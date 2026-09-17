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
// The single source of truth for measured numbers and for risk severity.
// Contract: docs/measured-numbers.md. Nothing in this file may decide on its
// own whether a number is "measured" or how severe a condition is.
import { measuredNumbers, severityFor, BLOCKS_RECOVERY, staleAfterDaysFor } from '../lib/measured.js';

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

// --- evidence index: what is actually CHECKED somewhere, vs merely described.
//
// A component description that says "OIDC must be trusted in BOTH regions" is
// prose. A runbook step or checklist item that verifies it is proof. The
// regional-failure rules below fire on the absence of PROOF, never on the
// absence of prose — otherwise they would be satisfied by the same documents
// that caused the audit finding.
function buildProof(allRunbooks, checklists, comps) {
  const parts = [];
  const items = [];
  for (const rb of arr(allRunbooks)) {
    for (const s of [...arr(rb?.steps), ...arr(rb?.rollback)]) {
      parts.push(str(s?.title), str(s?.command), str(s?.verify), str(s?.pass), str(s?.record));
    }
  }
  for (const cl of arr(checklists)) {
    for (const it of arr(cl?.items)) {
      const text = `${str(it?.text)} ${str(it?.proof)}`;
      items.push({ text, done: !!it?.done, list: str(cl?.name) });
      parts.push(text);
    }
  }
  for (const c of arr(comps)) parts.push(str(c?.verification?.command), str(c?.verification?.pass));
  return { text: parts.join(' \n ').toLowerCase(), items };
}

// Does anything CHECK this? Returns 'verified' | 'listed-not-done' | 'none'.
function proofState(proof, re) {
  const item = proof.items.find((it) => re.test(it.text));
  if (item) return item.done ? 'verified' : 'listed-not-done';
  return re.test(proof.text) ? 'verified' : 'none';
}

// ARNs that are legitimately global carry no region to pin.
const GLOBAL_ARN_SERVICES = new Set([
  'iam', 'route53', 'route53domains', 'cloudfront', 'waf', 'globalaccelerator',
  'organizations', 'sts', 'shield', 'artifact', 'support', 'health', 's3',
]);
function pinnedToPrimary(value, primary) {
  const v = str(value);
  if (!v || !primary) return false;
  if (!v.toLowerCase().includes(String(primary).toLowerCase())) return false;
  const m = /^arn:[^:]*:([^:]+):/.exec(v);
  if (m && GLOBAL_ARN_SERVICES.has(m[1].toLowerCase())) return false;
  return true;
}

const QUOTA_RE = /quota|capacity headroom|capacity reservation|service limit|vcpu|instance[- ]type availability|insufficient(instance)?capacity|on-demand capacity/i;
const IRSA_RE = /irsa|oidc|web identity|assume-?role-?with-?web-?identity|issuer url|serviceaccount .*role/i;
const CERT_RE = /certificate .*(recovery|us-[a-z]+-\d)|acm .*(recovery|second region)|cert .*recovery region/i;
const KMS_RE = /multi-?region key|mrk-|replica key|re-?encrypt/i;

