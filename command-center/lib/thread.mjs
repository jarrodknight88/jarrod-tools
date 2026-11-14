// Task comments and attachments. Files live in the private Supabase bucket "task-attachments";
// the browser uploads straight to a signed URL, so large files never pass through a Netlify function.
import { db } from './db.mjs';
import { extractText, PREVIEW_CHARS } from './extract.mjs';
import { accessToken, uploadFile, shareWithReader, deleteFile, ensureFolder } from './google.mjs';

export const BUCKET = 'task-attachments';
const MAX_BYTES = 25 * 1024 * 1024;
const fail = r => { if (r.error) throw new Error(r.error.message); return r; };

// Who is acting. One login today, so it's Jarrod; per-person logins come in the sharing phase.
export const actor = () => 'jarrod';

export async function taskExists(s, taskId) {
  const { data } = await s.from('tasks').select('id,title,area_id,notes,claude_status').eq('id', taskId).maybeSingle();
  return data;
}

// Full thread for a task: comments oldest first, each with its files, plus files attached to the task itself.
export async function getThread(taskId) {
  const s = db();
  const task = await taskExists(s, taskId);
  if (!task) return null;
  const [comments, files] = await Promise.all([
    s.from('task_comments').select('*').eq('task_id', taskId).order('created_at'),
    s.from('task_attachments').select('*').eq('task_id', taskId).order('created_at')
  ]);
  fail(comments); fail(files);
  const paths = files.data.map(f => f.storage_path);
  const signed = paths.length ? fail(await s.storage.from(BUCKET).createSignedUrls(paths, 3600)).data : [];
  const urlFor = Object.fromEntries((signed || []).map(x => [x.path, x.signedUrl]));
  const fileOut = f => ({ id: f.id, name: f.file_name, type: f.mime_type, size: f.size_bytes, by: f.uploaded_by, at: f.created_at, url: urlFor[f.storage_path] || null });
  return {
    task: { id: task.id, title: task.title, claudeStatus: task.claude_status },
    files: files.data.filter(f => !f.comment_id).map(fileOut),
    comments: comments.data.map(c => ({ id: c.id, author: c.author, body: c.body, at: c.created_at, files: files.data.filter(f => f.comment_id === c.id).map(fileOut) }))
  };
}

// Read the text out of a task's attachments so Claude's worker gets it with the task. Runs when a task is handed
// to Claude; anything already read is skipped. Never blocks the hand-off: a file that fails just carries a note.
export async function prepareForClaude(s, taskId, budgetMs = 6000) {
  const started = Date.now(); let read = 0;
  const { data: files } = await s.from('task_attachments').select('id,file_name,mime_type,size_bytes,storage_path').eq('task_id', taskId).is('text_content', null).is('text_note', null);
  for (const f of files || []) {
    if (Date.now() - started > budgetMs) break;
    let out;
    try {
      if ((f.size_bytes || 0) > 15 * 1024 * 1024) out = { note: 'The file is too large to read for Claude (over 15 MB).' };
      else { const dl = await s.storage.from(BUCKET).download(f.storage_path); if (dl.error || !dl.data) throw new Error(dl.error ? dl.error.message : 'download failed'); const buf = Buffer.from(await dl.data.arrayBuffer()); out = extractText(buf, f.file_name, f.mime_type);
        if (out.viaDrive) out = await lendViaDrive(s, f, buf, out);
        else if (out.full) out = await lendLongText(s, f, out); }
    } catch (e) { console.error('attachment read failed', f.file_name, e.message); continue; } // left unread so the 15-minute catch-up tries again
    await s.from('task_attachments').update({ text_content: out.text || null, text_note: out.note || (out.text || out.drive ? null : 'No readable text.'), drive_file_id: out.drive ? out.drive.id : null, drive_url: out.drive ? out.drive.webViewLink || null : null }).eq('id', f.id); read++;
  }
  return read;
}

