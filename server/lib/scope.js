// Environments + services: the scoping helper every read endpoint imports.
//
// Contract: docs/ENV-SERVICE-MODEL.md (§3 Scoping, §7 this API).
//
// The one sentence that explains this file: a workspace is ONE system you are
// responsible for recovering; inside it there are ENVIRONMENTS (dev, staging,
// prod — different accounts, recovered separately) and SERVICES (adjudication,
// remittance — each owning a slice of the components, and each able to own
// SUB-SERVICES). A component belongs to exactly one environment and at most one
// service. "The DR package for Acme Pharmacy / adjudication / prod" is
// `resolveScope(ws, { envId, serviceId })` and then `scopeCollection(...)` for
// every collection in the package.
//
// Three rules, from the contract, that this file exists to enforce:
//
//   1. A SERVICE SCOPE MEANS THAT SERVICE **AND ITS SUB-SERVICES**. Asking for
//      adjudication when adjudication has a `claims-intake` sub-service and
//      getting only the parent's own components is a wrong answer, not a
//      narrow one.
//   2. AN UNKNOWN ID IS A 404, NOT AN EMPTY LIST. Silently returning zero rows
//      for a typo'd serviceId is how someone concludes a service has no
//      components.
//   3. NO SCOPE ⇒ EVERYTHING, UNCHANGED. `scopeComponents(items, scope)` on an
//      inactive scope returns the SAME ARRAY REFERENCE it was given, so a
//      workspace with no environments and no services is byte-identical to how
//      it behaved before any of this existed.
//
// Nothing here writes. Membership writes live in routes/services.js and
// routes/environments.js, which keep `component.serviceId` and
// `service.componentIds` consistent in both directions on every mutation.

import * as store from '../store.js';

// Collections this helper knows how to narrow. Anything not listed is returned
// untouched by `scopeCollection` — a decision log and a contact list are not
// per-service, and inventing a rule for them would drop rows from a package.
export const SCOPED_COLLECTIONS = ['components', 'services', 'gaps', 'tests', 'runbooks', 'checklists', 'documents'];

// `?envId=unassigned` / `?serviceId=unassigned` — "what belongs to nothing yet".
// This is what the UI's "we're not 100% sure what belongs to Acme Pharmacy" flow
// reads before the user ticks boxes.
export const UNASSIGNED = 'unassigned';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const trimmed = (v) => str(v).trim();
const isBlank = (v) => {
  const s = trimmed(v).toLowerCase();
  return !s || s === 'null' || s === 'undefined' || s === 'all' || s === 'any';
};

