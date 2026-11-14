// Command Center front end. Plain JavaScript, no framework: state comes from /api/app/state,
// every change is a small request to /api/app/* (or /api/tasks/* for comments and files).
(() => {
'use strict';
const CLAUDE_TASKS = true; // Hand a task to Claude by mentioning @Claude in a comment.

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const SPARK = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1l2.6 7.4L22 11l-7.4 2.6L12 21l-2.6-7.4L2 11l7.4-2.6z"/></svg>';
const CLIP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/></svg>';
const BUBBLE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], FULLDOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], FULLMON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const NAMES = { jarrod:'Jarrod', jalea:'Jalea', claude:'Claude' };
const LS = { get(k, d) { try { const v = localStorage.getItem('cc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('cc.' + k, JSON.stringify(v)); } catch {} } };

// ---------- state ----------
let S = null, AREAS = {}, PROJECTS = [], TASKS = [], MEETINGS = [], EVENTS = [], evDays = new Set();
let resizing = false;
let who = LS.get('who', 'jarrod'), view = 'board', calMode = 'day', calStart = 0, curId = null, drag = null, lastArea = LS.get('area', 'cardshq'), H = 44, briefMode = 'am', loadedAt = 0;
const START = 6, END = 21;
const openAreas = LS.get('open', {});
const q = { area:'cardshq', due:0, who:'jarrod' };
const phone = matchMedia('(max-width:760px)');

// ---------- dates (everything is an offset in days from the server's "today") ----------
const T0 = () => Date.parse(S.today + 'T12:00:00Z');
const off = ymd => ymd ? Math.round((Date.parse(ymd + 'T12:00:00Z') - T0()) / 864e5) : null;
const ymd = n => new Date(T0() + n * 864e5).toISOString().slice(0, 10);
const dd = n => new Date(T0() + n * 864e5);
const dow = n => DOW[dd(n).getUTCDay()], mon = n => MON[dd(n).getUTCMonth()], dom = n => dd(n).getUTCDate();
const dayName = n => n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : `${dow(n)} ${mon(n)} ${dom(n)}`;
const tm = m => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}${mm ? ':' + pad(mm) : ''}${h < 12 ? 'a' : 'p'}`; };
const tmLong = m => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${pad(mm)} ${h < 12 ? 'am' : 'pm'}`; };
const durLabel = d => d < 60 ? d + ' min' : (d / 60) + (d === 60 ? ' hour' : ' hours');
const hhmm = v => { const [h, m] = String(v || '16:00').split(':').map(Number); return h * 60 + m; };
function zoned(date) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:S.tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(date).map(x => [x.type, x.value])); return { ymd:`${p.year}-${p.month}-${p.day}`, min:(Number(p.hour) % 24) * 60 + Number(p.minute) }; }
const nowMin = () => zoned(new Date()).min;
const stamp = isoStr => { if (!isoStr) return ''; const z = zoned(new Date(isoStr)), d = off(z.ymd); return `${d === 0 ? '' : dayName(d) + ', '}${tmLong(z.min)}`; };

