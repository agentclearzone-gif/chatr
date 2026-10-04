'use strict';
/*
 * ChateX — in-memory realtime chat server.
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
const Rooms = require('./rooms.js');
const Accounts = require('./accounts.js');
const store = require('./store.js'); // already loaded by server.js before this file runs

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
files.set('/admin', files.get('/admin.html'));
files.set('/admin/', files.get('/admin.html'));

// ---------- the login page is rendered from the admin's Appearance settings ----------
const Theme = require('./theme.js');
const theme = new Theme(store);
const INDEX_TEMPLATE = files.get('/index.html').body.toString('utf8');
const HERO_DEFAULT = `/hero-dubai.svg?v=${hashOf(raw.get('hero-dubai.svg'))}`;
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function themeAssets(t) {
  return {
    heroUrl: t.heroImage ? `/media/hero?v=${t.heroImage.v}` : HERO_DEFAULT,
    logoHtml: t.logoImage ? `<img src="/media/logo?v=${t.logoImage.v}" alt="">` : Theme.DEFAULT_LOGO,
  };
}
function renderIndex() {
  const t = theme.all();
  const { heroUrl, logoHtml } = themeAssets(t);
  const values = {
    themeVars: Theme.cssVars(t), themeColor: t.primary, siteTitle: escHtml(t.brandMain + t.brandAccent),
    brandMain: escHtml(t.brandMain), brandAccent: escHtml(t.brandAccent), tagline: escHtml(t.tagline),
    description: escHtml(t.description), buttonText: escHtml(t.buttonText),
    heroUrl: escHtml(heroUrl), heroClass: !t.showHero ? 'off' : t.heroImage ? '' : 'default', patternClass: t.showPattern ? 'pattern' : '', logoHtml,
  };
  const body = Buffer.from(INDEX_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m)));
  const f = { body, gz: zlib.gzipSync(body), etag: `"${hashOf(body)}"`, type: TYPES['.html'] };
  files.set('/', f);
  files.set('/index.html', f);
}
renderIndex();

// ---------- bans (persisted) ----------
class Bans {
  constructor(store) {
    this.store = store;
    const saved = store.get('bans');
    this.items = Array.isArray(saved) ? saved : [];
    this.nextId = this.items.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  }
  save() {
    this.store.set('bans', this.items);
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
const roomLog = [];           // last ROOM_LOG_SIZE room messages (all rooms), for moderators
const roomMembers = new Map(); // room id -> Set of users currently in it
const roomMsgCount = new Map(); // room id -> messages since server start
let imgStoreBytes = 0;
let pmSeq = 0;                 // private message ids (read receipts)
let nextId = 1;
let pendingJoins = [];
const pendingIdle = new Map(); // user id -> idle since (0 = active again), sent with the next tick
const pendingStatus = new Map(); // user id -> [status, since]
let pendingLeaves = [];
const pendingRoom = new Map(); // room id -> messages waiting for the next flush
let roomCountsDirty = false;
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
    massPm: 0, rateLimited: 0, badWords: 0, mutedAttempts: 0, roomPassword: 0, autoMutes: 0, autoKicks: 0,
  },
};
const filter = new WordFilter(store);
const accounts = new Accounts(store, filter);
const bans = new Bans(store);
const settings = new Settings(store);
const rooms = new Rooms(store);
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
  users, convos, roomLog, stats, filter, bans, settings, captcha, clientIp, dataDir: DATA_DIR, storage: () => store.describe(),
  theme, themeInfo: () => ({ theme: theme.all(), presets: Theme.PRESETS, defaultLogo: Theme.DEFAULT_LOGO, heroDefault: HERO_DEFAULT, ...themeAssets(theme.all()) }),
  onThemeChange: renderIndex,
  accounts: {
    list(q) {
      const s = (q || '').toLowerCase();
      const online = new Map([...users.values()].filter(u => u.acct).map(u => [u.acct, u]));
      return accounts.list().filter(a => !s || a.key.includes(s) || (a.bio || '').toLowerCase().includes(s))
        .sort((a, b) => b.lastLogin - a.lastLogin).slice(0, 500)
        .map(a => ({ key: a.key, name: a.name, g: a.g, age: a.age, loc: a.loc, cc: a.cc, bio: a.bio || '', photoV: a.photoV,
          created: a.created, lastLogin: a.lastLogin, online: online.has(a.key) }));
    },
    total: () => accounts.count(),
    moderate(key, action) {
      const a = accounts.get(key);
      if (!a) return false;
      const u = [...users.values()].find(x => x.acct === a.key);
      if (action === 'photo') accounts.removePhoto(a);
      else if (action === 'bio') accounts.update(a, { bio: '' });
      else if (action === 'delete') {
        accounts.remove(a.key);
        dropFromFriendLists(a.key);
        if (u) { onlineAccts.delete(a.key); u.acct = null; kickUser(u, 'Your profile was removed by a moderator.'); }
        return true;
      }
      if (u) refreshUser(u);
      return true;
    },
  },
  rooms: {
    list: () => rooms.list.map(r => ({ id: r.id, name: r.name, desc: r.desc, locked: !!r.pw, chat: r.chat !== false, created: r.created,
      members: (roomMembers.get(r.id) || EMPTY).size, messages: roomMsgCount.get(r.id) || 0 })),
    async create(data) { const r = await rooms.create(data); broadcastRooms(); return r; },
    async update(id, data) { const r = await rooms.update(id, data); broadcastRooms(); return r; },
    move(id, dir) { rooms.move(id, dir); broadcastRooms(); },
    remove(id) {
      const room = rooms.remove(id);
      if (!room) return false;
      for (const u of roomMembers.get(id) || []) {
        u.rooms.delete(id);
        send(u.ws, { t: 'rclosed', r: id, e: `“${room.name}” was closed by a moderator.` });
      }
      roomMembers.delete(id); pendingRoom.delete(id); roomMsgCount.delete(id);
      let w = 0;
      for (let i = 0; i < roomLog.length; i++) if (roomLog[i].r !== id) roomLog[w++] = roomLog[i];
      roomLog.length = w;
      broadcastRooms();
      return true;
    },
  },
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
  const media = url.pathname.match(/^\/media\/(hero|logo)$/);
  if (media) {
    // images uploaded in Admin → Appearance
    const img = theme.image(media[1]);
    if (!img) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': img.type, 'content-length': img.data.length, 'x-content-type-options': 'nosniff',
      'cache-control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return res.end(img.data);
  }
  // registered users' profile photos and public profile info
  const av = url.pathname.match(/^\/avatar\/([A-Za-z0-9_]{3,16})$/);
  if (av) {
    accounts.photo(av[1].toLowerCase()).then(p => {
      if (!p) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': p.type, 'content-length': p.data.length, 'x-content-type-options': 'nosniff',
        'cache-control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(p.data);
    }, () => { res.writeHead(500); res.end(); });
    return;
  }
  const pr = url.pathname.match(/^\/api\/profile\/([A-Za-z0-9_]{3,16})$/);
  if (pr) {
    const a = accounts.get(pr[1]);
    res.writeHead(a ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(a ? { name: a.name, bio: a.bio || '', photoV: a.photoV, created: a.created } : { error: 'Not registered' }));
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
    return res.end(JSON.stringify({ users: users.size, rssMB: Math.round(process.memoryUsage().rss / 1048576), storage: store.kind }));
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
    ...(isHtml ? { 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin' } : {}), // same-origin only: the admin preview frames the login page
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
      const room = rooms.get(typeof m.r === 'string' ? m.r : 'main');
      if (!room || !u.rooms.has(room.id)) return send(ws, { t: 'err', e: 'Join the room before posting in it.' });
      if (room.chat === false) return send(ws, { t: 'err', e: 'Chatting is turned off in this room. You can still message people privately.' });
      const text = cleanText(m.x, MAX_TEXT);
      if (!text) return;
      const muted = antispam.checkMuted(u);
      if (muted) return send(ws, { t: 'err', e: muted });
      // Flood limit (admin-configurable): at most N room messages per user in any 30 seconds, across all rooms.
      const now = Date.now(), limit = settings.get('roomMsgsPer30s');
      u.roomTimes = u.roomTimes.filter(t => now - t < 30000);
      if (u.roomTimes.length >= limit) {
        antispam.strike(u, 'rateLimited');
        const wait = Math.ceil((u.roomTimes[0] + 30000 - now) / 1000);
        return send(ws, { t: 'err', e: `You can send ${limit} message${limit === 1 ? '' : 's'} every 30 seconds in rooms. Try again in ${wait}s.` });
      }
      u.roomTimes.push(now);
      const spam = antispam.checkText(u, text, 'room');
      if (spam) return send(ws, { t: 'err', e: spam });
      const ts = Date.now();
      const r = filter.check(text);
      u.msgCount++;
      if (r.blocked) {
        stats.filtered.blocked++;
        if (antispam.strike(u, 'badWords')) return;
        logRoom({ r: room.id, rn: room.name, f: u.id, name: u.name, g: u.g, x: text, ts, blocked: true });
        return send(ws, { t: 'err', e: 'Message not sent: it contains a word that isn\'t allowed.' });
      }
      if (r.masked) stats.filtered.masked++;
      stats.messages.room++;
      logRoom({ r: room.id, rn: room.name, f: u.id, name: u.name, g: u.g, x: r.text, ts, ...(r.masked ? { o: text } : {}) });
      roomMsgCount.set(room.id, (roomMsgCount.get(room.id) || 0) + 1);
      let q = pendingRoom.get(room.id);
      if (!q) pendingRoom.set(room.id, q = []);
      q.push([u.id, u.name, u.g, r.text, ts]);
      return;
    }
    case 'rjoin':
      return roomJoinRequest(ws, u, m).catch(e => console.error('[rjoin]', e));
    case 'fr':
      return friendRequest(ws, u, m);
    case 'claim': case 'profile': case 'pwchange':
      return profileRequest(ws, u, m).catch(e => console.error('[profile]', e));
    case 'rleave': {
      if (typeof m.r === 'string') leaveRoom(u, m.r);
      return send(ws, { t: 'rleave', r: m.r });
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
      const out = { t: 'pm', f: u.id, ts, mid: ++pmSeq, ...(u.invisible ? { fu: u.tuple } : {}) }; // mid: read receipts; fu: sender's card if invisible
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
      if (to.blocked.has(u.id)) return send(ws, { t: 'ack', c, ok: true }); // silently dropped (never shows as read)
      send(to.ws, out);
      // tell the sender if the text was masked so their copy matches what was delivered
      return send(ws, { t: 'ack', c, ok: true, mid: out.mid, ...(stored.o ? { x: out.x } : {}) });
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
    case 'idle': case 'act': {
      // away status: the browser reports "idle for N ms" after a minute without activity, and "active" when they're back
      if (!allow(u.idleBucket, 0.5, 6)) return;
      const since = m.t === 'idle' ? Date.now() - Math.min(Math.max(+m.ago || 0, 0), 10 * 60000) : 0;
      if (!since === !u.idleSince) return; // no change
      u.idleSince = since;
      u.tuple[8] = since;
      if (!u.invisible) pendingIdle.set(u.id, since);
      return;
    }
    case 'status': {
      // chosen status: online · busy · away · dnd (do not disturb) · invisible (appear offline)
      const s = ['online', 'busy', 'away', 'dnd', 'invisible'].includes(m.s) ? m.s : null;
      if (!s || !allow(u.statusBucket, 0.2, 6)) return;
      const wasInvisible = !!u.invisible;
      u.invisible = s === 'invisible';
      u.status = s === 'online' || s === 'invisible' ? '' : s;
      u.statusSince = u.status ? Date.now() : 0;
      u.tuple = tupleOf(u);
      snapshot = null;
      if (u.invisible && !wasInvisible) pendingLeaves.push(u.id);        // disappear from everyone's lists
      else if (!u.invisible && wasInvisible) pendingJoins.push(u.tuple);   // reappear
      else if (!u.invisible) pendingStatus.set(u.id, [u.status, u.statusSince]);
      return send(ws, { t: 'mystatus', s });
    }
    case 'read': {
      // read receipt: "I've seen your messages up to id N" → tell the sender (blue ticks)
      const from = users.get(m.f);
      if (from && from !== u && Number.isInteger(m.mid) && m.mid > 0 && !u.blocked.has(from.id) && allow(u.readBucket, 5, 20)) send(from.ws, { t: 'read', by: u.id, mid: m.mid });
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

// ---------- rooms ----------
const EMPTY = new Set();
function membersOf(id) {
  let s = roomMembers.get(id);
  if (!s) roomMembers.set(id, s = new Set());
  return s;
}
function joinRoom(u, room) {
  if (u.rooms.has(room.id)) return;
  u.rooms.add(room.id);
  membersOf(room.id).add(u);
  roomCountsDirty = true;
}
function leaveRoom(u, id) {
  if (!u.rooms.delete(id)) return;
  const s = roomMembers.get(id);
  if (s) s.delete(u);
  roomCountsDirty = true;
}
function roomCounts() {
  const c = {};
  for (const r of rooms.list) c[r.id] = (roomMembers.get(r.id) || EMPTY).size;
  return c;
}
function broadcastRooms() {
  broadcast(JSON.stringify({ t: 'rooms', list: rooms.publicList(), c: roomCounts() }));
}
function sendToRoom(id, str) {
  const s = roomMembers.get(id);
  if (!s || !s.size) return;
  const buf = Buffer.from(str);
  for (const u of s) {
    const ws = u.ws;
    if (ws.readyState === 1 && ws.bufferedAmount < SLOW_CLIENT_BYTES) ws.send(buf, { binary: false });
  }
}
async function roomJoinRequest(ws, u, m) {
  const room = typeof m.r === 'string' && rooms.get(m.r);
  if (!room) return send(ws, { t: 'rjoin', r: m.r, ok: false, e: 'This room no longer exists.' });
  if (u.rooms.has(room.id)) return send(ws, { t: 'rjoin', r: room.id, ok: true });
  if (room.pw) {
    // 5 tries, then one every 10 seconds; hammering past that counts as a spam strike
    if (!allow(u.roomPwBucket, 0.1, 5)) {
      antispam.strike(u, 'roomPassword');
      return send(ws, { t: 'rjoin', r: room.id, ok: false, e: 'Too many attempts. Please wait a bit.' });
    }
    const ok = await rooms.checkPassword(room, m.pw);
    if (ws.user !== u || rooms.get(room.id) !== room) return; // left or room deleted meanwhile
    if (!ok) return send(ws, { t: 'rjoin', r: room.id, ok: false, e: 'Wrong password.' });
  }
  joinRoom(u, room);
  send(ws, { t: 'rjoin', r: room.id, ok: true });
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

// ---------- joining: guest, log in to a registered profile, or create a profile ----------
const loginFails = new Map();   // ip -> { n, reset }  (failed profile logins)
const registrations = new Map(); // ip -> { n, reset }  (profiles created)
function limited(map, ip, max) { const e = map.get(ip); return !!e && e.reset > Date.now() && e.n >= max; }
function bump(map, ip, ms) {
  const now = Date.now();
  let e = map.get(ip);
  if (!e || e.reset < now) map.set(ip, e = { n: 0, reset: now + ms });
  e.n++;
}
setInterval(() => { const now = Date.now(); for (const m of [loginFails, registrations]) for (const [k, e] of m) if (e.reset < now) m.delete(k); }, 60000).unref();

/** Gender, age, country and state from a join/profile message → { g, age, loc, cc } or { error } */
function readProfile(m, ws) {
  const g = m.g === 'f' || m.g === 'm' ? m.g : null;
  const age = Number.isInteger(m.age) ? m.age : parseInt(m.age, 10);
  let cc = typeof m.cc === 'string' ? m.cc.toLowerCase() : '';
  if (GEO_LOCK && ws.ipcc && COUNTRY_CODES.has(ws.ipcc)) cc = ws.ipcc;
  const loc = cleanText(m.loc, 60);   // state / region, from the country's list
  if (!g) return { error: 'Please choose a gender' };
  if (!(age >= 18 && age <= 99)) return { error: 'You must be 18 or older' };
  if (!COUNTRY_CODES.has(cc)) return { error: 'Please choose a country' };
  if (!validState(cc, loc)) return { error: (Geo.STATES[cc] || []).length ? 'Please choose your state' : 'Invalid state' };
  return { g, age, loc, cc };
}

