// Runs every 30 minutes. Queues new Granola notes for Claude and turns finished recaps into Docs + tasks.
// The last run's log is saved to settings.granola_last_run so problems are visible without function logs.
import { runSync } from '../../lib/sync.mjs';
import { db } from '../../lib/db.mjs';

export default async () => {
  let entry;
  try { const r = await runSync(); entry = { at: new Date().toISOString(), ran: r.ran, reason: r.reason || null, waiting_on_claude: r.waiting_on_claude ?? null, log: r.log }; console.log('granola sync', JSON.stringify(r.log)); }
  catch (e) { entry = { at: new Date().toISOString(), ran: false, error: e.message || String(e) }; console.error('granola sync failed', e); }
  try { await db().from('settings').upsert({ key: 'granola_last_run', value: entry }, { onConflict: 'key' }); } catch {}
  return new Response('ok');
};

export const config = { schedule: '*/30 * * * *' };