/* eslint-disable complexity */
function computeRisks(ctx) {
  const {
    root, deps, calls, runbooks, tests, posture, meta, manualEdge, closureIds,
    byId, numbers, graphNodes, k8sWorkloads, proof, regions, staleAfterDays,
  } = ctx;
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
      tier: comp && comp.tier !== undefined ? comp.tier : null,
      blocksRecovery: BLOCKS_RECOVERY.has(rule),
      aggregated: false, count: 1, items: [],
      ...(extra || {}),
    });
  };
  const inScopeWord = { no: 'is NOT in the recovery scope', partial: 'is only partially in the recovery scope', unknown: 'has an unknown recovery scope' };

  // 1. the service itself is not (fully) covered
  if (root.inRecoveryScope !== 'yes') {
    add('service-out-of-scope', severityFor('service-out-of-scope', { tier: root.tier, scope: root.inRecoveryScope }),
      `${root.name} ${inScopeWord[root.inRecoveryScope] || 'has an unclear recovery scope'}`,
      'Nothing else on this page matters until this is settled: if the service is not in scope, it does not come back in the recovery region. Fix it in Inventory → Recovery.',
      root);
  }

  for (const d of deps) {
    // 2. a dependency that will not be there
    if (d.inRecoveryScope !== 'yes') {
      add('dependency-out-of-scope', severityFor('dependency-out-of-scope', { tier: d.tier, scope: d.inRecoveryScope }),
        `Dependency ${d.inRecoveryScope === 'no' ? 'out of recovery scope' : `scope '${d.inRecoveryScope}'`} — ${d.name}`,
        `${root.name} depends on ${d.name} (${d.restoreLayer || 'no layer'}), which ${inScopeWord[d.inRecoveryScope]}. Either bring it into scope or prove in writing that ${root.name} can serve traffic without it.`,
        d, { layer: d.restoreLayer });
    }
    // 3. a layer you cannot verify is a layer you cannot gate
    if (!d.hasVerification) {
      add('missing-verification', severityFor('missing-verification', { tier: d.tier, isRoot: false }),
        `No verification defined — ${d.name}`,
        `${d.name} has no verification command, so a runbook cannot gate on it and a test cannot prove it came back. Add one in Inventory → Verification.`,
        d, { layer: d.restoreLayer });
    }
    // 4. unlayered dependencies cannot be sequenced
    if (!d.restoreLayer) {
      add('unlayered-dependency', severityFor('unlayered-dependency', { tier: d.tier }),
        `No restore layer — ${d.name}`,
        `${d.name} has no restore layer, so it cannot be placed in the L0→L7 recovery order. Assign one in Inventory → Recovery.`,
        d);
    }
    // 5. in scope, but no stated mechanism for how it gets there
    const mech = lower(d.replication.mechanism);
    if (d.inRecoveryScope !== 'no' && DATA_CATEGORIES.has(d.category) && (!mech || mech === 'none' || mech === 'unknown')) {
      add('replication-undefined', severityFor('replication-undefined', { tier: d.tier }),
        `No replication mechanism recorded — ${d.name}`,
        `${d.name} holds state (${d.category}) and is in scope, but nothing says HOW it arrives in the recovery region. Without a mechanism there is no RPO — only hope.`,
        d);
    }
  }

  if (!root.hasVerification) {
    add('missing-verification', severityFor('missing-verification', { tier: root.tier, isRoot: true }),
      `No verification defined — ${root.name}`,
      `There is no command that proves ${root.name} actually recovered. Every test of this service is a judgement call until there is one.`,
      root);
  }

  // 6. secrets are the number-one cause of failed recovery tests
  for (const c of [root, ...deps]) {
    for (const s of c.secrets) {
      if (s.replicated === 'yes') continue;
      add('unreplicated-secret', severityFor('unreplicated-secret', { tier: c.tier, replicated: s.replicated }),
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
      const sev = severityFor('manual-third-party-failover', { critical: call.critical, tier: root.tier });
      add('manual-third-party-failover', sev,
        `${call.critical ? 'Critical ' : ''}${call.type} call needs a human — ${label}`,
        call.failoverBehavior
          ? `${call.componentName} calls ${label} (${call.type}). Failover behavior: "${call.failoverBehavior}". Anything that needs a partner ticket or an allowlist change has lead time measured in days, not minutes — pre-register the recovery-region egress now.`
          : `${call.componentName} calls ${label} (${call.type}) and no failover behavior is recorded. Assume it breaks after failover until someone writes down why it doesn't.`,
        comp, { target: label, callType: call.type });
    }
    if (OUT_OF_SCOPE_RE.test(call.failoverBehavior) || OUT_OF_SCOPE_RE.test(call.purpose)) {
      add('outbound-target-out-of-scope', severityFor('outbound-target-out-of-scope', { critical: true, tier: root.tier }),
        `Outbound call to something that will not be there — ${label}`,
        `${call.componentName} calls ${label}; the recorded behavior is "${call.failoverBehavior || call.purpose}". Decide in writing whether ${root.name} can answer a real request without it.`,
        comp, { target: label });
    } else if (call.resolvedComponentId && call.resolvedScope && call.resolvedScope !== 'yes') {
      const undeclared = !closureIds.has(call.resolvedComponentId);
      add('outbound-target-out-of-scope', severityFor('outbound-target-out-of-scope', { critical: call.critical, tier: root.tier }),
        `Calls ${call.resolvedComponentName}, which ${inScopeWord[call.resolvedScope]}`,
        `${call.componentName} calls ${label} (${call.type}), matched to inventory component ${call.resolvedComponentName} (scope: ${call.resolvedScope}).${undeclared ? ` It is NOT listed as a dependency of ${root.name}, so it never appears in the recovery order.` : ''}`,
        { id: call.resolvedComponentId, name: call.resolvedComponentName },
        { target: label, undeclared });
    }
  }

  // 9. the live cutover in front of this service
  for (const e of manualEdge) {
    add('manual-cutover', severityFor('manual-cutover', { onPath: e.onPath, tier: root.tier }),
      `Live cutover is manual — ${e.component.name}`,
      `${e.component.name} (${e.component.restoreLayer || 'no layer'}${e.component.inRecoveryScope !== 'yes' ? `, scope: ${e.component.inRecoveryScope}` : ''}) `
      + `is a step that puts live traffic on the recovery region, and it is not automated: ${e.why} `
      + `Until someone does it by hand, a recovered ${root.name} serves no real users.`,
      e.component, { onPath: e.onPath });
  }

  // 10. no written procedure
  if (!runbooks.length) {
    add('no-runbook', severityFor('no-runbook', { tier: root.tier }),
      `No runbook covers ${root.name}`,
      `No runbook step references ${root.name} or anything in its dependency closure. In an event this service is recovered from memory, by whoever is awake.`,
      root);
  } else if (!runbooks.some((rb) => rb.stepsForService > 0)) {
    add('no-runbook', severityFor('no-runbook', { tier: root.tier, namesService: false }),
      `No runbook step names ${root.name}`,
      `${runbooks.length} runbook(s) touch this service's dependencies, but no step names ${root.name} itself — so nothing tells an operator how to bring it back or how to know it is back.`,
      root);
  }

  // 11 & 12. test coverage and what the last test measured
  const measuredTests = tests.filter((t) => t.status === 'passed' || t.status === 'failed');
  if (!tests.length) {
    add('no-test-coverage', severityFor('no-test-coverage', { tier: root.tier }),
      `${root.name} has never been in a recovery test`,
      'An untested recovery path is a hypothesis. Plan a component test or add this service to the next recovery test\'s app-test list.',
      root);
  } else if (!measuredTests.length) {
    add('no-test-coverage', severityFor('no-test-coverage', { tier: root.tier, anyTest: true }),
      `No completed test has covered ${root.name}`,
      `${tests.length} test(s) reference this service but none has a passed/failed result yet — its RTA and RPA are still unmeasured.`,
      root);
  } else if (!measuredTests.some((t) => t.status === 'passed')) {
    const last = measuredTests[0];
    add('test-failed', severityFor('test-failed', { tier: root.tier }),
      `Last test covering ${root.name} failed`,
      `${last.name} (${last.date || 'no date'}) failed${(last.findings || []).length ? `: ${last.findings[0].title}.` : '.'} This service has no passing recovery evidence, so it has no RTA — a failed run produced a time to FAILURE, not a recovery time. Nothing measured by that run may be quoted as achieved.`,
      root, { testId: last.id });
  }

  // 13 & 14. objectives vs what was actually MEASURED (never a typed number,
  // never a failed run — see server/lib/measured.js).
  const rpa = numbers.rpa;
  const rta = numbers.rta;
  const businessRpo = numbers.target.rpoMinutes;
  const mechanismRpo = numbers.target.mechanismRpoMinutes;
  if (rpa.state === 'measured' && businessRpo !== null && rpa.minutes > businessRpo) {
    add('rpo-gap', severityFor('rpo-gap', { tier: root.tier }),
      `Measured data loss exceeds the business RPO — ${rpa.minutes} min vs ${businessRpo} min`,
      `${rpa.test.name} (${rpa.test.date || 'no date'}) measured an RPA of ${rpa.minutes} minutes against the ${businessRpo}-minute BUSINESS objective. Recovery points that are not aligned across stores produce exactly this result. Align the recovery points or renegotiate the objective — those are the only two honest options.`,
      root, { testId: rpa.test.id });
  } else if (rpa.state === 'measured' && mechanismRpo !== null && rpa.minutes > mechanismRpo) {
    // Replication is not keeping its own promise. That is an engineering
    // problem, not a business breach — a different finding at a different
    // severity (audit R-1: spending 'blocker' on replication jitter is how
    // alert fatigue starts).
    add('replication-lag-exceeds-mechanism', severityFor('replication-lag-exceeds-mechanism', { tier: root.tier }),
      `Replication is slower than its own claim — measured ${rpa.minutes} min vs a ${mechanismRpo}-min mechanism RPO`,
      `${rpa.test.name} measured an RPA of ${rpa.minutes} minutes while ${root.replication.mechanism || 'the replication mechanism'} claims ${mechanismRpo} minutes. The business RPO (${businessRpo === null ? 'not set' : `${businessRpo} min`}) is not breached, so this is a replication-health finding, not a data-loss breach: check lag, snapshot cadence and sync-set alignment.`,
      root, { testId: rpa.test.id });
  }
  if (rta.state === 'measured' && numbers.target.rtoMinutes !== null && rta.minutes > numbers.target.rtoMinutes) {
    add('rta-gap', severityFor('rta-gap', { tier: root.tier }),
      `Measured recovery time exceeds the RTO — ${rta.minutes} min vs ${numbers.target.rtoMinutes} min`,
      `${rta.test.name} took ${rta.minutes} minutes to reach its success bar against a ${numbers.target.rtoMinutes}-minute objective.`,
      root, { testId: rta.test.id });
  }
  // 15. numbers are being carried in Settings that no passed test produced.
  // One finding, not one per metric — it is one defect with one fix.
  const declaredOnly = [['rtaMinutes', rta, 'RTA', 'recovery time'], ['rpaMinutes', rpa, 'RPA', 'data loss']]
    .filter(([, e]) => e.state === 'declared');
  if (declaredOnly.length) {
    const attempt = numbers.evidence.lastAttempt;
    const copied = attempt && attempt.status === 'failed'
      && declaredOnly.some(([, e]) => e.minutes === attempt.rtaMinutes || e.minutes === attempt.rpaMinutes);
    add('unverified-objective', severityFor('unverified-objective', { tier: root.tier }),
      `${declaredOnly.map(([, e, label]) => `${label} ${e.minutes} min`).join(' and ')} ${declaredOnly.length > 1 ? 'are' : 'is'} typed in Settings, not measured`,
      `${declaredOnly.map(([key, e]) => `workspace.objectives.${key} = ${e.minutes}`).join(', ')} — free number field(s) with no link to any test. `
      + `${copied ? `${attempt.rtaMinutes === null ? '' : ''}They match ${attempt.name} (${attempt.date || 'no date'}), which FAILED${attempt.cleanRun === false ? ' and was not a clean run' : ''} — and by this product's own definition a failed run has no RTA at all: the clock stops at the L6 success bar, which that run never reached. What it produced is a time to FAILURE. ` : ''}`
      + `Until a PASSED test that directly covers ${root.name} produces them, these must be shown as declared values — never as measured, achieved, met, or in green. `
      + 'DO THIS: leave the objectives as targets, record RTA/RPA on the test record itself, and let the tool read them from there.',
      root, {
        testId: null,
        aggregated: true,
        count: declaredOnly.length,
        items: declaredOnly.map(([key, e, label]) => ({
          componentId: root.id, componentName: root.name,
          title: `${label} ${e.minutes} min (declared)`, note: e.note, field: `objectives.${key}`,
        })),
      });
  }

  regionalRisks({ root, deps, closureIds, byId, numbers, graphNodes, k8sWorkloads, proof, regions, meta, staleAfterDays, tests }, add);

  out.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.title.localeCompare(b.title));
  return out;
}
/* eslint-enable complexity */