/** What everyone's user list gets: [id, name, gender, age, state, country, registered, photo version] */
function tupleOf(u) {
  const acct = u.acct && accounts.get(u.acct);
  return [u.id, u.name, u.g, u.age, u.loc, u.cc, acct ? 1 : 0, (acct && acct.photoV) || 0, u.idleSince || 0, u.status || '', u.statusSince || 0];
}
function myAccount(u) {
  const a = u.acct && accounts.get(u.acct);
  return a ? { name: a.name, bio: a.bio || '', photoV: a.photoV, created: a.created } : null;
}
/** Re-send someone's list entry to everyone after their profile changed. */
function refreshUser(u) {
  u.tuple = tupleOf(u);
  snapshot = null;
  if (!u.invisible) broadcast(JSON.stringify({ t: 'uu', u: u.tuple }));
}

async function join(ws, m) {
  if (ws.user || ws.joining) return;
  const mode = m.mode === 'login' || m.mode === 'register' ? m.mode : 'guest';
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  const device = typeof m.dev === 'string' && DEVICE_RE.test(m.dev) ? m.dev : null;
  const fail = (e, extra) => send(ws, { t: 'err', e, join: true, ...extra });

  const ban = bans.match(isLoopback(ws.ip) ? null : ws.ip, device);
  if (ban) return fail('You are banned from this chat' + (ban.until ? ` until ${new Date(ban.until).toUTCString()}` : '') + '.');
  if (!NAME_RE.test(name)) return fail('Username must be 3–16 letters, numbers or _');
  if (users.size >= MAX_USERS) return fail('The chat is full, please try again shortly');

  let profile = null;
  if (mode !== 'login') {
    if (!filter.nameAllowed(name)) return fail('That username is not allowed');
    profile = readProfile(m, ws);
    if (profile.error) return fail(profile.error);
    if (accounts.get(name)) {
      return fail(mode === 'register' ? 'That username is already registered. Log in instead, or choose another name.'
        : 'That username belongs to a registered profile. Log in with its password, or choose another name.', { code: 'registered' });
    }
    if (names.has(name.toLowerCase())) return fail('That username is taken right now');
  }
  if (mode === 'register') {
    try { accounts.checkPassword(m.pw); accounts.cleanBio(m.bio); } catch (e) { return fail(e.message); }
    if (!isLoopback(ws.ip) && limited(registrations, ws.ip, 3)) return fail('Too many new profiles from your connection. Please try again in an hour.');
  }
  if (mode === 'login' && limited(loginFails, ws.ip, 8)) return fail('Too many wrong passwords. Please wait 15 minutes and try again.');

  // Bots: a hidden form field people never see or fill in, then the bot check.
  if (typeof m.hp === 'string' && m.hp !== '') {
    stats.spam.honeypot++;
    return fail('Could not join. Please reload the page and try again.', { code: 'captcha' });
  }
  ws.joining = true;
  let acct = null, warn = null;
  try {
    if (!(await captcha.verify(m.cap, ws.ip))) return fail('Bot check failed. Please try again.', { code: 'captcha' });
    if (mode === 'login') {
      acct = await accounts.login(name, m.pw);
      if (!acct) { bump(loginFails, ws.ip, 15 * 60000); return fail('Wrong username or password.'); }
      loginFails.delete(ws.ip);
      profile = { g: acct.g, age: acct.age, loc: acct.loc, cc: acct.cc };
      if (GEO_LOCK && ws.ipcc && COUNTRY_CODES.has(ws.ipcc) && ws.ipcc !== acct.cc) profile = { ...profile, cc: ws.ipcc, loc: '' };
    } else if (mode === 'register') {
      try { acct = await accounts.register(name, m.pw, profile, m.bio); } catch (e) { return fail(e.message); }
      bump(registrations, ws.ip, 3600000);
      if (typeof m.photo === 'string' && m.photo) try { accounts.setPhoto(acct, m.photo); } catch (e) { warn = `Profile created, but the photo was not saved: ${e.message}`; }
    }
  } finally { ws.joining = false; }
  if (ws.readyState !== 1 || ws.user) return;
  const display = acct ? acct.name : name;
  // re-check anything that could have changed while verifying
  if (names.has(display.toLowerCase())) return fail(acct ? 'This profile is already logged in somewhere else.' : 'That username is taken right now');
  if (users.size >= MAX_USERS) return fail('The chat is full, please try again shortly');
  if (acct) accounts.touch(acct);

  clearTimeout(ws.joinTimer);
  const u = {
    id: nextId++, name: display, ...profile, ws, ip: ws.ip, ipcc: ws.ipcc, device, acct: acct ? acct.key : null, joined: Date.now(), msgCount: 0,
    roomTimes: [], pmBucket: bucket(15), imgBucket: bucket(3), tyBucket: bucket(3), draftBucket: bucket(30), roomPwBucket: bucket(5), profileBucket: bucket(5), friendBucket: bucket(20), readBucket: bucket(20), idleBucket: bucket(6), idleSince: 0, statusBucket: bucket(6), status: '', statusSince: 0, invisible: false,
    blocked: new Set(), convoKeys: new Set(), rooms: new Set(),
  };
  u.tuple = tupleOf(u);
  antispam.init(u);
  ws.user = u;

  // Snapshot reflects the list as of its last rebuild; anything newer arrives in the next
  // batched delta (clients apply joins/leaves idempotently), so it is rebuilt at most once per tick.
  // Nobody is put in a room: people start in 1-to-1 mode and join rooms themselves.
  if (snapshot === null) snapshot = JSON.stringify(Array.from(users.values()).filter(x => !x.invisible).map(x => x.tuple));
  ws.send('{"t":"welcome","now":' + Date.now() + ',"live":' + settings.get('liveTyping') + ',"me":' + JSON.stringify(u.tuple) + ',"acct":' + JSON.stringify(myAccount(u)) +
    (warn ? ',"warn":' + JSON.stringify(warn) : '') +
    ',"rooms":' + JSON.stringify(rooms.publicList()) + ',"rc":' + JSON.stringify(roomCounts()) + ',"in":[]' +
    ',"users":' + snapshot + '}');

  users.set(u.id, u);
  if (u.acct) { onlineAccts.set(u.acct, u); pushFriends(u.acct); }
  names.add(display.toLowerCase());
  pendingJoins.push(u.tuple);

  stats.totalJoins++;
  stats.countryJoins.set(u.cc, (stats.countryJoins.get(u.cc) || 0) + 1);
  if (users.size > stats.peak.n) stats.peak = { n: users.size, ts: Date.now() };
}

