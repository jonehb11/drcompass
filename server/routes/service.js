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

// Audit R-3: a component can hold state without being categorised as data. A
// StatefulSet with a PVC, a Kafka/OpenSearch cluster, an EBS-backed instance and
// a metrics store all keep bytes that a category label does not mention. These
// are the things whose "replication mechanism" must describe BYTES, not shape.
const STATEFUL_KIND_RE = /\b(statefulset|kafka|msk|zookeeper|opensearch|elasticsearch|solr|mongo|cassandra|scylla|clickhouse|couch|neo4j|neptune|documentdb|timestream|influx|prometheus|thanos|mimir|loki|victoria ?metrics|rabbitmq|activemq|amazon ?mq|artemis|etcd|consul|vault|jenkins|gitlab|nexus|artifactory|sftp|nfs|efs|fsx|ebs|volume|disk|datastore|ledger|database|db\b)/i;
// Mechanisms that rebuild the SHAPE of a thing and say nothing about its BYTES.
// The product's own shape-vs-bytes split: re-applying Terraform gives you an
// empty cluster, not the data that was in it.
const SHAPE_ONLY_MECH_RE = /^(iac|iac-gitops|gitops|terraform|terragrunt|cloudformation|cdk|helm|rebuild|redeploy|recreate|manual|n\/a|na|none-needed)$/i;
const STATEFUL_GRAPH_TYPES = new Set([
  'ebs-volume', 'volume', 'efs-filesystem', 'file-system', 'fsx-filesystem',
  'db-instance', 'db-cluster', 'snapshot', 'backup-vault',
]);
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
// Audit R-7: this is a fuzzy match, and a wrong attribution produces a WRONG
// SENTENCE ABOUT A REAL RISK — the most expensive kind of wrong. "pricing"
// matches pricing-service, the pricing Aurora cluster and the pricing cache. So
// the resolver no longer returns a bare id: it returns the match, why it
// matched, what else it could have been, and a confidence that the risk rules
// are required to respect (a low-confidence match can never drive a
// high-severity row — see RISK_SEVERITY['outbound-target-out-of-scope']).
//
//   high   — the target names the component: exact name match, or the name is
//            contained in the target and they share 2+ words, with no rival.
//   medium — a strong but not decisive name match, or an exact match on a
//            specific (non-generic) kind/service, or a 'high' with a rival.
//   low    — matched only through a generic service word ("redis", "sqs"), or
//            several components match equally well. Confirm before acting.
const GENERIC_MATCH_KEYS = new Set([
  'ec2', 'ecs', 'eks', 'rds', 'sqs', 'sns', 'iam', 'kms', 'vpc', 'acm', 'ecr', 's3', 'efs',
  'lambda', 'api gateway', 'apigateway', 'secrets manager', 'cloudfront', 'route 53', 'route53',
  'elasticache', 'redis', 'memcached', 'kinesis', 'aurora', 'postgres', 'mysql', 'dynamodb',
  'opensearch', 'elasticsearch', 'kafka', 'msk', 'database', 'cache', 'queue', 'stream',
  'storage', 'bucket', 'cluster', 'service', 'external', 'observability', 'eks workload',
]);

