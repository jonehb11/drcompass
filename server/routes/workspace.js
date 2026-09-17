import { Router } from 'express';
import * as store from '../store.js';
import { normalizeEnvironment, listEnvironments, defaultEnvId, slugify } from '../lib/scope.js';

const r = Router();

const str = (v) => (v === null || v === undefined ? '' : String(v));

// Environments live ON the workspace object (docs/ENV-SERVICE-MODEL.md §2), so
// a plain `PUT /w/:ws/workspace` can reach them. The dedicated CRUD is in
// routes/environments.js; what this does is make sure a raw PUT — from the
// Settings page, from the AI bridge, from curl — cannot leave the list in a
// shape the rest of the app will trip over: entries without ids, duplicate
// ids, a `defaultEnvId` naming an environment that is not there.
//
// Two things it deliberately does NOT do: it does not invent environments (a
// workspace with no `environments` key stays single-environment, §6), and it
// does not touch `component.envId` — reassignment is an explicit operation with
// its own endpoint, never a side effect of saving settings.
function normalizeEnvironmentsIn(slug, body) {
  if (body.environments === undefined && body.defaultEnvId === undefined) return body;
  const out = { ...body };

  if (body.environments !== undefined) {
    if (!Array.isArray(body.environments)) throw store.httpError(400, 'environments must be an array');
    const existing = new Map(listEnvironments(slug).map((e) => [str(e.id), e]));
    const seenIds = new Set();
    const seenSlugs = new Set();
    out.environments = body.environments.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw store.httpError(400, `environments[${i}] is not an object`);
      const name = str(raw.name).trim();
      if (!name) throw store.httpError(400, `environments[${i}] needs a name`);
      const id = str(raw.id).trim() || `env_${slugify(name, `e${i}`).replace(/-/g, '_')}`;
      if (seenIds.has(id)) throw store.httpError(409, `duplicate environment id '${id}'`);
      seenIds.add(id);
      const env = normalizeEnvironment({ ...raw, id }, existing.get(id) || { id });
      const s = (env.slug || slugify(name, `e${i}`)).toLowerCase();
      if (seenSlugs.has(s)) throw store.httpError(409, `duplicate environment slug '${s}'`);
      seenSlugs.add(s);
      return { ...env, id, slug: s };
    });
  }

  const list = out.environments !== undefined ? out.environments : listEnvironments(slug);
  if (body.defaultEnvId !== undefined) {
    const want = str(body.defaultEnvId).trim();
    if (want && !list.some((e) => e.id === want)) {
      throw store.httpError(404, `defaultEnvId '${want}' is not one of this workspace's environments`
        + `${list.length ? ` (${list.map((e) => e.id).join(', ')})` : ' — it has none'}`);
    }
    out.defaultEnvId = want || (list.length ? list[0].id : null);
  } else if (out.environments !== undefined) {
    // The list changed under a default that may no longer exist.
    const cur = defaultEnvId(slug);
    out.defaultEnvId = list.some((e) => e.id === cur) ? cur : (list.length ? list[0].id : null);
  }
  return out;
}

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
  try {
    res.json(store.saveWorkspace(req.params.ws, normalizeEnvironmentsIn(req.params.ws, req.body || {})));
  } catch (e) { next(e); }
});

export default r;
