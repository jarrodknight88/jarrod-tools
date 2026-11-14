// Server side of the redesigned dashboard (Nov 2026): one state read plus small, targeted writes.
// The classic page still uses loadState/saveState in db.mjs; nothing here depends on that whole-document save.
import { db, todayIn, tzParts, zonedToIso } from './db.mjs';
import { accessToken, rangeEvents, folderTree, folderFiles, upsertBlockEvent, deleteBlockEvent, globMatch, tokenScopes } from './google.mjs';

const fail = r => { if (r.error) throw new Error(r.error.message); return r; };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const NAMES = { jarrod: 'Jarrod', jalea: 'Jalea' };
const REPEATS = ['daily', 'weekly', 'monthly'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// A task's "owner" is who committed to it. When that is someone else, the dashboard shows it under Waiting on.
const isSelf = o => !o || /^(jarrod|jalea)\b/i.test(String(o).trim());
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const fmt12 = t => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };

async function config(s) {
  const { data } = fail(await s.from('settings').select('key,value').in('key', ['timezone', 'briefing_wrap', 'default_recap_folder', 'granola_last_run', 'claude_autostart']));
  const cfg = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  return { cfg, tz: cfg.timezone || 'America/New_York' };
}

// ---- Google status (token + whether Drive writes are approved), cached briefly ----
let scopeCache = { at: 0, token: null, drive: false };
async function googleStatus() {
  if (globalThis.__ccTest && globalThis.__ccTest.google) return globalThis.__ccTest.google; // local test harness only
  const configured = !!Netlify.env.get('GOOGLE_CLIENT_ID');
  let token = null;
  try { token = configured ? await accessToken() : null; } catch { token = null; }
  let drive = false;
  if (token) {
    if (scopeCache.token === token && Date.now() - scopeCache.at < 600000) drive = scopeCache.drive;
    else { try { drive = (await tokenScopes(token)).includes('https://www.googleapis.com/auth/drive.file'); scopeCache = { at: Date.now(), token, drive }; } catch { drive = false; } }
  }
  return { configured, token, drive };
}

// ---- shaping rows for the client ----
function taskOut(t, c) {
  let block = null;
  if (t.block_start) { const p = tzParts(new Date(t.block_start), c.tz); block = { date: p.date, start: p.minutes, dur: t.block_dur_min || 30, work: t.block_on_calendar !== false }; }
  const doneToday = !!t.done && !!t.done_at && tzParts(new Date(t.done_at), c.tz).date === c.today;
  // Unfinished board tasks carry over from day to day; finished ones show in Done only on the day they were finished.
  const board = t.done ? (doneToday ? 'done' : 'none') : (['todo', 'doing'].includes(t.board) ? t.board : 'none');
  return {
    id: t.id, title: t.title, area: t.area_id, proj: (c.projBy[t.id] || [])[0] || null, meeting: (c.meetBy[t.id] || [])[0] || null,
    who: t.assignee || 'jarrod', owner: isSelf(t.owner) ? null : t.owner, due: t.due_date || null, board,
    carried: board !== 'none' && !t.done && !!t.board_date && t.board_date < c.today,
    done: !!t.done, doneAt: t.done_at || null, block, claude: t.claude_status === 'needs_review' ? 'review' : t.claude_status ? 'working' : null,
    repeat: t.repeat || '', notes: t.notes || '', source: t.source, comments: c.cc[t.id] || 0, files: c.fc[t.id] || 0, created: t.created_at
  };
}
function whenLabel(m) {
  if (m.one_off) return m.one_off_date ? 'One-off on ' + m.one_off_date : 'One-off';
  const d = [...(m.days || [])].sort();
  let days = '';
  if (d.join() === '1,2,3,4,5') days = 'Weekdays'; else if (d.length === 7) days = 'Every day'; else if (d.length === 1) days = FULL[d[0]] + 's'; else if (d.length) days = d.map(x => DOW[x]).join(', ');
  const time = m.default_time ? 'at ' + fmt12(m.default_time) : '';
  return [days || m.cadence || '', time].filter(Boolean).join(' ') || 'No set time';
}
const recapOut = r => ({ date: r.meeting_date, summary: r.summary || '', url: r.drive_url, title: r.title });
const groupBy = (rows, k, v) => rows.reduce((o, r) => ((o[r[k]] ||= []).push(r[v]), o), {});
const countBy = rows => rows.reduce((o, r) => (o[r.task_id] = (o[r.task_id] || 0) + 1, o), {});