// ---------- server ----------
let inflight = 0;
function busy(n) { inflight += n; $('#saving').classList.toggle('show', inflight > 0); }
async function api(method, path, body) {
  const write = method !== 'GET'; if (write) busy(1);
  try {
    const r = await fetch(path, { method, credentials:'same-origin', headers: body ? { 'content-type':'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
    return j;
  } finally { if (write) busy(-1); }
}
const normTask = t => ({ ...t, due: off(t.due), block: t.block ? { d: off(t.block.date), start: t.block.start, dur: t.block.dur, work: t.block.work } : null });
const wire = p => { const o = { ...p }; if ('due' in o) o.due = o.due == null ? null : ymd(o.due); if ('block' in o) o.block = o.block ? { date: ymd(o.block.d), start: o.block.start, dur: o.block.dur, work: o.block.work } : null; return o; };
function addEvents(r) {
  const first = off(r.eventsFrom); for (let i = 0; i < r.eventsDays; i++) evDays.add(first + i);
  const have = new Set(EVENTS.map(e => e.id + e.date));
  (r.events || []).forEach(e => { if (!have.has(e.id + e.date)) EVENTS.push({ ...e, d: off(e.date) }); });
}
function ingest(state) {
  S = state; AREAS = Object.fromEntries(state.areas.map(a => [a.id, a])); PROJECTS = state.projects; MEETINGS = state.meetings;
  const keep = Object.fromEntries(TASKS.map(t => [t.id, t]));
  TASKS = state.tasks.map(t => { const n = normTask(t), old = keep[t.id]; if (old && old.thread) { n.thread = old.thread; n.fileList = old.fileList; } return n; });
  EVENTS = []; evDays = new Set(); addEvents(state);
  if (!AREAS[lastArea]) lastArea = state.areas[0] ? state.areas[0].id : 'cardshq';
  loadedAt = Date.now();
}
let saves = 0;
function save(t, patch, { quiet = false } = {}) {
  saves++;
  return api('PATCH', '/api/app/tasks/' + t.id, wire(patch)).then(r => {
    saves--;
    if (r.next && !byId(r.next.id)) TASKS.push(normTask(r.next));
    if (!quiet && saves === 0) { Object.assign(t, normTask(r.task)); render(); } else if (r.next) renderBehind();
    return r;
  }).catch(e => { saves--; toast('That didn\'t save. ' + e.message); refresh(true); });
}
const timers = {};
function saveSoon(t, field, value) { clearTimeout(timers[t.id + field]); timers[t.id + field] = setTimeout(() => save(t, { [field]: value }, { quiet:true }), 600); }
async function refresh(force) {
  if (!force && ($('#scrim').classList.contains('show') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || saves > 0 || drag)) return;
  try { ingest(await api('GET', '/api/app/state')); if (calStart !== 0 || calMode === 'week') ensureEvents(); renderBrief(); renderNotifs(); render(); } catch (e) { if (force) toast('Couldn\'t reload. ' + e.message); }
}

// ---------- small helpers ----------
const byId = id => TASKS.find(t => t.id === id), cur = () => byId(curId);
const ac = id => (AREAS[id] || {}).color || '#8A93A6';
const an = id => (AREAS[id] || {}).name || 'No area';
const isDone = t => !!t.done;
const visible = t => who === 'both' || t.who === who;
const mine = t => visible(t) && !t.owner;
const projName = t => (PROJECTS.find(p => p.id === t.proj) || {}).name || '';
function dueInfo(t) {
  if (t.due == null) return null; const d = t.due;
  if (d < 0) return { cls:'late', label: (-d) + (d === -1 ? ' day' : ' days') + ' overdue' };
  if (d === 0) return { cls:'today', label:'Due today' };
  if (d === 1) return { cls:'', label:'Tomorrow' };
  return { cls:'', label: d < 7 ? dow(d) : `${mon(d)} ${dom(d)}` };
}
function setBoard(t, b) { t.board = b; t.done = b === 'done'; if (t.done) { t.doneAt = new Date().toISOString(); t.claude = null; } else t.doneAt = null; return save(t, { board:b }); }
let tt; function toast(msg, undo) { const el = $('#toast'), u = $('#toastUndo'); $('#toastMsg').textContent = msg; u.hidden = !undo; u.onclick = () => { undo(); el.classList.remove('show'); }; el.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 2400); }
function closeAll() { ['#scrim','#notif','#detail','#qa','#info','#search','#fp'].forEach(s => $(s).classList.remove('show')); }
const opt = (v, l, sel) => `<option value="${esc(v)}"${String(sel ?? '') === String(v) ? ' selected' : ''}>${l}</option>`;

// ---------- cards, sidebar, tabs ----------
function meta(t, { due = true } = {}) {
  const p = projName(t), d = dueInfo(t); let h = `<span class="atag"><i></i>${esc(an(t.area))}</span>`;
  if (p) h += `<span>${esc(p)}</span>`;
  if (t.claude) h += `<span class="cl ${t.claude}">${SPARK}${t.claude === 'review' ? 'Needs your review' : 'Claude is on it'}</span>`;
  if (due && d && !isDone(t)) h += `<span class="due ${d.cls}">${d.label}</span>`;
  if (isDone(t) && t.doneAt) h += `<span>Done ${stamp(t.doneAt)}</span>`;
  if (t.block && !isDone(t)) h += `<span>${t.block.d === 0 ? '' : dayName(t.block.d) + ' '}${tmLong(t.block.start)} block</span>`;
  if (t.repeat) h += `<span>Repeats ${t.repeat}</span>`;
  if (t.files) h += `<span class="ic">${CLIP}${t.files}</span>`;
  if (t.comments) h += `<span class="ic">${BUBBLE}${t.comments}</span>`;
  if (who === 'both') h += `<span class="wp ${t.who}">${NAMES[t.who] || 'Jarrod'}</span>`;
  return h;
}
const card = t => `<div class="card" draggable="true" data-id="${t.id}" style="--c:${ac(t.area)}"><div class="t">${esc(t.title)}</div><div class="m">${meta(t)}</div></div>`;

function renderSide() {
  $$('[data-who]').forEach(el => el.innerHTML = [['jarrod','Me'],['jalea','Jalea'],['both','Both']].map(([v, l]) => `<button data-act="who" data-v="${v}" aria-pressed="${who === v}">${l}</button>`).join(''));
  $('#tree').innerHTML = S.areas.map((a, i) => {
    const id = a.id, open = TASKS.filter(t => t.area === id && mine(t) && !isDone(t)), isOpen = id in openAreas ? openAreas[id] : i < 2;
    const groups = [...PROJECTS.filter(p => p.area === id).map(p => [p.name, open.filter(t => t.proj === p.id)]), ['No project', open.filter(t => !t.proj || !PROJECTS.some(p => p.id === t.proj && p.area === id))]];
    return `<div class="area" data-open="${isOpen}"><button data-act="area" data-v="${id}" aria-expanded="${isOpen}"><svg class="chev" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span class="dot" style="background:${a.color}"></span>${esc(a.name)}<span class="count">${open.length}</span></button>
      <div class="projects">${groups.filter(([n, ts]) => n !== 'No project' || ts.length).map(([n, ts]) => `<div class="proj">${esc(n)}</div>${ts.map(t => `<div class="ptask" draggable="true" data-id="${t.id}"><span>${esc(t.title)}</span></div>`).join('') || '<div class="none">Nothing open</div>'}`).join('')}
      <button class="addp" data-act="addproj" data-v="${id}">+ Add project</button></div></div>`;
  }).join('');
  const c = S.connections, bad = (c.googleConfigured && (!c.calendar || !c.drive)) ? 1 : 0, pg = document.body.dataset.page;
  $('#navSet').innerHTML = 'Settings' + (bad ? `<span class="pill late" title="Needs attention">${bad}</span>` : '');
  [['#navMeet', 'meetings'], ['#navSet', 'settings']].forEach(([s, p]) => pg === p ? $(s).setAttribute('aria-current', 'page') : $(s).removeAttribute('aria-current'));
}

function renderTabs() {
  const today = TASKS.filter(t => visible(t) && !isDone(t) && ['todo','doing'].includes(t.board)).length;
  const late = TASKS.filter(t => mine(t) && !isDone(t) && t.due != null && t.due < 0).length;
  const waiting = who === 'jalea' ? 0 : TASKS.filter(t => t.owner && !isDone(t)).length;
  $('#tabs').innerHTML = `<button data-act="view" data-v="board" aria-pressed="${view === 'board'}">Today<span class="pill">${today}</span></button>
    <button data-act="view" data-v="upcoming" aria-pressed="${view === 'upcoming'}">Upcoming${late ? `<span class="pill late" title="Overdue">${late}</span>` : ''}</button>
    <button data-act="view" data-v="waiting" aria-pressed="${view === 'waiting'}">Waiting on<span class="pill">${waiting}</span></button>`;
}

function renderView() {
  const v = $('#view');
  if (view === 'board') {
    const cols = [['todo','To do'],['doing','Doing'],['done','Done']];
    const keep = document.activeElement && document.activeElement.id === 'quick' ? document.activeElement.value : null;
    v.innerHTML = `<section class="board">${cols.map(([k, l]) => { const ts = TASKS.filter(t => visible(t) && t.board === k && (k === 'done') === isDone(t));
      return `<div class="col" data-col="${k}"><h3>${l} <span>${ts.length}</span></h3>${k === 'todo' ? '<input class="qa-in" id="quick" placeholder="Add a task, then press Enter" autocomplete="off" aria-label="Add a task">' : ''}${ts.map(card).join('') || `<div class="empty">${k === 'done' ? 'Nothing finished yet today' : 'Drag a task here'}</div>`}</div>`; }).join('')}</section>`;
    if (keep != null) { $('#quick').value = keep; $('#quick').focus(); }
  } else if (view === 'upcoming') {
    const ts = TASKS.filter(t => mine(t) && !isDone(t)).sort((a, b) => (a.due ?? 9999) - (b.due ?? 9999));
    const groups = [['Overdue', t => t.due != null && t.due < 0, 'late'], ['Today', t => t.due === 0], ['Tomorrow', t => t.due === 1], ['This week', t => t.due >= 2 && t.due <= 6], ['Later', t => t.due >= 7], ['No date', t => t.due == null]];
    v.innerHTML = `<section class="list">${groups.map(([g, f, cls]) => { const x = ts.filter(f); return x.length ? `<div class="grp ${cls || ''}">${g}<span class="pill ${cls || ''}">${x.length}</span></div>` + x.map(t => { const d = dueInfo(t);
      return `<div class="row" draggable="true" data-id="${t.id}" style="--c:${ac(t.area)}"><button class="chk" data-act="check" data-id="${t.id}" aria-label="Mark done"></button><div><div class="t">${esc(t.title)}</div><div class="m">${meta(t, { due:false })}</div></div><span class="due ${d ? d.cls : ''}">${d ? d.label : ''}</span>${t.board === 'none' ? `<button class="mini" data-act="addtoday" data-id="${t.id}">Add to today</button>` : '<span class="on">On today\'s board</span>'}</div>`; }).join('') : ''; }).join('') || '<div class="empty">Nothing open. Add a task to get started.</div>'}</section>`;
  } else {
    const ts = who === 'jalea' ? [] : TASKS.filter(t => t.owner && !isDone(t)).sort((a, b) => (a.due ?? 9999) - (b.due ?? 9999));
    const people = [...new Set(ts.map(t => t.owner))];
    v.innerHTML = `<section class="list"><p>What other people committed to in your meetings. These come in from recaps on their own.</p>${people.map(p => { const x = ts.filter(t => t.owner === p);
      return `<div class="grp">${esc(p)}<span class="pill">${x.length}</span></div>` + x.map(t => { const d = dueInfo(t);
        return `<div class="row" data-id="${t.id}" style="--c:${ac(t.area)}"><span></span><div><div class="t">${esc(t.title)}</div><div class="m">${meta(t, { due:false })}</div></div><span class="due ${d ? d.cls : ''}">${d ? d.label : ''}</span><button class="mini" data-act="check" data-id="${t.id}">Got it</button></div>`; }).join(''); }).join('') || '<div class="empty">Nobody owes you anything right now</div>'}</section>`;
  }
}

// ---------- calendar ----------
function evHtml(e, wk) {
  const top = (e.start - START * 60) / 60 * H, h = Math.max(15, e.dur) / 60 * H - 3;
  const act = e.meeting ? `data-act="meeting" data-v="${e.meeting}"` : e.link ? `data-act="evlink" data-v="${esc(e.link)}"` : '';
  return `<div class="ev meeting${e.dur <= 30 ? ' short' : ''}" ${act} style="--c:${e.area ? ac(e.area) : '#8A93A6'};top:${top + 1}px;height:${h}px" title="${esc(e.title)}"><b>${esc(e.title)}</b>${wk || !e.people.length ? '' : `<span>${esc(e.people.slice(0, 4).join(', '))}</span>`}</div>`;
}
function blockHtml(t, wk) {
  const b = t.block;
  return `<div class="ev block" draggable="true" data-id="${t.id}" style="--c:${ac(t.area)};top:${(b.start - START * 60) / 60 * H + 1}px;height:${b.dur / 60 * H - 3}px" title="${esc(t.title)}"><b>${esc(t.title)}</b>${wk ? '' : `<span>${tm(b.start)} to ${tm(b.start + b.dur)}${b.work ? ', on your calendar' : ''}</span>`}<i class="rz" title="Drag to change length"></i></div>`;
}
const inGrid = m => m >= START * 60 && m < END * 60;
function renderCal() {
  const wk = calMode === 'week', days = wk ? 7 : 1, list = [...Array(days)].map((_, i) => calStart + i);
  $$('[data-act=calmode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === calMode));
  $('#calLabel').textContent = wk ? `${mon(calStart)} ${dom(calStart)} to ${mon(calStart) === mon(calStart + 6) ? '' : mon(calStart + 6) + ' '}${dom(calStart + 6)}` : `${dow(calStart)}, ${mon(calStart)} ${dom(calStart)}${calStart === 0 ? ' (today)' : ''}`;
  $('#legend').innerHTML = S.connections.calendar ? '<span><i class="dot" style="background:var(--cards)"></i>Meeting</span><span><i class="dot" style="border:1.5px dashed var(--ink)"></i>Time block</span>'
    : `<span>Google Calendar isn't connected, so meetings don't show.</span><button class="linkbtn" data-act="page" data-v="settings" style="padding:0">Fix in Settings</button>`;
  const blocks = d => TASKS.filter(t => visible(t) && t.block && t.block.d === d);
  const evs = d => EVENTS.filter(e => e.d === d).sort((a, b) => a.start - b.start);
  if (wk && phone.matches) {
    $('#cal').innerHTML = `<div class="agenda">${list.map(d => { const items = [...evs(d).map(e => ({ s:e.start, h:`<div class="arow" ${e.meeting ? `data-act="meeting" data-v="${e.meeting}"` : e.link ? `data-act="evlink" data-v="${esc(e.link)}"` : ''} style="--c:${e.area ? ac(e.area) : '#8A93A6'}"><span>${tmLong(e.start)}</span><b>${esc(e.title)}</b></div>` })), ...blocks(d).map(t => ({ s:t.block.start, h:`<div class="arow block" data-id="${t.id}" style="--c:${ac(t.area)}"><span>${tmLong(t.block.start)}</span><b>${esc(t.title)}</b></div>` }))].sort((x, y) => x.s - y.s);
      return `<h3 class="${d === 0 ? 'is-today' : ''}">${dayName(d)}</h3>${items.map(i => i.h).join('') || '<div class="none">Nothing scheduled</div>'}`; }).join('')}</div>`;
    return;
  }
  H = wk ? 36 : 44;
  const nm = nowMin();
  // Anything outside the visible hours is listed above the grid so it is never silently hidden.
  const early = d => [...evs(d).filter(e => !inGrid(e.start)).map(e => `${tm(e.start)} ${e.title}`), ...blocks(d).filter(t => !inGrid(t.block.start)).map(t => `${tm(t.block.start)} ${t.title}`)];
  $('#cal').innerHTML = `<div class="cg${wk ? ' wk' : ''}" style="--h:${H}px;--n:${days}"><div class="gut">${[...Array(END - START)].map((_, i) => `<div class="hr"><span>${tm((START + i) * 60)}</span></div>`).join('')}</div>${list.map(d => `<div><div class="dh${d === 0 ? ' is-today' : ''}"${early(d).length ? ` title="Also: ${esc(early(d).join('; '))}"` : ''}>${dow(d)} ${dom(d)}${early(d).length ? ' +' + early(d).length : ''}</div><div class="dbody" data-d="${d}">${evs(d).filter(e => inGrid(e.start)).map(e => evHtml(e, wk)).join('')}${blocks(d).filter(t => inGrid(t.block.start)).map(t => blockHtml(t, wk)).join('')}${d === 0 && inGrid(nm) ? `<div class="now" style="top:${(nm - START * 60) / 60 * H}px"></div>` : ''}</div></div>`).join('')}</div>${!wk && early(calStart).length ? `<div class="none" style="padding:10px 2px 0">Outside these hours: ${esc(early(calStart).join('; '))}</div>` : ''}`;
}
async function ensureEvents() {
  const need = [...Array(calMode === 'week' ? 7 : 1)].map((_, i) => calStart + i).filter(d => !evDays.has(d));
  if (!need.length || !S.connections.calendar) return;
  try { addEvents(await api('GET', `/api/app/events?start=${ymd(calStart)}&days=7`)); renderCal(); } catch (e) { toast('Couldn\'t load the calendar. ' + e.message); }
}

// ---------- briefing (worked out from your data; the AI-written version comes in a later phase) ----------
const NUM = ['no','one','two','three','four','five','six','seven','eight','nine','ten'];
const n2w = n => n <= 10 ? NUM[n] : String(n);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const listSentence = parts => cap(parts.length > 1 ? parts.slice(0, -1).join(', ') + (parts.length > 2 ? ',' : '') + ' and ' + parts[parts.length - 1] : parts[0]) + '.';
function buildBrief(mode) {
  const my = TASKS.filter(mine), open = my.filter(t => !isDone(t)), late = open.filter(t => t.due != null && t.due < 0).sort((a, b) => a.due - b.due);
  const waiting = who === 'jalea' ? [] : TASKS.filter(t => t.owner && !isDone(t)), people = new Set(waiting.map(t => t.owner)).size;
  const doneOn = d => my.filter(t => isDone(t) && t.doneAt && off(zoned(new Date(t.doneAt)).ymd) === d);
  const it = t => [ac(t.area), t.title], ev = e => [e.area ? ac(e.area) : '#8A93A6', `${tmLong(e.start)}: ${e.title}`];
  const onBoard = open.filter(t => ['todo','doing'].includes(t.board));
  if (mode === 'am') {
    const meetings = EVENTS.filter(e => e.d === 0), parts = [];
    if (meetings.length) parts.push(`${n2w(meetings.length)} meeting${meetings.length === 1 ? '' : 's'} today`);
    if (late.length) parts.push(`${n2w(late.length)} task${late.length === 1 ? '' : 's'} overdue`);
    if (people) parts.push(`${n2w(people)} ${people === 1 ? 'person owes' : 'people owe'} you something`);
    const needs = [...open.filter(t => t.claude === 'review').map(t => [ac(t.area), 'Review Claude\'s reply: ' + t.title]), ...open.filter(t => t.due === 0).map(it), ...late.map(it)];
    const coming = [...EVENTS.filter(e => e.d === 1).sort((a, b) => a.start - b.start).slice(0, 1).map(e => [e.area ? ac(e.area) : '#8A93A6', `Tomorrow ${tmLong(e.start)}: ${e.title}`]), ...open.filter(t => t.due >= 1 && t.due <= 7).sort((a, b) => a.due - b.due).map(t => [ac(t.area), `${dueInfo(t).label}: ${t.title}`])];
    return { head: parts.length ? listSentence(parts) : 'Nothing on the calendar and nothing overdue. The day is yours.',
      cols: [['Finished yesterday', doneOn(-1).map(it)], ['Carrying over', onBoard.filter(t => t.carried).map(it)], ['Needs you', needs], ['Coming up', coming]],
      note: 'Anything you didn\'t finish yesterday stays on today\'s board.' };
  }
  const done = doneOn(0), total = done.length + onBoard.length;
  return { head: total ? `You closed ${n2w(done.length)} of ${n2w(total)} today. ${onBoard.length ? cap(n2w(onBoard.length)) + (onBoard.length === 1 ? ' carries' : ' carry') + ' over to tomorrow.' : 'Nothing carries over.'}` : 'Nothing was on the board today.',
    cols: [['Done today', done.map(it)], ['Still open', onBoard.map(it)], open.some(t => t.claude) ? ['With Claude', open.filter(t => t.claude).map(t => [ac(t.area), (t.claude === 'review' ? 'Review: ' : '') + t.title])] : ['Waiting on others', waiting.filter(t => t.due != null && t.due <= 0).map(t => [ac(t.area), `${t.owner}: ${t.title}`])], ['Tomorrow', [...EVENTS.filter(e => e.d === 1).sort((a, b) => a.start - b.start).map(ev), ...open.filter(t => t.due === 1).map(it)]]],
    note: 'Open tasks stay on the board for tomorrow. Done ones show up as "Finished yesterday" in the morning.' };
}
function renderBrief(mode) {
  if (mode) briefMode = mode;
  const b = buildBrief(briefMode), d = dd(0), wrap = hhmm(S.settings.wrap);
  $$('[data-act=mode]').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === briefMode));
  $('#briefDate').textContent = `${FULLDOW[d.getUTCDay()]}, ${FULLMON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  $('#briefAuto').textContent = `Changes over at ${tmLong(wrap).replace(':00', '')}`;
  $('#headline').textContent = b.head; $('#briefNote').textContent = b.note;
  $('#briefCols').innerHTML = b.cols.map(([h, items]) => `<div><h3>${h}</h3><ul>${items.slice(0, 4).map(([c, t]) => `<li><i style="background:${c}"></i>${esc(t)}</li>`).join('') || '<li class="more">Nothing here</li>'}${items.length > 4 ? `<li class="more">and ${items.length - 4} more</li>` : ''}</ul></div>`).join('');
  const hr = Math.floor(nowMin() / 60);
  $('#hello').textContent = `Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${NAMES[S.me] || 'Jarrod'}`;
  $('#helloSub').textContent = $('#briefDate').textContent;
}

// ---------- notifications (worked out from your data; phone alerts come in a later phase) ----------
function buildNotifs() {
  const out = [], c = S.connections, LATE = 'var(--late)';
  if (c.googleConfigured && !c.calendar) out.push({ id:'conn-cal', c:LATE, i:'!', t:'Google Calendar isn\'t connected', s:'Meetings and time blocks need it', page:'settings' });
  else if (c.calendar && !c.drive) out.push({ id:'conn-drive-' + c.claude.unfiled, c:LATE, i:'!', t:'Google Drive needs your approval', s: c.claude.unfiled ? `${c.claude.unfiled} recap${c.claude.unfiled === 1 ? ' is' : 's are'} waiting to be filed` : 'Recaps can\'t be saved as Docs until you approve', page:'settings' });
  TASKS.filter(t => mine(t) && t.claude === 'review').forEach(t => out.push({ id:'rev-' + t.id, c:'var(--ink)', i:'C', t:'Claude needs your review', s:t.title, open:t.id }));
  const late = TASKS.filter(t => mine(t) && !isDone(t) && t.due != null && t.due < 0).sort((a, b) => a.due - b.due);
  if (late.length) out.push({ id:`late-${S.today}-${late.length}`, c:LATE, i:'!', t:`${late.length} of your tasks ${late.length === 1 ? 'is' : 'are'} overdue`, s:`Oldest: ${late[0].title}`, view:'upcoming' });
  if (who !== 'jalea') TASKS.filter(t => t.owner && !isDone(t) && t.due != null && t.due < 0).sort((a, b) => a.due - b.due).slice(0, 3).forEach(t => out.push({ id:`w-${t.id}-${S.today}`, c:LATE, i:'W', t:`${t.owner} is ${-t.due} day${t.due === -1 ? '' : 's'} late`, s:t.title, open:t.id }));
  MEETINGS.forEach(m => m.recaps.filter(r => r.date === S.today).forEach(r => out.push({ id:`rc-${m.id}-${r.date}`, c:ac(m.area), i:'R', t:'Recap ready: ' + m.title, s:(r.summary || '').slice(0, 90), meeting:m.id })));
  return out;
}
function renderNotifs() {
  const read = new Set(LS.get('read', [])), list = buildNotifs();
  $('#notifList').innerHTML = list.map(n => `<div class="nitem${read.has(n.id) ? '' : ' unread'}" style="--c:${n.c}"><span class="nicon">${n.i}</span><div><div class="nt">${esc(n.t)}</div><div class="ns">${esc(n.s)}</div>${n.open ? `<button class="linkbtn" data-act="nopen" data-v="${n.open}" style="padding:4px 0 0">Open task</button>` : n.view ? `<button class="linkbtn" data-act="nview" data-v="${n.view}" style="padding:4px 0 0">Show me</button>` : n.page ? `<button class="linkbtn" data-act="page" data-v="${n.page}" style="padding:4px 0 0">Fix in Settings</button>` : n.meeting ? `<button class="linkbtn" data-act="meeting" data-v="${n.meeting}" style="padding:4px 0 0">Open recap</button>` : ''}</div><span class="ntime"></span></div>`).join('') || '<div class="empty">You\'re all caught up</div>';
  const u = list.filter(n => !read.has(n.id)).length;
  $$('[data-badge]').forEach(b => { b.textContent = u; b.hidden = !u; });
}
function renderBehind() { renderSide(); renderTabs(); renderView(); renderCal(); }
function render() { renderBehind(); renderPage(); if (curId && $('#detail').classList.contains('show')) renderDetail(); }

// ---------- task detail ----------
function renderDetail() {
  const t = cur(); if (!t) { closeAll(); return; }
  $('#dCrumb').innerHTML = `<i style="background:${ac(t.area)}"></i>${esc(an(t.area))}${projName(t) ? ' / ' + esc(projName(t)) : ''}`;
  const d = dueInfo(t), b = t.block, status = isDone(t) ? 'done' : t.board;
  const review = t.claude === 'review' ? `<div class="rvbox"><b>Claude replied</b><p>Its reply is in the comments below. Nothing goes out until you approve it.</p><div class="btns"><button class="send" data-act="approve">Approve</button><button class="ghost" data-act="sendback">Send back</button></div></div>`
    : t.claude === 'working' ? `<div class="rvbox working"><b>Claude is on this</b><p>It picks up tasks every hour. Its reply will show in the comments here.</p></div>` : '';
  const blockDays = [...new Set([...Array(14).keys(), ...(b ? [b.d] : [])])].sort((x, y) => x - y);
  const meeting = MEETINGS.find(m => m.id === t.meeting);
  $('#dBody').innerHTML = `<textarea class="d-title" data-f="title" rows="2" aria-label="Task title">${esc(t.title)}</textarea>
    ${review}<div class="acts" style="grid-template-columns:repeat(${CLAUDE_TASKS ? 4 : 3},1fr)"><button data-act="d-doing"><i style="background:var(--cards)"></i>Start</button><button data-act="d-done"><i style="background:var(--home)"></i>Done</button><button data-act="block"><i style="border:1.5px dashed var(--ink)"></i>Block time</button>${CLAUDE_TASKS ? '<button data-act="d-claude"><i style="background:var(--ink)"></i>To Claude</button>' : ''}</div>
    <dl class="fields">
      <dt>Status</dt><dd><select data-f="board" aria-label="Status">${opt('none','Not on today\'s board',status)}${opt('todo','To do',status)}${opt('doing','Doing',status)}${opt('done','Done',status)}</select></dd>
      <dt>Area</dt><dd><select data-f="area" aria-label="Area">${S.areas.map(a => opt(a.id, esc(a.name), t.area)).join('')}</select></dd>
      <dt>Project</dt><dd><select data-f="proj" aria-label="Project">${opt('','No project',t.proj || '')}${PROJECTS.filter(p => p.area === t.area).map(p => opt(p.id, esc(p.name), t.proj)).join('')}</select></dd>
      <dt>Due</dt><dd><input type="date" data-f="due" value="${t.due == null ? '' : ymd(t.due)}" aria-label="Due date">${d && !isDone(t) ? `<span class="due ${d.cls}">${d.label}</span>` : ''}</dd>
      <dt>Assigned to</dt><dd><div class="seg"><button data-act="assign" data-v="jarrod" aria-pressed="${t.who === 'jarrod'}">Jarrod</button><button data-act="assign" data-v="jalea" aria-pressed="${t.who === 'jalea'}">Jalea</button></div></dd>
      <dt>Waiting on</dt><dd><input type="text" data-f="owner" value="${esc(t.owner || '')}" placeholder="Nobody, this one is mine" aria-label="Waiting on"></dd>
      <dt>Repeats</dt><dd><select data-f="repeat" aria-label="Repeats">${opt('','Doesn\'t repeat',t.repeat)}${opt('daily','Daily',t.repeat)}${opt('weekly','Weekly',t.repeat)}${opt('monthly','Monthly',t.repeat)}</select></dd>
      <dt>Time block</dt><dd>${b ? `<div class="bed"><select data-f="bday" aria-label="Day">${blockDays.map(i => opt(i, dayName(i), b.d)).join('')}</select><input type="time" data-f="bstart" step="900" value="${pad(Math.floor(b.start / 60))}:${pad(b.start % 60)}" aria-label="Start time"><select data-f="bdur" aria-label="Length">${[...new Set([15,30,45,60,90,120,180,b.dur])].sort((x, y) => x - y).map(m => opt(m, durLabel(m), b.dur)).join('')}</select><button class="linkbtn" data-act="unblock">Remove</button><label class="ck" style="width:100%"><input type="checkbox" data-f="bwork"${b.work ? ' checked' : ''}> Also block it on my Google Calendar</label></div>` : '<button class="mini" data-act="block">Block time</button>'}</dd>
      ${meeting ? `<dt>From</dt><dd><button class="linkbtn" data-act="meeting" data-v="${meeting.id}" style="padding:0">${esc(meeting.title)}</button></dd>` : ''}
    </dl>
    <h3 class="d-sec">Notes</h3><textarea class="notes" data-f="notes" placeholder="Add notes">${esc(t.notes)}</textarea>
    <h3 class="d-sec">Attachments</h3><div class="files" id="dFiles"></div>
    <h3 class="d-sec">Comments</h3><div class="thread" id="dThread"></div>
    <button class="del" data-act="delete">Delete task</button>`;
  renderThread();
}
const fileTile = f => `<a class="file" ${f.url ? `href="${esc(f.url)}" target="_blank" rel="noopener"` : ''}><div class="thumb">${esc((f.name.split('.').pop() || 'file').toUpperCase().slice(0, 4))}</div><div class="fn" title="${esc(f.name)}">${esc(f.name)}</div><div class="fs">${f.size ? (f.size > 1e6 ? (f.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1e3)) + ' KB') : ''}</div></a>`;
function renderThread() {
  const t = cur(); if (!t || !$('#dFiles')) return;
  $('#dFiles').innerHTML = (t.fileList || []).map(fileTile).join('') + '<button class="file add" data-act="attach" data-v="task">+ Add file</button>';
  $('#dThread').innerHTML = !t.thread ? '<div class="none">Loading comments</div>' : t.thread.map(c => c.author === 'system' ? `<div class="ev2">${esc(c.body)}</div>`
    : `<div class="cm"><span class="av ${c.author}">${c.author === 'claude' ? SPARK : (NAMES[c.author] || '?').slice(0, 2)}</span><div><div class="who2">${NAMES[c.author] || esc(c.author)}<span>${stamp(c.at)}</span></div><div class="txt">${esc(c.body).replace(/@claude\b/gi, '<b>@Claude</b>').replace(/\n/g, '<br>')}</div>${(c.files || []).map(f => `<a class="att" ${f.url ? `href="${esc(f.url)}" target="_blank" rel="noopener"` : ''} style="text-decoration:none;color:inherit">${CLIP} ${esc(f.name)}</a>`).join(' ')}</div></div>`).join('') || '<div class="none">No comments yet</div>';
}
async function loadThread(id) {
  try {
    const r = await api('GET', `/api/tasks/${id}/thread`), t = byId(id); if (!t) return;
    t.thread = r.comments; t.fileList = r.files; t.comments = r.comments.length; t.files = r.files.length + r.comments.reduce((n, c) => n + (c.files || []).length, 0);
    if (curId === id) renderThread(); renderBehind();
  } catch (e) { if (curId === id && $('#dThread')) $('#dThread').innerHTML = `<div class="none">Couldn't load comments. ${esc(e.message)}</div>`; }
}
let pending = [], fileTarget = 'task';
const renderPending = () => $('#dPending').innerHTML = pending.map(f => `<span>${esc(f.name)}</span>`).join('');
function openDetail(id) { if (!byId(id)) return; curId = id; pending = []; renderPending(); $('#dInput').value = ''; closeAll(); renderDetail(); $('#detail').classList.add('show'); $('#scrim').classList.add('show'); loadThread(id); }
function defaultBlock() { let s = Math.ceil((nowMin() + 1) / 30) * 30; if (s < START * 60 || s > 19 * 60) s = 15 * 60; return { d:0, start:s, dur:60, work:true }; }
async function uploadFile(t, f, onComment) {
  if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is over 25 MB`);
  const r = await api('POST', `/api/tasks/${t.id}/attachments`, { name:f.name, type:f.type, size:f.size, onComment });
  const up = await fetch(r.uploadUrl, { method:'PUT', headers:{ 'content-type': f.type || 'application/octet-stream', 'x-upsert':'false' }, body:f });
  if (!up.ok) { await api('DELETE', `/api/tasks/${t.id}/attachments/${r.attachmentId}`).catch(() => {}); throw new Error(`${f.name} didn't upload (${up.status})`); }
  return { id:r.attachmentId, name:f.name };
}
$('#dBody').addEventListener('input', e => { const f = e.target.dataset.f, t = cur(); if (!t) return;
  if (f === 'title') { const v = e.target.value.replace(/\n/g, ' '); if (v.trim()) { t.title = v; saveSoon(t, 'title', v.trim()); } }
  else if (f === 'notes') { t.notes = e.target.value; saveSoon(t, 'notes', t.notes); }
  else if (f === 'owner') { t.owner = e.target.value.trim() || null; saveSoon(t, 'owner', t.owner || ''); }
  else return;
  renderBehind(); });
