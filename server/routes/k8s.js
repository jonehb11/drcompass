// Kubernetes discovery routes: local kubectl scan (read-only), downloadable
// snapshot script, artifact upload, stored-snapshot CRUD.
//
// STORAGE — one snapshot PER ENVIRONMENT (v0.7), migrated on read
// ---------------------------------------------------------------------------
// A workspace used to hold exactly one cluster snapshot, written flat to
// `k8s.json` and read by half the app (diagrams, deploy-order, exports,
// ai-bridge, network flows) with a bare `store.getObject(slug, 'k8s')`. Dev
// and prod are different clusters, so that has to become one snapshot per
// environment — without breaking any of those readers, and without a
// migration step that a workspace saved yesterday has to survive.
//
// The shape:
//
//   {
//     ...mostRecentSnapshot,     // FLAT, exactly the old shape. Every existing
//     envId: 'env_prod',         // reader keeps working, unchanged.
//     envName: 'Prod',
//     byEnv: { env_dev: {…} },   // every OTHER environment's snapshot
//     legacy: {…}                // the pre-environments snapshot, once an
//   }                            // env-scoped capture displaced it
//
// So: the flat top level is always the newest capture (that is what an
// unscoped read returns, byte-identically to before), `byEnv` holds the rest,
// and no snapshot is ever stored twice — a reader that mutates the flat
// snapshot and saves the whole object back (routes/ai.js does exactly that
// when it applies workload links) cannot desynchronise a duplicate.
//
// Migration is on read: a file with no `byEnv`/`envId` IS the flat snapshot
// and is treated as the unscoped/legacy one. It is never silently claimed by
// an environment — asking for prod's snapshot when all that exists is a
// pre-environments capture answers "none for prod", and says the unassigned
// one is there. The migration is performed on the next env-scoped write.
import { Router } from 'express';
import * as store from '../store.js';
import { listContexts, scan, snapshotScript, normalizeUpload, autoLink } from '../lib/k8s-discovery.js';
import { resolveDiscoveryEnv, envScope } from './discover.js';

const r = Router();

const K8S = 'k8s';

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

// ------------------------------------------------------- per-env storage

const hasSnapshot = (s) => !!(s && typeof s === 'object'
  && (s.capturedAt || s.summary || s.counts || s.cluster || s.source
    || Array.isArray(s.workloads) || Array.isArray(s.namespaces)));

// The flat snapshot inside the stored object (the per-env index stripped off).
function flatOf(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const { byEnv, legacy, ...flat } = stored;
  return hasSnapshot(flat) ? flat : null;
}

function byEnvOf(stored) {
  const m = stored && typeof stored.byEnv === 'object' && stored.byEnv ? stored.byEnv : {};
  const out = {};
  for (const [k, v] of Object.entries(m)) if (k && hasSnapshot(v)) out[k] = v;
  return out;
}

export function readStored(ws) {
  try { return store.getObject(ws, K8S) || {}; } catch { return {}; }
}

/**
 * The snapshot for one environment, or the unscoped one.
 *   envId given -> that environment's snapshot, or null. NEVER another
 *                  environment's, and never the pre-environments one.
 *   no envId    -> the flat (most recent) snapshot: today's behaviour exactly.
 */
export function readSnapshot(ws, envId = '') {
  const stored = readStored(ws);
  const flat = flatOf(stored);
  const id = String(envId || '');
  if (!id) return flat;
  if (flat && String(flat.envId || '') === id) return flat;
  return byEnvOf(stored)[id] || null;
}

// What else is on file — so a "no snapshot for prod" answer can say what there
// IS, instead of looking like an empty workspace.
export function snapshotIndex(ws) {
  const stored = readStored(ws);
  const flat = flatOf(stored);
  const byEnv = byEnvOf(stored);
  const envIds = new Set(Object.keys(byEnv));
  if (flat && flat.envId) envIds.add(String(flat.envId));
  return {
    envIds: [...envIds],
    // A capture made before environments existed (or deliberately unscoped).
    hasUnassigned: !!(stored.legacy && hasSnapshot(stored.legacy)) || !!(flat && !flat.envId),
    capturedAt: flat?.capturedAt || null,
    currentEnvId: flat?.envId || '',
  };
}

/**
 * Write one environment's snapshot. The newest capture becomes the flat top
 * level (so unscoped readers see it); whatever was there moves into `byEnv`
 * under its own environment, or into `legacy` if it predates environments.
 * An unscoped write into a workspace with no per-env snapshots is exactly the
 * old `saveObject(ws, 'k8s', snapshot)` — same bytes, same file.
 */
export function writeSnapshot(ws, envInfo, snapshot) {
  const stored = readStored(ws);
  const byEnv = byEnvOf(stored);
  let legacy = hasSnapshot(stored.legacy) ? stored.legacy : null;
  const prev = flatOf(stored);
  const envId = envInfo ? envInfo.id : '';

  if (prev) {
    const prevEnv = String(prev.envId || '');
    if (prevEnv) byEnv[prevEnv] = prev;
    else if (envId) legacy = prev; // displaced by the first env-scoped capture
  }
  if (envId) delete byEnv[envId];

  const next = { ...snapshot };
  if (envId) { next.envId = envInfo.id; next.envName = envInfo.name; }
  if (Object.keys(byEnv).length) next.byEnv = byEnv;
  if (legacy) next.legacy = legacy;
  store.saveObject(ws, K8S, next);
  return next;
}

