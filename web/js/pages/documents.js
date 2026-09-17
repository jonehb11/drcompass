// Documents — upload the context you already have, and let the AI turn it into
// proposals you review before anything changes.
//
// Three promises this page has to keep:
//
//   1. Extraction is never silent. Plain text and markdown always work. DOCX is
//      a real extraction (it is a ZIP; the platform inflates it). PDF is
//      best-effort and SAYS SO — when the bytes do not give up honest text, the
//      page asks you to paste it in rather than storing an empty document and
//      letting the AI "read" nothing.
//   2. Nothing is applied without a click. The proposals go through the ONE
//      operations review block the whole app shares (ai-actions.js), and the one
//      apply path (/ai/apply).
//   3. Every proposal shows the sentence it came from. The server checks that
//      sentence against the stored text, so a proposal that cannot be traced to
//      the document arrives already greyed out.
import {
  h, card, cardHead, pageHead, table, badge, btn, empty, banner, modal, toast,
  confirmDialog, fmtDate, relTime, spinner,
} from '../ui.js';
import {
  operationsBlock, aiAvailable, INSTALL_HINT, INSTALL_STEPS, installHint, aiToolName,
} from '../ai-actions.js';

// ---------------------------------------------------------------- styling
// Scoped and idempotent — app.css is shared, so the handful of classes this
// page needs live here (same pattern as ai-actions.js).
const STYLE = `
.doc-drop { border: 1.5px dashed var(--border); border-radius: var(--radius); padding: 22px 18px;
  text-align: center; background: var(--panel2); transition: border-color .15s, background .15s; }
.doc-drop.over { border-color: var(--accent); background: var(--accent-soft); }
.doc-drop-title { font-weight: 650; margin-bottom: 4px; }
.doc-extract { margin-top: 14px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--panel2); padding: 12px 14px; }
.doc-extract-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.doc-extract-name { font-weight: 650; }
.doc-preview { max-height: 190px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--mono); font-size: 11.5px; color: var(--muted); background: var(--bg2);
  border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; margin-top: 8px; }
.doc-text-view { max-height: 58vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--bg2);
  border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.doc-cite { border-left: 3px solid var(--accent); padding: 6px 11px; margin: 6px 0;
  background: var(--panel2); border-radius: 0 8px 8px 0; font-size: 12.5px; }
.doc-cite.unverified { border-left-color: var(--err); }
.doc-cite q { color: var(--text); font-style: italic; }
.doc-block { margin: 0 0 16px; }
.doc-block-head { font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); font-weight: 700; margin-bottom: 7px; }
.doc-item { border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px;
  background: var(--panel2); margin-bottom: 7px; }
.doc-item.warn { border-left: 3px solid var(--warn); }
.doc-item.err { border-left: 3px solid var(--err); }
.doc-item-title { font-weight: 650; font-size: 13px; }
.doc-item-body { font-size: 12.5px; color: var(--muted); margin-top: 3px; }
.doc-conflict-vs { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 5px; font-size: 12px; }
.doc-conflict-vs > div { flex: 1 1 200px; border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
.doc-conflict-k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.doc-row-name { font-weight: 600; }
.doc-row-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.doc-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.doc-flow-opt { display: block; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  margin-bottom: 8px; cursor: pointer; background: var(--panel2); }
.doc-flow-opt:hover { border-color: var(--accent); }
.doc-flow-opt input { width: auto; margin-right: 8px; }
.doc-flow-name { font-weight: 650; font-size: 13px; }
.doc-flow-why { font-size: 12px; color: var(--muted); margin: 3px 0 0 22px; }
`;

function ensureStyle() {
  if (document.getElementById('documents-page-style')) return;
  document.head.append(h('style', { id: 'documents-page-style' }, STYLE));
}

// ============================================================================
// TEXT EXTRACTION — in the browser, with platform APIs only. No dependency is
// added, and nothing here pretends to have read something it did not.
// ============================================================================

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|yaml|yml|xml|html?|rst|adoc|org|ini|conf|sql)$/i;
const TEXT_MIME = /^text\/|json|yaml|xml|markdown|csv/i;

const dec = (bytes, enc = 'utf-8') => new TextDecoder(enc, { fatal: false }).decode(bytes);

const canInflate = () => typeof DecompressionStream === 'function';

/**
 * Inflate, keeping whatever decoded before a complaint. DecompressionStream
 * throws "trailing junk" when anything follows a complete deflate stream — and
 * a PDF always puts an EOL between the stream data and `endstream`, so the
 * strict form fails on the commonest PDF there is. The bytes it had already
 * emitted are still correct, so they are kept; an error before ANY output is a
 * real failure and is rethrown.
 */
