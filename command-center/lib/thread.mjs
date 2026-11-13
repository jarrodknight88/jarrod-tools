// Task comments and attachments. Files live in the private Supabase bucket "task-attachments";
// the browser uploads straight to a signed URL, so large files never pass through a Netlify function.
import { db } from './db.mjs';

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
    fail(await s.from('task_comments').insert({ task_id: taskId, author: 'system', body: 'Claude picked this up and will reply here.' }));
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
