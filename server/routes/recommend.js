// Strategy / tooling recommender + Region-switch plan skeleton + template serving.
// Owned by agent: runbooks-tests.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspace, getCollection, httpError } from '../store.js';
// One severity table, one definition of "measured" — shared with
// server/routes/service.js. Contract: docs/measured-numbers.md.
import { measuredNumbers, severityFor } from '../lib/measured.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// ---------------------------------------------------------------- templates

const TEMPLATE_KINDS = ['runbooks', 'checklists', 'app-tests'];

router.get('/w/:ws/templates/:kind', (req, res, next) => {
  try {
    getWorkspace(req.params.ws); // 404 if workspace missing
    const kind = req.params.kind;
    if (!TEMPLATE_KINDS.includes(kind)) throw httpError(404, `unknown template kind '${kind}'`);
    const file = path.join(__dirname, '..', 'data', 'templates', `${kind}.json`);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw httpError(500, `template file for '${kind}' is missing or invalid`); }
    if (!data || !Array.isArray(data.templates)) data = { templates: [] };
    res.json(data);
  } catch (e) { next(e); }
});

// ------------------------------------------------------- strategy catalog

// Built-in fallback used when server/data/strategy-catalog.json (owned by the
// research-knowledge agent) is absent or unreadable/half-written.
const FALLBACK_CATALOG = [
  { id: 'backup-restore', name: 'Backup & restore', rtoFloorMinutes: 240, rpoFloorMinutes: 60,
    summary: 'Restore from backups after the event. Cheapest; slowest.' },
  { id: 'pilot-light', name: 'Pilot light', rtoFloorMinutes: 30, rpoFloorMinutes: 15,
    summary: 'Core data replicated; minimal standby infrastructure scaled up on failover.' },
  { id: 'warm-standby', name: 'Warm standby', rtoFloorMinutes: 10, rpoFloorMinutes: 5,
    summary: 'Scaled-down but fully functional copy running in the recovery region.' },
  { id: 'active-active', name: 'Active-active', rtoFloorMinutes: 1, rpoFloorMinutes: 1,
    summary: 'Both regions serve live traffic; failover is traffic-shifting.' },
];