async function inflate(bytes, format) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    if (!total) throw e;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ------------------------------------------------------------------- ZIP
// Just enough of the central directory to pull ONE member out of a .docx.

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function zipEntries(bytes) {
  // End of central directory: scan back over the max comment length.
  let eocd = -1;
  const from = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== 0x02014b50) break;
    const method = u16(bytes, at + 10);
    const compSize = u32(bytes, at + 20);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const name = dec(bytes.subarray(at + 46, at + 46 + nameLen));
    out.push({ name, method, compSize, localAt });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function zipRead(bytes, entry) {
  if (u32(bytes, entry.localAt) !== 0x04034b50) throw new Error(`corrupt local header for ${entry.name}`);
  const nameLen = u16(bytes, entry.localAt + 26);
  const extraLen = u16(bytes, entry.localAt + 28);
  const start = entry.localAt + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;                       // stored
  if (entry.method === 8) return inflate(raw, 'deflate-raw'); // deflate
  throw new Error(`compression method ${entry.method} is not supported`);
}

// ------------------------------------------------------------------ DOCX

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unentity = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => XML_ENT[n]);

function docxXmlToText(xml) {
  return unentity(xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, ''))
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractDocx(bytes) {
  if (!canInflate()) {
    return {
      text: '', method: 'docx', confident: false,
      note: 'This browser has no DecompressionStream, so a .docx (which is a ZIP) cannot be opened here.',
    };
  }
  const entries = zipEntries(bytes);
  const wanted = ['word/document.xml', ...entries.filter((e) => /^word\/(header|footer)\d*\.xml$/.test(e.name)).map((e) => e.name)];
  const parts = [];
  for (const name of wanted) {
    const entry = entries.find((e) => e.name === name);
    if (!entry) continue;
    try { parts.push(docxXmlToText(dec(await zipRead(bytes, entry)))); } catch { /* skip that part */ }
  }
  const body = parts.filter(Boolean).join('\n\n').trim();
  if (!body) {
    return {
      text: '', method: 'docx', confident: false,
      note: 'The .docx opened, but word/document.xml held no readable text. If the content is inside images or an embedded object, this page cannot read it.',
    };
  }
  return {
    text: body, method: 'docx', confident: true,
    note: `Read word/document.xml out of the .docx (a ZIP) and stripped the markup — ${body.length.toLocaleString()} characters. Text in images or embedded objects is not included.`,
  };
}

// ------------------------------------------------------------------- PDF
//
// Honest position: this is a best-effort reader, not a PDF engine. It inflates
// the Flate streams and pulls the text-showing operators out of them, which
// works for PDFs written by ordinary word processors and exporters. It does NOT
// do custom font encodings, CID fonts, or scanned pages — and rather than hand
// those back as mojibake, `looksLikeProse()` fails them and the page asks the
// user to paste the text instead.

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return s;
};

const PDF_ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function pdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (n === '\n') { /* line continuation */ } else {
      out += PDF_ESC[n] ?? n;
    }
  }
  return out;
}

function pdfHexString(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  let out = '';
  // A hex string is bytes; UTF-16BE is common for anything non-ASCII.
  if (/^feff/i.test(clean)) {
    for (let i = 4; i + 3 < clean.length + 1; i += 4) out += String.fromCharCode(parseInt(clean.substr(i, 4), 16));
    return out;
  }
  for (let i = 0; i + 1 < clean.length + 1; i += 2) out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
  return out;
}

/** Pull the text-showing operators out of one PDF content stream. */
function pdfContentText(content) {
  let out = '';
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bT[Jj]\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b|\bBT\b|'|"/g;
  let pending = '';
  let m;
  while ((m = re.exec(content))) {
    const tok = m[0];
    if (tok[0] === '(') pending += pdfString(tok.slice(1, -1));
    else if (tok[0] === '<' && tok[1] !== '<') pending += pdfHexString(tok.slice(1, -1));
    else if (tok === 'Tj' || tok === 'TJ' || tok === "'" || tok === '"') { out += pending; pending = ''; if (tok !== 'TJ') out += '\n'; }
    else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') { out += pending; pending = ''; out += '\n'; }
    else if (tok === 'BT') { pending = ''; }
  }
  out += pending;
  return out;
}

