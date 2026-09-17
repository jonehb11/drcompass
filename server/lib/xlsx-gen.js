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
const LIST_SCOPE = '"Yes,Partial,No,Unknown"';
const LIST_SEVERITY = '"blocker,high,medium,low"';
const LIST_REPLICATED = '"yes,no,unknown"';
const LIST_GAP_STATUS = '"open,accepted,resolved"';

// Conditional-formatting rule sets: [cellValue, tintKind]
const CF_STATUS = [['Pass', 'ok'], ['Fail', 'err'], ['Blocked', 'err'], ['Partial', 'warn'], ['Not reached', 'warn']];
const CF_SEVERITY = [['blocker', 'err'], ['high', 'err'], ['medium', 'warn']];
const CF_GAP_STATUS = [['resolved', 'ok'], ['open', 'err'], ['accepted', 'warn']];
const CF_YES_DONE = [['Yes', 'ok']];
const CF_REPLICATED = [['yes', 'ok'], ['no', 'err'], ['unknown', 'warn']];
const CF_DECISION = [['decided', 'ok'], ['pending', 'warn']];
const CF_RESULT = [...CF_STATUS, ...CF_SEVERITY];

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

// Excel forbids / in worksheet names, so the tab reads "Egress — Outbound
// Calls" while the title row inside it keeps the "Egress / Outbound Calls" name.
const EGRESS_SHEET = 'Egress — Outbound Calls';

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

