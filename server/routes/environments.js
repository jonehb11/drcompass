// Environments — "I should be able to go into Acme Pharmacy and choose dev,
// staging or prod."
//
// Contract: docs/ENV-SERVICE-MODEL.md §2 (stored ON workspace.json, not in a
// collection of their own) and §6 (a workspace with no environments behaves
// exactly as it did before this existed).
//
//   GET    /w/:ws/environments                 list + per-environment counts
//   POST   /w/:ws/environments                 create
//   POST   /w/:ws/environments/reorder         { ids: [...] }  (order = UI order)
//   GET    /w/:ws/environments/:id             one, with its members
//   PUT    /w/:ws/environments/:id             update
//   DELETE /w/:ws/environments/:id             refuses to orphan — see below
//   POST   /w/:ws/environments/:id/default     make it the one the UI opens on
//   POST   /w/:ws/environments/:id/assign      bulk assign components
//   GET    /w/:ws/unassigned                   what belongs to nothing yet
//
// THE RULE THAT MATTERS: deleting an environment never silently orphans the
// components that named it. Either the request says what should happen to them
// (`?reassignTo=` / `?unassign=true`) or the delete is refused with the count.
// "The environment vanished and 14 components quietly became homeless" is the
// kind of data loss nobody notices until a recovery test.
import { Router } from 'express';
import * as store from '../store.js';
import {
  listEnvironments, defaultEnvId, findByIdOrSlug, normalizeEnvironment, slugify,
  resolveScope, describeScope,
} from '../lib/scope.js';

const r = Router();

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const ids = (v) => arr(v).map(str).filter(Boolean);
const truthy = (v) => /^(1|true|yes|on)$/i.test(str(v));

function saveEnvironments(slug, envs, nextDefault) {
  const list = envs.map((e) => ({ ...e }));
  const def = list.some((e) => e.id === nextDefault) ? nextDefault : (list.length ? list[0].id : null);
  store.saveWorkspace(slug, { environments: list, defaultEnvId: def });
  return def;
}

function requireEnv(slug, idOrSlug) {
  const envs = listEnvironments(slug);
  const env = findByIdOrSlug(envs, idOrSlug);
  if (!env) {
    throw store.httpError(404, envs.length
      ? `no environment '${idOrSlug}' in workspace '${slug}' — known environments: ${envs.map((e) => e.id).join(', ')}`
      : `no environment '${idOrSlug}': workspace '${slug}' has no environments yet`);
  }
  return { envs, env };
}

// The counts the UI needs to say "prod (11 components, 3 services)" and, more
// importantly, "9 components are not in any environment".
function envCounts(components, services, envs) {
  const byEnv = {};
  for (const e of envs) byEnv[e.id] = { components: 0, services: 0 };
  let unassignedComponents = 0;
  let unassignedServices = 0;
  for (const c of components) {
    const id = str(c.envId);
    if (!id) { unassignedComponents += 1; continue; }
    if (byEnv[id]) byEnv[id].components += 1;
    else (byEnv[id] = { components: 1, services: 0, dangling: true });
  }
  for (const s of services) {
    const id = str(s.envId);
    if (!id) { unassignedServices += 1; continue; }
    if (byEnv[id]) byEnv[id].services += 1;
    else (byEnv[id] = { components: 0, services: 1, dangling: true });
  }
  return { byEnv, unassignedComponents, unassignedServices };
}

// A stored environment may leave regions blank; the workspace's own regions are
// what it actually runs in until someone says otherwise. Computed on read so we
// never write a fabricated region into the file.
function withEffective(env, ws) {
  return {
    ...env,
    effectiveRegions: {
      primary: str(env.regions?.primary) || str(ws.regions?.primary) || '',
      recovery: str(env.regions?.recovery) || str(ws.regions?.recovery) || '',
      inherited: !str(env.regions?.primary) && !str(env.regions?.recovery),
    },
  };
}

// ------------------------------------------------------------------ list

