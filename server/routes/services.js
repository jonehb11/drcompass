// Services and sub-services — "within Acme Pharmacy you have remittance or
// adjudication or whatever; you should be able to see these categorized with
// their sub-components and the things they require."
//
// Contract: docs/ENV-SERVICE-MODEL.md §2 (services.json) and §3 (a service
// scope means that service AND its sub-services).
//
//   GET    /w/:ws/services                    list (+ ?tree=1, ?envId=)
//   POST   /w/:ws/services                    create
//   GET    /w/:ws/services/:id                one, with members + hierarchy
//   PUT    /w/:ws/services/:id                update (parent change is cycle-guarded)
//   DELETE /w/:ws/services/:id                refuses to orphan — see below
//   POST   /w/:ws/services/:id/members        { add: [], remove: [] }  bulk
//   POST   /w/:ws/services/:id/assign         { componentIds: [], mode }
//
// THE INVARIANT THIS FILE OWNS: `component.serviceId` and
// `service.componentIds` say the same thing after EVERY write, through EVERY
// path. Two places recording the same membership is a standing invitation to
// drift, so this file never edits them independently: every mutation writes
// `component.serviceId` and then REBUILDS every `service.componentIds` from
// the components list (`syncMembership`). One direction is derived, so the two
// cannot disagree — and a component can only ever be in one service, because a
// component has one `serviceId` field.
import { Router } from 'express';
import * as store from '../store.js';
import {
  listServices, findByIdOrSlug, normalizeService, slugify,
  descendantServiceIds, ancestorServiceIds, serviceTree, wouldCycle,
  listEnvironments,
} from '../lib/scope.js';

const r = Router();

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const ids = (v) => arr(v).map(str).filter(Boolean);
const truthy = (v) => /^(1|true|yes|on)$/i.test(str(v));

// ---------------------------------------------------------------- invariant
//
// `component.serviceId` is the source of truth (the contract says readers
// should prefer it). This rebuilds every `service.componentIds` from it and
// writes both collections. Membership order follows component order, so the
// output is stable and diffs stay readable.
function syncMembership(slug, services, components) {
  // Compare against what is ON DISK, not against the array the caller handed
  // in: callers arrive here holding components they have ALREADY edited, so an
  // identity check against that array reports "nothing changed" and silently
  // drops every `component.serviceId` write — which is exactly the drift this
  // function exists to prevent.
  const onDisk = store.getCollection(slug, 'components');
  const valid = new Set(services.map((s) => str(s.id)));
  const members = new Map(services.map((s) => [str(s.id), []]));
  const orphaned = [];
  const cleanedComponents = components.map((c) => {
    const sid = str(c.serviceId);
    if (!sid) return c;
    if (!valid.has(sid)) {
      // Pointing at a service that no longer exists is not membership. Clear
      // it rather than leaving a component that LOOKS assigned.
      orphaned.push(str(c.id));
      return { ...c, serviceId: null, updatedAt: new Date().toISOString() };
    }
    members.get(sid).push(str(c.id));
    return c;
  });
  const nextServices = services.map((s) => {
    const next = members.get(str(s.id)) || [];
    const cur = arr(s.componentIds).map(str);
    if (cur.length === next.length && cur.every((id, i) => id === next[i])) return s;
    return { ...s, componentIds: next, updatedAt: new Date().toISOString() };
  });
  const onDiskServices = store.getCollection(slug, 'services');
  if (JSON.stringify(nextServices) !== JSON.stringify(onDiskServices)) {
    store.saveCollection(slug, 'services', nextServices);
  }
  if (JSON.stringify(cleanedComponents) !== JSON.stringify(onDisk)) {
    store.saveCollection(slug, 'components', cleanedComponents);
  }
  return { services: nextServices, components: cleanedComponents, orphaned };
}

