// DR Compass — Excel workbook + CSV dataset generation.
// buildWorkbook(slug) is used by both the export route and `drcompass export`.
import ExcelJS from 'exceljs';
import * as store from '../store.js';

// ---------------------------------------------------------------- constants

const HEADER_BLUE = 'FF1F4E79';
const HEADER_BLUE_DARK = 'FF16385C';
const ZEBRA = 'FFF3F6FA';

const KIND_STYLE = {
  ok:   { fill: 'FFC6EFCE', font: 'FF1E6E3E' },
  warn: { fill: 'FFFFEB9C', font: 'FF8A5A00' },
  err:  { fill: 'FFFFC7CE', font: 'FF9C0006' },
};

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

// ------------------------------------------------------------- color rules

const scopeRule = (v) => (v === 'yes' ? 'ok' : v === 'no' ? 'err' : v ? 'warn' : null);
const sevRule = (v) => (v === 'blocker' ? 'err' : v === 'high' ? 'warn' : null);
const gapStatusRule = (v) => (v === 'resolved' ? 'ok' : v === 'open' ? 'err' : v === 'accepted' ? 'warn' : null);
const testStatusRule = (v) => (v === 'passed' ? 'ok' : v === 'failed' ? 'err' : v === 'in-progress' || v === 'planned' ? 'warn' : null);
const yesNoRule = (v) => (v === 'yes' ? 'ok' : v === 'no' ? 'err' : v === 'unknown' ? 'warn' : null);
const doneRule = (v) => (v === 'yes' ? 'ok' : v === 'no' ? 'warn' : null);
const criticalRule = (v) => (v === 'yes' ? 'warn' : null);

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

// ------------------------------------------------- datasets (xlsx + csv share)

// Each dataset: columns [{header, width, wrap?, numFmt?}], rows(d) -> [][]
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
    colorCols: { 6: scopeRule },
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
    colorCols: { 6: criticalRule },
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
    colorCols: { 3: yesNoRule },
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
    colorCols: { 3: sevRule, 5: gapStatusRule },
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
    colorCols: { 2: testStatusRule, 7: doneRule },
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
    colorCols: { 6: doneRule },
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
    colorCols: { 5: (v) => (v === 'decided' ? 'ok' : v === 'pending' ? 'warn' : null) },
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

function addTableSheet(wb, name, { title, note, columns, rows, colorCols = {}, autoFilter = true, zebra = true }) {
  const ws = wb.addWorksheet(name);
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 18; });

  const titleRow = ws.addRow([title]);
  titleRow.height = 26;
  ws.mergeCells(1, 1, 1, columns.length);
  titleRow.getCell(1).font = { size: 14, bold: true, color: { argb: HEADER_BLUE } };
  titleRow.getCell(1).alignment = { vertical: 'middle' };

  if (note) {
    const nRow = ws.addRow([note]);
    ws.mergeCells(2, 1, 2, columns.length);
    nRow.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF7F7F7F' } };
    nRow.getCell(1).alignment = { vertical: 'top', wrapText: true };
    nRow.height = 26;
  }

  const hRow = ws.addRow(columns.map((c) => c.header));
  hRow.height = 22;
  for (let i = 1; i <= columns.length; i++) {
    const cell = hRow.getCell(i);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BLUE } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: HEADER_BLUE_DARK } } };
  }
  const headerRowIdx = hRow.number;
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];

  rows.forEach((r, ri) => {
    const row = ws.addRow(r);
    for (let i = 1; i <= columns.length; i++) {
      const col = columns[i - 1];
      const cell = row.getCell(i);
      cell.alignment = { vertical: 'top', wrapText: !!col.wrap };
      if (col.numFmt && typeof cell.value === 'number') cell.numFmt = col.numFmt;
      if (zebra && ri % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
      }
      const rule = colorCols[i - 1];
      const kind = rule ? rule(r[i - 1]) : null;
      if (kind) {
        const st = KIND_STYLE[kind];
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.fill } };
        cell.font = { color: { argb: st.font }, bold: kind === 'err' };
      }
    }
  });

  if (autoFilter && rows.length) {
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + rows.length, column: columns.length },
    };
  }
  return { ws, firstDataRow: headerRowIdx + 1 };
}

function sectionHeader(ws, text, span = 2) {
  const row = ws.addRow([text]);
  ws.mergeCells(row.number, 1, row.number, span);
  const cell = row.getCell(1);
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BLUE } };
  row.height = 20;
  return row;
}

function kvRow(ws, key, value, { valueKind = null, wrap = false } = {}) {
  const row = ws.addRow([key, value]);
  row.getCell(1).font = { bold: true, color: { argb: 'FF44546A' } };
  row.getCell(1).alignment = { vertical: 'top' };
  row.getCell(2).alignment = { vertical: 'top', wrapText: wrap };
  if (valueKind) {
    const st = KIND_STYLE[valueKind];
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.fill } };
    row.getCell(2).font = { color: { argb: st.font } };
  }
  return row;
}

