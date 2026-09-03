
const TYPES = { Leadership: '#8B5CF6', Loyalty: '#3B82F6', Engineering: '#10B981', Inventory: '#F59E0B', Vendor: '#EC4899', General: '#6B7280' };
const TYPE_LIST = Object.keys(TYPES);
const person = a => PEOPLE[a] || PEOPLE.Jarrod;
const PEOPLE = {
  Kelly: ['#EDE9FE','#5B21B6'], Matthew: ['#DBEAFE','#1D4ED8'], Sammy: ['#FCE7F3','#9D174D'],
  Nathaniel: ['#D1FAE5','#065F46'], Mikhail: ['#FEF3C7','#92400E'], Jimmy: ['#E0E7FF','#3730A3'],
  Zach: ['#FFE4E6','#9F1239'], Jasmine: ['#CCFBF1','#115E59'], Jarrod: ['#F3F4F6','#374151']
};
const URG = {
  urgent: { label: 'Urgent', bg: '#FEE2E2', fg: '#B91C1C', dot: '#DC2626' },
  soon: { label: 'Soon', bg: '#FEF3C7', fg: '#B45309', dot: '#F59E0B' },
  ongoing: { label: 'Ongoing', bg: '#F3F4F6', fg: '#4B5563', dot: '#9CA3AF' }
};
const HEALTH = { Green: ['On track', '#D1FAE5', '#065F46', '#10B981'], Yellow: ['At risk', '#FEF3C7', '#92400E', '#F59E0B'], Red: ['Off track', '#FEE2E2', '#991B1B', '#DC2626'] };
const STATUS = { 'In Progress': ['#DBEAFE', '#1D4ED8'], Estimate: ['#F3F4F6', '#4B5563'], Ready: ['#D1FAE5', '#065F46'] };
const initials = n => n.slice(0, 2).toUpperCase();
const fmt = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtDate = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (iso || '');
const DAY_START = 420, DAY_END = 1140, ROW_PX = 28, PX_PER_MIN = ROW_PX / 30;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toMin = t => { const [hm, ap] = t.split(' '); let [h, m] = hm.split(':').map(Number); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return h * 60 + m; };
const fromMin = m => { const h = Math.floor(m / 60), mm = m % 60; return (((h + 11) % 12) + 1) + ':' + String(mm).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); };
const hourLabel = m => { const h = Math.floor(m / 60); return (((h + 11) % 12) + 1) + ' ' + (h >= 12 ? 'PM' : 'AM'); };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
let MEETINGS = [], ITEMS = [], PROJECTS = [], TICKETS = [];
let DRIVE = { id: 'root', name: 'My Drive', children: [] };
let FOLDER_INDEX = {};
function setFolderTree(tree) { DRIVE = tree || { id: 'root', name: 'My Drive', children: [] }; FOLDER_INDEX = {}; (function walk(n, path, parent) { FOLDER_INDEX[n.id] = { node: n, path, parent }; (n.children || []).forEach(c => walk(c, [...path, c.name], n.id)); })(DRIVE, [], null); }
setFolderTree(DRIVE);
const folderPath = id => id && FOLDER_INDEX[id] ? FOLDER_INDEX[id].path.join(' / ') : '';
const FOLDER_FILES = {};
const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const PERSIST_KEYS = ['custom', 'done', 'links', 'blocks', 'projectsState', 'settings', 'meetingsState'];
const globMatch = (pattern, title) => { const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp('^' + pattern.trim().split('*').map(esc).join('.*') + '$', 'i').test(title); };
const DEFAULT_SETTINGS = { defaultFolder: null, mappings: {}, patterns: [] };
function parseQuick(text, now) {
  let title = ' ' + text + ' ', hasDate = false, hasTime = false;
  const d = new Date(now); d.setHours(9, 0, 0, 0);
  const rules = [
    [/\btomorrow\b/i, () => d.setDate(d.getDate() + 1)],
    [/\btoday\b/i, () => {}],
    [/\bnext week\b/i, () => d.setDate(d.getDate() + 7)],
    [/\b(?:on\s+|next\s+)?(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i, m => { const idx = DAYS.indexOf(m[1].slice(0, 3).toLowerCase()); d.setDate(d.getDate() + ((idx - d.getDay() + 7) % 7 || 7)); }]
  ];
  for (const [re, fn] of rules) { const m = title.match(re); if (m) { fn(m); hasDate = true; title = title.replace(re, ' '); } }
  const tm = title.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (tm) { let h = +tm[1]; if (/pm/i.test(tm[3]) && h !== 12) h += 12; if (/am/i.test(tm[3]) && h === 12) h = 0; d.setHours(h, +(tm[2] || 0), 0, 0); hasTime = true; title = title.replace(tm[0], ' '); }
  title = title.replace(/\s{2,}/g, ' ').trim().replace(/\s+(on|at|by)$/i, '');
  return { title, due: hasDate || hasTime ? { date: d, hasTime } : null };
}
function dueLabel(due, now) {
  if (!due) return '';
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(due.date).setHours(0, 0, 0, 0) - a) / 86400000);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : due.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return day + (due.hasTime ? ' ' + due.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
}

