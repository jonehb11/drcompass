// Network / firewall flow import routes.
//
// The browser parses the CSV/TSV locally and posts only the parsed cells —
// the raw export file is never uploaded anywhere, and these rows go no further
// than this local server (they are analyzed in memory and never written to
// disk; only the confirmed assignments are persisted).
//
// Flows belong to an environment: prod's firewall log describes prod's
// components and prod's cluster. With `envId` the suggestions are drawn from
// that environment's components and its own Kubernetes snapshot, and an
// assignment that names a component in a different environment is refused
// rather than quietly writing a prod call onto a dev component. Without
// `envId` everything behaves exactly as it did.
import { Router } from 'express';
import * as store from '../store.js';
import {
  detectColumns, resolveMapping, aggregate, suggestSources, applyFlows,
  MAX_ROWS, MAX_COLUMNS, MAX_FLOWS, FLOW_ROLES,
} from '../lib/network-flows.js';
import { resolveDiscoveryEnv, envScope } from './discover.js';
import { readSnapshot } from './k8s.js';
// §3 lists /network/* as a scoped read endpoint. This route already honoured
// `envId` — but only out of the request BODY, so `?envId=` on the URL (which is
// what web/js/app.js's scopedApi appends to every read) was silently ignored,
// and `serviceId` was ignored entirely. The service half of the narrowing is
// resolved by the shared helper, not by a second rule written here.
import { resolveScopeOrThrow, scopeComponents } from '../lib/scope.js';

const r = Router();

// One place that answers "which components do these flows belong to, and what
// is this request scoped to". `envId` keeps going through resolveDiscoveryEnv
// because the discovery scope also carries the profile / region / kubeContext a
// scan needs; `serviceId` goes through lib/scope.js. Either may come from the
// body (the UI posts it) or the query string (scopedApi appends it); the body
// wins, which is the precedence every other route here already uses.
function flowScope(ws, body, query) {
  const pick = (key) => {
    const b = body?.[key];
    const q = Array.isArray(query?.[key]) ? query[key][0] : query?.[key];
    return String((b ?? '') || (q ?? '') || '').trim();
  };
  const envInfo = resolveDiscoveryEnv(ws, pick('envId')); // 404 on an unknown id
  const serviceId = pick('serviceId');
  const all = store.getCollection(ws, 'components');
  // Env first (that is what the snapshot and the refusal in /apply key on),
  // then the service narrowing on top of it.
  const byEnv = envInfo ? all.filter((c) => String(c?.envId || '') === envInfo.id) : all;
  if (!serviceId) return { envInfo, serviceScope: null, all, components: byEnv };
  const serviceScope = resolveScopeOrThrow(ws, { serviceId }, { components: all }); // 404 on an unknown id
  return { envInfo, serviceScope, all, components: scopeComponents(byEnv, serviceScope) };
}

// The `scope:` block §3 requires, or null when nothing was scoped.
function flowScopeMeta({ envInfo, serviceScope, components }) {
  if (!envInfo && !serviceScope) return null;
  return {
    ...(envInfo ? envScope(envInfo) : {}),
    ...(serviceScope ? {
      serviceId: serviceScope.serviceId,
      serviceName: serviceScope.serviceName,
      ...(serviceScope.serviceIds.length > 1
        ? { subServiceIds: serviceScope.serviceIds.filter((id) => id !== serviceScope.serviceId) } : {}),
      ...(serviceScope.warnings.length ? { warnings: serviceScope.warnings } : {}),
    } : {}),
    componentCount: components.length,
    ...(components.length ? {} : {
      why: 'No component matches this scope, so nothing in this import can be assigned yet. That is a missing '
        + 'assignment, not an empty environment — assign components to it first.',
    }),
  };
}

const MAX_CELL = 512;
const MAX_ASSIGNMENTS = 20000;

// Rows arrive as string cells; numbers/nulls are tolerated and coerced.
function validateGrid(body) {
  const headers = body?.headers;
  const rows = body?.rows;
  if (!Array.isArray(headers) || !headers.length) throw store.httpError(400, 'headers must be a non-empty array');
  if (headers.length > MAX_COLUMNS) throw store.httpError(400, `too many columns: ${headers.length} (max ${MAX_COLUMNS})`);
  if (!Array.isArray(rows)) throw store.httpError(400, 'rows must be an array');
  if (rows.length > MAX_ROWS) throw store.httpError(400, `too many rows: ${rows.length} (max ${MAX_ROWS})`);

  const cleanHeaders = headers.map((hd) => {
    if (hd !== null && hd !== undefined && typeof hd === 'object') throw store.httpError(400, 'headers must be strings');
    return String(hd ?? '').slice(0, MAX_CELL);
  });
  const cleanRows = rows.map((row, i) => {
    if (!Array.isArray(row)) throw store.httpError(400, `row ${i} is not an array`);
    if (row.length > MAX_COLUMNS) throw store.httpError(400, `row ${i} has ${row.length} columns (max ${MAX_COLUMNS})`);
    return row.map((cell) => {
      if (cell !== null && cell !== undefined && typeof cell === 'object') {
        throw store.httpError(400, `row ${i} contains a non-scalar cell`);
      }
      return String(cell ?? '').slice(0, MAX_CELL);
    });
  });
  return { headers: cleanHeaders, rows: cleanRows };
}

function hasMapping(m) {
  return !!m && typeof m === 'object' && FLOW_ROLES.some((role) => m[role] !== null && m[role] !== undefined && m[role] !== '');
}

