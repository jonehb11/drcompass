// DR Compass — interactive diagram canvas engine.
// Self-contained ES module: draggable icon-node diagrams over SVG with live
// edge re-routing, group containers, pan/zoom, deterministic auto-layouts,
// and SVG/PNG export. No dependencies. The pure layout functions are exported
// separately so they can be unit-tested in Node (no DOM needed).
//
// Public API:
//   const ctl = await createCanvas(el, { data, positions, template, readOnly,
//                                        manifestUrl, onChange });
//   ctl.setTemplate(name) / getTemplate() / resetLayout() / getPositions()
//   ctl.exportSvg() -> Promise<string>   (standalone light-theme SVG, icons inlined)
//   ctl.exportPng(scale) -> Promise<Blob>
//   ctl.fit() / ctl.destroy()

export const NODE_W = 180;
export const NODE_H = 64;

const GRID = 8;
const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
export const TEMPLATES = ['category-grid', 'layer-rows', 'flow'];

export const CATEGORY_ORDER = [
  'edge-dns', 'networking', 'compute', 'messaging-streaming', 'database',
  'storage', 'security-secrets', 'identity-access', 'cicd-control-plane',
  'observability', 'third-party', 'other',
];

// Screen (dark) + export (light) themes.
const DARK = {
  bg: '#12161d', grid: '#222a38', card: '#1d2431', cardBorder: '#2a3242',
  text: '#e6ebf2', muted: '#8a94a6', accent: '#4f8ff7', tier0: '#e2564f',
  edge: '#8a94a6', groupFill: 'rgba(138,148,166,0.055)', groupStroke: '#2a3242',
  labelBg: '#171c25',
};
const LIGHT = {
  bg: '#ffffff', grid: 'none', card: '#ffffff', cardBorder: '#c9d2de',
  text: '#202124', muted: '#5f6b7a', accent: '#2f6fdb', tier0: '#d64540',
  edge: '#6b7686', groupFill: '#f4f6fa', groupStroke: '#dde3ec',
  labelBg: '#ffffff',
};

// ---------------------------------------------------------------------------
// Pure helpers (Node-testable, no DOM)
// ---------------------------------------------------------------------------

const snap = (v) => Math.round(v / GRID) * GRID;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function catRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

function byLabel(a, b) {
  return String(a.label || a.id).localeCompare(String(b.label || b.id)) || String(a.id).localeCompare(String(b.id));
}

function safeNodes(data) {
  const seen = new Set();
  const out = [];
  for (const n of (data && Array.isArray(data.nodes) ? data.nodes : [])) {
    if (!n || n.id === undefined || n.id === null || seen.has(String(n.id))) continue;
    seen.add(String(n.id));
    out.push(n);
  }
  return out;
}

function safeEdges(data, ids) {
  const out = [];
  for (const e of (data && Array.isArray(data.edges) ? data.edges : [])) {
    if (!e || e.from === undefined || e.to === undefined) continue;
    const from = String(e.from), to = String(e.to);
    if (from === to) continue;                 // self-loops: skip
    if (!ids.has(from) || !ids.has(to)) continue; // dangling endpoints: skip
    out.push({ from, to, kind: e.kind === 'outbound' ? 'outbound' : 'dependency', label: e.label || '' });
  }
  return out;
}

// Deterministic de-collision: nudge exact-duplicate coordinates apart.
function decollide(positions, orderedIds) {
  const seen = new Set();
  for (const id of orderedIds) {
    const p = positions[id];
    if (!p) continue;
    let k = `${p.x},${p.y}`;
    while (seen.has(k)) {
      p.x = snap(p.x + GRID);
      p.y = snap(p.y + GRID * 2);
      k = `${p.x},${p.y}`;
    }
    seen.add(k);
  }
  return positions;
}

// -- Template 1: category-grid — one column band per category ----------------
function layoutCategoryGrid(data) {
  const nodes = safeNodes(data);
  const cols = new Map();
  for (const n of nodes) {
    const cat = n.category || 'other';
    if (!cols.has(cat)) cols.set(cat, []);
    cols.get(cat).push(n);
  }
  const order = [...cols.keys()].sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b));

  const positions = {};
  const COL_GAP = 72, ROW_GAP = 20, SUB_GAP = 24, MAX_ROWS = 8;
  let x0 = 40;
  for (const cat of order) {
    const members = cols.get(cat).slice().sort((a, b) => (num(a.tier) ?? 9) - (num(b.tier) ?? 9) || byLabel(a, b));
    const subCols = Math.max(1, Math.ceil(members.length / MAX_ROWS));
    const rows = Math.ceil(members.length / subCols);
    members.forEach((n, i) => {
      const sc = Math.floor(i / rows), row = i % rows;
      positions[String(n.id)] = {
        x: snap(x0 + sc * (NODE_W + SUB_GAP)),
        y: snap(48 + row * (NODE_H + ROW_GAP)),
      };
    });
    x0 += subCols * NODE_W + (subCols - 1) * SUB_GAP + COL_GAP;
  }
  return decollide(positions, nodes.map((n) => String(n.id)));
}

