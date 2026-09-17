// Diagram endpoints — mermaid + draw.io generation from workspace inventory.
import { Router } from 'express';
import * as store from '../store.js';
import * as gen from '../lib/diagram-gen.js';
import * as solution from '../lib/solution-context.js';

const r = Router();

// The k8s snapshot is captured by the discovery agent and stored as the
// workspace object 'k8s' (may be absent / {}).
function k8sSnapshot(ws) {
  const snap = store.getObject(ws, 'k8s');
  return gen.hasK8sSnapshot(snap) ? snap : null;
}

// The deep-enrichment resource graph lives in the workspace object store as
// 'resource-graph' (may be absent / {} — hasResourceGraph treats both as empty).
function resourceGraph(ws) {
  return store.getObject(ws, 'resource-graph');
}

// Models extracted from uploaded solution documents live in the workspace
// object 'solution-models' (server/lib/solution-context.js). A workspace that
// has never had a document read simply has none, and every solution diagram id
// then answers 409 with a sentence saying what to do.
function solutionModels(ws) {
  try { return solution.solutionModelsFor(ws) || {}; } catch { return {}; }
}

// Services are a normal collection; a workspace written before they existed
// simply has none, and every diagram then covers the whole inventory.
function services(ws) {
  try { return store.getCollection(ws, 'services'); } catch { return []; }
}

/* ===========================================================================
 * SCOPE  —  ?envId= / ?serviceId= on every diagram endpoint
 * ---------------------------------------------------------------------------
 * docs/ENV-SERVICE-MODEL.md §3. The resolver lives in server/lib/scope.js
 * (shared with /c/:col, /export/*, /deploy-order…). It is imported defensively
 * so a workspace, and this router, still work if that module is missing:
 * without it an unknown ?envId is simply not honoured rather than 500-ing.
 *
 * Rules kept exactly as the contract states them:
 *   - no scope ⇒ today's answer, byte for byte (scopeComponents returns the
 *     same array reference, and `scopeData` below returns the same data bag);
 *   - an unknown id is a 404 with a message listing what does exist;
 *   - a scoped response says what it was scoped to.
 * =========================================================================*/

let scopeMod;                   // undefined = not tried, null = unavailable
async function scopeLib() {
  if (scopeMod !== undefined) return scopeMod;
  try {
    const mod = await import('../lib/scope.js');
    scopeMod = mod && typeof mod.resolveScope === 'function' ? mod : null;
  } catch { scopeMod = null; }
  return scopeMod;
}

async function resolveScope(req) {
  const q = req.query || {};
  const asked = ['envId', 'env', 'environmentId', 'environment', 'serviceId', 'service', 'svcId']
    .some((k) => q[k] !== undefined && String(q[k]).trim() !== '');
  if (!asked) return null;
  const mod = await scopeLib();
  if (!mod) return null;               // no resolver installed — unscoped
  const scope = mod.resolveScope(req.params.ws, q);
  if (!scope.ok) throw store.httpError(scope.error?.status || 400, scope.error?.message || 'invalid scope');
  return scope.active ? scope : null;
}

// Narrow a loaded bag to a scope. Components follow the scope; the resource
// graph follows the components; the region pair becomes the environment's own
// pair when it declares one. No scope ⇒ the SAME object.
function scopeData(data, scope) {
  if (!scope || !scope.active) return data;
  const keep = scope.componentIds instanceof Set
    ? scope.componentIds
    : new Set((scope.componentIds || []).map(String));
  const components = (data.components || []).filter((c) => keep.has(String(c.id)));
  const regions = scope.env && scope.env.regions && typeof scope.env.regions === 'object'
    ? { ...(data.workspace?.regions || {}), ...scope.env.regions }
    : data.workspace?.regions;
  return {
    ...data,
    workspace: { ...(data.workspace || {}), regions },
    components,
    resourceGraph: gen.scopeResourceGraph(data.resourceGraph, new Set(components.map((c) => String(c.id)))),
    scope,
  };
}

