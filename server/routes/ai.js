// AI copilot routes: propose workspace operations from an instruction, apply
// a user-approved subset. Pre-mounted at /api by server/index.js.
import { Router } from 'express';
import * as store from '../store.js';
import {
  propose, correlate, claudeCliFound, missingCliMsg, getSelectedProvider, validateOperations,
  ask, draft, review, narrative, buildFocusedContext, NARRATIVE_KINDS,
  suggestOrdering,
  // The honest-numbers guard, run HERE at the write boundary — not only where
  // proposals are built. See the comment on /ai/apply below.
  guardOperations, flowForKind, INGEST_FLOWS,
  // [ai-console] the open console + the organisational operations
  converse, buildConsoleContext, applyAiOperation, isExtendedOperation,
  resolveOperationRefs, orderOperationsForApply,
  CONSOLE_PARTS, CONSOLE_DEFAULT_INCLUDE,
} from '../lib/ai-bridge.js';

const r = Router();
const PREFIX = { components: 'cmp', runbooks: 'rbk', tests: 'tst', checklists: 'chk', gaps: 'gap', decisions: 'dec', contacts: 'per' };

// `claudeCliFound` keeps its name (every AI panel in web/ reads it) but now
// answers for whichever CLI is selected. `provider` and `missing` are additive,
// so the UI can name the actual tool instead of always saying "Claude Code".
r.get('/ai/status', async (req, res, next) => {
  try {
    const p = getSelectedProvider();
    const found = await claudeCliFound();
    res.json({
      claudeCliFound: found,
      aiCliFound: found,
      provider: p ? { id: p.id, name: p.name, bin: p.bin, source: p.source, verified: p.verified } : null,
      missing: found ? null : missingCliMsg(),
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Contextual AI: the four endpoints every in-page AI action uses. All of them
// are READ-ONLY — writes only ever happen through /ai/apply below, with the
// operations the user explicitly approved.

// A focus selector from the client: {kind, id?, extra?}. Anything else is
// ignored, so a page can pass its whole state object without leaking it.
function selector(body) {
  const c = body && typeof body.context === 'object' && body.context ? body.context : null;
  if (!c) return null;
  const out = { kind: String(c.kind || 'workspace') };
  if (c.id) out.id = String(c.id);
  if (c.extra && typeof c.extra === 'object') out.extra = c.extra;
  return out;
}

// Focused answer (markdown prose, no data changes).
r.post('/w/:ws/ai/answer', async (req, res, next) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !String(prompt).trim()) throw store.httpError(400, 'prompt required');
    store.getWorkspace(req.params.ws); // 404 if missing
    res.json(await ask({ slug: req.params.ws, prompt: String(prompt), context: selector(req.body) }));
  } catch (e) { next(e); }
});

// Same handler under /ai/ask, for callers that expect the spec's name. NOTE:
// server/routes/discover.js is mounted first and also defines POST
// /w/:ws/ai/ask, so that one wins today; this exists so the focused-context
// contract holds if discover's copy ever goes away. Legacy body
// ({prompt, includeContext}) keeps working either way.
r.post('/w/:ws/ai/ask', async (req, res, next) => {
  try {
    const { prompt, includeContext } = req.body || {};
    if (!prompt || !String(prompt).trim()) throw store.httpError(400, 'prompt required');
    store.getWorkspace(req.params.ws);
    const ctx = selector(req.body) || (includeContext ? { kind: 'workspace' } : null);
    res.json(await ask({ slug: req.params.ws, prompt: String(prompt), context: ctx }));
  } catch (e) { next(e); }
});

// Generic "make me a thing" — returns validated operations, applies nothing.
r.post('/w/:ws/ai/draft', async (req, res, next) => {
  try {
    const { kind, instruction } = req.body || {};
    if (!instruction || !String(instruction).trim()) throw store.httpError(400, 'instruction required');
    store.getWorkspace(req.params.ws);
    res.json(await draft({
      slug: req.params.ws, kind: kind ? String(kind) : '',
      instruction: String(instruction), context: selector(req.body),
    }));
  } catch (e) { next(e); }
});

// Critique of one object → {ok, markdown, findings:[{severity,title,detail}]}.
r.post('/w/:ws/ai/review', async (req, res, next) => {
  try {
    const { kind, id } = req.body || {};
    store.getWorkspace(req.params.ws);
    res.json(await review({ slug: req.params.ws, kind: kind ? String(kind) : 'workspace', id: id ? String(id) : '' }));
  } catch (e) { next(e); }
});

// Prose for humans → {ok, kind, title, markdown}.
r.post('/w/:ws/ai/narrative', async (req, res, next) => {
  try {
    const kind = String((req.body || {}).kind || '');
    if (!NARRATIVE_KINDS.includes(kind)) {
      throw store.httpError(400, `kind must be one of ${NARRATIVE_KINDS.join(', ')}`);
    }
    store.getWorkspace(req.params.ws);
    res.json(await narrative({ slug: req.params.ws, kind }));
  } catch (e) { next(e); }
});

// Debug/introspection: what context WOULD be sent for a selector. No CLI call.
r.post('/w/:ws/ai/context', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const f = buildFocusedContext(req.params.ws, selector(req.body) || { kind: 'workspace' });
    res.json({ ok: true, kind: f.kind, id: f.id, bytes: f.bytes, truncated: f.truncated, context: f.json });
  } catch (e) { next(e); }
});

