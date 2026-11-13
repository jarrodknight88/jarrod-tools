// Comments and attachments for one task.
// GET    /api/tasks/:id/thread                      -> { task, files, comments }
// POST   /api/tasks/:id/comments  { body, attachmentIds? }   -> { comment, queued }  (@Claude queues the task)
// POST   /api/tasks/:id/attachments { name, type, size, onComment? } -> { attachmentId, uploadUrl }  (browser PUTs the file to uploadUrl)
// DELETE /api/tasks/:id/attachments/:fileId
import { isAuthed, unauthorized, json } from '../../lib/auth.mjs';
import { getThread, addComment, signUpload, removeAttachment } from '../../lib/thread.mjs';

const UUID = /^[0-9a-f-]{36}$/i;

export default async (req, context) => {
  if (!isAuthed(req)) return unauthorized();
  const { id, kind, fileId } = context.params || {};
  if (!UUID.test(id || '')) return json({ error: 'bad task id' }, { status: 400 });
  try {
    let body = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch {} }
    let out;
    if (kind === 'thread' && req.method === 'GET') out = await getThread(id);
    else if (kind === 'comments' && req.method === 'POST') out = await addComment(id, { body: body.body, attachmentIds: (body.attachmentIds || []).filter(x => UUID.test(x)) });
    else if (kind === 'attachments' && req.method === 'POST') out = await signUpload(id, body);
    else if (kind === 'attachments' && req.method === 'DELETE' && UUID.test(fileId || '')) out = (await removeAttachment(id, fileId)) ? { ok: true } : null;
    else return json({ error: 'not found' }, { status: 404 });
    return out ? json(out) : json({ error: 'task not found' }, { status: 404 });
  } catch (e) {
    console.error('task thread', e);
    return json({ error: e.message || 'server error' }, { status: e.status || 500 });
  }
};

export const config = { path: ['/api/tasks/:id/:kind', '/api/tasks/:id/:kind/:fileId'] };