$('#dBody').addEventListener('change', e => { const f = e.target.dataset.f, v = e.target.value, t = cur(); if (!t || !f) return;
  if (f === 'board') { setBoard(t, v); render(); return; }
  if (f === 'area') { t.area = v; t.proj = null; lastArea = v; LS.set('area', v); save(t, { area:v, proj:null }); }
  else if (f === 'proj') { t.proj = v || null; save(t, { proj:t.proj }); }
  else if (f === 'due') { t.due = off(v); save(t, { due:t.due }); }
  else if (f === 'repeat') { t.repeat = v; save(t, { repeat:v }); }
  else if (['bday','bstart','bdur','bwork'].includes(f) && t.block) {
    if (f === 'bday') t.block.d = +v; else if (f === 'bdur') t.block.dur = +v; else if (f === 'bwork') t.block.work = e.target.checked;
    else { const [h, m] = v.split(':').map(Number); if (isNaN(h)) return; t.block.start = h * 60 + m; }
    save(t, { block:t.block });
  } else return;
  render(); });

// ---------- meetings and settings pages ----------
const openItems = m => TASKS.filter(t => t.meeting === m.id && !isDone(t));
const ago = isoStr => { if (!isoStr) return 'never'; const m = Math.round((Date.now() - Date.parse(isoStr)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago` : stamp(isoStr); };
const recapDate = d => { const o = off(d); return o == null ? '' : dayName(o); };
function renderPage() {
  const pg = document.body.dataset.page, el = $('#page'); if (pg === 'home') { el.innerHTML = ''; return; }
  if (el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
  const head = t => `<div class="pagehead"><button class="mini" data-act="page" data-v="home">Back to today</button><h2>${t}</h2></div>`;
  if (pg === 'meetings') {
    el.innerHTML = head('Meetings') + `<section class="list" style="margin-top:14px"><p>A recap is written after each meeting and filed in the folder shown. Its action items land in the meeting's area.</p>${S.areas.map(a => { const ms = MEETINGS.filter(m => m.area === a.id);
      return ms.length ? `<div class="grp"><span class="atag" style="--c:${a.color}"><i></i>${esc(a.name)}</span></div>` + ms.map(m => { const n = openItems(m).length;
        return `<div class="row" data-act="meeting" data-v="${m.id}" style="--c:${a.color}"><span></span><div><div class="t">${esc(m.title)}</div><div class="m"><span>${esc(m.when)}</span><span>${m.on ? esc(m.folderPath || (m.folderId ? 'Folder set' : 'Default folder')) : 'Recaps off'}</span></div></div><span class="due">${m.recaps[0] ? 'Last recap ' + recapDate(m.recaps[0].date) : ''}</span><span class="on">${n ? n + ' open' : ''}</span></div>`; }).join('') : ''; }).join('') || '<div class="empty">Meetings show up here once Granola records one.</div>'}</section>`;
    return;
  }
  const c = S.connections, g = c.granola;
  const conn = (name, note, state, btn) => `<div class="srow"><div><b>${name}</b><small>${note}</small></div><span class="st ${state}">${state === 'ok' ? 'Connected' : state === 'fix' ? 'Needs attention' : 'Not set up'}</span>${btn || '<span></span>'}</div>`;
  const link = label => `<a class="mini" href="/api/google/connect" style="text-decoration:none;color:inherit">${label}</a>`;
  el.innerHTML = head('Settings') + `
    <section class="set"><h3>Connections</h3><p>Where the dashboard gets its information. If one breaks, it shows here and on the Settings link.</p>
      ${conn('Google Calendar', 'Your meetings, and the time blocks you make here', !c.googleConfigured ? 'off' : c.calendar ? 'ok' : 'fix', c.googleConfigured && !c.calendar ? link('Connect') : '')}
      ${conn('Google Drive', !c.calendar ? 'Connect Google first' : c.drive ? 'Recap Docs are saved to your mapped folders' : `Needs your approval again.${c.claude.unfiled ? ` ${c.claude.unfiled} recap${c.claude.unfiled === 1 ? ' is' : 's are'} waiting to be filed.` : ''}`, !c.googleConfigured ? 'off' : c.calendar && c.drive ? 'ok' : 'fix', c.calendar && !c.drive ? link('Reconnect') : '')}
      ${conn('Granola', g.configured ? `Meeting notes, checked every 30 minutes. Last check ${ago(g.lastRun)}.` : 'No Granola key on the site yet', g.configured ? 'ok' : 'off', g.configured ? '<button class="mini" data-act="granola">Check now</button>' : '')}
      ${conn('Claude', `Runs on your plan, no API key.${c.claude.waiting ? ` ${c.claude.waiting} recap${c.claude.waiting === 1 ? '' : 's'} waiting to be written.` : ''}${c.claude.tasks ? ` ${c.claude.tasks} task${c.claude.tasks === 1 ? '' : 's'} in its queue.` : ''}`, 'ok')}
    </section>
    <section class="set"><h3>Claude</h3><p>Mention @Claude in a task's comments and it picks the task up within the hour, then replies in the same thread for your review. It can read your connected tools and write drafts. It never sends, posts or changes anything.</p>
      <div class="srow"><div><b>Start on recap action items automatically</b><small>When a recap is filed, Claude begins the tasks it can prepare on its own</small></div><span></span><button class="switch" role="switch" aria-checked="${S.settings.autostart}" data-act="autostart" aria-label="Start on recap action items automatically"></button></div></section>
    <section class="set"><h3>Daily briefing</h3><div class="srow"><div><b>Evening wrap-up starts at</b><small>Before this time you get the morning brief.</small></div><input type="time" data-s="wrap" value="${esc(S.settings.wrap)}" aria-label="Evening wrap-up time"><span></span></div></section>
    <section class="set"><h3>Meeting recaps</h3><div class="srow"><div><b>Default folder</b><small>${esc((S.settings.defaultFolder && S.settings.defaultFolder.path) || 'Meeting Recaps / General')}, used when a meeting has no folder of its own</small></div><span></span><button class="mini" data-act="pickdefault">Change</button></div></section>
    <section class="set"><h3>This dashboard</h3>
      <div class="srow"><div><b>Classic view</b><small>The previous dashboard, kept as a fallback</small></div><span></span><a class="mini" href="/classic.html" style="text-decoration:none;color:inherit">Open</a></div>
      <div class="srow"><div><b>Signed in as Jarrod</b><small>Jalea's login, phone alerts, quiet hours and Jira arrive in later phases</small></div><span></span><button class="mini" data-act="signout">Sign out</button></div></section>`;
}
$('#page').addEventListener('change', async e => { const el = e.target;
  if (el.dataset.s === 'wrap' && el.value) { S.settings.wrap = el.value; renderBrief(nowMin() >= hhmm(el.value) ? 'pm' : 'am'); try { await api('PUT', '/api/app/settings', { wrap:el.value }); toast(`Evening wrap-up now starts at ${tmLong(hhmm(el.value)).replace(':00', '')}`); } catch (err) { toast('That didn\'t save. ' + err.message); } } });
