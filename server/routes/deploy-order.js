// Deployment / recovery ORDER API.
//
//   GET  /w/:ws/deploy-order[?componentId=cmp_x]   the wave plan
//   GET  /w/:ws/deploy-order/explain/:id           why ONE item sits where it does
//   POST /w/:ws/deploy-order/ai-assist             AI suggestions for the ambiguous bits
//   POST /w/:ws/deploy-order/to-runbook            a runbook DRAFT (returned, never written)
//
// All read-only. Every ordering decision comes from server/lib/deploy-order.js,
// which is pure — this file only loads the workspace, stamps `generatedAt`, and
// shapes errors.
import { Router } from 'express';
import * as store from '../store.js';
import {
  deployOrder, computeDeployOrder, explainItem, toRunbookDraft, ambiguousSubgraph,
} from '../lib/deploy-order.js';
// Environment / service scoping — docs/ENV-SERVICE-MODEL.md §3, §7.
import {
  scopeFromQuery, resolveScopeOrThrow, scopeComponents, scopeMeta, describeScope,
} from '../lib/scope.js';

const r = Router();

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
// `?componentIds=a,b,c`, `?componentIds=a&componentIds=b`, or a JSON array.
const idList = (v) => {
  const raw = Array.isArray(v) ? v : String(v === null || v === undefined ? '' : v).split(',');
  return [...new Set(raw.map((s) => str(s).trim()).filter(Boolean))];
};

// ids contain '/' and ':' (res:s3/bucket, k8s:ns/Deployment/name). Express
// decodes a single path segment for us, so an encodeURIComponent-ed id arrives
// intact; `?id=` is offered as well for callers that would rather not encode.
function wantedId(req) {
  const fromPath = str(req.params.id);
  if (fromPath) return fromPath;
  return str(req.query.id);
}

// Two scopes meet in this file and they are different things:
//
//   `?componentId=`          — ONE service's dependency closure. The engine's
//                              own scope; it is what `inputs.scope` reports.
//   `?componentIds=a,b,c`    — the same engine scope over a SET. The plan is the
//                              UNION of the closures with waves recomputed over
//                              it, and `inputs.scope` says how many were asked
//                              for, how many the closure came to, and which
//                              components are there only because the scoped set
//                              waits on them. Never the first id's closure.
//   `?envId=` / `?serviceId=` — the §3 environment/service scope. It decides
//                              WHICH INVENTORY the whole plan is built from,
//                              and is reported as the response's `scope` block.
//
// With neither env nor service asked for, this takes exactly the old code path
// (`deployOrder`), so an unscoped plan is byte-identical to what it was.
function envScopedInputs(slug, scope) {
  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const components = read(() => store.getCollection(slug, 'components'), []);
  const kept = scopeComponents(components, scope);
  const keptIds = new Set(kept.map((c) => str(c?.id)));
  const graph = read(() => store.getObject(slug, 'resource-graph'), {}) || {};
  const k8s = read(() => store.getObject(slug, 'k8s'), {}) || {};
  // A discovered resource or a workload that names ONLY out-of-scope components
  // belongs to another environment's estate. One that names none is shared or
  // not yet attributed, and is kept — dropping it would silently remove a
  // prerequisite from a recovery plan over a missing field (§7's rule for
  // unlinked items).
  const linkedOut = (ids) => {
    const list = arr(ids).map(str).filter(Boolean);
    return list.length > 0 && !list.some((id) => keptIds.has(id));
  };
  const nodes = graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : null;
  let scopedGraph = graph;
  if (nodes) {
    const out = {};
    for (const [rid, n] of Object.entries(nodes)) if (!linkedOut(n?.componentIds)) out[rid] = n;
    const dead = (v) => (!!nodes[v] && !out[v]) || (v.startsWith('cmp_') && !keptIds.has(v));
    scopedGraph = {
      ...graph,
      nodes: out,
      edges: arr(graph.edges).filter((e) => e && !dead(str(e.from)) && !dead(str(e.to))),
    };
  }
  const scopedK8s = Array.isArray(k8s.workloads)
    ? { ...k8s, workloads: k8s.workloads.filter((w) => !linkedOut(w?.componentId ? [w.componentId] : [])) }
    : k8s;
  return {
    components: kept,
    runbooks: read(() => store.getCollection(slug, 'runbooks'), []),
    graph: scopedGraph,
    k8s: scopedK8s,
  };
}

async function load(req) {
  const slug = req.params.ws;
  store.getWorkspace(slug); // 404s on an unknown workspace
  const componentId = str(req.query.componentId || req.body?.componentId);
  // A SET, as `?componentIds=a,b,c` or a JSON array in the body. `componentId`
  // still wins when both are given, so no existing caller changes shape.
  const componentIds = idList(req.query.componentIds ?? req.body?.componentIds);
  const wanted = scopeFromQuery({ ...(req.body && typeof req.body === 'object' ? req.body : {}), ...req.query });
  if (!wanted.envId && !wanted.serviceId) {
    return {
      slug,
      result: await deployOrder(slug, { componentId, componentIds }),
      scope: null,
      scopeBlock: null,
    };
  }
  // Unknown envId/serviceId ⇒ 404 naming the known ones, never a silently empty
  // plan — an empty recovery order is the most dangerous empty list here.
  const scope = resolveScopeOrThrow(slug, wanted, { components: store.getCollection(slug, 'components') });
  const result = computeDeployOrder({
    ...envScopedInputs(slug, scope),
    // The §3 scope has already chosen the inventory; `componentId`/`componentIds`
    // narrow further, within it, to a closure.
    scope: componentId || (componentIds.length ? { componentIds } : null),
    options: {},
  });
  const meta = scopeMeta(scope);
  return {
    slug,
    result,
    scope,
    scopeBlock: meta && { ...meta, description: describeScope(scope) },
  };
}