// ------------------------------------------------------------- README sheet

function sheetGuide(d) {
  const has = (arr) => arr && arr.length > 0;
  const guide = [
    ['README', 'What this workbook is and how to read it'],
    ['Readiness Summary', 'Objectives, counts, open gaps, test status, maturity — the one-screen status'],
  ];
  if (has(d.components)) guide.push(['Dependency Inventory', 'One row per component: scope, layer, replication, dependencies, verification']);
  if (d.components.some((c) => (c.outboundCalls || []).length)) guide.push(['Outbound Calls', 'Every outbound dependency call and its failover behavior']);
  if (d.components.some((c) => (c.secrets || []).length)) guide.push(['Secrets Reconciliation', 'All secrets and their replication status — reconcile into ONE signed-off list']);
  if (has(d.gaps)) guide.push(['Gap List', 'Known gaps with severity, owner component, and status']);
  if (has(d.runbooks)) {
    guide.push(['Runbooks', 'One row per runbook with scenario and audience']);
    guide.push(['Runbook Steps', 'Every step flattened: layer, command, verify, gate']);
  }
  if (has(d.tests)) {
    guide.push(['Test Log', 'Every test/exercise with status and measured RTA/RPA']);
    if (d.tests.some((t) => (t.appTests || []).length)) guide.push(['App Test Catalog', 'Application-level success checks run during recovery tests']);
    if (d.tests.some((t) => (t.findings || []).length || t.record)) guide.push(['Test Records', 'Findings and narrative records per test']);
  }
  if (d.checklists.some((c) => (c.items || []).length)) guide.push(['Checklists', 'Phase 0 / preflight / game-day checklist items with proof and owner']);
  if (has(d.decisions)) guide.push(['Decision Log', 'Decisions made, their context, owner, and status']);
  if (has(d.contacts)) guide.push(['People', 'Who does what, contact and escalation paths']);
  guide.push(['DR Options Matrix', 'Reference: the four DR strategies with honest RTO/RPO/cost/complexity ranges']);
  if (d.components.some((c) => c.verification?.command || c.verification?.pass)) guide.push(['Verification Catalog', 'All verification commands ordered by restore layer']);
  return guide;
}

