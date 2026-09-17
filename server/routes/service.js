// Service DR Profile — ONE read-only endpoint that answers every question a DR
// owner has about ONE service, so the page is a single round-trip instead of
// eight. Everything here is derived from data that already exists (inventory,
// resource graph, k8s snapshot, runbooks, tests, gaps) — nothing is written.
//
//   GET /w/:ws/service/:componentId
//     -> { workspace, component, posture, closure, dependents, impact, graph,
//          outboundCalls, runbooks, tests, gaps, inlineGaps, k8sWorkloads,
//          diagrams, risks, counts }
//
// `risks` is the interesting part: explicit, named rules (see RULES below) that
// turn scattered fields into the sentences an owner needs to read. They are
// computed server-side so the page, the AI prompts and (later) the DR-package
// export all say exactly the same thing.
import { Router } from 'express';
import * as store from '../store.js';

const r = Router();

// The dependency-closure walk is shared with the scoped exports
// (`/export/scope/:componentId`) so both agree on what "this service" means.
// Loaded defensively: if the export lib can't load (its exceljs dependency,
// say), this page still works off the local fallback.
let sharedClosure = null;
try {
  ({ serviceClosure: sharedClosure } = await import('../lib/xlsx-gen.js'));
} catch (e) {
  console.error(`[drcompass] service profile: falling back to local closure walk (${e.message})`);
}

// --------------------------------------------------------------- vocabulary

const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
const LAYER_LABEL = {
  L0: 'Guardrails & backups green',
  L1: 'Recovery launch & replication',
  L2: 'Platform — cluster, nodes, mesh',
  L3: 'Data & secrets',
  L4: 'Applications',
  L5: 'Edge & network reachability',
  L6: 'Functional success bar',
  L7: 'Live traffic cutover',
};
const layerRank = (l) => {
  const i = LAYER_ORDER.indexOf(String(l || ''));
  return i < 0 ? 99 : i;
};
const SEV_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };
const sevRank = (s) => (SEV_RANK[String(s || '').toLowerCase()] ?? 4);

const EXTERNAL_TYPES = new Set(['third-party', 'saas', 'on-prem']);
const DATA_CATEGORIES = new Set(['database', 'storage', 'messaging-streaming', 'security-secrets']);
// "nobody has to do this by hand" is the whole point of a runbook — these
// phrases in a field mean a human is in the failover path.
const MANUAL_RE = /manual|by hand|allow ?-?list|support ticket|raise a ticket|not automated|human/i;
const OUT_OF_SCOPE_RE = /not in (the )?(recovery )?scope|out of scope|no failover|known gap|unsupported/i;

const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const lower = (v) => str(v).toLowerCase();

// --------------------------------------------------------------- closure

function localClosure(components, rootId) {
  const all = arr(components);
  const byId = new Map(all.map((c) => [c.id, c]));
  const root = byId.get(rootId);
  if (!root) throw store.httpError(404, `no component '${rootId}'`);
  const seen = new Set([rootId]);
  const deps = [];
  const queue = [rootId];
  while (queue.length) {
    const cur = byId.get(queue.shift());
    for (const dep of arr(cur?.dependsOn)) {
      if (seen.has(dep) || !byId.has(dep)) continue; // cycle-safe, drops dangling ids
      seen.add(dep);
      deps.push(dep);
      queue.push(dep);
    }
  }
  const dependents = [];
  for (const c of all) {
    if (c.id === rootId || seen.has(c.id)) continue;
    if (arr(c.dependsOn).includes(rootId)) { seen.add(c.id); dependents.push(c.id); }
  }
  return { ids: [rootId, ...deps, ...dependents], root, depsCount: deps.length, dependentsCount: dependents.length };
}

const closureOf = (components, rootId) =>
  (typeof sharedClosure === 'function' ? sharedClosure : localClosure)(components, rootId);

// Everything that breaks if this service never comes back (transitive).
function downstreamOf(components, rootId) {
  const usedBy = new Map();
  for (const c of arr(components)) {
    for (const d of arr(c.dependsOn)) {
      if (!usedBy.has(d)) usedBy.set(d, []);
      usedBy.get(d).push(c.id);
    }
  }
  const out = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const id of usedBy.get(queue.shift()) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(id);
    }
  }
  return out;
}

// --------------------------------------------------------------- summaries

