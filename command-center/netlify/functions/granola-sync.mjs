// Manual trigger and status, used from the dashboard and for testing.
// GET  /api/granola/sync            -> last 20 ledger rows
// POST /api/granola/sync            -> run now  (body: { force?, limit?, noteIds? })
import { isAuthed, unauthorized, json } from '../../lib/auth.mjs';
import { runSync } from '../../lib/sync.mjs';
import { db } from '../../lib/db.mjs';

export default async (req) => {
  if (!isAuthed(req)) return unauthorized();
  try {
    if (req.method === 'GET') {
      const { data, error } = await db().from('granola_notes').select('*').order('processed_at', { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      return json({ configured: !!Netlify.env.get('GRANOLA_API_KEY') && !!Netlify.env.get('ANTHROPIC_API_KEY'), recent: data });
    }
    if (req.method === 'POST') {
      let body = {}; try { body = await req.json(); } catch {}
      return json(await runSync({ force: !!body.force, limit: body.limit || 5, noteIds: body.noteIds || null }));
    }
    return json({ error: 'method' }, { status: 405 });
  } catch (e) { console.error(e); return json({ error: e.message }, { status: 500 }); }
};

export const config = { path: '/api/granola/sync' };