function addReadme(wb, d) {
  const ws = wb.addWorksheet('README');
  ws.getColumn(1).width = 30; ws.getColumn(2).width = 96;

  const t = ws.addRow([`${d.meta.name} — Disaster Recovery Tracker`]);
  t.height = 30; ws.mergeCells(1, 1, 1, 2);
  t.getCell(1).font = { size: 18, bold: true, color: { argb: HEADER_BLUE } };
  t.getCell(1).alignment = { vertical: 'middle' };

  const sub = ws.addRow(['Generated by DR Compass. This workbook is the current, complete picture of DR readiness: inventory, gaps, runbooks, tests, and decisions. Hand it to leadership, auditors, or partners — or import it into Google Sheets.']);
  ws.mergeCells(2, 1, 2, 2);
  sub.getCell(1).font = { size: 11, color: { argb: 'FF595959' } };
  sub.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  sub.height = 30;
  ws.addRow([]);

  sectionHeader(ws, 'Workspace');
  kvRow(ws, 'Workspace', d.meta.name);
  kvRow(ws, 'Organization', d.meta.org || '');
  if (d.meta.description) kvRow(ws, 'Description', d.meta.description, { wrap: true }).height = 40;
  kvRow(ws, 'Primary region', d.meta.regions?.primary || '');
  kvRow(ws, 'Recovery region', d.meta.regions?.recovery || '');
  kvRow(ws, 'DR strategy', d.meta.strategy || '');
  kvRow(ws, 'Tooling', join(d.meta.tooling));
  kvRow(ws, 'Generated', new Date().toISOString().slice(0, 10));
  ws.addRow([]);

  sectionHeader(ws, 'The honest-numbers rule');
  const honest = ws.addRow(['RTO/RPO are TARGETS the business signs off on. RTA/RPA are what your last test actually MEASURED. Until targets are formally approved and a test has hit them, quote only the measured RTA/RPA. A target nobody has tested is a hope, not a capability.']);
  ws.mergeCells(honest.number, 1, honest.number, 2);
  honest.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  honest.getCell(1).font = { italic: true, color: { argb: 'FF8A5A00' } };
  honest.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4D6' } };
  honest.height = 44;
  ws.addRow([]);

  sectionHeader(ws, 'Sheet guide');
  const hdr = ws.addRow(['Sheet', 'Purpose']);
  hdr.eachCell((c) => { c.font = { bold: true, color: { argb: 'FF44546A' } }; });
  for (const [name, purpose] of sheetGuide(d)) {
    const r = ws.addRow([name, purpose]);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true };
  }
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
  const ws = wb.addWorksheet('Readiness Summary');
  ws.getColumn(1).width = 34; ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 60;

  const t = ws.addRow(['Readiness Summary']);
  t.height = 26; ws.mergeCells(1, 1, 1, 3);
  t.getCell(1).font = { size: 14, bold: true, color: { argb: HEADER_BLUE } };
  ws.addRow([]);

  const obj = d.meta.objectives || {};
  sectionHeader(ws, 'Objectives (targets vs measured)', 3);
  const rows = [
    ['RTO target (min)', num(obj.rtoMinutes), 'Business sign-off target for time to restore'],
    ['RPO target (min)', num(obj.rpoMinutes), 'Business sign-off target for data loss window'],
    ['RTA measured (min)', num(obj.rtaMinutes), 'What the last test actually achieved'],
    ['RPA measured (min)', num(obj.rpaMinutes), 'Actual data age at the recovery point in the last test'],
  ];
  for (const [k, v, note] of rows) {
    const r = ws.addRow([k, v, note]);
    r.getCell(1).font = { bold: true, color: { argb: 'FF44546A' } };
    if (typeof v === 'number') r.getCell(2).numFmt = '0';
    r.getCell(3).font = { size: 10, color: { argb: 'FF7F7F7F' } };
  }
  kvRow(ws, 'Objectives approved by business', obj.approved ? 'yes' : 'no',
    { valueKind: obj.approved ? 'ok' : 'warn' });
  if (obj.notes) kvRow(ws, 'Notes', obj.notes, { wrap: true }).height = 30;
  ws.addRow([]);

  sectionHeader(ws, 'Components by category', 3);
  for (const [k, v] of [...countBy(d.components, (c) => c.category)].sort((a, b) => b[1] - a[1])) {
    kvRow(ws, k, v);
  }
  ws.addRow([]);

  sectionHeader(ws, 'Components by recovery scope', 3);
  for (const scope of ['yes', 'partial', 'no', 'unknown']) {
    const n = d.components.filter((c) => (c.inRecoveryScope || 'unknown') === scope).length;
    if (n) kvRow(ws, `in scope: ${scope}`, n, { valueKind: scopeRule(scope) });
  }
  ws.addRow([]);

  sectionHeader(ws, 'Open gaps by severity', 3);
  const openGaps = d.gaps.filter((g) => g.status !== 'resolved');
  if (openGaps.length) {
    for (const sev of ['blocker', 'high', 'medium', 'low']) {
      const n = openGaps.filter((g) => g.severity === sev).length;
      if (n) kvRow(ws, sev, n, { valueKind: sevRule(sev) });
    }
  } else {
    kvRow(ws, 'Tracked gap items', 0);
  }
  const inlineGaps = d.components.reduce((n, c) => n + (c.gaps || []).length, 0);
  if (inlineGaps) {
    kvRow(ws, 'Component-level gap notes', inlineGaps,
      { valueKind: 'warn' });
    ws.addRow(['', '', 'See the Gaps column on the Dependency Inventory sheet']).getCell(3)
      .font = { size: 10, color: { argb: 'FF7F7F7F' } };
  }
  ws.addRow([]);

  sectionHeader(ws, 'Tests by status', 3);
  if (d.tests.length) {
    for (const [k, v] of countBy(d.tests, (t2) => t2.status)) {
      kvRow(ws, k, v, { valueKind: testStatusRule(k) });
    }
  } else {
    kvRow(ws, 'Tests recorded', 0, { valueKind: 'warn' });
    ws.addRow(['', '', 'No recovery tests recorded yet — an untested plan is a hypothesis']).getCell(3)
      .font = { size: 10, italic: true, color: { argb: 'FF8A5A00' } };
  }
  ws.addRow([]);

  sectionHeader(ws, 'Maturity assessment', 3);
  const m = maturity(d.assessment);
  if (m) {
    kvRow(ws, 'Average answer score (0–4)', Math.round(m.avg * 100) / 100);
    kvRow(ws, 'Overall level', m.label, { valueKind: m.level >= 4 ? 'ok' : m.level >= 2 ? 'warn' : 'err' });
    kvRow(ws, 'Questions answered', m.answered);
    ws.addRow(['', '', 'Simple average across answered questions; see the Assessment page for per-pillar detail']).getCell(3)
      .font = { size: 10, color: { argb: 'FF7F7F7F' } };
  } else {
    kvRow(ws, 'Assessment', 'not answered yet', { valueKind: 'warn' });
  }
  return ws;
}

// ------------------------------------------------- extra workbook-only sheets