async function eventsFor(token, tz, start, days, meetings) {
  const test = globalThis.__ccTest && globalThis.__ccTest.events;
  const evs = test ? test(start, days) : await rangeEvents(token, tz, start, days);
  const match = (m, title) => (m.match_pattern && globMatch(m.match_pattern, title)) || (m.title || '').trim().toLowerCase() === (title || '').trim().toLowerCase();
  return evs.map(e => { const m = meetings.find(x => match(x, e.title));
    return { id: e.eventId, date: e.date, start: e.startMin, dur: e.dur, title: e.title, meeting: m ? m.id : null, area: m ? m.area_id : null, people: e.attendees || [], link: e.link || null }; });
}

// ---- read ----
export async function loadApp({ start, days = 7 } = {}) {
  const s = db();
  const { cfg, tz } = await config(s);
  const today = todayIn(tz);
  const res = await Promise.all([
    s.from('areas').select('*').order('sort_order'),
    s.from('projects').select('id,name,area_id,sort_order,created_at').eq('active', true).order('sort_order').order('created_at'),
    s.from('tasks').select('*').is('deleted_at', null).order('created_at'),
    s.from('task_projects').select('task_id,project_id'),
    s.from('task_meetings').select('task_id,meeting_id'),
    s.from('meetings').select('*').eq('active', true).order('sort_order').order('title'),
    s.from('recaps').select('id,meeting_id,meeting_date,summary,drive_url,title').order('meeting_date', { ascending: false }),
    s.from('task_comments').select('task_id'),
    s.from('task_attachments').select('task_id'),
    s.from('claude_queue').select('kind,status')
  ]);
  res.forEach(fail);
  const [areas, projects, tasks, tp, tm, meetings, recaps, comments, files, queue] = res.map(r => r.data || []);

  const ctx = { tz, today, projBy: groupBy(tp, 'task_id', 'project_id'), meetBy: groupBy(tm, 'task_id', 'meeting_id'), cc: countBy(comments), fc: countBy(files) };
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString(); // finished tasks older than this stay in the database but aren't sent
  const recapsBy = {};
  for (const r of recaps) (recapsBy[r.meeting_id] ||= []).push(recapOut(r));

  const warnings = [];
  const google = await googleStatus();
  const from = DATE.test(start || '') ? start : today;
  const events = (google.token || (globalThis.__ccTest && globalThis.__ccTest.events))
    ? await eventsFor(google.token, tz, from, clamp(days || 7, 1, 31), meetings).catch(e => { warnings.push('Calendar: ' + e.message); return []; }) : [];

  const last = cfg.granola_last_run || null;
  return {
    today, tz, me: 'jarrod', warnings,
    areas: areas.map(a => ({ id: a.id, name: a.name, color: a.color })),
    projects: projects.map(p => ({ id: p.id, name: p.name, area: p.area_id })),
    tasks: tasks.filter(t => !t.done || !t.done_at || t.done_at > cutoff).map(t => taskOut(t, ctx)),
    meetings: meetings.map(m => ({ id: m.id, title: m.title, area: m.area_id, when: whenLabel(m), people: (m.attendees || []).join(', '), on: !m.exclude_from_recaps,
      folderId: m.recap_folder_id && !m.recap_folder_id.startsWith('ph:') ? m.recap_folder_id : null, folderPath: m.recap_folder_path || null, recaps: (recapsBy[m.id] || []).slice(0, 5) })),
    events, eventsFrom: from, eventsDays: clamp(days || 7, 1, 31),
    connections: {
      googleConfigured: google.configured, calendar: !!google.token, drive: google.drive,
      granola: { configured: !!Netlify.env.get('GRANOLA_API_KEY'), lastRun: last ? last.at : null, lastLog: last ? (last.error ? [last.error] : (last.log || []).slice(-3)) : [] },
      claude: { waiting: queue.filter(q => q.kind === 'recap' && ['pending', 'working'].includes(q.status)).length, unfiled: queue.filter(q => q.kind === 'recap' && q.status === 'ready').length,
        tasks: queue.filter(q => q.kind === 'task' && ['pending', 'working'].includes(q.status)).length }
    },
    settings: { wrap: typeof cfg.briefing_wrap === 'string' ? cfg.briefing_wrap : '16:00', defaultFolder: cfg.default_recap_folder || null, autostart: cfg.claude_autostart !== false }
  };
}

