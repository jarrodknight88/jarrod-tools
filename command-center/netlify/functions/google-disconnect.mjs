import { isAuthed, unauthorized, json } from '../../lib/auth.mjs';
import { disconnect } from '../../lib/google.mjs';

export default async (req) => {
  if (!isAuthed(req)) return unauthorized();
  if (req.method !== 'POST') return json({ error: 'method' }, { status: 405 });
  await disconnect();
  return json({ ok: true });
};

export const config = { path: '/api/google/disconnect' };