/**
 * Delete one environment's snapshot (or, unscoped, every snapshot — which is
 * what the button has always done).
 */
export function deleteSnapshot(ws, envInfo) {
  if (!envInfo) { store.saveObject(ws, K8S, {}); return { deleted: 'all' }; }
  const stored = readStored(ws);
  const byEnv = byEnvOf(stored);
  const legacy = hasSnapshot(stored.legacy) ? stored.legacy : null;
  const flat = flatOf(stored);
  const envId = envInfo.id;
  let deleted = false;

  if (byEnv[envId]) { delete byEnv[envId]; deleted = true; }
  let promoted = null;
  if (flat && String(flat.envId || '') === envId) {
    deleted = true;
    // Promote the newest remaining per-env snapshot into the flat slot so the
    // unscoped readers keep seeing a real snapshot.
    const rest = Object.entries(byEnv)
      .sort((a, b) => String(b[1]?.capturedAt || '').localeCompare(String(a[1]?.capturedAt || '')));
    if (rest.length) { promoted = rest[0][1]; delete byEnv[rest[0][0]]; }
    else if (legacy) promoted = legacy;
  } else {
    promoted = flat;
  }

  const next = promoted ? { ...promoted } : {};
  if (Object.keys(byEnv).length) next.byEnv = byEnv;
  if (legacy && promoted !== legacy) next.legacy = legacy;
  store.saveObject(ws, K8S, next);
  return { deleted: deleted ? envId : null };
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
    const { namespaces = [] } = req.body || {};
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.body?.envId);
    // The environment names the cluster to snapshot; an explicit context wins.
    const context = String(req.body?.context ?? '').trim() || (envInfo ? envInfo.kubeContext : '');
    const { snapshot, log, errors } = await scan({ context, namespaces });
    if (!snapshot) return res.json({ summary: null, log, errors }); // e.g. kubectl missing — nothing saved
    const components = scopedComponents(req.params.ws, envInfo);
    const linked = autoLink(snapshot, components);
    writeSnapshot(req.params.ws, envInfo, snapshot);
    const scope = envScope(envInfo);
    res.json({ summary: summarize(snapshot, linked), log, errors, ...(scope ? { scope } : {}) });
  } catch (e) { next(e); }
});

r.post('/w/:ws/k8s/upload', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.body?.envId);
    const { snapshot, warnings } = normalizeUpload(req.body); // throws 400 on garbage
    const components = scopedComponents(req.params.ws, envInfo);
    const linked = autoLink(snapshot, components);
    writeSnapshot(req.params.ws, envInfo, snapshot);
    const scope = envScope(envInfo);
    res.json({ summary: summarize(snapshot, linked), warnings, ...(scope ? { scope } : {}) });
  } catch (e) { next(e); }
});

// Workloads are matched against the components of the environment being
// snapshotted — a dev pod must not claim the prod component of the same name.
function scopedComponents(ws, envInfo) {
  const all = store.getCollection(ws, 'components');
  if (!envInfo) return all;
  return all.filter((c) => String(c?.envId || '') === envInfo.id);
}

// ---------------------------------------------------------------- stored snapshot

r.get('/w/:ws/k8s', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 for an unknown workspace, as before
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.query.envId);
    if (!envInfo) return res.json(readSnapshot(req.params.ws) || {}); // unchanged
    const snap = readSnapshot(req.params.ws, envInfo.id);
    if (snap) return res.json({ ...snap, scope: envScope(envInfo) });
    // Nothing for this environment. This used to answer a bare `{}` unless the
    // caller thought to ask `?explain=1`, which is the one thing §3/§7 forbid:
    // an empty scoped answer has to say WHY it is empty, or a reader concludes
    // the cluster was never captured when in fact it was captured for another
    // environment. So the explanation is now unconditional. It stays additive —
    // there is still no snapshot-shaped field in this body, so every consumer
    // that tests for `capturedAt` / `workloads` still reads "no snapshot yet".
    const idx = snapshotIndex(req.params.ws);
    const others = idx.envIds.filter((id) => id !== envInfo.id);
    res.json({
      scope: envScope(envInfo),
      empty: true,
      why: `No Kubernetes snapshot has been captured for the ${envInfo.name} environment`
        + `${others.length ? `. One exists for ${others.join(', ')} — a snapshot of another environment's cluster is never shown here, because a dev pod must not stand in for a prod workload` : ''}`
        + `${idx.hasUnassigned ? `${others.length ? ', and' : '. There is also'} a capture that predates environments (or was taken unscoped), which is not claimed by any environment until an env-scoped capture replaces it` : ''}`
        + `. This is empty because nothing was captured for this environment, not because the workspace has no cluster.`,
      capturedForEnvIds: idx.envIds,
      hasUnassignedSnapshot: idx.hasUnassigned,
    });
  } catch (e) { next(e); }
});

r.delete('/w/:ws/k8s', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.query.envId);
    const out = deleteSnapshot(req.params.ws, envInfo);
    res.json({ ok: true, ...(envInfo ? { envId: envInfo.id, deleted: out.deleted } : {}) });
  } catch (e) { next(e); }
});

export default r;