// Calendar events for another run of days (the calendar's Earlier / Later buttons).
export async function loadEvents({ start, days = 7 } = {}) {
  const s = db();
  const { tz } = await config(s);
  if (!DATE.test(start || '')) throw bad('start must be a date');
  const google = await googleStatus();
  const hasTest = globalThis.__ccTest && globalThis.__ccTest.events;
  if (!google.token && !hasTest) return { events: [], eventsFrom: start, eventsDays: days };
  const meetings = fail(await s.from('meetings').select('id,title,match_pattern,area_id').eq('active', true)).data || [];
  return { events: await eventsFor(google.token, tz, start, clamp(days || 7, 1, 31), meetings), eventsFrom: start, eventsDays: clamp(days || 7, 1, 31) };
}

async function oneTask(s, id, tz, today) {
  const t = fail(await s.from('tasks').select('*').eq('id', id).maybeSingle()).data;
  if (!t) return null;
  const [tp, tm, c, f] = await Promise.all([
    s.from('task_projects').select('task_id,project_id').eq('task_id', id), s.from('task_meetings').select('task_id,meeting_id').eq('task_id', id),
    s.from('task_comments').select('task_id').eq('task_id', id), s.from('task_attachments').select('task_id').eq('task_id', id)
  ]);
  [tp, tm, c, f].forEach(fail);
  return taskOut(t, { tz, today, projBy: groupBy(tp.data || [], 'task_id', 'project_id'), meetBy: groupBy(tm.data || [], 'task_id', 'meeting_id'), cc: countBy(c.data || []), fc: countBy(f.data || []) });
}

// ---- tasks ----
export async function createTask(b = {}) {
  const s = db();
  const { tz } = await config(s);
  const today = todayIn(tz);
  const title = String(b.title || '').trim().slice(0, 500);
  if (!title) throw bad('A task needs a title');
  const who = b.who === 'jalea' ? 'jalea' : 'jarrod';
  const board = ['todo', 'doing'].includes(b.board) ? b.board : 'none';
  const t = fail(await s.from('tasks').insert({
    title, area_id: b.area || 'cardshq', assignee: who, owner: String(b.owner || '').trim().slice(0, 120) || NAMES[who], due_date: DATE.test(b.due || '') ? b.due : null,
    board, board_date: board === 'none' ? null : today, notes: String(b.notes || '').slice(0, 20000) || null, repeat: REPEATS.includes(b.repeat) ? b.repeat : null, source: 'manual'
  }).select('*').single()).data;
  if (b.proj) fail(await s.from('task_projects').insert({ task_id: t.id, project_id: b.proj }));
  if (b.meeting) fail(await s.from('task_meetings').insert({ task_id: t.id, meeting_id: b.meeting }));
  return { task: await oneTask(s, t.id, tz, today) };
}

// Mirror a task's time block to Google Calendar. Never blocks a save; returns the event id to store.
async function mirrorBlock(was, t) {
  let token = null;
  try { token = Netlify.env.get('GOOGLE_CLIENT_ID') ? await accessToken() : null; } catch { token = null; }
  if (!token) return was.calendar_event_id || null;
  try {
    if (t.block_start && t.block_on_calendar !== false && !t.deleted_at) return await upsertBlockEvent(token, { eventId: was.calendar_event_id, title: t.title, startIso: t.block_start, durMin: t.block_dur_min, taskId: t.id, done: !!t.done });
    if (was.calendar_event_id) await deleteBlockEvent(token, was.calendar_event_id);
    return null;
  } catch (e) { console.error('block mirror', t.id, e.message); return was.calendar_event_id || null; }
}

function nextDue(from, repeat, today) {
  const step = ymd => {
    if (repeat === 'daily') return addDays(ymd, 1);
    if (repeat === 'weekly') return addDays(ymd, 7);
    const [y, m, d] = ymd.split('-').map(Number); const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  };
  let n = step(from || today);
  for (let i = 0; n <= today && i < 400; i++) n = step(n);
  return n;
}

