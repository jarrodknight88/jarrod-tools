// Pull readable text out of an attached file so Claude's task worker can use it.
// No dependencies: Word, Excel and PowerPoint files are zip archives of XML, read here with Node's zlib.
// PDFs and images are not handled; those come back with a note saying so.
import { inflateRawSync } from 'node:zlib';

const MAX_CHARS = 60000;
const ext = name => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'log', 'yaml', 'yml', 'rtf']);

// Read named entries from a zip archive. `want` picks entries by name.
export function unzip(buf, want) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!want(name) || usize > 40 * 1024 * 1024) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    out[name] = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
  }
  return out;
}

const ents = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const strip = xml => ents(xml.replace(/<[^>]+>/g, ''));
const numOrder = (a, b) => (+(a.match(/(\d+)\.xml$/) || [0, 0])[1]) - (+(b.match(/(\d+)\.xml$/) || [0, 0])[1]);

function docx(buf) {
  const f = unzip(buf, n => n === 'word/document.xml')['word/document.xml'];
  if (!f) throw new Error('no document text found');
  // A table row becomes one line with tabs between cells.
  const xml = f.toString('utf8').replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, row => '<w:p>' + [...row.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map(c => c[0].replace(/<\/w:p>/g, ' ').replace(/<\/?w:tc[^>]*>/g, '')).join('<w:tab/>') + '</w:p>');
  return strip(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:p>/g, '\n')).replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function xlsx(buf) {
  const f = unzip(buf, n => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [];
  if (f['xl/sharedStrings.xml']) for (const m of f['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(strip(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const names = f['xl/workbook.xml'] ? [...f['xl/workbook.xml'].toString('utf8').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => ents(m[1])) : [];
  const colNum = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const parts = [];
  Object.keys(f).filter(n => n.startsWith('xl/worksheets/')).sort(numOrder).forEach((n, i) => {
    const rows = [];
    for (const r of f[n].toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] || '', ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1], type = (attrs.match(/t="(\w+)"/) || [])[1];
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const val = type === 's' ? (shared[+v] ?? '') : type === 'inlineStr' ? strip(body) : v == null ? '' : ents(v);
        const at = ref ? colNum(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = String(val).replace(/[\t\n]+/g, ' ');
      }
      if (cells.some(x => x !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) parts.push(`Sheet: ${names[i] || i + 1}\n${rows.join('\n')}`);
  });
  if (!parts.length) throw new Error('no cells found');
  return parts.join('\n\n');
}

function pptx(buf) {
  const f = unzip(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = Object.keys(f).sort(numOrder).map((n, i) => `Slide ${i + 1}\n${strip(f[n].toString('utf8').replace(/<\/a:p>/g, '\n')).replace(/\n{2,}/g, '\n').trim()}`);
  if (!slides.length) throw new Error('no slides found');
  return slides.join('\n\n');
}

// Returns { text } when the file could be read, or { note } saying why not.
export function extractText(buf, name, mime = '') {
  const e = ext(name), m = String(mime || '').toLowerCase();
  try {
    let text = null;
    if (e === 'docx') text = docx(buf);
    else if (e === 'xlsx' || e === 'xlsm') text = xlsx(buf);
    else if (e === 'pptx') text = pptx(buf);
    else if (TEXT_EXT.has(e) || m.startsWith('text/') || m === 'application/json') text = buf.toString('utf8').replace(/^﻿/, '');
    else if (e === 'pdf' || m === 'application/pdf') return { viaDrive: true, note: 'PDF: this file could not be passed to Claude. Ask Jarrod to paste the key parts or attach it as Word, Excel, CSV or text.' };
    else if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(e)) return { viaDrive: true, note: 'Image: this picture could not be passed to Claude. Ask Jarrod to describe what it shows.' };
    else return { note: `This file type (${e || m || 'unknown'}) cannot be read for Claude yet.` };
    text = text.replace(/\u0000/g, '').trim();
    if (!text) return { note: 'The file had no readable text.' };
    return text.length > MAX_CHARS ? { text: text.slice(0, MAX_CHARS), note: `Only the first ${MAX_CHARS.toLocaleString('en-US')} characters are included; the file is longer.` } : { text };
  } catch (err) {
    return { note: 'The file could not be read: ' + (err.message || 'unknown error') };
  }
}
