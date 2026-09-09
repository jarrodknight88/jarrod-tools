// Turns a Granola note into a structured recap (JSON) via the Anthropic API, then into HTML for Drive to convert to a Google Doc.
const MODEL = 'claude-sonnet-4-6';

const GLOSSARY = `Transcription corrections (always apply): "Tops" or "TOPS" = Topps; "Dizzy" or "busy" = Digi (Steven Polizzi, design vendor); "Jeff" = Geoff (CEO); "Colin" = Collin (Shipping Manager); "Lloyds Online" or "loyalty line" = LoyaltyLion; "Gorgeous" = Gorgias; "Macau", "Miguel", "McGow" = Mikhail (developer); "Teapot" = Tyler; "Nate" = Nathaniel (lead developer); "Zac" = Zach; "Grady Grails" = Graded Grails; "meth" = Meta.
People: Kelly (EVP Media and Marketing), Geoff (CEO), Carter (Owner-operator), Matthew (CFO), Dan (VP Product), Nathaniel and Mikhail (developers at Sevenbrand - all dev, API, and Zapier work goes to Nathaniel, never John), John (Digital Marketing Manager), Jared (Head of UX/UI - distinct from Jarrod), Jawad (IT), Collin (Shipping), Lei/Layton (social), Jimmy (Inventory, COGS), Zach (sports inventory), Jasmine (TCG inventory), Mike (Director of Buying, TCG), Sammy (LoyaltyLion), Parker (events co-host).
Company: CardsHQ, Atlanta sports and trading card retailer on Shopify Plus with a headless storefront. Never write the word "Fragment"; say "the headless storefront". Whatnot revenue is excluded from loyalty scope. Email/SMS platform is Mailchimp (never Klaviyo). Reviews platform is Judge.me. Segmentation is Tresl.
Style: single hyphens only, never em dashes or double spaces. Concise, confident, no hedging. Name sections after topics, not people.`;

export function buildPrompt(note, meetingTitle) {
  return `You are writing the post-meeting recap for Jarrod Knight (Director of Ecommerce, moving into Product Manager, at CardsHQ). "Me" in the transcript is usually Jarrod.

${GLOSSARY}

Meeting: ${meetingTitle || note.title}
Date: ${note.start}
Attendees (from calendar): ${note.attendees.join(', ') || 'unknown'}

Granola's own summary (use as a guide, but the transcript is the source of truth - Granola summaries sometimes misassign who owns an action):
${note.summaryMarkdown || '(none)'}

Transcript:
${note.transcriptText.slice(0, 120000)}

Return ONLY a JSON object, no markdown fences, with this exact shape:
{
  "headline": "one line, under 15 words, what this meeting was about",
  "summary": "two to three sentences a time-constrained executive could read alone",
  "sections": [
    { "title": "Decisions Made", "items": [ { "lead": "short bold lead-in.", "text": "one to three sentences of detail" } ] },
    { "title": "Open Items / Flagged for Review", "items": [ ... ] },
    { "title": "Next Steps", "items": [ ... ] }
  ],
  "keyDates": [ "Sep 16 - Pokemon launch" ],
  "tasks": [
    { "title": "imperative task under 100 characters", "owner": "first name, or 'Jarrod'", "urgency": "urgent|soon|ongoing", "due_date": "YYYY-MM-DD or null", "notes": "optional detail or null" }
  ]
}
Rules: urgent = today, tomorrow, or this week; soon = within two weeks or a named date; ongoing = open-ended. Only include tasks someone actually committed to. Attribute each task to the person who said they would do it in the transcript. Include tasks owned by other people too - Jarrod tracks what he is waiting on. Add a section only if it has content; you may add one topic-specific section (e.g. "Shop Channel Performance") before Decisions Made when the meeting reported numbers. Keep every number exactly as stated; if figures are quoted per-day but do not sum to a stated total, say the list is as read out rather than implying it sums.`;
}

export async function generateRecap(note, meetingTitle) {
  const key = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, messages: [{ role: 'user', content: buildPrompt(note, meetingTitle) }] }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (j.error?.message || 'error'));
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = clean.indexOf('{');
  const recap = JSON.parse(clean.slice(start));
  recap.tasks = (recap.tasks || []).filter(t => t && t.title).map(t => ({ title: String(t.title).slice(0, 200), owner: t.owner || 'Jarrod', urgency: ['urgent', 'soon', 'ongoing'].includes(t.urgency) ? t.urgency : 'soon', due_date: /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null, notes: t.notes || null }));
  return recap;
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }); };

