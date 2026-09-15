// DR Compass — Excel workbook + CSV dataset generation.
// buildWorkbook(slug) is used by both the export route and `drcompass export`.
//
// Visual system (every sheet):
//   row 1  merged title — Arial 14 bold #202124, no fill, height 28
//   row 2  column headers — #3C6958 fill, white bold Arial 10, height 20
//   panes frozen at A3; data rows Arial 10, zebra #F8F9FA / white
//   parent/summary rows in outlined sheets: #F1F3F4 bold
//   dropdowns via dataValidation lists; status tints via conditional formatting
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

// ---------------------------------------------------------------- data load

function loadData(slug) {
  const meta = store.getWorkspace(slug);
  const d = { meta, assessment: store.getObject(slug, 'assessment') };
  for (const c of store.COLLECTIONS) d[c] = store.getCollection(slug, c) || [];
  d.byId = new Map(d.components.map((c) => [c.id, c]));
  d.nameOf = (id) => d.byId.get(id)?.name || (id || '');
  d.usedBy = new Map();
  for (const c of d.components) {
    for (const dep of c.dependsOn || []) {
      if (!d.usedBy.has(dep)) d.usedBy.set(dep, []);
      d.usedBy.get(dep).push(c.name);
    }
  }
  d.testNameOf = (id) => d.tests.find((t) => t.id === id)?.name || (id || '');
  return d;
}

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
      d.nameOf(g.componentId), g.status || '', g.ticket || '', g.notes || '',
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
      d.runbooks.find((r) => r.id === t.runbookId)?.name || '',
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
};

function stepRow(rbName, n, s) {
  return [rbName, n, s.layer || '', s.title || '', s.detail || '', s.command || '',
    s.verify || '', s.pass || '', s.owner || '', num(s.estMinutes),
    s.gate ? 'yes' : '', s.record || ''];
}

export const CSV_SHEETS = Object.keys(DATASETS);

// Returns {headers, rows} for one CSV sheet name; throws 404 on unknown sheet.
export function csvDataset(slug, sheet) {
  const ds = DATASETS[sheet];
  if (!ds) throw store.httpError(404, `unknown export sheet '${sheet}' — one of: ${CSV_SHEETS.join(', ')}`);
  const d = loadData(slug);
  return { headers: ds.columns.map((c) => c.header), rows: ds.rows(d) };
}

// ------------------------------------------------------------ sheet helpers

function colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Shared shell: title row 1 (merged), header row 2 (green), frozen at A3.
function addSheet(wb, name, title, columns, { note, outline = false } = {}) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 2, topLeftCell: 'A3', activeCell: 'A3' }],
    ...(outline ? { properties: { outlineProperties: { summaryBelow: false, summaryRight: false } } } : {}),
  });
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 16; });

  const t = ws.addRow([title]);
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
  return ws;
}

// One data row with per-column alignment/wrap/link/numFmt/validation + zebra.
function dataRow(ws, columns, values, { stripe = false, level = 0, hidden = false } = {}) {
  const row = ws.addRow(values);
  if (level) row.outlineLevel = level;
  if (hidden) row.hidden = true;
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.font = ARIAL(c.link && values[i] ? { color: { argb: LINK } } : {});
    cell.alignment = { vertical: 'top', horizontal: c.align || 'left', wrapText: !!c.wrap };
    if (c.numFmt && typeof cell.value === 'number') cell.numFmt = c.numFmt;
    if (stripe) cell.fill = solid(ZEBRA);
    if (c.list) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [c.list] };
  });
  return row;
}

// Parent/summary row for outlined sheets (and section headers): #F1F3F4, bold, merged.
function groupRow(ws, columns, text, { level = 0 } = {}) {
  const row = ws.addRow([text]);
  if (level) row.outlineLevel = level;
  row.height = 18;
  for (let i = 1; i <= columns.length; i++) {
    const cell = row.getCell(i);
    cell.fill = solid(PARENT_FILL);
    cell.font = ARIAL({ bold: true, color: { argb: INK } });
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  ws.mergeCells(row.number, 1, row.number, columns.length);
  return row;
}

// Quiet single-cell annotation row (used for inventory sub-detail, level 2).
function noteRow(ws, text, { level = 2, hidden = true, col = 2, color = MUTED } = {}) {
  const vals = [];
  vals[col - 1] = text;
  const row = ws.addRow(vals);
  row.outlineLevel = level;
  if (hidden) row.hidden = true;
  const cell = row.getCell(col);
  cell.font = ARIAL({ italic: true, color: { argb: color } });
  cell.alignment = { vertical: 'top', wrapText: false };
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
function flatSheet(wb, name, { title, note, columns, rows, cf = {}, autoFilter = true }) {
  if (!rows.length) return null;
  const ws = addSheet(wb, name, title, columns, { note });
  rows.forEach((r, i) => dataRow(ws, columns, r, { stripe: i % 2 === 1 }));
  const last = 2 + rows.length;
  for (const [idx, rules] of Object.entries(cf)) addCF(ws, Number(idx), 3, last, rules);
  if (autoFilter) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: last, column: columns.length } };
  return ws;
}

