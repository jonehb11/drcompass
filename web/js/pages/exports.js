import { h, card, badge, toast, empty } from '../ui.js';
import * as ui from '../ui.js';
import { createZip } from '../zip.js';
import { measuredNumbers } from '../measured.js';

// ui.term() is a glossary helper owned by another page's author; use it when it
// is there and fall back to plain text when it is not.
const gloss = (key, label) => (typeof ui.term === 'function'
  ? ui.term(key, label)
  : document.createTextNode(label || key));

// The workbook's sheets, in the order buildWorkbook() writes them.
// Deployment Order appears only when the deploy-order engine is available.
const SHEETS_PREVIEW = [
  'Executive Summary', 'How to use', 'Resource Graph', 'Runtime',
  'Outbound Calls', 'Dependencies', 'Deployment Order', 'Tests',
  'Runbooks', 'Workbench',
];

// [csv id, human name, one-line purpose, rows(counts) -> number|null]
const CSVS = [
  ['components', 'Dependency inventory', 'Every component with its owner, restore layer, DR strategy, replication and gaps.', (c) => c.components.length],
  ['outbound-calls', 'Outbound calls', 'Who each service calls out to, and what that call does on failover.', (c) => c.outboundCalls],
  ['secrets', 'Secrets reconciliation', 'Every secret and whether it is replicated — the list that has to be signed off.', (c) => c.secrets],
  ['gaps', 'Gap list', 'Open gaps with severity, owner-component and ticket.', (c) => c.gaps.length],
  ['runbook-steps', 'Runbook steps', 'Every step of every runbook, flattened — commands, verify and pass criteria.', (c) => c.steps],
  ['tests', 'Test log', 'One row per recovery test with its measured RTA/RPA.', (c) => c.tests.length],
  ['checklists', 'Checklists', 'Pre-test and cutover checklist items with their proof requirement.', (c) => c.checklistItems],
  ['decisions', 'Decision log', 'Decisions with context, so they are not re-argued mid-incident.', (c) => c.decisions.length],
  ['contacts', 'People / contacts', 'Who does what during a recovery, and how to reach them.', (c) => c.contacts.length],
  ['verification-catalog', 'Verification catalog', 'The command that proves each component came back, in restore-layer order.', (c) => c.verifications],
  ['resource-graph', 'Discovered AWS resources', 'Every discovered resource behind each component, flat — the Dependencies tree as a table.', () => null],
  ['k8s-workloads', 'Kubernetes workloads', 'Cluster workload census with images, service accounts and mounts.', () => null],
];

// Overview diagrams worth carrying in a whole-workspace package, and the
// per-service set. Anything the server does not list is silently skipped.
const WORKSPACE_DIAGRAMS = ['architecture', 'dependencies', 'restore-layers',
  'region-pair', 'data-replication', 'resource-map'];

// draw.io exports that have an AWS-shape variant worth preferring.
const AWS_DRAWIO = /^(architecture|dependencies|resource-map)(-|$)/;

const PKG_STYLE = `
  .pkg-card { border-color: rgba(79,143,247,.35); }
  .pkg-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 900px) { .pkg-grid { grid-template-columns: 1fr; } }
  .pkg-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 14px; margin-top: 4px; }
  .pkg-opts label { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
  .pkg-opts input { width: auto; margin-top: 3px; }
  .pkg-preview { font-size: 12.5px; color: var(--muted); margin-top: 8px; min-height: 18px; }
  .pkg-preview.warn { color: var(--warn); }
  .pkg-steps { list-style: none; margin: 10px 0 0; padding: 0; max-height: 280px; overflow-y: auto;
    font-size: 12.5px; font-family: var(--mono); }
  .pkg-steps li { display: flex; gap: 10px; padding: 3px 0; color: var(--muted); }
  .pkg-steps li .pkg-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-steps li .pkg-status { flex: none; width: 16px; text-align: center; }
  .pkg-steps li.done { color: var(--text); }
  .pkg-steps li.done .pkg-status { color: var(--ok); }
  .pkg-steps li.skip .pkg-status { color: var(--warn); }
  .pkg-steps li.fail .pkg-status { color: var(--err); }
  .pkg-tree { font-family: var(--mono); font-size: 11.5px; color: var(--muted); line-height: 1.7; margin: 0; }
  .pkg-summary:not(:empty) { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
  .pkg-sum-head { font-size: 12.5px; font-weight: 600; margin-bottom: 4px; }
  .pkg-sum-head.warn { color: var(--warn); margin-top: 10px; }
  .pkg-sum-line { font-size: 12.5px; color: var(--muted); }
  .pkg-sum-line.ok { color: var(--ok); }
  .pkg-sum-notes { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
  .pkg-sum-notes li { margin-bottom: 3px; }

  /* secondary downloads: one group per audience */
  .dl-group { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 14px; }
  .dl-group:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .dl-group h3 { margin: 0 0 2px; font-size: 13.5px; }
  .dl-group .dl-for { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .dl-row { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between;
    padding: 6px 0; border-bottom: 1px solid var(--border); }
  .dl-row:last-child { border-bottom: 0; }
  .dl-row .dl-what { min-width: 0; }
  .dl-row .dl-name { font-size: 13px; font-weight: 600; }
  .dl-row .dl-why { font-size: 12px; color: var(--muted); }
  .dl-row .dl-act { flex: none; display: flex; gap: 6px; align-items: center; }
  .dl-scope { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
`;

// Mirrors the Mermaid setup on the Diagrams page (web/js/pages/diagrams.js) —
// same theme, and the same raised maxTextSize/maxEdges, because a real
// inventory blows past mermaid's defaults. Module URL is identical, so if the
// Diagrams page already imported mermaid this resolves to that same instance.
const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  maxTextSize: 1_000_000,
  maxEdges: 10_000,
  flowchart: { maxEdges: 10_000 },
  themeVariables: {
    background: '#171c25',
    primaryColor: '#1d2431',
    primaryTextColor: '#e6ebf2',
    primaryBorderColor: '#2a3242',
    secondaryColor: '#12161d',
    tertiaryColor: '#171c25',
    lineColor: '#8a94a6',
    clusterBkg: '#12161d',
    clusterBorder: '#2a3242',
    edgeLabelBackground: '#171c25',
    noteBkgColor: '#1d2431',
    noteBorderColor: '#2a3242',
    noteTextColor: '#e6ebf2',
    actorBkg: '#1d2431',
    actorBorder: '#2a3242',
    actorTextColor: '#e6ebf2',
    signalColor: '#8a94a6',
    signalTextColor: '#e6ebf2',
    fontFamily: 'ui-sans-serif',
  },
};

let mermaidPromise = null;   // one import + one initialize per page load
let renderSeq = 0;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('/vendor/mermaid/mermaid.esm.min.mjs').then((mod) => {
      const mermaid = mod.default || mod;
      // The Diagrams page initializes on import with the same config; guard so
      // we never initialize twice from here.
      if (!mermaid.__drcompassPkgInit) {
        mermaid.initialize(MERMAID_CONFIG);
        try { mermaid.__drcompassPkgInit = true; } catch { /* frozen module object */ }
      }
      return mermaid;
    }).catch((e) => { mermaidPromise = null; throw e; });
  }
  return mermaidPromise;
}

// --------------------------------------------------------------- utilities

const today = () => new Date().toISOString().slice(0, 10);