// What a scoped response says it was scoped to (contract §3).
function scopeMeta(scope, data) {
  if (!scope || !scope.active) return null;
  return {
    envId: scope.envId || null,
    envName: scope.envName || '',
    serviceId: scope.serviceId || null,
    serviceName: scope.serviceName || '',
    componentCount: (data?.components || []).length,
    ...(Array.isArray(scope.warnings) && scope.warnings.length ? { warnings: scope.warnings } : {}),
  };
}

// 'full' turns the scale gate off; 'summary' forces it on even for a picture
// that would fit. Anything else is 'auto'.
function detailOf(req) {
  const v = String(req.query?.detail || '').toLowerCase();
  return v === 'full' || v === 'summary' ? v : 'auto';
}
function levelOf(req) {
  const v = String(req.query?.summary || req.query?.level || '').toLowerCase();
  return v === 'service' || v === 'category' ? v : 'auto';
}

function load(ws) {
  return {
    workspace: store.getWorkspace(ws),
    components: store.getCollection(ws, 'components'),
    runbooks: store.getCollection(ws, 'runbooks'),
    k8sSnapshot: k8sSnapshot(ws),
    resourceGraph: resourceGraph(ws),
    solutionModels: solutionModels(ws),
    services: services(ws),
  };
}

async function loadScoped(req) {
  const scope = await resolveScope(req);
  return { data: scopeData(load(req.params.ws), scope), scope };
}

const NO_SNAPSHOT_MSG = 'No Kubernetes snapshot yet — capture one in Discover → Kubernetes';
const NO_GRAPH_MSG = 'No resource graph yet — run Discover → AWS → Deep enrichment first';
const NO_SOLUTION_MSG = 'No solution model for that document yet — upload the document in Documents, then run the solution extraction on it';

// A scoped request that empties the picture should say so, not draw nothing.
function emptyScopeNote(scope, data) {
  if (!scope || !scope.active || (data.components || []).length) return null;
  const what = [scope.serviceName && `service '${scope.serviceName}'`, scope.envName && `environment '${scope.envName}'`]
    .filter(Boolean).join(' in ');
  return `Nothing is assigned to ${what || 'that scope'} yet — no component carries it. Assign components in Inventory (nothing auto-assigns), or clear the scope to see the whole workspace.`;
}

async function generateOr404(req) {
  const { data, scope } = await loadScoped(req);
  if (gen.isK8sDiagramId(req.params.id) && !data.k8sSnapshot)
    throw store.httpError(409, NO_SNAPSHOT_MSG);
  if (gen.isResourceMapId(req.params.id) && !gen.hasResourceGraph(data.resourceGraph)) {
    throw store.httpError(404, scope && scope.active
      ? `No resource graph inside this scope — the ${(data.components || []).length} component(s) in it have no discovered AWS resources yet. Run Discover → AWS → Deep enrichment, or clear the scope.`
      : NO_GRAPH_MSG);
  }
  if (gen.isSolutionDiagramId(req.params.id) && !gen.solutionModelFor(data, req.params.id))
    throw store.httpError(409, NO_SOLUTION_MSG);
  const d = gen.generate(req.params.id, data, { detail: detailOf(req), level: levelOf(req) });
  if (!d) throw store.httpError(404, `no such diagram '${req.params.id}'`);
  return { data, d, scope };
}

// The additive fields every diagram response now carries. `mermaid`, `notes`,
// `id`, `name` and `kind` are exactly what they were.
function diagramBody(d, scope, data) {
  const note = emptyScopeNote(scope, data);
  return {
    id: d.id,
    name: d.name + (scope && scope.active ? ` — ${gen.scopeLabel(scope)}` : ''),
    kind: d.kind,
    mermaid: d.mermaid,
    notes: [note, d.notes].filter(Boolean).join('\n\n'),
    ...(d.scale ? { scale: d.scale } : {}),
    ...(d.summarized ? { summarized: d.summarized } : {}),
    ...(d.oversize ? { oversize: d.oversize } : {}),
    ...(scope && scope.active ? {
      scope: scopeMeta(scope, data),
      layoutKey: gen.scopedDiagramKey(d.id, scope),
    } : {}),
  };
}

