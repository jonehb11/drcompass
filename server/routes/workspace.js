import { Router } from 'express';
import * as store from '../store.js';

const r = Router();

r.get('/workspaces', (req, res) => res.json(store.listWorkspaces()));

r.post('/workspaces', (req, res, next) => {
  try {
    const { slug, ...meta } = req.body || {};
    if (!slug) throw store.httpError(400, 'slug required');
    res.status(201).json(store.createWorkspace(slug, meta));
  } catch (e) { next(e); }
});

r.delete('/workspaces/:ws', (req, res, next) => {
  try { store.deleteWorkspace(req.params.ws); res.json({ ok: true }); } catch (e) { next(e); }
});

r.get('/w/:ws/workspace', (req, res, next) => {
  try { res.json(store.getWorkspace(req.params.ws)); } catch (e) { next(e); }
});

r.put('/w/:ws/workspace', (req, res, next) => {
  try { res.json(store.saveWorkspace(req.params.ws, req.body || {})); } catch (e) { next(e); }
});

export default r;