// A file whose text is too long to travel with the task is lent the same way, as plain text, so Claude can read
// all of it. The start of the text still goes with the task as a preview. If Drive is not set up or the share
// fails, Claude gets the text cut to the inline limit, with a note saying so.
async function lendLongText(s, f, out) {
  const plain = /\.(csv|tsv|txt|md|json|html?|xml|log|ya?ml|rtf)$/i.test(f.file_name || '');
  const copy = { file_name: plain ? f.file_name : f.file_name + '.txt', mime_type: /\.csv$/i.test(f.file_name || '') ? 'text/csv' : 'text/plain' };
  let lent;
  try { lent = await lendViaDrive(s, copy, Buffer.from(out.full, 'utf8'), { note: out.note }); }
  catch (e) { console.error('lending long text failed', f.file_name, e.message); lent = { note: out.note }; }
  if (!lent.drive) return { text: out.text, note: lent.note || out.note };
  const n = x => x.toLocaleString('en-US');
  return { drive: lent.drive, text: out.full.slice(0, PREVIEW_CHARS), note: `Only the first ${n(PREVIEW_CHARS)} of ${n(out.full.length)} characters are shown here. The whole file is lent through Google Drive as plain text: read it with drive_file_id.` };
}

// PDFs and pictures can't be turned into text here, so a copy is lent to Claude through Google Drive: uploaded to a
// "Command Center - files for Claude" folder and shared, read-only, with the one Google account Claude's Drive
// connector uses (settings.claude_drive_email). cleanupClaudeFiles() deletes the copy once Claude is done.
async function lendViaDrive(s, f, buf, fallback) {
  const { data: who } = await s.from('settings').select('value').eq('key', 'claude_drive_email').maybeSingle();
  const token = who && who.value ? await accessToken() : null;
  if (!token) return fallback;
  if (!folderId) folderId = (await ensureFolder(token, 'Command Center - files for Claude', null)).id;
  const file = await uploadFile(token, { name: f.file_name, mime: f.mime_type, buffer: buf, parentId: folderId });
  try { await shareWithReader(token, file.id, who.value); }
  catch (e) { await deleteFile(token, file.id).catch(() => {}); return { note: fallback.note + ' (Sharing it with Claude through Google Drive failed: ' + (e.message || 'unknown error') + ')' }; }
  return { drive: file };
}
let folderId = null;

// Remove what was set aside for Claude once no job is open on the task: the Drive copy is deleted and the stored
// text is cleared. The original attachment on the task is untouched. Runs from the 15-minute scheduled check.
export async function cleanupClaudeFiles(s) {
  const { data: rows } = await s.from('task_attachments').select('id,task_id,drive_file_id').or('drive_file_id.not.is.null,text_content.not.is.null,text_note.not.is.null');
  if (!rows || !rows.length) return 0;
  const { data: open } = await s.from('claude_queue').select('source_ref').eq('kind', 'task').in('status', ['pending', 'working']);
  const busy = new Set((open || []).map(j => j.source_ref));
  let token = null, cleaned = 0;
  for (const r of rows) {
    if (busy.has('task:' + r.task_id)) continue;
    if (r.drive_file_id) { token = token || await accessToken(); if (!token) continue; try { await deleteFile(token, r.drive_file_id); } catch (e) { console.error('drive cleanup failed', e.message); continue; } }
    await s.from('task_attachments').update({ drive_file_id: null, drive_url: null, text_content: null, text_note: null }).eq('id', r.id); cleaned++;
  }
  return cleaned;
}

// When Claude's task worker next checks the queue (Eastern time). Mirrors its two scheduled runs:
// 35 past every hour 6 am to 10 pm daily, plus 5 past 8 am to 6 pm Monday to Saturday.
export function nextClaudeRun(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 1; i <= 24 * 60; i++) {
    const d = new Date(now.getTime() + i * 60000), p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
    const h = Number(p.hour), m = Number(p.minute);
    if ((m === 35 && h >= 6 && h <= 22) || (m === 5 && h >= 8 && h <= 18 && p.weekday !== 'Sun')) {
      const t = `${h % 12 || 12}:${p.minute} ${h < 12 ? 'am' : 'pm'}`;
      return i > 6 * 60 ? `tomorrow at ${t}` : `at ${t}`;
    }
  }
  return 'within the hour';
}

