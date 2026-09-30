(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryName = cc => { try { return regionNames.of(cc.toUpperCase()); } catch { return cc.toUpperCase(); } };
  const flagUrl = cc => `https://flagcdn.com/w40/${cc}.png`;
  const flagSrcset = cc => `https://flagcdn.com/w80/${cc}.png 2x`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const AVATAR = {
    f: '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="#fff" d="M32 13c-7.6 0-12.6 5.8-12.6 13.6 0 5.6 1 9.4-2.4 13.4 3.3 1.3 6.6 1.1 9-.4 1.8 1.2 3.8 1.8 6 1.8s4.2-.6 6-1.8c2.4 1.5 5.7 1.7 9 .4-3.4-4-2.4-7.8-2.4-13.4C44.6 18.8 39.6 13 32 13z"/><path fill="#fff" d="M10 64c0-11.5 9.8-18.5 22-18.5S54 52.5 54 64z"/></svg>',
    m: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle fill="#fff" cx="32" cy="26" r="11.5"/><path fill="#fff" d="M10 64c0-11.5 9.8-18.5 22-18.5S54 52.5 54 64z"/></svg>',
  };
  const avatar = g => `<div class="av ${g}">${AVATAR[g]}</div>`;
  const subLine = u => [u.age + ' Yrs', u.loc, countryName(u.cc)].filter(Boolean).join(', ');
  const flagImg = u => `<img class="flag" src="${flagUrl(u.cc)}" srcset="${flagSrcset(u.cc)}" alt="${esc(countryName(u.cc))}" title="${esc(countryName(u.cc))}" loading="lazy" width="40" height="30">`;

  // ---------------- state ----------------
  const S = {
    ws: null, me: null,
    users: new Map(),     // id -> {id,name,g,age,loc,cc,seq}
    seq: 0,
    convos: new Map(),    // userId -> {msgs:[], unread, last}
    room: { msgs: [], unread: 0 },
    active: 'room',       // 'room' | userId
    filter: 'all', q: '',
    view: [], viewDirty: true,
    pendingAcks: new Map(),
    clientSeq: 0, lastTyping: 0,
    sound: store.get('chatr.sound') !== false,   // message chime
    live: store.get('chatr.live') !== false,     // share my live typing
    liveAllowed: true,                           // admin setting, from the server
    draftTo: null,                               // who is currently seeing my live typing
  };
  const MAX_ROOM = 250, MAX_PM = 300;

  // ---------------- login ----------------
  const sel = $('fCountry');
  const opts = COUNTRY_CODES.map(cc => [cc, countryName(cc)]).sort((a, b) => a[1].localeCompare(b[1]));
  sel.innerHTML = '<option value="">Select country…</option>' + opts.map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join('');
  const setFlag = () => { const cc = sel.value; $('fFlag').style.visibility = cc ? 'visible' : 'hidden'; if (cc) $('fFlag').src = flagUrl(cc); };
  const stateSel = $('fState');

  // State / region dropdown: the list is fetched per country (and cached) when the country changes.
  const stateCache = new Map();
  let stateLoad = 0;
  async function loadStates(cc, preferred) {
    const ticket = ++stateLoad;
    if (!cc) {
      stateSel.innerHTML = '<option value="">Select a country first</option>';
      stateSel.disabled = true; $('stateField').hidden = false;
      return;
    }
    stateSel.disabled = true;
    stateSel.innerHTML = '<option value="">Loading…</option>';
    let list = stateCache.get(cc);
    if (!list) {
      try { list = (await fetch('/states?cc=' + cc).then(r => r.json())).states; stateCache.set(cc, list); }
      catch { list = []; }
    }
    if (ticket !== stateLoad) return; // the country changed again while loading
    $('stateField').hidden = !list.length; // tiny territories have no states
    stateSel.innerHTML = '<option value="">Select state / region…</option>' + list.map(n => `<option>${esc(n)}</option>`).join('');
    stateSel.disabled = false;
    if (preferred && list.includes(preferred)) stateSel.value = preferred;
  }

  let pickedCountryByHand = false, pickedStateByHand = false;
  sel.addEventListener('change', () => { pickedCountryByHand = true; pickedStateByHand = false; setFlag(); loadStates(sel.value); updateHint(); });
  stateSel.addEventListener('change', () => { pickedStateByHand = true; updateHint(); });

  const saved = store.get('chatr.profile');
  if (saved) {
    $('fName').value = saved.name || '';
    $('fAge').value = saved.age || '';
    sel.value = saved.cc || '';
    const r = document.querySelector(`input[name=g][value="${saved.g}"]`);
    if (r) r.checked = true;
  }
  setFlag();
  loadStates(sel.value, saved && saved.loc);

  // Detect country AND state from the visitor's IP. If they corrected the state on a previous visit
  // (same country), their correction wins. If detection fails, nothing is guessed.
  let detected = null;
  function updateHint() {
    const h = $('geoHint');
    if (!detected || sel.value !== detected.cc) { h.hidden = true; return; }
    const place = [detected.state, countryName(detected.cc)].filter(Boolean).join(', ');
    const differs = detected.state && stateSel.value && stateSel.value !== detected.state;
    h.innerHTML = `<img src="${flagUrl(detected.cc)}" alt="" width="20" height="15"> ` +
      `${detected.locked ? 'Detected from your connection' : 'Detected from your IP'}: <b>${esc(place)}</b>` +
      (differs ? ' <span class="muted">· you changed the state</span>' : !detected.state ? ' <span class="muted">· please pick your state</span>' : '');
    h.hidden = false;
  }
  fetch('/geo', { cache: 'no-store' }).then(r => r.json()).then(async ({ cc, state, locked }) => {
    if (!cc || !COUNTRY_CODES.includes(cc)) return;
    detected = { cc, state, locked };
    if (locked) sel.disabled = true;
    if (!pickedCountryByHand || locked) {
      const remembered = saved && saved.cc === cc && saved.loc;   // their own earlier choice for this country
      const keepState = sel.value === cc && stateSel.value && pickedStateByHand;
      sel.value = cc; setFlag();
      if (!keepState) await loadStates(cc, remembered || state);
    }
    updateHint();
  }).catch(() => {});

  // ---------------- bot check (runs in the background while the form is filled in) ----------------
  const Cap = { job: null, mode: null, widget: null };
  function capStatus(state) {
    const el = $('capStatus');
    el.dataset.state = state;
    el.textContent = { checking: '🛡️ Checking you\u2019re human…', ok: '✓ Verified human', error: '⚠ Bot check could not load. Please reload the page.', off: '' }[state];
    el.hidden = state === 'off';
  }
  function prepareCaptcha() {
    if (Cap.widget != null && window.turnstile) { try { turnstile.remove(Cap.widget); } catch {} Cap.widget = null; }
    capStatus('checking');
    Cap.job = fetch('/challenge', { cache: 'no-store' }).then(r => r.json()).then(ch => {
      Cap.mode = ch.mode;
      if (ch.mode === 'pow') return solvePow(ch);
      if (ch.mode === 'turnstile') return turnstileToken(ch.siteKey);
      return { value: null, expires: Infinity };
    }).then(r => { capStatus(Cap.mode === 'off' ? 'off' : 'ok'); return r; }, err => { capStatus('error'); throw err; });
    Cap.job.catch(() => {});
  }
  function solvePow(ch) {
    return new Promise((resolve, reject) => {
      const w = new Worker('/pow-worker.js');
      w.onmessage = e => { w.terminate(); resolve({ value: { salt: ch.salt, sig: ch.sig, nonce: e.data.nonce }, expires: +ch.salt.split('.')[0] }); };
      w.onerror = e => { w.terminate(); reject(e); };
      w.postMessage({ salt: ch.salt, difficulty: ch.difficulty });
    });
  }
  let turnstileScript;
  function turnstileToken(siteKey) {
    turnstileScript = turnstileScript || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return turnstileScript.then(() => new Promise((resolve, reject) => {
      $('capBox').hidden = false;
      Cap.widget = turnstile.render('#capBox', {
        sitekey: siteKey, theme: 'light', size: 'flexible',
        callback: token => resolve({ value: token, expires: Date.now() + 290000 }),
        'expired-callback': () => prepareCaptcha(),
        'error-callback': () => reject(new Error('turnstile')),
      });
    }));
  }
  async function getCaptcha() {
    let r;
    try { r = await Cap.job; } catch { prepareCaptcha(); r = await Cap.job; }
    if (r.expires < Date.now() + 5000) { prepareCaptcha(); r = await Cap.job; } // puzzle expired while the form sat open
    return r.value;
  }
  prepareCaptcha();

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const profile = {
      name: $('fName').value.trim(),
      g: (document.querySelector('input[name=g]:checked') || {}).value,
      age: parseInt($('fAge').value, 10),
      loc: $('stateField').hidden ? '' : stateSel.value,
      cc: sel.value,
    };
    const err = !/^[A-Za-z0-9_]{3,16}$/.test(profile.name) ? 'Username must be 3–16 letters, numbers or _'
      : !profile.g ? 'Please choose a gender'
      : !(profile.age >= 18 && profile.age <= 99) ? 'You must be 18 or older'
      : !profile.cc ? 'Please choose a country'
      : !$('stateField').hidden && !profile.loc ? 'Please choose your state / region' : '';
    $('loginErr').textContent = err;
    if (err) return;
    store.set('chatr.profile', profile);
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Verifying…';
    let cap;
    try { cap = await getCaptcha(); } catch {
      $('loginBtn').disabled = false; $('loginBtn').textContent = 'Start chatting';
      $('loginErr').textContent = 'Bot check could not load. Please reload the page.';
      return;
    }
    connect(profile, cap, 0);
  });

  // ---------------- socket ----------------
  function connect(profile, cap, attempt) {
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Connecting…';
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    S.ws = ws;
    let joined = false;
    let dev = store.get('chatr.dev');
    if (!/^[a-f0-9]{32}$/.test(dev || '')) {
      dev = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      store.set('chatr.dev', dev);
    }
    S.closeReason = '';
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', ...profile, dev, cap, hp: $('fWebsite').value }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { joined = true; onWelcome(m); return; }
      if (m.t === 'err' && m.join) {
        if (m.code === 'captcha') {
          prepareCaptcha(); // that answer is used up
          if (attempt === 0) { // e.g. it expired: solve a fresh one and retry once, invisibly
            S.ws = null; ws.close();
            getCaptcha().then(c => connect(profile, c, 1), () => { $('loginBtn').disabled = false; $('loginBtn').textContent = 'Start chatting'; $('loginErr').textContent = m.e; });
            return;
          }
        }
        $('loginErr').textContent = m.e; ws.close();
        return;
      }
      if (joined) onMessage(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.ws = null;
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = 'Start chatting';
      if (joined) resetToLogin(S.closeReason || 'You were disconnected. Your chat history has been deleted.');
      else if (!$('loginErr').textContent) $('loginErr').textContent = 'Could not connect. Please try again.';
    };
  }
  const send = obj => { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; } return false; };

  function onWelcome(m) {
    S.liveAllowed = m.live !== false;
    S.me = toUser(m.me);
    S.users.clear();
    for (const t of m.users) addUser(t);
    $('meBox').innerHTML = `${avatar(S.me.g)}<div class="info"><div class="nm">${esc(S.me.name)}</div><div class="sub">${esc(subLine(S.me))}</div></div>`;
    $('login').hidden = true;
    $('app').hidden = false;
    $('loginNotice').hidden = true;
    openChat('room');
    markDirty();
    sysMsg('room', `Welcome ${S.me.name}! Say hi to the room, or tap someone to chat privately.`);
  }

  function resetToLogin(notice) {
    // Everything lives in memory only; drop it all.
    S.users.clear(); S.convos.clear(); S.room = { msgs: [], unread: 0 }; S.pendingAcks.clear();
    S.me = null; S.view = [];
    $('msgs').innerHTML = '';
    document.body.classList.remove('chat-open');
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginErr').textContent = '';
    $('loginNotice').textContent = notice || '';
    $('loginNotice').hidden = !notice;
    prepareCaptcha(); // a fresh bot check for the next login
    updateTitle();
  }
  $('logoutBtn').onclick = () => {
    const ws = S.ws; S.ws = null;
    if (ws) ws.close();
    $('loginBtn').disabled = false; $('loginBtn').textContent = 'Start chatting';
    resetToLogin('You left the chat. All messages were deleted.');
  };

  const toUser = t => ({ id: t[0], name: t[1], g: t[2], age: t[3], loc: t[4], cc: t[5] });
  function addUser(t) {
    if (S.users.has(t[0]) || (S.me && t[0] === S.me.id)) return;
    const u = toUser(t); u.seq = ++S.seq;
    S.users.set(u.id, u);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'ud':
        for (const t of m.j) addUser(t);
        for (const id of m.l) userLeft(id);
        markDirty();
        break;
      case 'room':
        for (const [id, name, g, x, ts] of m.m) pushMsg('room', { from: id, name, g, x, ts, me: S.me && id === S.me.id });
        break;
      case 'pm': {
        if (!S.users.has(m.f)) return;
        hideDraft(m.f);
        pushMsg(m.f, { from: m.f, x: m.x, i: m.i, ts: m.ts });
        hideTyping(m.f);
        chime();
        break;
      }
      case 'ack': {
        const p = S.pendingAcks.get(m.c);
        S.pendingAcks.delete(m.c);
        if (p && m.ok && m.x) { p.msg.x = m.x; const b = p.msg.el && p.msg.el.querySelector('.bubble'); if (b) b.textContent = m.x; }
        if (p && !m.ok) {
          p.msg.fail = m.e || 'Not delivered';
          const el = p.msg.el;
          if (el) { el.classList.add('fail'); el.querySelector('.meta').textContent = '⚠ ' + p.msg.fail; }
        }
        break;
      }
      case 'ty': if (S.active === m.f) showTyping(); break;
      case 'draft': if (S.active === m.f) showDraft(m.x); break;
      case 'err': toast(m.e); break;
      case 'kicked': S.closeReason = m.e; break;
    }
  }

  function userLeft(id) {
    const u = S.users.get(id);
    if (!u) return;
    S.users.delete(id);
    if (S.convos.has(id)) {
      S.convos.delete(id);   // history is deleted as soon as the peer disconnects
      if (S.active === id) {
        hideDraft();
        $('msgs').innerHTML = '';
        sysMsg(null, `${u.name} has left. This chat has been deleted.`);
        $('composer').classList.add('disabled');
        $('headActions').hidden = true;
      }
      updateTitle();
    }
  }

  // ---------------- messages ----------------
  function convo(id) {
    if (id === 'room') return S.room;
    let c = S.convos.get(id);
    if (!c) { c = { msgs: [], unread: 0, last: 0 }; S.convos.set(id, c); }
    return c;
  }

  function pushMsg(target, msg) {
    const c = convo(target);
    c.msgs.push(msg);
    const cap = target === 'room' ? MAX_ROOM : MAX_PM;
    if (c.msgs.length > cap) c.msgs.splice(0, c.msgs.length - cap);
    if (target !== 'room') { c.last = Date.now(); markDirty(); }
    const visible = S.active === target && !document.hidden && ($('app').offsetParent !== null) &&
      (window.innerWidth > 720 || document.body.classList.contains('chat-open'));
    if (S.active === target) appendMsgEl(msg, target);
    if (!msg.me && !visible) { c.unread++; updateBadges(target); }
    return msg;
  }

  function sysMsg(target, text) {
    if (target && target !== S.active) return;
    const el = document.createElement('div');
    el.className = 'sys'; el.textContent = text;
    stickToBottom(() => $('msgs').appendChild(el));
  }

  const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  function msgEl(msg, target) {
    const el = document.createElement('div');
    el.className = 'msg' + (msg.me ? ' me' : '') + (msg.fail ? ' fail' : '');
    if (target === 'room' && !msg.me) {
      const who = document.createElement('div');
      who.className = 'who ' + msg.g; who.textContent = msg.name; who.dataset.uid = msg.from;
      el.appendChild(who);
    }
    const b = document.createElement('div');
    b.className = 'bubble';
    if (msg.i) {
      b.classList.add('pic');
      const img = document.createElement('img');
      img.src = msg.i; img.alt = 'Picture'; img.decoding = 'async';
      img.onload = () => { const box = $('msgs'); if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight; };
      b.appendChild(img);
    } else b.textContent = msg.x;
    el.appendChild(b);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = msg.fail ? '⚠ ' + msg.fail : timeFmt.format(msg.ts);
    el.appendChild(meta);
    return el;
  }

  function stickToBottom(fn) {
    const box = $('msgs');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    fn();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function appendMsgEl(msg, target) {
    const box = $('msgs');
    const el = msgEl(msg, target);
    msg.el = el;
    stickToBottom(() => {
      if (draftEl.isConnected) box.insertBefore(el, draftEl); else box.appendChild(el); // keep the live preview last
      // keep the DOM small in the busy main room
      while (box.childElementCount > (target === 'room' ? MAX_ROOM : MAX_PM)) box.firstElementChild.remove();
    });
    if (msg.me) box.scrollTop = box.scrollHeight;
  }

  // ---------------- open / render a chat ----------------
  function openChat(target) {
    if (target !== 'room' && !S.users.has(target)) return;
    if (S.draftTo && S.draftTo !== target) stopSharingDraft();
    S.active = target;
    hideTyping();
    hideDraft();
    const c = convo(target);
    c.unread = 0;
    const peer = $('peer');
    if (target === 'room') {
      peer.innerHTML = `<div class="av room">#</div><div class="info"><div class="nm">Main Room</div><div class="sub">${S.users.size + 1} people online · keep it friendly</div></div>`;
      $('picBtn').hidden = true;
      $('headActions').hidden = true;
    } else {
      const u = S.users.get(target);
      peer.innerHTML = `${avatar(u.g)}<div class="info"><div class="nm">${esc(u.name)}</div><div class="sub">${esc(subLine(u))}</div></div>${flagImg(u)}`;
      $('picBtn').hidden = false;
      $('headActions').hidden = false;
    }
    $('composer').classList.remove('disabled');
    renderLiveNote();
    const box = $('msgs');
    const frag = document.createDocumentFragment();
    for (const m of c.msgs) { m.el = msgEl(m, target); frag.appendChild(m.el); }
    box.replaceChildren(frag);
    if (target !== 'room' && !c.msgs.length) sysMsg(null, 'Private chat. Messages disappear when either of you leaves.');
    box.scrollTop = box.scrollHeight;
    document.body.classList.add('chat-open');
    updateBadges(target);
    renderList(true);
    if (window.innerWidth > 720) $('text').focus();
  }

  $('backBtn').onclick = () => { document.body.classList.remove('chat-open'); };
  $('closeBtn').onclick = () => {
    const id = S.active;
    if (id === 'room') return;
    S.convos.delete(id);
    markDirty();
    updateTitle();
    openChat('room');
    if (window.innerWidth <= 720) document.body.classList.remove('chat-open');
  };
  $('blockBtn').onclick = () => {
    const id = S.active;
    const u = S.users.get(id);
    if (!u || !confirm(`Block ${u.name}? You will no longer receive their messages.`)) return;
    send({ t: 'block', id });
    S.blocked = S.blocked || new Set();
    S.blocked.add(id);
    $('closeBtn').onclick();
    toast(`${u.name} blocked`);
  };
  $('msgs').addEventListener('click', e => {
    const who = e.target.closest('.who');
    if (who) { const id = +who.dataset.uid; if (S.users.has(id)) openChat(id); else toast('That user has left'); return; }
    if (e.target.tagName === 'IMG' && e.target.closest('.pic')) { $('lightbox').querySelector('img').src = e.target.src; $('lightbox').hidden = false; }
  });
  $('lightbox').onclick = () => { $('lightbox').hidden = true; $('lightbox').querySelector('img').removeAttribute('src'); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('lightbox').hidden = true; $('emojiPop').hidden = true; } });

  // ---------------- composer ----------------
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('text');
    const x = input.value.trim();
    if (!x) return;
    if (S.active === 'room') {
      if (!send({ t: 'room', x })) return toast('Not connected');
      // the server echoes our own room message back in the next batch
    } else {
      sendPm({ x });
    }
    input.value = '';
    $('emojiPop').hidden = true;
    if (S.draftTo) { clearTimeout(draftTimer); draftTimer = 0; S.draftTo = null; }
  });

  function sendPm(payload) {
    const to = S.active;
    if (!S.users.has(to)) return toast('That user has left');
    const c = ++S.clientSeq;
    const msg = pushMsg(to, { me: true, from: S.me.id, ts: Date.now(), ...payload });
    S.pendingAcks.set(c, { msg });
    if (!send({ t: 'pm', to, c, ...payload })) toast('Not connected');
  }

  $('text').addEventListener('input', () => {
    if (S.active === 'room') return;
    if (S.live && S.liveAllowed) return scheduleDraft();
    const now = Date.now();
    if (now - S.lastTyping > 2500) { S.lastTyping = now; send({ t: 'ty', to: S.active }); }
  });

  let typingTimer = 0;
  function showTyping() { $('typing').hidden = false; clearTimeout(typingTimer); typingTimer = setTimeout(hideTyping, 3500); }
  function hideTyping() { $('typing').hidden = true; clearTimeout(typingTimer); }

  // ---------------- live typing ----------------
  // Sending side: at most ~8 updates/second, always ending with the latest text.
  let draftTimer = 0, lastDraftAt = 0;
  function scheduleDraft() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = 0;
      lastDraftAt = Date.now();
      if (S.active === 'room' || !S.users.has(S.active)) return;
      S.draftTo = S.active;
      send({ t: 'draft', to: S.active, x: $('text').value.slice(0, 500) });
    }, Math.max(0, 120 - (Date.now() - lastDraftAt)));
  }
  function stopSharingDraft() {
    clearTimeout(draftTimer); draftTimer = 0;
    if (S.draftTo && S.users.has(S.draftTo)) send({ t: 'draft', to: S.draftTo, x: '' });
    S.draftTo = null;
  }
  // Receiving side: a dashed "ghost" bubble kept as the last item in the chat.
  const draftEl = document.createElement('div');
  draftEl.className = 'msg draft';
  draftEl.innerHTML = '<div class="bubble"></div><div class="meta"></div>';
  let draftHideTimer = 0;
  function showDraft(text) {
    if (!text || !text.trim()) return hideDraft();
    hideTyping();
    const u = S.users.get(S.active);
    draftEl.querySelector('.meta').textContent = `${u ? u.name : ''} is typing…`;
    stickToBottom(() => {
      draftEl.querySelector('.bubble').textContent = text;
      if (!draftEl.isConnected) $('msgs').appendChild(draftEl);
    });
    clearTimeout(draftHideTimer);
    draftHideTimer = setTimeout(hideDraft, 8000); // they stopped typing without sending
  }
  function hideDraft(from) {
    if (from !== undefined && from !== S.active) return;
    clearTimeout(draftHideTimer);
    draftEl.remove();
  }
  function renderLiveNote() {
    const note = $('liveNote');
    const u = S.users.get(S.active);
    note.hidden = S.active === 'room' || !u || !S.liveAllowed;
    if (note.hidden) return;
    note.innerHTML = S.live
      ? `👁 ${esc(u.name)} can see what you type as you type. <button type="button" data-live="off">Turn off</button>`
      : `Live typing is off. ${esc(u.name)} only sees “typing…”. <button type="button" data-live="on">Turn on</button>`;
  }
  $('liveNote').addEventListener('click', e => {
    const b = e.target.closest('[data-live]'); if (!b) return;
    S.live = b.dataset.live === 'on';
    store.set('chatr.live', S.live);
    if (!S.live) stopSharingDraft();
    renderLiveNote();
  });

  // ---------------- notification sound ----------------
  // A short two-note chime made with Web Audio (no sound file). Browsers only allow audio after
  // the user has interacted with the page, so the audio context is unlocked on the first click/key.
  let audioCtx = null, lastChime = 0;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true }));
  function chime() {
    if (!S.sound || !audioCtx || Date.now() - lastChime < 800) return;
    lastChime = Date.now();
    const t0 = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.12]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.45);
    });
  }
  function renderSoundBtn() {
    const b = $('soundBtn');
    b.textContent = S.sound ? '🔔' : '🔕';
    b.title = b.ariaLabel = S.sound ? 'Message sound on' : 'Message sound off';
  }
  $('soundBtn').onclick = () => {
    S.sound = !S.sound;
    store.set('chatr.sound', S.sound);
    renderSoundBtn();
    if (S.sound) { lastChime = 0; chime(); } // preview
  };
  renderSoundBtn();

  // emoji
  const EMOJI = '😀 😂 🥰 😍 😘 😊 😉 😎 🤔 😅 😭 😡 😴 🥺 😳 🙈 👍 👋 🙏 👏 💪 🔥 ✨ 🎉 ❤️ 💔 💯 🌹 ☕ 🍕 🎵 😇'.split(' ');
  $('emojiPop').innerHTML = EMOJI.map(e => `<button type="button">${e}</button>`).join('');
  $('emojiBtn').onclick = () => { $('emojiPop').hidden = !$('emojiPop').hidden; };
  $('emojiPop').onclick = e => {
    if (e.target.tagName !== 'BUTTON') return;
    const t = $('text');
    const pos = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, pos) + e.target.textContent + t.value.slice(t.selectionEnd ?? pos);
    t.focus();
    t.dispatchEvent(new Event('input'));
  };

  // pictures: downscale in the browser so they are small and fast to relay
  $('picBtn').onclick = () => $('picInput').click();
  $('picInput').onchange = async () => {
    const file = $('picInput').files[0];
    $('picInput').value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('Please choose an image');
    if (file.size > 25 * 1024 * 1024) return toast('Image is too large');
    try {
      sendPm({ i: await compressImage(file) });
    } catch {
      toast('Could not read that image');
    }
  };

  async function compressImage(file) {
    const bmp = await createImageBitmap(file);
    let max = 1280, quality = 0.82, url;
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
      url = cv.toDataURL('image/jpeg', quality);
      if (url.length < 900_000) break;
      max *= 0.8; quality -= 0.08;
    }
    bmp.close && bmp.close();
    return url;
  }

  // ---------------- user list (virtualized — smooth with 10k users) ----------------
  const list = $('list'), spacer = $('spacer');
  let rafPending = false;
  function markDirty() {
    S.viewDirty = true;
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderList(); }); }
  }

  function rebuildView() {
    const q = S.q.toLowerCase();
    let f = 0, m = 0;
    const chats = [], rest = [];
    for (const u of S.users.values()) {
      u.g === 'f' ? f++ : m++;
      if (S.filter !== 'all' && u.g !== S.filter) continue;
      if (q && !u.name.toLowerCase().includes(q) && !(u.loc || '').toLowerCase().includes(q) && !countryName(u.cc).toLowerCase().includes(q)) continue;
      (S.convos.has(u.id) ? chats : rest).push(u);
    }
    chats.sort((a, b) => S.convos.get(b.id).last - S.convos.get(a.id).last);
    rest.sort((a, b) => b.seq - a.seq);  // newest first
    S.view = chats.concat(rest);
    $('cAll').textContent = f + m; $('cF').textContent = f; $('cM').textContent = m;
    $('roomSub').textContent = `${f + m + 1} online`;
    S.viewDirty = false;
  }

  const rowH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 80;
  let RH = rowH();
  window.addEventListener('resize', () => { RH = rowH(); renderList(true); });

  let lastKey = '';
  function renderList(force) {
    if (!S.me) return;
    if (S.viewDirty) { rebuildView(); force = true; }
    const n = S.view.length;
    spacer.style.height = n * RH + 'px';
    const first = Math.max(0, Math.floor(list.scrollTop / RH) - 4);
    const last = Math.min(n, Math.ceil((list.scrollTop + list.clientHeight) / RH) + 4);
    const key = first + ':' + last;
    if (!force && key === lastKey) return;
    lastKey = key;
    let html = '';
    for (let i = first; i < last; i++) {
      const u = S.view[i];
      const c = S.convos.get(u.id);
      const unread = c && c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
      html += `<div class="row ${u.g}${S.active === u.id ? ' sel' : ''}" data-id="${u.id}" style="transform:translateY(${i * RH}px)">` +
        `${avatar(u.g)}<div class="info"><div class="nm">${esc(u.name)}</div><div class="sub">${esc(subLine(u))}</div></div>${unread}${flagImg(u)}</div>`;
    }
    if (!n) html = `<div class="empty">${S.q || S.filter !== 'all' ? 'No one matches.' : 'No one else is online yet.'}</div>`;
    // keep the spacer, replace rows
    list.replaceChildren(spacer);
    list.insertAdjacentHTML('beforeend', html);
    $('roomRow').classList.toggle('sel', S.active === 'room');
  }
  list.addEventListener('scroll', () => { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderList(); }); } }, { passive: true });
  list.addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openChat(+r.dataset.id); });
  $('roomRow').onclick = () => openChat('room');

  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.filter = b.dataset.f;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    list.scrollTop = 0; markDirty();
  });
  let qTimer;
  $('search').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); list.scrollTop = 0; markDirty(); }, 120); });

  // ---------------- badges / title ----------------
  function updateBadges(target) {
    if (target === 'room') {
      const b = $('roomBadge');
      b.hidden = !S.room.unread;
      b.textContent = S.room.unread > 99 ? '99+' : S.room.unread;
    } else markDirty();
    updateTitle();
  }
  function updateTitle() {
    let n = 0;
    for (const c of S.convos.values()) n += c.unread;
    document.title = n ? `(${n}) Chatr` : 'Chatr';
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me) { const c = convo(S.active); if (c.unread) { c.unread = 0; updateBadges(S.active); } }
  });

  let toastTimer;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
})();