/* ===========================================================================
 * DEPLOYMENT ORDER  (additive — every handler below falls through with next()
 * for every pre-existing diagram id, so the routes further down this file, and
 * their responses, are untouched.)
 *
 * The order itself is computed by server/lib/deploy-order.js, which may not be
 * installed yet: the import is dynamic and every failure degrades to "no order"
 * (diagram ids simply are not listed; asking for one 409s with an explanation).
 * =========================================================================*/

const NO_ORDER_MSG = 'No deployment order yet — it is computed from your inventory and resource graph';

// The published library API is `computeDeployOrder({components, graph, k8s, scope})`
// (INTEGRATION-NOTES.md → "Deployment / Recovery Order Engine"). The extra names
// and call shapes below are only a safety net if that module is renamed.
const ORDER_FN_NAMES = [
  'computeDeployOrder', 'deployOrder', 'buildDeployOrder', 'deploymentOrder',
  'computeOrder', 'compute', 'build', 'generate', 'order',
];

let engineMod; // undefined = not tried yet, null = unavailable
async function deployEngine() {
  if (engineMod !== undefined) return engineMod;
  try {
    const mod = await import('../lib/deploy-order.js');
    engineMod = mod && typeof mod === 'object' ? mod : null;
  } catch {
    engineMod = null; // not written yet, or broken — never fatal
  }
  return engineMod;
}

function engineFn(mod) {
  for (const name of ORDER_FN_NAMES) {
    for (const bag of [mod, mod.default]) {
      if (bag && typeof bag === 'object' && typeof bag[name] === 'function') return bag[name];
    }
  }
  if (typeof mod.default === 'function') return mod.default;
  return null;
}

// Compute the order for a workspace (optionally scoped to one component).
// Returns null — never throws — when the engine is absent or gives us nothing
// shaped like { waves: [...] }.
async function computeDeployOrder(ws, componentId = '') {
  const mod = await deployEngine();
  if (!mod) return null;
  const fn = engineFn(mod);
  if (!fn) return null;
  const data = load(ws);
  const scope = componentId ? { componentId } : null;
  const attempts = [
    // The documented call.
    [{
      components: data.components, graph: data.resourceGraph, k8s: data.k8sSnapshot,
      scope, workspace: data.workspace, runbooks: data.runbooks,
    }],
    // Fallbacks, in case the engine is renamed or takes a different bag.
    [data, componentId ? { componentId } : {}],
    [{ ...data, ws, componentId: componentId || undefined }],
    [ws, componentId ? { componentId } : {}],
  ];
  for (const args of attempts) {
    try {
      const out = await fn(...args);
      if (gen.hasDeployOrder(out)) return out;
    } catch { /* try the next call shape */ }
  }
  return null;
}

// The data bag the deploy-order generators want: everything load() gives plus
// the computed order. Scoped ids get the engine's own scoped answer when it
// supports one; otherwise diagram-gen narrows the workspace order purely.
async function loadWithOrder(req) {
  const ws = req.params.ws;
  const scope = gen.deployOrderScope(req.params.id) || { kind: 'order', componentId: '' };
  let order = null;
  if (scope.kind === 'order' && scope.componentId) order = await computeDeployOrder(ws, scope.componentId);
  if (!order) order = await computeDeployOrder(ws, '');
  return { ...load(ws), deployOrder: order };
}

async function deployOrderOr409(req) {
  const data = await loadWithOrder(req);
  if (!gen.hasDeployOrder(data.deployOrder)) throw store.httpError(409, NO_ORDER_MSG);
  const d = gen.generateDeployOrder(req.params.id, data);
  if (!d) throw store.httpError(404, `no such diagram '${req.params.id}'`);
  return { data, d };
}

