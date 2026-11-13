// Runs every 30 minutes. Queues new Granola notes for Claude and turns finished recaps into Docs + tasks.
import { runSync } from '../../lib/sync.mjs';

export default async () => {
  try { const r = await runSync(); console.log('granola sync', JSON.stringify(r.log)); }
  catch (e) { console.error('granola sync failed', e); }
  return new Response('ok');
};

export const config = { schedule: '*/30 * * * *' };
