// Documents — upload context, then ask the AI to turn it into proposals.
//
// The contract is docs/ENV-SERVICE-MODEL.md §5: the client extracts text (plain
// text and markdown always work; PDF/DOCX where it honestly can), the server
// caps what it stores and SAYS when it truncated, the AI reads a document only
// when the user asks it to, and every proposal it makes is reviewed before it is
// applied — through the same operations contract as everything else.
//
// This router therefore stores documents and produces proposals. It does NOT
// apply anything. The single apply path in the product is POST /w/:ws/ai/apply,
// and `POST /w/:ws/documents/:id/applied` only writes provenance back onto the
// DOCUMENT (what was applied, when, from which flow) — never onto the workspace.
//
// Pre-mounted at /api by server/index.js.
import { Router } from 'express';
import * as store from '../store.js';
import {
  ingestDocument, claudeCliFound, flowForKind,
  DOCUMENT_KINDS, INGEST_FLOWS, DOC_TEXT_CAP,
  // The prompt-injection scanner (defined in server/lib/solution-context.js and
  // re-exported by the bridge). It was written for the solution-document flow
  // and was never wired into the main documents flow, so `GET /documents` could
  // not warn about a document that spends a paragraph talking to the AI.
  scanInjection,
} from '../lib/ai-bridge.js';

const r = Router();

const MISSING_CLI =
  'Claude Code CLI not found on PATH — install Claude Code (https://claude.com/claude-code), sign in, then retry.';

const STATUSES = ['uploaded', 'summarised', 'applied'];
const MAX_DOCUMENTS = 500;

// ---------------------------------------------------------------- storage
//
// documents.json lives beside the other collections and uses the same
// {items:[...]} envelope, so the day `documents` joins store.COLLECTIONS
// getCollection() reads this file unchanged.

export function readDocuments(slug) {
  const obj = store.getObject(slug, 'documents'); // 404s on an unknown workspace
  return obj && Array.isArray(obj.items) ? obj.items : [];
}

export function saveDocuments(slug, items) {
  store.saveObject(slug, 'documents', { items });
  return items;
}

export function getDocument(slug, id) {
  const doc = readDocuments(slug).find((d) => d && d.id === id);
  if (!doc) throw store.httpError(404, `no document '${id}' in workspace '${slug}'`);
  return doc;
}

// ---------------------------------------------------------------- shaping

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

// Everything stored from a request body goes through this: `name`, `mime`,
// `extraction.note`, `appliesTo.*` and every applied[] field.
//
// It used to strip NUL and nothing else — a character class that had lost its
// range — so a document NAME could carry CR/LF, tabs and quote runs verbatim,
// which is exactly what made a hostile filename useful against an AI prompt.
// \p{Cc} is every control character (C0, DEL, C1) and \p{Cf} every format
// character (zero-width joiners, bidi overrides); they are written as Unicode
// property escapes on purpose, because a \u00NN escape in source is one
// careless editor away from becoming the literal byte it names — which is how
// this line lost its range in the first place.
const clean = (v, max) => str(v)
  .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

/**
 * Cap the stored text at 1 MB of UTF-8 and say so. Never silently shortens:
 * `truncated` and `truncatedFrom` travel with the record and the UI prints them.
 */
function capText(text) {
  const full = str(text);
  const bytes = Buffer.byteLength(full, 'utf8');
  if (bytes <= DOC_TEXT_CAP) return { text: full, textBytes: bytes, truncated: false, truncatedFrom: null };
  // Slice on a character boundary that lands under the cap.
  const buf = Buffer.from(full, 'utf8').subarray(0, DOC_TEXT_CAP);
  let kept = buf.toString('utf8');
  if (kept.endsWith('�')) kept = kept.slice(0, -1);
  return {
    text: kept,
    textBytes: Buffer.byteLength(kept, 'utf8'),
    truncated: true,
    truncatedFrom: bytes,
  };
}

const PREVIEW_CHARS = 280;

/** Text we are willing to re-scan on a list request for a legacy document. */
const LAZY_SCAN_CAP = 200 * 1024;

