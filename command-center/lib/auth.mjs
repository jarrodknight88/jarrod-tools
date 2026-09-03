// Single-user session auth. A login sets a signed cookie; every data function verifies it.
// Secrets come from Netlify environment variables: APP_PASSWORD, SESSION_SECRET.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'cc_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sign(payload) {
  return createHmac('sha256', Netlify.env.get('SESSION_SECRET') || '').update(payload).digest('base64url');
}

export function makeSession() {
  const payload = String(Date.now() + MAX_AGE * 1000);
  return payload + '.' + sign(payload);
}

export function sessionCookie(value, maxAge = MAX_AGE) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return sessionCookie('', 0);
}

export function authDisabled() { return (Netlify.env.get('AUTH_DISABLED') || '').toLowerCase() === 'true'; }

export function isAuthed(req) {
  if (authDisabled()) return true;
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (expected.length !== sig.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  return Number(payload) > Date.now();
}

export function passwordMatches(candidate) {
  const real = Netlify.env.get('APP_PASSWORD') || '';
  if (!real || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate), b = Buffer.from(real);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const unauthorized = () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
export const json = (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