// -- Template 2: layer-rows — restore layer cake, L0 top → L7 bottom ---------
function layoutLayerRows(data) {
  const nodes = safeNodes(data);
  const rows = new Map();
  for (const n of nodes) {
    const layer = LAYERS.includes(n.layer) ? n.layer : '~unlayered';
    if (!rows.has(layer)) rows.set(layer, []);
    rows.get(layer).push(n);
  }
  const order = [...LAYERS.filter((l) => rows.has(l)), ...(rows.has('~unlayered') ? ['~unlayered'] : [])];

  const positions = {};
  const X_GAP = 32, LINE_GAP = 18, ROW_GAP = 64, PER_LINE = 5;
  let y0 = 48;
  for (const layer of order) {
    const members = rows.get(layer).slice().sort((a, b) => catRank(a.category) - catRank(b.category) || byLabel(a, b));
    members.forEach((n, i) => {
      const line = Math.floor(i / PER_LINE), col = i % PER_LINE;
      positions[String(n.id)] = {
        x: snap(48 + col * (NODE_W + X_GAP)),
        y: snap(y0 + line * (NODE_H + LINE_GAP)),
      };
    });
    const lines = Math.max(1, Math.ceil(members.length / PER_LINE));
    y0 += lines * (NODE_H + LINE_GAP) + ROW_GAP;
  }
  return decollide(positions, nodes.map((n) => String(n.id)));
}

// -- Template 3: flow — layered left-to-right by dependency topology ---------
// Longest-path rank along dependency edges (from.rank < to.rank), back-edges
// in cycles ignored; nodes reached only by outbound edges land one rank past
// their sources. Exported for testing.
export function computeFlowRanks(data) {
  const nodes = safeNodes(data);
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = safeEdges(data, ids);
  const deps = edges.filter((e) => e.kind === 'dependency');

  const preds = new Map(); // to -> [from]
  for (const e of deps) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
  }

  const rank = new Map();
  const visiting = new Set();
  function rankOf(id) {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id)) return 0; // cycle back-edge: ignore
    visiting.add(id);
    let r = 0;
    for (const p of preds.get(id) || []) {
      if (visiting.has(p)) continue; // skip back-edge inside a cycle
      r = Math.max(r, rankOf(p) + 1);
    }
    visiting.delete(id);
    rank.set(id, r);
    return r;
  }
  for (const n of nodes) rankOf(String(n.id));

  // Outbound-only targets (synthetic third-party nodes): push past their sources.
  const depTouched = new Set();
  for (const e of deps) { depTouched.add(e.from); depTouched.add(e.to); }
  for (const n of nodes) {
    const id = String(n.id);
    if (depTouched.has(id)) continue;
    let best = -1;
    for (const e of edges) if (e.kind === 'outbound' && e.to === id) best = Math.max(best, rank.get(e.from) ?? 0);
    if (best >= 0) rank.set(id, best + 1);
  }
  return rank;
}

function layoutFlow(data) {
  const nodes = safeNodes(data);
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = safeEdges(data, ids);
  const rank = computeFlowRanks(data);

  // Buckets per rank, initial deterministic order.
  const buckets = new Map();
  for (const n of nodes.slice().sort(byLabel)) {
    const r = rank.get(String(n.id)) ?? 0;
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(String(n.id));
  }
  const rankList = [...buckets.keys()].sort((a, b) => a - b);

  const nbrOut = new Map(), nbrIn = new Map();
  for (const e of edges) {
    if (!nbrOut.has(e.from)) nbrOut.set(e.from, []);
    nbrOut.get(e.from).push(e.to);
    if (!nbrIn.has(e.to)) nbrIn.set(e.to, []);
    nbrIn.get(e.to).push(e.from);
  }

  // Barycenter sweeps to reduce crossings (forward then backward).
  const idx = new Map();
  const reindex = () => { for (const r of rankList) buckets.get(r).forEach((id, i) => idx.set(id, i)); };
  reindex();
  const sortBucket = (r, nbrs) => {
    const arr = buckets.get(r);
    const bary = new Map();
    for (const id of arr) {
      const ns = (nbrs.get(id) || []).map((m) => idx.get(m)).filter((v) => v !== undefined);
      bary.set(id, ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : idx.get(id));
    }
    arr.sort((a, b) => bary.get(a) - bary.get(b) || idx.get(a) - idx.get(b));
    reindex();
  };
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const r of rankList) sortBucket(r, nbrIn);
    for (const r of rankList.slice().reverse()) sortBucket(r, nbrOut);
  }

  const positions = {};
  const X_GAP = 130, Y_GAP = 28;
  const maxCount = Math.max(1, ...rankList.map((r) => buckets.get(r).length));
  const maxH = maxCount * (NODE_H + Y_GAP);
  rankList.forEach((r, ri) => {
    const arr = buckets.get(r);
    const colH = arr.length * (NODE_H + Y_GAP);
    arr.forEach((id, i) => {
      positions[id] = {
        x: snap(60 + ri * (NODE_W + X_GAP)),
        y: snap(48 + (maxH - colH) / 2 + i * (NODE_H + Y_GAP)),
      };
    });
  });
  return decollide(positions, nodes.map((n) => String(n.id)));
}

// Dispatcher — deterministic, returns {nodeId: {x, y}} for every node.
export function computeLayout(template, data) {
  const t = TEMPLATES.includes(template) ? template : 'category-grid';
  if (t === 'layer-rows') return layoutLayerRows(data);
  if (t === 'flow') return layoutFlow(data);
  return layoutCategoryGrid(data);
}

// ---------------------------------------------------------------------------
// Icon resolution + built-in fallback glyphs
// ---------------------------------------------------------------------------

const GLYPH_COLORS = {
  'compute': '#e8873c', 'database': '#4f8ff7', 'storage': '#3fb27f',
  'networking': '#9d7bf5', 'messaging-streaming': '#e2a336',
  'security-secrets': '#e2564f', 'edge-dns': '#58c1d4',
  'identity-access': '#d46bb8', 'observability': '#7ec97e',
  'cicd-control-plane': '#8a94a6', 'third-party': '#8a94a6', 'other': '#8a94a6',
};

