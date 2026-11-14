// Local test server for the dashboard: serves dist/ and runs the REAL Netlify function code
// (netlify/functions/app.mjs and task-thread.mjs) against a small in-memory stand-in for Supabase.
// Nothing here touches the live database or Google. Usage: npm run build && node dev/server.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const TZ = 'America/New_York';
const ymd = (n = 0) => { const d = new Date(Date.now() + n * 864e5); return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); };

// ---- in-memory tables with the columns the functions rely on ----
const DEFAULTS = {
  tasks: () => ({ id: randomUUID(), created_at: now(), owner: 'Jarrod', urgency: 'soon', done: false, done_at: null, due_date: null, scope: false, source: 'manual', notes: null, block_start: null, block_dur_min: null, calendar_event_id: null,
    area_id: 'cardshq', assignee: 'jarrod', board: 'none', board_date: null, claude_status: null, repeat: null, deleted_at: null, block_on_calendar: true }),
  projects: () => ({ id: randomUUID(), created_at: now(), active: true, sort_order: 0, area_id: 'cardshq' }),
  task_comments: () => ({ id: randomUUID(), created_at: now(), body: '' }),
  task_attachments: () => ({ id: randomUUID(), created_at: now(), comment_id: null, uploaded_by: 'jarrod' }),
  claude_queue: () => ({ id: randomUUID(), created_at: now(), status: 'pending', attempts: 0 }),
  settings: () => ({}), task_projects: () => ({}), task_meetings: () => ({})
};
const T = { areas: [], projects: [], tasks: [], task_projects: [], task_meetings: [], meetings: [], recaps: [], task_comments: [], task_attachments: [], claude_queue: [], settings: [] };

