'use strict';
/*
 * Admin REST API, mounted under /admin/api/*.
 * Auth: password (ADMIN_PASSWORD) → random session token in an HttpOnly, SameSite=Strict cookie.
 * State-changing calls also require the X-Admin header, so they cannot be forged cross-site.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'chatr_admin';

module.exports = function createAdminApi(ctx) {
  const { users, convos, roomLog, stats, filter, bans, settings, captcha, theme, clientIp } = ctx;
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    // No env var: generate one once and keep it in data/admin-password.txt (readable only by this OS user).
    const file = path.join(ctx.dataDir, 'admin-password.txt');
    try { password = fs.readFileSync(file, 'utf8').trim(); } catch {}
    if (!password) {
      password = crypto.randomBytes(12).toString('base64url');
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      fs.writeFileSync(file, password + '\n', { mode: 0o600 });
    }
    console.log(`[admin] ADMIN_PASSWORD not set — using the password stored in ${file}`);
  }
  const pwHash = crypto.createHash('sha256').update(password).digest();
  const sessions = new Map();     // token -> expiresAt
  const loginAttempts = new Map(); // ip -> { n, reset }

  setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
    for (const [ip, a] of loginAttempts) if (a.reset < now) loginAttempts.delete(ip);
  }, 60000).unref();

  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  function readBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('Invalid JSON')); } });
      req.on('error', reject);
    });
  }

  function token(req) {
    const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]+)'));
    return m && m[1];
  }
  function authed(req) {
    const t = token(req);
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) return false;
    sessions.set(t, Date.now() + SESSION_MS); // sliding expiry
    return true;
  }
  const secure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

  const userInfo = u => ({ id: u.id, name: u.name, g: u.g, age: u.age, loc: u.loc, cc: u.cc });

  // ---------------- handlers ----------------
  function overview() {
    const byCountry = new Map();
    const ages = [0, 0, 0, 0, 0]; // 18-24, 25-34, 35-44, 45-54, 55+
    let f = 0, m = 0;
    for (const u of users.values()) {
      let c = byCountry.get(u.cc);
      if (!c) { c = { cc: u.cc, online: 0, f: 0, m: 0, ageSum: 0, joins: stats.countryJoins.get(u.cc) || 0 }; byCountry.set(u.cc, c); }
      c.online++; c[u.g]++; c.ageSum += u.age;
      u.g === 'f' ? f++ : m++;
      ages[u.age < 25 ? 0 : u.age < 35 ? 1 : u.age < 45 ? 2 : u.age < 55 ? 3 : 4]++;
    }
    // countries with joins today but nobody online right now
    for (const [cc, joins] of stats.countryJoins) if (!byCountry.has(cc)) byCountry.set(cc, { cc, online: 0, f: 0, m: 0, ageSum: 0, joins });
    const countries = [...byCountry.values()]
      .map(c => ({ cc: c.cc, online: c.online, f: c.f, m: c.m, avgAge: c.online ? Math.round(c.ageSum / c.online) : null, joins: c.joins }))
      .sort((a, b) => b.online - a.online || b.joins - a.joins);
    return {
      now: Date.now(),
      startedAt: stats.startedAt,
      online: users.size,
      female: f, male: m,
      peak: stats.peak,
      totalJoins: stats.totalJoins,
      messages: stats.messages,
      filtered: stats.filtered,
      activeConvos: convos.size,
      moderation: { kicks: stats.kicks, bans: bans.list().length },
      ages,
      countries,
      history: stats.history,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      storage: ctx.storage(),
    };
  }

  function listUsers(q) {
    const s = (q.get('q') || '').toLowerCase();
    const cc = q.get('cc') || '';
    const g = q.get('g') || '';
    const out = [];
    let total = 0;
    for (const u of users.values()) {
      if (cc && u.cc !== cc) continue;
      if (g && u.g !== g) continue;
      if (s && !u.name.toLowerCase().includes(s) && !u.loc.toLowerCase().includes(s) && !u.ip.includes(s)) continue;
      total++;
      if (out.length < 300) out.push({ ...userInfo(u), reg: !!u.acct, status: u.invisible ? 'invisible' : u.status || 'online', ip: u.ip, ipcc: u.ipcc, strikes: u.spam ? u.spam.strikes : 0, muted: !!(u.spam && u.spam.mutedUntil > Date.now()), joined: u.joined, msgs: u.msgCount, convos: u.convoKeys.size });
    }
    out.sort((a, b) => b.joined - a.joined);
    return { total, users: out };
  }

  function listConvos(q) {
    const s = (q.get('q') || '').toLowerCase();
    const uid = +q.get('user') || 0;
    const out = [];
    for (const c of convos.values()) {
      const a = users.get(c.a), b = users.get(c.b);
      if (!a || !b) continue;
      if (uid && c.a !== uid && c.b !== uid) continue;
      if (s && !a.name.toLowerCase().includes(s) && !b.name.toLowerCase().includes(s)) continue;
      const last = c.msgs[c.msgs.length - 1];
      out.push({
        key: c.key, a: userInfo(a), b: userInfo(b), count: c.count, started: c.started, last: c.last,
        flagged: c.flagged, preview: last ? (last.i !== undefined ? '📷 Picture' : last.x) : '', lastFrom: last ? last.f : 0,
      });
    }
    out.sort((x, y) => y.last - x.last);
    return { total: out.length, convos: out.slice(0, 300) };
  }

  function getConvo(key) {
    const c = convos.get(key);
    if (!c) return null;
    const a = users.get(c.a), b = users.get(c.b);
    return { key, a: a && userInfo(a), b: b && userInfo(b), count: c.count, started: c.started, msgs: c.msgs };
  }

  async function route(req, res, url) {
    const method = req.method;
    const p = url.pathname.slice('/admin/api'.length);

    if (p === '/login' && method === 'POST') {
      const ip = clientIp(req);
      const a = loginAttempts.get(ip) || { n: 0, reset: Date.now() + 15 * 60000 };
      if (a.n >= 8) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const body = await readBody(req);
      const given = crypto.createHash('sha256').update(String(body.password || '')).digest();
      if (!crypto.timingSafeEqual(given, pwHash)) {
        a.n++; loginAttempts.set(ip, a);
        return json(res, 401, { error: 'Wrong password' });
      }
      loginAttempts.delete(ip);
      const t = crypto.randomBytes(32).toString('base64url');
      sessions.set(t, Date.now() + SESSION_MS);
      res.setHeader('set-cookie', `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure(req) ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }

    if (!authed(req)) return json(res, 401, { error: 'Not logged in' });
    if (method !== 'GET' && req.headers['x-admin'] !== '1') return json(res, 403, { error: 'Missing X-Admin header' });

    if (p === '/logout' && method === 'POST') {
      sessions.delete(token(req));
      res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (p === '/overview' && method === 'GET') return json(res, 200, overview());
    if (p === '/users' && method === 'GET') return json(res, 200, listUsers(url.searchParams));
    if (p === '/convos' && method === 'GET') return json(res, 200, listConvos(url.searchParams));
    if (p.startsWith('/convos/') && method === 'GET') {
      const c = getConvo(decodeURIComponent(p.slice(8)));
      return c ? json(res, 200, c) : json(res, 404, { error: 'This conversation ended — one of the users left and it was deleted.' });
    }
    if (p === '/room' && method === 'GET') return json(res, 200, { msgs: roomLog });

    let m;
    if ((m = p.match(/^\/users\/(\d+)\/(kick|ban)$/)) && method === 'POST') {
      const body = await readBody(req);
      const u = users.get(+m[1]);
      if (!u) return json(res, 404, { error: 'User already left' });
      const reason = String(body.reason || '').slice(0, 200);
      if (m[2] === 'kick') ctx.kick(u, reason);
      else ctx.ban(u, Math.max(0, Math.min(24 * 365, +body.hours || 24)), reason);
      return json(res, 200, { ok: true });
    }

    if (p === '/filters' && method === 'GET') return json(res, 200, { rules: filter.list() });
    if (p === '/filters' && method === 'POST') {
      const body = await readBody(req);
      const words = String(body.word || '').split(/[,\n]/).map(w => w.trim()).filter(Boolean);
      if (!words.length) return json(res, 400, { error: 'Enter a word' });
      const added = [], errors = [];
      for (const w of words.slice(0, 500)) {
        try { added.push(filter.add({ word: w, match: body.match, action: body.action })); } catch (e) { errors.push(`${w}: ${e.message}`); }
      }
      return json(res, added.length ? 200 : 400, { added, errors, error: added.length ? undefined : errors[0] });
    }
    if (p === '/filters/test' && method === 'POST') {
      const body = await readBody(req);
      // dry run: compute without counting hits
      const saved = filter.rules.map(r => r.hits);
      const r = filter.check(String(body.text || '').slice(0, 500));
      filter.rules.forEach((x, i) => { x.hits = saved[i]; });
      return json(res, 200, r);
    }
    if ((m = p.match(/^\/filters\/(\d+)$/))) {
      try {
        if (method === 'DELETE') return filter.remove(+m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
        if (method === 'PATCH') return json(res, 200, filter.update(+m[1], await readBody(req)));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/antispam' && method === 'GET') {
      return json(res, 200, {
        settings: settings.all(), stats: stats.spam,
        captcha: { mode: captcha.mode(), turnstileConfigured: !!captcha.turnstile, forcedOff: captcha.forcedOff },
      });
    }
    if (p === '/antispam' && method === 'PUT') {
      try { return json(res, 200, { settings: settings.update(await readBody(req)) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/accounts' && method === 'GET') return json(res, 200, { total: ctx.accounts.total(), accounts: ctx.accounts.list(url.searchParams.get('q')) });
    if ((m = p.match(/^\/accounts\/([a-z0-9_]{3,16})\/(photo|bio|delete)$/)) && method === 'POST') {
      return ctx.accounts.moderate(m[1], m[2]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Account not found' });
    }

    if (p === '/rooms' && method === 'GET') return json(res, 200, { rooms: ctx.rooms.list() });
    if (p === '/rooms' && method === 'POST') {
      try { await ctx.rooms.create(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 200, { rooms: ctx.rooms.list() });
    }
    if ((m = p.match(/^\/rooms\/([\w-]+)$/))) {
      if (method === 'PATCH') {
        const body = await readBody(req);
        const patch = { name: body.name, desc: body.desc };
        if (typeof body.chat === 'boolean') patch.chat = body.chat;
        if (body.removePassword) patch.password = '';
        else if (typeof body.password === 'string' && body.password !== '') patch.password = body.password;
        try { await ctx.rooms.update(m[1], patch); } catch (e) { return json(res, 400, { error: e.message }); }
        return json(res, 200, { rooms: ctx.rooms.list() });
      }
      if (method === 'DELETE') {
        return ctx.rooms.remove(m[1]) ? json(res, 200, { rooms: ctx.rooms.list() }) : json(res, 404, { error: 'Room not found' });
      }
    }
    if ((m = p.match(/^\/rooms\/([\w-]+)\/move$/)) && method === 'POST') {
      const body = await readBody(req);
      ctx.rooms.move(m[1], body.dir === -1 ? -1 : 1);
      return json(res, 200, { rooms: ctx.rooms.list() });
    }

    if (p === '/theme' && method === 'GET') return json(res, 200, ctx.themeInfo());
    if (p === '/theme' && method === 'PUT') {
      try { theme.update(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
      ctx.onThemeChange();
      return json(res, 200, ctx.themeInfo());
    }
    if (p === '/theme/image' && method === 'POST') {
      const body = await readBody(req, 6 * 1024 * 1024);
      try { theme.saveImage(body.slot, body.data); } catch (e) { return json(res, 400, { error: e.message }); }
      ctx.onThemeChange();
      return json(res, 200, ctx.themeInfo());
    }
    if ((m = p.match(/^\/theme\/image\/(hero|logo)$/)) && method === 'DELETE') {
      theme.removeImage(m[1]);
      ctx.onThemeChange();
      return json(res, 200, ctx.themeInfo());
    }

    if (p === '/loadtest' && method === 'GET') return json(res, 200, { ...ctx.loadTest.status(), limits: ctx.loadTest.limits, rooms: ctx.rooms.list().filter(r => !r.locked).map(r => ({ id: r.id, name: r.name })) });
    if (p === '/loadtest/start' && method === 'POST') {
      try { return json(res, 200, ctx.loadTest.start(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/loadtest/stop' && method === 'POST') return json(res, 200, ctx.loadTest.stop());
    if (p === '/bans' && method === 'GET') return json(res, 200, { bans: bans.list() });
    if ((m = p.match(/^\/bans\/(\d+)$/)) && method === 'DELETE') return bans.remove(+m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });

    return json(res, 404, { error: 'Unknown endpoint' });
  }

  return {
    handle(req, res, url) {
      route(req, res, url).catch(e => json(res, 400, { error: e.message || 'Bad request' }));
    },
  };
};