function loadCatalog() {
  try {
    const file = path.join(__dirname, '..', 'data', 'strategy-catalog.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.strategies || raw.items || raw.templates);
    if (!Array.isArray(list) || !list.length) return FALLBACK_CATALOG;
    // Normalize: keep only entries with an id; fill floors from fallback when absent.
    const out = list.filter((s) => s && typeof s === 'object' && s.id).map((s) => {
      const fb = FALLBACK_CATALOG.find((f) => f.id === s.id) || {};
      return {
        id: s.id,
        name: s.name || fb.name || s.id,
        rtoFloorMinutes: Number.isFinite(s.rtoFloorMinutes) ? s.rtoFloorMinutes : fb.rtoFloorMinutes,
        rpoFloorMinutes: Number.isFinite(s.rpoFloorMinutes) ? s.rpoFloorMinutes : fb.rpoFloorMinutes,
        summary: s.summary || s.description || fb.summary || '',
      };
    });
    return out.length ? out : FALLBACK_CATALOG;
  } catch {
    return FALLBACK_CATALOG;
  }
}

// --------------------------------------------------------- strategy fit
//
// Audit K-7. This used to print "Typical pilot light recovery (~30m RTO / ~15m
// RPO floor) MEETS YOUR TARGETS" from four numbers hard-coded in this file. That
// is an unmeasured, generic claim phrased as compliance — the exact thing
// 05-strategy-matrix.md forbids ("never quote the column header as your RPO"),
// and it ignored the article's rule 5: LET THE DATA LAYER VETO. A workspace whose
// only mechanism is a nightly snapshot copy is capped at backup-restore RPO no
// matter how warm the compute is.
//
// So the fit is now grounded in three things, in this order of authority:
//   1. MEASURED   — what a passed test actually achieved (measuredNumbers()).
//   2. DECLARED   — each in-scope stateful component's replication.mechanism and
//                   replication.rpoMinutes: what your data layer can do.
//   3. GENERIC    — the catalog's typical figures, which describe the industry,
//                   not you, and are always labelled as such.
// Where none of the three can answer, the verdict is 'unknown' and it says why.
// "Could plausibly support" is the strongest claim this function may make about
// an untested strategy.

const STATEFUL_CATEGORIES = new Set(['database', 'storage', 'messaging-streaming', 'security-secrets']);
// Only a STORE OF RECORD can veto a strategy or set an RPO floor. A cache is
// rebuilt by design (its consequence is capacity, not data loss — see the
// cache-cold-start-load rule on the service profile); a queue's in-flight loss
// is a separate, explicitly accepted decision; a secret store and a KMS key are
// judged on presence, not on minutes of lag. Counting any of them here would
// veto every strategy for reasons that have nothing to do with data loss.
const RPO_BEARING_CATEGORIES = new Set(['database', 'storage']);
const CACHE_RE = /\b(cache|caching|elasticache|redis|memcach|valkey|dax)\b/i;

// What a mechanism can actually deliver, from 16-replication-mechanisms.md.
const MECH_CLASSES = [
  { class: 'continuous-bidirectional', rank: 5, re: /active-?active|multi-?master|multi-?primary|global ?table|mrsc|dynamodb-?global/i },
  { class: 'continuous', rank: 4, re: /aurora-?global|global-?(database|cluster)|read-?replica|replica|crr|rtc|continuous|real-?time|stream(ing)?-?replication|log ?shipping|dms|msk-?replicator|cross-?cluster|ccr|ecr-?replication|drs|elastic-?disaster|block-?level|multi-?region-?key/i },
  { class: 'periodic', rank: 3, re: /snapshot|backup|copy|point-?in-?time|pitr|recovery-?point|arpio|export|dump|nightly|hourly|daily|scheduled/i },
  { class: 'rebuild', rank: 2, re: /rebuild|re-?ingest|re-?index|replay|reconstruct|repopulat/i },
  { class: 'shape-only', rank: 1, re: /^(iac|iac-gitops|gitops|terraform|terragrunt|cloudformation|cdk|helm|redeploy|recreate)/i },
];
const CLASS_RANK = { none: 0, 'shape-only': 1, rebuild: 2, periodic: 3, continuous: 4, 'continuous-bidirectional': 5 };
// The least capable data layer each strategy's promise actually rests on.
const STRATEGY_MIN_CLASS = {
  'backup-restore': 'periodic',
  'pilot-light': 'periodic',
  'warm-standby': 'continuous',
  'active-active': 'continuous-bidirectional',
};

function mechClassOf(mechanism) {
  const m = String(mechanism || '').trim();
  if (!m || /^(none|unknown|n\/a|na|tbd|\?)$/i.test(m)) return 'none';
  for (const c of MECH_CLASSES) if (c.re.test(m)) return c.class;
  return 'none';
}

// What the declared mechanisms say this workspace's data layer can do.
function dataLayerProfile(components) {
  const stores = [];
  for (const c of components || []) {
    const scope = String(c.inRecoveryScope || '').toLowerCase();
    if (scope === 'no') continue;
    if (!STATEFUL_CATEGORIES.has(String(c.category || ''))) continue;
    const tier = Number.isFinite(c.tier) ? c.tier : 99;
    const mechanism = String(c.replication?.mechanism || '').trim();
    const isCache = CACHE_RE.test(`${c.kind || ''} ${c.name || ''} ${(c.tags || []).join(' ')}`);
    stores.push({
      componentId: c.id,
      name: c.name || c.id,
      tier,
      scope,
      category: String(c.category || ''),
      mechanism,
      mechanismClass: mechClassOf(mechanism),
      rpoMinutes: Number.isFinite(c.replication?.rpoMinutes) ? c.replication.rpoMinutes : null,
      rpoBearing: RPO_BEARING_CATEGORIES.has(String(c.category || '')) && !isCache,
      role: isCache ? 'cache' : (RPO_BEARING_CATEGORIES.has(String(c.category || '')) ? 'store-of-record' : String(c.category || 'other')),
    });
  }
  const ofRecord = stores.filter((s) => s.rpoBearing);
  const critical = ofRecord.filter((s) => s.tier <= 1);
  const judged = critical.length ? critical : ofRecord;
  const weakest = judged.reduce((w, s) =>
    (!w || CLASS_RANK[s.mechanismClass] < CLASS_RANK[w.mechanismClass] ? s : w), null);
  const withNumbers = judged.filter((s) => s.rpoMinutes !== null);
  const withoutNumbers = judged.filter((s) => s.rpoMinutes === null && s.mechanismClass !== 'none');
  const unrecorded = judged.filter((s) => s.mechanismClass === 'none');
  return {
    stores,
    judged,
    weakest,
    weakestClass: weakest ? weakest.mechanismClass : null,
    // The worst declared lag across the stores that matter: an RPO cannot be
    // better than its slowest store, and a store with no number is a hole in
    // the claim, not a zero.
    declaredFloorRpoMinutes: withNumbers.length ? Math.max(...withNumbers.map((s) => s.rpoMinutes)) : null,
    floorIsComplete: judged.length > 0 && withoutNumbers.length === 0 && unrecorded.length === 0,
    withoutNumbers,
    unrecorded,
  };
}

function strategyFit(ws, catalog, { components = [], tests = [], runbooks = [] } = {}) {
  const rto = Number.isFinite(ws.objectives?.rtoMinutes) ? ws.objectives.rtoMinutes : null;
  const rpo = Number.isFinite(ws.objectives?.rpoMinutes) ? ws.objectives.rpoMinutes : null;
  const numbers = measuredNumbers(ws, tests, null, { components, runbooks });
  const data = dataLayerProfile(components);
  const measuredRpa = numbers.rpa.state === 'measured' ? numbers.rpa : null;
  const measuredRta = numbers.rta.state === 'measured' ? numbers.rta : null;

  // The sentence about evidence is the same for every strategy, because it is
  // about the workspace, not the strategy.
  const excluded = data.stores.filter((st) => !st.rpoBearing);
  const excludedNote = excluded.length
    ? `Judged on ${data.judged.length} store(s) of record (${data.judged.map((st) => st.name).join(', ')}); ${excluded.length} other stateful component(s) are deliberately outside this RPO — a cache's cold rebuild is a capacity problem, a queue's in-flight loss is a separate accepted decision, and a secret store or key is judged on presence, not on minutes.`
    : '';
  const evidenceSentence = measuredRta || measuredRpa
    ? `Measured, by a passed test that covers this workspace: ${measuredRta ? `RTA ${measuredRta.minutes}m` : 'RTA not measured'} / ${measuredRpa ? `RPA ${measuredRpa.minutes}m` : 'RPA not measured'}${(measuredRta && measuredRta.stale) || (measuredRpa && measuredRpa.stale) ? ' — and that evidence is stale' : ''}.`
    : `Nothing here has been measured: no passed test has produced an RTA or an RPA for this workspace${numbers.rta.state === 'declared' || numbers.rpa.state === 'declared' ? ' (the numbers in Settings are typed, not measured)' : ''}, so no strategy can be said to have achieved anything yet.`;

  return catalog.map((s) => {
    const genericRto = Number.isFinite(s.rtoFloorMinutes) ? s.rtoFloorMinutes : null;
    const genericRpo = Number.isFinite(s.rpoFloorMinutes) ? s.rpoFloorMinutes : null;
    const minClass = STRATEGY_MIN_CLASS[s.id] || 'periodic';
    const generic = `Industry-typical figures for ${s.name} are ~${genericRto ?? '—'}m RTO / ~${genericRpo ?? '—'}m RPO; those describe the pattern, not your estate, and must never be quoted as your numbers.`;

    // 1. Can this workspace's DATA LAYER carry this strategy at all?
    if (!data.judged.length) {
      return {
        strategyId: s.id,
        verdict: 'unknown',
        why: `Cannot judge: no in-scope stateful components are recorded, so there is nothing to say what your data layer can do. ${generic}`,
        basis: 'none',
        confidence: 'none',
        limiters: [],
        dataFloorRpoMinutes: null,
        generic: { rtoFloorMinutes: genericRto, rpoFloorMinutes: genericRpo },
      };
    }
    const limiters = data.judged
      .filter((st) => CLASS_RANK[st.mechanismClass] < CLASS_RANK[minClass])
      .map((st) => ({
        componentId: st.componentId, name: st.name, tier: st.tier,
        mechanism: st.mechanism || '(none recorded)', mechanismClass: st.mechanismClass,
        why: st.mechanismClass === 'none'
          ? 'no replication mechanism is recorded, so its contribution to the RPO is unknown'
          : `'${st.mechanism}' is ${st.mechanismClass} — ${s.name} assumes at least ${minClass} replication for every store it covers`,
      }));

    const floor = data.declaredFloorRpoMinutes;
    const floorSentence = floor === null
      ? `None of your in-scope stores declares an RPO number for its mechanism, so the data loss this strategy would actually produce here is UNKNOWN${data.unrecorded.length ? ` (${data.unrecorded.length} store(s) have no mechanism at all: ${data.unrecorded.slice(0, 3).map((x) => x.name).join(', ')})` : ''}.`
      : `Your declared mechanisms bottom out at ${floor}m of data loss (worst store: ${data.judged.filter((x) => x.rpoMinutes === floor).map((x) => `${x.name} via ${x.mechanism || 'no mechanism'}`)[0]})${data.floorIsComplete ? '' : `, and ${data.withoutNumbers.length + data.unrecorded.length} further store(s) declare no number, so the real floor may be worse`}.`;

    let verdict;
    let claim;
    if (limiters.length) {
      verdict = 'mismatch';
      claim = `Your data layer vetoes this: ${limiters.length} in-scope store(s) cannot support ${s.name} as configured — ${limiters.slice(0, 3).map((l) => `${l.name} (${l.mechanism})`).join(', ')}${limiters.length > 3 ? `, +${limiters.length - 3} more` : ''}. A warm stack in front of a nightly copy is still a nightly-copy RPO.`;
    } else if (rpo === null && rto === null) {
      verdict = 'unknown';
      claim = `Your declared mechanisms are consistent with ${s.name}, but no RTO/RPO objective is set, so there is no target to judge fit against. Set objectives in Settings.`;
    } else if (floor === null) {
      verdict = 'stretch';
      claim = `Your mechanisms are the right SHAPE for ${s.name}, but they carry no RPO numbers, so whether they meet an RPO of ${rpo ?? '—'}m is unknown — not "yes". Record replication.rpoMinutes per store (from observed lag, not the brochure), then re-check.`;
    } else if (rpo !== null && floor > rpo) {
      verdict = 'mismatch';
      const worst = data.judged.filter((x) => x.rpoMinutes === floor);
      claim = `Not this strategy's fault — your data layer misses the RPO whatever you run in front of it: ${worst.map((x) => `${x.name} declares ${x.rpoMinutes}m via '${x.mechanism}'`).join('; ')}, against a ${rpo}m objective. ${s.name} is compatible in shape, but no compute posture fixes a data mechanism. Change the mechanism on that store, give it its own objective, or renegotiate the ${rpo}m number — those are the honest options.`;
    } else if (rpo !== null && floor > rpo * 0.75) {
      verdict = 'stretch';
      claim = `Your mechanisms could plausibly support ${s.name} at an RPO of ${rpo}m, but only just: the declared floor is ${floor}m, which leaves no headroom for the lag you will actually see during a regional event.`;
    } else {
      verdict = 'ok';
      claim = `Your declared mechanisms could plausibly support ${s.name}${rpo !== null ? ` at an RPO of ${rpo}m (declared floor ${floor}m)` : ''} — "could", because a mechanism's claim is not a measurement.`;
    }

    // 2. Cross-check against EVIDENCE where evidence exists. Measured numbers
    // outrank both the mechanism claim and the generic floor.
    let evidenceNote = '';
    if (measuredRta && rto !== null) {
      const over = measuredRta.minutes > rto;
      evidenceNote = over
        ? ` Your last passed test took ${measuredRta.minutes}m against a ${rto}m RTO, so whatever the pattern promises, this estate has not delivered it yet${verdict === 'ok' ? ' — treat this fit as a plan, not a status' : ''}.`
        : ` Your last passed test reached the success bar in ${measuredRta.minutes}m against a ${rto}m RTO, which is real evidence for a recovery-time claim (for the configuration that was tested).`;
      if (over && verdict === 'ok') verdict = 'stretch';
    }
    if (measuredRpa && floor !== null && measuredRpa.minutes > floor) {
      evidenceNote += ` Note the gap between claim and reality: the measured RPA was ${measuredRpa.minutes}m against a ${floor}m declared mechanism floor — the mechanism is not keeping its own promise, which is a replication-health problem to fix before any strategy claim means anything.`;
    }

    const basis = (measuredRta || measuredRpa) ? 'measured+mechanisms' : 'mechanisms';
    return {
      strategyId: s.id,
      verdict,
      // `why` is the row a human reads: the claim, the evidence that outranks
      // it, and the number the claim rests on — and nothing generic, because a
      // generic number printed next to a verdict is how the old version came to
      // say "meets your targets". The rest of the reasoning is additive below,
      // so it can be shown on demand without turning four rows into a wall.
      why: `${claim}${evidenceNote} ${floorSentence}`.replace(/\s{2,}/g, ' ').trim(),
      basisNote: excludedNote,
      evidenceNote: evidenceSentence,
      genericNote: generic,
      basis,
      confidence: data.floorIsComplete ? (basis === 'measured+mechanisms' ? 'high' : 'medium') : 'low',
      requiresDataClass: minClass,
      dataFloorRpoMinutes: floor,
      dataFloorComplete: data.floorIsComplete,
      limiters,
      generic: { rtoFloorMinutes: genericRto, rpoFloorMinutes: genericRpo },
    };
  });
}

// ------------------------------------------------------------- tooling fit

function toolingVerdicts(ws, components, runbooks) {
  const inUse = new Set(ws.tooling || []);
  const kinds = components.map((c) => String(c.kind || '').toLowerCase());
  const hasEc2 = kinds.some((k) => /ec2|vm\b|instance|server|on-prem/.test(k)) ||
    components.some((c) => (c.awsServices || []).some((s) => /^ec2$/i.test(s)) && /compute/.test(c.category || '') && !/eks|ecs|lambda|fargate/i.test(c.kind || ''));
  const iacCount = components.filter((c) => (c.definedIn || '').trim()).length;
  const manualDns = components.some((c) => (c.category === 'edge-dns') &&
    ((c.gaps || []).join(' ').toLowerCase().includes('manual') || /manual/i.test(c.replication?.notes || '')));
  const hasEdge = components.some((c) => c.category === 'edge-dns');
  const tier0 = components.filter((c) => c.tier === 0).length;

  const mk = (id, name, verdict, why) => ({ id, name, verdict: inUse.has(id) ? 'in-use' : verdict, why });

  return [
    mk('arpio', 'Arpio (snapshot recovery)',
      ws.strategy === 'pilot-light' || ws.strategy === 'backup-restore' ? 'recommended' : 'consider',
      inUse.has('arpio')
        ? 'Already in play — keep running the Phase-1 test loop with it.'
        : 'Point-in-time environment recovery fits snapshot-based strategies; fastest path to a first real recovery test.'),
    mk('region-switch', 'AWS ARC Region switch',
      tier0 >= 3 ? 'recommended' : 'consider',
      inUse.has('region-switch')
        ? 'In evaluation/use — build the plan in BOTH regions and rehearse it quarterly by EXECUTING it in graceful mode against a lower environment. There is no practice/simulation mode for Region switch (scheduled practice runs are an ARC zonal-autoshift feature); plan evaluation runs every 30 min but AWS explicitly says it is not a substitute for executing the plan.'
        : `${tier0} Tier-0 components across multiple layers benefit from orchestrated execution blocks instead of a human running 14 steps under stress.`),
    mk('arc-routing-controls', 'ARC routing controls',
      hasEdge && manualDns ? 'recommended' : (hasEdge ? 'consider' : 'not-needed'),
      manualDns
        ? 'Your DNS flip is manual today — routing controls give a highly-available, auditable traffic switch.'
        : hasEdge
          ? 'Useful once failover frequency or audit requirements outgrow direct Route 53 changes.'
          : 'No edge/DNS components in inventory.'),
    mk('elastic-dr', 'AWS Elastic Disaster Recovery',
      hasEc2 ? 'recommended' : 'not-needed',
      hasEc2
        ? 'EC2/VM-based workloads present — DRS gives block-level replication with cheap drills.'
        : 'No EC2/VM-style workloads in inventory (containers + managed services) — DRS would protect nothing here.'),
    mk('gitops-iac', 'GitOps / IaC region flip',
      iacCount >= Math.max(3, components.length * 0.5) ? 'recommended' : 'consider',
      `${iacCount}/${components.length} components are IaC-defined. ` +
      (iacCount >= components.length * 0.5
        ? 'Coverage is high enough that a primary_region flip is a realistic orchestration path — if the control plane survives the blast radius.'
        : 'Raise IaC coverage before betting failover on a git flip.')),
    mk('resilience-hub', 'AWS Resilience Hub',
      'consider',
      'Continuous RTO/RPO assessment against policy; useful as a drift alarm between tests, not a recovery mechanism.'),
    mk('backup', 'AWS Backup (baseline)',
      'recommended',
      'Independent baseline backups are the floor under every other tool — keep them even with replication in place.'),
  ];
}

// --------------------------------------------------- region-switch plan

const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];