// ------------------------------------------------------------ How to use

function sheetGuide(d) {
  const has = (arr) => arr && arr.length > 0;
  const rows = [
    ['Readiness Summary', 'Read this first: targets vs measured, scope counts, open gaps, test status, maturity.', 'Computed from the workspace'],
  ];
  if (has(d.components)) rows.push(['Dependency Inventory', 'Work the Status dropdown per component. Expand the +/- outline in the left margin for depends-on and gap detail.', 'Every Status = Not started']);
  if (d.components.some((c) => (c.outboundCalls || []).length)) rows.push(['Outbound Calls', 'Confirm each failover behavior; chase critical third-party calls (allowlists, endpoints) before the next test.', 'Filled from the inventory']);
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
  rows.push(['DR Options Matrix', 'Reference: the four DR strategies with honest RTO/RPO/cost/complexity ranges.', 'Static reference']);
  if (d.components.some((c) => c.verification?.command || c.verification?.pass)) {
    rows.push(['Verification Catalog', 'During recovery, run verifications top to bottom by restore layer.', 'Filled from the inventory']);
  }
  return rows;
}

function addHowToUse(wb, d) {
  const columns = [
    { header: 'Sheet', width: 24 },
    { header: 'What you do', width: 72, wrap: true },
    { header: 'Starts as', width: 34, wrap: true },
  ];
  const ws = addSheet(wb, 'How to use', `${d.meta.name} — Disaster Recovery Tracker`, columns, {
    note: 'Generated by DR Compass. Import into Excel or Google Sheets — dropdowns, tints, and row groups survive both.',
  });
  sheetGuide(d).forEach((g, i) => {
    const row = dataRow(ws, columns, g, { stripe: i % 2 === 1 });
    row.getCell(1).font = ARIAL({ bold: true });
  });
  ws.addRow([]);

  groupRow(ws, columns, 'WORKSPACE');
  const kv = (k, v) => {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = ARIAL({ bold: true, color: { argb: MUTED } });
    r.getCell(1).alignment = { vertical: 'top' };
    r.getCell(2).font = ARIAL();
    r.getCell(2).alignment = { vertical: 'top', wrapText: true };
    ws.mergeCells(r.number, 2, r.number, columns.length);
    return r;
  };
  kv('Workspace', d.meta.name);
  if (d.meta.org) kv('Organization', d.meta.org);
  if (d.meta.description) kv('Description', d.meta.description).height = 30;
  kv('Primary region', d.meta.regions?.primary || '');
  kv('Recovery region', d.meta.regions?.recovery || '');
  kv('DR strategy', d.meta.strategy || '');
  if ((d.meta.tooling || []).length) kv('Tooling', join(d.meta.tooling));
  kv('Generated', new Date().toISOString().slice(0, 10));
  ws.addRow([]);

  groupRow(ws, columns, 'THE HONEST-NUMBERS RULE');
  const hr = ws.addRow(['RTO/RPO are TARGETS the business signs off on. RTA/RPA are what your last test actually MEASURED. Until targets are formally approved and a test has hit them, quote only the measured RTA/RPA. A target nobody has tested is a hope, not a capability.']);
  ws.mergeCells(hr.number, 1, hr.number, columns.length);
  const hc = hr.getCell(1);
  hc.font = ARIAL({ italic: true, color: { argb: TINT.warn.font } });
  hc.fill = solid(TINT.warn.fill);
  hc.alignment = { vertical: 'top', wrapText: true };
  hr.height = 42;
  return ws;
}

// -------------------------------------------------- Readiness Summary sheet

function countBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) || 'unknown';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function addReadiness(wb, d) {
  const columns = [
    { header: 'Metric', width: 34 },
    { header: 'Value', width: 16 },
    { header: 'Notes', width: 62, wrap: true },
  ];
  const ws = addSheet(wb, 'Readiness Summary', 'Readiness Summary', columns);
  const stat = (k, v, { tint = null, note = '', numFmt = null, list = null } = {}) => {
    const r = ws.addRow([k, v, note]);
    r.getCell(1).font = ARIAL({ color: { argb: INK } });
    r.getCell(1).alignment = { vertical: 'top' };
    const vc = r.getCell(2);
    vc.font = ARIAL(tint ? { color: { argb: TINT[tint].font } } : {});
    vc.alignment = { vertical: 'top' };
    if (tint) vc.fill = solid(TINT[tint].fill);
    if (numFmt && typeof v === 'number') vc.numFmt = numFmt;
    if (list) vc.dataValidation = { type: 'list', allowBlank: true, formulae: [list] };
    r.getCell(3).font = ARIAL({ color: { argb: MUTED } });
    r.getCell(3).alignment = { vertical: 'top', wrapText: true };
    return r;
  };

  const obj = d.meta.objectives || {};
  groupRow(ws, columns, 'OBJECTIVES — TARGETS VS MEASURED');
  stat('RTO target (min)', num(obj.rtoMinutes), { numFmt: '0', note: 'Business sign-off target for time to restore' });
  stat('RPO target (min)', num(obj.rpoMinutes), { numFmt: '0', note: 'Business sign-off target for the data-loss window' });
  stat('RTA measured (min)', num(obj.rtaMinutes), { numFmt: '0', note: 'What the last test actually achieved' });
  stat('RPA measured (min)', num(obj.rpaMinutes), { numFmt: '0', note: 'Actual data age at the recovery point in the last test' });
  stat('Approved by business', yn(obj.approved), { tint: obj.approved ? 'ok' : 'warn', list: LIST_YESNO });
  if (obj.notes) stat('Notes', '', { note: obj.notes });
  ws.addRow([]);

  groupRow(ws, columns, 'INVENTORY');
  const catText = [...countBy(d.components, (c) => c.category)]
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  stat('Components tracked', d.components.length, { numFmt: '0', note: catText });
  for (const scope of ['yes', 'partial', 'no', 'unknown']) {
    const n = d.components.filter((c) => (c.inRecoveryScope || 'unknown') === scope).length;
    if (n) {
      stat(`In recovery scope: ${scope}`, n, {
        numFmt: '0',
        tint: scope === 'partial' || scope === 'unknown' ? 'warn' : null,
      });
    }
  }
  ws.addRow([]);

  groupRow(ws, columns, 'OPEN GAPS BY SEVERITY');
  const openGaps = d.gaps.filter((g) => g.status !== 'resolved');
  if (openGaps.length) {
    for (const sev of ['blocker', 'high', 'medium', 'low']) {
      const n = openGaps.filter((g) => g.severity === sev).length;
      if (n) stat(sev, n, { numFmt: '0', tint: sev === 'blocker' || sev === 'high' ? 'err' : sev === 'medium' ? 'warn' : null });
    }
  } else {
    stat('Open gap items', 0, { numFmt: '0' });
  }
  const inlineGaps = d.components.reduce((n, c) => n + (c.gaps || []).length, 0);
  if (inlineGaps) {
    stat('Component-level gap notes', inlineGaps, {
      numFmt: '0', tint: 'warn',
      note: 'Expand the outline on the Dependency Inventory sheet to read them',
    });
  }
  ws.addRow([]);

  groupRow(ws, columns, 'TESTS');
  if (d.tests.length) {
    for (const [k, v] of countBy(d.tests, (t) => t.status)) {
      stat(TEST_STATUS_DISPLAY[k] || k, v, {
        numFmt: '0',
        tint: k === 'passed' ? 'ok' : k === 'failed' ? 'err' : k === 'planned' || k === 'in-progress' ? 'warn' : null,
      });
    }
  } else {
    stat('Tests recorded', 0, { numFmt: '0', tint: 'warn', note: 'No recovery tests recorded yet — an untested plan is a hypothesis' });
  }
  ws.addRow([]);

  groupRow(ws, columns, 'MATURITY ASSESSMENT');
  const m = maturity(d.assessment);
  if (m) {
    stat('Average answer score (0–4)', Math.round(m.avg * 100) / 100);
    stat('Overall level', m.label, { tint: m.level >= 4 ? 'ok' : m.level >= 2 ? 'warn' : 'err' });
    stat('Questions answered', m.answered, { numFmt: '0', note: 'Simple average across answered questions; see the Assessment page for per-pillar detail' });
  } else {
    stat('Assessment', 'not answered yet', { tint: 'warn' });
  }
  return ws;
}