/* The listing, scoped. One builder so the two handlers below (with and without
 * a deployment order) cannot drift apart. Entries gain, additively:
 *   estimate / canvasRecommended / summarizes — how big this picture is, so the
 *     page can open a 2,000-component workspace on the icon canvas rather than
 *     on a Mermaid hairball;
 *   scopable — whether ?envId/?serviceId mean anything for that id;
 *   layoutKey — the per-scope key for saved layouts and exports.
 * The `scope`, `environments` and `services` the picker needs ride on the
 * envelope: with no scope asked for, the response is still a bare ARRAY, which
 * is what every existing client expects.
 */
function decorateListing(out, { scope, data }) {
  const active = !!(scope && scope.active);
  return out.map((d) => {
    const id = String(d.id);
    const scopable = !gen.isDeployOrderId(id) && !gen.isK8sDiagramId(id) && !gen.isSolutionDiagramId(id);
    return {
      ...d,
      scopable,
      ...(active && scopable ? { layoutKey: gen.scopedDiagramKey(id, scope) } : {}),
    };
  }).filter((d) => {
    // A per-component entry for a component outside the scope is a dead link.
    if (!active) return true;
    const id = String(d.id);
    const cid = id.startsWith('dependencies-') ? id.slice('dependencies-'.length)
      : (id.startsWith('resource-map-') ? id.slice('resource-map-'.length) : '');
    if (!cid) return true;
    return (data.components || []).some((c) => String(c.id) === cid);
  });
}

async function buildListing(req, { deployOrder = null } = {}) {
  const ws = req.params.ws;
  const scope = await resolveScope(req);
  const data = scopeData({ ...load(ws), ...(deployOrder ? { deployOrder } : {}) }, scope);
  const out = gen.listDiagrams(data.components);
  out.push(...gen.listServiceDiagrams(data, scope));
  if (data.k8sSnapshot) out.push(...gen.listK8sDiagrams(data.k8sSnapshot));
  out.push(...gen.listResourceMapDiagrams(data.components, data.resourceGraph));
  if (deployOrder) out.push(...gen.listDeployOrderDiagrams(data));
  out.push(...gen.listSolutionDiagrams(data));
  const items = decorateListing(out, { scope, data });
  if (!scope || !scope.active) return items;
  // Scoped: an envelope that says what it was scoped to (contract §3).
  return {
    scope: scopeMeta(scope, data),
    items,
  };
}

// The environments and services the picker offers, plus which one to open on.
r.get('/w/:ws/diagrams/scopes', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const workspace = store.getWorkspace(ws);
    const comps = store.getCollection(ws, 'components');
    const svcs = services(ws);
    const envs = Array.isArray(workspace.environments) ? workspace.environments.filter((e) => e && e.id) : [];
    const perEnv = new Map();
    const perSvc = new Map();
    let unassignedEnv = 0;
    for (const c of comps) {
      const e = c.envId ? String(c.envId) : '';
      const s = c.serviceId ? String(c.serviceId) : '';
      if (e) perEnv.set(e, (perEnv.get(e) || 0) + 1); else unassignedEnv++;
      if (s) perSvc.set(s, (perSvc.get(s) || 0) + 1);
    }
    res.json({
      environments: envs.map((e) => ({
        id: String(e.id), name: String(e.name || e.slug || e.id), slug: String(e.slug || ''),
        isProduction: !!e.isProduction, regions: e.regions || null,
        componentCount: perEnv.get(String(e.id)) || 0,
      })),
      services: svcs.map((s) => ({
        id: String(s.id), name: String(s.name || s.id), envId: s.envId ? String(s.envId) : null,
        tier: typeof s.tier === 'number' ? s.tier : null,
        parentServiceId: s.parentServiceId || null,
        diagramId: gen.serviceDiagramId(String(s.id)),
        componentCount: perSvc.get(String(s.id))
          || (Array.isArray(s.componentIds) ? s.componentIds.length : 0),
      })),
      defaultEnvId: workspace.defaultEnvId && envs.some((e) => String(e.id) === String(workspace.defaultEnvId))
        ? String(workspace.defaultEnvId)
        : (envs[0] ? String(envs[0].id) : null),
      componentCount: comps.length,
      unassignedComponents: unassignedEnv,
      limits: { mermaidNodes: gen.MERMAID_MAX_NODES, mermaidEdges: gen.MERMAID_MAX_EDGES },
    });
  } catch (e) { next(e); }
});