// Block types that move LIVE PUBLIC TRAFFIC. These are always L7 in a drafted plan,
// whatever layer the component happens to carry, because the plan is ordered by layer
// and the one ordering the product forbids is traffic-before-verification
// (04-restore-layer-cake.md: L6 before L7). See also the layer correction on
// route53-health-check in strategy-catalog.json.
const TRAFFIC_BLOCK_TYPES = new Set(['route53-health-check', 'routing-control']);

// Block types that irreversibly move a data primary. An approval belongs in front of
// these, per the catalog's manual-approval note.
const IRREVERSIBLE_DATA_BLOCK_TYPES = new Set(['data-switchover']);

function blockTypeFor(c) {
  const kind = String(c.kind || '').toLowerCase();
  const cat = c.category || '';
  // SQS/Kinesis are NOT promotable or restorable — they have no native cross-region
  // replication at all (16-replication-mechanisms.md, "the hole in the menu"), so
  // routing them to data-switchover drafted a step nobody can execute.
  if (cat === 'messaging-streaming') return 'messaging-inflight';
  if (cat === 'database' || cat === 'storage') return 'data-switchover';
  if (cat === 'compute') return 'compute-scale-up';
  if (cat === 'edge-dns') {
    if (/route53|dns/.test(kind)) return 'route53-health-check';
    // API Gateway (and any other edge entry point) is where traffic ARRIVES, not a
    // switch that moves it. Calling it a routing-control block told operators the plan
    // would shift traffic when it would not.
    if (/api-?gateway|alb|nlb|load-?balancer|ingress|cdn|cloudfront|waf/.test(kind)) return 'edge-precondition';
    return 'routing-control';
  }
  if (cat === 'third-party') return 'manual-partner-action';
  if (cat === 'cicd-control-plane' || cat === 'identity-access' || cat === 'security-secrets' || cat === 'networking') return 'precondition';
  return 'custom-lambda';
}