export async function patchTask(id, b = {}) {
  const s = db();
  const { tz } = await config(s);
  const today = todayIn(tz), now = new Date().toISOString();
  const was = fail(await s.from('tasks').select('*').eq('id', id).is('deleted_at', null).maybeSingle()).data;
  if (!was) return null;
  const u = {};
  if ('title' in b) { const t = String(b.title || '').trim().slice(0, 500); if (t) u.title = t; }
  if ('notes' in b) u.notes = String(b.notes || '').slice(0, 20000) || null;
  if ('area' in b && b.area) u.area_id = b.area;
  if ('who' in b) { u.assignee = b.who === 'jalea' ? 'jalea' : 'jarrod'; if (isSelf(was.owner) && !('owner' in b)) u.owner = NAMES[u.assignee]; }
  if ('owner' in b) u.owner = String(b.owner || '').trim().slice(0, 120) || NAMES[u.assignee || was.assignee || 'jarrod'];
  if ('due' in b) u.due_date = DATE.test(b.due || '') ? b.due : null;
  if ('repeat' in b) u.repeat = REPEATS.includes(b.repeat) ? b.repeat : null;
  let finishing = false;
  if ('board' in b && ['none', 'todo', 'doing', 'done'].includes(b.board)) {
    const done = b.board === 'done';
    u.board = b.board; u.board_date = b.board === 'none' ? null : today; u.done = done; u.done_at = done ? (was.done && was.done_at ? was.done_at : now) : null;
    finishing = done && !was.done;
    if (finishing && was.claude_status) u.claude_status = null;
  }
  if ('block' in b) {
    if (b.block && DATE.test(b.block.date || '')) {
      u.block_start = zonedToIso(b.block.date, clamp(Math.round(+b.block.start) || 0, 0, 1425), tz);
      u.block_dur_min = clamp(Math.round(+b.block.dur) || 60, 15, 720); u.block_on_calendar = b.block.work !== false;
    } else { u.block_start = null; u.block_dur_min = null; }
  }
  const approving = !!b.approve && was.claude_status === 'needs_review';
  if (approving) u.claude_status = null;

  const merged = { ...was, ...u };
  if ('block' in b || ((u.title !== undefined || u.done !== undefined) && was.block_start)) u.calendar_event_id = await mirrorBlock(was, merged);
  if (Object.keys(u).length) fail(await s.from('tasks').update(u).eq('id', id));
  if ('proj' in b) {
    fail(await s.from('task_projects').delete().eq('task_id', id));
    if (b.proj) fail(await s.from('task_projects').insert({ task_id: id, project_id: b.proj }));
  }
  if (approving) fail(await s.from('task_comments').insert({ task_id: id, author: 'system', body: `${NAMES[was.assignee] || 'Jarrod'} approved Claude's draft.` }));

  // A repeating task leaves its next occurrence behind when it's finished.
  let next = null;
  if (finishing && merged.repeat) {
    const n = fail(await s.from('tasks').insert({ title: merged.title, area_id: merged.area_id, assignee: merged.assignee, owner: merged.owner, notes: merged.notes, repeat: merged.repeat,
      due_date: nextDue(merged.due_date, merged.repeat, today), source: 'manual', urgency: merged.urgency }).select('*').single()).data;
    const [tp, tm] = await Promise.all([s.from('task_projects').select('project_id').eq('task_id', id), s.from('task_meetings').select('meeting_id').eq('task_id', id)]);
    if ((tp.data || []).length) fail(await s.from('task_projects').insert(tp.data.map(r => ({ task_id: n.id, project_id: r.project_id }))));
    if ((tm.data || []).length) fail(await s.from('task_meetings').insert(tm.data.map(r => ({ task_id: n.id, meeting_id: r.meeting_id }))));
    next = await oneTask(s, n.id, tz, today);
  }
  return { task: await oneTask(s, id, tz, today), next };
}

export async function deleteTask(id) {
  const s = db();
  const was = fail(await s.from('tasks').select('*').eq('id', id).is('deleted_at', null).maybeSingle()).data;
  if (!was) return null;
  const u = { deleted_at: new Date().toISOString() };
  if (was.calendar_event_id) u.calendar_event_id = await mirrorBlock(was, { ...was, ...u });
  fail(await s.from('tasks').update(u).eq('id', id));
  return { ok: true };
}