// -------------------------------------------- the regional failure modes
//
// Audit R-4/R-5: the rules above are strong on what the engine already knew and
// silent on the things that actually take a Tier-0 service down in a REGIONAL
// event. Each rule below is checkable from data the workspace already holds.
/* eslint-disable complexity */
function regionalRisks(ctx, add) {
  const { root, deps, closureIds, byId, numbers, graphNodes, k8sWorkloads, proof, regions, meta, staleAfterDays, tests } = ctx;
  const all = [root, ...deps];
  const inScope = all.filter((c) => c.inRecoveryScope !== 'no');
  const primary = str(regions?.primary);
  const recovery = str(regions?.recovery);
  const nodesFor = (types) => Object.values(graphNodes || {})
    .filter((n) => n && types.includes(str(n.type)) && arr(n.componentIds).some((id) => closureIds.has(str(id))));

  // --- R1. recovery-region quota / capacity headroom -----------------------
  // "the most likely real pilot-light failure": pilot light and warm standby
  // both assume the recovery region will SELL you the compute during a regional
  // event, when every other tenant is asking too.
  const strategy = lower(root.drStrategy === 'inherit' ? str(meta?.strategy) : root.drStrategy);
  const computeDeps = inScope.filter((c) => c.category === 'compute' || /eks|ecs|ec2|asg|node|fargate|lambda/i.test(c.kind));
  if (computeDeps.length && strategy !== 'active-active') {
    const state = proofState(proof, QUOTA_RE);
    if (state !== 'verified') {
      add('quota-capacity-unverified', severityFor('quota-capacity-unverified', { tier: root.tier }),
        `Recovery-region quota and capacity headroom is never verified${state === 'listed-not-done' ? ' (checklist item still open)' : ''}`,
        `${root.name} is a ${strategy || 'pilot-light'} stack: ${computeDeps.length} in-scope compute component(s) `
        + `(${computeDeps.slice(0, 3).map((c) => c.name).join(', ')}${computeDeps.length > 3 ? `, +${computeDeps.length - 3} more` : ''}) `
        + `must be scaled up in ${recovery || 'the recovery region'} during an event — at the same moment every other tenant is doing the same. `
        + `${state === 'listed-not-done'
          ? 'A checklist item exists for this but is not ticked, so nothing has actually been confirmed. '
          : 'No runbook step, checklist item or verification command checks it at all. '}`
        + `DO THIS: check Service Quotas in ${recovery || 'the recovery region'} for vCPU per instance family, EIPs, NAT gateways, EBS volume/IOPS totals and your RDS/EKS limits against FULL production load, not standby load; confirm the instance types you need are actually offered in the recovery AZs; and for Tier-0 capacity buy an On-Demand Capacity Reservation. Otherwise the first symptom is InsufficientInstanceCapacity while the dashboard is still green.`,
        root, { proofState: state });
    }
  }

  // --- R2. IRSA / OIDC trust on a recovered cluster ------------------------
  // A recovered or second EKS cluster has a DIFFERENT OIDC issuer URL, so every
  // IRSA role trust policy must already trust it or every pod silently loses
  // its AWS identity.
  const oidcNodes = nodesFor(['oidc-provider']);
  const irsaWorkloads = arr(k8sWorkloads).filter((w) => str(w.serviceAccount) && str(w.serviceAccount) !== 'default');
  const hasCluster = all.some((c) => /eks|kubernetes|k8s/i.test(`${c.kind} ${c.name}`)) || irsaWorkloads.length > 0;
  if ((oidcNodes.length || hasCluster) && proofState(proof, IRSA_RE) !== 'verified') {
    const issuer = oidcNodes.length ? str(oidcNodes[0].name || oidcNodes[0].rid) : '';
    add('irsa-oidc-trust', severityFor('irsa-oidc-trust', { tier: root.tier }),
      'Nothing checks that IRSA/OIDC trust follows the workload to the recovery region',
      `${irsaWorkloads.length ? `${irsaWorkloads.length} workload(s) behind ${root.name} run under a named ServiceAccount` : `${root.name} runs on a Kubernetes platform`}`
      + `${issuer ? `, and the IRSA trust anchor in the inventory is the PRIMARY-region issuer (${issuer})` : ''}. `
      + 'A recovered or second cluster gets a NEW OIDC issuer URL. Every IAM role trust policy still names the old one, so on recovery day every pod loses its AWS identity and fails to read secrets or S3 — with an opaque AccessDenied, not a message that says "wrong issuer". '
      + 'DO THIS: register the recovery cluster\'s OIDC provider in the account NOW, add its ARN + issuer condition as a second statement in every IRSA role trust policy, and add a runbook gate that assumes one of those roles FROM A POD in the recovery cluster (not from an admin shell — an admin proves nothing about the pod\'s identity).',
      root, { oidcNodes: oidcNodes.length, workloads: irsaWorkloads.length });
  }

  // --- R3. regional ACM certificate ----------------------------------------
  // A certificate is regional. A listener in the recovery region needs one
  // THERE (and CloudFront's must be in us-east-1).
  const facesPublic = all.some((c) => c.category === 'edge-dns' || c.endpoints.length > 0);
  if (facesPublic && primary) {
    const certs = Object.values(graphNodes || {}).filter((n) => str(n?.type) === 'certificate');
    const inRecovery = certs.filter((n) => str(n.region) === recovery);
    if (!inRecovery.length && proofState(proof, CERT_RE) !== 'verified') {
      const edge = all.filter((c) => c.category === 'edge-dns').map((c) => c.name);
      add('acm-cert-not-regional', severityFor('acm-cert-not-regional', { tier: root.tier }),
        `No certificate exists in ${recovery || 'the recovery region'} for the public path into ${root.name}`,
        `${certs.length ? `${certs.length} ACM certificate(s) are known and all of them live in ${primary}${certs[0]?.name ? ` (e.g. ${str(certs[0].name)})` : ''}.` : 'No ACM certificate is recorded in the recovery region.'} `
        + `ACM certificates are REGIONAL: a listener, API Gateway custom domain or ALB in ${recovery || 'the recovery region'} cannot use a ${primary} certificate${edge.length ? `, and ${edge.join(', ')} sit(s) on that path` : ''}. `
        + `DO THIS: request or import the certificate in ${recovery || 'the recovery region'} now (DNS validation, so it renews itself), attach it to the recovery-region listener/custom domain ahead of the event, and — if CloudFront fronts this — remember its certificate must be in us-east-1 regardless of where the origin is. A cert requested during the event needs DNS validation to propagate while you are down.`,
        root, { certsInPrimary: certs.length });
    }
  }

  // --- R4. single-region KMS key -------------------------------------------
  // "Replication of ciphertext you can't decrypt is a very durable form of data
  // loss." A single-region key cannot be converted after the fact.
  const kmsNodes = nodesFor(['kms-key']);
  const encryptedStores = inScope.filter((c) => DATA_CATEGORIES.has(c.category) || c.secrets.length);
  const singleRegionKeys = kmsNodes.filter((n) => n?.details?.multiRegion !== true && !/^mrk-/i.test(str(n.rid)) && !/mrk-/i.test(str(n.arn)));
  // The "we cannot tell" branch only fires where a key demonstrably matters —
  // a secret store, a component holding secrets, or data that arrives by
  // snapshot/backup COPY (the case where the destination must decrypt). Firing
  // it on every cache in the estate would be exactly the noise this pass exists
  // to remove, and it is reported at a lower severity because "unproven" is not
  // the same finding as "proven wrong".
  const keyMatters = encryptedStores.filter((c) => c.category === 'security-secrets'
    || c.secrets.length
    || /snapshot|backup|restore|copy|replica/i.test(`${c.replication.mechanism} ${c.replication.notes}`));
  if (encryptedStores.length && (singleRegionKeys.length || (!kmsNodes.length && keyMatters.length && proofState(proof, KMS_RE) === 'none'))) {
    const named = singleRegionKeys.slice(0, 3).map((n) => str(n.name || n.rid));
    add('kms-single-region-key', singleRegionKeys.length ? severityFor('kms-single-region-key', { tier: root.tier }) : 'medium',
      singleRegionKeys.length
        ? `${singleRegionKeys.length} encryption key(s) behind ${root.name} are not multi-region`
        : `Nothing proves the encryption keys behind ${root.name} are multi-region`,
      `${(singleRegionKeys.length ? encryptedStores : keyMatters).length} in-scope component(s) hold encrypted state that has to be readable in the recovery region (${(singleRegionKeys.length ? encryptedStores : keyMatters).slice(0, 3).map((c) => c.name).join(', ')}${(singleRegionKeys.length ? encryptedStores : keyMatters).length > 3 ? ', …' : ''}). `
      + `${singleRegionKeys.length ? `These keys are single-region: ${named.join(', ')}. ` : 'No KMS key in the resource graph is marked multi-region and no check proves otherwise. '}`
      + 'A single-region KMS key CANNOT be converted to a multi-region key after the fact, and a cross-region restore of data encrypted with it will not decrypt — replication of ciphertext you cannot decrypt is a very durable form of data loss. '
      + `DO THIS: create multi-region keys (or a documented re-encryption path) and re-encrypt the affected snapshots/objects/secrets BEFORE the next test, then add a decrypt probe in ${recovery || 'the recovery region'} to the L0 gate — an actual kms:Decrypt from the workload's own role, not a describe-key.`,
      root, { keys: named, total: singleRegionKeys.length });
  }

  // --- R5. ARNs pinned to the primary region -------------------------------
  // "The single most common wiring failure" — and the field exists so the audit
  // is a query, not a grep marathon. This is that query.
  if (primary) {
    // Two classes, and conflating them would be the same sin the audit found.
    //   config   — a VALUE something resolves at runtime (a secret ARN an app
    //              looks up, an endpoint URL it dials). These do not fail over.
    //   identity — the ARN of the primary-region resource itself. That is a
    //              fact, not a defect; it is a list to audit for config that
    //              points at it, not a list of bugs.
    const config = [];
    const identity = [];
    for (const c of all) {
      const raw = byId.get(c.id) || {};
      if (pinnedToPrimary(raw.arn, primary)) {
        identity.push({ componentId: c.id, componentName: c.name, where: 'component.arn', value: str(raw.arn), class: 'identity' });
      }
      for (const s of c.secrets) {
        if (pinnedToPrimary(s.arn, primary)) config.push({ componentId: c.id, componentName: c.name, where: `secret '${s.name}' arn`, value: str(s.arn), class: 'config' });
      }
      for (const e of c.endpoints) {
        for (const [what, v] of [['url', e.url], ['health check', e.healthCheck]]) {
          if (pinnedToPrimary(v, primary)) config.push({ componentId: c.id, componentName: c.name, where: `endpoint '${e.name}' ${what}`, value: str(v), class: 'config' });
        }
      }
    }
    for (const n of Object.values(graphNodes || {})) {
      if (!n || !arr(n.componentIds).some((id) => closureIds.has(str(id))) || !pinnedToPrimary(n.arn, primary)) continue;
      // A trust anchor, key or certificate ARN is referenced BY configuration,
      // so it is the list you grep your config against.
      identity.push({ componentId: null, componentName: str(n.name || n.rid), where: `resource-graph ${str(n.type)}`, value: str(n.arn), class: 'identity' });
    }
    const items = [...config, ...identity];
    // A Secrets Manager / KMS / certificate / role ARN is the exact thing
    // applications hard-code, so its presence keeps this at full severity even
    // when no inventory field has been filled in yet.
    const sensitive = identity.filter((h) => /secret|kms|certificate|oidc-provider|iam-role/i.test(h.where));
    if (items.length) {
      const sev = (config.length || sensitive.length) ? severityFor('arn-pinned-to-primary', { tier: root.tier }) : 'medium';
      add('arn-pinned-to-primary', sev,
        config.length
          ? `${config.length} configured ARN${config.length > 1 ? 's' : ''} resolve${config.length > 1 ? '' : 's'} to ${primary} and will not fail over`
          : `${identity.length} ARNs behind this service name ${primary}${sensitive.length ? ` — including ${sensitive.length} secret/key/identity ARN${sensitive.length > 1 ? 's' : ''}` : ''} — audit what points at them`,
        `A full ARN that names ${primary} does not fail over: it keeps resolving into the dead region, and the symptom is AccessDenied or a timeout that looks like anything except "wrong region". The knowledge base calls this the single most common wiring failure, and the arn fields exist so the audit is a query rather than a grep marathon — this IS that query. `
        + `${config.length ? `FIX THESE FIRST (${config.length} configured value${config.length > 1 ? 's' : ''}): ${config.slice(0, 4).map((h) => `${h.componentName} → ${h.where}`).join('; ')}${config.length > 4 ? `; +${config.length - 4} more` : ''}. ` : 'No configured secret ARN or endpoint URL in this service names the primary region — good. '}`
        + `${identity.length ? `${identity.length} primary-region resource ARN(s) are recorded (e.g. ${identity.slice(0, 3).map((h) => h.where).join(', ')}). Those are facts, not defects — the job is to grep your application config, IaC and IAM policies for them, because anything that hard-codes one has the same failure. ` : ''}`
        + 'DO THIS: resolve secrets and parameters by NAME — a Secrets Manager replica keeps the same name, which is exactly why name-based lookup fails over and ARN-based lookup does not — and make the region a deploy-time variable, not a literal.',
        root, { aggregated: true, count: items.length, items, configHits: config.length, identityHits: identity.length });
    }
  }

  // --- R6. layer inversions -------------------------------------------------
  // The L0→L7 order IS the recovery order, so a dependency at a LATER layer than
  // its consumer is an order the tool prints and an operator follows.
  const inversions = [];
  for (const c of all) {
    for (const depId of c.dependsOn) {
      const target = byId.get(depId);
      if (!target) continue;
      const cr = layerRank(c.restoreLayer);
      const dr = layerRank(str(target.restoreLayer));
      if (cr === 99 || dr === 99 || dr <= cr) continue;
      inversions.push({
        componentId: c.id, componentName: c.name,
        where: `${c.restoreLayer} → ${str(target.restoreLayer)}`,
        note: `${c.name} (${c.restoreLayer}) depends on ${str(target.name) || depId} (${str(target.restoreLayer)})`,
      });
    }
  }
  if (inversions.length) {
    add('layer-inversion', severityFor('layer-inversion', { tier: root.tier }),
      `${inversions.length} layer inversion${inversions.length > 1 ? 's' : ''} in this service's restore order`,
      `${inversions.map((i) => i.note).join('; ')}. The L0→L7 layers ARE the recovery order: every diagram, the workbook's prerequisite list and the drafted plan sort on them. An inversion tells the operator to bring something up BEFORE the thing it declares a dependency on — at 3am that is a wasted cycle at best and an L4 symptom of an L3 cause at worst. `
      + 'DO THIS: either the edge is wrong (drop it) or the layer is wrong (move the prerequisite earlier). Do not leave it for the operator to notice.',
      root, { aggregated: true, count: inversions.length, items: inversions });
  }

  // --- R7. dangling dependsOn ids ------------------------------------------
  // localClosure() silently drops ids that are not in the inventory and the
  // route has returned them since day one. Nobody read them.
  const dangling = [];
  for (const c of all) {
    for (const depId of c.dependsOn) {
      if (!byId.has(depId)) dangling.push({ componentId: c.id, componentName: c.name, where: depId, note: `${c.name} → '${depId}' (no such component)` });
    }
  }
  if (dangling.length) {
    add('dangling-dependency', severityFor('dangling-dependency', { tier: root.tier }),
      `${dangling.length} dependency id${dangling.length > 1 ? 's' : ''} point${dangling.length > 1 ? '' : 's'} at nothing — a HOLE in this service's restore order`,
      `${dangling.map((d) => d.note).join('; ')}. The closure walk drops ids it cannot resolve, so the tool reports a CLEAN, SHORTER recovery order with no warning — which is the most dangerous possible output. `
      + 'A renamed or deleted component leaves an invisible hole: nothing tells the operator that something used to be there. '
      + 'DO THIS: restore the component, repoint the id, or delete the stale edge — but decide, because right now the recovery order is silently incomplete.',
      root, { aggregated: true, count: dangling.length, items: dangling });
  }

  // --- R8. stale evidence ---------------------------------------------------
  // Nothing decays today: one passed test leaves a green tile forever, against
  // the product's own "findings expire" and quarterly cadence.
  const lastPassed = numbers.evidence.lastPassedTest;
  const staleEntry = [numbers.rta, numbers.rpa].find((e) => e.state === 'measured' && e.stale);
  if (staleEntry) {
    add('stale-evidence', severityFor('stale-evidence', { tier: root.tier }),
      `The evidence behind ${root.name}'s numbers is ${staleEntry.staleDays} days old`,
      `${staleEntry.test.name} (${staleEntry.test.date}) is the most recent passed test that directly covers ${root.name}, and it is ${staleEntry.staleDays} days old against a ${staleAfterDays}-day freshness threshold. `
      + 'Findings expire and estates drift: a number measured before the last three platform changes describes a system that no longer exists. The number stays MEASURED — it was — but it is no longer current, and it should not be quoted to an auditor or an exec without a re-test. '
      + 'DO THIS: schedule the next test (Tier-0 cadence is quarterly) and treat the current tile as caution, not green.',
      root, { testId: staleEntry.test.id, staleDays: staleEntry.staleDays, staleAfterDays });
  } else if (lastPassed && !numbers.rta.stale && numbers.rta.state !== 'measured' && tests.length) {
    // A passing test exists but produced no numbers at all — worth one line,
    // not a severity escalation.
    add('stale-evidence', 'low',
      `${root.name} has a passing test but no measured RTA/RPA`,
      `${lastPassed.name} (${lastPassed.date || 'no date'}) passed and directly covers ${root.name}, but recorded no RTA or RPA. A test without T0/T1 timestamps proves the path works and measures nothing — record the clock next time, because the clock is what the objectives are judged against.`,
      root, { testId: lastPassed.id });
  }
}
/* eslint-enable complexity */

