// API for the redesigned dashboard. Small, targeted writes instead of saving the whole document.
// GET    /api/app/state?start=YYYY-MM-DD&days=7     everything the page needs
// GET    /api/app/events?start=YYYY-MM-DD&days=7    calendar events for another run of days
// GET    /api/app/folders                           Drive folder tree (for picking a recap folder)
// PUT    /api/app/settings          { wrap?, defaultFolder? }
// POST   /api/app/projects          { name, area }
// PATCH  /api/app/projects/:id      { name?, area?, due?, notes?, done?, closeTasks? }   DELETE hides it, POST .../restore undoes that
// GET    /api/app/projects/:id/files   POST the same path { name, type, size } to add one   DELETE .../files/:fileId
// POST   /api/app/tasks             { title, area, proj?, who?, owner?, due?, board?, notes?, repeat?, meeting? }
// PATCH  /api/app/tasks/:id         any of the fields above, plus block ({ date, start, dur, work } or null) and approve
// DELETE /api/app/tasks/:id         soft delete      POST /api/app/tasks/:id/restore  undo it
// PATCH  /api/app/meetings/:id      { area?, on?, folderId?, folderPath? }
// GET    /api/app/meetings/:id/recaps
import { isAuthed, unauthorized, json } from '../../lib/auth.mjs';
import * as app from '../../lib/app.mjs';

const UUID = /^[0-9a-f-]{36}$/i;

export default async (req, context) => {
  if (!isAuthed(req)) return unauthorized();
  const { a, b, c, d } = context.params || {};
  const m = req.method, url = new URL(req.url);
  try {
    let body = {};
    if (m !== 'GET' && m !== 'DELETE') { try { body = await req.json(); } catch {} }
    const range = { start: url.searchParams.get('start'), days: Number(url.searchParams.get('days')) || 7 };
    let out;
    if (a === 'state' && m === 'GET' && !b) out = await app.loadApp(range);
    else if (a === 'events' && m === 'GET' && !b) out = await app.loadEvents(range);
    else if (a === 'folders' && m === 'GET' && !b) out = await app.folders();
    else if (a === 'settings' && m === 'PUT' && !b) out = await app.saveSettings(body);
    else if (a === 'projects' && m === 'POST' && !b) out = await app.createProject(body);
    else if (a === 'tasks' && m === 'POST' && !b) out = await app.createTask(body);
    else if (a === 'projects' && UUID.test(b || '')) {
      if (m === 'PATCH' && !c) out = await app.patchProject(b, body);
      else if (m === 'DELETE' && !c) out = await app.deleteProject(b);
      else if (m === 'POST' && c === 'restore') out = await app.restoreProject(b);
      else if (c === 'files' && m === 'GET' && !d) out = await app.projectFiles(b);
      else if (c === 'files' && m === 'POST' && !d) out = await app.addProjectFile(b, body);
      else if (c === 'files' && m === 'DELETE' && UUID.test(d || '')) out = await app.removeProjectFile(b, d);
    }
    else if (a === 'tasks' && UUID.test(b || '')) {
      if (m === 'PATCH' && !c) out = await app.patchTask(b, body);
      else if (m === 'DELETE' && !c) out = await app.deleteTask(b);
      else if (m === 'POST' && c === 'restore') out = await app.restoreTask(b);
    } else if (a === 'meetings' && UUID.test(b || '')) {
      if (m === 'PATCH' && !c) out = await app.patchMeeting(b, body);
      else if (m === 'GET' && c === 'recaps') out = await app.meetingRecaps(b);
    }
    if (out === undefined || out === null) return json({ error: 'not found' }, { status: 404 });
    return json(out);
  } catch (e) {
    console.error('app api', m, url.pathname, e);
    return json({ error: e.message || 'server error' }, { status: e.status || 500 });
  }
};

export const config = { path: ['/api/app/:a', '/api/app/:a/:b', '/api/app/:a/:b/:c', '/api/app/:a/:b/:c/:d'] };