function showInfo(crumb, html) { closeAll(); $('#iCrumb').innerHTML = crumb; $('#iBody').innerHTML = html; $('#info').classList.add('show'); $('#scrim').classList.add('show'); }
$('#iBody').addEventListener('change', async e => { const m = MEETINGS.find(x => x.id === e.target.dataset.m); if (!m) return;
  m.area = e.target.value; renderPage(); EVENTS.forEach(ev => { if (ev.meeting === m.id) ev.area = m.area; }); renderCal(); ACT.meeting(m.id);
  try { await api('PATCH', '/api/app/meetings/' + m.id, { area:m.area }); toast(`New action items will land in ${an(m.area)}`); } catch (err) { toast('That didn\'t save. ' + err.message); } });

// ---------- folder picker ----------
let fpTree = null, fpDone = null;
function fpRender() {
  const node = (n, path) => { const p = path ? path + ' / ' + n.name : n.name, kids = n.children || [];
    return `<div class="fnode" data-open="false"><div>${kids.length ? '<button class="tw" data-act="fptoggle" aria-label="Open folder">&rsaquo;</button>' : '<span class="tw"></span>'}<button data-act="fppick" data-v="${esc(n.id)}" data-path="${esc(p)}">${esc(n.name)}</button></div>${kids.length ? `<div class="kids">${kids.map(k => node(k, p)).join('')}</div>` : ''}</div>`; };
  $('#fpTree').innerHTML = (fpTree.children || []).map(k => node(k, '')).join('') || '<div class="none" style="padding:8px">No folders found. Connect Google in Settings first.</div>';
}
async function pickFolder(note, done) {
  fpDone = done; $('#fpNote').textContent = note; $('#fp').classList.add('show'); $('#scrim').classList.add('show');
  if (!fpTree) { $('#fpTree').innerHTML = '<div class="none" style="padding:8px">Loading your Drive folders</div>'; try { fpTree = (await api('GET', '/api/app/folders')).tree; } catch (e) { $('#fpTree').innerHTML = `<div class="none" style="padding:8px">Couldn't load folders. ${esc(e.message)}</div>`; return; } }
  fpRender();
}