// HTML that Drive converts into a Google Doc. Inline styles only; Docs keeps headings, bold, tables, and cell shading.
export function recapHtml(recap, note, meetingTitle, hubUrl) {
  const urg = { urgent: ['#FEE2E2', '#991B1B', 'This week'], soon: ['#FEF3C7', '#92400E', 'Within two weeks'], ongoing: ['#F3F4F6', '#374151', 'Ongoing'] };
  const byOwner = {};
  for (const t of recap.tasks) (byOwner[t.owner] ||= []).push(t);
  const owners = Object.keys(byOwner).sort((a, b) => (a === 'Jarrod' ? -1 : b === 'Jarrod' ? 1 : a.localeCompare(b)));
  const section = (title, items) => `<h2 style="color:#3B82F6;font-size:12pt;text-transform:uppercase;letter-spacing:0.5pt;margin-top:18pt">${esc(title)}</h2><ul>${items.map(i => `<li style="margin-bottom:6pt"><b>${esc(i.lead || '')}</b> ${esc(i.text || '')}</li>`).join('')}</ul>`;
  const table = (owner, items) => `<p style="margin-top:12pt"><b>${esc(owner)}</b></p><table style="border-collapse:collapse;width:100%"><tr><th style="background:#111111;color:#ffffff;text-align:left;padding:6pt;font-size:9.5pt;width:62%">Action Item</th><th style="background:#111111;color:#ffffff;text-align:left;padding:6pt;font-size:9.5pt;width:18%">Owner</th><th style="background:#111111;color:#ffffff;text-align:left;padding:6pt;font-size:9.5pt;width:20%">Timing</th></tr>${items.map(t => `<tr><td style="border:1px solid #E5E7EB;padding:6pt;font-size:9.5pt">${esc(t.title)}${t.notes ? `<br><span style="color:#6B7280">${esc(t.notes)}</span>` : ''}</td><td style="border:1px solid #E5E7EB;padding:6pt;font-size:9.5pt">${esc(t.owner)}</td><td style="border:1px solid #E5E7EB;padding:6pt;font-size:9.5pt;background:${urg[t.urgency][0]};color:${urg[t.urgency][1]}">${esc(t.due_date ? new Date(t.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : urg[t.urgency][2])}</td></tr>`).join('')}</table>`;
  return `<html><body style="font-family:Arial;font-size:10.5pt;color:#111111">
<table style="width:100%;border-collapse:collapse"><tr><td style="background:#111111;color:#ffffff;padding:14pt 16pt"><span style="font-size:17pt;font-weight:bold">${esc(meetingTitle || note.title)}</span><br><span style="font-size:11pt;color:#D1D5DB">${esc(fmtDate(note.start))} - ${esc(recap.headline)}</span><br><span style="font-size:9pt;color:#9CA3AF">Attendees: ${esc(note.attendees.join(', ') || 'not captured')} - Captured in Granola, recap generated automatically</span></td></tr></table>
<table style="width:100%;border-collapse:collapse;margin-top:10pt"><tr><td style="background:#ECFDF5;border:1px solid #10B981;padding:8pt 12pt;font-size:10pt"><b style="color:#065F46">Live action items</b><br>Every item below is tracked in the Command Center and linked to this meeting: <a href="${esc(hubUrl)}" style="color:#065F46">${esc(hubUrl)}</a></td></tr></table>
<table style="width:100%;border-collapse:collapse;margin-top:10pt"><tr><td style="background:#F3F4F6;border:1px solid #E5E7EB;padding:8pt 12pt;font-size:10pt"><b style="color:#6B7280">Summary</b><br>${esc(recap.summary)}</td></tr></table>
${(recap.sections || []).filter(s => s.items && s.items.length).map(s => section(s.title, s.items)).join('')}
${recap.keyDates && recap.keyDates.length ? `<table style="width:100%;border-collapse:collapse;margin-top:10pt"><tr><td style="background:#F3F4F6;border:1px solid #E5E7EB;padding:8pt 12pt;font-size:10pt"><b style="color:#6B7280">Key dates</b><br>${recap.keyDates.map(esc).join('<br>')}</td></tr></table>` : ''}
<h2 style="color:#3B82F6;font-size:12pt;text-transform:uppercase;letter-spacing:0.5pt;margin-top:18pt">Action Items</h2>
<p style="color:#6B7280;font-size:9.5pt">Open items by owner. Timing badges: red = this week, amber = within two weeks, gray = ongoing. Track and check off at <a href="${esc(hubUrl)}">${esc(hubUrl)}</a></p>
${owners.map(o => table(o, byOwner[o])).join('')}
</body></html>`;
}

export const mdy = iso => { const d = new Date(iso); return `${d.getMonth() + 1}.${d.getDate()}.${String(d.getFullYear()).slice(2)}`; };
