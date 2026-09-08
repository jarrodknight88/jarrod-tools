import { isAuthed, unauthorized } from '../../lib/auth.mjs';
import { exchangeCode } from '../../lib/google.mjs';

export default async (req) => {
  if (!isAuthed(req)) return unauthorized();
  const u = new URL(req.url);
  if (u.searchParams.get('error')) return new Response('Google returned: ' + u.searchParams.get('error'), { status: 400 });
  const code = u.searchParams.get('code');
  if (!code) return new Response('Missing code', { status: 400 });
  try {
    await exchangeCode(req, code);
    return Response.redirect(`${u.protocol}//${u.host}/?google=connected`, 302);
  } catch (e) {
    console.error(e);
    return new Response('Could not connect Google: ' + e.message, { status: 500 });
  }
};

export const config = { path: '/api/google/callback' };