// ---------- search ----------
function renderSearch() {
  const qv = $('#sInput').value.trim().toLowerCase(), out = $('#sResults');
  if (!qv) { out.innerHTML = '<div class="none" style="padding:10px">Covers tasks, meetings and projects, including finished tasks.</div>'; return; }
  const ts = TASKS.filter(t => `${t.title} ${t.owner || ''} ${t.notes || ''}`.toLowerCase().includes(qv)).slice(0, 10), ms = MEETINGS.filter(m => m.title.toLowerCase().includes(qv)), ps = PROJECTS.filter(p => p.name.toLowerCase().includes(qv));
  const grp = (l, h) => h ? `<div class="sgrp">${l}</div>${h}` : '';
  out.innerHTML = (grp('Tasks', ts.map(t => `<button data-act="nopen" data-v="${t.id}" style="--c:${ac(t.area)}"><span class="atag"><i></i></span><span>${esc(t.title)}</span><span class="on">${isDone(t) ? 'Done' : t.owner ? 'Waiting on ' + esc(t.owner) : ''}</span></button>`).join(''))
    + grp('Meetings', ms.map(m => `<button data-act="meeting" data-v="${m.id}" style="--c:${ac(m.area)}"><span class="atag"><i></i></span><span>${esc(m.title)}</span><span class="on">${esc(m.when)}</span></button>`).join(''))
    + grp('Projects', ps.map(p => `<button data-act="sproj" data-v="${p.id}" style="--c:${ac(p.area)}"><span class="atag"><i></i></span><span>${esc(p.name)}</span><span class="on">${esc(an(p.area))}</span></button>`).join(''))) || '<div class="none" style="padding:10px">Nothing matches</div>';
}
$('#sInput').addEventListener('input', renderSearch);
function setPage(p) { document.body.dataset.page = p; renderPage(); renderSide(); markTabs(); }
function markTabs() { const b = document.body, on = b.dataset.page === 'meetings' ? 'meetings' : b.dataset.page === 'settings' ? '' : b.dataset.tab; $$('.tabbar button').forEach(x => x.dataset.v === on ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current')); }

// ---------- quick add ----------
function renderQa() {
  $('#qArea').innerHTML = S.areas.map(a => `<button data-act="qset" data-k="area" data-v="${a.id}" aria-pressed="${q.area === a.id}"><i style="background:${a.color}"></i>${esc(a.name)}</button>`).join('');
  $('#qProj').innerHTML = opt('', 'No project', '') + PROJECTS.filter(p => p.area === q.area).map(p => opt(p.id, esc(p.name), '')).join('');
  $('#qDue').innerHTML = [[0,'Today'],[1,'Tomorrow'],[7,'Next week'],['','No date']].map(([v, l]) => `<button data-act="qset" data-k="due" data-v="${v}" aria-pressed="${String(q.due ?? '') === String(v)}">${l}</button>`).join('');
  $('#qWho').innerHTML = [['jarrod','Me'],['jalea','Jalea']].map(([v, l]) => `<button data-act="qset" data-k="who" data-v="${v}" aria-pressed="${q.who === v}">${l}</button>`).join('');
}
async function addTask(o) {
  try { const r = await api('POST', '/api/app/tasks', wire(o)); const t = normTask(r.task); TASKS.push(t); lastArea = t.area; LS.set('area', lastArea); render(); return t; }
  catch (e) { toast('Couldn\'t add that. ' + e.message); return null; }
}

// ---------- actions ----------
const ACT = {
  who: v => { who = v; LS.set('who', v); if (v === 'jalea' && view === 'waiting') view = 'board'; renderBrief(); renderNotifs(); render(); },
  view: v => { view = v; renderTabs(); renderView(); },
  mode: v => renderBrief(v),
  brief: () => { const b = $('#brief'), o = b.dataset.open !== 'true'; b.dataset.open = o; $('#briefMore').textContent = o ? 'Hide details' : 'Show details'; },
  area: v => { const el = $(`[data-act=area][data-v="${v}"]`).parentElement; openAreas[v] = el.dataset.open !== 'true'; LS.set('open', openAreas); renderSide(); },
  addproj: (v, el) => { const i = document.createElement('input'); i.className = 'addp-in'; i.placeholder = 'Project name, then Enter'; i.setAttribute('aria-label', 'New project name'); el.replaceWith(i); i.focus();
    i.onkeydown = async e => { if (e.key === 'Escape') renderSide(); if (e.key !== 'Enter' || !i.value.trim()) return; i.disabled = true;
      try { const r = await api('POST', '/api/app/projects', { name:i.value.trim(), area:v }); PROJECTS.push(r.project); toast('Project added'); } catch (err) { toast('Couldn\'t add that. ' + err.message); } renderSide(); };
    i.onblur = () => setTimeout(() => { if (!i.disabled) renderSide(); }, 150); },
  tab: v => { if (v === 'meetings') { document.body.dataset.tab = 'today'; setPage('meetings'); } else { document.body.dataset.tab = v; if (v === 'today') setPage('home'); else markTabs(); } scrollTo(0, 0); },
  page: v => { if (calMode === 'week') { calMode = 'day'; document.body.dataset.cal = 'day'; renderCal(); } closeAll(); document.body.dataset.tab = 'today'; setPage(v); scrollTo(0, 0); },
  calmode: v => { calMode = v; document.body.dataset.cal = v; renderCal(); ensureEvents(); },
  calnav: v => { calStart = +v === 0 ? 0 : calStart + (+v) * (calMode === 'week' ? 7 : 1); renderCal(); ensureEvents(); },
  evlink: v => window.open(v, '_blank', 'noopener'),
  bell: () => { const o = !$('#notif').classList.contains('show'); closeAll(); if (o) { renderNotifs(); $('#notif').classList.add('show'); $('#scrim').classList.add('show'); } },
  markread: () => { LS.set('read', buildNotifs().map(n => n.id)); renderNotifs(); },
  nopen: v => openDetail(v),
  nview: v => { closeAll(); ACT.tab('today'); ACT.view(v); },
  close: closeAll,
  search: () => { closeAll(); $('#sInput').value = ''; renderSearch(); $('#search').classList.add('show'); $('#scrim').classList.add('show'); setTimeout(() => $('#sInput').focus(), 60); },
  sproj: v => { const p = PROJECTS.find(x => x.id === v); openAreas[p.area] = true; closeAll(); renderSide(); if (phone.matches) ACT.tab('projects'); toast(`${p.name} is under ${an(p.area)}`); },
  new: () => { closeAll(); q.area = lastArea; q.due = 0; q.who = who === 'jalea' ? 'jalea' : 'jarrod'; $('#qTitle').value = ''; $('#qBoard').checked = true; renderQa(); $('#qa').classList.add('show'); $('#scrim').classList.add('show'); setTimeout(() => $('#qTitle').focus(), 60); },
  qset: (v, el) => { const k = el.dataset.k; q[k] = k === 'due' ? (v === '' ? null : +v) : v; if (k === 'due') $('#qBoard').checked = q.due === 0; renderQa(); },
  qadd: async () => { const title = $('#qTitle').value.trim(); if (!title) { $('#qTitle').focus(); return; } closeAll();
    if (await addTask({ title, area:q.area, proj:$('#qProj').value || null, due:q.due, who:q.who, board:$('#qBoard').checked ? 'todo' : 'none' })) toast('Task added'); },
  check: (v, el) => { const t = byId(el.dataset.id), was = t.board, wasDone = t.done; setBoard(t, 'done'); render();
    toast(t.owner ? 'Marked as received' : t.repeat ? `Done. The next one is due in a ${t.repeat === 'daily' ? 'day' : t.repeat === 'weekly' ? 'week' : 'month'}` : 'Marked done', t.repeat ? null : () => { setBoard(t, wasDone ? 'done' : was); render(); }); },
  addtoday: (v, el) => { setBoard(byId(el.dataset.id), 'todo'); render(); toast('Added to today\'s board'); },
  assign: v => { const t = cur(); t.who = v; save(t, { who:v }); render(); },
  'd-doing': () => { setBoard(cur(), 'doing'); render(); toast('Moved to Doing'); },
  'd-done': () => { setBoard(cur(), 'done'); render(); toast('Marked done'); },
  'd-claude': () => { $('#dInput').value = '@Claude '; $('#dInput').focus(); toast('Tell Claude what you need, then press Comment'); },
  block: () => { const t = cur(); if (!t.block) { t.block = defaultBlock(); save(t, { block:t.block }); toast(`Blocked ${tmLong(t.block.start)} today${S.connections.calendar ? ' on your calendar' : ''}`); } render(); const el = $('#dBody [data-f=bstart]'); if (el) el.scrollIntoView({ block:'center' }); },
  unblock: () => { const t = cur(); t.block = null; save(t, { block:null }); render(); toast('Time block removed'); },
  delete: async () => { const t = cur(), i = TASKS.indexOf(t); TASKS.splice(i, 1); closeAll(); render();
    try { await api('DELETE', '/api/app/tasks/' + t.id); toast('Task deleted', async () => { try { const r = await api('POST', `/api/app/tasks/${t.id}/restore`); TASKS.splice(i, 0, normTask(r.task)); render(); } catch (e) { toast('Couldn\'t undo. ' + e.message); } }); }
    catch (e) { TASKS.splice(i, 0, t); render(); toast('Couldn\'t delete. ' + e.message); } },
  attach: v => { fileTarget = v; $('#fileInput').click(); },
  mention: () => { const i = $('#dInput'); i.value = (i.value ? i.value.trim() + ' ' : '') + '@Claude '; i.focus(); },
  comment: async () => { const i = $('#dInput'), text = i.value.trim(), t = cur(), btn = $('#commentBtn'); if (!t || (!text && !pending.length)) return;
    btn.disabled = true;
    try { const r = await api('POST', `/api/tasks/${t.id}/comments`, { body:text, attachmentIds:pending.map(f => f.id) }); i.value = ''; pending = []; renderPending();
      if (r.queued) t.claude = 'working'; toast(r.queued ? 'Handed to Claude' : 'Comment added'); await loadThread(t.id); if (r.queued) render(); }
    catch (e) { toast('Comment didn\'t post. ' + e.message); }
    btn.disabled = false; },
  approve: () => { const t = cur(); t.claude = null; save(t, { approve:true }).then(() => loadThread(t.id)); render(); toast('Approved. It\'s yours to send.'); },
  sendback: () => { const i = $('#dInput'); i.value = '@Claude '; i.focus(); toast('Tell Claude what to change, then press Comment'); },
  meeting: async v => { const m = MEETINGS.find(x => x.id === v); if (!m) return; const items = openItems(m);
    const recaps = list => list.map(r => `<div class="rc"><b>${esc(recapDate(r.date))}</b>${r.url ? ` <a class="linkbtn" href="${esc(r.url)}" target="_blank" rel="noopener" style="text-decoration:none">Open Doc</a>` : ''}<p>${esc(r.summary || r.title || '')}</p></div>`).join('') || '<div class="none">No recaps yet</div>';
    showInfo(`<i style="background:${ac(m.area)}"></i>${esc(an(m.area))} / Meeting`, `<h2>${esc(m.title)}</h2>
      <dl class="fields"><dt>When</dt><dd>${esc(m.when)}</dd>${m.people ? `<dt>People</dt><dd>${esc(m.people)}</dd>` : ''}
      <dt>Area</dt><dd><select data-m="${m.id}" aria-label="Area">${S.areas.map(a => opt(a.id, esc(a.name), m.area)).join('')}</select></dd>
      <dt>Recap folder</dt><dd>${esc(m.folderPath || (m.folderId ? 'Folder set' : 'Default folder'))}<button class="linkbtn" data-act="mfolder" data-v="${m.id}">Change</button></dd>
      <dt>Write recaps</dt><dd><button class="switch" role="switch" aria-checked="${m.on}" data-act="mrec" data-v="${m.id}" aria-label="Write recaps for this meeting"></button></dd></dl>
      <h3 class="d-sec">Recaps</h3><div id="mRecaps">${recaps(m.recaps)}</div>
      <h3 class="d-sec" style="margin-top:18px">Open action items</h3>${items.map(t => { const d = dueInfo(t); return `<div class="row" data-id="${t.id}" style="--c:${ac(t.area)}"><span></span><div><div class="t">${esc(t.title)}</div><div class="m"><span>${t.owner ? esc(t.owner) : NAMES[t.who] || 'You'}</span></div></div><span class="due ${d ? d.cls : ''}">${d ? d.label : ''}</span><span></span></div>`; }).join('') || '<div class="none">Nothing open from this meeting</div>'}`);
    try { const r = await api('GET', `/api/app/meetings/${m.id}/recaps`); if ($('#mRecaps') && $('#info').classList.contains('show')) $('#mRecaps').innerHTML = recaps(r.recaps); } catch {} },
  mrec: async v => { const m = MEETINGS.find(x => x.id === v); m.on = !m.on; renderPage(); ACT.meeting(v);
    try { await api('PATCH', '/api/app/meetings/' + v, { on:m.on }); toast(m.on ? 'Recaps on for this meeting' : 'Recaps off for this meeting'); } catch (e) { m.on = !m.on; toast('That didn\'t save. ' + e.message); } },
  mfolder: v => { const m = MEETINGS.find(x => x.id === v); pickFolder(`Recaps for ${m.title} will be filed here.`, async (id, path) => { m.folderId = id; m.folderPath = path; renderPage(); ACT.meeting(v);
    try { await api('PATCH', '/api/app/meetings/' + v, { folderId:id, folderPath:path }); toast('Recap folder changed'); } catch (e) { toast('That didn\'t save. ' + e.message); } }); },
  pickdefault: () => pickFolder('Recaps for meetings with no folder of their own will be filed here.', async (id, path) => { S.settings.defaultFolder = { id, path }; closeAll(); renderPage();
    try { await api('PUT', '/api/app/settings', { defaultFolder:{ id, path } }); toast('Default folder changed'); } catch (e) { toast('That didn\'t save. ' + e.message); } }),
  fptoggle: (v, el) => { const n = el.closest('.fnode'); n.dataset.open = n.dataset.open !== 'true'; },
  fppick: (v, el) => { $('#fp').classList.remove('show'); if (fpDone) fpDone(v, el.dataset.path); },
  fpclose: () => { $('#fp').classList.remove('show'); if (!$('#info').classList.contains('show')) $('#scrim').classList.remove('show'); },
  autostart: async () => { S.settings.autostart = !S.settings.autostart; renderPage(); try { await api('PUT', '/api/app/settings', { autostart:S.settings.autostart }); toast(S.settings.autostart ? 'Claude will start on recap action items' : 'Claude will wait for you to hand tasks over'); } catch (e) { S.settings.autostart = !S.settings.autostart; renderPage(); toast('That didn\'t save. ' + e.message); } },
  granola: async () => { toast('Checking Granola'); try { const r = await api('POST', '/api/granola/sync', { force:true }); const n = k => (r.results || []).filter(x => x.status === k).length;
    toast(`${n('processed')} filed, ${n('queued')} queued for Claude${r.waiting_on_claude ? `, ${r.waiting_on_claude} waiting` : ''}`); refresh(true); } catch (e) { toast('Granola check failed. ' + e.message); } },
  signout: async () => { await fetch('/api/logout', { method:'POST', credentials:'same-origin' }).catch(() => {}); location.href = '/login.html'; },
  retry: () => location.reload()
};
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (a && ACT[a.dataset.act]) { ACT[a.dataset.act](a.dataset.v, a, e); return; }
  const c = e.target.closest('.ev.block,.arow.block,.card,.ptask,.row'); if (c && c.dataset.id && !e.target.closest('.rz')) openDetail(c.dataset.id);
});
document.addEventListener('keydown', async e => {
  if (e.key === 'Escape') closeAll();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Enter' && e.target.id === 'quick' && e.target.value.trim()) { const title = e.target.value.trim(); e.target.value = ''; if (await addTask({ title, area:lastArea, due:0, board:'todo' })) { toast(`Added to ${an(lastArea)}`); setTimeout(() => $('#quick') && $('#quick').focus(), 0); } }
  else if (e.key === 'Enter' && e.target.id === 'qTitle') ACT.qadd();
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'dInput') ACT.comment();
  else if ((e.key || '').toLowerCase() === 'n' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); ACT.new(); }
  else if (e.key === '/' && !typing) { e.preventDefault(); ACT.search(); }
});
$('#fileInput').onchange = async () => { const t = cur(), fi = $('#fileInput'), files = [...fi.files]; fi.value = ''; if (!t || !files.length) return;
  toast(`Uploading ${files.length === 1 ? files[0].name : files.length + ' files'}`);
  for (const f of files) { try { const up = await uploadFile(t, f, fileTarget === 'comment'); if (fileTarget === 'comment') { pending.push(up); renderPending(); } } catch (e) { toast(e.message); return; } }
  if (fileTarget === 'task') { await loadThread(t.id); toast('File attached'); } else toast('File added to your comment'); };