class Q {
  constructor(table) { this.table = table; this.rows = T[table] ||= []; this.f = []; this.op = 'select'; this.ord = []; }
  select() { return this; }
  insert(r) { this.op = 'insert'; this.payload = [].concat(r); return this; }
  update(v) { this.op = 'update'; this.payload = v; return this; }
  upsert(r, o = {}) { this.op = 'upsert'; this.payload = [].concat(r); this.key = o.onConflict || 'id'; this.ignore = !!o.ignoreDuplicates; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k, v) { this.f.push(r => r[k] === v); return this; }
  neq(k, v) { this.f.push(r => r[k] !== v); return this; }
  in(k, vs) { this.f.push(r => vs.includes(r[k])); return this; }
  is(k, v) { this.f.push(r => (r[k] ?? null) === v); return this; }
  lt(k, v) { this.f.push(r => r[k] < v); return this; }
  gt(k, v) { this.f.push(r => r[k] > v); return this; }
  order(k, o = {}) { this.ord.push([k, o.ascending === false ? -1 : 1]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  single() { this.one = 'single'; return this; }
  exec() {
    const match = r => this.f.every(fn => fn(r)); let out = [];
    if (this.op === 'select') out = this.rows.filter(match);
    else if (this.op === 'insert') out = this.payload.map(p => { const row = { ...(DEFAULTS[this.table] ? DEFAULTS[this.table]() : { id: randomUUID(), created_at: now() }), ...p }; this.rows.push(row); return row; });
    else if (this.op === 'update') { out = this.rows.filter(match); out.forEach(r => Object.assign(r, this.payload)); }
    else if (this.op === 'upsert') for (const p of this.payload) { const ex = this.rows.find(r => r[this.key] === p[this.key]); if (ex) { if (!this.ignore) Object.assign(ex, p); out.push(ex); } else { const row = { ...(DEFAULTS[this.table] ? DEFAULTS[this.table]() : {}), ...p }; this.rows.push(row); out.push(row); } }
    else if (this.op === 'delete') { out = this.rows.filter(match); for (const r of out) this.rows.splice(this.rows.indexOf(r), 1); }
    for (const [k, dir] of [...this.ord].reverse()) out = [...out].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir);
    if (this.lim) out = out.slice(0, this.lim);
    out = out.map(r => ({ ...r }));
    if (this.one) return out.length ? { data: out[0], error: null } : { data: null, error: this.one === 'single' ? { message: 'no rows returned' } : null };
    return { data: out, error: null };
  }
  then(a, b) { let r; try { r = this.exec(); } catch (e) { return Promise.reject(e).then(a, b); } return Promise.resolve(r).then(a, b); }
}
const fakeDb = {
  from: t => new Q(t),
  storage: { from: () => ({
    createSignedUrls: async paths => ({ data: paths.map(p => ({ path: p, signedUrl: '/__file/' + encodeURIComponent(p) })), error: null }),
    createSignedUploadUrl: async p => ({ data: { signedUrl: '/__upload/' + encodeURIComponent(p), token: 't', path: p }, error: null }),
    remove: async () => ({ data: [], error: null })
  }) }
};

// ---- seed data: shaped like the live rows, with made-up content ----
const M = { kelly: randomUUID(), nat: randomUUID(), camp: randomUUID(), ops: randomUUID() }, P = { loy: randomUUID(), tier: randomUUID(), web: randomUUID() };
T.areas.push({ id: 'cardshq', name: 'CardsHQ', color: '#2F5BEA', sort_order: 1 }, { id: 'teranga', name: 'Teranga', color: '#D9961A', sort_order: 2 }, { id: 'wugi', name: 'Wugi', color: '#7A4FD6', sort_order: 3 }, { id: 'home', name: 'Home', color: '#3E8C68', sort_order: 4 });
T.projects.push({ ...DEFAULTS.projects(), id: P.loy, name: 'Loyalty' }, { ...DEFAULTS.projects(), id: P.tier, name: 'Product Tiering', sort_order: 1 }, { ...DEFAULTS.projects(), id: P.web, name: 'Website upgrades', sort_order: 2 });
const meeting = (id, title, area, days, time, extra = {}) => ({ id, key: title.slice(0, 6), title, type: 'General', cadence: 'Weekly', match_pattern: title, recap_folder_id: null, recap_folder_path: null, recap_mode: 'title', exclude_from_recaps: false, one_off: false, active: true, sort_order: 0, default_time: time, default_dur_min: 30, days, one_off_date: null, attendees: [], area_id: area, ...extra });
T.meetings.push(meeting(M.kelly, 'Kelly Weekly Touchbase', 'cardshq', [1], '14:00:00', { attendees: ['Kelly'], recap_folder_id: 'f-kelly', recap_folder_path: 'Meeting Recaps / Kelly' }), meeting(M.nat, 'Nathaniel / Jarrod Sync Weekly Sync', 'cardshq', [4], '15:00:00', { attendees: ['Nathaniel'] }),
  meeting(M.camp, 'Campaign Sync', 'cardshq', [3], '11:00:00', { attendees: ['John', 'Kelly'] }), meeting(M.ops, 'Teranga weekly operations', 'teranga', [1], '17:00:00', { attendees: ['Ben'] }));
T.recaps.push({ id: randomUUID(), meeting_id: M.kelly, meeting_date: ymd(0), summary: 'Priorities for the week: loyalty launch, filter badges, holiday promos.', drive_url: 'https://docs.google.com/document/d/x', title: 'Kelly Recap', drive_file_id: 'x' });
const task = (title, o = {}, link = {}) => { const t = { ...DEFAULTS.tasks(), title, ...o }; T.tasks.push(t); if (link.p) T.task_projects.push({ task_id: t.id, project_id: link.p }); if (link.m) T.task_meetings.push({ task_id: t.id, meeting_id: link.m }); return t; };
const at = (n, h, m = 0) => new Date(new Date(`${ymd(n)}T12:00:00Z`).setUTCHours(h + 5, m)).toISOString(); // close enough to Eastern for a test
const t1 = task('Send Jeff the launch status update', { due_date: ymd(0), board: 'todo', board_date: ymd(0), notes: 'One page before Monday.' }, { p: P.loy, m: M.kelly });
task('Confirm Afro District bills are logged', { area_id: 'teranga', due_date: ymd(0), board: 'todo', board_date: ymd(-1), repeat: 'monthly' });
task('Book the dealer for the heat issue', { area_id: 'home', board: 'doing', board_date: ymd(-2) });
task('Upload new App Store screenshots', { area_id: 'wugi', due_date: ymd(0), board: 'doing', board_date: ymd(0), block_start: at(0, 14), block_dur_min: 60 });
task('Approve Detroit grand opening banner', { board: 'done', board_date: ymd(0), done: true, done_at: now() }, { p: P.web });
task('Review payroll draft', { area_id: 'teranga', board: 'done', board_date: ymd(-1), done: true, done_at: at(-1, 9) });
task('Review tier copy with Digi', { due_date: ymd(-3) }, { p: P.loy });
task('Outline the A/B testing spec', { due_date: ymd(-6) }, { p: P.tier });
task('Finalize collection filter badges', { due_date: ymd(1), claude_status: 'needs_review' }, { p: P.web });
task('Prep the investor demo walkthrough', { area_id: 'wugi', due_date: ymd(4) });
task('Drop off the school forms', { area_id: 'home', due_date: ymd(3), assignee: 'jalea', owner: 'Jalea' });
task('Fix the cart drawer bug on mobile', { owner: 'Nathaniel', due_date: ymd(-2), source: 'granola' }, { p: P.web, m: M.nat });
task('Send the SMS login estimate', { owner: 'Nathaniel', due_date: ymd(2), source: 'granola' }, { p: P.web, m: M.nat });
task('Approve the rewards email copy', { owner: 'Kelly', due_date: ymd(-1), source: 'granola' }, { p: P.loy, m: M.kelly });
task('Old deleted task', { deleted_at: now() });
T.task_comments.push({ ...DEFAULTS.task_comments(), task_id: t1.id, author: 'system', body: 'Created from the Kelly Weekly Touchbase recap.' }, { ...DEFAULTS.task_comments(), task_id: t1.id, author: 'jarrod', body: 'Adding the banner mockup before I send it.' });
T.settings.push({ key: 'timezone', value: TZ }, { key: 'granola_last_run', value: { at: now(), ran: true, log: ['0 new note(s)', 'finalize skipped: google needs re-authorization for Drive write access (visit /api/google/connect)'] } });
for (let i = 0; i < 12; i++) T.claude_queue.push({ ...DEFAULTS.claude_queue(), kind: 'recap', status: 'ready' });

function events(start, days) {
  const out = [];
  for (let i = 0; i < days; i++) { const d = new Date(start + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + i); const date = d.toISOString().slice(0, 10), wd = d.getUTCDay();
    const add = (title, h, m, dur, attendees = []) => out.push({ eventId: `${title}-${date}`, title, date, startMin: h * 60 + m, dur, attendees, link: 'https://calendar.google.com/' });
    if (wd >= 1 && wd <= 5) add('CardsHQ standup', 9, 30, 30, ['Nathaniel', 'Kelly']);
    if (wd === 1) { add('Kelly Weekly Touchbase', 14, 0, 30, ['Kelly']); add('Teranga weekly operations', 17, 0, 60, ['Ben']); }
    if (wd === 3) add('Campaign Sync', 11, 0, 60, ['John', 'Kelly']);
    if (wd === 4) add('Nathaniel / Jarrod Sync Weekly Sync', 15, 0, 30, ['Nathaniel']);
    if (date === ymd(0)) { add('Dentist', 13, 0, 45); add('Early flight check-in', 5, 30, 15); }
  }
  return out;
}

globalThis.Netlify = { env: { get: k => ({ AUTH_DISABLED: 'true', GRANOLA_API_KEY: 'test' }[k]) } };
globalThis.__ccTest = { db: fakeDb, events, google: { configured: true, token: null, drive: false } };
globalThis.__ccTest.google.token = 'test-token';
const { accessToken } = await import('../lib/google.mjs'); void accessToken; // real module, but with no refresh token it never calls Google

const appFn = (await import('../netlify/functions/app.mjs')).default;
const threadFn = (await import('../netlify/functions/task-thread.mjs')).default;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const PORT = Number(process.env.PORT) || 8787;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`), parts = url.pathname.split('/').filter(Boolean);
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
  const send = async r => { res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer())); };
  try {
    const request = () => new Request(url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body });
    if (parts[0] === 'api' && parts[1] === 'app') return send(await appFn(request(), { params: { a: parts[2], b: parts[3], c: parts[4] } }));
    if (parts[0] === 'api' && parts[1] === 'tasks') return send(await threadFn(request(), { params: { id: parts[2], kind: parts[3], fileId: parts[4] } }));
    if (parts[0] === '__sim' && parts[1] === 'claude') { // stand-in for the Claude worker: reply on a queued task
      const { title, reply } = JSON.parse(body.toString()), t = T.tasks.find(x => x.title === title), j = t && T.claude_queue.find(x => x.source_ref === 'task:' + t.id);
      if (!j) { res.statusCode = 404; return res.end('no job'); }
      T.task_comments.push({ ...DEFAULTS.task_comments(), task_id: t.id, author: 'claude', body: reply }); t.claude_status = 'needs_review'; j.status = 'done';
      return res.end('ok'); }
    if (parts[0] === '__upload') { res.statusCode = 200; return res.end('{}'); }
    if (parts[0] === '__tables') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(T)); }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const f = join('dist', p);
    if (!existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', MIME[extname(f)] || 'application/octet-stream'); res.end(readFileSync(f));
  } catch (e) { console.error(e); res.statusCode = 500; res.end(String(e)); }
}).listen(PORT, () => console.log('test server on ' + PORT));