// POST /w/:ws/network/flows/analyze {headers, rows, mapping?}
//   -> {mapping, detected, confidence, roleConfidence, headers, flows,
//       sourceSuggestions, stats, truncated}
// Without `mapping` the columns are auto-detected; with one (indices or header
// names) that mapping is used verbatim so the user can correct a bad guess.
r.post('/w/:ws/network/flows/analyze', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const scoped = flowScope(ws, req.body, req.query);
    const { envInfo } = scoped;
    const { headers, rows } = validateGrid(req.body);

    const detection = detectColumns(headers, rows.slice(0, 200));
    const manual = hasMapping(req.body?.mapping);
    const mapping = manual ? resolveMapping(req.body.mapping, headers) : detection.mapping;
    if (mapping.source === null && mapping.destination === null) {
      // Not an error — the UI shows the mapping card so the user can pick.
      return res.json({
        mapping, detected: detection.mapping, confidence: 0,
        roleConfidence: detection.roleConfidence, headers,
        flows: [], sourceSuggestions: [], truncated: false,
        stats: { rowsRead: 0, rowsSkipped: rows.length, totalFlows: 0, totalCount: 0, rowsDropped: 0 },
        warning: 'Could not tell which columns hold the source and destination — pick them below.',
      });
    }

    const agg = aggregate(rows, mapping, { maxRows: MAX_ROWS, maxFlows: MAX_FLOWS });
    const { components } = scoped;
    // This environment's cluster snapshot — not "the" snapshot.
    const k8s = (envInfo ? readSnapshot(ws, envInfo.id) : readSnapshot(ws)) || null;
    // Pass the resource graph so a private IP can be matched to the subnet
    // that holds it, instead of asking the user something we already know.
    const sourceSuggestions = suggestSources(agg.flows, components, k8s,
      { graph: store.getObject(req.params.ws, 'resource-graph') });

    res.json({
      mapping,
      detected: detection.mapping,
      confidence: manual ? 1 : detection.confidence,
      roleConfidence: detection.roleConfidence,
      headers,
      flows: agg.flows,
      sourceSuggestions,
      truncated: agg.truncated,
      stats: {
        rowsRead: agg.rowsRead, rowsSkipped: agg.rowsSkipped, rowsDropped: agg.rowsDropped,
        totalFlows: agg.totalFlows, returnedFlows: agg.flows.length,
        totalCount: agg.totalCount, uniqueSources: sourceSuggestions.length,
        maxFlows: MAX_FLOWS,
      },
      k8sWorkloads: Array.isArray(k8s?.workloads) ? k8s.workloads.length : 0,
      // Unscoped: absent, exactly as before.
      ...(flowScopeMeta(scoped) ? { scope: flowScopeMeta(scoped) } : {}),
    });
  } catch (e) { next(e); }
});

// POST /w/:ws/network/flows/apply {assignments}
//   assignments: [{componentId, target, type, protocol, port, purpose,
//                  critical, observedCount?, workload?}]
//   -> {componentsUpdated, callsAdded, graphNodesAdded, graphEdgesAdded, skipped}
r.post('/w/:ws/network/flows/apply', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const assignments = req.body?.assignments;
    if (!Array.isArray(assignments) || !assignments.length) {
      throw store.httpError(400, 'assignments must be a non-empty array');
    }
    if (assignments.length > MAX_ASSIGNMENTS) {
      throw store.httpError(400, `too many assignments: ${assignments.length} (max ${MAX_ASSIGNMENTS})`);
    }
    const scoped = flowScope(ws, req.body, req.query);
    const { envInfo, serviceScope } = scoped;
    const comps = scoped.all;
    const ids = new Set(comps.map((c) => c.id));
    const envOf = new Map(comps.map((c) => [c.id, String(c?.envId || '')]));
    // A service scope refuses the same way the environment one does: flows
    // imported for adjudication must not be written onto remittance's
    // components just because the operator had the wrong row selected.
    const inService = serviceScope ? new Set(scopeComponents(comps, serviceScope).map((c) => c.id)) : null;
    for (const [i, a] of assignments.entries()) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw store.httpError(400, `assignment ${i} is not an object`);
      const cid = String(a.componentId || '');
      if (!cid) throw store.httpError(400, `assignment ${i}: componentId is required`);
      if (!ids.has(cid)) throw store.httpError(400, `assignment ${i}: no such component '${cid}'`);
      if (envInfo && envOf.get(cid) !== envInfo.id) {
        throw store.httpError(400,
          `assignment ${i}: component '${cid}' is not in the ${envInfo.name} environment — these flows were imported for ${envInfo.name}, and a call observed there does not belong on another environment's component`);
      }
      if (inService && !inService.has(cid)) {
        throw store.httpError(400,
          `assignment ${i}: component '${cid}' is not in the ${serviceScope.serviceName} service — these flows were imported for ${serviceScope.serviceName}, and a call observed there does not belong on another service's component`);
      }
      if (typeof a.target !== 'string' || !a.target.trim()) {
        throw store.httpError(400, `assignment ${i}: target must be a non-empty string`);
      }
      if (a.target.length > 300) throw store.httpError(400, `assignment ${i}: target too long (max 300 chars)`);
      if (a.purpose !== undefined && typeof a.purpose !== 'string') {
        throw store.httpError(400, `assignment ${i}: purpose must be a string`);
      }
      if (a.purpose && a.purpose.length > 300) throw store.httpError(400, `assignment ${i}: purpose too long (max 300 chars)`);
    }
    const out = applyFlows({ slug: ws, assignments });
    const meta = flowScopeMeta(scoped);
    res.json(meta ? { ...out, scope: meta } : out);
  } catch (e) { next(e); }
});

export default r;