// Listing: append the deployment-order entries when an order exists. With no
// order we hand straight over to the original handler below, which is the only
// thing that ever answers today.
r.get('/w/:ws/diagrams', async (req, res, next) => {
  try {
    const order = await computeDeployOrder(req.params.ws, '');
    if (!gen.hasDeployOrder(order)) return next();
    res.json(await buildListing(req, { deployOrder: order }));
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id/drawio', async (req, res, next) => {
  if (!gen.isDeployOrderId(req.params.id)) return next();
  try {
    // Problem 9b: the deployment-order diagrams used to export the ARCHITECTURE
    // view of their component subset. They now export their own waves.
    const { data } = await deployOrderOr409(req);
    const aws = req.query.style === 'aws';
    const out = gen.drawioForDiagram(req.params.id, data, { aws });
    if (!out.ok) throw store.httpError(out.status || 409, out.message);
    const xml = out.xml;
    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}${aws ? '-aws' : ''}.drawio"`);
    res.send(xml);
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id/canvas', async (req, res, next) => {
  if (!gen.isDeployOrderId(req.params.id)) return next();
  try {
    const data = await loadWithOrder(req);
    if (!gen.hasDeployOrder(data.deployOrder)) throw store.httpError(409, NO_ORDER_MSG);
    const canvas = gen.buildDeployOrderCanvasData(req.params.id, data);
    if (!canvas) throw store.httpError(404, `no such diagram '${req.params.id}'`);
    res.json(canvas);
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id/mmd', async (req, res, next) => {
  if (!gen.isDeployOrderId(req.params.id)) return next();
  try {
    const { d } = await deployOrderOr409(req);
    const lucid = wantsLucid(req) ? gen.lucidFlavor(d) : null;
    const body = lucid ? lucid.mermaid : d.mermaid + '\n';
    const notes = lucid && lucid.lucidWarnings.length
      ? lucid.lucidWarnings.map((w) => `%% note: ${w}`).join('\n') + '\n'
      : '';
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}${lucid ? '-lucid' : ''}.mmd"`);
    res.send(notes + body);
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id', async (req, res, next) => {
  if (!gen.isDeployOrderId(req.params.id)) return next();
  try {
    const { d } = await deployOrderOr409(req);
    const base = { id: d.id, name: d.name, kind: d.kind, mermaid: d.mermaid, notes: d.notes };
    if (!wantsLucid(req)) return res.json(base);
    const lucid = gen.lucidFlavor(d);
    res.json({
      ...base,
      mermaid: lucid.mermaid,
      flavor: 'lucid',
      lucidWarnings: lucid.lucidWarnings,
      lucidStats: lucid.lucidStats,
    });
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams', async (req, res, next) => {
  try {
    res.json(await buildListing(req));
  } catch (e) { next(e); }
});

/* ===========================================================================
 * SOLUTION DOCUMENTS → a reviewable model → this router's `solution-<docId>`
 * diagram and the runbook draft other generators consume.
 *
 * The document itself is uploaded and stored by routes/documents.js — nothing
 * here uploads, parses or applies anything. These endpoints only read a stored
 * document, extract the model, and hand it back for review. The model is always
 * saved with review.status 'unreviewed'; no inventory write happens anywhere in
 * this file.
 *
 * Registered before the generic `/diagrams/:id` handlers so `solutions` and
 * `solution/<documentId>` are never mistaken for a diagram id.
 * =========================================================================*/

// Every extracted model in this workspace, newest first.
r.get('/w/:ws/diagrams/solutions', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 for an unknown workspace
    const models = solution.listSolutionModels(req.params.ws);
    res.json(models.map((m) => ({
      documentId: m.documentId,
      documentName: m.documentName,
      diagramId: solution.solutionDiagramId(m.documentId),
      orchestration: m.orchestration?.id || 'unknown',
      orchestrationLabel: m.orchestration?.label || '',
      extractedAt: m.extractedAt || null,
      reviewStatus: m.review?.status || 'unreviewed',
      summary: solution.solutionSummary(m),
      counts: {
        steps: (m.steps || []).length,
        gates: (m.gates || []).length,
        preCutover: (m.preCutoverConditions || []).length,
        conflicts: (m.conflicts || []).length,
        unmatched: (m.components?.unmatched || []).length,
        injectionAttempts: (m.injectionAttempts || []).length,
      },
    })));
  } catch (e) { next(e); }
});

// Read the model extracted from one document.
r.get('/w/:ws/diagrams/solution/:documentId', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const model = solution.getSolutionModel(req.params.ws, req.params.documentId);
    if (!model) throw store.httpError(404, NO_SOLUTION_MSG);
    res.json(model);
  } catch (e) { next(e); }
});

