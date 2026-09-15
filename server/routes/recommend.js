// Strategy / tooling recommender + Region-switch plan skeleton + template serving.
// Owned by agent: runbooks-tests.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspace, getCollection, httpError } from '../store.js';

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

function strategyFit(ws, catalog) {
  const rto = ws.objectives?.rtoMinutes;
  const rpo = ws.objectives?.rpoMinutes;
  return catalog.map((s) => {
    const floorRto = Number.isFinite(s.rtoFloorMinutes) ? s.rtoFloorMinutes : 60;
    const floorRpo = Number.isFinite(s.rpoFloorMinutes) ? s.rpoFloorMinutes : 30;
    let verdict, why;
    if (!Number.isFinite(rto) && !Number.isFinite(rpo)) {
      verdict = 'stretch';
      why = 'No RTO/RPO targets set yet — set objectives in Settings to judge fit.';
    } else {
      const rtoOk = !Number.isFinite(rto) || rto >= floorRto;
      const rpoOk = !Number.isFinite(rpo) || rpo >= floorRpo;
      const rtoClose = Number.isFinite(rto) && rto < floorRto && rto >= floorRto / 2;
      const rpoClose = Number.isFinite(rpo) && rpo < floorRpo && rpo >= floorRpo / 2;
      if (rtoOk && rpoOk) {
        const overkill = Number.isFinite(rto) && rto >= floorRto * 12 && floorRto <= 10;
        verdict = overkill ? 'stretch' : 'ok';
        why = overkill
          ? `Targets (RTO ${rto}m) are far looser than what ${s.name} delivers — likely paying for more than you need.`
          : `Typical ${s.name} recovery (~${floorRto}m RTO / ~${floorRpo}m RPO floor) meets your targets (RTO ${rto ?? '—'}m / RPO ${rpo ?? '—'}m).`;
      } else if ((rtoOk || rtoClose) && (rpoOk || rpoClose)) {
        verdict = 'stretch';
        why = `Targets are tighter than ${s.name} typically achieves (~${floorRto}m RTO / ~${floorRpo}m RPO) — possible with heavy optimization, but fragile.`;
      } else {
        verdict = 'mismatch';
        why = `Your targets (RTO ${rto ?? '—'}m / RPO ${rpo ?? '—'}m) are well below what ${s.name} can deliver (~${floorRto}m / ~${floorRpo}m).`;
      }
    }
    return { strategyId: s.id, verdict, why };
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
        ? 'In evaluation/use — build the plan in BOTH regions and run practice mode quarterly.'
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

function blockTypeFor(c) {
  const kind = String(c.kind || '').toLowerCase();
  const cat = c.category || '';
  if (cat === 'database' || cat === 'storage' || cat === 'messaging-streaming') return 'data-switchover';
  if (cat === 'compute') return 'compute-scale-up';
  if (cat === 'edge-dns') return /route53|dns/.test(kind) ? 'route53-health-check' : 'routing-control';
  if (cat === 'third-party') return 'manual-partner-action';
  if (cat === 'cicd-control-plane' || cat === 'identity-access' || cat === 'security-secrets' || cat === 'networking') return 'precondition';
  return 'custom-lambda';
}

function blockNotes(type, comps) {
  switch (type) {
    case 'data-switchover': {
      const aurora = comps.some((c) => /aurora/i.test(c.kind || '') || /aurora/i.test(c.name || ''));
      return aurora
        ? 'Managed switchover (e.g. Aurora Global Database) — promote recovery-region writer; zero loss when planned.'
        : 'Promote/restore recovery-region data stores; verify freshness before apps start.';
    }
    case 'compute-scale-up': return 'Scale EKS node groups / ASG / ECS services from standby to production capacity.';
    case 'route53-health-check': return 'Flip traffic via Route 53 health-check inversion or alias update — the final block.';
    case 'routing-control': return 'ARC routing control / edge configuration change to shift traffic.';
    case 'manual-partner-action': return 'Cannot be automated by the plan — partner coordination step (allowlists, notifications).';
    case 'precondition': return 'Must already be true in the recovery region before execution (IaC-deployed ahead of time) — verify, don\'t create.';
    default: return 'App-specific step — implement as a custom Lambda execution block.';
  }
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
  for (const c of inScope) {
    const layer = LAYER_ORDER.includes(c.restoreLayer) ? c.restoreLayer : 'L4';
    const type = blockTypeFor(c);
    const key = `${layer}|${type}`;
    if (!groups.has(key)) groups.set(key, { layer, type, comps: [] });
    groups.get(key).comps.push(c);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || a.type.localeCompare(b.type));
  const steps = ordered.map((g, i) => ({
    order: i + 1,
    blockType: g.type,
    name: `${g.layer} — ${g.type.replace(/-/g, ' ')} (${g.comps.length} component${g.comps.length > 1 ? 's' : ''})`,
    components: g.comps.map((c) => c.name),
    layer: g.layer,
    notes: blockNotes(g.type, g.comps),
  }));
  return {
    applicable: true,
    why: `${inScope.length} in-scope components across ${new Set(ordered.map((g) => g.layer)).size} restore layers can be expressed as ordered execution blocks.`,
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
        title: `${c.name} is ${c.inRecoveryScope === 'no' ? 'not' : 'of unknown status'} in recovery scope`,
        severity: tier === 0 ? 'high' : 'medium',
        componentId: c.id,
        why: `Tier-${tier} component with inRecoveryScope='${c.inRecoveryScope}' — it will not exist after failover unless deliberately excluded.`,
      });
    }
    for (const call of c.outboundCalls || []) {
      const fb = String(call.failoverBehavior || '').trim();
      if (call.critical && (call.type === 'third-party' || call.type === 'saas') && (!fb || /manual/i.test(fb))) {
        gaps.push({
          title: `Critical third-party call '${call.target}' has ${fb ? 'a manual' : 'no'} failover behavior`,
          severity: 'high',
          componentId: c.id,
          why: `${c.name} depends on ${call.target} (${call.purpose || 'critical path'}); ${fb ? `'${fb}' means a human in the loop during the event` : 'nobody has written down what happens on failover'}.`,
        });
      }
    }
    for (const s of c.secrets || []) {
      if (s.replicated !== 'yes') {
        gaps.push({
          title: `Secret '${s.name}' not confirmed replicated`,
          severity: tier === 0 ? 'blocker' : 'high',
          componentId: c.id,
          why: `replicated='${s.replicated || 'unset'}' — unresolved secrets are the most common cause of failed recovery tests (crash-looping secrets-init).`,
        });
      }
    }
    if (tier <= 1 && !(c.verification?.command || '').trim()) {
      gaps.push({
        title: `${c.name} has no verification step`,
        severity: 'medium',
        componentId: c.id,
        why: 'Without a written verify command + pass criterion, "recovered" is a feeling, not a fact.',
      });
    }
  }
  for (const tool of ws.tooling || []) {
    if (!runbooks.some((r) => r.tooling === tool)) {
      gaps.push({
        title: `No runbook for tooling '${tool}'`,
        severity: 'medium',
        why: `'${tool}' is in the workspace tooling list but no runbook exercises it — a tool nobody has steps for is shelfware in a disaster.`,
      });
    }
  }
  if (Number.isFinite(ws.objectives?.rtoMinutes)) {
    const measured = tests.some((t) => t.status === 'passed' && Number.isFinite(t.results?.rtaMinutes));
    if (!measured) {
      gaps.push({
        title: `RTO target set (${ws.objectives.rtoMinutes}m) but no passed test has measured RTA`,
        severity: 'high',
        why: 'Until a passed test produces an RTA, the RTO is a hope. Quote only measured numbers.',
      });
    }
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
    res.json({
      strategy: { current: ws.strategy || null, fit: strategyFit(ws, catalog) },
      tooling: toolingVerdicts(ws, components, runbooks),
      regionSwitch: regionSwitchPlan(ws, components),
      gapsDetected: detectGaps(ws, components, tests, runbooks),
    });
  } catch (e) { next(e); }
});

export default router;