function blockNotes(type, comps) {
  switch (type) {
    case 'data-switchover': {
      const aurora = comps.some((c) => /aurora/i.test(c.kind || '') || /aurora/i.test(c.name || ''));
      return aurora
        ? 'Aurora Global Database execution block. GRACEFUL mode performs a switchover: Aurora syncs the secondary before changing anything, so RPO is 0 — but it requires a healthy primary. UNGRACEFUL mode performs a failover: data not yet replicated is lost (RPO = replication lag at failure) and the old writer is NOT demoted for you, so fencing it is your job. Choose and record the mode BEFORE execution; verify the writer endpoint is in the recovery region and record the loss window.'
        : 'Promote or restore the recovery-region data store, then verify freshness before apps start. Check first that the store actually HAS a promote/restore path in the recovery region — a plan step for a mechanism that does not exist is worse than no step.';
    }
    case 'messaging-inflight':
      return 'NOT a promote/restore step — SQS and Kinesis have no native cross-region replication, so there is nothing to promote and nothing to restore. What this block actually does: (a) recreate/confirm the queue or stream exists in the recovery region (shape, from IaC — a precondition, not an event-day action); (b) enable the recovery-region consumers (Lambda event source mapping execution block, or scale up your consumer deployments); (c) execute the recorded in-flight decision for this component — re-drive from the durable source of truth, or accept and log the documented loss window. If no decision is recorded on the component, that is a gap to close before the plan is trusted, not a step to improvise at 3am. Also decide NOW what happens to the impaired region\'s backlog when it returns (purge / quarantine / idempotent reprocess).';
    case 'compute-scale-up': return 'Scale EKS node groups / ASG / ECS services from standby to production capacity. Capacity is not guaranteed — a scaling block asks the region and the region answers, so watch for insufficient-capacity errors and consider on-demand capacity reservations for Tier-0.';
    case 'route53-health-check': return 'Route 53 health check execution block — redirects live public DNS traffic to the target region via health-check state (data plane, no record edits during the event). This is the L7 cutover: it must run AFTER the L6 verification and AFTER a manual-approval block.';
    case 'routing-control': return 'ARC routing control execution block — flips routing-control state to shift live public traffic (data plane). This is the L7 cutover: it must run AFTER the L6 verification and AFTER a manual-approval block.';
    case 'edge-precondition': return 'Edge entry point (API Gateway / load balancer / CDN / WAF), not a traffic switch — the plan does not move traffic here. Verify, don\'t create: the edge exists in the recovery region, its certificate is valid for the public domain (ACM is regional), target groups/VPC links are healthy, and partner/WAF allowlists include the recovery egress IPs. Prove it with the direct endpoint plus a Host header so no public DNS is touched.';
    case 'manual-partner-action': return 'Cannot be automated by the plan — partner coordination step (allowlists, egress IPs, notifications). This is an L5 precondition of the success bar: it must be verified BEFORE the L6 bar and long before the L7 cutover, because a partner allowlist is the one thing you cannot fix during the event.';
    case 'precondition': return 'Must already be true in the recovery region before execution (IaC-deployed ahead of time) — verify, don\'t create.';
    default: return 'App-specific step — implement as a custom Lambda execution block. Note: ungraceful mode SKIPS custom Lambda blocks, so never put a must-run data action here without confirming that behaviour.';
  }
}

