'use strict';
/*
 * Load test: opens N simulated users, then has some of them chat in the main room
 * and send private messages, and reports end-to-end latency.
 *
 *   node loadtest.js [users=7000] [url=ws://localhost:3000/ws] [seconds=60]
 *
 * Only the "talkers" parse incoming JSON; the rest just count bytes, so this process
 * stays light enough to be run on the same machine as the server.
 */
const WebSocket = require('ws');
const N = +process.argv[2] || 7000;
const URL = process.argv[3] || 'ws://localhost:3000/ws';
const DURATION = (+process.argv[4] || 60) * 1000;
const TALKERS = Math.min(300, Math.floor(N * 0.04));   // chat in the room
const PM_PAIRS = Math.min(1000, Math.floor(N * 0.15)); // private chats
const CC = ['us', 'gb', 'ca', 'de', 'in', 'br', 'ph', 'au', 'fr', 'mx'];
const STATES = require('./geo-states.json');  // joins must use a real state of the chosen country

let open = 0, joined = 0, failed = 0, bytes = 0;
const roomLat = [], pmLat = [];
const clients = [];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function spawn(i) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL, { perMessageDeflate: false });
    const c = { ws, i, id: 0, parse: i < TALKERS || i < PM_PAIRS * 2 };
    clients[i] = c;
    ws.on('open', () => {
      open++;
      ws.send(JSON.stringify({ t: 'join', name: 'u' + i + '_' + Math.random().toString(36).slice(2, 6), g: Math.random() < 0.5 ? 'f' : 'm',
        age: 18 + Math.floor(Math.random() * 40), ...(cc => ({ cc, loc: pick(STATES[cc]) }))(pick(CC)) }));
    });
    ws.on('message', data => {
      bytes += data.length;
      if (!c.id) {
        const m = JSON.parse(data);
        if (m.t === 'welcome') { c.id = m.me[0]; joined++; resolve(); }
        else if (m.t === 'err') { failed++; resolve(); }
        return;
      }
      if (!c.parse) return;
      const m = JSON.parse(data);
      const now = Date.now();
      if (m.t === 'room') for (const r of m.m) { if (r[0] === c.id) roomLat.push(now - +r[3].split(':')[1]); }
      else if (m.t === 'pm' && m.x) pmLat.push(now - +m.x.split(':')[1]);
    });
    ws.on('error', () => { failed++; resolve(); });
    ws.on('close', () => { open--; });
  });
}

function pct(a, p) { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] + 'ms'; }

(async () => {
  const httpUrl = URL.replace(/^ws/, 'http').replace(/\/ws$/, '/challenge');
  const ch = await fetch(httpUrl).then(r => r.json()).catch(() => ({}));
  if (ch.mode && ch.mode !== 'off') {
    console.error('The bot check is on, so simulated users cannot join. Start the server with CAPTCHA=off for load tests:\n  CAPTCHA=off node server.js');
    process.exit(1);
  }
  const t0 = Date.now();
  const BATCH = 200;
  for (let i = 0; i < N; i += BATCH) {
    await Promise.all(Array.from({ length: Math.min(BATCH, N - i) }, (_, k) => spawn(i + k)));
    process.stdout.write(`\rconnected ${joined}/${N} (failed ${failed})`);
  }
  console.log(`\nAll joined in ${((Date.now() - t0) / 1000).toFixed(1)}s. Chatting for ${DURATION / 1000}s: ${TALKERS} room talkers, ${PM_PAIRS} private pairs…`);

  // Room: each talker sends every ~8s (server allows 1 per 2s). PM pairs: ~1 msg/s each.
  const timers = [];
  for (let i = 0; i < TALKERS; i++) {
    timers.push(setInterval(() => { const c = clients[i]; if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'room', x: 'hi:' + Date.now() })); }, 8000 + Math.random() * 2000));
  }
  for (let p = 0; p < PM_PAIRS; p++) {
    const a = clients[p * 2], b = clients[p * 2 + 1];
    timers.push(setInterval(() => { if (a.ws.readyState === 1 && b.id) a.ws.send(JSON.stringify({ t: 'pm', to: b.id, c: 1, x: 'yo:' + Date.now() })); }, 1000 + Math.random() * 500));
  }

  const report = setInterval(() => {
    console.log(`open=${open} room msgs=${roomLat.length} p50=${pct(roomLat, .5)} p99=${pct(roomLat, .99)} | pm msgs=${pmLat.length} p50=${pct(pmLat, .5)} p99=${pct(pmLat, .99)} | recv=${(bytes / 1048576).toFixed(0)}MB`);
  }, 10000);

  setTimeout(() => {
    timers.forEach(clearInterval); clearInterval(report);
    console.log('\n=== RESULT ===');
    console.log(`users connected: ${joined}/${N}, still open: ${open}, failed: ${failed}`);
    console.log(`room message latency  p50=${pct(roomLat, .5)} p95=${pct(roomLat, .95)} p99=${pct(roomLat, .99)} (n=${roomLat.length}, includes ${60}ms batching)`);
    console.log(`private message latency p50=${pct(pmLat, .5)} p95=${pct(pmLat, .95)} p99=${pct(pmLat, .99)} (n=${pmLat.length})`);
    for (const c of clients) c && c.ws.terminate();
    setTimeout(() => process.exit(0), 500);
  }, DURATION);
})();
