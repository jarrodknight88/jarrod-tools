import { passwordMatches, makeSession, sessionCookie, json } from '../../lib/auth.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, { status: 405 });
  let body = {};
  try { body = await req.json(); } catch {}
  if (!passwordMatches(body.password)) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    return json({ error: 'Wrong password' }, { status: 401 });
  }
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(makeSession()) } });
};

export const config = { path: '/api/login' };
