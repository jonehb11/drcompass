// Kubernetes discovery routes: local kubectl scan (read-only), downloadable
// snapshot script, artifact upload, stored-snapshot CRUD.
// Snapshot is stored per-workspace via saveObject(slug, 'k8s', snapshot).
import { Router } from 'express';
import * as store from '../store.js';
import { listContexts, scan, snapshotScript, normalizeUpload, autoLink } from '../lib/k8s-discovery.js';

const r = Router();

// Exported (additive) for the background-jobs route, which must produce
// byte-compatible results for the same operations.
export function summarize(snapshot, linked) {
  return {
    namespaces: snapshot.namespaces.length,
    workloads: snapshot.workloads.length,
    services: snapshot.services.length,
    ingresses: snapshot.ingresses.length,
    pvcs: snapshot.pvcs.length,
    hpas: snapshot.hpas.length,
    linked,
  };
}

// ---------------------------------------------------------------- kubectl / script

r.get('/discover/k8s/contexts', async (req, res, next) => {
  try {
    res.json(await listContexts()); // { kubectlFound, contexts: [{name, current}] }
  } catch (e) { next(e); }
});

r.get('/discover/k8s/script', (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="drcompass-k8s-snapshot.sh"');
    res.send(snapshotScript());
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- scan / upload

r.post('/w/:ws/k8s/scan', async (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 before shelling out
    const { context = '', namespaces = [] } = req.body || {};
    const { snapshot, log, errors } = await scan({ context, namespaces });
    if (!snapshot) return res.json({ summary: null, log, errors }); // e.g. kubectl missing — nothing saved
    const components = store.getCollection(req.params.ws, 'components');
    const linked = autoLink(snapshot, components);
    store.saveObject(req.params.ws, 'k8s', snapshot);
    res.json({ summary: summarize(snapshot, linked), log, errors });
  } catch (e) { next(e); }
});

r.post('/w/:ws/k8s/upload', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const { snapshot, warnings } = normalizeUpload(req.body); // throws 400 on garbage
    const components = store.getCollection(req.params.ws, 'components');
    const linked = autoLink(snapshot, components);
    store.saveObject(req.params.ws, 'k8s', snapshot);
    res.json({ summary: summarize(snapshot, linked), warnings });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- stored snapshot

r.get('/w/:ws/k8s', (req, res, next) => {
  try {
    res.json(store.getObject(req.params.ws, 'k8s')); // {} when none stored
  } catch (e) { next(e); }
});

r.delete('/w/:ws/k8s', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    store.saveObject(req.params.ws, 'k8s', {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
