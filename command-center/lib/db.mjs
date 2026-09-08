// Translation layer between the dashboard's client state and the Supabase tables.
// Reads assemble one document the UI renders from; writes reconcile that document back into rows.
import { createClient } from '@supabase/supabase-js';
import { accessToken, todayEvents, folderTree, folderFiles, upsertBlockEvent, deleteBlockEvent, globMatch } from './google.mjs';

export function db() {
  return createClient(Netlify.env.get('SUPABASE_URL'), Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
}

// ---- time zone helpers (blocks are stored as timestamps, the UI thinks in minutes-of-today) ----

function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export function todayIn(tz) { return tzParts(new Date(), tz).date; }

// Convert a local (tz) date + minutes to a UTC ISO string.
function zonedToIso(dateStr, minutes, tz) {
  const guess = new Date(`${dateStr}T00:00:00Z`).getTime() + minutes * 60000;
  const local = tzParts(new Date(guess), tz);
  const localMs = new Date(`${local.date}T00:00:00Z`).getTime() + local.minutes * 60000;
  return new Date(guess - (localMs - guess)).toISOString();
}

const fromMin = mm => { const h = Math.floor(mm / 60), m = mm % 60; return (((h + 11) % 12) + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); };
const to12 = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return (((h + 11) % 12) + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); };
const to24 = t => { if (!t) return null; const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i); if (!m) return t.length === 5 ? t : null; let h = +m[1]; if (/pm/i.test(m[3]) && h !== 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0; return String(h).padStart(2, '0') + ':' + m[2]; };

// ---- read ----