async function pdfStreams(bytes) {
  const s = latin1(bytes);
  const chunks = [];
  const re = /stream\r\n|stream\n|stream\r/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const dictFrom = Math.max(0, m.index - 900);
    const dict = s.slice(dictFrom, m.index);
    const body = s.slice(start, end);
    if (/\/FlateDecode/.test(dict)) {
      if (!canInflate()) continue;
      const raw = bytes.subarray(start, end);
      try { chunks.push(dec(await inflate(raw, 'deflate'), 'latin1')); }
      catch { /* an object stream we cannot inflate is not text we lost */ }
    } else if (!/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode|LZWDecode|ASCII85Decode)/.test(dict)) {
      chunks.push(body);
    }
    re.lastIndex = end;
  }
  return chunks;
}

/** Does this read like a document, or like the inside of a binary? */
function looksLikeProse(text) {
  const t = String(text || '');
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const words = (t.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  if (t.length < 60 || letters < 40 || words < 15) return false;
  const printable = (t.match(/[\x20-\x7e\s -ɏ]/g) || []).length;
  return printable / t.length > 0.9 && letters / t.length > 0.35;
}

async function extractPdf(bytes) {
  const failed = (why) => ({
    text: '', method: 'pdf-besteffort', confident: false,
    note: `${why} This page reads PDFs with the browser's own decompression and the PDF text operators — no PDF library is bundled — so anything scanned, or drawn with an embedded font that carries its own encoding, will not come out. Open the PDF, copy the text, and paste it in below.`,
  });
  if (!canInflate()) return failed('This browser has no DecompressionStream, so the PDF\'s compressed streams cannot be opened.');
  let chunks;
  try { chunks = await pdfStreams(bytes); } catch (e) { return failed(`The PDF could not be parsed (${e.message}).`); }
  if (!chunks.length) return failed('No readable content stream was found in this PDF.');
  const text = chunks.map(pdfContentText).join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!looksLikeProse(text)) return failed('The PDF was opened, but what came out does not read as text.');
  return {
    text, method: 'pdf-besteffort', confident: true,
    note: `Best-effort PDF extraction — ${text.length.toLocaleString()} characters from the text operators in this file's content streams. No PDF library was used, so check the preview: spacing and column order can be wrong, and text drawn as an image is missing. If it looks wrong, paste the text instead.`,
  };
}

// ----------------------------------------------------------- the entry point

/** file -> {text, method, note, confident, name, mime, bytes}. Never throws. */
export async function extractFile(file) {
  const name = file.name || 'document';
  const mime = file.type || '';
  const base = { name, mime, bytes: file.size };
  try {
    if (TEXT_EXT.test(name) || (mime && TEXT_MIME.test(mime))) {
      const text = await file.text();
      return {
        ...base, text, method: 'plain-text', confident: true,
        note: `Read as plain text — ${text.length.toLocaleString()} characters, exactly as the file holds them.`,
      };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.docx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return { ...base, ...await extractDocx(bytes) };
    }
    if (/\.pdf$/i.test(name) || mime === 'application/pdf') {
      return { ...base, ...await extractPdf(bytes) };
    }
    if (/\.doc$/i.test(name)) {
      return {
        ...base, text: '', method: 'unsupported', confident: false,
        note: 'Legacy .doc is a binary format from before Office moved to ZIP+XML, and reading it honestly needs a parser this app will not bundle. Save it as .docx, or paste the text in below.',
      };
    }
    // Last resort: if the bytes happen to be text, say that is what we did.
    const guess = dec(bytes);
    if (looksLikeProse(guess) && !guess.includes('\u0000')) {
      return {
        ...base, text: guess, method: 'plain-text-guess', confident: true,
        note: `This file has no extension this page knows, but its bytes decode as readable text — ${guess.length.toLocaleString()} characters. Check the preview.`,
      };
    }
    return {
      ...base, text: '', method: 'unsupported', confident: false,
      note: `This page can read plain text and markdown always, .docx reliably, and .pdf best-effort. "${name}" is none of those, and it will not be guessed at. Paste the text in below instead.`,
    };
  } catch (e) {
    return { ...base, text: '', method: 'failed', confident: false, note: `Could not read this file: ${e.message}. Paste the text in below instead.` };
  }
}

// ============================================================================
// PAGE
// ============================================================================

const KINDS = [
  ['bia', 'Business impact analysis', 'Tiers, RTO/RPO targets, what it costs the business when this is down.'],
  ['solution', 'Proposed failover solution', 'How someone proposes this system fails over — the tool, the sequence, the regions.'],
  ['test-plan', 'Test notes / test plan', 'What a developer told you about testing their service.'],
  ['runbook-notes', 'Runbook notes', 'Rough steps or meeting notes about how a recovery would actually run.'],
  ['other', 'Something else', 'Context for the AI to read; you pick the ingestion.'],
];

