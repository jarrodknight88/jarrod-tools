// Granola -> recap -> Drive Doc -> Supabase. Runs on a schedule and on demand.
import { db, todayIn } from './db.mjs';
import { listNotesSince, getNote } from './granola.mjs';
import { generateRecap, recapHtml } from './recap.mjs';
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

export async function runSync({ force = false, limit = 5, noteIds = null } = {}) {
  const s = db();
  const { data: cfgRows } = await s.from('settings').select('key,value').in('key', ['granola_sync', 'timezone', 'default_recap_folder']);
  const cfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
  const sync = cfg.granola_sync || {}; const tz = cfg.timezone || 'America/New_York';
  const log = [];
  if (sync.enabled === false && !force) return { ran: false, reason: 'disabled', log };

  const token = await accessToken();
  if (!token) return { ran: false, reason: 'google not connected', log };
  const scopes = await tokenScopes(token);
  if (!scopes.includes('https://www.googleapis.com/auth/drive.file')) return { ran: false, reason: 'google needs re-authorization for Drive write access (visit /api/google/connect)', log };

  // Candidate notes
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
  log.push(`${candidates.length} candidate note(s)`);

  const { data: meetings } = await s.from('meetings').select('*').eq('active', true);
  const results = [];
  for (const c of candidates) {
    const rec = { note_id: c.id, status: 'error', title: c.title || null, note_created: c.created_at || c.createdAt || null, task_count: 0 };
    try {
      const note = await getNote(c.id);
      rec.title = note.title; rec.note_created = note.createdAt || rec.note_created;
      if (!note.hasTranscript) { rec.status = 'skipped_no_transcript'; log.push(`skip (no transcript): ${note.title}`); }
      else {
        let meeting = matchMeeting(meetings, note);
        if (meeting && meeting.exclude_from_recaps) { rec.status = 'skipped_excluded'; rec.meeting_id = meeting.id; log.push(`skip (excluded): ${note.title}`); }
        else {
          // Unmatched calendar meetings become tracked meetings automatically, so no recap is ever lost.
          if (!meeting) {
            const title = (note.eventTitle || note.title).trim();
            meeting = fail(await s.from('meetings').insert({ key: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + c.id.slice(-4), title, type: 'General', match_pattern: title, attendees: note.attendees.slice(0, 8), sort_order: 99 }).select('*').single()).data;
            meetings.push(meeting); log.push(`tracked new meeting: ${title}`);
          }
          // Destination folder: the meeting's mapping, else the default, else a General folder we create.
          let folderId = meeting.recap_folder_id && !meeting.recap_folder_id.startsWith('ph:') ? meeting.recap_folder_id : ((cfg.default_recap_folder || {}).id || null);
          if (!folderId) {
            const root = await ensureFolder(token, 'Meeting Recaps', null); const gen = await ensureFolder(token, 'General', root.id);
            folderId = gen.id; await s.from('settings').upsert({ key: 'default_recap_folder', value: { id: gen.id, path: 'Meeting Recaps / General' } }, { onConflict: 'key' }); log.push('created Meeting Recaps / General as default folder');
          }
          const recap = await generateRecap(note, meeting.title);
          const dateStr = localDate(note.start, tz) || todayIn(tz);
          const docName = `${meeting.title} Recap: ${mdy(dateStr)}`;
          const doc = await createDocFromHtml(token, { name: docName, html: recapHtml(recap, note, meeting.title, HUB()), parentId: folderId });
          const recapRow = fail(await s.from('recaps').upsert({ meeting_id: meeting.id, drive_file_id: doc.id, drive_url: doc.webViewLink, title: docName, meeting_date: dateStr, summary: recap.summary, source: 'granola' }, { onConflict: 'drive_file_id' }).select('id').single()).data;
          rec.recap_id = recapRow.id; rec.meeting_id = meeting.id;
          if (recap.tasks.length) {
            const rows = fail(await s.from('tasks').insert(recap.tasks.map(t => ({ title: t.title, owner: t.owner, urgency: t.urgency, due_date: t.due_date, notes: t.notes, source: 'granola' }))).select('id')).data;
            fail(await s.from('task_meetings').insert(rows.map(r => ({ task_id: r.id, meeting_id: meeting.id }))));
            rec.task_count = rows.length;
          }
          rec.status = 'processed'; log.push(`processed: ${docName} (${rec.task_count} tasks)`);
        }
      }
    } catch (e) { rec.error = (e.message || String(e)).slice(0, 500); log.push(`error: ${rec.title || c.id}: ${rec.error}`); console.error('granola sync', c.id, e); }
    await s.from('granola_notes').upsert(rec, { onConflict: 'note_id' });
    results.push(rec);
  }
  return { ran: true, results, log };
}