// The runbook/plan draft shaped from the model — for the runbook generator and
// the recommender. A DRAFT: every step carries its provenance and nothing is
// written anywhere.
r.get('/w/:ws/diagrams/solution/:documentId/runbook', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const model = solution.getSolutionModel(ws, req.params.documentId);
    if (!model) throw store.httpError(404, NO_SOLUTION_MSG);
    res.json(solution.solutionRunbookDraft(model, {
      workspace: store.getWorkspace(ws),
      components: store.getCollection(ws, 'components'),
    }));
  } catch (e) { next(e); }
});

// Read a stored document with the AI and produce the model. Needs the local
// Claude Code CLI; without it this answers 503 with the install sentence rather
// than pretending.
r.post('/w/:ws/diagrams/solution/:documentId/extract', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    if (!(await solution.claudeCliFound(ws))) {
      // Names whichever AI CLI is selected (server/lib/ai-providers.js).
      throw store.httpError(503, solution.missingCliMsg(ws));
    }
    const out = await solution.extractSolutionModel({ slug: ws, documentId: req.params.documentId });
    if (!out.ok) throw store.httpError(out.status || 502, out.message);
    res.json({
      ok: true,
      saved: out.saved !== false,
      diagramId: solution.solutionDiagramId(out.model.documentId),
      summary: solution.solutionSummary(out.model),
      model: out.model,
    });
  } catch (e) { next(e); }
});

// Forget an extraction (the uploaded document itself is untouched — that is
// routes/documents.js's to delete).
r.delete('/w/:ws/diagrams/solution/:documentId', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const gone = solution.deleteSolutionModel(req.params.ws, req.params.documentId);
    if (!gone) throw store.httpError(404, NO_SOLUTION_MSG);
    res.json({ ok: true, deleted: req.params.documentId });
  } catch (e) { next(e); }
});

// More specific routes first.
r.get('/w/:ws/diagrams/:id/drawio', async (req, res, next) => {
  try {
    // Problem 9b: this used to export the architecture-style drawio of the
    // diagram's component subset, whatever diagram was asked for — so
    // architecture / dependencies / restore-layers / region-pair / resource-map
    // all returned the SAME file. Each diagram now renders its own node/edge/
    // group model, and a diagram draw.io cannot carry faithfully is refused
    // with a reason rather than answered with a different picture.
    // (generateOr404 still runs first so the existing 404/409 messages for a
    // missing snapshot / resource graph / unknown id are unchanged.)
    const { data } = await generateOr404(req);
    const aws = req.query.style === 'aws';
    const out = gen.drawioForDiagram(req.params.id, data, { aws });
    if (!out.ok) throw store.httpError(out.status || 409, out.message);
    const xml = out.xml;
    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}${aws ? '-aws' : ''}.drawio"`);
    res.send(xml);
  } catch (e) { next(e); }
});