r.get('/w/:ws/deploy-order', async (req, res, next) => {
  try {
    const { result, scopeBlock } = await load(req);
    res.json({ ...result, ...(scopeBlock ? { scope: scopeBlock } : {}), generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

const explain = async (req, res, next) => {
  try {
    const id = wantedId(req);
    if (!id) throw store.httpError(400, 'pass the item id in the path (URL-encoded) or as ?id=');
    const { result, scopeBlock } = await load(req);
    const out = explainItem(result, id);
    if (!out) {
      throw store.httpError(404, `no item "${id}" in this deployment order${scopeBlock ? ` — the order was scoped to ${scopeBlock.description}` : ''}. Item ids are cmp_* for components, res:<rid> for discovered resources, k8s:<ns>/<Kind>/<name> for Kubernetes objects, ext:<slug> for external preconditions.`);
    }
    res.json({
      ...out,
      // `scope` here has meant the component-closure scope since this endpoint
      // existed and the page reads it, so the §3 environment/service block is
      // additive and named for what it is rather than taking that key over.
      ...(scopeBlock ? { envScope: scopeBlock } : {}),
      scope: result.inputs.scope,
      stats: { waveCount: result.stats.waveCount, itemCount: result.stats.itemCount },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
};
r.get('/w/:ws/deploy-order/explain/:id', explain);
r.get('/w/:ws/deploy-order/explain', explain);

r.post('/w/:ws/deploy-order/to-runbook', async (req, res, next) => {
  try {
    const { slug, result, scopeBlock } = await load(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const workspace = store.getWorkspace(slug);
    const runbook = toRunbookDraft(result, {
      workspace,
      name: body.name, tooling: body.tooling, scenario: body.scenario, audience: body.audience,
    });
    // Counts a reader can check the draft against before trusting it. Every step
    // now carries a derived verification command and a concrete pass criterion,
    // so the useful question is no longer "how many are blank" (none are) but
    // "how much of this still needs something from me" — which is what
    // `stepsNeedingInput` and `stepsWithoutOwner` answer honestly.
    const needsInput = runbook.steps.filter((s) => /\bSUPPLY\b/.test(String(s.verify || '')));
    res.json({
      runbook,
      draft: true,
      ...(scopeBlock ? { scope: scopeBlock } : {}),
      stats: {
        steps: runbook.steps.length,
        gates: runbook.steps.filter((s) => s.gate).length,
        waves: result.stats.waveCount,
        preconditions: runbook.preconditions.length,
        stepsWithoutVerifyCommand: runbook.steps.filter((s) => !String(s.verify || '').trim()).length,
        stepsNeedingInput: needsInput.length,
        stepsWithoutOwner: runbook.steps.filter((s) => !String(s.owner || '').trim() || s.owner === 'unassigned').length,
        stepsWithoutEstimate: runbook.steps.filter((s) => s.estMinutes === null).length,
        estMinutes: runbook.steps.reduce((n, s) => n + (Number(s.estMinutes) || 0), 0) || null,
      },
      note: 'This is a DRAFT for review — nothing was written. POST it to /api/w/:ws/c/runbooks unchanged to keep it. '
        + 'Every step carries a derived VERIFICATION command and a pass criterion; none carries a create/restore command, '
        + 'because that depends on your tooling and the engine will not invent one — each step says exactly what you must supply.',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

r.post('/w/:ws/deploy-order/ai-assist', async (req, res, next) => {
  try {
    const { slug, result } = await load(req);
    const subgraph = ambiguousSubgraph(result, { limit: 60 });
    if (subgraph.empty) {
      res.json({
        ok: true, suggestions: [],
        message: 'Nothing ambiguous to ask about: no cycles, nothing unordered, and every resolvable start-up call is already ordered correctly.',
        subgraph: { nodes: 0, edges: 0 },
      });
      return;
    }
    let bridge;
    try {
      bridge = await import('../lib/ai-bridge.js');
    } catch (e) {
      throw store.httpError(501, `AI bridge unavailable: ${e.message}`);
    }
    if (typeof bridge.suggestOrdering !== 'function') {
      throw store.httpError(501, 'the AI bridge in this build has no suggestOrdering() — update server/lib/ai-bridge.js');
    }
    const out = await bridge.suggestOrdering({ slug, subgraph });
    res.json({
      ...out,
      subgraph: {
        nodes: subgraph.nodes.length, edges: subgraph.edges.length,
        cycles: subgraph.cycles.length, unordered: subgraph.unordered.length,
      },
      note: 'Suggestions only — nothing was applied. Each one names the edge it would add or remove so you can judge it yourself.',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

export default r;
