// Diagram endpoints — mermaid + draw.io generation from workspace inventory.
import { Router } from 'express';
import * as store from '../store.js';
import * as gen from '../lib/diagram-gen.js';

const r = Router();

function load(ws) {
  return {
    workspace: store.getWorkspace(ws),
    components: store.getCollection(ws, 'components'),
    runbooks: store.getCollection(ws, 'runbooks'),
  };
}

function generateOr404(req) {
  const data = load(req.params.ws);
  const d = gen.generate(req.params.id, data);
  if (!d) throw store.httpError(404, `no such diagram '${req.params.id}'`);
  return { data, d };
}

r.get('/w/:ws/diagrams', (req, res, next) => {
  try {
    res.json(gen.listDiagrams(store.getCollection(req.params.ws, 'components')));
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
    const xml = gen.drawioXml({ workspace: data.workspace, components });
    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="${req.params.id}.drawio"`);
    res.send(xml);
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
