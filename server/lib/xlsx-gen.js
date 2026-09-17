// DR Compass — Excel workbook + CSV dataset generation.
// buildWorkbook(slug) is used by both the export route and `drcompass export`.
//
// Scoped ("DR package for THIS service") exports: pass {componentIds, rootName}
// as the optional second argument. Omit it and output is identical to before —
// the scope layer only ever narrows the loaded data (see applyScope).
//
// Visual system (every sheet):
//   row 1  merged title that TEACHES — Arial 14 bold #202124, no fill
//   row 2  column headers — #3C6958 fill, white bold Arial 10
//   panes frozen at A3; data rows Arial 10, zebra #F8F9FA / white by row parity
//   parent rows (L0/L1) #F1F3F4 bold; component rows (L2) bold on the zebra
//   dropdowns via dataValidation lists; status tints via conditional formatting
//
// Sheet system: five TREE sheets share ONE 11-column grid (TREE_COLUMNS) —
//   Resource Graph  the inventory, category-spined, expandable to the resource
//   Runtime         the traffic path: who calls a service, what it calls
//   Dependencies    the recovery order, restore-layer-spined (L0 first)
//   Tests           what has actually been measured, per test
//   Workbench       Phase 0 gate, gaps, secrets, verification, people, rules
// plus Executive Summary (the one-pager) and Runbooks (procedure + steps), and
// How to use, which explains all of them. Category/Group repeat on every
// descendant row, so filtering one section of a tree sheet reproduces any of
// the thin single-purpose sheets this design replaced.
import ExcelJS from 'exceljs';
import * as store from '../store.js';
// The Diagrams tab, and the environment/service scope label every sheet
// carries. Self-contained: see server/lib/xlsx-diagrams.js for why the
// diagram is drawn in cells rather than embedded as an image.
import { decorateWorkbook } from './xlsx-diagrams.js';
// The pre-cutover gate library — the same import server/routes/exports.js uses.
// The rule that an L7 traffic step is unreachable without a POPULATED L6
// verification gate is defined once, in web/js/cutover.js, and every export
// reads it from there. Until this import existed the workbook — the artifact
// people print for a bridge call and hand to auditors — was the one export that
// could not see an ungated cutover, and rendered it as an ordinary row.
import { auditCutoverGate, onFailOf } from '../../web/js/cutover.js';

// ------------------------------------------------- the honest-numbers helper
//
// `server/lib/measured.js` is the single source of truth for which numbers may
// be called MEASURED. It is loaded optionally: if it is not present (older
// checkout, partial deploy) the local implementation below applies exactly the
// same rule. What never happens either way is a hand-typed number being
// labelled measured or achieved — the fallback degrades to "recorded by hand",
// never to the old behaviour.
let sharedMeasured = null;
let sharedFormatNumber = null;
let sharedCoverage = null;
try {
  const mod = await import('./measured.js');
  const fn = mod.measuredNumbers || mod.default?.measuredNumbers || mod.default;
  if (typeof fn === 'function') sharedMeasured = fn;
  if (typeof mod.formatNumber === 'function') sharedFormatNumber = mod.formatNumber;
  if (typeof mod.coverageOf === 'function') sharedCoverage = mod.coverageOf;
} catch { sharedMeasured = null; sharedFormatNumber = null; sharedCoverage = null; }

/**
 * Does this passed test's evidence actually cover the WORKSPACE, rather than
 * some component inside it?
 *
 * `coverageOf(test, null)` answers 'direct' only when the test was
 * workspace-scoped — it named no components (a whole-estate exercise) or it
 * named every component in the critical set. A test that adjudication ran on
 * its own measured adjudication, not the system, and quoting its 47 minutes as
 * the programme's recovery time is exactly the failure this product exists to
 * stop. When measured.js is unavailable the gate falls back to the same rule
 * expressed locally: a test that names components is scoped evidence.
 */
function coversWholeWorkspace(test) {
  if (sharedCoverage) return sharedCoverage(test, null) === 'direct';
  const named = [
    ...(Array.isArray(test?.componentIds) ? test.componentIds : []),
    ...(test?.componentId ? [test.componentId] : []),
    ...((test?.appTests || []).map((a) => a?.componentId).filter(Boolean)),
  ];
  return named.length === 0;
}

// --------------------------------------------- the computed risk engine
//
// Audit NEW-8. The `risks` block in execModel below is the hand-written GAP
// LIST. The risk engine in server/routes/service.js — the twelve regional
// failure-mode rules plus the structural ones — was never consulted by either
// board-facing artifact, so a workspace whose Tier-0 service had a dangling
// dependency id ("a HOLE in this service's restore order") printed
// "No open gaps are recorded. Either the plan is genuinely clean…" on both the
// Executive Summary sheet and EXECUTIVE-SUMMARY.md. The two most senior-sounding
// artifacts this product produces were the two that did not know what it found.
//
// Loaded LAZILY and never at module top level: routes/service.js imports THIS
// module with a top-level await, and two top-level awaited imports pointing at
// each other deadlock. By the time anything asks for a digest both modules are
// fully evaluated, so the lazy import is a cache hit.
let riskEngineOnce = null;
function loadRiskEngine() {
  if (!riskEngineOnce) {
    riskEngineOnce = import('../routes/service.js')
      .then((m) => (typeof m.serviceProfile === 'function' ? m.serviceProfile : null))
      .catch((e) => {
        console.error(`[drcompass] executive summary: computed risks unavailable (${e.message})`);
        return null;
      });
  }
  return riskEngineOnce;
}

// The rules are per-service and walk a full closure each time, so this is
// bounded. Tier 0 and Tier 1 are the components the plan exists for; a workspace
// with none falls back to the lowest tier it does have, and says which.
const RISK_SCAN_LIMIT = 25;
const DIGEST_SEV_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };
// Holes in the restore ORDER. The shared severity table grades both `high`,
// and the audit was explicit that neither may be rounded to "clean".
const STRUCTURAL_HOLE_RULES = new Set(['dangling-dependency', 'layer-inversion']);

/**
 * computedRiskDigest(slug, scope) -> the HEADLINE of what the risk engine found,
 * or null when the engine cannot be loaded. Deliberately NOT the whole list: the
 * exec surfaces get the count, the worst few and a pointer to where the detail
 * lives, because a board pack that reprints forty findings is read by nobody.
 */
export async function computedRiskDigest(slug, scope = null) {
  const serviceProfile = await loadRiskEngine();
  if (!serviceProfile) return null;
  let components = [];
  try { components = store.getCollection(slug, 'components') || []; } catch { return null; }
  if (!components.length) return null;
  const byId = new Map(components.map((c) => [c.id, c]));
  const tierOf = (c) => (typeof c.tier === 'number' && Number.isFinite(c.tier) ? c.tier : 9);
  const inScope = (c) => String(c.inRecoveryScope || 'unknown') !== 'no';

  let subjects;
  let criticalTier = 1;
  if (scope && scope.rootId && byId.has(scope.rootId)) {
    subjects = [byId.get(scope.rootId)];
  } else {
    subjects = components.filter((c) => tierOf(c) <= 1 && inScope(c));
    if (!subjects.length) {
      const tiers = components.filter(inScope).map(tierOf);
      const lowest = tiers.length ? Math.min(...tiers) : null;
      criticalTier = lowest == null ? 9 : lowest;
      subjects = lowest == null ? [] : components.filter((c) => tierOf(c) === lowest && inScope(c));
    }
  }
  subjects = subjects.slice().sort((a, b) => tierOf(a) - tierOf(b)
    || String(a.name || '').localeCompare(String(b.name || '')));
  const requested = subjects.length;
  subjects = subjects.slice(0, RISK_SCAN_LIMIT);
  if (!subjects.length) return null;

  // The same finding surfaces on every service whose closure contains it, so it
  // is de-duplicated on rule + component + title. `via` keeps the first service
  // it fired on — that is where a reader goes to see it in context.
  const seen = new Set();
  const findings = [];
  const scannedNames = [];
  let failed = 0;
  for (const c of subjects) {
    let profile = null;
    try { profile = serviceProfile(slug, c.id); } catch { failed += 1; continue; }
    scannedNames.push(c.name || c.id);
    for (const f of (profile?.risksAll || [])) {
      const key = `${f.rule}|${f.componentId || ''}|${f.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        rule: String(f.rule || ''),
        severity: String(f.severity || 'medium'),
        title: String(f.title || ''),
        detail: String(f.detail || ''),
        componentId: String(f.componentId || ''),
        component: f.componentName || byId.get(f.componentId)?.name || 'workspace-wide',
        blocksRecovery: !!f.blocksRecovery,
        via: c.name || c.id,
        viaId: c.id,
      });
    }
  }
  findings.sort((a, b) => (DIGEST_SEV_RANK[a.severity] ?? 4) - (DIGEST_SEV_RANK[b.severity] ?? 4)
    || Number(b.blocksRecovery) - Number(a.blocksRecovery)
    || a.title.localeCompare(b.title));

  // What counts as a BLOCKER for the purpose of refusing to say "clean":
  // severity `blocker`, plus the two STRUCTURAL rules — a dependency id that
  // points at nothing and an inverted restore layer are holes in the restore
  // ORDER, and the shared table grades both `high`. An exec surface may not
  // round a hole to "clean" because the severity word happened to be "high".
  //
  // Deliberately NOT everything in BLOCKS_RECOVERY: on the seed that is 75 of
  // 161 findings, and a headline that says 75 blockers is read as wallpaper.
  // The severity breakdown carries the rest.
  const blockers = findings.filter((f) => f.severity === 'blocker' || STRUCTURAL_HOLE_RULES.has(f.rule));
  const holes = blockers.filter((f) => f.severity !== 'blocker');
  const bySeverity = ['blocker', 'high', 'medium', 'low']
    .map((s) => [s, findings.filter((f) => f.severity === s).length])
    .filter(([, n]) => n);
  const ruleList = [...new Set(blockers.map((f) => f.rule))];

  return {
    available: true,
    scanned: scannedNames.length,
    requested,
    truncated: requested > subjects.length,
    failed,
    criticalTier,
    scannedNames,
    total: findings.length,
    bySeverity,
    blockerCount: blockers.length,
    holeCount: holes.length,
    blockers: blockers.slice(0, 5),
    blockerRules: ruleList.slice(0, 4),
    blockerRulesMore: Math.max(0, ruleList.length - 4),
    // Reported separately so a reader can see how much of the list the shared
    // BLOCKS_RECOVERY table considers recovery-stopping, without that number
    // becoming the headline.
    blocksRecoveryCount: findings.filter((f) => f.blocksRecovery).length,
    top: findings.slice(0, 5),
    where: scope && scope.rootId
      ? 'the Service profile page for this service'
      : 'the Service profile page for each Tier-0/Tier-1 component',
  };
}

// Attach the digest to a loaded dataset before execModel reads it. Kept separate
// so execModel itself stays synchronous and every existing caller still works.
async function attachComputedRisks(slug, d) {
  try { d.computedRisks = await computedRiskDigest(slug, d.scope || null); } catch { d.computedRisks = null; }
  return d;
}

// ------------------------------------------------------- palette / typography

const INK = 'FF202124';
const WHITE = 'FFFFFFFF';
const HEADER_GREEN = 'FF3C6958';
const HEADER_EDGE = 'FF2A4C40';
const ZEBRA = 'FFF8F9FA';
const PARENT_FILL = 'FFF1F3F4';
const LINK = 'FF1155CC';
const MUTED = 'FF5F6368';

const TINT = {
  ok:   { fill: 'FFE6F4EA', font: 'FF137333' },
  err:  { fill: 'FFFCE8E6', font: 'FFA50E0E' },
  warn: { fill: 'FFFEF7E0', font: 'FFB06000' },
};

const ARIAL = (extra = {}) => ({ name: 'Arial', size: 10, ...extra });
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

// ------------------------------------------------------------ dropdown lists

const LIST_STATUS = '"Pass,Fail,Partial,Not reached,Unknown,Accepted,N/A,Not started,In Progress,Blocked"';
const LIST_YESNO = '"Yes,No"';
// The recovery-scope column: our own yes/partial/no/unknown, plus Auto (covered
// by the tool without being listed) and Stale (listed but no longer real).
const LIST_DR_SCOPE = '"Yes,Partial,Auto,No,Unknown,Stale"';

// Conditional-formatting rule sets: [cellValue, tintKind]
const CF_STATUS = [['Pass', 'ok'], ['Fail', 'err'], ['Blocked', 'err'], ['Partial', 'warn'], ['Not reached', 'warn']];
const CF_TREE_STATUS = [...CF_STATUS, ['Stale', 'warn']];
const CF_TREE_SCOPE = [['Yes', 'ok'], ['No', 'err'], ['Partial', 'warn'], ['Unknown', 'warn'], ['Stale', 'warn']];
const CF_SEVERITY = [['blocker', 'err'], ['high', 'err'], ['medium', 'warn']];

const TEST_STATUS_DISPLAY = {
  passed: 'Pass', failed: 'Fail', planned: 'Not started',
  'in-progress': 'In Progress', canceled: 'N/A',
};

// ---------------------------------------------------------------- constants

const LAYER_LABELS = {
  L0: 'L0 guardrails/backups green', L1: 'L1 recovery launch/replication',
  L2: 'L2 platform', L3: 'L3 data + secrets', L4: 'L4 applications',
  L5: 'L5 edge/network reachability', L6: 'L6 functional success bar',
  L7: 'L7 live traffic cutover',
};
const layerOrder = (l) => {
  const n = parseInt(String(l || '').replace(/^L/i, ''), 10);
  return Number.isFinite(n) ? n : 99;
};

const MATURITY_LABELS = ['0 — None', '1 — Backups', '2 — Documented',
  '3 — Tested once', '4 — Repeatable loop', '5 — Production-proven'];

const CATEGORY_ORDER = ['compute', 'networking', 'storage', 'database',
  'messaging-streaming', 'security-secrets', 'edge-dns', 'identity-access',
  'observability', 'third-party', 'cicd-control-plane', 'other'];

const CATEGORY_LABELS = {
  compute: 'COMPUTE', networking: 'NETWORKING', storage: 'STORAGE',
  database: 'DATABASE', 'messaging-streaming': 'MESSAGING & STREAMING',
  'security-secrets': 'SECURITY & SECRETS', 'edge-dns': 'EDGE & DNS',
  'identity-access': 'IDENTITY & ACCESS / IAM', observability: 'OBSERVABILITY',
  'third-party': 'THIRD-PARTY', 'cicd-control-plane': 'CI/CD & CONTROL PLANE',
  other: 'OTHER',
};
const categoryLabel = (cat) => CATEGORY_LABELS[cat]
  || String(cat || 'other').replace(/-/g, ' ').toUpperCase();

// The sheets buildWorkbook writes, in order (Deployment Order appears only when
// the deploy-order engine is available). Kept as one list so the How-to-use
// guide, the scope suffixes and the workbook can never disagree. Every name is
// inside Excel's 31-character limit and free of / \ ? * [ ].
const SHEETS = {
  exec: 'Executive Summary',
  brief: 'How we fail this over',  // the narrative one-pager — read aloud in a meeting
  guide: 'How to use',
  graph: 'Resource Graph',
  runtime: 'Runtime',
  egress: 'Outbound Calls',
  deps: 'Dependencies',
  deploy: 'Deployment Order',
  tests: 'Tests',
  runbooks: 'Runbooks',
  workbench: 'Workbench',
};

// Group a component's components by category, in CATEGORY_ORDER then extras.
function byCategory(components) {
  const m = new Map();
  for (const c of components) {
    const k = c.category || 'other';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  const keys = [...CATEGORY_ORDER.filter((k) => m.has(k)),
    ...[...m.keys()].filter((k) => !CATEGORY_ORDER.includes(k))];
  return keys.map((k) => [k, m.get(k).sort((a, b) =>
    (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name))]);
}

// ---------------------------------------------------------------- data load

// ------------------------------------------------ defensive field coercion
//
// Every list this file walks comes out of the store, and the store is not the
// only writer: the AI path, an imported document and a hand-edited JSON file
// all land records here. A `tests` record whose `findings` arrived as the
// STRING "All application tests passed." applied cleanly through the AI path
// and then 500'd the workbook, executive-summary.md AND failover-brief.md — a
// DR package that cannot be generated during an incident is its own hazard.
// So the reporting path coerces the shapes it did not write, ONCE, on load:
// a field that should be a list and is not becomes an empty list, and nothing
// below here has to ask again. (`server/lib/measured.js` holds the same line
// with the same `arr()` rule — this is that rule, applied to the whole file.)
const arr = (v) => (Array.isArray(v) ? v : []);

// Shallow-copy each record, replacing only the named fields that are not lists.
function hardenRows(rows, fields, nested = null) {
  return arr(rows)
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      let out = r;
      for (const f of fields) {
        if (out[f] !== undefined && !Array.isArray(out[f])) {
          if (out === r) out = { ...r };
          out[f] = [];
        }
      }
      return nested ? nested(out) : out;
    });
}

// The list fields the sheets, the CSVs and the models iterate. Named explicitly
// rather than walked generically: a coercion nobody declared is a coercion
// nobody can review.
function hardenData(d) {
  const steps = (list) => hardenRows(list, ['tests', 'componentIds', 'requires']);
  d.components = hardenRows(d.components,
    ['dependsOn', 'secrets', 'outboundCalls', 'resourceDetails', 'awsServices', 'gaps', 'tags']);
  d.tests = hardenRows(d.tests, ['findings', 'appTests', 'componentIds']);
  d.runbooks = hardenRows(d.runbooks, ['steps', 'rollback', 'preconditions', 'linkedTestIds'],
    (rb) => ({ ...rb, steps: steps(rb.steps), rollback: steps(rb.rollback) }));
  d.checklists = hardenRows(d.checklists, ['items']);
  d.services = hardenRows(d.services, ['componentIds', 'tags']);
  d.gaps = hardenRows(d.gaps, []);
  d.contacts = hardenRows(d.contacts, []);
  d.decisions = hardenRows(d.decisions, []);
  d.documents = hardenRows(d.documents, []);
  d.meta = {
    ...(d.meta || {}),
    tooling: arr(d.meta?.tooling),
    environments: arr(d.meta?.environments).filter((e) => e && typeof e === 'object'),
  };
  if (d.resourceGraph && typeof d.resourceGraph === 'object') {
    d.resourceGraph = {
      ...d.resourceGraph,
      nodes: d.resourceGraph.nodes && typeof d.resourceGraph.nodes === 'object' && !Array.isArray(d.resourceGraph.nodes)
        ? d.resourceGraph.nodes : {},
      edges: arr(d.resourceGraph.edges),
    };
  }
  if (d.k8s && typeof d.k8s === 'object') {
    d.k8s = {
      ...d.k8s,
      workloads: hardenRows(d.k8s.workloads, ['images', 'configmaps', 'secrets']),
      services: hardenRows(d.k8s.services, ['targets', 'ports']),
      ingresses: hardenRows(d.k8s.ingresses, ['backends', 'hosts']),
      namespaces: hardenRows(d.k8s.namespaces, []),
    };
  }
  return d;
}

function loadData(slug, scope = null) {
  const meta = store.getWorkspace(slug);
  const d = { meta, assessment: store.getObject(slug, 'assessment') };
  d.resourceGraph = store.getObject(slug, 'resource-graph');
  d.k8s = store.getObject(slug, 'k8s');
  for (const c of store.COLLECTIONS) d[c] = arr(store.getCollection(slug, c));
  // Before ANY index is built off these rows (see byId below) or any sheet
  // walks them.
  hardenData(d);
  // Lookup maps stay WORKSPACE-WIDE even when scoped: names/relations rendered
  // inside a scoped sheet still resolve (a scoped row may point outward).
  d.byId = new Map(d.components.map((c) => [c.id, c]));
  d.nameOf = (id) => d.byId.get(id)?.name || (id || '');
  d.usedBy = new Map();
  d.usedByIds = new Map();
  for (const c of d.components) {
    for (const dep of c.dependsOn || []) {
      if (!d.usedBy.has(dep)) { d.usedBy.set(dep, []); d.usedByIds.set(dep, []); }
      d.usedBy.get(dep).push(c.name);
      d.usedByIds.get(dep).push(c.id);
    }
  }
  const allTests = d.tests;
  const allRunbooks = d.runbooks;
  d.testNameOf = (id) => allTests.find((t) => t.id === id)?.name || (id || '');
  d.runbookNameOf = (id) => allRunbooks.find((r) => r.id === id)?.name || '';
  d.scope = null;
  if (scope) applyScope(d, scope);
  return d;
}

// ------------------------------------------------------------------- scope

// Root + transitive dependsOn closure (cycle-safe) + DIRECT dependents of the
// root (one level — they carry the blast radius). Throws 404 on unknown root.
export function serviceClosure(components, rootId) {
  const all = components || [];
  const byId = new Map(all.map((c) => [c.id, c]));
  const root = byId.get(rootId);
  if (!root) throw store.httpError(404, `no component '${rootId}'`);

  const seen = new Set([rootId]);
  const deps = [];
  const queue = [rootId];
  while (queue.length) {
    const cur = byId.get(queue.shift());
    for (const dep of cur?.dependsOn || []) {
      if (seen.has(dep) || !byId.has(dep)) continue; // cycle-safe + drops dangling ids
      seen.add(dep);
      deps.push(dep);
      queue.push(dep);
    }
  }
  const dependents = [];
  for (const c of all) {
    if (c.id === rootId || seen.has(c.id)) continue; // already in the closure
    if ((c.dependsOn || []).includes(rootId)) { seen.add(c.id); dependents.push(c.id); }
  }
  return {
    ids: [rootId, ...deps, ...dependents],
    root,
    depsCount: deps.length,
    dependentsCount: dependents.length,
  };
}

function normalizeScope(opts) {
  const ids = arr(opts?.componentIds).map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  return {
    ids: new Set(ids),
    rootId: opts.rootId || '',
    rootName: opts.rootName || '',
    depsCount: n(opts.depsCount),
    dependentsCount: n(opts.dependentsCount),
    // docs/ENV-SERVICE-MODEL.md §3. These arrive on every scope that
    // server/lib/export-scope.js resolves, and dropping them here is how the
    // Executive Summary sheet came to print "not scoped" on a sheet whose own
    // title said "Staging environment", the WORKSPACE region pair as the
    // environment's, and the workspace objective as a service's commitment.
    // Carried, not interpreted: every reader below treats each one as optional.
    envId: opts.envId || null,
    envName: s(opts.envName),
    envRegions: opts.envRegions && typeof opts.envRegions === 'object' ? opts.envRegions : null,
    serviceId: opts.serviceId || null,
    serviceName: s(opts.serviceName),
    empty: !!opts.empty,
    label: s(opts.label),
    sentence: s(opts.sentence),
    warnings: arr(opts.warnings),
    // What narrowing to this scope took out of frame — the counts and the
    // English. The Diagrams sheet has printed these since v0.7; sheet 1, the
    // page people actually print, had not.
    hidden: opts.hidden && typeof opts.hidden === 'object' ? opts.hidden : null,
    hiddenSentences: arr(opts.hiddenSentences),
  };
}

// Component links declared by a runbook's steps (+ rollback steps).
const runbookComponentIds = (rb) => [...(rb.steps || []), ...(rb.rollback || [])]
  .flatMap((s) => s.componentIds || []).filter(Boolean);

// Narrow every collection on `d` to the scope. Only ever removes rows; the
// workspace-wide lookup maps built in loadData are left intact.
function applyScope(d, scope) {
  const has = (id) => !!id && scope.ids.has(id);
  const anyIn = (ids) => (ids || []).some(has);
  d.scope = scope;

  d.components = d.components.filter((c) => has(c.id));

  // Runbooks: linked to something in scope, or generic (no component links at
  // all, tooling consistent with the workspace) — those stay as package context.
  const tooling = (d.meta.tooling || []).map((t) => String(t).toLowerCase());
  d.runbooks = d.runbooks.filter((rb) => {
    const links = runbookComponentIds(rb);
    if (links.length) return links.some(has);
    return !tooling.length || !rb.tooling || tooling.includes(String(rb.tooling).toLowerCase());
  }).map((rb) => (runbookComponentIds(rb).length ? rb : { ...rb, scopeGeneric: true }));

  const rbIds = new Set(d.runbooks.map((rb) => rb.id));
  d.tests = d.tests.filter((t) => rbIds.has(t.runbookId)
    || (t.appTests || []).some((a) => has(a.componentId)));

  // Scoped gaps, plus workspace-wide gaps (no component) flagged in the sheet.
  d.gaps = d.gaps.filter((g) => !g.componentId || has(g.componentId));

  // Resource graph: nodes intersecting scope; unlinked nodes are dropped.
  // Edges are kept — they only feed the Relation column lookup.
  const nodes = {};
  for (const [k, n] of Object.entries(d.resourceGraph?.nodes || {})) {
    if (anyIn(n.componentIds)) nodes[k] = n;
  }
  d.resourceGraph = { ...(d.resourceGraph || {}), nodes };

  if (d.k8s) {
    const workloads = (d.k8s.workloads || []).filter((w) => has(w.componentId));
    const uids = new Set(workloads.map((w) => w.uid));
    const nsNames = new Set(workloads.map((w) => w.namespace || 'default'));
    const services = (d.k8s.services || []).filter((s) => (s.targets || []).some((u) => uids.has(u)));
    const svcKey = (ns, name) => `${ns || ''}/${name || ''}`;
    const svcKeys = new Set(services.map((s) => svcKey(s.namespace, s.name)));
    const ingresses = (d.k8s.ingresses || []).filter((x) => (x.backends || []).some((b) => {
      const name = b && typeof b === 'object' ? (b.service || b.name) : b;
      return svcKeys.has(svcKey(x.namespace, name));
    }));
    d.k8s = {
      ...d.k8s,
      workloads,
      services,
      ingresses,
      namespaces: (d.k8s.namespaces || []).filter((n) => nsNames.has(n.name)),
    };
  }
  return d;
}

// What a scoped package contains — backs GET /export/scope/:id and the bundle.
export function scopeSelection(slug, opts) {
  const d = loadData(slug, normalizeScope(opts));
  return {
    componentIds: d.components.map((c) => c.id),
    components: d.components.map((c) => ({
      id: c.id, name: c.name, category: c.category || '', tier: c.tier ?? null,
    })),
    runbookIds: d.runbooks.map((rb) => rb.id),
    testIds: d.tests.map((t) => t.id),
    gapIds: d.gaps.map((g) => g.id),
  };
}

// Sheets whose rows are narrowed by scope — their title row names the service.
const SCOPE_KEY = Symbol('drScope');
// Workspace name / generated date / scope label, for print headers and footers.
const META_KEY = Symbol('drPrintMeta');
// (The tree sheets are absent on purpose: each one already names the service in
// its own teaching title, so the generic suffix would double it up.)
const SCOPED_SHEETS = new Set([
  SHEETS.tests, SHEETS.runbooks, SHEETS.workbench,
]);

// Gap rows: workspace-wide gaps are kept in a scoped package, flagged as such.
const gapComponent = (d, g) => d.nameOf(g.componentId) || (d.scope ? '(workspace-wide)' : '');

function maturity(assessment) {
  const answers = Object.values(assessment?.answers || {}).filter((v) => typeof v === 'number');
  if (!answers.length) return null;
  const avg = answers.reduce((a, b) => a + b, 0) / answers.length; // 0..4 scale
  const level = Math.max(0, Math.min(5, Math.round((avg / 4) * 5)));
  return { avg, level, label: MATURITY_LABELS[level], answered: answers.length };
}

const join = (arr, sep = ', ') => (arr || []).filter(Boolean).join(sep);
const ownerTeam = (c) => join([c.owner, c.team], ' / ');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : '');
const yn = (v) => (v ? 'Yes' : 'No');
const cap = (v) => (v ? String(v)[0].toUpperCase() + String(v).slice(1) : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------- datasets (xlsx + csv share)

// Each dataset: columns [{header, width, wrap?, numFmt?}], rows(d) -> [][]
// NOTE: these back the CSV endpoints — headers and row shapes are a contract.
const DATASETS = {
  'components': {
    title: 'Dependency Inventory',
    columns: [
      { header: 'Name', width: 30 }, { header: 'Category', width: 18 },
      { header: 'Kind', width: 16 }, { header: 'Tier', width: 6, numFmt: '0' },
      { header: 'Owner / Team', width: 22 }, { header: 'Restore Layer', width: 12 },
      { header: 'Scope', width: 10 }, { header: 'DR Strategy', width: 14 },
      { header: 'Replication Mechanism', width: 20 }, { header: 'RPO (min)', width: 10, numFmt: '0' },
      { header: 'Depends On', width: 34, wrap: true }, { header: 'Used By', width: 34, wrap: true },
      { header: 'AWS Services', width: 22, wrap: true }, { header: 'Defined In', width: 26 },
      { header: 'Verification Command', width: 36, wrap: true }, { header: 'Verification Pass', width: 32, wrap: true },
      { header: 'Gaps', width: 42, wrap: true }, { header: 'Notes', width: 36, wrap: true },
      // APPENDED, never inserted: this dataset backs components.csv and the
      // header/row shape is a contract, so a consumer reading by position is
      // unaffected. Discovery records an `arn` on every proposal it imports and
      // it appeared nowhere in the workbook or the CSV.
      { header: 'ARN', width: 56 },
    ],
    rows: (d) => [...d.components]
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
      .map((c) => [
        c.name, c.category || '', c.kind || '', num(c.tier), ownerTeam(c),
        c.restoreLayer || '', c.inRecoveryScope || '', c.drStrategy || '',
        c.replication?.mechanism || '', num(c.replication?.rpoMinutes),
        join((c.dependsOn || []).map(d.nameOf)), join(d.usedBy.get(c.id)),
        join(c.awsServices), c.definedIn || '',
        c.verification?.command || '', c.verification?.pass || '',
        join(c.gaps, '; '), c.notes || '', c.arn || '',
      ]),
  },
  'outbound-calls': {
    title: 'Outbound Calls',
    columns: [
      { header: 'Component', width: 28 }, { header: 'Target', width: 30 },
      { header: 'Type', width: 14 }, { header: 'Protocol', width: 10 },
      { header: 'Purpose', width: 38, wrap: true },
      { header: 'Failover Behavior', width: 46, wrap: true }, { header: 'Critical', width: 9 },
    ],
    rows: (d) => d.components.flatMap((c) => (c.outboundCalls || []).map((o) => [
      c.name, o.target || '', o.type || '', o.protocol || '', o.purpose || '',
      o.failoverBehavior || '', o.critical ? 'yes' : 'no',
    ])),
  },
  'secrets': {
    title: 'Secrets Reconciliation',
    note: 'Reconcile ALL secret lists (recovery tool, manual lists, runtime logical names) into ONE signed-off list. Unknowns here are the most common cause of failed recovery tests.',
    columns: [
      { header: 'Component', width: 28 }, { header: 'Secret Name', width: 36 },
      { header: 'ARN', width: 44, wrap: true }, { header: 'Replicated', width: 12 },
      { header: 'Notes', width: 48, wrap: true },
    ],
    rows: (d) => d.components.flatMap((c) => (c.secrets || []).map((s) => [
      c.name, s.name || '', s.arn || '', s.replicated || 'unknown', s.notes || '',
    ])),
  },
  'gaps': {
    title: 'Gap List',
    columns: [
      { header: 'Title', width: 44, wrap: true }, { header: 'Category', width: 18 },
      { header: 'Class', width: 20 }, { header: 'Severity', width: 10 },
      { header: 'Component', width: 26 }, { header: 'Status', width: 10 },
      { header: 'Ticket', width: 14 }, { header: 'Notes', width: 44, wrap: true },
    ],
    rows: (d) => d.gaps.map((g) => [
      g.title || '', g.category || '', g.class || '', g.severity || '',
      gapComponent(d, g), g.status || '', g.ticket || '', g.notes || '',
    ]),
  },
  'runbook-steps': {
    title: 'Runbook Steps',
    columns: [
      { header: 'Runbook', width: 26 }, { header: '#', width: 5 },
      { header: 'Layer', width: 7 }, { header: 'Title', width: 30, wrap: true },
      { header: 'Detail', width: 46, wrap: true }, { header: 'Command', width: 40, wrap: true },
      { header: 'Verify', width: 32, wrap: true }, { header: 'Pass', width: 30, wrap: true },
      { header: 'Owner', width: 14 }, { header: 'Est (min)', width: 9, numFmt: '0' },
      { header: 'Gate?', width: 7 }, { header: 'Record', width: 26, wrap: true },
      // Appended, never inserted: the twelve columns above are a contract and
      // keep their order and meaning. `Gate?` is the legacy per-step flag
      // somebody ticked; these two are what the cutover gate ACTUALLY audits to
      // — without them this dataset could not tell a reader that row 3 moves
      // live traffic with nothing verified above it.
      { header: 'Cutover gate', width: 46, wrap: true },
      { header: 'Gate checks', width: 60, wrap: true },
    ],
    rows: (d) => d.runbooks.flatMap((rb) => {
      const g = gateFacts(rb);
      return [
        ...arr(rb.steps).map((s, i) => stepRow(rb.name, i + 1, s, g, i)),
        ...arr(rb.rollback).map((s, i) => stepRow(rb.name, `R${i + 1}`, s)),
      ];
    }),
  },
  'tests': {
    title: 'Test Log',
    columns: [
      { header: 'Name', width: 30 }, { header: 'Type', width: 15 },
      { header: 'Status', width: 12 }, { header: 'Date', width: 12 },
      { header: 'Runbook', width: 26 }, { header: 'RTA (min)', width: 10, numFmt: '0' },
      { header: 'RPA (min)', width: 10, numFmt: '0' }, { header: 'Clean Run', width: 10 },
      { header: 'Findings', width: 9, numFmt: '0' },
    ],
    rows: (d) => d.tests.map((t) => [
      t.name || '', t.type || '', t.status || '', t.date || '',
      d.runbookNameOf(t.runbookId),
      num(t.results?.rtaMinutes), num(t.results?.rpaMinutes),
      t.results?.cleanRun ? 'yes' : 'no', (t.findings || []).length,
    ]),
  },
  'checklists': {
    title: 'Checklists',
    columns: [
      { header: 'Checklist', width: 28 }, { header: 'Kind', width: 12 },
      { header: 'Item', width: 46, wrap: true }, { header: 'Why', width: 42, wrap: true },
      { header: 'Proof', width: 34, wrap: true }, { header: 'Owner', width: 16 },
      { header: 'Done', width: 8 },
    ],
    rows: (d) => d.checklists.flatMap((cl) => (cl.items || []).map((it) => [
      cl.name || '', cl.kind || '', it.text || '', it.why || '', it.proof || '',
      it.owner || '', it.done ? 'yes' : 'no',
    ])),
  },
  'decisions': {
    title: 'Decision Log',
    columns: [
      { header: 'Date', width: 12 }, { header: 'Title', width: 34, wrap: true },
      { header: 'Context', width: 48, wrap: true }, { header: 'Decision', width: 48, wrap: true },
      { header: 'Owner', width: 16 }, { header: 'Status', width: 10 },
    ],
    rows: (d) => d.decisions.map((x) => [
      x.date || '', x.title || '', x.context || '', x.decision || '', x.owner || '', x.status || '',
    ]),
  },
  'contacts': {
    title: 'People',
    columns: [
      { header: 'Name', width: 24 }, { header: 'Role', width: 24 },
      { header: 'Responsibilities', width: 52, wrap: true }, { header: 'Contact', width: 28 },
      { header: 'Escalation', width: 28, wrap: true },
    ],
    rows: (d) => d.contacts.map((p) => [
      p.name || '', p.role || '', p.responsibilities || '', p.contact || '', p.escalation || '',
    ]),
  },
  'verification-catalog': {
    title: 'Verification Catalog',
    note: 'Every component with a defined verification, ordered by restore layer — run top to bottom during recovery.',
    columns: [
      { header: 'Layer', width: 26 }, { header: 'Component', width: 30 },
      { header: 'Command', width: 56, wrap: true }, { header: 'Pass Criteria', width: 52, wrap: true },
    ],
    rows: (d) => d.components
      .filter((c) => c.verification?.command || c.verification?.pass)
      .sort((a, b) => layerOrder(a.restoreLayer) - layerOrder(b.restoreLayer) || a.name.localeCompare(b.name))
      .map((c) => [
        LAYER_LABELS[c.restoreLayer] || c.restoreLayer || '', c.name,
        c.verification?.command || '', c.verification?.pass || '',
      ]),
  },
  'resource-graph': {
    title: 'Resource Graph',
    columns: [
      { header: 'Component', width: 26 }, { header: 'Type', width: 18 },
      { header: 'Name', width: 30 }, { header: 'RID / ARN', width: 46 },
      { header: 'Relation', width: 18 }, { header: 'Region', width: 12 },
      { header: 'Details', width: 50, wrap: true }, { header: 'Tags', width: 30 },
      { header: 'Source', width: 12 },
    ],
    rows: (d) => flatGraphRows(d),
  },
  'k8s-workloads': {
    title: 'K8s Workloads',
    columns: [
      { header: 'Namespace', width: 22 }, { header: 'Kind', width: 13 },
      { header: 'Name', width: 30 }, { header: 'Ready', width: 9 },
      { header: 'Images', width: 46, wrap: true }, { header: 'Service Account', width: 20 },
      { header: 'ConfigMaps', width: 28 }, { header: 'Secrets', width: 28 },
      { header: 'Component', width: 26 },
    ],
    rows: (d) => (d.k8s?.workloads || []).map((w) => [
      w.namespace || '', w.kind || '', w.name || '', readyText(w),
      join(w.images), w.serviceAccount || '', join(w.configmaps), join(w.secrets),
      d.nameOf(w.componentId),
    ]),
  },
};

// ------------------------------------------------------- the cutover gate
//
// One reading of `auditCutoverGate` per runbook, turned into the few facts a
// renderer needs. Both the Runbooks sheet and the runbook-steps CSV read it, so
// the sheet and the dataset cannot disagree about whether a step is safe to
// run — and neither of them words the rule itself.
//
// Never throws: a runbook shaped in a way the library did not expect costs the
// gate columns, never the workbook.

// What a step's own row says about itself, in TEXT. Colour alone is not a
// warning — these sheets get printed in greyscale for a bridge call.
const GATE_FLAG = {
  'traffic-before-verification': '*** BLOCKED — DO NOT RUN ***',
  'traffic-without-approval': '*** NO APPROVAL — DO NOT RUN ***',
  'empty-gate': '*** EMPTY GATE — nothing is verified here ***',
  'no-blocking-test': '!! GATE CANNOT FAIL',
  'no-pass-criterion': '!! NO PASS CRITERION',
  'approval-before-verification': '!! APPROVAL COMES BEFORE THE GATE',
};

const gateCheckText = (t) => `${onFailOf(t) === 'block' ? 'BLOCKING' : 'advisory'}: ${String(t?.name || '—').replace(/\r?\n/g, ' ')}`
  + `${t?.expected ? ` — pass when ${String(t.expected).replace(/\r?\n/g, ' ')}` : ' — NO pass criterion'}`
  + `${t?.owner ? ` (${t.owner})` : ' (owner unassigned)'}`;

function gateFacts(rb) {
  let audit = null;
  try { audit = auditCutoverGate(rb); } catch { return null; }
  if (!audit) return null;
  const findings = arr(audit.findings);
  const findingsAt = new Map();
  for (const f of findings) {
    if (!Number.isFinite(f?.index)) continue;
    if (!findingsAt.has(f.index)) findingsAt.set(f.index, []);
    findingsAt.get(f.index).push(f);
  }
  const blocked = new Set(arr(audit.blockedIndexes));
  const errs = findings.filter((f) => f.severity === 'err');
  const warns = findings.filter((f) => f.severity === 'warn');
  const gateTests = arr(audit.gateTests);
  const blockingCount = gateTests.filter((t) => onFailOf(t) === 'block').length;
  const testsAt = new Map(arr(audit.verificationSteps).map((v) => [v.index, arr(v.tests)]));
  const approvalAt = new Set(arr(audit.approvalSteps).map((a) => a.index));
  const trafficAt = new Set(arr(audit.trafficSteps).map((t) => t.index));

  // What the runbook's header row says. Empty when this runbook has no cutover
  // at all and no gate — those runbooks read exactly as they did before.
  const headline = blocked.size
    ? `*** CUTOVER NOT GATED — ${plural(blocked.size, 'traffic step')} BLOCKED ***`
    : errs.length ? `*** CUTOVER GATE FAULT — ${plural(errs.length, 'finding')} ***`
      : warns.length ? `cutover gate: ${plural(warns.length, 'warning')}`
        : trafficAt.size || gateTests.length
          ? `cutover gate: ${plural(gateTests.length, 'check')}, ${blockingCount} blocking`
          : '';

  const flagAt = (i) => {
    if (blocked.has(i)) return GATE_FLAG['traffic-before-verification'];
    const at = findingsAt.get(i) || [];
    const worst = at.find((f) => f.severity === 'err') || at.find((f) => f.severity === 'warn') || null;
    return worst ? (GATE_FLAG[worst.kind] || '!! GATE FINDING') : '';
  };

  // The state cell for the CSV: what this step IS in the gate, in one phrase.
  const stateAt = (i) => {
    const flag = flagAt(i);
    const tests = testsAt.get(i);
    const role = tests ? (tests.length
      ? `pre-cutover verification gate — ${plural(tests.length, 'check')}, `
        + `${tests.filter((t) => onFailOf(t) === 'block').length} blocking`
      : 'pre-cutover verification gate — EMPTY')
      : approvalAt.has(i) ? 'cutover approval'
        : trafficAt.has(i) ? 'moves live traffic' : '';
    const why = (findingsAt.get(i) || []).map((f) => String(f.text).replace(/\r?\n/g, ' ')).join(' ');
    return join([flag, role, why], ' — ');
  };

  return {
    audit,
    findings,
    findingsAt,
    blocked,
    headline,
    flagAt,
    stateAt,
    testsAt,
    hasErr: !!errs.length,
    worstSeverity: errs.length ? 'err' : warns.length ? 'warn' : findings.length ? 'info' : '',
    checksAt: (i) => arr(testsAt.get(i)),
  };
}

function stepRow(rbName, n, s, gate = null, i = -1) {
  const checks = gate && i >= 0 ? gate.checksAt(i) : [];
  return [rbName, n, s.layer || '', s.title || '', s.detail || '', s.command || '',
    s.verify || '', s.pass || '', s.owner || '', num(s.estMinutes),
    s.gate ? 'yes' : '', s.record || '',
    gate && i >= 0 ? gate.stateAt(i) : '',
    checks.map(gateCheckText).join(' · ')];
}

export const CSV_SHEETS = Object.keys(DATASETS);

// Returns {headers, rows} for one CSV sheet name; throws 404 on unknown sheet.
// Optional {componentIds} narrows the rows to a service package (headers are a
// contract and never change).
export function csvDataset(slug, sheet, scopeOpts = {}) {
  const ds = DATASETS[sheet];
  if (!ds) throw store.httpError(404, `unknown export sheet '${sheet}' — one of: ${CSV_SHEETS.join(', ')}`);
  const d = loadData(slug, normalizeScope(scopeOpts));
  return { headers: ds.columns.map((c) => c.header), rows: ds.rows(d) };
}

// ------------------------------------------------------------ sheet helpers

function colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------------------------------------------------- print / page setup
//
// Every sheet gets repeat header rows, fit-to-width, and a header/footer naming
// the workspace, the sheet, the generated date and page numbers — so anything
// anyone prints looks deliberate. Sheets people actually carry into a meeting
// (Executive Summary, Gap List, Checklists, Runbook Steps, Verification
// Catalog) additionally pick their own orientation and, for the one-pager, a
// print area that stops at the end of the summary.

// Excel header/footer codes use & as an escape, so a literal & must be doubled.
const ampEscape = (s) => String(s ?? '').replace(/&/g, '&&');

// Header/footer text is limited in practice; keep the parts short and tidy.
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Same, but backing up to a word boundary — the executive one-pager clips a lot
// of titles and a cut mid-word reads like a bug rather than a decision.
const clipWords = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—-]+$/, '')}…`;
};

function applyPrintSetup(wb, ws, title, opts = {}) {
  const meta = wb[META_KEY] || {};
  const { orientation = null, fitHeight = 0, printArea = null, landscapeAt = 7 } = opts;
  const orient = orientation || (ws.columnCount > landscapeAt ? 'landscape' : 'portrait');
  ws.pageSetup = {
    ...(ws.pageSetup || {}),
    orientation: orient,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: fitHeight,
    horizontalCentered: false,
    printTitlesRow: '1:2',
    margins: {
      left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3,
    },
    ...(printArea ? { printArea } : {}),
  };
  const left = ampEscape(clip(meta.name || 'DR Compass', 60));
  const right = ampEscape(clip(title, 70));
  const scopeBit = meta.scopeLabel ? ` · ${ampEscape(clip(meta.scopeLabel, 40))}` : '';
  ws.headerFooter = {
    differentFirst: false,
    differentOddEven: false,
    oddHeader: `&L&"Arial,Bold"&11${left}&R&"Arial,Regular"&9${right}`,
    oddFooter: `&L&"Arial,Regular"&8Generated ${meta.generated || ''} by DR Compass${scopeBit}`
      + '&C&"Arial,Regular"&8Page &P of &N'
      + `&R&"Arial,Regular"&8${ampEscape(clip(ws.name, 40))}`,
  };
  return ws;
}

// Shared shell: title row 1 (merged), header row 2 (green), panes frozen below
// the header (and optionally to the left of `freezeCols`, so a wide sheet keeps
// its context columns on screen when you scroll right).
function addSheet(wb, name, title, columns, {
  note, outline = false, freezeCols = 0, zoom = null, gridLines = true, print = null,
} = {}) {
  const home = `${colLetter(freezeCols + 1)}3`;
  const ws = wb.addWorksheet(name, {
    views: [{
      state: 'frozen',
      xSplit: freezeCols,
      ySplit: 2,
      topLeftCell: home,
      activeCell: home,
      zoomScale: zoom || (columns.length > 10 ? 90 : 100),
      showGridLines: gridLines,
    }],
    properties: {
      tabColor: { argb: HEADER_GREEN },
      ...(outline ? { outlineProperties: { summaryBelow: false, summaryRight: false } } : {}),
    },
  });
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 16; });

  const scope = wb[SCOPE_KEY];
  const t = ws.addRow([scope?.rootName && SCOPED_SHEETS.has(name)
    ? `${title} — ${scope.rootName} service` : title]);
  t.height = 28;
  ws.mergeCells(1, 1, 1, columns.length);
  const tc = t.getCell(1);
  tc.font = ARIAL({ size: 14, bold: true, color: { argb: INK } });
  tc.alignment = { vertical: 'middle', horizontal: 'left' };
  if (note) tc.note = note;

  const h = ws.addRow(columns.map((c) => c.header));
  h.height = 20;
  columns.forEach((c, i) => {
    const cell = h.getCell(i + 1);
    cell.font = ARIAL({ bold: true, color: { argb: WHITE } });
    cell.fill = solid(HEADER_GREEN);
    cell.alignment = { vertical: 'middle', horizontal: c.align || 'left', wrapText: false };
    cell.border = { bottom: { style: 'thin', color: { argb: HEADER_EDGE } } };
  });
  applyPrintSetup(wb, ws, tc.value, print || {});
  return ws;
}