r.post('/w/:ws/ai/propose', async (req, res, next) => {
  try {
    const { instruction, page } = req.body || {};
    if (!instruction || !String(instruction).trim()) throw store.httpError(400, 'instruction required');
    store.getWorkspace(req.params.ws); // 404 if missing
    res.json(await propose({ slug: req.params.ws, instruction: String(instruction), page: page ? String(page) : '' }));
  } catch (e) { next(e); }
});

// Apply ONLY the operations the client sends (the approved subset). Each op is
// re-validated against the live workspace and applied independently — one bad
// op never blocks the rest.
//
// Optional `documentId` (+ `flow`): when the approved operations came from an
// uploaded document, the document records what it was applied to. That is
// provenance on the DOCUMENT — this route is still the one and only path that
// writes workspace data, and the record is written after the writes, never
// instead of them. It is imported lazily so a missing documents router can
// never break an apply.
//
// THE HONEST-NUMBERS GUARD RUNS HERE. Until v0.7.1 `guardOperations()` was
// called only inside `ingestDocument()` — the PROPOSAL path — so an operation
// that reached this route by any other road (the AI console, a hand-rolled
// POST, a user ticking "apply" on something a weak local provider proposed)
// was re-checked for shape and citations but never for honesty. A `create` on
// `tests` with `status:"passed"` and `results:{rtaMinutes:4}` landed intact and
// turned the executive summary's "NOT PROVEN" into "MEASURED". This route now
// runs the same guard over every operation before validating it, and REPORTS
// every strip and downgrade in the response: silently altering what somebody
// approved would be its own kind of dishonesty.
//
// This is not a privilege boundary — anyone who can call this can equally PUT
// /c/tests. It is the product's contract: a number the AI wrote is never a
// measurement, on any path.
r.post('/w/:ws/ai/apply', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    // [ai-console] Forward references: a create may declare {"ref":"x"}, and a
    // later operation may write "$x" wherever an id goes. The declaring creates
    // run first, and each id they are given is substituted into the operations
    // that follow — which is what lets ONE approved batch create a service and
    // put eighteen components in it. A reference whose create did not land is
    // never treated as a literal: that operation fails and says why.
    const ops = orderOperationsForApply(Array.isArray(req.body?.operations) ? req.body.operations : []);
    const refMap = {};
    const applied = [];
    const errors = [];

    // Document provenance, re-checked here rather than trusted from the client.
    // An operation that came from an uploaded document carries the sentence it
    // came from; if that sentence is not in the stored text, the operation does
    // not get applied. The UI already greys those out — this is the same rule
    // enforced where the writes actually happen.
    const documentId = String(req.body?.documentId || '');
    let docText = null;
    let docName = '';
    let docKind = '';
    if (documentId) {
      try {
        const docs = await import('./documents.js');
        const d = docs.getDocument(ws, documentId);
        docText = String(d.text || '');
        docName = String(d.name || '');
        docKind = String(d.kind || '');
      } catch (e) {
        throw store.httpError(400, `documentId '${documentId}' could not be read: ${e.message}`);
      }
    }

    // Which ingestion flow's rules apply. The client normally says; when it
    // does not, a document-scoped apply falls back to the flow its kind
    // implies, so the BIA rules cannot be dodged by omitting one field.
    const bodyFlow = String(req.body?.flow || '');
    const flow = INGEST_FLOWS.includes(bodyFlow) ? bodyFlow : (documentId ? flowForKind(docKind) : '');
    const guardNotes = [];

    for (const rawIn of ops) {
      const raw = resolveOperationRefs(rawIn, refMap);
      const label = `${raw?.op || '?'} ${raw?.collection || ''} ${raw?.id || ''}`.trim();
      const opNotes = [];
      const appliedBefore = applied.length;
      try {
        if (docText !== null) {
          // A document-scoped apply must cite the document for EVERY
          // operation. This used to read `if (... && raw.citation)`, so an
          // operation that simply omitted the key skipped the check entirely —
          // the one field a caller controls turned provenance off. Missing
          // provenance is now a refusal, which is what "re-checked here rather
          // than trusted from the client" was always supposed to mean.
          const quote = raw && raw.citation && typeof raw.citation.quote === 'string' ? raw.citation.quote : '';
          if (!quote.trim()) {
            errors.push(`${label}: refused — this apply names document '${documentId}', so every operation must carry the sentence it came from. This one carries none, and a document never becomes fact without one.`);
            continue;
          }
          const { verifyQuote } = await import('../lib/ai-bridge.js');
          const check = verifyQuote(docText, quote);
          if (!check.verified) {
            errors.push(`${label}: refused — the sentence this was supposed to come from is not in document '${documentId}'. ${check.note}`);
            continue;
          }
        }
        // Honest numbers, enforced where the write happens.
        const [guardedRaw] = guardOperations(flow, [raw], opNotes, docName);
        const [op] = validateOperations(ws, [guardedRaw]); // fresh validation per op
        if (!op.valid) { errors.push(`${label}: ${op.problem}`); continue; }
        // [ai-console] The organisational vocabulary (bulk-update,
        // split-component, merge-components) and the scope collections
        // (services / environments / documents) are applied by the bridge,
        // which owns their semantics: id prefixes, dependsOn rewiring on a
        // merge, service membership. Everything else falls through to the
        // branches below, byte-for-byte unchanged.
        if (isExtendedOperation(op)) {
          const out = applyAiOperation(ws, op);
          if (op.ref && out.applied[0] && out.applied[0].id) refMap[op.ref] = out.applied[0].id;
          applied.push(...out.applied);
          for (const e of out.errors) errors.push(`${label}: ${e}`);
          continue;
        }
        if (op.op === 'update-workspace') {
          const meta = store.saveWorkspace(ws, op.data);
          applied.push({ op: 'update-workspace', collection: 'workspace', id: ws, name: meta.name || ws });
        } else if (op.op === 'create') {
          const items = store.getCollection(ws, op.collection);
          const item = { ...op.data, id: store.newId(PREFIX[op.collection] || 'itm'), updatedAt: new Date().toISOString() };
          items.push(item);
          store.saveCollection(ws, op.collection, items);
          if (op.ref) refMap[op.ref] = item.id;
          applied.push({ op: 'create', collection: op.collection, id: item.id, name: item.name || item.title || item.id });
        } else if (op.op === 'update') {
          const items = store.getCollection(ws, op.collection);
          const i = items.findIndex((x) => x.id === op.id);
          items[i] = { ...items[i], ...op.data, id: op.id, updatedAt: new Date().toISOString() };
          store.saveCollection(ws, op.collection, items);
          applied.push({ op: 'update', collection: op.collection, id: op.id, name: items[i].name || items[i].title || op.id });
        } else if (op.op === 'delete') {
          const items = store.getCollection(ws, op.collection);
          const victim = items.find((x) => x.id === op.id);
          store.saveCollection(ws, op.collection, items.filter((x) => x.id !== op.id));
          applied.push({ op: 'delete', collection: op.collection, id: op.id, name: victim?.name || victim?.title || op.id });
        } else {
          errors.push(`${label}: unsupported op`);
        }
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      } finally {
        // Whatever the guard changed is reported — on the applied record, so a
        // reader sees it beside the thing that landed, and once in the
        // response-level list. `finally` so an operation that `continue`d out
        // of the try still reports what was stripped from it.
        if (opNotes.length) {
          for (let i = appliedBefore; i < applied.length; i += 1) applied[i].guarded = opNotes.slice();
          for (const n of opNotes) {
            const line = `${label} — ${n}`;
            if (!guardNotes.includes(line)) guardNotes.push(line);
          }
        }
      }
    }

    let document = null;
    if (documentId && applied.length) {
      try {
        const docs = await import('./documents.js');
        const run = docs.recordApplied(ws, documentId, {
          flow: String(req.body?.flow || ''), applied, errors,
        });
        if (run) document = { id: documentId, recorded: run.items.length, at: run.at };
      } catch (e) {
        // The workspace writes already happened and are correct; only the
        // paper trail failed. Say so rather than failing the apply.
        errors.push(`document provenance not recorded for '${documentId}': ${e.message}`);
      }
    }

    res.json({ applied, errors, guardNotes, ...(document ? { document } : {}) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// AI correlation: propose links from unlinked resource-graph nodes and
// Kubernetes workloads to components, then apply the user-approved subset.

// Names whichever AI CLI is selected for this workspace — with Claude Code
// selected (the default when it is on PATH) this is the sentence it always was.
const missingCli = (ws) => missingCliMsg(ws);

r.post('/w/:ws/ai/correlate', async (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 if missing
    if (!await claudeCliFound(req.params.ws)) {
      const MISSING_CLI = missingCli(req.params.ws);
      return res.status(503).json({ ok: false, error: MISSING_CLI, message: MISSING_CLI });
    }
    res.json(await correlate({ slug: req.params.ws }));
  } catch (e) { next(e); }
});

// Apply ONLY the links the client sends (the approved subset). Each link is
// validated against the live graph/snapshot and applied independently.
r.post('/w/:ws/ai/correlate/apply', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const links = Array.isArray(req.body?.links) ? req.body.links : [];
    if (!links.length) throw store.httpError(400, 'links required: [{rid?|workloadUid?, componentId}]');
    const componentIds = new Set(store.getCollection(ws, 'components').map((c) => c.id));
    const graph = store.getObject(ws, 'resource-graph');
    const gNodes = graph && typeof graph === 'object' && graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : null;
    let k8s = null; // loaded lazily on the first workload link
    let graphChanged = false;
    let k8sChanged = false;
    const applied = [];
    const errors = [];
    for (const raw of links.slice(0, 500)) {
      const rid = raw?.rid !== undefined && raw?.rid !== null ? String(raw.rid) : '';
      const workloadUid = raw?.workloadUid !== undefined && raw?.workloadUid !== null ? String(raw.workloadUid) : '';
      const componentId = String(raw?.componentId || '');
      const label = rid || workloadUid || '(missing target)';
      if ((rid ? 1 : 0) + (workloadUid ? 1 : 0) !== 1) { errors.push(`${label}: exactly one of rid or workloadUid required`); continue; }
      if (!componentIds.has(componentId)) { errors.push(`${label}: no component '${componentId || '(missing)'}'`); continue; }
      if (rid) {
        const node = gNodes ? gNodes[rid] : null;
        if (!node) { errors.push(`${rid}: not in the resource graph`); continue; }
        if (!Array.isArray(node.componentIds)) node.componentIds = [];
        if (!node.componentIds.includes(componentId)) { node.componentIds.push(componentId); graphChanged = true; }
        if (!Array.isArray(graph.edges)) graph.edges = [];
        if (!graph.edges.some((e) => e && e.from === componentId && e.to === rid && e.relation === 'uses')) {
          graph.edges.push({ from: componentId, to: rid, relation: 'uses' });
          graphChanged = true;
        }
        applied.push({ rid, componentId });
      } else {
        if (k8s === null) k8s = store.getObject(ws, 'k8s');
        const w = k8s && Array.isArray(k8s.workloads) ? k8s.workloads.find((x) => x && x.uid === workloadUid) : null;
        if (!w) { errors.push(`${workloadUid}: not in the Kubernetes snapshot`); continue; }
        if (w.componentId !== componentId) { w.componentId = componentId; k8sChanged = true; }
        applied.push({ workloadUid, componentId });
      }
    }
    if (graphChanged) {
      graph.updatedAt = new Date().toISOString();
      store.saveObject(ws, 'resource-graph', graph);
    }
    if (k8sChanged) store.saveObject(ws, 'k8s', k8s);
    res.json({ applied, errors });
  } catch (e) { next(e); }
});