function addRunbooksSheet(wb, d) {
  addTableSheet(wb, 'Runbooks', {
    title: 'Runbooks',
    columns: [
      { header: 'Name', width: 32 }, { header: 'Tooling', width: 14 },
      { header: 'Scenario', width: 18 }, { header: 'Audience', width: 12 },
      { header: 'Steps', width: 8, numFmt: '0' },
      { header: 'Preconditions', width: 56, wrap: true },
      { header: 'Linked Tests', width: 34, wrap: true },
    ],
    rows: d.runbooks.map((rb) => [
      rb.name || '', rb.tooling || '', rb.scenario || '', rb.audience || '',
      (rb.steps || []).length, join(rb.preconditions, '; '),
      join((rb.linkedTestIds || []).map(d.testNameOf)),
    ]),
  });
}

function addAppTestCatalog(wb, d) {
  const rows = d.tests.flatMap((t) => (t.appTests || []).map((a) => [
    t.name || '', a.name || '', a.command || '', a.expected || '',
    d.nameOf(a.componentId), a.critical ? 'yes' : 'no',
  ]));
  if (!rows.length) return;
  addTableSheet(wb, 'App Test Catalog', {
    title: 'App Test Catalog',
    note: 'Application-level success checks: infrastructure being green is not the bar — a business transaction completing is.',
    columns: [
      { header: 'Test', width: 26 }, { header: 'App Test Name', width: 36, wrap: true },
      { header: 'Command', width: 44, wrap: true }, { header: 'Expected', width: 40, wrap: true },
      { header: 'Component', width: 26 }, { header: 'Critical', width: 9 },
    ],
    colorCols: { 5: criticalRule },
    rows,
  });
}

function addTestRecords(wb, d) {
  const rows = [];
  const recordRowIdxs = [];
  for (const t of d.tests) {
    for (const f of t.findings || []) {
      rows.push([t.name || '', t.date || '', f.title || '', f.severity || '', f.ticket || '']);
    }
    if (t.record) {
      rows.push([t.name || '', t.date || '', t.record, '', '']);
      recordRowIdxs.push(rows.length - 1);
    }
  }
  if (!rows.length) return;
  const { ws, firstDataRow } = addTableSheet(wb, 'Test Records', {
    title: 'Test Records',
    columns: [
      { header: 'Test', width: 28 }, { header: 'Date', width: 12 },
      { header: 'Finding / Record', width: 70, wrap: true },
      { header: 'Severity', width: 10 }, { header: 'Ticket', width: 14 },
    ],
    colorCols: { 3: sevRule },
    autoFilter: false,
    rows,
  });
  for (const i of recordRowIdxs) {
    const r = firstDataRow + i;
    ws.mergeCells(r, 3, r, 5);
    const cell = ws.getRow(r).getCell(3);
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.font = { italic: true };
  }
}

function addOptionsMatrix(wb) {
  addTableSheet(wb, 'DR Options Matrix', {
    title: 'DR Options Matrix — the four strategies, honestly',
    note: 'Costs are relative, ranges are typical for AWS multi-region setups. A measured RTA from a real test beats every number in this table.',
    columns: [
      { header: 'Strategy', width: 18 }, { header: 'Typical RTO', width: 22 },
      { header: 'Typical RPO', width: 26 }, { header: 'Cost', width: 30, wrap: true },
      { header: 'Complexity', width: 14 }, { header: 'When to choose', width: 64, wrap: true },
    ],
    autoFilter: false,
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

// ----------------------------------------------------------------- workbook

export async function buildWorkbook(slug) {
  const d = loadData(slug);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DR Compass';
  wb.created = new Date();

  addReadme(wb, d);
  addReadiness(wb, d);

  const addDataset = (sheetName, key, extra = {}) => {
    const ds = DATASETS[key];
    const rows = ds.rows(d);
    if (!rows.length) return;
    addTableSheet(wb, sheetName, {
      title: ds.title, note: ds.note, columns: ds.columns,
      colorCols: ds.colorCols || {}, rows, ...extra,
    });
  };

  addDataset('Dependency Inventory', 'components');
  addDataset('Outbound Calls', 'outbound-calls');
  addDataset('Secrets Reconciliation', 'secrets');
  addDataset('Gap List', 'gaps');
  if (d.runbooks.length) addRunbooksSheet(wb, d);
  addDataset('Runbook Steps', 'runbook-steps');
  addDataset('Test Log', 'tests');
  addAppTestCatalog(wb, d);
  addTestRecords(wb, d);
  addDataset('Checklists', 'checklists');
  addDataset('Decision Log', 'decisions');
  addDataset('People', 'contacts');
  addOptionsMatrix(wb);
  addDataset('Verification Catalog', 'verification-catalog');

  return wb;
}