// ------------------------------------------- Dependency Inventory (outlined)

function addInventory(wb, d) {
  if (!d.components.length) return null;
  const columns = [
    { header: 'Tier', width: 6, align: 'center', numFmt: '0' },
    { header: 'Component', width: 28 },
    { header: 'Kind', width: 16 },
    { header: 'Owner / Team', width: 20 },
    { header: 'Layer', width: 7, align: 'center' },
    { header: 'Scope', width: 11, list: LIST_SCOPE },
    { header: 'DR Strategy', width: 12 },
    { header: 'Replication', width: 20 },
    { header: 'RPO (min)', width: 9, align: 'right', numFmt: '0' },
    { header: 'Status', width: 13, list: LIST_STATUS },
    { header: 'Defined In', width: 26, link: true },
    { header: 'Notes', width: 40, wrap: true },
  ];
  const ws = addSheet(wb, 'Dependency Inventory', 'Dependency Inventory', columns, {
    outline: true,
    note: 'One row per component, grouped by category. Expand the +/- handles in the left margin for depends-on / used-by / gap detail. Status is your working column — it starts at "Not started".',
  });

  const byCat = new Map();
  for (const c of d.components) {
    const k = c.category || 'other';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(c);
  }
  const cats = [...CATEGORY_ORDER.filter((k) => byCat.has(k)),
    ...[...byCat.keys()].filter((k) => !CATEGORY_ORDER.includes(k))];

  let stripe = 0;
  for (const cat of cats) {
    const comps = byCat.get(cat).sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name));
    const label = cat.replace(/-/g, ' ').toUpperCase();
    groupRow(ws, columns, `${label} — ${plural(comps.length, 'component')}`);
    for (const c of comps) {
      dataRow(ws, columns, [
        num(c.tier), c.name, c.kind || '', ownerTeam(c), c.restoreLayer || '',
        cap(c.inRecoveryScope || 'unknown'), c.drStrategy || '',
        c.replication?.mechanism || '', num(c.replication?.rpoMinutes),
        'Not started', c.definedIn || '', c.notes || '',
      ], { level: 1, stripe: stripe++ % 2 === 1 });
      if ((c.dependsOn || []).length) noteRow(ws, `depends on: ${join(c.dependsOn.map(d.nameOf))}`);
      const usedBy = d.usedBy.get(c.id);
      if (usedBy?.length) noteRow(ws, `used by: ${join(usedBy)}`);
      if ((c.gaps || []).length) noteRow(ws, `gaps: ${join(c.gaps, '; ')}`, { color: TINT.err.font });
    }
  }
  addCF(ws, 10, 3, ws.rowCount, CF_STATUS);
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
    { header: 'Owner', width: 12 },
    { header: 'Est (min)', width: 9, align: 'right', numFmt: '0' },
    { header: 'Gate', width: 7, align: 'center', list: LIST_YESNO },
    { header: 'Record', width: 24, wrap: true },
  ];
  const ws = addSheet(wb, 'Runbook Steps', 'Runbook Steps', columns, {
    outline: true,
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
    groupRow(ws, columns, `${rb.name} — ${parts.join(' · ')}`);
    steps.forEach((s, i) => row(s, i + 1, 1, i % 2 === 1));
    if (rollback.length) {
      groupRow(ws, columns, `ROLLBACK — ${plural(rollback.length, 'step')}`, { level: 1 });
      rollback.forEach((s, i) => row(s, `R${i + 1}`, 2, i % 2 === 1));
    }
  }
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
  const ws = addSheet(wb, 'Test Records', 'Test Records', columns, {
    outline: true,
    note: 'One collapsible block per test: app-test results, findings, and the narrative record.',
  });

  for (const t of d.tests) {
    const status = TEST_STATUS_DISPLAY[t.status] || t.status || '';
    groupRow(ws, columns, [t.name, t.type, status, t.date].filter(Boolean).join(' · '));
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
  return ws;
}

// ---------------------------------------------------- Checklists (outlined)

function addChecklists(wb, d) {
  if (!d.checklists.some((cl) => (cl.items || []).length)) return null;
  const columns = [
    { header: 'Done', width: 8, align: 'center', list: LIST_YESNO },
    { header: 'Item', width: 48, wrap: true },
    { header: 'Why', width: 44, wrap: true },
    { header: 'Proof', width: 36, wrap: true },
    { header: 'Owner', width: 14 },
  ];
  const ws = addSheet(wb, 'Checklists', 'Checklists', columns, {
    outline: true,
    note: 'Grouped by checklist. Flip Done to Yes only with the proof in hand.',
  });
  for (const cl of d.checklists) {
    const items = cl.items || [];
    if (!items.length) continue;
    const done = items.filter((it) => it.done).length;
    groupRow(ws, columns, `${cl.name} · ${cl.kind || 'custom'} · ${done}/${items.length} done`);
    items.forEach((it, i) => dataRow(ws, columns, [
      yn(!!it.done), it.text || '', it.why || '', it.proof || '', it.owner || '',
    ], { level: 1, stripe: i % 2 === 1 }));
  }
  addCF(ws, 1, 3, ws.rowCount, CF_YES_DONE);
  return ws;
}

// -------------------------------------------------------- flat sheet specs

function addOutboundCalls(wb, d) {
  flatSheet(wb, 'Outbound Calls', {
    title: 'Outbound Calls',
    note: 'Every outbound dependency call and its failover behavior. Critical third-party calls (allowlists, endpoints) need partner action before a test.',
    columns: [
      { header: 'Component', width: 26 }, { header: 'Target', width: 28 },
      { header: 'Type', width: 13 }, { header: 'Protocol', width: 10 },
      { header: 'Purpose', width: 38, wrap: true },
      { header: 'Failover Behavior', width: 46, wrap: true },
      { header: 'Critical', width: 9, align: 'center', list: LIST_YESNO },
    ],
    rows: d.components.flatMap((c) => (c.outboundCalls || []).map((o) => [
      c.name, o.target || '', o.type || '', o.protocol || '', o.purpose || '',
      o.failoverBehavior || '', yn(!!o.critical),
    ])),
  });
}

function addSecrets(wb, d) {
  flatSheet(wb, 'Secrets Reconciliation', {
    title: 'Secrets Reconciliation',
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
  flatSheet(wb, 'Gap List', {
    title: 'Gap List',
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
      d.nameOf(g.componentId), g.status || '', g.ticket || '', g.notes || '',
    ]),
    cf: { 4: CF_SEVERITY, 6: CF_GAP_STATUS },
  });
}

function addRunbooksIndex(wb, d) {
  flatSheet(wb, 'Runbooks', {
    title: 'Runbooks',
    columns: [
      { header: 'Name', width: 34 }, { header: 'Tooling', width: 12 },
      { header: 'Scenario', width: 14 }, { header: 'Audience', width: 12 },
      { header: 'Steps', width: 7, align: 'right', numFmt: '0' },
      { header: 'Rollback', width: 9, align: 'right', numFmt: '0' },
      { header: 'Preconditions', width: 56, wrap: true },
      { header: 'Linked Tests', width: 30, wrap: true },
    ],
    rows: d.runbooks.map((rb) => [
      rb.name || '', rb.tooling || '', rb.scenario || '', rb.audience || '',
      (rb.steps || []).length, (rb.rollback || []).length,
      join(rb.preconditions, '; '), join((rb.linkedTestIds || []).map(d.testNameOf)),
    ]),
  });
}

function addTestLog(wb, d) {
  flatSheet(wb, 'Test Log', {
    title: 'Test Log',
    columns: [
      { header: 'Name', width: 30 }, { header: 'Type', width: 14 },
      { header: 'Status', width: 13, align: 'center', list: LIST_STATUS },
      { header: 'Date', width: 12 }, { header: 'Runbook', width: 34 },
      { header: 'RTA (min)', width: 10, align: 'right', numFmt: '0' },
      { header: 'RPA (min)', width: 10, align: 'right', numFmt: '0' },
      { header: 'Clean Run', width: 10, align: 'center', list: LIST_YESNO },
      { header: 'Findings', width: 9, align: 'right', numFmt: '0' },
    ],
    rows: d.tests.map((t) => [
      t.name || '', t.type || '', TEST_STATUS_DISPLAY[t.status] || t.status || '', t.date || '',
      d.runbooks.find((r) => r.id === t.runbookId)?.name || '',
      num(t.results?.rtaMinutes), num(t.results?.rpaMinutes),
      t.status === 'passed' || t.status === 'failed' ? yn(!!t.results?.cleanRun) : '',
      (t.findings || []).length,
    ]),
    cf: { 3: CF_STATUS, 8: CF_YES_DONE },
  });
}

function addAppTestCatalog(wb, d) {
  flatSheet(wb, 'App Test Catalog', {
    title: 'App Test Catalog',
    note: 'Application-level success checks: infrastructure being green is not the bar — a business transaction completing is.',
    columns: [
      { header: 'Test', width: 26 }, { header: 'App Test', width: 36, wrap: true },
      { header: 'Command', width: 44, wrap: true }, { header: 'Expected', width: 36, wrap: true },
      { header: 'Component', width: 24 },
      { header: 'Critical', width: 9, align: 'center', list: LIST_YESNO },
    ],
    rows: d.tests.flatMap((t) => (t.appTests || []).map((a) => [
      t.name || '', a.name || '', a.command || '', a.expected || '',
      d.nameOf(a.componentId), yn(!!a.critical),
    ])),
  });
}

function addDecisions(wb, d) {
  flatSheet(wb, 'Decision Log', {
    title: 'Decision Log',
    columns: [
      { header: 'Date', width: 12 }, { header: 'Title', width: 32, wrap: true },
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
    title: 'People',
    columns: [
      { header: 'Name', width: 22 }, { header: 'Role', width: 24 },
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
    title: 'DR Options Matrix — the four strategies, honestly',
    note: 'Costs are relative, ranges are typical for AWS multi-region setups. A measured RTA from a real test beats every number in this table.',
    autoFilter: false,
    columns: [
      { header: 'Strategy', width: 18 }, { header: 'Typical RTO', width: 22 },
      { header: 'Typical RPO', width: 26 }, { header: 'Cost', width: 30, wrap: true },
      { header: 'Complexity', width: 13 }, { header: 'When to choose', width: 64, wrap: true },
    ],
    rows: [
      ['Backup & restore', '4–24+ hours', '1–24 hours (age of last good backup)',
        '$ — backup storage only', 'Low',
        'Tier 2/3 workloads; tight budgets; the business can genuinely tolerate being down most of a day and losing hours of data. Restores MUST be rehearsed — an unrestored backup is a rumor.'],
      ['Pilot light', '30 min – a few hours', 'Minutes (continuous data replication)',
        '$$ — data stores replicated, compute off until needed', 'Medium',
        'Data must be near-current but you can wait for compute to launch. A good fit for most Tier-0/1 apps that can tolerate ~1 hour of downtime. Snapshot-based tools (e.g. Arpio) live here.'],
      ['Warm standby', '5–30 minutes', 'Seconds – minutes',
        '$$$ — scaled-down but fully functional copy always running', 'Medium-High',
        'RTO under ~30 minutes; you want continuous proof the recovery stack actually runs (it serves synthetic or small live traffic). Scaling up is far less risky than cold-starting.'],
      ['Active-active', '~0 (seconds – minutes)', '~0 (synchronous / near-synchronous)',
        '$$$$ — 2× infrastructure plus data-layer engineering', 'High',
        'The business cannot tolerate meaningful downtime and will fund it. You accept hard problems: write conflicts, data consistency, routing, and testing failure modes across two live regions.'],
    ],
  });
}

function addVerificationCatalog(wb, d) {
  flatSheet(wb, 'Verification Catalog', {
    title: 'Verification Catalog',
    note: DATASETS['verification-catalog'].note,
    columns: [
      { header: 'Layer', width: 26 }, { header: 'Component', width: 28 },
      { header: 'Command', width: 56, wrap: true },
      { header: 'Pass Criteria', width: 50, wrap: true },
    ],
    rows: DATASETS['verification-catalog'].rows(d),
  });
}

// ----------------------------------------------------------------- workbook

export async function buildWorkbook(slug) {
  const d = loadData(slug);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DR Compass';
  wb.created = new Date();

  addHowToUse(wb, d);
  addReadiness(wb, d);
  addInventory(wb, d);
  addOutboundCalls(wb, d);
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