// ---------- friends (registered profiles only; saved with the accounts) ----------
const onlineAccts = new Map(); // account key -> online user
const MAX_FRIENDS = 500, MAX_PENDING = 100;
const lists = a => { a.friends = a.friends || []; a.reqIn = a.reqIn || []; a.reqOut = a.reqOut || []; return a; };
const without = (arr, k) => arr.filter(x => x !== k);
function friendState(acct) {
  const info = k => { const a = accounts.get(k); return a && { name: a.name, g: a.g, age: a.age, cc: a.cc, loc: a.loc, photoV: a.photoV || 0 }; };
  const l = lists(acct);
  return { t: 'friends', friends: l.friends.map(info).filter(Boolean), reqIn: l.reqIn.map(info).filter(Boolean), reqOut: l.reqOut.map(info).filter(Boolean) };
}
function pushFriends(key) {
  const u = onlineAccts.get(key), a = accounts.get(key);
  if (u && a) send(u.ws, friendState(a));
}
function dropFromFriendLists(key) {
  for (const a of accounts.list()) {
    if (!a.friends && !a.reqIn && !a.reqOut) continue;
    const l = lists(a), n = l.friends.length + l.reqIn.length + l.reqOut.length;
    a.friends = without(l.friends, key); a.reqIn = without(l.reqIn, key); a.reqOut = without(l.reqOut, key);
    if (a.friends.length + a.reqIn.length + a.reqOut.length !== n) { accounts.update(a, {}); pushFriends(a.key); }
  }
}
function friendRequest(ws, u, m) {
  const fail = e => send(ws, { t: 'frev', kind: 'error', e });
  const me = u.acct && accounts.get(u.acct);
  if (!me) return fail('Create a profile to add friends.');
  const other = accounts.get(m.name);
  if (!other) return fail('Only registered profiles can be added as friends.');
  if (other === me) return fail('That\'s you!');
  if (!allow(u.friendBucket, 0.2, 20)) return fail('Too many friend actions. Please wait a minute.');
  lists(me); lists(other);
  const notify = (to, kind) => { const t = onlineAccts.get(to.key); if (t) send(t.ws, { t: 'frev', kind, name: (to === other ? me : other).name }); };
  const becomeFriends = () => {
    me.friends = [...without(me.friends, other.key), other.key]; other.friends = [...without(other.friends, me.key), me.key];
    me.reqIn = without(me.reqIn, other.key); me.reqOut = without(me.reqOut, other.key);
    other.reqIn = without(other.reqIn, me.key); other.reqOut = without(other.reqOut, me.key);
  };
  switch (m.op) {
    case 'add':
      if (me.friends.includes(other.key)) return pushFriends(me.key);
      if (me.reqIn.includes(other.key)) { becomeFriends(); notify(other, 'accepted'); break; } // they already asked → friends
      if (me.reqOut.includes(other.key)) return pushFriends(me.key);
      if (me.friends.length >= MAX_FRIENDS) return fail(`You can have up to ${MAX_FRIENDS} friends.`);
      if (me.reqOut.length >= MAX_PENDING || other.reqIn.length >= MAX_PENDING) return fail('Too many pending friend requests.');
      me.reqOut.push(other.key); other.reqIn.push(me.key);
      notify(other, 'request');
      break;
    case 'accept':
      if (!me.reqIn.includes(other.key)) return pushFriends(me.key);
      if (me.friends.length >= MAX_FRIENDS) return fail(`You can have up to ${MAX_FRIENDS} friends.`);
      becomeFriends(); notify(other, 'accepted');
      break;
    case 'decline':
      me.reqIn = without(me.reqIn, other.key); other.reqOut = without(other.reqOut, me.key);
      break;
    case 'cancel':
      me.reqOut = without(me.reqOut, other.key); other.reqIn = without(other.reqIn, me.key);
      break;
    case 'remove':
      me.friends = without(me.friends, other.key); other.friends = without(other.friends, me.key);
      break;
    default: return;
  }
  accounts.update(me, {}); accounts.update(other, {});
  pushFriends(me.key); pushFriends(other.key);
}