// The two blocks every drafted plan must contain, regardless of inventory shape:
// an L6 functional verification, and a human approval in front of the live cutover.
// "Human decides, machine executes" — no component in an inventory is ever a
// "success bar" or an "approval", so these can only come from here.
function verificationBlock(order) {
  return {
    order,
    blockType: 'l6-verification',
    name: 'L6 — functional success bar (business transaction, in the recovery region)',
    components: [],
    layer: 'L6',
    notes: 'Injected by DR Compass, not derived from your inventory: no component is ever a "success bar", so a plan drafted purely from components contains no proof that anything works. Run the agreed business transaction end to end against the recovery region using the DIRECT endpoint plus a Host header (no public DNS change yet), and the batch/settlement path too. Region switch has no block type for this — implement it as a Custom action Lambda that fails the plan on a bad response, and/or hold here on a manual-approval block while a human runs it. Green pods are not recovery.',
    verify: 'Business transaction executed against the recovery region via the direct endpoint; batch/settlement path also exercised',
    pass: 'A correct business-level response with a real transaction id (not a health check, not a 500) AND the batch path completes. First success = T1; RTA = T1 - T0.',
    gate: true,
  };
}

function approvalBlock(order, what, why) {
  return {
    order,
    blockType: 'manual-approval',
    name: `Manual approval — ${what}`,
    components: [],
    layer: 'L6',
    notes: `Injected by DR Compass: ${why} Region switch's Manual approval execution block pauses the execution and sets the status to pending approval; approve with 'aws arc-region-switch approve-plan-execution-step --plan-arn <arn> --execution-id <id> --step-name <step> --approval approve' (or 'decline' to cancel the execution). The named decision-maker approves in writing with the reason recorded.`,
    verify: 'Approval (or decline) recorded against the execution step, with approver name, timestamp and reason',
    pass: 'Approved by the named decision-maker — or declined, which cancels the execution',
    gate: true,
  };
}