// A bare "YYYY-MM-DD" string becomes a real Excel date so date columns sort and
// format consistently. Anything else is left exactly as it came in.
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function asDate(v) {
  const m = typeof v === 'string' ? v.match(ISO_DAY) : null;
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? v : d;
}

// One data row with per-column alignment/wrap/link/numFmt/validation + zebra.
// `indent` shifts the column flagged {indentable:true} — that is how the
// Dependencies tree shows its hierarchy without relying on outline buttons.
function dataRow(ws, columns, values, {
  stripe = false, level = 0, hidden = false, indent = 0,
} = {}) {
  const row = ws.addRow(values.map((v, i) => (columns[i]?.date ? asDate(v) : v)));
  if (level) row.outlineLevel = level;
  if (hidden) row.hidden = true;
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    const extra = c.link && values[i] ? { color: { argb: LINK } } : {};
    cell.font = c.mono && values[i] ? { name: 'Courier New', size: 9, ...extra } : ARIAL(extra);
    cell.alignment = {
      vertical: 'top',
      horizontal: c.align || 'left',
      wrapText: !!c.wrap,
      ...(indent && c.indentable ? { indent } : {}),
    };
    if (c.date && cell.value instanceof Date) cell.numFmt = c.numFmt || 'yyyy-mm-dd';
    else if (c.numFmt && typeof cell.value === 'number') cell.numFmt = c.numFmt;
    if (stripe) cell.fill = solid(ZEBRA);
    if (c.list) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [c.list] };
  });
  return row;
}

// Parent/summary row for outlined sheets (and section headers): #F1F3F4, bold, merged.
// Pass values:[...] instead of text to keep individual columns (no merge).
// `merge: false` on a sheet that carries an autoFilter: the fill still spans
// every column and left-aligned text still spills across the empty cells to its
// right, so the row looks identical — but filtering a range that contains
// merged cells is a well-known source of Excel complaints, so we don't.
function groupRow(ws, columns, text, {
  level = 0, values = null, indent = 0, size = 10, fill = PARENT_FILL, merge = true,
} = {}) {
  const row = ws.addRow(values || [text]);
  if (level) row.outlineLevel = level;
  row.height = size >= 11 ? 20 : 18;
  for (let i = 1; i <= columns.length; i++) {
    const cell = row.getCell(i);
    if (fill) cell.fill = solid(fill);
    cell.font = ARIAL({ bold: true, size, color: { argb: INK } });
    cell.alignment = { vertical: 'middle', horizontal: 'left', ...(indent ? { indent } : {}) };
  }
  if (!values && merge) ws.mergeCells(row.number, 1, row.number, columns.length);
  return row;
}

// Second green header band mid-sheet (K8s Network ingress table).
function bandHeader(ws, labels) {
  const row = ws.addRow(labels);
  row.height = 20;
  labels.forEach((_, i) => {
    const cell = row.getCell(i + 1);
    cell.font = ARIAL({ bold: true, color: { argb: WHITE } });
    cell.fill = solid(HEADER_GREEN);
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
    cell.border = { bottom: { style: 'thin', color: { argb: HEADER_EDGE } } };
  });
  return row;
}

// Conditional formatting tints (only the status-like cell itself).
function addCF(ws, colIdx, firstRow, lastRow, rules) {
  if (lastRow < firstRow) return;
  const L = colLetter(colIdx);
  ws.addConditionalFormatting({
    ref: `${L}${firstRow}:${L}${lastRow}`,
    rules: rules.map(([val, kind], i) => ({
      type: 'cellIs', operator: 'equal', formulae: [`"${val}"`], priority: i + 1,
      style: {
        font: { color: { argb: TINT[kind].font } },
        fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: TINT[kind].fill } },
      },
    })),
  });
}

// AutoFilter over a grouped/outlined sheet: the dropdowns sit on the green
// header row and cover every data row, so "show me everything not in scope"
// works the same way it does on the flat sheets.
function filterAll(ws, columnCount) {
  if (ws.rowCount <= 2) return ws;
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: ws.rowCount, column: columnCount } };
  return ws;
}

// ------------------------------------------------------------ How to use
//
// Four columns, in the reference's voice: what the sheet is, what YOU do with
// it, and what it looks like when it arrives. The last rows are the mechanics —
// the +/- margin, the Google Sheets import, the Status dropdown, and the rule
// that governs every number in the workbook.

function sheetGuide(d, { deployOrder = false } = {}) {
  const rows = [];
  const add = (sheet, what, starts) => rows.push([sheet, what, starts]);

  add(SHEETS.guide, 'This page. Read the last five rows before you touch anything else — they are the mechanics.', '—');
  add(SHEETS.exec,
    'Read this first, and nothing else if you have 90 seconds: what this covers, the strategy, the honest numbers '
    + '(targets vs measured), the top risks with owners, the test history and the next actions. It prints to one page.',
    'Computed from this workspace — nothing estimated');
  add(SHEETS.brief,
    'The narrative. One page you can read out loud in a meeting and an engineer can still follow: what this '
    + 'system is, what it is made of in plain language, the order it comes back in and WHY that order, what has '
    + 'to be true before you start, where it breaks today, the honest numbers and who does what. Every sentence '
    + 'is derived from this workspace — when you disagree with one, open the sheet it points at.',
    'Derived from the inventory, the deployment-order engine and the risk rules');
  add(SHEETS.graph,
    'The inventory. Expand a CATEGORY → a component → its resources. An EKS cluster opens into namespaces, a namespace '
    + 'into workloads, a workload into the secrets it mounts, an Ingress into the load balancer it created, a database '
    + 'into its subnet group → subnets → AZs. Category and Group repeat on every row, so filter either one.',
    'Categories visible; the depth sits behind + in the left margin');
  add(SHEETS.runtime,
    'The traffic path. Expand a service for its namespace and IaC repo, who calls it, and what it calls: Calls → a sync '
    + 'request, Writes → a data store, Publishes → a queue or topic, Feeds → a file hand-off. A sync call takes the '
    + 'path down with it; an async one can lag.',
    'Services visible');
  if (d.components.some((c) => (c.outboundCalls || []).length)) {
    add(SHEETS.egress,
      'Every destination each service talks to, one row per destination + protocol + port (a flow seen 4,000 times is '
      + 'ONE row with Observed 4000). Expand a service → a destination class: Startup first (nothing there can wait — '
      + 'the pod is not Ready without it), then AWS, internal, third-party, SaaS. Day-0? = Yes means the call BLOCKS '
      + 'recovery. Red rows are the classic killers: a partner call with no failover story, a target out of scope, an '
      + 'allowlist / static-egress-IP dependency, or a target built in a later deployment wave than its caller.',
      'Summary block first, then services worst-first');
  }
  add(SHEETS.deps,
    'The recovery order. Restore layer (L0 first) → component → what it needs, what needs it, and the gaps against it. '
    + 'Each dependency shows ITS OWN layer and posture — that is what tells you whether it will be there.',
    'Layers and components visible');
  if (deployOrder) {
    // Only present when server/lib/deploy-order.js is there to compute it.
    add(SHEETS.deploy,
      'What has to be built before what: wave → category → resource, with what each resource waits for and why. '
      + 'Everything inside a wave can be built in parallel; a wave cannot start until the one above it is done. '
      + 'Cycles the engine could not order are listed at the bottom rather than hidden.',
      'Waves visible, computed from the dependency graph');
  }
  if (d.tests.length) {
    add(SHEETS.tests,
      'What has actually been measured. Expand a test for the snapshot fields, the app checks (the business success '
      + 'bar), the findings and the written record. Copy the newest block as the form for your next test.',
      'Tests visible, newest finished first');
  }
  if (d.runbooks.length) {
    add(SHEETS.runbooks,
      'The procedures. Work one top to bottom during an exercise — a GATE step must pass before you continue. '
      + 'Commands, checks and pass criteria have their own columns because you work this one with a terminal open.',
      'Runbooks visible; steps behind +');
  }
  add(SHEETS.workbench,
    'Every working list in one place: the Phase 0 gate, the gap list, the secrets reconciliation, the verification '
    + 'catalogue, people, decisions, accounts and numbers, the hard rules and the strategy reference. Filter the '
    + 'Category column to pull one section out on its own.',
    'Sections visible; Phase 0 first');
  add('Excel: + / − in the margin',
    'Use the + / − handles in the LEFT MARGIN to expand and collapse. The numbered buttons above them (1 2 3 4 5 6 7) '
    + 'jump the whole sheet to one depth. Do not expand everything at once on the Resource Graph — go one branch at a time.',
    '—');
  add('Google Sheets',
    'File → Import → upload this .xlsx → Replace spreadsheet. Filters, dropdowns and the tints import. Row groups '
    + 'usually survive; if they do not, filter the Category and Group columns instead — they carry the same structure.',
    '—');
  add('The Status column',
    'A dropdown on every data row, and only that cell tints: Pass green, Fail and Blocked red, Partial / Not reached / '
    + 'Stale amber. It ARRIVES DERIVED from this workspace — a failed app check reads Fail, an open blocker gap reads '
    + 'Blocked, out-of-scope reads N/A or Accepted, and anything in scope that nobody has measured reads "Not started". '
    + 'Change it as you verify; the Status notes column says what the derivation was based on.',
    'Derived, not blank');
  add('Day-0? and In DR scope?',
    'Day-0? is derived from Tier (0 and 1 = Yes) — edit it if your first-hour list differs. In DR scope? is the '
    + 'recovery-tool scope from the inventory: Yes / Partial / No / Unknown, or Stale when a gap says the listing no '
    + 'longer matches reality.',
    'Derived from the inventory');
  add('The honest-numbers rule',
    'RTO/RPO are TARGETS the business signs off on. RTA/RPA are what your last test MEASURED. Until a target is '
    + 'approved and a test has hit it, quote only the measured number and name the test that produced it. A target '
    + 'nobody has tested is a hope, not a capability.',
    'It governs every sheet here');
  return rows;
}

function addHowToUse(wb, d, opts = {}) {
  const columns = [
    { header: 'Id', width: 6, align: 'right', numFmt: '0' },
    { header: 'Sheet', width: 18 },
    { header: 'What you do', width: 110, wrap: true },
    { header: 'Starts as', width: 36, wrap: true },
  ];
  const ws = addSheet(wb, SHEETS.guide,
    `${d.meta.name || d.meta.slug} — DR workbook · generated by DR Compass · read this page first`, columns, {
      note: 'Generated by DR Compass. Works in Excel, Numbers and Google Sheets — dropdowns, tints and row groups survive all three.',
      gridLines: false,
      print: { orientation: 'landscape' },
    });
  const rows = sheetGuide(d, opts);
  rows.forEach((g, i) => {
    const row = dataRow(ws, columns, [i + 1, ...g], { stripe: i % 2 === 1 });
    row.height = 32;
    row.getCell(2).font = ARIAL({ bold: true });
    row.getCell(2).alignment = { vertical: 'top', wrapText: true };
  });
  const last = 2 + rows.length;
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: last, column: columns.length } };
  return ws;
}

// --------------------------------------------------------- shared reference

// The four strategies, one source of truth: the DR Options Matrix sheet renders
// this table, and the Executive Summary quotes the row matching meta.strategy.
const DR_OPTIONS = [
  {
    key: 'backup-restore',
    name: 'Backup & restore',
    rto: '4–24+ hours',
    rpo: '1–24 hours (age of last good backup)',
    cost: '$ — backup storage only',
    complexity: 'Low',
    when: 'Tier 2/3 workloads; tight budgets; the business can genuinely tolerate being down most of a day and losing hours of data. Restores MUST be rehearsed — an unrestored backup is a rumor.',
  },
  {
    key: 'pilot-light',
    name: 'Pilot light',
    rto: '30 min – a few hours',
    rpo: 'Minutes (continuous data replication)',
    cost: '$$ — data stores replicated, compute off until needed',
    complexity: 'Medium',
    when: 'Data must be near-current but you can wait for compute to launch. A good fit for most Tier-0/1 apps that can tolerate ~1 hour of downtime. Snapshot-based tools (e.g. Arpio) live here.',
  },
  {
    key: 'warm-standby',
    name: 'Warm standby',
    rto: '5–30 minutes',
    rpo: 'Seconds – minutes',
    cost: '$$$ — scaled-down but fully functional copy always running',
    complexity: 'Medium-High',
    when: 'RTO under ~30 minutes; you want continuous proof the recovery stack actually runs (it serves synthetic or small live traffic). Scaling up is far less risky than cold-starting.',
  },
  {
    key: 'active-active',
    name: 'Active-active',
    rto: '~0 (seconds – minutes)',
    rpo: '~0 (synchronous / near-synchronous)',
    cost: '$$$$ — 2× infrastructure plus data-layer engineering',
    complexity: 'High',
    when: 'The business cannot tolerate meaningful downtime and will fund it. You accept hard problems: write conflicts, data consistency, routing, and testing failure modes across two live regions.',
  },
];
const strategyOption = (s) => DR_OPTIONS.find((o) => o.key === String(s || '').toLowerCase()) || null;
const strategyName = (s) => strategyOption(s)?.name
  || (s ? cap(String(s).replace(/-/g, ' ')) : '');

const TOOLING_LABELS = {
  arpio: 'Arpio — snapshot-based cross-region recovery',
  'region-switch': 'AWS Region Switch — failover orchestration',
  'arc-routing-controls': 'ARC routing controls — traffic cutover',
  'elastic-dr': 'AWS Elastic Disaster Recovery',
  'gitops-iac': 'GitOps / IaC redeploy',
  'resilience-hub': 'AWS Resilience Hub',
  backup: 'AWS Backup',
};
const toolingLabel = (t) => TOOLING_LABELS[String(t || '').toLowerCase()]
  || cap(String(t || '').replace(/-/g, ' '));

function countBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) || 'unknown';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

// ------------------------------------------------------- executive one-pager
//
// Pure derivation from the workspace — no estimates, no invented numbers. A
// missing measurement reads "unmeasured"; a missing target reads "not set".
// Both the Executive Summary sheet and the DR Package's EXECUTIVE-SUMMARY.md
// render this one model, so the two can never drift.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SEV_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };
const sevRank = (s) => (SEV_RANK[String(s || '').toLowerCase()] ?? 8);

// Transitive dependsOn closure of one component, cycle-safe, in restore order.
function needsOf(d, rootId) {
  const seen = new Set([rootId]);
  const queue = [rootId];
  const out = [];
  while (queue.length) {
    const cur = d.byId.get(queue.shift());
    for (const id of cur?.dependsOn || []) {
      if (seen.has(id) || !d.byId.has(id)) continue;
      seen.add(id);
      out.push(d.byId.get(id));
      queue.push(id);
    }
  }
  return out.sort((a, b) => layerOrder(a.restoreLayer) - layerOrder(b.restoreLayer)
    || (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name));
}

const postureText = (c) => join([
  `scope: ${c.inRecoveryScope || 'unknown'}`,
  c.drStrategy ? strategyName(c.drStrategy) : '',
  isNum(c.replication?.rpoMinutes) ? `RPO ${c.replication.rpoMinutes} min` : '',
  ownerTeam(c),
], ' · ');

/**
 * WHOSE objective is this package judged against?
 *
 * v0.7 gave a service its own `objectives` block — the one that carries
 * `approved: true` and `source: "BIA 2026-03"` — and nothing in the export path
 * ever read it. Every scoped package printed the WORKSPACE numbers instead, so
 * an adjudication package told an auditor the tolerated data loss was 30
 * minutes when the signed BIA says 15 (wrong in the permissive direction) and
 * called it unapproved when it is approved; and a dev/lab package was judged
 * against production's approved business commitment, which the lab has never
 * been given.
 *
 * Order: the scoped SERVICE, then the scoped ENVIRONMENT, then the workspace.
 * Two rules the resolution will not bend:
 *   - a scope whose own objective is empty does NOT inherit one. It says it has
 *     none, and no verdict is reached against a number that was never its
 *     commitment. The workspace figure is still shown, named as the workspace's.
 *   - where the service objective and the workspace objective DISAGREE, both are
 *     printed and the disagreement is stated. The seed's own note records that
 *     nobody has reconciled them; hiding that is how the wrong number reaches a
 *     board.
 */
function resolveObjectives(d) {
  const meta = d.meta || {};
  const ws = meta.objectives || {};
  const has = (o) => isNum(o?.rtoMinutes) || isNum(o?.rpoMinutes);
  const scope = d.scope || null;
  const env = scope?.envId
    ? arr(meta.environments).find((e) => e.id === scope.envId) || null : null;
  const svc = scope?.serviceId
    ? arr(d.services).find((s) => s.id === scope.serviceId) || null : null;
  const envLabel = env ? `${env.name || env.slug || env.id} environment`
    : scope?.envName ? `${scope.envName} environment` : 'this environment';
  const svcLabel = svc ? `${svc.name || svc.id} service`
    : scope?.serviceName ? `${scope.serviceName} service` : 'this service';

  const base = {
    rtoMinutes: isNum(ws.rtoMinutes) ? ws.rtoMinutes : null,
    rpoMinutes: isNum(ws.rpoMinutes) ? ws.rpoMinutes : null,
    approved: !!ws.approved,
    source: '',
    level: 'workspace',
    owner: 'the workspace',
    // The one thing every renderer prints beside the target.
    why: ws.approved ? 'Business target, approved' : 'Business target — NOT approved',
    conflict: null,
    // Only a WORKSPACE-level target may be replaced by measured.js's own copy
    // of the workspace objective (see execModel) — otherwise the module would
    // quietly put the workspace number back on a service's row.
    fromWorkspace: true,
    workspace: {
      rtoMinutes: isNum(ws.rtoMinutes) ? ws.rtoMinutes : null,
      rpoMinutes: isNum(ws.rpoMinutes) ? ws.rpoMinutes : null,
      approved: !!ws.approved,
    },
  };
  if (!scope || (!svc && !env)) return base;

  // The scope names a service: its objective is the answer, or its ABSENCE is.
  const subject = svc ? { o: svc.objectives, label: svcLabel, level: 'service' }
    : { o: env?.objectives, label: envLabel, level: 'environment' };

  if (!has(subject.o)) {
    const wsText = base.rtoMinutes != null || base.rpoMinutes != null
      ? ` The workspace proposes ${[base.rtoMinutes != null ? `RTO ${base.rtoMinutes} min` : '',
        base.rpoMinutes != null ? `RPO ${base.rpoMinutes} min` : ''].filter(Boolean).join(' / ')}`
        + `${base.approved ? ', approved' : ', not approved'} — that is the WORKSPACE's number, not this scope's.`
      : '';
    return {
      ...base,
      rtoMinutes: null,
      rpoMinutes: null,
      approved: false,
      level: 'none',
      owner: subject.label,
      why: `${cap(subject.label)} has no objective of its own.${wsText}`,
      fromWorkspace: false,
      none: true,
    };
  }

  const o = subject.o;
  const rto = isNum(o.rtoMinutes) ? o.rtoMinutes : null;
  const rpo = isNum(o.rpoMinutes) ? o.rpoMinutes : null;
  const differs = (base.rtoMinutes != null && rto != null && base.rtoMinutes !== rto)
    || (base.rpoMinutes != null && rpo != null && base.rpoMinutes !== rpo);
  const disagreement = differs ? join([
    base.rtoMinutes !== rto && base.rtoMinutes != null ? `RTO ${base.rtoMinutes} vs ${rto} min` : '',
    base.rpoMinutes !== rpo && base.rpoMinutes != null ? `RPO ${base.rpoMinutes} vs ${rpo} min` : '',
  ], ' · ') : '';
  return {
    ...base,
    rtoMinutes: rto,
    rpoMinutes: rpo,
    approved: !!o.approved,
    source: String(o.source || ''),
    level: subject.level,
    owner: subject.label,
    why: join([
      `${cap(subject.label)} objective`,
      o.source ? String(o.source) : '',
      o.approved ? 'approved' : 'NOT approved',
    ], ' · '),
    conflict: differs ? {
      text: `The workspace objective disagrees with this one (${disagreement}) and nobody has reconciled the two. `
        + `The number above is ${subject.label}'s${o.approved ? ', and it is the approved one' : ''}.`,
      summary: disagreement,
      workspaceValue: join([
        base.rtoMinutes != null ? `RTO ${base.rtoMinutes} min` : '',
        base.rpoMinutes != null ? `RPO ${base.rpoMinutes} min` : '',
      ], ' / ') + (base.approved ? ', approved' : ', not approved'),
    } : null,
    fromWorkspace: false,
  };
}