function summarize(c, rel = {}) {
  const rep = c.replication || {};
  const ver = c.verification || {};
  const secrets = arr(c.secrets).map((s) => ({
    name: str(s.name), arn: str(s.arn),
    replicated: lower(s.replicated) || 'unknown', notes: str(s.notes),
  }));
  const calls = arr(c.outboundCalls);
  return {
    id: c.id,
    name: str(c.name) || '(unnamed)',
    kind: str(c.kind),
    category: str(c.category) || 'other',
    tier: c.tier === null || c.tier === undefined ? null : Number(c.tier),
    owner: str(c.owner),
    team: str(c.team),
    description: str(c.description),
    drStrategy: str(c.drStrategy) || 'inherit',
    restoreLayer: str(c.restoreLayer),
    restoreLayerLabel: LAYER_LABEL[str(c.restoreLayer)] || '',
    inRecoveryScope: lower(c.inRecoveryScope) || 'unknown',
    definedIn: str(c.definedIn),
    replication: { mechanism: str(rep.mechanism), rpoMinutes: num(rep.rpoMinutes), notes: str(rep.notes) },
    verification: { command: str(ver.command), pass: str(ver.pass) },
    hasVerification: !!str(ver.command).trim(),
    secrets,
    secretsAtRisk: secrets.filter((s) => s.replicated !== 'yes').length,
    endpoints: arr(c.endpoints).map((e) => ({ name: str(e.name), url: str(e.url), healthCheck: str(e.healthCheck) })),
    awsServices: arr(c.awsServices).map(str),
    outboundCount: calls.length,
    criticalOutboundCount: calls.filter((o) => o && o.critical).length,
    dependsOn: arr(c.dependsOn).map(str),
    inlineGaps: arr(c.gaps).map(str).filter(Boolean),
    tags: arr(c.tags).map(str),
    notes: str(c.notes),
    ...rel,
  };
}

// --------------------------------------------------------- resource graph

function adjacency(edges) {
  const adj = new Map();
  const push = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of arr(edges)) {
    if (!e) continue;
    push(str(e.from), str(e.to));
    push(str(e.to), str(e.from));
  }
  return adj;
}

// Same 2-hop walk (+ one extra hop for attribute-like leaves) the resource
// panel and the resource-map diagram use, so the counts on this page match
// what Discover and Diagrams show.
function subgraphFor(graph, componentId) {
  const nodes = (graph && typeof graph.nodes === 'object' && graph.nodes) || {};
  const edges = arr(graph?.edges);
  const empty = {
    updatedAt: graph?.updatedAt || null, hasGraph: !!Object.keys(nodes).length,
    nodes: {}, edges: [], countsByType: {}, hops: {}, total: Object.keys(nodes).length,
  };
  if (!empty.hasGraph) return empty;

  const adj = adjacency(edges);
  const dist = new Map([[componentId, 0]]);
  const queue = [componentId];
  while (queue.length) {
    const v = queue.shift();
    const d = dist.get(v);
    if (d >= 2) continue;
    for (const n of adj.get(v) || []) {
      if (!dist.has(n)) { dist.set(n, d + 1); queue.push(n); }
    }
  }
  const LEAF_TYPES = new Set(['availability-zone', 'certificate', 'kms-key']);
  for (const e of edges) {
    if (!e) continue;
    const from = str(e.from), to = str(e.to);
    if (dist.has(from) && !dist.has(to) && nodes[to] && LEAF_TYPES.has(nodes[to].type)) dist.set(to, 3);
  }

  const out = {};
  const hops = {};
  const countsByType = {};
  for (const [rid, n] of Object.entries(nodes)) {
    if (!dist.has(rid)) continue;
    out[rid] = n;
    hops[rid] = dist.get(rid);
    const t = str(n.type) || 'other';
    countsByType[t] = (countsByType[t] || 0) + 1;
  }
  const present = (v) => dist.has(v) && (out[v] || v.startsWith('cmp_'));
  return {
    updatedAt: graph?.updatedAt || null,
    hasGraph: true,
    nodes: out,
    edges: edges.filter((e) => e && present(str(e.from)) && present(str(e.to))),
    countsByType,
    hops,
    total: Object.keys(nodes).length,
  };
}

// ------------------------------------------------- outbound call resolution

