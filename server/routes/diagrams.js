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
    const { data, d } = generateOr404(req);
    // For non-architecture diagrams, export the architecture-style drawio of
    // that diagram's component subset (falls back to everything).
    const subset = new Set(d.componentIds || []);
    const components = subset.size
      ? data.components.filter((c) => subset.has(c.id))
      : data.components;
    const aws = req.query.style === 'aws';
    const xml = aws
      ? gen.drawioXmlIcons({ workspace: data.workspace, components, diagramId: req.params.id })
      : gen.drawioXml({ workspace: data.workspace, components });
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