function execModel(d) {
  const meta = d.meta || {};
  const o = meta.objectives || {};
  // WHOSE targets apply to this package — service, environment or workspace.
  // `o` above stays the workspace block: rtaMinutes/rpaMinutes are hand-typed
  // MEASUREMENTS and have no per-service equivalent.
  const objective = resolveObjectives(d);
  const root = d.scope?.rootId ? d.byId.get(d.scope.rootId) : null;

  // ---- test history: what has actually been PROVEN first (a finished test
  // outranks a scheduled one however recent), newest first inside each group ----
  const testRank = (t) => (t.status === 'passed' || t.status === 'failed' ? 0
    : t.status === 'in-progress' ? 1 : t.status === 'planned' ? 2 : 3);
  const history = [...d.tests]
    .sort((a, b) => testRank(a) - testRank(b)
      || String(b.date || '').localeCompare(String(a.date || '')))
    .map((t) => ({
      name: t.name || '(unnamed test)',
      date: t.date || '',
      status: t.status || '',
      statusLabel: TEST_STATUS_DISPLAY[t.status] || cap(t.status) || 'Unknown',
      rtaMinutes: isNum(t.results?.rtaMinutes) ? t.results.rtaMinutes : null,
      rpaMinutes: isNum(t.results?.rpaMinutes) ? t.results.rpaMinutes : null,
      cleanRun: t.results?.cleanRun ?? null,
      findings: (t.findings || []).length,
      blockers: (t.findings || []).filter((f) => String(f.severity) === 'blocker').length,
    }));
  const withMeasure = history.find((t) => t.rtaMinutes != null || t.rpaMinutes != null) || null;

  // ---- the honest numbers ----
  //
  // pick() used to PREFER the hand-typed workspace objective over a real test
  // result and label its provenance "workspace objectives", which is how a
  // number nobody measured reached a board-ready export reading "Achieved".
  // Now: a PASSED test outranks everything; the typed field is only ever a
  // fallback, and when it is used the cell says so in its own words.
  // A passed test is evidence for the WORKSPACE number only when it COVERED the
  // workspace. Without that filter this fallback answered "12 min, measured,
  // inside the 60 min target" for a drill that recovered one service — the
  // measured.js path has always refused that, and the comment above claims this
  // path holds the same line, so now it does.
  const passedWith = (key) => {
    const linkedId = key === 'rtaMinutes' ? o.rtaTestId : o.rpaTestId;
    const passed = d.tests
      .filter((t) => t.status === 'passed' && isNum(t.results?.[key]) && coversWholeWorkspace(t))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return (linkedId && passed.find((t) => t.id === linkedId)) || passed[0] || null;
  };

  const pick = (own, key) => {
    const evidence = passedWith(key);
    if (evidence) {
      const stamp = `${evidence.name || '(unnamed test)'}${evidence.date ? ` — ${evidence.date}` : ''} — passed`;
      return {
        value: Number(evidence.results[key]),
        state: 'measured',
        source: `test "${evidence.name || '(unnamed test)'}"${evidence.date ? ` (${evidence.date})` : ''}, recorded as passed`,
        stamp,
        test: { id: evidence.id || '', name: evidence.name || '(unnamed test)', date: evidence.date || '', status: 'passed' },
        cleanRun: evidence.results?.cleanRun ?? null,
        typed: isNum(own) ? own : null,
      };
    }
    if (isNum(own)) {
      // A number somebody typed into Settings. It may be perfectly true — but
      // nothing in this workspace tests it, so it is not evidence.
      const echo = history.find((t) => t.status !== 'passed' && t[key] === own) || null;
      return {
        value: own,
        state: 'declared',
        source: 'recorded by hand in workspace settings — NOT from a test',
        stamp: 'recorded by hand, not from a test',
        test: null,
        echo: echo ? { name: echo.name, date: echo.date, status: echo.statusLabel } : null,
        cleanRun: null,
        typed: own,
      };
    }
    return {
      value: null, state: 'unmeasured', source: null, stamp: null, test: null,
      cleanRun: null, typed: null,
    };
  };

  const rta = pick(o.rtaMinutes, 'rtaMinutes');
  const rpa = pick(o.rpaMinutes, 'rpaMinutes');
  // The TARGETS come from whoever owns them for this scope (resolveObjectives),
  // not from the workspace block, and a scope with no objective of its own has
  // no target to be judged against — both stay null and every verdict below
  // reads that as "no verdict" rather than inventing one.
  const rto = objective.rtoMinutes;
  const rpo = objective.rpoMinutes;

  // Only a MEASURED number can meet or miss an objective. A declared number has
  // nothing behind it, so both verdicts stay null and every renderer reads that
  // as "no verdict" rather than "met".
  const meets = (slot, target) =>
    (slot.state === 'measured' && slot.value != null && target != null ? slot.value <= target : null);

  // The sentence each renderer prints beside the number, so the workbook, the
  // markdown one-pager and the DR-package cover can never word it differently.
  const whatFor = (slot, kind, target, met) => {
    if (slot.state === 'measured') {
      return `Measured by ${slot.source}`
        + (met === true ? ` — inside the ${target} min target` : '')
        + (met === false ? ` — OVER the ${target} min target` : '')
        + (slot.cleanRun === false ? '. Not a clean run: it needed hands-on help, so it is not yet repeatable' : '');
    }
    if (slot.state === 'declared') {
      return `RECORDED BY HAND in workspace settings — no test in this workspace produced it, so it is not evidence`
        + (slot.echo ? `. It matches "${slot.echo.name}"${slot.echo.date ? ` (${slot.echo.date})` : ''}, result: ${slot.echo.status}` : '')
        + '. Do not quote it as achieved';
    }
    return kind === 'rta'
      ? 'No passed test has produced a time to restore — this is the number you cannot yet defend'
      : 'No passed test has produced a data-loss measurement';
  };

  const meetsRto = meets(rta, rto);
  const meetsRpo = meets(rpa, rpo);
  const numbers = {
    rtoMinutes: rto,
    rpoMinutes: rpo,
    rtaMinutes: rta.value,
    rpaMinutes: rpa.value,
    // Kept for every existing consumer; now it names a PASSED test or says
    // plainly that the number was recorded by hand.
    rtaSource: rta.source,
    rpaSource: rpa.source,
    rtaState: rta.state,
    rpaState: rpa.state,
    rtaTest: rta.test,
    rpaTest: rpa.test,
    // "47 min (Aug 12 recovery test — passed)" / "47 min (recorded by hand)".
    rtaStamp: rta.stamp,
    rpaStamp: rpa.stamp,
    rtaWhat: whatFor(rta, 'rta', rto, meetsRto),
    rpaWhat: whatFor(rpa, 'rpa', rpo, meetsRpo),
    rtaCleanRun: rta.cleanRun,
    rpaCleanRun: rpa.cleanRun,
    approved: objective.approved,
    // Which objective this package is judged against, and where it came from.
    // Every renderer prints `objective.why` beside the target rather than
    // wording the provenance itself.
    objective,
    notes: o.notes || '',
    meetsRto,
    meetsRpo,
    // The test the numbers are actually attributed to, or null. Only a passed
    // test can appear here now.
    measuredIn: rta.test || rpa.test
      ? { name: (rta.test || rpa.test).name, date: (rta.test || rpa.test).date, status: 'Pass' }
      : null,
    // Where a run exists but did not pass, say so rather than going quiet.
    unprovenRun: !rta.test && !rpa.test && withMeasure
      ? { name: withMeasure.name, date: withMeasure.date, status: withMeasure.statusLabel }
      : null,
  };

  // `server/lib/measured.js` is the single source of truth (see
  // docs/measured-numbers.md). When it is present it has the last word on
  // state, provenance and verdict; the block above is the fallback that holds
  // the same line without it. Its shape is validated before it is adopted, so
  // an unexpected return can only cost us the fallback, never the rule.
  if (sharedMeasured) {
    try {
      // The objective resolved above travels WITH the question: `measured.js`
      // accepts `options.target` and judges against it
      // (docs/measured-numbers.md), so the verdict arrives already reached
      // against the number that actually applies to this scope — including the
      // "no objective of its own" case, where both numbers are null and no
      // verdict is reached at all. This block used to re-derive the per-metric
      // verdict here, from the module's slots, whenever the objective was not
      // the workspace's: a second copy of the comparison, and one that left
      // `overall` and `why` describing the workspace's target beside an
      // `rto`/`rpo` describing the service's.
      //
      // Only passed when the objective is NOT the workspace's. Unscoped, the
      // module reads the same workspace.objectives itself, and handing it the
      // same numbers as an override would change only the words it uses about a
      // number nobody disagrees on.
      const shared = sharedMeasured(meta, d.tests, d.scope?.rootId || null, {
        components: d.components,
        ...(objective.fromWorkspace ? {} : { target: objective }),
      });
      const okSlot = (s) => s && ['measured', 'declared', 'unmeasured'].includes(s.state);
      if (shared && okSlot(shared.rta) && okSlot(shared.rpa)) {
        // The module echoes back the target it used, so these numbers and the
        // verdict below can never describe two different targets.
        const t2 = shared.target || {};
        if (isNum(t2.rtoMinutes)) numbers.rtoMinutes = t2.rtoMinutes;
        if (isNum(t2.rpoMinutes)) numbers.rpoMinutes = t2.rpoMinutes;
        const v = shared.verdict || {};
        const adopt = (k, s, verdict, kind) => {
          const t = s.state === 'measured' ? (s.test || null) : null;
          numbers[`${k}State`] = s.state;
          numbers[`${k}Minutes`] = s.minutes ?? null;
          numbers[`${k}Test`] = t;
          numbers[`${k}CleanRun`] = s.test?.cleanRun ?? null;
          numbers[`${k}Source`] = s.state === 'measured'
            ? `test "${t?.name || '(unnamed test)'}"${t?.date ? ` (${t.date})` : ''}, recorded as passed`
            : s.state === 'declared' ? 'recorded by hand in workspace settings — NOT from a test' : null;
          numbers[`${k}Stamp`] = s.state === 'measured'
            ? `${t?.name || 'recovery test'}${t?.date ? ` — ${t.date}` : ''} — passed${s.stale ? `, ${s.staleDays} days ago` : ''}`
            : s.state === 'declared' ? 'recorded by hand, not from a test' : null;
          // The module's own sentence, which is documented as safe to print
          // verbatim, plus the verdict it reached against the business target.
          const verdictTail = verdict === 'met' ? ` Inside the ${kind === 'rta' ? 'RTO' : 'RPO'} target.`
            : verdict === 'missed' ? ` OVER the ${kind === 'rta' ? numbers.rtoMinutes : numbers.rpoMinutes} min target.`
              : '';
          numbers[`${k}What`] = `${s.note || s.label || ''}${verdictTail}`.trim();
          numbers[`${k}Format`] = sharedFormatNumber ? sharedFormatNumber(s, { unit: 'min' }) : null;
          // Only the module may declare an achievement.
          numbers[`${k}IsAchievement`] = !!s.isAchievement;
          // The two facts that disqualify a measured number from the present
          // tense (docs/measured-numbers.md): evidence past the freshness
          // threshold, and a run that only reached the bar by hand. Carried so
          // the verdict ladder below can read them instead of recomputing
          // readiness from the numeric comparison alone.
          numbers[`${k}Stale`] = !!s.stale;
          numbers[`${k}StaleDays`] = Number.isFinite(s.staleDays) ? s.staleDays : null;
        };
        // meets* stays the workbook's tint/status signal; it now tracks the
        // module's verdict, which is 'unknown' for anything not measured.
        numbers.meetsRto = v.rto === 'met' ? true : v.rto === 'missed' ? false : null;
        numbers.meetsRpo = v.rpo === 'met' ? true : v.rpo === 'missed' ? false : null;
        adopt('rta', shared.rta, v.rto, 'rta');
        adopt('rpa', shared.rpa, v.rpo, 'rpa');
        numbers.verdict = v;
        // What the number is evidence FOR, and what has never been tested at
        // all. A workspace number measured on one peripheral component is not
        // the workspace's recovery evidence (validation-2 NEW-2), and the
        // next-actions block below refuses to go quiet while this is non-empty.
        numbers.scope = shared.scope || null;
        numbers.measuredIn = numbers.rtaTest || numbers.rpaTest
          ? { name: (numbers.rtaTest || numbers.rpaTest).name, date: (numbers.rtaTest || numbers.rpaTest).date, status: 'Pass' }
          : null;
        const la = shared.evidence?.lastAttempt;
        numbers.unprovenRun = !numbers.measuredIn && la
          ? { name: la.name, date: la.date, status: TEST_STATUS_DISPLAY[la.status] || cap(la.status) || 'Unknown' }
          : null;
        if (Array.isArray(shared.warnings)) numbers.warnings = shared.warnings;
      }
    } catch { /* the local implementation above already holds the line */ }
  }

  // ---- risks: open gaps, worst first ----
  const openGaps = d.gaps.filter((g) => g.status !== 'resolved');
  const risks = [...openGaps]
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
      || String(a.title || '').localeCompare(String(b.title || '')))
    .slice(0, 5)
    .map((g) => {
      const c = g.componentId ? d.byId.get(g.componentId) : null;
      return {
        title: g.title || '(untitled gap)',
        severity: g.severity || 'unknown',
        component: c ? c.name : (g.componentId || 'workspace-wide'),
        owner: (c && ownerTeam(c)) || 'unassigned',
        ticket: g.ticket || '',
        status: g.status || 'open',
        klass: g.class || '',
        notes: g.notes || '',
      };
    });

  // ---- next actions: derived, worst risk first, never invented ----
  const unknownSecrets = d.components
    .flatMap((c) => (c.secrets || []).filter((s) => (s.replicated || 'unknown') === 'unknown').map((s) => ({ c, s })));
  const undecidedScope = d.components
    .filter((c) => !c.inRecoveryScope || c.inRecoveryScope === 'unknown' || c.inRecoveryScope === 'partial');
  const noVerification = d.components.filter((c) => !(c.verification?.command || c.verification?.pass));
  const lastTest = history[0] || null;
  const cand = [];
  if (!history.length) {
    cand.push({
      action: 'Run the first recovery test',
      owner: 'unassigned',
      why: 'Nothing has been measured yet, so every number in this plan is a target rather than a capability.',
    });
  }
  // Computed blockers go in ABOVE the hand-written ones. A finding nobody has
  // triaged into the gap list is not a smaller problem than one that has been
  // written down — it is the same problem, one step earlier. This is also the
  // half of NEW-8 that makes "No actions fall out of the current data" and
  // "the plan is genuinely clean" impossible while a blocker is firing.
  // ONE consolidated row, not one per finding: the action is to triage them, and
  // spending three of five exec rows on a list that is printed in full two
  // sections above is how a one-pager stops being read.
  const computed = d.computedRisks || null;
  if (computed && computed.blockerCount) {
    const first = computed.blockers[0];
    cand.push({
      action: `Triage ${plural(computed.blockerCount, 'computed finding')} into the gap list — starting with "${first.title}"`,
      owner: (d.byId.get(first.componentId) && ownerTeam(d.byId.get(first.componentId))) || 'unassigned',
      why: `The risk engine grades ${computed.blockerCount === 1 ? 'it a blocker or a hole' : 'them blockers or holes'} in the restore order `
        + `(${computed.blockerRules.join(', ')}${computed.blockerRulesMore ? `, +${computed.blockerRulesMore} more` : ''}), `
        + `and ${computed.blockerCount === 1 ? 'it is not in the gap list — so it has' : 'none is in the gap list — so none has'} an owner or a date. The worst is on ${first.component}`
        + `${first.component === first.via ? '' : `, found via ${first.via}`}. `
        + 'A finding nobody has triaged is not a smaller problem than one that was written down.',
    });
  }
  for (const r of risks.filter((r) => r.severity === 'blocker').slice(0, 2)) {
    cand.push({
      action: `Close blocker — ${r.title}`,
      owner: r.owner,
      why: `Blocker on ${r.component}${r.ticket ? ` · ${r.ticket}` : ''}. The next test cannot pass around it.`,
    });
  }
  // The most critical components in the workspace that NO passed test has ever
  // covered. This sits directly under the blockers because it is the reason a
  // workspace-level number cannot be quoted, and because "no actions fall out
  // of the current data" must never print while it is non-empty (NEW-2).
  const untested = (numbers.scope && Array.isArray(numbers.scope.untestedCritical))
    ? numbers.scope.untestedCritical : [];
  // The `history.length` guard: with no test at all, "Run the first recovery
  // test" above already says this, and saying it twice is how a list of actions
  // stops being read.
  if (untested.length && history.length && !d.scope?.rootId) {
    const named = untested.slice(0, 3).map((c) => c.name).join(', ');
    const firstComp = untested[0] ? d.byId.get(untested[0].id) : null;
    cand.push({
      action: `Run a recovery test that covers ${named}${untested.length > 3 ? ` and ${untested.length - 3} more` : ''}`,
      owner: (firstComp && ownerTeam(firstComp)) || 'unassigned',
      why: `${plural(untested.length, `Tier ${numbers.scope.criticalTier} component`)} in recovery scope `
        + `(${named}) ${untested.length > 1 ? 'have' : 'has'} never been covered by a passed test. `
        + 'A passed test on something peripheral is evidence about that thing only, so until this is tested '
        + 'the workspace has no recovery evidence for the part of it that matters most.',
    });
  }
  if (lastTest && lastTest.status === 'failed') {
    cand.push({
      action: `Re-run "${lastTest.name}" — the last recovery test failed`,
      owner: 'unassigned',
      why: `${plural(lastTest.findings, 'finding')}${lastTest.blockers ? `, ${lastTest.blockers} of them blockers` : ''}`
        + `${lastTest.date ? ` on ${lastTest.date}` : ''}. Until it passes, the measured numbers above describe a failed run.`,
    });
  }
  if (unknownSecrets.length) {
    cand.push({
      action: `Reconcile ${plural(unknownSecrets.length, 'secret')} whose replication status is unknown`,
      owner: ownerTeam(unknownSecrets[0].c) || 'unassigned',
      why: 'Unresolved secrets are the most common cause of a failed recovery test — the app comes up and cannot read its credentials.',
    });
  }
  // The typed RTA/RPA are on screen and in every export; name them for what
  // they are, above the softer data-quality actions.
  if (numbers.rtaState === 'declared' || numbers.rpaState === 'declared') {
    cand.push({
      action: 'Replace the hand-recorded RTA/RPA with a number from a test that passed',
      owner: 'unassigned',
      why: `${[numbers.rtaState === 'declared' ? 'the recovery time' : null,
        numbers.rpaState === 'declared' ? 'the data loss figure' : null].filter(Boolean).join(' and ')} `
        + 'in this plan was typed into Settings, not produced by a test. Until a passed test records it, '
        + 'it is a note to self and cannot be quoted to an auditor, an exec or a regulator.',
    });
  }
  if (!numbers.approved && (rto != null || rpo != null)) {
    cand.push({
      action: 'Get the RTO / RPO targets signed off by the business',
      owner: 'unassigned',
      why: numbers.rtaState === 'measured' || numbers.rpaState === 'measured'
        ? 'The targets are proposed only, so the measured RTA/RPA are currently the only defensible numbers.'
        : 'The targets are proposed only — and nothing has been measured, so this plan currently has no defensible number at all.',
    });
  }
  for (const r of risks.filter((r) => r.severity === 'high').slice(0, 2)) {
    cand.push({
      action: `Close high-severity gap — ${r.title}`,
      owner: r.owner,
      why: `High severity on ${r.component}${r.ticket ? ` · ${r.ticket}` : ''}.`,
    });
  }
  if (undecidedScope.length) {
    cand.push({
      action: `Decide recovery scope for ${plural(undecidedScope.length, 'component')} still marked partial or unknown`,
      owner: ownerTeam(undecidedScope[0]) || 'unassigned',
      why: `Anything undecided now gets decided during the incident: ${join(undecidedScope.slice(0, 3).map((c) => c.name))}`
        + `${undecidedScope.length > 3 ? ` and ${undecidedScope.length - 3} more` : ''}.`,
    });
  }
  if (noVerification.length) {
    cand.push({
      action: `Write a verification command for ${plural(noVerification.length, 'component')}`,
      owner: 'unassigned',
      why: 'Without one, "it came back" is an opinion rather than a check someone can run.',
    });
  }
  // Six, not five: two derived actions were added to the front of this list
  // (the computed-risk triage row and the untested-critical row) and at five the
  // flagship "replace the hand-recorded RTA/RPA with a number from a test that
  // passed" fell off the seed's one-pager. It is one line; it stays.
  const actions = cand.slice(0, 6);

  // ---- the service story, when this is a scoped package ----
  let service = null;
  if (root) {
    const needs = needsOf(d, root.id);
    const neededBy = (d.usedByIds.get(root.id) || [])
      .map((id) => d.byId.get(id)).filter(Boolean)
      .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name));
    service = {
      id: root.id,
      name: root.name,
      kind: root.kind || '',
      category: root.category || '',
      tier: isNum(root.tier) ? root.tier : null,
      owner: ownerTeam(root) || 'unassigned',
      layer: root.restoreLayer || '',
      layerLabel: LAYER_LABELS[root.restoreLayer] || root.restoreLayer || 'not set',
      inRecoveryScope: root.inRecoveryScope || 'unknown',
      drStrategy: root.drStrategy || '',
      replication: root.replication?.mechanism || '',
      rpoMinutes: isNum(root.replication?.rpoMinutes) ? root.replication.rpoMinutes : null,
      description: root.description || '',
      verification: root.verification?.command || '',
      definedIn: root.definedIn || '',
      needs: needs.map((c) => ({
        name: c.name, layer: c.restoreLayer || '', posture: postureText(c),
        inRecoveryScope: c.inRecoveryScope || 'unknown',
      })),
      neededBy: neededBy.map((c) => ({
        name: c.name, tier: isNum(c.tier) ? c.tier : null, layer: c.restoreLayer || '',
        owner: ownerTeam(c) || 'unassigned',
      })),
    };
  }

  const m = maturity(d.assessment);
  const scopeCounts = {};
  for (const s of ['yes', 'partial', 'no', 'unknown']) {
    const n = d.components.filter((c) => (c.inRecoveryScope || 'unknown') === s).length;
    if (n) scopeCounts[s] = n;
  }

  // -------------------------------------------------- the four exec questions
  //
  // Everything below exists so the sheet and the .md can render the SAME four
  // answers — what this is, can we recover it, what would stop us, what happens
  // next — without either of them composing prose of its own. A renderer that
  // writes its own sentences is how the two drifted, and how the "what it means"
  // column grew into a page of explanation nobody read.

  const subject = service ? service.name : (meta.name || meta.slug || 'this workspace');
  const blockerGapCount = openGaps.filter((g) => g.severity === 'blocker').length;
  const blockerTotal = (computed?.blockerCount || 0) + blockerGapCount;

  // ---- 1. what this is ----
  //
  // env/service scoping per docs/ENV-SERVICE-MODEL.md §3. Read defensively: the
  // scope helper lands separately, so every field is optional and the labels
  // degrade to today's single-environment truth rather than inventing an
  // environment that does not exist (§2: "Never fabricate one").
  const envs = arr(meta.environments);
  const scopedEnv = d.scope?.envId ? envs.find((e) => e.id === d.scope.envId) || null : null;
  const envLabel = scopedEnv ? (scopedEnv.name || scopedEnv.slug || scopedEnv.id)
    : d.scope?.envName || (envs.length
      ? `not scoped — ${plural(envs.length, 'environment')} in this workspace`
      : 'single environment');
  // An environment is its own account and its own REGION PAIR (contract §2).
  // Staging runs us-east-2 → us-east-1: the reverse of the workspace default,
  // which this row printed on a sheet titled "Staging environment" until the
  // scoped environment was resolvable here. The failover brief has always read
  // the environment's own pair (briefSubject); this is the same rule.
  const envPair = scopedEnv?.regions?.primary || scopedEnv?.regions?.recovery
    ? scopedEnv.regions
    : (d.scope?.envRegions?.primary || d.scope?.envRegions?.recovery ? d.scope.envRegions : null);
  const regionNote = `${(envPair || meta.regions)?.primary || '?'} → ${(envPair || meta.regions)?.recovery || '?'}`;
  // The workspace-wide component total survives scoping: d.byId is built before
  // the scope filter, so "12 of 51" can be told the truth.
  const workspaceComponents = d.byId?.size ?? d.components.length;
  const scopedServiceName = d.scope?.serviceName || d.scope?.serviceId || '';
  const serviceLabel = service ? service.name
    : scopedServiceName
    // "every service — 12 components" on a 12-of-51 slice reads as the whole
    // estate. Scoped, it names the slice; the note cell carries the counts.
    || (d.scope
      ? `every service in this ${d.scope.envName ? 'environment' : 'scope'}`
      : `every service — ${plural(d.components.length, 'component')}`);

  // The rows of "what this is", composed once. Both renderers print these
  // verbatim in three columns, so the sheet and the .md say the same words.
  const identityRows = [
    {
      name: 'System', value: meta.name || meta.slug || '',
      note: meta.org || 'No organisation recorded',
      bold: true, full: meta.description || '',
    },
    {
      name: 'Environment', value: envLabel,
      note: envPair
        ? `${regionNote} — this environment's own region pair, not the workspace default`
        : regionNote,
    },
    service ? {
      name: 'Service', value: service.name, bold: true,
      tint: service.tier === 0 ? 'err' : null,
      note: join([service.tier != null ? `Tier ${service.tier}` : 'Tier not set', service.owner], ' · '),
    } : {
      name: 'Service', value: serviceLabel,
      note: d.scope
        ? `${d.components.length} of ${workspaceComponents} components in the workspace · `
          + `${scopeCounts.yes || 0} fully in recovery scope`
        : `${scopeCounts.yes || 0} fully in recovery scope`,
    },
    service ? {
      name: 'Must come back first / breaks if down',
      value: `${service.needs.length} / ${service.neededBy.length}`,
      tint: service.needs.length ? null : 'warn',
      note: service.needs.length ? 'Both lists are under Detail' : 'No dependency recorded — check the inventory',
    } : null,
    {
      name: 'Strategy', value: strategyName(meta.strategy) || 'not set',
      tint: meta.strategy ? null : 'warn',
      // The tool NAME, not its one-line description: three tools fit, and what
      // each one does is not what an exec reads this row for.
      note: clipWords((meta.tooling || []).map((t) => String(toolingLabel(t)).split(' — ')[0]).join('; ')
        || 'No tooling recorded', 58),
    },
    {
      name: 'Generated', value: new Date().toISOString().slice(0, 10),
      note: 'Regenerate before a test or a review',
    },
  ].filter(Boolean);

  // ---- 2. can we recover it — one line, and the honest-numbers rule decides it
  //
  // docs/measured-numbers.md: only `state: 'measured'` may be spoken of as a
  // capability. Every other state produces NOT PROVEN, whatever number is on
  // file, and a declared number is named as typed-in inside the same sentence.
  const rtaStamp = numbers.rtaStamp ? ` (${numbers.rtaStamp})` : '';
  const blockerTail = blockerTotal ? ` ${plural(blockerTotal, 'blocker')} still open.` : '';

  // ---- is the evidence speakable in the PRESENT tense? ----
  //
  // measured.js gained a fourth verdict, `met-with-caveats`: both numbers were
  // inside target on the day, and the evidence behind at least one of them is
  // stale (past the freshness threshold) or came off a run that was not clean —
  // the bar reached only after undocumented manual intervention. Its
  // `isAchievement` flag goes false with it. This ladder used to recompute
  // readiness from `meetsRto` alone, so a 684-day-old, hand-helped run printed a
  // green "RECOVERABLE — inside the RTO" to an executive. It reads the module's
  // verdict now. The per-metric verdicts stay the pure numeric comparison by
  // contract, so the caveat is applied here, where the claim is made.
  // Name the side that is caveated: the RTA and the RPA can come off different
  // tests, and "the evidence is 2 days old" beside a 986-day-old RPA is the
  // payload arguing with itself again.
  const staleSide = numbers.rtaStale && numbers.rpaStale ? 'both numbers'
    : numbers.rtaStale ? 'the recovery-time evidence'
      : numbers.rpaStale ? 'the data-loss evidence' : '';
  const staleDays = numbers.rtaStale ? numbers.rtaStaleDays : numbers.rpaStale ? numbers.rpaStaleDays : null;
  const caveatReasons = [
    staleSide
      ? `${staleSide} ${numbers.rtaStale && numbers.rpaStale ? 'are' : 'is'} ${staleDays} days old, `
        + 'past the freshness threshold'
      : '',
    numbers.rtaCleanRun === false || numbers.rpaCleanRun === false
      ? 'the run was not clean — the bar was reached only after undocumented manual intervention'
      : '',
  ].filter(Boolean);
  const caveated = numbers.rtaState === 'measured' && (
    numbers.verdict?.overall === 'met-with-caveats'
    || caveatReasons.length > 0
    // The module's own flag, when it ran: met on the numbers, refused as an
    // achievement. Never recomputed here.
    || (numbers.meetsRto === true && numbers.rtaIsAchievement === false)
  );
  numbers.evidenceCaveats = caveated
    ? (caveatReasons.length ? caveatReasons
      : ['the evidence behind it cannot be spoken of in the present tense'])
    : [];
  numbers.caveated = caveated;

  const verdict = (() => {
    const v = (() => {
      if (numbers.rtaState !== 'measured') {
        return {
          state: 'unproven', tint: 'err', label: 'NOT PROVEN',
          because: `no passed test has measured a recovery time for ${subject}.`
            + (numbers.rtaState === 'declared'
              ? ` The ${numbers.rtaMinutes} min on file was typed into Settings, not measured.` : '')
            + blockerTail,
        };
      }
      if (numbers.meetsRto === false) {
        return {
          state: 'missed', tint: 'err', label: 'OVER TARGET',
          because: `${subject} came back in ${numbers.rtaMinutes} min against a `
            + `${numbers.rtoMinutes} min RTO${rtaStamp}.${blockerTail}`,
        };
      }
      // Before the blocker line and before RECOVERABLE: a number that was
      // inside target on a run nobody can repeat today is not a capability, and
      // the word for it is not "recoverable".
      if (caveated && numbers.meetsRto !== false) {
        return {
          state: 'met-with-caveats', tint: 'warn', label: 'MET ON A PAST RUN — NOT PROVEN CURRENT',
          because: `${subject} came back in ${numbers.rtaMinutes} min`
            + `${numbers.rtoMinutes != null ? `, inside the ${numbers.rtoMinutes} min RTO` : ''}${rtaStamp}, `
            + `but ${numbers.evidenceCaveats.join(', and ')}. `
            + 'Re-test before anyone says this objective is met.'
            + blockerTail,
        };
      }
      if (blockerTotal) {
        return {
          state: 'at-risk', tint: 'warn', label: 'MEASURED, BUT AT RISK',
          because: `${numbers.rtaMinutes} min`
            + `${numbers.rtoMinutes != null ? `, inside the ${numbers.rtoMinutes} min RTO` : ''}${rtaStamp}.${blockerTail}`,
        };
      }
      if (numbers.meetsRto === true) {
        return {
          state: 'proven', tint: numbers.rpaState === 'measured' ? 'ok' : 'warn', label: 'RECOVERABLE',
          because: `${subject} came back in ${numbers.rtaMinutes} min, inside the `
            + `${numbers.rtoMinutes} min RTO${rtaStamp}.`
            + (numbers.rpaState === 'measured' ? '' : ' Data loss has never been measured.'),
        };
      }
      return {
        state: 'no-target', tint: 'warn', label: 'MEASURED, NO TARGET',
        because: `${numbers.rtaMinutes} min${rtaStamp}, but ${objective.none
          ? `${objective.owner} has no RTO of its own to judge it against — and the workspace's belongs to the workspace`
          : 'the business has not set an RTO to judge it against'}.`,
      };
    })();
    return { ...v, text: `${v.label} — ${v.because}` };
  })();

  // The five rows under the verdict. Value and provenance are separate cells, so
  // a number copied out of this sheet carries where it came from with it.
  // WHOSE target this is, in the provenance cell: the service's (with the BIA
  // that set it), the environment's, or the workspace's. A scope with no
  // objective of its own says so there rather than borrowing one.
  const targetWhy = objective.why;
  const stateWhy = (state) => (state === 'measured' ? 'Measured — evidence'
    : state === 'declared' ? 'TYPED IN — not evidence' : 'Never measured');
  const numberRows = [
    {
      name: 'RTO target — downtime allowed', value: minText(numbers.rtoMinutes) ?? 'not set',
      why: numbers.rtoMinutes == null
        ? (objective.none ? targetWhy : 'Nobody has set one') : targetWhy,
      tint: numbers.rtoMinutes == null ? 'warn' : null,
    },
    {
      name: 'RPO target — data loss allowed', value: minText(numbers.rpoMinutes) ?? 'not set',
      why: numbers.rpoMinutes == null
        ? (objective.none ? targetWhy : 'Nobody has set one') : targetWhy,
      tint: numbers.rpoMinutes == null ? 'warn' : null,
    },
    // Two numbers that disagree are a governance fact, not a rendering choice:
    // printing one of them and dropping the other is how the wrong one reaches
    // a board. Present only when they actually differ.
    objective.conflict ? {
      name: 'These targets are NOT reconciled', value: objective.conflict.workspaceValue,
      why: objective.conflict.text,
      tint: 'warn',
    } : null,
    // Green means "this is a capability today". A measured number whose
    // evidence is stale or came off a run that needed hands-on help is amber,
    // and the cell says which — the module's isAchievement flag, not a
    // recomputed comparison, decides it.
    {
      name: 'RTA — time actually taken', value: minText(numbers.rtaMinutes) ?? 'none',
      // The caveat leads: it is the fact that decides whether the number may be
      // quoted, so it must not be what the clip drops.
      why: numbers.rtaState === 'measured'
        ? clipWords(join([caveated ? 'PAST RUN — NOT current' : '',
          numbers.rtaStamp || 'passed test'], ' · '), caveated ? 80 : 58)
        : stateWhy(numbers.rtaState),
      tint: numbers.rtaState !== 'measured' ? 'warn'
        : numbers.meetsRto === false ? 'err'
          : numbers.meetsRto ? (caveated ? 'warn' : 'ok') : null,
    },
    {
      name: 'RPA — data actually lost', value: minText(numbers.rpaMinutes) ?? 'none',
      why: numbers.rpaState === 'measured'
        ? clipWords(join([caveated ? 'PAST RUN — NOT current' : '',
          numbers.rpaStamp || 'passed test'], ' · '), caveated ? 80 : 58)
        : stateWhy(numbers.rpaState),
      tint: numbers.rpaState !== 'measured' ? 'warn'
        : numbers.meetsRpo === false ? 'err'
          : numbers.meetsRpo ? (caveated ? 'warn' : 'ok') : null,
    },
    {
      name: 'Last recovery test', value: history[0] ? history[0].statusLabel : 'none ever run',
      why: history[0] ? clipWords(join([history[0].name, history[0].date], ' · '), 58) : 'An untested plan is a hypothesis',
      tint: !history[0] || history[0].status === 'failed' ? 'err'
        : history[0].status === 'passed' ? 'ok' : 'warn',
    },
  ].filter(Boolean);

  // ---- 3. what would stop us — ONE ranked list ----
  //
  // Computed findings and written-down gaps interleaved by severity. An exec
  // does not care which list a blocker sits on; the owner cell is where that
  // shows, because an untriaged finding's honest owner is nobody. This replaces
  // two tables and the 500-character paragraph that introduced them — the counts
  // that paragraph carried are now the section headline, one line long.
  const stoppers = [
    ...(computed?.top || []).map((f) => ({
      title: f.title,
      severity: f.severity,
      component: f.component,
      owner: (d.byId.get(f.componentId) && ownerTeam(d.byId.get(f.componentId))) || '',
      ticket: '',
      triaged: false,
      blocksRecovery: !!f.blocksRecovery,
      isBlocker: f.severity === 'blocker' || STRUCTURAL_HOLE_RULES.has(f.rule),
    })),
    ...risks.map((r) => ({
      title: r.title,
      severity: r.severity,
      component: r.component,
      owner: r.owner,
      ticket: r.ticket || '',
      triaged: true,
      blocksRecovery: false,
      isBlocker: r.severity === 'blocker',
    })),
  ].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
    || Number(b.isBlocker) - Number(a.isBlocker)
    || Number(b.blocksRecovery) - Number(a.blocksRecovery)
    || Number(a.triaged) - Number(b.triaged))
    .slice(0, 5)
    .map((s) => ({
      ...s,
      title: clipWords(s.title, 92),
      // Who is on the hook. "NOT TRIAGED" is the answer for a computed finding,
      // and it is that finding's most important fact, so it leads.
      who: s.triaged
        ? clipWords(join([s.owner || 'unassigned', s.ticket], ' · '), 54)
        : clipWords(`NOT TRIAGED · ${s.owner || s.component}`, 54),
      where: clipWords(s.component, 44),
    }));

  const stopperHeadline = (() => {
    if (!computed) {
      return 'the risk engine did not run — an empty list below is NOT evidence of a clean plan';
    }
    const bits = [];
    if (computed.blockerCount) bits.push(plural(computed.blockerCount, 'computed blocker'));
    if (blockerGapCount) bits.push(`${blockerGapCount} written-down blocker${blockerGapCount === 1 ? '' : 's'}`);
    if (bits.length) return `${bits.join(' + ')}. THIS PLAN IS NOT CLEAN`;
    if (computed.total || openGaps.length) {
      return `no blockers — ${plural(computed.total, 'computed finding')}, ${plural(openGaps.length, 'open gap')}`;
    }
    return 'nothing recorded — which is still not the same as a passed test';
  })();

  // ---- 4. what happens next ----
  //
  // Three on the page, each with a name against it. `trigger` is the lead clause
  // of the derived why; the full paragraph stays with the row (a cell note on the
  // sheet, the Detail section in the .md), because the reason an action is here
  // is the two sections directly above it.
  const actionRows = actions.map((a, i) => ({
    n: i + 1,
    action: clipWords(a.action, 108),
    owner: a.owner || 'unassigned',
    trigger: clipWords(leadClause(a.why), 76),
    why: a.why,
  }));

  // ---- where the rest of it lives ----
  //
  // Ruthless subtraction only works if the reader can find what was subtracted.
  const pointers = [
    computed && computed.total ? `all ${computed.total} findings: service profile pages` : null,
    openGaps.length ? `all ${openGaps.length} gaps: Workbench sheet` : null,
    history.length > 1 ? 'every test: Tests sheet' : null,
    'counts, restore order and actions 4+: below the print line',
  ].filter(Boolean);

  return {
    workspace: {
      slug: meta.slug || '',
      name: meta.name || meta.slug || '',
      org: meta.org || '',
      description: meta.description || '',
      primaryRegion: meta.regions?.primary || '',
      recoveryRegion: meta.regions?.recovery || '',
      strategy: meta.strategy || '',
      strategyName: strategyName(meta.strategy),
      strategyOption: strategyOption(meta.strategy),
      tooling: (meta.tooling || []).map((t) => ({ key: String(t), label: toolingLabel(t) })),
      generated: new Date().toISOString().slice(0, 10),
    },
    scope: {
      kind: service ? 'service' : 'workspace',
      name: service ? service.name : (meta.name || ''),
      componentCount: d.components.length,
      depsCount: d.scope?.depsCount ?? null,
      dependentsCount: d.scope?.dependentsCount ?? null,
      // docs/ENV-SERVICE-MODEL.md §3. Present whether or not the scope helper
      // has landed; the labels say "not scoped" rather than guessing.
      envId: d.scope?.envId || null,
      envLabel,
      envRegions: envPair || null,
      serviceId: d.scope?.serviceId || null,
      serviceLabel,
      subject,
      // What narrowing to this scope takes out of frame — carried on the model
      // so sheet 1 can print it, not only the Diagrams tab. A scoped package
      // that reads clean because the mess is filed against another service is
      // the exact failure this block exists to prevent.
      label: d.scope?.label || '',
      sentence: d.scope?.sentence || '',
      warnings: arr(d.scope?.warnings),
      hidden: d.scope?.hidden || null,
      hiddenSentences: arr(d.scope?.hiddenSentences),
    },
    // The four answers the one-pager renders. Both the sheet and the .md print
    // these verbatim — neither composes a verdict or a headline of its own.
    identityRows,
    verdict,
    numberRows,
    stoppers,
    stopperHeadline,
    actionRows,
    blockerGapCount,
    blockerTotal,
    pointers,
    service,
    numbers,
    risks,
    // The risk engine's headline (NEW-8). null when the engine could not be
    // loaded — in which case every surface says so rather than reporting clean.
    computedRisks: computed,
    openGapCount: openGaps.length,
    gapsBySeverity: ['blocker', 'high', 'medium', 'low']
      .map((s) => [s, openGaps.filter((g) => g.severity === s).length]).filter(([, n]) => n),
    tests: history,
    actions,
    inventory: {
      total: d.components.length,
      byCategory: [...countBy(d.components, (c) => c.category)].sort((a, b) => b[1] - a[1]),
      byLayer: [...countBy(d.components, (c) => c.restoreLayer || '(layer not set)')]
        .sort((a, b) => layerOrder(a[0]) - layerOrder(b[0])),
      byScope: scopeCounts,
      verified: d.components.length - noVerification.length,
      unknownSecrets: unknownSecrets.length,
      runbooks: d.runbooks.length,
      checklistItems: d.checklists.reduce((n, c) => n + (c.items || []).length, 0),
      checklistDone: d.checklists.reduce((n, c) => n + (c.items || []).filter((i) => i.done).length, 0),
    },
    maturity: m ? { level: m.level, label: m.label, avg: Math.round(m.avg * 100) / 100, answered: m.answered } : null,
  };
}

/**
 * The executive one-pager as data, for the .md in the DR Package.
 * Async since NEW-8: the computed risk digest is loaded lazily (see
 * computedRiskDigest) so this module and routes/service.js cannot deadlock on
 * each other's top-level imports.
 */
export async function executiveSummaryModel(slug, scopeOpts = {}) {
  const d = loadData(slug, normalizeScope(scopeOpts));
  await attachComputedRisks(slug, d);
  return execModel(d);
}

const minText = (v) => (v == null ? null : `${v} min`);

// The lead clause of a derived "why now", for the one-pager's "Why now" column.
// The full paragraph stays on the row as a cell note and in the .md tail.
const leadClause = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : t).replace(/\.$/, '');
};


// The one-pager. Four questions, in this order, and nothing else above the
// print line: what this is · can we recover it · what would stop us · what
// happens next. Three columns totalling 96 character-widths, which is what fits
// a portrait page at 100% — the old 144 forced Excel to shrink the whole sheet,
// and the 76-wide "What it means" column held paragraphs that explained the
// sheet rather than the situation. Explanation moved below the print line or
// onto the sheet it came from; the WHERE THE REST IS row says where.
function addExecutiveSummary(wb, d) {
  const x = execModel(d);
  const columns = [
    { header: 'What', width: 44, wrap: true },
    { header: 'Value', width: 26, wrap: true },
    { header: 'Evidence / owner', width: 26, wrap: true },
  ];
  const title = x.service
    ? `Executive summary — ${x.service.name}`
    : `Executive summary — ${x.workspace.name}`;
  const ws = addSheet(wb, 'Executive Summary', title, columns, {
    gridLines: false,
    zoom: 100,
    print: { orientation: 'portrait' },
    note: 'Every value here is computed from this workspace — nothing is estimated. A target reads "not set" '
      + 'when nobody has set one; a measurement reads "none" until a PASSED test produced it. Detail below the print line.',
  });

  // label / value / note, with the value tinted when it is worth a second look
  const line = (label, value, { tint = null, note = '', numFmt = null, bold = false, list = null } = {}) => {
    const r = ws.addRow([label, value, note]);
    r.getCell(1).font = ARIAL({ bold, color: { argb: INK } });
    r.getCell(1).alignment = { vertical: 'top', wrapText: true };
    const vc = r.getCell(2);
    vc.font = ARIAL({ bold, ...(tint ? { color: { argb: TINT[tint].font } } : {}) });
    vc.alignment = { vertical: 'top', wrapText: true };
    if (tint) vc.fill = solid(TINT[tint].fill);
    if (numFmt && typeof value === 'number') vc.numFmt = numFmt;
    if (list) vc.dataValidation = { type: 'list', allowBlank: true, formulae: [list] };
    r.getCell(3).font = ARIAL({ color: { argb: MUTED } });
    r.getCell(3).alignment = { vertical: 'top', wrapText: true };
    return r;
  };
  const section = (text) => groupRow(ws, columns, text, { size: 11 });
  const spacer = () => ws.addRow([]);
  const para = (text, { tint = null, height = 30, bold = false } = {}) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, columns.length);
    const c = r.getCell(1);
    c.font = ARIAL({ bold, ...(tint ? { color: { argb: TINT[tint].font } } : { color: { argb: MUTED } }) });
    if (tint) c.fill = solid(TINT[tint].fill);
    c.alignment = { vertical: 'middle', wrapText: true };
    r.height = height;
    return r;
  };

  // -------------------------------------------------- 1. WHAT THIS IS
  //
  // Which system, which environment, which service — no paragraph. The
  // workspace description (490 characters on the seed) is now a cell note on
  // the System row: one click away, no longer a fifth of the printed page.
  section('WHAT THIS IS');
  for (const r of x.identityRows) {
    const row = line(r.name, r.value, { bold: !!r.bold, tint: r.tint || null, note: r.note });
    if (r.full) row.getCell(2).note = r.full;
  }
  spacer();

  // ------------------------------- 1b. WHAT SCOPING THIS WAY HIDES (scoped only)
  //
  // The same disclosure the markdown export carries, on the sheet people
  // actually print. It lived only on the Diagrams tab — the fourth tab, which
  // is not the page that goes into the pack — while sheet 1 could report "Open
  // gap items 0" for a package whose workspace has an open blocker. Absent
  // entirely on an unscoped export: there, nothing is out of frame.
  const sc = x.scope || {};
  if (sc.hiddenSentences.length || sc.sentence || sc.warnings.length) {
    const loud = !!(sc.hidden && (sc.hidden.blockerOrHighGaps || sc.hidden.failedTests));
    section('WHAT THIS PACKAGE IS SCOPED TO — AND WHAT THAT HIDES');
    if (sc.sentence) para(`SCOPE — ${sc.sentence}`, { height: 30 });
    if (loud) {
      para('READ THIS BEFORE YOU CALL THIS PACKAGE CLEAN — narrowing to this scope took known problems out of frame.',
        { tint: 'err', height: 18, bold: true });
    }
    for (const sentence of sc.hiddenSentences) {
      para(`• ${sentence}`, { tint: loud ? 'warn' : null, height: 30 });
    }
    for (const w of sc.warnings) para(`• ${w}`, { tint: 'warn', height: 30 });
    para('The whole-workspace export is the one that shows everything: rebuild it without envId/serviceId '
      + 'to see the findings above in context.', { height: 18 });
    spacer();
  }

  // ------------------------------------------- 2. CAN WE RECOVER IT
  //
  // One verdict line, then five rows. The verdict is composed in execModel so
  // this sheet and the .md cannot word it differently, and it obeys
  // docs/measured-numbers.md: nothing but a PASSED test that covers the subject
  // can produce anything other than NOT PROVEN.
  section('CAN WE RECOVER IT');
  const verdictRow = para(x.verdict.text, { tint: x.verdict.tint, height: 30, bold: true });
  if (x.numbers.notes) verdictRow.getCell(1).note = x.numbers.notes;
  const numbersHead = bandHeader(ws, ['Number', 'Value', 'Where it came from']);
  // The honest-numbers rule itself: one hover away, and it costs the page nothing.
  numbersHead.getCell(3).note = 'RTO/RPO are targets. RTA/RPA are evidence ONLY when a test that PASSED and covered '
    + 'this subject produced them — a number typed in by hand is a note to self. A target nobody has met is not a '
    + 'recovery capability. See docs/measured-numbers.md.';
  x.numberRows.forEach((n, i) => {
    const row = dataRow(ws, columns, [n.name, n.value, n.why], { stripe: i % 2 === 1 });
    const vc = row.getCell(2);
    vc.font = ARIAL({ bold: true, ...(n.tint ? { color: { argb: TINT[n.tint].font } } : {}) });
    if (n.tint) vc.fill = solid(TINT[n.tint].fill);
  });
  spacer();

  // ------------------------------------------ 3. WHAT WOULD STOP US
  //
  // ONE ranked list: computed findings and written-down gaps interleaved by
  // severity (NEW-8 kept — an untriaged finding is not a smaller problem, and
  // the Owner cell says "NOT TRIAGED" rather than naming somebody who has not
  // agreed to it). The counts and the not-clean verdict that used to fill a
  // 500-character paragraph are the section headline.
  section(`WHAT WOULD STOP US — ${x.stopperHeadline}`);
  if (x.stoppers.length) {
    bandHeader(ws, ['Blocker or gap', 'Severity', 'Owner']);
    x.stoppers.forEach((s, i) => {
      const row = dataRow(ws, columns, [s.title, s.severity, s.who], { stripe: i % 2 === 1 });
      row.getCell(1).note = `${s.component}${s.triaged ? '' : ' — computed by the risk engine, not yet triaged into the gap list'}`;
      row.getCell(2).alignment = { vertical: 'top', horizontal: 'center' };
    });
    addCF(ws, 2, ws.rowCount - x.stoppers.length + 1, ws.rowCount, CF_SEVERITY);
  } else {
    para(x.computedRisks
      ? 'Nothing is recorded and the risk engine found nothing on the services it scanned — which is still not a passed test.'
      : 'Nothing is written down AND the risk engine did not run. Treat this as unknown, not clean.',
      { tint: x.computedRisks ? null : 'warn', height: 16 });
  }
  spacer();

  // ------------------------------------------ 4. WHAT HAPPENS NEXT
  //
  // Three, each with a name against it. The rest of the derived list is below
  // the print line. The "why now" paragraph that used to run to 350 characters
  // per row is a cell note: the reason is the two sections directly above it.
  section('WHAT HAPPENS NEXT');
  if (x.actionRows.length) {
    bandHeader(ws, ['Action', 'Owner', 'Why now']);
    x.actionRows.slice(0, 3).forEach((a, i) => {
      const row = dataRow(ws, columns, [`${a.n}. ${a.action}`, a.owner, a.trigger],
        { stripe: i % 2 === 1 });
      row.getCell(1).note = a.why;
    });
  } else {
    para(x.computedRisks
      ? 'No action falls out of the current data — no open blockers, targets approved, tests passing, scope decided.'
      : 'No action falls out of what is written down — but the risk engine did not run, so that is not the same as none.',
      { height: 16, tint: x.computedRisks ? null : 'warn' });
  }
  spacer();

  // Where everything that is NOT on this page lives.
  para(`WHERE THE REST IS — ${x.pointers.join(' · ')}.`, { height: 16 });

  // Printing stops here: this is the one-pager. The detail below is for
  // whoever scrolls, not for the meeting.
  const onePagerEnd = ws.rowCount;
  ws.pageSetup.printArea = `A1:${colLetter(columns.length)}${onePagerEnd}`;

  spacer();
  para('— Detail below this line is not part of the printed one-pager —', { height: 16 });
  spacer();

  // ------------------------------------------- what the one-pager dropped
  //
  // Nothing was deleted, it moved here (or to the sheet the WHERE THE REST IS
  // row names). In order: the qualifying note on the numbers, the rest of the
  // derived actions, the full test history, and — for a scoped package — the
  // restore order and the blast radius.
  if (x.numbers.notes) {
    section('THE NOTE ON THESE NUMBERS');
    para(x.numbers.notes, { height: 32 });
    spacer();
  }

  if (x.actionRows.length > 3) {
    section('FURTHER ACTIONS — DERIVED, BELOW THE TOP THREE');
    bandHeader(ws, ['Action', 'Owner', 'Why now']);
    x.actionRows.slice(3).forEach((a, i) => dataRow(ws, columns, [
      `${a.n}. ${a.action}`, a.owner, a.why,
    ], { stripe: i % 2 === 1 }));
    spacer();
  }

  section('TEST HISTORY — WHAT HAS ACTUALLY BEEN PROVEN');
  if (x.tests.length) {
    bandHeader(ws, ['Test', 'Result', 'Measured']);
    x.tests.slice(0, 8).forEach((t, i) => {
      const measured = join([
        t.rtaMinutes != null ? `RTA ${t.rtaMinutes} min` : 'RTA unmeasured',
        t.rpaMinutes != null ? `RPA ${t.rpaMinutes} min` : 'RPA unmeasured',
        (t.rtaMinutes != null || t.rpaMinutes != null) && t.status !== 'passed'
          ? 'NOT measurements — this run did not pass' : '',
        t.cleanRun === true ? 'clean run' : t.cleanRun === false ? 'not a clean run' : '',
        t.findings ? plural(t.findings, 'finding') : 'no findings',
      ], ' · ');
      const row = dataRow(ws, columns, [
        join([t.name, t.date ? `(${t.date})` : ''], ' '), t.statusLabel, measured,
      ], { stripe: i % 2 === 1 });
      row.getCell(2).alignment = { vertical: 'top', horizontal: 'center' };
    });
    addCF(ws, 2, ws.rowCount - Math.min(8, x.tests.length) + 1, ws.rowCount, CF_STATUS);
  } else {
    para('No recovery tests have been recorded. An untested plan is a hypothesis: nothing in the numbers above can be defended yet.',
      { tint: 'err', height: 18 });
  }
  spacer();

  if (x.service && (x.service.needs.length || x.service.neededBy.length)) {
    section(`WHAT ${x.service.name.toUpperCase()} NEEDS TO COME BACK — IN RESTORE ORDER`);
    if (x.service.needs.length) {
      bandHeader(ws, ['Must come back first', 'Layer', 'Recovery posture']);
      x.service.needs.forEach((n, i) => {
        const r = dataRow(ws, columns, [n.name, n.layer || 'not set', n.posture], { stripe: i % 2 === 1 });
        r.getCell(2).alignment = { vertical: 'top', horizontal: 'center' };
        if (n.inRecoveryScope !== 'yes') {
          r.getCell(3).font = ARIAL({ color: { argb: TINT.warn.font } });
        }
      });
    }
    if (x.service.neededBy.length) {
      spacer();
      bandHeader(ws, ['Breaks while this is down', 'Tier / layer', 'Owner']);
      x.service.neededBy.forEach((n, i) => dataRow(ws, columns, [
        n.name, join([n.tier != null ? `Tier ${n.tier}` : '', n.layer], ' · ') || '—', n.owner,
      ], { stripe: i % 2 === 1 }));
    }
    spacer();
  }

  // --------------------------------------------------- 7. readiness detail
  section('READINESS DETAIL — THE COUNTS BEHIND THE SUMMARY');
  const inv = x.inventory;
  line('Components tracked', inv.total, {
    numFmt: '0',
    note: inv.byCategory.map(([k, v]) => `${k} ${v}`).join(' · '),
  });
  for (const [s, n] of Object.entries(inv.byScope)) {
    line(`In recovery scope: ${s}`, n, {
      numFmt: '0',
      tint: s === 'partial' || s === 'unknown' ? 'warn' : s === 'no' ? 'err' : null,
    });
  }
  line('With a verification command', inv.verified, {
    numFmt: '0',
    tint: inv.verified < inv.total ? 'warn' : 'ok',
    note: inv.verified < inv.total
      ? `${inv.total - inv.verified} component(s) have no way to prove they came back`
      : 'Every component can be checked — see the Verification Catalog sheet',
  });
  if (inv.unknownSecrets) {
    line('Secrets with unknown replication', inv.unknownSecrets, {
      numFmt: '0', tint: 'err',
      note: 'Drive each to yes or no on the Secrets Reconciliation sheet',
    });
  }
  line('Runbooks', inv.runbooks, {
    numFmt: '0', tint: inv.runbooks ? null : 'err',
    note: inv.runbooks ? 'Procedures available — see the Runbooks sheet' : 'No procedure exists for this recovery',
  });
  if (inv.checklistItems) {
    line('Checklist items done', `${inv.checklistDone} / ${inv.checklistItems}`, {
      tint: inv.checklistDone === inv.checklistItems ? 'ok' : 'warn',
      note: 'Pre-test and cutover checklists — proof in hand before flipping Done',
    });
  }
  spacer();

  groupRow(ws, columns, 'COMPONENTS BY RESTORE LAYER — THE RECOVERY ORDER');
  for (const [layer, n] of inv.byLayer) {
    line(LAYER_LABELS[layer] || layer, n, { numFmt: '0', note: layer === '(layer not set)' ? 'Position in the recovery order undefined' : '' });
  }
  spacer();

  groupRow(ws, columns, 'OPEN GAPS BY SEVERITY');
  // A zero that exists BECAUSE of scoping is not a zero. Whenever gaps were
  // filtered out of this package, the count says how many are open in the
  // workspace and where to read them — a scoped package reporting "Open gap
  // items 0" while a blocker is open in the workspace is the single most
  // misleading cell this sheet can print.
  const hiddenGaps = sc.hidden && (sc.hidden.openGaps || sc.hidden.blockerOrHighGaps) ? sc.hidden : null;
  const hiddenGapNote = hiddenGaps
    ? `${hiddenGaps.blockerOrHighGaps ? `${hiddenGaps.blockerOrHighGaps} at blocker/high. ` : ''}`
      + 'Listed under WHAT THIS PACKAGE IS SCOPED TO'
    : '';
  if (x.gapsBySeverity.length) {
    for (const [sev, n] of x.gapsBySeverity) {
      line(sev, n, { numFmt: '0', tint: sev === 'blocker' || sev === 'high' ? 'err' : sev === 'medium' ? 'warn' : null });
    }
    if (hiddenGaps) {
      line('Open, but outside this scope', hiddenGaps.openGaps, {
        numFmt: '0', tint: hiddenGaps.blockerOrHighGaps ? 'err' : 'warn', note: hiddenGapNote,
      });
    }
  } else if (hiddenGaps) {
    line('Open gap items IN THIS PACKAGE', 0, {
      numFmt: '0',
      tint: hiddenGaps.blockerOrHighGaps ? 'err' : 'warn',
      note: `Zero because of SCOPING, not because the plan is clean — ${hiddenGaps.openGaps} open outside it. ${hiddenGapNote}`,
    });
  } else {
    line('Open gap items', 0, { numFmt: '0' });
  }
  spacer();

  groupRow(ws, columns, 'MATURITY ASSESSMENT');
  if (x.maturity) {
    line('Overall level', x.maturity.label, {
      tint: x.maturity.level >= 4 ? 'ok' : x.maturity.level >= 2 ? 'warn' : 'err',
      note: `Average answer score ${x.maturity.avg} of 4 across ${plural(x.maturity.answered, 'answered question')}`,
    });
  } else {
    line('Assessment', 'not answered yet', { tint: 'warn', note: 'See the Assessment page in DR Compass' });
  }
  return ws;
}

// ============================================================= the tree grid
//
// Resource Graph, Runtime, Dependencies, Tests and Workbench all render on ONE
// 11-column grid, so a row means the same thing wherever you find it:
//
//   Id | Category | Group | Component | Kind | Status | Status notes |
//   Day-0? | In DR scope? | ARN / reference | Resources/links
//
// Column 10 used to be headed "ARN" and, on most sheets, held something that
// was not an ARN: a TIER on Dependencies, a ticket on the gap rows, an owner on
// the Phase 0 gate, a contact on People, a date on Decisions, a Kubernetes uid
// on the workload rows. A header that does not describe its cells is a lie that
// reads as data — someone copies that column expecting ARNs and gets "Tier 0".
// So the column is "ARN / reference" and the convention is:
//
//   * a real ARN, or a resource/plan id that IS the identity (rid, res:…),
//     goes in BARE — it identifies itself;
//   * anything else carries a one-word prefix saying what it is (`ticket …`,
//     `owner …`, `contact …`, `decided …`, `uid …`, `ns …`, `id …`), so a cell
//     found on its own still says what it holds.
//
// Facts that are neither an ARN nor a reference — a tier, a restore layer, the
// pods behind a service — belong in Status notes, and that is where they are.
//
//   L0  the workspace (or the service, in a scoped package)
//   L1  a SECTION — a category, a restore layer, a test, a Workbench section
//   L2  a component / service / section item — the thing people look for
//   L3+ what hangs off it, nested by the REAL relationship, up to level 6
//
// Two rules make a row found six levels deep readable on its own:
//   * Category repeats the L1 section and Group repeats the L2 parent on EVERY
//     descendant row — so filtering Category reproduces any single-purpose
//     sheet this design replaced (Secrets, Gaps, People, Verification …);
//   * zebra runs continuously by ROW PARITY, so depth never breaks the banding.
//
// Status is the working column: a dropdown on every data row, tinted by
// conditional formatting on that cell only. It ARRIVES DERIVED from our data
// (test results, open gaps, recovery scope, replication) rather than blank.

const TREE_COLUMNS = [
  { header: 'Id', width: 6, align: 'right', numFmt: '0' },
  { header: 'Category', width: 28 },
  { header: 'Group', width: 36 },
  { header: 'Component', width: 52 },
  { header: 'Kind', width: 16 },
  { header: 'Status', width: 14, align: 'center', list: LIST_STATUS },
  { header: 'Status notes', width: 48 },
  { header: 'Day-0?', width: 10, align: 'center', list: LIST_YESNO },
  { header: 'In DR scope?', width: 12, align: 'center', list: LIST_DR_SCOPE },
  { header: 'ARN / reference', width: 56, mono: true },
  { header: 'Resources/links', width: 36, link: true },
];
const TREE_STATUS_COL = 6;
const TREE_SCOPE_COL = 9;
const TREE_COLS = TREE_COLUMNS.length;
// Excel supports outline levels 0-7; we use 0-6 and flatten anything deeper
// into its parent's Status notes rather than dropping it.
const MAX_LEVEL = 6;
const NOT_STARTED = 'Not started';

// Status notes is one line at width 48 (two, on the rows that wrap), so notes
// are trimmed hard: a note that will not fit is a fact that deserves its own row.
function trimText(s, max = 150) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const bits = (...parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join(' · ');

// The "ARN / reference" column (10). An ARN or a resource id identifies itself
// and goes in bare; everything else is prefixed with what it is, so a cell read
// on its own is never mistaken for an ARN. See the grid comment above.
const ref = (label, value) => {
  const v = String(value ?? '').trim();
  return v ? `${label} ${v}` : '';
};

function treeSheet(wb, name, title, { note, print = null } = {}) {
  return addSheet(wb, name, title, TREE_COLUMNS, {
    outline: true, note, print, zoom: 90,
  });
}

// One writer per tree sheet. It owns the running Id, the current Category (the
// L1 section) and Group (the L2 parent) — which it repeats downward — and the
// zebra/parent fills.
function treeWriter(ws) {
  let id = 0;
  let category = '';
  let group = '';
  const write = (level, o = {}) => {
    const lvl = Math.max(0, Math.min(MAX_LEVEL, level));
    if (lvl <= 1) {
      category = o.category ?? o.label ?? '';
      group = '';
    } else {
      if (o.category !== undefined) category = o.category;
      if (lvl === 2) group = o.group ?? o.label ?? '';
      else if (o.group !== undefined) group = o.group;
    }
    id += 1;
    const values = [
      id, category, lvl <= 1 ? '' : group, o.label ?? '', o.kind ?? '',
      o.status ?? '', trimText(o.notes, o.notesMax || 150), o.day0 ?? '', o.scope ?? '',
      o.arn ?? '', o.link ?? '',
    ];
    const row = ws.addRow(values);
    if (lvl) row.outlineLevel = lvl;
    row.height = 22.5;
    const isParent = lvl <= 1;
    const fill = isParent ? PARENT_FILL : (row.number % 2 === 1 ? ZEBRA : WHITE);
    const bold = lvl <= 2;
    const indent = Math.max(0, Math.min(4, lvl - 2));
    TREE_COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.fill = solid(fill);
      if (c.mono && values[i]) cell.font = { name: 'Courier New', size: 9, color: { argb: MUTED } };
      else if (c.link && values[i]) cell.font = ARIAL({ bold, color: { argb: LINK } });
      else cell.font = ARIAL({ bold, color: { argb: INK } });
      cell.alignment = {
        vertical: 'middle',
        horizontal: c.align || 'left',
        ...(i === 3 && indent ? { indent } : {}),
      };
      if (c.numFmt && typeof cell.value === 'number') cell.numFmt = c.numFmt;
      if (c.list) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [c.list] };
    });
    return row;
  };
  write.marker = (row, text) => {
    // How a scoped package marks its focus: the row is tinted green and says so.
    const cell = row.getCell(4);
    cell.fill = solid(TINT.ok.fill);
    cell.font = ARIAL({ bold: true, color: { argb: TINT.ok.font } });
    if (text) {
      const notes = row.getCell(7);
      notes.value = trimText(bits(text, notes.value));
      notes.font = ARIAL({ bold: true, color: { argb: TINT.ok.font } });
    }
    return row;
  };
  return write;
}

// Finish a tree sheet: status/scope tints, then one autoFilter over every data
// row. Nothing on these sheets is merged below row 1, so the filter is clean.
function finishTree(ws) {
  addCF(ws, TREE_STATUS_COL, 3, ws.rowCount, CF_TREE_STATUS);
  addCF(ws, TREE_SCOPE_COL, 3, ws.rowCount, CF_TREE_SCOPE);
  return filterAll(ws, TREE_COLS);
}

// ------------------------------------------------ derived Status / Day-0 rows
//
// The reference workbook left Status blank for someone to fill in. We have the
// data, so Status arrives DERIVED and Status notes say what it is derived FROM:
//
//   Fail        an app check for this component failed in the last finished test
//   Blocked     an open blocker gap is filed against it
//   Pass        an app check for it passed in the last finished test
//   Accepted    out of recovery scope, and the decision is recorded as accepted
//   N/A         out of recovery scope, nothing pending
//   Partial     partially in recovery scope
//   Unknown     scope unknown, or out of scope with an open question
//   Not started in scope, nothing measured yet — the honest default

const REPL_STATUS = { yes: 'Pass', no: 'Fail', unknown: 'Unknown' };

function statusModel(d) {
  const finished = d.tests
    .filter((t) => t.status === 'passed' || t.status === 'failed')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const latest = finished[0] || null;

  // Newest finished test wins for each component.
  const appByComponent = new Map();
  for (const t of finished) {
    for (const a of t.appTests || []) {
      if (!a.componentId || !a.result || appByComponent.has(a.componentId)) continue;
      appByComponent.set(a.componentId, {
        result: String(a.result).toLowerCase(),
        name: a.name || 'app check',
        test: t.name || 'a recovery test',
        date: t.date || '',
        critical: !!a.critical,
      });
    }
  }
  const gapsByComponent = new Map();
  for (const g of d.gaps) {
    if (!g.componentId) continue;
    if (!gapsByComponent.has(g.componentId)) gapsByComponent.set(g.componentId, []);
    gapsByComponent.get(g.componentId).push(g);
  }
  const openGaps = (cid) => (gapsByComponent.get(cid) || []).filter((g) => g.status !== 'resolved');

  const statusOf = (c) => {
    const app = appByComponent.get(c.id);
    const open = openGaps(c.id);
    if (app?.result === 'fail') return 'Fail';
    if (open.some((g) => g.severity === 'blocker')) return 'Blocked';
    if (app?.result === 'pass') return 'Pass';
    const scope = String(c.inRecoveryScope || 'unknown').toLowerCase();
    if (scope === 'no') {
      if (open.some((g) => g.status !== 'accepted')) return 'Unknown';
      return open.length ? 'Accepted' : 'N/A';
    }
    if (scope === 'partial') return 'Partial';
    if (scope !== 'yes') return 'Unknown';
    return NOT_STARTED;
  };

  // Why it says that — from the data, never invented. Worst news first.
  const notesOf = (c) => {
    const app = appByComponent.get(c.id);
    const open = openGaps(c.id);
    const blocker = open.find((g) => g.severity === 'blocker');
    const worst = blocker || open.find((g) => g.severity === 'high') || open[0] || null;
    const parts = [];
    if (app?.result === 'fail') {
      parts.push(`"${app.name}" FAILED in ${app.test}${app.date ? ` (${app.date})` : ''}`);
    } else if (app?.result === 'pass') {
      parts.push(`"${app.name}" passed in ${app.test}${app.date ? ` (${app.date})` : ''}`);
    }
    if (worst) {
      parts.push(`${worst.severity === 'blocker' ? 'BLOCKER' : worst.severity || 'gap'}: ${worst.title}`
        + `${worst.ticket ? ` (${worst.ticket})` : ''}`);
    }
    if (!parts.length && (c.gaps || []).length) parts.push(c.gaps[0]);
    if (c.replication?.notes) parts.push(c.replication.notes);
    if (!parts.length) {
      const scope = String(c.inRecoveryScope || 'unknown').toLowerCase();
      if (scope === 'yes') {
        parts.push(bits(c.replication?.mechanism ? `covered by ${c.replication.mechanism}` : 'in recovery scope',
          isNum(c.replication?.rpoMinutes) ? `RPO ${c.replication.rpoMinutes} min (configured)` : null,
          'nothing measured for it yet'));
      } else {
        parts.push(`recovery scope: ${scope}`);
      }
    }
    if (open.length > 1) parts.push(`${open.length} open gaps`);
    return bits(...parts);
  };

  // Day-0 = "needed in the first hour". Derived from Tier, which is the only
  // honest signal we have; edit the column if your Day-0 list differs.
  const day0Of = (c) => (c.tier == null ? '' : (c.tier <= 1 ? 'Yes' : 'No'));

  // Recovery scope, with Stale when a gap says the listing no longer matches.
  const scopeOf = (c) => {
    if (openGaps(c.id).some((g) => String(g.class || '').includes('stale'))) return 'Stale';
    const s = String(c.inRecoveryScope || 'unknown').toLowerCase();
    return s === 'yes' ? 'Yes' : s === 'no' ? 'No' : s === 'partial' ? 'Partial' : 'Unknown';
  };

  return { latest, appByComponent, openGaps, statusOf, notesOf, day0Of, scopeOf };
}

// ------------------------------------------------------ resource-graph walker
//
// The nesting is driven by the graph's own edges: a child is whatever an edge
// points AT from the row above. Two rules stop the walk from exploding:
// container edges (member-of) show the container but do not descend into it,
// and attribute-like types (AZ, KMS key, IAM policy, certificate …) are leaves.

const GRAPH_LEAF_TYPES = new Set([
  'availability-zone', 'kms-key', 'iam-policy', 'certificate', 'nacl',
  'elastic-ip', 'addon', 'launch-template', 'dns-record', 'bucket-policy',
  'queue-policy', 'tag-match', 'oidc-provider', 'instance-profile',
  'internet-gateway', 'vpc-endpoint', 'log-group', 'sns-topic', 'repository',
]);
const NO_DESCEND_RELATIONS = new Set(['member-of']);

const NODE_TYPE_LABELS = {
  vpc: 'VPC', nacl: 'Network ACL', 'kms-key': 'KMS key', 'iam-role': 'IAM role',
  'iam-policy': 'IAM policy', 'oidc-provider': 'OIDC provider',
  'db-subnet-group': 'DB subnet group', 'load-balancer': 'Load balancer',
  'target-group': 'Target group', 'availability-zone': 'Availability zone',
  'vpc-endpoint': 'VPC endpoint', 'nat-gateway': 'NAT gateway',
  'internet-gateway': 'Internet gateway', 'log-group': 'Log group',
  'sns-topic': 'SNS topic', 'dns-record': 'DNS record',
  'hosted-zone': 'Hosted zone', 'parameter-group': 'Parameter group',
  'security-group': 'Security group', 'route-table': 'Route table',
  'elastic-ip': 'Elastic IP', 'instance-profile': 'Instance profile',
  'launch-template': 'Launch template', 'bucket-policy': 'Bucket policy',
  'queue-policy': 'Queue policy', 'tag-match': 'Tag match',
};
const nodeTypeLabel = (t) => NODE_TYPE_LABELS[t]
  || cap(String(t || 'resource').replace(/-/g, ' '));
// "Other" is how the scanner labels anything it has no type for, and it reads
// like nothing: fall back to the AWS service it came from (EKS, SQS, S3 …).
const nodeLabel = (n) => {
  const kind = n.type === 'other' || !n.type
    ? (n.service || 'Resource')
    : nodeTypeLabel(n.type);
  return `${kind} ${n.name || n.rid || ''}`.trim();
};

// rid -> [{relation, node}], built once per workbook.
function graphEdgeIndex(d) {
  const nodes = d.resourceGraph?.nodes || {};
  const out = new Map();
  for (const e of d.resourceGraph?.edges || []) {
    if (!e.from || !e.to) continue;
    const child = nodes[e.to];
    if (!child) continue; // edges into components/unknown ends are lookups, not children
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push({ relation: e.relation || '', node: child });
  }
  for (const list of out.values()) {
    list.sort((a, b) => graphGroupIndex(a.node.type) - graphGroupIndex(b.node.type)
      || String(a.node.name || '').localeCompare(String(b.node.name || '')));
  }
  return out;
}

const nodeNotes = (n, relation) => bits(
  relation, kvText(n.details, ': ', 90), n.region ? n.region : null,
  n.source ? `via ${n.source}` : null,
);

// A resource row's own status, where the data actually says something:
// a secret with no replica is a real finding, a replicated one is real evidence.
function nodeStatus(n) {
  const repl = n.type === 'secret' ? String(n.details?.replicaRegions ?? '') : '';
  if (!repl) return '';
  return /^(none|)$/i.test(repl.trim()) ? 'Fail' : 'Pass';
}

// ------------------------------- the per-component resource dropdown --------
//
// docs/ENV-SERVICE-MODEL.md §4. Every component expands to the resources it is
// actually built from — an ELB to its security groups, network interfaces,
// listeners, target groups and the subnets it lives in — bucketed by type so
// each bucket is its own handle. And every resource row says what it DOES
// ("allows egress tcp/443 to 0.0.0.0/0"), not merely that it exists: that
// sentence is the difference between a plan and an inventory.
//
// The facts come from `component.resourceDetails[]`, which enrichment writes.
// The field is additive and may be absent (older workspace, enrichment never
// run), so every reader here degrades to the resource graph and the sheet looks
// exactly as it did before rather than going empty.

// Finer buckets than the CSV dataset's GRAPH_GROUPS, which lumps listeners in
// with target groups and hides network interfaces inside "Networking". Anything
// not named here falls through to GRAPH_GROUPS and then to the pluralised type
// name ("Secrets", "Repositories"), so a type nobody has thought of yet still
// lands in a sensibly named group.
const RESOURCE_GROUPS = [
  { label: 'Security groups', types: ['security-group'] },
  { label: 'Network interfaces', types: ['network-interface', 'elastic-ip'] },
  { label: 'Listeners', types: ['listener'] },
  { label: 'Target groups', types: ['target-group'] },
  { label: 'Load balancers', types: ['load-balancer'] },
  { label: 'Subnets & AZs', types: ['subnet', 'availability-zone', 'db-subnet-group'] },
  { label: 'Networking', types: ['vpc', 'vpc-endpoint', 'vpc-link', 'route-table', 'nat-gateway', 'internet-gateway', 'network-acl', 'nacl'] },
  { label: 'DNS', types: ['hosted-zone', 'dns-record', 'health-check'] },
  { label: 'IAM', types: ['iam-role', 'iam-policy', 'iam-instance-profile', 'instance-profile', 'oidc-provider'] },
  { label: 'Encryption', types: ['kms-key', 'certificate'] },
  { label: 'Secrets', types: ['secret'] },
];
const resourceGroupAt = (type) => RESOURCE_GROUPS.findIndex((g) => g.types.includes(type));
// Ordered: the named buckets first, in the order above, then whatever the CSV
// dataset's own grouping makes of the rest — never interleaved with them.
const resourceGroupIndex = (type) => {
  const i = resourceGroupAt(type);
  return i === -1 ? RESOURCE_GROUPS.length + graphGroupIndex(type) : i;
};
const resourceGroupLabel = (type) => {
  const i = resourceGroupAt(type);
  return i === -1 ? graphGroupLabel(type) : RESOURCE_GROUPS[i].label;
};

// rid -> the enrichment record for it, for ONE component.
function resourceDetailMap(c) {
  const m = new Map();
  for (const r of c?.resourceDetails || []) {
    const rid = String(r?.rid || '').trim();
    if (rid && !m.has(rid)) m.set(rid, r);
  }
  return m;
}

const detailFacts = (detail) => (detail?.facts || [])
  .map((f) => trimText(f, 150)).filter(Boolean);

// A resourceDetails entry the resource graph has never seen still gets a row:
// enrichment described it, so it is real. Shaped like a graph node so nodeLabel,
// nodeNotes and nodeStatus read it with no special case.
const detailAsNode = (r) => ({
  rid: String(r.rid), type: r.type || 'other', service: r.service || '',
  name: r.name || '', arn: r.arn || '', region: r.region || '',
  details: r.details || {}, source: r.source || '',
});

// Status notes is trimmed at 150 characters. The facts are the whole point of
// the row, so they either ALL fit in the notes or they ALL get their own row
// underneath: half a firewall rule, cut mid-sentence, is worse than none.
const NOTES_ROOM = 150;
function factNotes(lead, facts) {
  if (!facts.length) return { notes: lead, spill: [] };
  const all = bits(lead, ...facts);
  if (all.length <= NOTES_ROOM) return { notes: all, spill: [] };
  return { notes: bits(lead, `${plural(facts.length, 'fact')} below`), spill: facts };
}

// What a resource-group row says about its facts.
function groupFactNote(grp, describedCount) {
  if (grp.facts) return `${plural(grp.facts, 'recorded fact')} — expand for what each one does`;
  return describedCount ? 'nothing recorded about these yet — re-run Discover → map dependencies' : null;
}

// Bucket a component's attachments. `items` are {node, relation, detail}.
function groupAttachments(items) {
  const m = new Map();
  for (const it of items) {
    const label = resourceGroupLabel(it.node.type);
    if (!m.has(label)) m.set(label, { order: resourceGroupIndex(it.node.type), label, items: [] });
    m.get(label).items.push(it);
  }
  const groups = [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const g of groups) {
    g.items.sort((a, b) => (a.node.type || '').localeCompare(b.node.type || '')
      || String(a.node.name || a.node.rid || '').localeCompare(String(b.node.name || b.node.rid || '')));
    g.facts = g.items.reduce((n, it) => n + detailFacts(it.detail).length, 0);
  }
  return groups;
}

// What a component is built from, from all three places it can be recorded: the
// graph edges out of the component, the nodes linked to it, and
// `resourceDetails`. Deduplicated on rid; `skip` is what the Kubernetes tier
// above has already rendered, so nothing is printed twice.
function componentAttachments(c, { edges, cNodes, relationFor, skip }) {
  const details = resourceDetailMap(c);
  const claimed = new Set();
  const out = [];
  const push = (node, relation) => {
    const rid = String(node?.rid || '');
    if (!rid || claimed.has(rid) || skip.has(rid)) return;
    claimed.add(rid);
    out.push({ node, relation: relation || '', detail: details.get(rid) || null });
  };
  for (const e of edges) push(e.node, e.relation);
  for (const n of cNodes) push(n, relationFor(n));
  for (const r of details.values()) push(detailAsNode(r), r.relation);
  return { attachments: out, details };
}

// ------------------------------------------- Resource Graph (the centrepiece)
//
// CATEGORY → parent component → its children nested by the real relationship:
// for the EKS cluster, namespaces → workloads → mounted secrets, Services and
// Ingresses → the load balancer they created → its listeners and target groups;
// for a database, subnet group → subnets → AZs, parameter group, KMS key; for a
// queue, DLQ, policy, KMS; plus every component's IAM roles → policies,
// security groups → VPC, secrets and certificates.

function addResourceGraph(wb, d, sm) {
  if (!d.components.length) return null;
  const rootId = d.scope?.rootId || '';
  const rootName = (rootId && d.byId.get(rootId)?.name) || d.scope?.rootName || '';
  const title = rootName
    ? `Resource Graph — ${rootName} and everything it is built from: expand a category, then the component, then its resources`
    : 'Resource Graph — expand a category, then the component, then the resources it is built from';
  const ws = treeSheet(wb, SHEETS.graph, title, {
    note: 'The inventory as a tree. Nesting follows the real relationship: an EKS cluster holds namespaces, '
      + 'a namespace holds workloads, a workload holds the secrets it mounts, an Ingress holds the load balancer '
      + 'it created, a database holds its subnet group. EVERY component also opens on its OWN resources, grouped '
      + '— Security groups, Network interfaces, Listeners, Target groups, Subnets & AZs, IAM, Encryption, DNS — '
      + 'and each resource row says what it DOES ("allows egress tcp/443 to 0.0.0.0/0") in Status notes. Use the '
      + '+/- handles in the left margin (the 1 2 3 4 5 6 7 buttons above them jump the whole sheet to one depth). '
      + 'Category and Group repeat on every row, so filter either one to pull a slice out. Status is a dropdown '
      + 'and arrives derived from our data.',
  });

  const write = treeWriter(ws);
  const g = graphModel(d);
  const edges = graphEdgeIndex(d);
  const nodesOf = (cid) => (g ? g.byComponent.get(cid) || [] : []);
  const k = hasK8s(d) ? d.k8s : null;
  const workloads = k?.workloads || [];
  const services = k?.services || [];
  const ingresses = k?.ingresses || [];

  // --------- L0: the account / workspace row, with the real counts on it ----
  const meta = d.meta || {};
  const graphCount = Object.keys(d.resourceGraph?.nodes || {}).length;
  const graphDate = d.resourceGraph?.updatedAt ? String(d.resourceGraph.updatedAt).slice(0, 10) : '';
  // Resources DESCRIBED — the ones that came back with facts on them. Said once,
  // here, so the group rows further down do not each repeat the same nag.
  const describedCount = d.components
    .reduce((n, c) => n + (c.resourceDetails || []).filter((r) => (r?.facts || []).length).length, 0);
  write(0, {
    label: bits(meta.name || meta.slug,
      `${meta.regions?.primary || '?'} → ${meta.regions?.recovery || '?'}`),
    kind: rootName ? 'service package' : 'workspace',
    notes: bits(
      plural(d.components.length, 'component'),
      graphCount ? `${plural(graphCount, 'discovered resource')}${graphDate ? ` (${graphDate})` : ''}` : 'no resource graph imported yet',
      describedCount ? `${plural(describedCount, 'resource')} described` : 'no resource notes yet',
      workloads.length ? plural(workloads.length, 'k8s workload') : null,
      'expand a category',
    ),
    link: meta.org || '',
  });

  // ---------------------------------------------------- per-namespace k8s ----
  const nsOwners = (ns) => [...new Set(workloads.filter((w) => (w.namespace || 'default') === ns)
    .map((w) => w.componentId).filter(Boolean))].map((id) => d.byId.get(id)).filter(Boolean);

  // Which load balancer (if any) an Ingress/Service actually created. Matched on
  // the component it belongs to, then on the host name in the LB's DNS name, then
  // on the k8s stack tag — never guessed into existence.
  const lbNodes = Object.values(d.resourceGraph?.nodes || {})
    .filter((n) => n.type === 'load-balancer');
  const matchLb = (cids, names, hosts) => {
    const wanted = new Set(cids.filter(Boolean));
    const text = [...names, ...hosts].map((s) => String(s || '').toLowerCase()).filter(Boolean);
    const hit = lbNodes.find((n) => (n.componentIds || []).some((id) => wanted.has(id)))
      || lbNodes.find((n) => {
        const hay = [n.name, n.details?.dnsName, ...Object.values(n.tags || {})]
          .map((s) => String(s || '').toLowerCase()).join(' ');
        return text.some((t) => t.length > 5 && hay.includes(t));
      });
    return hit || null;
  };

  const svcTargetsOf = (s) => (s.targets || [])
    .map((uid) => workloads.find((w) => w.uid === uid)).filter(Boolean);

  // ------------------------------------------------------- category sections
  for (const [cat, comps] of byCategory(d.components)) {
    // Counted the same way the component rows below count: the graph AND what
    // enrichment attached, so the section total is not smaller than its parts.
    const catNodes = comps.reduce((n, c) => n + new Set([
      ...nodesOf(c.id).map((x) => x.rid),
      ...(c.resourceDetails || []).map((r) => String(r?.rid || '')).filter(Boolean),
    ]).size, 0);
    write(1, {
      label: categoryLabel(cat),
      kind: 'Category',
      notes: bits(plural(comps.length, 'component'),
        catNodes ? plural(catNodes, 'discovered resource') : null,
        `restore layers ${[...new Set(comps.map((c) => c.restoreLayer).filter(Boolean))].sort().join(' ') || 'not set'}`),
    });

    for (const c of comps) {
      const isRoot = !!rootId && c.id === rootId;
      const myWorkloads = workloads.filter((w) => w.componentId === c.id);
      const isCluster = /cluster/i.test(c.kind || '') && !!k;
      const clusterNs = isCluster
        ? [...new Set([
          ...(k.namespaces || []).map((n) => n.name),
          ...workloads.map((w) => w.namespace || 'default'),
        ])].filter(Boolean).sort()
        : [];
      const cNodes = nodesOf(c.id);
      // The component row says how much is under the handle BEFORE you pull it:
      // resources counted across all three sources (graph edges, linked nodes,
      // resourceDetails), and how many recorded facts came with them.
      const cDetails = resourceDetailMap(c);
      const cResourceCount = new Set([
        ...(edges.get(c.id) || []).map((e) => e.node.rid),
        ...cNodes.map((n) => n.rid),
        ...cDetails.keys(),
      ]).size;
      const cFactCount = [...cDetails.values()].reduce((n, r) => n + detailFacts(r).length, 0);
      const cRow = write(2, {
        label: c.name,
        group: c.name,
        kind: c.kind || c.category || '',
        status: sm.statusOf(c),
        notes: bits(
          clusterNs.length ? `${plural(clusterNs.length, 'namespace')} · ${plural(workloads.length, 'workload')}` : null,
          !isCluster && myWorkloads.length ? plural(myWorkloads.length, 'workload') : null,
          cResourceCount ? plural(cResourceCount, 'resource') : null,
          cFactCount ? plural(cFactCount, 'recorded fact') : null,
          sm.notesOf(c),
        ),
        day0: sm.day0Of(c),
        scope: sm.scopeOf(c),
        arn: c.arn || cNodes.find((n) => n.arn)?.arn || '',
        link: c.definedIn || '',
      });
      if (isRoot) write.marker(cRow, 'THIS SERVICE — the focus of this package');

      const inherited = { day0: sm.day0Of(c), scope: sm.scopeOf(c) };
      const seen = new Set();

      // --- resources reached from the component by an edge, recursively ---
      // `descend` is decided by the PARENT edge: an attribute-like leaf (an AZ, a
      // KMS key, an IAM policy) is still shown where it belongs, but nothing
      // hangs off it, and a container edge (member-of) shows the container
      // without walking into everything else inside it.
      // `detail` is this component's resourceDetails entry for the node, when
      // there is one: its facts are what the row is FOR.
      const walk = (node, relation, level, descend = true, detail = null) => {
        if (seen.has(node.rid)) return;
        seen.add(node.rid);
        const kids = descend
          ? (edges.get(node.rid) || []).filter((e) => !seen.has(e.node.rid))
          : [];
        // Level 6 is the deepest Excel row group we use: anything below it is
        // folded into this row's notes rather than dropped.
        const atCap = level >= MAX_LEVEL;
        const folded = atCap
          ? kids.map((e) => nodeLabel(e.node)).slice(0, 3)
          : [];
        const foldNote = folded.length
          ? `holds ${folded.join(', ')}${kids.length > folded.length ? ` +${kids.length - folded.length} more` : ''}`
          : null;
        // Where enrichment described this resource, ITS FACTS ARE THE NOTES:
        // "allows egress tcp/443 to 0.0.0.0/0" is worth more than the describe
        // dump, so the kv pairs, the region and the source yield the column to
        // it. Undescribed resources keep the notes they have always had.
        const facts = detailFacts(detail);
        const lead = facts.length ? String(relation || '') : nodeNotes(node, relation);
        // At the cap nothing can hang below this row, so the facts fold into the
        // notes (and are trimmed there) instead of getting rows of their own.
        // The fold marker goes BEFORE them: trimText cuts the tail, and a reader
        // who loses "holds …" cannot tell there is anything below at all —
        // which would re-create the false leaf this sheet exists to remove.
        const split = atCap
          ? { notes: bits(lead, foldNote, ...facts), spill: [] }
          : factNotes(lead, facts);
        write(level, {
          label: nodeLabel(node),
          kind: node.type || 'resource',
          status: nodeStatus(node),
          notes: split.notes,
          day0: inherited.day0,
          scope: node.type === 'secret' && nodeStatus(node) === 'Fail' ? 'No' : inherited.scope,
          arn: node.arn || node.rid || '',
        });
        // Facts that did not fit: one row each, so a rule is never half-printed.
        for (const f of split.spill) {
          write(level + 1, {
            label: f,
            kind: 'fact',
            notes: bits(`on ${nodeLabel(node)}`,
              detail?.source ? `via ${detail.source}` : null,
              detail?.checkedAt ? `checked ${String(detail.checkedAt).slice(0, 10)}` : null),
            day0: inherited.day0,
            scope: inherited.scope,
            arn: node.arn || node.rid || '',
          });
        }
        if (atCap) {
          for (const e of kids) seen.add(e.node.rid);
          return;
        }
        for (const e of kids) {
          walk(e.node, e.relation, level + 1,
            !GRAPH_LEAF_TYPES.has(e.node.type) && !NO_DESCEND_RELATIONS.has(e.relation),
            cDetails.get(e.node.rid) || null);
        }
      };

      // --- the Kubernetes tier of a cluster component: ns → workload → … ---
      for (const ns of clusterNs) {
        const nsWorkloads = workloads.filter((w) => (w.namespace || 'default') === ns);
        const nsServices = services.filter((s) => (s.namespace || 'default') === ns);
        const nsIngresses = ingresses.filter((x) => (x.namespace || 'default') === ns);
        const owners = nsOwners(ns);
        write(3, {
          label: `Namespace ${ns}`,
          kind: 'Namespace',
          notes: bits(
            plural(nsWorkloads.length, 'workload'),
            nsServices.length ? plural(nsServices.length, 'service') : null,
            nsIngresses.length ? plural(nsIngresses.length, 'ingress') : null,
            owners.length ? `owned by ${join(owners.map((o) => o.name))}` : 'no component linked — link it in the inventory',
          ),
          day0: owners.some((o) => sm.day0Of(o) === 'Yes') ? 'Yes' : (owners.length ? 'No' : ''),
          scope: owners.length === 1 ? sm.scopeOf(owners[0]) : (owners.length ? 'Partial' : ''),
          link: owners.find((o) => o.definedIn)?.definedIn || '',
        });
        const nsDay0 = owners.some((ow) => sm.day0Of(ow) === 'Yes') ? 'Yes' : (owners.length ? 'No' : '');
        const nsScope = owners.length === 1 ? sm.scopeOf(owners[0]) : (owners.length ? 'Partial' : '');
        for (const o of [...new Set(owners.map((x) => x.definedIn).filter(Boolean))]) {
          write(4, {
            label: 'Defined in (IaC)',
            kind: 'repo',
            notes: `redeploy this namespace from ${o}`,
            day0: nsDay0,
            scope: nsScope,
            link: o,
          });
        }
        for (const w of [...nsWorkloads].sort((a, b) => String(a.kind).localeCompare(String(b.kind))
          || String(a.name).localeCompare(String(b.name)))) {
          const owner = w.componentId ? d.byId.get(w.componentId) : null;
          const des = w.replicas?.desired;
          const rdy = w.replicas?.ready;
          const ready = readyText(w);
          const wStatus = des > 0 ? (rdy >= des ? 'Pass' : rdy ? 'Partial' : 'Fail') : '';
          const wRow = write(4, {
            label: `${w.kind || 'Workload'} ${w.name}`,
            kind: w.kind || 'Workload',
            status: wStatus,
            notes: bits(
              ready ? `${ready} ready at snapshot${k.capturedAt ? ` ${String(k.capturedAt).slice(0, 10)}` : ''}` : null,
              join(w.images), w.serviceAccount ? `SA ${w.serviceAccount}` : null,
              (w.configmaps || []).length ? `configmaps ${join(w.configmaps)}` : null,
            ),
            day0: owner ? sm.day0Of(owner) : '',
            scope: owner ? sm.scopeOf(owner) : '',
            arn: ref('uid', w.uid),
            link: owner?.definedIn || '',
          });
          if (owner && rootId && owner.id === rootId) write.marker(wRow, '');
          // The secrets a workload mounts are the classic recovery failure, so
          // each one gets its own row with its real replication state.
          for (const s of w.secrets || []) {
            // The cluster mount is "adjudication-db-password"; the inventory
            // calls the same secret "adjudication/db-password". Match on the
            // squashed name so the two lists actually reconcile.
            const declared = (owner?.secrets || []).find((x) => squash(x.name) === squash(s)
              || squash(x.name).endsWith(squash(s)) || squash(s).endsWith(squash(x.name)));
            const repl = declared?.replicated || 'unknown';
            write(5, {
              label: `Secret mount ${s}`,
              kind: 'secret',
              status: REPL_STATUS[repl] || 'Unknown',
              notes: bits(`mounted by ${w.name}`,
                declared ? `replicated: ${repl}` : 'not on the component secret list — reconcile it',
                declared?.notes),
              day0: owner ? sm.day0Of(owner) : '',
              scope: repl === 'yes' ? 'Yes' : repl === 'no' ? 'No' : 'Unknown',
            });
          }
          // The load balancer this workload actually sits behind, when the
          // graph has one: workload → Service → Ingress → LB.
          const fronting = nsServices.filter((s) => svcTargetsOf(s).some((t) => t.uid === w.uid));
          const frontIngress = nsIngresses.filter((x) => (x.backends || [])
            .some((b) => fronting.some((s) => s.name === (b?.service || b?.name || b))));
          const lb = matchLb([w.componentId], [...fronting.map((s) => s.name), ...frontIngress.map((x) => x.name)],
            frontIngress.flatMap((x) => x.hosts || []));
          if (lb) {
            write(5, {
              label: nodeLabel(lb),
              kind: lb.type,
              notes: bits('load balancer in front of this workload', kvText(lb.details, ': ', 80)),
              day0: owner ? sm.day0Of(owner) : '',
              scope: owner ? sm.scopeOf(owner) : '',
              arn: lb.arn || lb.rid,
            });
            seen.add(lb.rid);
            for (const e of edges.get(lb.rid) || []) {
              if (NO_DESCEND_RELATIONS.has(e.relation)) continue;
              seen.add(e.node.rid);
              write(6, {
                label: nodeLabel(e.node),
                kind: e.node.type,
                notes: nodeNotes(e.node, e.relation),
                day0: owner ? sm.day0Of(owner) : '',
                scope: owner ? sm.scopeOf(owner) : '',
                arn: e.node.arn || e.node.rid,
              });
            }
          }
        }
        for (const s of nsServices) {
          const targets = svcTargetsOf(s);
          write(4, {
            label: `Service ${s.name}`,
            kind: 'Service',
            notes: bits(s.type, fmtPorts(s.ports) ? `ports ${fmtPorts(s.ports)}` : null,
              targets.length ? `targets ${join(targets.map((t) => t.name))}` : 'no target workload in the snapshot'),
            day0: owners.some((o) => sm.day0Of(o) === 'Yes') ? 'Yes' : '',
            scope: owners.length === 1 ? sm.scopeOf(owners[0]) : '',
          });
        }
        for (const x of nsIngresses) {
          const backendNames = (x.backends || []).map((b) => (b && typeof b === 'object' ? (b.service || b.name) : b));
          const backendCids = [...new Set(nsServices.filter((s) => backendNames.includes(s.name))
            .flatMap((s) => svcTargetsOf(s).map((t) => t.componentId)).filter(Boolean))];
          const lb = matchLb(backendCids, [x.name], x.hosts || []);
          write(4, {
            label: `Ingress ${x.name}`,
            kind: 'Ingress',
            notes: bits(x.class ? `class ${x.class}` : null,
              (x.hosts || []).length ? join(x.hosts) : null,
              fmtBackends(x.backends) ? `→ ${fmtBackends(x.backends)}` : null,
              lb ? 'expand for the load balancer it created' : 'no load balancer matched in the resource graph — run discovery'),
            day0: owners.some((o) => sm.day0Of(o) === 'Yes') ? 'Yes' : '',
            scope: owners.length === 1 ? sm.scopeOf(owners[0]) : '',
          });
          if (lb && !seen.has(lb.rid)) walk(lb, 'created by this Ingress', 5);
        }
      }

      // --- the AWS tier: THIS COMPONENT'S OWN RESOURCES, grouped by type -----
      //
      // One handle per bucket — Security groups, Network interfaces, Listeners,
      // Target groups, Subnets & AZs, IAM, Encryption, DNS — then the resources
      // in it, then whatever hangs off each of those. A component is never a
      // leaf while it has something attached, and a component with nothing
      // attached SAYS so rather than sitting there silently closed.
      const { attachments } = componentAttachments(c, {
        edges: edges.get(c.id) || [],
        cNodes,
        relationFor: (n) => (g ? g.relationFor(n, c.id) : '') || 'linked to this component',
        skip: seen,
      });
      let rendered = 0;
      for (const grp of groupAttachments(attachments)) {
        // A resource an earlier group already nested (the VPC's route table,
        // say) is not repeated here — and a group left with nothing to show
        // does not get a header row, because a group row with no handle under
        // it is the same lie as a component row with no handle under it.
        const pending = grp.items.filter((a) => !seen.has(a.node.rid));
        if (!pending.length) continue;
        const facts = pending.reduce((n, a) => n + detailFacts(a.detail).length, 0);
        write(3, {
          label: grp.label,
          kind: 'resources',
          // The "nothing recorded" note only fires where enrichment HAS
          // described this component and left this bucket blank. A workspace
          // that has never been enriched says so once, on the workspace row.
          notes: bits(plural(pending.length, 'resource'),
            groupFactNote({ facts }, cDetails.size)),
          day0: inherited.day0,
          scope: inherited.scope,
        });
        rendered += 1;
        for (const a of pending) {
          walk(a.node, a.relation, 4,
            !GRAPH_LEAF_TYPES.has(a.node.type) && !NO_DESCEND_RELATIONS.has(a.relation),
            a.detail);
        }
      }
      // Nothing under this component ANYWHERE — not a bucket that happened to
      // be empty, and not a cluster whose resources were all shown above.
      if (!rendered && !cResourceCount) {
        write(3, {
          label: 'No resources discovered',
          kind: 'resources',
          status: 'Unknown',
          notes: 'no resources discovered — run Discover → map dependencies to attach this '
            + "component's security groups, network interfaces, listeners and the rest",
          day0: inherited.day0,
          scope: inherited.scope,
        });
      }
    }
  }

  // ------------------------------------------ resources nobody has claimed --
  if (g?.unlinked.length) {
    write(1, {
      label: 'UNLINKED DISCOVERED RESOURCES',
      kind: 'Category',
      notes: `${plural(g.unlinked.length, 'resource')} not linked to any component — claim them or delete them`,
    });
    for (const n of g.unlinked) {
      write(2, {
        label: nodeLabel(n),
        group: 'unlinked',
        kind: n.type || 'resource',
        notes: nodeNotes(n, g.relationFor(n, null)),
        scope: 'Unknown',
        arn: n.arn || n.rid,
      });
    }
  }
  return finishTree(ws);
}

// -------------------------------------------------------------- Runtime -----
//
// The business path: per service, who calls it, what it calls, where it lives
// and where it is defined. Inbound comes from other components' outbound calls
// pointing at it, from declared dependencies, and from the cluster's Ingresses;
// outbound from its own outboundCalls, verbed by what the target actually is.

const STOPWORDS = new Set(['aws', 'the', 'service', 'services', 'cluster', 'recovery',
  'account', 'prod', 'dev', 'stream', 'streams', 'queue', 'queues', 'partner']);
const textTokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/)
  .filter((t) => t.length > 3 && !STOPWORDS.has(t));
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Best component for a free-text call target ("Aurora adjudication DB"), or
// null when nothing matches well enough to claim a link.
function matchComponentByText(d, text) {
  const t = squash(text);
  if (!t) return null;
  const tokens = new Set(textTokens(text));
  let best = null;
  let bestScore = 0;
  for (const c of d.components) {
    const n = squash(c.name);
    let score = 0;
    if (n && (t.includes(n) || n.includes(t))) score += 3;
    for (const tok of textTokens(c.name)) if (tokens.has(tok)) score += 1;
    for (const s of c.awsServices || []) if (tokens.has(String(s).toLowerCase())) score += 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 2 ? best : null;
}

const CALL_OBSERVED = (o) => {
  const v = [o.observedCount, o.observed, o.flowCount, o.flows, o.count]
    .find((x) => typeof x === 'number' && Number.isFinite(x));
  return v ?? null;
};

// Calls → / Writes → / Publishes → / Feeds →, from what the target IS.
function callVerb(o, target) {
  const proto = String(o.protocol || '').toLowerCase();
  const cat = target?.category || '';
  const text = `${o.target || ''} ${o.purpose || ''}`.toLowerCase();
  if (/postgres|mysql|jdbc|redis|mongo|sql|dynamo/.test(proto) || cat === 'database') return 'Writes →';
  if (cat === 'messaging-streaming' || /\bsqs\b|\bsns\b|kinesis|topic|queue|stream/.test(text)) return 'Publishes →';
  if (cat === 'storage' || /sftp|s3 |bucket|file exchange|era file/.test(`${proto} ${text}`)) return 'Feeds →';
  return 'Calls →';
}
const callKind = (verb, o) => (verb === 'Calls →'
  ? (String(o.protocol || '').toLowerCase() === 'sftp' ? 'async outbound' : 'sync outbound')
  : verb === 'Writes →' ? 'sync' : 'async');

function addRuntime(wb, d, sm) {
  const k = hasK8s(d) ? d.k8s : null;
  const workloads = k?.workloads || [];
  const myWorkloads = (c) => workloads.filter((w) => w.componentId === c.id);

  // A runtime service is something that RUNS or TALKS: it has workloads in the
  // cluster, it makes outbound calls, or it is on the edge path. Data stores and
  // platform primitives are not services here — they show up as the targets of
  // the calls, which is the question this sheet answers. (Without that rule the
  // sheet degenerates into a second copy of Dependencies.)
  const isService = (c) => myWorkloads(c).length > 0
    || (c.outboundCalls || []).length > 0
    || c.category === 'edge-dns';
  const candidates = d.components.filter(isService);
  if (!candidates.length) return null;
  const serviceIds = new Set(candidates.map((c) => c.id));

  // Who calls it: a recorded outbound call pointing at it, then any runtime
  // service that declares it as a dependency.
  const inboundOf = (c) => {
    const rows = [];
    for (const other of d.components) {
      if (other.id === c.id) continue;
      for (const o of other.outboundCalls || []) {
        if (matchComponentByText(d, o.target)?.id === c.id) rows.push({ from: other, call: o });
      }
    }
    for (const id of d.usedByIds.get(c.id) || []) {
      if (!serviceIds.has(id) || rows.some((r) => r.from.id === id)) continue;
      const other = d.byId.get(id);
      if (other) rows.push({ from: other, call: null });
    }
    return rows;
  };

  const rootName = (d.scope?.rootId && d.byId.get(d.scope.rootId)?.name) || d.scope?.rootName || '';
  const ws = treeSheet(wb, SHEETS.runtime,
    rootName
      ? `Runtime — how ${rootName} is called and what it calls: expand a service for callers, calls, secrets and load balancers`
      : 'Runtime — expand a service to see who calls it, what it calls, and what it needs to start',
    {
      note: 'One block per service: its namespace and IaC location, who calls it (inbound), and what it calls '
        + '(Calls → sync request, Writes → a data store, Publishes → a queue or topic, Feeds → a file or batch '
        + 'hand-off). A sync call takes the path down with it; an async one can lag. Status notes carry the '
        + 'purpose, the failover behaviour and, where a network-flow import supplied one, the observed count.',
    });
  const write = treeWriter(ws);

  const critical = (sm.latest?.appTests || []).filter((a) => a.critical).map((a) => a.name);
  write(0, {
    label: 'Runtime path — what has to talk before you can call it recovered',
    kind: 'runtime',
    notes: bits(
      plural(candidates.length, 'service'),
      plural(d.components.reduce((n, c) => n + (c.outboundCalls || []).length, 0), 'outbound call'),
      critical.length ? `success bar: ${join(critical.slice(0, 2), '; ')}` : 'no critical app check recorded yet',
    ),
  });

  const order = [...candidates].sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9)
    || layerOrder(a.restoreLayer) - layerOrder(b.restoreLayer) || a.name.localeCompare(b.name));

  for (const c of order) {
    const isRoot = !!d.scope?.rootId && c.id === d.scope.rootId;
    const wls = myWorkloads(c);
    const namespaces = [...new Set(wls.map((w) => w.namespace || 'default'))];
    const inbound = inboundOf(c);
    const calls = c.outboundCalls || [];
    const sRow = write(1, {
      label: c.name,
      kind: c.kind || 'service',
      status: sm.statusOf(c),
      notes: bits(sm.notesOf(c),
        `${inbound.length} inbound · ${calls.length} outbound`,
        namespaces.length ? `ns ${join(namespaces)}` : null),
      day0: sm.day0Of(c),
      scope: sm.scopeOf(c),
      arn: c.arn || '',
      link: c.definedIn || '',
    });
    if (isRoot) write.marker(sRow, 'THIS SERVICE — the focus of this package');

    const day0 = sm.day0Of(c);
    const scope = sm.scopeOf(c);

    // ---- where it runs, and where it is defined ----
    for (const ns of namespaces) {
      const nsWl = wls.filter((w) => (w.namespace || 'default') === ns);
      write(2, {
        label: `Namespace ${ns}`,
        kind: 'Namespace',
        status: !nsWl.length ? ''
          : nsWl.every((w) => (w.replicas?.desired ?? 0) > 0 && w.replicas.ready >= w.replicas.desired)
            ? 'Pass' : nsWl.some((w) => (w.replicas?.ready ?? 0) === 0) ? 'Fail' : 'Partial',
        notes: bits(plural(nsWl.length, 'workload'),
          join(nsWl.map((w) => `${w.name} ${readyText(w)}`)),
          k?.capturedAt ? `snapshot ${String(k.capturedAt).slice(0, 10)}` : null),
        day0,
        scope,
        link: c.definedIn || '',
      });
    }
    if (c.definedIn) {
      write(2, {
        label: 'Defined in (IaC / GitHub)',
        kind: 'repo',
        notes: `redeploy or diff this service from ${c.definedIn}`,
        day0,
        scope,
        link: c.definedIn,
      });
    }

    // ---- who calls it ----
    for (const { from, call } of inbound) {
      write(2, {
        label: `Called by ${from.name}`,
        kind: call ? (String(call.protocol || '').toLowerCase() === 'sftp' ? 'async inbound' : 'sync inbound') : 'inbound (declared)',
        status: sm.statusOf(from),
        notes: bits(call?.purpose, call?.failoverBehavior,
          call ? null : 'declared dependency in the inventory',
          call?.critical ? 'CRITICAL call' : null,
          CALL_OBSERVED(call || {}) != null ? `observed ${CALL_OBSERVED(call).toLocaleString('en-US')} flows` : null),
        day0: sm.day0Of(from),
        scope: sm.scopeOf(from),
        link: from.definedIn || '',
      });
    }
    // Ingresses in the cluster that reach this service's workloads.
    for (const x of k?.ingresses || []) {
      const backendNames = (x.backends || []).map((b) => (b && typeof b === 'object' ? (b.service || b.name) : b));
      const svcs = (k.services || []).filter((s) => backendNames.includes(s.name)
        && (s.namespace || 'default') === (x.namespace || 'default'));
      const reaches = svcs.some((s) => (s.targets || []).some((uid) => wls.some((w) => w.uid === uid)));
      if (!reaches) continue;
      write(2, {
        label: `Called by Ingress ${x.name}`,
        kind: 'sync inbound',
        notes: bits(x.class ? `class ${x.class}` : null, join(x.hosts), `→ ${fmtBackends(x.backends)}`),
        day0,
        scope,
      });
    }

    // ---- what it calls ----
    for (const o of calls) {
      const target = matchComponentByText(d, o.target);
      const verb = callVerb(o, target);
      write(2, {
        label: `${verb} ${o.target || '(unnamed target)'}`,
        kind: callKind(verb, o),
        status: target ? sm.statusOf(target) : (o.critical ? 'Unknown' : ''),
        notes: bits(o.purpose, o.failoverBehavior,
          o.critical ? 'CRITICAL on the recovery path' : null,
          o.type, o.protocol,
          CALL_OBSERVED(o) != null ? `observed ${CALL_OBSERVED(o).toLocaleString('en-US')} flows` : null,
          o.source === 'network-flows' ? 'from a network-flow import' : null,
          target?.restoreLayer ? `${target.restoreLayer} ${target.category || ''}`.trim() : null,
        target ? null : 'no inventory component matches this target'),
        day0: target ? sm.day0Of(target) : day0,
        scope: target ? sm.scopeOf(target) : 'Unknown',
        arn: target?.arn || '',
        link: target?.definedIn || '',
      });
    }

    // ---- what it needs at startup ----
    if ((c.secrets || []).length) {
      const unknown = c.secrets.filter((s) => (s.replicated || 'unknown') !== 'yes').length;
      write(2, {
        label: 'Needs secrets at startup',
        kind: 'config',
        status: unknown ? (c.secrets.some((s) => s.replicated === 'no') ? 'Fail' : 'Unknown') : 'Pass',
        notes: bits(plural(c.secrets.length, 'secret'),
          unknown ? `${unknown} not confirmed replicated — this is how recovery tests die` : 'all confirmed replicated'),
        day0,
        scope,
      });
      for (const s of c.secrets) {
        const repl = s.replicated || 'unknown';
        write(3, {
          label: s.name || '(unnamed secret)',
          kind: 'secret',
          status: REPL_STATUS[repl] || 'Unknown',
          notes: bits(`replicated: ${repl}`, s.notes),
          day0,
          scope: repl === 'yes' ? 'Yes' : repl === 'no' ? 'No' : 'Unknown',
          arn: s.arn || '',
        });
      }
    }
    // ---- how you know it came back ----
    if (c.verification?.command || c.verification?.pass) {
      write(2, {
        label: 'Success check',
        kind: 'verification',
        notes: bits(c.verification.command, c.verification.pass ? `pass when: ${c.verification.pass}` : null),
        day0,
        scope,
      });
    }
  }
  return finishTree(ws);
}

// ------------------------------------- Dependencies — the recovery order ----
//
// The same grid, spined on the RESTORE LAYER so the sheet reads top to bottom
// as the order things have to come back in: L0 first, then what builds on it.

function addDependencies(wb, d, sm) {
  if (!d.components.length) return null;
  const rootId = d.scope?.rootId || '';
  const rootName = (rootId && d.byId.get(rootId)?.name) || d.scope?.rootName || '';
  const ws = treeSheet(wb, SHEETS.deps,
    rootName
      ? `Dependencies — what ${rootName} needs to come back, in restore order (L0 first)`
      : 'Dependencies — what each service needs to come back, in restore order (L0 first)',
    {
      note: 'Restore layer → component → what it needs, what needs it, and the gaps filed against it. '
        + 'Everything in a lower layer must be up before the layer below it. Expand a component to see its '
        + 'dependency links with THEIR own layer and recovery posture — that is what tells you whether they '
        + 'will be there when you need them.',
      print: { orientation: 'landscape' },
    });
  const write = treeWriter(ws);

  const layers = new Map();
  for (const c of d.components) {
    const key = c.restoreLayer || '';
    if (!layers.has(key)) layers.set(key, []);
    layers.get(key).push(c);
  }
  const layerKeys = [...layers.keys()].sort((a, b) => layerOrder(a) - layerOrder(b));
  const catRank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c.category || 'other');
    return i === -1 ? CATEGORY_ORDER.length : i;
  };

  write(0, {
    label: rootName
      ? `${rootName} — recovery order for this package`
      : `${d.meta.name || d.meta.slug} — recovery order`,
    kind: 'recovery order',
    notes: bits(plural(d.components.length, 'component'),
      `${layerKeys.length} restore layers`,
      'work down the sheet: a layer cannot start until the one above it is green'),
  });

  for (const layer of layerKeys) {
    const comps = layers.get(layer).sort((a, b) => catRank(a) - catRank(b)
      || (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name));
    const inScope = comps.filter((c) => c.inRecoveryScope === 'yes').length;
    write(1, {
      label: layer ? (LAYER_LABELS[layer] || layer) : 'RESTORE LAYER NOT SET — position in the recovery order undefined',
      kind: layer || 'unset',
      notes: bits(plural(comps.length, 'component'),
        `${inScope}/${comps.length} fully in recovery scope`,
        join([...new Set(comps.map((c) => c.category).filter(Boolean))])),
    });
    for (const c of comps) {
      const deps = (c.dependsOn || []).map((id) => d.byId.get(id)).filter(Boolean);
      const users = (d.usedByIds.get(c.id) || []).map((id) => d.byId.get(id)).filter(Boolean);
      const gaps = sm.openGaps(c.id);
      const isRoot = !!rootId && c.id === rootId;
      const row = write(2, {
        label: c.name,
        group: c.name,
        kind: c.kind || c.category || '',
        status: sm.statusOf(c),
        notes: bits(
          // The tier used to live in the ARN column, where the header called it
          // an ARN. It is a property of the component, so it belongs here with
          // the component's other properties.
          c.tier != null ? `Tier ${c.tier}` : null,
          `needs ${deps.length} · needed by ${users.length}`,
          // "inherit" is the common case and reads like nothing on its own.
          String(c.drStrategy || '').toLowerCase() === 'inherit'
            ? `inherits the workspace strategy (${strategyName(d.meta.strategy) || 'not set'})`
            : strategyName(c.drStrategy) || null,
          c.replication?.mechanism || null,
          isNum(c.replication?.rpoMinutes) ? `RPO ${c.replication.rpoMinutes} min` : null,
          ownerTeam(c) || null),
        day0: sm.day0Of(c),
        scope: sm.scopeOf(c),
        // The actual ARN, when discovery gave us one.
        arn: c.arn || '',
        link: c.definedIn || '',
      });
      if (isRoot) write.marker(row, 'THIS SERVICE — the focus of this package');
      const linkRow = (dep, relation) => write(3, {
        label: `${relation} ${dep.name}`,
        kind: dep.restoreLayer || dep.category || '',
        status: sm.statusOf(dep),
        notes: bits(`${dep.restoreLayer || 'layer not set'}${dep.tier != null ? ` · Tier ${dep.tier}` : ''}`,
          `scope ${dep.inRecoveryScope || 'unknown'}`,
          dep.replication?.mechanism, ownerTeam(dep)),
        day0: sm.day0Of(dep),
        scope: sm.scopeOf(dep),
        arn: dep.arn || '',
        link: dep.definedIn || '',
      });
      for (const dep of deps.sort((a, b) => layerOrder(a.restoreLayer) - layerOrder(b.restoreLayer))) {
        linkRow(dep, 'Needs →');
      }
      for (const u of users.sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9))) linkRow(u, 'Needed by ←');
      for (const g of gaps) {
        write(3, {
          label: g.title || '(untitled gap)',
          kind: g.class || 'gap',
          status: g.severity === 'blocker' ? 'Blocked' : g.status === 'accepted' ? 'Accepted' : 'Fail',
          notes: bits(`severity ${g.severity || 'unknown'}`, `status ${g.status || 'open'}`, g.notes),
          day0: sm.day0Of(c),
          scope: sm.scopeOf(c),
          arn: ref('ticket', g.ticket),
        });
      }
      for (const t of c.gaps || []) {
        write(3, {
          label: t, kind: 'gap note', status: 'Unknown', notes: 'noted on the component in the inventory',
          day0: sm.day0Of(c), scope: sm.scopeOf(c),
        });
      }
      // Same rule as the Resource Graph: a row with no handle must MEAN
      // "nothing here", never "nobody filled this in". A component with no
      // links either way and no gaps says which of the two it is.
      if (!deps.length && !users.length && !gaps.length && !(c.gaps || []).length) {
        write(3, {
          label: 'Nothing recorded',
          kind: 'no links',
          status: 'Unknown',
          notes: 'declares no dependencies and nothing declares one on it — either it truly '
            + 'stands alone, or the inventory is incomplete; confirm before the next test',
          day0: sm.day0Of(c),
          scope: sm.scopeOf(c),
        });
      }
    }
  }
  return finishTree(ws);
}

// ------------------------------------------------- Resource Graph (outlined)

// Node type -> display group, ordered networking → identity → data → other.
const GRAPH_GROUPS = [
  { label: 'Security groups', types: ['security-group'] },
  { label: 'Subnets & AZs', types: ['subnet', 'availability-zone'] },
  { label: 'Target groups & listeners', types: ['target-group', 'listener', 'load-balancer'] },
  { label: 'Networking', types: ['vpc', 'vpc-endpoint', 'route-table', 'nat-gateway', 'internet-gateway', 'network-acl', 'elastic-ip', 'network-interface'] },
  { label: 'IAM', types: ['iam-role', 'iam-policy', 'iam-instance-profile', 'oidc-provider'] },
  { label: 'Encryption', types: ['kms-key', 'certificate'] },
  { label: 'Data & config', types: ['db-subnet-group', 'parameter-group', 'option-group', 'snapshot', 'backup-vault'] },
  { label: 'Logs & monitoring', types: ['log-group', 'alarm'] },
];
const graphGroupIndex = (type) => {
  const i = GRAPH_GROUPS.findIndex((g) => g.types.includes(type));
  return i === -1 ? GRAPH_GROUPS.length : i;
};
const graphGroupLabel = (type) => {
  const i = graphGroupIndex(type);
  if (i < GRAPH_GROUPS.length) return GRAPH_GROUPS[i].label;
  const words = String(type || 'resource').replace(/-/g, ' ');
  if (/s$/.test(words)) return cap(words);
  // repository → repositories, policy → policies (not "Repositorys")
  if (/[^aeiou]y$/.test(words)) return cap(`${words.slice(0, -1)}ies`);
  if (/(ch|sh|x|z|ss)$/.test(words)) return cap(`${words}es`);
  return cap(`${words}s`);
};

// Group a component's nodes into ordered type groups; stable sort inside each.
function groupGraphNodes(nodes) {
  const m = new Map();
  for (const n of nodes) {
    const label = graphGroupLabel(n.type);
    if (!m.has(label)) m.set(label, { order: graphGroupIndex(n.type), label, nodes: [] });
    m.get(label).nodes.push(n);
  }
  const groups = [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const g of groups) {
    g.nodes.sort((a, b) => (a.type || '').localeCompare(b.type || '')
      || (a.name || a.rid || '').localeCompare(b.name || b.rid || ''));
  }
  return groups;
}

const fmtVal = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(fmtVal).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

// Compact "k: v · k: v" (details) / "k=v · k=v" (tags), capped at ~140 chars.
function kvText(obj, eq, max = 140) {
  if (!obj || typeof obj !== 'object') return '';
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    const part = `${k}${eq}${fmtVal(v)}`;
    const next = out ? `${out} · ${part}` : part;
    if (next.length > max) return out ? `${out} · …` : `${part.slice(0, max - 1)}…`;
    out = next;
  }
  return out;
}

function graphModel(d) {
  const nodes = Object.values(d.resourceGraph?.nodes || {});
  if (!nodes.length) return null;
  const byComponent = new Map();
  const unlinked = [];
  for (const n of nodes) {
    const cids = (n.componentIds || []).filter((id) => d.byId.has(id));
    if (!cids.length) { unlinked.push(n); continue; }
    for (const cid of cids) {
      if (!byComponent.has(cid)) byComponent.set(cid, []);
      byComponent.get(cid).push(n);
    }
  }
  const byEnd = new Map();
  for (const e of d.resourceGraph?.edges || []) {
    for (const end of [e.from, e.to]) {
      if (!end) continue;
      if (!byEnd.has(end)) byEnd.set(end, []);
      byEnd.get(end).push(e);
    }
  }
  // Relation shown per row: the edge tying the node to this component when one
  // exists, otherwise the node's distinct edge relations.
  const relationFor = (n, cid) => {
    const es = byEnd.get(n.rid) || [];
    const direct = cid ? es.find((e) => e.from === cid || e.to === cid) : null;
    if (direct?.relation) return direct.relation;
    return [...new Set(es.map((e) => e.relation).filter(Boolean))].slice(0, 3).join(' · ');
  };
  const catRank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c.category || 'other');
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  const components = [...d.components].sort((a, b) =>
    catRank(a) - catRank(b) || (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name));
  return { byComponent, unlinked, relationFor, components };
}

const graphRowValues = (d, g, n, cid) => [
  cid ? d.nameOf(cid) : '', n.type || '', n.name || '', n.arn || n.rid || '',
  g.relationFor(n, cid), n.region || '',
  kvText(n.details, ': '), kvText(n.tags, '='), n.source || '',
];

// Flat rows backing the resource-graph CSV.
function flatGraphRows(d) {
  const g = graphModel(d);
  if (!g) return [];
  const rows = [];
  for (const c of g.components) {
    const nodes = g.byComponent.get(c.id);
    if (!nodes) continue;
    for (const grp of groupGraphNodes(nodes)) {
      for (const n of grp.nodes) rows.push(graphRowValues(d, g, n, c.id));
    }
  }
  for (const grp of groupGraphNodes(g.unlinked)) {
    for (const n of grp.nodes) rows.push(graphRowValues(d, g, n, null));
  }
  return rows;
}

// The Resource Graph once had its own sheet. It duplicated the Dependencies
// tree row for row — same nodes, same type groups, same ARN/relation/region/
// details — so it was folded in: linked resources hang off their component
// there, unlinked ones sit in a block at the end. The flat dataset survives as
// the `resource-graph` CSV (flatGraphRows above), which is a contract.

// ---------------------------------------------------- K8s snapshot sheets

const readyText = (w) => {
  const des = w.replicas?.desired;
  const rdy = w.replicas?.ready;
  return des == null && rdy == null ? '' : `${rdy ?? 0}/${des ?? 0}`;
};

const hasK8s = (d) => !!(d.k8s && (d.k8s.capturedAt || (d.k8s.workloads || []).length));

const fmtPorts = (ports) => join((ports || []).map((p) => {
  if (p === null || p === undefined) return '';
  if (typeof p !== 'object') return String(p);
  const base = p.port ?? p.name ?? '';
  const tgt = p.targetPort != null && p.targetPort !== p.port ? `→${p.targetPort}` : '';
  const proto = p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : '';
  return `${base}${tgt}${proto}`;
}), ' · ');

const fmtBackends = (backends) => join((backends || []).map((b) => {
  if (b === null || b === undefined) return '';
  if (typeof b !== 'object') return String(b);
  const svc = b.service || b.name || '';
  return b.port != null ? `${svc}:${b.port}` : svc || JSON.stringify(b);
}), ' · ');

// ----------------------------------- Runbooks — the procedure and its steps
//
// The index and the steps live on ONE sheet: a runbook's header row carries its
// tooling, scenario, audience and totals, then its preconditions, steps and
// rollback hang off it. This sheet keeps its own wider grid on purpose — a step
// needs its command, its check and its pass criterion in their own columns,
// because people work down it with a terminal open.

function addRunbooks(wb, d) {
  if (!d.runbooks.length) return null;
  const columns = [
    { header: '#', width: 6, align: 'center' },
    { header: 'Layer', width: 7, align: 'center' },
    { header: 'Step', width: 32, wrap: true },
    { header: 'Detail', width: 46, wrap: true },
    { header: 'Command', width: 40, wrap: true },
    { header: 'Verify', width: 30, wrap: true },
    { header: 'Pass when', width: 28, wrap: true },
    { header: 'Owner', width: 13 },
    { header: 'Est (min)', width: 10, align: 'right', numFmt: '0' },
    { header: 'Gate', width: 8, align: 'center', list: LIST_YESNO },
    { header: 'Status', width: 13, align: 'center', list: LIST_STATUS },
    { header: 'Record', width: 24, wrap: true },
  ];
  const ws = addSheet(wb, SHEETS.runbooks,
    'Runbooks — the procedures that exist; work one top to bottom during an exercise, and a GATE step must pass before you continue',
    columns, {
      outline: true,
      freezeCols: 1,
      print: { orientation: 'landscape' },
      note: 'One collapsible block per runbook: what it covers, its preconditions, its steps, then its rollback. '
        + 'Gate = Yes means do not proceed until the verify passes. A step marked *** BLOCKED — DO NOT RUN *** moves '
        + 'live traffic with no verification gate passed above it. Status is yours to work during the exercise.',
    });

  // The gate, rendered IN the step column and not only in a colour: this sheet
  // gets printed in greyscale for a bridge call, and an operator working down
  // it must not be able to reach a traffic cutover without reading why it is
  // unsafe. `flag` comes from gateFacts (web/js/cutover.js) — the same audit the
  // editor, the .md and the quick-reference .txt use.
  const row = (s, n, level, stripe, flag = '') => {
    const r = dataRow(ws, columns, [
      n, s.layer || '', flag ? `${flag} ${s.title || ''}`.trim() : (s.title || ''),
      s.detail || '', s.command || '',
      s.verify || '', s.pass || '', s.owner || '', num(s.estMinutes),
      yn(!!s.gate), flag.startsWith('***') ? 'Blocked' : NOT_STARTED, s.record || '',
    ], { level, stripe });
    if (flag) {
      r.getCell(3).font = ARIAL({ bold: true, color: { argb: TINT[flag.startsWith('***') ? 'err' : 'warn'].font } });
    }
    return r;
  };

  // One gate row per check, on the same grid as the steps: the operator works
  // down them exactly as they work down the procedure, with the pass criterion
  // in the Pass-when column and their own Status cell to fill in.
  const checkRows = (tests, level) => tests.forEach((t, i) => {
    const blocking = onFailOf(t) === 'block';
    dataRow(ws, columns, [
      '', '', blocking ? 'BLOCKING check' : 'advisory check',
      join([t.name || '(unnamed check)', t.proves ? `proves: ${t.proves}` : ''], ' — '),
      t.command || '', '', t.expected || 'NO pass criterion — nobody can fail this at 3am',
      t.owner || 'unassigned', '', blocking ? 'Yes' : 'No', NOT_STARTED, t.evidence || '',
    ], { level, stripe: i % 2 === 1 });
  });

  for (const rb of d.runbooks) {
    const steps = arr(rb.steps);
    const rollback = arr(rb.rollback);
    const gate = gateFacts(rb);
    const est = steps.reduce((n, s) => n + (s.estMinutes || 0), 0);
    const gates = steps.filter((s) => s.gate).length;
    const parts = [plural(steps.length, 'step')];
    if (est) parts.push(`~${est} min est`);
    if (gates) parts.push(`${gates} gate${gates === 1 ? '' : 's'}`);
    if (rollback.length) parts.push(plural(rollback.length, 'rollback step'));
    if (gate?.headline) parts.push(gate.headline);
    groupRow(ws, columns,
      `${rb.name}${rb.scopeGeneric ? ' (generic — package context)' : ''} — ${parts.join(' · ')}`,
      { size: 11, merge: false });
    const context = [toolingLabel(rb.tooling), rb.scenario, rb.audience,
      join(arr(rb.linkedTestIds).map(d.testNameOf))].filter(Boolean).join(' · ');
    if (context) {
      dataRow(ws, columns, ['', '', 'Covers', context, '', '', '', '', '', '', '', ''], { level: 1 });
    }
    // The .md and the quick-reference .txt both open with this block. The
    // workbook is the copy that gets printed and handed to an auditor, so it
    // cannot be the one that stays quiet about it.
    if (gate && gate.findings.length) {
      groupRow(ws, columns,
        gate.hasErr
          ? `BEFORE YOU RUN THIS — the cutover gate did not audit clean (${plural(gate.findings.length, 'finding')}). `
            + 'Each one is a way this plan can move traffic to something nobody proved.'
          : `BEFORE YOU RUN THIS — ${plural(gate.findings.length, 'note')} on the cutover gate.`,
        { level: 1, merge: false, fill: null });
      gate.findings.forEach((f, i) => {
        const r = dataRow(ws, columns, ['', '',
          f.severity === 'err' ? 'DO NOT RUN' : f.severity === 'warn' ? 'Warning' : 'Note',
          String(f.text).replace(/\r?\n/g, ' '), '', '', '', '', '', '', '', ''],
        { level: 2, stripe: i % 2 === 1 });
        r.getCell(3).font = ARIAL({ bold: true, color: { argb: TINT[f.severity === 'err' ? 'err' : 'warn'].font } });
      });
    }
    arr(rb.preconditions).forEach((p, i) => dataRow(ws, columns,
      ['', '', i === 0 ? 'Preconditions' : '', p, '', '', '', '', '', '', NOT_STARTED, ''],
      { level: 1, stripe: i % 2 === 1 }));
    steps.forEach((s, i) => {
      row(s, i + 1, 1, i % 2 === 1, gate ? gate.flagAt(i) : '');
      if (!gate) return;
      // A populated gate lists its checks — `step.tests` was never read by this
      // sheet, so a gate somebody filled in rendered blank, exactly where the
      // blocking checks should be.
      const checks = gate.checksAt(i);
      if (checks.length) checkRows(checks, 2);
      // Why this step is flagged, in the library's own words, under the step.
      for (const f of gate.findingsAt.get(i) || []) {
        dataRow(ws, columns, ['', '',
          f.severity === 'err' ? 'WHY IT IS BLOCKED' : 'Gate warning',
          String(f.text).replace(/\r?\n/g, ' '), '', '', '', '', '', '', '', ''], { level: 2 });
      }
    });
    if (rollback.length) {
      groupRow(ws, columns, `ROLLBACK — ${plural(rollback.length, 'step')}`, { level: 1, merge: false });
      rollback.forEach((s, i) => row(s, `R${i + 1}`, 2, i % 2 === 1));
    }
  }
  addCF(ws, 10, 3, ws.rowCount, [['Yes', 'warn']]);
  addCF(ws, 11, 3, ws.rowCount, CF_STATUS);
  filterAll(ws, columns.length);
  return ws;
}

// --------------------------------------- Tests — what has actually been proven
//
// One block per test on the shared grid: the snapshot (dates, runbook, measured
// RTA/RPA, clean run), the app checks with their real results, the findings, and
// the written record. Targets and measurements are never mixed: a measurement
// that does not exist reads "unmeasured".

function addTests(wb, d) {
  if (!d.tests.length) return null;
  // The objective this package is judged against — the scoped service's, the
  // scoped environment's, or the workspace's (resolveObjectives). Reading
  // `meta.objectives` here printed "RTO target 30 min · approved" on a LAB
  // package, and marked a drill OVER a target the lab was never given.
  const o = resolveObjectives(d);
  const ws = treeSheet(wb, SHEETS.tests,
    'Tests — what each recovery test actually measured: expand a test for its checks, findings and record',
    {
      note: 'RTA/RPA on this sheet are MEASUREMENTS, not targets — a blank means the test did not measure it. '
        + 'Expand a test for the app checks (the business success bar), the findings it produced, and the '
        + 'written record. Copy the newest block as the form for your next test.',
    });
  const write = treeWriter(ws);

  const rank = (t) => (t.status === 'passed' || t.status === 'failed' ? 0
    : t.status === 'in-progress' ? 1 : t.status === 'planned' ? 2 : 3);
  const tests = [...d.tests].sort((a, b) => rank(a) - rank(b)
    || String(b.date || '').localeCompare(String(a.date || '')));
  // Only a PASSED run measured anything. A failed run with numbers gets named
  // separately, so the header never reads "last measured" off it.
  const measured = tests.find((t) => t.status === 'passed'
    && (isNum(t.results?.rtaMinutes) || isNum(t.results?.rpaMinutes)));
  const unproven = measured ? null
    : tests.find((t) => isNum(t.results?.rtaMinutes) || isNum(t.results?.rpaMinutes));

  write(0, {
    label: `Tests — ${d.meta.name || d.meta.slug}`,
    kind: 'index',
    notes: bits(plural(tests.length, 'test'),
      measured
        ? `last measured: ${bits(isNum(measured.results?.rtaMinutes) ? `RTA ${measured.results.rtaMinutes} min` : null,
          isNum(measured.results?.rpaMinutes) ? `RPA ${measured.results.rpaMinutes} min` : null)} in "${measured.name}"`
          + `${measured.date ? ` (${measured.date})` : ''} — passed`
        : unproven
          ? `nothing measured yet — "${unproven.name}"${unproven.date ? ` (${unproven.date})` : ''} carries numbers but is recorded as `
            + `${TEST_STATUS_DISPLAY[unproven.status] || cap(unproven.status) || 'not passed'}, so they are not measurements`
          : 'nothing measured yet — every number in this plan is still a target',
      bits(isNum(o.rtoMinutes) ? `RTO target ${o.rtoMinutes} min` : 'RTO target not set',
        isNum(o.rpoMinutes) ? `RPO target ${o.rpoMinutes} min` : 'RPO target not set',
        o.approved ? 'approved' : 'not approved',
        // Whose target it is. Silence here is what let a lab drill be reported
        // against production's approved commitment.
        o.level === 'workspace' ? null : o.why)),
  });

  for (const t of tests) {
    const r = t.results || {};
    const apps = t.appTests || [];
    const finds = t.findings || [];
    const status = TEST_STATUS_DISPLAY[t.status] || cap(t.status) || 'Unknown';
    const overRto = isNum(r.rtaMinutes) && isNum(o.rtoMinutes) && r.rtaMinutes > o.rtoMinutes;
    const overRpo = isNum(r.rpaMinutes) && isNum(o.rpoMinutes) && r.rpaMinutes > o.rpoMinutes;
    write(1, {
      label: bits(t.date || 'undated', t.name || '(unnamed test)'),
      kind: t.type || 'test',
      status,
      notes: bits(
        isNum(r.rtaMinutes) ? `RTA ${r.rtaMinutes} min${overRto ? ` — OVER the ${o.rtoMinutes} min target` : ''}` : 'RTA unmeasured',
        isNum(r.rpaMinutes) ? `RPA ${r.rpaMinutes} min${overRpo ? ` — OVER the ${o.rpoMinutes} min target` : ''}` : 'RPA unmeasured',
        // A number off a run that did not pass is a reading, not a measurement.
        (isNum(r.rtaMinutes) || isNum(r.rpaMinutes)) && t.status !== 'passed'
          ? 'NOT measurements — this run did not pass' : null,
        r.cleanRun === true ? 'clean run' : r.cleanRun === false ? 'not a clean run' : null,
        finds.length ? plural(finds.length, 'finding') : 'no findings',
      ),
    });

    // ---- the snapshot: the fields you fill on every test ----
    write(2, {
      label: 'Snapshot',
      kind: 'record',
      notes: 'fill these on every test — they are what makes the next one comparable',
    });
    const field = (label, value, extra = {}) => write(3, {
      label, kind: 'field', notes: value, ...extra,
    });
    field('Date', t.date || 'undated');
    field('Runbook followed', d.runbookNameOf(t.runbookId) || 'none linked — the test is not reproducible without one',
      { status: t.runbookId ? '' : 'Unknown' });
    field('Result', status, { status });
    // Pass/Fail here is a verdict against an objective, which only a passed run
    // can earn. A failed run's clock reading stays Unknown and says why.
    const runMeasured = t.status === 'passed';
    field(runMeasured ? 'RTA measured (time to restore)' : 'RTA reading (NOT a measurement — run did not pass)',
      isNum(r.rtaMinutes)
        ? `${r.rtaMinutes} min${runMeasured ? '' : ' — time to failure, not a recovery time'}`
        : 'unmeasured',
      { status: isNum(r.rtaMinutes) && runMeasured ? (overRto ? 'Fail' : 'Pass') : 'Unknown' });
    field(runMeasured ? 'RPA measured (data age at recovery point)' : 'RPA reading (NOT a measurement — run did not pass)',
      isNum(r.rpaMinutes)
        ? `${r.rpaMinutes} min${runMeasured ? '' : ' — unconfirmed: the run never reached the success bar'}`
        : 'unmeasured',
      { status: isNum(r.rpaMinutes) && runMeasured ? (overRpo ? 'Fail' : 'Pass') : 'Unknown' });
    field('Clean run (no manual fixes)', r.cleanRun === true ? 'yes' : r.cleanRun === false ? 'no' : 'not recorded',
      { status: r.cleanRun === true ? 'Pass' : r.cleanRun === false ? 'Fail' : 'Unknown' });
    field('App checks / findings', `${apps.filter((a) => a.result === 'pass').length}/${apps.length} passed · ${plural(finds.length, 'finding')}`);

    // ---- the business success bar ----
    if (apps.length) {
      write(2, {
        label: `App checks (${apps.length})`,
        kind: 'checklist',
        notes: 'the business success bar — a transaction completing, not infrastructure turning green',
      });
      for (const a of apps) {
        const c = a.componentId ? d.byId.get(a.componentId) : null;
        write(3, {
          label: a.name || '(unnamed check)',
          kind: a.critical ? 'critical check' : 'app check',
          status: a.result ? (TEST_STATUS_DISPLAY[a.result] || cap(a.result)) : 'Not reached',
          notes: bits(c ? c.name : a.componentId, a.expected ? `expect: ${a.expected}` : null, a.command),
          day0: a.critical ? 'Yes' : 'No',
          scope: c ? (c.inRecoveryScope === 'yes' ? 'Yes' : cap(c.inRecoveryScope || 'unknown')) : '',
          link: c?.definedIn || '',
        });
      }
    }

    // ---- what it found ----
    if (finds.length) {
      write(2, {
        label: `Findings (${finds.length})`,
        kind: 'findings',
        notes: bits(`${finds.filter((f) => f.severity === 'blocker').length} blocker`,
          'each one should exist as a gap on the Workbench sheet'),
      });
      for (const f of finds) {
        const gap = f.gapId ? d.gaps.find((x) => x.id === f.gapId) : null;
        write(3, {
          label: f.title || '(untitled finding)',
          kind: f.severity || 'finding',
          status: f.severity === 'blocker' ? 'Blocked' : 'Fail',
          notes: bits(`severity ${f.severity || 'unknown'}`,
            gap ? `gap: ${gap.title} (${gap.status || 'open'})` : (f.gapId ? `gap ${f.gapId}` : 'not filed as a gap yet')),
          arn: ref('ticket', f.ticket),
        });
      }
    }

    // ---- the written record ----
    if (t.record) {
      const rec = write(2, { label: 'Record', kind: 'record', notes: t.record });
      const cell = rec.getCell(7);
      cell.value = String(t.record).replace(/\s+/g, ' ').trim();
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.font = ARIAL({ italic: true });
      rec.height = Math.min(120, Math.max(22.5, Math.ceil(String(t.record).length / 60) * 12));
    }
  }
  return finishTree(ws);
}

// ================================================ Outbound Calls (the egress)
//
// "Point at any service and say exactly who it talks to, and what would break
// in the recovery region." The sheet is built to be CLEAN, in this order:
//
//   L1  the service being recovered  — with its headline on the row
//   L2  destination class            — Startup first, then AWS, internal,
//                                      third-party, SaaS, unclassified
//   L3  one row per call             — deduplicated on (destination, protocol,
//                                      port); a flow seen 4,000 times is ONE
//                                      row carrying Observed 4000
//
// Rules held here: destinations are RESOLVED to human names (never a bare host
// or pod hash), no cell is ambiguously blank, rows sort blockers-first, and the
// classic recovery killers are tinted and named — a partner call with a manual
// or missing failover story, a target that is out of recovery scope, an
// allowlist / static-egress-IP dependency, and a target that is only built in a
// LATER deployment wave than the caller (that caller will CrashLoop).

const NOT_KNOWN = '—';

// A call's port and protocol, however the importer spelled them.
const egressPort = (o) => o.port ?? o.destinationPort ?? o.targetPort ?? o.dport ?? null;
const egressProtoPort = (o) => {
  const proto = o.protocol || '';
  const port = egressPort(o);
  if (proto && port != null && port !== '') return `${proto}/${port}`;
  return proto || (port != null && port !== '' ? String(port) : '');
};

// AWS endpoint host → a human service name. Only the services we actually see.
const AWS_SERVICE_NAMES = {
  sqs: 'Amazon SQS', sns: 'Amazon SNS', s3: 'Amazon S3', kms: 'AWS KMS',
  secretsmanager: 'AWS Secrets Manager', ssm: 'AWS Systems Manager',
  ecr: 'Amazon ECR', dkr: 'Amazon ECR (registry)',
  dynamodb: 'Amazon DynamoDB', kinesis: 'Amazon Kinesis', firehose: 'Amazon Data Firehose',
  sts: 'AWS STS', logs: 'Amazon CloudWatch Logs', monitoring: 'Amazon CloudWatch',
  rds: 'Amazon RDS', elasticache: 'Amazon ElastiCache', eks: 'Amazon EKS',
  'execute-api': 'Amazon API Gateway', lambda: 'AWS Lambda', events: 'Amazon EventBridge',
  transfer: 'AWS Transfer Family', route53: 'Amazon Route 53', acm: 'AWS Certificate Manager',
  states: 'AWS Step Functions', athena: 'Amazon Athena', glue: 'AWS Glue',
};
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const AWS_HOST = /^([a-z0-9.-]+?)\.([a-z]{2}-[a-z]+-\d)\.amazonaws\.com$/i;
const AWS_HOST_GLOBAL = /^([a-z0-9.-]+?)\.amazonaws\.com$/i;

// A pod name carries a ReplicaSet hash: adjudication-deploy-7d9f8c6b5-abcde.
const podToWorkload = (name, workloads) => {
  const s = String(name || '');
  const hit = workloads.find((w) => w.name && s.startsWith(`${w.name}-`));
  return hit ? hit.name : s.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, '');
};

// Resolve a raw target into {name, class, resolved} — never a bare hash or an
// unexplained IP in the primary column.
function resolveDestination(o, target) {
  const raw = String(o.target || '').trim();
  if (target) {
    // A target we hold in the inventory: its own category decides the class, so
    // a partner clearinghouse we track is still a third-party call.
    const cls = target.category === 'third-party' ? 'third-party'
      : target.category === 'edge-dns' ? 'internal' : 'internal';
    return { name: target.name, cls, component: target, detail: raw };
  }
  const host = raw.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  const aws = host.match(AWS_HOST);
  if (aws) {
    const code = aws[1].toLowerCase().replace(/^api\./, '');
    const label = AWS_SERVICE_NAMES[code] || AWS_SERVICE_NAMES[aws[1].toLowerCase()] || `AWS ${code}`;
    return { name: `${label} (${aws[2]})`, cls: 'aws-service', detail: host };
  }
  const awsGlobal = host.match(AWS_HOST_GLOBAL);
  if (awsGlobal) {
    const code = awsGlobal[1].toLowerCase().split('.').pop();
    return { name: `${AWS_SERVICE_NAMES[code] || `AWS ${code}`} (global)`, cls: 'aws-service', detail: host };
  }
  if (IPV4.test(host)) {
    return {
      name: `IP ${host} — name not known`,
      cls: String(o.type || '').toLowerCase().includes('third') ? 'third-party' : 'unclassified',
      detail: host,
      unresolved: true,
    };
  }
  const type = String(o.type || '').toLowerCase();
  if (/aws/.test(type)) return { name: raw || NOT_KNOWN, cls: 'aws-service', detail: host };
  if (/third|partner|external/.test(type)) return { name: raw || NOT_KNOWN, cls: 'third-party', detail: host };
  if (/saas|vendor/.test(type)) return { name: raw || NOT_KNOWN, cls: 'saas', detail: host };
  if (/internal|service/.test(type)) return { name: raw || NOT_KNOWN, cls: 'internal', detail: host };
  return { name: raw || NOT_KNOWN, cls: 'unclassified', detail: host, unresolved: !raw };
}

const STARTUP_RE = /startup|start-?up|pod start|at boot|bootstrap|secrets?-init|image pull|init container|on launch/i;
const MANUAL_RE = /manual|by hand|ticket|raise a|ask the|partner must|must be added|reconfigur/i;
const ALLOWLIST_RE = /allow-?list|white-?list|static egress|egress ip|source ip|ip pinn/i;

const CALL_CLASSES = [
  ['startup', 'Startup — must be reachable before pods are Ready'],
  ['aws-service', 'AWS services'],
  ['internal', 'Internal services'],
  ['third-party', 'Third-party / partner'],
  ['saas', 'SaaS'],
  ['unclassified', 'Unclassified — resolve these before the next test'],
];

// One deduplicated call per (destination, protocol, port) for one service.
function egressRows(d, c, { waveOf = null, workloads = [] } = {}) {
  const byKey = new Map();
  for (const o of c.outboundCalls || []) {
    const target = matchComponentByText(d, o.target);
    const dest = resolveDestination(o, target);
    const port = egressPort(o);
    const proto = String(o.protocol || '').toLowerCase();
    const key = `${squash(dest.name)}|${proto}|${port ?? ''}`;
    const observed = CALL_OBSERVED(o);
    const src = o.source === 'network-flows' ? 'network-flows' : 'declared';
    const cur = byKey.get(key);
    if (cur) {
      // Two sources describing the same call: ONE row, both facts kept.
      cur.purpose = cur.purpose || o.purpose || '';
      cur.failover = cur.failover || o.failoverBehavior || '';
      cur.critical = cur.critical || !!o.critical;
      cur.observed = observed != null ? Math.max(cur.observed ?? 0, observed) : cur.observed;
      if (!cur.sources.includes(src)) cur.sources.push(src);
      if (o.workload && !cur.workloads.includes(o.workload)) cur.workloads.push(o.workload);
      continue;
    }
    byKey.set(key, {
      dest,
      target,
      proto,
      port,
      purpose: o.purpose || '',
      failover: o.failoverBehavior || '',
      critical: !!o.critical,
      observed,
      sources: [src],
      workloads: o.workload ? [o.workload] : [],
      type: o.type || '',
    });
  }

  const rows = [...byKey.values()].map((r) => {
    const text = `${r.purpose} ${r.failover} ${r.type} ${r.dest.name}`;
    const startup = STARTUP_RE.test(text)
      || ['security-secrets', 'cicd-control-plane'].includes(r.target?.category || '');
    const manual = !r.failover || MANUAL_RE.test(r.failover);
    const allowlist = ALLOWLIST_RE.test(text);
    const tScope = r.target ? String(r.target.inRecoveryScope || 'unknown').toLowerCase() : '';
    const outOfScope = !!r.target && tScope !== 'yes';
    const callerWave = waveOf ? waveOf.get(c.id) : null;
    const targetWave = waveOf && r.target ? waveOf.get(r.target.id) : null;
    const laterWave = callerWave != null && targetWave != null && targetWave > callerWave;
    const blocks = r.critical && (startup || manual || outOfScope || laterWave);
    const reasons = [];
    if (blocks) reasons.push('BLOCKS RECOVERY');
    if (laterWave) {
      reasons.push(`its target is built in wave ${targetWave} — after this service (wave ${callerWave}): it will CrashLoop until then`);
    }
    if (outOfScope) reasons.push(`target recovery scope: ${tScope}`);
    if (allowlist) reasons.push('allowlist / static egress IP — partner action needed before a test');
    if (manual && (r.dest.cls === 'third-party' || r.dest.cls === 'saas')) {
      reasons.push(r.failover ? 'manual failover step' : 'NO failover behaviour recorded for a partner call');
    }
    if (r.dest.unresolved) reasons.push('destination not resolved — name it before the next test');
    // The GROUP a call sits in (startup first, cross-cutting) is not the same
    // question as WHAT the destination is, which stays in the Kind column.
    const cls = startup ? 'startup' : r.dest.cls;
    const status = blocks ? 'Blocked'
      : (r.dest.unresolved || (!r.failover && r.critical)) ? 'Unknown'
        : outOfScope || allowlist || (manual && r.critical) ? 'Partial'
          : r.critical ? NOT_STARTED : 'N/A';
    return {
      ...r, startup, manual, allowlist, outOfScope, laterWave, blocks, reasons, cls, status,
      // What the destination IS — never overwritten by the group it sits in.
      kindLabel: r.target
        ? (r.target.category === 'third-party' ? 'third-party' : 'internal service')
        : r.dest.cls === 'aws-service' ? 'AWS service'
          : r.dest.cls === 'third-party' ? 'third-party'
            : r.dest.cls === 'saas' ? 'SaaS'
              : r.dest.cls === 'internal' ? 'internal service' : 'not classified',
      thirdParty: r.dest.cls === 'third-party' || r.dest.cls === 'saas',
      when: startup ? 'needed AT STARTUP' : (r.purpose || r.failover ? 'during operation' : 'when: not recorded'),
      podText: r.workloads.length
        ? join(r.workloads.map((w) => podToWorkload(w, workloads)))
        : '',
    };
  });
  rows.sort((a, b) => (b.blocks - a.blocks) || (b.critical - a.critical)
    || String(a.dest.name).localeCompare(String(b.dest.name)));
  return rows;
}

function addOutboundCalls(wb, d, sm, deploy) {
  const withCalls = d.components.filter((c) => (c.outboundCalls || []).length);
  if (!withCalls.length) return null;

  // component id -> deployment wave, when the engine gave us one
  let waveOf = null;
  if (deploy?.waves?.length) {
    waveOf = new Map();
    for (const w of deploy.waves) {
      for (const cat of w.categories || []) {
        for (const it of cat.items || []) {
          if (it?.id != null && isNum(w.index)) waveOf.set(it.id, w.index);
        }
      }
    }
  }
  const workloads = hasK8s(d) ? (d.k8s.workloads || []) : [];
  const rootName = (d.scope?.rootId && d.byId.get(d.scope.rootId)?.name) || d.scope?.rootName || '';

  const ws = treeSheet(wb, SHEETS.egress,
    rootName
      ? `Outbound Calls — everything ${rootName} talks to · Day-0? = the call is needed in the first hour · Status = Blocked means it will stop the recovery`
      : 'Outbound Calls — expand a service for every destination it talks to · Day-0? = needed in the first hour · Status = Blocked means it will stop the recovery',
    {
      note: 'One row per destination per service — deduplicated on destination + protocol + port, so a flow observed '
        + '4,000 times is one row carrying Observed 4000. Destinations are resolved to human names; ARN / reference '
        + 'carries the service ARN on a service row and the protocol/port + endpoint on a call row; Resources/links '
        + 'carries the provenance (declared / network-flows) and the '
        + 'observed count. Status = Blocked is derived — a critical call that is needed at startup, has a manual or '
        + 'missing failover story, points at something out of recovery scope, or points at something built in a LATER '
        + 'deployment wave than its caller (that caller will CrashLoop). Those rows are red on purpose.',
      print: { orientation: 'landscape' },
    });
  const write = treeWriter(ws);

  // ---------------------------------------------------- the whole picture ----
  const all = withCalls.map((c) => ({ c, rows: egressRows(d, c, { waveOf, workloads }) }));
  const flat = all.flatMap((s) => s.rows);
  const count = (fn) => flat.filter(fn).length;
  write(0, {
    label: rootName ? `${rootName} — outbound calls` : `${d.meta.name || d.meta.slug} — outbound calls`,
    kind: 'egress',
    notes: bits(`${flat.length} distinct calls from ${plural(all.length, 'service')}`,
      `${count((r) => r.blocks)} block recovery`,
      `${count((r) => r.thirdParty)} third-party`,
      `${count((r) => r.allowlist)} need an allowlist`,
      `${count((r) => r.observed != null)} seen in flow data`),
  });

  // ------------------------------------------------------- the headline -----
  write(1, {
    label: 'SUMMARY — THE HEADLINE BEFORE YOU EXPAND ANYTHING',
    kind: 'summary',
    notes: 'the four numbers that decide whether egress is a recovery risk here',
  });
  const summary = (label, n, notes, status) => write(2, {
    label, kind: 'count', status: status || (n ? 'Partial' : 'Pass'),
    notes: bits(String(n), notes), day0: n ? 'Yes' : 'No', scope: NOT_KNOWN, arn: NOT_KNOWN, link: NOT_KNOWN,
  });
  summary('Calls that BLOCK recovery', count((r) => r.blocks),
    'critical, and either needed at startup, missing a failover story, out of scope, or built later',
    count((r) => r.blocks) ? 'Blocked' : 'Pass');
  summary('Third-party / SaaS calls', count((r) => r.thirdParty),
    'someone else has to act for these to work in the recovery region');
  summary('Calls needing an allowlist / static egress IP', count((r) => r.allowlist),
    'partner-side change — start it before the test, not during it');
  summary('Calls with no failover behaviour recorded', count((r) => !r.failover),
    'unrecorded means undecided; it gets decided during the incident',
    count((r) => !r.failover) ? 'Unknown' : 'Pass');
  summary('Destinations not resolved to a name', count((r) => r.dest.unresolved),
    'a bare IP or hash tells nobody anything — resolve it',
    count((r) => r.dest.unresolved) ? 'Unknown' : 'Pass');
  summary('Calls seen in imported flow data', count((r) => r.observed != null),
    'the rest are declared by hand — flows prove, declarations assert', 'Pass');

  // -------------------------------------------------------- per service -----
  const order = [...all].sort((a, b) => (b.rows.filter((r) => r.blocks).length - a.rows.filter((r) => r.blocks).length)
    || (a.c.tier ?? 9) - (b.c.tier ?? 9) || a.c.name.localeCompare(b.c.name));

  for (const { c, rows } of order) {
    const isRoot = !!d.scope?.rootId && c.id === d.scope.rootId;
    const pods = workloads.filter((w) => w.componentId === c.id);
    const blockers = rows.filter((r) => r.blocks).length;
    const third = rows.filter((r) => r.thirdParty).length;
    const allow = rows.filter((r) => r.allowlist).length;
    const sRow = write(1, {
      label: c.name,
      kind: c.kind || 'service',
      status: blockers ? 'Blocked' : rows.some((r) => r.status === 'Partial' || r.status === 'Unknown') ? 'Partial' : sm.statusOf(c),
      notes: bits(`${plural(rows.length, 'outbound call')}`,
        third ? `${third} third-party` : 'none third-party',
        allow ? `${allow} need an allowlist` : null,
        blockers ? `${blockers} block recovery` : 'none block recovery',
        pods.length
          ? `pods ${join(pods.slice(0, 3).map((w) => `${w.name} (${w.namespace})`))}`
          : 'no workload in the cluster snapshot'),
      notesMax: 220,
      day0: sm.day0Of(c),
      scope: sm.scopeOf(c),
      arn: c.arn || '',
      link: c.definedIn || NOT_KNOWN,
    });
    if (isRoot) write.marker(sRow, 'THIS SERVICE — the focus of this package');

    for (const [clsKey, clsLabel] of CALL_CLASSES) {
      const group = rows.filter((r) => r.cls === clsKey);
      if (!group.length) continue;
      write(2, {
        label: clsLabel,
        kind: 'class',
        status: group.some((r) => r.blocks) ? 'Blocked' : group.some((r) => r.status === 'Partial') ? 'Partial' : '',
        notes: bits(plural(group.length, 'call'),
          clsKey === 'startup' ? 'nothing here can wait: the pod does not become Ready without it' : null,
          clsKey === 'third-party' ? 'someone outside your account has to act' : null,
          clsKey === 'unclassified' ? 'these have no destination type recorded' : null),
        day0: clsKey === 'startup' ? 'Yes' : (group.some((r) => r.blocks) ? 'Yes' : 'No'),
        scope: NOT_KNOWN,
        arn: NOT_KNOWN,
        link: NOT_KNOWN,
      });
      for (const r of group) {
        const row = write(3, {
          label: r.dest.name,
          kind: r.kindLabel,
          status: r.status,
          notes: bits(
            r.reasons.length ? r.reasons.join(' · ') : null,
            r.when,
            r.podText ? `from ${r.podText}` : null,
            r.purpose ? `why: ${r.purpose}` : 'why: not recorded',
            `failover: ${r.failover || 'NOT RECORDED'}`,
          ),
          notesMax: 220, // this cell wraps to two lines: let it use them
          day0: r.critical || r.startup ? 'Yes' : 'No',
          scope: r.target ? sm.scopeOf(r.target) : NOT_KNOWN,
          // A call row has no ARN of its own; its identity is the wire it uses.
          // Prefixed so the cell still says what it is under the column header.
          arn: ref('via', bits(egressProtoPort({ protocol: r.proto, port: r.port }) || 'protocol/port not recorded',
            r.dest.detail && squash(r.dest.detail) !== squash(r.dest.name) ? r.dest.detail : null)) || NOT_KNOWN,
          link: bits(r.sources.join(' + '),
            r.observed != null ? `observed ${r.observed.toLocaleString('en-US')}` : null),
        });
        // Two lines of notes: this is the sheet people read, not skim.
        const cell = row.getCell(7);
        cell.alignment = { vertical: 'top', wrapText: true };
        row.height = 32;
        if (r.blocks) {
          cell.font = ARIAL({ bold: true, color: { argb: TINT.err.font } });
          row.getCell(4).font = ARIAL({ bold: true, color: { argb: TINT.err.font } });
        }
        if (r.target) row.getCell(4).font = ARIAL({ bold: r.blocks, color: { argb: LINK } });
      }
    }
  }
  return finishTree(ws);
}

// ------------------------------------------- Deployment Order (engine-fed) --
//
// "What has to be built before what" — IAM and KMS before secrets, networking
// before compute, a VPC and its subnets and security groups before the EKS
// cluster that lives in them. The ORDER is computed by server/lib/deploy-order.js
// (a separate engine, contract in INTEGRATION-NOTES.md); this sheet only renders
// it, on the same grid as everything else:
//
//   Wave (L1) → category inside the wave (L2) → the resource and what it waits
//   for (L3)
//
// The engine is optional. If the module is missing or throws, the sheet is
// skipped and the How-to-use guide says so — a workbook never fails to build
// because an engine is not there yet.

const DEPLOY_ORDER_EXPORTS = ['deployOrder', 'buildDeployOrder', 'computeDeployOrder',
  'deployOrderModel', 'getDeployOrder', 'deploymentOrder', 'default'];

// Returns the engine's model, or null when there is no usable engine.
async function loadDeployOrder(slug, scopeOpts) {
  let mod = null;
  try {
    mod = await import('./deploy-order.js');
  } catch {
    return null; // not built yet — expected
  }
  const fns = DEPLOY_ORDER_EXPORTS
    .map((k) => mod?.[k])
    .filter((f) => typeof f === 'function');
  const ok = (m) => m && typeof m === 'object' && Array.isArray(m.waves);
  for (const fn of fns) {
    for (const args of [[slug, scopeOpts || {}], [slug]]) {
      try {
        const m = await fn(...args);
        if (ok(m)) return m;
      } catch { /* try the next shape */ }
    }
  }
  return null;
}

function addDeploymentOrder(wb, d, model, sm) {
  const waves = (model?.waves || []).filter((w) => w && (w.categories || []).length);
  if (!waves.length) return null;
  const stats = model.stats || {};
  const rootName = (d.scope?.rootId && d.byId.get(d.scope.rootId)?.name) || d.scope?.rootName || '';
  const ws = treeSheet(wb, SHEETS.deploy,
    rootName
      ? `Deployment Order — what has to exist before what for ${rootName}: expand a wave to see the categories, then each resource and what it waits for`
      : 'Deployment Order — expand a wave to see which category goes first, then each resource and what it waits for',
    {
      note: 'Computed from the dependency graph: everything in one wave can be built in parallel, and a wave '
        + 'cannot start until the wave above it is done. Status notes on a resource row name what it waits for '
        + 'and why. Cycles, if any, are listed at the bottom — an order with a flagged cycle is safer than a '
        + 'clean-looking order that is wrong.',
      print: { orientation: 'landscape' },
    });
  const write = treeWriter(ws);

  const itemCount = waves.reduce((n, w) => n
    + (w.categories || []).reduce((m, c) => m + (c.items || []).length, 0), 0);
  write(0, {
    label: rootName ? `${rootName} — deployment order` : `${d.meta.name || d.meta.slug} — deployment order`,
    kind: 'order',
    notes: bits(plural(waves.length, 'wave'), plural(itemCount, 'resource'),
      isNum(stats.edgeCount) ? `${stats.edgeCount} ordering edges` : null,
      stats.cycleCount ? `${plural(stats.cycleCount, 'cycle')} — see the bottom of the sheet` : 'no cycles',
      model.generatedAt ? `computed ${String(model.generatedAt).slice(0, 10)}` : null),
  });

  // ---- the short answer: which category goes first ----
  const catOrder = (model.categoryOrder || []).filter((c) => c && c.category);
  if (catOrder.length) {
    write(1, {
      label: 'CATEGORY ORDER — THE SHORT ANSWER',
      kind: 'summary',
      notes: catOrder.map((c) => categoryLabel(c.category)).join(' → '),
    });
    for (const c of catOrder) {
      write(2, {
        label: categoryLabel(c.category),
        kind: 'category',
        notes: bits(isNum(c.firstWave) ? `first appears in wave ${c.firstWave}` : null, c.rationale),
      });
    }
  }

  // ---- the waves ----
  for (const w of waves) {
    const cats = (w.categories || []).filter((c) => (c.items || []).length);
    const count = cats.reduce((n, c) => n + c.items.length, 0);
    write(1, {
      // The engine's `name` already reads "Wave N · Identity & encryption";
      // `title` is the same label without that prefix. Prefer title so the row
      // doesn't render "Wave 0 · Wave 0 · Identity & encryption".
      label: bits(isNum(w.index) ? `Wave ${w.index}` : 'Wave', w.title ?? w.name),
      kind: w.layer || 'wave',
      notes: bits(plural(count, 'resource'),
        cats.map((c) => categoryLabel(c.category)).join(' → '),
        w.parallelizable === false
          ? 'NOT parallel — build these one at a time, in the order listed'
          : 'everything in this wave can be built in parallel',
        isNum(w.estMinutes) ? `~${w.estMinutes} min` : null),
    });
    for (const c of cats) {
      write(2, {
        label: categoryLabel(c.category),
        kind: 'category',
        notes: plural(c.items.length, 'resource'),
      });
      for (const it of c.items) {
        const own = it.id ? d.byId.get(it.id) : null;
        const waits = (it.waitsFor || []).filter(Boolean);
        write(3, {
          label: it.name || it.id || '(unnamed)',
          kind: it.kind || it.category || '',
          // Where the item is one of our components, it carries the same derived
          // Status / Day-0? / scope it has on every other sheet.
          status: own ? sm.statusOf(own) : '',
          notes: bits(
            it.tierName || (isNum(it.tier) ? `Tier ${it.tier}` : null),
            it.layer,
            waits.length
              ? `waits for: ${waits.slice(0, 3).map((x) => bits(x.name || x.id, x.why)).join('; ')}`
                + `${waits.length > 3 ? ` +${waits.length - 3} more` : ''}`
              : 'waits for nothing — it can go in the first wave',
            it.notes, it.provenance ? `source: ${it.provenance}` : null,
          ),
          day0: own ? sm.day0Of(own) : '',
          scope: own ? sm.scopeOf(own) : '',
          arn: ref('id', it.id),
          link: own?.definedIn || '',
        });
      }
    }
  }

  // ---- honesty: what the engine could not order ----
  const cycles = (model.cycles || []).filter(Boolean);
  if (cycles.length) {
    write(1, {
      label: 'CYCLES — THE ORDER IS NOT FULLY DETERMINED HERE',
      kind: 'warning',
      notes: `${plural(cycles.length, 'cycle')} in the dependency graph — break one edge by hand before you trust the order above`,
    });
    for (const cy of cycles) {
      write(2, {
        label: (cy.nodes || []).map((n) => (typeof n === 'string' ? n : n?.name || n?.id)).join(' → ') || 'cycle',
        kind: 'cycle',
        status: 'Blocked',
        notes: bits(cy.why, cy.suggestedBreak ? `suggested break: ${cy.suggestedBreak}` : null),
      });
    }
  }
  const unordered = (model.unordered || []).filter(Boolean);
  if (unordered.length) {
    write(1, {
      label: 'NOT PLACED IN ANY WAVE',
      kind: 'warning',
      notes: `${plural(unordered.length, 'item')} the engine could not place — decide their position by hand`,
    });
    for (const u of unordered) {
      const name = typeof u === 'string' ? u : (u.name || u.id || '(unnamed)');
      write(2, {
        label: name,
        kind: typeof u === 'object' ? (u.kind || u.category || '') : '',
        status: 'Unknown',
        notes: typeof u === 'object' ? bits(u.notes, u.why, u.provenance) : '',
        arn: typeof u === 'object' ? ref('id', u.id) : '',
      });
    }
  }
  return finishTree(ws);
}

// --------------------------------------------------------------- Workbench --
//
// The reference workbook folds everything that is not inventory, runtime or a
// test into ONE outlined sheet, and it is right: a Phase-0 gate, the gap list,
// the secret reconciliation, the verification catalogue, the people and the
// hard rules are all the same kind of thing — the working list. Nine thin tabs
// became nine sections here, and because Category repeats on every row,
// filtering Category = "GAP LIST" gives you exactly the old sheet.

function addWorkbench(wb, d, sm) {
  const ws = treeSheet(wb, SHEETS.workbench,
    'Workbench — Phase 0 gate, gaps, secrets, verification, people, accounts and the hard rules',
    {
      note: 'Every working list in one place. Expand a section; filter the Category column to pull one out. '
        + 'Phase 0 must be green before you launch a test. The honest-numbers rule at the bottom governs every '
        + 'number in this workbook.',
      print: { orientation: 'landscape' },
    });
  const write = treeWriter(ws);
  const x = execModel(d);

  write(0, {
    label: `Workbench — ${d.meta.name || d.meta.slug}`,
    kind: 'ops',
    notes: bits(
      `${x.openGapCount} open gap${x.openGapCount === 1 ? '' : 's'}`,
      x.inventory.unknownSecrets ? `${x.inventory.unknownSecrets} secrets with unknown replication` : 'secrets reconciled',
      `${x.inventory.checklistDone}/${x.inventory.checklistItems} checklist items done`,
      'do not launch a test until Phase 0 is green',
    ),
  });

  // ---------------------------------------------------------- 1. Phase 0 ----
  const checklists = d.checklists.filter((cl) => (cl.items || []).length);
  if (checklists.length) {
    const items = checklists.flatMap((cl) => cl.items || []);
    const done = items.filter((i) => i.done).length;
    write(1, {
      label: 'PHASE 0 — BEFORE ANY TEST OR FAILOVER',
      kind: 'gate',
      notes: bits(`${done}/${items.length} done`, 'flip Done only with the proof in hand',
        done === items.length ? 'gate green' : `${items.length - done} still open`),
    });
    for (const cl of checklists) {
      const its = cl.items || [];
      const clDone = its.filter((i) => i.done).length;
      write(2, {
        label: cl.name || 'checklist',
        kind: cl.kind || 'checklist',
        status: clDone === its.length ? 'Pass' : clDone ? 'Partial' : NOT_STARTED,
        notes: `${clDone}/${its.length} done`,
      });
      for (const it of its) {
        write(3, {
          label: it.text || '(unnamed item)',
          kind: 'gate item',
          status: it.done ? 'Pass' : NOT_STARTED,
          notes: bits(it.why, it.proof ? `proof: ${it.proof}` : 'no proof requirement recorded'),
          day0: 'Yes',
          arn: ref('owner', it.owner),
        });
      }
    }
  }

  // -------------------------------------------------------- 2. the gaps ----
  if (d.gaps.length) {
    const open = d.gaps.filter((g) => g.status !== 'resolved');
    write(1, {
      label: 'GAP LIST — WHAT STANDS BETWEEN THIS PLAN AND A PASSING TEST',
      kind: 'gaps',
      notes: bits(`${open.length} open of ${d.gaps.length}`,
        x.gapsBySeverity.map(([s, n]) => `${n} ${s}`).join(' · '),
        'a blocker stops the next test'),
    });
    const sevOrder = [...d.gaps].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
      || String(a.title || '').localeCompare(String(b.title || '')));
    for (const g of sevOrder) {
      const c = g.componentId ? d.byId.get(g.componentId) : null;
      write(2, {
        label: g.title || '(untitled gap)',
        kind: g.severity || 'gap',
        status: g.status === 'resolved' ? 'Pass'
          : g.status === 'accepted' ? 'Accepted'
            : g.severity === 'blocker' ? 'Blocked' : 'Fail',
        notes: bits(c ? c.name : (g.componentId || 'workspace-wide'),
          g.class, g.notes),
        day0: g.severity === 'blocker' || g.severity === 'high' ? 'Yes' : 'No',
        scope: c ? sm.scopeOf(c) : '',
        arn: ref('ticket', g.ticket),
        link: c?.definedIn || '',
      });
    }
  }

  // ---------------------------------------------------- 3. the secrets ----
  const secretRows = d.components.flatMap((c) => (c.secrets || []).map((s) => ({ c, s })));
  if (secretRows.length) {
    const unknown = secretRows.filter(({ s }) => (s.replicated || 'unknown') !== 'yes').length;
    write(1, {
      label: 'SECRETS RECONCILIATION — DRIVE EVERY ROW TO YES OR NO',
      kind: 'secrets',
      notes: bits(plural(secretRows.length, 'secret'),
        unknown ? `${unknown} not confirmed replicated` : 'all confirmed replicated',
        'unresolved secrets are the most common cause of a failed recovery test'),
    });
    for (const { c, s } of secretRows) {
      const repl = s.replicated || 'unknown';
      write(2, {
        label: s.name || '(unnamed secret)',
        kind: 'secret',
        status: REPL_STATUS[repl] || 'Unknown',
        notes: bits(c.name, `replicated: ${repl}`, s.notes),
        day0: sm.day0Of(c),
        scope: repl === 'yes' ? 'Yes' : repl === 'no' ? 'No' : 'Unknown',
        arn: s.arn || '',
      });
    }
  }

  // ----------------------------------------------- 4. the verifications ----
  const verifiable = d.components
    .filter((c) => c.verification?.command || c.verification?.pass)
    .sort((a, b) => layerOrder(a.restoreLayer) - layerOrder(b.restoreLayer)
      || a.name.localeCompare(b.name));
  if (verifiable.length) {
    write(1, {
      label: 'VERIFICATION — RUN THESE IN RESTORE-LAYER ORDER',
      kind: 'verification',
      notes: bits(`${verifiable.length} of ${d.components.length} components have a check`,
        verifiable.length < d.components.length
          ? `${d.components.length - verifiable.length} have no way to prove they came back`
          : 'every component can be proved',
        'proof beats opinion'),
    });
    for (const c of verifiable) {
      const row = write(2, {
        label: c.name,
        kind: c.restoreLayer || c.category || '',
        status: sm.statusOf(c),
        notes: bits(c.verification.command, c.verification.pass ? `pass when: ${c.verification.pass}` : null),
        day0: sm.day0Of(c),
        scope: sm.scopeOf(c),
        link: c.definedIn || '',
      });
      const cell = row.getCell(7);
      cell.alignment = { vertical: 'top', wrapText: true };
      row.height = 34;
    }
  }

  // --------------------------------------------------------- 5. people ----
  if (d.contacts.length) {
    write(1, {
      label: 'PEOPLE — WHO DOES WHAT DURING A RECOVERY',
      kind: 'roster',
      notes: bits(plural(d.contacts.length, 'person'), 'escalation paths in the notes'),
    });
    for (const p of d.contacts) {
      write(2, {
        label: p.name || '(unnamed)',
        kind: 'person',
        notes: bits(p.role, p.responsibilities, p.escalation ? `escalation: ${p.escalation}` : null),
        arn: ref('contact', p.contact),
      });
    }
  }

  // ------------------------------------------------------ 6. decisions ----
  if (d.decisions.length) {
    write(1, {
      label: 'DECISIONS — SO THEY ARE NOT RE-LITIGATED MID-INCIDENT',
      kind: 'log',
      notes: plural(d.decisions.length, 'decision'),
    });
    for (const dec of d.decisions) {
      write(2, {
        label: dec.title || '(untitled decision)',
        kind: dec.status || 'decision',
        status: dec.status === 'decided' ? 'Accepted' : 'In Progress',
        notes: bits(dec.decision, dec.context),
        arn: ref('decided', dec.date),
        link: dec.owner || '',
      });
    }
  }

  // ------------------------------------------- 7. accounts and numbers ----
  write(1, {
    label: 'ACCOUNTS, REGIONS AND THE NUMBERS',
    kind: 'map',
    notes: bits(`${x.workspace.primaryRegion || '?'} → ${x.workspace.recoveryRegion || '?'}`,
      x.workspace.strategyName || 'no strategy recorded',
      x.workspace.tooling.map((t) => t.key).join(' · ') || 'no tooling recorded'),
  });
  const numLine = (label, value, notes, status) => write(2, {
    label, kind: 'number', status, notes: bits(value, notes),
  });
  numLine('Primary region', x.workspace.primaryRegion || 'not set', 'where it runs today');
  numLine('Recovery region', x.workspace.recoveryRegion || 'not set', 'where it comes back');
  numLine('DR strategy', x.workspace.strategyName || 'not set',
    x.workspace.strategyOption ? `typically RTO ${x.workspace.strategyOption.rto}, RPO ${x.workspace.strategyOption.rpo}` : null,
    x.workspace.strategyName ? '' : 'Unknown');
  for (const t of x.workspace.tooling) numLine('Tooling', t.key, t.label);
  numLine('RTO target', x.numbers.rtoMinutes != null ? `${x.numbers.rtoMinutes} min` : 'not set',
    x.numbers.approved ? 'approved by the business' : 'NOT approved — a target nobody signed is a hope',
    x.numbers.rtoMinutes == null ? 'Unknown' : x.numbers.approved ? 'Pass' : 'Partial');
  numLine('RPO target', x.numbers.rpoMinutes != null ? `${x.numbers.rpoMinutes} min` : 'not set',
    x.numbers.approved ? 'approved by the business' : 'NOT approved',
    x.numbers.rpoMinutes == null ? 'Unknown' : x.numbers.approved ? 'Pass' : 'Partial');
  // Same rule on the package cover: measured only when a passed test produced
  // it, and the status column stays Unknown for anything hand-recorded — a
  // "Pass" against a number nobody tested is the whole defect this fixes.
  const coverNumber = (label, state, minutes, stamp, what, meets) => numLine(
    state === 'measured' ? `${label} measured`
      : state === 'declared' ? `${label} recorded by hand (not measured)` : `${label} unmeasured`,
    minutes == null ? 'not measured yet' : `${minutes} min${stamp ? ` (${stamp})` : ''}`,
    what,
    state !== 'measured' ? 'Unknown' : meets === false ? 'Fail' : 'Pass');
  coverNumber('RTA', x.numbers.rtaState, x.numbers.rtaMinutes, x.numbers.rtaStamp, x.numbers.rtaWhat, x.numbers.meetsRto);
  coverNumber('RPA', x.numbers.rpaState, x.numbers.rpaMinutes, x.numbers.rpaStamp, x.numbers.rpaWhat, x.numbers.meetsRpo);
  if (x.maturity) {
    numLine('Maturity', x.maturity.label,
      `average answer ${x.maturity.avg} of 4 across ${plural(x.maturity.answered, 'answered question')}`,
      x.maturity.level >= 4 ? 'Pass' : x.maturity.level >= 2 ? 'Partial' : 'Fail');
  }

  // ------------------------------------------------------ 8. hard rules ----
  write(1, {
    label: 'HARD RULES — THE HONEST-NUMBERS RULE GOVERNS EVERY SHEET HERE',
    kind: 'policy',
    notes: 'RTO/RPO are targets the business signs. RTA/RPA are what a test that PASSED measured. Quote the measurement and name the test.',
  });
  for (const rule of [
    ['RTO/RPO are targets; RTA/RPA are evidence', 'A target nobody has met is not a recovery capability.'],
    ['Quote the measured number and name the test', 'If it was never measured, say "unmeasured" — not the target.'],
    ['Only a PASSED test produces a measurement', 'A run that did not reach the success bar has a time to failure, not a recovery time. A number typed into Settings is recorded by hand, not evidence.'],
    ['A gate step must pass before the next step', 'Runbook gates exist so a failed test stops rather than drifts.'],
    ['Infrastructure green is not the success bar', 'The bar is a business transaction completing — see the app checks on the Tests sheet.'],
    ['An untested runbook is a hypothesis', 'Nothing counts as a capability until a test has walked it end to end.'],
    ['Reconcile the secret lists to ONE signed-off list', 'Three lists that disagree is how a recovery test dies at startup.'],
  ]) {
    write(2, { label: rule[0], kind: 'rule', notes: rule[1], day0: 'Yes' });
  }

  // -------------------------------------------- 9. the strategy options ----
  write(1, {
    label: 'DR STRATEGY OPTIONS — REFERENCE',
    kind: 'reference',
    notes: 'ranges are typical for AWS multi-region; a measured RTA from a real test beats every number here',
  });
  for (const o of DR_OPTIONS) {
    const row = write(2, {
      label: o.name,
      kind: o.complexity,
      status: x.workspace.strategy === o.key ? 'Accepted' : '',
      notes: bits(`RTO ${o.rto}`, `RPO ${o.rpo}`, o.cost, o.when),
    });
    const cell = row.getCell(7);
    cell.alignment = { vertical: 'top', wrapText: true };
    row.height = 44;
    if (x.workspace.strategy === o.key) write.marker(row, '');
  }
  return finishTree(ws);
}

// ======================================== How we fail this over (the brief) ==
//
// ADDITIVE SECTION — nothing above this line is changed by it. The tree sheets
// (the Resource Graph especially) are untouched.
//
// THE PROBLEM THIS SHEET SOLVES. The rest of the workbook is inventory: every
// component, every deployable item, every wave, every port and every ARN. All
// of it true, none of it followable out loud. Someone opening the workbook in a
// meeting needs one page that says, in order:
//
//   1  what this is            — system, environment, service, regions, strategy
//   2  what it's made of       — the inventory as a paragraph, not a list
//   3  the order it comes back — the waves at CATEGORY granularity, with the
//                                reason for each ("secrets first, because a pod
//                                that cannot read one CrashLoops before
//                                anything is testable")
//   4  what must be true first — the verify-don't-create preconditions + Phase 0
//   5  where it breaks today   — the blockers, named, with owners
//   6  what we know and don't  — the honest numbers, one row each
//   7  who does what           — the roles that actually appear in the runbooks
//
// EVERY SENTENCE IS DERIVED. There is no template prose with blanks filled in:
// each clause is built from the components, the resource graph, the
// deploy-order engine's own rationale strings, the gap list, the risk engine
// and the measured-numbers contract. Where the data does not say something the
// sheet says THAT, instead of guessing. `docs/measured-numbers.md` governs
// section 6 absolutely — its numbers come from execModel, the same model the
// Executive Summary sheet and EXECUTIVE-SUMMARY.md render, so the three can
// never tell different stories.

// The sheet name lives in the shared SHEETS list above (so the guide, the scope
// suffixes and the workbook can never disagree); this is the local alias.
const BRIEF_SHEET = SHEETS.brief;

const BRIEF_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten'];
const briefNumberWord = (n) => (Number.isInteger(n) && n >= 0 && n <= 10 ? BRIEF_NUMBER_WORDS[n] : String(n));

// Display spellings for the `kind` identifiers already in the inventory — the
// same kind of table as CATEGORY_LABELS / TOOLING_LABELS / NODE_TYPE_LABELS
// above, and used the same way. An unknown kind falls through to the raw
// identifier with its dashes removed, which is honest rather than pretty.
const BRIEF_KIND_NOUN = {
  'aurora-postgres': 'Aurora PostgreSQL cluster', 'aurora-mysql': 'Aurora MySQL cluster',
  'rds-postgres': 'RDS PostgreSQL instance', 'rds-mysql': 'RDS MySQL instance',
  'elasticache-redis': 'Redis cache', 'elasticache-memcached': 'Memcached cache',
  dynamodb: 'DynamoDB table group', documentdb: 'DocumentDB cluster',
  s3: 'S3 bucket group', efs: 'EFS file system', fsx: 'FSx file system',
  ebs: 'EBS volume group', sqs: 'SQS queue group', sns: 'SNS topic group',
  kinesis: 'Kinesis stream', msk: 'Kafka (MSK) cluster', eventbridge: 'EventBridge bus',
  'secrets-manager': 'Secrets Manager store', 'parameter-store': 'Parameter Store tree',
  kms: 'KMS key set', acm: 'ACM certificate set', iam: 'IAM role and trust set',
  vpc: 'VPC', 'transit-gateway': 'Transit Gateway', 'direct-connect': 'Direct Connect link',
  ecr: 'container registry', 'eks-cluster': 'EKS cluster', 'ecs-cluster': 'ECS cluster',
  'eks-workload': 'service', 'ecs-service': 'service', lambda: 'Lambda function',
  ec2: 'EC2 instance group', 'api-gateway': 'API Gateway front door',
  alb: 'application load balancer', nlb: 'network load balancer',
  route53: 'Route 53 zone', cdn: 'CDN / edge', waf: 'WAF',
  external: 'external partner', observability: 'observability stack',
};
const briefKindNoun = (k) => BRIEF_KIND_NOUN[String(k || '').toLowerCase()]
  || String(k || 'component').replace(/-/g, ' ');

// "three Aurora PostgreSQL clusters" / "one Kinesis stream"
const briefCountedNoun = (n, noun) => `${briefNumberWord(n)} ${noun}${n === 1 ? '' : 's'}`;

// "a, b and c" — with a truthful tail rather than a silent truncation.
function briefNameList(items, max = 4, key = 'name') {
  const names = (items || []).map((x) => (typeof x === 'string' ? x : x?.[key])).filter(Boolean);
  const head = names.slice(0, max);
  const more = names.length - head.length;
  const joined = head.length > 1
    ? `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
    : (head[0] || '');
  return more > 0 ? `${joined} and ${more} more` : joined;
}

// The first sentence of whatever a person wrote in the inventory. Quoting the
// workspace's own words is the only way this sheet can say what a service is
// FOR without inventing a business fact about it.
function briefSentence(text, max = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : t).replace(/[.!?]+$/, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const briefLowerFirst = (s) => (s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function briefGroupByKind(list) {
  const m = new Map();
  for (const c of list) {
    const k = c.kind || c.category || 'other';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length
    || String(a[0]).localeCompare(String(b[0])));
}
// "three Aurora PostgreSQL clusters, three Redis caches and one S3 bucket group"
function briefKindPhrase(list, max = 5) {
  const groups = briefGroupByKind(list);
  const head = groups.slice(0, max).map(([k, xs]) => briefCountedNoun(xs.length, briefKindNoun(k)));
  const restCount = groups.slice(max).reduce((n, [, xs]) => n + xs.length, 0);
  if (restCount) head.push(`${restCount} more`);
  return head.length > 1
    ? `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
    : (head[0] || '');
}

// ------------------------------------------------------------ 1. the subject
//
// "this workbook is for Acme Pharmacy on dev". An environment or a service is only
// NAMED when every component in the loaded (possibly scoped) set carries it —
// otherwise the sheet reports what it actually has rather than implying a scope
// it does not have. Per docs/ENV-SERVICE-MODEL.md §1 a workspace with no
// environments is single-environment, and we never fabricate one.
function briefSubject(d, opts = {}) {
  const meta = d.meta || {};
  const envs = Array.isArray(meta.environments) ? meta.environments : [];
  const services = Array.isArray(d.services) ? d.services : [];
  const comps = d.components || [];
  const idsOf = (key) => [...new Set(comps.map((c) => String(c[key] || '')).filter(Boolean))];
  const envIds = idsOf('envId');
  const svcIds = idsOf('serviceId');
  const allHave = (key) => comps.length > 0 && comps.every((c) => c[key]);

  let env = opts.env || null;
  if (!env && envIds.length === 1 && allHave('envId')) env = envs.find((e) => e.id === envIds[0]) || null;
  let service = opts.service || null;
  if (!service && svcIds.length === 1 && allHave('serviceId')) service = services.find((s) => s.id === svcIds[0]) || null;

  const root = d.scope?.rootId ? d.byId.get(d.scope.rootId) : null;
  return {
    system: meta.name || meta.slug || '',
    org: meta.org || '',
    env,
    envName: env ? (env.name || env.id) : '',
    service,
    serviceName: service ? (service.name || service.id) : '',
    // A component-closure scope (?componentId=) is a different kind of slice and
    // is named as one, so the two can never be confused on the page.
    root,
    // The environment owns the region pair when it declares one (contract §2).
    primaryRegion: env?.regions?.primary || meta.regions?.primary || '',
    recoveryRegion: env?.regions?.recovery || meta.regions?.recovery || '',
    strategy: meta.strategy || '',
    strategyName: strategyName(meta.strategy),
    strategyOption: strategyOption(meta.strategy),
    // The short half of the tooling label ("Arpio", not "Arpio — snapshot-based
    // cross-region recovery"): the full sentence belongs on the sheets that
    // explain the tool, not in the line someone reads out.
    tooling: (meta.tooling || []).map((t) => String(toolingLabel(t)).split(' — ')[0]),
    componentCount: comps.length,
    envCount: envs.length,
    serviceCount: services.length,
    // Honest reporting for the case where the slice is NOT one clean
    // environment or one clean service.
    envsPresent: envIds.length,
    servicesPresent: svcIds.length,
    unassignedEnv: envs.length ? comps.filter((c) => !c.envId).length : 0,
    unassignedService: services.length ? comps.filter((c) => !c.serviceId).length : 0,
  };
}

function briefSubjectLabel(s) {
  const parts = [s.system];
  if (s.envName) parts.push(s.envName);
  if (s.serviceName) parts.push(s.serviceName);
  if (!s.serviceName && s.root) parts.push(`${s.root.name} closure`);
  return parts.filter(Boolean).join(' · ');
}

// ------------------------------------------------- 2. what it's made of
//
// The inventory, read out loud. Every clause below is a fact already in the
// workspace: the category, the kind, the tier, the description someone typed,
// the declared outbound calls, the listener ports enrichment found. A clause
// whose source data is absent is not emitted — or, where its absence is the
// interesting fact, it says so.
function briefMadeOf(d, subj) {
  const C = d.components || [];
  const inCat = (...cats) => C.filter((c) => cats.includes(c.category || 'other'));
  const isApp = (c) => (c.category || '') === 'compute'
    && (layerOrder(c.restoreLayer) >= 4
      || /workload|deployment|service|function|lambda/.test(String(c.kind || '').toLowerCase()));
  const apps = C.filter(isApp);
  const platform = inCat('compute').filter((c) => !isApp(c));
  const data = inCat('database', 'storage', 'messaging-streaming');
  const net = inCat('networking', 'edge-dns');
  const sec = inCat('security-secrets', 'identity-access');
  const third = inCat('third-party');
  const covered = ['compute', 'database', 'storage', 'messaging-streaming',
    'networking', 'edge-dns', 'security-secrets', 'identity-access', 'third-party'];
  const rest = C.filter((c) => !covered.includes(c.category || 'other'));

  const who = subj.serviceName
    ? `${subj.serviceName}${subj.envName ? ` (${subj.envName})` : ''}`
    : `${subj.system}${subj.envName ? ` (${subj.envName})` : ''}`;
  const P = [];

  // --- the shape
  if (apps.length || platform.length) {
    P.push(`${who} is ${apps.length ? briefCountedNoun(apps.length, 'application service') : 'a platform'}`
      + `${platform.length ? ` running on ${briefNameList(platform, 2)}` : ''}`
      + `${apps.length ? ` — ${briefNameList(apps, 5)}` : ''}.`);
  }

  // --- which of them the plan exists for, in the workspace's own words
  const tiered = (t) => apps.filter((c) => c.tier === t);
  const t0 = tiered(0);
  const t1 = tiered(1);
  if (t0.length) {
    const said = t0.map((c) => {
      const s = briefSentence(c.description);
      return s ? `${c.name} ${briefLowerFirst(s)}` : `${c.name} has no description recorded`;
    });
    P.push(`Tier 0 is ${briefNameList(t0, 4)}: ${said.slice(0, 3).join('; ')}.`
      + (t1.length ? ` ${briefNameList(t1, 3)} ${t1.length === 1 ? 'is' : 'are'} Tier 1.` : ''));
  } else if (apps.length) {
    P.push('No application service in this slice is marked Tier 0, so nothing here is flagged as the reason the '
      + 'plan exists — set tiers before the next review, because tier is what decides the first hour.');
  }

  // --- state
  if (data.length) {
    const out = data.filter((c) => String(c.inRecoveryScope || 'unknown') === 'no');
    const partial = data.filter((c) => String(c.inRecoveryScope || '') === 'partial');
    P.push(`State lives in ${briefKindPhrase(data)}.`
      + (out.length
        ? ` ${briefNameList(out, 3)} ${out.length === 1 ? 'is' : 'are'} marked NOT in recovery scope — whatever `
          + `${out.length === 1 ? 'it holds does' : 'they hold does'} not come back.`
        : '')
      + (partial.length
        ? ` ${briefNameList(partial, 3)} ${partial.length === 1 ? 'is' : 'are'} only partially covered.`
        : ''));
  }

  // --- how it is reached, with the ports enrichment actually found
  if (net.length) {
    const listeners = Object.values(d.resourceGraph?.nodes || {})
      .filter((n) => n && n.type === 'listener' && n.details && n.details.port);
    const ports = [...new Set(listeners.map((n) => `${n.details.protocol || 'TCP'} ${n.details.port}`))];
    P.push(`It is reached through ${briefNameList(net, 4)}`
      + (ports.length ? `; the front door listens on ${ports.slice(0, 3).join(' and ')}` : '')
      + '.');
  }

  // --- secrets and identity, and the one count that predicts a failed test
  if (sec.length) {
    const secrets = C.flatMap((c) => (c.secrets || []).map((s) => ({ c, s })));
    const unknown = secrets.filter(({ s }) => (s.replicated || 'unknown') === 'unknown');
    P.push(`${briefNameList(sec, 4)} must be in place before any of it starts`
      + (secrets.length
        ? `: ${plural(secrets.length, 'runtime secret')} are declared across `
          + `${plural(new Set(secrets.map(({ c }) => c.id)).size, 'component')}`
          + `${unknown.length
            ? `, ${unknown.length} of them with replication status still unknown`
            : ', all with a recorded replication status'}`
        : ' — but no individual secrets are listed against any component, so what has to be readable in the '
          + 'recovery region is not written down anywhere')
      + '.');
  }

  // --- who is outside your account
  if (third.length) {
    const calls = C.flatMap((c) => (c.outboundCalls || [])
      .filter((o) => String(o.type || '') === 'third-party')
      .map((o) => ({ from: c, o })));
    const said = calls.map(({ from, o }) => `${from.name} reaches ${o.target} over `
      + `${String(o.protocol || 'an unrecorded protocol').toUpperCase()}${o.port ? ` on ${o.port}` : ''}`
      + `${o.purpose ? ` for ${o.purpose}` : ''}`
      + `${o.failoverBehavior ? ` — ${o.failoverBehavior}` : ' — no failover behaviour recorded'}`);
    P.push(`Outside your account: ${briefNameList(third, 3)}.`
      + (said.length
        ? ` ${said.slice(0, 2).join('. ')}.`
        : ' No outbound call in the inventory names them, so how they are reached is not written down.'));
  }

  if (rest.length) P.push(`Also in scope: ${briefNameList(rest, 4)}.`);
  return P;
}

// -------------------------------------------- 3. the order it comes back in
//
// The engine's waves, collapsed into STAGES — runs of consecutive waves that
// share a restore layer. Fifteen wave rows is a listing; eight stage rows is
// something a person can read out. Nothing is invented: the categories and
// their counts are the engine's, and the reason on each row is the engine's own
// `categoryOrder[].rationale` for the category that DEBUTS in that stage, with
// its "First appears in wave N…" statistics tail removed.
function briefStages(deploy) {
  const waves = (deploy?.waves || []).filter((w) => w && (w.categories || []).length);
  if (!waves.length) return [];
  const order = (deploy?.categoryOrder || []).filter((c) => c && c.category);
  const rationaleOf = new Map(order.map((c) => [c.category,
    String(c.rationale || '').split(/\s*First appears in wave/)[0].trim()]));
  const firstWaveOf = new Map(order.map((c) => [c.category, c.firstWave]));
  const orderedCats = order.map((c) => c.category);

  const stages = [];
  for (const w of waves) {
    const last = stages[stages.length - 1];
    if (last && last.layer === (w.layer || '')) last.waves.push(w);
    else stages.push({ layer: w.layer || '', layerLabel: w.layerLabel || '', waves: [w] });
  }

  let prevLead = [];
  return stages.map((st) => {
    const from = st.waves[0].index;
    const to = st.waves[st.waves.length - 1].index;
    const counts = new Map();
    for (const w of st.waves) {
      for (const c of w.categories || []) {
        counts.set(c.category, (counts.get(c.category) || 0) + (c.items || []).length);
      }
    }
    // WHY this stage is here, in at most two of the engine's own sentences:
    //   the first category that DEBUTS in it (that is the new thing the stage
    //   exists to do — a category merely continuing from an earlier stage is
    //   not the reason for this one), then the BIGGEST category in it (that is
    //   where the stage's actual work is). One category is often both.
    const debut = orderedCats.filter((c) => counts.has(c)
      && firstWaveOf.get(c) >= from && firstWaveOf.get(c) <= to);
    const bySize = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (orderedCats.indexOf(a[0]) - orderedCats.indexOf(b[0])))
      .map(([c]) => c);
    const first = debut.length ? debut[0] : bySize[0];
    // The SECOND sentence skips anything the stage above already said. Without
    // this, four consecutive stages containing networking all read "The VPC,
    // subnets, routing and security groups have to exist…" and a reader learns
    // to skip the column. Falls back to repeating rather than going silent.
    const rest = bySize.filter((c) => c !== first);
    const second = rest.find((c) => !prevLead.includes(c)) ?? rest[0];
    const lead = [first, second].filter((c, i, a) => c && a.indexOf(c) === i);
    prevLead = lead;
    const why = lead.map((c) => rationaleOf.get(c)).filter(Boolean).join(' ');
    const est = st.waves.map((w) => w.estMinutes).filter(isNum);
    return {
      from,
      to,
      label: from === to ? `Wave ${from}` : `Waves ${from}–${to}`,
      layer: st.layer,
      layerLabel: st.layerLabel || LAYER_LABELS[st.layer] || '',
      itemCount: [...counts.values()].reduce((a, b) => a + b, 0),
      categories: [...counts.entries()]
        .sort((a, b) => (orderedCats.indexOf(a[0]) - orderedCats.indexOf(b[0])) || b[1] - a[1])
        .map(([c, n]) => `${categoryLabel(c)} (${n})`),
      leadCategories: lead.map(categoryLabel),
      why: why || `Everything at ${LAYER_LABELS[st.layer] || 'this restore layer'} — the engine placed these here `
        + 'from the dependency graph.',
      estMinutes: est.length ? Math.max(...est) : null,
      readinessGates: st.waves.reduce((n2, w) => n2 + (w.readinessGates || []).length, 0),
      reviewReasons: st.waves.flatMap((w) => w.reviewReasons || []),
    };
  });
}

// --------------------------------- 4. what has to be true before we start
//
// Two sources, both real: the deploy-order items the engine itself marked
// `action: 'verify'` — it will not pretend a partner allowlist is something you
// deploy in wave 3 — and the workspace's own Phase 0 checklist.
function briefPreconditions(d, deploy) {
  const externals = [];
  for (const w of deploy?.waves || []) {
    for (const c of w.categories || []) {
      for (const it of c.items || []) {
        if (String(it.action || '') !== 'verify') continue;
        const notes = (it.notes || []).filter(Boolean);
        // Every verify item carries the same generic "verify, don't create"
        // sentence. Drop it and take the longest of what is LEFT — that is the
        // engine's reasoning about THIS precondition. Fall back to the generic
        // one only when there is nothing else.
        const specific = notes.filter((t) => !/^Must already be true in the recovery region/i.test(t));
        const longest = (list) => list.slice().sort((a, b) => b.length - a.length)[0] || '';
        externals.push({
          name: it.name || it.id,
          wave: w.index,
          owner: it.owner || (it.componentId && ownerTeam(d.byId.get(it.componentId) || {})) || '',
          why: longest(specific) || longest(notes),
          scope: it.inRecoveryScope || '',
        });
      }
    }
  }
  externals.sort((a, b) => a.wave - b.wave || String(a.name).localeCompare(String(b.name)));

  // The call-order issues are the same kind of fact one step further on: a
  // service scheduled to start before something it calls at start-up. Narrowed
  // to the loaded component set — the engine reports them workspace-wide, and a
  // scoped brief that lists a problem with a service it does not otherwise
  // mention reads as a mistake.
  const inSlice = new Set((d.components || []).map((c) => String(c.id)));
  const callIssues = (deploy?.callOrderIssues || [])
    .filter((i) => i && i.severity !== 'low')
    .filter((i) => !d.scope || !i.componentId || inSlice.has(String(i.componentId)))
    .map((i) => ({
      name: `${i.componentName || i.componentId} → ${i.target}`,
      why: i.suggestion || i.why || '',
      severity: i.severity || 'medium',
    }));

  const phase0 = (d.checklists || []).filter((c) => String(c.kind || '') === 'phase0');
  const items = phase0.flatMap((c) => (c.items || []).map((i) => ({ ...i, list: c.name })));
  const open = items.filter((i) => !i.done);
  return {
    externals,
    callIssues,
    gate: phase0.length ? {
      names: phase0.map((c) => c.name),
      total: items.length,
      done: items.length - open.length,
      open: open.map((i) => ({
        text: i.text || '(untitled item)',
        why: briefSentence(i.why, 180),
        owner: i.owner || 'unassigned',
      })),
    } : null,
  };
}

// ------------------------------------------------------- 7. who does what
//
// Roles come from where they are actually written down: runbook step owners,
// the runbook audience, Phase 0 item owners. Each is matched against the
// contact list; a role with nobody behind it is REPORTED as such rather than
// dropped, because that is the interesting case — during an incident an
// unowned gate step is fifteen minutes spent finding a person.
function briefPeople(d) {
  const use = new Map();
  const note = (roleRaw, where) => {
    const role = String(roleRaw || '').trim();
    if (!role) return;
    const key = role.toLowerCase();
    if (!use.has(key)) use.set(key, { role, where: new Map() });
    const w = use.get(key).where;
    w.set(where, (w.get(where) || 0) + 1);
  };
  // Singular nouns: the counts are pluralised on render, so "1 runbook step".
  for (const rb of d.runbooks || []) {
    for (const s of [...(rb.steps || []), ...(rb.rollback || [])]) note(s.owner, 'runbook step');
    for (const s of rb.steps || []) if (s.gate) note(s.owner, 'GATE step');
  }
  for (const cl of d.checklists || []) {
    for (const i of cl.items || []) note(i.owner, 'Phase 0 item');
  }

  const contacts = d.contacts || [];
  const matches = (c, key) => {
    const hay = `${c.role || ''} ${c.name || ''} ${c.responsibilities || ''}`.toLowerCase();
    return key.split(/[-\s/]+/).filter((t) => t.length > 2).some((t) => hay.includes(t));
  };
  const total = (u) => [...u.where.values()].reduce((x, y) => x + y, 0);
  const rows = [];
  const claimed = new Map();
  for (const [key, u] of [...use.entries()].sort((a, b) => total(b[1]) - total(a[1]))) {
    const person = contacts.find((c) => matches(c, key)) || null;
    const where = [...u.where.entries()].map(([w, n]) => plural(n, w)).join(' · ');
    // Two role words resolving to the same human ("dr-lead" and "approver" are
    // both A. Rivera) are ONE row. Printing the same person twice on a page
    // this short is how a reader stops trusting the page.
    if (person && claimed.has(person.id)) {
      const prev = claimed.get(person.id);
      prev.role = `${prev.role} / ${u.role}`;
      prev.where = `${prev.where} · ${where}`;
      continue;
    }
    const row = {
      role: u.role,
      person: person ? `${person.name}${person.contact ? ` · ${person.contact}` : ''}` : 'NOBODY NAMED',
      does: person ? briefSentence(person.responsibilities, 180) : '',
      where,
      named: !!person,
    };
    if (person) claimed.set(person.id, row);
    rows.push(row);
  }
  // A contact no runbook step mentions still belongs on the page when they are
  // the escalation path — marked as not appearing in a procedure.
  for (const c of contacts) {
    if (claimed.has(c.id)) continue; // already on the page under a role word
    rows.push({
      role: c.role || '(role not recorded)',
      person: `${c.name}${c.contact ? ` · ${c.contact}` : ''}`,
      does: briefSentence(c.responsibilities, 180),
      where: 'in the contact list, not on any runbook step',
      named: true,
    });
  }
  return rows;
}

/**
 * The whole brief as data. `d` is a loaded (possibly scoped) dataset, `deploy`
 * the deploy-order engine's model or null, and `opts.env` / `opts.service` the
 * already-resolved environment / service when the caller has one (that is what
 * routes/exports.js passes straight through from the shared scope helper).
 *
 * Renderers: addFailoverBrief (the sheet) and briefMarkdown (the .md export).
 */
export function failoverBriefModel(d, deploy = null, opts = {}) {
  const subj = briefSubject(d, opts);
  const x = execModel(d);
  const stages = briefStages(deploy);
  const stats = deploy?.stats || {};
  return {
    subject: subj,
    subjectLabel: briefSubjectLabel(subj),
    generated: new Date().toISOString().slice(0, 10),
    madeOf: briefMadeOf(d, subj),
    order: {
      available: !!stages.length,
      stages,
      waveCount: stats.waveCount ?? (deploy?.waves || []).length,
      itemCount: stats.itemCount ?? null,
      cycleCount: stats.cycleCount ?? 0,
      unorderedCount: stats.unorderedCount ?? 0,
      chain: (deploy?.categoryOrder || []).map((c) => categoryLabel(c.category)),
    },
    before: briefPreconditions(d, deploy),
    // `scoped` says this brief describes a SLICE. The gap list and the
    // inventory below it are narrowed to that slice; the risk engine's digest
    // is not (computedRiskDigest only narrows for a single-component scope), so
    // both renderers say which is which rather than letting a reader assume the
    // headline count belongs to the slice.
    scoped: !!(subj.envName || subj.serviceName || subj.root || d.scope),
    breaks: { risks: x.risks, computed: x.computedRisks, openGapCount: x.openGapCount },
    numbers: x.numbers,
    tests: x.tests,
    people: briefPeople(d),
    inventory: x.inventory,
  };
}

/** The brief for one workspace, loaded and scoped. Backs the .md export. */
export async function failoverBrief(slug, scopeOpts = {}, opts = {}) {
  const d = loadData(slug, normalizeScope(scopeOpts));
  await attachComputedRisks(slug, d);
  const deploy = await loadDeployOrder(slug, scopeOpts || {});
  return failoverBriefModel(d, deploy, opts);
}

// --------------------------------------------------------------- the sheet
//
// Prose-and-table, not a tree: the visual grammar is the workbook's (teaching
// title in row 1, green header band in row 2, panes frozen at A3) but the
// content is meant to be read downward rather than expanded. One printable
// page — the print area stops at exactly the rows written.

function addFailoverBrief(wb, d, deploy, opts = {}) {
  const m = failoverBriefModel(d, deploy, opts);
  const s = m.subject;
  // Three columns, landscape, deliberately wide: the fewer times a sentence
  // wraps, the shorter the sheet is, and the less Excel has to shrink it to
  // keep the whole brief on the single page the print area asks for.
  const columns = [
    { header: 'The brief', width: 26, wrap: true },
    { header: 'What', width: 44, wrap: true },
    { header: 'Why it is this way — and what it costs you if it is wrong', width: 92, wrap: true },
  ];
  const ws = addSheet(wb, BRIEF_SHEET,
    // The title names the SYSTEM only: a scoped workbook already appends its own
    // "— adjudication service, Dev environment" suffix to every sheet title, and
    // the first row of the sheet says the scope in a full sentence either way.
    `How we fail this over — ${s.system}: what it is, what it is made of, the order it comes back in, `
    + 'and what has to be true before you start',
    columns, {
      gridLines: false,
      zoom: 100,
      print: { orientation: 'landscape', fitHeight: 0 },
      note: 'Read this page out loud and the room can follow the failover. Every sentence on it is derived from '
        + 'this workspace — the inventory, the resource graph, the deployment-order engine, the gap list and the '
        + 'risk rules. Nothing is written by hand and nothing is estimated: where the data is silent, the sheet '
        + 'says so. The detail behind each section is on the sheet it names.',
    });

  const section = (text) => groupRow(ws, columns, text, { size: 11 });
  const spacer = () => ws.addRow([]);

  // Excel does NOT auto-fit a row containing wrapped text (and never a merged
  // one), so every row here computes its own height from how many lines its
  // longest cell needs. Guessing one fixed height per row kind either clips a
  // sentence — which on THIS sheet means a reason nobody reads — or wastes
  // space the single-page print area cannot spare.
  const LINE_PT = 12.75;
  const linesFor = (text, chars) => Math.max(1, Math.ceil(String(text ?? '').length / Math.max(8, chars)));
  const heightFor = (cells) => Math.min(72, 4 + LINE_PT * Math.max(...cells.map(([t, w]) => linesFor(t, w))));
  const totalWidth = columns.reduce((a, c) => a + c.width, 0);

  const para = (text, { tint = null, height = null, bold = false } = {}) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, columns.length);
    const c = r.getCell(1);
    c.font = ARIAL({ bold, ...(tint ? { color: { argb: TINT[tint].font } } : { color: { argb: INK } }) });
    if (tint) c.fill = solid(TINT[tint].fill);
    c.alignment = { vertical: 'top', wrapText: true };
    r.height = height || heightFor([[text, totalWidth]]);
    return r;
  };
  const line = (label, what, why, { tint = null, bold = false, height = null } = {}) => {
    const r = ws.addRow([label, what, why]);
    r.getCell(1).font = ARIAL({ bold: true, color: { argb: INK } });
    r.getCell(1).alignment = { vertical: 'top', wrapText: true };
    const vc = r.getCell(2);
    vc.font = ARIAL({ bold, ...(tint ? { color: { argb: TINT[tint].font } } : {}) });
    vc.alignment = { vertical: 'top', wrapText: true };
    if (tint) vc.fill = solid(TINT[tint].fill);
    r.getCell(3).font = ARIAL({ color: { argb: MUTED } });
    r.getCell(3).alignment = { vertical: 'top', wrapText: true };
    r.height = height || heightFor(columns.map((c, i) => [[label, what, why][i], c.width]));
    return r;
  };
  const mins = (v) => (v == null ? null : `${v} min`);

  // ---------------------------------------------------- 1. what this is
  section('1 · WHAT THIS IS');
  para(`This workbook is the disaster-recovery plan for ${s.system}`
    + `${s.envName ? `, ${s.envName} environment` : ''}`
    + `${s.serviceName ? `, ${s.serviceName} service` : ''}`
    + `${!s.serviceName && s.root ? `, scoped to ${s.root.name} and everything it needs` : ''}`
    + ` — ${plural(s.componentCount, 'component')}, failing over from `
    + `${s.primaryRegion || 'an unrecorded primary region'} to ${s.recoveryRegion || 'an unrecorded recovery region'}`
    + `${s.strategyName ? ` on a ${briefLowerFirst(s.strategyName)} strategy` : ''}`
    + `${s.tooling.length ? `, using ${briefNameList(s.tooling, 3)}` : ''}.`, { bold: true });
  if (m.order.available) {
    para(`The order below is computed from the dependency graph — ${plural(m.order.itemCount || 0, 'item')} in `
      + `${plural(m.order.waveCount || 0, 'wave')} — not typed by hand. Everything on this page traces to a sheet `
      + `behind it: the inventory is ${SHEETS.graph}, the order is ${SHEETS.deploy}, the procedure is ${SHEETS.runbooks}.`,
    );
  } else {
    para('The deployment-order engine did not run for this workspace, so section 3 below is the restore-layer order '
      + `from the inventory rather than a computed build order. The ${SHEETS.deps} sheet is the detail behind it.`,
    { tint: 'warn' });
  }
  // One line, per the brief: subject · environment · service · region pair ·
  // strategy. It is deliberately NOT a five-row table — the sentence above
  // already said all of it, and this is the row someone points at.
  line(briefSubjectLabel(s),
    bits(`${s.primaryRegion || '?'} → ${s.recoveryRegion || '?'}`, s.strategyName || 'strategy not set'),
    bits(
      s.env?.isProduction ? 'THIS IS PRODUCTION' : null,
      s.envName ? null : (s.envCount
        ? `${plural(s.unassignedEnv, 'component')} here ${s.unassignedEnv === 1 ? 'is' : 'are'} in no environment`
        : 'no environments defined, so this is the whole system'),
      s.serviceName
        ? (bits(s.service?.tier != null ? `Tier ${s.service.tier}` : null, ownerTeam(s.service || {})) || null)
        : (s.serviceCount ? `${plural(s.serviceCount, 'service')} defined, all in scope here` : 'no services defined'),
      s.strategyOption ? `${s.strategyName} typically buys RTO ${s.strategyOption.rto}, RPO ${s.strategyOption.rpo} — the shape of the plan, not a promise` : null,
    ),
    { tint: s.env?.isProduction ? 'err' : (s.primaryRegion && s.recoveryRegion && s.strategyName ? null : 'warn') });

  // -------------------------------------------- 2. what it's made of
  spacer();
  section('2 · WHAT IT IS MADE OF, IN PLAIN LANGUAGE');
  if (m.madeOf.length) {
    for (const p of m.madeOf) para(p);
  } else {
    para('No components are recorded in this slice, so there is nothing to describe. Import an inventory first.',
      { tint: 'warn' });
  }

  // ------------------------------------------ 3. the order it comes back in
  spacer();
  section('3 · THE ORDER IT COMES BACK IN');
  if (m.order.available) {
    if (m.order.chain.length) {
      para(`Category order, the short answer: ${m.order.chain.join(' → ')}.`, { bold: true });
    }
    for (const st of m.order.stages) {
      line(`${st.label} · ${st.layerLabel || st.layer || 'layer not set'}`,
        st.categories.join(' · '),
        bits(st.why,
          st.readinessGates ? `${plural(st.readinessGates, 'readiness gate')} in here — "created" is not "Ready"` : null,
          isNum(st.estMinutes) ? `~${st.estMinutes} min, from your own runbook steps` : null,
          st.reviewReasons[0] || null),
        { tint: st.reviewReasons.length ? 'warn' : null });
    }
    if (m.order.cycleCount || m.order.unorderedCount) {
      // Only the holes that actually exist get named — "in 0 places" is the
      // kind of sentence that teaches a reader to stop reading the page.
      para(`${bits(
        m.order.cycleCount ? `The engine could not fully determine the order in ${plural(m.order.cycleCount, 'place')} (a dependency cycle)` : null,
        m.order.unorderedCount ? `${plural(m.order.unorderedCount, 'item')} could not be placed in any wave` : null,
      )}. Listed at the bottom of the ${SHEETS.deploy} sheet — an order with a flagged hole in it is safer than a `
        + 'clean-looking one that is wrong.', { tint: 'warn' });
    }
  } else {
    para(`Restore-layer order from the inventory: ${(m.inventory.byLayer || []).map(([l, n]) => `${l} (${n})`).join(' → ')}.`,
      );
  }

  // ----------------------------- 4. what has to be true before we start
  spacer();
  section('4 · WHAT HAS TO BE TRUE BEFORE WE START');
  const b = m.before;
  if (b.externals.length) {
    para(`${plural(b.externals.length, 'precondition')} cannot be built during the failover — `
      + `${b.externals.length === 1 ? 'it is' : 'they are'} verified, not created. Partner allowlists and `
      + 'egress-IP approvals have lead times measured in days, so they are started before the window opens.',
    );
    for (const e of b.externals.slice(0, 3)) {
      line(e.name, bits(`confirm before wave ${e.wave}`, e.owner || null) || 'confirm before you start',
        briefSentence(e.why, 220) || 'Recorded as verify-not-create by the deployment-order engine.',
        { tint: 'warn' });
    }
    if (b.externals.length > 3) {
      para(`${b.externals.length - 3} further verify-not-create ${b.externals.length - 3 === 1 ? 'precondition' : 'preconditions'} `
        + `(including the fence-before-promote checks on the data tier) are on the ${SHEETS.deploy} sheet, marked "verify".`,
      );
    }
  }
  for (const ci of b.callIssues.slice(0, 1)) {
    line(ci.name, `ordering issue · ${ci.severity}`, briefSentence(ci.why, 220),
      { tint: ci.severity === 'blocker' || ci.severity === 'high' ? 'err' : 'warn' });
  }
  if (b.gate) {
    line(b.gate.names.join(', '), `${b.gate.done} of ${b.gate.total} green`,
      b.gate.done === b.gate.total
        ? 'The gate is green. Re-read the freshness items at T0 anyway — "checked" goes stale.'
        : `${b.gate.total - b.gate.done} still open. The gate exists because each of these has failed a real test before.`,
      { tint: b.gate.done === b.gate.total ? 'ok' : 'err', bold: true });
    for (const i of b.gate.open.slice(0, 3)) {
      line('', i.text, bits(i.why, `owner: ${i.owner}`));
    }
    if (b.gate.open.length > 3) {
      para(`${b.gate.open.length - 3} further Phase 0 items are open — the full gate is on the ${SHEETS.workbench} sheet.`,
        );
    }
  } else if (!b.externals.length) {
    para('No Phase 0 checklist and no external preconditions are recorded. That is not the same as there being '
      + 'none — it means nobody has written down what must be true before the first recovery action.', { tint: 'warn' });
  }

  // ------------------------------------------------ 5. where it breaks today
  spacer();
  section('5 · WHERE IT BREAKS TODAY');
  const cr = m.breaks.computed;
  if (cr && cr.total) {
    para(`The risk engine found ${plural(cr.total, 'finding')} `
      + `(${cr.bySeverity.map(([sev, n]) => `${n} ${sev}`).join(' · ')}) across the `
      + `${plural(cr.scanned, 'service')} it scanned. `
      + (cr.blockerCount
        ? `${cr.blockerCount} ${cr.blockerCount === 1 ? 'is a blocker or a hole' : 'are blockers or holes'} in the `
          + 'restore order — this plan is NOT clean.'
        : 'None of them is a blocker or a hole in the restore order.')
      + (m.scoped && !m.subject.root
        ? ' That scan covers the whole workspace; the gap rows below are narrowed to this slice.' : ''),
    { tint: cr.blockerCount ? 'err' : 'ok' });
  } else if (!cr) {
    para('The computed risk engine could not be loaded, so what follows is the hand-written gap list only. An empty '
      + 'list below is not evidence of a clean plan.', { tint: 'warn' });
  }
  if (m.breaks.risks.length) {
    for (const r of m.breaks.risks.slice(0, 3)) {
      line(r.title, bits(r.severity, r.component),
        bits(`owner: ${r.owner}`, r.ticket || null, briefSentence(r.notes, 140)),
        { tint: r.severity === 'blocker' ? 'err' : r.severity === 'high' ? 'warn' : null });
    }
    if (m.breaks.openGapCount > 3) {
      para(`${m.breaks.openGapCount - 3} further open gaps are on the ${SHEETS.workbench} sheet.`, );
    }
  } else {
    para('No open gaps are written down. Either the plan is clean or the gaps have not been recorded — the '
      + 'risk-engine line above is the one that tells you which.', { tint: 'warn' });
  }

  // -------------------------------------------- 6. what we know and don't
  spacer();
  section('6 · WHAT WE KNOW, AND WHAT WE DO NOT');
  const n = m.numbers;
  // WHOSE target, and where it came from: the scoped service's BIA, the
  // environment's, or the workspace's proposal. `obj.why` is composed in
  // resolveObjectives so this sheet and the Executive Summary cannot word the
  // provenance differently.
  const obj = n.objective || { level: 'workspace', why: '', conflict: null };
  const targetWhy = obj.level === 'workspace'
    ? (n.approved ? 'Approved by the business' : 'NOT yet approved by the business — a proposal, not a commitment')
    : obj.why;
  line('RTO target', mins(n.rtoMinutes) || (obj.none ? 'none of its own' : 'not set'), targetWhy,
    { tint: n.rtoMinutes == null || !n.approved ? 'warn' : null });
  line('RPO target', mins(n.rpoMinutes) || (obj.none ? 'none of its own' : 'not set'), targetWhy,
    { tint: n.rpoMinutes == null || !n.approved ? 'warn' : null });
  if (obj.conflict) {
    line('Targets NOT reconciled', obj.conflict.workspaceValue, obj.conflict.text, { tint: 'warn' });
  }
  // A measured number is green only while it can be spoken of in the present
  // tense. Stale evidence, or a run that reached the bar by hand, is amber and
  // says so in the row label (measured.js `met-with-caveats` / isAchievement).
  const numberRow = (label, state, minutes, stamp, what) => {
    const measuredNow = state === 'measured' && !n.caveated;
    const rowLabel = state === 'measured'
      ? `${label} measured${n.caveated ? ' on a past run — not proven current' : ''}`
      : state === 'declared' ? `${label} recorded by hand` : `${label} unmeasured`;
    line(rowLabel,
      minutes == null ? 'not measured yet' : `${mins(minutes)}${stamp ? ` (${stamp})` : ''}`,
      join([what || '', state === 'measured' && n.caveated
        ? `Not a current capability: ${(n.evidenceCaveats || []).join(', and ')}.` : ''], ' '),
      { tint: measuredNow ? 'ok' : state === 'unmeasured' ? 'err' : 'warn' });
  };
  numberRow('RTA', n.rtaState, n.rtaMinutes, n.rtaStamp, n.rtaWhat);
  numberRow('RPA', n.rpaState, n.rpaMinutes, n.rpaStamp, n.rpaWhat);
  const passed = m.tests.filter((t) => t.status === 'passed').length;
  line('Tests on record', m.tests.length ? `${m.tests.length} · ${passed} passed` : 'none',
    m.tests.length
      ? `Most recent: ${m.tests[0].name}${m.tests[0].date ? ` (${m.tests[0].date})` : ''} — ${m.tests[0].statusLabel}`
        + `${m.tests[0].findings ? `, ${plural(m.tests[0].findings, 'finding')}` : ''}. Detail on ${SHEETS.tests}.`
      : 'An untested plan is a hypothesis. Nothing above can be defended until one passes.',
    { tint: passed ? null : 'err' });
  para('RTO and RPO are targets. RTA and RPA are evidence ONLY when a test that passed produced them — a number '
    + 'typed into settings is a note to self. When someone asks how fast you can recover, quote the measured number '
    + 'and name the test that produced it.', );

  // ------------------------------------------------------ 7. who does what
  spacer();
  section('7 · WHO DOES WHAT');
  if (m.people.length) {
    for (const p of m.people.slice(0, 5)) {
      line(p.role, p.person, bits(p.does, p.where), { tint: p.named ? null : 'err' });
    }
  } else {
    para('No owners are recorded on any runbook step and no contacts are listed. During an incident that means the '
      + 'first fifteen minutes go on finding people.', { tint: 'err' });
  }

  spacer();
  para(`Generated ${m.generated} by DR Compass from this workspace. Every sentence above is derived from the data — `
    + 'regenerate before a review, and read the sheet it points at before you disagree with it.', );

  // Fit the WIDTH to one page and let the height run to as many pages as the
  // content needs. Forcing `fitToHeight = 1` does produce literally one page,
  // but Excel gets there by scaling ~65 rows down to roughly 28% — about 3pt
  // on paper, which is the same way the Executive Summary sheet became
  // unreadable. A brief nobody can read in the meeting is not a brief.
  ws.pageSetup.printArea = `A1:${colLetter(columns.length)}${ws.rowCount}`;
  ws.pageSetup.fitToHeight = 0;
  return ws;
}

// ----------------------------------------------------------------- workbook

// buildWorkbook(slug) — whole workspace (unchanged output).
// buildWorkbook(slug, {componentIds, rootName, rootId, depsCount, dependentsCount})
// — a service package: every scoped sheet filtered to those components.
export async function buildWorkbook(slug, scopeOpts = {}) {
  const scope = normalizeScope(scopeOpts);
  const d = loadData(slug, scope);
  const wb = new ExcelJS.Workbook();
  if (scope) wb[SCOPE_KEY] = scope;
  // Print headers/footers read from here (see applyPrintSetup).
  wb[META_KEY] = {
    name: d.meta.name || slug,
    generated: new Date().toISOString().slice(0, 10),
    scopeLabel: scope?.rootName ? `${scope.rootName} service package` : '',
  };
  wb.creator = 'DR Compass';
  wb.created = new Date();
  wb.title = scope?.rootName
    ? `DR package — ${scope.rootName} (${d.meta.name || slug})`
    : `DR Compass — ${d.meta.name || slug}`;
  wb.company = d.meta.org || '';
  wb.description = 'Disaster recovery plan generated by DR Compass. '
    + 'RTO/RPO are targets; RTA/RPA are measured. Read the Executive Summary sheet first.';

  // Executive one-pager first: it is the sheet the workbook opens on.
  // Derived once and shared: Status / Status notes / Day-0? / In DR scope? mean
  // the same thing on every sheet because they come from one model.
  const sm = statusModel(d);
  // The deployment-order engine is a separate module and may not exist yet. If
  // it is missing or throws, its sheet is simply absent — the workbook always
  // builds. (loadDeployOrder never throws; see its try/catch.)
  const deploy = await loadDeployOrder(slug, scopeOpts || {});
  // The risk engine's findings, for the Executive Summary sheet (NEW-8). Never
  // throws: a workbook always builds, and the sheet says so if it is missing.
  await attachComputedRisks(slug, d);

  addExecutiveSummary(wb, d);
  addFailoverBrief(wb, d, deploy, { env: scopeOpts?.env || null, service: scopeOpts?.service || null });
  addHowToUse(wb, d, { deployOrder: !!(deploy?.waves || []).length });
  addResourceGraph(wb, d, sm);
  addRuntime(wb, d, sm);
  addOutboundCalls(wb, d, sm, deploy);
  addDependencies(wb, d, sm);
  addDeploymentOrder(wb, d, deploy, sm);
  addTests(wb, d);
  addRunbooks(wb, d);
  addWorkbench(wb, d, sm);


  // The high-level picture, plus the scope label on every sheet title. One
  // call, so this cannot be half-applied; it never throws.
  decorateWorkbook(wb, d, {
    scope: scopeOpts && Array.isArray(scopeOpts.componentIds) && scopeOpts.componentIds.length
      ? scopeOpts : null,
    deploy,
  });

  return wb;
}
