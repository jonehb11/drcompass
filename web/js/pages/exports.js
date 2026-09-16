import { h, card, badge, toast, empty } from '../ui.js';
import { createZip } from '../zip.js';

const SHEETS_PREVIEW = [
  'README', 'Readiness Summary', 'Dependency Inventory', 'Outbound Calls',
  'Secrets Reconciliation', 'Gap List', 'Runbooks', 'Runbook Steps', 'Test Log',
  'App Test Catalog', 'Test Records', 'Checklists', 'Decision Log', 'People',
  'DR Options Matrix', 'Verification Catalog',
];

const CSVS = [
  ['components', 'Dependency inventory'],
  ['outbound-calls', 'Outbound calls'],
  ['secrets', 'Secrets reconciliation'],
  ['gaps', 'Gap list'],
  ['runbook-steps', 'Runbook steps'],
  ['tests', 'Test log'],
  ['checklists', 'Checklists'],
  ['decisions', 'Decision log'],
  ['contacts', 'People / contacts'],
  ['verification-catalog', 'Verification catalog'],
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

const PURPOSE = [
  [/^workbook\//, 'The full DR picture in Excel — inventory, gaps, runbooks, tests, readiness summary.'],
  [/^diagrams\/.*\.svg$/, 'Rendered diagram — drop straight into slides, wikis, or a printed binder.'],
  [/^diagrams\/.*\.drawio$/, 'Editable diagram for draw.io / app.diagrams.net (AWS shapes where available).'],
  [/^diagrams\/.*\.mmd$/, 'Mermaid source — paste into Lucidchart, Notion, GitHub, or any Mermaid renderer.'],
  [/^runbooks\//, 'Step-by-step recovery procedure with verify/pass criteria and a sign-off table.'],
  [/^data\/.*\.csv$/, 'Raw table for Google Sheets / analysis (File → Import → Upload).'],
  [/^data\/workspace\.json$/, 'Workspace metadata: regions, strategy, tooling, objectives.'],
  [/^manifest\.json$/, 'Machine-readable index of this package: every file, its size, and the scope it covers.'],
  [/^README\.md$/, 'This cover sheet.'],
];

// A file may carry its own label (the diagram or table it actually is);
// otherwise fall back to the purpose of its folder.
const purposeOf = (file) => {
  if (typeof file === 'string') return (PURPOSE.find(([re]) => re.test(file)) || [null, 'Package file.'])[1];
  return file.label || purposeOf(file.path);
};

// CSV sheet id → the human name used on this page, for the README inventory.
const CSV_LABEL = new Map([...CSVS,
  ['resource-graph', 'Discovered AWS resource graph'],
  ['k8s-workloads', 'Kubernetes workloads'],
]);

function objectivesSection(meta) {
  const o = meta?.objectives || {};
  const has = (v) => v !== null && v !== undefined && v !== '';
  const min = (v) => (has(v) ? `${v} min` : '—');
  const lines = [
    '## Objectives — read the numbers honestly',
    '',
    '| | Value | What it actually is |',
    '| --- | --- | --- |',
    `| RTO (target) | ${min(o.rtoMinutes)} | Target${o.approved ? ', approved by the business' : ' — **not yet approved by the business**'} |`,
    `| RPO (target) | ${min(o.rpoMinutes)} | Target${o.approved ? ', approved by the business' : ' — **not yet approved by the business**'} |`,
    `| RTA (achieved) | ${min(o.rtaMinutes)} | Measured in the last recovery test — this is the number you can defend |`,
    `| RPA (achieved) | ${min(o.rpaMinutes)} | Measured in the last recovery test |`,
    '',
    'RTO/RPO are goals. RTA/RPA are evidence. When someone asks "how fast can we recover?", '
      + 'quote the achieved numbers and say what test produced them — a target nobody has met is not a recovery capability.',
  ];
  if (o.notes) lines.push('', `> ${String(o.notes).replace(/\r?\n/g, ' ')}`);
  return lines.join('\n');
}

export function buildReadme({ meta, ws, scope, files, notes, options }) {
  const name = meta?.name || ws;
  const regions = meta?.regions || {};
  const scopeLine = scope.componentId
    ? `Service scope — **${scope.componentName}**${scope.componentIds?.length ? ` and ${scope.componentIds.length - 1} related component(s)` : ''}`
    : 'Whole workspace — every component in the inventory';

  const L = [];
  L.push(`# DR Package — ${name}`, '');
  L.push(`${scopeLine}.`, '');
  L.push('| | |', '| --- | --- |');
  L.push(`| Workspace | ${name} (\`${ws}\`) |`);
  if (meta?.org) L.push(`| Organization | ${meta.org} |`);
  L.push(`| Scope | ${scope.componentId ? `${scope.componentName} (\`${scope.componentId}\`)` : 'Whole workspace'} |`);
  L.push(`| Regions | \`${regions.primary || '?'}\` → \`${regions.recovery || '?'}\` |`);
  if (meta?.strategy) L.push(`| Strategy | ${meta.strategy} |`);
  if (meta?.tooling?.length) L.push(`| Tooling | ${meta.tooling.join(', ')} |`);
  L.push(`| Generated | ${new Date().toISOString()} |`);
  L.push(`| Generated by | DR Compass |`, '');

  if (meta?.description) L.push(meta.description, '');

  L.push(objectivesSection(meta), '');

  L.push('## What is in this package', '');
  L.push('| File | Purpose |', '| --- | --- |');
  for (const f of files) L.push(`| \`${f.path}\` | ${purposeOf(f)} |`);
  L.push('| `README.md` | This cover sheet. |');
  L.push('| `manifest.json` | Machine-readable index of every file in this package. |', '');

  L.push('## Using this during a DR event', '');
  L.push('**Start in `runbooks/`.** Open the runbook that matches the event, work the steps in order, '
    + 'and fill in the sign-off table as you go (T0, first access restored, T1, RTA/RPA) — that table is '
    + 'the evidence you will be asked for afterwards. Do not skip a step marked **GATE**: it exists because '
    + 'something downstream fails silently without it.',
    '');
  L.push('When a runbook step needs context — what depends on what, what has to come up first, which '
    + 'store replicates how — use `diagrams/` (open the `.svg` files; the `.drawio` and `.mmd` versions '
    + 'are there when you need to edit or re-render) and the `workbook/` Excel file, whose Readiness Summary, '
    + 'Dependency Inventory, and Gap List sheets carry the detail. `data/` has the same tables as plain CSV '
    + 'when you want to sort, filter, or paste into a ticket.',
    '');

  L.push('## Before you rely on this', '');
  L.push('- This package is a **point-in-time snapshot** of the workspace as of the generated timestamp above. '
    + 'Anything changed since — new components, rotated secrets, edited runbooks — is not in here. Regenerate before a test.');
  L.push('- Work the **pre-test checklist** in the workbook (Checklists sheet) before declaring readiness: '
    + 'replication green *after* the most recent guardrail/policy change, backup error count at zero, '
    + 'secrets reconciled into one signed-off list, and the known blockers re-verified in the recovery region.');
  L.push('- Open gaps in the Gap List sheet are the things that will bite you. An untested runbook is a hypothesis, not a plan.');
  if (!options.workbook || !options.diagrams || !options.runbooks || !options.data) {
    L.push('- Some sections were deselected when this package was built — see `manifest.json` for exactly what it contains.');
  }
  L.push('');

  if (notes.length) {
    L.push('## Notes from generation', '');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }
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

    const dl = (href, label, kind = '') =>
      h('a', { class: `btn ${kind}`, href }, label);

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

    const optionRow = (key, label, hint) => {
      const input = h('input', { type: 'checkbox', checked: true });
      const wrap = h('label', null, input,
        h('span', null, h('span', { style: 'font-weight:600' }, label),
          hint ? h('span', { class: 'hint', style: 'display:block' }, hint) : null));
      return { key, input, el: wrap };
    };
    const OPTIONS = [
      optionRow('workbook', 'Workbook (.xlsx)', 'The scoped Excel workbook'),
      optionRow('diagrams', 'Diagrams', 'SVG + draw.io + Mermaid'),
      optionRow('runbooks', 'Runbooks (.md)', 'Step-by-step procedures'),
      optionRow('data', 'Data (CSVs)', 'Raw tables for Sheets'),
      optionRow('readme', 'Cover README', 'Scope, objectives, how to use it'),
    ];
    const optionsBox = h('div', { class: 'pkg-opts' }, OPTIONS.map((o) => o.el));
    const readOptions = () => Object.fromEntries(OPTIONS.map((o) => [o.key, o.input.checked]));

    const stepsList = h('ol', { class: 'pkg-steps' });
    const buildBtn = h('button', { class: 'btn btn-primary' }, 'Build DR Package');

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

        // ---- workbook ----
        if (options.workbook) {
          const step = addStep('Workbook (.xlsx)');
          try {
            const bytes = await fetchBytes(`/api/w/${ws}/export/xlsx${q}`);
            files.push({ path: `workbook/${scopeSlug}-dr-package.xlsx`, data: bytes });
            step.ok(fmtBytes(bytes.length));
          } catch (e) {
            step.fail(String(e.message || e));
            notes.push(`Workbook export failed: ${e.message || e}`);
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
                notes.push(`Runbook "${rb.name || rb.id}" could not be exported: ${e.message || e}`);
              }
            }
            if (n) step.ok(`${n} file${n === 1 ? '' : 's'}`); else step.fail('all exports failed');
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
                  label: `${CSV_LABEL.get(sheet) || titleCase(sheet)} — CSV for Sheets/Excel (File → Import → Upload).`,
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
          return;
        }

        // ---- zip it (README first, manifest last) ----
        const zipStep = addStep('Zip + manifest');
        const zip = createZip();
        if (options.readme) {
          zip.add('README.md', buildReadme({ meta, ws, scope, files, notes, options }));
        }
        for (const f of files) zip.add(f.path, f.data);
        const manifest = {
          generatedAt: new Date().toISOString(),
          app: 'DR Compass',
          workspace: { slug: ws, name: meta?.name || ws, regions: meta?.regions || null },
          scope,
          files: zip.entries(),
          notes,
        };
        zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

        const blob = zip.blob();
        const zipName = `${slug(ws, 'drcompass')}-${scopeSlug}-dr-package-${today()}.zip`;
        zipStep.ok(`${zip.entries().length} files · ${fmtBytes(blob.size)}`);
        saveZipBlob(zipName, blob);
        addStep(zipName).ok('downloaded');
        toast(notes.length
          ? `DR Package ready (${notes.length} note${notes.length === 1 ? '' : 's'} in the manifest)`
          : 'DR Package ready', notes.length ? '' : 'ok');
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
        const { filename, notes } = await buildDiagramPack({ ws, api, scope, meta, onStep: addStep });
        addStep(filename).ok('downloaded');
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
        h('h2', { style: 'margin:0' }, 'DR Package'),
        badge('one zip', 'ok')),
      h('p', { class: 'hint', style: 'margin-bottom:14px' },
        'Everything a recovery needs, in a single .zip: the cover sheet, the workbook, every relevant '
        + 'diagram (rendered SVG plus editable draw.io and Mermaid), the runbooks, the raw CSVs, and a manifest. '
        + 'Pick a scope, hit build — the archive is assembled right here in your browser.'),
      h('div', { class: 'pkg-grid' },
        h('div', null,
          h('label', { class: 'field' }, h('span', null, 'Scope'), scopeSelect),
          previewLine,
          h('div', { class: 'hint', style: 'margin:14px 0 6px; font-weight:600; color:var(--text)' }, 'Include'),
          optionsBox,
          h('div', { class: 'row', style: 'margin-top:14px; gap:8px' }, buildBtn, packBtn),
          h('div', { class: 'hint', style: 'margin-top:6px' },
            'Diagram pack: every diagram in the selected scope as SVG + draw.io + Mermaid — no workbook, runbooks, or CSVs.')),
        h('div', null,
          h('div', { class: 'hint', style: 'margin-bottom:6px; font-weight:600; color:var(--text)' }, 'Package layout'),
          h('pre', { class: 'pkg-tree' },
            'README.md\n'
            + 'workbook/<scope>-dr-package.xlsx\n'
            + 'diagrams/<id>.svg  .drawio  .mmd\n'
            + 'runbooks/<name>.md\n'
            + 'data/<table>.csv\n'
            + 'manifest.json'),
          stepsList)),
    );

    // --- 1. Excel workbook ---
    const workbookCard = card(
      h('h2', null, 'Excel workbook'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'The flagship artifact: one styled .xlsx with the full DR picture — inventory, gaps, runbooks, tests, decisions, and the readiness summary. Hand it to leadership or open it directly in Excel or Google Sheets.'),
      h('div', { style: 'margin-bottom:14px' },
        dl(`/api/w/${ws}/export/xlsx`, 'Download workbook (.xlsx)', 'btn-primary')),
      h('div', { class: 'hint', style: 'margin-bottom:6px' }, 'Sheets included (empty sections are skipped):'),
      h('div', { class: 'row', style: 'gap:6px' },
        SHEETS_PREVIEW.map((s) => badge(s))),
    );

    // --- 2. Google Sheets / CSVs ---
    const csvCard = card(
      h('h2', null, 'Google Sheets'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Two ways in: (a) download the workbook above and open it straight in Google Sheets, or (b) download individual CSVs below and use File → Import → Upload in Sheets — the cleanest path when you only want one table.'),
      h('div', { class: 'grid cols-2', style: 'gap:8px' },
        CSVS.map(([id, label]) =>
          h('div', { class: 'row', style: 'justify-content:space-between; gap:8px' },
            h('span', { style: 'font-size:13px' }, label),
            dl(`/api/w/${ws}/export/csv/${id}`, '.csv', 'btn-sm')))),
    );

    // --- 3. Runbooks as markdown ---
    const runbookRows = runbooks.map((rb) =>
      h('div', { class: 'row', style: 'justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--border)' },
        h('div', null,
          h('div', { style: 'font-weight:600; font-size:13px' }, rb.name),
          h('div', { class: 'hint' },
            [rb.scenario, rb.audience].filter(Boolean).join(' · ') || '—')),
        dl(`/api/w/${ws}/export/runbook/${rb.id}.md`, 'Download .md', 'btn-sm')));
    const runbookCard = card(
      h('h2', null, 'Runbooks (markdown)'),
      h('p', { class: 'hint', style: 'margin-bottom:10px' },
        'Each runbook exports as a standalone .md: meta table, preconditions, ordered steps with commands and pass criteria, rollback, and a sign-off table with T0/T1/RTA blanks to fill during execution. Print it or drop it in your wiki.'),
      runbookRows.length ? runbookRows
        : empty('No runbooks yet — create one on the Runbooks page.'),
    );

    // --- 4. Everything bundle ---
    const bundleBtn = h('button', { class: 'btn btn-primary' }, 'Download everything');
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
        bundleBtn.textContent = 'Download everything';
      }
    });
    const bundleCard = card(
      h('h2', null, 'Everything bundle'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'All CSVs, every runbook as markdown, and workspace.json — downloaded as individual files in one go. Your browser may ask permission for multiple downloads.'),
      bundleBtn,
    );

    // --- 5. Diagrams hint ---
    const diagramsCard = card(
      h('h2', null, 'Looking for diagrams?'),
      h('p', { class: 'hint' },
        'Architecture, dependency, and failover-sequence diagrams are exported from the ',
        h('a', { href: `#/${ws}/diagrams` }, 'Diagrams page'),
        ' — as Mermaid source, draw.io XML, or SVG.'),
    );

    el.append(
      h('style', null, PKG_STYLE),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, 'Exports'),
          h('div', { class: 'sub' }, 'Turn this workspace into artifacts you can hand to leadership, auditors, and operators'))),
      packageCard,
      h('div', { class: 'grid cols-2', style: 'margin-top:14px' },
        workbookCard, csvCard, runbookCard, bundleCard, diagramsCard),
    );
  },
};
