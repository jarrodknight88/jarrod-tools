// Google Calendar + Drive access for the dashboard.
// One-time OAuth stores a refresh token in the settings table; every request mints a short-lived access token from it.
import { db } from './db.mjs';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.metadata.readonly'];
const cfg = () => ({ id: Netlify.env.get('GOOGLE_CLIENT_ID'), secret: Netlify.env.get('GOOGLE_CLIENT_SECRET') });

export function redirectUri(req) { const u = new URL(req.url); return `${u.protocol}//${u.host}/api/google/callback`; }

export function authUrl(req, state) {
  const p = new URLSearchParams({ client_id: cfg().id, redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}

export async function exchangeCode(req, code) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg().id, client_secret: cfg().secret, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error('Token exchange failed: ' + (j.error_description || j.error || r.status));
  const s = db();
  const { error } = await s.from('settings').upsert({ key: 'google_refresh_token', value: j.refresh_token }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return j;
}

export async function disconnect() {
  const s = db();
  const { data } = await s.from('settings').select('value').eq('key', 'google_refresh_token').maybeSingle();
  if (data && data.value) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(data.value), { method: 'POST' }).catch(() => {});
  await s.from('settings').delete().eq('key', 'google_refresh_token');
}

let cached = { token: null, exp: 0 };
export async function accessToken() {
  if (cached.token && cached.exp > Date.now() + 60000) return cached.token;
  const s = db();
  const { data } = await s.from('settings').select('value').eq('key', 'google_refresh_token').maybeSingle();
  if (!data || !data.value || !cfg().id) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: data.value, client_id: cfg().id, client_secret: cfg().secret, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) { console.error('google refresh failed', j); return null; }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

async function g(token, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Google API ' + r.status));
  return j;
}

// ---- Calendar ----

// Today's events on the primary calendar, in the given time zone.
export async function todayEvents(token, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = fmt.format(new Date());
  const offset = tzOffsetString(new Date(`${day}T12:00:00Z`), tz);
  const p = new URLSearchParams({ timeMin: `${day}T00:00:00${offset}`, timeMax: `${day}T23:59:59${offset}`, singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeZone: tz });
  const j = await g(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + p);
  return (j.items || []).filter(e => e.status !== 'cancelled' && e.start && e.start.dateTime && !(e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.ccTask))
    .map(e => {
      const st = new Date(e.start.dateTime), en = new Date(e.end.dateTime);
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(st).map(x => [x.type, x.value]));
      const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
      return { eventId: e.id, title: e.summary || '(No title)', startMin: minutes, dur: Math.max(5, Math.round((en - st) / 60000)), attendees: (e.attendees || []).filter(a => !a.self && !a.resource).map(a => a.displayName || (a.email || '').split('@')[0]).slice(0, 8), link: e.htmlLink, recurringEventId: e.recurringEventId || null };
    });
}

function tzOffsetString(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date).find(x => x.type === 'timeZoneName').value; // e.g. GMT-04:00
  const m = p.match(/([+-]\d{2}):?(\d{2})/); return m ? `${m[1]}:${m[2]}` : 'Z';
}

// Task blocks become events tagged with a private extended property so they are never mistaken for meetings.
export async function upsertBlockEvent(token, { eventId, title, startIso, durMin, taskId, done }) {
  const body = { summary: (done ? '✓ ' : '') + title, start: { dateTime: startIso }, end: { dateTime: new Date(new Date(startIso).getTime() + durMin * 60000).toISOString() },
    description: 'Time block from Command Center', colorId: '8', transparency: 'transparent', reminders: { useDefault: false }, extendedProperties: { private: { ccTask: taskId } } };
  if (eventId) {
    try { const j = await g(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(body) }); return j.id; }
    catch (e) { if (!/404|410|Not Found/.test(e.message)) throw e; }
  }
  const j = await g(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', body: JSON.stringify(body) });
  return j.id;
}

export async function deleteBlockEvent(token, eventId) {
  try { await g(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }); }
  catch (e) { if (!/404|410|Not Found/.test(e.message)) throw e; }
}

// ---- Drive ----

// Full folder tree under My Drive. Cached in settings for an hour because it lists every folder.
export async function folderTree(token, force = false) {
  const s = db();
  const { data } = await s.from('settings').select('value').eq('key', 'folder_tree_cache').maybeSingle();
  if (!force && data && data.value && data.value.at && Date.now() - data.value.at < 3600000) return data.value.tree;
  const root = await g(token, 'https://www.googleapis.com/drive/v3/files/root?fields=id');
  const folders = []; let pageToken = '';
  do {
    const p = new URLSearchParams({ q: "mimeType='application/vnd.google-apps.folder' and trashed=false and 'me' in owners", fields: 'nextPageToken,files(id,name,parents)', pageSize: '1000', pageToken });
    const j = await g(token, 'https://www.googleapis.com/drive/v3/files?' + p);
    folders.push(...(j.files || [])); pageToken = j.nextPageToken || '';
  } while (pageToken);
  const nodes = Object.fromEntries(folders.map(f => [f.id, { id: f.id, name: f.name, children: [] }]));
  const tree = { id: root.id, name: 'My Drive', children: [] };
  for (const f of folders) { const parent = (f.parents || [])[0]; const n = nodes[f.id]; if (parent === root.id) tree.children.push(n); else if (nodes[parent]) nodes[parent].children.push(n); }
  const sortRec = n => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sortRec); }; sortRec(tree);
  await s.from('settings').upsert({ key: 'folder_tree_cache', value: { at: Date.now(), tree } }, { onConflict: 'key' });
  return tree;
}

// Docs in a folder, newest first.
export async function folderFiles(token, folderId) {
  const p = new URLSearchParams({ q: `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`, fields: 'files(id,name,webViewLink,createdTime,modifiedTime,mimeType)', orderBy: 'createdTime desc', pageSize: '50' });
  const j = await g(token, 'https://www.googleapis.com/drive/v3/files?' + p);
  return (j.files || []).map(f => ({ id: f.id, name: f.name, url: f.webViewLink, date: dateFromName(f.name) || f.createdTime.slice(0, 10), isDoc: f.mimeType === 'application/vnd.google-apps.document' }));
}

// "Recap - 9.3.26", "2026-09-03", "Sep 3, 2026" all resolve to an ISO date; otherwise null.
export function dateFromName(name) {
  let m = name.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = name.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const d = Date.parse(name.replace(/^.*?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/, '$1')); if (!isNaN(d) && /\d{4}/.test(name)) return new Date(d).toISOString().slice(0, 10);
  return null;
}

// Simple glob: * matches anything, case-insensitive.
export const globMatch = (pattern, text) => { if (!pattern) return false; const re = new RegExp('^' + pattern.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'); return re.test(text || ''); };
