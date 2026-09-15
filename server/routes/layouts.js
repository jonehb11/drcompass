// Per-diagram canvas layouts: user-dragged node positions + chosen template.
// Stored per workspace in layouts.json: { [diagramId]: { positions, template, updatedAt } }
import { Router } from 'express';
import * as store from '../store.js';

const r = Router();

const DIAGRAM_ID = /^[\w-]{1,160}$/;
const TEMPLATES = ['category-grid', 'layer-rows', 'flow'];

function checkDiagramId(id) {
  if (!DIAGRAM_ID.test(id)) throw store.httpError(400, `invalid diagram id '${String(id).slice(0, 60)}'`);
  return id;
}

// Keep only entries whose key is a sane node id and whose x/y are finite numbers.
function sanitizePositions(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw store.httpError(400, 'positions must be an object of {nodeId: {x, y}}');
  }
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!/^[\w.:-]{1,200}$/.test(key)) continue;
    if (val === null || typeof val !== 'object') continue;
    const x = Number(val.x), y = Number(val.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[key] = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }
  return out;
}

r.get('/w/:ws/layouts/:diagramId', (req, res, next) => {
  try {
    const id = checkDiagramId(req.params.diagramId);
    const all = store.getObject(req.params.ws, 'layouts');
    const entry = all && typeof all === 'object' ? all[id] : null;
    if (!entry || typeof entry !== 'object') return res.json({});
    res.json({
      positions: entry.positions && typeof entry.positions === 'object' ? entry.positions : {},
      template: typeof entry.template === 'string' ? entry.template : null,
    });
  } catch (e) { next(e); }
});

r.put('/w/:ws/layouts/:diagramId', (req, res, next) => {
  try {
    const id = checkDiagramId(req.params.diagramId);
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw store.httpError(400, 'body must be {positions, template}');
    }
    const positions = sanitizePositions(body.positions ?? {});
    let template = null;
    if (body.template !== undefined && body.template !== null) {
      if (typeof body.template !== 'string' || !TEMPLATES.includes(body.template)) {
        throw store.httpError(400, `template must be one of: ${TEMPLATES.join(', ')}`);
      }
      template = body.template;
    }
    const all = store.getObject(req.params.ws, 'layouts');
    const clean = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    clean[id] = { positions, template, updatedAt: new Date().toISOString() };
    store.saveObject(req.params.ws, 'layouts', clean);
    res.json({ positions: clean[id].positions, template: clean[id].template });
  } catch (e) { next(e); }
});

r.delete('/w/:ws/layouts/:diagramId', (req, res, next) => {
  try {
    const id = checkDiagramId(req.params.diagramId);
    const all = store.getObject(req.params.ws, 'layouts');
    if (all && typeof all === 'object' && all[id]) {
      delete all[id];
      store.saveObject(req.params.ws, 'layouts', all);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