function targetResolver(components) {
  const normalize = (s) => lower(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const index = [];
  for (const c of arr(components)) {
    const push = (key, source, base) => {
      const k = normalize(key);
      if (k.length >= 4) index.push({ id: c.id, name: str(c.name), key: k, source, base });
    };
    push(c.name, 'name', 30);
    push(c.kind, 'kind', 20);
    for (const [i, s] of arr(c.awsServices).entries()) push(s, 'aws-service', i === 0 ? 15 : 10);
  }
  return (target, fromId) => {
    const t = normalize(target);
    if (!t) return null;
    const tTokens = t.split(' ').filter(Boolean);
    const scored = [];
    for (const cand of index) {
      if (cand.id === fromId) continue;
      const kTokens = cand.key.split(' ').filter(Boolean);
      const shared = kTokens.filter((x) => tTokens.includes(x) && x.length >= 3).length;
      const exact = cand.key === t;
      const contained = t.includes(cand.key) || cand.key.includes(t);
      // A loose word overlap has to cover most of BOTH strings to count.
      // Without this, "Kinesis claim stream" matches the S3 claim-report
      // bucket on {claim, stream} and the engine writes a confident,
      // specific, wrong sentence about the wrong component.
      const overlap = shared >= 2 && (shared / kTokens.length) >= 0.4 && (shared / tTokens.length) >= 0.5;
      if (!exact && !contained && !overlap) continue;
      scored.push({
        ...cand,
        exact,
        contained,
        shared,
        // Containment beats a loose word overlap; an exact hit beats both; the
        // source class (name > kind > service) dominates all of it, so a
        // component that merely LISTS "Secrets Manager" in awsServices can
        // never outrank the component that IS Secrets Manager.
        score: cand.base + (exact ? 5 : 0) + (contained ? 0 : -6) + Math.min(4, shared),
      });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score || b.key.length - a.key.length);
    // Corroboration: a component that matches on its name AND its kind (or its
    // service list) is a much better bet than one that matches on a name alone.
    // This is what separates the Kinesis stream from the queue whose name also
    // happens to contain "claim stream".
    const bySource = new Map();
    for (const s of scored) {
      if (!bySource.has(s.id)) bySource.set(s.id, new Set());
      bySource.get(s.id).add(s.source);
    }
    for (const s of scored) s.score += bySource.get(s.id).size > 1 ? 3 : 0;
    scored.sort((a, b) => b.score - a.score || b.key.length - a.key.length);
    const best = scored[0];
    const rivals = [...new Map(scored.filter((s) => s.id !== best.id && s.score > best.score - 2)
      .map((s) => [s.id, s])).values()];

    let confidence;
    if (best.source === 'name' && (best.exact || (best.contained && best.shared >= 2))) confidence = 'high';
    else if (best.source === 'name' || (best.exact && !GENERIC_MATCH_KEYS.has(best.key))) confidence = 'medium';
    else confidence = 'low';
    if (rivals.length) confidence = confidence === 'high' ? 'medium' : 'low';

    return {
      id: best.id,
      confidence,
      score: best.score,
      matchedOn: `${best.source} "${best.key}"`,
      why: best.exact
        ? `the call target matches this component's ${best.source} exactly`
        : best.contained
          ? `the call target and this component's ${best.source} contain one another`
          : `the call target shares ${best.shared} word(s) with this component's ${best.source}`,
      alternatives: rivals.map((rv) => ({ id: rv.id, name: rv.name, matchedOn: `${rv.source} "${rv.key}"` })),
    };
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

// Which components demonstrably hold persistent state? Evidence only — a
// StatefulSet or a PVC in the cluster snapshot, a volume/filesystem in the
// resource graph, or a kind/service that IS a stateful engine. A description
// that says "stores claims" is prose and is deliberately not read here.
function statefulIndex(components, snapshot, graphNodes) {
  const reasons = new Map();
  const note = (id, why) => {
    if (!id) return;
    if (!reasons.has(id)) reasons.set(id, why);
  };
  const workloads = arr(snapshot?.workloads);
  const byUid = new Map(workloads.map((w) => [str(w?.uid), w]));
  for (const w of workloads) {
    if (lower(w?.kind) === 'statefulset') note(str(w.componentId), `a StatefulSet (${str(w.namespace)}/${str(w.name)}) in the cluster snapshot`);
  }
  for (const pvc of arr(snapshot?.pvcs)) {
    const w = byUid.get(str(pvc?.boundTo));
    if (w) note(str(w.componentId), `a PersistentVolumeClaim (${str(pvc.namespace)}/${str(pvc.name)}${pvc.size ? `, ${str(pvc.size)}` : ''}) bound to ${str(w.kind)} ${str(w.name)}`);
  }
  for (const n of Object.values(graphNodes || {})) {
    if (!n || !STATEFUL_GRAPH_TYPES.has(str(n.type))) continue;
    for (const id of arr(n.componentIds)) note(str(id), `a ${str(n.type)} (${str(n.name || n.rid)}) in the resource graph`);
  }
  for (const c of arr(components)) {
    const hay = `${str(c?.kind)} ${arr(c?.awsServices).map(str).join(' ')} ${arr(c?.tags).map(str).join(' ')}`;
    const m = STATEFUL_KIND_RE.exec(hay);
    if (m) note(str(c.id), `it is a ${m[0]} — a stateful engine`);
  }
  return reasons;
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
    byId, numbers, graphNodes, k8sWorkloads, proof, regions, staleAfterDays, stateful,
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
  }

  // 5. in scope, holds state, and nothing says how the STATE gets there.
  // Audit R-3: driven off evidence of persistent state, not off the category
  // label — a StatefulSet with a PVC, a Kafka broker or a search cluster holds
  // data whether or not someone typed 'database' in a dropdown.
  for (const c of [root, ...deps]) {
    if (c.inRecoveryScope === 'no') continue;
    const mech = lower(c.replication.mechanism);
    const isData = DATA_CATEGORIES.has(c.category);
    const statefulWhy = stateful.get(c.id) || null;
    if (!isData && !statefulWhy) continue;
    const undefinedMech = !mech || mech === 'none' || mech === 'unknown';
    // For something already labelled as data, "rebuild" is a recorded decision
    // and is left alone (its consequence is the cache rule below). For a
    // component whose state we INFERRED, a shape-only mechanism is the finding:
    // re-applying Terraform gives you an empty cluster.
    const shapeOnly = !isData && !!statefulWhy && SHAPE_ONLY_MECH_RE.test(mech);
    if (!undefinedMech && !shapeOnly) continue;
    add('replication-undefined', severityFor('replication-undefined', { tier: c.tier }),
      shapeOnly
        ? `State with a shape-only recovery mechanism — ${c.name}`
        : `No replication mechanism recorded — ${c.name}`,
      shapeOnly
        ? `${c.name} is categorised '${c.category}', but it holds persistent state: ${statefulWhy}. Its recorded mechanism is '${c.replication.mechanism}', which rebuilds the SHAPE of the thing and says nothing about the BYTES inside it — re-applying IaC gives you an empty one. `
          + 'That is fine if the data is genuinely disposable, and a silent data-loss event if it is not (log and metric retention is the usual casualty: it is the evidence the post-incident review runs on). '
          + `DO THIS: decide out loud — either record a real data mechanism for ${c.name} (snapshot copy, replication, re-ingest from source) or write "state is disposable" in the replication notes so the next reader knows it was a decision and not an oversight.`
        : `${c.name} ${isData ? `holds state (${c.category})` : `holds persistent state — ${statefulWhy}`} and is in scope, but nothing says HOW it arrives in the recovery region. Without a mechanism there is no RPO — only hope.`,
      c, { statefulEvidence: statefulWhy, mechanism: c.replication.mechanism });
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
      // Audit R-7: this whole finding rests on a fuzzy name match. A low
      // confidence one is reported a step down and phrased as a question, not
      // an assertion, because a wrong attribution here is a confident, specific,
      // WRONG sentence about a real risk.
      const conf = call.resolvedConfidence || 'low';
      const alts = arr(call.resolvedAlternatives);
      add('outbound-target-out-of-scope',
        severityFor('outbound-target-out-of-scope', { critical: call.critical, tier: root.tier, confidence: conf }),
        conf === 'low'
          ? `Possible match: calls ${label}, which may be ${call.resolvedComponentName} — ${inScopeWord[call.resolvedScope]} (CONFIRM)`
          : `Calls ${call.resolvedComponentName}, which ${inScopeWord[call.resolvedScope]}`,
        `${call.componentName} calls ${label} (${call.type}), matched to inventory component ${call.resolvedComponentName} (scope: ${call.resolvedScope}).${undeclared ? ` It is NOT listed as a dependency of ${root.name}, so it never appears in the recovery order.` : ''} `
        + `Match confidence: ${conf.toUpperCase()} — ${call.resolvedWhy || 'name similarity'} (${call.resolvedMatchedOn || 'name'}).`
        + `${alts.length ? ` It could also be ${alts.map((a) => `${a.name} (${a.matchedOn})`).join(' or ')}.` : ''}`
        + `${conf === 'low'
          ? ' CONFIRM THE TARGET FIRST: this row is held one severity below where the fact itself would sit, because acting on a mis-attributed call wastes the time of whoever chases it. Name the real component on the outbound call (or add it as a dependency) and the finding will re-rank itself.'
          : ''}`,
        { id: call.resolvedComponentId, name: call.resolvedComponentName },
        {
          target: label,
          undeclared,
          confidence: conf,
          matchedOn: call.resolvedMatchedOn,
          alternatives: alts,
          needsConfirmation: conf === 'low',
        });
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
  failoverPathRisks(ctx, add);

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

// ------------------------------------------ the failover path's own failures
//
// Audit R-5 (the longer list). Four modes that take a Tier-0 service down on the
// day, none of which the engine could see:
//
//   runbook-without-rollback                  — a one-way door
//   control-plane-dependency-in-failover-path — the plan needs what just died
//   scheduler-double-run                      — two writers after the flip
//   cache-cold-start-load                     — the herd lands on a cold store
//
// All four read only CHECKED fields — a runbook step's title/command/verify/pass,
// a checklist item's text + proof, a component's verification command. None of
// them reads a description, a step `detail` or a replication note: a rule that
// can be satisfied by prose is satisfied by exactly the documents that produced
// the audit finding in the first place.

// Only the executable half of a step. `detail` is prose and is never read.
const checkedText = (s) => [s?.title, s?.command, s?.verify, s?.pass].map(str).join(' \n ');

// Forward hazards: the two things that make a runbook a one-way door.
const TRAFFIC_MOVE_RE = /\b(cut ?over|flip (the )?dns|dns flip|change-resource-record-sets|update-health-check|routing[- ]control|update-routing-control-state|shift (live )?traffic|move (live )?traffic|weighted (record|routing)|failover record|traffic (flip|switch)|start-plan-execution|update-distribution|switch (public )?dns)\b/i;
const DATA_PROMOTE_RE = /\b(promote|promotion|failover-global-cluster|failover-db-cluster|force-failover|promote-read-replica|writer endpoint|fail (the )?[a-z0-9-]+ over|failover the|global cluster over|make .* (the )?(writer|primary))\b/i;
// A rollback is real when it names an ACTION that returns the thing that moved.
// "Revert if needed" is not a rollback; neither is an end state with no verb.
const RETURN_TRAFFIC_RE = /\b(flip [^.]*back|switch [^.]*back|point [^.]*back|revert (the )?(dns|record|weight|routing|traffic)|restore (the )?(previous|original|prior) (dns|record|routing|weight)|re-?enable (the )?primary|fail ?back|weight[^.]*\b(100|0)\b[^.]*primary|reverse (the )?(dns|traffic|cutover))\b/i;
const RETURN_DATA_RE = /\b(fail ?back|switch ?back|switchover-global-cluster|switchover [^.]*back|demote|re-?promote|promote [^.]*(primary|original)|reverse (the )?replication|re-?point (the )?(writer|primary)|restore (the )?(original|old|previous) (primary|writer)|return (the )?(writer|primary)|writer [^.]*back (in|to))\b/i;

// Control-plane classes. Each one is the failover depending on something the
// failover scenario may itself have taken out.
const CI_CONTROL_PLANE_RE = /\b(jenkins|gh workflow run|gh run |github actions|gitlab-ci|glab |argocd (app )?(sync|rollback)|flux reconcile|circleci|buildkite|spinnaker|codepipeline|codebuild|terraform cloud|atlantis|octopus deploy|harness)\b/i;
const GLOBAL_CONTROL_PLANE_RE = /\b(change-resource-record-sets|route53 (create|change|update|delete)|route53domains|cloudfront (create|update)-|acm request-certificate|iam (create|put|attach|update|delete)-|organizations (create|update)-)\b/i;
const SSO_RE = /\b(aws sso login|aws configure sso|sso[- ]?(profile|login|session)|\bsso\b|okta|onelogin|ping ?(federate|identity)|azure ?ad|entra|jumpcloud|duo security|saml|identity provider|\bidp\b|\bvpn\b)\b/i;
const BREAK_GLASS_RE = /\b(break ?-?glass|breakglass|emergency (access|credential)|root (account )?credential|offline (access )?key|out-of-band (access|credential)|sealed envelope|standing (local )?iam user|backup iam user|emergency iam)\b/i;
const BASTION_RE = /\b(bastion|jump ?(host|box)|jumpbox|ssm start-session)\b/i;
const ARTIFACT_KIND_RE = /\b(ecr|registry|artifactory|nexus|jfrog|harbor|quay|docker ?hub|package ?(feed|repo)|artifact ?(store|bucket))\b/i;

// A gate that is read on a dashboard instead of on the thing itself.
const OBSERVABILITY_SURFACE_RE = /\b(grafana|datadog|dashboard|kibana|new ?relic|splunk|dynatrace|sumo ?logic|honeycomb|pagerduty dashboard|cloudwatch (dashboard|console)|prometheus ui|status page|the console shows|panel (is |shows )?green)\b/i;

// Schedulers and queue consumers that can wake up in both regions at once.
const SCHEDULER_KIND_RE = /\b(eventbridge|event ?bridge|scheduler|cron|batch|step ?functions|sfn|mwaa|airflow|glue|dms|datasync|data ?pipeline|quartz|celery|sidekiq|temporal)\b/i;
const SCHEDULER_NAME_RE = /\b(cron|schedul|worker|consumer|poller|polling|batch|sweeper|reconcil|ingest|import|export|settle|payout|billing|invoice|notifier|digest|sync)\b/i;
// Evidence that exactly one region can run them. A singleton gate, not a hope.
const FENCE_RE = /\b(suspend|--suspend|suspend=true|disable-rule|disable-event|--enabled false|--no-enabled|event ?source ?mapping[^\n]*disabl|scale[^\n]*--replicas[= ]?0|replicas: ?0|scaled? (down )?to zero|leader[- ]?elect|singleton|fenc(e|ed|ing)|quiesce|pause (the )?(schedule|cron|job)|stop (the )?(cron|scheduler|consumer|worker)|drain (the )?(consumer|queue)|only one region|single writer|active[- ]passive)\b/i;

// A cache that comes back empty, and the store that then eats the herd.
const CACHE_KIND_RE = /\b(cache|caching|elasticache|redis|memcach|valkey|hazelcast|varnish|dax)\b/i;
const CACHE_WARM_RE = /\b(cold[- ]cache|cache warm|warm (the )?cache|pre-?warm|warm-?up|thundering herd|cache (hit|miss) (rate|ratio)|prime the cache|request collaps|cache stampede|connection storm)\b/i;

/* eslint-disable complexity */
function failoverPathRisks(ctx, add) {
  const {
    root, deps, byId, closureIds, runbooks, allRunbooks, proof, regions, k8sWorkloads, components,
  } = ctx;
  const all = [root, ...deps];
  const primary = str(regions?.primary);
  const recovery = str(regions?.recovery);
  const relevant = arr(allRunbooks).filter((rb) => runbooks.some((r) => r.id === str(rb?.id)));
  const tierOf = (...cs) => cs.map((c) => (c && c.tier !== null && c.tier !== undefined ? Number(c.tier) : 9))
    .reduce((a, b) => Math.min(a, b), 9);

  // --- R9. a runbook that moves traffic or promotes data with no way back ----
  for (const rb of relevant) {
    const steps = arr(rb.steps);
    const rollback = arr(rb.rollback);
    const hazards = [];
    const traffic = steps.filter((s) => TRAFFIC_MOVE_RE.test(checkedText(s)));
    const promotes = steps.filter((s) => DATA_PROMOTE_RE.test(checkedText(s)));
    if (traffic.length) {
      hazards.push({
        kind: 'live traffic', re: RETURN_TRAFFIC_RE, steps: traffic,
        needs: 'an action that puts traffic back where it came from — flip the record/weight/routing control back, with the pass condition that says how you know it landed',
      });
    }
    if (promotes.length) {
      hazards.push({
        kind: 'a data primary', re: RETURN_DATA_RE, steps: promotes,
        needs: 'an action that returns the writer — switch back / fail back / demote / reverse replication, named as a command, because failing back is a SECOND failover with the same risks and "replication is green again" is a state, not a way to get there',
      });
    }
    if (!hazards.length) continue;
    // A rollback step counts only when it is executable: a command, or a verify
    // AND a pass. A paragraph of intent is not a rollback.
    const actionable = rollback.filter((s) => str(s?.command).trim() || (str(s?.verify).trim() && str(s?.pass).trim()));
    const unmet = hazards.filter((h) => !actionable.some((s) => h.re.test(checkedText(s))));
    if (!unmet.length) continue;
    const none = actionable.length === 0;
    const moved = unmet.map((h) => h.kind).join(' and ');
    add('runbook-without-rollback',
      severityFor('runbook-without-rollback', { tier: root.tier, hasRollback: !none }),
      none
        ? `${str(rb.name) || rb.id} moves ${moved} and has NO rollback steps — a one-way door`
        : `${str(rb.name) || rb.id}'s rollback never says how to put ${moved} back`,
      `${unmet.map((h) => `Step(s) ${h.steps.map((s) => `"${str(s.title)}"`).join(', ')} move ${h.kind}.`).join(' ')} `
      + `${none
        ? `The runbook has ${rollback.length ? `${rollback.length} rollback entr${rollback.length > 1 ? 'ies' : 'y'} but none of them carries a command or a verify+pass, so there is nothing an operator can execute` : 'no rollback section at all'}. `
        : `Its rollback (${actionable.length} executable step(s): ${actionable.map((s) => `"${str(s.title)}"`).join(', ')}) does not name a return path for that. `}`
      + `A rollback is real when it names HOW to get back: ${unmet.map((h) => h.needs).join('; and ')}. `
      + 'The product\'s own rule is that untested failback makes your recovery a one-way door — and the moment this gets read is the moment it is going badly, when nobody is going to invent the reverse sequence under time pressure. '
      + `DO THIS: write the reverse steps as steps, with the decision gate in front of them ("the data block succeeded and the compute block failed — continue, hold, or reverse, and who decides?"), and rehearse the return trip${recovery ? ` out of ${recovery}` : ''} at least once. If the honest answer is that there is no way back, say THAT in the runbook and get it approved — an accepted one-way door is a decision; an undiscovered one is an incident. `
      + 'HEURISTIC: this rule reads the executable half of each step (title, command, verify, pass) and matches return-path verbs. If your rollback does name a way back in different words, say so in a step title or pass condition and this will fall silent.',
      root, {
        runbookId: str(rb.id), runbookName: str(rb.name),
        rollbackSteps: rollback.length, executableRollbackSteps: actionable.length,
        hazards: unmet.map((h) => ({ kind: h.kind, stepIds: h.steps.map((s) => str(s.id)) })),
      });
  }

  // --- R9b. gates, not timers ----------------------------------------------
  // The other half of the same audit item: service.js has always computed
  // `gates` per runbook and never looked at it. A procedure with no gate is a
  // list of things to do in order, and the only thing that tells the operator
  // when to move on is the clock.
  for (const rb of relevant) {
    const steps = arr(rb.steps);
    if (steps.length < 3) continue;
    const gated = steps.filter((s) => s?.gate);
    if (gated.length) continue;
    const unverifiable = steps.filter((s) => !str(s?.verify).trim() || !str(s?.pass).trim());
    const timed = steps.filter((s) => num(s?.estMinutes) !== null);
    add('runbook-without-gates', severityFor('runbook-without-gates', { tier: root.tier }),
      `${str(rb.name) || rb.id} has ${steps.length} steps and not one gate`,
      `No step in this runbook is marked as a gate, so nothing stops an operator moving to the next step before the previous one is actually true`
      + `${timed.length ? `, while ${timed.length} step(s) do carry a time estimate (${timed.reduce((a, s) => a + num(s.estMinutes), 0)} min in total) — so the only signal in the document is the clock` : ''}. `
      + `${unverifiable.length ? `${unverifiable.length} of the ${steps.length} steps also lack a verify command or an observable pass condition. ` : ''}`
      + 'Timers are how runbooks lie to you: at 3am, under pressure, a step that "should take 10 minutes" gets 10 minutes and then everyone moves on, and the failure surfaces three layers later as something else entirely (L4 symptoms of an L3 cause). '
      + 'DO THIS: mark the exit of every layer as a gate with an observable pass condition — an actual command and an actual expected output — and treat the minute estimates as planning numbers for the calendar invite, never as permission to advance.',
      root, { runbookId: str(rb.id), runbookName: str(rb.name), steps: steps.length, unverifiable: unverifiable.length });
  }

  // --- R9c. the surface every gate is read on -------------------------------
  // Audit R-5.11. Only fires when a step ACTUALLY gates on a dashboard — reading
  // the tool's own anti-pattern back to it.
  const dashboardSteps = [];
  for (const rb of relevant) {
    for (const s of [...arr(rb.steps), ...arr(rb.rollback)]) {
      if (!OBSERVABILITY_SURFACE_RE.test(`${str(s?.verify)} ${str(s?.pass)} ${str(s?.command)}`)) continue;
      dashboardSteps.push({ componentId: null, componentName: str(rb.name), where: `${str(rb.name) || rb.id} → "${str(s.title)}"`, note: `gate reads a dashboard/monitoring surface — ${str(s.title)}` });
    }
  }
  if (dashboardSteps.length) {
    const obs = arr(components).filter((c) => str(c?.category) === 'observability'
      || /grafana|datadog|splunk|new ?relic|prometheus|observab|monitor/i.test(`${str(c?.kind)} ${str(c?.name)}`));
    const weak = obs.filter((c) => lower(c.inRecoveryScope) !== 'yes');
    if (!obs.length || weak.length) {
      add('observability-out-of-scope', severityFor('observability-out-of-scope', { tier: root.tier }),
        obs.length
          ? `${weak.length} observability component(s) are not fully in scope, and ${dashboardSteps.length} runbook gate(s) read them`
          : `${dashboardSteps.length} runbook gate(s) read a dashboard, and no observability component is in the inventory at all`,
        `${dashboardSteps.slice(0, 4).map((d) => `• ${d.note}`).join('\n')}${dashboardSteps.length > 4 ? `\n• …and ${dashboardSteps.length - 4} more` : ''}\n\n`
        + `${obs.length
          ? `${weak.map((c) => `${c.name} (scope: ${c.inRecoveryScope})`).join(', ')} — the thing those gates are read on is itself not guaranteed to be there.`
          : 'Nothing in the inventory owns the monitoring surface those gates depend on, so nobody is responsible for it coming back.'} `
        + 'Observability is a COMPONENT, not a given: in a regional event the dashboard is as likely to be down (or showing the dead region\'s data) as anything else, and a green panel that is stale is worse than no panel — it is a gate that passes when it should fail. '
        + `DO THIS: verify with direct commands against the recovered thing itself (the pattern the rest of the product uses: kubectl/psql/curl with an observable output), keep the dashboard as the convenience and not the evidence, and if you do intend to gate on it, bring the observability stack into recovery scope in ${recovery || 'the recovery region'} and prove it is showing recovery-region data before you trust a panel.`,
        root, { aggregated: true, count: dashboardSteps.length, items: dashboardSteps });
    }
  }

  // --- R10. the failover path depends on what the failure took out ----------
  // "Could you execute this failover with the primary region AND your SSO dark?"
  const cp = [];
  const regionFlagRe = primary
    ? new RegExp(`(--region[= ]+|AWS_REGION=|AWS_DEFAULT_REGION=|region=)${primary}\\b|\\b${primary}\\.(console\\.)?amazonaws\\.com`, 'i')
    : null;
  for (const rb of relevant) {
    for (const s of [...arr(rb.steps), ...arr(rb.rollback)]) {
      const text = checkedText(s);
      const where = `${str(rb.name) || rb.id} → "${str(s.title)}"`;
      const item = (cls, note) => cp.push({
        componentId: null, componentName: str(rb.name), where, class: cls, note,
        stepId: str(s.id), runbookId: str(rb.id),
      });
      if (regionFlagRe && regionFlagRe.test(str(s.command))) item('primary-region-api', `runs against ${primary} (the region the event is about) — ${where}`);
      if (GLOBAL_CONTROL_PLANE_RE.test(text)) item('global-control-plane', `edits a control plane that is itself hosted in one region (Route 53 / IAM / CloudFront / ACM control planes live in us-east-1 and are not covered by the data-plane availability designs) — ${where}`);
      if (CI_CONTROL_PLANE_RE.test(text)) item('ci-system', `drives the failover through a CI/CD control plane — ${where}`);
      if (BASTION_RE.test(text) && !(recovery && new RegExp(recovery, 'i').test(text))) item('bastion', `reaches the estate through a bastion/jump host with no recovery-region equivalent named in the step — ${where}`);
    }
  }
  // SSO / IdP: the access path itself. Evidence comes from steps AND checklist
  // items; the exemption is a break-glass path that is written down somewhere
  // checkable.
  const ssoHits = [
    ...relevant.flatMap((rb) => [...arr(rb.steps), ...arr(rb.rollback)]
      .filter((s) => SSO_RE.test(checkedText(s)))
      .map((s) => ({ where: `${str(rb.name) || rb.id} → "${str(s.title)}"`, stepId: str(s.id) }))),
    ...proof.items.filter((it) => SSO_RE.test(it.text))
      .map((it) => ({ where: `checklist ${it.list}${it.done ? '' : ' (item still open)'}`, stepId: '' })),
  ];
  const hasBreakGlass = BREAK_GLASS_RE.test(proof.text);
  if (ssoHits.length && !hasBreakGlass) {
    for (const h of ssoHits.slice(0, 4)) {
      cp.push({
        componentId: null, componentName: '', where: h.where, class: 'sso-no-break-glass',
        note: `operator access depends on SSO/VPN and nothing in the workspace records a break-glass path — ${h.where}`,
        stepId: h.stepId,
      });
    }
  }
  // An artifact store that only exists in the primary region: the pods cannot
  // start, and no amount of orchestration fixes it during the event.
  for (const c of all) {
    const isArtifact = c.category === 'cicd-control-plane' || ARTIFACT_KIND_RE.test(`${c.kind} ${c.name}`);
    if (!isArtifact) continue;
    const mech = lower(c.replication.mechanism);
    if (c.inRecoveryScope === 'yes' && mech && mech !== 'none' && mech !== 'unknown') continue;
    cp.push({
      componentId: c.id, componentName: c.name, where: `${c.name} (${c.category})`, class: 'artifact-store',
      note: `${c.name} is the artifact/image source for this service, its recovery scope is '${c.inRecoveryScope}' and its mechanism is '${c.replication.mechanism || 'none recorded'}'`,
    });
  }
  for (const w of arr(k8sWorkloads)) {
    for (const img of arr(w.images)) {
      if (!primary || !str(img).includes(primary)) continue;
      cp.push({
        componentId: str(w.componentId), componentName: str(w.componentName), where: `${str(w.namespace)}/${str(w.name)}`,
        class: 'artifact-store', note: `${str(w.name)} pulls ${str(img)} — an image reference pinned to ${primary}`,
      });
    }
  }
  if (cp.length) {
    const classes = [...new Set(cp.map((h) => h.class))];
    const CLASS_FIX = {
      'primary-region-api': `re-point every event-day command at ${recovery || 'the recovery region'} (or a global endpoint) and prove the whole path runs with ${primary || 'the primary'} unreachable — not "should work", executed`,
      'global-control-plane': 'move the event-day action to a DATA-plane mechanism (health-check state or an ARC routing control, not a record edit), because the record-editing control plane is single-region and not covered by the data plane\'s availability design',
      'ci-system': 'hold a copy of the pipeline (or a checked-in, runnable script + credentials) outside the primary region, and prove an operator can execute it from a laptop with the CI system dark',
      'sso-no-break-glass': 'create a break-glass identity in the recovery account that does NOT traverse the IdP, seal it, TEST it on a schedule, and write the test date down — an untested break-glass credential is a rumour',
      bastion: 'stand up the access path in the recovery region (or use Session Manager with a recovery-region endpoint) and verify it from outside the primary region',
      'artifact-store': `replicate images/artifacts into ${recovery || 'the recovery region'} ahead of time and pin deployments to the recovery-region registry — a cross-region pull from a dead primary is an ImagePullBackOff, which reads as an application failure for the first 30 minutes`,
    };
    add('control-plane-dependency-in-failover-path',
      severityFor('control-plane-dependency-in-failover-path', { tier: root.tier }),
      `The failover path for ${root.name} depends on ${cp.length} thing(s) the event itself may have taken out`,
      `${cp.slice(0, 6).map((h) => `• ${h.note}`).join('\n')}${cp.length > 6 ? `\n• …and ${cp.length - 6} more` : ''}\n\n`
      + `The design rule this enforces is "the event-day action must be data-plane only". A failover procedure that needs ${primary || 'the primary region'}'s API, a CI system that lives there, an IdP with no break-glass, a bastion in the dead region or an artifact store that never left it is a procedure that works in every rehearsal and fails in the one event it exists for — and the failure looks like a login loop or an ImagePullBackOff, not like a regional outage, so the first half hour goes on the wrong problem. `
      + `DO THIS: ${classes.map((c) => CLASS_FIX[c]).filter(Boolean).join('; ')}. `
      + 'Then run the drill the assessment asks about: execute the failover with the primary region AND your SSO dark, and fix whatever you could not do. '
      + 'HEURISTIC: this reads commands and verify/pass conditions, not prose. A step that legitimately reads the primary region (proving the old writer is fenced, say) will appear here — that is not a false positive, it is the question of what you do when that read times out.',
      root, {
        aggregated: true, count: cp.length, items: cp, classes,
      });
  }

  // --- R11. schedulers and queue consumers running in BOTH regions ----------
  const schedulers = [];
  for (const w of arr(k8sWorkloads)) {
    const kind = lower(w.kind);
    if (kind === 'cronjob' || kind === 'job') {
      schedulers.push({
        componentId: str(w.componentId), componentName: str(w.componentName) || str(w.name),
        where: `${str(w.namespace)}/${str(w.kind)} ${str(w.name)}`,
        note: `${str(w.kind)} ${str(w.namespace)}/${str(w.name)} — a schedule that exists in whichever cluster is running`,
        confidence: 'high',
      });
    } else if (SCHEDULER_NAME_RE.test(str(w.name))) {
      schedulers.push({
        componentId: str(w.componentId), componentName: str(w.componentName) || str(w.name),
        where: `${str(w.namespace)}/${str(w.name)}`,
        note: `${str(w.name)} reads as a worker/consumer by name — confirm whether it polls or writes on a timer`,
        confidence: 'low',
      });
    }
  }
  for (const c of all) {
    if (SCHEDULER_KIND_RE.test(`${c.kind} ${arr(c.awsServices).join(' ')}`)) {
      schedulers.push({
        componentId: c.id, componentName: c.name, where: `${c.name} (${c.kind})`,
        note: `${c.name} is a scheduled/triggered service (${c.kind}) — its rules or jobs fire wherever they are enabled`,
        confidence: 'high',
      });
    }
    if (c.category === 'messaging-streaming' && c.inRecoveryScope !== 'no') {
      const consumers = arr(components).filter((x) => arr(x?.dependsOn).includes(c.id) && str(x.id) !== c.id);
      if (consumers.length) {
        schedulers.push({
          componentId: c.id, componentName: c.name, where: `${c.name} → ${consumers.map((x) => str(x.name)).join(', ')}`,
          note: `${consumers.length} consumer(s) of ${c.name} (${consumers.map((x) => str(x.name)).join(', ')}) — if the recovery-region consumers start while the primary's are still draining, both are writing`,
          confidence: 'medium',
        });
      }
    }
  }
  if (schedulers.length) {
    const fenced = proofState(proof, FENCE_RE);
    if (fenced !== 'verified') {
      const worstTier = tierOf(root, ...schedulers.map((s) => byId.get(s.componentId)).filter(Boolean)
        .map((c) => ({ tier: c.tier === undefined || c.tier === null ? null : Number(c.tier) })));
      // Same discipline as the outbound-call resolver (audit R-7): a finding
      // built only from inference ("this reads like a worker", "this queue has
      // consumers") is held one step below a finding built from a CronJob that
      // is demonstrably in the snapshot.
      const certain = schedulers.some((s) => s.confidence === 'high');
      const sev = severityFor('scheduler-double-run', { tier: worstTier });
      add('scheduler-double-run', certain ? sev : (sev === 'high' ? 'medium' : sev),
        `${schedulers.length} scheduled job(s)/consumer(s) behind ${root.name} could run in BOTH regions`,
        `${schedulers.slice(0, 6).map((s) => `• ${s.note}`).join('\n')}${schedulers.length > 6 ? `\n• …and ${schedulers.length - 6} more` : ''}\n\n`
        + `${fenced === 'listed-not-done'
          ? 'A checklist item mentions fencing/suspending them but is not ticked, so nothing has actually been confirmed. '
          : 'Nothing in this workspace — no runbook step command, no verify/pass condition, no checklist item — suspends a schedule, disables an event-source mapping, scales a consumer to zero, or names a leader election. '}`
        + `${certain ? '' : 'Every item above is INFERRED (a queue that has consumers, a workload whose name reads like a worker) rather than a CronJob the cluster snapshot proves exists, so this row is held one severity below where a proven scheduler would sit — confirm which of them actually write. '}`
        + 'A failover is not just "start the other side": in a gray failure the old region is still running, and a cron that fires in both places double-charges a card, writes a second settlement file, or produces two writers on one ledger. Unlike downtime, that is not undone when the region comes back — somebody reconciles it by hand, and the customer-facing part of it is already out the door. '
        + 'DO THIS: give every schedule and every queue consumer a single-region gate that is part of the failover, not a memory — suspend CronJobs (kubectl patch cronjob … -p \'{"spec":{"suspend":true}}\'), disable EventBridge rules and Lambda event-source mappings, scale consumer deployments to zero in the region that is standing down, or make the job take a lease it can only hold in one region. Put the gate IN the runbook with a pass condition ("zero running jobs in the standing-down region"), and put the reverse in the rollback. '
        + 'HEURISTIC: this errs toward firing — an idempotent job is safe and will still be listed. Suppress it honestly by recording the singleton gate as a step or a ticked checklist item, not by deleting the row.',
        root, {
          aggregated: true, count: schedulers.length, items: schedulers, fenceEvidence: fenced,
        });
    }
  }

  // --- R12. a cold cache in front of a store that eats the herd -------------
  const warmEvidence = proofState(proof, CACHE_WARM_RE);
  if (warmEvidence !== 'verified') {
    for (const cache of all) {
      const isCache = CACHE_KIND_RE.test(`${cache.kind} ${cache.name} ${arr(cache.tags).join(' ')}`);
      if (!isCache || cache.category === 'edge-dns') continue;
      const mech = lower(cache.replication.mechanism);
      const cold = !mech || mech === 'none' || mech === 'unknown' || SHAPE_ONLY_MECH_RE.test(mech);
      if (!cold) continue;
      // Who reads through it, and what do they fall through to?
      const consumers = arr(components).filter((x) => arr(x?.dependsOn).includes(cache.id));
      const backing = [];
      for (const cons of consumers) {
        for (const depId of arr(cons.dependsOn)) {
          const b = byId.get(depId);
          if (!b || b.id === cache.id) continue;
          // The store of record only. A queue or a secret store is not what a
          // cache miss falls through to, and naming one here would be the kind
          // of confidently-wrong sentence this pass exists to remove.
          if (str(b.category) !== 'database' && str(b.category) !== 'storage') continue;
          if (CACHE_KIND_RE.test(`${str(b.kind)} ${str(b.name)}`)) continue;
          if (!backing.some((x) => x.id === b.id)) backing.push(b);
        }
      }
      // No datastore behind it means no herd to land: the cold cache is a
      // latency story, not a capacity failure, and this rule stays quiet.
      if (!backing.length) continue;
      const backingInScope = backing.some((b) => lower(b.inRecoveryScope) === 'yes');
      const tierish = (x) => ({ tier: x && x.tier !== undefined && x.tier !== null ? Number(x.tier) : null });
      const tier = tierOf(...consumers.map(tierish), ...backing.map(tierish));
      add('cache-cold-start-load', severityFor('cache-cold-start-load', { tier, backingInScope }),
        `${cache.name} comes back EMPTY — ${backing.map((b) => str(b.name)).join(', ')} take${backing.length > 1 ? '' : 's'} the uncached load`,
        `${cache.name}'s recovery mechanism is '${cache.replication.mechanism || 'none recorded'}', which means it is rebuilt cold: every read that used to be served from memory becomes a read against ${backing.map((b) => `${str(b.name)} (${str(b.inRecoveryScope) === 'yes' ? 'in scope' : `scope: ${str(b.inRecoveryScope) || 'unknown'}`})`).join(' and ')} at the same moment ${consumers.map((x) => str(x.name)).join(', ')} ${consumers.length > 1 ? 'come' : 'comes'} back and every client retries at once. `
        + `${backingInScope
          ? 'This is a capacity failure, not a data-loss one, and it is the one that looks like a successful recovery for the first four minutes: pods Ready, health checks green, and then the database saturates and the success bar never passes. '
          : 'The store behind it is not confirmed in scope, so the scope finding above is the louder one — but note that a cold cache makes that store\'s first minutes much worse, not better. '}`
        + `A restored or scaled-from-standby ${backing.map((b) => str(b.kind)).join('/')} is also usually running at LESS than production capacity at that moment (a pilot light is scaled down by definition), so the herd lands on the smallest version of the store you will ever have. `
        + `DO THIS: measure it before you need it — run the recovery-region load with the cache empty and record the backing store's peak CPU/connections; then pick a mitigation and write it into the runbook as a step: pre-warm the cache from a snapshot or a replay before the L7 cutover, scale ${backing.map((b) => str(b.name)).join('/')} up BEFORE traffic rather than after, add request coalescing/singleflight so one miss is one query, or stage the traffic shift (10% → 50% → 100%) so the cache fills behind a partial load. `
        + 'HEURISTIC: a cache with no recorded warm-up evidence is assumed cold. If you have measured the cold-start load and it is fine, record that check (a runbook step or a ticked checklist item naming cold cache / warm-up / thundering herd) and this goes quiet.',
        cache, {
          backingStores: backing.map((b) => ({ id: b.id, name: str(b.name), scope: str(b.inRecoveryScope) })),
          consumers: consumers.map((x) => ({ id: x.id, name: str(x.name) })),
          backingInScope, mechanism: cache.replication.mechanism, warmEvidence,
        });
    }
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
    case 'cache-cold-start-load': return `${n} caches come back empty in front of a datastore: ${shown}${more}`;
    case 'runbook-without-rollback': return `${n} runbooks move traffic or promote data with no usable rollback: ${group.map((g) => str(g.runbookName)).filter(Boolean).slice(0, 3).join(', ')}${more}`;
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
      const match = resolve(o.target, c.id);
      const rc = match ? byId.get(match.id) : null;
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
        // Audit R-7: the match is a guess, so it says how good a guess it is.
        resolvedConfidence: rc ? match.confidence : '',
        resolvedWhy: rc ? match.why : '',
        resolvedMatchedOn: rc ? match.matchedOn : '',
        resolvedAlternatives: rc
          ? match.alternatives.map((a) => ({ id: a.id, name: str(byId.get(a.id)?.name || a.name), matchedOn: a.matchedOn }))
          : [],
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
        // Audit RB-12: the summed estimate invites timer-driven advancement,
        // which is the one thing the layer cake forbids. The number stays; it
        // now travels with the sentence that says what it is not.
        estMinutesLabel: 'planning estimate, not a schedule — gates govern advancement, never the clock',
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
    // Evidence of persistent state (audit R-3) — from the cluster snapshot and
    // the resource graph, never from a description.
    const stateful = statefulIndex(components, snap, graph.nodes);
    const risksAll = computeRisks({
      root, deps, calls: outboundCalls, runbooks, tests, posture, meta, manualEdge, closureIds,
      byId, numbers, graphNodes: graph.nodes, k8sWorkloads, proof,
      regions: meta.regions || {}, staleAfterDays, stateful, allRunbooks, components,
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
      note: [
        collapsed
          ? `${collapsed} findings sharing a rule were folded into single rows so the list stays actionable.`
          : 'No findings needed folding.',
        suppressed
          ? `${suppressed} of the lowest-ranked findings are below the ${MAX_SHOWN}-row cut (blockers are never cut) — they are not gone, they are in risksAll.`
          : '',
        'Every finding is in risksAll.',
      ].filter(Boolean).join(' '),
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