const mentionsClaude = body => /(^|\s)@claude\b/i.test(body || '');

// Adds a comment. Attachments already uploaded (via signUpload) are linked by id.
// Mentioning @Claude queues the task for Claude and marks it on the card.
export async function addComment(taskId, { body = '', attachmentIds = [] } = {}) {
  const s = db();
  const task = await taskExists(s, taskId);
  if (!task) return null;
  const text = String(body).slice(0, 20000).trim();
  if (!text && !attachmentIds.length) throw Object.assign(new Error('comment is empty'), { status: 400 });
  const comment = fail(await s.from('task_comments').insert({ task_id: taskId, author: actor(), body: text }).select('*').single()).data;
  if (attachmentIds.length) fail(await s.from('task_attachments').update({ comment_id: comment.id }).eq('task_id', taskId).in('id', attachmentIds));

  let queued = false;
  if (mentionsClaude(text)) {
    // One open job per task: a new @Claude while one is pending updates that job's request instead of stacking.
    const ref = 'task:' + taskId;
    const { data: open } = await s.from('claude_queue').select('id,status').eq('source_ref', ref).maybeSingle();
    const payload = { task_id: taskId, comment_id: comment.id, request: text, task_title: task.title, area: task.area_id };
    if (open && ['pending', 'working'].includes(open.status)) fail(await s.from('claude_queue').update({ payload }).eq('id', open.id));
    else if (open) fail(await s.from('claude_queue').update({ status: 'pending', payload, result: null, error: null, claimed_at: null, ready_at: null, completed_at: null, title: task.title }).eq('id', open.id));
    else fail(await s.from('claude_queue').insert({ kind: 'task', status: 'pending', source_ref: ref, title: task.title, payload }));
    fail(await s.from('tasks').update({ claude_status: 'queued' }).eq('id', taskId));
    try { await prepareForClaude(s, taskId); } catch (e) { console.error('prepareForClaude', e); }
    fail(await s.from('task_comments').insert({ task_id: taskId, author: 'system', body: `Queued for Claude. The next run is ${nextClaudeRun()}, and the reply will show up here.` }));
    queued = true;
  }
  return { comment: { id: comment.id, author: comment.author, body: comment.body, at: comment.created_at }, queued };
}

// Step 1 of an upload: record the attachment and hand back a signed upload URL for the browser.
export async function signUpload(taskId, { name, type, size, onComment = false } = {}) {
  const s = db();
  if (!(await taskExists(s, taskId))) return null;
  if (!name) throw Object.assign(new Error('file name is required'), { status: 400 });
  if (size && size > MAX_BYTES) throw Object.assign(new Error('files can be up to 25 MB'), { status: 400 });
  const safe = String(name).replace(/[^\w.\- ]+/g, '_').slice(-120);
  const path = `${taskId}/${crypto.randomUUID()}-${safe}`;
  const up = fail(await s.storage.from(BUCKET).createSignedUploadUrl(path)).data;
  const row = fail(await s.from('task_attachments').insert({ task_id: taskId, file_name: String(name).slice(0, 255), mime_type: type || null, size_bytes: size || null, storage_path: path, uploaded_by: actor() }).select('id').single()).data;
  // onComment files stay unlinked (comment_id null) until addComment links them; until then they show on the task.
  return { attachmentId: row.id, uploadUrl: up.signedUrl, token: up.token, path, onComment: !!onComment };
}

export async function removeAttachment(taskId, attachmentId) {
  const s = db();
  const { data: f } = await s.from('task_attachments').select('id,storage_path').eq('task_id', taskId).eq('id', attachmentId).maybeSingle();
  if (!f) return false;
  await s.storage.from(BUCKET).remove([f.storage_path]);
  fail(await s.from('task_attachments').delete().eq('id', f.id));
  return true;
}
