// Runs every 30 minutes. Picks up new Granola notes and turns them into recaps + tasks.
import { runSync } from '../../lib/sync.mjs';

export default async () => {
  try { const r = await runSync(); console.log('granola sync', JSON.stringify(r.log)); }
  catch (e) { console.error('granola sync failed', e); }
  return new Response('ok');
};

export const config = { schedule: '*/30 * * * *' };