function loadData(slug, scope = null) {
  const meta = store.getWorkspace(slug);
  const d = { meta, assessment: store.getObject(slug, 'assessment') };
  d.resourceGraph = store.getObject(slug, 'resource-graph');
  d.k8s = store.getObject(slug, 'k8s');
  for (const c of store.COLLECTIONS) d[c] = store.getCollection(slug, c) || [];
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
  const ids = (opts?.componentIds || []).map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  return {
    ids: new Set(ids),
    rootId: opts.rootId || '',
    rootName: opts.rootName || '',
    depsCount: n(opts.depsCount),
    dependentsCount: n(opts.dependentsCount),
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
// ('Dependencies' and 'Executive Summary' are absent on purpose: they name the
// service in their own title, so the generic suffix would double it up.)
const SCOPED_SHEETS = new Set([
  'K8s Workloads', 'K8s Network',
  EGRESS_SHEET, 'Secrets Reconciliation', 'Gap List', 'Runbooks',
  'Runbook Steps', 'Test Log', 'Test Records', 'App Test Catalog',
  'Verification Catalog',
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
        join(c.gaps, '; '), c.notes || '',
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
    ],
    rows: (d) => d.runbooks.flatMap((rb) => [
      ...(rb.steps || []).map((s, i) => stepRow(rb.name, i + 1, s)),
      ...(rb.rollback || []).map((s, i) => stepRow(rb.name, `R${i + 1}`, s)),
    ]),
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

function stepRow(rbName, n, s) {
  return [rbName, n, s.layer || '', s.title || '', s.detail || '', s.command || '',
    s.verify || '', s.pass || '', s.owner || '', num(s.estMinutes),
    s.gate ? 'yes' : '', s.record || ''];
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
    ...(outline ? { properties: { outlineProperties: { summaryBelow: false, summaryRight: false } } } : {}),
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

// Sub-parent inside an outlined sheet (a resource-type or attachment group):
// bold, no fill, indented one step deeper than its parent.
function subGroupRow(ws, columns, text, {
  level = 1, hidden = false, indent = 0, color = INK, size = 10, merge = true,
} = {}) {
  const row = ws.addRow([text]);
  row.outlineLevel = level;
  if (hidden) row.hidden = true;
  row.height = 16;
  const cell = row.getCell(1);
  cell.font = ARIAL({ bold: true, size, color: { argb: color } });
  cell.alignment = { vertical: 'middle', horizontal: 'left', ...(indent ? { indent } : {}) };
  if (merge) ws.mergeCells(row.number, 1, row.number, columns.length);
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

// Flat table: shell + zebra rows + autoFilter + CF on selected columns.
function flatSheet(wb, name, {
  title, note, columns, rows, cf = {}, autoFilter = true, freezeCols = 0, print = null,
}) {
  if (!rows.length) return null;
  const ws = addSheet(wb, name, title, columns, { note, freezeCols, print });
  rows.forEach((r, i) => dataRow(ws, columns, r, { stripe: i % 2 === 1 }));
  const last = 2 + rows.length;
  for (const [idx, rules] of Object.entries(cf)) addCF(ws, Number(idx), 3, last, rules);
  if (autoFilter) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: last, column: columns.length } };
  return ws;
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

function sheetGuide(d) {
  const has = (arr) => arr && arr.length > 0;
  const rows = [
    ['Executive Summary', 'Read this first, and read nothing else if you have 90 seconds: what this covers, the DR strategy, the honest numbers (targets vs measured), the top risks with owners, the test history, and the next actions.', 'Computed from this workspace — nothing estimated'],
  ];
  if (has(d.components)) rows.push(['Dependencies', 'The centrepiece. Restore layer (L0 first) → service → what it depends on and what depends on it → its discovered resources, workloads and gaps. Dependency links are open when you arrive; resources sit collapsed behind the +/- handles in the left margin. Work the Status column as you verify each service.', 'Dependency links open; resources collapsed. Every Status = Not started']);
  if ((d.k8s?.workloads || []).length) rows.push(['K8s Workloads', 'Per-namespace workload census: readiness, images, service accounts, config/secret mounts, linked components.', 'Captured cluster snapshot']);
  if ((d.k8s?.services || []).length || (d.k8s?.ingresses || []).length) rows.push(['K8s Network', 'How traffic reaches workloads: Services with ports and targets, then Ingress hosts and backends.', 'Captured cluster snapshot']);
  if (d.components.some((c) => (c.outboundCalls || []).length)) rows.push([EGRESS_SHEET, 'Which workloads call out and to whom, per service. Confirm each failover behavior; chase critical third-party calls (allowlists, endpoints) before the next test.', 'Grouped by category then service; pods from the cluster snapshot']);
  if (d.components.some((c) => (c.secrets || []).length)) rows.push(['Secrets Reconciliation', 'Drive every Replicated cell to yes or no — one signed-off list. Unknowns are how recovery tests die.', 'Filled; unknowns highlighted']);
  if (has(d.gaps)) rows.push(['Gap List', 'Triage severity, attach tickets, move Status to resolved. Blockers stop the next test.', 'Open gaps from the workspace']);
  if (has(d.runbooks)) {
    rows.push(['Runbooks', 'Index of runbooks: tooling, scenario, audience, preconditions.', 'Filled from the workspace']);
    rows.push(['Runbook Steps', 'During an exercise, walk a runbook top to bottom. Gate steps must pass before you continue.', 'Grouped by runbook; rollback nested']);
  }
  if (has(d.tests)) {
    rows.push(['Test Log', 'One row per test or exercise. Keep Status and measured RTA/RPA honest — measured beats promised.', 'Filled from recorded tests']);
    if (d.tests.some((t) => (t.findings || []).length || (t.appTests || []).length || t.record)) {
      rows.push(['Test Records', 'Per-test detail: app-test results, findings, and the narrative record.', 'Grouped by test']);
    }
    if (d.tests.some((t) => (t.appTests || []).length)) {
      rows.push(['App Test Catalog', 'The application-level success bar — a business transaction completing, not infrastructure turning green.', 'Filled from tests']);
    }
  }
  if (d.checklists.some((c) => (c.items || []).length)) rows.push(['Checklists', 'Flip Done to Yes only with the proof in hand.', 'Grouped by checklist']);
  if (has(d.decisions)) rows.push(['Decision Log', 'Record decisions with context so they are not re-litigated mid-incident.', 'Filled from the workspace']);
  if (has(d.contacts)) rows.push(['People', 'Who does what; contact and escalation paths.', 'Filled from the workspace']);
  rows.push(['DR Options Matrix', 'Reference: the four DR strategies with honest RTO/RPO/cost/complexity ranges. Use it to sanity-check the strategy on the Executive Summary.', 'Static reference']);
  if (d.components.some((c) => c.verification?.command || c.verification?.pass)) {
    rows.push(['Verification Catalog', 'During recovery, run these top to bottom by restore layer — the proof that each layer actually came back.', 'Filled from the inventory']);
  }
  return rows;
}

function addHowToUse(wb, d) {
  const columns = [
    { header: 'Sheet', width: 24 },
    { header: 'What it is for, and what you do with it', width: 82, wrap: true },
    { header: 'How it arrives', width: 36, wrap: true },
  ];
  const ws = addSheet(wb, 'How to use',
    `How to use this workbook — what every sheet is for (${d.meta.name})`, columns, {
      note: 'Generated by DR Compass. Import into Excel or Google Sheets — dropdowns, tints, and row groups survive both.',
      gridLines: false,
    });
  sheetGuide(d).forEach((g, i) => {
    const row = dataRow(ws, columns, g, { stripe: i % 2 === 1 });
    row.getCell(1).font = ARIAL({ bold: true });
  });
  ws.addRow([]);

  groupRow(ws, columns, 'THE HONEST-NUMBERS RULE — IT GOVERNS EVERY SHEET HERE', { size: 11 });
  const hr = ws.addRow(['RTO/RPO are TARGETS the business signs off on. RTA/RPA are what your last test actually MEASURED. Until targets are formally approved and a test has hit them, quote only the measured RTA/RPA. A target nobody has tested is a hope, not a capability.']);
  ws.mergeCells(hr.number, 1, hr.number, columns.length);
  const hc = hr.getCell(1);
  hc.font = ARIAL({ italic: true, color: { argb: TINT.warn.font } });
  hc.fill = solid(TINT.warn.fill);
  hc.alignment = { vertical: 'top', wrapText: true };
  hr.height = 42;
  ws.addRow([]);
  const tip = ws.addRow(['Row groups: the +/- handles in the left margin of the Dependencies, Runbook Steps, Test Records and Checklists sheets expand and collapse detail. The numbered buttons above them (1 2 3 4) jump the whole sheet to one depth.']);
  ws.mergeCells(tip.number, 1, tip.number, columns.length);
  tip.getCell(1).font = ARIAL({ color: { argb: MUTED } });
  tip.getCell(1).alignment = { vertical: 'top', wrapText: true };
  tip.height = 28;
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

function execModel(d) {
  const meta = d.meta || {};
  const o = meta.objectives || {};
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
  const pick = (own, key) => {
    if (isNum(own)) return { value: own, source: 'workspace objectives' };
    if (withMeasure && withMeasure[key] != null) {
      return { value: withMeasure[key], source: `test "${withMeasure.name}"${withMeasure.date ? ` (${withMeasure.date})` : ''}` };
    }
    return { value: null, source: null };
  };
  const rta = pick(o.rtaMinutes, 'rtaMinutes');
  const rpa = pick(o.rpaMinutes, 'rpaMinutes');
  const rto = isNum(o.rtoMinutes) ? o.rtoMinutes : null;
  const rpo = isNum(o.rpoMinutes) ? o.rpoMinutes : null;
  const numbers = {
    rtoMinutes: rto,
    rpoMinutes: rpo,
    rtaMinutes: rta.value,
    rpaMinutes: rpa.value,
    rtaSource: rta.source,
    rpaSource: rpa.source,
    approved: !!o.approved,
    notes: o.notes || '',
    meetsRto: rto != null && rta.value != null ? rta.value <= rto : null,
    meetsRpo: rpo != null && rpa.value != null ? rpa.value <= rpo : null,
    measuredIn: withMeasure ? { name: withMeasure.name, date: withMeasure.date, status: withMeasure.statusLabel } : null,
  };

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
  for (const r of risks.filter((r) => r.severity === 'blocker').slice(0, 2)) {
    cand.push({
      action: `Close blocker — ${r.title}`,
      owner: r.owner,
      why: `Blocker on ${r.component}${r.ticket ? ` · ${r.ticket}` : ''}. The next test cannot pass around it.`,
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
  if (!numbers.approved && (rto != null || rpo != null)) {
    cand.push({
      action: 'Get the RTO / RPO targets signed off by the business',
      owner: 'unassigned',
      why: 'The targets are proposed only, so the measured RTA/RPA are currently the only defensible numbers.',
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
  const actions = cand.slice(0, 5);

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
    },
    service,
    numbers,
    risks,
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

/** The executive one-pager as data, for the .md in the DR Package. */
export function executiveSummaryModel(slug, scopeOpts = {}) {
  return execModel(loadData(slug, normalizeScope(scopeOpts)));
}

const minText = (v) => (v == null ? null : `${v} min`);

function addExecutiveSummary(wb, d) {
  const x = execModel(d);
  const columns = [
    { header: 'Item', width: 46, wrap: true },
    { header: 'Value', width: 22, wrap: true },
    { header: 'What it means', width: 76, wrap: true },
  ];
  const title = x.service
    ? `Executive summary — ${x.service.name}: what it needs to come back, the honest numbers, risks, next actions`
    : `Executive summary — ${x.workspace.name}: DR readiness in 90 seconds`;
  const ws = addSheet(wb, 'Executive Summary', title, columns, {
    gridLines: false,
    zoom: 100,
    print: { orientation: 'portrait' },
    note: 'Every value on this sheet is computed from this workspace. Targets read "not set" when nobody has set one; measurements read "unmeasured" until a test has produced one. Nothing here is estimated.',
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
  const para = (text, { tint = null, height = 30 } = {}) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, columns.length);
    const c = r.getCell(1);
    c.font = ARIAL(tint ? { color: { argb: TINT[tint].font } } : { color: { argb: MUTED } });
    if (tint) c.fill = solid(TINT[tint].fill);
    c.alignment = { vertical: 'top', wrapText: true };
    r.height = height;
    return r;
  };

  // ------------------------------------------------ 1. what this covers
  section(x.service ? 'THE SERVICE' : 'WHAT THIS COVERS');
  if (x.service) {
    const s = x.service;
    line(s.name, s.tier != null ? `Tier ${s.tier}` : 'Tier not set', {
      bold: true,
      tint: s.tier === 0 ? 'err' : null,
      note: join([s.kind, s.category], ' · ') || 'No kind recorded',
    });
    if (s.description) para(s.description, { height: 30 });
    line('Owner', s.owner, { note: 'Accountable for this service coming back' });
    line('Restore layer', s.layer || 'not set', {
      tint: s.layer ? null : 'warn',
      note: s.layerLabel === 'not set'
        ? 'No restore layer set — its position in the recovery order is undefined'
        : `${s.layerLabel} — everything in lower layers must be up first`,
    });
    line('In recovery scope', cap(s.inRecoveryScope), {
      tint: s.inRecoveryScope === 'yes' ? 'ok' : 'warn',
      note: s.inRecoveryScope === 'yes'
        ? 'Covered by the recovery tooling'
        : 'Not fully covered — decide this before the next test',
    });
    line('Recovery mechanism', join([strategyName(s.drStrategy), s.replication], ' · ') || 'not recorded', {
      tint: s.replication || s.drStrategy ? null : 'warn',
      note: s.rpoMinutes != null
        ? `Replication RPO ${s.rpoMinutes} min for this component`
        : 'No per-component RPO recorded',
    });
    line('Depends on', s.needs.length, {
      numFmt: '0', bold: true,
      tint: s.needs.length ? null : 'warn',
      note: s.needs.length
        ? `${s.needs.length} component(s) must come back before or with it — listed in restore order below`
        : 'Nothing recorded as a dependency, which is unusual — check the inventory',
    });
    line('Depended on by', s.neededBy.length, {
      numFmt: '0', bold: true,
      note: s.neededBy.length
        ? `${s.neededBy.length} component(s) break while this is down — that is the blast radius`
        : 'Nothing in the inventory declares a dependency on it',
    });
  } else {
    line(x.workspace.name, x.inventory.total, {
      bold: true, numFmt: '0',
      note: x.workspace.org ? `${x.workspace.org} — components tracked in this plan` : 'Components tracked in this plan',
    });
    if (x.workspace.description) para(x.workspace.description, { height: 42 });
  }
  line('Regions', `${x.workspace.primaryRegion || '?'} → ${x.workspace.recoveryRegion || '?'}`, {
    note: 'Primary region → recovery region',
  });
  line('DR strategy', x.workspace.strategyName || 'not set', {
    tint: x.workspace.strategyName ? null : 'warn',
    note: x.workspace.strategyOption
      ? `Typical for this strategy: RTO ${x.workspace.strategyOption.rto}, RPO ${x.workspace.strategyOption.rpo}. See the DR Options Matrix sheet.`
      : 'No strategy recorded on the workspace',
  });
  if (x.workspace.tooling.length) {
    x.workspace.tooling.forEach((t, i) => line(i === 0 ? 'Tooling' : '', t.key, { note: t.label }));
  } else {
    line('Tooling', 'none recorded', { tint: 'warn', note: 'No recovery tooling recorded on the workspace' });
  }
  line('Generated', x.workspace.generated, {
    note: 'A point-in-time snapshot — regenerate before a test or a review',
  });
  spacer();

  // ------------------------------- 2. what it needs to come back (scoped)
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
    } else {
      para('No dependencies are recorded for this service. Either it truly stands alone, or the inventory is incomplete — worth confirming before the next test.', { tint: 'warn' });
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

  // ------------------------------------------------- 3. the honest numbers
  section('THE HONEST NUMBERS — TARGETS VS MEASURED');
  line('RTO target', minText(x.numbers.rtoMinutes) ?? 'not set', {
    tint: x.numbers.rtoMinutes == null ? 'warn' : null,
    note: x.numbers.rtoMinutes == null
      ? 'No target recorded — the business has not said how long it can be down'
      : `How long the business says it can be down${x.numbers.approved ? ', approved' : ' (proposed, not yet approved)'}`,
  });
  line('RPO target', minText(x.numbers.rpoMinutes) ?? 'not set', {
    tint: x.numbers.rpoMinutes == null ? 'warn' : null,
    note: x.numbers.rpoMinutes == null
      ? 'No target recorded — the business has not said how much data it can lose'
      : `How much data the business says it can lose${x.numbers.approved ? ', approved' : ' (proposed, not yet approved)'}`,
  });
  line('RTA measured', minText(x.numbers.rtaMinutes) ?? 'unmeasured', {
    bold: true,
    tint: x.numbers.rtaMinutes == null ? 'warn' : (x.numbers.meetsRto === false ? 'err' : x.numbers.meetsRto ? 'ok' : null),
    note: x.numbers.rtaMinutes == null
      ? 'No recovery test has produced a time to restore — this is the number you cannot yet defend'
      : `Actually achieved, per ${x.numbers.rtaSource}`
        + (x.numbers.meetsRto === true ? ' — inside the RTO target' : '')
        + (x.numbers.meetsRto === false ? ` — OVER the ${x.numbers.rtoMinutes} min target` : ''),
  });
  line('RPA measured', minText(x.numbers.rpaMinutes) ?? 'unmeasured', {
    bold: true,
    tint: x.numbers.rpaMinutes == null ? 'warn' : (x.numbers.meetsRpo === false ? 'err' : x.numbers.meetsRpo ? 'ok' : null),
    note: x.numbers.rpaMinutes == null
      ? 'No recovery test has produced a data-loss measurement'
      : `Actual data age at the recovery point, per ${x.numbers.rpaSource}`
        + (x.numbers.meetsRpo === true ? ' — inside the RPO target' : '')
        + (x.numbers.meetsRpo === false ? ` — OVER the ${x.numbers.rpoMinutes} min target` : ''),
  });
  line('Targets approved by the business', yn(x.numbers.approved), {
    tint: x.numbers.approved ? 'ok' : 'warn',
    list: LIST_YESNO,
    note: x.numbers.approved
      ? 'Signed off, so the targets are commitments'
      : 'Not signed off, so quote only the measured numbers above',
  });
  if (x.numbers.measuredIn) {
    line('Measured in', x.numbers.measuredIn.date || 'undated', {
      note: `${x.numbers.measuredIn.name} — result: ${x.numbers.measuredIn.status}`,
    });
  }
  if (x.numbers.notes) para(x.numbers.notes, { height: 30 });
  para('RTO/RPO are targets. RTA/RPA are evidence. A target nobody has met is not a recovery capability.',
    { tint: 'warn', height: 18 });
  spacer();

  // ----------------------------------------------------------- 4. top risks
  section(`TOP RISKS — WORST FIRST${x.openGapCount > x.risks.length ? ` (${x.risks.length} of ${x.openGapCount} open; all of them on the Gap List sheet)` : ''}`);
  if (x.risks.length) {
    bandHeader(ws, ['Risk', 'Severity', 'Owner · component · ticket']);
    x.risks.forEach((r, i) => {
      const row = dataRow(ws, columns, [
        r.title, r.severity, join([r.owner, r.component, r.ticket], ' · '),
      ], { stripe: i % 2 === 1 });
      row.getCell(2).alignment = { vertical: 'top', horizontal: 'center' };
    });
    addCF(ws, 2, ws.rowCount - x.risks.length + 1, ws.rowCount, CF_SEVERITY);
  } else {
    para('No open gaps are recorded. Either the plan is genuinely clean, or nobody has written the gaps down — the Gap List sheet is where they belong.', { tint: 'warn', height: 18 });
  }
  spacer();

  // ------------------------------------------------------- 5. test history
  section('TEST HISTORY — WHAT HAS ACTUALLY BEEN PROVEN');
  if (x.tests.length) {
    bandHeader(ws, ['Test', 'Result', 'Measured']);
    x.tests.slice(0, 6).forEach((t, i) => {
      const measured = join([
        t.rtaMinutes != null ? `RTA ${t.rtaMinutes} min` : 'RTA unmeasured',
        t.rpaMinutes != null ? `RPA ${t.rpaMinutes} min` : 'RPA unmeasured',
        t.cleanRun === true ? 'clean run' : t.cleanRun === false ? 'not a clean run' : '',
        t.findings ? plural(t.findings, 'finding') : 'no findings',
      ], ' · ');
      const row = dataRow(ws, columns, [
        join([t.name, t.date ? `(${t.date})` : ''], ' '), t.statusLabel, measured,
      ], { stripe: i % 2 === 1 });
      row.getCell(2).alignment = { vertical: 'top', horizontal: 'center' };
    });
    addCF(ws, 2, ws.rowCount - Math.min(6, x.tests.length) + 1, ws.rowCount, CF_STATUS);
  } else {
    para('No recovery tests have been recorded. An untested plan is a hypothesis: nothing on the honest-numbers rows above can be defended yet.', { tint: 'err', height: 18 });
  }
  spacer();

  // ------------------------------------------------------ 6. next actions
  section('NEXT ACTIONS — DERIVED FROM THE DATA ABOVE');
  if (x.actions.length) {
    bandHeader(ws, ['Action', 'Owner', 'Why now']);
    x.actions.forEach((a, i) => dataRow(ws, columns, [`${i + 1}. ${a.action}`, a.owner, a.why],
      { stripe: i % 2 === 1 }));
  } else {
    para('No actions fall out of the current data — no open blockers, targets approved, tests passing, scope decided.', { height: 18 });
  }

  // Printing stops here: this is the one-pager. The detail below is for
  // whoever scrolls, not for the meeting.
  const onePagerEnd = ws.rowCount;
  ws.pageSetup.printArea = `A1:${colLetter(columns.length)}${onePagerEnd}`;

  spacer();
  para('— Detail below this line is not part of the printed one-pager —', { height: 16 });
  spacer();

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
  if (x.gapsBySeverity.length) {
    for (const [sev, n] of x.gapsBySeverity) {
      line(sev, n, { numFmt: '0', tint: sev === 'blocker' || sev === 'high' ? 'err' : sev === 'medium' ? 'warn' : null });
    }
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

// ------------------------------------- Dependencies (the centrepiece sheet)
//
// One sheet, four outline levels, spined on the RESTORE LAYER so the sheet
// reads top-to-bottom as the recovery order — what has to come back first,
// then what comes next:
//
//   L0 RESTORE LAYER  →  L1 COMPONENT  →  L2 attachment group  →  L3 the rows
//
// Two things make it readable rather than merely correct:
//   * every row carries its owning component in column B (frozen), so a row
//     found deep in the sheet is never orphaned — you always know whose it is;
//   * the hierarchy is indented as well as outlined, so the shape is visible
//     without touching the +/- handles.
//
// The "Dependencies" attachment group (depends-on, then used-by) arrives
// EXPANDED — that is the question the sheet exists to answer. Discovered
// resources, workloads and gaps arrive collapsed behind the handles.

const DEP_STATUS_COL = 11;
const NOT_STARTED = 'Not started';

function addDependencies(wb, d) {
  if (!d.components.length) return null;
  const columns = [
    { header: 'Layer', width: 8, align: 'center' },
    { header: 'Component', width: 28, indentable: true },
    { header: 'Attached resource / dependency / gap', width: 40, indentable: true },
    { header: 'Relation', width: 18 },
    { header: 'Tier', width: 6, align: 'center', numFmt: '0' },
    { header: 'Category / kind', width: 22 },
    { header: 'In scope?', width: 11, align: 'center', list: LIST_SCOPE },
    { header: 'DR strategy', width: 15 },
    { header: 'Replication', width: 20 },
    { header: 'RPO (min)', width: 10, align: 'right', numFmt: '0' },
    { header: 'Status', width: 13, align: 'center', list: LIST_STATUS },
    { header: 'Owner / team', width: 20 },
    // Real ARNs run past 110 characters and the Region column to its right is
    // populated, so without wrapping they are silently truncated on screen.
    // These rows are already tall (Key details wraps), so wrapping is free.
    { header: 'Resource ID / defined in', width: 46, mono: true, link: true, wrap: true },
    { header: 'Region', width: 12 },
    { header: 'Key details / notes', width: 52, wrap: true },
  ];

  const rootId = d.scope?.rootId || '';
  const rootName = (rootId && d.byId.get(rootId)?.name) || d.scope?.rootName || '';
  const title = rootName
    ? `Dependencies — what ${rootName} needs to come back, in restore order (L0 first)`
    : 'Dependencies — what each service needs to come back, in restore order (L0 first)';
  const ws = addSheet(wb, 'Dependencies', title, columns, {
    outline: true,
    freezeCols: 2,
    note: 'Restore layer → service → what it depends on and what depends on it, then its discovered '
      + 'resources, workloads and gaps. Layers run L0 first: everything in a lower layer must be up before '
      + 'the layer below it. Dependency links are open on arrival; the rest sits behind the +/- handles in '
      + 'the left margin (the 1 2 3 4 buttons above them jump the whole sheet to one depth). Column B repeats '
      + 'the owning component on every row, and columns A-B are frozen, so no row is ever orphaned. '
      + 'Status is your working column — it starts at "Not started".',
  });

  const g = graphModel(d);
  const nodesOf = (cid) => (g ? g.byComponent.get(cid) || [] : []);
  const workloadsOf = (cid) => (d.k8s?.workloads || []).filter((w) => w.componentId === cid);
  const gapsOf = (cid) => d.gaps.filter((x) => x.componentId === cid);

  const kindText = (c) => join([c.category, c.kind], ' · ');

  // The component's own row: its recovery posture, at indent 1.
  const componentRow = (c, { isRoot = false, stripe = false } = {}) => {
    const row = dataRow(ws, columns, [
      c.restoreLayer || '', c.name, '', isRoot ? 'this service' : '',
      num(c.tier), kindText(c), cap(c.inRecoveryScope || 'unknown'),
      strategyName(c.drStrategy), c.replication?.mechanism || '',
      num(c.replication?.rpoMinutes), NOT_STARTED, ownerTeam(c),
      c.definedIn || '', '', c.notes || '',
    ], { level: 1, stripe, indent: 1 });
    const name = row.getCell(2);
    name.font = ARIAL({ bold: true, color: { argb: INK } });
    if (isRoot) {
      name.fill = solid(TINT.ok.fill);
      row.getCell(4).font = ARIAL({ bold: true, color: { argb: TINT.ok.font } });
    }
    return row;
  };

  // A row hanging off a component: column B repeats the owner, column C names
  // the thing itself. Everything else is filled in only where it means
  // something for this kind of row.
  const attachedRow = (ownerName, cells, { hidden, stripe }) => {
    const row = dataRow(ws, columns, cells, { level: 3, hidden, stripe, indent: 3 });
    row.getCell(2).value = ownerName;
    row.getCell(2).font = ARIAL({ color: { argb: MUTED } });
    row.getCell(2).alignment = { vertical: 'top', indent: 2 };
    return row;
  };

  // L2 group header + its L3 rows. `open` keeps the dependency block visible.
  const attachGroup = (ownerName, label, rows, { open = false } = {}) => {
    if (!rows.length) return;
    const gr = subGroupRow(ws, columns, label, {
      level: 2, hidden: !open, indent: 2, color: MUTED, size: 9, merge: false,
    });
    gr.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
    rows.forEach((cells, i) => attachedRow(ownerName, cells, {
      hidden: !open, stripe: i % 2 === 1,
    }));
  };

  // A dependency / dependent: shown with ITS OWN layer and posture, because
  // that is what tells you whether it will be there when you need it.
  const linkCells = (id, relation) => {
    const dep = d.byId.get(id);
    if (!dep) return ['', '', id, relation, '', '(not in inventory)', '', '', '', '', '', '', '', '', ''];
    return [
      dep.restoreLayer || '', '', dep.name, relation, num(dep.tier), kindText(dep),
      cap(dep.inRecoveryScope || 'unknown'), strategyName(dep.drStrategy),
      dep.replication?.mechanism || '', num(dep.replication?.rpoMinutes), '',
      ownerTeam(dep), dep.definedIn || '', '', dep.notes || '',
    ];
  };

  const resourceCells = (n, cid) => [
    '', '', n.name || n.rid || '', g.relationFor(n, cid), '', n.type || '',
    '', '', '', '', '', '', n.arn || n.rid || '', n.region || '',
    join([kvText(n.details, ': '), n.source ? `via ${n.source}` : ''], ' · '),
  ];

  // Group components by restore layer (L0 first), then category, tier, name.
  const layers = new Map();
  for (const c of d.components) {
    const k = c.restoreLayer || '';
    if (!layers.has(k)) layers.set(k, []);
    layers.get(k).push(c);
  }
  const catRank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c.category || 'other');
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  const layerKeys = [...layers.keys()].sort((a, b) => layerOrder(a) - layerOrder(b));

  for (const layer of layerKeys) {
    const comps = layers.get(layer).sort((a, b) => catRank(a) - catRank(b)
      || (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name));
    const resourceCount = comps.reduce((n, c) => n + nodesOf(c.id).length, 0);
    const parts = [plural(comps.length, 'component')];
    if (resourceCount) parts.push(plural(resourceCount, 'attached resource'));
    const label = layer
      ? (LAYER_LABELS[layer] || layer)
      : 'RESTORE LAYER NOT SET — position in the recovery order undefined';
    groupRow(ws, columns, `${label} — ${parts.join(' · ')}`, { size: 11, merge: false });

    let stripe = 0;
    for (const c of comps) {
      const isRoot = !!rootId && c.id === rootId;
      componentRow(c, { isRoot, stripe: stripe++ % 2 === 1 });

      // 1. Dependencies first, and open — this is the question people came for.
      const depIds = c.dependsOn || [];
      const userIds = d.usedByIds.get(c.id) || [];
      const depLabel = `Dependencies — needs ${depIds.length}, needed by ${userIds.length}`;
      attachGroup(c.name, depLabel, [
        ...depIds.map((id) => linkCells(id, 'depends on')),
        ...userIds.map((id) => linkCells(id, 'used by')),
      ], { open: true });

      // 2. Gaps filed against it (inline notes + workspace gap items).
      const gapRows = [
        ...(c.gaps || []).map((t) => ['', '', t, 'gap note', '', '', '', '', '', '', '', '', '', '', '']),
        ...gapsOf(c.id).map((x) => [
          '', '', x.title || '', `gap · ${x.status || 'open'}`, '', x.severity || '',
          '', '', '', '', '', '', x.ticket || '', '', x.notes || '',
        ]),
      ];
      attachGroup(c.name, `Gaps (${gapRows.length})`, gapRows, { open: isRoot });

      // 3. Kubernetes workloads linked to it.
      const workloads = workloadsOf(c.id);
      attachGroup(c.name, `Workloads (${workloads.length})`, workloads.map((w) => [
        '', '', w.name || '', 'k8s workload', '', w.kind || '', '', '', '', '', '', '',
        w.namespace || '', '',
        join([readyText(w) ? `${readyText(w)} ready` : '', join(w.images)], ' · '),
      ]), { open: isRoot });

      // 4. Discovered AWS resources, by resource type.
      for (const grp of groupGraphNodes(nodesOf(c.id))) {
        attachGroup(c.name, `${grp.label} (${grp.nodes.length})`,
          grp.nodes.map((n) => resourceCells(n, c.id)), { open: isRoot });
      }
    }
  }

  // Discovered resources nobody has linked to a component. They used to live on
  // a separate Resource Graph sheet; they belong here, at the end, where the
  // question "whose is this?" is the whole point.
  if (g?.unlinked.length) {
    groupRow(ws, columns,
      `UNLINKED DISCOVERED RESOURCES — ${plural(g.unlinked.length, 'resource')} not linked to any component`,
      { size: 11, merge: false });
    for (const grp of groupGraphNodes(g.unlinked)) {
      attachGroup('(unlinked)', `${grp.label} (${grp.nodes.length})`,
        grp.nodes.map((n) => resourceCells(n, null)));
    }
  }

  addCF(ws, DEP_STATUS_COL, 3, ws.rowCount, CF_STATUS);
  addCF(ws, 7, 3, ws.rowCount, [['No', 'err'], ['Partial', 'warn'], ['Unknown', 'warn'], ['Yes', 'ok']]);
  filterAll(ws, columns.length);
  return ws;
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

function addK8sWorkloads(wb, d) {
  if (!hasK8s(d) || !(d.k8s.workloads || []).length) return null;
  const k = d.k8s;
  const columns = [
    { header: 'Namespace', width: 22 },
    { header: 'Kind', width: 13 },
    { header: 'Name', width: 30 },
    { header: 'Ready', width: 10, align: 'center' },
    { header: 'Images', width: 46, wrap: true },
    { header: 'Service Account', width: 20 },
    { header: 'ConfigMaps', width: 28, wrap: true },
    { header: 'Secrets', width: 28, wrap: true },
    { header: 'Linked Component', width: 26, link: true },
  ];
  const bits = [];
  if (k.clusterName) bits.push(k.clusterName);
  if (k.capturedAt) bits.push(`captured ${String(k.capturedAt).slice(0, 10)}`);
  if (k.nodes?.count != null) {
    bits.push(`${plural(k.nodes.count, 'node')}${k.nodes.readyCount != null ? ` (${k.nodes.readyCount} ready)` : ''}`);
  }
  const ws = addSheet(wb, 'K8s Workloads',
    `K8s Workloads — what runs in the cluster and which component owns it${bits.length ? ` · ${bits.join(' · ')}` : ''}`,
    columns, {
      outline: true,
      freezeCols: 1,
      note: 'Cluster snapshot grouped by namespace. Ready is desired vs actually-ready replicas at capture time.',
    });

  const byNs = new Map();
  for (const w of k.workloads) {
    const ns = w.namespace || 'default';
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(w);
  }
  const declared = (k.namespaces || []).map((n) => n.name).filter((n) => byNs.has(n));
  const nsOrder = [...declared, ...[...byNs.keys()].filter((n) => !declared.includes(n))];

  for (const ns of nsOrder) {
    const items = byNs.get(ns);
    groupRow(ws, columns, `${ns} — ${plural(items.length, 'workload')}`, { merge: false });
    items.forEach((w, i) => {
      const row = dataRow(ws, columns, [
        w.namespace || '', w.kind || '', w.name || '', readyText(w),
        join(w.images), w.serviceAccount || '', join(w.configmaps), join(w.secrets),
        d.nameOf(w.componentId),
      ], { level: 1, stripe: i % 2 === 1 });
      const des = w.replicas?.desired ?? 0;
      const rdy = w.replicas?.ready ?? 0;
      if (des > 0) {
        const kind = rdy >= des ? 'ok' : rdy === 0 ? 'err' : 'warn';
        const cell = row.getCell(4);
        cell.fill = solid(TINT[kind].fill);
        cell.font = ARIAL({ color: { argb: TINT[kind].font } });
      }
    });
  }
  filterAll(ws, columns.length);
  return ws;
}

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

function addK8sNetwork(wb, d) {
  if (!hasK8s(d)) return null;
  const services = d.k8s.services || [];
  const ingresses = d.k8s.ingresses || [];
  if (!services.length && !ingresses.length) return null;
  const columns = [
    { header: 'Namespace', width: 22 },
    { header: 'Service', width: 28 },
    { header: 'Type', width: 24 },
    { header: 'Ports', width: 34, wrap: true },
    { header: 'Targets', width: 44, wrap: true },
  ];
  // No autoFilter here: the sheet carries two stacked tables (Services, then a
  // second green band for Ingress), and one filter range cannot span both.
  const ws = addSheet(wb, 'K8s Network',
    'K8s Network — how traffic reaches the workloads: Services first, then Ingress', columns, {
      note: 'How traffic reaches workloads: Services (ports → target workloads) first, then Ingress hosts and backends.',
    });
  const nameByUid = new Map((d.k8s.workloads || []).map((w) => [w.uid, w.name]));
  services.forEach((s, i) => dataRow(ws, columns, [
    s.namespace || '', s.name || '', s.type || '', fmtPorts(s.ports),
    join((s.targets || []).map((uid) => nameByUid.get(uid) || uid)),
  ], { stripe: i % 2 === 1 }));
  if (ingresses.length) {
    ws.addRow([]);
    bandHeader(ws, ['Namespace', 'Ingress', 'Hosts', 'Backends']);
    ingresses.forEach((x, i) => dataRow(ws, columns, [
      x.namespace || '', x.name || '',
      join(Array.isArray(x.hosts) ? x.hosts : x.hosts ? [x.hosts] : []),
      fmtBackends(x.backends), '',
    ], { stripe: i % 2 === 1 }));
  }
  return ws;
}

// ------------------------------------------------ Runbook Steps (outlined)

function addRunbookSteps(wb, d) {
  if (!d.runbooks.some((rb) => (rb.steps || []).length || (rb.rollback || []).length)) return null;
  const columns = [
    { header: '#', width: 6, align: 'center' },
    { header: 'Layer', width: 7, align: 'center' },
    { header: 'Step', width: 30, wrap: true },
    { header: 'Detail', width: 48, wrap: true },
    { header: 'Command', width: 40, wrap: true },
    { header: 'Verify', width: 30, wrap: true },
    { header: 'Pass when', width: 28, wrap: true },
    { header: 'Owner', width: 13 },
    { header: 'Est (min)', width: 10, align: 'right', numFmt: '0' },
    { header: 'Gate', width: 8, align: 'center', list: LIST_YESNO },
    { header: 'Record', width: 24, wrap: true },
  ];
  // Printed and worked from during an exercise: landscape, fit to one page
  // wide, header rows repeated on every page.
  const ws = addSheet(wb, 'Runbook Steps',
    'Runbook Steps — work top to bottom during an exercise; a GATE step must pass before you continue',
    columns, {
      outline: true,
      freezeCols: 1,
      print: { orientation: 'landscape' },
      note: 'Grouped by runbook; rollback steps nested one level deeper. Gate = Yes means do not proceed until the verify passes.',
    });

  const row = (s, n, level, stripe) => dataRow(ws, columns, [
    n, s.layer || '', s.title || '', s.detail || '', s.command || '',
    s.verify || '', s.pass || '', s.owner || '', num(s.estMinutes),
    yn(!!s.gate), s.record || '',
  ], { level, stripe });

  for (const rb of d.runbooks) {
    const steps = rb.steps || [];
    const rollback = rb.rollback || [];
    const est = steps.reduce((n, s) => n + (s.estMinutes || 0), 0);
    const parts = [plural(steps.length, 'step')];
    if (est) parts.push(`~${est} min est`);
    if (rollback.length) parts.push(`${plural(rollback.length, 'rollback step')}`);
    groupRow(ws, columns, `${rb.name}${rb.scopeGeneric ? ' (generic)' : ''} — ${parts.join(' · ')}`, { merge: false });
    steps.forEach((s, i) => row(s, i + 1, 1, i % 2 === 1));
    if (rollback.length) {
      groupRow(ws, columns, `ROLLBACK — ${plural(rollback.length, 'step')}`, { level: 1, merge: false });
      rollback.forEach((s, i) => row(s, `R${i + 1}`, 2, i % 2 === 1));
    }
  }
  addCF(ws, 10, 3, ws.rowCount, [['Yes', 'warn']]);
  filterAll(ws, columns.length);
  return ws;
}

// -------------------------------------------------- Test Records (outlined)

function addTestRecords(wb, d) {
  if (!d.tests.some((t) => (t.appTests || []).length || (t.findings || []).length || t.record)) return null;
  const columns = [
    { header: 'Kind', width: 11 },
    { header: 'Item', width: 42, wrap: true },
    { header: 'Command', width: 38, wrap: true },
    { header: 'Expected / Detail', width: 38, wrap: true },
    { header: 'Result', width: 12, list: LIST_STATUS },
    { header: 'Ticket', width: 12, link: true },
  ];
  const ws = addSheet(wb, 'Test Records',
    'Test Records — per test: what the app checks returned, what was found, and the written record',
    columns, {
      outline: true,
      note: 'One collapsible block per test: app-test results, findings, and the narrative record.',
    });

  for (const t of d.tests) {
    const status = TEST_STATUS_DISPLAY[t.status] || t.status || '';
    groupRow(ws, columns, [t.name, t.type, status, t.date].filter(Boolean).join(' · '), { merge: false });
    let stripe = 0;
    for (const a of t.appTests || []) {
      dataRow(ws, columns, [
        'App test', a.name || '', a.command || '', a.expected || '',
        a.result ? (TEST_STATUS_DISPLAY[a.result] || cap(a.result)) : '', '',
      ], { level: 1, stripe: stripe++ % 2 === 1 });
    }
    for (const f of t.findings || []) {
      dataRow(ws, columns, [
        'Finding', f.title || '', '', '', f.severity || '', f.ticket || '',
      ], { level: 1, stripe: stripe++ % 2 === 1 });
    }
    if (t.record) {
      const r = dataRow(ws, columns, ['Record', t.record, '', '', '', ''], { level: 1 });
      ws.mergeCells(r.number, 2, r.number, columns.length);
      const cell = r.getCell(2);
      cell.font = ARIAL({ italic: true });
      cell.alignment = { vertical: 'top', wrapText: true };
      r.height = Math.min(220, Math.max(15, Math.ceil(String(t.record).length / 150) * 13));
    }
  }
  addCF(ws, 5, 3, ws.rowCount, CF_RESULT);
  filterAll(ws, columns.length);
  return ws;
}

// ---------------------------------------------------- Checklists (outlined)

function addChecklists(wb, d) {
  if (!d.checklists.some((cl) => (cl.items || []).length)) return null;
  const columns = [
    { header: 'Done', width: 10, align: 'center', list: LIST_YESNO },
    { header: 'Item', width: 48, wrap: true },
    { header: 'Why it matters', width: 44, wrap: true },
    { header: 'Proof required', width: 36, wrap: true },
    { header: 'Owner', width: 15 },
  ];
  // Printed and ticked off by hand before a test: landscape, one page wide.
  const ws = addSheet(wb, 'Checklists',
    'Checklists — flip Done to Yes only with the proof in hand', columns, {
      outline: true,
      print: { orientation: 'landscape' },
      note: 'Grouped by checklist. Flip Done to Yes only with the proof in hand.',
    });
  for (const cl of d.checklists) {
    const items = cl.items || [];
    if (!items.length) continue;
    const done = items.filter((it) => it.done).length;
    groupRow(ws, columns, `${cl.name} · ${cl.kind || 'custom'} · ${done}/${items.length} done`, { merge: false });
    items.forEach((it, i) => dataRow(ws, columns, [
      yn(!!it.done), it.text || '', it.why || '', it.proof || '', it.owner || '',
    ], { level: 1, stripe: i % 2 === 1 }));
  }
  addCF(ws, 1, 3, ws.rowCount, CF_YES_DONE);
  filterAll(ws, columns.length);
  return ws;
}

// -------------------------------------------------------- flat sheet specs

// ------------------------------------------- Egress / Outbound Calls (tree)
//
// "Which workloads call out, and to whom" — grouped category → component →
// the calls themselves. Flow-import fields (observedCount / source) are read
// defensively: they are absent until a network-flows import has run.

const egressPort = (o) => o.port ?? o.destinationPort ?? o.targetPort ?? o.dport ?? null;
const egressProtoPort = (o) => {
  const proto = o.protocol || '';
  const port = egressPort(o);
  if (proto && port != null && port !== '') return `${proto}/${port}`;
  return proto || (port != null && port !== '' ? String(port) : '');
};
const egressObserved = (o) => {
  const v = [o.observedCount, o.observed, o.flowCount, o.flows, o.count]
    .find((x) => typeof x === 'number');
  return num(v);
};
const CF_CRITICAL = [['Yes', 'warn']];

function addEgress(wb, d) {
  const withCalls = d.components.filter((c) => (c.outboundCalls || []).length);
  if (!withCalls.length) return null;
  const columns = [
    { header: 'Category', width: 20 },
    { header: 'Component (service)', width: 26 },
    { header: 'Workload / Pod', width: 30, wrap: true },
    { header: 'Destination', width: 30 },
    { header: 'Destination Type', width: 16 },
    { header: 'Protocol / Port', width: 14, align: 'center' },
    { header: 'Purpose', width: 38, wrap: true },
    { header: 'Failover Behavior', width: 44, wrap: true },
    { header: 'Critical', width: 10, align: 'center', list: LIST_YESNO },
    { header: 'Observed', width: 10, align: 'right', numFmt: '0' },
  ];
  const ws = addSheet(wb, EGRESS_SHEET,
    'Egress / Outbound Calls — who each service calls out to, and what happens on failover', columns, {
    outline: true,
    freezeCols: 2,
    note: 'Every outbound call a service makes and where it goes, grouped by category then service. Workload / Pod comes from the Kubernetes snapshot; Observed is the flow count when the entry came from a network-flows import. Critical third-party calls (allowlists, endpoints) need partner action before a test.',
  });

  const workloadText = (cid) => join((d.k8s?.workloads || [])
    .filter((w) => w.componentId === cid)
    .map((w) => `${w.name}${w.namespace ? ` (${w.namespace})` : ''}`), ' · ');

  for (const [cat, comps] of byCategory(withCalls)) {
    const calls = comps.reduce((n, c) => n + (c.outboundCalls || []).length, 0);
    groupRow(ws, columns, `${categoryLabel(cat)} — ${plural(comps.length, 'service')} · ${plural(calls, 'outbound call')}`, { merge: false });
    for (const c of comps) {
      const list = c.outboundCalls || [];
      const pods = workloadText(c.id);
      const crit = list.filter((o) => o.critical).length;
      const bits = [plural(list.length, 'outbound call')];
      if (crit) bits.push(`${crit} critical`);
      groupRow(ws, columns, `${c.name} — ${bits.join(' · ')}`, { level: 1, merge: false });
      list.forEach((o, i) => dataRow(ws, columns, [
        c.category || '', c.name, pods, o.target || '', o.type || '',
        egressProtoPort(o), o.purpose || '', o.failoverBehavior || '',
        yn(!!o.critical), egressObserved(o),
      ], { level: 2, stripe: i % 2 === 1 }));
    }
  }
  addCF(ws, 9, 3, ws.rowCount, CF_CRITICAL);
  filterAll(ws, columns.length);
  return ws;
}

function addSecrets(wb, d) {
  flatSheet(wb, 'Secrets Reconciliation', {
    title: 'Secrets Reconciliation — drive every Replicated cell to yes or no; unknowns are how recovery tests die',
    note: DATASETS['secrets'].note,
    columns: [
      { header: 'Component', width: 26 }, { header: 'Secret Name', width: 34 },
      { header: 'ARN', width: 44, wrap: true },
      { header: 'Replicated', width: 12, align: 'center', list: LIST_REPLICATED },
      { header: 'Notes', width: 46, wrap: true },
    ],
    rows: d.components.flatMap((c) => (c.secrets || []).map((s) => [
      c.name, s.name || '', s.arn || '', s.replicated || 'unknown', s.notes || '',
    ])),
    cf: { 4: CF_REPLICATED },
  });
}

function addGaps(wb, d) {
  // The triage sheet people print and walk through in a review meeting.
  flatSheet(wb, 'Gap List', {
    title: 'Gap List — what stands between this plan and a passing recovery test',
    print: { orientation: 'landscape' },
    columns: [
      { header: 'Title', width: 44, wrap: true }, { header: 'Category', width: 18 },
      { header: 'Class', width: 20 },
      { header: 'Severity', width: 10, align: 'center', list: LIST_SEVERITY },
      { header: 'Component', width: 26 },
      { header: 'Status', width: 11, align: 'center', list: LIST_GAP_STATUS },
      { header: 'Ticket', width: 13, link: true },
      { header: 'Notes', width: 44, wrap: true },
    ],
    rows: d.gaps.map((g) => [
      g.title || '', g.category || '', g.class || '', g.severity || '',
      gapComponent(d, g), g.status || '', g.ticket || '', g.notes || '',
    ]),
    cf: { 4: CF_SEVERITY, 6: CF_GAP_STATUS },
  });
}

function addRunbooksIndex(wb, d) {
  // Scoped packages gain a Package column: generic runbooks (no component
  // links) ride along as context and say so.
  const scoped = !!d.scope;
  flatSheet(wb, 'Runbooks', {
    title: 'Runbooks — the recovery procedures that exist, and what each one covers',
    columns: [
      { header: 'Name', width: 36 }, { header: 'Tooling', width: 13 },
      { header: 'Scenario', width: 15 }, { header: 'Audience', width: 13 },
      { header: 'Steps', width: 8, align: 'right', numFmt: '0' },
      { header: 'Rollback', width: 10, align: 'right', numFmt: '0' },
      { header: 'Preconditions', width: 56, wrap: true },
      { header: 'Linked Tests', width: 30, wrap: true },
      ...(scoped ? [{ header: 'Package', width: 14 }] : []),
    ],
    rows: d.runbooks.map((rb) => [
      rb.name || '', rb.tooling || '', rb.scenario || '', rb.audience || '',
      (rb.steps || []).length, (rb.rollback || []).length,
      join(rb.preconditions, '; '), join((rb.linkedTestIds || []).map(d.testNameOf)),
      ...(scoped ? [rb.scopeGeneric ? '(generic)' : 'service-linked'] : []),
    ]),
  });
}

function addTestLog(wb, d) {
  flatSheet(wb, 'Test Log', {
    title: 'Test Log — every recovery test, and what it actually measured',
    note: 'RTA/RPA here are measurements, not targets. A blank means the test did not measure it.',
    columns: [
      { header: 'Name', width: 32 }, { header: 'Type', width: 15 },
      { header: 'Status', width: 13, align: 'center', list: LIST_STATUS },
      { header: 'Date', width: 13, align: 'center', date: true },
      { header: 'Runbook', width: 34 },
      { header: 'RTA (min)', width: 11, align: 'right', numFmt: '0' },
      { header: 'RPA (min)', width: 11, align: 'right', numFmt: '0' },
      { header: 'Clean Run', width: 11, align: 'center', list: LIST_YESNO },
      { header: 'Findings', width: 10, align: 'right', numFmt: '0' },
    ],
    rows: d.tests.map((t) => [
      t.name || '', t.type || '', TEST_STATUS_DISPLAY[t.status] || t.status || '', t.date || '',
      d.runbookNameOf(t.runbookId),
      num(t.results?.rtaMinutes), num(t.results?.rpaMinutes),
      t.status === 'passed' || t.status === 'failed' ? yn(!!t.results?.cleanRun) : '',
      (t.findings || []).length,
    ]),
    cf: { 3: CF_STATUS, 8: CF_YES_DONE },
  });
}

function addAppTestCatalog(wb, d) {
  flatSheet(wb, 'App Test Catalog', {
    title: 'App Test Catalog — the business transactions that must work before you call it recovered',
    note: 'Application-level success checks: infrastructure being green is not the bar — a business transaction completing is.',
    columns: [
      { header: 'Test', width: 28 }, { header: 'App Test', width: 36, wrap: true },
      { header: 'Command', width: 44, wrap: true }, { header: 'Expected', width: 36, wrap: true },
      { header: 'Component', width: 26 },
      { header: 'Critical', width: 10, align: 'center', list: LIST_YESNO },
    ],
    cf: { 6: CF_YES_DONE },
    rows: d.tests.flatMap((t) => (t.appTests || []).map((a) => [
      t.name || '', a.name || '', a.command || '', a.expected || '',
      d.nameOf(a.componentId), yn(!!a.critical),
    ])),
  });
}

function addDecisions(wb, d) {
  flatSheet(wb, 'Decision Log', {
    title: 'Decision Log — what was decided and why, so it is not re-litigated mid-incident',
    columns: [
      { header: 'Date', width: 13, align: 'center', date: true },
      { header: 'Title', width: 32, wrap: true },
      { header: 'Context', width: 48, wrap: true }, { header: 'Decision', width: 48, wrap: true },
      { header: 'Owner', width: 14 }, { header: 'Status', width: 10, align: 'center' },
    ],
    rows: d.decisions.map((x) => [
      x.date || '', x.title || '', x.context || '', x.decision || '', x.owner || '', x.status || '',
    ]),
    cf: { 6: CF_DECISION },
  });
}

function addPeople(wb, d) {
  flatSheet(wb, 'People', {
    title: 'People — who does what during a recovery, and how to reach them',
    columns: [
      { header: 'Name', width: 24 }, { header: 'Role', width: 26 },
      { header: 'Responsibilities', width: 52, wrap: true },
      { header: 'Contact', width: 28, link: true },
      { header: 'Escalation', width: 30, wrap: true },
    ],
    rows: d.contacts.map((p) => [
      p.name || '', p.role || '', p.responsibilities || '', p.contact || '', p.escalation || '',
    ]),
  });
}

function addOptionsMatrix(wb) {
  flatSheet(wb, 'DR Options Matrix', {
    title: 'DR Options Matrix — reference: the four strategies, with honest RTO/RPO/cost ranges',
    note: 'Costs are relative, ranges are typical for AWS multi-region setups. A measured RTA from a real test beats every number in this table.',
    autoFilter: false,
    columns: [
      { header: 'Strategy', width: 18 }, { header: 'Typical RTO', width: 22 },
      { header: 'Typical RPO', width: 26 }, { header: 'Cost', width: 30, wrap: true },
      { header: 'Complexity', width: 13 }, { header: 'When to choose', width: 64, wrap: true },
    ],
    rows: DR_OPTIONS.map((o) => [o.name, o.rto, o.rpo, o.cost, o.complexity, o.when]),
  });
}

function addVerificationCatalog(wb, d) {
  // Operators print this and work down it in the recovery region.
  flatSheet(wb, 'Verification Catalog', {
    title: 'Verification Catalog — run these in restore-layer order to prove the recovery actually worked',
    note: DATASETS['verification-catalog'].note,
    print: { orientation: 'landscape' },
    freezeCols: 2,
    columns: [
      { header: 'Layer', width: 26 }, { header: 'Component', width: 28 },
      { header: 'Command', width: 56, wrap: true },
      { header: 'Pass Criteria', width: 50, wrap: true },
    ],
    rows: DATASETS['verification-catalog'].rows(d),
  });
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
  addExecutiveSummary(wb, d);
  addHowToUse(wb, d);
  addDependencies(wb, d);
  addK8sWorkloads(wb, d);
  addK8sNetwork(wb, d);
  addEgress(wb, d);
  addSecrets(wb, d);
  addGaps(wb, d);
  addRunbooksIndex(wb, d);
  addRunbookSteps(wb, d);
  addTestLog(wb, d);
  addTestRecords(wb, d);
  addAppTestCatalog(wb, d);
  addChecklists(wb, d);
  addDecisions(wb, d);
  addPeople(wb, d);
  addOptionsMatrix(wb);
  addVerificationCatalog(wb, d);

  return wb;
}