// "Kinesis claim stream" in an outbound call is almost certainly cmp_kinesis in
// the inventory. Resolving it is what lets the page say "you call this, and it
// is not in the recovery scope" — the classic hidden blocker.
function targetResolver(components) {
  const normalize = (s) => lower(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const index = [];
  for (const c of arr(components)) {
    const push = (key, score) => {
      const k = normalize(key);
      if (k.length >= 4) index.push({ id: c.id, key: k, score });
    };
    push(c.name, 3);
    push(c.kind, 2);
    for (const [i, s] of arr(c.awsServices).entries()) push(s, i === 0 ? 1.5 : 1);
  }
  return (target, fromId) => {
    const t = normalize(target);
    if (!t) return null;
    let best = null;
    for (const cand of index) {
      if (cand.id === fromId) continue;
      const hit = t.includes(cand.key) || cand.key.includes(t);
      if (!hit) continue;
      const score = cand.score + (cand.key === t ? 2 : 0);
      if (!best || score > best.score || (score === best.score && cand.key.length > best.key.length)) {
        best = { ...cand, score };
      }
    }
    return best ? best.id : null;
  };
}

// --------------------------------------------------------------- risk rules

/* eslint-disable complexity */
function computeRisks(ctx) {
  const { root, deps, calls, runbooks, tests, posture, meta, manualEdge, closureIds } = ctx;
  const out = [];
  const seen = new Set();
  const add = (rule, severity, title, detail, comp, extra) => {
    const componentId = comp ? comp.id : null;
    const key = `${rule}|${componentId || ''}|${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      rule, severity, title, detail,
      componentId, componentName: comp ? comp.name : '',
      ...(extra || {}),
    });
  };
  const inScopeWord = { no: 'is NOT in the recovery scope', partial: 'is only partially in the recovery scope', unknown: 'has an unknown recovery scope' };

  // 1. the service itself is not (fully) covered
  if (root.inRecoveryScope !== 'yes') {
    add('service-out-of-scope', root.inRecoveryScope === 'no' ? 'blocker' : 'high',
      `${root.name} ${inScopeWord[root.inRecoveryScope] || 'has an unclear recovery scope'}`,
      'Nothing else on this page matters until this is settled: if the service is not in scope, it does not come back in the recovery region. Fix it in Inventory → Recovery.',
      root);
  }

  for (const d of deps) {
    // 2. a dependency that will not be there
    if (d.inRecoveryScope !== 'yes') {
      add('dependency-out-of-scope', d.inRecoveryScope === 'no' ? 'high' : 'medium',
        `Dependency ${d.inRecoveryScope === 'no' ? 'out of recovery scope' : `scope '${d.inRecoveryScope}'`} — ${d.name}`,
        `${root.name} depends on ${d.name} (${d.restoreLayer || 'no layer'}), which ${inScopeWord[d.inRecoveryScope]}. Either bring it into scope or prove in writing that ${root.name} can serve traffic without it.`,
        d, { layer: d.restoreLayer });
    }
    // 3. a layer you cannot verify is a layer you cannot gate
    if (!d.hasVerification) {
      add('missing-verification', 'medium',
        `No verification defined — ${d.name}`,
        `${d.name} has no verification command, so a runbook cannot gate on it and a test cannot prove it came back. Add one in Inventory → Verification.`,
        d, { layer: d.restoreLayer });
    }
    // 4. unlayered dependencies cannot be sequenced
    if (!d.restoreLayer) {
      add('unlayered-dependency', 'medium',
        `No restore layer — ${d.name}`,
        `${d.name} has no restore layer, so it cannot be placed in the L0→L7 recovery order. Assign one in Inventory → Recovery.`,
        d);
    }
    // 5. in scope, but no stated mechanism for how it gets there
    const mech = lower(d.replication.mechanism);
    if (d.inRecoveryScope !== 'no' && DATA_CATEGORIES.has(d.category) && (!mech || mech === 'none' || mech === 'unknown')) {
      add('replication-undefined', 'medium',
        `No replication mechanism recorded — ${d.name}`,
        `${d.name} holds state (${d.category}) and is in scope, but nothing says HOW it arrives in the recovery region. Without a mechanism there is no RPO — only hope.`,
        d);
    }
  }

  if (!root.hasVerification) {
    add('missing-verification', 'high',
      `No verification defined — ${root.name}`,
      `There is no command that proves ${root.name} actually recovered. Every test of this service is a judgement call until there is one.`,
      root);
  }

  // 6. secrets are the number-one cause of failed recovery tests
  for (const c of [root, ...deps]) {
    for (const s of c.secrets) {
      if (s.replicated === 'yes') continue;
      add('unreplicated-secret', s.replicated === 'no' ? 'blocker' : 'high',
        `Secret ${s.replicated === 'no' ? 'not replicated' : 'replication unconfirmed'} — ${s.name}`,
        `${c.name} reads '${s.name}' at start-up and its presence in the recovery region is '${s.replicated}'.${s.notes ? ` Note: ${s.notes}` : ''} A missing secret usually shows up as an opaque container error, not as "missing secret" — budget 30 minutes of confusion per occurrence.`,
        c, { secret: s.name });
    }
  }

  // 7 & 8. outbound calls: manual third-party failover, and targets that are
  // known not to come back.
  for (const call of calls) {
    const label = call.target || '(unnamed target)';
    const comp = { id: call.componentId, name: call.componentName };
    const manual = MANUAL_RE.test(call.failoverBehavior);
    if (EXTERNAL_TYPES.has(call.type) && (manual || !call.failoverBehavior)) {
      const sev = call.critical ? 'blocker' : 'high';
      add('manual-third-party-failover', sev,
        `${call.critical ? 'Critical ' : ''}${call.type} call needs a human — ${label}`,
        call.failoverBehavior
          ? `${call.componentName} calls ${label} (${call.type}). Failover behavior: "${call.failoverBehavior}". Anything that needs a partner ticket or an allowlist change has lead time measured in days, not minutes — pre-register the recovery-region egress now.`
          : `${call.componentName} calls ${label} (${call.type}) and no failover behavior is recorded. Assume it breaks after failover until someone writes down why it doesn't.`,
        comp, { target: label, callType: call.type });
    }
    if (OUT_OF_SCOPE_RE.test(call.failoverBehavior) || OUT_OF_SCOPE_RE.test(call.purpose)) {
      add('outbound-target-out-of-scope', 'high',
        `Outbound call to something that will not be there — ${label}`,
        `${call.componentName} calls ${label}; the recorded behavior is "${call.failoverBehavior || call.purpose}". Decide in writing whether ${root.name} can answer a real request without it.`,
        comp, { target: label });
    } else if (call.resolvedComponentId && call.resolvedScope && call.resolvedScope !== 'yes') {
      const undeclared = !closureIds.has(call.resolvedComponentId);
      add('outbound-target-out-of-scope', call.critical ? 'high' : 'medium',
        `Calls ${call.resolvedComponentName}, which ${inScopeWord[call.resolvedScope]}`,
        `${call.componentName} calls ${label} (${call.type}), matched to inventory component ${call.resolvedComponentName} (scope: ${call.resolvedScope}).${undeclared ? ` It is NOT listed as a dependency of ${root.name}, so it never appears in the recovery order.` : ''}`,
        { id: call.resolvedComponentId, name: call.resolvedComponentName },
        { target: label, undeclared });
    }
  }

  // 9. the live cutover in front of this service
  for (const e of manualEdge) {
    add('manual-cutover', e.severity,
      `Live cutover is manual — ${e.component.name}`,
      `${e.component.name} (${e.component.restoreLayer || 'no layer'}${e.component.inRecoveryScope !== 'yes' ? `, scope: ${e.component.inRecoveryScope}` : ''}) `
      + `is a step that puts live traffic on the recovery region, and it is not automated: ${e.why} `
      + `Until someone does it by hand, a recovered ${root.name} serves no real users.`,
      e.component, { onPath: e.onPath });
  }

  // 10. no written procedure
  if (!runbooks.length) {
    add('no-runbook', 'high',
      `No runbook covers ${root.name}`,
      `No runbook step references ${root.name} or anything in its dependency closure. In an event this service is recovered from memory, by whoever is awake.`,
      root);
  } else if (!runbooks.some((rb) => rb.stepsForService > 0)) {
    add('no-runbook', 'medium',
      `No runbook step names ${root.name}`,
      `${runbooks.length} runbook(s) touch this service's dependencies, but no step names ${root.name} itself — so nothing tells an operator how to bring it back or how to know it is back.`,
      root);
  }

  // 11 & 12. test coverage and what the last test measured
  const measuredTests = tests.filter((t) => t.status === 'passed' || t.status === 'failed');
  if (!tests.length) {
    add('no-test-coverage', 'high',
      `${root.name} has never been in a recovery test`,
      'An untested recovery path is a hypothesis. Plan a component test or add this service to the next recovery test\'s app-test list.',
      root);
  } else if (!measuredTests.length) {
    add('no-test-coverage', 'medium',
      `No completed test has covered ${root.name}`,
      `${tests.length} test(s) reference this service but none has a passed/failed result yet — its RTA and RPA are still unmeasured.`,
      root);
  } else if (!measuredTests.some((t) => t.status === 'passed')) {
    const last = measuredTests[0];
    add('test-failed', 'high',
      `Last test covering ${root.name} failed`,
      `${last.name} (${last.date || 'no date'}) failed${(last.findings || []).length ? `: ${last.findings[0].title}` : '.'} This service has no passing recovery evidence.`,
      root, { testId: last.id });
  }

  // 13 & 14. objectives vs what was actually measured
  const m = posture.measured;
  if (m && num(m.rpaMinutes) !== null && num(posture.targetRpoMinutes) !== null && m.rpaMinutes > posture.targetRpoMinutes) {
    add('rpo-gap', 'blocker',
      `Measured data loss exceeds the RPO — ${m.rpaMinutes} min vs ${posture.targetRpoMinutes} min`,
      `${m.name} (${m.date || 'no date'}) measured an RPA of ${m.rpaMinutes} minutes against a ${posture.targetRpoMinutes}-minute target${posture.rpoSource === 'workspace' ? ' (workspace objective)' : ' (component replication RPO)'}. Recovery points that are not aligned across stores produce exactly this result.`,
      root, { testId: m.id });
  }
  if (m && num(m.rtaMinutes) !== null && num(meta?.objectives?.rtoMinutes) !== null && m.rtaMinutes > meta.objectives.rtoMinutes) {
    add('rta-gap', 'high',
      `Measured recovery time exceeds the RTO — ${m.rtaMinutes} min vs ${meta.objectives.rtoMinutes} min`,
      `${m.name} took ${m.rtaMinutes} minutes to reach its success bar against a ${meta.objectives.rtoMinutes}-minute objective.`,
      root, { testId: m.id });
  }

  out.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.title.localeCompare(b.title));
  return out;
}
/* eslint-enable complexity */