const slug = (s, fallback = 'item') => String(s || '')
  .normalize('NFKD')
  .replace(/[^\w.-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase() || fallback;

const titleCase = (s) => String(s || '')
  .split(/[-_\s]+/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

function downloadBlob(name, content) {
  const type = name.endsWith('.json') ? 'application/json'
    : name.endsWith('.md') ? 'text/markdown' : 'text/csv';
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

function saveZipBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 8000);
}

// ------------------------------------------------- client-side SVG renders

async function renderMermaidSvg(src) {
  const mermaid = await loadMermaid();
  const id = `pkg_svg_${++renderSeq}`;
  try {
    const { svg } = await mermaid.render(id, src);
    return svg;
  } catch (e) {
    document.getElementById(id)?.remove(); // mermaid's scratch node on failure
    throw e;
  }
}

// Canvas-backed diagrams (resource maps) have no useful Mermaid form at scale:
// mount the icon-canvas engine into a hidden offscreen host, export, tear down.
async function renderCanvasSvg({ ws, api, id }) {
  const mod = await import('../diagram-canvas.js');
  if (typeof mod.createCanvas !== 'function') throw new Error('icon-canvas engine unavailable');
  const data = await api.get(`/w/${ws}/diagrams/${id}/canvas`);
  let saved = null;
  try { saved = await api.get(`/w/${ws}/layouts/${id}`); } catch { /* no saved layout */ }
  const host = h('div', {
    style: 'position:fixed; left:-10000px; top:0; width:1400px; height:900px; '
      + 'opacity:0; pointer-events:none; z-index:-1; overflow:hidden',
    'aria-hidden': 'true',
  });
  document.body.append(host);
  let ctl = null;
  try {
    ctl = await mod.createCanvas(host, {
      data,
      positions: saved?.positions || null,
      template: saved?.template || 'category-grid',
      readOnly: true,
    });
    const svg = await ctl.exportSvg();
    if (!svg) throw new Error('canvas produced no SVG');
    return svg;
  } finally {
    try { ctl?.destroy?.(); } catch { /* engine cleanup is best-effort */ }
    host.remove();
  }
}

// ------------------------------------------------- diagram collection (shared)

// Where a diagram's three files land, per flow. The DR Package keeps them
// together under diagrams/; the standalone diagram pack splits by format.
export const DIAGRAM_LAYOUT = {
  package: { svg: (id) => `diagrams/${id}.svg`, drawio: (id) => `diagrams/${id}.drawio`, mmd: (id) => `diagrams/${id}.mmd` },
  pack: { svg: (id) => `svg/${id}.svg`, drawio: (id) => `drawio/${id}.drawio`, mmd: (id) => `mermaid/${id}.mmd` },
};

/**
 * Fetch/render one diagram into up to three files (SVG rendered client-side,
 * draw.io XML, Mermaid source). Never throws for a single bad artifact — what
 * fails becomes a note. Returns the list of formats collected.
 */
export async function collectDiagram({ ws, api, entry, files, notes, layout = DIAGRAM_LAYOUT.package }) {
  const id = String(entry.id);
  const got = [];
  const why = [];   // one consolidated note per diagram, not three

  // --- SVG (rendered client-side) ---
  try {
    let svg = null;
    let src = '';
    try { src = (await api.get(`/w/${ws}/diagrams/${id}`))?.mermaid || ''; }
    catch { /* mermaid form unavailable — canvas may still work */ }
    // Resource maps are the icon-canvas's home turf: their Mermaid form is
    // huge and reads poorly, so render the canvas and keep Mermaid as backup.
    const canvasFirst = /^resource-map(-|$)/.test(id) && entry.canvas;
    if (canvasFirst) {
      try { svg = await renderCanvasSvg({ ws, api, id }); }
      catch (e) { why.push(`icon-canvas render failed (${e.message || e})`); }
    }
    if (!svg && src.trim()) svg = await renderMermaidSvg(src);
    if (!svg && !canvasFirst && entry.canvas) svg = await renderCanvasSvg({ ws, api, id });
    if (svg) { files.push({ path: layout.svg(id), data: svg, label: `${entry.name || id} — rendered diagram, opens in any browser.` }); got.push('svg'); }
    else why.push('no SVG could be rendered');
  } catch (e) {
    why.push(`SVG render failed (${e.message || e})`);
  }

  // --- draw.io (AWS shapes where the generator offers them) ---
  try {
    let xml = null;
    if (AWS_DRAWIO.test(id)) {
      try { xml = await fetchText(`/api/w/${ws}/diagrams/${id}/drawio?style=aws`); }
      catch { /* fall through to the plain shape set */ }
    }
    if (!xml) xml = await fetchText(`/api/w/${ws}/diagrams/${id}/drawio`);
    files.push({ path: layout.drawio(id), data: xml, label: `${entry.name || id} — editable in draw.io / app.diagrams.net.` });
    got.push('drawio');
  } catch (e) {
    why.push(`no draw.io export (${e.message || e})`);
  }

  // --- Mermaid source ---
  try {
    const mmd = await fetchText(`/api/w/${ws}/diagrams/${id}/mmd`);
    if (mmd.trim()) { files.push({ path: layout.mmd(id), data: mmd, label: `${entry.name || id} — Mermaid source for Lucidchart, GitHub, Notion.` }); got.push('mmd'); }
  } catch { /* canvas-only diagram — no mermaid form, not worth a note */ }

  if (!got.length) notes.push(`Skipped \`${id}\` — ${why.join('; ') || 'nothing to export'}.`);
  else if (why.length) notes.push(`\`${id}\`: exported ${got.join(' + ')}, but ${why.join('; ')}.`);
  return got;
}

// Per-component diagrams are named after the component, so "Dependency graph"
// and "resource map" views of one service would otherwise read identically in
// the progress list.
export function diagramStepLabel(entry) {
  const id = String(entry?.id ?? '');
  const name = entry?.name || id;
  if (/^dependencies-./.test(id)) return `Diagram: ${name} — dependencies`;
  if (/^resource-map-./.test(id)) return `Diagram: ${name} — resource map`;
  return `Diagram: ${name}`;
}

/** The diagrams the DR Package embeds: overviews, or the service's own views. */
export function diagramPlan(list, rootId) {
  const byId = new Map((Array.isArray(list) ? list : []).map((d) => [String(d.id), d]));
  const want = rootId
    ? ['architecture', `dependencies-${rootId}`, `resource-map-${rootId}`, 'restore-layers']
    : WORKSPACE_DIAGRAMS;
  return want.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

/**
 * Every diagram worth putting in a standalone pack.
 * Whole workspace → the entire server list (overviews, per-component
 * dependency views, resource maps, and k8s diagrams when a snapshot exists).
 * Service scope → the overviews plus the dependency/resource-map views of
 * every component in scope (k8s diagrams are cluster-wide, not per-service).
 */
export function diagramPackPlan(list, componentIds) {
  const all = (Array.isArray(list) ? list : []).filter((d) => d && d.id);
  if (!componentIds || !componentIds.length) return all;
  const ids = new Set(componentIds.map(String));
  const wanted = new Set();
  for (const cid of ids) { wanted.add(`dependencies-${cid}`); wanted.add(`resource-map-${cid}`); }
  return all.filter((d) => {
    const id = String(d.id);
    if (wanted.has(id)) return true;
    if (d.kind === 'component' || /^resource-map-./.test(id)) return false; // other services
    if (d.kind === 'k8s' || d.section === 'k8s' || /^k8s-/.test(id)) return false;
    return true; // overview diagrams: keep, they frame the service
  });
}

// ------------------------------------------------------------ README/cover

// What each file in the package is, and who it is for. The README's contents
// table is built from this, so a reader never has to guess why a file is there.
const FILE_KINDS = [
  {
    re: /^EXECUTIVE-SUMMARY\.md$/,
    purpose: 'The 90-second read: what this covers, the DR strategy, the honest numbers (targets vs measured), top risks with owners, test history, next actions.',
    who: 'Leadership, auditors',
  },
  {
    re: /^RUNBOOK-QUICKREF\.txt$/,
    purpose: 'The chosen runbook stripped to steps, commands, checks and pass criteria. Plain text, no formatting to read around.',
    who: 'On-call, mid-incident',
  },
  {
    re: /^README\.md$/,
    purpose: 'This cover sheet — what is in the package and what to read first.',
    who: 'Everyone',
  },
  {
    re: /^workbook\//,
    purpose: 'The full DR picture in one Excel file: Executive Summary, the Dependencies tree (restore order), gaps, runbooks, tests, verifications.',
    who: 'Anyone who lives in spreadsheets',
  },
  {
    re: /^runbooks\//,
    purpose: 'Step-by-step recovery procedure with verify/pass criteria, rollback, and a sign-off table to fill in as you go.',
    who: 'Operators running the recovery',
  },
  {
    re: /^diagrams\/.*\.svg$/,
    purpose: 'Rendered diagram — drop straight into slides, a wiki, or a printed binder.',
    who: 'Anyone explaining the system',
  },
  {
    re: /^diagrams\/.*\.drawio$/,
    purpose: 'Editable diagram for draw.io / app.diagrams.net (AWS shapes where available).',
    who: 'Whoever redraws it',
  },
  {
    re: /^diagrams\/.*\.mmd$/,
    purpose: 'Mermaid source — paste into Lucidchart, Notion, GitHub, or any Mermaid renderer.',
    who: 'Docs maintainers',
  },
  {
    re: /^data\/workspace\.json$/,
    purpose: 'Workspace metadata: regions, strategy, tooling, objectives.',
    who: 'Tooling, scripts',
  },
  {
    re: /^data\/.*\.csv$/,
    purpose: 'Raw table for Google Sheets or analysis (File → Import → Upload).',
    who: 'Analysts, ticket-writers',
  },
  {
    re: /^manifest\.json$/,
    purpose: 'Machine-readable index: every file, its size, the scope, and the generation notes.',
    who: 'Tooling, scripts',
  },
  {
    re: /^MANIFEST\.txt$/,
    purpose: 'The same index in plain text, so you can read it without a JSON viewer.',
    who: 'Everyone',
  },
];
const DEFAULT_KIND = { purpose: 'Package file.', who: '—' };
const kindOf = (path) => FILE_KINDS.find((k) => k.re.test(String(path))) || DEFAULT_KIND;

// A file may carry its own label (the diagram or table it actually is);
// otherwise fall back to the purpose of its folder.
const purposeOf = (file) => {
  if (typeof file === 'string') return kindOf(file).purpose;
  return file.label || kindOf(file.path).purpose;
};
const whoOf = (file) => kindOf(typeof file === 'string' ? file : file.path).who;

// The order a reader should meet the files in, not the order they were built.
const READ_ORDER = ['EXECUTIVE-SUMMARY.md', 'README.md', 'RUNBOOK-QUICKREF.txt',
  'workbook/', 'runbooks/', 'diagrams/', 'data/', 'MANIFEST.txt', 'manifest.json'];
const readRank = (path) => {
  const i = READ_ORDER.findIndex((p) => (p.endsWith('/') ? String(path).startsWith(p) : path === p));
  return i === -1 ? READ_ORDER.length : i;
};

// CSV sheet id → the human name used on this page, for the README inventory.
const CSV_LABEL = new Map(CSVS.map(([id, label]) => [id, label]));
const CSV_PURPOSE = new Map(CSVS.map(([id, , purpose]) => [id, purpose]));

function objectivesSection(meta, tests = []) {
  const o = meta?.objectives || {};
  const has = (v) => v !== null && v !== undefined && v !== '';
  const min = (v) => (has(v) ? `${v} min` : null);
  const target = (v) => min(v) ?? '**not set**';
  // "RTA (achieved) | 47 min | Measured in a recovery test — this is the number
  // you can defend" was printed off the hand-typed Settings field. Now the row
  // label, the value and the explanation all come from the number's state.
  const honest = measuredNumbers(meta || {}, tests, null);
  const row = (label, slot) => {
    const cell = slot.minutes == null
      ? '**not measured yet**'
      : `${slot.minutes} min${slot.state === 'measured' && slot.test
        ? ` _(${slot.test.name}${slot.test.date ? ` — ${slot.test.date}` : ''} — passed)_` : ''}`;
    const name = slot.state === 'measured' ? `${label} (measured)`
      : slot.state === 'declared' ? `${label} — **recorded by hand**, not measured`
        : `${label} — **unmeasured**`;
    return `| ${name} | ${cell} | ${String(slot.note || '').replace(/\|/g, '\\|')} |`;
  };
  const lines = [
    '## Objectives — read the numbers honestly',
    '',
    '| | Value | What it actually is |',
    '| --- | --- | --- |',
    `| RTO (target) | ${target(o.rtoMinutes)} | Target${o.approved ? ', approved by the business' : ' — **not yet approved by the business**'} |`,
    `| RPO (target) | ${target(o.rpoMinutes)} | Target${o.approved ? ', approved by the business' : ' — **not yet approved by the business**'} |`,
    row('RTA', honest.rta),
    row('RPA', honest.rpa),
    '',
    'RTO/RPO are goals. RTA/RPA are evidence **only when a test that passed produced them** — a number typed '
      + 'into Settings by hand is a note to self. When someone asks "how fast can we recover?", quote a measured '
      + 'number and name the test that produced it; a target nobody has met is not a recovery capability.',
  ];
  if (honest.warnings.length) {
    lines.push('', ...honest.warnings.map((w) => `> ${w}`));
  }
  if (o.notes) lines.push('', `> ${String(o.notes).replace(/\r?\n/g, ' ')}`);
  return lines.join('\n');
}

// Group the file list for the contents table: one row per file, but folders
// with many files (diagrams, data) collapse into a counted heading first.
function contentsRows(files) {
  const sorted = [...files].sort((a, b) => readRank(a.path) - readRank(b.path)
    || String(a.path).localeCompare(String(b.path)));
  return sorted.map((f) => [f.path, purposeOf(f), whoOf(f)]);
}

export function buildReadme({
  meta, ws, scope, files, notes, options, quickrefOf = null, aiNarrative = false, tests = [],
}) {
  const name = meta?.name || ws;
  const regions = meta?.regions || {};
  const has = (p) => files.some((f) => f.path === p || String(f.path).startsWith(p));
  const scopeLine = scope.componentId
    ? `**Service scope: ${scope.componentName}**${scope.componentIds?.length > 1 ? ` — plus the ${scope.componentIds.length - 1} components it depends on or that depend on it` : ''}`
    : '**Whole workspace** — every component in the inventory';

  const L = [];
  L.push(`# DR Package — ${name}`, '');
  L.push(`${scopeLine}.`, '');

  // ---- read this first: an explicit path through the package ----
  L.push('## Read this first', '');
  const order = [];
  if (has('EXECUTIVE-SUMMARY.md')) order.push('1. **`EXECUTIVE-SUMMARY.md`** — 90 seconds. Where recovery actually stands: the honest numbers, the top risks, what is next.');
  if (has('workbook/')) order.push(`${order.length + 1}. **\`workbook/\`** — the Excel file. Open the **Executive Summary** sheet, then **Dependencies** (restore layer L0 first: what has to come back before what). Every sheet's first row says what the sheet is for.`);
  if (has('runbooks/')) order.push(`${order.length + 1}. **\`runbooks/\`** — the procedures. Read the one matching the scenario you care about before you need it.`);
  if (has('RUNBOOK-QUICKREF.txt')) order.push(`${order.length + 1}. **\`RUNBOOK-QUICKREF.txt\`** — during an incident, this one${quickrefOf ? ` (${quickrefOf})` : ''}: steps, commands and checks, nothing else.`);
  if (!order.length) order.push('1. `MANIFEST.txt` — this package was built with most sections deselected; the manifest lists what it does contain.');
  L.push(...order, '');

  L.push('| | |', '| --- | --- |');
  L.push(`| Workspace | ${name} (\`${ws}\`) |`);
  if (meta?.org) L.push(`| Organization | ${meta.org} |`);
  L.push(`| Scope | ${scope.componentId ? `${scope.componentName} (\`${scope.componentId}\`)` : 'Whole workspace'} |`);
  L.push(`| Regions | \`${regions.primary || '?'}\` → \`${regions.recovery || '?'}\` |`);
  if (meta?.strategy) L.push(`| Strategy | ${meta.strategy} |`);
  if (meta?.tooling?.length) L.push(`| Tooling | ${meta.tooling.join(', ')} |`);
  L.push(`| Files | ${files.length + 3} |`);
  L.push(`| Generated | ${new Date().toISOString()} |`);
  L.push('| Generated by | DR Compass |', '');

  if (meta?.description) L.push(meta.description, '');

  // ---- contents: file → purpose → audience ----
  L.push('## Contents', '');
  L.push('| File | What it is | Who it is for |', '| --- | --- | --- |');
  L.push('| `README.md` | This cover sheet — what is in the package and what to read first. | Everyone |');
  for (const [path, purpose, who] of contentsRows(files)) {
    L.push(`| \`${path}\` | ${String(purpose).replace(/\|/g, '\\|')} | ${who} |`);
  }
  L.push('| `MANIFEST.txt` | Plain-text index: every file with its size, plus the generation notes. | Everyone |');
  L.push('| `manifest.json` | The same index, machine-readable. | Tooling, scripts |', '');

  L.push(objectivesSection(meta, tests), '');

  // ---- how to use it, by situation ----
  L.push('## Using this during a DR event', '');
  L.push('**Start with the runbook.** Work the steps in order and fill in the sign-off table as you go '
    + '(T0, first access restored, T1, RTA/RPA) — that table is the evidence you will be asked for afterwards. '
    + 'Never skip a step marked **GATE**: it exists because something downstream fails silently without it.', '');
  if (has('RUNBOOK-QUICKREF.txt')) {
    L.push('If you are working from a terminal, `RUNBOOK-QUICKREF.txt` is the same procedure with the prose '
      + 'removed — steps, commands, checks, pass criteria, sign-off blanks.', '');
  }
  L.push('When a step needs context — what depends on what, what has to come up first, which store replicates '
    + 'how — the workbook\'s **Dependencies** sheet answers it: it is ordered by restore layer, every row names '
    + 'the component it belongs to, and each service\'s "needs / needed by" block is open by default. '
    + '`diagrams/` has the same picture visually (`.svg` to look at, `.drawio` and `.mmd` to edit).', '');

  L.push('## Using this in a review', '');
  L.push('`EXECUTIVE-SUMMARY.md` is the meeting document; the workbook\'s **Executive Summary** sheet is the '
    + 'same content, and it prints to one page. The **Gap List**, **Checklists**, **Runbook Steps** and '
    + '**Verification Catalog** sheets are set up to print landscape, fit to one page wide, with the header '
    + 'row repeated and the workspace, date and page numbers in the header/footer. `data/` has every table as '
    + 'CSV when you want to sort, filter, or paste into a ticket.', '');

  L.push('## Before you rely on this', '');
  L.push('- This package is a **point-in-time snapshot** of the workspace as of the generated timestamp above. '
    + 'Anything changed since — new components, rotated secrets, edited runbooks — is not in here. Regenerate before a test.');
  L.push('- Work the **pre-test checklist** in the workbook (Checklists sheet) before declaring readiness: '
    + 'replication green *after* the most recent guardrail/policy change, backup error count at zero, '
    + 'secrets reconciled into one signed-off list, and the known blockers re-verified in the recovery region.');
  L.push('- Open gaps in the Gap List sheet are the things that will bite you. An untested runbook is a hypothesis, not a plan.');
  L.push('- Numbers in this package are only as honest as the workspace: a blank RTA/RPA means **nobody has measured it**, '
    + 'and nothing here estimates on your behalf.');
  const off = ['workbook', 'diagrams', 'runbooks', 'data'].filter((k) => !options[k]);
  if (off.length) {
    L.push(`- Deselected when this package was built: ${off.join(', ')}. \`MANIFEST.txt\` lists exactly what it contains.`);
  }
  if (aiNarrative) {
    L.push('- `EXECUTIVE-SUMMARY.md` ends with a narrative section written by your local AI. The tables above it '
      + 'are computed; the narrative is not. Review it before sharing.');
  }
  L.push('');

  if (notes.length) {
    L.push('## What was skipped, and why', '');
    L.push('Nothing below stopped the package from being built — each line is a file that is absent, or present '
      + 'with a caveat, and the reason.', '');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}

/** The manifest a human can read without a JSON viewer. */
export function manifestText({ manifest, notes }) {
  const m = manifest;
  const pad = (s, n) => String(s).padEnd(n);
  const L = [];
  L.push('DR PACKAGE — CONTENTS');
  L.push('='.repeat(78));
  L.push(`Workspace   : ${m.workspace?.name || ''} (${m.workspace?.slug || ''})`);
  if (m.workspace?.regions) {
    L.push(`Regions     : ${m.workspace.regions.primary || '?'} -> ${m.workspace.regions.recovery || '?'}`);
  }
  L.push(`Scope       : ${m.scope?.kind === 'service' ? `${m.scope.componentName} (${m.scope.componentId})` : 'whole workspace'}`);
  if (m.scope?.componentIds?.length) L.push(`              ${m.scope.componentIds.length} components in scope`);
  L.push(`Generated   : ${m.generatedAt}`);
  L.push(`Generated by: ${m.app || 'DR Compass'}`);
  L.push(`Files       : ${(m.files || []).length} listed below, plus manifest.json and MANIFEST.txt`);
  L.push('');
  L.push('FILES');
  L.push('-'.repeat(78));
  const rows = [...(m.files || [])].sort((a, b) => readRank(a.path) - readRank(b.path)
    || String(a.path).localeCompare(String(b.path)));
  const w = Math.min(64, Math.max(20, ...rows.map((f) => f.path.length)));
  for (const f of rows) L.push(`  ${pad(f.path, w)}  ${fmtBytes(f.bytes).padStart(8)}   ${whoOf(f.path)}`);
  L.push('');
  if (notes?.length) {
    L.push('SKIPPED / CAVEATS');
    L.push('-'.repeat(78));
    for (const n of notes) {
      L.push(`  - ${String(n).replace(/`/g, '').replace(/\*\*/g, '')}`);
    }
    L.push('');
  }
  L.push('Read README.md first. RTO/RPO in this package are targets; RTA/RPA are measurements.');
  L.push('');
  return L.join('\n');
}

function diagramPackReadme({ meta, ws, scope, entries, files, notes }) {
  const name = meta?.name || ws;
  const L = [];
  L.push(`# Diagram pack — ${name}`, '');
  L.push(scope.componentId
    ? `Service scope: **${scope.componentName}** and the components it touches.`
    : 'Whole workspace — every diagram DR Compass generates from this inventory.', '');
  L.push('| | |', '| --- | --- |');
  L.push(`| Workspace | ${name} (\`${ws}\`) |`);
  if (meta?.regions) L.push(`| Regions | \`${meta.regions.primary || '?'}\` → \`${meta.regions.recovery || '?'}\` |`);
  L.push(`| Diagrams | ${entries.length} |`);
  L.push(`| Generated | ${new Date().toISOString()} |`);
  L.push(`| Generated by | DR Compass |`, '');

  L.push('## What each diagram is', '');
  L.push('| Diagram | File name | What it shows |', '| --- | --- | --- |');
  for (const e of entries) {
    L.push(`| ${e.name || e.id} | \`${e.id}\` | ${(e.description || '—').replace(/\|/g, '\\|')} |`);
  }
  L.push('');

  L.push('## Three formats, same diagram', '');
  L.push('- `svg/` — rendered, ready to drop into slides, a wiki, or a printed binder. Opens in any browser.');
  L.push('- `drawio/` — editable source. Open [app.diagrams.net](https://app.diagrams.net) → **File → Open from → Device**, '
    + 'or open the file in the draw.io desktop app. Architecture-family diagrams use the official AWS shape library where the server offers it.');
  L.push('- `mermaid/` — Mermaid text. In Lucidchart: **Insert → Diagram as code → Mermaid**, then paste the file contents. '
    + 'GitHub, GitLab, Notion, and Obsidian render Mermaid in a fenced ```mermaid block as-is.');
  L.push('');
  L.push(`This pack contains ${files.length} files. See \`manifest.json\` for the full index.`, '');
  if (notes.length) {
    L.push('## Notes from generation', '');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}

/**
 * Build the standalone diagram pack: every diagram in scope, as SVG +
 * draw.io + Mermaid, plus a short README and a manifest. Importing this
 * module has no side effects, so any page can import and call this.
 *
 * @param {object}   o
 * @param {string}   o.ws        workspace slug
 * @param {object}   o.api       the shared api client (web/js/api.js)
 * @param {string|object|null} [o.scope]   componentId, or {componentId, componentName, componentIds}
 * @param {object}   [o.meta]    workspace meta (fetched when omitted)
 * @param {Function} [o.onStep]  (label) => {ok, skip, fail} progress reporter
 * @param {boolean}  [o.download=true] trigger the browser download
 * @returns {Promise<{blob: Blob, filename: string, files: Array, notes: string[], manifest: object}>}
 */
export async function buildDiagramPack({ ws, api, scope = null, meta = null, onStep = null, download = true } = {}) {
  const step = typeof onStep === 'function' ? onStep : () => ({ ok() {}, skip() {}, fail() {} });
  const notes = [];
  const files = [];

  const scopeIn = typeof scope === 'string' ? { componentId: scope } : (scope || {});
  const componentId = scopeIn.componentId || null;
  let componentIds = Array.isArray(scopeIn.componentIds) ? scopeIn.componentIds.map(String) : null;
  let componentName = scopeIn.componentName || null;

  if (!meta) { try { meta = await api.get(`/w/${ws}/workspace`); } catch { /* slug-only cover */ } }

  // Resolve the scope ourselves when the caller only handed us an id.
  if (componentId && (!componentIds || !componentIds.length)) {
    const s = step(`Scope: ${componentName || componentId}`);
    try {
      const info = await api.get(`/w/${ws}/export/scope/${encodeURIComponent(componentId)}`);
      componentIds = (info.componentIds || (info.components || []).map((c) => c.id) || []).map(String);
      componentName = info.root?.name || componentName || componentId;
      s.ok(`${componentIds.length} components`);
    } catch {
      componentIds = [String(componentId)];
      componentName = componentName || componentId;
      s.skip('scope endpoint unavailable — this service only');
      notes.push('The scope endpoint is not available on this server, so the pack covers the selected '
        + 'service and the overview diagrams only, not its dependency neighbourhood.');
    }
  }

  let list = [];
  try { list = await api.get(`/w/${ws}/diagrams`); }
  catch (e) {
    notes.push(`Diagram list unavailable: ${e.message || e}`);
    step('Diagram list').fail(String(e.message || e));
  }
  const entries = diagramPackPlan(list, componentIds);
  if (!entries.length) throw new Error('no diagrams available for this scope');

  let done = 0;
  for (const entry of entries) {
    const s = step(diagramStepLabel(entry));
    try {
      const got = await collectDiagram({ ws, api, entry, files, notes, layout: DIAGRAM_LAYOUT.pack });
      if (got.length) { s.ok(`${got.join(' + ')} · ${++done}/${entries.length}`); }
      else s.fail('nothing exported');
    } catch (e) {
      s.fail(String(e.message || e));
      notes.push(`Diagram \`${entry.id}\` failed: ${e.message || e}`);
    }
  }
  if (!files.length) throw new Error('every diagram export failed — nothing to package');

  const scopeSlug = componentId ? slug(componentName || componentId, 'service') : 'workspace';
  const scopeOut = componentId
    ? { kind: 'service', componentId, componentName, componentIds: componentIds || [] }
    : { kind: 'workspace', componentId: null, componentName: null };

  const zipStep = step('Zip + manifest');
  const zip = createZip();
  zip.add('README.md', diagramPackReadme({ meta, ws, scope: scopeOut, entries, files, notes }));
  for (const f of files) zip.add(f.path, f.data);
  const manifest = {
    generatedAt: new Date().toISOString(),
    app: 'DR Compass',
    kind: 'diagram-pack',
    workspace: { slug: ws, name: meta?.name || ws, regions: meta?.regions || null },
    scope: scopeOut,
    diagrams: entries.map((e) => ({ id: String(e.id), name: e.name || String(e.id), kind: e.kind || null })),
    files: zip.entries(),
    notes,
  };
  zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  const blob = zip.blob();
  const filename = `${slug(ws, 'drcompass')}-${scopeSlug}-diagrams-${today()}.zip`;
  zipStep.ok(`${zip.entries().length} files · ${fmtBytes(blob.size)}`);
  if (download) saveZipBlob(filename, blob);
  return { blob, filename, files: zip.entries(), notes, manifest };
}

// --------------------------------------------------------------- the page

export default {
  title: 'Exports',
  async render(el, { ws, api }) {
    let runbooks = [];
    try { runbooks = (await api.get(`/w/${ws}/c/runbooks`)).items || []; }
    catch { /* runbooks unavailable — show empty state */ }

    let components = [];
    try { components = (await api.get(`/w/${ws}/c/components`)).items || []; }
    catch { /* inventory unavailable — the picker degrades to whole-workspace */ }

    let meta = null;
    try { meta = await api.get(`/w/${ws}/workspace`); }
    catch { /* cover README falls back to the slug */ }

    // The DR package cover quotes the two recovery numbers. It reads them
    // through measured.js so a hand-typed value cannot be printed as
    // "Measured in a recovery test" — which is what it said before.
    let allTests = [];
    try { allTests = (await api.get(`/w/${ws}/c/tests`)).items || []; }
    catch { /* no tests readable: every number degrades to declared/unmeasured */ }

    // Scope hints on the download rows ("8 rows") come from the collections we
    // can count locally — no extra work per row, and a 0 tells you a table is
    // empty before you download an empty CSV.
    const collection = async (name) => {
      try { return (await api.get(`/w/${ws}/c/${name}`)).items || []; }
      catch { return []; }
    };
    const [gaps, tests, checklists, decisions, contacts] = await Promise.all(
      ['gaps', 'tests', 'checklists', 'decisions', 'contacts'].map(collection),
    );
    const sum = (arr, fn) => arr.reduce((n, x) => n + fn(x), 0);
    const counts = {
      components, gaps, tests, decisions, contacts,
      steps: sum(runbooks, (rb) => (rb.steps || []).length + (rb.rollback || []).length),
      outboundCalls: sum(components, (c) => (c.outboundCalls || []).length),
      secrets: sum(components, (c) => (c.secrets || []).length),
      verifications: components.filter((c) => c.verification?.command || c.verification?.pass).length,
      checklistItems: sum(checklists, (cl) => (cl.items || []).length),
    };

    const dl = (href, label, kind = '') =>
      h('a', { class: `btn ${kind}`, href }, label);

    // One download row: what it is, why you'd want it, and how big/wide its scope is.
    const dlRow = (name, why, href, { label = '.csv', kind = 'btn-sm', scope = null } = {}) =>
      h('div', { class: 'dl-row' },
        h('div', { class: 'dl-what' },
          h('div', { class: 'dl-name' }, name),
          h('div', { class: 'dl-why' }, why)),
        h('div', { class: 'dl-act' },
          scope ? h('span', { class: 'dl-scope' }, scope) : null,
          dl(href, label, kind)));

    // ================================================== 0. DR Package card
    const scopeSelect = h('select', { style: 'width:100%' },
      h('option', { value: '' }, 'Whole workspace'));
    {
      const tier0 = components.filter((c) => Number(c.tier) === 0);
      const rest = components.filter((c) => Number(c.tier) !== 0);
      const opt = (c) => h('option', { value: c.id }, c.name || c.id);
      if (tier0.length) {
        scopeSelect.append(h('optgroup', { label: 'Tier 0' }, tier0.map(opt)));
      }
      const byCategory = new Map();
      for (const c of rest) {
        const key = c.category || 'other';
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key).push(c);
      }
      for (const key of [...byCategory.keys()].sort()) {
        scopeSelect.append(h('optgroup', { label: titleCase(key) }, byCategory.get(key).map(opt)));
      }
    }

    const previewLine = h('div', { class: 'pkg-preview' },
      components.length
        ? `Whole workspace · ${components.length} components · ${runbooks.length} runbooks`
        : 'Whole workspace');

    const optionRow = (key, label, hint, on = true) => {
      const input = h('input', { type: 'checkbox', ...(on ? { checked: true } : {}) });
      const wrap = h('label', null, input,
        h('span', null, h('span', { style: 'font-weight:600' }, label),
          hint ? h('span', { class: 'hint', style: 'display:block' }, hint) : null));
      return { key, input, el: wrap };
    };
    const OPTIONS = [
      optionRow('summary', 'Executive summary (.md)', 'The 90-second read for leadership'),
      optionRow('workbook', 'Workbook (.xlsx)', 'All 18 sheets, scoped'),
      optionRow('diagrams', 'Diagrams', 'SVG + draw.io + Mermaid'),
      optionRow('runbooks', 'Runbooks (.md)', 'Step-by-step procedures'),
      optionRow('quickref', 'Runbook quick-ref (.txt)', 'Terminal-friendly, for an incident'),
      optionRow('data', 'Data (CSVs)', 'Raw tables for Sheets'),
      optionRow('readme', 'Cover README', 'Contents, what to read first'),
      optionRow('narrative', 'AI narrative', 'Adds a written summary from your local Claude — off by default', false),
    ];
    const optionsBox = h('div', { class: 'pkg-opts' }, OPTIONS.map((o) => o.el));
    const readOptions = () => Object.fromEntries(OPTIONS.map((o) => [o.key, o.input.checked]));

    const stepsList = h('ol', { class: 'pkg-steps' });
    const summaryBox = h('div', { class: 'pkg-summary' });
    const buildBtn = h('button', { class: 'btn btn-primary' }, 'Build DR Package');

    // What actually went in, grouped the way a person would describe it.
    function summarize(files) {
      const count = (re) => files.filter((f) => re.test(f.path)).length;
      const parts = [];
      if (count(/^EXECUTIVE-SUMMARY\.md$/)) parts.push('executive summary');
      if (count(/^workbook\//)) parts.push('1 workbook (18 sheets)');
      const svg = count(/^diagrams\/.*\.svg$/);
      const dia = count(/^diagrams\//);
      if (dia) parts.push(`${svg || dia} diagram${(svg || dia) === 1 ? '' : 's'} (${dia} files)`);
      const rb = count(/^runbooks\//);
      if (rb) parts.push(`${rb} runbook${rb === 1 ? '' : 's'}`);
      if (count(/^RUNBOOK-QUICKREF\.txt$/)) parts.push('1 quick-ref');
      const csv = count(/^data\/.*\.csv$/);
      if (csv) parts.push(`${csv} table${csv === 1 ? '' : 's'}`);
      return parts;
    }

    function renderSummary({ files, notes, bytes, name }) {
      const parts = summarize(files);
      const kids = [
        h('div', { class: 'pkg-sum-head' },
          name ? `Contents of ${name}` : 'Nothing was packaged'),
      ];
      if (parts.length) {
        kids.push(h('div', { class: 'pkg-sum-line' },
          `${files.length} files · ${fmtBytes(bytes)} — ${parts.join(', ')}.`));
      }
      if (notes.length) {
        kids.push(h('div', { class: 'pkg-sum-head warn' },
          `Skipped or caveated (${notes.length}) — also written into README.md and MANIFEST.txt`));
        kids.push(h('ul', { class: 'pkg-sum-notes' },
          notes.map((n) => h('li', null, String(n).replace(/[`*]/g, '')))));
      } else if (parts.length) {
        kids.push(h('div', { class: 'pkg-sum-line ok' }, 'Nothing was skipped.'));
      }
      summaryBox.replaceChildren(...kids);
    }

    function markDownloaded(name) {
      summaryBox.prepend(h('div', { class: 'pkg-sum-line ok' }, `Downloaded ${name}`));
    }

    // scope state: null = whole workspace; {componentId,…} = service scope.
    const scopeState = { componentId: '', info: null, unavailable: false };

    function addStep(label) {
      const status = h('span', { class: 'pkg-status' }, '…');
      const li = h('li', null, h('span', { class: 'pkg-label' }, label), status);
      stepsList.append(li);
      stepsList.scrollTop = stepsList.scrollHeight;
      const set = (cls, mark, detail) => {
        li.className = cls;
        status.textContent = mark;
        if (detail) li.querySelector('.pkg-label').textContent = `${label} — ${detail}`;
        stepsList.scrollTop = stepsList.scrollHeight;
      };
      return {
        ok: (detail) => set('done', '✓', detail),
        skip: (why) => set('skip', '–', why),
        fail: (why) => set('fail', '✕', why),
      };
    }

    async function loadScope(componentId) {
      scopeState.componentId = componentId;
      scopeState.info = null;
      scopeState.unavailable = false;
      previewLine.className = 'pkg-preview';
      if (!componentId) {
        previewLine.textContent = components.length
          ? `Whole workspace · ${components.length} components · ${runbooks.length} runbooks`
          : 'Whole workspace';
        return;
      }
      previewLine.textContent = 'Resolving scope…';
      try {
        const info = await api.get(`/w/${ws}/export/scope/${encodeURIComponent(componentId)}`);
        scopeState.info = info;
        const n = info.components?.length || info.componentIds?.length || 1;
        const parts = [
          `${n} component${n === 1 ? '' : 's'} (${info.depsCount ?? 0} dependencies, ${info.dependentsCount ?? 0} dependents)`,
          `${info.runbookIds?.length ?? 0} runbooks`,
          `${info.testIds?.length ?? 0} tests`,
          `${info.gapIds?.length ?? 0} gaps`,
        ];
        previewLine.textContent = parts.join(' · ');
      } catch {
        // Scoping backend not live yet (404/501) — say so plainly and fall
        // back to a whole-workspace package rather than shipping a half-scope.
        scopeState.unavailable = true;
        previewLine.className = 'pkg-preview warn';
        previewLine.textContent = 'Per-service scoping is not available on this server yet — '
          + 'the package will cover the whole workspace.';
      }
    }
    scopeSelect.addEventListener('change', () => { loadScope(scopeSelect.value); });

    async function build() {
      stepsList.innerHTML = '';
      buildBtn.disabled = true;
      buildBtn.textContent = 'Building…';
      const options = readOptions();
      const notes = [];
      const files = [];
      let quickrefOf = null;
      summaryBox.replaceChildren();

      try {
        // ---- resolve scope (re-check if the picker changed under us) ----
        const wantId = scopeSelect.value;
        if (wantId && !scopeState.info && !scopeState.unavailable) await loadScope(wantId);
        const info = wantId ? scopeState.info : null;
        const rootId = info ? (info.root?.id || wantId) : null;
        const rootName = info
          ? (info.root?.name || components.find((c) => c.id === wantId)?.name || wantId)
          : null;
        if (wantId && !info) {
          notes.push('Per-service scoping was requested but the server could not scope it — '
            + 'this package covers the whole workspace.');
        }
        const q = rootId ? `?componentId=${encodeURIComponent(rootId)}` : '';
        const scopeSlug = rootId ? slug(rootName || rootId, 'service') : 'workspace';
        const scope = rootId
          ? {
              kind: 'service',
              componentId: rootId,
              componentName: rootName,
              componentIds: info.componentIds || (info.components || []).map((c) => c.id),
              depsCount: info.depsCount ?? null,
              dependentsCount: info.dependentsCount ?? null,
            }
          : { kind: 'workspace', componentId: null, componentName: null };

        // ---- executive summary (computed server-side from the same model the
        //      workbook's first sheet renders, so the two always agree) ----
        let aiNarrative = false;
        if (options.summary) {
          const step = addStep('Executive summary (.md)');
          try {
            let md = await fetchText(`/api/w/${ws}/export/executive-summary.md${q}`);
            if (options.narrative) {
              const nstep = addStep('AI narrative (local Claude)');
              try {
                const r = await api.post(`/w/${ws}/ai/narrative`, { kind: 'executive-summary' });
                if (r?.ok && r.markdown) {
                  md += `\n\n---\n\n## Narrative — generated by your local AI\n\n`
                    + '> Written by Claude running on your machine from this workspace\'s data. '
                    + 'The tables above are computed; this section is not. **Review before sharing.**\n\n'
                    + `${r.markdown.replace(/^# .*\n+/, '')}\n`;
                  aiNarrative = true;
                  nstep.ok('appended to EXECUTIVE-SUMMARY.md');
                } else {
                  nstep.skip(r?.message || 'local AI returned nothing');
                  notes.push(`No AI narrative: ${r?.message || 'the local AI returned nothing'}. The computed summary is unaffected.`);
                }
              } catch (e) {
                nstep.skip(String(e.message || e));
                notes.push(`No AI narrative: ${e.message || e}. The computed summary is unaffected.`);
              }
            }
            files.push({ path: 'EXECUTIVE-SUMMARY.md', data: md });
            step.ok(fmtBytes(md.length));
          } catch (e) {
            step.fail(String(e.message || e));
            notes.push(`EXECUTIVE-SUMMARY.md is missing — the server could not generate it (${e.message || e}). `
              + 'The workbook\'s Executive Summary sheet carries the same content.');
          }
        }

        // ---- workbook ----
        if (options.workbook) {
          const step = addStep('Workbook (.xlsx)');
          try {
            const bytes = await fetchBytes(`/api/w/${ws}/export/xlsx${q}`);
            files.push({ path: `workbook/${scopeSlug}-dr-package.xlsx`, data: bytes });
            step.ok(`${fmtBytes(bytes.length)} · 18 sheets`);
          } catch (e) {
            step.fail(String(e.message || e));
            notes.push(`The workbook is missing — the export failed (${e.message || e}). `
              + 'Everything else in this package is unaffected, but the Dependencies tree and the readiness '
              + 'detail only exist there.');
          }
        }

        // ---- diagrams ----
        if (options.diagrams) {
          let list = [];
          try { list = await api.get(`/w/${ws}/diagrams`); }
          catch (e) { notes.push(`Diagram list unavailable: ${e.message || e}`); }
          const plan = diagramPlan(list, rootId);
          if (!plan.length) addStep('Diagrams').skip('none available');
          for (const entry of plan) {
            // Never let one bad diagram take the package down with it.
            const s = addStep(diagramStepLabel(entry));
            try {
              const got = await collectDiagram({ ws, api, entry, files, notes, layout: DIAGRAM_LAYOUT.package });
              if (got.length) s.ok(got.join(' + ')); else s.fail('nothing exported');
            } catch (e) {
              s.fail(String(e.message || e));
              notes.push(`Diagram \`${entry.id}\` failed: ${e.message || e}`);
            }
          }
        }

        // ---- runbooks ----
        if (options.runbooks) {
          const step = addStep('Runbooks (.md)');
          // Scoped when the server told us which runbooks belong to this
          // service; every runbook otherwise (an unscoped list is better than
          // a package with no procedure in it — the README states the scope).
          const wanted = info?.runbookIds?.length
            ? runbooks.filter((rb) => info.runbookIds.includes(rb.id))
            : (info?.runbookIds ? [] : runbooks);
          if (info && !info.runbookIds) {
            notes.push('The scope response did not list runbooks, so every runbook in the workspace is included.');
          }
          if (!wanted.length) {
            step.skip(info?.runbookIds ? 'none in scope' : 'no runbooks yet');
            notes.push(info?.runbookIds
              ? 'No runbooks are linked to this service yet — write one on the Runbooks page.'
              : 'This workspace has no runbooks yet — a DR package without a runbook is reference material, not a plan.');
          } else {
            let n = 0;
            for (const rb of wanted) {
              try {
                const md = await fetchText(`/api/w/${ws}/export/runbook/${encodeURIComponent(rb.id)}.md`);
                files.push({
                  path: `runbooks/${slug(rb.name, rb.id)}.md`,
                  data: md,
                  label: `${rb.name || rb.id}${rb.scenario ? ` (${rb.scenario})` : ''} — ordered steps, verify/pass criteria, rollback, sign-off table.`,
                });
                n++;
              } catch (e) {
                notes.push(`Runbook "${rb.name || rb.id}" is not in \`runbooks/\` — its export failed (${e.message || e}).`);
              }
            }
            if (n) step.ok(`${n} file${n === 1 ? '' : 's'}`); else step.fail('all exports failed');
          }

          // ---- the one runbook someone will work from in a terminal ----
          // Service-linked beats generic; otherwise the first one in the list.
          if (options.quickref && wanted.length) {
            const chosen = wanted.find((rb) => !rb.scopeGeneric) || wanted[0];
            const step2 = addStep('Runbook quick-ref (.txt)');
            try {
              const txt = await fetchText(`/api/w/${ws}/export/runbook/${encodeURIComponent(chosen.id)}.txt`);
              files.push({
                path: 'RUNBOOK-QUICKREF.txt',
                data: txt,
                label: `${chosen.name || chosen.id} — steps, commands, checks and pass criteria only, in plain text. For working from a terminal during an incident.`,
              });
              quickrefOf = chosen.name || chosen.id;
              step2.ok(chosen.name || chosen.id);
              if (wanted.length > 1) {
                notes.push(`\`RUNBOOK-QUICKREF.txt\` is "${chosen.name || chosen.id}" — the ${wanted.length - 1} other runbook(s) `
                  + 'are in `runbooks/` as markdown.');
              }
            } catch (e) {
              step2.skip(String(e.message || e));
              notes.push('No `RUNBOOK-QUICKREF.txt` — this server does not offer the plain-text runbook export '
                + `(${e.message || e}). The markdown runbooks in \`runbooks/\` carry the same steps.`);
            }
          } else if (options.quickref) {
            addStep('Runbook quick-ref (.txt)').skip('no runbook to condense');
          }
        }

        // ---- data CSVs ----
        if (options.data) {
          const step = addStep('Data (CSVs)');
          try {
            const bundle = await api.get(`/w/${ws}/export/bundle${q}`);
            let n = 0;
            for (const f of bundle.files || []) {
              const name = String(f.name || '');
              if (!name || name === 'scope.json') continue;       // scope lives in manifest.json
              if (name.endsWith('.md')) continue;                 // runbooks are handled above
              if (name.endsWith('.csv')) {
                const sheet = name.replace(/\.csv$/, '');
                files.push({
                  path: `data/${name}`,
                  data: f.content ?? '',
                  label: `${CSV_LABEL.get(sheet) || titleCase(sheet)} — `
                    + `${CSV_PURPOSE.get(sheet) || 'Raw table.'} CSV: in Sheets use File → Import → Upload.`,
                });
                n++;
              }
              else if (name === 'workspace.json') files.push({ path: 'data/workspace.json', data: f.content ?? '' });
            }
            if (n) step.ok(`${n} table${n === 1 ? '' : 's'}`); else step.skip('no tables with rows');
          } catch (e) {
            step.fail(String(e.message || e));
            notes.push(`CSV bundle unavailable: ${e.message || e}`);
          }
        }

        if (!files.length) {
          toast('Nothing to package — every section was empty or unavailable', 'err');
          addStep('Package').fail('no content');
          renderSummary({ files: [], notes, bytes: 0, name: null });
          return;
        }

        // ---- zip it (README first, manifests last) ----
        const zipStep = addStep('Zip + manifest');
        const zip = createZip();
        if (options.readme) {
          zip.add('README.md', buildReadme({
            meta, ws, scope, files, notes, options, quickrefOf, aiNarrative, tests: allTests,
          }));
        }
        for (const f of files) zip.add(f.path, f.data);
        const manifest = {
          generatedAt: new Date().toISOString(),
          app: 'DR Compass',
          kind: 'dr-package',
          workspace: { slug: ws, name: meta?.name || ws, regions: meta?.regions || null },
          scope,
          contents: summarize(files),
          files: zip.entries(),
          notes,
        };
        zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
        zip.add('MANIFEST.txt', manifestText({ manifest, notes }));

        const blob = zip.blob();
        const zipName = `${slug(ws, 'drcompass')}-${scopeSlug}-dr-package-${today()}.zip`;
        zipStep.ok(`${zip.entries().length} files · ${fmtBytes(blob.size)}`);

        // Contents summary BEFORE the download starts, so what lands in the
        // Downloads folder is never a surprise.
        renderSummary({ files: zip.entries(), notes, bytes: blob.size, name: zipName });
        saveZipBlob(zipName, blob);
        markDownloaded(zipName);
        toast(notes.length
          ? `DR Package ready — ${zip.entries().length} files, ${notes.length} note${notes.length === 1 ? '' : 's'}`
          : `DR Package ready — ${zip.entries().length} files`, notes.length ? '' : 'ok');
      } catch (e) {
        addStep('Package').fail(String(e.message || e));
        toast(`Package build failed: ${e.message || e}`, 'err');
      } finally {
        buildBtn.disabled = false;
        buildBtn.textContent = 'Build DR Package';
      }
    }
    buildBtn.addEventListener('click', build);

    // ---- diagrams-only pack (same scope picker, no workbook/runbooks/CSVs) ----
    const packBtn = h('button', { class: 'btn' }, 'Diagram pack (.zip)');
    packBtn.addEventListener('click', async () => {
      stepsList.innerHTML = '';
      summaryBox.replaceChildren();
      packBtn.disabled = true;
      buildBtn.disabled = true;
      packBtn.textContent = 'Building…';
      try {
        const wantId = scopeSelect.value;
        if (wantId && !scopeState.info && !scopeState.unavailable) await loadScope(wantId);
        const info = wantId ? scopeState.info : null;
        const scope = wantId
          ? {
              componentId: info?.root?.id || wantId,
              componentName: info?.root?.name || components.find((c) => c.id === wantId)?.name || wantId,
              componentIds: info?.componentIds || (info?.components || []).map((c) => c.id) || null,
            }
          : null;
        const { filename, notes, files: packed, blob } = await buildDiagramPack({
          ws, api, scope, meta, onStep: addStep,
        });
        renderSummary({ files: packed, notes, bytes: blob?.size || 0, name: filename });
        markDownloaded(filename);
        toast(notes.length
          ? `Diagram pack ready (${notes.length} note${notes.length === 1 ? '' : 's'} in the manifest)`
          : 'Diagram pack ready', notes.length ? '' : 'ok');
      } catch (e) {
        addStep('Diagram pack').fail(String(e.message || e));
        toast(`Diagram pack failed: ${e.message || e}`, 'err');
      } finally {
        packBtn.disabled = false;
        buildBtn.disabled = false;
        packBtn.textContent = 'Diagram pack (.zip)';
      }
    });

    const packageCard = h('div', { class: 'card pkg-card' },
      h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('h2', { style: 'margin:0' }, 'Build a DR package'),
        badge('start here', 'ok'),
        badge('one zip')),
      h('p', { class: 'hint', style: 'margin-bottom:14px' },
        'Everything a recovery needs for one service, in a single .zip: the executive summary, the workbook, '
        + 'the diagrams (rendered SVG plus editable draw.io and Mermaid), the runbooks, a terminal-friendly '
        + 'quick-ref, the raw CSVs, and a readable manifest. Pick the service, hit build — the archive is '
        + 'assembled here in your browser, so nothing leaves your machine.'),
      h('div', { class: 'pkg-grid' },
        h('div', null,
          h('label', { class: 'field' },
            h('span', null, 'Which service?'), scopeSelect),
          previewLine,
          h('div', { class: 'hint', style: 'margin-top:4px' },
            'Picking a service narrows every sheet and diagram to it, plus what it ',
            gloss('dependency', 'depends on'),
            ' and what depends on it.'),
          h('div', { class: 'hint', style: 'margin:14px 0 6px; font-weight:600; color:var(--text)' }, 'Include'),
          optionsBox,
          h('div', { class: 'row', style: 'margin-top:14px; gap:8px' }, buildBtn, packBtn),
          h('div', { class: 'hint', style: 'margin-top:6px' },
            'Diagram pack: every diagram in the selected scope as SVG + draw.io + Mermaid — no workbook, runbooks, or CSVs.')),
        h('div', null,
          h('div', { class: 'hint', style: 'margin-bottom:6px; font-weight:600; color:var(--text)' }, 'Package layout'),
          h('pre', { class: 'pkg-tree' },
            'README.md                 what to read first\n'
            + 'EXECUTIVE-SUMMARY.md      the 90-second read\n'
            + 'RUNBOOK-QUICKREF.txt      steps + checks, plain text\n'
            + 'workbook/<scope>.xlsx     all 18 sheets\n'
            + 'diagrams/<id>.svg .drawio .mmd\n'
            + 'runbooks/<name>.md\n'
            + 'data/<table>.csv\n'
            + 'MANIFEST.txt  manifest.json'),
          stepsList,
          summaryBox)),
    );

    // ============================== secondary downloads, grouped by audience
    const group = (title, forWhom, ...rows) => h('div', { class: 'dl-group' },
      h('h3', null, title),
      h('div', { class: 'dl-for' }, forWhom),
      ...rows);

    // --- for stakeholders who live in spreadsheets ---
    const workbookCard = card(
      h('h2', null, 'One file at a time'),
      h('p', { class: 'hint', style: 'margin-bottom:14px' },
        'Everything below is also inside the DR Package above. Take a single file when that is all you need.'),

      group('For stakeholders who live in spreadsheets',
        'Leadership, auditors, anyone who wants the whole picture in Excel or Google Sheets.',
        // Secondary to "Build DR Package" above — one primary action per page.
        dlRow('Excel workbook', 'Executive Summary first, then the Resource Graph tree you expand category by category, the runtime path, outbound calls, deployment order and the rest. Opens in Excel or Google Sheets with the dropdowns, tints and row groups intact.',
          `/api/w/${ws}/export/xlsx`, {
            label: 'Download .xlsx',
            scope: `${components.length} components · ${runbooks.length} runbooks`,
          }),
        dlRow('Executive summary', 'The 90-second read as markdown: strategy, the honest numbers, top risks with owners, test history, next actions. Same content as the workbook\'s first sheet.',
          `/api/w/${ws}/export/executive-summary.md`, {
            label: 'Download .md',
            scope: `${gaps.filter((g) => g.status !== 'resolved').length} open gaps · ${tests.length} tests`,
          }),
        h('div', { class: 'hint', style: 'margin-top:10px; margin-bottom:5px' }, 'Sheets in the workbook (empty sections are skipped):'),
        h('div', { class: 'row', style: 'gap:6px' }, SHEETS_PREVIEW.map((s) => badge(s)))),
    );

    // --- for importing into Sheets ---
    const csvCard = card(
      h('h2', null, 'Individual tables'),
      group('For importing into Sheets',
        'One table at a time: in Google Sheets use File → Import → Upload. Row counts are for the whole workspace.',
        ...CSVS.map(([id, label, why, rowsOf]) => {
          let rows = null;
          try { rows = rowsOf(counts); } catch { rows = null; }
          return dlRow(label, why, `/api/w/${ws}/export/csv/${id}`, {
            scope: rows == null ? 'discovered data' : `${rows} row${rows === 1 ? '' : 's'}`,
          });
        })),
    );

    // --- for your wiki, or a terminal ---
    const runbookCard = card(
      h('h2', null, 'Runbooks'),
      group('For your wiki, or a terminal during an incident',
        'The .md is the full procedure — meta, preconditions, steps with commands and pass criteria, rollback, and a sign-off table with T0/T1/RTA blanks. The .txt is the same thing stripped to steps, commands and checks for someone working in a shell.',
        ...(runbooks.length
          ? runbooks.map((rb) => h('div', { class: 'dl-row' },
            h('div', { class: 'dl-what' },
              h('div', { class: 'dl-name' }, rb.name),
              h('div', { class: 'dl-why' },
                [rb.scenario, rb.audience,
                  `${(rb.steps || []).length} steps`,
                  (rb.rollback || []).length ? `${rb.rollback.length} rollback` : '',
                ].filter(Boolean).join(' · '))),
            h('div', { class: 'dl-act' },
              dl(`/api/w/${ws}/export/runbook/${rb.id}.md`, '.md', 'btn-sm'),
              dl(`/api/w/${ws}/export/runbook/${rb.id}.txt`, 'quick-ref .txt', 'btn-sm'))))
          : [empty('No runbooks yet — create one on the Runbooks page.')])),
    );

    // --- 4. Everything bundle ---
    const bundleBtn = h('button', { class: 'btn' }, 'Download every file separately');
    bundleBtn.addEventListener('click', async () => {
      bundleBtn.disabled = true;
      bundleBtn.textContent = 'Preparing…';
      try {
        const bundle = await api.get(`/w/${ws}/export/bundle`);
        const files = bundle.files || [];
        if (!files.length) { toast('Nothing to export yet', 'err'); return; }
        files.forEach((f, i) => setTimeout(() => downloadBlob(f.name, f.content), i * 250));
        toast(`Downloading ${files.length} files`, 'ok');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        bundleBtn.disabled = false;
        bundleBtn.textContent = 'Download every file separately';
      }
    });
    const bundleCard = card(
      h('h2', null, 'Bulk & diagrams'),
      group('When you want the raw files, not an archive',
        'Every CSV, every runbook as markdown, and workspace.json — as separate downloads. Your browser will ask permission for multiple files. The DR Package above is the same content in one zip, which is almost always what you want instead.',
        h('div', { style: 'padding-top:4px' }, bundleBtn)),
      group('Diagrams',
        'Architecture, dependency and failover-sequence views.',
        h('div', { class: 'dl-why' },
          'Build the diagram pack from the card above (SVG + draw.io + Mermaid for everything in scope), or open the ',
          h('a', { href: `#/${ws}/diagrams` }, 'Diagrams page'),
          ' to look at one diagram and export it on its own.')),
    );

    el.append(
      h('style', null, PKG_STYLE),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, 'Exports'),
          h('div', { class: 'sub' }, 'Turn this workspace into artifacts you can hand to leadership, auditors, and operators'))),
      h('div', { class: 'hint', style: 'margin:-6px 0 12px' },
        'Start here: build one package for the service you care about. Individual files are below if you only need one.'),
      packageCard,
      h('div', { class: 'grid cols-2', style: 'margin-top:14px' },
        workbookCard, csvCard, runbookCard, bundleCard),
    );

    // Close with the program's one next action, like every other page.
    try {
      const { nextStepFor } = await import('../onboarding.js');
      const snap = await ui.snapshot(api, ws);
      const band = nextStepFor('exports', snap, ws);
      if (band) el.append(band);
    } catch { /* the band is never load-bearing */ }
  },
};