function regionSwitchPlan(ws, components) {
  const primary = ws.regions?.primary, recovery = ws.regions?.recovery;
  if (!primary || !recovery) {
    return { applicable: false, why: 'Primary and recovery regions are not both set in Settings.', plan: null };
  }
  const inScope = components.filter((c) => c.inRecoveryScope === 'yes' || c.inRecoveryScope === 'partial');
  if (!inScope.length) {
    return { applicable: false, why: 'No components marked in recovery scope — build the inventory first.', plan: null };
  }
  // Group by (layer, blockType), ordered by restore layer.
  const groups = new Map();
  const relabelled = [];
  for (const c of inScope) {
    const declared = LAYER_ORDER.includes(c.restoreLayer) ? c.restoreLayer : 'L4';
    const type = blockTypeFor(c);
    // A block that moves live public traffic is L7 in the drafted plan no matter what
    // layer the component carries. Sorting strictly by the declared layer is how a
    // workspace whose edge is labelled L5 got a plan that cut traffic before L6.
    const layer = TRAFFIC_BLOCK_TYPES.has(type) ? 'L7' : declared;
    if (layer !== declared) relabelled.push(`${c.name} (${declared} → L7)`);
    const key = `${layer}|${type}`;
    if (!groups.has(key)) groups.set(key, { layer, type, comps: [] });
    groups.get(key).comps.push(c);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || a.type.localeCompare(b.type));
  const derived = ordered.map((g) => ({
    order: 0,
    blockType: g.type,
    name: `${g.layer} — ${g.type.replace(/-/g, ' ')} (${g.comps.length} component${g.comps.length > 1 ? 's' : ''})`,
    components: g.comps.map((c) => c.name),
    layer: g.layer,
    notes: blockNotes(g.type, g.comps),
    verify: '',
    pass: '',
    gate: true,
  }));

  // ---- inject the blocks no inventory can produce -------------------------
  const steps = [];
  let approvedData = false;
  for (const s of derived) {
    // An approval in front of the first irreversible data promotion.
    if (!approvedData && IRREVERSIBLE_DATA_BLOCK_TYPES.has(s.blockType)) {
      approvedData = true;
      steps.push(approvalBlock(0, 'authorize data promotion',
        'the next block moves a data primary, and in ungraceful mode that is lossy and not cleanly reversible. The mode decision (graceful = switchover, RPO 0, needs a healthy primary; ungraceful = failover, loses the replication lag and does NOT demote the old writer) is approved here, with the expected loss window written down. Fence the old primary before this block runs.'));
      steps[steps.length - 1].layer = s.layer;
    }
    steps.push(s);
  }
  // L6 verification, then approval, immediately before the first traffic block.
  const firstTrafficIdx = steps.findIndex((s) => TRAFFIC_BLOCK_TYPES.has(s.blockType));
  const gateBlocks = [
    verificationBlock(0),
    approvalBlock(0, 'authorize the L7 live-traffic cutover',
      'the next block moves live customer traffic. It must not run until the L6 business transaction above has passed in the recovery region, the partner/edge allowlists and certificates are confirmed, and a named decision-maker has said go.'),
  ];
  if (firstTrafficIdx === -1) {
    // No traffic block in the inventory — the plan still owes an L6 verification, and
    // the cutover is then a manual step outside the plan. Say so.
    const v = verificationBlock(0);
    v.notes += ' NOTE: this drafted plan contains no traffic-switching block, so the L7 cutover is a MANUAL step outside the plan — add it to the runbook explicitly, after this verification, with its own approval.';
    steps.push(v);
  } else {
    steps.splice(firstTrafficIdx, 0, ...gateBlocks);
  }
  steps.forEach((s, i) => { s.order = i + 1; });

  const why = `${inScope.length} in-scope components across ${new Set(ordered.map((g) => g.layer)).size} restore layers can be expressed as ordered execution blocks. `
    + 'An L6 functional-verification block and manual-approval blocks are always injected — no component is ever a "success bar" or an "approval", so a plan drafted only from inventory would cut traffic without ever proving a business transaction. '
    + `Execution mode is a separate, recorded decision at run time: 'graceful' for a planned switchover (both regions healthy, zero data loss expected) or 'ungraceful' for an unplanned failover (primary unreachable, data loss possible, some blocks skipped). There is no practice mode — you rehearse by executing in graceful mode.${relabelled.length ? ` Traffic-moving blocks were re-layered to L7 regardless of the component's declared layer: ${relabelled.join(', ')}.` : ''}`;

  return {
    applicable: true,
    why,
    plan: {
      name: `${ws.name || ws.slug} — ${primary} → ${recovery} failover`,
      mode: 'active-passive',
      regions: [primary, recovery],
      steps,
    },
  };
}

