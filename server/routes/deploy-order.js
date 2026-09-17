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
  scopedInventory,
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
//
// A SCOPE CARRIES ITS DEPENDENCY CLOSURE. `scopeComponents` alone hands the
// engine an inventory with holes in it: prod's EKS cluster still declares a
// dependency on the shared ECR registry, but the registry is assigned to no
// environment, so it is not in the narrowed list — and the engine, behaving
// correctly on the input it was given, reports that the registry "no longer
// exists. It was renamed or deleted". It was not. It was filtered out here, and
// the resulting plan never restores the thing every pod pulls its image from.
//
// So the inventory the engine is given is the scoped set PLUS its transitive
// `dependsOn` closure — the identical rule, from the identical function, that
// server/lib/export-scope.js applies to the workbook and the brief
// (`componentDependencyClosure`). A component pulled in this way is NOT
// presented as part of the scope: `closure.added` feeds `inputs.scope.added`,
// which names each one and the scoped component that needs it.
//
// A dependency id that points at NOTHING is still dangling after the closure
// runs, and still surfaces as a hole in the restore order. That warning is
// correct and stays; it was simply being fed false input.
function envScopedInputs(slug, scope, alsoSeed = []) {
  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const components = read(() => store.getCollection(slug, 'components'), []);
  const core = scopeComponents(components, scope);
  const coreIds = core.map((c) => str(c?.id)).filter(Boolean);
  // `?componentId=`/`?componentIds=` narrow WITHIN the scope, but a caller may
  // name something the environment does not own. Seeding the closure with it
  // too means the engine is never asked to order a component it cannot see.
  // `scopedInventory` is the ENGINE's own narrowing, shared with the workbook
  // path — a discovered resource or workload that names ONLY out-of-scope
  // components goes; one that names none is kept (§7's rule for unlinked items:
  // dropping it could silently remove a prerequisite over a missing field).
  const narrowed = scopedInventory({
    components,
    graph: read(() => store.getObject(slug, 'resource-graph'), {}) || {},
    k8s: read(() => store.getObject(slug, 'k8s'), {}) || {},
    // `?componentId=`/`?componentIds=` narrow WITHIN the scope, but a caller may
    // name something the environment does not own. Seeding the closure with it
    // too means the engine is never asked to order a component it cannot see.
    componentIds: [...coreIds, ...arr(alsoSeed).map(str)],
  });
  return {
    inputs: {
      components: narrowed.components,
      runbooks: read(() => store.getCollection(slug, 'runbooks'), []),
      graph: narrowed.graph,
      k8s: narrowed.k8s,
    },
    // The accounting the response needs to keep "I scoped to this" apart from
    // "this came along because the scope waits on it".
    // `added` is measured against the ENVIRONMENT/SERVICE scope, not against
    // the closure's seeds: a component named in `?componentId=` that the
    // environment does not own is still something this plan pulled in.
    closure: {
      coreIds,
      added: narrowed.closure.ids.filter((id) => !coreIds.includes(id)).sort(),
      dangling: narrowed.closure.dangling,
      nameOf: new Map(components.map((c) => [str(c?.id), str(c?.name)])),
    },
  };
}

// The label `inputs.scope.name` carries — what was asked for, not what the
// closure came to. `describeScope` writes the paragraph; this writes the title.
function describeScopeName(scope) {
  return [
    scope?.envName ? `${scope.envName} environment` : '',
    scope?.serviceName ? `${scope.serviceName} service` : '',
  ].filter(Boolean).join(' · ') || 'scoped';
}

// What the environment/service scope had to pull in to be a restorable plan.
// Printed next to the scope itself so the count on this page and the count in
// the workbook can be reconciled by a reader without opening either engine.
function inventoryBlock(closure) {
  const added = arr(closure?.added).map((id) => ({ id, name: closure.nameOf.get(id) || id }));
  const core = arr(closure?.coreIds).length;
  return {
    scopedComponentCount: core,
    planComponentCount: core + added.length,
    prerequisiteCount: added.length,
    prerequisites: added,
    ...(arr(closure?.dangling).length ? { danglingDependencyIds: closure.dangling } : {}),
    description: added.length
      ? `${core} component${core === 1 ? '' : 's'} are assigned to this scope. `
        + `${added.length} further component${added.length === 1 ? ' is' : 's are'} ordered here because `
        + `something in the scope cannot start without ${added.length === 1 ? 'it' : 'them'} — `
        + `${added.map((a) => a.name).join(', ')}. `
        + 'They are NOT in this scope and nothing here assigns them to it; a plan that left them out would '
        + 'omit a prerequisite the recovery actually waits on.'
      : `${core} component${core === 1 ? '' : 's'} are assigned to this scope, and nothing outside it is a `
        + 'prerequisite — this plan is complete without pulling anything in.',
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
  const { inputs, closure } = envScopedInputs(slug, scope, componentId ? [componentId] : componentIds);
  const result = computeDeployOrder({
    ...inputs,
    // The §3 scope has already chosen the inventory; `componentId`/`componentIds`
    // narrow further, within it, to a closure. With neither asked for, the scope
    // is handed to the engine with `restrict: false` — the inventory IS the plan
    // (narrowing it a second time would drop the unlinked resources and
    // workloads §7 keeps on purpose), and the engine reports the accounting in
    // `inputs.scope`: how many components were scoped, what the closure came to,
    // and every component that is here only as a prerequisite.
    scope: componentId || (componentIds.length ? { componentIds }
      : (closure.coreIds.length
        ? { componentIds: closure.coreIds, name: describeScopeName(scope), restrict: false }
        : null)),
    options: {},
  });
  const meta = scopeMeta(scope);
  return {
    slug,
    result,
    scope,
    scopeBlock: meta && {
      ...meta, description: describeScope(scope), inventory: inventoryBlock(closure),
    },
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