/**
 * Scan stored text for passages written to steer an AI rather than to describe
 * a plan, and record the result ON THE DOCUMENT. The text itself is never
 * altered — every citation has to stay checkable, character for character — so
 * this is a warning, not a filter. `ingestDocument()` fences the same text and
 * names these findings to the model as things to REPORT, never to follow.
 */
function injectionRecord(text) {
  let findings = [];
  try {
    findings = (scanInjection(str(text)) || []).slice(0, 50).map((f) => ({
      pattern: clean(f && f.pattern, 40),
      quote: clean(f && f.quote, 400),
      sentenceIndex: Number(f && f.sentenceIndex) || 0,
    }));
  } catch { findings = []; }
  return {
    scannedAt: new Date().toISOString(),
    count: findings.length,
    patterns: [...new Set(findings.map((f) => f.pattern))],
    findings,
  };
}

// Tolerant of every shape a record can be in: the one written here, the one
// `ingestDocument()` returns, and one stored by an older version that had no
// `patterns` list at all.
const injectionWarning = (inj) => {
  const count = Number(inj && inj.count) || 0;
  if (!count) return '';
  const pats = Array.isArray(inj.patterns) && inj.patterns.length
    ? inj.patterns
    : [...new Set((Array.isArray(inj.findings) ? inj.findings : []).map((f) => f && f.pattern).filter(Boolean))];
  return `${count} passage(s) in this document read as an instruction to an AI rather than as content`
    + `${pats.length ? ` (${pats.join(', ')})` : ''}. `
    + 'Nothing was removed — the text is stored byte-for-byte so every citation stays checkable — but read them before you apply anything from this document.';
};

/** The list shape: everything except the text itself, plus enough to judge it. */
function summarise(doc) {
  const { text, ...rest } = doc;
  const body = str(text);
  // Documents stored before the scanner was wired in have no record; scan them
  // on the way out rather than pretending they were clean.
  const injection = rest.injection && typeof rest.injection === 'object'
    ? rest.injection
    : (body.length <= LAZY_SCAN_CAP ? injectionRecord(body) : null);
  return {
    ...rest,
    ...(injection ? { injection } : {}),
    injectionWarning: injectionWarning(injection),
    chars: body.length,
    preview: body.slice(0, PREVIEW_CHARS) + (body.length > PREVIEW_CHARS ? '…' : ''),
    hasText: !!body.trim(),
  };
}

