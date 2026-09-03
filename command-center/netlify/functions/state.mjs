import { isAuthed, unauthorized, json } from '../../lib/auth.mjs';
import { loadState, saveState } from '../../lib/db.mjs';

export default async (req) => {
  if (!isAuthed(req)) return unauthorized();
  try {
    if (req.method === 'GET') return json(await loadState());
    if (req.method === 'PUT') {
      const doc = await req.json();
      const result = await saveState(doc);
      return json(result);
    }
    return json({ error: 'method' }, { status: 405 });
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'server error' }, { status: 500 });
  }
};

export const config = { path: '/api/state' };