// ---------- profile management while online ----------
async function profileRequest(ws, u, m) {
  const reply = (ok, e) => send(ws, { t: 'acct', op: m.t, ok, e, acct: myAccount(u), me: u.tuple });
  if (!allow(u.profileBucket, 0.1, 5)) return reply(false, 'Too many changes. Please wait a minute.');
  if (m.t === 'claim') {
    // a guest creates a profile for the name they're already using
    if (u.acct) return reply(false, 'You already have a profile.');
    if (accounts.get(u.name)) return reply(false, 'That username is already registered.');
    if (!isLoopback(u.ip) && limited(registrations, u.ip, 3)) return reply(false, 'Too many new profiles from your connection. Please try again in an hour.');
    let acct;
    try { acct = await accounts.register(u.name, m.pw, { g: u.g, age: u.age, loc: u.loc, cc: u.cc }, m.bio); } catch (e) { return reply(false, e.message); }
    bump(registrations, u.ip, 3600000);
    u.acct = acct.key;
    onlineAccts.set(acct.key, u);
    pushFriends(acct.key);
    let warn;
    if (typeof m.photo === 'string' && m.photo) try { accounts.setPhoto(acct, m.photo); } catch (e) { warn = e.message; }
    refreshUser(u);
    return reply(true, warn && `Profile created, but the photo was not saved: ${warn}`);
  }
  const acct = u.acct && accounts.get(u.acct);
  if (!acct) return reply(false, 'Create a profile first.');
  try {
    if (m.t === 'profile') {
      const p = readProfile(m, ws);
      if (p.error) return reply(false, p.error);
      const bio = accounts.cleanBio(m.bio);
      accounts.update(acct, { ...p, bio });
      Object.assign(u, p);
      if (m.removePhoto) accounts.removePhoto(acct);
      else if (typeof m.photo === 'string' && m.photo) accounts.setPhoto(acct, m.photo);
      refreshUser(u);
      return reply(true);
    }
    if (m.t === 'pwchange') {
      await accounts.changePassword(acct, String(m.cur || ''), m.next);
      return reply(true);
    }
  } catch (e) { return reply(false, e.message); }
}