function requireService(slug, idOrSlug, services = null) {
  const list = services || listServices(slug);
  const svc = findByIdOrSlug(list, idOrSlug);
  if (!svc) {
    throw store.httpError(404, list.length
      ? `no service '${idOrSlug}' in workspace '${slug}' — known services: ${list.map((s) => s.id).join(', ')}`
      : `no service '${idOrSlug}': workspace '${slug}' has no services yet`);
  }
  return { services: list, service: svc };
}

function validateEnv(slug, envId) {
  const id = str(envId).trim();
  if (!id) return null;
  const env = findByIdOrSlug(listEnvironments(slug), id);
  if (!env) throw store.httpError(404, `no environment '${id}' in workspace '${slug}'`);
  return env.id;
}

// A service's own components PLUS every sub-service's — the number the UI puts
// next to the parent, and the number a scoped package will actually contain.
function rollup(services, components, rootId) {
  const family = descendantServiceIds(services, rootId);
  const own = [];
  const inherited = [];
  for (const c of components) {
    const sid = str(c.serviceId);
    if (!sid) continue;
    if (sid === str(rootId)) own.push(str(c.id));
    else if (family.has(sid)) inherited.push(str(c.id));
  }
  return { own, inherited, total: own.length + inherited.length, family: [...family] };
}

function summarize(s, components, services) {
  const roll = rollup(services, components, s.id);
  return {
    ...s,
    componentCount: roll.own.length,
    // "with their sub-components": the parent's count must include the
    // children's, or a user reading "adjudication: 2" while its sub-services
    // hold 9 more concludes the service is nearly empty.
    totalComponentCount: roll.total,
    subServiceIds: roll.family.filter((id) => id !== str(s.id)),
  };
}

// ------------------------------------------------------------------ list