// --------------------------------------------------- de-noising the risk list
//
// Audit R-2 (alert fatigue): `missing-verification` was 37% of one service's 19
// risks — 7 identical medium findings, one per dependency. A list where a third
// of the rows say the same thing trains the reader to skim, and losing signal to
// noise is itself a defect. So: repeated same-rule findings collapse into ONE
// risk that carries the count and the list, ranking puts what actually blocks
// recovery on top, and the full unfolded list stays available as `risksAll`.
const COLLAPSE_AT = 3;   // more than this many of one rule+severity -> collapse
const MAX_SHOWN = 24;    // blockers are never suppressed by this cap

function rankOf(x) {
  return sevRank(x.severity) * 1000
    + (x.blocksRecovery ? 0 : 100)
    + Math.min(9, (x.tier === null || x.tier === undefined ? 9 : Number(x.tier))) * 10;
}

function collapseTitle(rule, group) {
  const names = group.map((g) => g.componentName).filter(Boolean);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  const n = group.length;
  switch (rule) {
    case 'missing-verification': return `${n} components have no verification command: ${shown}${more}`;
    case 'unreplicated-secret': return `${n} secrets are not confirmed present in the recovery region: ${group.map((g) => str(g.secret)).filter(Boolean).slice(0, 3).join(', ')}${group.length > 3 ? ` and ${group.length - 3} more` : ''}`;
    case 'dependency-out-of-scope': return `${n} dependencies are not fully in the recovery scope: ${shown}${more}`;
    case 'unlayered-dependency': return `${n} dependencies have no restore layer: ${shown}${more}`;
    case 'replication-undefined': return `${n} stateful components have no replication mechanism recorded: ${shown}${more}`;
    case 'outbound-target-out-of-scope': return `${n} outbound calls target something that may not be there: ${group.map((g) => str(g.target)).filter(Boolean).slice(0, 3).join(', ')}${more}`;
    case 'manual-cutover': return `${n} live-cutover steps in front of this service are manual: ${shown}${more}`;
    default: return `${n} × ${rule}: ${shown}${more}`;
  }
}