export function slugify(name, fallback = '') {
  const s = trimmed(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

// ---------------------------------------------------------------- normalizers
//
// Shape is pinned here so environments.js, services.js and workspace.js cannot
// drift from one another (or from the contract) on what an environment IS.

export function normalizeEnvironment(input = {}, existing = null) {
  const base = existing || {};
  const inRegions = input.regions && typeof input.regions === 'object' ? input.regions : null;
  const baseRegions = base.regions && typeof base.regions === 'object' ? base.regions : {};
  const pick = (key, fallback = '') => (input[key] === undefined ? (base[key] ?? fallback) : input[key]);
  const name = trimmed(pick('name')) || trimmed(base.name);
  return {
    id: str(base.id || input.id) || '',
    name,
    slug: slugify(pick('slug') || name, base.slug || ''),
    regions: {
      primary: trimmed(inRegions ? inRegions.primary : baseRegions.primary),
      recovery: trimmed(inRegions ? inRegions.recovery : baseRegions.recovery),
    },
    accountId: trimmed(pick('accountId')),
    awsProfile: trimmed(pick('awsProfile')),
    kubeContext: trimmed(pick('kubeContext')),
    tierDefault: toTier(pick('tierDefault', null)),
    isProduction: !!pick('isProduction', false),
    notes: str(pick('notes')),
    createdAt: str(base.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function toTier(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeService(input = {}, existing = null) {
  const base = existing || {};
  const pick = (key, fallback = '') => (input[key] === undefined ? (base[key] ?? fallback) : input[key]);
  const name = trimmed(pick('name')) || trimmed(base.name);
  const inObj = input.objectives && typeof input.objectives === 'object' ? input.objectives : null;
  const baseObj = base.objectives && typeof base.objectives === 'object' ? base.objectives : {};
  const o = inObj || baseObj;
  return {
    id: str(base.id || input.id) || '',
    name,
    slug: slugify(pick('slug') || name, base.slug || ''),
    envId: trimmed(pick('envId')) || null,
    tier: toTier(pick('tier', null)),
    owner: trimmed(pick('owner')),
    team: trimmed(pick('team')),
    description: str(pick('description')),
    businessImpact: str(pick('businessImpact')),
    objectives: {
      rtoMinutes: toTier(o.rtoMinutes ?? null),
      rpoMinutes: toTier(o.rpoMinutes ?? null),
      approved: !!o.approved,
      source: str(o.source || ''),
    },
    // Membership is rebuilt from `component.serviceId` by services.js on every
    // write; whatever a caller sends here is treated as INTENT, not as truth.
    componentIds: arr(pick('componentIds', [])).map(str).filter(Boolean),
    parentServiceId: trimmed(pick('parentServiceId')) || null,
    notes: str(pick('notes')),
    tags: arr(pick('tags', [])).map(str).filter(Boolean),
    createdAt: str(base.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- readers

// Always an array. A workspace with no `environments` key is single-environment
// — per the contract we never fabricate one.
export function listEnvironments(slug, workspace = null) {
  const ws = workspace || store.getWorkspace(slug);
  return arr(ws.environments).filter((e) => e && typeof e === 'object');
}

export function defaultEnvId(slug, workspace = null) {
  const ws = workspace || store.getWorkspace(slug);
  const envs = listEnvironments(slug, ws);
  const declared = trimmed(ws.defaultEnvId);
  if (declared && envs.some((e) => e.id === declared)) return declared;
  return envs.length ? envs[0].id : null;
}

export function listServices(slug) {
  return arr(store.getCollection(slug, 'services'));
}

// id first, then slug, then case-insensitive name. Accepting a slug is a
// convenience for humans and for URLs (`?envId=prod`); it can never make an
// unknown id resolve, so rule 2 above still holds.
export function findByIdOrSlug(items, needle) {
  const n = trimmed(needle);
  if (!n) return null;
  const lower = n.toLowerCase();
  return arr(items).find((x) => x && str(x.id) === n)
    || arr(items).find((x) => x && str(x.slug) && str(x.slug).toLowerCase() === lower)
    || arr(items).find((x) => x && str(x.name) && str(x.name).toLowerCase() === lower)
    || null;
}

export function getEnvironment(slug, idOrSlug, workspace = null) {
  return findByIdOrSlug(listEnvironments(slug, workspace), idOrSlug);
}

export function getService(slug, idOrSlug, services = null) {
  return findByIdOrSlug(services || listServices(slug), idOrSlug);
}

// ---------------------------------------------------------------- hierarchy

// The service itself PLUS every sub-service beneath it, at any depth.
// Cycle-safe: a `seen` set means a corrupted parent chain degrades to a partial
// answer instead of hanging the request.
export function descendantServiceIds(services, rootId) {
  const out = new Set();
  const root = str(rootId);
  if (!root) return out;
  const children = new Map();
  for (const s of arr(services)) {
    const p = trimmed(s?.parentServiceId);
    if (!p) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(str(s.id));
  }
  const queue = [root];
  out.add(root);
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

// Walking UP: the service, its parent, its parent's parent…
export function ancestorServiceIds(services, id) {
  const byId = new Map(arr(services).map((s) => [str(s.id), s]));
  const out = [];
  const seen = new Set([str(id)]);
  let cur = byId.get(str(id));
  while (cur && trimmed(cur.parentServiceId)) {
    const p = trimmed(cur.parentServiceId);
    if (seen.has(p) || !byId.has(p)) break;
    seen.add(p);
    out.push(p);
    cur = byId.get(p);
  }
  return out;
}

// Would setting `id`'s parent to `parentId` create a loop? (Including making a
// service its own parent, and making it the child of one of its own children.)
export function wouldCycle(services, id, parentId) {
  const target = trimmed(parentId);
  if (!target) return false;
  if (target === str(id)) return true;
  return descendantServiceIds(services, str(id)).has(target);
}

// Nested {…service, children:[…]} for the sidebar. Services whose parent id is
// dangling are surfaced at the top level rather than disappearing.
export function serviceTree(services) {
  const list = arr(services);
  const ids = new Set(list.map((s) => str(s.id)));
  const nodes = new Map(list.map((s) => [str(s.id), { ...s, children: [] }]));
  const roots = [];
  for (const s of list) {
    const node = nodes.get(str(s.id));
    const p = trimmed(s.parentServiceId);
    if (p && ids.has(p) && p !== str(s.id)) nodes.get(p).children.push(node);
    else roots.push(node);
  }
  // A cycle would leave nodes unreachable from any root; surface them instead
  // of losing them.
  const reachable = new Set();
  const walk = (n) => {
    if (reachable.has(n.id)) return;
    reachable.add(n.id);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  for (const s of list) if (!reachable.has(str(s.id))) roots.push(nodes.get(str(s.id)));
  return roots;
}

// ---------------------------------------------------------------- the scope

function scopeError(status, message, field, value, available) {
  return {
    status,
    message,
    field,
    value: str(value),
    available: arr(available).map((x) => ({ id: str(x.id), name: str(x.name), slug: str(x.slug) })),
  };
}

function emptyScope(slug, query) {
  return {
    ok: true,
    active: false,
    slug: str(slug),
    query: { envId: null, serviceId: null, ...query },
    envId: null, envName: '', env: null, envInherited: false,
    serviceId: null, serviceName: '', service: null,
    serviceIds: [],
    componentIds: new Set(),
    componentCount: 0,
    totalComponents: 0,
    warnings: [],
    error: null,
  };
}

/**
 * Resolve `?envId=` / `?serviceId=` into everything a read endpoint needs.
 *
 *   resolveScope('example-acme', { envId: 'env_prod', serviceId: 'svc_adj' })
 *
 * `envId`/`serviceId` accept an id, a slug or a name; blank / 'all' / 'any' /
 * 'null' mean "not scoped"; the literal 'unassigned' means "components with no
 * environment / no service", which is what the bulk-assign UI reads.
 *
 * Never throws for a bad id — returns `{ ok:false, error:{status,message,…} }`
 * so the caller decides. `resolveScopeOrThrow` is the throwing variant.
 *
 * @returns {{ok:boolean, active:boolean, envId:?string, envName:string, env:?object,
 *            serviceId:?string, serviceName:string, service:?object, serviceIds:string[],
 *            componentIds:Set<string>, componentCount:number, totalComponents:number,
 *            warnings:string[], error:?{status:number,message:string,field:string,value:string,available:object[]}}}
 */
export function resolveScope(slug, query = {}, opts = {}) {
  const wanted = scopeFromQuery(query);
  const scope = emptyScope(slug, wanted);

  let workspace;
  let components;
  let services;
  try {
    workspace = opts.workspace || store.getWorkspace(slug);
    components = arr(opts.components || store.getCollection(slug, 'components'));
    services = arr(opts.services || store.getCollection(slug, 'services'));
  } catch (e) {
    scope.ok = false;
    scope.error = scopeError(e.status || 500, e.message, 'workspace', slug, []);
    return scope;
  }

  scope.totalComponents = components.length;
  scope.componentIds = new Set(components.map((c) => str(c.id)));
  scope.componentCount = components.length;

  const envs = listEnvironments(slug, workspace);

  // --- environment --------------------------------------------------------
  if (wanted.envId === UNASSIGNED) {
    scope.active = true;
    scope.envId = UNASSIGNED;
    scope.envName = 'unassigned';
  } else if (wanted.envId) {
    const env = findByIdOrSlug(envs, wanted.envId);
    if (!env) {
      scope.ok = false;
      scope.error = scopeError(404,
        envs.length
          ? `no environment '${wanted.envId}' in workspace '${slug}' — known environments: ${envs.map((e) => e.id).join(', ')}`
          : `no environment '${wanted.envId}': workspace '${slug}' has no environments defined, so it is single-environment`,
        'envId', wanted.envId, envs);
      return scope;
    }
    scope.active = true;
    scope.env = env;
    scope.envId = str(env.id);
    scope.envName = str(env.name) || str(env.id);
  }

  // --- service (and its sub-services) --------------------------------------
  if (wanted.serviceId === UNASSIGNED) {
    scope.active = true;
    scope.serviceId = UNASSIGNED;
    scope.serviceName = 'unassigned';
  } else if (wanted.serviceId) {
    const svc = findByIdOrSlug(services, wanted.serviceId);
    if (!svc) {
      scope.ok = false;
      scope.error = scopeError(404,
        services.length
          ? `no service '${wanted.serviceId}' in workspace '${slug}' — known services: ${services.map((s) => s.id).join(', ')}`
          : `no service '${wanted.serviceId}': workspace '${slug}' has no services defined yet`,
        'serviceId', wanted.serviceId, services);
      return scope;
    }
    scope.active = true;
    scope.service = svc;
    scope.serviceId = str(svc.id);
    scope.serviceName = str(svc.name) || str(svc.id);
    // RULE 1: a service scope is the service AND its sub-services.
    scope.serviceIds = [...descendantServiceIds(services, scope.serviceId)];
    if (scope.envId && scope.envId !== UNASSIGNED && trimmed(svc.envId) && trimmed(svc.envId) !== scope.envId) {
      scope.warnings.push(
        `service '${scope.serviceName}' records envId '${svc.envId}', which is not the requested environment '${scope.envId}' — the result is the intersection and may legitimately be empty`,
      );
    } else if (!wanted.envId && trimmed(svc.envId)) {
      // RULE 4 (audit H4): A SERVICE LIVES IN AN ENVIRONMENT, AND AN ENVIRONMENT
      // IS ITS OWN REGION PAIR (contract §2). The service's own `envId` was read
      // here only to warn about a mismatch and never adopted, so a package for a
      // service in the APAC environment printed the WORKSPACE default region
      // pair — `eu-west-1 → eu-central-1` on a brief whose operator has to fail
      // over ap-southeast-2 → ap-southeast-1. Adopted only when the caller named
      // no environment of their own; naming a different one still warns above
      // and still wins.
      const own = findByIdOrSlug(envs, svc.envId);
      if (own) {
        scope.env = own;
        scope.envId = str(own.id);
        scope.envName = str(own.name) || str(own.id);
        // The caller asked for a SERVICE. The environment came with it, so it
        // names the region pair and the labels — it must not also become a
        // second filter that silently drops a component of this very service
        // because someone typed the wrong envId on it. Those are reported.
        scope.envInherited = true;
      }
    }
  }

  if (!scope.active) return scope; // RULE 3: no scope ⇒ everything, unchanged.

  const serviceSet = scope.serviceIds.length ? new Set(scope.serviceIds) : null;
  const keep = new Set();
  // An INHERITED environment labels the scope; it never narrows it (see above).
  const envFilter = scope.envInherited ? null : scope.envId;
  for (const c of components) {
    if (!matchesEnv(c, envFilter)) continue;
    if (!matchesService(c, scope.serviceId, serviceSet)) continue;
    keep.add(str(c.id));
  }
  scope.componentIds = keep;
  scope.componentCount = keep.size;

  // Adopting the service's environment must not hide a disagreement: a member
  // component recorded in a DIFFERENT environment is a data-quality fact the
  // package has to carry, not something to quietly filter away.
  if (scope.envInherited) {
    const strays = [...keep]
      .map((id) => components.find((c) => str(c.id) === id))
      .filter((c) => c && trimmed(c.envId) && trimmed(c.envId) !== scope.envId);
    if (strays.length) {
      scope.warnings.push(
        `service '${scope.serviceName}' records envId '${scope.envId}' (${scope.envName}), but `
        + `${strays.length} of its component${strays.length === 1 ? '' : 's'} `
        + `(${strays.slice(0, 3).map((c) => str(c.name) || str(c.id)).join(', ')}${strays.length > 3 ? `, +${strays.length - 3} more` : ''}) `
        + 'belong to another environment. They are kept — this scope is the service — but the environment label and '
        + 'the region pair on this package come from the service, and do not describe them.',
      );
    }
  }

  if (!keep.size && components.length) {
    scope.warnings.push(
      `no component in '${slug}' matches this scope yet — nothing auto-assigns, so components stay unassigned until someone assigns them`,
    );
  }
  return scope;
}

function matchesEnv(component, envId) {
  if (!envId) return true;
  const own = trimmed(component?.envId);
  return envId === UNASSIGNED ? !own : own === envId;
}

function matchesService(component, serviceId, serviceSet) {
  if (!serviceId) return true;
  const own = trimmed(component?.serviceId);
  if (serviceId === UNASSIGNED) return !own;
  return !!own && serviceSet.has(own);
}

/** Same as `resolveScope`, but throws a `store.httpError` on an unknown id. */
export function resolveScopeOrThrow(slug, query = {}, opts = {}) {
  const scope = resolveScope(slug, query, opts);
  if (!scope.ok) throw store.httpError(scope.error.status, scope.error.message);
  return scope;
}

/** Pull `{envId, serviceId}` out of an Express `req.query` (or a plain object). */
export function scopeFromQuery(query = {}) {
  const q = query || {};
  const read = (...keys) => {
    for (const k of keys) {
      const v = Array.isArray(q[k]) ? q[k][0] : q[k];
      if (!isBlank(v)) return trimmed(v);
    }
    return null;
  };
  const envId = read('envId', 'env', 'environmentId', 'environment');
  const serviceId = read('serviceId', 'service', 'svcId');
  return {
    envId: envId && envId.toLowerCase() === UNASSIGNED ? UNASSIGNED : envId,
    serviceId: serviceId && serviceId.toLowerCase() === UNASSIGNED ? UNASSIGNED : serviceId,
  };
}

// ---------------------------------------------------------------- filtering

/**
 * Narrow a component list to the scope. An INACTIVE scope returns the SAME
 * ARRAY REFERENCE — that is the guarantee that an unscoped request is
 * byte-identical to the behaviour before environments existed.
 */
export function scopeComponents(components, scope) {
  if (!scope || !scope.active || !scope.ok) return components;
  const ids = scope.componentIds;
  return arr(components).filter((c) => ids.has(str(c?.id)));
}

// Every component id an item points at, wherever it is nested (`componentId`,
// `componentIds`, `steps[].componentIds`, `appTests[].componentId`, …). A
// generic walk rather than a per-collection schema, because the collections
// disagree with one another and new link fields keep appearing.
export function componentRefs(item, depth = 0) {
  const out = new Set();
  if (!item || typeof item !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(item)) {
    if (k === 'componentId' && typeof v === 'string' && v) out.add(v);
    else if (k === 'componentIds') for (const id of arr(v)) { if (str(id)) out.add(str(id)); }
    else if (v && typeof v === 'object') for (const id of componentRefs(v, depth + 1)) out.add(id);
  }
  return out;
}

/**
 * Narrow any collection to the scope.
 *
 *   components  — by `envId` / `serviceId` (via `scopeComponents`)
 *   services    — the scoped service and its sub-services, and/or the environment
 *   documents   — by `appliesTo.{envId,serviceId}`
 *   gaps, tests, runbooks, checklists — by the components they LINK TO
 *   anything else (decisions, contacts, …) — returned unchanged
 *
 * An item that links to NO component at all is KEPT: a workspace-wide runbook
 * or checklist applies to every service, and silently dropping it from a scoped
 * DR package would lose the procedure someone is meant to follow. Pass
 * `{ unlinked: 'drop' }` for the strict reading. Use `scopeCollectionDetailed`
 * when you need to tell the user what was dropped and why.
 *
 * PASS `components` (the workspace-wide list) WHENEVER YOU HAVE IT. It is what
 * lets this tell a DANGLING link from an out-of-scope one: with the list, an
 * item whose only links are to ids that no longer exist counts as unlinked and
 * is kept; without it, those ids are indistinguishable from real out-of-scope
 * components and the item is dropped. A stale id is a data-quality problem, not
 * a reason to delete a runbook from someone's recovery package.
 */
export function scopeCollection(name, items, scope, components = null, options = {}) {
  return scopeCollectionDetailed(name, items, scope, components, options).items;
}

export function scopeCollectionDetailed(name, items, scope, components = null, options = {}) {
  const list = arr(items);
  const none = { items, kept: list.length, dropped: 0, unlinked: 0, rule: 'unscoped' };
  if (!scope || !scope.active || !scope.ok) return none;

  const keepUnlinked = str(options.unlinked || 'keep') !== 'drop';

  if (name === 'components') {
    const out = scopeComponents(list, scope);
    return { items: out, kept: out.length, dropped: list.length - out.length, unlinked: 0, rule: 'component envId/serviceId' };
  }

  if (name === 'services') {
    const set = scope.serviceIds.length ? new Set(scope.serviceIds) : null;
    const out = list.filter((s) => {
      if (set && !set.has(str(s?.id))) return false;
      if (scope.serviceId === UNASSIGNED && trimmed(s?.parentServiceId)) return false;
      if (scope.envId === UNASSIGNED) return !trimmed(s?.envId);
      if (scope.envId && trimmed(s?.envId) && trimmed(s.envId) !== scope.envId) return false;
      return true;
    });
    return { items: out, kept: out.length, dropped: list.length - out.length, unlinked: 0, rule: 'service hierarchy + envId' };
  }

  if (name === 'documents') {
    const set = scope.serviceIds.length ? new Set(scope.serviceIds) : null;
    let unlinked = 0;
    const out = list.filter((d) => {
      const a = (d && typeof d.appliesTo === 'object' && d.appliesTo) || {};
      const e = trimmed(a.envId);
      const s = trimmed(a.serviceId);
      if (!e && !s) { unlinked += 1; return keepUnlinked; }
      if (scope.envId === UNASSIGNED && e) return false;
      if (scope.envId && scope.envId !== UNASSIGNED && e && e !== scope.envId) return false;
      if (scope.serviceId === UNASSIGNED && s) return false;
      if (set && s && !set.has(s)) return false;
      return true;
    });
    return { items: out, kept: out.length, dropped: list.length - out.length, unlinked, rule: 'document appliesTo' };
  }

  if (!['gaps', 'tests', 'runbooks', 'checklists'].includes(name) && !options.force) return none;

  // Link-based: an item is in scope if ANY component it names is in scope.
  // `components` is accepted so a caller can resolve links through a
  // workspace-wide component list; the scope's own id set is what decides.
  const ids = scope.componentIds;
  const known = components ? new Set(arr(components).map((c) => str(c?.id))) : null;
  let unlinked = 0;
  const out = list.filter((item) => {
    const refs = [...componentRefs(item)];
    // A link to an id that does not exist is not a link to anything — treat an
    // item whose only references are dangling as unlinked rather than as
    // out-of-scope, so a stale id cannot delete a runbook from a package.
    const real = known ? refs.filter((id) => known.has(id)) : refs;
    if (!real.length) { unlinked += 1; return keepUnlinked; }
    return real.some((id) => ids.has(id));
  });
  return {
    items: out,
    kept: out.length,
    dropped: list.length - out.length,
    unlinked,
    rule: `component links (${keepUnlinked ? 'unlinked items kept' : 'unlinked items dropped'})`,
  };
}

// ---------------------------------------------------------------- reporting

/** The `scope:` block the contract (§3) requires on every scoped response. */
export function scopeMeta(scope) {
  if (!scope || !scope.active || !scope.ok) return null;
  return {
    envId: scope.envId,
    envName: scope.envName,
    // True when the environment came from the SERVICE rather than the caller:
    // it names the region pair and the labels, and narrows nothing.
    ...(scope.envInherited ? { envInherited: true } : {}),
    serviceId: scope.serviceId,
    serviceName: scope.serviceName,
    componentCount: scope.componentCount,
    ...(scope.serviceIds.length > 1 ? { subServiceIds: scope.serviceIds.filter((id) => id !== scope.serviceId) } : {}),
    ...(scope.warnings.length ? { warnings: scope.warnings } : {}),
  };
}

/** One human sentence saying exactly what was scoped to. Never empty. */
export function describeScope(scope) {
  if (!scope) return 'The whole workspace.';
  if (!scope.ok) return scope.error ? scope.error.message : 'Unresolvable scope.';
  if (!scope.active) return `The whole workspace — all ${scope.totalComponents} component${scope.totalComponents === 1 ? '' : 's'}.`;

  const parts = [];
  if (scope.serviceId === UNASSIGNED) parts.push('components not assigned to any service');
  else if (scope.serviceId) {
    const subs = scope.serviceIds.length - 1;
    parts.push(`${scope.serviceName}${subs > 0 ? ` and its ${subs} sub-service${subs === 1 ? '' : 's'}` : ''}`);
  }
  if (scope.envId === UNASSIGNED) parts.push('components not assigned to any environment');
  else if (scope.envId) parts.push(`the ${scope.envName} environment`);

  const of = `${scope.componentCount} of ${scope.totalComponents} component${scope.totalComponents === 1 ? '' : 's'}`;
  const head = parts.length === 2 ? `${parts[0]}, in ${parts[1]}` : parts[0];
  const tail = scope.componentCount === 0
    ? ` — ${of}: nothing is assigned to this scope yet, so this is empty because of missing assignment, not because nothing exists.`
    : ` — ${of}.`;
  return `Scoped to ${head}${tail}`;
}