// ------------------------------------------------------------- gap scan

function detectGaps(ws, components, tests, runbooks) {
  const gaps = [];
  for (const c of components) {
    const tier = Number.isFinite(c.tier) ? c.tier : 99;
    if ((c.inRecoveryScope === 'no' || c.inRecoveryScope === 'unknown') && tier <= 1) {
      gaps.push({
        rule: 'component-out-of-scope',
        title: `${c.name} is ${c.inRecoveryScope === 'no' ? 'not' : 'of unknown status'} in recovery scope`,
        // Shared table (audit R-6): this used to be 'high' here and 'blocker' in
        // service.js for the same fact, so two pages disagreed.
        severity: severityFor('component-out-of-scope', { tier, scope: c.inRecoveryScope }),
        componentId: c.id,
        why: `Tier-${tier} component with inRecoveryScope='${c.inRecoveryScope}' — it will not exist after failover unless deliberately excluded.`,
      });
    }
    for (const call of c.outboundCalls || []) {
      const fb = String(call.failoverBehavior || '').trim();
      if (call.critical && (call.type === 'third-party' || call.type === 'saas') && (!fb || /manual/i.test(fb))) {
        gaps.push({
          rule: 'manual-third-party-failover',
          title: `Critical third-party call '${call.target}' has ${fb ? 'a manual' : 'no'} failover behavior`,
          severity: severityFor('manual-third-party-failover', { tier, critical: true }),
          componentId: c.id,
          why: `${c.name} depends on ${call.target} (${call.purpose || 'critical path'}); ${fb ? `'${fb}' means a human in the loop during the event` : 'nobody has written down what happens on failover'}.`,
        });
      }
    }
    for (const s of c.secrets || []) {
      if (s.replicated !== 'yes') {
        gaps.push({
          rule: 'unreplicated-secret',
          title: `Secret '${s.name}' not confirmed replicated`,
          severity: severityFor('unreplicated-secret', { tier, replicated: s.replicated || 'unknown' }),
          componentId: c.id,
          why: `replicated='${s.replicated || 'unset'}' — unresolved secrets are the most common cause of failed recovery tests (crash-looping secrets-init).`,
        });
      }
    }
    if (tier <= 1 && !(c.verification?.command || '').trim()) {
      gaps.push({
        rule: 'missing-verification',
        title: `${c.name} has no verification step`,
        severity: severityFor('missing-verification', { tier, isRoot: false }),
        componentId: c.id,
        why: 'Without a written verify command + pass criterion, "recovered" is a feeling, not a fact.',
      });
    }
  }
  for (const tool of ws.tooling || []) {
    if (!runbooks.some((r) => r.tooling === tool)) {
      gaps.push({
        rule: 'no-runbook-for-tooling',
        title: `No runbook for tooling '${tool}'`,
        severity: severityFor('no-runbook-for-tooling', {}),
        why: `'${tool}' is in the workspace tooling list but no runbook exercises it — a tool nobody has steps for is shelfware in a disaster.`,
      });
    }
  }

  // ---- objectives vs evidence ------------------------------------------------
  // Whether a number is measured is decided in ONE place. This route used to ask
  // the question itself; it now asks the helper, so it cannot drift from the
  // service profile, the workbook or the AI context.
  const numbers = measuredNumbers(ws, tests, null, { components, runbooks });
  if (Number.isFinite(ws.objectives?.rtoMinutes) && numbers.rta.state !== 'measured') {
    gaps.push({
      rule: 'unverified-objective',
      title: `RTO target set (${ws.objectives.rtoMinutes}m) but no passed test has measured RTA`,
      severity: severityFor('unverified-objective', {}),
      why: `Until a passed test produces an RTA, the RTO is a hope. Quote only measured numbers.${
        numbers.rta.state === 'declared' ? ` objectives.rtaMinutes currently holds ${numbers.rta.minutes} — typed in Settings, with no test behind it.` : ''}`,
    });
  }
  for (const [label, entry, field] of [['RTA', numbers.rta, 'rtaMinutes'], ['RPA', numbers.rpa, 'rpaMinutes']]) {
    if (entry.state !== 'declared') continue;
    const attempt = numbers.evidence.lastAttempt;
    gaps.push({
      rule: 'unverified-objective',
      title: `objectives.${field} (${entry.minutes}m) is typed, not measured`,
      severity: severityFor('unverified-objective', {}),
      why: `${entry.note}${attempt && attempt.status === 'failed'
        && (attempt.rtaMinutes === entry.minutes || attempt.rpaMinutes === entry.minutes)
        ? ` It matches ${attempt.name}, which FAILED — a failed run has no ${label}, only a time to failure.`
        : ''} Reasoning from it as if it were evidence is the one thing this product exists not to do.`,
    });
  }
  if (numbers.rta.stale || numbers.rpa.stale) {
    gaps.push({
      rule: 'stale-evidence',
      title: `The measured numbers are ${numbers.rta.staleDays ?? numbers.rpa.staleDays} days old`,
      severity: severityFor('stale-evidence', {}),
      why: `Evidence older than ${numbers.evidence.staleAfterDays} days describes a system that has since changed. Schedule the next test before quoting these numbers.`,
    });
  }
  return gaps;
}