function leave(ws) {
  const u = ws.user;
  if (!u) return;
  ws.user = null;
  users.delete(u.id);
  names.delete(u.name.toLowerCase());
  if (u.acct && onlineAccts.get(u.acct) === u) onlineAccts.delete(u.acct);
  pendingLeaves.push(u.id);
  for (const id of [...u.rooms]) leaveRoom(u, id);

  // Delete every private conversation this user was part of…
  for (const key of u.convoKeys) {
    const c = convos.get(key);
    if (!c) continue;
    for (const msg of c.msgs) releaseImg(msg);
    convos.delete(key);
    const other = users.get(c.a === u.id ? c.b : c.a);
    if (other) other.convoKeys.delete(key);
  }
  // …and their room messages from the moderation log.
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

// One tick: presence delta + each room's batch (sent only to that room's members).
setInterval(() => {
  if (pendingJoins.length || pendingLeaves.length) {
    const msg = JSON.stringify({ t: 'ud', j: pendingJoins, l: pendingLeaves });
    pendingJoins = [];
    pendingLeaves = [];
    snapshot = null;
    broadcast(msg);
  }
  if (pendingIdle.size) {
    const msg = JSON.stringify({ t: 'ui', now: Date.now(), u: [...pendingIdle].filter(([id]) => users.has(id) && !users.get(id).invisible) });
    pendingIdle.clear();
    snapshot = null;
    broadcast(msg);
  }
  if (pendingStatus.size) {
    const list = [...pendingStatus].filter(([id]) => users.has(id) && !users.get(id).invisible).map(([id, [s, at]]) => [id, s, at]);
    pendingStatus.clear();
    if (list.length) broadcast(JSON.stringify({ t: 'us', now: Date.now(), u: list }));
  }
  for (const [id, q] of pendingRoom) {
    const batch = q.splice(0, MAX_ROOM_MSGS_PER_FLUSH);
    if (!q.length) pendingRoom.delete(id);
    sendToRoom(id, JSON.stringify({ t: 'room', r: id, m: batch }));
  }
}, FLUSH_MS);

// Room member counts for everyone's room list, at most every 3 seconds.
setInterval(() => {
  if (!roomCountsDirty) return;
  roomCountsDirty = false;
  broadcast(JSON.stringify({ t: 'rc', c: roomCounts() }));
}, 3000);

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

server.listen(PORT, () => console.log(`ChateX listening on http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`));

function shutdown() {
  if (filter.dirty) filter.save();
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  // let queued database writes finish (at most 5s), then exit
  Promise.race([store.flush(), new Promise(r => setTimeout(r, 5000))]).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