// Deployment-order assist. Additive: the deployment-order router calls the
// bridge directly; this endpoint exists so any page can ask the same question
// with the same validation. SUGGESTIONS ONLY — nothing is ever applied.
r.post('/w/:ws/ai/deploy-order', async (req, res, next) => {
  try {
    const slug = req.params.ws;
    store.getWorkspace(slug); // 404s on an unknown workspace
    let subgraph = req.body && typeof req.body === 'object' ? req.body.subgraph : null;
    if (!subgraph) {
      // Build it ourselves from the engine so callers can just POST {}.
      const eng = await import('../lib/deploy-order.js');
      const model = await eng.deployOrder(slug, { componentId: req.body?.componentId });
      subgraph = eng.ambiguousSubgraph(model, { limit: 60 });
      if (subgraph.empty) {
        res.json({ ok: true, suggestions: [], message: 'Nothing ambiguous in this deployment order.' });
        return;
      }
    }
    res.json(await suggestOrdering({ slug, subgraph }));
  } catch (e) { next(e); }
});


// ---------------------------------------------------------------------------
// [ai-console] The open AI console — POST /w/:ws/ai/console
//
// The difference from every endpoint above: the prompt is whatever the user
// typed, the context is whatever scope the user picked, and the conversation
// is multi-turn. What does NOT differ: it proposes, it never writes. The
// approved subset still goes back through POST /w/:ws/ai/apply.
//
// The transcript is session-local and lives in the browser. It is sent up on
// every turn, so nothing is stored server-side and closing the tab forgets it.

