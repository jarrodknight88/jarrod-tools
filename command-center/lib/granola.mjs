// Granola public API (https://docs.granola.ai). Key is a personal API key from Granola settings, env GRANOLA_API_KEY.
const BASE = 'https://public-api.granola.ai/v1';

async function g(path, params = {}) {
  const key = Netlify.env.get('GRANOLA_API_KEY');
  if (!key) throw new Error('GRANOLA_API_KEY is not set');
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Granola ' + r.status + ': ' + (j.error?.message || j.message || j.error || r.statusText)); e.status = r.status; e.code = j.error?.code || j.code; throw e; }
  return j;
}

// Notes created after a timestamp, newest first, following pagination.
export async function listNotesSince(isoSince, max = 100) {
  const out = []; let cursor;
  do {
    const j = await g('/notes', { created_after: isoSince, page_size: 30, cursor });
    out.push(...(j.notes || j.data || []));
    cursor = j.has_more || j.hasMore ? (j.cursor || j.next_cursor) : null;
  } while (cursor && out.length < max);
  return out;
}

// Full note with transcript. Falls back to the transcript endpoint if the note is too large to inline.
export async function getNote(noteId) {
  let note;
  try { note = await g(`/notes/${encodeURIComponent(noteId)}`, { include: 'transcript' }); }
  catch (e) {
    if (e.status !== 413) throw e;
    note = await g(`/notes/${encodeURIComponent(noteId)}`);
    note.transcript = (await g(`/notes/${encodeURIComponent(noteId)}/transcript`)).transcript;
  }
  return normalize(note);
}

// Flatten the API shape into what the recap generator needs.
function normalize(n) {
  const tr = n.transcript || n.transcript_segments || [];
  const segments = Array.isArray(tr) ? tr : (tr.segments || tr.items || []);
  const transcriptText = segments.map(s => {
    const who = s.speaker?.name || s.speaker_name || (s.speaker?.diarization_label) || (s.speaker?.source === 'microphone' || s.source === 'microphone' ? 'Me' : 'Them');
    return `${who}: ${s.text}`;
  }).join('\n');
  const ev = n.calendar_event || n.calendarEvent || {};
  const attendees = (n.attendees || ev.invitees || []).map(a => a.name || a.email || a).filter(Boolean);
  return {
    id: n.id, title: n.title || ev.title || '(Untitled meeting)', eventTitle: ev.title || null,
    createdAt: n.created_at || n.createdAt, start: ev.start_time || ev.start || n.meeting_date || n.created_at || n.createdAt, end: ev.end_time || ev.end || null,
    attendees, folders: (n.folders || []).map(f => f.name || f), summaryMarkdown: n.summary_markdown || n.summaryMarkdown || n.summary_text || n.summaryText || '',
    transcriptText, hasTranscript: transcriptText.length > 200
  };
}
