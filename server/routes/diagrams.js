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

function load(ws) {
  return {
    workspace: store.getWorkspace(ws),
    components: store.getCollection(ws, 'components'),
    runbooks: store.getCollection(ws, 'runbooks'),
    k8sSnapshot: k8sSnapshot(ws),
  };
}

const NO_SNAPSHOT_MSG = 'No Kubernetes snapshot yet — capture one in Discover → Kubernetes';

function generateOr404(req) {
  const data = load(req.params.ws);
  if (gen.isK8sDiagramId(req.params.id) && !data.k8sSnapshot)
    throw store.httpError(409, NO_SNAPSHOT_MSG);
  const d = gen.generate(req.params.id, data);
  if (!d) throw store.httpError(404, `no such diagram '${req.params.id}'`);
  return { data, d };
}

r.get('/w/:ws/diagrams', (req, res, next) => {
  try {
    const out = gen.listDiagrams(store.getCollection(req.params.ws, 'components'));
    const snap = k8sSnapshot(req.params.ws);
    if (snap) out.push(...gen.listK8sDiagrams(snap));
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
    if (!gen.canvasSupported(id))
      throw store.httpError(404, `diagram '${id}' has no icon-canvas view (it is mermaid-only) — use GET /diagrams/${id} instead`);
    const data = load(req.params.ws);
    const canvas = gen.buildCanvasData(id, data);
    if (!canvas) throw store.httpError(404, `no such diagram '${id}'`);
    res.json(canvas);
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id/mmd', (req, res, next) => {
  try {
    const { d } = generateOr404(req);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}.mmd"`);
    res.send(d.mermaid + '\n');
  } catch (e) { next(e); }
});

r.get('/w/:ws/diagrams/:id', (req, res, next) => {
  try {
    const { d } = generateOr404(req);
    res.json({ id: d.id, name: d.name, kind: d.kind, mermaid: d.mermaid, notes: d.notes });
  } catch (e) { next(e); }
});

export default r;