// ---------- drag, drop, resize ----------
document.addEventListener('dragstart', e => { const el = e.target.closest && e.target.closest('[draggable=true][data-id]'); if (!el) return;
  drag = { id:el.dataset.id, kind:el.classList.contains('block') ? 'block' : 'task' }; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', el.dataset.id); });
document.addEventListener('dragend', () => { drag = null; $$('.dragging,.over').forEach(x => x.classList.remove('dragging', 'over')); });
document.addEventListener('dragover', e => { const z = e.target.closest('.col,.dbody'); if (!z || !drag || (z.classList.contains('col') && drag.kind !== 'task')) return;
  e.preventDefault(); $$('.over').forEach(x => x !== z && x.classList.remove('over')); z.classList.add('over'); });
document.addEventListener('drop', e => { const z = e.target.closest('.col,.dbody'); if (!z || !drag) return; e.preventDefault(); const t = byId(drag.id); drag = null; if (!t) return;
  if (z.classList.contains('col')) { if (t.board !== z.dataset.col || (z.dataset.col === 'done') !== isDone(t)) { setBoard(t, z.dataset.col); toast(z.dataset.col === 'done' ? 'Marked done' : 'Moved to ' + (z.dataset.col === 'todo' ? 'To do' : 'Doing')); } }
  else { const r = z.getBoundingClientRect(), d = +z.dataset.d, start = START * 60 + Math.max(0, Math.min((END - START) * 60 - 30, Math.floor((e.clientY - r.top) / H * 2) * 30));
    t.block = { d, start, dur:t.block ? t.block.dur : 60, work:t.block ? t.block.work : true }; save(t, { block:t.block });
    toast(`Blocked ${tmLong(start)} ${d === 0 ? 'today' : dayName(d)}${t.block.work && S.connections.calendar ? ' on your calendar' : ''}`); }
  render(); });
document.addEventListener('mousedown', e => { const hnd = e.target.closest('.rz'); if (!hnd) return; e.preventDefault();
  const el = hnd.parentElement, t = byId(el.dataset.id), y0 = e.clientY, d0 = t.block.dur; resizing = true;
  const mv = ev => { t.block.dur = Math.max(15, Math.round((d0 + (ev.clientY - y0) / H * 60) / 15) * 15); el.style.height = (t.block.dur / 60 * H - 3) + 'px'; };
  const up = () => { resizing = false; removeEventListener('mousemove', mv); removeEventListener('mouseup', up); if (t.block.dur !== d0) { save(t, { block:t.block }); toast('Block is now ' + durLabel(t.block.dur)); } render(); };
  addEventListener('mousemove', mv); addEventListener('mouseup', up); });

// ---------- start ----------
async function start() {
  try { ingest(await api('GET', '/api/app/state')); }
  catch (e) { if (e.message === 'Signed out') return; $('#bootMsg').innerHTML = `The dashboard couldn't load. ${esc(e.message)}<br><button class="mini" data-act="retry">Try again</button><a class="mini" href="/classic.html" style="text-decoration:none;color:inherit">Open the classic view</a>`; return; }
  if (!CLAUDE_TASKS) $('#viewHint').textContent = ''; else { $('#viewHint').textContent = 'Mention @Claude in a comment to hand a task off'; $('#mentionBtn').hidden = false; $('#dInput').placeholder = 'Add a comment. Mention @Claude to hand it off.'; }
  delete document.body.dataset.boot;
  ACT.tab('today'); renderBrief(nowMin() >= hhmm(S.settings.wrap) ? 'pm' : 'am'); renderNotifs(); render();
  phone.addEventListener('change', renderCal);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - loadedAt > 60000) refresh(); });
  setInterval(() => { if (!document.hidden) { if (Date.now() - loadedAt > 300000) refresh(); else if (!drag && !resizing) renderCal(); } }, 60000);
}
start();
})();