r.get('/w/:ws/services', (req, res, next) => {
  try {
    const { ws } = req.params;
    store.getWorkspace(ws); // 404 if missing
    const all = listServices(ws);
    const components = store.getCollection(ws, 'components');
    const envFilter = str(req.query.envId).trim();
    const envId = envFilter ? validateEnv(ws, envFilter) : null;
    const items = (envId ? all.filter((s) => str(s.envId) === envId) : all)
      .map((s) => summarize(s, components, all));
    const body = {
      items,
      total: all.length,
      envId,
      unassignedComponents: components.filter((c) => !str(c.serviceId)).length,
      // §6 migration signal: false ⇒ nothing about this workspace has changed.
      hasServices: all.length > 0,
    };
    if (truthy(req.query.tree)) body.tree = serviceTree(items);
    res.json(body);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ create

r.post('/w/:ws/services', (req, res, next) => {
  try {
    const { ws } = req.params;
    store.getWorkspace(ws);
    const body = req.body || {};
    const name = str(body.name).trim();
    if (!name) throw store.httpError(400, 'service name required (e.g. "adjudication")');

    const services = listServices(ws);
    const slug = slugify(body.slug || name, 'service');
    const envId = validateEnv(ws, body.envId);
    // A service is per-environment, so the same NAME may legitimately exist in
    // dev and in prod; only a clash inside the same environment is a conflict.
    if (services.some((s) => str(s.slug).toLowerCase() === slug.toLowerCase() && str(s.envId) === str(envId || ''))) {
      throw store.httpError(409, `service '${slug}' already exists${envId ? ` in environment '${envId}'` : ''} in '${ws}'`);
    }
    const parentId = str(body.parentServiceId).trim() || null;
    if (parentId && !services.some((s) => str(s.id) === parentId)) {
      throw store.httpError(404, `no parent service '${parentId}' in '${ws}'`);
    }

    const preferred = `svc_${slug.replace(/-/g, '_')}`;
    const id = services.some((s) => s.id === preferred) ? store.newId('svc') : preferred;
    const svc = normalizeService({ ...body, slug, envId, parentServiceId: parentId }, { id, createdAt: new Date().toISOString() });

    // Any componentIds supplied at create are INTENT: they are applied to the
    // components, then membership is rebuilt from the components.
    const wanted = new Set(ids(svc.componentIds));
    const components = store.getCollection(ws, 'components');
    const unknown = [...wanted].filter((cid) => !components.some((c) => str(c.id) === cid));
    if (unknown.length) throw store.httpError(404, `unknown component id(s): ${unknown.join(', ')}`);
    const now = new Date().toISOString();
    const nextComponents = components.map((c) => (wanted.has(str(c.id)) && str(c.serviceId) !== id
      ? { ...c, serviceId: id, updatedAt: now } : c));

    const synced = syncMembership(ws, [...services, { ...svc, componentIds: [] }], nextComponents);
    const created = synced.services.find((s) => s.id === id);
    res.status(201).json(summarize(created, synced.components, synced.services));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ read one

r.get('/w/:ws/services/:id', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { services, service } = requireService(ws, id);
    const components = store.getCollection(ws, 'components');
    const roll = rollup(services, components, service.id);
    const byId = new Map(components.map((c) => [str(c.id), c]));
    const brief = (cid) => {
      const c = byId.get(cid) || {};
      return {
        id: cid, name: str(c.name), kind: str(c.kind), category: str(c.category),
        tier: c.tier ?? null, envId: str(c.envId) || null, serviceId: str(c.serviceId) || null,
        restoreLayer: str(c.restoreLayer), inRecoveryScope: str(c.inRecoveryScope) || 'unknown',
      };
    };
    const memberIds = new Set([...roll.own, ...roll.inherited]);
    // "and the things they require": everything the members depend on that is
    // NOT itself a member. This is the list that turns a service into a DR
    // package, and the place cross-service coupling becomes visible.
    const requires = [];
    for (const cid of memberIds) {
      for (const dep of arr(byId.get(cid)?.dependsOn).map(str)) {
        if (!dep || memberIds.has(dep) || requires.some((x) => x.id === dep)) continue;
        const d = byId.get(dep);
        requires.push({
          ...brief(dep),
          exists: !!d,
          ownedByServiceId: d ? (str(d.serviceId) || null) : null,
          ownedByServiceName: d && str(d.serviceId) ? str(services.find((s) => s.id === str(d.serviceId))?.name || '') : '',
        });
      }
    }
    res.json({
      ...summarize(service, components, services),
      parents: ancestorServiceIds(services, service.id),
      children: services.filter((s) => str(s.parentServiceId) === str(service.id))
        .map((s) => summarize(s, components, services)),
      components: roll.own.map(brief),
      inheritedComponents: roll.inherited.map(brief),
      requires,
      counts: {
        own: roll.own.length,
        inherited: roll.inherited.length,
        total: roll.total,
        requires: requires.length,
        requiresOutsideService: requires.filter((x) => !x.ownedByServiceId).length,
      },
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ update

r.put('/w/:ws/services/:id', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { services, service } = requireService(ws, id);
    const body = { ...(req.body || {}) };
    delete body.id;
    if (body.name !== undefined && !str(body.name).trim()) throw store.httpError(400, 'service name cannot be empty');

    if (body.envId !== undefined) body.envId = validateEnv(ws, body.envId);

    // --- the cycle guard ---------------------------------------------------
    // Without this, `a.parent = b; b.parent = a` makes the tree walk, the
    // scope resolver and the UI sidebar all loop. Rejected with the chain, so
    // the caller can see WHY it is a cycle.
    if (body.parentServiceId !== undefined) {
      const parentId = str(body.parentServiceId).trim() || null;
      if (parentId) {
        if (!services.some((s) => str(s.id) === parentId)) {
          throw store.httpError(404, `no parent service '${parentId}' in '${ws}'`);
        }
        if (parentId === str(service.id)) {
          throw store.httpError(400, `a service cannot be its own parent ('${service.id}')`);
        }
        if (wouldCycle(services, service.id, parentId)) {
          const chain = [...descendantServiceIds(services, service.id)];
          throw store.httpError(400,
            `setting parentServiceId='${parentId}' on '${service.id}' would create a cycle: `
            + `'${parentId}' is already a sub-service of '${service.id}' (${chain.join(' -> ')}). `
            + 'Move the sub-service out first.');
        }
      }
      body.parentServiceId = parentId;
    }

    if (body.slug !== undefined || body.name !== undefined) {
      body.slug = slugify(body.slug || body.name || service.name, service.slug);
      const envId = body.envId !== undefined ? body.envId : service.envId;
      if (services.some((s) => s.id !== service.id
        && str(s.slug).toLowerCase() === str(body.slug).toLowerCase()
        && str(s.envId) === str(envId || ''))) {
        throw store.httpError(409, `service '${body.slug}' already exists in that environment`);
      }
    }

    const updated = normalizeService(body, service);
    let components = store.getCollection(ws, 'components');

    // componentIds on a PUT is a REPLACE of this service's membership, applied
    // through the components (so a component moved in here is moved OUT of
    // whatever it was in, in the same write).
    if (body.componentIds !== undefined) {
      const wanted = new Set(ids(body.componentIds));
      const unknown = [...wanted].filter((cid) => !components.some((c) => str(c.id) === cid));
      if (unknown.length) throw store.httpError(404, `unknown component id(s): ${unknown.join(', ')}`);
      const now = new Date().toISOString();
      components = components.map((c) => {
        const cid = str(c.id);
        const cur = str(c.serviceId) || null;
        const target = wanted.has(cid) ? str(service.id) : (cur === str(service.id) ? null : cur);
        return target === cur ? c : { ...c, serviceId: target, updatedAt: now };
      });
    }

    const nextServices = services.map((s) => (s.id === service.id ? { ...updated, id: service.id } : s));
    const synced = syncMembership(ws, nextServices, components);
    res.json(summarize(synced.services.find((s) => s.id === service.id), synced.components, synced.services));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ delete
//
// Same rule as environments: never orphan silently. Members and sub-services
// are two separate hazards, so each needs its own explicit instruction.
//   ?reassignTo=svc_y     move the member components to another service
//   ?unassign=true        set their serviceId to null
//   ?reparentTo=svc_z     give the sub-services a new parent
//   ?promoteChildren=true make the sub-services top-level
//   ?cascade=true         delete the sub-services too (members handled as above)

r.delete('/w/:ws/services/:id', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { services, service } = requireService(ws, id);
    let components = store.getCollection(ws, 'components');

    const cascade = truthy(req.query.cascade);
    const doomed = cascade ? descendantServiceIds(services, service.id) : new Set([str(service.id)]);
    const children = services.filter((s) => str(s.parentServiceId) === str(service.id) && !doomed.has(str(s.id)));
    const members = components.filter((c) => doomed.has(str(c.serviceId)));

    const reassignTo = str(req.query.reassignTo).trim();
    const unassign = truthy(req.query.unassign);
    const reparentTo = str(req.query.reparentTo).trim();
    const promote = truthy(req.query.promoteChildren);

    let target = null;
    if (reassignTo) {
      target = findByIdOrSlug(services, reassignTo);
      if (!target) throw store.httpError(404, `cannot reassign to '${reassignTo}': no such service in '${ws}'`);
      if (doomed.has(str(target.id))) throw store.httpError(400, `cannot reassign members to '${target.id}': it is being deleted too`);
    }
    let newParent = null;
    if (reparentTo) {
      const p = findByIdOrSlug(services, reparentTo);
      if (!p) throw store.httpError(404, `cannot reparent to '${reparentTo}': no such service in '${ws}'`);
      if (doomed.has(str(p.id))) throw store.httpError(400, `cannot reparent to '${p.id}': it is being deleted too`);
      newParent = p.id;
    }
    // Members and sub-services are two independent hazards. Report BOTH in one
    // refusal: answering them one at a time makes the caller discover the
    // second problem only after they thought they had solved the first.
    const blockers = [];
    if (members.length && !target && !unassign) {
      blockers.push(`${members.length} component(s)${cascade ? ' across it and its sub-services' : ''} are assigned to it`
        + ' — add ?reassignTo=<serviceId> to move them, or ?unassign=true to leave them unassigned');
    }
    if (children.length && !reparentTo && !promote) {
      blockers.push(`${children.length} sub-service(s) hang off it (${children.map((c) => c.name).join(', ')})`
        + ' — add ?reparentTo=<serviceId>, ?promoteChildren=true, or ?cascade=true to delete them too');
    }
    if (blockers.length) {
      throw store.httpError(409,
        `cannot delete service '${service.name}': deleting it would silently orphan things. ${blockers.join('; ')}.`);
    }

    const now = new Date().toISOString();
    if (members.length) {
      const to = target ? str(target.id) : null;
      components = components.map((c) => (doomed.has(str(c.serviceId)) ? { ...c, serviceId: to, updatedAt: now } : c));
    }
    const remaining = services
      .filter((s) => !doomed.has(str(s.id)))
      .map((s) => (str(s.parentServiceId) === str(service.id)
        ? { ...s, parentServiceId: newParent, updatedAt: now } : s));

    const synced = syncMembership(ws, remaining, components);
    // A workspace whose last service just went away must end up with an empty
    // services.json, not a stale one.
    if (!synced.services.length) store.saveCollection(ws, 'services', []);

    const what = target ? `reassigned to ${target.name}` : 'left unassigned';
    res.json({
      ok: true,
      deleted: [...doomed],
      deletedNames: services.filter((s) => doomed.has(str(s.id))).map((s) => s.name),
      cascade,
      components: {
        count: members.length,
        ids: members.map((c) => c.id),
        action: members.length ? (target ? 'reassigned' : 'unassigned') : 'none',
      },
      reassignedTo: target ? target.id : null,
      children: {
        count: children.length,
        ids: children.map((c) => c.id),
        action: children.length ? (newParent ? 'reparented' : 'promoted to top level') : 'none',
      },
      reparentedTo: newParent,
      message: `Deleted ${doomed.size} service(s). `
        + `${members.length ? `${members.length} component(s) were ${what}. ` : 'No components referenced them. '}`
        + `${children.length ? `${children.length} sub-service(s) were ${newParent ? `moved under ${newParent}` : 'promoted to top level'}.` : ''}`,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ members
//
// POST /w/:ws/services/:id/members  { add: [...], remove: [...] }
//
// The bulk endpoint the checkbox UI posts to. Both lists in one request so a
// re-tick and an un-tick land in a single, atomic write — a UI that had to
// send two calls could leave membership half-applied if the second failed.
// Adding a component that already belongs to another service MOVES it (a
// component has at most one service) and the move is reported, never silent.

r.post('/w/:ws/services/:id/members', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { services, service } = requireService(ws, id);
    const body = req.body || {};
    const add = ids(body.add || body.componentIds);
    const remove = ids(body.remove);
    if (!add.length && !remove.length) {
      throw store.httpError(400, 'members needs { add: [componentId, ...] } and/or { remove: [componentId, ...] }');
    }
    const overlap = add.filter((cid) => remove.includes(cid));
    if (overlap.length) throw store.httpError(400, `component id(s) in both add and remove: ${overlap.join(', ')}`);

    const components = store.getCollection(ws, 'components');
    const byId = new Map(components.map((c) => [str(c.id), c]));
    const unknown = [...add, ...remove].filter((cid) => !byId.has(cid));
    if (unknown.length) throw store.httpError(404, `unknown component id(s): ${unknown.join(', ')}`);

    const svcName = new Map(services.map((s) => [str(s.id), str(s.name)]));
    const addSet = new Set(add);
    const removeSet = new Set(remove);
    const now = new Date().toISOString();
    const added = [];
    const removed = [];
    const moved = [];
    const envMismatch = [];

    const next = components.map((c) => {
      const cid = str(c.id);
      const cur = str(c.serviceId) || null;
      let target = cur;
      if (addSet.has(cid)) target = str(service.id);
      else if (removeSet.has(cid) && cur === str(service.id)) target = null;
      if (target === cur) return c;
      if (target) {
        added.push(cid);
        if (cur) moved.push({ componentId: cid, name: str(c.name), from: cur, fromName: svcName.get(cur) || cur, to: str(service.id) });
        // A service records an environment; a component records one too. We do
        // not silently rewrite either — we report the disagreement, because
        // guessing which one is right is how a component ends up scanned in
        // the wrong account.
        if (str(service.envId) && str(c.envId) && str(c.envId) !== str(service.envId)) {
          envMismatch.push({ componentId: cid, name: str(c.name), componentEnvId: str(c.envId), serviceEnvId: str(service.envId) });
        }
      } else removed.push(cid);
      return { ...c, serviceId: target, updatedAt: now };
    });

    const synced = syncMembership(ws, services, next);
    const updated = synced.services.find((s) => s.id === service.id);
    const notMembers = remove.filter((cid) => !removed.includes(cid));

    res.json({
      ok: true,
      serviceId: service.id,
      serviceName: service.name,
      added,
      removed,
      moved,
      // Asked to remove something that was never in this service: not an error
      // (the end state is what was asked for), but the caller is told.
      notMembers,
      envMismatch,
      componentIds: updated.componentIds,
      componentCount: updated.componentIds.length,
      totalComponentCount: rollup(synced.services, synced.components, service.id).total,
      message: `${added.length} added, ${removed.length} removed`
        + `${moved.length ? `, ${moved.length} moved from another service` : ''}`
        + `${envMismatch.length ? `, ${envMismatch.length} in a different environment than the service` : ''}.`,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ assign
//
// POST /w/:ws/services/:id/assign  { componentIds: [], mode }
//
// The environments-equivalent bulk endpoint. `mode:'add'` (default) is the
// same as members-add; `mode:'replace'` makes the list the WHOLE membership,
// which is what a "save these checkboxes" button sends.

r.post('/w/:ws/services/:id/assign', (req, res, next) => {
  try {
    const { ws, id } = req.params;
    const { services, service } = requireService(ws, id);
    const body = req.body || {};
    const mode = str(body.mode || 'add').toLowerCase();
    if (!['add', 'replace'].includes(mode)) throw store.httpError(400, `unknown mode '${mode}' (expected 'add' or 'replace')`);
    const wanted = ids(body.componentIds || body.add);
    if (!wanted.length && mode !== 'replace') throw store.httpError(400, 'assign needs { componentIds: [...] } (or mode "replace")');

    const components = store.getCollection(ws, 'components');
    const unknown = wanted.filter((cid) => !components.some((c) => str(c.id) === cid));
    if (unknown.length) throw store.httpError(404, `unknown component id(s): ${unknown.join(', ')}`);

    const svcName = new Map(services.map((s) => [str(s.id), str(s.name)]));
    const want = new Set(wanted);
    const now = new Date().toISOString();
    const assigned = [];
    const unassigned = [];
    const moved = [];

    const next = components.map((c) => {
      const cid = str(c.id);
      const cur = str(c.serviceId) || null;
      let target = cur;
      if (want.has(cid)) target = str(service.id);
      else if (mode === 'replace' && cur === str(service.id)) target = null;
      if (target === cur) return c;
      if (target) {
        assigned.push(cid);
        if (cur) moved.push({ componentId: cid, name: str(c.name), from: cur, fromName: svcName.get(cur) || cur, to: str(service.id) });
      } else unassigned.push(cid);
      return { ...c, serviceId: target, updatedAt: now };
    });

    const synced = syncMembership(ws, services, next);
    const updated = synced.services.find((s) => s.id === service.id);
    res.json({
      ok: true,
      serviceId: service.id,
      serviceName: service.name,
      mode,
      assigned,
      unassigned,
      moved,
      componentIds: updated.componentIds,
      componentCount: updated.componentIds.length,
      message: `${assigned.length} component(s) assigned to ${service.name}`
        + `${moved.length ? `, ${moved.length} moved out of another service` : ''}`
        + `${unassigned.length ? `, ${unassigned.length} removed` : ''}.`,
    });
  } catch (e) { next(e); }
});

export default r;
