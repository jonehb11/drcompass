// AI copilot routes: propose workspace operations from an instruction, apply
// a user-approved subset. Pre-mounted at /api by server/index.js.
import { Router } from 'express';
import * as store from '../store.js';
import {
  propose, correlate, claudeCliFound, validateOperations,
  ask, draft, review, narrative, buildFocusedContext, NARRATIVE_KINDS,
} from '../lib/ai-bridge.js';

const r = Router();
const PREFIX = { components: 'cmp', runbooks: 'rbk', tests: 'tst', checklists: 'chk', gaps: 'gap', decisions: 'dec', contacts: 'per' };

r.get('/ai/status', async (req, res, next) => {
  try { res.json({ claudeCliFound: await claudeCliFound() }); } catch (e) { next(e); }
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
r.post('/w/:ws/ai/apply', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const ops = Array.isArray(req.body?.operations) ? req.body.operations : [];
    const applied = [];
    const errors = [];
    for (const raw of ops) {
      const label = `${raw?.op || '?'} ${raw?.collection || ''} ${raw?.id || ''}`.trim();
      try {
        const [op] = validateOperations(ws, [raw]); // fresh validation per op
        if (!op.valid) { errors.push(`${label}: ${op.problem}`); continue; }
        if (op.op === 'update-workspace') {
          const meta = store.saveWorkspace(ws, op.data);
          applied.push({ op: 'update-workspace', collection: 'workspace', id: ws, name: meta.name || ws });
        } else if (op.op === 'create') {
          const items = store.getCollection(ws, op.collection);
          const item = { ...op.data, id: store.newId(PREFIX[op.collection] || 'itm'), updatedAt: new Date().toISOString() };
          items.push(item);
          store.saveCollection(ws, op.collection, items);
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
      }
    }
    res.json({ applied, errors });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// AI correlation: propose links from unlinked resource-graph nodes and
// Kubernetes workloads to components, then apply the user-approved subset.

const MISSING_CLI = 'Claude Code CLI not found on PATH — install Claude Code (https://claude.com/claude-code), sign in, then retry.';

r.post('/w/:ws/ai/correlate', async (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 if missing
    if (!await claudeCliFound()) {
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

export default r;
