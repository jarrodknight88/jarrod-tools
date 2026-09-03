import { clearCookie, json } from '../../lib/auth.mjs';

export default async () => json({ ok: true }, { headers: { 'set-cookie': clearCookie() } });

export const config = { path: '/api/logout' };
