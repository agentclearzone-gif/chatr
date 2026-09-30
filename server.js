'use strict';
/*
 * ArabianTalk — in-memory realtime chat server.
 *
 * Design goals: 5k–10k concurrent sockets on one Node process, no chat history on disk.
 *  - Plain WebSockets (ws), no per-message compression (saves CPU + ~300KB RAM per socket).
 *  - Presence and main-room messages are batched and flushed every FLUSH_MS, so a
 *    burst of 1000 joins costs one broadcast per tick instead of 1000 × N sends.
 *  - Every broadcast is serialized once into a Buffer and reused for all sockets.
 *  - Slow consumers (large bufferedAmount) are skipped instead of growing memory.
 *  - Private conversations are kept in memory only while both users are online so
 *    moderators can review them from /admin; they are deleted the moment either user leaves.
 *  - Only admin settings (word filter, bans) are written to ./data.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const COUNTRY_CODES = new Set(require('./public/countries.js'));
const WordFilter = require('./filter.js');
const createAdminApi = require('./admin-api.js');
const Geo = require('./geo.js');
const Settings = require('./settings.js');
const Captcha = require('./captcha.js');
const AntiSpam = require('./antispam.js');

const PORT = +process.env.PORT || 3000;
const MAX_USERS = +process.env.MAX_USERS || 10000;
const MAX_PER_IP = +process.env.MAX_PER_IP || 20;          // loopback is exempt (load tests)
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // use X-Forwarded-For behind nginx/LB
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';    // e.g. https://chat.example.com
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GEO_LOCK = process.env.GEO_LOCK === '1';              // force each user's country to their IP's country
const FLUSH_MS = 60;
const MAX_TEXT = 500;
const MAX_IMG_CHARS = 1_400_000;                            // base64 data URL (~1MB image)
const SLOW_CLIENT_BYTES = 2 * 1024 * 1024;
const MAX_ROOM_MSGS_PER_FLUSH = 150;
const MAX_STORED_PER_CONVO = 200;                           // messages kept per private chat for moderation
const ROOM_LOG_SIZE = 500;
const IMG_STORE_BUDGET = (+process.env.IMG_STORE_MB || 300) * 1024 * 1024; // pictures kept for moderation
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const DEVICE_RE = /^[a-f0-9]{32}$/;
const CTRL_RE = new RegExp('[\\x00-\\x1f\\x7f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

// ---------- static files: preloaded and pre-gzipped ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
// Each file gets a content hash. HTML pages reference scripts/styles as /file.js?v=<hash>, so a
// deploy is picked up immediately while unchanged files stay cached by the browser forever.
const files = new Map();
const hashOf = buf => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 10);
const publicFiles = fs.readdirSync(PUBLIC_DIR).filter(n => fs.statSync(path.join(PUBLIC_DIR, n)).isFile());
const raw = new Map(publicFiles.map(n => [n, fs.readFileSync(path.join(PUBLIC_DIR, n))]));
for (const [name, buf] of raw) {
  let body = buf;
  if (name.endsWith('.html')) {
    body = Buffer.from(buf.toString('utf8').replace(/(src|href)="\/([\w.-]+\.(?:js|css))"/g,
      (m, attr, file) => raw.has(file) ? `${attr}="/${file}?v=${hashOf(raw.get(file))}"` : m));
  }
  files.set('/' + name, { body, gz: zlib.gzipSync(body), etag: `"${hashOf(body)}"`, type: TYPES[path.extname(name)] || 'application/octet-stream' });
}
files.set('/', files.get('/index.html'));
files.set('/admin', files.get('/admin.html'));
files.set('/admin/', files.get('/admin.html'));

// ---------- bans (persisted) ----------
class Bans {
  constructor(file) {
    this.file = file;
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.items = []; }
    this.nextId = this.items.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }
  list() {
    const now = Date.now();
    const before = this.items.length;
    this.items = this.items.filter(b => !b.until || b.until > now);
    if (this.items.length !== before) this.save();
    return this.items;
  }
  add(b) { const ban = { id: this.nextId++, created: Date.now(), ...b }; this.items.push(ban); this.save(); return ban; }
  remove(id) { const n = this.items.length; this.items = this.items.filter(b => b.id !== id); if (n === this.items.length) return false; this.save(); return true; }
  match(ip, device) { return this.list().find(b => (b.ip && b.ip === ip) || (b.device && b.device === device)); }
}

// ---------- state (memory only) ----------
const users = new Map();      // id -> user
const names = new Set();      // lowercase usernames in use
const ipCount = new Map();
const convos = new Map();     // "a-b" -> private conversation (while both users are online)
const roomLog = [];           // last ROOM_LOG_SIZE main-room messages, for moderators
let imgStoreBytes = 0;
let nextId = 1;
let pendingJoins = [];
let pendingLeaves = [];
let pendingRoom = [];
let snapshot = null;          // cached JSON of the user list, rebuilt lazily

const stats = {
  startedAt: Date.now(),
  totalJoins: 0,
  peak: { n: 0, ts: Date.now() },
  messages: { room: 0, pm: 0, img: 0 },
  filtered: { masked: 0, blocked: 0 },
  kicks: 0,
  countryJoins: new Map(),
  history: [],                // [ts, online] every 30s, last 24h
  spam: {
    captchaPassed: 0, captchaFailed: 0, honeypot: 0, links: 0, duplicates: 0, newUser: 0,
    massPm: 0, rateLimited: 0, badWords: 0, mutedAttempts: 0, autoMutes: 0, autoKicks: 0,
  },
};
const filter = new WordFilter(path.join(DATA_DIR, 'filters.json'));
const bans = new Bans(path.join(DATA_DIR, 'bans.json'));
const settings = new Settings(path.join(DATA_DIR, 'settings.json'));
const captcha = new Captcha({ settings, stats });
const antispam = new AntiSpam({
  settings, stats,
  onAutoKick(u) {
    bans.add({ ip: isLoopback(u.ip) ? null : u.ip, device: u.device, name: u.name, reason: 'Automatic: spamming', until: Date.now() + 10 * 60000, auto: true });
    kickUser(u, 'You were removed automatically for spamming. You can come back in 10 minutes.');
  },
});

function clientIp(req) {
  if (TRUST_PROXY) {
    // Cloudflare (used by Render and many hosts) sets these itself, so visitors can't fake them;
    // X-Forwarded-For is the fallback for plain nginx/load balancers.
    const h = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0];
    if (h && h.trim()) return h.trim();
  }
  return req.socket.remoteAddress || '';
}
const isLoopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const geo = new Geo({ dataDir: process.env.GEO_DIR || path.join(__dirname, 'data'), trustProxy: TRUST_PROXY, devIp: process.env.GEO_DEV_IP || '' });

const adminApi = createAdminApi({
  users, convos, roomLog, stats, filter, bans, settings, captcha, clientIp, dataDir: DATA_DIR,
  kick(u, reason) {
    stats.kicks++;
    kickUser(u, reason ? `You were removed by a moderator: ${reason}` : 'You were removed by a moderator.');
  },
  ban(u, hours, reason) {
    const ban = bans.add({
      ip: isLoopback(u.ip) ? null : u.ip, device: u.device, name: u.name, reason,
      until: hours ? Date.now() + hours * 3600000 : null,
    });
    const msg = 'You have been banned' + (reason ? `: ${reason}` : '.');
    for (const x of [...users.values()]) if ((ban.ip && x.ip === ban.ip) || (ban.device && x.device === ban.device)) kickUser(x, msg);
  },
});

function kickUser(u, msg) {
  send(u.ws, { t: 'kicked', e: msg });
  leave(u.ws);
  setTimeout(() => u.ws.close(4000, 'Removed'), 100);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/admin/api/')) return adminApi.handle(req, res, url);
  if (url.pathname === '/geo') {
    // The login page calls this to pre-select the visitor's country from their IP.
    // (Right after startup, wait briefly for the server's own public IP, used for local visitors.)
    Promise.race([geo.ready, new Promise(r => setTimeout(r, 3000))]).then(() => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      const { cc, state } = geo.locate(req, clientIp(req));
      res.end(JSON.stringify({ cc, state, locked: GEO_LOCK }));
    });
    return;
  }
  if (url.pathname === '/states') {
    const cc = (url.searchParams.get('cc') || '').toLowerCase();
    if (!COUNTRY_CODES.has(cc)) { res.writeHead(400); return res.end('Unknown country'); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' });
    return res.end(JSON.stringify({ cc, states: Geo.STATES[cc] || [] }));
  }
  if (url.pathname === '/challenge') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(captcha.challenge(clientIp(req))));
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ users: users.size, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  }
  const f = files.get(url.pathname);
  if (!f || req.method !== 'GET') { res.writeHead(404); return res.end('Not found'); }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const isHtml = f.type.startsWith('text/html');
  const cacheControl = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (req.headers['if-none-match'] === f.etag) {
    res.writeHead(304, { etag: f.etag, 'cache-control': cacheControl });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': f.type,
    'cache-control': cacheControl,
    etag: f.etag,
    vary: 'accept-encoding',
    'x-content-type-options': 'nosniff',
    ...(isHtml ? { 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' } : {}),
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(gzip ? f.gz : f.body);
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_IMG_CHARS + 4096,
  perMessageDeflate: false,
  verifyClient: ALLOWED_ORIGIN ? ({ origin }) => origin === ALLOWED_ORIGIN : undefined,
});

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  if (!isLoopback(ip)) {
    const n = (ipCount.get(ip) || 0) + 1;
    if (n > MAX_PER_IP) return ws.close(1008, 'Too many connections');
    ipCount.set(ip, n);
  }
  ws.ip = ip;
  ws.ipcc = geo.country(req, ip);
  ws.alive = true;
  ws.user = null;
  ws.joinTimer = setTimeout(() => { if (!ws.user) ws.terminate(); }, 30000);

  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && typeof m === 'object') handle(ws, m);
  });
  ws.on('close', () => {
    clearTimeout(ws.joinTimer);
    if (!isLoopback(ws.ip)) {
      const n = ipCount.get(ws.ip) - 1;
      n > 0 ? ipCount.set(ws.ip, n) : ipCount.delete(ws.ip);
    }
    leave(ws);
  });
  ws.on('error', () => {});
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Token bucket: `rate` tokens per second, up to `burst`.
function allow(bucket, rate, burst) {
  const now = Date.now();
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
const bucket = burst => ({ tokens: burst, at: Date.now() });

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(CTRL_RE, ' ').trim().slice(0, max);
}

// ---------- moderation copies (memory only) ----------
function releaseImg(msg) {
  if (typeof msg.i === 'string') imgStoreBytes -= msg.i.length;
}

function record(a, b, msg) {
  const lo = a.id < b.id ? a : b, hi = lo === a ? b : a;
  const key = lo.id + '-' + hi.id;
  let c = convos.get(key);
  if (!c) {
    c = { key, a: lo.id, b: hi.id, msgs: [], count: 0, started: msg.ts, last: msg.ts, flagged: false };
    convos.set(key, c);
    a.convoKeys.add(key);
    b.convoKeys.add(key);
  }
  c.msgs.push(msg);
  c.count++;
  c.last = msg.ts;
  if (msg.blocked || msg.o) c.flagged = true;
  if (c.msgs.length > MAX_STORED_PER_CONVO) releaseImg(c.msgs.shift());
}

function storeImg(dataUrl) {
  if (imgStoreBytes + dataUrl.length > IMG_STORE_BUDGET) return null; // over budget: keep a placeholder only
  imgStoreBytes += dataUrl.length;
  return dataUrl;
}

function handle(ws, m) {
  if (m.t === 'join') return join(ws, m).catch(e => console.error('[join]', e));
  const u = ws.user;
  if (!u) return;

  switch (m.t) {
    case 'room': {
      const text = cleanText(m.x, MAX_TEXT);
      if (!text) return;
      const muted = antispam.checkMuted(u);
      if (muted) return send(ws, { t: 'err', e: muted });
      if (!allow(u.roomBucket, 0.5, 4)) {
        antispam.strike(u, 'rateLimited');
        return send(ws, { t: 'err', e: 'Slow down — you are sending too fast.' });
      }
      const spam = antispam.checkText(u, text, 'room');
      if (spam) return send(ws, { t: 'err', e: spam });
      const ts = Date.now();
      const r = filter.check(text);
      u.msgCount++;
      if (r.blocked) {
        stats.filtered.blocked++;
        if (antispam.strike(u, 'badWords')) return;
        logRoom({ f: u.id, name: u.name, g: u.g, x: text, ts, blocked: true });
        return send(ws, { t: 'err', e: 'Message not sent: it contains a word that isn\'t allowed.' });
      }
      if (r.masked) stats.filtered.masked++;
      stats.messages.room++;
      logRoom({ f: u.id, name: u.name, g: u.g, x: r.text, ts, ...(r.masked ? { o: text } : {}) });
      pendingRoom.push([u.id, u.name, u.g, r.text, ts]);
      return;
    }
    case 'pm': {
      const to = users.get(m.to);
      const c = m.c;
      if (!to || to === u) return send(ws, { t: 'ack', c, ok: false, e: 'User is offline' });
      const muted = antispam.checkMuted(u);
      if (muted) return send(ws, { t: 'ack', c, ok: false, e: muted });
      const isNewChat = !u.convoKeys.has(u.id < to.id ? u.id + '-' + to.id : to.id + '-' + u.id);
      if (isNewChat) {
        const e = antispam.checkNewChat(u);
        if (e) return send(ws, { t: 'ack', c, ok: false, e });
      }
      const ts = Date.now();
      const out = { t: 'pm', f: u.id, ts };
      let stored;
      if (typeof m.i === 'string') {
        if (m.i.length > MAX_IMG_CHARS || !IMG_RE.test(m.i)) return send(ws, { t: 'ack', c, ok: false, e: 'Invalid picture' });
        if (!allow(u.imgBucket, 0.5, 3)) {
          antispam.strike(u, 'rateLimited');
          return send(ws, { t: 'ack', c, ok: false, e: 'Too many pictures, wait a moment' });
        }
        if (to.ws.bufferedAmount > SLOW_CLIENT_BYTES) return send(ws, { t: 'ack', c, ok: false, e: 'Recipient connection is busy' });
        out.i = m.i;
        stored = { f: u.id, ts, i: storeImg(m.i) };
        stats.messages.img++;
      } else {
        const text = cleanText(m.x, MAX_TEXT);
        if (!text) return;
        if (!allow(u.pmBucket, 5, 15)) {
          antispam.strike(u, 'rateLimited');
          return send(ws, { t: 'ack', c, ok: false, e: 'Slow down' });
        }
        const spam = antispam.checkText(u, text, 'pm');
        if (spam) return send(ws, { t: 'ack', c, ok: false, e: spam });
        const r = filter.check(text);
        if (r.blocked) {
          stats.filtered.blocked++;
          if (antispam.strike(u, 'badWords')) return;
          u.msgCount++;
          record(u, to, { f: u.id, ts, x: text, blocked: true });
          return send(ws, { t: 'ack', c, ok: false, e: 'Not sent: contains a word that isn\'t allowed' });
        }
        if (r.masked) stats.filtered.masked++;
        out.x = r.text;
        stored = { f: u.id, ts, x: r.text, ...(r.masked ? { o: text } : {}) };
        stats.messages.pm++;
      }
      u.msgCount++;
      record(u, to, stored);
      if (to.blocked.has(u.id)) return send(ws, { t: 'ack', c, ok: true }); // silently dropped
      send(to.ws, out);
      // tell the sender if the text was masked so their copy matches what was delivered
      return send(ws, { t: 'ack', c, ok: true, ...(stored.o ? { x: out.x } : {}) });
    }
    case 'draft': {
      // Live typing preview for private chats: relayed, never stored, word-filtered.
      const to = users.get(m.to);
      if (!to || to === u || to.blocked.has(u.id) || antispam.mutedFor(u)) return;
      if (!allow(u.draftBucket, 15, 30)) return;
      if (!settings.get('liveTyping')) {
        if (allow(u.tyBucket, 1, 3)) send(to.ws, { t: 'ty', f: u.id }); // fall back to the "typing…" dots
        return;
      }
      const x = typeof m.x === 'string' ? filter.maskAll(m.x.replace(CTRL_RE, ' ').slice(0, MAX_TEXT)) : '';
      send(to.ws, { t: 'draft', f: u.id, x });
      return;
    }
    case 'ty': {
      const to = users.get(m.to);
      if (to && to !== u && !to.blocked.has(u.id) && allow(u.tyBucket, 1, 3)) send(to.ws, { t: 'ty', f: u.id });
      return;
    }
    case 'block': {
      if (users.has(m.id) && u.blocked.size < 1000) u.blocked.add(m.id);
      return;
    }
  }
}

// The state must come from the chosen country's list (or be empty for countries without states).
function validState(cc, loc) {
  const list = Geo.STATES[cc] || [];
  return list.length ? list.includes(loc) : loc === '';
}

function logRoom(entry) {
  roomLog.push(entry);
  if (roomLog.length > ROOM_LOG_SIZE) roomLog.splice(0, roomLog.length - ROOM_LOG_SIZE);
}

async function join(ws, m) {
  if (ws.user || ws.joining) return;
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  const g = m.g === 'f' || m.g === 'm' ? m.g : null;
  const age = Number.isInteger(m.age) ? m.age : parseInt(m.age, 10);
  let cc = typeof m.cc === 'string' ? m.cc.toLowerCase() : '';
  if (GEO_LOCK && ws.ipcc && COUNTRY_CODES.has(ws.ipcc)) cc = ws.ipcc;
  const loc = cleanText(m.loc, 60);   // state / region, from the country's list
  const device = typeof m.dev === 'string' && DEVICE_RE.test(m.dev) ? m.dev : null;

  let e = null;
  const ban = bans.match(isLoopback(ws.ip) ? null : ws.ip, device);
  if (ban) e = 'You are banned from this chat' + (ban.until ? ` until ${new Date(ban.until).toUTCString()}` : '') + '.';
  else if (!NAME_RE.test(name)) e = 'Username must be 3–16 letters, numbers or _';
  else if (!filter.nameAllowed(name)) e = 'That username is not allowed';
  else if (!g) e = 'Please choose a gender';
  else if (!(age >= 18 && age <= 99)) e = 'You must be 18 or older';
  else if (!COUNTRY_CODES.has(cc)) e = 'Please choose a country';
  else if (!validState(cc, loc)) e = (Geo.STATES[cc] || []).length ? 'Please choose your state' : 'Invalid state';
  else if (names.has(name.toLowerCase())) e = 'That username is taken right now';
  else if (users.size >= MAX_USERS) e = 'The chat is full, please try again shortly';
  if (e) return send(ws, { t: 'err', e, join: true });

  // Bots: a hidden form field people never see or fill in, then the bot check.
  if (typeof m.hp === 'string' && m.hp !== '') {
    stats.spam.honeypot++;
    return send(ws, { t: 'err', e: 'Could not join. Please reload the page and try again.', join: true, code: 'captcha' });
  }
  ws.joining = true;
  let human;
  try { human = await captcha.verify(m.cap, ws.ip); } finally { ws.joining = false; }
  if (!human) return send(ws, { t: 'err', e: 'Bot check failed. Please try again.', join: true, code: 'captcha' });
  if (ws.readyState !== 1 || ws.user) return;
  // re-check anything that could have changed while verifying
  if (names.has(name.toLowerCase())) return send(ws, { t: 'err', e: 'That username is taken right now', join: true });
  if (users.size >= MAX_USERS) return send(ws, { t: 'err', e: 'The chat is full, please try again shortly', join: true });

  clearTimeout(ws.joinTimer);
  const u = {
    id: nextId++, name, g, age, loc, cc, ws, ip: ws.ip, ipcc: ws.ipcc, device, joined: Date.now(), msgCount: 0,
    roomBucket: bucket(4), pmBucket: bucket(15), imgBucket: bucket(3), tyBucket: bucket(3), draftBucket: bucket(30),
    blocked: new Set(), convoKeys: new Set(),
  };
  u.tuple = [u.id, name, g, age, loc, cc];
  antispam.init(u);
  ws.user = u;

  // Snapshot reflects the list as of its last rebuild; anything newer arrives in the next
  // batched delta (clients apply joins/leaves idempotently), so it is rebuilt at most once per tick.
  if (snapshot === null) snapshot = JSON.stringify(Array.from(users.values(), x => x.tuple));
  ws.send('{"t":"welcome","live":' + settings.get('liveTyping') + ',"me":' + JSON.stringify(u.tuple) + ',"users":' + snapshot + '}');

  users.set(u.id, u);
  names.add(name.toLowerCase());
  pendingJoins.push(u.tuple);

  stats.totalJoins++;
  stats.countryJoins.set(cc, (stats.countryJoins.get(cc) || 0) + 1);
  if (users.size > stats.peak.n) stats.peak = { n: users.size, ts: Date.now() };
}

function leave(ws) {
  const u = ws.user;
  if (!u) return;
  ws.user = null;
  users.delete(u.id);
  names.delete(u.name.toLowerCase());
  pendingLeaves.push(u.id);

  // Delete every private conversation this user was part of…
  for (const key of u.convoKeys) {
    const c = convos.get(key);
    if (!c) continue;
    for (const msg of c.msgs) releaseImg(msg);
    convos.delete(key);
    const other = users.get(c.a === u.id ? c.b : c.a);
    if (other) other.convoKeys.delete(key);
  }
  // …and their main-room messages from the moderation log.
  let w = 0;
  for (let i = 0; i < roomLog.length; i++) if (roomLog[i].f !== u.id) roomLog[w++] = roomLog[i];
  roomLog.length = w;
}

function broadcast(str) {
  const buf = Buffer.from(str);
  for (const u of users.values()) {
    const ws = u.ws;
    if (ws.readyState === 1 && ws.bufferedAmount < SLOW_CLIENT_BYTES) ws.send(buf, { binary: false });
  }
}

// One tick: presence delta + main-room batch.
setInterval(() => {
  if (pendingJoins.length || pendingLeaves.length) {
    const msg = JSON.stringify({ t: 'ud', j: pendingJoins, l: pendingLeaves });
    pendingJoins = [];
    pendingLeaves = [];
    snapshot = null;
    broadcast(msg);
  }
  if (pendingRoom.length) {
    const batch = pendingRoom.length > MAX_ROOM_MSGS_PER_FLUSH ? pendingRoom.splice(0, MAX_ROOM_MSGS_PER_FLUSH) : pendingRoom;
    if (batch === pendingRoom) pendingRoom = [];
    broadcast(JSON.stringify({ t: 'room', m: batch }));
  }
}, FLUSH_MS);

// Drop dead connections so their users disappear from the list.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

// Online-users history for the admin chart.
const sample = () => {
  stats.history.push([Date.now(), users.size]);
  if (stats.history.length > 2880) stats.history.shift();
};
sample();
setInterval(sample, 30000);

if (process.env.STATS !== '0') {
  setInterval(() => {
    const mem = process.memoryUsage();
    console.log(`[stats] sockets=${wss.clients.size} users=${users.size} convos=${convos.size} rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB`);
  }, 30000).unref();
}

server.listen(PORT, () => console.log(`ArabianTalk listening on http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`));

function shutdown() {
  if (filter.dirty) filter.save();
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