// --------------------------------------------------------------- route

router.post('/w/:ws/recommend', (req, res, next) => {
  try {
    const ws = getWorkspace(req.params.ws);
    const components = getCollection(req.params.ws, 'components');
    const tests = getCollection(req.params.ws, 'tests');
    const runbooks = getCollection(req.params.ws, 'runbooks');
    const catalog = loadCatalog();
    // Severity order, so the list leads with what blocks recovery.
    const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };
    const gaps = detectGaps(ws, components, tests, runbooks)
      .sort((a, b) => (SEV[a.severity] ?? 4) - (SEV[b.severity] ?? 4) || String(a.title).localeCompare(String(b.title)));
    const dataLayer = dataLayerProfile(components);
    res.json({
      strategy: {
        current: ws.strategy || null,
        fit: strategyFit(ws, catalog, { components, tests, runbooks }),
        // Additive: the evidence the fit was judged on, so a reader can check
        // the reasoning instead of trusting a verdict word (audit K-7).
        dataLayer: {
          weakestClass: dataLayer.weakestClass,
          weakestStore: dataLayer.weakest
            ? { componentId: dataLayer.weakest.componentId, name: dataLayer.weakest.name, mechanism: dataLayer.weakest.mechanism }
            : null,
          declaredFloorRpoMinutes: dataLayer.declaredFloorRpoMinutes,
          floorIsComplete: dataLayer.floorIsComplete,
          storesJudged: dataLayer.judged.length,
          judged: dataLayer.judged.map((s) => ({ componentId: s.componentId, name: s.name, tier: s.tier, mechanism: s.mechanism, mechanismClass: s.mechanismClass, rpoMinutes: s.rpoMinutes })),
          notJudged: dataLayer.stores.filter((s) => !s.rpoBearing).map((s) => ({ componentId: s.componentId, name: s.name, role: s.role })),
          storesWithoutRpoNumber: dataLayer.withoutNumbers.map((s) => s.name),
          storesWithoutMechanism: dataLayer.unrecorded.map((s) => s.name),
          stores: dataLayer.stores,
          note: 'The data layer vetoes: a warm stack in front of a nightly copy still has a nightly-copy RPO. Mechanism numbers are CLAIMS — set them from observed lag in drills, not from the vendor page.',
        },
      },
      tooling: toolingVerdicts(ws, components, runbooks),
      regionSwitch: regionSwitchPlan(ws, components),
      gapsDetected: gaps,
      // Additive: what the gap list actually says, so a page can lead with the
      // three things that matter instead of 26 rows in inventory order.
      gapSummary: {
        total: gaps.length,
        byRule: gaps.reduce((a, g) => { a[g.rule] = (a[g.rule] || 0) + 1; return a; }, {}),
        bySeverity: gaps.reduce((a, g) => { a[g.severity] = (a[g.severity] || 0) + 1; return a; }, {}),
      },
      // Additive: the workspace-level measured numbers, so anything reading this
      // response knows which of RTO/RPO/RTA/RPA are targets and which are
      // evidence. The strategy fit above is judged against TARGETS only — it is
      // a "could this strategy plausibly support your objectives" question, and
      // it deliberately does not reason from RTA/RPA at all.
      numbers: measuredNumbers(ws, tests, null, { components, runbooks }),
    });
  } catch (e) { next(e); }
});

export default router;