r.get('/w/:ws/environments', (req, res, next) => {
  try {
    const { ws } = req.params;
    const meta = store.getWorkspace(ws);
    const envs = listEnvironments(ws, meta);
    const components = store.getCollection(ws, 'components');
    const services = store.getCollection(ws, 'services');
    const counts = envCounts(components, services, envs);
    res.json({
      items: envs.map((e) => ({ ...withEffective(e, meta), counts: counts.byEnv[e.id] || { components: 0, services: 0 } })),
      defaultEnvId: defaultEnvId(ws, meta),
      unassigned: { components: counts.unassignedComponents, services: counts.unassignedServices },
      // §6: this is the migration-safety signal. `false` means the workspace is
      // single-environment and every read endpoint behaves exactly as before.
      multiEnvironment: envs.length > 0,
      workspaceRegions: meta.regions || null,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ create

r.post('/w/:ws/environments', (req, res, next) => {
  try {
    const { ws } = req.params;
    const body = req.body || {};
    const name = str(body.name).trim();
    if (!name) throw store.httpError(400, 'environment name required (e.g. "Prod")');
    const envs = listEnvironments(ws);
    const slug = slugify(body.slug || name, 'env');
    if (envs.some((e) => str(e.slug).toLowerCase() === slug.toLowerCase())) {
      throw store.httpError(409, `environment slug '${slug}' already exists in '${ws}'`);
    }
    if (envs.some((e) => str(e.name).toLowerCase() === name.toLowerCase())) {
      throw store.httpError(409, `environment '${name}' already exists in '${ws}'`);
    }
    const preferred = `env_${slug.replace(/-/g, '_')}`;
    const id = envs.some((e) => e.id === preferred) ? store.newId('env') : preferred;
    const env = normalizeEnvironment({ ...body, slug }, { id, createdAt: new Date().toISOString() });
    const next2 = [...envs, env];
    // The first environment created becomes the default — otherwise the UI has
    // nothing to open on. Later ones never steal it.
    const def = saveEnvironments(ws, next2, envs.length ? defaultEnvId(ws) : env.id);
    res.status(201).json({ ...withEffective(env, store.getWorkspace(ws)), defaultEnvId: def });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ reorder
// Declared before /:id so 'reorder' can never be read as an environment id.

r.post('/w/:ws/environments/reorder', (req, res, next) => {
  try {
    const { ws } = req.params;
    const envs = listEnvironments(ws);
    const wanted = ids(req.body?.ids || req.body?.order);
    if (!wanted.length) throw store.httpError(400, 'reorder needs { ids: [...] }');
    const byId = new Map(envs.map((e) => [e.id, e]));
    const unknown = wanted.filter((id) => !byId.has(id));
    if (unknown.length) throw store.httpError(404, `unknown environment id(s): ${unknown.join(', ')}`);
    // Ids left out keep their relative order at the end — a partial reorder
    // must not delete an environment.
    const ordered = [...wanted.map((id) => byId.get(id)), ...envs.filter((e) => !wanted.includes(e.id))];
    saveEnvironments(ws, ordered, defaultEnvId(ws));
    res.json({ ok: true, items: ordered, defaultEnvId: defaultEnvId(ws) });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ read one

r.get('/w/:ws/environments/:id', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const meta = store.getWorkspace(ws);
    const { env } = requireEnv(ws, id);
    const components = store.getCollection(ws, 'components');
    const services = store.getCollection(ws, 'services');
    const mine = components.filter((c) => str(c.envId) === env.id);
    res.json({
      ...withEffective(env, meta),
      defaultEnvId: defaultEnvId(ws, meta),
      componentIds: mine.map((c) => c.id),
      components: mine.map((c) => ({ id: c.id, name: c.name, tier: c.tier ?? null, serviceId: str(c.serviceId) || null })),
      services: services.filter((s) => str(s.envId) === env.id).map((s) => ({ id: s.id, name: s.name, parentServiceId: s.parentServiceId || null })),
      counts: { components: mine.length, services: services.filter((s) => str(s.envId) === env.id).length },
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ update

r.put('/w/:ws/environments/:id', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { envs, env } = requireEnv(ws, id);
    const body = { ...(req.body || {}) };
    delete body.id;
    if (body.name !== undefined && !str(body.name).trim()) throw store.httpError(400, 'environment name cannot be empty');
    const nextSlug = body.slug !== undefined || body.name !== undefined
      ? slugify(body.slug || body.name || env.name, env.slug)
      : env.slug;
    if (envs.some((e) => e.id !== env.id && str(e.slug).toLowerCase() === nextSlug.toLowerCase())) {
      throw store.httpError(409, `environment slug '${nextSlug}' already exists in '${ws}'`);
    }
    const updated = normalizeEnvironment({ ...body, slug: nextSlug }, env);
    const list = envs.map((e) => (e.id === env.id ? updated : e));
    saveEnvironments(ws, list, defaultEnvId(ws));
    res.json(withEffective(updated, store.getWorkspace(ws)));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ default

r.post('/w/:ws/environments/:id/default', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { envs, env } = requireEnv(ws, id);
    const def = saveEnvironments(ws, envs, env.id);
    res.json({ ok: true, defaultEnvId: def, name: env.name });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ delete
//
// Refuses to orphan. The caller must say what happens to the members:
//   ?reassignTo=env_y   move them to another environment
//   ?unassign=true      set envId to null (they become "unassigned" again)
// and the response says exactly what it did.

r.delete('/w/:ws/environments/:id', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { envs, env } = requireEnv(ws, id);
    const components = store.getCollection(ws, 'components');
    const services = store.getCollection(ws, 'services');
    const memberComponents = components.filter((c) => str(c.envId) === env.id);
    const memberServices = services.filter((s) => str(s.envId) === env.id);
    const total = memberComponents.length + memberServices.length;

    const reassignTo = str(req.query.reassignTo).trim();
    const unassign = truthy(req.query.unassign);
    let target = null;
    if (reassignTo) {
      target = findByIdOrSlug(envs, reassignTo);
      if (!target) throw store.httpError(404, `cannot reassign to '${reassignTo}': no such environment in '${ws}'`);
      if (target.id === env.id) throw store.httpError(400, `cannot reassign '${env.id}' to itself`);
    }
    if (total && !target && !unassign) {
      throw store.httpError(409,
        `environment '${env.name}' still has ${memberComponents.length} component(s)`
        + `${memberServices.length ? ` and ${memberServices.length} service(s)` : ''} assigned to it. `
        + 'Deleting it would orphan them silently. Re-send with ?reassignTo=<envId> to move them, '
        + 'or ?unassign=true to leave them unassigned.');
    }

    const newEnvId = target ? target.id : null;
    if (total) {
      if (memberComponents.length) {
        store.saveCollection(ws, 'components', components.map((c) => (
          str(c.envId) === env.id ? { ...c, envId: newEnvId, updatedAt: new Date().toISOString() } : c)));
      }
      if (memberServices.length) {
        store.saveCollection(ws, 'services', services.map((s) => (
          str(s.envId) === env.id ? { ...s, envId: newEnvId, updatedAt: new Date().toISOString() } : s)));
      }
    }
    const remaining = envs.filter((e) => e.id !== env.id);
    const def = saveEnvironments(ws, remaining, defaultEnvId(ws) === env.id ? null : defaultEnvId(ws));

    const what = target ? `reassigned to ${target.name}` : 'left unassigned';
    res.json({
      ok: true,
      deleted: { id: env.id, name: env.name },
      components: { count: memberComponents.length, ids: memberComponents.map((c) => c.id), action: total ? (target ? 'reassigned' : 'unassigned') : 'none' },
      services: { count: memberServices.length, ids: memberServices.map((s) => s.id), action: total ? (target ? 'reassigned' : 'unassigned') : 'none' },
      reassignedTo: newEnvId,
      defaultEnvId: def,
      message: total
        ? `Deleted environment '${env.name}'. ${memberComponents.length} component(s)`
          + `${memberServices.length ? ` and ${memberServices.length} service(s)` : ''} were ${what}.`
        : `Deleted environment '${env.name}'. Nothing referenced it.`,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ assign
//
// POST /w/:ws/environments/:id/assign  { componentIds: [], remove: [], mode }
//
//   mode 'add'     (default) — the listed components join this environment
//   mode 'replace'           — this environment's membership BECOMES the list;
//                              anything currently in it and not listed is
//                              unassigned. This is what a checkbox list posts.
//
// A component belongs to exactly ONE environment, so assigning it here moves it
// out of whatever it was in — the response reports every such move by name,
// because a silent move is a lie about where something runs.

r.post('/w/:ws/environments/:id/assign', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { envs, env } = requireEnv(ws, id);
    const body = req.body || {};
    const mode = str(body.mode || 'add').toLowerCase();
    if (!['add', 'replace'].includes(mode)) throw store.httpError(400, `unknown mode '${mode}' (expected 'add' or 'replace')`);

    const wanted = ids(body.componentIds || body.add);
    const remove = ids(body.remove);
    if (!wanted.length && !remove.length && mode !== 'replace') {
      throw store.httpError(400, 'assign needs { componentIds: [...] } (or { remove: [...] }, or mode "replace")');
    }

    const components = store.getCollection(ws, 'components');
    const byId = new Map(components.map((c) => [str(c.id), c]));
    const notFound = [...wanted, ...remove].filter((cid) => !byId.has(cid));
    if (notFound.length) throw store.httpError(404, `unknown component id(s): ${notFound.join(', ')}`);

    const envName = new Map(envs.map((e) => [e.id, e.name]));
    const add = new Set(wanted);
    const drop = new Set(remove);
    const moved = [];
    const assigned = [];
    const unassigned = [];
    const now = new Date().toISOString();

    const next2 = components.map((c) => {
      const cid = str(c.id);
      const cur = str(c.envId) || null;
      let target = cur;
      if (add.has(cid)) target = env.id;
      else if (drop.has(cid) && cur === env.id) target = null;
      else if (mode === 'replace' && cur === env.id) target = null;
      if (target === cur) return c;
      if (target === env.id) {
        assigned.push(cid);
        if (cur) moved.push({ componentId: cid, name: str(c.name), from: cur, fromName: envName.get(cur) || cur, to: env.id });
      } else unassigned.push(cid);
      return { ...c, envId: target, updatedAt: now };
    });

    if (assigned.length || unassigned.length) store.saveCollection(ws, 'components', next2);

    res.json({
      ok: true,
      envId: env.id,
      envName: env.name,
      mode,
      assigned,
      unassigned,
      moved,
      componentIds: next2.filter((c) => str(c.envId) === env.id).map((c) => c.id),
      message: `${assigned.length} component(s) assigned to ${env.name}`
        + `${moved.length ? `, ${moved.length} moved out of another environment` : ''}`
        + `${unassigned.length ? `, ${unassigned.length} removed from ${env.name}` : ''}.`,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ unassigned
//
// GET /w/:ws/unassigned[?dimension=env|service|either|both]
//
// "We're not 100% sure what belongs to Acme Pharmacy" — this is the list that
// checkbox flow reads. Nothing here auto-assigns anything; it only reports.
//   either (default) — missing an environment OR a service
//   both             — missing BOTH (never been touched)
//   env / service    — missing that one dimension

r.get('/w/:ws/unassigned', (req, res, next) => {
  try {
    const { ws } = req.params;
    const meta = store.getWorkspace(ws);
    const dimension = str(req.query.dimension || 'either').toLowerCase();
    if (!['either', 'both', 'env', 'service'].includes(dimension)) {
      throw store.httpError(400, `unknown dimension '${dimension}' (expected either|both|env|service)`);
    }
    const components = store.getCollection(ws, 'components');
    const services = store.getCollection(ws, 'services');
    const envs = listEnvironments(ws, meta);
    const svcName = new Map(services.map((s) => [str(s.id), str(s.name)]));
    const envName = new Map(envs.map((e) => [str(e.id), str(e.name)]));

    const rows = components.map((c) => {
      const envId = str(c.envId) || null;
      const serviceId = str(c.serviceId) || null;
      return {
        id: c.id,
        name: str(c.name),
        kind: str(c.kind),
        category: str(c.category),
        tier: c.tier ?? null,
        envId,
        envName: envId ? (envName.get(envId) || null) : null,
        serviceId,
        serviceName: serviceId ? (svcName.get(serviceId) || null) : null,
        // A component pointing at an environment or service that no longer
        // exists is worse than an unassigned one: it looks assigned.
        danglingEnvId: !!envId && !envName.has(envId),
        danglingServiceId: !!serviceId && !svcName.has(serviceId),
      };
    });

    const missingEnv = (x) => !x.envId || x.danglingEnvId;
    const missingSvc = (x) => !x.serviceId || x.danglingServiceId;
    const match = {
      either: (x) => missingEnv(x) || missingSvc(x),
      both: (x) => missingEnv(x) && missingSvc(x),
      env: missingEnv,
      service: missingSvc,
    }[dimension];

    const items = rows.filter(match);
    res.json({
      items,
      dimension,
      counts: {
        total: rows.length,
        noEnvironment: rows.filter(missingEnv).length,
        noService: rows.filter(missingSvc).length,
        neither: rows.filter((x) => missingEnv(x) && missingSvc(x)).length,
        dangling: rows.filter((x) => x.danglingEnvId || x.danglingServiceId).length,
      },
      environments: envs.map((e) => ({ id: e.id, name: e.name })),
      services: services.map((s) => ({ id: s.id, name: s.name, parentServiceId: s.parentServiceId || null })),
      message: envs.length || services.length
        ? `${items.length} of ${rows.length} component(s) are not fully assigned.`
        : 'This workspace has no environments and no services, so nothing is assigned — that is the single-environment default, not a problem.',
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ scope echo
//
// GET /w/:ws/scope?envId=&serviceId= — the resolver itself, over HTTP. The UI
// header uses it to print "Scoped to adjudication and its 2 sub-services, in
// Prod — 11 of 27 components." without duplicating the rule in JavaScript.

r.get('/w/:ws/scope', (req, res, next) => {
  try {
    const scope = resolveScope(req.params.ws, req.query);
    if (!scope.ok) throw store.httpError(scope.error.status, scope.error.message);
    res.json({
      active: scope.active,
      envId: scope.envId,
      envName: scope.envName,
      serviceId: scope.serviceId,
      serviceName: scope.serviceName,
      serviceIds: scope.serviceIds,
      componentIds: [...scope.componentIds],
      componentCount: scope.componentCount,
      totalComponents: scope.totalComponents,
      warnings: scope.warnings,
      description: describeScope(scope),
    });
  } catch (e) { next(e); }
});

export default r;