class Component extends DCLogic {
  state = { selected: null, tab: 'recaps', showDone: false, expanded: null, query: '', isMobile: false, view: 'meetings', newTask: '', custom: [], panelNew: '', projNew: '', links: {}, tagging: null,
    projectsState: PROJECTS, projEdit: null, settings: DEFAULT_SETTINGS, draft: null, settingsOpen: false, pickerFor: null, pickerSel: null, pickerQuery: '', pickerExpanded: { root: true, recaps: true }, highlightRow: null, toast: '', linkMeeting: undefined, linkProject: undefined,
    blocks: {}, done: {}, loaded: false, loadError: '', saving: false, meetingsState: [], meetEdit: null, today: null };
  componentDidMount() {
    this._onResize = () => { const w = document.documentElement.clientWidth || window.innerWidth; const isMobile = w < 760; if (isMobile !== this.state.isMobile) this.setState({ isMobile }); };
    this._onResize(); requestAnimationFrame(this._onResize); setTimeout(this._onResize, 300);
    window.addEventListener('resize', this._onResize);
    if (window.ResizeObserver) { this._ro = new ResizeObserver(this._onResize); this._ro.observe(document.documentElement); }
    this.load();
  }
  // ---- persistence ----
  async load() {
    try {
      const r = await fetch('/api/state', { credentials: 'same-origin' });
      if (r.status === 401) { location.href = '/login.html'; return; }
      if (!r.ok) throw new Error('Load failed (' + r.status + ')');
      const d = await r.json();
      MEETINGS = d.meetings.map(m => ({ ...m, recaps: m.recaps || [] }));
      TICKETS = d.tickets || [];
      setFolderTree(d.folderTree);
      const custom = d.tasks.map(t => ({ id: t.id, title: t.title, owner: t.owner, urgency: t.urgency, scope: t.scope, source: t.source, meetings: t.meetings, projects: t.projects,
        due: t.dueDate ? { date: new Date(t.dueDate + 'T' + (t.dueTime || '09:00') + ':00'), hasTime: !!t.dueTime } : null }));
      const done = Object.fromEntries(d.tasks.map(t => [t.id, !!t.done]));
      const blocks = Object.fromEntries(d.tasks.filter(t => t.block).map(t => [t.id, t.block]));
      const settings = { defaultFolder: d.settings.defaultFolder || null, mappings: d.settings.mappings || {}, patterns: d.settings.patterns || [] };
      this._snapshot = null;
      this.setState({ custom, done, blocks, links: {}, projectsState: d.projects, settings, meetingsState: MEETINGS, loaded: true, loadError: '', today: d.today }, () => { this._snapshot = this.snapshot(); });
    } catch (e) { this.setState({ loadError: e.message || 'Could not load' }); }
  }
  snapshot() { const s = this.state; return PERSIST_KEYS.map(k => s[k]); }
  setState(update, cb) {
    super.setState(update, () => {
      if (cb) cb();
      if (!this.state.loaded || !this._snapshot) return;
      const now = this.snapshot();
      if (now.some((v, i) => v !== this._snapshot[i])) { this._snapshot = now; this.schedulePersist(); }
    });
  }
  schedulePersist() { clearTimeout(this._persistT); this._persistT = setTimeout(() => this.persist(), 500); }
  buildDoc() {
    const { custom, done, links, blocks, projectsState, settings, meetingsState } = this.state;
    const pad = n => String(n).padStart(2, '0');
    const tasks = custom.map(t => { const l = links[t.id] || {}; return { id: t.id, title: t.title, owner: t.owner, urgency: t.urgency, scope: !!t.scope, source: t.source || 'manual', done: !!done[t.id],
      dueDate: t.due ? t.due.date.getFullYear() + '-' + pad(t.due.date.getMonth() + 1) + '-' + pad(t.due.date.getDate()) : null, dueTime: t.due && t.due.hasTime ? pad(t.due.date.getHours()) + ':' + pad(t.due.date.getMinutes()) : null,
      meetings: l.meetings || t.meetings || [], projects: l.projects || t.projects || [], block: blocks[t.id] || null }; });
    return { tasks, projects: projectsState, settings, meetings: meetingsState.map(m => { const { recaps, ...rest } = m; return rest; }) };
  }
  async persist() {
    if (this._persisting) { this._persistAgain = true; return; }
    this._persisting = true; this.setState({ saving: true });
    try {
      const r = await fetch('/api/state', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.buildDoc()) });
      if (r.status === 401) { location.href = '/login.html'; return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed');
      this.setState({ saving: false, loadError: '' });
    } catch (e) { this.setState({ saving: false, loadError: 'Not saved: ' + e.message }); }
    this._persisting = false;
    if (this._persistAgain) { this._persistAgain = false; this.persist(); }
  }
  componentWillUnmount() { window.removeEventListener('resize', this._onResize); if (this._ro) this._ro.disconnect(); }
  addTask(text, extra) { const { title, due } = parseQuick(text, new Date()); if (!title) return false;
    this.setState(s => ({ custom: [...s.custom, { id: uuid(), title, due, urgency: 'soon', owner: 'Jarrod', source: 'quick_add', meetings: [], projects: [], ...extra }] })); return true; }
  openMeetingEditor(m) {
    const to24 = t => { if (!t) return ''; const mm = toMin(t); return String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0'); };
    this.setState({ meetEdit: m ? { ...m, time24: to24(m.time), attendeesText: (m.attendees || []).join(', '), isNew: false }
      : { id: uuid(), key: '', title: '', type: 'General', cadence: '', time24: '', dur: 30, days: [], attendees: [], attendeesText: '', matchPattern: '', exclude: false, oneOff: false, oneOffDate: '', recaps: [], isNew: true } });
  }
  openSettings(rowId, withPicker) { this.setState(s => ({ settingsOpen: true, draft: JSON.parse(JSON.stringify(s.settings)), highlightRow: rowId || null, pickerFor: withPicker ? rowId : null, pickerSel: null, pickerQuery: '' })); }
  closeSettings() { this.setState(s => ({ settings: s.draft || s.settings, draft: null, settingsOpen: false, pickerFor: null, highlightRow: null, toast: 'Recap sources updated' }));
    clearTimeout(this._toast); this._toast = setTimeout(() => this.setState({ toast: '' }), 2600); }
  setDraft(fn) { this.setState(s => { const d = JSON.parse(JSON.stringify(s.draft)); fn(d); return { draft: d }; }); }
  resolveSource(m, cfg) { const ex = cfg.mappings[m.id]; if (ex && ex.folder) return { ...ex, via: 'explicit' };
    const p = cfg.patterns.find(p => p.folder && p.pattern && globMatch(p.pattern, m.title)); if (p) return { folder: p.folder, mode: p.mode, via: 'pattern' };
    if (cfg.defaultFolder) return { folder: cfg.defaultFolder, mode: 'title', via: 'default' }; return null; }
  setBlock(id, patch) { this.setState(s => ({ blocks: { ...s.blocks, [id]: { ...(s.blocks[id] || {}), ...patch } } })); }
  renderVals() {
    const { selected, tab, showDone, expanded, query, done, view, custom, blocks, panelNew, projNew, linkMeeting, linkProject, links, tagging, settings, draft, settingsOpen, pickerFor, pickerSel, pickerQuery, pickerExpanded, highlightRow, toast } = this.state;
    const cfg = draft || settings;
    const setLinks = (id, key, arr) => this.setState(s => ({ links: { ...s.links, [id]: { ...(s.links[id] || {}), [key]: arr } }, tagging: null }));
    const showOneOff = this.props.showOneOffMeeting !== false;
    MEETINGS = this.state.meetingsState;
    const MEET = showOneOff ? MEETINGS : MEETINGS.filter(m => !m.oneOff);
    const today0 = new Date(); const dow = today0.getDay(); const pad2 = n => String(n).padStart(2, '0'); const todayStr = today0.getFullYear() + '-' + pad2(today0.getMonth() + 1) + '-' + pad2(today0.getDate());
    const TODAY = MEET.filter(m => m.time && (m.oneOff ? m.oneOffDate === todayStr : (m.days || []).includes(dow)));
    const PROJ = this.state.projectsState;
    const byProject = Object.fromEntries(PROJ.map(p => [p.id, p]));
    const isMobile = this.props.forceMobile ? true : this.state.isMobile;
    const empty = !!this.props.emptyCalendar;
    const q = query.trim().toLowerCase();
    const match = s => !q || (s || '').toLowerCase().includes(q);
    const today = new Date();
    const overrideOverdue = !!this.props.markHq412Overdue;
    const openM = id => () => this.setState({ selected: id, tab: 'recaps', showDone: false });
    const dragStart = id => e => { e.dataTransfer.setData('text/plain', 'task:' + id); e.dataTransfer.effectAllowed = 'move'; };
    const celebrate = e => {
      const r = e.target.getBoundingClientRect(), id = Date.now() + Math.random();
      this.setState(s => ({ bursts: [...(s.bursts || []), { id, x: r.left + r.width / 2, y: r.top + r.height / 2 }] }));
      setTimeout(() => this.setState(s => ({ bursts: (s.bursts || []).filter(b => b.id !== id) })), 900);
    };
    const decorate = t => ({ ...t, done: !!done[t.id], toggle: e => { if (!done[t.id]) celebrate(e); this.setState(s => ({ done: { ...s.done, [t.id]: !s.done[t.id] } })); },
      ...URG[t.urgency], urgencyLabel: URG[t.urgency].label, ownerInitials: initials(t.owner), ownerBg: (PEOPLE[t.owner] || PEOPLE.Jarrod)[0], ownerFg: (PEOPLE[t.owner] || PEOPLE.Jarrod)[1] });
    const byMeeting = Object.fromEntries(MEETINGS.map(m => [m.id, m]));
    const ALL = [...ITEMS, ...custom].map(t => { const l = links[t.id] || {}; return { ...t,
      meetings: (l.meetings || t.meetings || [t.meeting].filter(Boolean)).filter(id => byMeeting[id] && (showOneOff || !byMeeting[id].oneOff)),
      projects: l.projects || t.projects || [t.project].filter(Boolean) }; });
    const meetingsRaw = empty ? [] : TODAY.filter(m => match(m.title) || match(m.type) || m.attendees.some(match)).sort((a, b) => toMin(a.time) - toMin(b.time));
    const meetings = meetingsRaw.map(m => {
      const open = ALL.filter(i => i.meetings.includes(m.id) && !done[i.id]).length;
      const sel = selected === m.id;
      return { ...m, color: TYPES[m.type], open: openM(m.id), bg: sel ? '#EFF6FF' : '#fff', border: sel ? '#3B82F6' : '#E5E7EB',
        openLabel: open + ' open item' + (open === 1 ? '' : 's'),
        avatars: m.attendees.map(a => ({ name: a, initials: initials(a), bg: person(a)[0], fg: person(a)[1] })) };
    });
    const mine = ALL.filter(t => t.owner === 'Jarrod').map(decorate).map(t => {
      const b = blocks[t.id];
      const remM = MEET.filter(mm => !t.meetings.includes(mm.id)), remP = PROJ.filter(p => !t.projects.includes(p.id));
      return { ...t, deco: t.done ? 'line-through' : 'none', textColor: t.done ? '#9CA3AF' : '#111111',
        meetingTags: t.meetings.map(id => byMeeting[id]).filter(Boolean).map(mm => ({ title: mm.title, color: TYPES[mm.type], open: openM(mm.id), remove: e => { e.stopPropagation(); setLinks(t.id, 'meetings', t.meetings.filter(x => x !== mm.id)); } })),
        projectTags: t.projects.map(id => byProject[id]).filter(Boolean).map(p => ({ title: p.name, remove: e => { e.stopPropagation(); setLinks(t.id, 'projects', t.projects.filter(x => x !== p.id)); } })),
        canTag: remM.length + remP.length > 0, tagLabel: !t.meetings.length && !t.projects.length ? 'Link' : 'Link more', tagging: tagging === t.id, needsMeeting: remM.length > 0, needsProject: remP.length > 0,
        openTagger: () => this.setState({ tagging: tagging === t.id ? null : t.id }), closeTagger: () => this.setState({ tagging: null }),
        tagMeetings: tagging === t.id ? remM.map(mm => ({ label: mm.title, dot: TYPES[mm.type], pick: () => setLinks(t.id, 'meetings', [...t.meetings, mm.id]) })) : [],
        tagProjects: tagging === t.id ? remP.map(p => ({ label: p.name, pick: () => setLinks(t.id, 'projects', [...t.projects, p.id]) })) : [], dueLabel: dueLabel(t.due, today), scheduled: b ? fromMin(b.start) + '–' + fromMin(b.start + b.dur) : '', dragStart: dragStart(t.id) };
    });
    const myTasks = mine.filter(t => match(t.title));
    const taskGroups = ['urgent', 'soon', 'ongoing'].map(u => { const ts = myTasks.filter(t => t.urgency === u); return { ...URG[u], tasks: ts, count: ts.filter(t => !t.done).length + ' open' }; }).filter(g => g.tasks.length);
    const openCount = mine.filter(t => !t.done).length;
    const projects = PROJ.filter(p => match(p.name)).map(p0 => {
      const linked = ALL.filter(t => t.projects.includes(p0.id)), doneLinked = linked.filter(t => done[t.id]).length;
      // Baseline percent represents work already done; every task (built-in or linked) is one unit of remaining work.
      // Adding a task grows the denominator (percent drops); completing one shrinks the open count (percent rises).
      const openAtLoad = p0.baselineOpen || 0;
      const baseUnits = p0.pct >= 100 ? openAtLoad : openAtLoad * p0.pct / (100 - p0.pct); // fractional; makes pct === p0.pct on first render
      const doneUnits = baseUnits + doneLinked, openUnits = linked.length - doneLinked;
      const pct = doneUnits + openUnits ? Math.min(100, Math.round(doneUnits / (doneUnits + openUnits) * 100)) : p0.pct;
      const p = { ...p0, pct }; const h = HEALTH[p.health]; const extra = linked.filter(t => !done[t.id]).map(t => t.title); return { ...p, edit: e => { e.stopPropagation(); this.setState({ projEdit: { ...p0, pctOrig: p0.pct, openNow: openUnits, isNew: false } }); }, tasks: extra, newText: expanded === p.id ? projNew : '', onNew: e => this.setState({ projNew: e.target.value }), onNewKey: e => { if (e.key === 'Enter' && this.addTask(e.target.value, { projects: [p.id] })) this.setState({ projNew: '' }); }, milestoneDate: p.date, healthLabel: h[0], pillBg: h[1], pillFg: h[2], pillDot: h[3], pctW: p.pct + '%', pctLabel: p.pct + '%', pctTitle: pct + '% · ' + openUnits + ' open task' + (openUnits === 1 ? '' : 's'), expanded: expanded === p.id, bg: expanded === p.id ? '#FAFAFA' : '#fff', toggle: () => this.setState(s => ({ expanded: s.expanded === p.id ? null : p.id })) }; });
    const tickets = TICKETS.filter(k => match(k.key) || match(k.title)).sort((a, b) => a.due.localeCompare(b.due)).map(k => {
      const overdue = new Date(k.due + 'T23:59:59') < today || (overrideOverdue && k.key === 'HQ-412');
      const hi = k.priority === 'High';
      return { ...k, url: 'https://cardshq.atlassian.net/browse/' + k.key, statusBg: STATUS[k.status][0], statusFg: STATUS[k.status][1], prioIcon: hi ? '↑' : '=', prioColor: hi ? '#DC2626' : '#6B7280',
        borderLeft: overdue ? '#DC2626' : 'transparent', dueLabel: (overdue ? 'Overdue · ' : 'Due ') + fmt(k.due), dueColor: overdue ? '#B91C1C' : '#6B7280', dueWeight: overdue ? 600 : 400 };
    });
    const dueThisMonth = TICKETS.filter(k => k.due && k.due.slice(0, 7) === todayStr.slice(0, 7)).length;
    const nowMin = today.getHours() * 60 + today.getMinutes();
    const nextId = (meetingsRaw.find(m => toMin(m.time) + m.dur > nowMin) || {}).id;
    meetings.forEach(m => { m.upNext = m.id === nextId; m.opacity = toMin(m.time) + m.dur <= nowMin ? 0.6 : 1; });
    const stats = [{ n: meetingsRaw.length, label: meetingsRaw.length === 1 ? 'meeting' : 'meetings' }, { n: openCount, label: 'open tasks' }, { n: dueThisMonth, label: 'Jira due this month' }];
    const atRisk = PROJ.filter(p => p.health !== 'Green').length;
    const { projEdit } = this.state;
    const setPE = (k, v) => this.setState(s => ({ projEdit: { ...s.projEdit, [k]: v } }));
    const pe = projEdit ? { ...projEdit, pctLabel: projEdit.pct + '%', canDelete: !projEdit.isNew, saveLabel: projEdit.isNew ? 'Create project' : 'Save changes', saveOpacity: projEdit.name.trim() ? 1 : 0.5,
      setName: e => setPE('name', e.target.value), setPct: e => setPE('pct', +e.target.value), setMilestone: e => setPE('milestone', e.target.value), setDate: e => setPE('date', e.target.value), setUpdate: e => setPE('update', e.target.value),
      healthOptions: ['Green', 'Yellow', 'Red'].map(hh => { const a = projEdit.health === hh; return { label: HEALTH[hh][0], dot: HEALTH[hh][3], bg: a ? '#fff' : 'transparent', fg: a ? '#111111' : '#6B7280', shadow: a ? '0 1px 2px rgba(17,17,17,0.08)' : 'none', pick: () => setPE('health', hh) }; }) } : { healthOptions: [] };
    const saveProject = () => { if (!projEdit || !projEdit.name.trim()) return; const { isNew, pctOrig, openNow, ...p } = projEdit;
      if (isNew || p.pct !== pctOrig) p.baselineOpen = isNew ? 0 : (openNow || 0);
      this.setState(s => ({ projectsState: isNew ? [...s.projectsState, p] : s.projectsState.map(x => x.id === p.id ? { ...x, ...p } : x), projEdit: null, expanded: p.id, toast: isNew ? 'Project created' : 'Project updated' }));
      clearTimeout(this._toast); this._toast = setTimeout(() => this.setState({ toast: '' }), 2600); };
    const deleteProject = () => { if (!projEdit) return; const id = projEdit.id; this.setState(s => ({ projectsState: s.projectsState.filter(x => x.id !== id), projEdit: null, expanded: null, toast: 'Project deleted' })); clearTimeout(this._toast); this._toast = setTimeout(() => this.setState({ toast: '' }), 2600); };
    // Calendar
    const slots = []; for (let m = DAY_START; m < DAY_END; m += 30) slots.push({ label: m % 60 === 0 ? hourLabel(m) : '', border: m % 60 === 0 ? '#E5E7EB' : '#F3F4F6' });
    const meetingBlocks = (empty ? [] : TODAY).map(m => { const s = toMin(m.time); return { title: m.title, type: m.type, color: TYPES[m.type], bg: TYPES[m.type] + '1F', open: openM(m.id), compact: m.dur <= 30, showMeta: m.dur > 30, pad: m.dur <= 30 ? '0 8px' : '4px 8px', start: fromMin(s).replace(/ [AP]M/, ''), top: (s - DAY_START) * PX_PER_MIN + 1 + 'px', height: m.dur * PX_PER_MIN - 3 + 'px', range: fromMin(s) + '–' + fromMin(s + m.dur) }; });
    const taskBlocks = Object.entries(blocks).map(([id, b]) => { const t = mine.find(x => String(x.id) === id); if (!t) return null; return {
      id, title: t.title, showMeta: b.dur > 30, pad: b.dur <= 30 ? '0 8px' : '4px 8px', top: (b.start - DAY_START) * PX_PER_MIN + 1 + 'px', height: b.dur * PX_PER_MIN - 3 + 'px', range: fromMin(b.start) + '–' + fromMin(b.start + b.dur),
      deco: t.done ? 'line-through' : 'none', status: t.done ? 'Done' : 'Focus block', bg: t.done ? '#F9FAFB' : '#EFF6FF', border: t.done ? '#D1D5DB' : '#3B82F6', fg: t.done ? '#9CA3AF' : '#1E3A8A',
      dragStart: e => { const r = e.currentTarget.getBoundingClientRect(); e.dataTransfer.setData('text/plain', 'move:' + id + ':' + (e.clientY - r.top)); e.dataTransfer.effectAllowed = 'move'; },
      unschedule: e => { e.stopPropagation(); this.setState(s => { const n = { ...s.blocks }; delete n[id]; return { blocks: n }; }); },
      resizeStart: e => { e.preventDefault(); e.stopPropagation(); const y0 = e.clientY, d0 = b.dur;
        const move = ev => this.setBlock(id, { dur: clamp(Math.round((d0 + (ev.clientY - y0) / PX_PER_MIN) / 15) * 15, 15, DAY_END - b.start) });
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); }
    }; }).filter(Boolean);
    const unscheduled = mine.filter(t => !t.done && !blocks[t.id]);
    const gridDrop = e => { e.preventDefault(); const data = e.dataTransfer.getData('text/plain'); if (!data) return; const [kind, id, off] = data.split(':');
      const y = e.clientY - e.currentTarget.getBoundingClientRect().top - (kind === 'move' ? +off : 0);
      const dur = (blocks[id] || {}).dur || 30, snap = kind === 'move' ? 15 : 30;
      this.setBlock(id, { start: clamp(DAY_START + Math.round(y / PX_PER_MIN / snap) * snap, DAY_START, DAY_END - dur), dur }); };
    const preview = query.trim() ? parseQuick(query, today) : null;
    const KW = { kelly: 'kelly', loyalty: 'loyalty', smile: 'loyalty', nathaniel: 'dev', mikhail: 'dev', 'hq-': 'dev', release: 'release', inventory: 'release', topps: 'release' };
    const PKW = { loyalty: 'loy', shipping: 'loy', topps: 'elev', pdp: 'elev', elevate: 'elev', dashboard: 'dash', gorgias: 'gorg', macro: 'gorg' };
    const auto = (map) => { const ql = query.toLowerCase(); const k = Object.keys(map).find(k => ql.includes(k)); return k ? map[k] : null; };
    const effMeetings = linkMeeting === undefined ? [auto(KW)].filter(Boolean) : linkMeeting;
    const effProjects = linkProject === undefined ? [auto(PKW)].filter(Boolean) : linkProject;
    const togg = (arr, id) => arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
    const chip = (active, color) => ({ bg: active ? '#EFF6FF' : '#fff', fg: active ? '#1D4ED8' : '#4B5563', border: active ? '#3B82F6' : '#E5E7EB', dot: color });
    const linkMeetings = MEET.map(m => ({ label: m.title, ...chip(effMeetings.includes(m.id), TYPES[m.type]), pick: () => this.setState({ linkMeeting: togg(effMeetings, m.id) }) }));
    const linkProjects = PROJ.map(p => ({ label: p.name, ...chip(effProjects.includes(p.id)), pick: () => this.setState({ linkProject: togg(effProjects, p.id) }) }));
    const addFromQuery = () => { if (this.addTask(query, { meetings: effMeetings, projects: effProjects })) this.setState({ query: '', linkMeeting: undefined, linkProject: undefined }); };
    // Panel
    const pm = byMeeting[selected];
    const items = pm ? ALL.filter(i => i.meetings.includes(pm.id)).map(decorate) : [];
    const openItems = items.filter(i => !i.done), doneItems = items.filter(i => i.done);
    const src = pm ? this.resolveSource(pm, settings) : null;
    const srcRecaps = pm && src ? [...pm.recaps.map(r => ({ ...r, kind: '' })), ...(src.mode === 'all' ? (FOLDER_FILES[src.folder] || []).map(f => ({ date: f, summary: 'Other file in this folder (not a recap).', kind: 'File' })) : [])] : [];
    const panel = pm ? { title: pm.title, type: pm.type, oneOff: !!pm.oneOff, unmapped: !pm.oneOff && !src, mapped: !pm.oneOff && !!src,
      folderPath: src ? folderPath(src.folder) + (src.via === 'default' ? ' (default)' : src.via === 'pattern' ? ' (pattern)' : '') : '',
      modeLabel: src ? (src.mode === 'all' ? 'All files in folder' : 'Matching “' + pm.title + '”') : '', mapFolder: () => this.openSettings(pm.id, true), color: TYPES[pm.type], cadence: pm.cadence, openCount: openItems.length, openCountLabel: openItems.length + ' open item' + (openItems.length === 1 ? '' : 's'),
      recaps: (pm.oneOff || src ? srcRecaps : []).map(r => ({ ...r, dateLabel: r.kind ? r.date : fmtDate(r.date), url: r.url || ('https://drive.google.com/drive/search?q=' + encodeURIComponent(pm.title + ' ' + r.date)) })), openItems, doneItems, noOpen: !openItems.length, hasDone: doneItems.length > 0, doneCount: '(' + doneItems.length + ')' } : { recaps: [], openItems: [], doneItems: [], openCount: '' };
    const on = '#3B82F6', off = '#6B7280';
    const seg = active => ({ bg: active ? '#fff' : 'transparent', fg: active ? '#111111' : '#6B7280', shadow: active ? '0 1px 2px rgba(17,17,17,0.08)' : 'none' });
    const segM = seg(view === 'meetings'), segC = seg(view === 'calendar');
    const COLORS = ['#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#EC4899'];
    const celebrations = React.createElement('div', { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 40 } },
      (this.state.bursts || []).map(b => React.createElement('div', { key: b.id, style: { position: 'absolute', left: b.x, top: b.y, width: 0, height: 0 } },
        React.createElement('span', { style: { position: 'absolute', left: -12, top: -12, width: 24, height: 24, borderRadius: '50%', border: '2px solid #10B981', animation: 'hqRing 500ms ease-out forwards' } }),
        ...Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2, d = 26 + (i % 3) * 10;
          return React.createElement('span', { key: i, style: { position: 'absolute', left: -3, top: -3, width: i % 2 ? 6 : 5, height: i % 2 ? 6 : 5, borderRadius: i % 3 ? '50%' : 1, background: COLORS[i % COLORS.length], '--dx': Math.cos(a) * d + 'px', '--dy': Math.sin(a) * d + 'px', animation: 'hqBurst 650ms cubic-bezier(.1,.7,.3,1) forwards' } }); }))));
    // Settings
    const recurring = MEETINGS.filter(m => !m.oneOff);
    const nextOcc = m => { if (!m.time || !(m.days || []).length) return '—'; const t = toMin(m.time); if (m.days.includes(dow) && t > nowMin) return 'Today, ' + m.time;
      for (let k = 1; k <= 7; k++) { const d = new Date(today); d.setDate(d.getDate() + k); if (m.days.includes(d.getDay())) return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } return '—'; };
    const seg2 = active => ({ bg: active ? '#fff' : 'transparent', fg: active ? '#111111' : '#6B7280', shadow: active ? '0 1px 2px rgba(17,17,17,0.08)' : 'none' });
    const chipFor = folder => folder ? { folderPath: folderPath(folder), chipBg: '#fff', chipBorder: '#E5E7EB', chipFg: '#111111', icon: '▰', iconColor: '#F59E0B' } : { folderPath: 'Not mapped', chipBg: '#F9FAFB', chipBorder: '#E5E7EB', chipFg: '#9CA3AF', icon: '⚠', iconColor: '#D97706' };
    const openPicker = id => e => { e.stopPropagation(); const cur = id === 'default' ? cfg.defaultFolder : id.startsWith('p:') ? (cfg.patterns.find(p => p.id === id) || {}).folder : (cfg.mappings[id] || {}).folder;
      const exp = { root: true, recaps: true }; let par = cur && FOLDER_INDEX[cur] ? FOLDER_INDEX[cur].parent : null; while (par) { exp[par] = true; par = FOLDER_INDEX[par].parent; }
      this.setState({ pickerFor: id, pickerSel: cur || null, pickerQuery: '', pickerExpanded: exp }); };
    const rowFor = (id, folder, mode) => { const s1 = seg2(mode !== 'all'), s2 = seg2(mode === 'all'); return { ...chipFor(folder), openPicker: openPicker(id), pickerOpen: pickerFor === id, z: pickerFor === id ? 5 : 1, rowBg: highlightRow === id ? '#FFFBEB' : 'transparent',
      titleBg: s1.bg, titleFg: s1.fg, titleShadow: s1.shadow, allBg: s2.bg, allFg: s2.fg, allShadow: s2.shadow }; };
    const setMode = (id, mode) => () => this.setDraft(d => { if (id.startsWith('p:')) { const p = d.patterns.find(p => p.id === id); if (p) p.mode = mode; } else d.mappings[id] = { ...(d.mappings[id] || {}), mode }; });
    const settingsRows = draft ? [
      ...recurring.map(m => { const ex = draft.mappings[m.id] || {}; return { id: m.id, isMeeting: true, isPattern: false, title: m.title, color: TYPES[m.type], cadence: m.cadence, next: nextOcc(m), edit: e => { e.stopPropagation(); this.openMeetingEditor(m); }, excluded: !!m.exclude, ...rowFor(m.id, ex.folder, ex.mode || 'title'), modeTitle: setMode(m.id, 'title'), modeAll: setMode(m.id, 'all') }; }),
      ...draft.patterns.map(p => ({ id: p.id, isMeeting: false, isPattern: true, pattern: p.pattern, cadence: 'Pattern', next: '—', ...rowFor(p.id, p.folder, p.mode || 'title'), modeTitle: setMode(p.id, 'title'), modeAll: setMode(p.id, 'all'),
        onPattern: e => { const v = e.target.value; this.setDraft(d => { const q = d.patterns.find(x => x.id === p.id); if (q) q.pattern = v; }); }, remove: () => this.setDraft(d => { d.patterns = d.patterns.filter(x => x.id !== p.id); }) }))
    ] : [];
    const defaultRow = draft ? rowFor('default', draft.defaultFolder, 'title') : { folderPath: '' };
    const unmappedCount = recurring.filter(m => !this.resolveSource(m, settings)).length;
    // Picker tree
    const pq = pickerQuery.trim().toLowerCase();
    const pickerNodes = [];
    if (pq) { Object.values(FOLDER_INDEX).forEach(({ node, path }) => { if (node.id !== 'root' && node.name.toLowerCase().includes(pq)) pickerNodes.push({ node, depth: 0, hint: path.slice(0, -1).join(' / ') || 'My Drive' }); }); }
    else { (function walk(n, depth) { pickerNodes.push({ node: n, depth, hint: '' }); if (pickerExpanded[n.id]) n.children.forEach(c => walk(c, depth + 1)); })(DRIVE, 0); }
    const pickerNodesOut = pickerNodes.map(({ node, depth, hint }) => ({ name: node.name, pad: 4 + depth * 16 + 'px', hint, chevVis: node.children.length && !pq ? 'visible' : 'hidden', chevRot: pickerExpanded[node.id] ? 'rotate(90deg)' : 'rotate(0)',
      bg: pickerSel === node.id ? '#EFF6FF' : 'transparent', fg: pickerSel === node.id ? '#1D4ED8' : '#111111',
      select: () => this.setState({ pickerSel: node.id }), toggle: e => { e.stopPropagation(); this.setState(s => ({ pickerExpanded: { ...s.pickerExpanded, [node.id]: !s.pickerExpanded[node.id] } })); } }));
    const crumbPath = pickerSel && FOLDER_INDEX[pickerSel] ? ['root', ...(function chain(id) { const out = []; let c = id; while (c && c !== 'root') { out.unshift(c); c = FOLDER_INDEX[c].parent; } return out; })(pickerSel)] : ['root'];
    const pickerCrumbs = crumbPath.map((id, i) => ({ name: FOLDER_INDEX[id].node.name, sep: i < crumbPath.length - 1 ? '›' : '', color: i === crumbPath.length - 1 ? '#111111' : '#6B7280', weight: i === crumbPath.length - 1 ? 600 : 400,
      go: () => this.setState(s => ({ pickerSel: id, pickerQuery: '', pickerExpanded: { ...s.pickerExpanded, [id]: true } })) }));
    const confirmPick = () => { if (!pickerSel || pickerSel === 'root') return; const id = pickerFor; this.setDraft(d => { if (id === 'default') d.defaultFolder = pickerSel; else if (id.startsWith('p:')) { const p = d.patterns.find(p => p.id === id); if (p) p.folder = pickerSel; } else d.mappings[id] = { ...(d.mappings[id] || { mode: 'title' }), folder: pickerSel }; }); this.setState({ pickerFor: null, highlightRow: null }); };
    const modalNarrow = isMobile;
    // Meeting editor
    const { meetEdit } = this.state;
    const setME = (k, v) => this.setState(s => ({ meetEdit: { ...s.meetEdit, [k]: v } }));
    const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const me = meetEdit ? { ...meetEdit, saveLabel: meetEdit.isNew ? 'Add meeting' : 'Save changes', canDelete: !meetEdit.isNew, saveOpacity: meetEdit.title.trim() ? 1 : 0.5,
      setTitle: e => setME('title', e.target.value), setCadence: e => setME('cadence', e.target.value), setTime: e => setME('time24', e.target.value), setDur: e => setME('dur', Math.max(5, +e.target.value || 30)),
      setAttendees: e => setME('attendeesText', e.target.value), setPattern: e => setME('matchPattern', e.target.value), setOneOffDate: e => setME('oneOffDate', e.target.value),
      toggleExclude: () => setME('exclude', !meetEdit.exclude), toggleOneOff: () => setME('oneOff', !meetEdit.oneOff),
      excludeBg: meetEdit.exclude ? '#111111' : '#fff', excludeFg: meetEdit.exclude ? '#fff' : '#374151', oneOffBg: meetEdit.oneOff ? '#111111' : '#fff', oneOffFg: meetEdit.oneOff ? '#fff' : '#374151',
      typeOptions: TYPE_LIST.map(tp => { const a = meetEdit.type === tp; return { label: tp, dot: TYPES[tp], bg: a ? '#fff' : 'transparent', fg: a ? '#111111' : '#6B7280', shadow: a ? '0 1px 2px rgba(17,17,17,0.08)' : 'none', pick: () => setME('type', tp) }; }),
      dayOptions: DAY_LABELS.map((l, i) => { const a = (meetEdit.days || []).includes(i); return { label: l, bg: a ? '#111111' : '#fff', fg: a ? '#fff' : '#374151', border: a ? '#111111' : '#E5E7EB', pick: () => setME('days', a ? meetEdit.days.filter(d => d !== i) : [...(meetEdit.days || []), i].sort()) }; }) } : { typeOptions: [], dayOptions: [] };
    const saveMeeting = () => { if (!meetEdit || !meetEdit.title.trim()) return; const { isNew, time24, attendeesText, ...m } = meetEdit;
      const t24 = time24 || ''; const time = t24 ? fromMin(+t24.slice(0, 2) * 60 + +t24.slice(3, 5)) : '';
      const rec = { ...m, title: m.title.trim(), time, attendees: (attendeesText || '').split(',').map(x => x.trim()).filter(Boolean), days: m.oneOff ? [] : (m.days || []), recaps: m.recaps || [] };
      this.setState(s => ({ meetingsState: isNew ? [...s.meetingsState, rec] : s.meetingsState.map(x => x.id === rec.id ? { ...x, ...rec } : x), meetEdit: null, toast: isNew ? 'Meeting added' : 'Meeting updated' }));
      clearTimeout(this._toast); this._toast = setTimeout(() => this.setState({ toast: '' }), 2600); };
    const deleteMeeting = () => { if (!meetEdit) return; const id = meetEdit.id; this.setState(s => ({ meetingsState: s.meetingsState.filter(x => x.id !== id), meetEdit: null, selected: s.selected === id ? null : s.selected, toast: 'Meeting removed' })); clearTimeout(this._toast); this._toast = setTimeout(() => this.setState({ toast: '' }), 2600); };
    const meetingCountLabel = MEETINGS.length + ' meeting' + (MEETINGS.length === 1 ? '' : 's') + ' configured';
    return {
      loaded: this.state.loaded, loading: !this.state.loaded && !this.state.loadError, loadError: this.state.loadError, saveLabel: this.state.saving ? 'Saving…' : (this.state.loadError ? '' : 'Saved'), saveColor: this.state.loadError ? '#B91C1C' : '#9CA3AF',
      signOut: async () => { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login.html'; },
      meetEditOpen: !!meetEdit, me, meetEditTitle: meetEdit && meetEdit.isNew ? 'New meeting' : 'Edit meeting', newMeeting: () => this.openMeetingEditor(null), cancelMeeting: () => this.setState({ meetEdit: null }), saveMeeting, deleteMeeting, meetingCountLabel,
      noTickets: !tickets.length, noProjects: !projects.length,
      projEditOpen: !!projEdit, pe, projEditTitle: projEdit && projEdit.isNew ? 'New project' : 'Edit project', projModalWidth: isMobile ? '100vw' : '560px',
      newProject: () => this.setState({ projEdit: { id: uuid(), name: '', health: 'Green', pct: 0, baselineOpen: 0, milestone: '', date: '', update: '', isNew: true } }),
      cancelProject: () => this.setState({ projEdit: null }), saveProject, deleteProject,
      openSettings: () => this.openSettings(), closeSettings: () => this.closeSettings(), settingsOpen, hasUnmapped: unmappedCount > 0, toast,
      defaultZ: pickerFor === 'default' ? 6 : 1, modalTop: modalNarrow ? 'auto' : '6vh', modalBottom: modalNarrow ? '0' : 'auto', modalWidth: modalNarrow ? '100vw' : '960px', modalMaxH: modalNarrow ? '92vh' : '84vh', modalRadius: modalNarrow ? '12px 12px 0 0' : '12px',
      settingsCols: modalNarrow ? '1.4fr 1.4fr auto' : '1.5fr 1fr 0.8fr 1.7fr auto', settingsWide: !modalNarrow, settingsNarrow: modalNarrow,
      pickerView: !!pickerFor, tableView: !pickerFor, pickerForLabel: pickerFor === 'default' ? 'Default folder' : pickerFor && pickerFor.startsWith('p:') ? 'title pattern' : pickerFor && byMeeting[pickerFor] ? byMeeting[pickerFor].title : '',
      settingsRows, defaultRow, addPattern: () => this.setDraft(d => { d.patterns.push({ id: 'p:' + uuid(), pattern: '', folder: null, mode: 'title' }); }),
      settingsStatus: draft ? (settingsRows.filter(r => r.isMeeting && r.folderPath === 'Not mapped').length ? settingsRows.filter(r => r.isMeeting && r.folderPath === 'Not mapped').length + ' meeting' + (settingsRows.filter(r => r.isMeeting && r.folderPath === 'Not mapped').length === 1 ? '' : 's') + ' without a recap folder' : 'All recurring meetings mapped') : '',
      pickerWidth: modalNarrow ? 'calc(100vw - 48px)' : '380px', pickerQuery, onPickerQuery: e => this.setState({ pickerQuery: e.target.value }), pickerCrumbs, pickerNodes: pickerNodesOut, pickerEmpty: !!pq && !pickerNodesOut.length,
      pickerSelLabel: pickerSel && pickerSel !== 'root' ? 'Selected: ' + folderPath(pickerSel) : 'Select a folder', confirmOpacity: pickerSel && pickerSel !== 'root' ? 1 : 0.5, confirmPick, cancelPick: () => this.setState({ pickerFor: null }),
      celebrations, stats, noQuery: !query, projectSummary: atRisk ? atRisk + ' at risk' : 'All on track', projectSummaryDisplay: (isMobile || window.innerWidth >= 1180) ? 'inline' : 'none',
      nowVisible: nowMin >= DAY_START && nowMin <= DAY_END, nowTop: (nowMin - DAY_START) * PX_PER_MIN + 8 + 'px',
      dateLabel: today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      summary: `${meetingsRaw.length} meeting${meetingsRaw.length === 1 ? '' : 's'} · ${openCount} open task${openCount === 1 ? '' : 's'} · ${dueThisMonth} Jira tickets due this month`,
      query, onQuery: e => this.setState({ query: e.target.value }),
      gridCols: isMobile ? '1fr' : '40fr 35fr 25fr',
      viewMeetings: () => this.setState({ view: 'meetings' }), viewCalendar: () => this.setState({ view: 'calendar' }),
      meetingsBtnBg: segM.bg, meetingsBtnFg: segM.fg, meetingsBtnShadow: segM.shadow, calendarBtnBg: segC.bg, calendarBtnFg: segC.fg, calendarBtnShadow: segC.shadow,
      showMeetingsView: view === 'meetings', showCalendarView: view === 'calendar',
      meetings, meetingCount: meetings.length ? meetings.length + ' today' : '', noMeetings: !meetings.length, hasMeetings: meetings.length > 0,
      slots, meetingBlocks, taskBlocks, unscheduled, noUnscheduled: !unscheduled.length, gridDrop, gridDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
      quickPreview: preview ? '↵ adds “' + preview.title + '” · Soon' + (preview.due ? ' · due ' + dueLabel(preview.due, today) : '') + effMeetings.map(id => ' · ' + byMeeting[id].title).join('') + effProjects.map(id => ' · ' + byProject[id].name).join('') : '',
      addFromQuery, linkMeetings, linkProjects,
      panelNew, onPanelNew: e => this.setState({ panelNew: e.target.value }), onPanelNewKey: e => { if (e.key === 'Enter' && pm && this.addTask(e.target.value, { meetings: [pm.id] })) this.setState({ panelNew: '' }); },
      onQuickKey: e => { if (e.key === 'Enter') addFromQuery(); if (e.key === 'Escape') this.setState({ query: '' }); },
      taskGroups, openTaskLabel: openCount + ' open',
      projects, tickets,
      panelOpen: !!pm, closePanel: () => this.setState({ selected: null }),
      panelWidth: isMobile ? '100vw' : '440px', panelTransform: pm ? 'translateX(0)' : 'translateX(105%)',
      panel, tabRecaps: () => this.setState({ tab: 'recaps' }), tabActions: () => this.setState({ tab: 'actions' }),
      showRecaps: tab === 'recaps', showActions: tab === 'actions',
      recapsTabBorder: tab === 'recaps' ? on : 'transparent', recapsTabColor: tab === 'recaps' ? '#111111' : off,
      actionsTabBorder: tab === 'actions' ? on : 'transparent', actionsTabColor: tab === 'actions' ? '#111111' : off,
      showDone, toggleDone: () => this.setState(s => ({ showDone: !s.showDone })), doneChevron: showDone ? 'rotate(90deg)' : 'rotate(0deg)'
    };
  }
}
