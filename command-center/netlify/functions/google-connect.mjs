import { isAuthed, unauthorized } from '../../lib/auth.mjs';
import { authUrl } from '../../lib/google.mjs';

export default async (req) => {
  if (!isAuthed(req)) return unauthorized();
  if (!Netlify.env.get('GOOGLE_CLIENT_ID')) return new Response('GOOGLE_CLIENT_ID is not set on this site yet.', { status: 500 });
  return Response.redirect(authUrl(req, 'cc'), 302);
};

export const config = { path: '/api/google/connect' };