// Simple 36×36 line glyphs, one per category — used whenever no icon resolves.
const GLYPH_PATHS = {
  'compute': '<rect x="8" y="8" width="20" height="20" rx="3"/><rect x="14.5" y="14.5" width="7" height="7" rx="1"/><path d="M13 8V4M18 8V4M23 8V4M13 32v-4M18 32v-4M23 32v-4M8 13H4M8 18H4M8 23H4M32 13h-4M32 18h-4M32 23h-4"/>',
  'database': '<ellipse cx="18" cy="9.5" rx="10" ry="4.5"/><path d="M8 9.5v17c0 2.5 4.5 4.5 10 4.5s10-2 10-4.5v-17M8 18c0 2.5 4.5 4.5 10 4.5s10-2 10-4.5"/>',
  'storage': '<path d="M8 13l10-5.5L28 13v10.5L18 29 8 23.5V13z"/><path d="M8 13l10 5.5L28 13M18 18.5V29"/>',
  'networking': '<circle cx="18" cy="9" r="3.5"/><circle cx="9" cy="27" r="3.5"/><circle cx="27" cy="27" r="3.5"/><path d="M16.2 12.2L10.6 24M19.8 12.2l5.6 11.8M12.5 27h11"/>',
  'messaging-streaming': '<rect x="6.5" y="10.5" width="23" height="15" rx="2"/><path d="M6.5 12.5L18 20.5l11.5-8"/>',
  'security-secrets': '<rect x="10" y="16" width="16" height="13" rx="2"/><path d="M13 16v-4a5 5 0 0 1 10 0v4M18 21.5v3"/>',
  'edge-dns': '<circle cx="18" cy="18" r="11"/><ellipse cx="18" cy="18" rx="5" ry="11"/><path d="M7 18h22"/>',
  'identity-access': '<circle cx="18" cy="12" r="5"/><path d="M8 29c0-6 4.5-9 10-9s10 3 10 9"/>',
  'observability': '<circle cx="18" cy="18" r="11"/><path d="M10 18h3.5l2-5 4.5 10 2-5H26"/>',
  'cicd-control-plane': '<circle cx="18" cy="18" r="4.5"/><circle cx="18" cy="18" r="10.5" stroke-dasharray="3.5 4.2"/><path d="M18 4v4M18 28v4M4 18h4M28 18h4"/>',
  'third-party': '<rect x="7" y="14" width="14" height="14" rx="2"/><path d="M21 8h7v7M28 8L17.5 18.5"/>',
  'other': '<rect x="9" y="9" width="18" height="18" rx="4"/><circle cx="18" cy="18" r="1.6"/>',
};

