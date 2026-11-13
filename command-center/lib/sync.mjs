// Granola -> claude_queue -> (Claude writes the recap on Jarrod's plan) -> Drive Doc + tasks in Supabase.
// No Anthropic API key is used anywhere. Runs on a schedule and on demand, in two passes:
//   1. enqueue: new Granola notes become 'pending' recap jobs in claude_queue, with the full prompt.
//   2. finalize: jobs a Claude scheduled task has marked 'ready' become a Google Doc, a recaps row and tasks.
import { db, todayIn } from './db.mjs';
import { listNotesSince, getNote } from './granola.mjs';
import { buildPrompt, normalizeRecap, recapHtml } from './recap.mjs';
import { accessToken, createDocFromHtml, ensureFolder, tokenScopes, globMatch } from './google.mjs';

const HUB = () => 'https://' + (Netlify.env.get('SITE_HOST') || 'jarrod-command-center.netlify.app');
const fail = r => { if (r.error) throw new Error(r.error.message); return r; };

function localDate(iso, tz) {
  const d = new Date(iso); if (isNaN(d)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const mdy = ymd => { const [y, m, d] = ymd.split('-'); return `${+m}.${+d}.${y.slice(2)}`; };

function matchMeeting(meetings, note) {
  const titles = [note.eventTitle, note.title].filter(Boolean);
  for (const m of meetings) for (const t of titles) {
    if (m.match_pattern && globMatch(m.match_pattern, t)) return m;
    if ((m.title || '').trim().toLowerCase() === t.trim().toLowerCase()) return m;
  }
  return null;
}

async function loadConfig(s) {
  const { data: cfgRows } = await s.from('settings').select('key,value').in('key', ['granola_sync', 'timezone', 'default_recap_folder']);
  const cfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
  return { cfg, sync: cfg.granola_sync || {}, tz: cfg.timezone || 'America/New_York' };
}

// Pass 1: new Granola notes -> pending recap jobs.
async function enqueue(s, { sync, tz, noteIds, limit, log }) {
  let candidates;
  if (noteIds) candidates = noteIds.map(id => ({ id }));
  else {
    const since = new Date(Date.now() - (sync.lookback_days || 7) * 86400000).toISOString();
    const listed = await listNotesSince(since);
    const { data: seen } = await s.from('granola_notes').select('note_id').in('note_id', listed.map(n => n.id));
    const seenIds = new Set((seen || []).map(r => r.note_id));
    const minAge = (sync.min_age_minutes || 20) * 60000;
    candidates = listed.filter(n => !seenIds.has(n.id) && Date.now() - new Date(n.created_at || n.createdAt).getTime() > minAge);
  }
  candidates = candidates.slice(0, limit);
  log.push(`${candidates.length} new note(s)`);

  const { data: meetings } = await s.from('meetings').select('*').eq('active', true);
  const results = [];
  for (const c of candidates) {
    const rec = { note_id: c.id, status: 'error', title: c.title || null, note_created: c.created_at || c.createdAt || null, task_count: 0 };
    try {
      const note = await getNote(c.id);
      rec.title = note.title; rec.note_created = note.createdAt || rec.note_created;
      let meeting = note.hasTranscript ? matchMeeting(meetings, note) : null;
      if (!note.hasTranscript) { rec.status = 'skipped_no_transcript'; log.push(`skip (no transcript): ${note.title}`); }
      else if (meeting && meeting.exclude_from_recaps) { rec.status = 'skipped_excluded'; rec.meeting_id = meeting.id; log.push(`skip (excluded): ${note.title}`); }
      else {
        // Unmatched calendar meetings become tracked meetings automatically, so no recap is ever lost.
        if (!meeting) {
          const title = (note.eventTitle || note.title).trim();
          meeting = fail(await s.from('meetings').insert({ key: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + c.id.slice(-4), title, type: 'General', match_pattern: title, attendees: note.attendees.slice(0, 8), sort_order: 99 }).select('*').single()).data;
          meetings.push(meeting); log.push(`tracked new meeting: ${title}`);
        }
        const meetingDate = localDate(note.start, tz) || todayIn(tz);
        fail(await s.from('claude_queue').upsert({
          kind: 'recap', status: 'pending', source_ref: 'granola:' + c.id, title: `${meeting.title} recap (${meetingDate})`,
          payload: {
            prompt: buildPrompt(note, meeting.title), meeting_id: meeting.id, meeting_title: meeting.title, meeting_date: meetingDate,
            note: { id: note.id, title: note.title, start: note.start, attendees: note.attendees }
          }
        }, { onConflict: 'source_ref', ignoreDuplicates: true }));
        rec.meeting_id = meeting.id; rec.status = 'queued'; log.push(`queued for Claude: ${meeting.title}`);
      }
    } catch (e) { rec.error = (e.message || String(e)).slice(0, 500); log.push(`error: ${rec.title || c.id}: ${rec.error}`); console.error('granola enqueue', c.id, e); }
    await s.from('granola_notes').upsert(rec, { onConflict: 'note_id' });
    results.push(rec);
  }
  return results;
}

// Pass 2: recaps Claude has written -> Google Doc, recaps row, tasks.
async function finalize(s, { cfg, token, log }) {
  const { data: ready } = await s.from('claude_queue').select('*').eq('kind', 'recap').eq('status', 'ready').order('created_at').limit(10);
  const results = [];
  for (const job of ready || []) {
    const p = job.payload || {}; const noteId = (job.source_ref || '').replace(/^granola:/, '');
    const rec = { note_id: noteId, status: 'error', title: p.note?.title || job.title, meeting_id: p.meeting_id || null, task_count: 0 };
    try {
      const recap = normalizeRecap(job.result);
      const { data: meeting } = await s.from('meetings').select('*').eq('id', p.meeting_id).maybeSingle();
      const title = meeting?.title || p.meeting_title || p.note?.title || 'Meeting';
      // Destination folder: the meeting's mapping, else the default, else a General folder we create.
      let folderId = meeting?.recap_folder_id && !meeting.recap_folder_id.startsWith('ph:') ? meeting.recap_folder_id : ((cfg.default_recap_folder || {}).id || null);
      if (!folderId) {
        const root = await ensureFolder(token, 'Meeting Recaps', null); const gen = await ensureFolder(token, 'General', root.id);
        folderId = gen.id; await s.from('settings').upsert({ key: 'default_recap_folder', value: { id: gen.id, path: 'Meeting Recaps / General' } }, { onConflict: 'key' }); log.push('created Meeting Recaps / General as default folder');
      }
      const note = { title: p.note?.title || title, start: p.note?.start, attendees: p.note?.attendees || [] };
      const docName = `${title} Recap: ${mdy(p.meeting_date)}`;
      const doc = await createDocFromHtml(token, { name: docName, html: recapHtml(recap, note, title, HUB()), parentId: folderId });
      const recapRow = fail(await s.from('recaps').upsert({ meeting_id: p.meeting_id, drive_file_id: doc.id, drive_url: doc.webViewLink, title: docName, meeting_date: p.meeting_date, summary: recap.summary, source: 'granola' }, { onConflict: 'drive_file_id' }).select('id').single()).data;
      rec.recap_id = recapRow.id;
      if (recap.tasks.length) {
        const rows = fail(await s.from('tasks').insert(recap.tasks.map(t => ({ title: t.title, owner: t.owner, urgency: t.urgency, due_date: t.due_date, notes: t.notes, source: 'granola', area_id: meeting?.area_id || 'cardshq' }))).select('id')).data;
        if (p.meeting_id) fail(await s.from('task_meetings').insert(rows.map(r => ({ task_id: r.id, meeting_id: p.meeting_id }))));
        rec.task_count = rows.length;
      }
      fail(await s.from('claude_queue').update({ status: 'done', completed_at: new Date().toISOString(), error: null }).eq('id', job.id));
      rec.status = 'processed'; log.push(`processed: ${docName} (${rec.task_count} tasks)`);
    } catch (e) {
      rec.error = (e.message || String(e)).slice(0, 500); log.push(`error finalizing ${job.title}: ${rec.error}`); console.error('granola finalize', job.id, e);
      await s.from('claude_queue').update({ status: 'error', error: rec.error }).eq('id', job.id);
    }
    if (noteId) await s.from('granola_notes').upsert(rec, { onConflict: 'note_id' });
    results.push(rec);
  }
  return results;
}

export async function runSync({ force = false, limit = 5, noteIds = null } = {}) {
  const s = db();
  const { cfg, sync, tz } = await loadConfig(s);
  const log = [];
  if (sync.enabled === false && !force) return { ran: false, reason: 'disabled', log };

  const queued = await enqueue(s, { sync, tz, noteIds, limit, log });

  // Finalizing needs Drive write access; queuing does not, so notes are never missed while Google is disconnected.
  const token = await accessToken();
  let processed = [];
  if (!token) log.push('finalize skipped: google not connected');
  else if (!(await tokenScopes(token)).includes('https://www.googleapis.com/auth/drive.file')) log.push('finalize skipped: google needs re-authorization for Drive write access (visit /api/google/connect)');
  else processed = await finalize(s, { cfg, token, log });

  const { count: waiting } = await s.from('claude_queue').select('id', { count: 'exact', head: true }).eq('kind', 'recap').in('status', ['pending', 'working']);
  return { ran: true, results: [...queued, ...processed], waiting_on_claude: waiting || 0, log };
}
