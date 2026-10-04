'use strict';
/*
 * Admin → Load test: the server connects N simulated users to itself over real WebSockets
 * (127.0.0.1), joins them to a room, has some of them chat, and reports how it copes:
 * connected / failed, room-message latency, memory and event-loop delay.
 *
 * Test users are always visibly marked: names start with "Test_", they carry a TEST badge in
 * every list (tuple flag), and their messages say they are load-test messages. They skip the bot
 * check only with a random per-process token, which is accepted from loopback connections only.
 */
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const WebSocket = require('ws');

const TOKEN = crypto.randomBytes(24).toString('base64url');
const ARAB = ['ae', 'sa', 'eg', 'qa', 'kw', 'om', 'bh', 'jo', 'lb', 'iq', 'ma', 'dz', 'tn', 'ly', 'sy', 'ps', 'ye', 'sd'];
const MAX_COUNT = 3000, MAX_MINUTES = 30, MAX_PER_MIN = 600;
const RAMP_BATCH = 50, RAMP_EVERY = 250; // up to 200 joins per second
const TALKERS = 25;                     // users that post messages and measure latency

const pick = a => a[Math.floor(Math.random() * a.length)];
const lag = ns => Math.max(0, +(ns / 1e6 - 20).toFixed(1));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function createLoadTest({ port, states, roomIds }) {
  let run = null; // the current or last run

  function status() {
    if (!run) return { running: false };
    const lat = run.lat;
    return {
      running: run.running, count: run.count, room: run.room, perMin: run.perMin, minutes: run.minutes,
      started: run.started, endsAt: run.endsAt, stopped: run.stopped || null,
      connected: run.joined, open: run.clients.filter(c => c.ws.readyState === 1 && c.id).length, failed: run.failed,
      errors: Object.entries(run.errors).sort((a, b) => b[1] - a[1]).slice(0, 5),
      messages: { sent: run.sent, measured: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat.length ? Math.max(...lat) : null },
      receivedMB: +(run.bytes / 1048576).toFixed(1),
      rssMB: Math.round(process.memoryUsage().rss / 1048576), peakRssMB: run.peakRss,
      // the histogram includes its own 20 ms sampling interval; report only the extra delay
      loopDelayMs: { p50: lag(run.loop.percentile(50)), p99: lag(run.loop.percentile(99)), max: lag(run.loop.max) },
    };
  }

  function connectOne(i) {
    const cc = pick(ARAB), st = states[cc] || [];
    const c = { id: 0, talker: i < TALKERS, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`), pending: new Map() };
    run.clients.push(c);
    const r = run;
    c.ws.on('open', () => c.ws.send(JSON.stringify({
      t: 'join', lt: TOKEN, name: 'Test_' + String(i + 1).padStart(4, '0'),
      g: Math.random() < 0.5 ? 'f' : 'm', age: 18 + Math.floor(Math.random() * 40), cc, loc: st.length ? pick(st) : '',
    })));
    c.ws.on('message', data => {
      r.bytes += data.length;
      if (c.id && !c.talker) return; // only talkers parse (keeps the test from measuring itself)
      const m = JSON.parse(data);
      if (m.t === 'welcome') { c.id = m.me[0]; r.joined++; c.ws.send(JSON.stringify({ t: 'rjoin', r: r.room })); }
      else if (m.t === 'err' && m.join) { r.failed++; r.errors[m.e] = (r.errors[m.e] || 0) + 1; c.ws.close(); }
      else if (m.t === 'room' && m.r === r.room) {
        for (const [from, , , x] of m.m) if (from === c.id) { const t0 = c.pending.get(x); if (t0) { c.pending.delete(x); if (r.lat.length < 50000) r.lat.push(Date.now() - t0); } }
      }
    });
    c.ws.on('error', e => { if (!c.id) { r.failed++; r.errors[e.message] = (r.errors[e.message] || 0) + 1; } });
  }

  function start(opts) {
    if (run && run.running) throw new Error('A load test is already running');
    const count = Math.round(+opts.count), minutes = +opts.minutes, perMin = Math.round(+opts.perMin || 0);
    if (!(count >= 1 && count <= MAX_COUNT)) throw new Error(`Users must be 1–${MAX_COUNT}`);
    if (!(minutes >= 0.5 && minutes <= MAX_MINUTES)) throw new Error(`Duration must be 0.5–${MAX_MINUTES} minutes`);
    if (!(perMin >= 0 && perMin <= MAX_PER_MIN)) throw new Error(`Messages per minute must be 0–${MAX_PER_MIN}`);
    const room = typeof opts.room === 'string' && roomIds().includes(opts.room) ? opts.room : null;
    if (!room) throw new Error('Choose a room without a password');

    const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
    run = { running: true, count, minutes, perMin, room, started: Date.now(), endsAt: Date.now() + minutes * 60000,
      clients: [], joined: 0, failed: 0, errors: {}, sent: 0, lat: [], bytes: 0, loop, peakRss: 0, timers: [] };
    const r = run;

    let next = 0;
    r.timers.push(setInterval(() => {
      for (let k = 0; k < RAMP_BATCH && next < count; k++) connectOne(next++);
    }, RAMP_EVERY));
    if (perMin > 0) {
      let seq = 0;
      r.timers.push(setInterval(() => {
        const talkers = r.clients.filter(c => c.talker && c.id && c.ws.readyState === 1);
        if (!talkers.length) return;
        const c = talkers[seq % talkers.length];
        const x = `🧪 Load test message #${++seq}`;
        c.pending.set(x, Date.now());
        c.ws.send(JSON.stringify({ t: 'room', r: r.room, x }));
        r.sent++;
      }, Math.max(100, 60000 / perMin)));
    }
    r.timers.push(setInterval(() => { r.peakRss = Math.max(r.peakRss, Math.round(process.memoryUsage().rss / 1048576)); }, 1000));
    r.timers.push(setTimeout(() => stop('finished'), minutes * 60000));
    return status();
  }

  function stop(reason = 'stopped') {
    if (!run || !run.running) return status();
    run.running = false;
    run.stopped = { at: Date.now(), reason };
    for (const t of run.timers) { clearInterval(t); clearTimeout(t); }
    for (const c of run.clients) { try { c.ws.close(); } catch {} }
    run.loop.disable();
    const done = run;
    setTimeout(() => { done.clients = done.clients.filter(c => c.ws.readyState === 1); }, 3000);
    return status();
  }

  return { TOKEN, start, stop, status, limits: { MAX_COUNT, MAX_MINUTES, MAX_PER_MIN } };
}

module.exports = createLoadTest;
