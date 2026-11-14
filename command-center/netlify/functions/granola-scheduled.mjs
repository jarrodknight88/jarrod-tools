// Runs every 15 minutes. Queues new Granola notes for Claude and turns finished recaps into Docs + tasks.
// The last run's log is saved to settings.granola_last_run so problems are visible without function logs.
import { runSync } from '../../lib/sync.mjs';
import { db } from '../../lib/db.mjs';
import { prepareForClaude, cleanupClaudeFiles } from '../../lib/thread.mjs';

export default async () => {
  let entry;
  try { const r = await runSync(); entry = { at: new Date().toISOString(), ran: r.ran, reason: r.reason || null, waiting_on_claude: r.waiting_on_claude ?? null, log: r.log }; console.log('granola sync', JSON.stringify(r.log)); }
  catch (e) { entry = { at: new Date().toISOString(), ran: false, error: e.message || String(e) }; console.error('granola sync failed', e); }
  // Catch-up: read any attachments on tasks waiting for Claude that were not read at hand-off.
  try { const { data: jobs } = await db().from('claude_queue').select('payload').eq('kind', 'task').eq('status', 'pending'); for (const j of jobs || []) if (j.payload && j.payload.task_id) await prepareForClaude(db(), j.payload.task_id, 8000); } catch (e) { console.error('attachment catch-up failed', e); }
  // Clean-up: once Claude has replied, delete the copies lent to it through Drive and clear the stored text.
  try { const n = await cleanupClaudeFiles(db()); if (n) console.log('claude files cleaned', n); } catch (e) { console.error('claude file clean-up failed', e); }
  try { await db().from('settings').upsert({ key: 'granola_last_run', value: entry }, { onConflict: 'key' }); } catch {}
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
