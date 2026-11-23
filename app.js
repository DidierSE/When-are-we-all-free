(() => {
  // ====== LIVE SYNC SETUP: paste your Firebase Realtime Database URL between the quotes ======
  // Example: 'https://my-friends-default-rtdb.europe-west1.firebasedatabase.app'
  const FIREBASE_URL = 'https://when-are-we-all-free-2918a-default-rtdb.europe-west1.firebasedatabase.app/';
  // The calendar's secret code comes from the link (...?room=SECRET), never from this file, so a stranger
  // who finds the site sees nothing. Only people you send the full link to can open the calendar.
  let ROOM = '';
  try {
    const q = new URLSearchParams(location.search).get('room');
    if (q) localStorage.setItem('whenfree.room', q);          // remember it on this device
    ROOM = q || localStorage.getItem('whenfree.room') || '';
  } catch (e) { ROOM = new URLSearchParams(location.search).get('room') || ''; }
  // ==========================================================================================

  const CLOUD = !!FIREBASE_URL;
  const KEY = 'whenfree.v2';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad = n => String(n).padStart(2, '0');
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const now = new Date();
  const TODAY = isoOf(now.getFullYear(), now.getMonth(), now.getDate());
  const label = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
  const fmt = ms => new Date(ms).toLocaleString('en-GB', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
  const empty = () => ({m: [], b: [], pw: null});
  const KINDS = ['m', 'b'];
  const ICON = {m: '?', b: '✕'};

  // ---------- state ----------
  let me = '';              // the name picked on this device
  let people = {};          // name -> {f: free days, m: not sure days, b: busy days}
  let hangouts = {};        // id -> {id, title, date, time, place, notes, by, at, editedBy, editedAt}
  let notes = {};           // id -> {id, text, from, to, by, at, editedAt}  (to = last day, same as from for one day)
  let pendingN = {};        // note changes not yet confirmed by the database
  let noteOpen = false, editingNote = null, noteDays = null;   // noteDays = days picked for a multi-day note
  let selMode = false, picked = new Set(), rangeMode = false, anchor = null;   // multi-select
  let pendingH = {};        // hangout changes not yet confirmed by the database (id -> hangout, or null = deleted)
  let loaded = !CLOUD;      // true once the shared calendar has been read
  let dirty = false, pushT = null, ver = 0;
  let mode = 'cal', selected = null, authMode = 'in', authSig = '';
  let formOpen = false, editingId = null;
  let tok = '';             // proof (the password hash) that this device signed in as a protected name
  let hold = false;         // pause database refreshes while a rename / password change is being saved
  let view = {y: now.getFullYear(), m: now.getMonth()};

  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) { me = s.me || ''; tok = s.tok || ''; if (!CLOUD) { people = s.people || {}; hangouts = s.hangouts || {}; notes = s.notes || {}; } }
  } catch (e) {}
  const saveLocal = () => { try { localStorage.setItem(KEY, JSON.stringify({me, tok, people: CLOUD ? {} : people, hangouts: CLOUD ? {} : hangouts, notes: CLOUD ? {} : notes})); } catch (e) {} };

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- custom modal (replaces browser confirm/alert) ----------
  let modalResolve = null;
  function closeModal() {
    $('#modal').classList.remove('show');
    if (modalResolve) { const r = modalResolve; modalResolve = null; r(false); }
  }
  function showModal({title, msg, buttons, input}) {
    return new Promise(resolve => {
      closeModal();
      modalResolve = resolve;
      $('#modalTitle').textContent = title || '';
      $('#modalMsg').textContent = msg || '';
      $('#modalInput').value = '';
      $('#modalInput').classList.toggle('hide', !input);          // password box (used for sign-in)
      const btns = $('#modalBtns');
      btns.innerHTML = '';
      (buttons || [{label: 'OK', value: true, primary: true}]).forEach(b => {
        const el = document.createElement('button');
        el.textContent = b.label;
        if (b.primary) el.className = 'primary';
        if (b.danger) el.className = (el.className ? el.className + ' ' : '') + 'danger';
        el.onclick = () => {
          $('#modal').classList.remove('show');
          modalResolve = null;
          resolve(input && b.value === true ? $('#modalInput').value : b.value);
        };
        btns.appendChild(el);
      });
      $('#modal').classList.add('show');
      if (input) setTimeout(() => $('#modalInput').focus(), 50);
    });
  }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal').classList.contains('show')) closeModal(); });
  $('#modalInput').addEventListener('keydown', e => { if (e.key === 'Enter') { const p = $('#modalBtns .primary'); if (p) p.click(); } });

  // ---------- shared database (Firebase Realtime Database over plain HTTPS) ----------
  const cKey = n => n.replace(/[.$#\[\]\/]/g, '_');
  const cUrl = p => FIREBASE_URL.replace(/\/$/, '') + '/rooms/' + encodeURIComponent(ROOM) + p + '.json';
  const parse = s => s ? String(s).split(',').filter(Boolean) : [];

  function setStatus(ok) {
    const el = $('#status');
    el.textContent = !CLOUD ? '⚠️ Live sync is not set up yet (see README), so changes stay on this device.'
      : ok ? '🟢 Live: everyone\'s changes show up automatically.'
      : '🔴 Can\'t reach the shared calendar right now. Retrying...';
  }
  async function cloudPull() {
    if (hold) return;
    lastPull = Date.now();
    try {
      const r = await fetch(cUrl(''), {cache: 'no-store'});
      if (!r.ok) throw 0;
      const root = (await r.json()) || {};
      const out = {};
      for (const v of Object.values(root.people || {})) {
        if (v && v.n) out[v.n] = {m: parse(v.m), b: parse(v.b), pw: v.h ? {h: v.h, s: v.s || ''} : null};
      }
      const hout = {};
      for (const v of Object.values(root.hangouts || {})) {
        if (v && v.id && v.date) hout[v.id] = {id: v.id, title: v.title || '', date: v.date, time: v.time || '', place: v.place || '',
          notes: v.notes || '', by: v.by || '', at: +v.at || 0, editedBy: v.editedBy || '', editedAt: +v.editedAt || 0};
      }
      for (const [id, h] of Object.entries(pendingH)) { if (h) hout[id] = h; else delete hout[id]; }   // keep my unsent changes
      const nout = {};
      for (const v of Object.values(root.notes || {})) {
        if (v && v.id && v.from && v.text) nout[v.id] = {id: v.id, text: v.text, from: v.from, to: v.to || v.from, by: v.by || '', at: +v.at || 0, editedAt: +v.editedAt || 0};
      }
      for (const [id, n] of Object.entries(pendingN)) { if (n) nout[id] = n; else delete nout[id]; }
      if (dirty && me && people[me]) out[me] = {...people[me], pw: out[me] ? out[me].pw : people[me].pw};   // keep my edits that are still being sent
      if (me && !out[me]) { me = ''; tok = ''; saveLocal(); }   // my name was removed from the group
      else if (me && out[me].pw && out[me].pw.h !== tok) {      // password was set or changed somewhere else
        me = ''; tok = ''; saveLocal(); toast('You were logged out because the password changed. Please log in again.');
      }
      people = out; hangouts = hout; notes = nout; loaded = true; setStatus(true); render();
    } catch (e) { setStatus(false); }
  }
  function cloudPush() {
    if (!CLOUD || !me || !people[me]) return;
    dirty = true; clearTimeout(pushT);
    const v = ++ver;
    pushT = setTimeout(async () => {
      const p = people[me]; if (!p) return;
      const keep = k => p[k].filter(d => d >= TODAY).join(',');
      try {
        // PATCH (not PUT) so the saved password fields are never overwritten by a day update
        const r = await fetch(cUrl('/people/' + encodeURIComponent(cKey(me))), {method: 'PATCH', body: JSON.stringify({n: me, m: keep('m'), b: keep('b')})});
        if (r.ok && v === ver) dirty = false;
        setStatus(r.ok);
      } catch (e) { setStatus(false); }
    }, 400);
  }
  function cloudDelete(name) {
    if (CLOUD) fetch(cUrl('/people/' + encodeURIComponent(cKey(name))), {method: 'DELETE'}).catch(() => {});
  }
  async function hangPut(h) {
    if (!CLOUD) { saveLocal(); return; }
    pendingH[h.id] = h;
    try {
      const r = await fetch(cUrl('/hangouts/' + h.id), {method: 'PUT', body: JSON.stringify(h)});
      if (r.ok && pendingH[h.id] === h) delete pendingH[h.id];
      setStatus(r.ok);
    } catch (e) { setStatus(false); }
  }
  async function hangDel(id) {
    delete hangouts[id];
    if (!CLOUD) { saveLocal(); return; }
    pendingH[id] = null;
    try {
      const r = await fetch(cUrl('/hangouts/' + id), {method: 'DELETE'});
      if (r.ok && pendingH[id] === null) delete pendingH[id];
      setStatus(r.ok);
    } catch (e) { setStatus(false); }
  }
  async function notePut(n) {
    if (!CLOUD) { saveLocal(); return; }
    pendingN[n.id] = n;
    try {
      const r = await fetch(cUrl('/notes/' + n.id), {method: 'PUT', body: JSON.stringify(n)});
      if (r.ok && pendingN[n.id] === n) delete pendingN[n.id];
      setStatus(r.ok);
    } catch (e) { setStatus(false); }
  }
  async function noteDel(id) {
    delete notes[id];
    if (!CLOUD) { saveLocal(); return; }
    pendingN[id] = null;
    try {
      const r = await fetch(cUrl('/notes/' + id), {method: 'DELETE'});
      if (r.ok && pendingN[id] === null) delete pendingN[id];
      setStatus(r.ok);
    } catch (e) { setStatus(false); }
  }
  function retryPending() {
    for (const [id, h] of Object.entries(pendingH)) { if (h) hangPut(h); else hangDel(id); }
    for (const [id, n] of Object.entries(pendingN)) { if (n) notePut(n); else noteDel(id); }
  }
  let pullT = null, stale = false, lastPull = 0;
  function pullSoon() {                           // the database said something changed
    if (document.hidden) { stale = true; return; }   // nobody is looking: refresh when the tab comes back
    clearTimeout(pullT); pullT = setTimeout(cloudPull, 300);
  }
  function cloudStart() {
    cloudPull();
    try {
      const es = new EventSource(cUrl(''));
      let first = true;                            // the first event is just the snapshot we already pulled
      const onEvt = () => { if (first) { first = false; return; } pullSoon(); };
      es.addEventListener('put', onEvt);
      es.addEventListener('patch', onEvt);
    } catch (e) {}
    setInterval(() => { if (!document.hidden) cloudPull(); }, 180000);   // slow safety net only
    setInterval(retryPending, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (stale || Date.now() - lastPull > 60000)) { stale = false; cloudPull(); }
    });
  }
  const persist = () => { saveLocal(); cloudPush(); };

  // ---------- passwords (salted PBKDF2 hash; the password itself is never stored or sent) ----------
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));
  async function hashPw(pw, salt) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000}, key, 256));
  }
  async function checkPw(name, pw) {
    const p = people[name] && people[name].pw; if (!p) return true;
    try { return (await hashPw(pw, p.s)) === p.h; }
    catch (e) { toast('Passwords need a secure (https) page'); return false; }
  }
  async function askPw(title, msg) {
    const v = await showModal({title, msg, input: true, buttons: [{label: 'Cancel', value: false}, {label: 'Continue', value: true, primary: true}]});
    return v || null;
  }
  const cPatch = (name, obj) => fetch(cUrl('/people/' + encodeURIComponent(cKey(name))), {method: 'PATCH', body: JSON.stringify(obj)});

  // ---------- helpers ----------
  function index() {
    const out = {};
    for (const [n, p] of Object.entries(people)) out[n] = {m: new Set(p.m), b: new Set(p.b)};
    return out;
  }
  const stat = (name, iso) => {
    const p = people[name]; if (!p) return null;
    return p.m.includes(iso) ? 'm' : p.b.includes(iso) ? 'b' : null;   // free = nothing marked
  };
    // A day someone left unmarked counts as free for them.
  const isFree = (ix, n, iso) => !ix[n].m.has(iso) && !ix[n].b.has(iso);

  function canEdit() {
    if (!me) { toast('Log in first 👆'); return false; }
    if (!loaded) { toast('Still connecting, try again in a second'); return false; }
    return true;
  }
  function setDay(iso, s) {
    if (iso < TODAY || !canEdit()) return false;
    const p = people[me] || (people[me] = empty());
    for (const k of KINDS) p[k] = p[k].filter(d => d !== iso);
    if (s) p[s].push(iso);
    return true;
  }

  // ---------- pop-up menu (Free / Not sure / Busy / Clear) ----------
  let menuEl = null, menuY = 0;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(anchor, title, current, onPick, extras, onExtra) {
    closeMenu();
    const items = [['f', '✅ Free'], ['m', '❓ Not sure'], ['b', '❌ Busy']];
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `<div class="t">${esc(title)}</div>` + items.map(([k, t]) =>
      `<button data-k="${k}" class="${(k === 'f' ? current === null : current === k) ? 'cur' : ''}">${t}</button>`).join('')
      + (extras || []).map(([k, t]) => `<button data-k="${k}">${t}</button>`).join('');
    m.addEventListener('click', e => {
      const b = e.target.closest('button[data-k]'); if (!b) return;
      const k = b.dataset.k; closeMenu();
      if ((extras || []).some(x => x[0] === k)) { onExtra(k); return; }
      onPick(k === 'f' ? null : k);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    m.style.left = left + 'px'; m.style.top = top + 'px';
    menuEl = m; menuY = window.scrollY;
  }
  document.addEventListener('pointerdown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', () => { if (menuEl && Math.abs(window.scrollY - menuY) > 30) closeMenu(); }, {passive: true});   // ignore tiny layout shifts
  window.addEventListener('resize', closeMenu);

  // ---------- rendering ----------
  // ---------- login / sign-up screen ----------
  function renderAuth() {
    const authed = !!me;
    document.querySelectorAll('.app').forEach(el => el.classList.toggle('hide', !authed));
    $('#authView').classList.toggle('hide', authed);
    $('#whoBar').textContent = me ? `👤 Logged in as ${me}` : '';
    if (authed) return;
    $('#authLoading').classList.toggle('hide', loaded);
    $('#authBox').classList.toggle('hide', !loaded);
    if (!loaded) return;
    const names = Object.keys(people).sort((a, b) => a.localeCompare(b));
    if (!names.length) authMode = 'up';                        // nobody has signed up yet
    $('#authTabIn').classList.toggle('on', authMode === 'in');
    $('#authTabUp').classList.toggle('on', authMode === 'up');
    $('#authTabIn').disabled = !names.length;
    $('#authIn').classList.toggle('hide', authMode !== 'in');
    $('#authUp').classList.toggle('hide', authMode !== 'up');
    const sig = names.map(n => n + (people[n].pw ? '*' : '')).join('|');
    if (sig !== authSig) {                                      // rebuild the list only when it changed
      authSig = sig;
      const cur = $('#liName').value;
      $('#liName').innerHTML = '<option value="" disabled>Select your name</option>'
        + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      $('#liName').value = names.includes(cur) ? cur : '';
    }
    const n = $('#liName').value, legacy = !!(n && people[n] && !people[n].pw);
    $('#liPw').classList.toggle('hide', legacy);
    $('#liClaim').classList.toggle('hide', !legacy);
  }

  function render() {
    const ix = index(), names = Object.keys(ix).sort((a, b) => a.localeCompare(b)), total = names.length;
    const hdays = new Set(Object.values(hangouts).map(h => h.date));
    $('#monthLabel').textContent = new Date(view.y, view.m, 1).toLocaleDateString('en-GB', {month:'long', year:'numeric'});

    const first = new Date(view.y, view.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const dim = new Date(view.y, view.m + 1, 0).getDate();
    let html = '';
    for (let i = 0; i < lead; i++) html += '<div class="day blank"></div>';
    for (let d = 1; d <= dim; d++) {
      const iso = isoOf(view.y, view.m, d);
      const past = iso < TODAY, hang = hdays.has(iso);
      const f = names.filter(n => isFree(ix, n, iso)).length;
      const m = names.filter(n => ix[n].m.has(iso)).length;
      const b = names.filter(n => ix[n].b.has(iso)).length;
      const all = total >= 2 && f === total && !past;
      const cls = ['day'];
      if (past) cls.push('past');
      if (iso === TODAY) cls.push('today');
      if (hang) cls.push('hang');
      if (Object.values(notes).some(n => n.from <= iso && iso <= n.to)) cls.push('hasnote');
      if (all && !hang) cls.push('all');
      if (iso === selected && !selMode) cls.push('sel');
      if (selMode && picked.has(iso)) cls.push('pick');
      if (selMode && iso === anchor) cls.push('anchor');
      let style = '', inner = '';
      // Colour by majority: gold = everyone free, green = more free, red = more busy, purple = hangout
      if (total && !hang && !past) {
        if (all) style = `style="background:color-mix(in srgb,var(--gold) 55%,var(--cell));color:#2b1a00"`;
        else if (f >= b && f > 0) {
          const pct = Math.round(20 + (f / total) * 70);
          style = `style="background:color-mix(in srgb,var(--free) ${pct}%,var(--cell));${f / total > .5 ? 'color:#06260f' : ''}"`;
        } else if (b > f) {
          const pct = Math.round(20 + (b / total) * 70);
          style = `style="background:color-mix(in srgb,var(--busy) ${pct}%,var(--cell));${b / total > .5 ? 'color:#3a0707' : ''}"`;
        }
      }
      const topIcon = hang ? '<span class="hg">🎉</span>' : all ? '<span class="star">⭐</span>' : '';
      const my = me && !past ? stat(me, iso) : null;                     // your own mark
      const mid = my ? `<span class="mine m-${my}">${ICON[my]}</span>` : '';
      const side = [m ? '?' + m : '', b && !hang ? '✕' + b : ''].filter(Boolean).join(' ');
      const cnt = total && !past ? `<span class="count">${f}/${total}</span>` : '';
      html += `<div class="${cls.join(' ')}" data-iso="${iso}" ${style}><div class="dtop"><span class="dn">${d}</span>${topIcon}</div><div class="dmid">${mid}<span class="qm">${side}</span></div><div class="dbot">${cnt}</div></div>`;
    }
    $('#grid').innerHTML = html;

    $('#calView').classList.toggle('hide', mode !== 'cal');
    $('#hangView').classList.toggle('hide', mode !== 'hangouts');
    $('#profView').classList.toggle('hide', mode !== 'profile');
    $('#tabCal').classList.toggle('on', mode === 'cal');
    $('#tabHang').classList.toggle('on', mode === 'hangouts');
    $('#tabProf').classList.toggle('on', mode === 'profile');
    $('#hangForm').classList.toggle('hide', !formOpen);
    renderDetail(ix, names);
    renderNotes();
    renderHangouts(ix, names);
    renderNextHang();
    renderBest(ix, names);
    renderPeople(ix, names);
    renderProfile();
    renderAuth();
    renderSel();
  }

  function renderProfile() {
    if (mode !== 'profile') return;
    const p = me && people[me];
    $('#profMain').classList.toggle('hide', !p);
    $('#profNone').classList.toggle('hide', !!p);
    if (!p) return;
    $('#profWho').textContent = `Signed in as ${me}`;
    $('#pfPwState').textContent = p.pw ? '🔒 This name is protected by a password.' : '🔓 No password yet. Anyone could log in as you, so set one below.';
    $('#pfCur').classList.toggle('hide', !p.pw);
    $('#pfRmPw').classList.toggle('hide', !p.pw);
    $('#pfSetPw').textContent = p.pw ? 'Change password' : 'Set password';
  }

  const chipOf = (ix, n, k, iso) => `<span class="n ${k}">${esc(n)}</span>`;
  function whoFree(ix, names, iso) {
    const groups = {f: names.filter(n => isFree(ix, n, iso)), m: names.filter(n => ix[n].m.has(iso)), b: names.filter(n => ix[n].b.has(iso))};
    const parts = [];
    for (const [k, t] of [['f', '✅'], ['m', '❓'], ['b', '❌']]) {
      if (groups[k].length) parts.push(`${t} ${groups[k].map(n => chipOf(ix, n, k, iso)).join('')}`);
    }
    return parts.join(' ');
  }

  const noteHtml = n => `<div class="note">
      <div>📝 <b>${esc(n.by || 'someone')}</b> · ${n.from === n.to ? label(n.from) : `${label(n.from)} → ${label(n.to)}`}</div>
      <div class="ntext">${esc(n.text)}</div>
      ${n.at || n.editedAt ? `<div class="muted nmeta">${n.at ? 'Added ' + fmt(n.at) : ''}${n.at && n.editedAt ? ' · ' : ''}${n.editedAt ? 'edited ' + fmt(n.editedAt) : ''}</div>` : ''}
      ${n.by === me ? `<div class="nbtns"><button class="small" data-nedit="${esc(n.id)}">✏️ Edit</button><button class="small" data-ndel="${esc(n.id)}">🗑 Delete</button></div>` : ''}
    </div>`;
  const noteSort = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.at - b.at);

  function renderDetail(ix, names) {
    const el = $('#detail');
    if (!selected) { el.innerHTML = '<span class="muted">Tap a day to set your status, add a note or plan a hangout. Who is free shows up here.</span>'; return; }
    let html = `<div class="dhead"><b>${label(selected)}</b><button class="small" data-desel="1" title="Deselect this day">✕ Deselect</button></div>`;
    for (const [k, title] of [['f', '✅ Free'], ['m', '❓ Not sure'], ['b', '❌ Busy']]) {
      const list = k === 'f' ? names.filter(n => isFree(ix, n, selected)) : names.filter(n => ix[n][k].has(selected));
      if (list.length) html += `<div class="g">${title}: ${list.map(n => chipOf(ix, n, k, selected)).join('')}</div>`;
    }
    const everyone = names.length >= 2 && names.every(n => isFree(ix, n, selected));
    const here = Object.values(hangouts).filter(h => h.date === selected);
    if (everyone && selected >= TODAY && !here.length) html += '<div class="g">⭐ Everyone is free this day! Tap the day to plan a hangout.</div>';
    for (const h of here) html += `<div class="g">🎉 <b>${esc(h.title)}</b> is planned this day</div>`;
    const dayNotes = Object.values(notes).filter(n => n.from <= selected && selected <= n.to).sort(noteSort);
    html += dayNotes.map(noteHtml).join('');
    el.innerHTML = html;
  }

  function renderNotes() {
    $('#noteForm').classList.toggle('hide', !noteOpen);
    const up = Object.values(notes).filter(n => n.to >= TODAY).sort(noteSort);
    $('#notesSum').textContent = `📝 All notes (${up.length})`;
    $('#notesList').innerHTML = up.length ? up.map(noteHtml).join('') : '<p class="muted" style="margin:8px 0 0">No notes yet. Tap a day and choose Add note.</p>';
  }

  function renderHangouts(ix, names) {
    const el = $('#hangList');
    const list = Object.values(hangouts);
    const key = h => h.date + ' ' + (h.time || '');
    const up = list.filter(h => h.date >= TODAY).sort((a, b) => key(a) < key(b) ? -1 : 1);
    const past = list.filter(h => h.date < TODAY).sort((a, b) => key(a) < key(b) ? 1 : -1);
    const rel = iso => {
      const n = Math.round((new Date(iso + 'T00:00:00') - new Date(TODAY + 'T00:00:00')) / 864e5);
      return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 ? `in ${n} days` : '';
    };
    const mine = h => {   // your own status for that day, editable right on the card
      const cur = stat(me, h.date);
      return `<div class="hmine"><span>Your status:</span>` + [['f', '✅ Free'], ['m', '❓ Not sure'], ['b', '❌ Busy']].map(([k, t]) =>
        `<button class="small ${(k === 'f' ? cur === null : cur === k) ? 'cur' : ''}" data-hset="${k}" data-date="${h.date}">${t}</button>`).join('') + `</div>`;
    };
    const hnotes = h => {   // notes that cover this hangout's day + a quick "add note" box
      const list = Object.values(notes).filter(n => n.from <= h.date && h.date <= n.to).sort(noteSort);
      return `<div class="hnoteSec">${list.map(noteHtml).join('')}`
        + (me ? `<div class="hnoteAdd"><input type="text" class="hnoteIn" data-date="${h.date}" maxlength="200" placeholder="📝 Add a personal note for this day..."><button class="small primary" data-hnadd="${h.date}">Add</button></div>` : '') + `</div>`;
    };
    const card = (h, isPast) => `<div class="hcard ${isPast ? 'past' : ''}" data-hgo="${h.date}" title="Tap to show this day in the calendar">
        <div class="hhead">
          <div class="hdate">📅 ${label(h.date)}${h.time ? ' · ' + esc(h.time) : ''}${isPast ? '' : `<span class="rel">${rel(h.date)}</span>`}</div>
          <div class="hbtns"><button class="small" data-hedit="${esc(h.id)}">✏️ Edit</button><button class="small" data-hdel="${esc(h.id)}">🗑 Delete</button></div>
        </div>
        <div class="htitle">${esc(h.title)}</div>
        ${h.place ? `<div class="hmeta">📍 ${esc(h.place)}</div>` : ''}
        ${h.notes ? `<div class="hnotes">${esc(h.notes)}</div>` : ''}
        ${isPast ? '' : `<div class="hwho">Availability that day: ${whoFree(ix, names, h.date) || 'nobody has answered yet'}</div>${me ? mine(h) : ''}`}
        ${isPast ? '' : hnotes(h)}
        <div class="hgo">📅 Tap the card to see this day in the calendar</div>
        <div class="hauthor">✍️ Written by <b>${esc(h.by || 'someone')}</b>${h.at ? ' · ' + fmt(h.at) : ''}`
        + (h.editedAt ? `<br>✏️ Last edited by <b>${esc(h.editedBy || 'someone')}</b> · ${fmt(h.editedAt)}` : '') + `</div>
      </div>`;
    let html = up.length ? up.map(h => card(h, false)).join('')
      : '<p class="muted">No hangouts planned yet. When you\'ve agreed on a day, add it here with ➕ New hangout.</p>';
    if (past.length) html += `<details class="pastbox"><summary>Past hangouts (${past.length})</summary>${past.map(h => card(h, true)).join('')}</details>`;
    const typed = {}; el.querySelectorAll('.hnoteIn').forEach(i => { if (i.value) typed[i.dataset.date] = i.value; });
    const focus = document.activeElement && document.activeElement.classList.contains('hnoteIn') ? document.activeElement.dataset.date : null;
    el.innerHTML = html;                                       // typing in a note box survives live updates
    el.querySelectorAll('.hnoteIn').forEach(i => { if (typed[i.dataset.date]) i.value = typed[i.dataset.date]; if (focus === i.dataset.date) i.focus(); });
  }

  function renderNextHang() {   // "Next hangout in N days" banner on the calendar tab (worked out on the device, no extra Firebase traffic)
    const el = $('#nextHang');
    const next = Object.values(hangouts).filter(h => h.date >= TODAY).sort((a, b) => (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1)[0];
    if (!next) { el.classList.add('hide'); el.innerHTML = ''; return; }
    const n = Math.round((new Date(next.date + 'T00:00:00') - new Date(TODAY + 'T00:00:00')) / 864e5);
    const when = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `in ${n} days`;
    el.dataset.date = next.date;
    el.innerHTML = `<span class="nhwhen">🎉 Next hangout${n > 1 ? ' ' + when : ': ' + when}</span><span class="nhtitle">${esc(next.title)} · ${label(next.date)}${next.time ? ' · ' + esc(next.time) : ''}</span>`;
    el.classList.remove('hide');
  }
  $('#nextHang').addEventListener('click', () => {
    const iso = $('#nextHang').dataset.date; if (!iso) return;
    const [y, m] = iso.split('-').map(Number);
    view = {y, m: m - 1}; selected = iso; render();
    $('#grid').scrollIntoView({behavior: 'smooth', block: 'center'});
  });

  function renderBest(ix, names) {
    const total = names.length, el = $('#best');
    if (!total) { el.innerHTML = '<span class="muted">Add your name and mark your days to get started.</span>'; return; }
    const rows = [];
    for (let i = 0; i < 365; i++) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const iso = isoOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const f = names.filter(n => isFree(ix, n, iso)).length;
      const m = names.filter(n => ix[n].m.has(iso)).length;
      if (f || m) rows.push({iso, f, m});
    }
    if (!rows.length) { el.innerHTML = '<span class="muted">Nobody has marked any days yet.</span>'; return; }
    const chip = (r, cls) => `<span class="chip ${cls}" data-jump="${r.iso}"><b>${label(r.iso)}</b> ${r.f}/${total}${r.m ? ' · ❓' + r.m : ''}</span>`;
    const block = (title, list, cls) => `<div class="blk"><div class="lbl">${title}</div><div class="chips">${list.slice(0, 12).map(r => chip(r, cls)).join('')}</div></div>`;
    let html = '';
    if (total >= 2) {
      const all = rows.filter(r => r.f === total);
      const maybe = rows.filter(r => r.f < total && r.f + r.m === total);
      if (all.length) html += block('⭐ Everyone is free', all, 'best');
      if (maybe.length) html += block('❓ Could work if the "not sure" people say yes', maybe, 'good');
      if (!html) {
        const top = rows.filter(r => r.f > 0).sort((a, b) => b.f - a.f || b.m - a.m || (a.iso < b.iso ? -1 : 1));
        html = top.length ? block('Closest matches so far', top, 'good') : '<span class="muted">Nobody has marked a free day yet.</span>';
      }
    } else {
      const mine = rows.filter(r => r.f > 0);
      html = mine.length ? block('Your free days', mine, 'good') : '<span class="muted">Mark some free days to get started.</span>';
    }
    el.innerHTML = html;
  }

  function renderPeople(ix, names) {
    const el = $('#people');
    if (!names.length) { el.innerHTML = '<span class="muted">Nobody yet.</span>'; return; }
    el.innerHTML = names.map(n =>
      `<span class="chip"><b>${esc(n)}${n === me ? ' (you)' : ''}</b>${people[n] && people[n].pw ? '<span class="muted">🔒</span>' : ''}<button data-rm="${esc(n)}" title="Remove">✕</button></span>`).join('');
  }

  // ---------- tapping a day ----------
  $('#grid').addEventListener('click', e => {
    const el = e.target.closest('.day[data-iso]'); if (!el) return;
    const iso = el.dataset.iso;
    if (selMode) {                                              // multi-select: taps pick days, no menu
      if (iso < TODAY) return;
      if (rangeMode) {
        if (!anchor) { anchor = iso; picked.add(iso); }
        else { isoBetween(anchor, iso).filter(x => x >= TODAY).forEach(x => picked.add(x)); anchor = null; }
      } else if (picked.has(iso)) picked.delete(iso); else picked.add(iso);
      selected = iso; render(); return;
    }
    if (iso === selected) { selected = null; render(); return; }   // tap the selected day again = deselect
    selected = iso; render();
    if (iso < TODAY || !canEdit()) return;                      // past days: just look
    const cellNow = [...d_grid().querySelectorAll('.day[data-iso]')].find(x => x.dataset.iso === iso) || el;
    const ix = index(), names = Object.keys(ix);
    const free = names.filter(n => isFree(ix, n, iso)).length;
    openMenu(cellNow, `${label(iso)}${names.length ? ` · ${free}/${names.length} free` : ''}`, stat(me, iso),
      st => { if (setDay(iso, st)) { persist(); render(); } },
      [['note', '📝 Add note'], ['hang', '🎉 Plan hangout']],
      k => { if (k === 'note') openNoteForm(null, iso); else openHangForm(null, iso); });
  });
  const d_grid = () => $('#grid');
  $('#detail').addEventListener('click', e => { if (e.target.closest('[data-desel]')) { selected = null; render(); } });

  // ---------- hangouts ----------
  function openHangForm(h, date) {
    if (!canEdit()) return;
    editingId = h ? h.id : null;
    $('#hfTitle').textContent = h ? 'Edit hangout' : 'New hangout';
    $('#hfWhat').value = h ? h.title : '';
    $('#hfDate').value = h ? h.date : (date || '');
    $('#hfTime').value = h ? h.time : '';
    $('#hfWhere').value = h ? h.place : '';
    $('#hfNotes').value = h ? h.notes : '';
    formOpen = true; mode = 'hangouts'; render();
    $('#hangForm').scrollIntoView({behavior: 'smooth', block: 'center'});
    $('#hfWhat').focus();
  }
  $('#newHang').onclick = () => openHangForm(null, selected && selected >= TODAY ? selected : '');
  $('#hfCancel').onclick = () => { formOpen = false; editingId = null; render(); };
  $('#hfSave').onclick = () => {
    if (!canEdit()) return;
    const title = $('#hfWhat').value.trim(), date = $('#hfDate').value;
    if (!title) { toast('Write what the hangout is 👆'); $('#hfWhat').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Pick a date'); return; }
    const f = {title, date, time: $('#hfTime').value, place: $('#hfWhere').value.trim(), notes: $('#hfNotes').value.trim()};
    const t = Date.now();
    let h, msg;
    if (editingId && hangouts[editingId]) {
      const old = hangouts[editingId];
      if (['title', 'date', 'time', 'place', 'notes'].every(k => old[k] === f[k])) { formOpen = false; editingId = null; render(); toast('No changes made'); return; }
      h = {...old, ...f, editedBy: me, editedAt: t}; msg = 'Hangout updated ✏️';
    } else {
      h = {id: t.toString(36) + Math.random().toString(36).slice(2, 6), ...f, by: me, at: t, editedBy: '', editedAt: 0}; msg = 'Hangout added 🎉';
    }
    hangouts[h.id] = h; hangPut(h);
    formOpen = false; editingId = null; render(); toast(msg);
  };
  const addHangNote = date => {   // quick note on a hangout's day, written right on its card
    if (!canEdit()) return;
    const inp = [...document.querySelectorAll('#hangList .hnoteIn')].find(i => i.dataset.date === date);
    const text = inp ? inp.value.trim() : '';
    if (!text) { toast('Write your note first 👆'); if (inp) inp.focus(); return; }
    const t = Date.now();
    const n = {id: t.toString(36) + Math.random().toString(36).slice(2, 6), text, from: date, to: date, by: me, at: t, editedAt: 0};
    notes[n.id] = n; notePut(n);
    inp.value = ''; render(); toast('Note added 📝');
  };
  $('#hangList').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('hnoteIn')) { e.preventDefault(); addHangNote(e.target.dataset.date); } });
  $('#hangList').addEventListener('click', async e => {
    if (await noteClick(e)) return;
    const add = e.target.closest('[data-hnadd]');
    if (add) { addHangNote(add.dataset.hnadd); return; }
    const st = e.target.closest('[data-hset]');
    if (st) {   // change your own status for the hangout's day
      const k = st.dataset.hset;
      if (setDay(st.dataset.date, k === 'f' ? null : k)) { persist(); render(); toast('Status updated'); }
      return;
    }
    const ed = e.target.closest('[data-hedit]');
    if (ed) { const h = hangouts[ed.dataset.hedit]; if (h) openHangForm(h); return; }
    const del = e.target.closest('[data-hdel]');
    if (del) {
      const h = hangouts[del.dataset.hdel]; if (!h || !canEdit()) return;
      const ok = await showModal({
        title: 'Delete hangout?',
        msg: `Delete "${h.title}" for everyone? This can't be undone.`,
        buttons: [
          {label: 'Cancel', value: false},
          {label: 'Delete', value: true, danger: true}
        ]
      });
      if (ok) { hangDel(h.id); render(); toast('Hangout deleted'); }
      return;
    }
    const go = e.target.closest('[data-hgo]');   // tapping the card itself jumps to its date in the calendar
    if (go && !e.target.closest('button, input, .note')) {
      const iso = go.dataset.hgo, [y, m] = iso.split('-').map(Number);
      view = {y, m: m - 1}; selected = iso; mode = 'cal'; closeMenu(); render();
      $('#grid').scrollIntoView({behavior: 'smooth', block: 'center'});
    }
  });
  // ---------- multi-select ----------
  const addDay = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoOf(d.getFullYear(), d.getMonth(), d.getDate()); };
  const isoBetween = (a, b) => { if (a > b) [a, b] = [b, a]; const out = []; for (let x = a; x <= b; x = addDay(x, 1)) out.push(x); return out; };
  const monthDays = () => { const dim = new Date(view.y, view.m + 1, 0).getDate(); return Array.from({length: dim}, (_, i) => isoOf(view.y, view.m, i + 1)).filter(x => x >= TODAY); };
  function exitSelect() { selMode = false; picked.clear(); rangeMode = false; anchor = null; }
  function renderSel() {
    const on = selMode && mode === 'cal' && !noteOpen;
    $('#selBar').classList.toggle('hide', !on);
    document.body.classList.toggle('selecting', on);
    $('#selToggle').classList.toggle('on', selMode);
    $('#selToggle').textContent = selMode ? '✕ Stop selecting' : '☑️ Select days';
    $('#selRange').classList.toggle('on', rangeMode);
    $('#selCount').textContent = rangeMode ? (anchor ? 'Now tap the last day' : 'Tap the first day') : `${picked.size} selected`;
  }
  function applySel(st) {
    if (!picked.size) { toast('Tap some days first 👆'); return; }
    if (!canEdit()) return;
    const n = picked.size;
    [...picked].forEach(iso => setDay(iso, st));
    persist(); exitSelect(); render();
    toast(`${n} day${n > 1 ? 's' : ''} marked ${st === null ? 'free' : st === 'm' ? 'not sure' : 'busy'}`);
  }
  $('#selToggle').onclick = () => { if (selMode) exitSelect(); else { selMode = true; closeMenu(); } render(); };
  $('#selCancel').onclick = () => { exitSelect(); render(); };
  $('#selRange').onclick = () => { rangeMode = !rangeMode; anchor = null; render(); };
  $('#selWk').onclick = () => { monthDays().filter(x => [0, 6].includes(new Date(x + 'T00:00:00').getDay())).forEach(x => picked.add(x)); render(); };
  $('#selAll').onclick = () => { monthDays().forEach(x => picked.add(x)); render(); };
  $('#selNone').onclick = () => { picked.clear(); anchor = null; render(); };
  $('#selBar').addEventListener('click', e => {
    const b = e.target.closest('[data-selact]'); if (!b) return;
    const k = b.dataset.selact;
    if (k === 'note') openNoteFormMulti(); else applySel(k === 'f' ? null : k);
  });

  // ---------- notes ----------
  function openNoteFormMulti() {
    if (!picked.size) { toast('Tap some days first 👆'); return; }
    if (!canEdit()) return;
    noteDays = [...picked].sort(); editingNote = null;
    $('#nfTitle').textContent = `Add a note to ${noteDays.length} day${noteDays.length > 1 ? 's' : ''}`;
    $('#nfText').value = ''; $('#nfDates').classList.add('hide');
    noteOpen = true; render();
    $('#noteForm').scrollIntoView({behavior: 'smooth', block: 'center'});
    $('#nfText').focus();
  }
  function openNoteForm(n, date) {
    if (!canEdit()) return;
    editingNote = n ? n.id : null; noteDays = null; $('#nfDates').classList.remove('hide');
    $('#nfTitle').textContent = n ? 'Edit note' : 'Add a note';
    $('#nfText').value = n ? n.text : '';
    $('#nfFrom').value = n ? n.from : (date || '');
    $('#nfTo').value = n && n.to !== n.from ? n.to : '';
    noteOpen = true; mode = 'cal'; render();
    $('#noteForm').scrollIntoView({behavior: 'smooth', block: 'center'});
    $('#nfText').focus();
  }
  $('#nfCancel').onclick = () => { noteOpen = false; editingNote = null; noteDays = null; render(); };   // a multi-select stays as it was
  $('#nfSave').onclick = () => {
    if (!canEdit()) return;
    if (noteDays) {                                             // one note per run of consecutive days
      const text = $('#nfText').value.trim();
      if (!text) { toast('Write your note first 👆'); $('#nfText').focus(); return; }
      const runs = []; noteDays.forEach(x => { const last = runs.at(-1); if (last && addDay(last.at(-1), 1) === x) last.push(x); else runs.push([x]); });
      const t = Date.now();
      runs.forEach((r, i) => {
        const n = {id: (t + i).toString(36) + Math.random().toString(36).slice(2, 6), text, from: r[0], to: r.at(-1), by: me, at: t + i, editedAt: 0};
        notes[n.id] = n; notePut(n);
      });
      const first = noteDays[0], count = noteDays.length;
      selected = first; view = {y: +first.slice(0, 4), m: +first.slice(5, 7) - 1};
      noteDays = null; noteOpen = false; exitSelect(); render();
      toast(`Note added to ${count} day${count > 1 ? 's' : ''} 📝`);
      return;
    }
    const text = $('#nfText').value.trim(), from = $('#nfFrom').value;
    let to = $('#nfTo').value || from;
    if (!text) { toast('Write your note first 👆'); $('#nfText').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { toast('Pick the date the note starts'); return; }
    if (to < from) { toast("The end date can't be before the start date"); return; }
    if ((new Date(to) - new Date(from)) / 864e5 > 366) { toast('A note can cover at most a year'); return; }
    const t = Date.now();
    let n;
    if (editingNote && notes[editingNote]) {
      const old = notes[editingNote];
      if (old.by !== me) { toast('You can only edit your own notes'); return; }
      if (old.text === text && old.from === from && old.to === to) { noteOpen = false; editingNote = null; render(); toast('No changes made'); return; }
      n = {...old, text, from, to, editedAt: t};
    } else {
      n = {id: t.toString(36) + Math.random().toString(36).slice(2, 6), text, from, to, by: me, at: t, editedAt: 0};
    }
    notes[n.id] = n; notePut(n);
    selected = from; view = {y: +from.slice(0, 4), m: +from.slice(5, 7) - 1};
    noteOpen = false; editingNote = null; render(); toast('Note saved 📝');
  };
  const noteClick = async e => {   // Edit / Delete buttons on a note (calendar and hangout cards)
    const ed = e.target.closest('[data-nedit]');
    if (ed) { const n = notes[ed.dataset.nedit]; if (n && n.by === me) openNoteForm(n); return true; }
    const del = e.target.closest('[data-ndel]');
    if (del) {
      const n = notes[del.dataset.ndel]; if (!n || n.by !== me) return true;
      const ok = await showModal({title: 'Delete note?', msg: `Delete this note for everyone? "${n.text.slice(0, 60)}"`,
        buttons: [{label: 'Cancel', value: false}, {label: 'Delete', value: true, danger: true}]});
      if (ok) { noteDel(n.id); render(); toast('Note deleted'); }
      return true;
    }
    return false;
  };
  $('#calView').addEventListener('click', noteClick);

  // ---------- controls ----------
  $('#tabCal').onclick = () => { mode = 'cal'; closeMenu(); render(); };
  $('#tabHang').onclick = () => { exitSelect(); mode = 'hangouts'; closeMenu(); render(); };
  $('#tabProf').onclick = () => { exitSelect(); mode = 'profile'; closeMenu(); $('#pfName').value = me; render(); };

  // ---------- profile: rename, password, sign out ----------
  $('#pfRename').onclick = async () => {
    if (!canEdit()) return;
    const nn = $('#pfName').value.trim().slice(0, 30), old = me;
    if (!nn) { toast('Type a new name first'); return; }
    if (nn === old) { toast('That is already your name'); return; }
    const clash = Object.keys(people).some(n => n !== old && cKey(n).toLowerCase() === cKey(nn).toLowerCase());
    if (clash) { toast('Someone in the group already has that name'); return; }
    hold = true;
    try {
      const rec = people[old];
      if (CLOUD) {
        const body = {n: nn, m: rec.m.filter(d => d >= TODAY).join(','), b: rec.b.filter(d => d >= TODAY).join(',')};
        if (rec.pw) { body.h = rec.pw.h; body.s = rec.pw.s; }
        const r = await fetch(cUrl('/people/' + encodeURIComponent(cKey(nn))), {method: 'PUT', body: JSON.stringify(body)});
        if (!r.ok) throw 0;
        if (cKey(old) !== cKey(nn)) await fetch(cUrl('/people/' + encodeURIComponent(cKey(old))), {method: 'DELETE'});
      }
      people[nn] = rec; if (old !== nn) delete people[old];
      me = nn; saveLocal();
      for (const h of Object.values(hangouts)) {      // hangouts keep showing the right author
        if (h.by === old || h.editedBy === old) {
          const nh = {...h, by: h.by === old ? nn : h.by, editedBy: h.editedBy === old ? nn : h.editedBy};
          hangouts[h.id] = nh; hangPut(nh);
        }
      }
      for (const n of Object.values(notes)) {
        if (n.by === old) { const nn2 = {...n, by: nn}; notes[n.id] = nn2; notePut(nn2); }
      }
      authSig = ''; toast(`Name changed to ${nn} ✅`);
    } catch (e) { toast("Couldn't change the name, try again"); }
    hold = false; render(); cloudPull();
  };

  const clearPwFields = () => { $('#pfCur').value = ''; $('#pfNew').value = ''; $('#pfNew2').value = ''; };
  $('#pfSetPw').onclick = async () => {
    if (!canEdit()) return;
    const p = people[me], cur = $('#pfCur').value, n1 = $('#pfNew').value, n2 = $('#pfNew2').value;
    if (p.pw && !(await checkPw(me, cur))) { toast('Current password is wrong'); return; }
    if (n1.length < 4) { toast('Use at least 4 characters'); return; }
    if (n1 !== n2) { toast("The two new passwords don't match"); return; }
    let h, s;
    try { s = newSalt(); h = await hashPw(n1, s); } catch (e) { toast('Passwords need a secure (https) page'); return; }
    hold = true;
    try {
      if (CLOUD) { const r = await cPatch(me, {n: me, h, s}); if (!r.ok) throw 0; }
      p.pw = {h, s}; tok = h; saveLocal(); clearPwFields(); authSig = '';
      toast('Password saved 🔒');
    } catch (e) { toast("Couldn't save the password, try again"); }
    hold = false; render(); cloudPull();
  };
  $('#pfRmPw').onclick = async () => {
    if (!canEdit()) return;
    const p = people[me];
    if (!p.pw) { toast('No password to remove'); return; }
    if (!(await checkPw(me, $('#pfCur').value))) { toast('Current password is wrong'); return; }
    hold = true;
    try {
      if (CLOUD) { const r = await cPatch(me, {h: null, s: null}); if (!r.ok) throw 0; }
      p.pw = null; tok = ''; saveLocal(); clearPwFields(); authSig = '';
      toast('Password removed 🔓');
    } catch (e) { toast("Couldn't remove the password, try again"); }
    hold = false; render(); cloudPull();
  };
  $('#pfInvite').onclick = async () => {
    const link = location.origin + location.pathname + '?room=' + encodeURIComponent(ROOM);
    try { await navigator.clipboard.writeText(link); toast('Invite link copied! Send it to your friends 🔗'); }
    catch (e) { showModal({title: 'Invite link', msg: link, buttons: [{label: 'Close', value: true, primary: true}]}); }
  };
  $('#pfOut').onclick = async () => {
    const ok = await showModal({
      title: 'Log out?',
      msg: "Are you sure you want to log out on this device? You'll need your password to get back in.",
      buttons: [
        {label: 'Cancel', value: false},
        {label: 'Log out', value: true, danger: true}
      ]
    });
    if (!ok) return;
    me = ''; tok = ''; authSig = ''; authMode = 'in'; saveLocal(); clearAuthFields(); mode = 'cal'; render(); toast('Logged out on this device');
  };
  $('#prev').onclick = () => { view.m--; if (view.m < 0) { view.m = 11; view.y--; } render(); };
  $('#next').onclick = () => { view.m++; if (view.m > 11) { view.m = 0; view.y++; } render(); };
  // ---------- log in / sign up ----------
  const clearAuthFields = () => ['liPw', 'liNew', 'liNew2', 'suName', 'suPw', 'suPw2'].forEach(id => { $('#' + id).value = ''; });
  const gotIn = msg => { saveLocal(); clearAuthFields(); mode = 'cal'; authSig = ''; render(); toast(msg); };

  $('#authTabIn').onclick = () => { authMode = 'in'; renderAuth(); };
  $('#authBox').addEventListener('click', e => { const b = e.target.closest('[data-auth]'); if (b) { authMode = b.dataset.auth; renderAuth(); } });
  $('#authTabUp').onclick = () => { authMode = 'up'; renderAuth(); };
  $('#liName').addEventListener('change', renderAuth);
  $('#authView').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') (authMode === 'in' ? $('#liBtn') : $('#suBtn')).click();
  });

  $('#liBtn').onclick = async () => {
    const n = $('#liName').value;
    if (!n || !people[n]) { toast('Select your name from the list'); return; }
    const p = people[n];
    if (p.pw) {
      const pw = $('#liPw').value;
      if (!pw) { toast('Enter your password'); return; }
      if (!(await checkPw(n, pw))) { toast('Wrong password'); return; }
      tok = p.pw.h; me = n;
      gotIn(`Welcome back, ${me}! 👋`);
      return;
    }
    // older account without a password: claim it by choosing one
    const n1 = $('#liNew').value, n2 = $('#liNew2').value;
    if (n1.length < 4) { toast('Use at least 4 characters'); return; }
    if (n1 !== n2) { toast("The two passwords don't match"); return; }
    let h, s;
    try { s = newSalt(); h = await hashPw(n1, s); } catch (e) { toast('Passwords need a secure (https) page'); return; }
    hold = true;
    try {
      if (CLOUD) { const r = await cPatch(n, {n, h, s}); if (!r.ok) throw 0; }
      p.pw = {h, s}; tok = h; me = n;
      gotIn(`Welcome, ${me}! Your password is set 🔒`);
    } catch (e) { toast("Couldn't save the password, try again"); }
    hold = false; render(); cloudPull();
  };

  $('#suBtn').onclick = async () => {
    if (CLOUD && !loaded) { toast('Still connecting, try again in a second'); return; }
    const name = $('#suName').value.trim().slice(0, 30), p1 = $('#suPw').value, p2 = $('#suPw2').value;
    if (!name) { toast('Type your name first'); return; }
    if (Object.keys(people).some(n => cKey(n).toLowerCase() === cKey(name).toLowerCase())) { toast('That name is taken. Log in instead, or pick another name.'); return; }
    if (p1.length < 4) { toast('Use at least 4 characters'); return; }
    if (p1 !== p2) { toast("The two passwords don't match"); return; }
    let h, s;
    try { s = newSalt(); h = await hashPw(p1, s); } catch (e) { toast('Passwords need a secure (https) page'); return; }
    hold = true;
    try {
      if (CLOUD) {
        const r = await fetch(cUrl('/people/' + encodeURIComponent(cKey(name))), {method: 'PUT', body: JSON.stringify({n: name, m: '', b: '', h, s})});
        if (!r.ok) throw 0;
      }
      people[name] = {...empty(), pw: {h, s}}; tok = h; me = name;
      gotIn(`Welcome, ${me}! 🎉 Tap a day to mark it.`);
      helpOnce();
    } catch (e) { toast("Couldn't create the account, try again"); }
    hold = false; render(); cloudPull();
  };

  $('#best').addEventListener('click', e => {
    const el = e.target.closest('[data-jump]'); if (!el) return;
    const [y, m] = el.dataset.jump.split('-').map(Number);
    view = {y, m: m - 1}; selected = el.dataset.jump; mode = 'cal'; render();
    $('#grid').scrollIntoView({behavior: 'smooth', block: 'center'});
  });
  $('#people').addEventListener('click', async e => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const n = b.dataset.rm;
    const ok = await showModal({
      title: 'Remove from group?',
      msg: `Remove ${n} from the group? Their days will be deleted for everyone.`,
      buttons: [
        {label: 'Cancel', value: false},
        {label: 'Remove', value: true, danger: true}
      ]
    });
    if (!ok) return;
    if (people[n] && people[n].pw && n !== me) {       // removing someone with a password needs their password
      const pw = await askPw(`Password for ${n}`, `${n} is protected. Enter their password to remove them.`);
      if (!pw || !(await checkPw(n, pw))) { toast('Wrong password'); return; }
    }
    delete people[n]; cloudDelete(n);
    if (n === me) me = '';
    saveLocal(); render();
  });

  // ---------- how to use ----------
  const openHelp = () => { $('#help').classList.remove('hide'); $('#help .hb').scrollTop = 0; };
  const closeHelp = () => { $('#help').classList.add('hide'); };
  ['helpBtn', 'helpBtn2'].forEach(id => { $('#' + id).onclick = openHelp; });
  $('#helpClose').onclick = closeHelp; $('#helpX').onclick = closeHelp;
  $('#help').addEventListener('click', e => { if (e.target.id === 'help') closeHelp(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHelp(); });
  function helpOnce() {                                    // show the guide once on a new device after sign-up
    try { if (localStorage.getItem('whenfree.helpSeen')) return; localStorage.setItem('whenfree.helpSeen', '1'); } catch (e) { return; }
    openHelp();
  }

  // ---------- startup ----------
  if (CLOUD && !ROOM) {
    document.querySelector('.wrap').innerHTML = '<h1>🔒 Private calendar</h1><div class="card"><p>This calendar only opens with the private link your friend sent you.</p><p class="muted">Open that full link (it ends with <b>?room=</b> and a code) once, and this device will remember it.</p></div>';
    return;
  }
  const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  $('#dows').innerHTML = dows.map(d => `<div class="dow">${d}</div>`).join('');
  setStatus(CLOUD ? true : null);
  if (CLOUD) { $('#status').textContent = 'Connecting...'; cloudStart(); }
  render();
})();
