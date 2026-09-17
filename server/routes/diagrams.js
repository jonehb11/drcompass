// Diagram endpoints — mermaid + draw.io generation from workspace inventory.
import { Router } from 'express';
import * as store from '../store.js';
import * as gen from '../lib/diagram-gen.js';

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

function load(ws) {
  return {
    workspace: store.getWorkspace(ws),
    components: store.getCollection(ws, 'components'),
    runbooks: store.getCollection(ws, 'runbooks'),
    k8sSnapshot: k8sSnapshot(ws),
    resourceGraph: resourceGraph(ws),
  };
}

const NO_SNAPSHOT_MSG = 'No Kubernetes snapshot yet — capture one in Discover → Kubernetes';
const NO_GRAPH_MSG = 'No resource graph yet — run Discover → AWS → Deep enrichment first';

function generateOr404(req) {
  const data = load(req.params.ws);
  if (gen.isK8sDiagramId(req.params.id) && !data.k8sSnapshot)
    throw store.httpError(409, NO_SNAPSHOT_MSG);
  if (gen.isResourceMapId(req.params.id) && !gen.hasResourceGraph(data.resourceGraph))
    throw store.httpError(404, NO_GRAPH_MSG);
  const d = gen.generate(req.params.id, data);
  if (!d) throw store.httpError(404, `no such diagram '${req.params.id}'`);
  return { data, d };
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

// Listing: append the deployment-order entries when an order exists. With no
// order we hand straight over to the original handler below, which is the only
// thing that ever answers today.
r.get('/w/:ws/diagrams', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    const order = await computeDeployOrder(ws, '');
    if (!gen.hasDeployOrder(order)) return next();
    // Mirrors the base listing in the handler below — keep the two in step.
    const data = { ...load(ws), deployOrder: order };
    const out = gen.listDiagrams(data.components);
    if (data.k8sSnapshot) out.push(...gen.listK8sDiagrams(data.k8sSnapshot));
    out.push(...gen.listResourceMapDiagrams(data.components, data.resourceGraph));
    out.push(...gen.listDeployOrderDiagrams(data));
    res.json(out);
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

r.get('/w/:ws/diagrams', (req, res, next) => {
  try {
    const components = store.getCollection(req.params.ws, 'components');
    const out = gen.listDiagrams(components);
    const snap = k8sSnapshot(req.params.ws);
    if (snap) out.push(...gen.listK8sDiagrams(snap));
    out.push(...gen.listResourceMapDiagrams(components, resourceGraph(req.params.ws)));
    res.json(out);
  } catch (e) { next(e); }
});

// More specific routes first.
r.get('/w/:ws/diagrams/:id/drawio', (req, res, next) => {
  try {
    // Problem 9b: this used to export the architecture-style drawio of the
    // diagram's component subset, whatever diagram was asked for — so
    // architecture / dependencies / restore-layers / region-pair / resource-map
    // all returned the SAME file. Each diagram now renders its own node/edge/
    // group model, and a diagram draw.io cannot carry faithfully is refused
    // with a reason rather than answered with a different picture.
    // (generateOr404 still runs first so the existing 404/409 messages for a
    // missing snapshot / resource graph / unknown id are unchanged.)
    const { data } = generateOr404(req);
    const aws = req.query.style === 'aws';
    const out = gen.drawioForDiagram(req.params.id, data, { aws });
    if (!out.ok) throw store.httpError(out.status || 409, out.message);
    const xml = out.xml;
    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}${aws ? '-aws' : ''}.drawio"`);
    res.send(xml);
  } catch (e) { next(e); }
});

// Structured node/edge/group data for the icon-canvas view.
r.get('/w/:ws/diagrams/:id/canvas', (req, res, next) => {
  try {
    const { id } = req.params;
    if (gen.isK8sDiagramId(id)) {
      const data = load(req.params.ws);
      if (!data.k8sSnapshot) throw store.httpError(409, NO_SNAPSHOT_MSG);
      const canvas = gen.buildK8sCanvasData(id, data);
      if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
      res.json(canvas);
      return;
    }
    if (gen.isResourceMapId(id)) {
      const data = load(req.params.ws);
      if (!gen.hasResourceGraph(data.resourceGraph)) throw store.httpError(404, NO_GRAPH_MSG);
      const canvas = gen.buildResourceMapCanvasData(id, data);
      if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
      res.json(canvas);
      return;
    }
    if (!gen.canvasSupported(id))
      throw store.httpError(404, `diagram '${id}' has no icon-canvas view (it is mermaid-only) — use GET /diagrams/${id} instead`);
    const data = load(req.params.ws);
    const canvas = gen.buildCanvasData(id, data);
    if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
    res.json(canvas);
  } catch (e) { next(e); }
});

// Additive: ?flavor=lucid returns the same diagram in the conservative subset
// Lucidchart's Mermaid importer accepts (no classDef/class/style/linkStyle, no
// directives, one subgraph level, ASCII labels, only `-->` and `-- text -->`).
// Any other flavor value — including none — returns today's output byte for byte.
function wantsLucid(req) {
  return String(req.query.flavor || '').toLowerCase() === 'lucid';
}

r.get('/w/:ws/diagrams/:id/mmd', (req, res, next) => {
  try {
    const { d } = generateOr404(req);
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

r.get('/w/:ws/diagrams/:id', (req, res, next) => {
  try {
    const { d } = generateOr404(req);
    const base = { id: d.id, name: d.name, kind: d.kind, mermaid: d.mermaid, notes: d.notes };
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