function consoleScope(body) {
  const s = body && typeof body.scope === 'object' && body.scope ? body.scope : {};
  return {
    envId: s.envId ? String(s.envId) : '',
    serviceId: s.serviceId ? String(s.serviceId) : '',
    componentIds: Array.isArray(s.componentIds) ? s.componentIds.map(String) : [],
    include: s.include,
  };
}

function consoleMessages(body) {
  const list = Array.isArray(body && body.messages) ? body.messages : [];
  return list
    .filter((m) => m && typeof m === 'object')
    .slice(-60)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 24000),
      proposedCount: Number(m.proposedCount) || 0,
      appliedCount: Number(m.appliedCount) || 0,
    }))
    .filter((m) => m.content.trim());
}

// What the console can offer as scope: the parts vocabulary plus this
// workspace's real environments and services. No CLI call.
r.get('/w/:ws/ai/console/options', async (req, res, next) => {
  try {
    const slug = req.params.ws;
    const ws = store.getWorkspace(slug); // 404 if missing
    const envs = Array.isArray(ws.environments) ? ws.environments : [];
    let services = [];
    try { services = store.getCollection(slug, 'services') || []; } catch { services = []; }
    let documents = 0;
    try { documents = (store.getCollection(slug, 'documents') || []).length; } catch { documents = 0; }
    res.json({
      ok: true,
      parts: CONSOLE_PARTS,
      defaultInclude: CONSOLE_DEFAULT_INCLUDE,
      environments: envs.map((e) => ({ id: e.id, name: e.name, slug: e.slug || '', isProduction: !!e.isProduction })),
      services: services.map((s) => ({ id: s.id, name: s.name, slug: s.slug || '', envId: s.envId || null })),
      counts: {
        components: (store.getCollection(slug, 'components') || []).length,
        documents,
      },
      claudeCliFound: await claudeCliFound(slug),
      provider: (() => {
        const p = getSelectedProvider(slug);
        return p ? { id: p.id, name: p.name, bin: p.bin, source: p.source, verified: p.verified } : null;
      })(),
      missing: missingCliMsg(slug),
    });
  } catch (e) { next(e); }
});

