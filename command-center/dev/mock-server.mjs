// Local smoke-test server: serves dist/ and a fake /api/state so the UI can be exercised without Supabase.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const today = new Date(); const pad = n => String(n).padStart(2, '0');
const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
const state = {
  today: todayStr, tz: 'America/New_York',
  meetings: [
    { id: 'm1', key: 'kelly', title: 'Kelly Weekly Touchbase', type: 'Leadership', cadence: 'Weekly', time: '9:30 AM', dur: 30, days: [today.getDay()], oneOff: false, oneOffDate: null, attendees: ['Kelly'], matchPattern: 'Kelly*', exclude: false,
      recaps: [{ id: 'r1', date: '2026-08-26', summary: 'Held launch date pending shipping decision.', url: 'https://docs.google.com/x', title: 'Recap' }] },
    { id: 'm2', key: 'dev', title: 'Dev Sync with Nathaniel', type: 'Engineering', cadence: 'Mon & Wed', time: '1:00 PM', dur: 30, days: [1,3], oneOff: false, oneOffDate: null, attendees: ['Nathaniel','Mikhail'], matchPattern: '', exclude: false, recaps: [] },
    { id: 'm3', key: 'teranga', title: 'Teranga ops', type: 'General', cadence: '', time: '4:00 PM', dur: 45, days: [today.getDay()], oneOff: false, oneOffDate: null, attendees: ['Somebody New'], matchPattern: '', exclude: true, recaps: [] }
  ],
  tasks: [
    { id: 't1', title: 'Send shipping cost recommendation to Kelly', owner: 'Jarrod', urgency: 'urgent', done: false, scope: false, source: 'manual', notes: '', dueDate: todayStr, dueTime: '14:00', meetings: ['m1'], projects: ['p1'], block: { start: 840, dur: 30 } },
    { id: 't2', title: 'Old done task', owner: 'Jarrod', urgency: 'ongoing', done: true, scope: false, source: 'manual', notes: '', dueDate: null, dueTime: null, meetings: [], projects: [], block: null }
  ],
  projects: [{ id: 'p1', name: 'Loyalty Program Launch', health: 'Yellow', pct: 72, baselineOpen: 1, milestone: 'Shipping decision', date: 'Sep 12', update: 'Tier structure final.' }],
  tickets: [],
  folderTree: { id: 'root', name: 'My Drive', children: [{ id: 'ph:meeting-recaps', name: 'Meeting Recaps', children: [{ id: 'ph:kelly-touchbase', name: 'Kelly Touchbase', children: [] }] }] },
  settings: { defaultFolder: null, mappings: { m1: { folder: 'ph:kelly-touchbase', mode: 'title' } }, patterns: [] }
};
export const puts = [];
createServer((req, res) => {
  if (req.url === '/api/state') {
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state)); }
    let body = ''; req.on('data', c => body += c); req.on('end', () => { puts.push(JSON.parse(body)); console.log('PUT', body.length, 'bytes'); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); return;
  }
  if (req.url === '/__puts') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(puts)); }
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = join('dist', p);
  if (!existsSync(f)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('content-type', MIME[extname(f)] || 'application/octet-stream'); res.end(readFileSync(f));
}).listen(8787, () => console.log('mock on 8787'));