// --------------------------------------------------------------- the route

r.get('/w/:ws/service/:componentId', (req, res, next) => {
  try {
    const slug = req.params.ws;
    const meta = store.getWorkspace(slug); // 404s on unknown workspace
    const components = store.getCollection(slug, 'components');
    const cl = closureOf(components, req.params.componentId); // 404s on unknown component

    const byId = new Map(components.map((c) => [c.id, c]));
    const rootRaw = byId.get(cl.root.id) || cl.root;
    const rootId = rootRaw.id;

    const directDependents = components.filter((c) => c.id !== rootId && arr(c.dependsOn).includes(rootId));
    const dependentIds = new Set(directDependents.map((c) => c.id));
    const depIds = arr(cl.ids).filter((id) => id !== rootId && !dependentIds.has(id));
    const closureIds = new Set([rootId, ...depIds]);

    const directDeps = new Set(arr(rootRaw.dependsOn));
    const root = summarize(rootRaw, { relation: 'service', isRoot: true });
    const deps = depIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((c) => summarize(c, { relation: 'dependency', isRoot: false, direct: directDeps.has(c.id) }));
    const dependents = directDependents.map((c) => summarize(c, { relation: 'dependent', isRoot: false, direct: true }));

    const downstreamIds = downstreamOf(components, rootId);

    // ---- the recovery story: L0 → L7, the service itself in its own layer ----
    const ordered = [root, ...deps].sort((a, b) =>
      layerRank(a.restoreLayer) - layerRank(b.restoreLayer)
      || (a.tier ?? 9) - (b.tier ?? 9)
      || a.name.localeCompare(b.name));
    const byLayer = [];
    for (const c of ordered) {
      const layer = c.restoreLayer || '';
      let group = byLayer.find((g) => g.layer === layer);
      if (!group) {
        group = {
          layer, label: LAYER_LABEL[layer] || (layer ? layer : 'No restore layer assigned'),
          rank: layerRank(layer), components: [],
        };
        byLayer.push(group);
      }
      group.components.push(c);
    }

    // ---- outbound calls (this service first, then its closure) ----
    const resolve = targetResolver(components);
    const callsOf = (c, own) => arr(c.outboundCalls).filter(Boolean).map((o) => {
      const rid = resolve(o.target, c.id);
      const rc = rid ? byId.get(rid) : null;
      return {
        componentId: c.id, componentName: str(c.name), own,
        target: str(o.target), type: lower(o.type) || 'internal',
        protocol: str(o.protocol), port: num(o.port),
        purpose: str(o.purpose), failoverBehavior: str(o.failoverBehavior),
        critical: !!o.critical,
        source: str(o.source), observedCount: num(o.observedCount),
        workload: str(o.workload), pod: str(o.pod),
        resolvedComponentId: rc ? rc.id : null,
        resolvedComponentName: rc ? str(rc.name) : '',
        resolvedScope: rc ? (lower(rc.inRecoveryScope) || 'unknown') : '',
      };
    });
    const outboundCalls = [
      ...callsOf(rootRaw, true),
      ...deps.flatMap((d) => callsOf(byId.get(d.id), false)),
    ].sort((a, b) => Number(b.own) - Number(a.own) || Number(b.critical) - Number(a.critical)
      || a.componentName.localeCompare(b.componentName) || a.target.localeCompare(b.target));

    // ---- runbooks whose steps reference this service or its closure ----
    const allRunbooks = store.getCollection(slug, 'runbooks');
    const runbooks = [];
    for (const rb of allRunbooks) {
      const steps = arr(rb.steps);
      const rollback = arr(rb.rollback);
      const all = [...steps, ...rollback];
      const forService = all.filter((s) => arr(s?.componentIds).includes(rootId));
      const inClosure = all.filter((s) => arr(s?.componentIds).some((id) => closureIds.has(id)));
      if (!inClosure.length) continue;
      runbooks.push({
        id: rb.id, name: str(rb.name), tooling: str(rb.tooling), scenario: str(rb.scenario),
        audience: str(rb.audience),
        steps: steps.length,
        rollbackSteps: rollback.length,
        estMinutes: steps.reduce((a, s) => a + (num(s?.estMinutes) || 0), 0),
        gates: steps.filter((s) => s?.gate).length,
        stepsForService: forService.length,
        stepsInClosure: inClosure.length,
        covers: forService.length ? 'direct' : 'closure',
        linkedTestIds: arr(rb.linkedTestIds).map(str),
        updatedAt: rb.updatedAt || null,
        serviceSteps: forService.map((s) => ({
          id: str(s.id), layer: str(s.layer), title: str(s.title),
          estMinutes: num(s.estMinutes), gate: !!s.gate,
          verify: str(s.verify), pass: str(s.pass), owner: str(s.owner),
        })),
      });
    }
    runbooks.sort((a, b) => b.stepsForService - a.stepsForService || a.name.localeCompare(b.name));
    const runbookIds = new Set(runbooks.map((rb) => rb.id));

    // ---- tests that covered it ----
    const allTests = store.getCollection(slug, 'tests');
    const tests = [];
    for (const t of allTests) {
      const appTests = arr(t.appTests).filter(Boolean);
      const mine = appTests.filter((a) => str(a.componentId) === rootId);
      const near = appTests.filter((a) => closureIds.has(str(a.componentId)));
      const viaRunbook = t.runbookId && runbookIds.has(t.runbookId);
      if (!mine.length && !near.length && !viaRunbook) continue;
      const results = t.results || {};
      tests.push({
        id: t.id, name: str(t.name), type: str(t.type), status: lower(t.status) || 'planned',
        date: str(t.date), scope: str(t.scope), runbookId: str(t.runbookId),
        rtaMinutes: num(results.rtaMinutes), rpaMinutes: num(results.rpaMinutes),
        cleanRun: !!results.cleanRun,
        covers: mine.length ? 'direct' : (near.length ? 'closure' : 'runbook'),
        findings: arr(t.findings).filter(Boolean).map((f) => ({
          title: str(f.title), severity: lower(f.severity) || 'medium',
          gapId: str(f.gapId), ticket: str(f.ticket),
        })),
        appTests: near.map((a) => ({
          name: str(a.name), componentId: str(a.componentId),
          componentName: str(byId.get(str(a.componentId))?.name || ''),
          critical: !!a.critical, result: lower(a.result), expected: str(a.expected),
          forService: str(a.componentId) === rootId,
        })),
      });
    }
    tests.sort((a, b) => str(b.date).localeCompare(str(a.date)) || a.name.localeCompare(b.name));

    // ---- posture: objectives vs the last thing anyone measured ----
    const measuredTest = tests.find((t) => (t.status === 'passed' || t.status === 'failed')
      && (t.rtaMinutes !== null || t.rpaMinutes !== null)) || null;
    const targetRpo = root.replication.rpoMinutes !== null
      ? root.replication.rpoMinutes : num(meta?.objectives?.rpoMinutes);
    const rpoSource = root.replication.rpoMinutes !== null ? 'component' : 'workspace';
    const rtoTarget = num(meta?.objectives?.rtoMinutes);
    const rtoMet = measuredTest && measuredTest.rtaMinutes !== null && rtoTarget !== null
      ? measuredTest.rtaMinutes <= rtoTarget : null;
    const rpoMet = measuredTest && measuredTest.rpaMinutes !== null && targetRpo !== null
      ? measuredTest.rpaMinutes <= targetRpo : null;
    const posture = {
      drStrategy: root.drStrategy === 'inherit' ? str(meta.strategy) : root.drStrategy,
      strategySource: root.drStrategy === 'inherit' ? 'workspace' : 'component',
      replication: root.replication,
      restoreLayer: root.restoreLayer,
      restoreLayerLabel: root.restoreLayerLabel,
      inRecoveryScope: root.inRecoveryScope,
      regions: meta.regions || {},
      tooling: arr(meta.tooling).map(str),
      objectives: {
        rtoMinutes: rtoTarget, rpoMinutes: num(meta?.objectives?.rpoMinutes),
        approved: !!meta?.objectives?.approved,
      },
      targetRpoMinutes: targetRpo,
      rpoSource,
      measured: measuredTest ? {
        id: measuredTest.id, name: measuredTest.name, date: measuredTest.date,
        status: measuredTest.status, rtaMinutes: measuredTest.rtaMinutes,
        rpaMinutes: measuredTest.rpaMinutes, cleanRun: measuredTest.cleanRun,
        covers: measuredTest.covers,
      } : null,
      rtoMet,
      rpoMet,
      verdict: !measuredTest ? 'unmeasured'
        : (rtoMet === false || rpoMet === false || measuredTest.status === 'failed' ? 'missed'
          : (rtoMet === true || rpoMet === true ? 'met' : 'unmeasured')),
    };

    // ---- the manual cutover in front of this service ----
    const facesOutside = root.endpoints.length > 0
      || outboundCalls.some((o) => o.own && EXTERNAL_TYPES.has(o.type))
      || root.category === 'edge-dns';
    const pathIds = new Set([...closureIds, ...downstreamIds]);
    const manualEdge = [];
    for (const c of components) {
      if (c.id === rootId) continue;
      const cat = str(c.category);
      const layer = str(c.restoreLayer);
      if (cat !== 'edge-dns' && layer !== 'L7') continue;
      const onPath = pathIds.has(c.id);
      if (!onPath && !facesOutside) continue;
      const signals = [str(c.description), str(c.replication?.notes), str(c.replication?.mechanism),
        ...arr(c.gaps).map(str), str(c.notes)].join(' ');
      const manual = MANUAL_RE.test(signals);
      const scope = lower(c.inRecoveryScope) || 'unknown';
      if (!manual && scope === 'yes') continue;
      const whyRaw = manual
        ? (arr(c.gaps).map(str).find((g) => MANUAL_RE.test(g)) || str(c.description) || 'recorded as a manual step')
        : `its recovery scope is '${scope}'`;
      const why = /[.!?]$/.test(whyRaw) ? whyRaw : `${whyRaw}.`;
      manualEdge.push({
        component: summarize(c, { relation: onPath ? 'edge-on-path' : 'edge' }),
        onPath,
        why,
        severity: (onPath || (root.tier !== null && root.tier <= 1)) ? 'high' : 'medium',
      });
    }

    // ---- gaps (tracked) + the inline notes on each component ----
    const allGaps = store.getCollection(slug, 'gaps');
    const gaps = allGaps
      .filter((g) => closureIds.has(str(g.componentId)) || dependentIds.has(str(g.componentId)))
      .map((g) => ({
        id: g.id, title: str(g.title), category: str(g.category), class: str(g.class),
        severity: lower(g.severity) || 'medium', status: lower(g.status) || 'open',
        componentId: str(g.componentId), componentName: str(byId.get(str(g.componentId))?.name || ''),
        ticket: str(g.ticket), notes: str(g.notes),
        forService: str(g.componentId) === rootId,
      }))
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
        || sevRank(a.severity) - sevRank(b.severity)
        || Number(b.forService) - Number(a.forService)
        || a.title.localeCompare(b.title));
    const inlineGaps = [root, ...deps].flatMap((c) =>
      c.inlineGaps.map((text) => ({ componentId: c.id, componentName: c.name, text, forService: c.id === rootId })));

    // ---- k8s workloads behind this service ----
    const snap = store.getObject(slug, 'k8s') || {};
    const k8sWorkloads = arr(snap.workloads)
      .filter((w) => closureIds.has(str(w?.componentId)))
      .map((w) => ({
        uid: str(w.uid), namespace: str(w.namespace), kind: str(w.kind), name: str(w.name),
        replicas: w.replicas || null, images: arr(w.images).map(str),
        serviceAccount: str(w.serviceAccount),
        secrets: arr(w.secrets).map(str), configmaps: arr(w.configmaps).map(str),
        componentId: str(w.componentId),
        componentName: str(byId.get(str(w.componentId))?.name || ''),
        forService: str(w.componentId) === rootId,
      }))
      .sort((a, b) => Number(b.forService) - Number(a.forService)
        || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

    // ---- resource-graph associations ----
    const graph = subgraphFor(store.getObject(slug, 'resource-graph') || {}, rootId);
    const ownRids = Object.entries(graph.nodes)
      .filter(([, n]) => arr(n?.componentIds).includes(rootId)).map(([rid]) => rid);

    const risks = computeRisks({
      root, deps, calls: outboundCalls, runbooks, tests, posture, meta, manualEdge, closureIds,
    });
    const riskCounts = risks.reduce((acc, x) => {
      acc[x.severity] = (acc[x.severity] || 0) + 1;
      return acc;
    }, {});

    res.json({
      workspace: {
        slug: meta.slug || slug, name: str(meta.name), org: str(meta.org),
        regions: meta.regions || {}, strategy: str(meta.strategy),
        tooling: arr(meta.tooling).map(str), objectives: meta.objectives || {},
      },
      component: rootRaw,
      service: root,
      posture,
      closure: {
        ids: [rootId, ...depIds],
        depIds,
        byLayer,
        depsCount: depIds.length,
        dependentsCount: dependents.length,
        directDepIds: arr(rootRaw.dependsOn).filter((id) => byId.has(id)),
        danglingDepIds: arr(rootRaw.dependsOn).filter((id) => !byId.has(id)),
      },
      dependents,
      impact: {
        directCount: dependents.length,
        transitiveCount: downstreamIds.length,
        ids: downstreamIds,
        names: downstreamIds.map((id) => str(byId.get(id)?.name || id)),
      },
      graph: {
        updatedAt: graph.updatedAt, hasGraph: graph.hasGraph,
        nodes: graph.nodes, edges: graph.edges, countsByType: graph.countsByType,
        hops: graph.hops,
        nodeCount: Object.keys(graph.nodes).length,
        ownNodeCount: ownRids.length,
        workspaceNodeCount: graph.total,
      },
      outboundCalls,
      runbooks,
      tests,
      gaps,
      inlineGaps,
      k8sWorkloads,
      diagrams: {
        resourceMap: ownRids.length ? `resource-map-${rootId}` : null,
        dependencies: `dependencies-${rootId}`,
      },
      risks,
      counts: {
        deps: depIds.length,
        dependents: dependents.length,
        downstream: downstreamIds.length,
        resources: Object.keys(graph.nodes).length,
        outboundCalls: outboundCalls.length,
        runbooks: runbooks.length,
        tests: tests.length,
        gaps: gaps.filter((g) => g.status === 'open').length,
        k8sWorkloads: k8sWorkloads.length,
        risks: risks.length,
        risksBySeverity: riskCounts,
        weakLinks: risks.filter((x) => x.severity === 'blocker' || x.severity === 'high').length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

export default r;