function denoise(findings) {
  const byBucket = new Map();
  for (const f of findings) {
    const key = `${f.rule}|${f.severity}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(f);
  }
  const shown = [];
  let collapsed = 0;
  for (const [key, group] of byBucket) {
    const [rule, severity] = key.split('|');
    // Never fold blockers together: each one is an individual thing that stops
    // the program, and the reader is meant to act on each.
    if (severity === 'blocker' || group.length <= COLLAPSE_AT || group[0].aggregated) {
      shown.push(...group);
      continue;
    }
    collapsed += group.length;
    const worst = group[0];
    shown.push({
      ...worst,
      title: collapseTitle(rule, group),
      detail: `${group.length} components share this finding, so it is shown once instead of ${group.length} times.\n\n`
        + `${group.map((g) => `• ${g.componentName || '(workspace)'} — ${g.title}`).join('\n')}\n\n`
        + `What to do: ${worst.detail}`,
      componentId: null,
      componentName: '',
      aggregated: true,
      count: group.length,
      items: group.map((g) => ({
        componentId: g.componentId, componentName: g.componentName,
        title: g.title, severity: g.severity, note: g.detail,
      })),
    });
  }
  shown.sort((a, b) => rankOf(a) - rankOf(b) || a.title.localeCompare(b.title));
  shown.forEach((x, i) => { x.rank = i + 1; });
  const capped = shown.length > MAX_SHOWN
    ? [...shown.filter((x) => x.severity === 'blocker'),
      ...shown.filter((x) => x.severity !== 'blocker').slice(0, Math.max(0, MAX_SHOWN - shown.filter((x) => x.severity === 'blocker').length))]
    : shown;
  return { shown: capped, collapsed, suppressed: shown.length - capped.length };
}

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

    // ---- posture: objectives vs what was actually MEASURED ------------------
    // Every number here comes from server/lib/measured.js. This route no longer
    // decides for itself what "measured" means: a number is measured only when a
    // PASSED test that DIRECTLY covers this service produced it. A failed run
    // has no RTA (it has a time to failure) and a number typed in Settings is
    // declared, never achieved. Contract: docs/measured-numbers.md.
    const staleAfterDays = staleAfterDaysFor(meta);
    const numbers = measuredNumbers(meta, allTests, rootId, {
      components,
      component: rootRaw,
      runbooks: allRunbooks,
      closureIds,
      staleAfterDays,
    });
    const rtoMet = numbers.verdict.rto === 'unknown' ? null : numbers.verdict.rto === 'met';
    const rpoMet = numbers.verdict.rpo === 'unknown' ? null : numbers.verdict.rpo === 'met';
    const measuredEvidence = (numbers.rta.state === 'measured' || numbers.rpa.state === 'measured')
      ? {
        // The provenance of whichever number is measured. Both come from the
        // same test in the ordinary case; when they don't, rta/rpa in
        // `posture.numbers` each carry their own.
        id: (numbers.rta.test || numbers.rpa.test).id,
        name: (numbers.rta.test || numbers.rpa.test).name,
        date: (numbers.rta.test || numbers.rpa.test).date,
        status: (numbers.rta.test || numbers.rpa.test).status,
        rtaMinutes: numbers.rta.state === 'measured' ? numbers.rta.minutes : null,
        rpaMinutes: numbers.rpa.state === 'measured' ? numbers.rpa.minutes : null,
        cleanRun: (numbers.rta.test || numbers.rpa.test).cleanRun,
        covers: 'direct',
        stale: !!(numbers.rta.stale || numbers.rpa.stale),
        staleDays: numbers.rta.staleDays ?? numbers.rpa.staleDays,
      }
      : null;
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
        rtoMinutes: numbers.target.rtoMinutes, rpoMinutes: numbers.target.rpoMinutes,
        approved: numbers.target.approved,
      },
      // The BUSINESS objective is what a verdict is judged against (audit R-1 /
      // H-5). The component's replication.rpoMinutes is a mechanism capability
      // and is reported separately as an engineering detail.
      targetRpoMinutes: numbers.target.rpoMinutes,
      rpoSource: 'business',
      mechanismRpoMinutes: numbers.target.mechanismRpoMinutes,
      // `measured` is now null unless there really is measured evidence.
      measured: measuredEvidence,
      rtoMet,
      rpoMet,
      verdict: numbers.verdict.overall === 'unknown' ? 'unmeasured' : numbers.verdict.overall,
      verdictDetail: numbers.verdict,
      // Additive: everything a page/export/AI context needs to render honestly.
      numbers,
      declared: { rtaMinutes: num(meta?.objectives?.rtaMinutes), rpaMinutes: num(meta?.objectives?.rpaMinutes) },
      lastAttempt: numbers.evidence.lastAttempt,
      staleAfterDays,
      warnings: numbers.warnings,
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

    const proof = buildProof(allRunbooks, store.getCollection(slug, 'checklists'), [root, ...deps]);
    const risksAll = computeRisks({
      root, deps, calls: outboundCalls, runbooks, tests, posture, meta, manualEdge, closureIds,
      byId, numbers, graphNodes: graph.nodes, k8sWorkloads, proof,
      regions: meta.regions || {}, staleAfterDays,
    });
    const { shown: risks, collapsed, suppressed } = denoise(risksAll);
    const riskCounts = risks.reduce((acc, x) => {
      acc[x.severity] = (acc[x.severity] || 0) + 1;
      return acc;
    }, {});
    const riskSummary = {
      total: risksAll.length,
      shown: risks.length,
      collapsed,
      suppressed,
      byRule: risksAll.reduce((a, x) => { a[x.rule] = (a[x.rule] || 0) + 1; return a; }, {}),
      bySeverity: risksAll.reduce((a, x) => { a[x.severity] = (a[x.severity] || 0) + 1; return a; }, {}),
      note: collapsed
        ? `${collapsed} findings sharing a rule were folded into single rows so the list stays actionable; every finding is in risksAll.`
        : 'No findings needed folding.',
    };

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
      risksAll,
      riskSummary,
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
        risksAll: risksAll.length,
        risksShown: risks.length,
        risksBySeverity: riskCounts,
        risksAllBySeverity: riskSummary.bySeverity,
        weakLinks: risks.filter((x) => x.severity === 'blocker' || x.severity === 'high').length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

export default r;