function appliedTargets(doc) {
  const seen = new Map();
  for (const run of doc.applied || []) {
    for (const it of run.items || []) {
      const key = `${it.collection}:${it.id}`;
      if (!seen.has(key)) seen.set(key, { collection: it.collection, id: it.id, name: it.name, op: it.op, at: run.at, flow: run.flow });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- scoping
//
// ENV-SERVICE-MODEL.md §3: read endpoints accept ?envId= and ?serviceId=. A
// document carries appliesTo{envId,serviceId}; documents with neither are not
// scoped away, because an unscoped document is "about this whole workspace",
// not "about nothing".

function knownServiceIds(slug) {
  const ids = new Set();
  for (const name of ['components', 'services']) {
    try {
      const items = store.COLLECTIONS.includes(name)
        ? store.getCollection(slug, name)
        : (store.getObject(slug, name)?.items || []);
      for (const it of items) if (it && it.id) ids.add(it.id);
    } catch { /* collection absent is not an error here */ }
  }
  return ids;
}

function knownEnvIds(slug) {
  const ids = new Set();
  try {
    const ws = store.getWorkspace(slug);
    for (const e of ws.environments || []) if (e && e.id) ids.add(e.id);
  } catch { /* single-environment workspace */ }
  return ids;
}

function applyScope(slug, items, query) {
  const envId = str(query.envId).trim();
  const serviceId = str(query.serviceId).trim();
  if (!envId && !serviceId) return { items, scope: null };

  if (serviceId) {
    const known = knownServiceIds(slug);
    if (known.size && !known.has(serviceId)) {
      throw store.httpError(404, `no service or component '${serviceId}' in workspace '${slug}'`);
    }
  }
  if (envId) {
    const known = knownEnvIds(slug);
    if (known.size && !known.has(envId)) {
      throw store.httpError(404, `no environment '${envId}' in workspace '${slug}'`);
    }
  }
  const match = (d) => {
    const a = d.appliesTo || {};
    if (envId && a.envId && a.envId !== envId) return false;
    if (serviceId && a.serviceId && a.serviceId !== serviceId) return false;
    return true;
  };
  const filtered = items.filter(match);
  return {
    items: filtered,
    scope: {
      envId: envId || null,
      serviceId: serviceId || null,
      documentCount: filtered.length,
      note: 'Documents with no appliesTo are included: an unscoped document is about the whole workspace.',
    },
  };
}

// ---------------------------------------------------------------- routes

/** The kinds, flows and caps the client needs to build its form. Static. */
r.get('/documents/meta', (req, res) => {
  res.json({
    kinds: DOCUMENT_KINDS,
    flows: INGEST_FLOWS,
    textCapBytes: DOC_TEXT_CAP,
    flowForKind: Object.fromEntries(DOCUMENT_KINDS.map((k) => [k, flowForKind(k)])),
  });
});

r.get('/w/:ws/documents', (req, res, next) => {
  try {
    const all = readDocuments(req.params.ws)
      .slice()
      .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
    const { items, scope } = applyScope(req.params.ws, all, req.query || {});
    res.json({
      items: items.map((d) => ({ ...summarise(d), appliedTargets: appliedTargets(d) })),
      ...(scope ? { scope } : {}),
    });
  } catch (e) { next(e); }
});

r.get('/w/:ws/documents/:id', (req, res, next) => {
  try {
    const doc = getDocument(req.params.ws, req.params.id);
    const injection = doc.injection && typeof doc.injection === 'object' ? doc.injection : injectionRecord(doc.text);
    res.json({
      ...doc, injection, injectionWarning: injectionWarning(injection),
      appliedTargets: appliedTargets(doc),
    });
  } catch (e) { next(e); }
});

/**
 * Upload. Body {name, kind, mime, text, bytes?, extraction?}.
 * `text` is what the CLIENT extracted — the server never parses a binary, and a
 * document with no text is stored as such rather than pretending it read one.
 */
r.post('/w/:ws/documents', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const body = req.body || {};
    const name = clean(body.name, 300).trim();
    if (!name) throw store.httpError(400, 'name required');
    const kind = DOCUMENT_KINDS.includes(body.kind) ? body.kind : 'other';
    const items = readDocuments(ws);
    if (items.length >= MAX_DOCUMENTS) {
      throw store.httpError(409, `this workspace already holds ${MAX_DOCUMENTS} documents — delete one before uploading another`);
    }
    const capped = capText(body.text);
    const ex = body.extraction && typeof body.extraction === 'object' ? body.extraction : {};
    const doc = {
      id: store.newId('doc'),
      name,
      kind,
      uploadedAt: new Date().toISOString(),
      bytes: Number.isFinite(Number(body.bytes)) ? Number(body.bytes) : capped.textBytes,
      mime: clean(body.mime, 120),
      text: capped.text,
      textBytes: capped.textBytes,
      truncated: capped.truncated,
      truncatedFrom: capped.truncatedFrom,
      summary: '',
      appliesTo: {
        envId: clean(body.appliesTo?.envId, 64) || null,
        serviceId: clean(body.appliesTo?.serviceId, 64) || null,
      },
      extraction: {
        method: clean(ex.method, 60) || 'unknown',
        note: clean(ex.note, 600),
        confident: ex.confident === undefined ? null : !!ex.confident,
      },
      // Scanned at upload, so the list warns before anyone asks the AI to read
      // it. Advisory only: nothing is stripped and nothing is blocked.
      injection: injectionRecord(capped.text),
      extracted: {},
      ingestions: [],
      applied: [],
      status: 'uploaded',
    };
    items.push(doc);
    saveDocuments(ws, items);
    res.status(201).json({
      ...summarise(doc),
      truncatedMessage: capped.truncated
        ? `Stored the first ${capped.textBytes.toLocaleString()} bytes of ${capped.truncatedFrom.toLocaleString()} — the rest was NOT stored and the AI will not see it.`
        : '',
    });
  } catch (e) { next(e); }
});

/**
 * Rename, re-classify, re-scope, or paste in text that extraction could not
 * get. PUT is an alias for the same partial merge, so the browser's tiny api
 * helper (get/post/put/del) can reach it without a bespoke fetch.
 */
const patchDocument = (req, res, next) => {
  try {
    const ws = req.params.ws;
    const items = readDocuments(ws);
    const i = items.findIndex((d) => d && d.id === req.params.id);
    if (i < 0) throw store.httpError(404, `no document '${req.params.id}'`);
    const body = req.body || {};
    const next_ = { ...items[i] };
    if (body.name !== undefined) {
      const n = clean(body.name, 300).trim();
      if (!n) throw store.httpError(400, 'name cannot be empty');
      next_.name = n;
    }
    if (body.kind !== undefined) {
      if (!DOCUMENT_KINDS.includes(body.kind)) throw store.httpError(400, `kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
      next_.kind = body.kind;
    }
    if (body.appliesTo !== undefined) {
      next_.appliesTo = {
        envId: clean(body.appliesTo?.envId, 64) || null,
        serviceId: clean(body.appliesTo?.serviceId, 64) || null,
      };
    }
    if (body.text !== undefined) {
      const capped = capText(body.text);
      next_.text = capped.text;
      next_.textBytes = capped.textBytes;
      next_.truncated = capped.truncated;
      next_.truncatedFrom = capped.truncatedFrom;
      next_.injection = injectionRecord(capped.text); // new text, new scan
      next_.extraction = {
        method: clean(body.extraction?.method, 60) || 'pasted-by-hand',
        note: clean(body.extraction?.note, 600) || 'The user pasted this text in.',
        confident: body.extraction?.confident === undefined ? true : !!body.extraction.confident,
      };
    }
    if (body.status !== undefined && STATUSES.includes(body.status)) next_.status = body.status;
    next_.updatedAt = new Date().toISOString();
    items[i] = next_;
    saveDocuments(ws, items);
    res.json(summarise(next_));
  } catch (e) { next(e); }
};

r.patch('/w/:ws/documents/:id', patchDocument);
r.put('/w/:ws/documents/:id', patchDocument);

r.delete('/w/:ws/documents/:id', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const items = readDocuments(ws);
    const left = items.filter((d) => d && d.id !== req.params.id);
    if (left.length === items.length) throw store.httpError(404, `no document '${req.params.id}'`);
    saveDocuments(ws, left);
    res.json({ ok: true, deleted: req.params.id, note: 'Anything already applied from this document stays in the workspace — deleting the document does not undo it.' });
  } catch (e) { next(e); }
});

/**
 * Run one ingestion flow over one document. Returns validated operations and
 * APPLIES NOTHING — the operations go to the existing review modal, and only
 * POST /w/:ws/ai/apply writes.
 */
r.post('/w/:ws/documents/:id/ingest', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    const doc = getDocument(ws, req.params.id);
    const requested = str((req.body || {}).flow) || flowForKind(doc.kind);
    if (!INGEST_FLOWS.includes(requested)) {
      throw store.httpError(400, `flow must be one of ${INGEST_FLOWS.join(', ')}`);
    }
    if (!str(doc.text).trim()) {
      throw store.httpError(400,
        'This document has no extracted text, so there is nothing for the AI to read. '
        + 'Open it, copy the text, and paste it in with PATCH /documents/:id {text}.');
    }
    if (!await claudeCliFound()) {
      return res.status(503).json({ ok: false, error: MISSING_CLI, message: MISSING_CLI });
    }

    const result = await ingestDocument({ slug: ws, doc, flow: requested });
    if (result.ok) {
      // Record that the AI read it. This is about the DOCUMENT, not the
      // workspace: no component, runbook or objective moves until /ai/apply.
      const items = readDocuments(ws);
      const i = items.findIndex((d) => d && d.id === doc.id);
      if (i >= 0) {
        items[i] = {
          ...items[i],
          summary: result.summary || items[i].summary || '',
          status: items[i].status === 'applied' ? 'applied' : 'summarised',
          // What the bridge's scan of the same text found, kept on the record.
          injection: (result.injection && typeof result.injection === 'object')
            ? result.injection
            : (items[i].injection || injectionRecord(items[i].text)),
          extracted: {
            ...(items[i].extracted || {}),
            [requested]: {
              at: new Date().toISOString(),
              summary: result.summary || '',
              operations: result.operations || [],
              unmatched: result.unmatched || [],
              conflicts: result.conflicts || [],
              flags: result.flags || [],
              guardNotes: result.guardNotes || [],
              notes: result.notes || '',
              // A read that was cut off at the provider's output ceiling is
              // stored AS a partial read. Without this the record looks
              // identical to a complete one, and "we already ingested that
              // document" becomes a reason not to look again.
              truncation: result.truncation || null,
            },
          },
          ingestions: [
            ...(items[i].ingestions || []).filter((g) => g && g.flow !== requested),
            {
              flow: requested,
              at: new Date().toISOString(),
              summary: result.summary || '',
              proposed: (result.operations || []).length,
              appliable: (result.operations || []).filter((o) => o.valid !== false).length,
              unmatched: (result.unmatched || []).length,
              conflicts: (result.conflicts || []).length,
              flags: (result.flags || []).length,
              partial: !!(result.truncation && result.truncation.detected),
            },
          ],
        };
        saveDocuments(ws, items);
      }
    }
    res.json({ ...result, documentId: doc.id, applied: false });
  } catch (e) { next(e); }
});

/**
 * Provenance only. The client calls this AFTER /w/:ws/ai/apply succeeds so the
 * document can say what it was applied to. It writes to documents.json and
 * nowhere else — it is not a second apply path.
 */
r.post('/w/:ws/documents/:id/applied', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const items = readDocuments(ws);
    const i = items.findIndex((d) => d && d.id === req.params.id);
    if (i < 0) throw store.httpError(404, `no document '${req.params.id}'`);
    const body = req.body || {};
    const flow = INGEST_FLOWS.includes(body.flow) ? body.flow : '';
    const applied = (Array.isArray(body.applied) ? body.applied : []).slice(0, 200).map((a) => ({
      op: clean(a?.op, 40), collection: clean(a?.collection, 40),
      id: clean(a?.id, 80), name: clean(a?.name, 200),
    }));
    if (!applied.length) throw store.httpError(400, 'applied[] required — this endpoint records what /ai/apply wrote, it does not write anything itself');
    const run = {
      at: new Date().toISOString(),
      flow,
      items: applied,
      errors: (Array.isArray(body.errors) ? body.errors : []).slice(0, 50).map((e) => clean(e, 400)),
    };
    items[i] = { ...items[i], applied: [...(items[i].applied || []), run], status: 'applied' };
    saveDocuments(ws, items);
    res.json({ ok: true, document: summarise(items[i]), appliedTargets: appliedTargets(items[i]) });
  } catch (e) { next(e); }
});

/** Called by /ai/apply when the client names a document — same provenance record. */
export function recordApplied(slug, documentId, { flow = '', applied = [], errors = [] } = {}) {
  const items = readDocuments(slug);
  const i = items.findIndex((d) => d && d.id === documentId);
  if (i < 0) return null;
  const run = {
    at: new Date().toISOString(),
    flow: INGEST_FLOWS.includes(flow) ? flow : '',
    items: (applied || []).map((a) => ({
      op: clean(a?.op, 40), collection: clean(a?.collection, 40),
      id: clean(a?.id, 80), name: clean(a?.name, 200),
    })),
    errors: (errors || []).map((e) => clean(e, 400)),
  };
  if (!run.items.length) return null;
  items[i] = { ...items[i], applied: [...(items[i].applied || []), run], status: 'applied' };
  saveDocuments(slug, items);
  return run;
}

export default r;