// Structured node/edge/group data for the icon-canvas view. The canvas is the
// view that survives 2,000 resources, so it is scoped exactly like the rest:
// `?envId=`/`?serviceId=` narrow the nodes before any layout happens.
r.get('/w/:ws/diagrams/:id/canvas', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { data, scope } = await loadScoped(req);
    const withScope = (canvas) => (scope && scope.active
      ? { ...canvas, meta: { ...(canvas.meta || {}), scope: scopeMeta(scope, data), layoutKey: gen.scopedDiagramKey(id, scope) } }
      : canvas);
    if (gen.isK8sDiagramId(id)) {
      if (!data.k8sSnapshot) throw store.httpError(409, NO_SNAPSHOT_MSG);
      const canvas = gen.buildK8sCanvasData(id, data);
      if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
      res.json(canvas);
      return;
    }
    if (gen.isResourceMapId(id)) {
      if (!gen.hasResourceGraph(data.resourceGraph)) throw store.httpError(404, NO_GRAPH_MSG);
      const canvas = gen.buildResourceMapCanvasData(id, data);
      if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
      res.json(withScope(canvas));
      return;
    }
    if (gen.isSolutionDiagramId(id)) {
      if (!gen.solutionModelFor(data, id)) throw store.httpError(409, NO_SOLUTION_MSG);
      const canvas = gen.buildSolutionCanvasData(id, data);
      if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
      res.json(canvas);
      return;
    }
    if (!gen.canvasSupported(id))
      throw store.httpError(404, `diagram '${id}' has no icon-canvas view (it is mermaid-only) — use GET /diagrams/${id} instead`);
    const canvas = gen.buildCanvasData(id, data);
    if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
    res.json(withScope(canvas));
  } catch (e) { next(e); }
});

// Additive: ?flavor=lucid returns the same diagram in the conservative subset
// Lucidchart's Mermaid importer accepts (no classDef/class/style/linkStyle, no
// directives, one subgraph level, ASCII labels, only `-->` and `-- text -->`).
// Any other flavor value — including none — returns today's output byte for byte.
function wantsLucid(req) {
  return String(req.query.flavor || '').toLowerCase() === 'lucid';
}

r.get('/w/:ws/diagrams/:id/mmd', async (req, res, next) => {
  try {
    const { d, scope } = await generateOr404(req);
    const lucid = wantsLucid(req) ? gen.lucidFlavor(d) : null;
    const body = lucid ? lucid.mermaid : d.mermaid + '\n';
    // A summarised download says so in the file itself — a .mmd that silently
    // held 24 boxes where the workspace has 2,000 components would be a lie in
    // someone's architecture doc six months from now.
    const head = [];
    if (d.summarized) {
      head.push(`%% SUMMARISED: ${d.summarized.from.nodes} nodes / ${d.summarized.from.edges} links rolled up into `
        + `${d.summarized.to.nodes} ${d.summarized.noun || d.summarized.level}-level nodes / ${d.summarized.to.edges} aggregated links.`);
      head.push('%% Add ?detail=full to this URL for the un-summarised source.');
    }
    if (lucid) for (const w of lucid.lucidWarnings) head.push(`%% note: ${w}`);
    const suffix = `${lucid ? '-lucid' : ''}${d.summarized ? '-summary' : ''}`;
    const scoped = scope && scope.active ? `-${gen.scopedDiagramKey('', scope).replace(/^-+/, '')}` : '';
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}${scoped}${suffix}.mmd"`);
    res.send((head.length ? head.join('\n') + '\n' : '') + body);
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id', async (req, res, next) => {
  try {
    const { d, scope, data } = await generateOr404(req);
    const base = diagramBody(d, scope, data);
    if (!wantsLucid(req)) return res.json(base);
    const lucid = gen.lucidFlavor(d);
    // Same shape, additive fields only.
    res.json({
      ...base,
      mermaid: lucid.mermaid,
      flavor: 'lucid',
      lucidWarnings: lucid.lucidWarnings,
      lucidStats: lucid.lucidStats,
    });
  } catch (e) { next(e); }
});

export default r;