const FLOWS = [
  ['bia', 'Read as a business impact analysis',
    'Proposes service tiers, RTO/RPO as TARGETS with this document named as their source, and the business-impact text — and tells you which of the document\'s service names it could not map onto this workspace.'],
  ['solution', 'Read as a proposed failover solution',
    'Proposes the tooling and strategy this document commits to, a runbook draft shaped by the matching template and by what the document actually says, and the inventory facts the diagrams are drawn from. Where it contradicts the workspace, it shows you the conflict instead of overwriting.'],
  ['test-notes', 'Read as notes from a developer',
    'Proposes app-level tests from the dev\'s own commands, a pre-flight checklist, and a flag for everything they said has to happen BEFORE cutover.'],
];

const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));
const FLOW_LABEL = Object.fromEntries(FLOWS.map(([k, l]) => [k, l]));
const SUGGESTED = { bia: 'bia', solution: 'solution', 'test-plan': 'test-notes', 'runbook-notes': 'test-notes', other: '' };

const STATUS_BADGE = { uploaded: ['not read yet', ''], summarised: ['read — nothing applied', 'accent'], applied: ['applied', 'ok'] };

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);

// ------------------------------------------------------------ citation block

function citeLine(citation) {
  if (!citation || !citation.quote) {
    return h('div', { class: 'doc-cite unverified' },
      badge('no quotation', 'err'), ' ',
      'This proposal named no sentence from the document, so it cannot be applied.');
  }
  const bad = !citation.verified;
  return h('div', { class: `doc-cite ${bad ? 'unverified' : ''}` },
    badge(bad ? 'NOT in the document' : citation.method === 'paraphrase' ? 'paraphrased' : 'quoted', bad ? 'err' : citation.method === 'paraphrase' ? 'warn' : 'ok'),
    ' ', h('q', null, citation.quote),
    citation.note ? h('div', { class: 'hint', style: 'margin-top:4px' }, citation.note) : null);
}

function listBlock(title, items, render, { intro } = {}) {
  if (!items || !items.length) return null;
  return h('div', { class: 'doc-block' },
    h('div', { class: 'doc-block-head' }, `${title} (${items.length})`),
    intro ? h('div', { class: 'hint', style: 'margin-bottom:7px' }, intro) : null,
    items.map(render));
}

