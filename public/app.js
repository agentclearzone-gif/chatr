(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryName = cc => { try { return regionNames.of(cc.toUpperCase()); } catch { return cc.toUpperCase(); } };
  const flagUrl = cc => `https://flagcdn.com/w40/${cc}.png`;
  const flagSrcset = cc => `https://flagcdn.com/w80/${cc}.png 2x`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Emoji → Google Noto Emoji image (Apache 2.0, pinned version); matched emojis are shown as images in messages
  const NOTO = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.048/svg/';
  const emojiUrl = e => NOTO + 'emoji_u' + [...e].map(c => c.codePointAt(0).toString(16).padStart(4, '0')).filter(h => h !== 'fe0f').join('_') + '.svg';
  const ZWJ = String.fromCharCode(0x200d), VS16 = String.fromCharCode(0xfe0f);
  const EMOJI_RE = new RegExp('(?:\\p{Regional_Indicator}\\p{Regional_Indicator}|\\p{Extended_Pictographic}(?:' + VS16 + '|\\p{Emoji_Modifier})?(?:' + ZWJ + '\\p{Extended_Pictographic}(?:' + VS16 + '|\\p{Emoji_Modifier})?)*)', 'gu');
  /** Put message text into a bubble, showing emojis as images (falls back to the device's emoji if an image is missing). */
  function setBubbleText(el, text) {
    el.textContent = '';
    let last = 0, count = 0;
    text.replace(EMOJI_RE, (m, off) => {
      if (off > last) el.append(text.slice(last, off));
      const img = document.createElement('img');
      img.className = 'emj'; img.alt = m; img.draggable = false; img.src = emojiUrl(m);
      img.onerror = () => img.replaceWith(m);
      el.append(img);
      last = off + m.length; count++;
      return m;
    });
    if (last < text.length) el.append(text.slice(last));
    // 1–3 emojis and nothing else: show them big, like WhatsApp
    el.classList.toggle('big-emoji', count > 0 && count <= 3 && !text.replace(EMOJI_RE, '').trim());
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  // Settings, remembered on this device
  const prefs = Object.assign({ pmFrom: 'all', receipts: true, desktop: false, previews: true, popups: true, enterSend: true,
    theme: store.get('chatr.dark') === true ? 'dark' : 'light', fontSize: 'm', lang: 'en', pin: null, pinSalt: null, lockAfter: 5 }, store.get('chatr.prefs') || {});
  const savePrefs = () => store.set('chatr.prefs', prefs);

  const AVATAR = {
    f: '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="#fff" d="M32 13c-7.6 0-12.6 5.8-12.6 13.6 0 5.6 1 9.4-2.4 13.4 3.3 1.3 6.6 1.1 9-.4 1.8 1.2 3.8 1.8 6 1.8s4.2-.6 6-1.8c2.4 1.5 5.7 1.7 9 .4-3.4-4-2.4-7.8-2.4-13.4C44.6 18.8 39.6 13 32 13z"/><path fill="#fff" d="M10 64c0-11.5 9.8-18.5 22-18.5S54 52.5 54 64z"/></svg>',
    m: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle fill="#fff" cx="32" cy="26" r="11.5"/><path fill="#fff" d="M10 64c0-11.5 9.8-18.5 22-18.5S54 52.5 54 64z"/></svg>',
  };
  // a gender string, or a user (registered users with a photo get their picture; idle users get a 🌙 + "5m" badge)
  const avatar = x => {
    const g = typeof x === 'string' ? x : x.g;
    const pic = typeof x === 'object' && x.photo
      ? `<div class="av ${g}"><img src="/avatar/${encodeURIComponent(x.name)}?v=${encodeURIComponent(x.photo)}" alt="" loading="lazy"></div>`
      : `<div class="av ${g}">${AVATAR[g]}</div>`;
    const away = typeof x === 'object' && x.idle && S.users.has(x.id) ? awayFor(x.idle) : 0;
    const st = typeof x === 'object' && STATUS[x.status] && x.status !== 'online' && (S.users.has(x.id) || x === S.me) ? x.status : '';
    if (!away && !st) return pic;
    return `<div class="av-wrap${away ? ' idle' : ''}">${pic}` +
      (st ? `<span class="st-dot st-${st}" title="${STATUS[st].label}"></span>` : '') +
      (away ? `<span class="idle-badge" title="Away for ${awayLong(away)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>${awayShort(away)}</span>` : '') + '</div>';
  };
  // statuses people can pick (invisible = appear offline: hidden from lists, can still chat)
  const STATUS = {
    online: { label: 'Online', hint: 'Available to chat' },
    busy: { label: 'Busy', hint: 'Shown as busy' },
    away: { label: 'Away', hint: 'Shown as away' },
    dnd: { label: 'Do not disturb', hint: 'Mutes sounds and pop-ups' },
    invisible: { label: 'Invisible', hint: 'Appear offline to everyone' },
  };
  // away durations use the server's clock (corrected for this device's clock difference)
  let clockSkew = 0;
  const awayFor = since => Math.max(60000, Date.now() + clockSkew - since);
  const awayShort = ms => { const m = Math.floor(ms / 60000); return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd'; };
  const awayLong = ms => { const m = Math.floor(ms / 60000); return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : m < 1440 ? `${Math.floor(m / 60)} hour${m < 120 ? '' : 's'}` : `${Math.floor(m / 1440)} day${m < 2880 ? '' : 's'}`; };
  const vb = u => (u && u.reg ? '<span class="vbadge" title="Registered profile">✓</span>' : '') + (u && u.test ? '<span class="test-badge" title="Simulated user from an admin load test">TEST</span>' : '');
  const subLine = u => [u.age + ' Yrs', u.loc, countryName(u.cc)].filter(Boolean).join(', ');
  const flagImg = u => `<img class="flag" src="${flagUrl(u.cc)}" srcset="${flagSrcset(u.cc)}" alt="${esc(countryName(u.cc))}" title="${esc(countryName(u.cc))}" loading="lazy" width="40" height="30">`;

  // ---------------- state ----------------
  const S = {
    ws: null, me: null,
    users: new Map(),     // id -> {id,name,g,age,loc,cc,seq}
    seq: 0,
    convos: new Map(),    // userId -> {msgs:[], unread, last}
    rooms: new Map(),     // roomId -> {id,name,desc,locked,count,joined,msgs:[],unread}
    joiningRoom: null,    // room the user asked to join (waiting for the server)
    fr: { friends: [], reqIn: [], reqOut: [] }, frSet: new Set(), // friends (registered profiles only)
    active: null,         // 'r:<roomId>' for a room, a user id for a private chat, null for none
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
  const isRoom = k => typeof k === 'string';
  const roomKey = id => 'r:' + id;
  const roomOf = k => S.rooms.get(k.slice(2));

  // ---------------- login ----------------
  const SITE = () => document.querySelector('meta[name=application-name]').content || document.title;
  let btnText = $('loginBtnText').textContent;       // set by the admin (Appearance → button text)
  const setBtn = t => { $('loginBtnText').textContent = t || btnText; };
  $('fAge').insertAdjacentHTML('beforeend', Array.from({ length: 82 }, (_, i) => `<option>${i + 18}</option>`).join(''));
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
    h.innerHTML = `<img src="${flagUrl(detected.cc)}" alt="" width="30" height="20">` +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" fill="currentColor" stroke="none"/><path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2.2"/></svg>' +
      `<span><span class="long">${detected.locked ? 'Detected from your connection' : 'Detected from your IP'}</span><span class="short">From your IP</span>:</span> <b>${esc(place)}</b>` +
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
    el.textContent = { checking: 'Checking you\u2019re human…', ok: '✓ Verified human', error: '⚠ Bot check could not load. Please reload the page.', off: '' }[state];
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

  // ---------------- login modes: guest (default) · log in to a profile · create a profile ----------------
  const MODE_BTN = { login: 'Log in', register: 'Create profile & chat' };
  const guestBtnText = btnText;
  function setMode(mode) {
    $('loginForm').dataset.mode = mode;
    btnText = MODE_BTN[mode] || guestBtnText; setBtn();
    $('fPw').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('loginErr').textContent = '';
    store.set('chatr.mode', mode);
  }
  document.querySelector('.mode-links').addEventListener('click', e => {
    const a = e.target.closest('[data-mode]'); if (!a) return;
    e.preventDefault(); setMode(a.dataset.mode); (a.dataset.mode === 'guest' ? $('fName') : $('fName')).focus();
  });
  if (store.get('chatr.mode') === 'login') setMode('login');
  let regPhoto = null;
  $('fPhoto').addEventListener('change', async () => {
    const f = $('fPhoto').files[0]; $('fPhoto').value = '';
    if (!f) return;
    try { regPhoto = await squarePhoto(f); $('fPhotoPrev').innerHTML = `<img src="${regPhoto}" alt="">`; } catch { toast('Could not read that photo'); }
  });

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const mode = $('loginForm').dataset.mode;
    const name = $('fName').value.trim();
    let profile, err = !/^[A-Za-z0-9_]{3,16}$/.test(name) ? 'Username must be 3–16 letters, numbers or _' : '';
    if (mode === 'login') {
      profile = { mode, name, pw: $('fPw').value };
      if (!err && !profile.pw) err = 'Please enter your password';
    } else {
      profile = { name, g: (document.querySelector('input[name=g]:checked') || {}).value, age: parseInt($('fAge').value, 10),
        loc: $('stateField').hidden ? '' : stateSel.value, cc: sel.value };
      err = err || (!profile.g ? 'Please choose a gender'
        : !(profile.age >= 18 && profile.age <= 99) ? 'You must be 18 or older'
        : !profile.cc ? 'Please choose a country'
        : !$('stateField').hidden && !profile.loc ? 'Please choose your state / region' : '');
      if (mode === 'register') {
        Object.assign(profile, { mode, pw: $('fPw').value, bio: $('fBio').value.trim(), photo: regPhoto || undefined });
        if (!err && profile.pw.length < 8) err = 'Choose a password of at least 8 characters';
      }
    }
    $('loginErr').textContent = err;
    if (err) return;
    // remember the form for next time (never the password)
    const { pw, photo, bio, mode: _m, ...remember } = profile;
    store.set('chatr.profile', { ...(store.get('chatr.profile') || {}), ...remember });
    $('loginBtn').disabled = true;
    setBtn('Verifying…');
    let cap;
    try { cap = await getCaptcha(); } catch {
      $('loginBtn').disabled = false; setBtn();
      $('loginErr').textContent = 'Bot check could not load. Please reload the page.';
      return;
    }
    connect(profile, cap, 0);
  });

  // ---------------- socket ----------------
  function connect(profile, cap, attempt) {
    $('loginBtn').disabled = true;
    setBtn('Connecting…');
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
      if (m.t === 'welcome') { lastActive = Date.now(); reportedIdle = false; joined = true; $('fPw').value = ''; regPhoto = null; $('fPhotoPrev').textContent = '📷'; onWelcome(m); return; }
      if (m.t === 'err' && m.join) {
        if (m.code === 'captcha') {
          prepareCaptcha(); // that answer is used up
          if (attempt === 0) { // e.g. it expired: solve a fresh one and retry once, invisibly
            S.ws = null; ws.close();
            getCaptcha().then(c => connect(profile, c, 1), () => { $('loginBtn').disabled = false; setBtn(); $('loginErr').textContent = m.e; });
            return;
          }
        }
        $('loginErr').textContent = m.e; ws.close();
        if (m.code === 'registered') setMode('login');
        return;
      }
      if (joined) onMessage(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.ws = null;
      $('loginBtn').disabled = false;
      setBtn();
      if (joined) { $('fPw').value = ''; resetToLogin(S.closeReason || 'You were disconnected. Your chat history has been deleted.'); }
      else if (!$('loginErr').textContent) $('loginErr').textContent = 'Could not connect. Please try again.';
    };
  }
  const send = obj => { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; } return false; };

  function onWelcome(m) {
    if (m.now) clockSkew = m.now - Date.now();
    S.liveAllowed = m.live !== false;
    S.me = toUser(m.me);
    S.users.clear();
    for (const t of m.users) addUser(t);
    S.acct = m.acct || null;
    store.set('chatr.mode', S.acct ? 'login' : 'guest'); // next visit: registered users get the log-in form
    renderMe();
    const saved = store.get('chatr.status');
    if (STATUS[saved] && saved !== 'online') send({ t: 'status', s: saved });
    if (prefs.pmFrom !== 'all') send({ t: 'privacy', pm: prefs.pmFrom });
    // opened from someone's QR code / chat link (?chat=Name)
    const linked = new URLSearchParams(location.search).get('chat');
    if (linked) { history.replaceState(null, '', location.pathname); setTimeout(() => openChatLink(linked), 400); }
    if (m.warn) setTimeout(() => toast(m.warn), 600);
    $('login').hidden = true;
    $('app').hidden = false;
    $('loginNotice').hidden = true;
    S.rooms.clear();
    for (const r of m.rooms || []) S.rooms.set(r.id, { ...r, count: (m.rc || {})[r.id] || 0, joined: false, msgs: [], unread: 0 });
    for (const id of m.in || []) { const r = S.rooms.get(id); if (r) r.joined = true; }
    renderRooms();
    markDirty();
    openDefault();
    showPane('people');
  }

  // The first room the user is in, or an empty "pick something" state.
  function openDefault() {
    const r = [...S.rooms.values()].find(x => x.joined);
    if (r) return openChat(roomKey(r.id));
    S.active = null;
    $('peer').innerHTML = `<div class="info"><div class="nm">${t('1-to-1 chat')}</div><div class="sub">${t('Private chats with one person at a time')}</div></div>`;
    $('headActions').hidden = true; $('picBtn').hidden = true;
    $('composer').classList.add('disabled');
    $('liveNote').hidden = true;
    $('msgs').replaceChildren();
    sysMsg(null, t('Tap someone in People to start a private chat, or open Rooms to join a group chat.'));
    renderRooms(); renderList(true); schedulePanes();
  }

  function resetToLogin(notice) {
    // Everything lives in memory only; drop it all.
    S.users.clear(); S.convos.clear(); S.rooms.clear(); S.active = null; S.joiningRoom = null; S.pendingAcks.clear(); S.acct = null;
    S.fr = { friends: [], reqIn: [], reqOut: [] }; S.frSet = new Set();
    if ($('profDlg').open) $('profDlg').close();
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
    $('loginBtn').disabled = false; setBtn();
    resetToLogin('You left the chat. All messages were deleted.');
  };

  const toUser = t => ({ id: t[0], name: t[1], g: t[2], age: t[3], loc: t[4], cc: t[5], reg: t[6] === 1, photo: t[7] || 0, idle: t[8] || 0, status: t[9] || '', since: t[10] || 0, test: t[11] === 1 });
  function addUser(t, ghost) {
    const old = S.users.get(t[0]);
    if (old && old.ghost && !ghost) { const u = toUser(t); u.seq = old.seq; S.users.set(u.id, u); return; } // invisible person showed up
    if (old || (S.me && t[0] === S.me.id)) return;
    const u = toUser(t); u.seq = ++S.seq; if (ghost) u.ghost = true; // ghost: invisible sender, kept out of the lists
    S.users.set(u.id, u);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'ud':
        for (const t of m.j) addUser(t);
        for (const id of m.l) userLeft(id);
        markDirty();
        if (pane === 'friends') schedulePanes();
        break;
      case 'room': {
        const r = S.rooms.get(m.r);
        if (!r || !r.joined) break;
        for (const [id, name, g, x, ts] of m.m) pushMsg(roomKey(m.r), { from: id, name, g, x, ts, me: S.me && id === S.me.id });
        break;
      }
      case 'rooms': { // an admin created, renamed, locked or deleted a room
        const old = S.rooms;
        S.rooms = new Map();
        for (const r of m.list) S.rooms.set(r.id, { ...(old.get(r.id) || { joined: false, msgs: [], unread: 0 }), ...r, count: (m.c || {})[r.id] || 0 });
        renderRooms();
        if (isRoom(S.active) && roomOf(S.active)) { renderPeer(); renderLiveNote(); }
        break;
      }
      case 'rc':
        for (const [id, n] of Object.entries(m.c)) { const r = S.rooms.get(id); if (r) r.count = n; }
        renderRooms();
        if (isRoom(S.active) && roomOf(S.active)) { renderPeer(); renderLiveNote(); }
        break;
      case 'rjoin': {
        const r = S.rooms.get(m.r);
        const mine = S.joiningRoom === m.r;
        if (m.ok && r) {
          r.joined = true;
          if (mine) { S.joiningRoom = null; closeRoomPw(); openChat(roomKey(r.id)); }
          renderRooms();
        } else if (mine) {
          if ($('roomPwDlg').open) { $('roomPwErr').textContent = m.e; $('roomPw').select(); }
          else { S.joiningRoom = null; toast(m.e); }
        }
        break;
      }
      case 'rclosed': {
        const r = S.rooms.get(m.r);
        if (r) { r.joined = false; r.msgs = []; r.unread = 0; }
        if (S.active === roomKey(m.r)) {
          $('msgs').replaceChildren();
          sysMsg(null, m.e);
          $('composer').classList.add('disabled');
          $('headActions').hidden = true;
        }
        toast(m.e);
        renderRooms();
        break;
      }
      case 'pm': {
        if (!S.users.has(m.f) && m.fu) { addUser(m.fu, true); const c = S.convos.get(m.f); if (c && c.gone) { c.gone = false; if (S.active === m.f) { renderPeer(); renderLiveNote(); } } }
        if (!S.users.has(m.f)) return;
        hideDraft(m.f);
        pushMsg(m.f, { from: m.f, x: m.x, i: m.i, ts: m.ts, mid: m.mid });
        hideTyping(m.f);
        chime();
        notifyDesktop(m.f, m);
        markRead(m.f);
        break;
      }
      case 'ack': {
        const p = S.pendingAcks.get(m.c);
        S.pendingAcks.delete(m.c);
        if (p && m.ok && m.x) { p.msg.x = m.x; const b = p.msg.el && p.msg.el.querySelector('.bubble'); if (b) setBubbleText(b, m.x); }
        if (p && m.ok) { p.msg.mid = m.mid; p.msg.state = 'sent'; updateTicks(p.msg); }
        if (p && !m.ok) {
          p.msg.fail = m.e || 'Not delivered';
          const el = p.msg.el;
          if (el) { el.classList.add('fail'); el.querySelector('.meta').textContent = '⚠ ' + p.msg.fail; }
        }
        break;
      }
      case 'read': { // the other person has seen my messages up to m.mid → blue ticks
        const c = S.convos.get(m.by);
        if (!c) break;
        c.seenUpTo = Math.max(c.seenUpTo || 0, m.mid);
        for (const x of c.msgs) if (x.me && x.mid && x.mid <= m.mid && x.state !== 'read') { x.state = 'read'; updateTicks(x); }
        break;
      }
      case 'ty': if (S.active === m.f) showTyping(); break;
      case 'draft': if (S.active === m.f) showDraft(m.x); break;
      case 'err': toast(m.e); break;
      case 'kicked': S.closeReason = m.e; break;
      case 'uu': { // someone's profile changed (photo, details, registered)
        const nu = toUser(m.u);
        if (S.me && nu.id === S.me.id) { nu.status = S.me.status; S.me = nu; renderMe(); break; }
        const old = S.users.get(nu.id);
        if (!old) break;
        nu.seq = old.seq;
        S.users.set(nu.id, nu);
        const c = S.convos.get(nu.id);
        if (c) c.peer = { ...nu };
        markDirty(); schedulePanes();
        if (S.active === nu.id) renderPeer();
        break;
      }
      case 'acct': onAccountReply(m); break;
      case 'ui': { // people went idle / came back
        if (m.now) clockSkew = m.now - Date.now();
        for (const [id, since] of m.u) { const u = S.users.get(id); if (u) u.idle = since; }
        markDirty(); schedulePanes();
        if (S.active != null && !isRoom(S.active) && m.u.some(([id]) => id === S.active)) renderPeer();
        break;
      }
      case 'us': { // people changed their status (busy / away / do not disturb)
        if (m.now) clockSkew = m.now - Date.now();
        for (const [id, s, since] of m.u) { const u = S.users.get(id); if (u) { u.status = s; u.since = since; } }
        markDirty(); schedulePanes();
        if (S.active != null && !isRoom(S.active) && m.u.some(([id]) => id === S.active)) renderPeer();
        break;
      }
      case 'mystatus':
        S.me.status = m.s; store.set('chatr.status', m.s); renderMe();
        break;
      case 'friends':
        S.fr = m; S.frSet = new Set(m.friends.map(f => f.name.toLowerCase()));
        if (S.frWatch) {
          const f = [...m.reqOut, ...m.friends].find(x => x.name.toLowerCase() === S.frWatch);
          if (f) toast(S.frSet.has(S.frWatch) ? `❤️ You and ${f.name} are now friends` : `💌 Friend request sent to ${f.name}`);
          if (f) S.frWatch = null;
        }
        markDirty(); schedulePanes();
        if (S.active != null && !isRoom(S.active)) renderPeer();
        break;
      case 'frev':
        if (m.kind === 'request') { if (!dnd() && prefs.popups) toast(`💌 ${m.name} sent you a friend request`); chime(); }
        else if (m.kind === 'accepted') { if (!dnd() && prefs.popups) toast(`❤️ ${m.name} is now your friend`); chime(); }
        else if (m.kind === 'error') { S.frWatch = null; toast(m.e); }
        break;
    }
  }

  function userLeft(id) {
    const u = S.users.get(id);
    if (!u) return;
    S.users.delete(id);
    const c = S.convos.get(id);
    if (c) {
      // keep the conversation in History (read-only) until *you* leave; nothing is kept after that
      c.gone = true; c.peer = { ...u };
      if (S.active === id) {
        hideDraft(); hideTyping();
        sysMsg(null, `${u.name} has left. You can still read this chat until you leave.`);
        renderPeer(); renderLiveNote();
      }
      schedulePanes();
    }
  }

  // ---------------- messages ----------------
  function convo(id) {
    if (isRoom(id)) return roomOf(id) || { msgs: [], unread: 0 };
    let c = S.convos.get(id);
    if (!c) { c = { msgs: [], unread: 0, last: 0, lastIn: 0, peer: { ...S.users.get(id) }, gone: false }; S.convos.set(id, c); }
    return c;
  }

  function pushMsg(target, msg) {
    const c = convo(target);
    c.msgs.push(msg);
    const cap = isRoom(target) ? MAX_ROOM : MAX_PM;
    if (c.msgs.length > cap) c.msgs.splice(0, c.msgs.length - cap);
    if (!isRoom(target)) { c.last = Date.now(); if (!msg.me) c.lastIn = c.last; markDirty(); schedulePanes(); }
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
    // who sent it: me, the room member, or the person in this private chat
    const room = isRoom(target);
    const c = !room && S.convos.get(target);
    const sender = msg.me ? S.me : S.users.get(msg.from) || (c && c.peer) || { name: msg.name || '?', g: msg.g || 'm' };
    const av = document.createElement('div');
    av.className = 'm-av'; av.innerHTML = avatar(sender);
    const col = document.createElement('div');
    col.className = 'm-col';
    const head = document.createElement('div');
    head.className = 'm-head';
    const who = document.createElement('span');
    who.className = 'm-name';
    who.textContent = msg.me ? 'You' : (room ? msg.name : sender.name);
    if (room && !msg.me) { who.classList.add('who'); who.dataset.uid = msg.from; av.classList.add('who'); av.dataset.uid = msg.from; }
    if (!msg.me && (sender.reg || sender.test)) who.insertAdjacentHTML('beforeend', vb(sender));
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = msg.fail ? '⚠ ' + msg.fail : timeFmt.format(msg.ts);
    if (msg.me && !room && !msg.fail) meta.insertAdjacentHTML('beforeend', ticksHtml(msg));
    const dot = document.createElement('i');
    head.append(who, dot, meta);
    col.appendChild(head);
    el.append(av, col);
    const b = document.createElement('div');
    b.className = 'bubble';
    if (msg.i) {
      b.classList.add('pic');
      const img = document.createElement('img');
      img.src = msg.i; img.alt = 'Picture'; img.decoding = 'async';
      img.onload = () => { const box = $('msgs'); if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight; };
      b.appendChild(img);
    } else setBubbleText(b, msg.x);
    col.appendChild(b);
    return el;
  }

  // ---------------- read receipts (private chats): ◷ sending · grey ✓✓ delivered · blue ✓✓ read ----------------
  const TICKS = '<svg viewBox="0 0 24 14" aria-hidden="true"><path d="M1.5 7.5 6 12 15 2.5"/><path d="M9 11.2 10 12 19 2.5"/></svg>';
  const CLOCK = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.3"/><path d="M7 4.2V7l2 1.3"/></svg>';
  function ticksHtml(msg) {
    const st = msg.state || 'sending';
    const label = { sending: 'Sending', sent: 'Delivered', read: 'Read' }[st];
    return `<span class="ticks ${st}" title="${label}" aria-label="${label}">${st === 'sending' ? CLOCK : TICKS}</span>`;
  }
  function updateTicks(msg) {
    const t = msg.el && msg.el.querySelector('.ticks');
    if (t) t.outerHTML = ticksHtml(msg);
  }
  const chatVisible = id => S.active === id && !document.hidden && (window.innerWidth > 720 || document.body.classList.contains('chat-open'));
  /** Tell the other person I've seen their messages (only while their chat is actually on screen). */
  function markRead(id) {
    const c = S.convos.get(id);
    if (!c || c.gone || !chatVisible(id) || !prefs.receipts) return;
    let last = 0;
    for (const x of c.msgs) if (!x.me && x.mid > last) last = x.mid;
    if (last > (c.readSent || 0)) { c.readSent = last; send({ t: 'read', f: id, mid: last }); }
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
      while (box.childElementCount > (isRoom(target) ? MAX_ROOM : MAX_PM)) box.firstElementChild.remove();
    });
    if (msg.me) box.scrollTop = box.scrollHeight;
  }

  // ---------------- open / render a chat ----------------
  function openChat(target) {
    if (isRoom(target)) {
      const r = roomOf(target);
      if (!r) return;
      if (!r.joined) return requestJoin(r);
    } else if (!S.users.has(target) && !S.convos.has(target)) return; // left, and no chat to show
    if (S.draftTo && S.draftTo !== target) stopSharingDraft();
    S.active = target;
    hideTyping();
    hideDraft();
    const c = convo(target);
    c.unread = 0;
    renderPeer();
    $('composer').classList.remove('disabled');
    renderLiveNote();
    const box = $('msgs');
    const frag = document.createDocumentFragment();
    for (const m of c.msgs) { m.el = msgEl(m, target); frag.appendChild(m.el); }
    box.replaceChildren(frag);
    if (!isRoom(target)) showProfileCard(target);
    if (!isRoom(target) && !c.msgs.length) sysMsg(null, 'Private chat. Messages are deleted when you leave.');
    if (!isRoom(target) && c.gone) sysMsg(null, `${c.peer.name} has left. You can still read this chat until you leave.`);
    box.scrollTop = box.scrollHeight;
    document.body.classList.add('chat-open');
    updateBadges(target);
    renderList(true);
    renderRooms();
    schedulePanes();
    if (window.innerWidth > 720 && !$('composer').classList.contains('disabled')) $('text').focus();
    if (!isRoom(target)) markRead(target); // after the chat is on screen (phones slide it in)
  }

  // Chat header: the room (name, lock, members) or the person you're talking to.
  function renderPeer() {
    const target = S.active, peer = $('peer');
    const inRoom = isRoom(target);
    if (inRoom) {
      const r = roomOf(target);
      peer.innerHTML = `<div class="av room">#</div><div class="info"><div class="nm">${esc(r.name)}${r.locked ? ' <span class="lock" title="Password protected">🔒</span>' : ''}</div>` +
        `<div class="sub">${r.count} ${r.count === 1 ? 'person' : 'people'} here${r.chat === false ? ' · 🔇 chat off' : ''}${r.desc ? ' · ' + esc(r.desc) : ''}</div></div>`;
    } else {
      const c = S.convos.get(target);
      const u = S.users.get(target) || (c && c.peer);
      const gone = !S.users.has(target);
      const st = STATUS[u.status] && u.status !== 'online' ? `<span class="st-label st-${u.status}">${STATUS[u.status].label}</span>` : '<span class="st-label st-online">Online</span>';
      peer.innerHTML = `<div class="peer-av${gone || (u.status && u.status !== 'online') ? '' : ' online'}">${avatar(u)}</div><div class="info"><div class="nm">${esc(u.name)}${vb(u)}</div><div class="sub">${gone ? 'Left the chat' : `${st}<span class="chip">${esc(subLine(u))}</span>`}</div></div>${flagImg(u)}`;
    }
    const gone = !inRoom && !S.users.has(target);
    $('picBtn').hidden = inRoom || gone;
    $('headActions').hidden = false;
    $('blockBtn').hidden = inRoom || gone;
    $('closeBtn').hidden = inRoom;
    $('closeBtn').title = 'Delete this chat';
    renderFriendBtn(inRoom || gone ? null : (S.users.get(target) || null));
    $('leaveRoomBtn').hidden = !inRoom;
  }

  // ---------------- rooms ----------------
  let roomsRaf = 0;
  function renderRooms() {
    if (roomsRaf) return;
    roomsRaf = requestAnimationFrame(() => {
      roomsRaf = 0;
      const all = [...S.rooms.values()];
      $('roomsCount').textContent = all.length;
      $('roomList').innerHTML = all.map(r => `<div class="room-row${S.active === roomKey(r.id) ? ' sel' : ''}${r.joined ? ' joined' : ''}" data-room="${esc(r.id)}">
          <div class="av room">#</div>
          <div class="info"><div class="nm">${esc(r.name)}${r.locked ? ' <span class="lock" title="Password protected">🔒</span>' : ''}</div>
          <div class="sub">${r.count} ${r.count === 1 ? 'person' : 'people'}${r.chat === false ? ' · chat off' : ''}${r.joined ? '' : ' · tap to join'}</div></div>
          ${r.unread ? `<span class="badge">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</div>`).join('') || '<div class="empty">No rooms yet</div>';
    });
  }
  $('roomList').addEventListener('click', e => { const row = e.target.closest('[data-room]'); if (row) openChat(roomKey(row.dataset.room)); });

  function requestJoin(r) {
    S.joiningRoom = r.id;
    if (!r.locked) return send({ t: 'rjoin', r: r.id });
    $('roomPwTitle').textContent = r.name;
    $('roomPw').value = '';
    $('roomPwErr').textContent = '';
    $('roomPwDlg').showModal();
    $('roomPw').focus();
  }
  function closeRoomPw() { if ($('roomPwDlg').open) $('roomPwDlg').close(); }
  $('roomPwForm').addEventListener('submit', e => {
    e.preventDefault();
    const pw = $('roomPw').value;
    if (!pw) return;
    $('roomPwErr').textContent = '';
    send({ t: 'rjoin', r: S.joiningRoom, pw });
  });
  $('roomPwCancel').onclick = () => { S.joiningRoom = null; closeRoomPw(); };
  $('roomPwDlg').addEventListener('cancel', () => { S.joiningRoom = null; });
  $('leaveRoomBtn').onclick = () => {
    const r = isRoom(S.active) && roomOf(S.active);
    if (!r) return;
    send({ t: 'rleave', r: r.id });
    r.joined = false; r.msgs = []; r.unread = 0;
    openDefault();
    toast(`You left ${r.name}`);
  };

  $('backBtn').onclick = () => { document.body.classList.remove('chat-open'); };
  $('closeBtn').onclick = () => {
    const id = S.active;
    if (id == null || isRoom(id)) return;
    S.convos.delete(id);
    markDirty();
    updateTitle();
    schedulePanes();
    openDefault();
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
    if (S.active == null) return;
    if (isRoom(S.active)) {
      if (!send({ t: 'room', r: S.active.slice(2), x })) return toast('Not connected');
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
    if (S.active == null || isRoom(S.active)) return;
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
      if (isRoom(S.active) || !S.users.has(S.active)) return;
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
  draftEl.innerHTML = '<div class="m-av"></div><div class="m-col"><div class="m-head"><span class="meta"></span></div><div class="bubble"></div></div>';
  let draftHideTimer = 0;
  function showDraft(text) {
    if (!text || !text.trim()) return hideDraft();
    hideTyping();
    const u = S.users.get(S.active);
    draftEl.querySelector('.meta').textContent = `${u ? u.name : ''} is typing…`;
    draftEl.querySelector('.m-av').innerHTML = u ? avatar(u) : '';
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
    if (isRoom(S.active)) {
      // the room's chat can be switched off by an admin: show why the message box is disabled
      const r = roomOf(S.active), off = !!r && r.joined && r.chat === false;
      note.hidden = !off;
      if (r && r.joined) $('composer').classList.toggle('disabled', off);
      if (off) note.innerHTML = '🔇 Chatting is turned off in this room. You can still message people privately.';
      return;
    }
    const c = S.convos.get(S.active);
    if (c && c.gone) {
      note.hidden = false;
      note.textContent = `${c.peer.name} has left — this chat is read-only. It's deleted when you leave.`;
      $('composer').classList.add('disabled');
      return;
    }
    const u = S.users.get(S.active);
    note.hidden = isRoom(S.active) || !u || !S.liveAllowed;
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
    if (!S.sound || dnd() || !audioCtx || Date.now() - lastChime < 800) return;
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
    b.innerHTML = S.sound ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2h-12M10 20.5a2 2 0 0 0 4 0M4 4l16 16"/></svg>';
    b.classList.toggle('off', !S.sound);
    b.title = b.ariaLabel = S.sound ? 'Message sound on' : 'Message sound off';
  }
  $('soundBtn').onclick = () => {
    S.sound = !S.sound;
    store.set('chatr.sound', S.sound);
    renderSoundBtn();
    if (S.sound) { lastChime = 0; chime(); } // preview
  };
  renderSoundBtn();

  // light / dark / follow the device (Settings → Appearance); the 🌙 button switches light ↔ dark
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const on = prefs.theme === 'dark' || (prefs.theme === 'system' && darkMq.matches);
    $('app').dataset.theme = on ? 'dark' : 'light';
    document.documentElement.dataset.chatTheme = on ? 'dark' : 'light';
    $('themeBtn').title = $('themeBtn').ariaLabel = on ? 'Light mode' : 'Dark mode';
    $('themeBtn').innerHTML = on ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  }
  applyTheme();
  darkMq.addEventListener('change', () => { if (prefs.theme === 'system') applyTheme(); });
  $('themeBtn').onclick = () => { prefs.theme = $('app').dataset.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); refreshSetting(); };

  // ---------------- emoji panel (Google Noto Emoji images, same look on every device) ----------------
  const EP_RECENT = 'chatr.recentEmoji';
  let epBuilt = false;
  const epButton = e => `<button type="button" data-e="${e}" title="${e}"><img src="${emojiUrl(e)}" alt="${e}" loading="lazy" draggable="false"></button>`;
  function epRecentHtml() {
    const recent = store.get(EP_RECENT) || [];
    return recent.length ? `<div class="ep-sec" id="ep-recent"><div class="ep-h">Recently used</div><div class="ep-items">${recent.map(epButton).join('')}</div></div>` : '';
  }
  function buildEmojiPanel() {
    epBuilt = true;
    const cats = window.EMOJI_CATS || [];
    $('epTabs').innerHTML = `<button type="button" data-cat="recent" title="Recently used"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></button>` +
      cats.map(c => `<button type="button" data-cat="${c.id}" title="${c.name}"><img src="${emojiUrl(c.icon)}" alt="${c.name}"></button>`).join('');
    $('epGrid').innerHTML = epRecentHtml() + cats.map(c => `<div class="ep-sec" id="ep-${c.id}"><div class="ep-h">${c.name}</div>` +
      `<div class="ep-items">${[...new Set(c.list.split(' ').filter(Boolean))].map(epButton).join('')}</div></div>`).join('');
  }
  $('emojiBtn').onclick = () => {
    if (!epBuilt) buildEmojiPanel();
    $('emojiPop').hidden = !$('emojiPop').hidden;
  };
  $('epTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    const sec = $('ep-' + b.dataset.cat) || $('ep-smileys');
    $('epGrid').scrollTo({ top: sec.offsetTop - $('epGrid').offsetTop, behavior: 'smooth' });
  });
  $('epGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-e]'); if (!b) return;
    const em = b.dataset.e, t = $('text');
    const pos = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, pos) + em + t.value.slice(t.selectionEnd ?? pos);
    t.selectionStart = t.selectionEnd = pos + em.length;
    if (window.innerWidth > 720) t.focus();
    t.dispatchEvent(new Event('input'));
    // remember it in "Recently used"
    const recent = [em, ...(store.get(EP_RECENT) || []).filter(x => x !== em)].slice(0, 24);
    store.set(EP_RECENT, recent);
    const old = $('ep-recent'), html = epRecentHtml();
    if (old) old.outerHTML = html; else $('epGrid').insertAdjacentHTML('afterbegin', html);
  });
  // close when clicking anywhere else
  document.addEventListener('pointerdown', e => {
    if (!$('emojiPop').hidden && !e.target.closest('#emojiPop, #emojiBtn')) $('emojiPop').hidden = true;
  });

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
      if (u.ghost) continue;
      u.g === 'f' ? f++ : m++;
      if (S.filter !== 'all' && u.g !== S.filter) continue;
      if (q && !u.name.toLowerCase().includes(q) && !(u.loc || '').toLowerCase().includes(q) && !countryName(u.cc).toLowerCase().includes(q)) continue;
      (S.convos.has(u.id) ? chats : rest).push(u);
    }
    chats.sort((a, b) => S.convos.get(b.id).last - S.convos.get(a.id).last);
    rest.sort((a, b) => b.seq - a.seq);  // newest first
    S.view = chats.concat(rest);
    $('cAll').textContent = f + m; $('cF').textContent = f; $('cM').textContent = m;
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
        `${avatar(u)}<div class="info"><div class="nm">${esc(u.name)}${vb(u)}${isFriend(u) ? '<span class="heart" title="Friend">❤</span>' : ''}</div><div class="sub">${esc(subLine(u))}</div></div>${unread}${quickFriend(u)}${flagImg(u)}</div>`;
    }
    if (!n) html = `<div class="empty">${S.q || S.filter !== 'all' ? 'No one matches.' : 'No one else is online yet.'}</div>`;
    // keep the spacer, replace rows
    list.replaceChildren(spacer);
    list.insertAdjacentHTML('beforeend', html);
  }
  list.addEventListener('scroll', () => { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderList(); }); } }, { passive: true });
  list.addEventListener('click', e => { if (quickFriendClick(e)) return; const r = e.target.closest('.row'); if (r) openChat(+r.dataset.id); });

  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.filter = b.dataset.f;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    list.scrollTop = 0; markDirty();
  });

  // ---------------- badges / title ----------------
  function updateBadges(target) {
    if (isRoom(target)) renderRooms(); else markDirty();
    schedulePanes();
    updateTitle();
  }
  function updateTitle() {
    let n = 0;
    for (const c of S.convos.values()) n += c.unread;
    document.title = n ? `(${n}) ${SITE()}` : SITE();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me && S.active != null) { const c = convo(S.active); if (c.unread) { c.unread = 0; updateBadges(S.active); } if (!isRoom(S.active)) markRead(S.active); }
  });

  // ---------------- me box (opens the profile dialog) ----------------
  const myStatus = () => (S.me && STATUS[S.me.status] ? S.me.status : 'online');
  const dnd = () => myStatus() === 'dnd';
  function renderMe() {
    const st = myStatus();
    $('meBox').innerHTML = `${avatar(S.me)}<div class="info"><div class="nm">${esc(S.me.name)}${vb(S.me)}</div>` +
      `<button type="button" class="st-btn" id="stBtn" aria-haspopup="menu" title="Set your status"><i class="st-ic st-${st}"></i>${STATUS[st].label}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div>`;
    $('meBox').title = S.acct ? 'Edit your profile' : 'Create a profile to keep your name';
    try { if (pane === 'settings' && !$('setMain').hidden) renderSettings(); } catch {}
  }
  $('meBox').addEventListener('click', e => { e.stopPropagation(); toggleStatusMenu(); });
  function toggleStatusMenu(force) {
    const menu = $('stMenu');
    const open = force !== undefined ? force : menu.hidden;
    if (!open) { menu.hidden = true; return; }
    const cur = myStatus();
    menu.innerHTML = `<div class="st-head">${avatar(S.me)}<div class="info"><div class="nm">${esc(S.me.name)}${vb(S.me)}</div><div class="sub">${esc(subLine(S.me))}</div></div></div>` +
      `<button type="button" class="st-prof" data-prof><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/></svg><span><b>${S.acct ? 'Edit my profile' : 'Create a profile'}</b><small>${S.acct ? 'Photo, bio, details, password' : 'Keep your name, add a photo and friends'}</small></span></button><div class="st-sep">Status</div>` +
      Object.entries(STATUS).map(([k, v]) =>
      `<button type="button" role="menuitemradio" aria-checked="${k === cur}" data-st="${k}"${k === cur ? ' class="on"' : ''}><i class="st-ic st-${k}"></i><span><b>${v.label}</b><small>${v.hint}</small></span></button>`).join('') +
      // phones: the rail has no room for these buttons, so they live in this menu
      `<div class="st-extra"><button type="button" data-act="soundBtn">${$('soundBtn').innerHTML}${S.sound ? 'Sound on' : 'Sound off'}</button><button type="button" data-act="themeBtn">${$('themeBtn').innerHTML}${$('app').dataset.theme === 'dark' ? 'Light' : 'Dark'}</button><button type="button" data-act="logoutBtn">${$('logoutBtn').innerHTML}Leave</button></div>`;
    menu.hidden = false;
  }
  $('stMenu').addEventListener('click', e => {
    if (e.target.closest('[data-prof]')) { toggleStatusMenu(false); openProfile(); return; }
    const act = e.target.closest('[data-act]');
    if (act) { toggleStatusMenu(false); $(act.dataset.act).click(); return; }
    const b = e.target.closest('[data-st]');
    if (!b) return;
    toggleStatusMenu(false);
    if (b.dataset.st === myStatus()) return;
    if (!send({ t: 'status', s: b.dataset.st })) toast('Not connected. Please try again.');
  });
  document.addEventListener('pointerdown', e => { if (!$('stMenu').hidden && !e.target.closest('#stMenu, #meBox')) toggleStatusMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('stMenu').hidden) toggleStatusMenu(false); });

  // ---------------- sidebar sections: People · Rooms · Inbox · History ----------------
  let pane = 'people';
  const PANE_TITLES = { people: 'People', rooms: 'Rooms', inbox: 'Inbox', history: 'History', search: 'Search', friends: 'Friends', settings: 'Settings' };
  function showPane(name) {
    pane = name;
    $('paneTitle').textContent = t(PANE_TITLES[name]);
    for (const b of $('sideNav').children) b.classList.toggle('on', b.dataset.pane === name);
    for (const n of ['people', 'rooms', 'inbox', 'history', 'search', 'friends', 'settings']) $('pane-' + n).hidden = n !== name;
    if (name === 'settings') renderSettings();
    if (name === 'search') fillSearchCountries();
    if (name === 'people') renderList(true);
    if (name === 'rooms') renderRooms();
    renderPanes();
  }
  $('sideNav').addEventListener('click', e => { const b = e.target.closest('[data-pane]'); if (b) showPane(b.dataset.pane); });
  $('newChatBtn').onclick = () => { showPane('search'); $('sName').focus(); };

  let panesRaf = 0;
  function schedulePanes() {
    if (panesRaf) return;
    // background tabs pause animation frames; use a timer there so badges (Inbox, Friends) still update
    panesRaf = document.hidden ? setTimeout(() => { panesRaf = 0; renderPanes(); }, 50) : requestAnimationFrame(() => { panesRaf = 0; renderPanes(); });
  }
  const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? 'now' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
  const preview = m => (m.i ? '📷 Photo' : m.x || '');
  function convoRow(id, c, text, meta, unread) {
    const u = S.users.get(id) || c.peer;
    return `<div class="crow${unread ? ' unread' : ''}${c.gone ? ' gone' : ''}${S.active === id ? ' sel' : ''}" data-uid="${id}">${avatar(u)}
      <div class="info"><div class="nm">${esc(u.name)}${vb(u)}${c.gone ? ' <span class="tag-left">left</span>' : ''}</div><div class="pv">${esc(text)}</div></div>
      <div class="side-meta"><span>${meta}</span>${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div></div>`;
  }
  function renderPanes() {
    if (!S.me) return;
    const convos = [...S.convos.entries()];
    // nav badges: unread private messages (Inbox) and unread room messages (Rooms)
    const unreadPm = convos.reduce((n, [, c]) => n + c.unread, 0);
    const unreadRooms = [...S.rooms.values()].reduce((n, r) => n + (r.joined ? r.unread : 0), 0);
    for (const [id, n] of [['nbInbox', unreadPm], ['nbRooms', unreadRooms], ['nbFriends', S.fr.reqIn.length]]) { $(id).hidden = !n; $(id).textContent = n > 99 ? '99+' : n; }
    if (pane === 'friends') renderFriends();
    const recent = convos.filter(([id, c]) => c.msgs.length && (S.users.has(id) || c.peer)).sort((a, b) => b[1].last - a[1].last).slice(0, 12);
    $('recentWrap').hidden = !recent.length;
    $('recentStrip').innerHTML = recent.map(([id, c]) => { const u = S.users.get(id) || c.peer;
      return `<button type="button" class="rc${S.active === id ? ' sel' : ''}${S.users.has(id) && !(S.users.get(id).status) ? ' on' : ''}" data-uid="${id}" title="${esc(u.name)}">${avatar(u)}${c.unread ? `<b class="rc-n">${c.unread > 9 ? '9+' : c.unread}</b>` : ''}<span>${esc(u.name)}</span></button>`; }).join('');
    if (pane === 'inbox') {
      const rows = convos.filter(([, c]) => c.lastIn).sort((a, b) => b[1].lastIn - a[1].lastIn);
      $('inboxList').innerHTML = rows.length ? rows.map(([id, c]) => {
        const got = c.msgs.filter(m => !m.me);
        return convoRow(id, c, preview(got[got.length - 1]), `${ago(c.lastIn)} · ${got.length} msg${got.length === 1 ? '' : 's'}`, c.unread);
      }).join('') : '<div class="empty-pane">No messages yet.<br>When someone messages you, it shows up here.</div>';
    }
    if (pane === 'history') {
      const rows = convos.filter(([, c]) => c.msgs.length).sort((a, b) => b[1].last - a[1].last);
      $('historyList').innerHTML = rows.length ? rows.map(([id, c]) => {
        const last = c.msgs[c.msgs.length - 1];
        return convoRow(id, c, (last.me ? 'You: ' : '') + preview(last), ago(c.last), c.unread);
      }).join('') : '<div class="empty-pane">No chats yet in this visit.</div>';
    }
  }
  for (const id of ['inboxList', 'historyList', 'recentStrip']) $(id).addEventListener('click', e => { const r = e.target.closest('[data-uid]'); if (r) openChat(+r.dataset.uid); });
  setInterval(() => { if (pane === 'inbox' || pane === 'history') renderPanes(); }, 30000); // refresh "5m ago"

  // ---------------- Search tab: username + gender + country ----------------
  function fillSearchCountries() {
    // countries with people online first (with counts), then every other country
    const counts = new Map();
    for (const u of S.users.values()) if (!u.ghost) counts.set(u.cc, (counts.get(u.cc) || 0) + 1);
    const cur = $('sCountry').value;
    const online = [...counts].sort((a, b) => b[1] - a[1] || countryName(a[0]).localeCompare(countryName(b[0])));
    const rest = opts.filter(([cc]) => !counts.has(cc));
    $('sCountry').innerHTML = '<option value="">All Countries</option>' +
      (online.length ? `<optgroup label="Online now">${online.map(([cc, n]) => `<option value="${cc}">${esc(countryName(cc))} (${n})</option>`).join('')}</optgroup>` : '') +
      `<optgroup label="All countries">${rest.map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join('')}</optgroup>`;
    $('sCountry').value = cur;
  }
  function runSearch() {
    const q = $('sName').value.trim().toLowerCase();
    const g = (document.querySelector('input[name=sg]:checked') || {}).value || 'all';
    const cc = $('sCountry').value;
    const lo = +$('sAgeMin').value, hi = +$('sAgeMax').value, anyAge = lo === AGE_MIN && hi === AGE_MAX;
    const found = [...S.users.values()]
      .filter(u => !u.ghost && (!q || u.name.toLowerCase().includes(q)) && (g === 'all' || u.g === g) && (!cc || u.cc === cc) && u.age >= lo && u.age <= hi)
      .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || b.seq - a.seq)
      .slice(0, 300);
    const one = found.length === 1;
    const noun = g === 'f' ? (one ? 'woman' : 'women') : g === 'm' ? (one ? 'man' : 'men') : (one ? 'person' : 'people');
    const what = [noun, anyAge ? '' : hi === AGE_MAX ? `aged ${lo}+` : `aged ${lo}–${hi}`, cc ? `from ${countryName(cc)}` : '', q ? `matching “${$('sName').value.trim()}”` : ''].filter(Boolean).join(' ');
    $('sHead').hidden = false;
    $('sHead').textContent = found.length ? `${found.length}${found.length === 300 ? '+' : ''} ${what} online` : 'No matches online right now. Try another name, gender, age or country.';
    $('sResults').innerHTML = found.map(u => `<div class="crow ${u.g}" data-uid="${u.id}">${avatar(u)}
      <div class="info"><div class="nm">${esc(u.name)}${vb(u)}</div><div class="pv">${esc(subLine(u))}</div></div>${quickFriend(u)}${flagImg(u)}</div>`).join('');
  }
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(); });
  // age range: 18 to 99+ (the ages people can sign up with); the two boxes never cross
  const AGE_MIN = 18, AGE_MAX = 99;
  const ageOpts = sel => { let h = ''; for (let a = AGE_MIN; a <= AGE_MAX; a++) h += `<option value="${a}"${a === sel ? ' selected' : ''}>${a === AGE_MAX ? '99+' : a}</option>`; return h; };
  $('sAgeMin').innerHTML = ageOpts(AGE_MIN);
  $('sAgeMax').innerHTML = ageOpts(AGE_MAX);
  $('sAgeMin').addEventListener('change', () => { if (+$('sAgeMin').value > +$('sAgeMax').value) $('sAgeMax').value = $('sAgeMin').value; });
  $('sAgeMax').addEventListener('change', () => { if (+$('sAgeMax').value < +$('sAgeMin').value) $('sAgeMin').value = $('sAgeMax').value; });
  $('sResults').addEventListener('click', e => { if (quickFriendClick(e)) { setTimeout(runSearch, 400); return; } const r = e.target.closest('[data-uid]'); if (r) openChat(+r.dataset.uid); });

  // ---------------- friends (registered profiles) ----------------
  const isFriend = u => u && u.reg && S.frSet.has(u.name.toLowerCase());
  const inList = (list, u) => list.some(f => f.name.toLowerCase() === u.name.toLowerCase());
  function renderFriendBtn(u) {
    const b = $('friendBtn');
    b.hidden = !u || !u.reg;
    if (b.hidden) return;
    b.className = 'friend-btn';
    if (isFriend(u)) { b.textContent = '❤ Friends'; b.classList.add('done'); b.dataset.op = 'remove'; }
    else if (inList(S.fr.reqIn, u)) { b.textContent = '✓ Accept friend'; b.classList.add('go'); b.dataset.op = 'accept'; }
    else if (inList(S.fr.reqOut, u)) { b.textContent = 'Request sent'; b.classList.add('done'); b.dataset.op = 'cancel'; }
    else { b.textContent = '＋ Add friend'; b.dataset.op = 'add'; }
    b.dataset.name = u.name;
  }
  function friendAction(op, name) {
    if (!S.acct) { toast('Create a profile to add friends'); openProfile(); return; }
    if (op === 'remove' && !confirm(`Remove ${name} from your friends?`)) return;
    if (op === 'cancel' && !confirm(`Cancel your friend request to ${name}?`)) return;
    send({ t: 'fr', op, name });
  }
  // small button on People / Search rows: add a registered person as a friend without opening the chat
  const ADD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M19 8v6M16 11h6"/></svg>';
  function quickFriend(u) {
    if (!S.acct || !u.reg || isFriend(u)) return '';
    if (inList(S.fr.reqOut, u)) return '<span class="qf sent" title="Friend request sent">Sent</span>';
    const accept = inList(S.fr.reqIn, u);
    return `<button type="button" class="qf${accept ? ' go' : ''}" data-qf="${accept ? 'accept' : 'add'}" data-name="${esc(u.name)}" title="${accept ? 'Accept friend request' : 'Add friend'}" aria-label="${accept ? 'Accept friend request from' : 'Add friend:'} ${esc(u.name)}">${accept ? '✓' : ADD_ICON}</button>`;
  }
  function quickFriendClick(e) {
    const b = e.target.closest('[data-qf]');
    if (!b) return false;
    e.stopPropagation();
    S.frWatch = b.dataset.name.toLowerCase();
    friendAction(b.dataset.qf, b.dataset.name);
    return true;
  }
  $('friendBtn').onclick = () => friendAction($('friendBtn').dataset.op, $('friendBtn').dataset.name);

  function renderFriends() {
    const box = $('friendsList');
    if (!S.acct) {
      box.innerHTML = `<div class="empty-pane">❤️ Friends are for registered profiles.<br>Create a profile to add people as friends and see when they're online.<br><br><button class="pw-join" type="button" data-create>Create a profile</button></div>`;
      return;
    }
    const online = new Map();
    for (const u of S.users.values()) if (u.reg && !u.ghost) online.set(u.name.toLowerCase(), u);
    const row = (f, actions, extra = '') => {
      const u = online.get(f.name.toLowerCase());
      const who = u || { name: f.name, g: f.g, photo: f.photoV, reg: true, age: f.age, loc: f.loc, cc: f.cc };
      return `<div class="crow${u ? '' : ' offline'}"${u ? ` data-uid="${u.id}"` : ''} data-name="${esc(f.name)}">${avatar(who)}
        <div class="info"><div class="nm">${esc(f.name)}${vb(who)}${u ? ' <i class="on-dot" title="Online"></i>' : ''}</div><div class="pv">${extra || esc(subLine(who))}</div></div>
        <div class="fr-actions">${actions}</div></div>`;
    };
    const on = S.fr.friends.filter(f => online.has(f.name.toLowerCase())), off = S.fr.friends.filter(f => !online.has(f.name.toLowerCase()));
    let html = '';
    if (S.fr.reqIn.length) html += `<div class="fsec">Friend requests (${S.fr.reqIn.length})</div>` + S.fr.reqIn.map(f => row(f, '<button class="ok" data-op="accept">Accept</button><button data-op="decline">Decline</button>', 'wants to be your friend')).join('');
    html += `<div class="fsec">Online (${on.length})</div>` + (on.length ? on.map(f => row(f, '<button class="x" data-op="remove" title="Remove friend">✕</button>')).join('') : '<div class="empty-pane" style="padding:14px">No friends online right now.</div>');
    if (off.length) html += `<div class="fsec">Offline (${off.length})</div>` + off.map(f => row(f, '<button class="x" data-op="remove" title="Remove friend">✕</button>')).join('');
    if (S.fr.reqOut.length) html += `<div class="fsec">Sent requests (${S.fr.reqOut.length})</div>` + S.fr.reqOut.map(f => row(f, '<button data-op="cancel">Cancel</button>', 'waiting for them to accept')).join('');
    if (!S.fr.friends.length && !S.fr.reqIn.length && !S.fr.reqOut.length) html += '<div class="empty-pane">No friends yet.<br>Add someone by username above, or tap the ＋ next to anyone with a ✓ profile in People or Search.</div>';
    const typed = $('frAddName') ? $('frAddName').value : '';
    box.innerHTML = `<form class="fr-add" id="frAdd" autocomplete="off"><input id="frAddName" maxlength="16" placeholder="Add friend by username" aria-label="Username to add as a friend"><button type="submit">${ADD_ICON}Add</button></form>` + html;
    $('frAddName').value = typed;
  }
  $('friendsList').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('frAddName').value.trim();
    if (!name) return $('frAddName').focus();
    S.frWatch = name.toLowerCase();
    $('frAddName').value = '';
    friendAction('add', name);
  });
  $('friendsList').addEventListener('click', e => {
    if (e.target.closest('[data-create]')) return openProfile();
    const b = e.target.closest('[data-op]'), r = e.target.closest('.crow');
    if (b && r) return friendAction(b.dataset.op, r.dataset.name);
    if (r && r.dataset.uid) openChat(+r.dataset.uid);
    else if (r) toast(`${r.dataset.name} is offline`);
  });

  // ---------------- profile card at the top of a chat with a registered user ----------------
  const profileCache = new Map();
  async function showProfileCard(id) {
    const u = S.users.get(id) || (S.convos.get(id) || {}).peer;
    if (!u || !u.reg) return;
    let p = profileCache.get(u.name);
    if (!p) {
      try { p = await fetch('/api/profile/' + encodeURIComponent(u.name)).then(r => (r.ok ? r.json() : null)); } catch { p = null; }
      if (!p) return;
      profileCache.set(u.name, p); setTimeout(() => profileCache.delete(u.name), 60000);
    }
    if (S.active !== id) return;
    const card = document.createElement('div');
    card.className = 'prof-card';
    card.innerHTML = `${avatar(u)}<div class="nm">${esc(u.name)}${vb(u)}</div><div class="sub">${esc(subLine(u))}</div>${p.bio ? `<div class="bio">“${esc(p.bio)}”</div>` : ''}`;
    $('msgs').prepend(card);
  }

  // ---------------- profile dialog: create a profile (guests) or edit it ----------------
  async function squarePhoto(file) { // centre-crop to a 256px JPEG
    if (!/^image\//.test(file.type)) throw new Error('not an image');
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height), cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
    return cv.toDataURL('image/jpeg', 0.85);
  }
  let profPhoto = null, profRemovePhoto = false;
  $('pAge').innerHTML = Array.from({ length: 82 }, (_, i) => `<option>${i + 18}</option>`).join('');
  $('pCountry').innerHTML = $('fCountry').innerHTML;
  async function fillStates(cc, preferred) {
    let list = stateCache.get(cc);
    if (!list) { try { list = (await fetch('/states?cc=' + cc).then(r => r.json())).states; stateCache.set(cc, list); } catch { list = []; } }
    $('pStateWrap').hidden = !list.length;
    $('pState').innerHTML = list.map(n => `<option>${esc(n)}</option>`).join('');
    if (preferred && list.includes(preferred)) $('pState').value = preferred;
  }
  $('pCountry').addEventListener('change', () => fillStates($('pCountry').value));
  function openProfile() {
    const dlg = $('profDlg'), me = S.me;
    dlg.dataset.kind = S.acct ? 'edit' : 'claim';
    profPhoto = null; profRemovePhoto = false;
    $('profErr').textContent = '';
    $('pPhotoPrev').innerHTML = me.photo ? `<img src="/avatar/${encodeURIComponent(me.name)}?v=${encodeURIComponent(me.photo)}" alt="">` : '📷';
    $('pPhotoRemove').hidden = !me.photo;
    $('pBio').value = S.acct ? S.acct.bio || '' : '';
    if (S.acct) {
      $('profTitle').textContent = 'Your profile';
      $('profIntro').textContent = 'Registered as ' + me.name + ' ✓';
      $('pG').value = me.g; $('pAge').value = me.age; $('pCountry').value = me.cc; fillStates(me.cc, me.loc);
      $('profSave').textContent = 'Save changes';
    } else {
      $('profTitle').textContent = 'Create a profile';
      $('profIntro').textContent = `Keep the name “${me.name}” for next time: choose a password, and add a photo and bio if you like. You stay in the chat.`;
      $('pNewPw').value = '';
      $('profSave').textContent = 'Create profile';
    }
    dlg.showModal();
  }
  $('profClose').onclick = () => $('profDlg').close();
  $('pPhoto').addEventListener('change', async () => {
    const f = $('pPhoto').files[0]; $('pPhoto').value = '';
    if (!f) return;
    try { profPhoto = await squarePhoto(f); profRemovePhoto = false; $('pPhotoPrev').innerHTML = `<img src="${profPhoto}" alt="">`; $('pPhotoRemove').hidden = false; }
    catch { $('profErr').textContent = 'Could not read that photo'; }
  });
  $('pPhotoRemove').onclick = () => { profPhoto = null; profRemovePhoto = true; $('pPhotoPrev').textContent = '📷'; $('pPhotoRemove').hidden = true; };
  $('profForm').addEventListener('submit', e => {
    e.preventDefault();
    $('profErr').textContent = '';
    if (!S.acct) {
      if ($('pNewPw').value.length < 8) { $('profErr').textContent = 'Choose a password of at least 8 characters'; return; }
      send({ t: 'claim', pw: $('pNewPw').value, bio: $('pBio').value.trim(), photo: profPhoto || undefined });
    } else {
      send({ t: 'profile', bio: $('pBio').value.trim(), g: $('pG').value, age: +$('pAge').value, cc: $('pCountry').value,
        loc: $('pStateWrap').hidden ? '' : $('pState').value, photo: profPhoto || undefined, removePhoto: profRemovePhoto });
    }
    $('profSave').disabled = true;
  });
  $('pPwBtn').onclick = () => {
    $('profErr').textContent = '';
    if ($('pNext').value.length < 8) { $('profErr').textContent = 'The new password needs at least 8 characters'; return; }
    send({ t: 'pwchange', cur: $('pCur').value, next: $('pNext').value });
  };
  function onAccountReply(m) {
    $('profSave').disabled = false;
    if (m.me) S.me = toUser(m.me);
    S.acct = m.acct;
    renderMe();
    if (!m.ok) { $('profErr').textContent = m.e || 'Something went wrong'; return; }
    if (m.op === 'pwchange') { $('pCur').value = $('pNext').value = ''; $('profErr').textContent = ''; toast('Password changed'); return; }
    if ($('profDlg').open) $('profDlg').close();
    if (m.op === 'claim') store.set('chatr.mode', 'login');
    toast(m.op === 'claim' ? 'Profile created ✓ Log in with your name and password next time.' : 'Profile saved');
    if (m.e) setTimeout(() => toast(m.e), 2900);
  }

  // ---------------- my own away status: idle after 1 minute without activity ----------------
  const IDLE_AFTER = 60000;
  let lastActive = Date.now(), reportedIdle = false;
  function activity() {
    lastActive = Date.now();
    if (reportedIdle && S.me) { reportedIdle = false; send({ t: 'act' }); }
  }
  let moveThrottle = 0;
  for (const ev of ['keydown', 'pointerdown', 'touchstart', 'wheel', 'focus']) window.addEventListener(ev, activity, { capture: true, passive: true });
  window.addEventListener('pointermove', () => { const now = Date.now(); if (now - moveThrottle > 2000) { moveThrottle = now; activity(); } }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) activity(); });
  setInterval(() => {
    if (!S.me || reportedIdle) return;
    const quiet = Date.now() - lastActive;
    if (quiet >= IDLE_AFTER) { reportedIdle = true; send({ t: 'idle', ago: quiet }); }
  }, 5000);
  // keep the "5m" away labels current
  setInterval(() => {
    if (!S.me) return;
    renderList(true); schedulePanes();
    if (S.active != null && !isRoom(S.active)) renderPeer();
  }, 30000);

  // ---------------- live theme preview (Admin → Appearance shows this page in an iframe) ----------------
  if (window.parent !== window) {
    window.addEventListener('message', e => {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'theme-preview') return;
      const t = e.data.theme;
      $('themeVars').textContent = e.data.css;
      $('brandMain').textContent = t.brandMain;
      $('brandAccent').textContent = t.brandAccent;
      $('tagline').textContent = t.tagline;
      $('siteDesc').textContent = t.description;
      btnText = t.buttonText; setBtn();
      $('heroImg').style.backgroundImage = `url("${e.data.heroUrl}")`;
      for (const el of [$('heroImg'), document.querySelector('.hero-edge')]) el.classList.toggle('off', !t.showHero);
      $('heroImg').classList.toggle('default', !!e.data.heroIsDefault);
      $('login').classList.toggle('pattern', t.showPattern);
      if (e.data.logoHtml != null) $('logoBox').innerHTML = e.data.logoHtml;
    });
  }

  // ---------------- Settings (rail → ⚙): account, QR code, privacy, security, notifications, chats, appearance, language ----------------
  const SI = {
    user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1.2"/><rect x="14" y="4" width="6" height="6" rx="1.2"/><rect x="4" y="14" width="6" height="6" rx="1.2"/><path d="M14 14h2.5v2.5M20 14v.01M14 20h.01M17 17.5V20h3v-3"/>',
    shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z"/><path d="M12 10.2a1.6 1.6 0 1 0 0 .01M12 11.8v2.7"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7M12 14.5v2"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
    chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5zM8 9.5h8M8 12.5h5"/>',
    palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.5-1-2.6 0-1 .8-1.7 1.8-1.7h2.2a3.7 3.7 0 0 0 3.7-3.8c0-4-3.8-7.2-8.5-7.2z"/><circle cx="7.8" cy="11" r="1.1"/><circle cx="10.5" cy="7.6" r="1.1"/><circle cx="14.8" cy="7.8" r="1.1"/>',
    lang: '<path d="M4 6h8M8 4v2M10.5 6c-.6 3.5-3 6.5-6 8M6 9.5c1 1.8 2.6 3.2 4.5 4M13 20l3.5-8.5L20 20M14.3 17h4.4"/>',
    leave: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  };
  const ico = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${SI[k]}</svg>`;
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
  const PM_LABEL = { all: 'Everyone', reg: 'Registered profiles', friends: 'Friends only' };
  const THEME_LABEL = { light: 'Light', dark: 'Dark', system: 'System' };
  const handle = name => '@' + String(name).toLowerCase();

  function srow(id, icon, title, sub, value, cls = '') {
    return `<button type="button" class="srow ${cls}" data-set="${id}"><span class="sic">${ico(icon)}</span>` +
      `<span class="stx"><b>${t(title)}</b><small>${t(sub)}</small></span>${value ? `<span class="sval">${esc(value)}</span>` : ''}${CHEV}</button>`;
  }
  function renderSettings() {
    if (!S.me) return;
    $('setDetail').hidden = true; $('setMain').hidden = false;
    const notifOn = S.sound || prefs.desktop || prefs.popups;
    $('setMain').innerHTML =
      `<button type="button" class="s-card s-prof" data-set="account"><span class="s-prof-av">${avatar(S.me)}</span>` +
        `<span class="stx"><b>${esc(S.me.name)}${vb(S.me)}</b><small>${S.acct ? handle(S.me.name) : t('Guest · tap to create a profile')}</small></span>${CHEV}</button>` +
      `<div class="s-card"><div class="s-sec">${t('Account')}</div>` +
        srow('account', 'user', 'Account', 'Profile info', S.me.name) +
        srow('qr', 'qr', 'QR Code', 'Share your code or scan one') +
        srow('privacy', 'shield', 'Privacy', 'Who can message you', t(PM_LABEL[prefs.pmFrom])) +
        srow('security', 'lock', 'Security', 'Password and screen lock', prefs.pin ? t('On') : '') + '</div>' +
      `<div class="s-card"><div class="s-sec">${t('Preferences')}</div>` +
        srow('notifications', 'bell', 'Notifications', 'Message alerts and sounds', t(notifOn ? 'On' : 'Off')) +
        srow('chats', 'chat', 'Chats', 'Live typing, history and backup') +
        srow('appearance', 'palette', 'Appearance', 'Theme and text size', t(THEME_LABEL[prefs.theme])) +
        srow('language', 'lang', 'Language', 'App language', prefs.lang === 'ar' ? 'العربية' : 'English') + '</div>' +
      `<div class="s-card">${srow('leave', 'leave', 'Leave chat', 'Delete all your chats and sign out', '', 'danger')}</div>`;
  }

  // detail pages
  const sw = (key, title, sub, on) => `<label class="s-opt sw-row"><span class="stx"><b>${t(title)}</b>${sub ? `<small>${t(sub)}</small>` : ''}</span>` +
    `<input type="checkbox" data-pref="${key}"${on ? ' checked' : ''}><i class="sw" aria-hidden="true"></i></label>`;
  const radios = (key, opts, cur) => opts.map(([v, title, sub]) => `<label class="s-opt"><input type="radio" name="sp-${key}" value="${v}" data-pref="${key}"${v === cur ? ' checked' : ''}>` +
    `<i class="rd" aria-hidden="true"></i><span class="stx"><b>${t(title)}</b>${sub ? `<small>${t(sub)}</small>` : ''}</span></label>`).join('');
  const card = (title, body, note) => `<div class="s-card">${title ? `<div class="s-sec">${t(title)}</div>` : ''}${body}${note ? `<p class="s-note">${t(note)}</p>` : ''}</div>`;
  const chatLink = () => `${location.origin}/?chat=${encodeURIComponent(S.me.name)}`;

  const DETAIL = {
    qr: () => card('', `<div class="qr-box"><img src="/qr.svg?d=${encodeURIComponent(chatLink())}" alt="${esc(t('QR Code'))}" width="200" height="200"></div>` +
        `<p class="s-note center">${t('Anyone who scans this code opens a chat with you while you are online.')}</p>` +
        `<div class="qr-link">${esc(chatLink())}</div>` +
        `<div class="s-actions"><button type="button" class="s-btn" data-do="copyLink">${t('Copy link')}</button>${navigator.share ? `<button type="button" class="s-btn" data-do="shareLink">${t('Share')}</button>` : ''}</div>`) +
      card('', `<button type="button" class="s-btn primary wide" data-do="scan">${ico('qr')}${t('Scan a code')}</button>`),
    privacy: () => card('Who can message me', radios('pmFrom', [['all', 'Everyone', 'Anyone in the chat can start a chat with you'], ['reg', 'Registered profiles', 'Only people with a ✓ profile'], ['friends', 'Friends only', 'Only your friends (needs a profile)']], prefs.pmFrom),
        'People you are already chatting with can always reply.') +
      card('', sw('receipts', 'Read receipts', 'Let people see when you have read their messages', prefs.receipts)) +
      card('', `<button type="button" class="srow" data-do="status"><span class="sic">${ico('user')}</span><span class="stx"><b>${t('Online status')}</b><small>${t(STATUS[myStatus()].label)}</small></span>${CHEV}</button>`),
    security: () => card('Password', S.acct
        ? `<button type="button" class="srow" data-do="password"><span class="sic">${ico('lock')}</span><span class="stx"><b>${t('Change password')}</b><small>${t('For your registered profile')}</small></span>${CHEV}</button>`
        : `<p class="s-note">${t('Guests have no password. Create a profile to keep your name with a password.')}</p><div class="s-actions"><button type="button" class="s-btn primary" data-do="profile">${t('Create a profile')}</button></div>`) +
      card('Screen lock', prefs.pin
        ? `<div class="s-actions"><button type="button" class="s-btn primary" data-do="lockNow">${t('Lock now')}</button></div>` +
          `<div class="s-sub">${t('Lock automatically')}</div>` + radios('lockAfter', [['0', 'Never'], ['1', 'After 1 minute away'], ['5', 'After 5 minutes away'], ['15', 'After 15 minutes away']], String(prefs.lockAfter)) +
          `<form class="s-form" data-form="pinOff"><input type="password" inputmode="numeric" maxlength="8" placeholder="${esc(t('Current PIN'))}" name="cur"><button class="s-btn danger">${t('Turn off screen lock')}</button></form>`
        : `<form class="s-form" data-form="pinSet"><input type="password" inputmode="numeric" maxlength="8" placeholder="${esc(t('New PIN (4–8 digits)'))}" name="pin"><input type="password" inputmode="numeric" maxlength="8" placeholder="${esc(t('Repeat PIN'))}" name="pin2"><button class="s-btn primary">${t('Turn on screen lock')}</button></form>`,
        'The screen lock protects this device only. Your chats are still deleted when you leave.'),
    notifications: () => card('', sw('sound', 'Message sound', 'Play a sound for new private messages', S.sound) +
        sw('desktop', 'Desktop notifications', 'Show a notification when the tab is in the background', prefs.desktop) +
        sw('previews', 'Show message text', 'Include the message in notifications', prefs.previews) +
        sw('popups', 'Pop-ups', 'Friend requests and other notices', prefs.popups),
        'Do not disturb (in your status) mutes all of these.'),
    chats: () => card('', sw('live', 'Live typing', 'The other person sees your text as you type', S.live) +
        sw('enterSend', 'Enter to send', 'When off, use the send button', prefs.enterSend)) +
      card('History and backup', `<div class="s-actions col"><button type="button" class="s-btn" data-do="export">${t('Export chats (.txt)')}</button>` +
        `<button type="button" class="s-btn danger" data-do="clear">${t('Clear all chats')}</button></div>`, 'Chats are never saved on the server. Export them if you want to keep a copy.'),
    appearance: () => card('Theme', radios('theme', [['light', 'Light'], ['dark', 'Dark'], ['system', 'System', 'Follow your device setting']], prefs.theme)) +
      card('Text size', radios('fontSize', [['s', 'Small'], ['m', 'Normal'], ['l', 'Large']], prefs.fontSize)),
    language: () => card('', radios('lang', [['en', 'English'], ['ar', 'العربية', 'Arabic']], prefs.lang)),
  };
  const DETAIL_TITLE = { qr: 'QR Code', privacy: 'Privacy', security: 'Security', notifications: 'Notifications', chats: 'Chats', appearance: 'Appearance', language: 'Language' };
  let setPage = null;
  function openSetting(id) {
    if (id === 'account') return openProfile();
    if (id === 'leave') return $('logoutBtn').click();
    setPage = id;
    $('setMain').hidden = true; $('setDetail').hidden = false;
    $('setDetail').innerHTML = `<div class="s-top"><button type="button" class="s-back" data-back aria-label="${esc(t('Back'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button><h2>${t(DETAIL_TITLE[id])}</h2></div>` + DETAIL[id]();
    $('setDetail').scrollTop = 0;
  }
  const refreshSetting = () => { if (setPage && !$('setDetail').hidden) { const y = $('setDetail').scrollTop; openSetting(setPage); $('setDetail').scrollTop = y; } };
  $('setMain').addEventListener('click', e => { const b = e.target.closest('[data-set]'); if (b) openSetting(b.dataset.set); });
  $('setDetail').addEventListener('click', e => {
    if (e.target.closest('[data-back]')) { setPage = null; return renderSettings(); }
    const b = e.target.closest('[data-do]');
    if (b) settingAction(b.dataset.do);
  });

  // a switch or option changed
  $('setDetail').addEventListener('change', async e => {
    const el = e.target.closest('[data-pref]');
    if (!el) return;
    const key = el.dataset.pref, val = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'sound') { S.sound = val; store.set('chatr.sound', val); renderSoundBtn(); if (val) { lastChime = 0; chime(); } return; }
    if (key === 'live') { S.live = val; store.set('chatr.live', val); if (!val) stopSharingDraft(); renderLiveNote(); return; }
    if (key === 'desktop' && val) {
      if (!('Notification' in window)) { el.checked = false; return toast(t('This browser does not support notifications')); }
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (p !== 'granted') { el.checked = false; return toast(t('Notifications are blocked. Allow them in your browser settings.')); }
    }
    prefs[key] = key === 'lockAfter' ? +val : val;
    savePrefs();
    if (key === 'pmFrom') send({ t: 'privacy', pm: val });
    if (key === 'theme') applyTheme();
    if (key === 'fontSize') $('app').dataset.fs = val;
    if (key === 'lang') { applyLang(); refreshSetting(); }
  });

  $('setDetail').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, kind = f.dataset.form;
    if (kind === 'pinSet') {
      const pin = f.pin.value.trim();
      if (!/^\d{4,8}$/.test(pin)) return toast(t('The PIN must be 4–8 digits'));
      if (pin !== f.pin2.value.trim()) return toast(t('The two PINs are different'));
      prefs.pinSalt = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
      prefs.pin = await pinHash(pin);
      savePrefs(); toast(t('Screen lock is on')); refreshSetting();
    } else if (kind === 'pinOff') {
      if ((await pinHash(f.cur.value.trim())) !== prefs.pin) return toast(t('Wrong PIN'));
      prefs.pin = null; prefs.pinSalt = null; savePrefs(); toast(t('Screen lock is off')); refreshSetting();
    }
  });

  function settingAction(what) {
    const link = chatLink();
    if (what === 'copyLink') navigator.clipboard.writeText(link).then(() => toast(t('Link copied')), () => toast(link));
    else if (what === 'shareLink') navigator.share({ title: SITE(), text: t('Chat with me on') + ' ' + SITE(), url: link }).catch(() => {});
    else if (what === 'scan') startScan();
    else if (what === 'status') toggleStatusMenu(true);
    else if (what === 'profile') openProfile();
    else if (what === 'password') { openProfile(); const d = document.querySelector('#profDlg .pw-change'); if (d) { d.open = true; setTimeout(() => $('pCur').focus(), 50); } }
    else if (what === 'lockNow') lockScreen();
    else if (what === 'export') exportChats();
    else if (what === 'clear') {
      if (!S.convos.size) return toast(t('There are no chats to clear'));
      if (!confirm(t('Delete all your private chats on this device?'))) return;
      S.convos.clear();
      markDirty(); updateTitle(); schedulePanes();
      if (!isRoom(S.active)) openDefault();
      toast(t('All chats cleared'));
    }
  }

  function exportChats() {
    const lines = [];
    for (const [id, c] of S.convos) {
      if (!c.msgs.length) continue;
      const u = S.users.get(id) || c.peer || { name: '?' };
      lines.push(`=== ${SITE()} chat with ${u.name} ===`);
      for (const m of c.msgs) lines.push(`[${new Date(m.ts).toLocaleString()}] ${m.me ? S.me.name : u.name}: ${m.i ? '[photo]' : m.x}`);
      lines.push('');
    }
    if (!lines.length) return toast(t('There are no chats to export'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    a.download = `${SITE().toLowerCase()}-chats-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- QR scanning (camera + the browser's built-in barcode reader) ----
  let scanStream = null, scanTimer = 0;
  async function startScan() {
    const dlg = $('scanDlg'), msg = $('scanMsg'), vid = $('scanVid');
    msg.textContent = ''; vid.hidden = true;
    dlg.showModal();
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
      msg.textContent = t("This browser can't scan codes. Open your phone's camera app and point it at the code: it opens the chat directly.");
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      vid.srcObject = scanStream; vid.hidden = false; await vid.play();
      msg.textContent = t('Point the camera at a QR code');
      const det = new BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (!dlg.open) return;
        try {
          const [code] = await det.detect(vid);
          if (code) return onScanned(code.rawValue);
        } catch {}
        scanTimer = setTimeout(tick, 250);
      };
      tick();
    } catch { msg.textContent = t('Camera access was refused.'); }
  }
  function stopScan() { clearTimeout(scanTimer); if (scanStream) scanStream.getTracks().forEach(tr => tr.stop()); scanStream = null; }
  $('scanDlg').addEventListener('close', stopScan);
  function onScanned(value) {
    $('scanDlg').close();
    let name = null;
    try { const u = new URL(value); if (u.origin === location.origin) name = u.searchParams.get('chat'); } catch {}
    if (!name) return toast(t('That is not a chat code from this site'));
    openChatLink(name);
  }
  function openChatLink(name) {
    if (S.me && name.toLowerCase() === S.me.name.toLowerCase()) return toast(t('That is your own code'));
    const u = [...S.users.values()].find(x => !x.ghost && x.name.toLowerCase() === name.toLowerCase());
    if (u) openChat(u.id); else toast(`${name} ${t("isn't online right now")}`);
  }

  // ---- screen lock ----
  async function pinHash(pin) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((prefs.pinSalt || '') + ':' + pin));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  let lockFails = 0, lockUntil = 0;
  function lockScreen() {
    if (!prefs.pin || !S.me) return;
    $('lockScr').hidden = false; $('lockErr').textContent = ''; $('lockPin').value = '';
    toggleStatusMenu(false); $('emojiPop').hidden = true;
    setTimeout(() => $('lockPin').focus(), 30);
  }
  $('lockForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (Date.now() < lockUntil) return ($('lockErr').textContent = t('Too many tries. Wait a moment.'));
    if ((await pinHash($('lockPin').value.trim())) === prefs.pin) { lockFails = 0; $('lockScr').hidden = true; lastAct = Date.now(); return; }
    $('lockPin').value = '';
    if (++lockFails >= 5) { lockFails = 0; lockUntil = Date.now() + 30000; }
    $('lockErr').textContent = t('Wrong PIN');
  });
  $('lockLeave').onclick = () => { if (confirm(t('Leave the chat? All your chats are deleted.'))) { prefs.pin = null; savePrefs(); $('lockScr').hidden = true; $('logoutBtn').click(); } };
  let lastAct = Date.now(), hiddenAt = 0;
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if ($('lockScr').hidden) lastAct = Date.now(); }, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (prefs.pin && prefs.lockAfter && hiddenAt && Date.now() - hiddenAt >= prefs.lockAfter * 60000) lockScreen();
  });
  setInterval(() => { if (prefs.pin && prefs.lockAfter && $('lockScr').hidden && Date.now() - lastAct >= prefs.lockAfter * 60000) lockScreen(); }, 15000);

  // ---- desktop notifications for private messages ----
  function notifyDesktop(from, msg) {
    if (!prefs.desktop || !document.hidden || dnd() || !('Notification' in window) || Notification.permission !== 'granted') return;
    const u = S.users.get(from);
    if (!u) return;
    try {
      const n = new Notification(u.name, { body: prefs.previews ? (msg.i ? '📷 ' + t('Photo') : msg.x || '') : t('New message'), tag: 'pm-' + from });
      n.onclick = () => { window.focus(); openChat(from); n.close(); };
    } catch {}
  }

  // ---- language: English / Arabic (right-to-left) ----
  const AR = {
    'People': 'الأشخاص', 'Rooms': 'الغرف', 'Inbox': 'الوارد', 'History': 'السجل', 'Search': 'بحث', 'Friends': 'الأصدقاء', 'Settings': 'الإعدادات',
    'Recent chats': 'المحادثات الأخيرة', 'Online now': 'متصل الآن', 'All': 'الكل', 'Female': 'أنثى', 'Male': 'ذكر', 'Type a message…': 'اكتب رسالة…',
    'Account': 'الحساب', 'Profile info': 'معلومات الملف الشخصي', 'QR Code': 'رمز QR', 'Share your code or scan one': 'شارك رمزك أو امسح رمزًا',
    'Privacy': 'الخصوصية', 'Who can message you': 'من يمكنه مراسلتك', 'Security': 'الأمان', 'Password and screen lock': 'كلمة المرور وقفل الشاشة',
    'Preferences': 'التفضيلات', 'Notifications': 'الإشعارات', 'Message alerts and sounds': 'تنبيهات الرسائل والأصوات', 'Chats': 'المحادثات',
    'Live typing, history and backup': 'الكتابة المباشرة والسجل والنسخ', 'Appearance': 'المظهر', 'Theme and text size': 'السمة وحجم الخط',
    'Language': 'اللغة', 'App language': 'لغة التطبيق', 'Leave chat': 'مغادرة الدردشة', 'Delete all your chats and sign out': 'حذف كل محادثاتك والخروج',
    'Guest · tap to create a profile': 'زائر · اضغط لإنشاء ملف شخصي', 'On': 'مفعّل', 'Off': 'متوقف', 'Everyone': 'الجميع',
    'Registered profiles': 'الملفات المسجلة', 'Friends only': 'الأصدقاء فقط', 'Light': 'فاتح', 'Dark': 'داكن', 'System': 'النظام', 'Back': 'رجوع',
    'Who can message me': 'من يمكنه مراسلتي', 'Anyone in the chat can start a chat with you': 'يمكن لأي شخص بدء محادثة معك',
    'Only people with a ✓ profile': 'فقط من لديهم ملف ✓', 'Only your friends (needs a profile)': 'أصدقاؤك فقط (يتطلب ملفًا شخصيًا)',
    'People you are already chatting with can always reply.': 'يمكن لمن تتحدث معهم الرد دائمًا.', 'Read receipts': 'إيصالات القراءة',
    'Let people see when you have read their messages': 'اسمح للآخرين بمعرفة أنك قرأت رسائلهم', 'Online status': 'حالة الاتصال',
    'Password': 'كلمة المرور', 'Change password': 'تغيير كلمة المرور', 'For your registered profile': 'لملفك المسجل',
    'Guests have no password. Create a profile to keep your name with a password.': 'الزوار ليس لديهم كلمة مرور. أنشئ ملفًا شخصيًا للاحتفاظ باسمك.',
    'Create a profile': 'إنشاء ملف شخصي', 'Screen lock': 'قفل الشاشة', 'Lock now': 'اقفل الآن', 'Lock automatically': 'القفل التلقائي', 'Never': 'أبدًا',
    'After 1 minute away': 'بعد دقيقة من الغياب', 'After 5 minutes away': 'بعد 5 دقائق من الغياب', 'After 15 minutes away': 'بعد 15 دقيقة من الغياب',
    'Current PIN': 'الرمز الحالي', 'Turn off screen lock': 'إيقاف قفل الشاشة', 'New PIN (4–8 digits)': 'رمز جديد (4–8 أرقام)', 'Repeat PIN': 'أعد الرمز',
    'Turn on screen lock': 'تفعيل قفل الشاشة', 'The screen lock protects this device only. Your chats are still deleted when you leave.': 'قفل الشاشة يحمي هذا الجهاز فقط. تُحذف محادثاتك عند المغادرة.',
    'Message sound': 'صوت الرسائل', 'Play a sound for new private messages': 'تشغيل صوت للرسائل الخاصة الجديدة', 'Desktop notifications': 'إشعارات سطح المكتب',
    'Show a notification when the tab is in the background': 'إظهار إشعار عندما تكون الصفحة في الخلفية', 'Show message text': 'إظهار نص الرسالة',
    'Include the message in notifications': 'تضمين الرسالة في الإشعارات', 'Pop-ups': 'النوافذ المنبثقة', 'Friend requests and other notices': 'طلبات الصداقة والتنبيهات الأخرى',
    'Do not disturb (in your status) mutes all of these.': 'وضع عدم الإزعاج يكتم كل هذا.', 'Live typing': 'الكتابة المباشرة',
    'The other person sees your text as you type': 'يرى الطرف الآخر ما تكتبه أثناء الكتابة', 'Enter to send': 'الإرسال بزر Enter',
    'When off, use the send button': 'عند الإيقاف استخدم زر الإرسال', 'History and backup': 'السجل والنسخ الاحتياطي', 'Export chats (.txt)': 'تصدير المحادثات (.txt)',
    'Clear all chats': 'مسح كل المحادثات', 'Chats are never saved on the server. Export them if you want to keep a copy.': 'لا تُحفظ المحادثات على الخادم. صدّرها للاحتفاظ بنسخة.',
    'Theme': 'السمة', 'Follow your device setting': 'حسب إعداد جهازك', 'Text size': 'حجم النص', 'Small': 'صغير', 'Normal': 'عادي', 'Large': 'كبير', 'Arabic': 'العربية',
    'Anyone who scans this code opens a chat with you while you are online.': 'من يمسح هذا الرمز يفتح محادثة معك أثناء اتصالك.',
    'Copy link': 'نسخ الرابط', 'Share': 'مشاركة', 'Scan a code': 'مسح رمز', 'Close': 'إغلاق', 'Link copied': 'تم نسخ الرابط', 'Unlock': 'فتح',
    'Chat is locked': 'الدردشة مقفلة', 'Enter your PIN to continue': 'أدخل الرمز للمتابعة', 'Forgot your PIN? Leave the chat': 'نسيت الرمز؟ غادر الدردشة', 'Wrong PIN': 'رمز خاطئ',
    'Join a room to chat with everyone in it. Your private chats keep working.': 'انضم إلى غرفة للدردشة مع الجميع. محادثاتك الخاصة تستمر.',
    'Messages people have sent you during this visit.': 'الرسائل التي أرسلها لك الآخرون خلال هذه الزيارة.',
    "Every chat from this visit, including people who have left. It's all deleted when you leave.": 'كل محادثات هذه الزيارة، بما فيها من غادروا. تُحذف كلها عند مغادرتك.',
    '1-to-1 chat': 'محادثة فردية', 'Private chats with one person at a time': 'محادثات خاصة مع شخص واحد في كل مرة',
    'Tap someone in People to start a private chat, or open Rooms to join a group chat.': 'اضغط على شخص في قائمة الأشخاص لبدء محادثة خاصة، أو افتح الغرف للانضمام إلى محادثة جماعية.',
    'Username': 'اسم المستخدم', 'All Countries': 'كل الدول', 'Age': 'العمر', 'to': 'إلى',
  };
  function t(s) { return (prefs.lang === 'ar' && AR[s]) || s; }
  function applyLang() {
    const ar = prefs.lang === 'ar';
    $('app').dir = ar ? 'rtl' : 'ltr';
    $('app').lang = ar ? 'ar' : 'en';
    for (const b of $('sideNav').children) { const l = b.querySelector('span:not(.ic)'); if (l) l.textContent = t(PANE_TITLES[b.dataset.pane]); }
    $('paneTitle').textContent = t(PANE_TITLES[pane]);
    $('text').placeholder = t('Type a message…');
    for (const b of $('tabs').children) b.firstChild.textContent = (b.dataset.f === 'all' ? t('All') : (b.dataset.f === 'f' ? '♀ ' + t('Female') : '♂ ' + t('Male'))) + ' ';
    document.querySelector('#recentWrap .sec-h').textContent = t('Recent chats');
    document.querySelector('.list-h').textContent = t('Online now');
    for (const el of document.querySelectorAll('.pane-note')) { el.dataset.en = el.dataset.en || el.textContent; el.textContent = t(el.dataset.en); }
    for (const el of document.querySelectorAll('#lockScr [data-i18n], #scanDlg [data-i18n]')) el.textContent = t(el.dataset.i18n);
    $('sName').placeholder = t('Username');
    document.querySelector('.search-btn').textContent = t('Search');
    if (pane === 'settings' && !$('setMain').hidden) renderSettings();
    if (S.me && S.active == null) openDefault();
  }

  // Settings → Chats → Enter to send (off: only the send button sends)
  $('text').addEventListener('keydown', e => { if (e.key === 'Enter' && !prefs.enterSend) e.preventDefault(); });
  // apply saved preferences
  $('app').dataset.fs = prefs.fontSize;
  applyLang();

  let toastTimer;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
})();