export async function loadState() {
  const s = db();
  const [settings, meetings, projects, tasks, tm, tp, recaps, patterns] = await Promise.all([
    s.from('settings').select('key,value'),
    s.from('meetings').select('*').eq('active', true).order('sort_order').order('default_time'),
    s.from('projects').select('*').eq('active', true).order('sort_order').order('created_at'),
    s.from('tasks').select('*').order('created_at'),
    s.from('task_meetings').select('task_id,meeting_id'),
    s.from('task_projects').select('task_id,project_id'),
    s.from('recaps').select('*').order('meeting_date', { ascending: false }),
    s.from('recap_patterns').select('*').order('priority')
  ]);
  for (const r of [settings, meetings, projects, tasks, tm, tp, recaps, patterns]) if (r.error) throw new Error(r.error.message);

  const cfg = Object.fromEntries(settings.data.map(r => [r.key, r.value]));
  const tz = cfg.timezone || 'America/New_York';
  const today = todayIn(tz);

  const recapsByMeeting = {};
  for (const r of recaps.data) (recapsByMeeting[r.meeting_id] ||= []).push({ id: r.id, fileId: r.drive_file_id, date: r.meeting_date, summary: r.summary || '', url: r.drive_url, title: r.title });

  // ---- Google layer (Calendar events for today, Drive folders and recap files) ----
  const googleConfigured = !!Netlify.env.get('GOOGLE_CLIENT_ID');
  const token = googleConfigured ? await accessToken().catch(() => null) : null;
  let events = [], tree = null, warnings = [];
  const filesByMeeting = {};
  if (token) {
    const mapped = meetings.data.filter(m => m.recap_folder_id && !m.recap_folder_id.startsWith('ph:'));
    const [ev, tr, ...ff] = await Promise.all([
      todayEvents(token, tz).catch(e => { warnings.push('Calendar: ' + e.message); return []; }),
      folderTree(token).catch(e => { warnings.push('Drive: ' + e.message); return null; }),
      ...mapped.map(m => folderFiles(token, m.recap_folder_id).catch(() => []))
    ]);
    events = ev; tree = tr; mapped.forEach((m, i) => { filesByMeeting[m.id] = ff[i]; });
  }

  const matchesMeeting = (m, title) => (m.match_pattern && globMatch(m.match_pattern, title)) || (m.title || '').trim().toLowerCase() === (title || '').trim().toLowerCase();
  const claimed = new Set();
  const meetingsOut = meetings.data.map(m => {
    const ev = token ? events.find(e => !claimed.has(e.eventId) && matchesMeeting(m, e.title)) : null;
    if (ev) claimed.add(ev.eventId);
    // 'title' mode: a file belongs to this meeting if its name contains the meeting title, the key, or any distinctive word from the title.
    const STOP = new Set(['weekly', 'daily', 'monthly', 'meeting', 'sync', 'call', 'session', 'with', 'and', 'the', 'team', 'check', 'standup', 'review']);
    const words = (m.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
    const nameMatches = f => { const n = f.name.toLowerCase(); return n.includes((m.title || '').toLowerCase()) || (m.key && n.includes(m.key.toLowerCase())) || words.some(w => n.includes(w)); };
    const fromDrive = (filesByMeeting[m.id] || []).filter(f => m.recap_mode === 'all' || nameMatches(f))
      .map(f => ({ id: 'drive:' + f.id, fileId: f.id, date: f.date, summary: f.isDoc ? '' : 'File in recap folder', url: f.url, title: f.name }));
    const stored = recapsByMeeting[m.id] || [];
    const seen = new Set(stored.map(r => r.fileId));
    const allRecaps = [...stored, ...fromDrive.filter(r => !seen.has(r.fileId))].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return {
      id: m.id, key: m.key, title: m.title, type: m.type, cadence: m.cadence || '', time: ev ? fromMin(ev.startMin) : to12(m.default_time && m.default_time.slice(0, 5)), dur: ev ? ev.dur : m.default_dur_min,
      days: m.days || [], oneOff: m.one_off, oneOffDate: m.one_off_date, attendees: ev && ev.attendees.length ? ev.attendees : (m.attendees || []), matchPattern: m.match_pattern || '', exclude: m.exclude_from_recaps,
      onCalendarToday: !!ev, eventLink: ev ? ev.link : null, recaps: allRecaps
    };
  });
  // Calendar events that aren't tracked meetings still show on today's timeline (read-only, not persisted).
  for (const e of events) if (!claimed.has(e.eventId)) meetingsOut.push({ id: 'gcal:' + e.eventId, key: '', title: e.title, type: 'General', cadence: '', time: fromMin(e.startMin), dur: e.dur, days: [], oneOff: true, oneOffDate: today, attendees: e.attendees, matchPattern: '', exclude: false, onCalendarToday: true, ephemeral: true, eventLink: e.link, recaps: [] });

  const mappings = {};
  for (const m of meetings.data) if (m.recap_folder_id) mappings[m.id] = { folder: m.recap_folder_id, mode: m.recap_mode };

  const mById = {}; for (const r of tm.data) (mById[r.task_id] ||= []).push(r.meeting_id);
  const pById = {}; for (const r of tp.data) (pById[r.task_id] ||= []).push(r.project_id);

  const tasksOut = tasks.data.map(t => {
    let block = null;
    if (t.block_start) { const p = tzParts(new Date(t.block_start), tz); if (p.date === today) block = { start: p.minutes, dur: t.block_dur_min || 30 }; }
    return { id: t.id, title: t.title, owner: t.owner, urgency: t.urgency, done: t.done, scope: t.scope, source: t.source, notes: t.notes || '',
      dueDate: t.due_date, dueTime: t.due_time ? t.due_time.slice(0, 5) : null, meetings: mById[t.id] || [], projects: pById[t.id] || [], block };
  });

  const projectsOut = projects.data.map(p => ({ id: p.id, name: p.name, health: p.health, pct: p.pct_baseline, baselineOpen: p.baseline_open_count, milestone: p.milestone || '', date: p.milestone_date || '', update: p.latest_update || '' }));

  return {
    today, tz, googleConfigured, calendarConnected: !!token, warnings,
    meetings: meetingsOut, tasks: tasksOut, projects: projectsOut, tickets: [],
    folderTree: tree || cfg.folder_tree || { id: 'root', name: 'My Drive', children: [] },
    settings: { defaultFolder: (cfg.default_recap_folder || {}).id || null, mappings, patterns: patterns.data.map(p => ({ id: 'p:' + p.id, pattern: p.pattern, folder: p.folder_id, mode: p.mode })) }
  };
}

// ---- write ----

export async function saveState(doc) {
  const s = db();
  const { data: tzRow } = await s.from('settings').select('value').eq('key', 'timezone').single();
  const tz = (tzRow && tzRow.value) || 'America/New_York';
  const today = todayIn(tz);
  const now = new Date().toISOString();
  const fail = r => { if (r.error) throw new Error(r.error.message); return r; };

  // Meetings: upsert incoming; anything missing is deactivated (soft delete).
  if (Array.isArray(doc.meetings)) {
    doc.meetings = doc.meetings.filter(m => !m.ephemeral && !String(m.id).startsWith('gcal:'));
    const rows = doc.meetings.map((m, i) => ({ id: m.id, key: m.key || m.id.slice(0, 8), title: m.title, type: m.type || 'General', cadence: m.cadence || null, default_time: to24(m.time), default_dur_min: m.dur || 30,
      days: m.days || [], one_off: !!m.oneOff, one_off_date: m.oneOff ? (m.oneOffDate || null) : null, attendees: m.attendees || [], match_pattern: m.matchPattern || null, exclude_from_recaps: !!m.exclude, active: true, sort_order: i,
      recap_folder_id: ((doc.settings || {}).mappings || {})[m.id]?.folder || null, recap_mode: ((doc.settings || {}).mappings || {})[m.id]?.mode || 'title' }));
    // Folder mapping is only written when the client actually has an entry for the meeting, so a page that
    // loaded before a mapping was made cannot wipe it.
    const mappings = (doc.settings || {}).mappings || {};
    for (const r of rows) if (!(r.id in mappings)) { delete r.recap_folder_id; delete r.recap_mode; }
    if (rows.length) fail(await s.from('meetings').upsert(rows, { onConflict: 'id' }));
    // Deletions are explicit. A meeting missing from a client's list is never treated as deleted,
    // because another tab or a server-side insert may know about meetings this page never loaded.
    const gone = (doc.deletedMeetings || []).filter(Boolean);
    if (gone.length) fail(await s.from('meetings').update({ active: false }).in('id', gone));
  }

  // Projects
  if (Array.isArray(doc.projects)) {
    const rows = doc.projects.map((p, i) => ({ id: p.id, name: p.name, health: p.health || 'Green', pct_baseline: Math.max(0, Math.min(100, Math.round(p.pct || 0))), baseline_open_count: p.baselineOpen || 0,
      milestone: p.milestone || null, milestone_date: p.date || null, latest_update: p.update || null, active: true, sort_order: i }));
    if (rows.length) fail(await s.from('projects').upsert(rows, { onConflict: 'id' }));
    const gone = (doc.deletedProjects || []).filter(Boolean);
    if (gone.length) fail(await s.from('projects').update({ active: false }).in('id', gone));
  }

  // Tasks + links
  if (Array.isArray(doc.tasks)) {
    const existing = fail(await s.from('tasks').select('id,done,done_at,block_start,block_dur_min,calendar_event_id,title')).data;
    const prev = Object.fromEntries(existing.map(t => [t.id, t]));
    const knownMeetings = new Set(fail(await s.from('meetings').select('id')).data.map(m => m.id));
    const rows = doc.tasks.map(t => {
      const was = prev[t.id];
      return { id: t.id, title: t.title, owner: t.owner || 'Jarrod', urgency: t.urgency || 'soon', done: !!t.done, done_at: t.done ? ((was && was.done_at) || now) : null,
        due_date: t.dueDate || null, due_time: t.dueTime || null, scope: !!t.scope, source: t.source || 'manual', notes: t.notes || null,
        block_start: t.block ? zonedToIso(today, t.block.start, tz) : null, block_dur_min: t.block ? t.block.dur : null, calendar_event_id: was ? was.calendar_event_id : null };
    });
    await syncBlocks(rows, prev);
    if (rows.length) {
      fail(await s.from('tasks').upsert(rows, { onConflict: 'id' }));
      const ids = rows.map(r => r.id);
      fail(await s.from('task_meetings').delete().in('task_id', ids));
      fail(await s.from('task_projects').delete().in('task_id', ids));
      const tm = doc.tasks.flatMap(t => (t.meetings || []).filter(id => knownMeetings.has(id)).map(meeting_id => ({ task_id: t.id, meeting_id })));
      const tp = doc.tasks.flatMap(t => (t.projects || []).map(project_id => ({ task_id: t.id, project_id })));
      if (tm.length) fail(await s.from('task_meetings').insert(tm));
      if (tp.length) fail(await s.from('task_projects').insert(tp));
    }
  }

  // Settings: default folder + patterns (meeting mappings were written with the meetings above)
  if (doc.settings) {
    fail(await s.from('settings').upsert({ key: 'default_recap_folder', value: { id: doc.settings.defaultFolder || null, path: null } }, { onConflict: 'key' }));
    fail(await s.from('recap_patterns').delete().neq('priority', -999999));
    const pats = (doc.settings.patterns || []).filter(p => p.pattern || p.folder).map((p, i) => ({ id: p.id.replace(/^p:/, ''), pattern: p.pattern || '', folder_id: p.folder || '', mode: p.mode || 'title', priority: i }));
    if (pats.length) fail(await s.from('recap_patterns').insert(pats));
  }
  return { ok: true, savedAt: now };
}

// Mirror task time blocks to Google Calendar as tagged events. Runs only when Google is connected; failures never block a save.
async function syncBlocks(rows, prev) {
  let token = null;
  try { token = Netlify.env.get('GOOGLE_CLIENT_ID') ? await accessToken() : null; } catch { token = null; }
  if (!token) return;
  for (const r of rows) {
    const was = prev[r.id] || {};
    try {
      if (r.block_start) {
        const changed = !was.calendar_event_id || was.block_start !== r.block_start || (was.block_dur_min || 0) !== r.block_dur_min || was.title !== r.title || !!was.done !== r.done;
        if (changed) r.calendar_event_id = await upsertBlockEvent(token, { eventId: was.calendar_event_id, title: r.title, startIso: r.block_start, durMin: r.block_dur_min, taskId: r.id, done: r.done });
      } else if (was.calendar_event_id) {
        await deleteBlockEvent(token, was.calendar_event_id); r.calendar_event_id = null;
      }
    } catch (e) { console.error('block sync', r.id, e.message); }
  }
}