// Exactly what WOULD be sent for a scope, with per-part byte counts. No CLI
// call — this is how the UI can say "31 KB, inventory + risks" before spending
// three minutes of the user's time, and how a reviewer can check that the
// scope control really changes the prompt.
r.post('/w/:ws/ai/console/context', async (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const built = await buildConsoleContext(req.params.ws, consoleScope(req.body));
    if (built.problem) { res.status(400).json({ ok: false, message: built.problem }); return; }
    const wantFull = /^(1|true|yes)$/i.test(String(req.query.full || ''));
    res.json({
      ok: true, bytes: built.bytes, truncated: built.truncated,
      parts: built.parts, scope: built.scope, counts: built.counts,
      ...(wantFull ? { context: built.json } : {}),
    });
  } catch (e) { next(e); }
});

// One turn. Returns prose, operations, or both. Applies NOTHING.
r.post('/w/:ws/ai/console', async (req, res, next) => {
  try {
    const slug = req.params.ws;
    store.getWorkspace(slug); // 404 if missing
    const messages = consoleMessages(req.body);
    if (!messages.length) throw store.httpError(400, 'messages required: [{role,content}], last one from the user');
    res.json(await converse({
      slug,
      messages,
      scope: consoleScope(req.body),
      page: req.body && req.body.page ? String(req.body.page).slice(0, 60) : '',
    }));
  } catch (e) { next(e); }
});

export default r;