function ingestResultBody(res, ws, api, doc, flow, onApplied) {
  const body = h('div');

  body.append(h('div', { class: 'doc-block' },
    h('div', { class: 'doc-block-head' }, `${FLOW_LABEL[flow] || flow} · ${doc.name}`),
    res.summary ? h('div', { class: 'ai-summary' }, res.summary) : null,
    h('div', { class: 'hint' },
      `Read ${(res.document?.sentChars || 0).toLocaleString()} of ${(res.document?.chars || 0).toLocaleString()} characters`,
      res.document?.clipped ? ' (the rest was too long for one prompt and was NOT read)' : '',
      res.template ? ` · runbook draft shaped from the "${res.template.name}" template` : '',
      '. Nothing below has been applied.')));

  const conflicts = listBlock('Conflicts — the document and the workspace disagree', res.conflicts, (c) =>
    h('div', { class: 'doc-item warn' },
      h('div', { class: 'doc-item-title' }, c.field || 'a value'),
      h('div', { class: 'doc-conflict-vs' },
        h('div', null, h('div', { class: 'doc-conflict-k' }, 'workspace says'), h('span', { class: 'mono' }, JSON.stringify(c.workspaceValue ?? null))),
        h('div', null, h('div', { class: 'doc-conflict-k' }, 'document says'), h('span', { class: 'mono' }, JSON.stringify(c.documentValue ?? null)))),
      c.recommendation ? h('div', { class: 'doc-item-body' }, c.recommendation) : null,
      c.found ? h('div', { class: 'hint', style: 'margin-top:4px' }, `Found ${c.found}.`) : null,
      c.citation ? citeLine(c.citation) : null),
  { intro: 'A document is a proposal. What is on disk is what people believe today. These are shown, not applied — decide each one yourself.' });
  if (conflicts) body.append(conflicts);

  const flags = listBlock('Must happen BEFORE cutover', res.flags, (f) =>
    h('div', { class: 'doc-item err' },
      h('div', { class: 'doc-item-title' }, f.title || '(untitled)'),
      f.detail ? h('div', { class: 'doc-item-body' }, f.detail) : null,
      citeLine(f.citation)),
  { intro: 'Read this list before you move traffic.' });
  if (flags) body.append(flags);

  const unmatched = listBlock('Names this workspace does not have', res.unmatched, (u) =>
    h('div', { class: 'doc-item' },
      h('div', { class: 'doc-item-title' }, u.name || '(unnamed)'),
      u.note ? h('div', { class: 'doc-item-body' }, u.note) : null,
      citeLine(u.citation)),
  { intro: 'The document names these; nothing here matches them. Nothing was created for them — a guessed match is worse than a named gap. Add them in Inventory if they are real.' });
  if (unmatched) body.append(unmatched);

  if (res.guardNotes && res.guardNotes.length) {
    body.append(h('div', { class: 'doc-block' },
      h('div', { class: 'doc-block-head' }, `Held back by the honest-numbers rule (${res.guardNotes.length})`),
      res.guardNotes.map((n) => h('div', { class: 'doc-item warn' }, h('div', { class: 'doc-item-body' }, n)))));
  }

  const ops = res.operations || [];
  if (ops.length) {
    const unciteable = ops.filter((o) => !o.citation || !o.citation.verified).length;
    body.append(h('div', { class: 'doc-block' },
      h('div', { class: 'doc-block-head' }, `Where each proposed change comes from (${ops.length})`),
      h('div', { class: 'hint', style: 'margin-bottom:8px' },
        'Every proposal names the sentence it came from, and the server checked that sentence against the stored text. '
        + (unciteable
          ? `${unciteable} of them could NOT be traced to the document and arrive greyed out below — they cannot be applied.`
          : 'All of them traced back.')),
      ops.map((op, i) => h('div', { style: 'margin-bottom:6px' },
        h('div', { class: 'doc-item-title' },
          `${i + 1}. ${op.op}${op.collection ? ` ${op.collection}` : ' workspace'}${op.id ? ` · ${op.id}` : ''}`),
        citeLine(op.citation)))));
  }

  body.append(operationsBlock({
    ws, api,
    result: { operations: ops, notes: res.notes },
    onApply: async (selected) => {
      const out = await api.post(`/w/${ws}/ai/apply`, { operations: selected, documentId: doc.id, flow });
      return out;
    },
    onApplied,
  }));

  return body;
}

// ------------------------------------------------------------------- page

