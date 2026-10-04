(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const cname = cc => { try { return regionNames.of(cc.toUpperCase()); } catch { return cc.toUpperCase(); } };
  const flag = cc => `<img class="flag" src="https://flagcdn.com/w40/${esc(cc)}.png" alt="" loading="lazy">`;
  const fmt = n => (n ?? 0).toLocaleString();
  const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
  const tFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const dtFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const clock = ts => tFmt.format(ts);
  function dur(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
  }
  const ago = ts => dur(Date.now() - ts) + ' ago';

  // ---------------- API ----------------
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/admin/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-admin': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  let toastTimer;
  function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600); }

  // ---------------- tooltip (any element with data-tip) ----------------
  const tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  document.addEventListener('mousemove', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) showTip(t.dataset.tip, e.clientX, e.clientY);
    else if (!e.target.closest('.chart')) hideTip();
  });

  // ---------------- auth / routing ----------------
  function showLogin() {
    $('shell').hidden = true; $('login').hidden = false;
    stopPolling();
    setTimeout(() => $('pw').focus(), 0);
  }
  function showShell() {
    $('login').hidden = true; $('shell').hidden = false;
    route();
    startPolling();
  }
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try { await api('/login', { method: 'POST', body: { password: $('pw').value } }); $('pw').value = ''; showShell(); }
    catch (err) { $('loginErr').textContent = err.message; }
  });
  $('logout').onclick = async () => { try { await api('/logout', { method: 'POST' }); } catch {} showLogin(); };

  const VIEWS = ['overview', 'convos', 'room', 'users', 'accounts', 'filter', 'appearance', 'spam', 'bans'];
  let view = 'overview';
  function route() {
    const v = location.hash.slice(1).split('?')[0];
    view = VIEWS.includes(v) ? v : 'overview';
    for (const name of VIEWS) $('v-' + name).hidden = name !== view;
    for (const a of $('nav').querySelectorAll('a')) a.classList.toggle('on', a.dataset.view === view);
    hideTip();
    refresh(true);
  }
  window.addEventListener('hashchange', route);

  let pollTimer = null, busy = false;
  function startPolling() { stopPolling(); pollTimer = setInterval(() => { if (!document.hidden) refresh(false); }, 4000); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  async function refresh(entering) {
    if (busy) return;
    busy = true;
    try {
      if (view === 'overview') await loadOverview();
      else if (view === 'convos') await loadConvos();
      else if (view === 'room') await loadRoom();
      else if (view === 'users') await loadUsers();
      else if (view === 'accounts') await loadAccounts();
      else if (view === 'filter') await loadFilter(entering);
      else if (view === 'appearance') { if (entering) await loadAppearance(); }
      else if (view === 'spam') await loadSpam(entering);
      else if (view === 'bans') await loadBans();
    } catch (e) { if (e.message !== 'Signed out') console.warn(e); }
    finally { busy = false; }
  }

  // ================= Overview =================
  let lastOverview = null;
  async function loadOverview() {
    const d = await api('/overview');
    lastOverview = d;
    $('navUsers').textContent = fmt(d.online);
    $('navConvos').textContent = fmt(d.activeConvos);
    const st = d.storage || {};
    $('uptime').innerHTML = `Server up ${dur(d.now - d.startedAt)} · ${fmt(d.memoryMB)} MB memory · ` +
      (st.kind === 'postgres'
        ? (st.error ? `<span class="tag block" data-tip="${esc(st.error)}">Database error</span> ${esc(st.detail)}` : `<span class="tag" style="background:#e7f6ea;color:#1b7a2f">Saved in database</span> ${esc(st.detail)}`)
        : `<span class="tag mask" data-tip="Settings are saved as files on this server. On hosts without a persistent disk (e.g. Render free) they reset on restart — set DATABASE_URL to use PostgreSQL.">Saved in files</span>`);
    const msgs = d.messages.room + d.messages.pm + d.messages.img;
    $('tiles').innerHTML = [
      tile('Online now', fmt(d.online), `Peak ${fmt(d.peak.n)} at ${dtFmt.format(d.peak.ts)}`, true),
      tile('Joins', fmt(d.totalJoins), `since ${dtFmt.format(d.startedAt)}`),
      tile('Messages sent', fmt(msgs), `${fmt(d.messages.room)} room · ${fmt(d.messages.pm)} private · ${fmt(d.messages.img)} pictures`),
      tile('Private chats', fmt(d.activeConvos), 'active right now'),
      tile('Filtered', fmt(d.filtered.masked + d.filtered.blocked), `${fmt(d.filtered.masked)} masked · ${fmt(d.filtered.blocked)} blocked`),
      tile('Moderation', fmt(d.moderation.kicks), `kicks · ${fmt(d.moderation.bans)} active bans`),
    ].join('');
    renderLine($('lineChart'), d.history.concat([[d.now, d.online]]));
    renderCountries();
    renderGender(d);
    renderAges($('ageChart'), d.ages, d.online);
  }
  const tile = (lbl, val, sub, hero) => `<div class="tile${hero ? ' hero' : ''}"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${esc(sub)}</div></div>`;

  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function renderLine(el, pts) {
    const W = Math.max(300, el.clientWidth), H = 240;
    const M = { l: 48, r: 18, t: 14, b: 28 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const x0 = pts[0][0], x1 = Math.max(pts[pts.length - 1][0], x0 + 60000);
    const yMax = niceMax(Math.max(...pts.map(p => p[1])));
    const X = t => M.l + ((t - x0) / (x1 - x0)) * iw;
    const Y = v => M.t + ih - (v / yMax) * ih;
    let grid = '', ticks = '';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i, y = Y(v);
      grid += `<line class="gridline" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/>`;
      ticks += `<text x="${M.l - 8}" y="${y + 4}" text-anchor="end">${fmt(Math.round(v))}</text>`;
    }
    const nx = W < 500 ? 3 : 5;
    for (let i = 0; i <= nx; i++) {
      const t = x0 + ((x1 - x0) / nx) * i;
      ticks += `<text x="${X(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === nx ? 'end' : 'middle'}">${clock(t)}</text>`;
    }
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const area = `${line}L${X(pts[pts.length - 1][0]).toFixed(1)},${Y(0)}L${X(pts[0][0]).toFixed(1)},${Y(0)}Z`;
    const last = pts[pts.length - 1];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Online users over time">
      ${grid}<line x1="${M.l}" x2="${W - M.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="#d8dbe2"/>
      <g class="axis">${ticks}</g>
      <path d="${area}" fill="var(--seq)" opacity=".1"/>
      <path d="${line}" fill="none" stroke="var(--seq)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(last[0])}" cy="${Y(last[1])}" r="4.5" fill="var(--seq)" stroke="#fff" stroke-width="2"/>
      <line class="xh" y1="${M.t}" y2="${M.t + ih}" stroke="#9aa3b2" stroke-width="1" visibility="hidden"/>
      <circle class="xd" r="5" fill="var(--seq)" stroke="#fff" stroke-width="2" visibility="hidden"/>
      <rect x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>`;
    const svg = el.firstElementChild, xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
    svg.onmousemove = e => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      if (px < M.l || px > W - M.r) { svg.onmouseleave(); return; }
      const t = x0 + ((px - M.l) / iw) * (x1 - x0);
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid; else hi = mid; }
      const p = Math.abs(pts[lo][0] - t) < Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
      xh.setAttribute('x1', X(p[0])); xh.setAttribute('x2', X(p[0])); xh.setAttribute('visibility', 'visible');
      xd.setAttribute('cx', X(p[0])); xd.setAttribute('cy', Y(p[1])); xd.setAttribute('visibility', 'visible');
      showTip(`${dtFmt.format(p[0])}<br><b>${fmt(p[1])}</b> online`, e.clientX, e.clientY);
    };
    svg.onmouseleave = () => { xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); hideTip(); };
  }

  function renderAges(el, ages, total) {
    const labels = ['18–24', '25–34', '35–44', '45–54', '55+'];
    const W = Math.max(260, el.clientWidth), H = 200, M = { l: 8, r: 8, t: 22, b: 26 };
    const ih = H - M.t - M.b, band = (W - M.l - M.r) / ages.length, bw = Math.min(24, band * 0.5);
    const max = Math.max(1, ...ages);
    let s = `<line x1="${M.l}" x2="${W - M.r}" y1="${M.t + ih}" y2="${M.t + ih}" stroke="#d8dbe2"/>`;
    ages.forEach((v, i) => {
      const h = (v / max) * ih, x = M.l + band * i + (band - bw) / 2, y = M.t + ih - h, r = Math.min(4, h);
      const path = h > 0 ? `M${x},${M.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${M.t + ih}Z` : '';
      s += `<g data-tip="${labels[i]}: <b>${fmt(v)}</b> users (${pct(v, total)}%)">
        <rect x="${M.l + band * i}" y="${M.t}" width="${band}" height="${ih}" fill="transparent"/>
        <path d="${path}" fill="var(--seq)"/>
        <text x="${x + bw / 2}" y="${y - 6}" text-anchor="middle" fill="var(--ink-2)" font-size="12" font-weight="700">${fmt(v)}</text>
        <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" fill="var(--muted)" font-size="11.5" font-weight="600">${labels[i]}</text></g>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Users by age group">${s}</svg>`;
  }

  function renderGender(d) {
    const total = d.female + d.male;
    $('genderBox').innerHTML = `
      <div class="gender-bar" data-tip="Female <b>${fmt(d.female)}</b> (${pct(d.female, total)}%) · Male <b>${fmt(d.male)}</b> (${pct(d.male, total)}%)">
        ${d.female ? `<i class="f" style="flex:${d.female}"></i>` : ''}${d.male ? `<i class="m" style="flex:${d.male}"></i>` : ''}
      </div>
      <div class="gender-nums">
        <div><span class="l"><i class="sw f"></i>Female</span><span class="v">${fmt(d.female)}</span><span class="muted">${pct(d.female, total)}%</span></div>
        <div><span class="l"><i class="sw m"></i>Male</span><span class="v">${fmt(d.male)}</span><span class="muted">${pct(d.male, total)}%</span></div>
      </div>`;
  }

  function renderCountries() {
    if (!lastOverview) return;
    const q = $('ctySearch').value.trim().toLowerCase();
    const rows = lastOverview.countries.filter(c => !q || cname(c.cc).toLowerCase().includes(q) || c.cc === q);
    $('ctyTable').tBodies[0].innerHTML = rows.length ? rows.map(c => {
      const tot = c.f + c.m;
      return `<tr>
        <td><a class="cty" href="#users" data-cc="${c.cc}" style="color:inherit;text-decoration:none">${flag(c.cc)}${esc(cname(c.cc))}</a></td>
        <td class="num"><b>${fmt(c.online)}</b></td>
        <td><div class="split-cell">
          <div class="split-bar" data-tip="${esc(cname(c.cc))}<br>Female <b>${fmt(c.f)}</b> (${pct(c.f, tot)}%)<br>Male <b>${fmt(c.m)}</b> (${pct(c.m, tot)}%)">
            ${c.f ? `<i class="f" style="flex:${c.f}"></i>` : ''}${c.m ? `<i class="m" style="flex:${c.m}"></i>` : ''}
          </div>${fmt(c.f)} / ${fmt(c.m)}</div></td>
        <td class="num">${c.avgAge ?? '–'}</td>
        <td class="num">${fmt(c.joins)}</td></tr>`;
    }).join('') : `<tr><td colspan="5" class="empty">No users yet</td></tr>`;
  }
  $('ctySearch').addEventListener('input', renderCountries);
  $('ctyTable').addEventListener('click', e => {
    const a = e.target.closest('[data-cc]');
    if (a) { e.preventDefault(); $('userCountry').value = a.dataset.cc; location.hash = 'users'; }
  });
  window.addEventListener('resize', () => { if (view === 'overview' && lastOverview) { renderLine($('lineChart'), lastOverview.history.concat([[lastOverview.now, lastOverview.online]])); renderAges($('ageChart'), lastOverview.ages, lastOverview.online); } });

  // ================= Conversations =================
  let selectedConvo = null;
  let convoUser = null; // { id, name } when filtering to one user
  async function loadConvos() {
    const qs = new URLSearchParams({ q: $('convoSearch').value.trim() });
    if (convoUser) qs.set('user', convoUser.id);
    const d = await api('/convos?' + qs);
    $('navConvos').textContent = fmt(d.total);
    const flaggedOnly = $('flaggedOnly').checked;
    const list = d.convos.filter(c => !flaggedOnly || c.flagged);
    $('convoUserChip').hidden = !convoUser;
    if (convoUser) $('convoUserChip').innerHTML = `<span class="chip">Chats of ${esc(convoUser.name)} <button data-clear aria-label="Clear">×</button></span>`;
    $('convoList').innerHTML = list.length ? list.map(c => `
      <div class="ci${c.key === selectedConvo ? ' on' : ''}" data-key="${c.key}">
        <div class="top"><i class="dot ${c.a.g}"></i>${esc(c.a.name)} <span class="x">↔</span> <i class="dot ${c.b.g}"></i>${esc(c.b.name)}
          ${c.flagged ? '<span class="tag flag">Flagged</span>' : ''}<time>${ago(c.last)}</time></div>
        <div class="pv">${esc(c.lastFrom === c.a.id ? c.a.name : c.b.name)}: ${esc(c.preview)} <span class="muted">· ${fmt(c.count)} msgs</span></div>
      </div>`).join('') : `<div class="empty">${d.total ? 'No conversations match.' : 'No private conversations right now.'}</div>`;
    if (selectedConvo) await loadTranscript();
  }
  $('convoList').addEventListener('click', e => {
    const ci = e.target.closest('.ci'); if (!ci) return;
    selectedConvo = ci.dataset.key;
    for (const x of $('convoList').children) x.classList.toggle('on', x === ci);
    loadTranscript(true);
  });
  $('convoUserChip').addEventListener('click', e => { if (e.target.closest('[data-clear]')) { convoUser = null; refresh(); } });
  let convoQ;
  $('convoSearch').addEventListener('input', () => { clearTimeout(convoQ); convoQ = setTimeout(() => refresh(), 250); });
  $('flaggedOnly').addEventListener('change', () => refresh());

  let transcriptSig = '';
  async function loadTranscript(fresh) {
    const key = selectedConvo;
    let c;
    try { c = await api('/convos/' + encodeURIComponent(key)); }
    catch (e) {
      if (key !== selectedConvo) return;
      $('transcript').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      selectedConvo = null; transcriptSig = '';
      return;
    }
    if (key !== selectedConvo) return;
    const sig = key + ':' + c.count;
    if (!fresh && sig === transcriptSig) return; // nothing new
    transcriptSig = sig;
    const body = $('transcript').querySelector('.t-body');
    const atBottom = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    const prevTop = body ? body.scrollTop : 0;
    const userBlock = u => u ? `<div class="t-user"><i class="dot ${u.g}"></i><div><div class="nm">${esc(u.name)}</div>
        <div class="sub">${u.age} yrs · ${esc([u.loc, cname(u.cc)].filter(Boolean).join(', '))}</div></div>${flag(u.cc)}
        <div class="btns"><button class="btn sm ghost" data-kick="${u.id}" data-name="${esc(u.name)}">Kick</button><button class="btn sm outline-danger" data-ban="${u.id}" data-name="${esc(u.name)}">Ban</button></div></div>` : '<div class="t-user muted">(left)</div>';
    const names = { [c.a?.id]: c.a?.name, [c.b?.id]: c.b?.name };
    const msgs = c.msgs.map(m => {
      const side = c.b && m.f === c.b.id ? 'b' : 'a';
      let content;
      if (m.i !== undefined) content = m.i ? `<img src="${m.i}" alt="Picture" loading="lazy">` : '<span class="muted">📷 Picture (not kept — storage limit reached)</span>';
      else content = esc(m.x);
      const tags = (m.blocked ? '<span class="tag block">Blocked</span>' : '') + (m.o ? '<span class="tag mask">Masked</span>' : '');
      return `<div class="tm ${side}${m.blocked ? ' blocked' : ''}">
        <div class="meta">${esc(names[m.f] || '?')} · ${clock(m.ts)} ${tags}</div>
        <div class="bub">${content}</div>
        ${m.o ? `<div class="orig">Original: ${esc(m.o)}</div>` : ''}</div>`;
    }).join('');
    $('transcript').innerHTML = `<div class="t-head">${userBlock(c.a)}<span class="t-sep">↔</span>${userBlock(c.b)}
        <span class="muted t-meta">${fmt(c.count)} messages · started ${ago(c.started)}${c.count > c.msgs.length ? ` · showing last ${c.msgs.length}` : ''}</span></div>
      <div class="t-body">${msgs || '<div class="empty">No messages</div>'}</div>`;
    const nb = $('transcript').querySelector('.t-body');
    nb.scrollTop = fresh || atBottom ? nb.scrollHeight : prevTop;
  }

  // lightbox for pictures in transcripts
  document.addEventListener('click', e => {
    if (e.target.matches('.tm img')) {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = `<img src="${e.target.src}" alt="">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    }
  });

  // ================= Kick / Ban (shared) =================
  document.addEventListener('click', async e => {
    const k = e.target.closest('[data-kick]');
    if (k) {
      const reason = prompt(`Kick ${k.dataset.name}? Optional reason (shown to them):`, '');
      if (reason === null) return;
      try { await api(`/users/${k.dataset.kick}/kick`, { method: 'POST', body: { reason } }); toast(`${k.dataset.name} was kicked`); refresh(true); }
      catch (err) { toast(err.message); }
      return;
    }
    const b = e.target.closest('[data-ban]');
    if (b) openBan(+b.dataset.ban, b.dataset.name);
  });
  function openBan(id, name) {
    const dlg = $('banDlg');
    $('banTitle').textContent = `Ban ${name}`;
    $('banReason').value = '';
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      try {
        await api(`/users/${id}/ban`, { method: 'POST', body: { hours: +$('banHours').value, reason: $('banReason').value.trim() } });
        toast(`${name} was banned`); refresh(true);
      } catch (err) { toast(err.message); }
    };
    dlg.showModal();
  }

  // ================= Main room =================
  // ---------- room management ----------
  let roomsData = [], editingRoom = null;
  async function loadRooms() {
    roomsData = (await api('/rooms')).rooms;
    $('navRooms').textContent = roomsData.length;
    // don't redraw under the admin's cursor while a row button is focused
    if (!$('roomTable').contains(document.activeElement)) {
      $('roomTable').tBodies[0].innerHTML = roomsData.length ? roomsData.map((r, i) => `<tr data-id="${esc(r.id)}">
        <td><b>${esc(r.name)}</b>${r.desc ? `<div class="muted">${esc(r.desc)}</div>` : ''}</td>
        <td>${r.locked ? '🔒 Password' : 'Open'}</td>
        <td><button class="btn sm ${r.chat ? 'ghost' : 'outline-danger'}" data-chat title="${r.chat ? 'Everyone can send messages. Click to turn chat off.' : 'Nobody can post. Click to turn chat on.'}">${r.chat ? '💬 On' : '🔇 Off'}</button></td>
        <td class="num"><b>${fmt(r.members)}</b></td>
        <td class="num">${fmt(r.messages)}</td>
        <td class="actions">
          <button class="btn sm ghost" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button class="btn sm ghost" data-move="1" ${i === roomsData.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="btn sm ghost" data-edit>Edit</button><button class="btn sm outline-danger" data-del>Delete</button></td></tr>`).join('')
        : '<tr><td colspan="6" class="empty">No rooms. Create one →</td></tr>';
    }
    const f = $('roomFilter'), cur = f.value;
    f.innerHTML = '<option value="">All rooms</option>' + roomsData.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    f.value = roomsData.some(r => r.id === cur) ? cur : '';
  }
  function resetRoomForm() {
    editingRoom = null;
    $('roomForm').reset();
    $('roomFormTitle').textContent = 'Create a room'; $('roomFormBtn').textContent = 'Create room';
    $('rfPwLabel').innerHTML = 'Password <span class="muted">(optional; leave empty for an open room)</span>';
    $('roomFormCancel').hidden = true; $('rfRemoveWrap').hidden = true; $('roomFormErr').textContent = '';
  }
  $('roomFormCancel').onclick = resetRoomForm;
  $('roomTable').addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const r = roomsData.find(x => x.id === tr.dataset.id); if (!r) return;
    try {
      if (e.target.closest('[data-chat]')) {
        await api(`/rooms/${r.id}`, { method: 'PATCH', body: { chat: !r.chat } });
        toast(`Chat ${r.chat ? 'turned off' : 'turned on'} in “${r.name}”`);
      } else if (e.target.closest('[data-move]')) {
        await api(`/rooms/${r.id}/move`, { method: 'POST', body: { dir: +e.target.closest('[data-move]').dataset.move } });
      } else if (e.target.closest('[data-edit]')) {
        editingRoom = r.id;
        $('rfName').value = r.name; $('rfDesc').value = r.desc || ''; $('rfPw').value = ''; $('rfRemovePw').checked = false; $('rfChat').checked = r.chat;
        $('roomFormTitle').textContent = `Edit “${r.name}”`; $('roomFormBtn').textContent = 'Save changes';
        $('rfPwLabel').innerHTML = r.locked ? 'New password <span class="muted">(leave empty to keep the current one)</span>' : 'Password <span class="muted">(optional; set one to lock the room)</span>';
        $('rfRemoveWrap').hidden = !r.locked; $('roomFormCancel').hidden = false; $('roomFormErr').textContent = '';
        $('rfName').focus();
        return;
      } else if (e.target.closest('[data-del]')) {
        if (!confirm(`Delete “${r.name}”? The ${r.members} ${r.members === 1 ? 'person' : 'people'} in it will be removed from the room.`)) return;
        await api(`/rooms/${r.id}`, { method: 'DELETE' });
        if (editingRoom === r.id) resetRoomForm();
        toast(`“${r.name}” deleted`);
      } else return;
      e.target.blur();
      await loadRooms();
    } catch (err) { toast(err.message); }
  });
  $('roomForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('roomFormErr').textContent = '';
    const body = { name: $('rfName').value, desc: $('rfDesc').value, password: $('rfPw').value, chat: $('rfChat').checked };
    try {
      if (editingRoom) {
        if ($('rfRemovePw').checked) body.removePassword = true;
        await api(`/rooms/${editingRoom}`, { method: 'PATCH', body });
        toast('Room updated');
      } else {
        await api('/rooms', { method: 'POST', body });
        toast(`Room “${body.name.trim()}” created`);
      }
      resetRoomForm();
      await loadRooms();
    } catch (err) { $('roomFormErr').textContent = err.message; }
  });

  async function loadRoom() {
    const [d] = await Promise.all([api('/room'), loadRooms()]);
    const q = $('roomSearch').value.trim().toLowerCase();
    const flaggedOnly = $('roomFlagged').checked;
    const only = $('roomFilter').value;
    const box = $('roomLog');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const rows = d.msgs.filter(m => (!only || m.r === only) && (!flaggedOnly || m.blocked || m.o) && (!q || m.name.toLowerCase().includes(q) || m.x.toLowerCase().includes(q) || (m.o || '').toLowerCase().includes(q)));
    box.innerHTML = rows.length ? rows.map(m => `
      <div class="rl${m.blocked ? ' blocked' : ''}">
        <time>${clock(m.ts)}${!only && m.rn ? `<span class="rn">#${esc(m.rn)}</span>` : ''}</time>
        <a class="who" href="#convos" data-user="${m.f}" data-name="${esc(m.name)}" style="color:inherit;text-decoration:none" title="View ${esc(m.name)}'s private chats"><i class="dot ${m.g}"></i>${esc(m.name)}</a>
        <span class="txt">${esc(m.x)}${m.o ? `<span class="orig">Original: ${esc(m.o)}</span>` : ''}</span>
        <span>${m.blocked ? '<span class="tag block">Blocked</span>' : m.o ? '<span class="tag mask">Masked</span>' : ''}
          <button class="btn sm ghost" data-kick="${m.f}" data-name="${esc(m.name)}">Kick</button></span>
      </div>`).join('') : '<div class="empty">No messages</div>';
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  $('roomSearch').addEventListener('input', () => refresh());
  $('roomFilter').addEventListener('change', () => refresh());
  $('roomFlagged').addEventListener('change', () => refresh());
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-user]');
    if (!a) return;
    e.preventDefault();
    convoUser = { id: +a.dataset.user, name: a.dataset.name };
    selectedConvo = null;
    $('transcript').innerHTML = '<div class="empty">Select a conversation to read it.</div>';
    if (location.hash === '#convos') refresh(); else location.hash = 'convos';
  });

  // ================= Users =================
  $('userCountry').insertAdjacentHTML('beforeend', COUNTRY_CODES.map(cc => [cc, cname(cc)]).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join(''));
  async function loadUsers() {
    const qs = new URLSearchParams({ q: $('userSearch').value.trim(), cc: $('userCountry').value, g: $('userGender').value });
    const d = await api('/users?' + qs);
    $('usersCount').textContent = `${fmt(d.total)} matching${d.total > d.users.length ? ` · showing newest ${d.users.length}` : ''}`;
    const now = Date.now();
    $('userTable').tBodies[0].innerHTML = d.users.length ? d.users.map(u => `<tr>
      <td><span class="who"><i class="dot ${u.g}"></i>${esc(u.name)}${u.reg ? ' ✓' : ''} <span class="muted">${u.age}</span></span></td>
      <td><span class="cty">${flag(u.cc)}${esc([u.loc, cname(u.cc)].filter(Boolean).join(', '))}</span></td>
      <td class="muted"><span class="cty">${u.ipcc ? `<span data-tip="IP location: ${esc(cname(u.ipcc))}">${flag(u.ipcc)}</span>` : ''}${esc(u.ip)}${u.ipcc && u.ipcc !== u.cc ? ' <span class="tag mask" data-tip="Chosen country differs from IP location">≠ IP</span>' : ''}</span></td>
      <td class="num">${dur(now - u.joined)}</td>
      <td class="num">${fmt(u.msgs)}</td>
      <td class="num">${u.convos ? `<a href="#convos" data-user="${u.id}" data-name="${esc(u.name)}">${u.convos}</a>` : 0}</td>
      <td class="num">${u.muted ? '<span class="tag block">Muted</span> ' : ''}${u.strikes || 0}</td>
      <td class="actions"><button class="btn sm ghost" data-kick="${u.id}" data-name="${esc(u.name)}">Kick</button><button class="btn sm outline-danger" data-ban="${u.id}" data-name="${esc(u.name)}">Ban</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">No users match</td></tr>';
  }
  let userQ;
  $('userSearch').addEventListener('input', () => { clearTimeout(userQ); userQ = setTimeout(() => refresh(), 250); });
  $('userCountry').addEventListener('change', () => refresh());
  $('userGender').addEventListener('change', () => refresh());

  // ================= Accounts =================
  async function loadAccounts() {
    if ($('acctTable').contains(document.activeElement)) return; // don't redraw under the cursor
    const d = await api('/accounts?' + new URLSearchParams({ q: $('acctSearch').value.trim() }));
    $('navAccounts').textContent = fmt(d.total);
    $('acctCount').textContent = `${fmt(d.total)} registered profile${d.total === 1 ? '' : 's'}`;
    $('acctTable').tBodies[0].innerHTML = d.accounts.length ? d.accounts.map(a => `<tr data-key="${esc(a.key)}">
      <td><span class="who">${a.photoV ? `<img class="acct-ph" src="/avatar/${encodeURIComponent(a.name)}?v=${esc(a.photoV)}" alt="">` : `<i class="dot ${a.g}"></i>`}${esc(a.name)} ✓
        ${a.online ? '<span class="tag" style="background:#e7f6ea;color:#1b7a2f">online</span>' : ''}</span></td>
      <td class="muted">${a.age} · ${esc([a.loc, cname(a.cc)].filter(Boolean).join(', '))}</td>
      <td style="max-width:280px">${a.bio ? esc(a.bio) : '<span class="muted">—</span>'}</td>
      <td class="muted">${dtFmt.format(a.created)}</td>
      <td class="muted">${dtFmt.format(a.lastLogin)}</td>
      <td class="actions">${a.photoV ? '<button class="btn sm ghost" data-act="photo">Remove photo</button>' : ''}${a.bio ? '<button class="btn sm ghost" data-act="bio">Clear bio</button>' : ''}<button class="btn sm outline-danger" data-act="delete">Delete</button></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">${d.total ? 'No accounts match' : 'No registered profiles yet'}</td></tr>`;
  }
  let acctQ;
  $('acctSearch').addEventListener('input', () => { clearTimeout(acctQ); acctQ = setTimeout(() => refresh(), 250); });
  $('acctTable').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const key = b.closest('tr').dataset.key, act = b.dataset.act;
    const msg = { photo: `Remove ${key}'s profile photo?`, bio: `Clear ${key}'s bio?`, delete: `Delete the account “${key}”? Their profile is removed and, if online, they are taken out of the chat.` }[act];
    if (!confirm(msg)) return;
    try { await api(`/accounts/${key}/${act}`, { method: 'POST' }); toast('Done'); b.blur(); loadAccounts(); } catch (err) { toast(err.message); }
  });

  // ================= Word filter =================
  let rules = [];
  async function loadFilter(entering) {
    // don't redraw under the admin's cursor while they're editing a row
    if (!entering && $('ruleTable').contains(document.activeElement)) return;
    rules = (await api('/filters')).rules;
    renderRules();
  }
  function renderRules() {
    const q = $('ruleSearch').value.trim().toLowerCase();
    const list = rules.filter(r => !q || r.word.toLowerCase().includes(q)).sort((a, b) => b.created - a.created);
    $('ruleCount').textContent = `(${rules.length})`;
    const opt = (v, cur, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    $('ruleTable').tBodies[0].innerHTML = list.length ? list.map(r => `<tr data-id="${r.id}">
      <td><b>${esc(r.word)}</b></td>
      <td><select data-f="match">${opt('word', r.match, 'Whole word')}${opt('contains', r.match, 'Anywhere')}</select></td>
      <td><select data-f="action">${opt('mask', r.action, 'Mask ****')}${opt('block', r.action, 'Block message')}</select></td>
      <td class="num">${fmt(r.hits)}</td>
      <td class="muted">${dtFmt.format(r.created)}</td>
      <td class="actions"><button class="btn sm outline-danger" data-del>Remove</button></td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">${rules.length ? 'No words match' : 'No words yet. Add some above.'}</td></tr>`;
  }
  $('ruleSearch').addEventListener('input', renderRules);
  $('filterForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('filterErr').textContent = '';
    try {
      const r = await api('/filters', { method: 'POST', body: { word: $('fWords').value, match: $('fMatch').value, action: $('fAction').value } });
      $('fWords').value = '';
      toast(`Added ${r.added.length} word${r.added.length === 1 ? '' : 's'}`);
      if (r.errors.length) $('filterErr').textContent = r.errors.join(' · ');
      await loadFilter(true);
      runTest();
    } catch (err) { $('filterErr').textContent = err.message; }
  });
  $('ruleTable').addEventListener('change', async e => {
    const sel = e.target.closest('select[data-f]'); if (!sel) return;
    const id = +sel.closest('tr').dataset.id;
    try { await api('/filters/' + id, { method: 'PATCH', body: { [sel.dataset.f]: sel.value } }); toast('Saved'); sel.blur(); await loadFilter(true); runTest(); }
    catch (err) { toast(err.message); }
  });
  $('ruleTable').addEventListener('click', async e => {
    if (!e.target.closest('[data-del]')) return;
    const tr = e.target.closest('tr');
    const r = rules.find(x => x.id === +tr.dataset.id);
    if (!r || !confirm(`Remove "${r.word}" from the filter?`)) return;
    try { await api('/filters/' + r.id, { method: 'DELETE' }); toast('Removed'); await loadFilter(true); runTest(); }
    catch (err) { toast(err.message); }
  });
  let testT;
  async function runTest() {
    const text = $('testText').value;
    if (!text.trim()) { $('testOut').innerHTML = '<span class="muted">Result appears here</span>'; return; }
    try {
      const r = await api('/filters/test', { method: 'POST', body: { text } });
      $('testOut').innerHTML = r.blocked ? '<span class="tag block">Blocked</span> This message would not be sent.'
        : r.masked ? `<span class="tag mask">Masked</span> ${esc(r.text)}`
        : `<span class="tag" style="background:#e7f6ea;color:#1b7a2f">Allowed</span> ${esc(r.text)}`;
    } catch (err) { $('testOut').textContent = err.message; }
  }
  $('testText').addEventListener('input', () => { clearTimeout(testT); testT = setTimeout(runTest, 200); });

  // ================= Appearance =================
  const THEME_COLORS = [
    ['primary', 'Main color', 'buttons & accents'], ['primary2', 'Main color, dark', 'gradients & shadows'],
    ['bg', 'Page background', ''], ['card', 'Card background', ''], ['text', 'Text', ''], ['muted', 'Secondary text', ''],
  ];
  const TEXT_KEYS = ['brandMain', 'brandAccent', 'tagline', 'description', 'buttonText', 'seoTitle', 'seoDesc', 'siteUrl', 'seoHeading', 'seoText'];
  let themeInfo = null, draft = null, formBuilt = false;

  async function loadAppearance() {
    themeInfo = await api('/theme');
    draft = { ...themeInfo.theme };
    if (!formBuilt) buildAppearanceForm();
    fillAppearanceForm();
    const frame = $('themeFrame');
    if (frame.src === 'about:blank' || !frame.src.startsWith(location.origin)) frame.src = '/';
    else pushPreview();
  }

  function buildAppearanceForm() {
    formBuilt = true;
    $('presets').innerHTML = Object.entries(themeInfo.presets).map(([k, p]) =>
      `<button type="button" class="preset" data-preset="${k}"><i style="background:linear-gradient(135deg,${p.primary},${p.primary2})"></i>${esc(p.label)}</button>`).join('');
    $('colorFields').innerHTML = THEME_COLORS.map(([k, label, hint]) => `<div class="color-row">
        <input type="color" data-c="${k}" aria-label="${label}">
        <span class="cl">${label}${hint ? `<br><span class="muted">${hint}</span>` : ''}</span>
        <input class="hex" data-hex="${k}" maxlength="7" spellcheck="false"></div>`).join('');
    $('presets').addEventListener('click', e => {
      const b = e.target.closest('[data-preset]'); if (!b) return;
      const { label, ...colors } = themeInfo.presets[b.dataset.preset];
      Object.assign(draft, colors, { preset: b.dataset.preset });
      fillAppearanceForm(); pushPreview();
    });
    $('v-appearance').addEventListener('input', e => {
      const t = e.target;
      if (t.dataset.c) { draft[t.dataset.c] = t.value; draft.preset = 'custom'; }
      else if (t.dataset.hex) {
        if (!/^#[0-9a-f]{6}$/i.test(t.value)) return;
        draft[t.dataset.hex] = t.value.toLowerCase(); draft.preset = 'custom';
      } else if (t.dataset.t) draft[t.dataset.t] = t.type === 'checkbox' ? t.checked : t.value;
      else return;
      fillAppearanceForm(t); pushPreview();
    });
    $('v-appearance').addEventListener('change', async e => {
      const inp = e.target.closest('input[type=file][data-slot]'); if (!inp || !inp.files[0]) return;
      const slot = inp.dataset.slot, file = inp.files[0];
      inp.value = '';
      try {
        const data = await shrinkImage(file, slot === 'hero' ? 1600 : 512, slot === 'hero' ? 'image/jpeg' : 'image/png');
        themeInfo = await api('/theme/image', { method: 'POST', body: { slot, data } });
        draft[slot + 'Image'] = themeInfo.theme[slot + 'Image'];
        toast(slot === 'hero' ? 'Corner picture uploaded' : 'Logo uploaded');
        fillAppearanceForm(); pushPreview();
      } catch (err) { toast(err.message); }
    });
    $('v-appearance').addEventListener('click', async e => {
      const r = e.target.closest('[data-reset-img]'); if (!r) return;
      const slot = r.dataset.resetImg;
      try {
        themeInfo = await api('/theme/image/' + slot, { method: 'DELETE' });
        draft[slot + 'Image'] = null;
        toast('Back to the default ' + (slot === 'hero' ? 'skyline' : 'logo'));
        fillAppearanceForm(); pushPreview();
      } catch (err) { toast(err.message); }
    });
    $('themeSave').onclick = async () => {
      const body = { preset: draft.preset };
      for (const [k] of THEME_COLORS) body[k] = draft[k];
      for (const k of TEXT_KEYS) body[k] = draft[k];
      body.showHero = draft.showHero; body.showPattern = draft.showPattern;
      try {
        themeInfo = await api('/theme', { method: 'PUT', body });
        draft = { ...themeInfo.theme };
        fillAppearanceForm(); toast('Saved — visitors now see the new look');
      } catch (err) { toast(err.message); }
    };
    $('themeDiscard').onclick = () => { draft = { ...themeInfo.theme }; fillAppearanceForm(); pushPreview(); };
    $('themeFrame').addEventListener('load', pushPreview);
  }

  function fillAppearanceForm(except) {
    for (const [k] of THEME_COLORS) {
      const c = document.querySelector(`[data-c="${k}"]`), h = document.querySelector(`[data-hex="${k}"]`);
      if (c !== except) c.value = draft[k];
      if (h !== except) h.value = draft[k];
    }
    for (const el of $('v-appearance').querySelectorAll('[data-t]')) {
      if (el === except) continue;
      if (el.type === 'checkbox') el.checked = !!draft[el.dataset.t]; else el.value = draft[el.dataset.t] ?? '';
    }
    for (const b of $('presets').children) b.classList.toggle('on', b.dataset.preset === draft.preset);
    $('presetNote').textContent = draft.preset === 'custom' ? 'Custom colors' : '';
    const assets = themeAssets();
    $('heroThumb').style.backgroundImage = `url("${assets.heroUrl}")`;
    $('logoThumb').innerHTML = assets.logoHtml;
    $('logoThumb').style.setProperty('--primary', draft.primary); $('logoThumb').style.setProperty('--primary-2', draft.primary2);
    $('heroReset').hidden = !draft.heroImage; $('logoReset').hidden = !draft.logoImage;
    // white button text must stay readable on the main color
    const ratio = contrast('#ffffff', draft.primary);
    $('contrastWarn').hidden = ratio >= 3;
    $('contrastWarn').textContent = `The main color is too light for white button text (contrast ${ratio.toFixed(1)}:1, needs 3:1). Pick a darker main color.`;
    const dirty = JSON.stringify(pick(draft)) !== JSON.stringify(pick(themeInfo.theme));
    $('dirtyNote').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    $('themeSave').disabled = !dirty;
  }
  const pick = t => { const o = {}; for (const [k] of THEME_COLORS) o[k] = t[k]; for (const k of TEXT_KEYS) o[k] = t[k]; o.showHero = t.showHero; o.showPattern = t.showPattern; return o; };

  function themeAssets() {
    const t = themeInfo.theme; // images are saved immediately, so the stored theme is the truth
    return {
      heroUrl: t.heroImage ? `/media/hero?v=${t.heroImage.v}` : themeInfo.heroDefault,
      logoHtml: t.logoImage ? `<img src="/media/logo?v=${t.logoImage.v}" alt="">` : themeInfo.defaultLogo,
      heroIsDefault: !t.heroImage,
    };
  }
  function pushPreview() {
    const frame = $('themeFrame');
    if (!draft || !frame.contentWindow || !frame.src.startsWith(location.origin)) return;
    const css = `:root{--primary:${draft.primary};--primary-2:${draft.primary2};--bg:${draft.bg};--card:${draft.card};--text:${draft.text};--muted:${draft.muted}}`;
    frame.contentWindow.postMessage({ type: 'theme-preview', theme: draft, css, ...themeAssets() }, location.origin);
  }

  function luminance(hex) {
    const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

  // Resize big images in the browser before uploading (keeps uploads fast and under the 4 MB limit).
  async function shrinkImage(file, max, type) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Please choose a PNG, JPEG or WebP image');
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return cv.toDataURL(type, 0.86);
  }

  // ================= Anti-spam =================
  const SPAM_LABELS = [
    ['captchaPassed', 'Passed the bot check'], ['captchaFailed', 'Failed the bot check'], ['honeypot', 'Bots caught by hidden trap field'],
    ['links', 'Links blocked'], ['duplicates', 'Repeated messages blocked'], ['newUser', 'New users held back from Main Room'],
    ['massPm', 'Mass private-message attempts'], ['rateLimited', 'Flooding (too fast)'], ['badWords', 'Blocked-word messages'], ['mutedAttempts', 'Messages tried while muted'],
    ['autoMutes', 'Auto-mutes'], ['autoKicks', 'Auto-kicks'],
  ];
  async function loadSpam(entering) {
    const d = await api('/antispam');
    const s = d.stats;
    const bots = s.captchaFailed + s.honeypot;
    const blocked = s.links + s.duplicates + s.massPm + s.rateLimited + s.badWords;
    $('spamTiles').innerHTML = [
      tile('Bots stopped at login', fmt(bots), `${fmt(s.captchaFailed)} failed check · ${fmt(s.honeypot)} trap`),
      tile('Spam messages blocked', fmt(blocked), 'links, repeats, flooding, bad words'),
      tile('Auto-mutes', fmt(s.autoMutes), 'muted for 5 minutes'),
      tile('Auto-kicks', fmt(s.autoKicks), 'kicked + 10 min ban'),
    ].join('');
    $('spamStats').tBodies[0].innerHTML = SPAM_LABELS.map(([k, l]) => `<tr><td>${l}</td><td class="num"><b>${fmt(s[k])}</b></td></tr>`).join('');
    const c = d.captcha;
    $('capMode').innerHTML = c.forcedOff ? '<span class="tag block">Off (CAPTCHA=off)</span>'
      : c.mode === 'off' ? '<span class="tag block">Off</span>'
      : `<span class="tag" style="background:#e7f6ea;color:#1b7a2f">${c.mode === 'turnstile' ? 'Cloudflare Turnstile' : 'Built-in invisible puzzle'}</span>`;
    $('capNote').textContent = c.turnstileConfigured
      ? 'Cloudflare Turnstile keys are set, so Turnstile is used instead of the built-in puzzle.'
      : 'Uses the built-in invisible puzzle. For stronger protection, add free Cloudflare Turnstile keys (see README). IPs that request many puzzles automatically get harder ones.';
    $('powField').hidden = c.turnstileConfigured;
    // only fill the form when opening the page, so polling doesn't overwrite unsaved edits
    if (entering) {
      const f = $('spamForm');
      for (const [k, v] of Object.entries(d.settings)) {
        const el = f.elements[k];
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
      }
    }
  }
  $('spamForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('spamErr').textContent = '';
    const f = e.target;
    const body = {};
    for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    try { await api('/antispam', { method: 'PUT', body }); toast('Anti-spam settings saved'); loadSpam(true); }
    catch (err) { $('spamErr').textContent = err.message; }
  });

  // ================= Bans =================
  async function loadBans() {
    const d = await api('/bans');
    $('banTable').tBodies[0].innerHTML = d.bans.length ? d.bans.slice().reverse().map(b => `<tr>
      <td><b>${esc(b.name)}</b></td>
      <td class="muted">${esc(b.ip || '— (browser only)')}</td>
      <td>${esc(b.reason || '—')}</td>
      <td class="muted">${dtFmt.format(b.created)}</td>
      <td>${b.until ? dtFmt.format(b.until) : '<b>Never</b>'}</td>
      <td class="actions"><button class="btn sm ghost" data-unban="${b.id}" data-name="${esc(b.name)}">Unban</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">No active bans</td></tr>';
  }
  $('banTable').addEventListener('click', async e => {
    const b = e.target.closest('[data-unban]'); if (!b) return;
    if (!confirm(`Unban ${b.dataset.name}?`)) return;
    try { await api('/bans/' + b.dataset.unban, { method: 'DELETE' }); toast('Unbanned'); loadBans(); } catch (err) { toast(err.message); }
  });

  // ---------------- boot ----------------
  api('/overview').then(showShell, () => showLogin());
})();