export async function restoreTask(id) {
  const s = db();
  const { tz } = await config(s);
  const was = fail(await s.from('tasks').select('*').eq('id', id).maybeSingle()).data;
  if (!was) return null;
  const u = { deleted_at: null };
  if (was.block_start) u.calendar_event_id = await mirrorBlock(was, { ...was, ...u });
  fail(await s.from('tasks').update(u).eq('id', id));
  return { task: await oneTask(s, id, tz, todayIn(tz)) };
}

// ---- projects, meetings, settings ----
export async function createProject(b = {}) {
  const s = db();
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw bad('A project needs a name');
  const p = fail(await s.from('projects').insert({ name, area_id: b.area || 'cardshq', sort_order: 99 }).select('id,name,area_id').single()).data;
  return { project: { id: p.id, name: p.name, area: p.area_id } };
}

export async function patchMeeting(id, b = {}) {
  const s = db();
  const u = {};
  if ('area' in b && b.area) u.area_id = b.area;
  if ('on' in b) u.exclude_from_recaps = !b.on;
  if ('folderId' in b) { u.recap_folder_id = b.folderId || null; u.recap_folder_path = b.folderId ? String(b.folderPath || '').slice(0, 500) || null : null; }
  if (!Object.keys(u).length) throw bad('Nothing to change');
  const r = fail(await s.from('meetings').update(u).eq('id', id).select('id'));
  return (r.data || []).length ? { ok: true } : null;
}

// Recap history for one meeting: recaps this app filed, plus Docs already sitting in its Drive folder.
export async function meetingRecaps(id) {
  const s = db();
  const m = fail(await s.from('meetings').select('*').eq('id', id).maybeSingle()).data;
  if (!m) return null;
  const stored = (fail(await s.from('recaps').select('meeting_date,summary,drive_url,title,drive_file_id').eq('meeting_id', id).order('meeting_date', { ascending: false })).data || []);
  const out = stored.map(recapOut), seen = new Set(stored.map(r => r.drive_file_id));
  const google = await googleStatus();
  if (google.token && m.recap_folder_id && !m.recap_folder_id.startsWith('ph:')) {
    try {
      const STOP = new Set(['weekly', 'daily', 'monthly', 'meeting', 'sync', 'call', 'session', 'with', 'and', 'the', 'team', 'check', 'standup', 'review']);
      const words = (m.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
      const hit = f => { const n = f.name.toLowerCase(); return n.includes((m.title || '').toLowerCase()) || (m.key && n.includes(m.key.toLowerCase())) || words.some(w => n.includes(w)); };
      for (const f of await folderFiles(google.token, m.recap_folder_id)) if (!seen.has(f.id) && (m.recap_mode === 'all' || hit(f))) out.push({ date: f.date, summary: '', url: f.url, title: f.name });
    } catch (e) { console.error('meeting recaps', id, e.message); }
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { recaps: out.slice(0, 30) };
}

export async function folders() {
  const s = db();
  const google = await googleStatus();
  if (google.token) { try { return { tree: await folderTree(google.token) }; } catch (e) { console.error('folders', e.message); } }
  const { data } = await s.from('settings').select('value').eq('key', 'folder_tree_cache').maybeSingle();
  return { tree: (data && data.value && data.value.tree) || { id: 'root', name: 'My Drive', children: [] }, offline: true };
}

export async function saveSettings(b = {}) {
  const s = db();
  if ('wrap' in b) { if (!/^\d{2}:\d{2}$/.test(b.wrap || '')) throw bad('wrap must be HH:MM'); fail(await s.from('settings').upsert({ key: 'briefing_wrap', value: b.wrap }, { onConflict: 'key' })); }
  if ('autostart' in b) fail(await s.from('settings').upsert({ key: 'claude_autostart', value: !!b.autostart }, { onConflict: 'key' }));
  if ('defaultFolder' in b) fail(await s.from('settings').upsert({ key: 'default_recap_folder', value: b.defaultFolder && b.defaultFolder.id ? { id: b.defaultFolder.id, path: String(b.defaultFolder.path || '').slice(0, 500) } : { id: null, path: null } }, { onConflict: 'key' }));
  return { ok: true };
}