export default {
  title: 'Documents',
  async render(el, { ws, api }) {
    ensureStyle();
    let docs = [];
    let components = [];
    let cliOk = null;

    const listCard = card();
    const uploadCard = card();

    async function reload() {
      const [{ items }, comps] = await Promise.all([
        api.get(`/w/${ws}/documents`).catch(() => ({ items: [] })),
        api.get(`/w/${ws}/c/components`).then((r) => r.items || []).catch(() => []),
      ]);
      docs = items || [];
      components = comps;
      paintList();
    }

    // ------------------------------------------------------------ viewing
    async function viewText(row) {
      const full = await api.get(`/w/${ws}/documents/${row.id}`).catch((e) => ({ text: '', error: e.message }));
      const textArea = h('textarea', { style: 'min-height:200px', placeholder: 'Paste the document text here…' }, full.text || '');
      const view = full.text
        ? h('div', { class: 'doc-text-view' }, full.text)
        : h('div', null,
          h('div', { class: 'hint', style: 'margin-bottom:8px' },
            'Nothing was extracted from this file. Open it, copy the text, and paste it here — that is honest, and an empty document the AI "reads" is not.'),
          textArea);
      const ok = await modal(row.name, h('div', null,
        h('div', { class: 'hint', style: 'margin-bottom:10px' },
          `${KIND_LABEL[row.kind] || row.kind} · uploaded ${fmtDate(row.uploadedAt)} · `,
          `${(full.textBytes || 0).toLocaleString()} bytes stored`,
          full.truncated ? ` · TRUNCATED from ${(full.truncatedFrom || 0).toLocaleString()} bytes — the rest is not stored and the AI does not see it` : '',
          full.extraction?.note ? h('div', { style: 'margin-top:5px' }, full.extraction.note) : null),
        view,
      ), { wide: true, actions: full.text ? [] : [{ label: 'Save pasted text', kind: 'btn-primary', value: 'save' }] });
      if (ok === 'save') {
        const text = textArea.value.trim();
        if (!text) { toast('Nothing pasted — cancelled', 'err'); return; }
        try {
          await api.put(`/w/${ws}/documents/${row.id}`, { text });
          toast('Text saved — the AI can read this document now', 'ok');
          await reload();
        } catch (e) { toast(e.message, 'err'); }
      }
    }

    // ----------------------------------------------------------- ingesting
    async function runIngest(row) {
      if (cliOk === null) cliOk = await aiAvailable(api);
      if (!cliOk) {
        // [ai-providers] Names whichever AI CLI is selected.
        await modal(`${aiToolName()} not found`, h('div', null,
          h('div', { class: 'ai-unavailable' }, installHint() || INSTALL_HINT, h('pre', { class: 'mono' }, INSTALL_STEPS),
            h('div', { style: 'margin-top:8px' }, 'Using a different tool? Pick it under Settings → AI tool.'))), { actions: [] });
        return;
      }
      let flow = SUGGESTED[row.kind] || 'bia';
      const radios = FLOWS.map(([id, label, why]) => h('label', { class: 'doc-flow-opt' },
        h('div', null,
          h('input', {
            type: 'radio', name: 'doc-flow', value: id, checked: id === flow,
            onChange: (e) => { if (e.target.checked) flow = id; },
          }),
          h('span', { class: 'doc-flow-name' }, label)),
        h('div', { class: 'doc-flow-why' }, why)));

      const go = await modal(`Read "${row.name}"`, h('div', null,
        h('p', { class: 'hint', style: 'margin-bottom:10px' },
          'This sends the document text and a summary of this workspace to your own local claude CLI. '
          + 'It returns proposals you review — it changes nothing.'),
        ...radios,
      ), { wide: true, actions: [{ label: 'Read it', kind: 'btn-primary', value: true }] });
      if (!go) return;

      // A plain overlay rather than modal(), so closing it is ours to do and
      // never races with another dialog on the page.
      const busy = h('div', { class: 'modal-back' },
        h('div', { class: 'modal' },
          h('h2', null, `Reading "${row.name}"`),
          spinner('Your local claude CLI is reading the document. A minute or two is normal; a solution document that comes back as a runbook draft takes longer.'),
          h('p', { class: 'hint', style: 'margin-top:10px' }, 'Nothing is being written — this only produces proposals.')));
      document.body.append(busy);
      let res;
      try {
        res = await api.post(`/w/${ws}/documents/${row.id}/ingest`, { flow });
      } catch (e) {
        res = { ok: false, message: e.message };
      } finally {
        busy.remove();
      }

      if (!res || !res.ok) {
        await modal('The document could not be read', h('div', null,
          h('div', null, badge((res && (res.message || res.error)) || 'The AI request failed.', 'warn')),
          res && res.raw ? h('details', { class: 'ai-op-data', style: 'margin-top:10px' },
            h('summary', null, 'raw answer'), h('pre', { class: 'mono' }, res.raw)) : null,
        ), { actions: [] });
        await reload();
        return;
      }

      await reload();
      await modal(`${FLOW_LABEL[flow]} — review`,
        ingestResultBody(res, ws, api, row, flow, async () => {
          await reload();
          window.dispatchEvent(new CustomEvent('drcompass:data-changed'));
        }),
        { wide: true, actions: [] });
      await reload();
    }

    async function removeDoc(row) {
      const ok = await confirmDialog(`Delete "${row.name}"?`, {
        title: 'Delete document',
        detail: 'Anything already applied from it stays in the workspace — deleting the document does not undo it.',
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      try { await api.del(`/w/${ws}/documents/${row.id}`); toast('Document deleted', 'ok'); await reload(); }
      catch (e) { toast(e.message, 'err'); }
    }

    // --------------------------------------------------------------- list
    function paintList() {
      const rows = docs.map((d) => {
        const [statusText, statusKind] = STATUS_BADGE[d.status] || ['unknown', ''];
        const targets = d.appliedTargets || [];
        const lastRun = (d.ingestions || [])[(d.ingestions || []).length - 1];
        return h('tr', null,
          h('td', null,
            h('div', { class: 'doc-row-name' }, d.name),
            h('div', { class: 'doc-row-sub' },
              d.hasText ? `${(d.chars || 0).toLocaleString()} characters` : 'no text extracted — paste it in',
              d.truncated ? ' · TRUNCATED' : '',
              d.extraction?.method ? ` · ${d.extraction.method}` : ''),
            d.summary ? h('div', { class: 'doc-row-sub' }, d.summary) : null,
            // Every stored document is scanned for text that is talking to the
            // AI rather than describing a plan. Nothing is removed — the text has
            // to stay byte-for-byte so citations stay checkable — so the useful
            // thing to do with a finding is show it before anyone runs ingestion.
            d.injectionWarning
              ? h('div', {
                class: 'doc-row-sub',
                style: 'color:var(--warn)',
                title: (d.injection?.findings || []).map((f) => `[${f.pattern}] ${f.quote}`).join('\n\n'),
              }, `⚠ ${d.injectionWarning}`)
              : null),
          h('td', null, badge(KIND_LABEL[d.kind] || d.kind, 'purple')),
          h('td', null, h('span', { title: fmtDate(d.uploadedAt) }, relTime(d.uploadedAt)), h('div', { class: 'doc-row-sub' }, fmtBytes(d.bytes))),
          h('td', null,
            badge(statusText, statusKind),
            lastRun
              ? h('div', { class: 'doc-row-sub' },
                `${FLOW_LABEL[lastRun.flow] || lastRun.flow} · `,
                `${lastRun.appliable} of ${lastRun.proposed} proposals appliable`,
                lastRun.conflicts ? ` · ${lastRun.conflicts} conflict${lastRun.conflicts === 1 ? '' : 's'}` : '',
                lastRun.unmatched ? ` · ${lastRun.unmatched} unmatched` : '')
              : null),
          h('td', null, targets.length
            ? h('div', null, targets.slice(0, 6).map((t) => h('div', { class: 'doc-row-sub' },
              `${t.op} ${t.collection} · ${t.name || t.id}`)),
            targets.length > 6 ? h('div', { class: 'doc-row-sub' }, `+${targets.length - 6} more`) : null)
            : h('span', { class: 'hint' }, 'nothing applied')),
          h('td', null, h('div', { class: 'doc-acts' },
            btn({ label: 'View text', size: 'btn-sm', onClick: () => viewText(d) }),
            btn({ label: 'Run ingestion', kind: 'btn-primary', size: 'btn-sm', disabled: !d.hasText, title: d.hasText ? '' : 'No text to read — open it and paste the text in first', onClick: () => runIngest(d) }),
            btn({ label: 'Delete', kind: 'btn-ghost', size: 'btn-sm', onClick: () => removeDoc(d) }))));
      });

      listCard.replaceChildren(
        cardHead('Uploaded documents', h('span', { class: 'hint' }, `${docs.length} stored in this workspace`)),
        docs.length
          ? table(['Document', 'Kind', 'Uploaded', 'Status', 'Applied to', ''], rows)
          : empty({
            icon: '📄',
            title: 'No documents yet',
            body: 'Upload the BIA, the failover design, or the notes from the meeting you just had. '
              + 'The AI reads one only when you ask it to, and everything it proposes is reviewed before it is applied.',
          }));
    }

    // ------------------------------------------------------------- upload
    function paintUpload() {
      const fileInput = h('input', { type: 'file', style: 'display:none', accept: '.txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.pdf,.docx,text/*,application/pdf' });
      const drop = h('div', { class: 'doc-drop' },
        h('div', { class: 'doc-drop-title' }, 'Drop a document here, or choose a file'),
        h('div', { class: 'hint' }, 'Plain text and markdown always work · .docx is read in full · .pdf is best-effort and will say so · anything else, paste the text'),
        h('div', { style: 'margin-top:12px' },
          btn({ label: 'Choose a file', onClick: () => fileInput.click() }),
          ' ',
          btn({ label: 'Paste text instead', kind: 'btn-ghost', onClick: () => pasteFlow() })));

      const staged = h('div');
      let pending = null;

      const nameInput = h('input');
      const kindSelect = h('select', null, KINDS.map(([id, label]) => h('option', { value: id }, label)));
      const serviceSelect = h('select', null,
        h('option', { value: '' }, 'the whole workspace'),
        components.map((c) => h('option', { value: c.id }, c.name)));

      function stage(ex) {
        pending = ex;
        nameInput.value = ex.name;
        // Guess the kind from the file name — the user confirms it.
        const n = ex.name.toLowerCase();
        const guess = /bia|impact/.test(n) ? 'bia'
          : /solution|design|architect|proposal|failover|switch/.test(n) ? 'solution'
            : /test|qa|verif/.test(n) ? 'test-plan'
              : /runbook|notes|meeting/.test(n) ? 'runbook-notes' : 'other';
        kindSelect.value = guess;

        const good = ex.confident && ex.text.trim();
        const pasteBox = h('textarea', { style: 'min-height:140px', placeholder: 'Paste the document text here…' });
        staged.replaceChildren(h('div', { class: 'doc-extract' },
          h('div', { class: 'doc-extract-head' },
            badge(good ? 'text extracted' : 'no usable text', good ? 'ok' : 'warn'),
            h('span', { class: 'doc-extract-name' }, ex.name),
            h('span', { class: 'hint' }, `${fmtBytes(ex.bytes)} · ${ex.method}`)),
          h('div', { class: 'hint' }, ex.note),
          good
            ? h('div', null,
              h('div', { class: 'hint', style: 'margin-top:8px' }, 'This is exactly what will be stored and what the AI will read:'),
              h('div', { class: 'doc-preview' }, ex.text.slice(0, 4000) + (ex.text.length > 4000 ? `\n\n… ${(ex.text.length - 4000).toLocaleString()} more characters` : '')))
            : h('div', null,
              h('div', { class: 'hint', style: 'margin-top:8px' }, 'Paste the text in and it will be stored instead — an empty document is not worth uploading.'),
              pasteBox),
          h('div', { class: 'grid cols-2', style: 'margin-top:12px' },
            h('label', { class: 'field' }, h('span', null, 'Name'), nameInput),
            h('label', { class: 'field' }, h('span', null, 'What kind of document is this?'), kindSelect)),
          h('label', { class: 'field' }, h('span', null, 'Which service is it about? (optional)'), serviceSelect),
          h('div', { class: 'row', style: 'margin-top:12px;gap:8px' },
            btn({
              label: 'Upload',
              kind: 'btn-primary',
              onClick: async () => {
                const text = good ? ex.text : pasteBox.value;
                if (!text.trim()) { toast('No text to store — paste the document text in first', 'err'); return; }
                await upload({
                  name: nameInput.value.trim() || ex.name,
                  kind: kindSelect.value,
                  mime: ex.mime,
                  bytes: ex.bytes,
                  text,
                  appliesTo: { serviceId: serviceSelect.value || null },
                  extraction: good
                    ? { method: ex.method, note: ex.note, confident: true }
                    : { method: 'pasted-by-hand', note: `Extraction from ${ex.name} did not produce usable text (${ex.method}); the user pasted it in.`, confident: true },
                });
              },
            }),
            btn({ label: 'Cancel', kind: 'btn-ghost', onClick: () => { pending = null; staged.replaceChildren(); } }))));
      }

      async function pasteFlow() {
        stage({ name: 'Pasted document.md', mime: 'text/markdown', bytes: 0, text: '', method: 'pasted-by-hand', confident: false, note: 'Nothing was uploaded — paste the text you want the AI to read.' });
      }

      async function handleFile(file) {
        staged.replaceChildren(spinner(`Reading ${file.name}…`));
        stage(await extractFile(file));
      }

      fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) handleFile(fileInput.files[0]); });
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) handleFile(f);
      });

      async function upload(body) {
        try {
          const created = await api.post(`/w/${ws}/documents`, body);
          toast(created.truncatedMessage || `"${created.name}" uploaded — nothing has been read yet`, created.truncatedMessage ? 'warn' : 'ok');
          if (created.truncatedMessage) {
            await modal('Stored, but truncated', h('div', null, h('p', null, created.truncatedMessage)), { actions: [] });
          }
          pending = null;
          staged.replaceChildren();
          await reload();
        } catch (e) { toast(e.message, 'err'); }
      }

      uploadCard.replaceChildren(
        cardHead('Add a document',
          h('span', { class: 'hint' }, 'Stored in this workspace, on this machine')),
        drop, fileInput, staged);
    }

    // ------------------------------------------------------------- render
    el.append(
      pageHead({
        title: 'Documents',
        purpose: 'Upload the context you already have — a BIA, a proposed failover design, the notes from a meeting with a dev — and have the AI turn it into changes you review before anything is applied.',
        meta: [h('span', { class: 'hint' }, 'The AI reads a document only when you ask it to, through your own local claude CLI. Every proposal quotes the sentence it came from.')],
      }),
      banner({
        kind: 'info',
        title: 'A document is a proposal, not a fact',
        body: 'An RTO in a BIA is a target someone asked for — never a measurement, and never an achievement. '
          + 'A proposed solution is what somebody intends, not what the workspace does today. '
          + 'Where the two disagree, this page shows you the conflict instead of overwriting anything.',
      }),
      uploadCard,
      listCard,
    );

    await reload();
    paintUpload();
    aiAvailable(api).then((ok) => { cliOk = ok; });
  },
};