function glyphMarkup(category, forExport) {
  const cat = GLYPH_PATHS[category] ? category : 'other';
  const color = GLYPH_COLORS[cat] || '#8a94a6';
  return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${forExport ? '' : ''}>${GLYPH_PATHS[cat]}</g>`;
}

// map.kinds[kind] → map.awsServices[first] → map.categories[category] → map.default
export function resolveIcon(node, manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.map || !manifest.icons) return null;
  const m = manifest.map;
  const tryId = (id) => (id && manifest.icons[id] && manifest.icons[id].file ? manifest.icons[id] : null);
  return tryId(m.kinds && node.kind ? m.kinds[node.kind] : null)
    || tryId(m.awsServices && Array.isArray(node.awsServices) && node.awsServices.length ? m.awsServices[node.awsServices[0]] : null)
    || tryId(m.categories && node.category ? m.categories[node.category] : null)
    || tryId(m.default);
}

// ---------------------------------------------------------------------------
// Geometry helpers (shared by screen + export renderers)
// ---------------------------------------------------------------------------

// Orthogonal-ish anchor selection: connect the two facing sides.
function edgeGeometry(p1, p2) {
  const c1 = { x: p1.x + NODE_W / 2, y: p1.y + NODE_H / 2 };
  const c2 = { x: p2.x + NODE_W / 2, y: p2.y + NODE_H / 2 };
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  let a, b, ca, cb;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const s = dx >= 0 ? 1 : -1;
    a = { x: c1.x + s * (NODE_W / 2), y: c1.y };
    b = { x: c2.x - s * (NODE_W / 2), y: c2.y };
    const k = Math.min(160, Math.max(40, Math.abs(dx) / 2.4));
    ca = { x: a.x + s * k, y: a.y };
    cb = { x: b.x - s * k, y: b.y };
  } else {
    const s = dy >= 0 ? 1 : -1;
    a = { x: c1.x, y: c1.y + s * (NODE_H / 2) };
    b = { x: c2.x, y: c2.y - s * (NODE_H / 2) };
    const k = Math.min(140, Math.max(36, Math.abs(dy) / 2.4));
    ca = { x: a.x, y: a.y + s * k };
    cb = { x: b.x, y: b.y - s * k };
  }
  const path = `M ${a.x} ${a.y} C ${ca.x} ${ca.y}, ${cb.x} ${cb.y}, ${b.x} ${b.y}`;
  // Bezier midpoint (t = 0.5) for the label.
  const mid = {
    x: (a.x + 3 * ca.x + 3 * cb.x + b.x) / 8,
    y: (a.y + 3 * ca.y + 3 * cb.y + b.y) / 8,
  };
  return { path, mid };
}

function groupBounds(group, positions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (const id of group.nodeIds || []) {
    const p = positions[String(id)];
    if (!p) continue;
    count++;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  if (!count) return null;
  const PAD = 16, LABEL = 22;
  return { x: minX - PAD, y: minY - PAD - LABEL, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 + LABEL };
}

function contentBounds(positions, groups) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of Object.values(positions)) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  for (const g of groups || []) {
    const b = groupBounds(g, positions);
    if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: NODE_W, h: NODE_H };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Text measurement (canvas 2d — works for both screen and export sizing)
// ---------------------------------------------------------------------------

let _mctx = null;
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';
function textWidth(s, font) {
  if (typeof document === 'undefined') return String(s).length * 7;
  if (!_mctx) {
    try { _mctx = document.createElement('canvas').getContext('2d'); } catch { return String(s).length * 7; }
  }
  if (!_mctx) return String(s).length * 7;
  _mctx.font = font;
  return _mctx.measureText(String(s)).width;
}
function ellipsize(s, font, max) {
  let t = String(s ?? '');
  if (textWidth(t, font) <= max) return t;
  while (t.length > 1 && textWidth(t + '…', font) > max) t = t.slice(0, -1);
  return t + '…';
}

const LABEL_FONT = `600 12.5px ${FONT_STACK}`;
const SUB_FONT = `400 11px ${FONT_STACK}`;
const TEXT_MAX = NODE_W - 58 - 12; // icon block + right padding

// ---------------------------------------------------------------------------
// Styles injected once
// ---------------------------------------------------------------------------

const STYLE_ID = 'dcv-styles';
const STYLES = `
.dcv-wrap { position: relative; width: 100%; min-height: 600px; background: ${DARK.bg};
  border-radius: 10px; overflow: hidden; }
.dcv-wrap svg.dcv-svg { display: block; width: 100%; height: 100%; position: absolute; inset: 0;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.dcv-toolbar { position: absolute; top: 10px; right: 10px; z-index: 5; display: flex; gap: 6px; }
.dcv-btn { background: rgba(29,36,49,.92); color: #e6ebf2; border: 1px solid #2a3242; border-radius: 7px;
  padding: 4px 10px; font: 600 12px ${FONT_STACK}; cursor: pointer; }
.dcv-btn:hover { border-color: #3a4557; }
.dcv-btn.dcv-on { background: rgba(79,143,247,.18); border-color: rgba(79,143,247,.45); color: #9cc0fa; }
.dcv-node { cursor: grab; }
.dcv-node.dcv-dragging { cursor: grabbing; }
.dcv-readonly .dcv-node { cursor: default; }
.dcv-node rect.dcv-card { transition: opacity .12s ease; }
.dcv-node:hover rect.dcv-card { stroke: #3a4557; }
.dcv-node.dcv-selected rect.dcv-card, .dcv-node.dcv-hot rect.dcv-card { stroke: ${DARK.accent}; stroke-width: 1.5; }
.dcv-dim { opacity: .22; transition: opacity .12s ease; }
.dcv-edge-hit { stroke: transparent; stroke-width: 12; fill: none; pointer-events: stroke; cursor: pointer; }
.dcv-edge.dcv-edge-hot path.dcv-edge-line { stroke: ${DARK.accent} !important; stroke-width: 2.4; }
.dcv-edge-label { pointer-events: none; }
.dcv-empty-hint { fill: ${DARK.muted}; font: 13px ${FONT_STACK}; }
.dcv-grabbing, .dcv-grabbing * { cursor: grabbing !important; }
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLES;
  document.head.appendChild(s);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, v);
  }
  return el;
}

// ---------------------------------------------------------------------------
// createCanvas — the engine
// ---------------------------------------------------------------------------

export async function createCanvas(el, opts = {}) {
  injectStyles();
  const {
    data = {},
    manifestUrl = '/assets/icons/manifest.json',
    readOnly = false,
    onChange = () => {},
  } = opts;

  // --- normalize data ------------------------------------------------------
  const nodes = safeNodes(data);
  const nodeById = new Map(nodes.map((n) => [String(n.id), n]));
  const edges = safeEdges(data, new Set(nodeById.keys()));
  const groups = (Array.isArray(data.groups) ? data.groups : [])
    .filter((g) => g && Array.isArray(g.nodeIds) && g.nodeIds.some((id) => nodeById.has(String(id))));

  const edgesByNode = new Map();
  edges.forEach((e, i) => {
    e._i = i;
    for (const id of [e.from, e.to]) {
      if (!edgesByNode.has(id)) edgesByNode.set(id, []);
      edgesByNode.get(id).push(e);
    }
  });

  // --- manifest (defensive: canvas must never break without icons) ---------
  let manifest = null;
  try {
    const res = await fetch(manifestUrl);
    if (res.ok) {
      const j = await res.json();
      if (j && typeof j === 'object' && j.icons && j.map) manifest = j;
    }
  } catch { /* no icons — glyph fallbacks take over */ }

  // --- layout state ---------------------------------------------------------
  let template = TEMPLATES.includes(opts.template) ? opts.template : 'category-grid';
  let base = computeLayout(template, { nodes, edges });
  const custom = {}; // user-moved overrides
  if (opts.positions && typeof opts.positions === 'object') {
    for (const [k, v] of Object.entries(opts.positions)) {
      if (!nodeById.has(String(k)) || !v) continue;
      const x = num(v.x), y = num(v.y);
      if (x === null || y === null) continue;
      custom[String(k)] = { x: snap(x), y: snap(y) };
    }
  }
  const posOf = (id) => custom[id] || base[id] || { x: 0, y: 0 };
  const allPositions = () => {
    const out = {};
    for (const id of nodeById.keys()) { const p = posOf(id); out[id] = { x: p.x, y: p.y }; }
    return out;
  };

  // --- DOM scaffold ----------------------------------------------------------
  el.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'dcv-wrap' + (readOnly ? ' dcv-readonly' : '');
  if (!el.style.minHeight) el.style.minHeight = '600px';
  el.style.position = el.style.position || 'relative';
  wrap.style.height = '100%';
  wrap.style.minHeight = 'inherit';
  el.appendChild(wrap);

  const svg = svgEl('svg', { class: 'dcv-svg' });
  wrap.appendChild(svg);

  const defs = svgEl('defs');
  defs.innerHTML = `
    <pattern id="dcv-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="1.2" cy="1.2" r="1.1" fill="${DARK.grid}"/>
    </pattern>
    <marker id="dcv-arrow-dep" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L8,4 L0,8 Z" fill="${DARK.edge}"/>
    </marker>
    <marker id="dcv-arrow-out" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L8,4 L0,8 Z" fill="${DARK.accent}"/>
    </marker>`;
  svg.appendChild(defs);

  const gridRect = svgEl('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'url(#dcv-grid)' });
  const viewport = svgEl('g');
  viewport.appendChild(gridRect);
  const gGroups = svgEl('g'), gEdges = svgEl('g'), gLabels = svgEl('g'), gNodes = svgEl('g');
  viewport.append(gGroups, gEdges, gLabels, gNodes);
  svg.appendChild(viewport);

  // toolbar overlay
  const toolbar = document.createElement('div');
  toolbar.className = 'dcv-toolbar';
  let showOutbound = true;
  const outBtn = document.createElement('button');
  outBtn.type = 'button';
  outBtn.className = 'dcv-btn dcv-on';
  outBtn.textContent = 'Outbound calls';
  outBtn.title = 'Show / hide dashed outbound-call edges';
  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'dcv-btn';
  fitBtn.textContent = 'Fit';
  fitBtn.title = 'Fit diagram to view';
  toolbar.append(outBtn, fitBtn);
  wrap.appendChild(toolbar);

  // --- view transform (pan/zoom) --------------------------------------------
  const view = { x: 0, y: 0, z: 1 };
  const applyView = () => viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.z})`);
  const toWorld = (sx, sy) => {
    const r = svg.getBoundingClientRect();
    return { x: (sx - r.left - view.x) / view.z, y: (sy - r.top - view.y) / view.z };
  };

  function fit() {
    const b = contentBounds(allPositions(), groups);
    const r = svg.getBoundingClientRect();
    const W = r.width || wrap.clientWidth || 900;
    const H = r.height || wrap.clientHeight || 600;
    if (!nodes.length || b.w <= 0 || b.h <= 0) { view.x = 0; view.y = 0; view.z = 1; applyView(); return; }
    const PAD = 48;
    let z = Math.min((W - PAD) / b.w, (H - PAD) / b.h);
    z = Math.max(0.3, Math.min(1.25, z));
    view.z = z;
    view.x = (W - b.w * z) / 2 - b.x * z;
    view.y = (H - b.h * z) / 2 - b.y * z;
    applyView();
  }

  // --- render: groups --------------------------------------------------------
  const groupEls = new Map();
  for (const g of groups) {
    const rect = svgEl('rect', { rx: 12, fill: DARK.groupFill, stroke: DARK.groupStroke, 'stroke-width': 1 });
    const label = svgEl('text', {
      fill: DARK.muted, 'font-family': FONT_STACK, 'font-size': 10, 'font-weight': 700,
      'letter-spacing': '0.08em', style: 'text-transform: uppercase',
    });
    label.textContent = String(g.label || g.id || '').toUpperCase();
    const gg = svgEl('g');
    gg.append(rect, label);
    gGroups.appendChild(gg);
    groupEls.set(g, { rect, label });
  }
  function refreshGroups() {
    const pos = allPositions();
    for (const [g, els] of groupEls) {
      const b = groupBounds(g, pos);
      if (!b) { els.rect.setAttribute('display', 'none'); els.label.setAttribute('display', 'none'); continue; }
      els.rect.removeAttribute('display'); els.label.removeAttribute('display');
      els.rect.setAttribute('x', b.x); els.rect.setAttribute('y', b.y);
      els.rect.setAttribute('width', b.w); els.rect.setAttribute('height', b.h);
      els.label.setAttribute('x', b.x + 12); els.label.setAttribute('y', b.y + 16);
    }
  }

  // --- render: edges ----------------------------------------------------------
  const showAllLabels = edges.filter((e) => e.label).length > 0 && edges.length <= 12;
  const edgeEls = [];
  for (const e of edges) {
    const isOut = e.kind === 'outbound';
    const line = svgEl('path', {
      class: 'dcv-edge-line', fill: 'none',
      stroke: isOut ? DARK.accent : DARK.edge,
      'stroke-width': 1.5,
      'stroke-dasharray': isOut ? '6 5' : null,
      'marker-end': `url(#${isOut ? 'dcv-arrow-out' : 'dcv-arrow-dep'})`,
      opacity: isOut ? 0.75 : 0.9,
    });
    const hit = svgEl('path', { class: 'dcv-edge-hit' });
    const gE = svgEl('g', { class: 'dcv-edge' });
    gE.append(line, hit);
    gEdges.appendChild(gE);

    let labelEl = null, labelBg = null;
    if (e.label) {
      labelBg = svgEl('rect', { rx: 4, fill: DARK.labelBg, opacity: 0.92, class: 'dcv-edge-label' });
      labelEl = svgEl('text', {
        class: 'dcv-edge-label', fill: DARK.muted, 'font-family': FONT_STACK,
        'font-size': 11, 'text-anchor': 'middle',
      });
      labelEl.textContent = e.label;
      gLabels.append(labelBg, labelEl);
      if (!showAllLabels) { labelBg.setAttribute('display', 'none'); labelEl.setAttribute('display', 'none'); }
    }
    const rec = { e, gE, line, hit, labelEl, labelBg };
    edgeEls.push(rec);

    hit.addEventListener('pointerenter', () => {
      gE.classList.add('dcv-edge-hot');
      nodeEls.get(e.from)?.g.classList.add('dcv-hot');
      nodeEls.get(e.to)?.g.classList.add('dcv-hot');
      if (labelEl && !showAllLabels) { labelBg.removeAttribute('display'); labelEl.removeAttribute('display'); }
    });
    hit.addEventListener('pointerleave', () => {
      gE.classList.remove('dcv-edge-hot');
      nodeEls.get(e.from)?.g.classList.remove('dcv-hot');
      nodeEls.get(e.to)?.g.classList.remove('dcv-hot');
      if (labelEl && !showAllLabels) { labelBg.setAttribute('display', 'none'); labelEl.setAttribute('display', 'none'); }
    });
  }

  function routeEdge(rec) {
    const p1 = posOf(rec.e.from), p2 = posOf(rec.e.to);
    const { path, mid } = edgeGeometry(p1, p2);
    rec.line.setAttribute('d', path);
    rec.hit.setAttribute('d', path);
    if (rec.labelEl) {
      rec.labelEl.setAttribute('x', mid.x);
      rec.labelEl.setAttribute('y', mid.y - 4);
      const w = textWidth(rec.e.label, `11px ${FONT_STACK}`) + 10;
      rec.labelBg.setAttribute('x', mid.x - w / 2);
      rec.labelBg.setAttribute('y', mid.y - 16);
      rec.labelBg.setAttribute('width', w);
      rec.labelBg.setAttribute('height', 16);
    }
  }
  function routeEdgesFor(nodeId) {
    for (const e of edgesByNode.get(nodeId) || []) routeEdge(edgeEls[e._i]);
  }
  function routeAllEdges() { for (const rec of edgeEls) routeEdge(rec); }

  function applyOutboundVisibility() {
    for (const rec of edgeEls) {
      if (rec.e.kind !== 'outbound') continue;
      const disp = showOutbound ? null : 'none';
      if (disp) rec.gE.setAttribute('display', disp); else rec.gE.removeAttribute('display');
      if (rec.labelEl) {
        if (disp || !showAllLabels) { rec.labelEl.setAttribute('display', 'none'); rec.labelBg.setAttribute('display', 'none'); }
        else { rec.labelEl.removeAttribute('display'); rec.labelBg.removeAttribute('display'); }
      }
    }
  }
  outBtn.addEventListener('click', () => {
    showOutbound = !showOutbound;
    outBtn.classList.toggle('dcv-on', showOutbound);
    applyOutboundVisibility();
  });
  fitBtn.addEventListener('click', fit);

  // --- render: nodes -----------------------------------------------------------
  const nodeEls = new Map();
  for (const n of nodes) {
    const id = String(n.id);
    const isThird = n.category === 'third-party';
    const isTier0 = num(n.tier) === 0;
    const g = svgEl('g', { class: 'dcv-node', 'data-id': id });

    const card = svgEl('rect', {
      class: 'dcv-card', width: NODE_W, height: NODE_H, rx: 10,
      fill: DARK.card, stroke: DARK.cardBorder, 'stroke-width': 1,
      'stroke-dasharray': isThird ? '5 4' : null,
    });
    g.appendChild(card);
    if (isTier0) {
      g.appendChild(svgEl('path', {
        d: `M 1.5 12 L 1.5 ${NODE_H - 12}`,
        stroke: DARK.tier0, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.85,
      }));
    }

    // icon (36×36 at 12,14) — manifest image with glyph fallback
    const iconHolder = svgEl('g', { transform: 'translate(12,14)' });
    const icon = manifest ? resolveIcon(n, manifest) : null;
    const useGlyph = () => { iconHolder.innerHTML = glyphMarkup(n.category || 'other'); };
    if (icon) {
      const img = svgEl('image', { width: 36, height: 36, href: `/assets/icons/${icon.file}` });
      img.addEventListener('error', useGlyph, { once: true });
      iconHolder.appendChild(img);
      n._iconFile = icon.file;
    } else {
      useGlyph();
    }
    g.appendChild(iconHolder);

    const hasSub = !!n.sub;
    n._dispLabel = ellipsize(n.label ?? id, LABEL_FONT, TEXT_MAX);
    const labelEl = svgEl('text', {
      x: 58, y: hasSub ? 29 : 37, fill: DARK.text,
      'font-family': FONT_STACK, 'font-size': 12.5, 'font-weight': 600,
    });
    labelEl.textContent = n._dispLabel;
    g.appendChild(labelEl);
    if (hasSub) {
      n._dispSub = ellipsize(n.sub, SUB_FONT, TEXT_MAX);
      const subEl = svgEl('text', {
        x: 58, y: 45, fill: DARK.muted, 'font-family': FONT_STACK, 'font-size': 11,
      });
      subEl.textContent = n._dispSub;
      g.appendChild(subEl);
    }
    const tip = svgEl('title');
    tip.textContent = `${n.label ?? id}${n.sub ? ` — ${n.sub}` : ''}`;
    g.appendChild(tip);

    gNodes.appendChild(g);
    nodeEls.set(id, { n, g });
  }

  function placeNode(id) {
    const p = posOf(id);
    nodeEls.get(id)?.g.setAttribute('transform', `translate(${p.x},${p.y})`);
  }
  function placeAll() {
    for (const id of nodeEls.keys()) placeNode(id);
    routeAllEdges();
    refreshGroups();
  }

  // empty state
  if (!nodes.length) {
    const hint = svgEl('text', { class: 'dcv-empty-hint', x: '50%', y: '50%', 'text-anchor': 'middle' });
    hint.textContent = 'Nothing to draw yet — add components in Inventory and they will appear here.';
    svg.appendChild(hint);
  }

  // --- focus mode (hover/selection dims unrelated to ~25%) ---------------------
  let dragging = false;
  let selectedId = null;
  function setFocus(nodeId) {
    if (nodeId === null) {
      for (const { g } of nodeEls.values()) g.classList.remove('dcv-dim');
      for (const rec of edgeEls) rec.gE.classList.remove('dcv-dim');
      for (const { rect, label } of groupEls.values()) { rect.classList.remove('dcv-dim'); label.classList.remove('dcv-dim'); }
      return;
    }
    const related = new Set([nodeId]);
    const litEdges = new Set();
    for (const e of edgesByNode.get(nodeId) || []) {
      if (e.kind === 'outbound' && !showOutbound) continue;
      related.add(e.from); related.add(e.to); litEdges.add(e._i);
    }
    for (const [id, { g }] of nodeEls) g.classList.toggle('dcv-dim', !related.has(id));
    for (const rec of edgeEls) rec.gE.classList.toggle('dcv-dim', !litEdges.has(rec.e._i));
  }

  // --- interaction: node drag ---------------------------------------------------
  let changeTimer = null;
  const emitChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { try { onChange(allPositions()); } catch (err) { console.error('[diagram-canvas] onChange failed', err); } }, 400);
  };

  for (const [id, { g }] of nodeEls) {
    g.addEventListener('pointerenter', () => { if (!dragging) setFocus(id); });
    g.addEventListener('pointerleave', () => { if (!dragging) setFocus(selectedId); });
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const was = g.classList.contains('dcv-selected');
      for (const { g: og } of nodeEls.values()) og.classList.remove('dcv-selected');
      selectedId = was ? null : id;
      if (!was) g.classList.add('dcv-selected');
      setFocus(selectedId ?? id); // hovering anyway; keep dim consistent
    });

    if (readOnly) continue;
    g.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const start = toWorld(ev.clientX, ev.clientY);
      const p0 = posOf(id);
      const grab = { dx: start.x - p0.x, dy: start.y - p0.y };
      let moved = false;
      dragging = true;
      g.classList.add('dcv-dragging');
      g.setPointerCapture(ev.pointerId);

      const onMove = (mv) => {
        const w = toWorld(mv.clientX, mv.clientY);
        const nx = snap(w.x - grab.dx), ny = snap(w.y - grab.dy);
        const cur = custom[id];
        if (cur && cur.x === nx && cur.y === ny) return;
        custom[id] = { x: nx, y: ny };
        moved = true;
        placeNode(id);
        routeEdgesFor(id);
        refreshGroups();
      };
      const onUp = (up) => {
        g.removeEventListener('pointermove', onMove);
        g.removeEventListener('pointerup', onUp);
        g.removeEventListener('pointercancel', onUp);
        try { g.releasePointerCapture(up.pointerId); } catch { /* already released */ }
        g.classList.remove('dcv-dragging');
        dragging = false;
        if (moved) emitChange();
      };
      g.addEventListener('pointermove', onMove);
      g.addEventListener('pointerup', onUp);
      g.addEventListener('pointercancel', onUp);
    });
  }

  // --- interaction: pan + zoom -----------------------------------------------------
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // only start a pan from empty space (svg root / grid / group containers)
    if (ev.target !== svg && ev.target !== gridRect && ev.target !== viewport
      && !gGroups.contains(ev.target)) return;
    // clicking empty space clears selection + focus
    if (selectedId !== null) {
      nodeEls.get(selectedId)?.g.classList.remove('dcv-selected');
      selectedId = null;
      setFocus(null);
    }
    const sx = ev.clientX, sy = ev.clientY, ox = view.x, oy = view.y;
    svg.setPointerCapture(ev.pointerId);
    wrap.classList.add('dcv-grabbing');
    const onMove = (mv) => {
      view.x = ox + (mv.clientX - sx);
      view.y = oy + (mv.clientY - sy);
      applyView();
    };
    const onUp = () => {
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      wrap.classList.remove('dcv-grabbing');
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
  });

  const onWheel = (ev) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    const nz = Math.max(0.3, Math.min(2.5, view.z * factor));
    if (nz === view.z) return;
    const r = svg.getBoundingClientRect();
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const wx = (sx - view.x) / view.z, wy = (sy - view.y) / view.z;
    view.z = nz;
    view.x = sx - wx * nz;
    view.y = sy - wy * nz;
    applyView();
  };
  svg.addEventListener('wheel', onWheel, { passive: false });

  // --- initial paint -----------------------------------------------------------------
  placeAll();
  applyOutboundVisibility();
  applyView();
  // fit once the element has real dimensions
  requestAnimationFrame(fit);

  // --- export ------------------------------------------------------------------------
  const iconDataCache = new Map();
  async function iconDataUri(file) {
    if (iconDataCache.has(file)) return iconDataCache.get(file);
    let uri = null;
    try {
      const res = await fetch(`/assets/icons/${file}`);
      if (res.ok) {
        const type = res.headers.get('content-type') || (file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        if (type.includes('svg') || file.endsWith('.svg')) {
          const text = await res.text();
          uri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
        } else {
          const blob = await res.blob();
          uri = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
          });
        }
      }
    } catch { /* fall back to glyph */ }
    iconDataCache.set(file, uri);
    return uri;
  }

  // Standalone light-theme SVG for docs: white bg, dark text, icons inlined.
  async function exportSvg() {
    const T = LIGHT;
    const pos = allPositions();
    const b = contentBounds(pos, groups);
    const PAD = 32;
    const W = Math.ceil(b.w + PAD * 2), H = Math.ceil(b.h + PAD * 2);
    const off = { x: PAD - b.x, y: PAD - b.y };
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${escXml(FONT_STACK)}">`);
    parts.push(`<defs>
      <marker id="xarr-dep" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 Z" fill="${T.edge}"/></marker>
      <marker id="xarr-out" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 Z" fill="${T.accent}"/></marker>
    </defs>`);
    parts.push(`<rect width="${W}" height="${H}" fill="${T.bg}"/>`);
    parts.push(`<g transform="translate(${off.x},${off.y})">`);

    for (const g of groups) {
      const gb = groupBounds(g, pos);
      if (!gb) continue;
      parts.push(`<rect x="${gb.x}" y="${gb.y}" width="${gb.w}" height="${gb.h}" rx="12" fill="${T.groupFill}" stroke="${T.groupStroke}"/>`);
      parts.push(`<text x="${gb.x + 12}" y="${gb.y + 16}" fill="${T.muted}" font-size="10" font-weight="700" letter-spacing="0.08em">${escXml(String(g.label || g.id || '').toUpperCase())}</text>`);
    }

    for (const e of edges) {
      if (e.kind === 'outbound' && !showOutbound) continue;
      const { path, mid } = edgeGeometry(pos[e.from], pos[e.to]);
      const isOut = e.kind === 'outbound';
      parts.push(`<path d="${path}" fill="none" stroke="${isOut ? T.accent : T.edge}" stroke-width="1.5"${isOut ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#${isOut ? 'xarr-out' : 'xarr-dep'})" opacity="0.9"/>`);
      if (e.label) {
        const w = textWidth(e.label, `11px ${FONT_STACK}`) + 10;
        parts.push(`<rect x="${mid.x - w / 2}" y="${mid.y - 16}" width="${w}" height="16" rx="4" fill="${T.labelBg}" opacity="0.92"/>`);
        parts.push(`<text x="${mid.x}" y="${mid.y - 4}" fill="${T.muted}" font-size="11" text-anchor="middle">${escXml(e.label)}</text>`);
      }
    }

    for (const n of nodes) {
      const id = String(n.id);
      const p = pos[id];
      const isThird = n.category === 'third-party';
      const isTier0 = num(n.tier) === 0;
      parts.push(`<g transform="translate(${p.x},${p.y})">`);
      parts.push(`<rect width="${NODE_W}" height="${NODE_H}" rx="10" fill="${T.card}" stroke="${T.cardBorder}"${isThird ? ' stroke-dasharray="5 4"' : ''}/>`);
      if (isTier0) parts.push(`<path d="M 1.5 12 L 1.5 ${NODE_H - 12}" stroke="${T.tier0}" stroke-width="3" stroke-linecap="round" opacity="0.9"/>`);
      let iconMarkup = null;
      if (n._iconFile) {
        const uri = await iconDataUri(n._iconFile);
        if (uri) iconMarkup = `<image x="0" y="0" width="36" height="36" href="${uri}"/>`;
      }
      if (!iconMarkup) iconMarkup = glyphMarkup(n.category || 'other', true);
      parts.push(`<g transform="translate(12,14)">${iconMarkup}</g>`);
      const hasSub = !!n.sub;
      parts.push(`<text x="58" y="${hasSub ? 29 : 37}" fill="${T.text}" font-size="12.5" font-weight="600">${escXml(n._dispLabel ?? n.label ?? id)}</text>`);
      if (hasSub) parts.push(`<text x="58" y="45" fill="${T.muted}" font-size="11">${escXml(n._dispSub ?? n.sub)}</text>`);
      parts.push('</g>');
    }

    parts.push('</g></svg>');
    return parts.join('\n');
  }

  async function exportPng(scale = 2) {
    const svgText = await exportSvg();
    const m = svgText.match(/width="(\d+)" height="(\d+)"/);
    const w = m ? Number(m[1]) : 1200, hgt = m ? Number(m[2]) : 800;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('failed to rasterize diagram SVG'));
      im.src = url;
    });
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(hgt * scale));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return new Promise((resolve, reject) => {
      cv.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob failed'))), 'image/png');
    });
  }

  // --- controller ------------------------------------------------------------------------
  let destroyed = false;
  const controller = {
    setTemplate(name) {
      if (destroyed) return;
      template = TEMPLATES.includes(name) ? name : 'category-grid';
      for (const k of Object.keys(custom)) delete custom[k]; // template switch re-lays out everything
      base = computeLayout(template, { nodes, edges });
      placeAll();
      fit();
      emitChange();
    },
    getTemplate() { return template; },
    resetLayout() {
      if (destroyed) return;
      for (const k of Object.keys(custom)) delete custom[k];
      base = computeLayout(template, { nodes, edges });
      placeAll();
      fit();
      emitChange();
    },
    getPositions() { return allPositions(); },
    exportSvg,
    exportPng,
    fit() { if (!destroyed) fit(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(changeTimer);
      svg.removeEventListener('wheel', onWheel);
      wrap.remove();
    },
  };
  return controller;
}

export default { createCanvas, computeLayout, computeFlowRanks, resolveIcon, TEMPLATES, NODE_W, NODE_H };
