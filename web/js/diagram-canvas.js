// DR Compass — interactive diagram canvas engine.
// Self-contained ES module: draggable icon-node diagrams over SVG with live
// obstacle-aware edge re-routing, group containers, pan/zoom, deterministic
// layered auto-layout, filter/focus/declutter controls, a collapsible legend,
// designed SVG/PNG export, and Arpio-style in-place expansion of component
// nodes into compact resource pills.
//
// All layout/routing/filter math lives in ./diagram-layout.js as pure
// functions (unit-tested in Node); this module is the DOM half. Those pure
// functions are re-exported here so existing importers keep working.
//
// Public API:
//   const ctl = await createCanvas(el, { data, positions, template, readOnly,
//                                        manifestUrl, onChange,
//                                        onNodeClick, onNodeHover, nodeBadges,
//                                        onExpandRequest, expandableIds,
//                                        view, onViewChange, onSelect,
//                                        title, subtitle, toolbarExtras });
//   onNodeClick(node)  — fired for a real click (pointer moved < 5px), with the
//                        node's data object. onNodeHover(node|null) — enter/leave.
//   onSelect(node|null) — selection changed (additive; used for AI actions).
//   nodeBadges         — {nodeId: string} extra line(s) shown in the hover
//                        tooltip (looked up by node id, then node.componentId).
//   view / onViewChange — additive: initial filter/declutter/focus state and a
//                        callback when it changes, so the host page can persist
//                        it (the layouts endpoint only stores positions,
//                        template and expandedState).
//   title / subtitle   — used for the exported SVG's header.
//   toolbarExtras      — (ctl) => HTMLElement[] appended to the toolbar (AI).
//   onExpandRequest(node) — when provided, full-size nodes grow a ⊕ affordance
//                        (limited to opts.expandableIds when that array is
//                        given). Clicking ⊕ calls this callback; the page then
//                        fetches a subgraph and calls ctl.expandNode. When a
//                        node is expanded the affordance becomes ⊖ and calls
//                        ctl.collapseNode directly.
//   ctl.expandNode(nodeId, {nodes, edges}) — inject child nodes (typically
//                        small:true pills) + edges near the parent (fanned to
//                        its right, 8px snap); injected nodes drag, export,
//                        dim, and re-route like any node. Idempotent per
//                        nodeId. Shared child ids are refcounted across
//                        expansions. Injected-node positions appear in
//                        getPositions() and are respected when passed back as
//                        opts.positions — persistence needs no extra wiring.
//   ctl.collapseNode(nodeId) / ctl.isExpanded(nodeId) / ctl.getExpandedState()
//   ctl.setTemplate(name) / getTemplate() / resetLayout() / getPositions()
//   ctl.setPositions(map) / getView() / setView(partial) / focusNode(id, hops)
//   ctl.getSelectedNode() / ctl.getStats()
//   ctl.exportSvg() -> Promise<string>   (designed light-theme SVG w/ legend)
//   ctl.exportPng(scale) -> Promise<Blob>
//   ctl.fit() / ctl.destroy()
//
// Node objects may carry { small: true, rtype: 'security-group' } — small
// nodes render as compact ~150×40 pills (tiny icon, name, muted rtype label)
// visually subordinate to full component cards. Icon resolution for small
// nodes goes manifest map.kinds[rtype] first.

import * as LAYOUT from './diagram-layout.js';

export const {
  NODE_W, NODE_H, SMALL_W, SMALL_H, GRID,
  CATEGORY_ORDER, TEMPLATES,
  computeLayout, computeLayoutFull, computeFlowRanks,
  graphToCanvasNodes, computeExpansionLayout, collapseRemovals,
  detectHubs, collapseHubEdges, shouldCollapseHubs, nHopNeighborhood,
  dependencyFacts, applyView, normalizeView, buildFacets,
  groupParallelEdges, routeEdge, selectEdgeLabels, groupBounds, contentBounds,
  countGeometricCrossings, findOverlaps, edgeKeyOf, safeNodes, safeEdges,
  sizeOfNode, layeredFlowLayout, layoutFlowLegacy,
} = LAYOUT;

const { snap, num } = LAYOUT;
const LAYER_IDS = LAYOUT.LAYERS;

// Screen (dark) + export (light) themes.
const DARK = {
  bg: '#12161d', grid: '#1c2330', card: '#1d2431', cardBorder: '#2a3242',
  text: '#e6ebf2', muted: '#8a94a6', accent: '#4f8ff7', tier0: '#e2564f',
  edge: '#7d879a', relation: '#5d6778', hub: '#e2a336',
  groupFill: 'rgba(138,148,166,0.04)', groupStroke: '#252d3b',
  labelBg: '#171c25',
};
const LIGHT = {
  bg: '#ffffff', panel: '#fbfcfe', grid: 'none', card: '#ffffff', cardBorder: '#c9d2de',
  text: '#1c2026', muted: '#5f6b7a', accent: '#2f6fdb', tier0: '#d64540',
  edge: '#7b8697', relation: '#a4adbb', hub: '#b9801f',
  groupFill: '#f5f7fa', groupStroke: '#dde3ec', labelBg: '#ffffff',
  frame: '#e6eaf0', title: '#12161d',
};

const CATEGORY_LABEL = {
  'compute': 'Compute', 'networking': 'Networking', 'storage': 'Storage',
  'database': 'Databases', 'messaging-streaming': 'Messaging & streaming',
  'security-secrets': 'Security & secrets', 'edge-dns': 'Edge & DNS',
  'identity-access': 'Identity & access', 'observability': 'Observability',
  'third-party': 'Third-party', 'cicd-control-plane': 'CI/CD & control plane',
  'other': 'Other',
};

const LAYER_LABEL = {
  L0: 'L0 Guardrails', L1: 'L1 Recovery launch', L2: 'L2 Platform',
  L3: 'L3 Data & secrets', L4: 'L4 Applications', L5: 'L5 Edge',
  L6: 'L6 Success bar', L7: 'L7 Live cutover',
};

// Zoom bands: below these thresholds we drop detail rather than paint mush.
const Z_SUB_LABELS = 0.78;   // sub-labels vanish below this
const Z_EDGE_LABELS = 0.72;  // edge labels vanish below this
const Z_LABELS = 0.44;       // all text vanishes below this (icons only)
// Level of detail: below this, resource pills FOLD INTO their component, which
// then carries a "+N" badge. Measured: fit() clamps a 500+ node graph to
// z = 0.22–0.3, where a pill's 11.5px label renders at 2.5–3.5 CSS px — there
// is nothing to read there, only ink. LAYOUT.LOD_ZOOM.pills is the same number,
// used by the pure filter; this constant only decides when to re-run it.
const Z_PILLS = LAYOUT.LOD_ZOOM ? LAYOUT.LOD_ZOOM.pills : 0.5;

// Obstacle-aware routing is quadratic-ish; above these sizes we rely on
// hub-collapse and the filters instead (documented in the legend).
const ROUTE_OBSTACLE_MAX_NODES = 420;
const ROUTE_OBSTACLE_MAX_EDGES = 460;

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

const RTYPE_GLYPH = {
  'security-group': 'networking', 'nacl': 'networking', 'subnet': 'networking',
  'vpc': 'networking', 'route-table': 'networking', 'nat-gateway': 'networking',
  'internet-gateway': 'networking', 'vpc-endpoint': 'networking',
  'elastic-ip': 'networking', 'load-balancer': 'networking',
  'target-group': 'networking', 'listener': 'networking',
  'availability-zone': 'networking',
  'iam-role': 'identity-access', 'iam-policy': 'identity-access',
  'instance-profile': 'identity-access', 'oidc-provider': 'identity-access',
  'kms-key': 'security-secrets', 'secret': 'security-secrets',
  'certificate': 'security-secrets', 'bucket-policy': 'security-secrets',
  'queue-policy': 'security-secrets',
  'log-group': 'observability', 'alarm': 'observability',
  'sns-topic': 'messaging-streaming',
  'dns-record': 'edge-dns', 'hosted-zone': 'edge-dns',
  'db-subnet-group': 'database', 'parameter-group': 'database',
  'nodegroup': 'compute', 'addon': 'compute', 'launch-template': 'compute',
  'repository': 'compute',
};

function glyphCategoryFor(node) {
  if (node && node.rtype && RTYPE_GLYPH[node.rtype]) return RTYPE_GLYPH[node.rtype];
  const cat = (node && node.category) || 'other';
  return GLYPH_PATHS[cat] ? cat : 'other';
}

function glyphMarkup(category) {
  const cat = GLYPH_PATHS[category] ? category : 'other';
  const color = GLYPH_COLORS[cat] || '#8a94a6';
  return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPH_PATHS[cat]}</g>`;
}

// map.kinds[rtype] → map.kinds[kind] → map.awsServices[first] →
// map.categories[category] → map.default
export function resolveIcon(node, manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.map || !manifest.icons) return null;
  const m = manifest.map;
  const tryId = (id) => (id && manifest.icons[id] && manifest.icons[id].file ? manifest.icons[id] : null);
  return tryId(m.kinds && node.rtype ? m.kinds[node.rtype] : null)
    || tryId(m.kinds && node.kind ? m.kinds[node.kind] : null)
    || tryId(m.awsServices && Array.isArray(node.awsServices) && node.awsServices.length ? m.awsServices[node.awsServices[0]] : null)
    || tryId(m.categories && node.category ? m.categories[node.category] : null)
    || tryId(m.default);
}

// ---------------------------------------------------------------------------
// Text measurement
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
const SMALL_LABEL_FONT = `600 11.5px ${FONT_STACK}`;
const SMALL_SUB_FONT = `400 10px ${FONT_STACK}`;
const TEXT_MAX = NODE_W - 58 - 12;
const SMALL_TEXT_MAX = SMALL_W - 34 - 10;

const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Styles injected once
// ---------------------------------------------------------------------------

const STYLE_ID = 'dcv-styles';
const STYLES = `
.dcv-wrap { position: relative; width: 100%; min-height: 600px; background: ${DARK.bg};
  border-radius: 10px; overflow: hidden;
  --dcv-lbl: 12.5px; --dcv-sub: 11px; --dcv-elbl: 11px; --dcv-slbl: 11.5px; --dcv-ssub: 10px; }
.dcv-wrap svg.dcv-svg { display: block; width: 100%; height: 100%; position: absolute; inset: 0;
  touch-action: none; user-select: none; -webkit-user-select: none; }

/* ---- toolbar ---- */
.dcv-bar { position: absolute; top: 10px; left: 10px; right: 10px; z-index: 5;
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center; pointer-events: none; }
.dcv-bar > * { pointer-events: auto; }
.dcv-bar-spacer { flex: 1 1 auto; min-width: 8px; }
.dcv-btn { background: rgba(23,28,37,.94); color: #d7deea; border: 1px solid #2a3242; border-radius: 7px;
  padding: 4px 9px; font: 600 11.5px ${FONT_STACK}; cursor: pointer; white-space: nowrap;
  backdrop-filter: blur(6px); }
.dcv-btn:hover { border-color: #3a4557; color: #e6ebf2; }
.dcv-btn:disabled { opacity: .45; cursor: default; }
.dcv-btn.dcv-on { background: rgba(79,143,247,.2); border-color: rgba(79,143,247,.5); color: #a8c8fb; }
.dcv-search { background: rgba(23,28,37,.94); border: 1px solid #2a3242; border-radius: 7px;
  color: #e6ebf2; font: 12px ${FONT_STACK}; padding: 4px 8px; width: 148px; }
.dcv-search:focus { outline: none; border-color: rgba(79,143,247,.6); }
.dcv-search::placeholder { color: #6b7688; }
.dcv-count { font: 11.5px ${FONT_STACK}; color: #8a94a6; padding: 3px 7px;
  background: rgba(23,28,37,.9); border: 1px solid #232b39; border-radius: 6px; white-space: nowrap; }
.dcv-count b { color: #d7deea; font-weight: 650; }

/* ---- popovers (filters, legend) ---- */
.dcv-pop { position: absolute; z-index: 7; background: rgba(23,28,37,.985); border: 1px solid #2a3242;
  border-radius: 10px; padding: 12px 13px; box-shadow: 0 18px 48px rgba(0,0,0,.55);
  font: 12px ${FONT_STACK}; color: #e6ebf2; max-width: 330px; max-height: 68%; overflow-y: auto; }
.dcv-pop[hidden] { display: none; }
.dcv-pop-title { font: 700 10.5px ${FONT_STACK}; letter-spacing: .08em; text-transform: uppercase;
  color: #8a94a6; margin: 0 0 7px; }
.dcv-pop-title + .dcv-pop-title { margin-top: 13px; }
.dcv-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.dcv-chip { background: rgba(18,22,29,.9); border: 1px solid #2a3242; border-radius: 999px;
  color: #aeb8c7; font: 600 11px ${FONT_STACK}; padding: 2px 9px; cursor: pointer; white-space: nowrap; }
.dcv-chip:hover { border-color: #3a4557; color: #e6ebf2; }
.dcv-chip.dcv-on { background: rgba(79,143,247,.2); border-color: rgba(79,143,247,.5); color: #a8c8fb; }
.dcv-chip i { font-style: normal; opacity: .6; margin-left: 4px; font-size: 10px; }
.dcv-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
.dcv-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; }
.dcv-hint { color: #8a94a6; font-size: 11.5px; line-height: 1.5; margin: 6px 0 0; }
.dcv-pop hr { border: 0; border-top: 1px solid #252d3b; margin: 11px 0; }

/* ---- legend ---- */
.dcv-leg-item { display: flex; align-items: center; gap: 9px; margin: 6px 0; font-size: 11.8px; color: #c3ccda; }
.dcv-leg-swatch { flex: none; width: 34px; height: 18px; }
.dcv-leg-note { color: #8a94a6; font-size: 11px; margin-left: 43px; margin-top: -3px; }

/* ---- nodes / edges ---- */
.dcv-node { cursor: grab; }
.dcv-node.dcv-dragging { cursor: grabbing; }
.dcv-readonly .dcv-node { cursor: default; }
.dcv-node rect.dcv-card { transition: stroke .1s ease, filter .1s ease; }
.dcv-node:hover rect.dcv-card { stroke: #45536b; }
.dcv-node.dcv-selected rect.dcv-card { stroke: ${DARK.accent}; stroke-width: 2; }
.dcv-node.dcv-hot rect.dcv-card { stroke: ${DARK.accent}; stroke-width: 1.5; }
.dcv-node.dcv-hit rect.dcv-card { stroke: ${DARK.hub}; stroke-width: 2; }
.dcv-halo { display: none; }
.dcv-node.dcv-selected .dcv-halo { display: block; }
.dcv-dim { opacity: .2; }
.dcv-edge-hit { stroke: transparent; stroke-width: 12; fill: none; pointer-events: stroke; cursor: pointer; }
.dcv-edge.dcv-edge-hot path.dcv-edge-line { stroke: ${DARK.accent} !important; stroke-width: 2.4; opacity: 1 !important; }
.dcv-edge-label { pointer-events: none; }
.dcv-label { font-size: var(--dcv-lbl); }
.dcv-sub { font-size: var(--dcv-sub); }
.dcv-slabel { font-size: var(--dcv-slbl); }
.dcv-ssub { font-size: var(--dcv-ssub); }
text.dcv-edge-text { font-size: var(--dcv-elbl); }
.dcv-z-mid text.dcv-sub, .dcv-z-mid text.dcv-ssub { display: none; }
.dcv-z-mid text.dcv-label { transform: translateY(7px); }
.dcv-z-mid text.dcv-slabel { transform: translateY(6px); }
.dcv-z-far text.dcv-label, .dcv-z-far text.dcv-sub,
.dcv-z-far text.dcv-slabel, .dcv-z-far text.dcv-ssub { display: none; }
.dcv-empty-hint { fill: ${DARK.muted}; font: 13px ${FONT_STACK}; }
.dcv-grabbing, .dcv-grabbing * { cursor: grabbing !important; }
.dcv-expander { cursor: pointer; opacity: .5; transition: opacity .12s ease; }
.dcv-node:hover .dcv-expander { opacity: 1; }
.dcv-expander:hover circle { stroke: ${DARK.accent}; }
.dcv-grp-title { pointer-events: none; }
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
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      el.setAttribute(k, v);
    }
  }
  return el;
}
function hEl(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
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
    onNodeClick = null,
    onNodeHover = null,
    onSelect = null,
    onViewChange = null,
    nodeBadges = null,
    onExpandRequest = null,
    title = '',
    subtitle = '',
    toolbarExtras = null,
  } = opts;
  const expandableIds = Array.isArray(opts.expandableIds)
    ? new Set(opts.expandableIds.map(String)) : null;

  // --- normalize data ------------------------------------------------------
  const nodes = safeNodes(data);
  const nodeById = new Map(nodes.map((n) => [String(n.id), n]));
  const edges = safeEdges(data, new Set(nodeById.keys()));
  const groups = (Array.isArray(data.groups) ? data.groups : [])
    .filter((g) => g && Array.isArray(g.nodeIds) && g.nodeIds.some((id) => nodeById.has(String(id))));

  const sizeOfId = (id) => sizeOfNode(nodeById.get(String(id)));
  const baseEdgeKeys = new Set(edges.map(edgeKeyOf));

  // --- hub (shared infrastructure) detection -------------------------------
  const hubInfo = detectHubs({ nodes, edges });
  const hubIds = new Set(hubInfo.hubIds);
  const hubMembership = collapseHubEdges({ nodes, edges }, hubInfo.hubIds).membership;
  const hubAutoOn = shouldCollapseHubs({ nodes, edges }, hubInfo.hubIds);

  // --- view state ----------------------------------------------------------
  // Saved view state arrives from the host page (localStorage); everything is
  // additive and unknown keys are ignored by normalizeView.
  let view = normalizeView({
    hideSharedInfra: hubAutoOn,
    ...(opts.view && typeof opts.view === 'object' ? opts.view : {}),
  });
  let viewResult = null;

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
  let layoutOut = computeLayoutFull(template, { nodes, edges });
  let base = layoutOut.positions;
  let waypoints = layoutOut.waypoints || {};
  const custom = {};          // user-moved / injected-node positions
  const savedPositions = {};  // raw opts.positions incl. not-yet-injected ids
  if (opts.positions && typeof opts.positions === 'object') {
    for (const [k, v] of Object.entries(opts.positions)) {
      if (!v) continue;
      const x = num(v.x), y = num(v.y);
      if (x === null || y === null) continue;
      savedPositions[String(k)] = { x: snap(x), y: snap(y) };
      if (nodeById.has(String(k))) custom[String(k)] = { x: snap(x), y: snap(y) };
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
    <pattern id="dcv-grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.9" fill="${DARK.grid}"/>
    </pattern>
    <marker id="dcv-arrow-dep" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L8,4 L0,8 Z" fill="${DARK.edge}"/>
    </marker>
    <marker id="dcv-arrow-out" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L8,4 L0,8 Z" fill="${DARK.accent}"/>
    </marker>
    <marker id="dcv-arrow-rel" markerWidth="8" markerHeight="7" refX="7" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="${DARK.relation}"/>
    </marker>`;
  svg.appendChild(defs);

  const gridRect = svgEl('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'url(#dcv-grid)' });
  const viewport = svgEl('g');
  viewport.appendChild(gridRect);
  const gGroups = svgEl('g'), gEdges = svgEl('g'), gLabels = svgEl('g'), gNodes = svgEl('g');
  viewport.append(gGroups, gEdges, gLabels, gNodes);
  svg.appendChild(viewport);

  // --- view transform (pan/zoom) --------------------------------------------
  const vt = { x: 0, y: 0, z: 1 };
  const applyView2 = () => {
    viewport.setAttribute('transform', `translate(${vt.x},${vt.y}) scale(${vt.z})`);
    applyZoomTypography();
  };
  const toWorld = (sx, sy) => {
    const r = svg.getBoundingClientRect();
    return { x: (sx - r.left - vt.x) / vt.z, y: (sy - r.top - vt.y) / vt.z };
  };

  // Keep type legible when zoomed out: counter-scale modestly, then drop
  // sub-labels, then drop text entirely rather than painting grey mush.
  function applyZoomTypography() {
    const z = vt.z;
    const cs = (base2, floorPx) => `${Math.min(base2 * 1.85, Math.max(base2, floorPx / Math.max(0.05, z))).toFixed(2)}px`;
    wrap.style.setProperty('--dcv-lbl', cs(12.5, 10.5));
    wrap.style.setProperty('--dcv-sub', cs(11, 9.5));
    wrap.style.setProperty('--dcv-slbl', cs(11.5, 10));
    wrap.style.setProperty('--dcv-ssub', cs(10, 9));
    wrap.style.setProperty('--dcv-elbl', cs(11, 9.5));
    wrap.classList.toggle('dcv-z-mid', z < Z_SUB_LABELS && z >= Z_LABELS);
    wrap.classList.toggle('dcv-z-far', z < Z_LABELS);
    const wantEdgeLabels = z >= Z_EDGE_LABELS;
    if (wantEdgeLabels !== edgeLabelsAllowed) {
      edgeLabelsAllowed = wantEdgeLabels;
      refreshEdgeLabels();
    }
    // Crossing the level-of-detail threshold changes WHICH nodes are drawn, not
    // just how they are typeset, so it re-runs the visibility pass — once per
    // crossing, never per wheel event.
    if (zoomBand(z) !== lodBand) applyVisibility();
  }
  let edgeLabelsAllowed = true;
  // Which side of the pill-folding threshold we are on. Recomputed in
  // applyVisibility so the two can never disagree. `forceFullDetail` is the
  // export path: a downloaded file is never level-of-detail'd.
  const zoomBand = (z) => (view.lod === 'off' || z >= Z_PILLS ? 'detail' : 'folded');
  let lodBand = 'detail';
  let forceFullDetail = false;

  function fit() {
    const pos = visiblePositions();
    const b = contentBounds(pos, visibleGroups(), sizeOfId, GROUP_OPTS);
    const r = svg.getBoundingClientRect();
    const W = r.width || wrap.clientWidth || 900;
    const H = r.height || wrap.clientHeight || 600;
    if (!Object.keys(pos).length || b.w <= 0 || b.h <= 0) { vt.x = 0; vt.y = 0; vt.z = 1; applyView2(); return; }
    const PAD = 56;
    let z = Math.min((W - PAD) / b.w, (H - PAD) / b.h);
    z = Math.max(0.22, Math.min(1.3, z));
    vt.z = z;
    vt.x = (W - b.w * z) / 2 - b.x * z;
    vt.y = (H - b.h * z) / 2 - b.y * z;
    applyView2();
  }

  // --- render: groups --------------------------------------------------------
  const GROUP_OPTS = { pad: 18, titleBand: 26 };
  const groupEls = new Map();
  for (const g of groups) {
    const rect = svgEl('rect', { rx: 13, fill: DARK.groupFill, stroke: DARK.groupStroke, 'stroke-width': 1 });
    // A title plate keeps the group name readable wherever it lands.
    const plate = svgEl('rect', { rx: 5, fill: DARK.bg, stroke: DARK.groupStroke, 'stroke-width': 1, opacity: 0.96 });
    const label = svgEl('text', {
      class: 'dcv-grp-title', fill: '#9aa5b5', 'font-family': FONT_STACK, 'font-size': 10,
      'font-weight': 700, 'letter-spacing': '0.08em',
    });
    label.textContent = String(g.label || g.id || '').toUpperCase();
    const gg = svgEl('g');
    gg.append(rect, plate, label);
    gGroups.appendChild(gg);
    groupEls.set(g, { rect, plate, label, gg });
  }
  function visibleGroups() {
    if (!viewResult) return groups;
    return groups.filter((g) => g.nodeIds.some((id) => viewResult.visibleNodeIds.has(String(id))));
  }
  function refreshGroups() {
    const pos = visiblePositions();
    for (const [g, els] of groupEls) {
      const memberIds = g.nodeIds.filter((id) => pos[String(id)]);
      const b = memberIds.length ? groupBounds({ nodeIds: memberIds }, pos, sizeOfId, GROUP_OPTS) : null;
      if (!b) { els.gg.setAttribute('display', 'none'); continue; }
      els.gg.removeAttribute('display');
      els.rect.setAttribute('x', b.x); els.rect.setAttribute('y', b.y);
      els.rect.setAttribute('width', b.w); els.rect.setAttribute('height', b.h);
      const text = String(g.label || g.id || '').toUpperCase();
      const tw = textWidth(text, `700 10px ${FONT_STACK}`) + 16;
      els.plate.setAttribute('x', b.x + 10);
      els.plate.setAttribute('y', b.y + 5);
      els.plate.setAttribute('width', Math.min(tw, Math.max(40, b.w - 20)));
      els.plate.setAttribute('height', 17);
      els.label.setAttribute('x', b.x + 18);
      els.label.setAttribute('y', b.y + 17);
    }
  }

  // --- render: edges ----------------------------------------------------------
  const edgeRecs = new Set();
  const edgesByNode = new Map();
  const edgeByKey = new Map();
  let bundles = groupParallelEdges(edges);
  const nodeEls = new Map();

  function addEdgeRec(e, { injected = false } = {}) {
    const isOut = e.kind === 'outbound';
    const nFrom = nodeById.get(e.from), nTo = nodeById.get(e.to);
    const bothSmall = !!(nFrom && nFrom.small) && !!(nTo && nTo.small);
    const key = edgeKeyOf(e);
    const stroke = isOut ? DARK.accent : (bothSmall ? DARK.relation : DARK.edge);
    const line = svgEl('path', {
      class: 'dcv-edge-line', fill: 'none',
      stroke,
      'stroke-width': bothSmall ? 1 : 1.5,
      'stroke-linecap': 'round',
      'stroke-dasharray': isOut ? '6 5' : null,
      'marker-end': `url(#${isOut ? 'dcv-arrow-out' : (bothSmall ? 'dcv-arrow-rel' : 'dcv-arrow-dep')})`,
      opacity: isOut ? 0.72 : (bothSmall ? 0.62 : 0.85),
    });
    const hit = svgEl('path', { class: 'dcv-edge-hit' });
    const gE = svgEl('g', { class: 'dcv-edge' });
    gE.append(line, hit);
    gEdges.appendChild(gE);

    let labelEl = null, labelBg = null;
    if (e.label) {
      labelBg = svgEl('rect', { rx: 4, fill: DARK.labelBg, opacity: 0.9, class: 'dcv-edge-label' });
      labelEl = svgEl('text', {
        class: 'dcv-edge-label dcv-edge-text', fill: '#95a0b1', 'font-family': FONT_STACK,
        'text-anchor': 'middle',
      });
      labelEl.textContent = e.label;
      gLabels.append(labelBg, labelEl);
    }
    const rec = {
      e, key, gE, line, hit, labelEl, labelBg, bothSmall,
      injected,
      bundle: bundles.get(key) || { index: 0, count: 1, reversed: false, bidi: false },
      hidden: false, labelShown: false, mid: { x: 0, y: 0 },
      removed: false,
    };
    edgeRecs.add(rec);
    edgeByKey.set(key, rec);
    for (const id of [e.from, e.to]) {
      if (!edgesByNode.has(id)) edgesByNode.set(id, new Set());
      edgesByNode.get(id).add(rec);
    }

    hit.addEventListener('pointerenter', () => {
      gE.classList.add('dcv-edge-hot');
      nodeEls.get(e.from)?.g.classList.add('dcv-hot');
      nodeEls.get(e.to)?.g.classList.add('dcv-hot');
      if (rec.labelEl && !rec.labelShown) showEdgeLabel(rec, true);
    });
    hit.addEventListener('pointerleave', () => {
      gE.classList.remove('dcv-edge-hot');
      nodeEls.get(e.from)?.g.classList.remove('dcv-hot');
      nodeEls.get(e.to)?.g.classList.remove('dcv-hot');
      if (rec.labelEl && !rec.labelShown) showEdgeLabel(rec, false);
    });
    return rec;
  }

  function removeEdgeRec(rec) {
    if (!rec || rec.removed) return;
    rec.removed = true;
    rec.gE.remove();
    rec.labelEl?.remove();
    rec.labelBg?.remove();
    edgeRecs.delete(rec);
    edgeByKey.delete(rec.key);
    for (const id of [rec.e.from, rec.e.to]) edgesByNode.get(id)?.delete(rec);
  }

  for (const e of edges) addEdgeRec(e);

  // --- edge routing ----------------------------------------------------------
  // Obstacle set is rebuilt lazily (positions change on drag / re-layout) and
  // bucketed into a coarse grid so a route only tests nearby boxes.
  let obstacleGrid = null;
  const OB_CELL = 320;
  function invalidateObstacles() { obstacleGrid = null; }
  function obstacleRouting() {
    return nodeById.size <= ROUTE_OBSTACLE_MAX_NODES && edgeRecs.size <= ROUTE_OBSTACLE_MAX_EDGES;
  }
  function buildObstacles() {
    const cells = new Map();
    const pos = visiblePositions();
    for (const [id, p] of Object.entries(pos)) {
      const s = sizeOfId(id);
      const rect = { x: p.x, y: p.y, w: s.w, h: s.h, id };
      const x0 = Math.floor(rect.x / OB_CELL), x1 = Math.floor((rect.x + rect.w) / OB_CELL);
      const y0 = Math.floor(rect.y / OB_CELL), y1 = Math.floor((rect.y + rect.h) / OB_CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = `${cx},${cy}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(rect);
        }
      }
    }
    obstacleGrid = cells;
  }
  function obstaclesFor(rec) {
    if (!obstacleRouting()) return [];
    if (!obstacleGrid) buildObstacles();
    const p1 = posOf(rec.e.from), p2 = posOf(rec.e.to);
    const s1 = sizeOfId(rec.e.from), s2 = sizeOfId(rec.e.to);
    const minX = Math.min(p1.x, p2.x) - 40, maxX = Math.max(p1.x + s1.w, p2.x + s2.w) + 40;
    const minY = Math.min(p1.y, p2.y) - 120, maxY = Math.max(p1.y + s1.h, p2.y + s2.h) + 120;
    const out = [];
    const seen = new Set();
    for (let cx = Math.floor(minX / OB_CELL); cx <= Math.floor(maxX / OB_CELL); cx++) {
      for (let cy = Math.floor(minY / OB_CELL); cy <= Math.floor(maxY / OB_CELL); cy++) {
        for (const r of obstacleGrid.get(`${cx},${cy}`) || []) {
          if (r.id === rec.e.from || r.id === rec.e.to || seen.has(r.id)) continue;
          seen.add(r.id);
          out.push({ x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 12 });
        }
      }
    }
    return out;
  }

  function routeOne(rec) {
    const p1 = posOf(rec.e.from), p2 = posOf(rec.e.to);
    const wp = (!custom[rec.e.from] && !custom[rec.e.to]) ? waypoints[rec.key] : null;
    const { path, mid } = routeEdge({
      p1, s1: sizeOfId(rec.e.from), p2, s2: sizeOfId(rec.e.to),
      bundle: rec.bundle,
      waypoints: wp || null,
      obstacles: obstaclesFor(rec),
    });
    rec.line.setAttribute('d', path);
    rec.hit.setAttribute('d', path);
    rec.mid = mid;
    if (rec.labelEl) placeEdgeLabel(rec);
  }
  function placeEdgeLabel(rec) {
    const { mid } = rec;
    rec.labelEl.setAttribute('x', mid.x);
    rec.labelEl.setAttribute('y', mid.y - 4);
    const w = textWidth(rec.e.label, `11px ${FONT_STACK}`) + 10;
    rec.labelBg.setAttribute('x', mid.x - w / 2);
    rec.labelBg.setAttribute('y', mid.y - 16);
    rec.labelBg.setAttribute('width', w);
    rec.labelBg.setAttribute('height', 16);
  }
  function showEdgeLabel(rec, on) {
    if (!rec.labelEl) return;
    if (on) { rec.labelEl.removeAttribute('display'); rec.labelBg.removeAttribute('display'); }
    else { rec.labelEl.setAttribute('display', 'none'); rec.labelBg.setAttribute('display', 'none'); }
  }
  function routeEdgesFor(nodeId) {
    for (const rec of edgesByNode.get(nodeId) || []) if (!rec.hidden) routeOne(rec);
  }
  function routeAllEdges() {
    for (const rec of edgeRecs) if (!rec.hidden) routeOne(rec);
  }

  // Which edge labels can be shown at once, without plates colliding.
  function refreshEdgeLabels() {
    const cands = [];
    for (const rec of edgeRecs) {
      rec.labelShown = false;
      if (!rec.labelEl) continue;
      if (rec.hidden || !edgeLabelsAllowed) { showEdgeLabel(rec, false); continue; }
      cands.push({ key: rec.key, label: rec.e.label, kind: rec.e.kind, mid: rec.mid });
    }
    if (!edgeLabelsAllowed) return;
    const shown = selectEdgeLabels(cands, { maxLabels: 48 });
    for (const rec of edgeRecs) {
      if (!rec.labelEl || rec.hidden) continue;
      rec.labelShown = shown.has(rec.key);
      showEdgeLabel(rec, rec.labelShown);
    }
  }

  // --- render: nodes -----------------------------------------------------------
  const expanderAllowed = (id) => typeof onExpandRequest === 'function'
    && !nodeById.get(id)?.small
    && (!expandableIds || expandableIds.has(id));

  function setExpanderState(id, expanded) {
    const rec = nodeEls.get(id);
    if (!rec || !rec.expanderText) return;
    rec.expanderText.textContent = expanded ? '−' : '+';
    rec.expanderTitle.textContent = expanded ? 'Collapse resources' : 'Expand resources';
  }

  function renderNode(n) {
    const id = String(n.id);
    const small = !!n.small;
    const { w: W, h: H } = sizeOfNode(n);
    const isThird = !small && n.category === 'third-party';
    const isTier0 = !small && num(n.tier) === 0;
    const isHub = hubIds.has(id);
    const g = svgEl('g', { class: 'dcv-node', 'data-id': id });

    // selection halo (hidden until selected)
    g.appendChild(svgEl('rect', {
      class: 'dcv-halo', x: -4, y: -4, width: W + 8, height: H + 8, rx: small ? 11 : 13,
      fill: 'none', stroke: DARK.accent, 'stroke-width': 1, opacity: 0.35,
    }));

    const card = svgEl('rect', {
      class: 'dcv-card', width: W, height: H, rx: small ? 8 : 10,
      fill: DARK.card, stroke: isHub ? DARK.hub : DARK.cardBorder, 'stroke-width': isHub ? 1.5 : 1,
      'fill-opacity': small ? 0.55 : null,
      'stroke-opacity': small ? 0.6 : null,
      'stroke-dasharray': isThird ? '5 4' : null,
    });
    g.appendChild(card);
    if (isTier0) {
      g.appendChild(svgEl('path', {
        d: `M 1.5 12 L 1.5 ${H - 12}`,
        stroke: DARK.tier0, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.9,
      }));
    }

    // icon — manifest image with glyph fallback (36px full card, 20px pill)
    const iconSize = small ? 20 : 36;
    const iconHolder = svgEl('g', { transform: small ? 'translate(8,10)' : 'translate(12,14)' });
    const icon = manifest ? resolveIcon(n, manifest) : null;
    const useGlyph = () => {
      const markup = glyphMarkup(glyphCategoryFor(n));
      iconHolder.innerHTML = small ? `<g transform="scale(${(iconSize / 36).toFixed(4)})">${markup}</g>` : markup;
    };
    if (icon) {
      const img = svgEl('image', { width: iconSize, height: iconSize, href: `/assets/icons/${icon.file}` });
      img.addEventListener('error', useGlyph, { once: true });
      iconHolder.appendChild(img);
      n._iconFile = icon.file;
    } else {
      useGlyph();
    }
    g.appendChild(iconHolder);

    if (small) {
      n._dispLabel = ellipsize(n.label ?? id, SMALL_LABEL_FONT, SMALL_TEXT_MAX);
      const labelEl = svgEl('text', {
        class: 'dcv-slabel', x: 34, y: 17, fill: DARK.text,
        'font-family': FONT_STACK, 'font-weight': 600,
      });
      labelEl.textContent = n._dispLabel;
      g.appendChild(labelEl);
      const rt = n.rtype || n.sub || '';
      if (rt) {
        n._dispSub = ellipsize(rt, SMALL_SUB_FONT, SMALL_TEXT_MAX);
        const subEl = svgEl('text', { class: 'dcv-ssub', x: 34, y: 30, fill: DARK.muted, 'font-family': FONT_STACK });
        subEl.textContent = n._dispSub;
        g.appendChild(subEl);
      }
    } else {
      const sharedCount = isHub ? (hubMembership[id] || []).length : 0;
      const subText = isHub && sharedCount
        ? `shared by ${sharedCount}${n.sub ? ` · ${n.sub}` : ''}`
        : (n.sub || '');
      const hasSub = !!subText;
      n._dispLabel = ellipsize(n.label ?? id, LABEL_FONT, TEXT_MAX);
      const labelEl = svgEl('text', {
        class: 'dcv-label', x: 58, y: hasSub ? 29 : 37, fill: DARK.text,
        'font-family': FONT_STACK, 'font-weight': 600,
      });
      labelEl.textContent = n._dispLabel;
      g.appendChild(labelEl);
      if (hasSub) {
        n._dispSub = ellipsize(subText, SUB_FONT, TEXT_MAX);
        const subEl = svgEl('text', {
          class: 'dcv-sub', x: 58, y: 45,
          fill: isHub && sharedCount ? DARK.hub : DARK.muted, 'font-family': FONT_STACK,
        });
        subEl.textContent = n._dispSub;
        g.appendChild(subEl);
      }
    }
    const tip = svgEl('title');
    tip.textContent = `${n.label ?? id}${n.sub ? ` — ${n.sub}` : ''}`;
    g.appendChild(tip);

    const rec = { n, g, card, expanderText: null, expanderTitle: null, rollup: null, rollupText: null };

    // Level-of-detail badge: when this node's resource pills are folded away
    // (zoomed out), it says how many it is standing in for. Hidden otherwise.
    if (!small) {
      const roll = svgEl('g', { class: 'dcv-rollup', transform: `translate(${W - 13},13)`, display: 'none' });
      const rc = svgEl('rect', { x: -16, y: -9, width: 32, height: 18, rx: 9, fill: DARK.card, stroke: DARK.hub, 'stroke-width': 1 });
      const rt2 = svgEl('text', {
        y: 4, 'text-anchor': 'middle', fill: DARK.hub,
        'font-family': FONT_STACK, 'font-size': 10.5, 'font-weight': 700,
      });
      const rTitle = svgEl('title');
      rTitle.textContent = 'Resources folded in at this zoom — zoom in to see them';
      roll.append(rc, rt2, rTitle);
      g.appendChild(roll);
      rec.rollup = roll;
      rec.rollupText = rt2;
    }

    if (expanderAllowed(id)) {
      const exp = svgEl('g', { class: 'dcv-expander', transform: `translate(${W - 1},${H / 2})` });
      const circle = svgEl('circle', { r: 9, fill: DARK.card, stroke: DARK.cardBorder, 'stroke-width': 1.2 });
      const txt = svgEl('text', {
        y: 4, 'text-anchor': 'middle', fill: DARK.accent,
        'font-family': FONT_STACK, 'font-size': 13, 'font-weight': 700,
      });
      txt.textContent = '+';
      const expTitle = svgEl('title');
      expTitle.textContent = 'Expand resources';
      exp.append(circle, txt, expTitle);
      exp.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); });
      exp.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTip();
        try {
          if (controller.isExpanded(id)) controller.collapseNode(id);
          else onExpandRequest(n);
        } catch (err) { console.error('[diagram-canvas] expand affordance failed', err); }
      });
      g.appendChild(exp);
      rec.expanderText = txt;
      rec.expanderTitle = expTitle;
    }

    gNodes.appendChild(g);
    nodeEls.set(id, rec);
    return rec;
  }

  for (const n of nodes) renderNode(n);

  function placeNode(id) {
    const p = posOf(id);
    nodeEls.get(id)?.g.setAttribute('transform', `translate(${p.x},${p.y})`);
  }
  function placeAll() {
    for (const id of nodeEls.keys()) placeNode(id);
    invalidateObstacles();
    routeAllEdges();
    refreshEdgeLabels();
    refreshGroups();
  }

  // empty state
  if (!nodes.length) {
    const hint = svgEl('text', { class: 'dcv-empty-hint', x: '50%', y: '50%', 'text-anchor': 'middle' });
    hint.textContent = 'Nothing to draw yet — add components in Inventory and they will appear here.';
    svg.appendChild(hint);
  }

  // --- visibility (filters / focus / declutter) -------------------------------
  function visiblePositions() {
    const out = {};
    for (const id of nodeById.keys()) {
      if (viewResult && !viewResult.visibleNodeIds.has(id)) continue;
      const p = posOf(id);
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function currentGraph() {
    // Base graph plus whatever expansion injected — filters apply to both.
    return { nodes: [...nodeById.values()], edges: [...edgeRecs].map((r) => r.e) };
  }

  function applyVisibility({ refit = false } = {}) {
    // The current zoom is part of the view: below LOD_ZOOM.pills the pure
    // filter folds resource pills into their component (see lodPlan), and the
    // component grows a "+N" badge saying what it is standing in for.
    viewResult = applyView(currentGraph(), view, {
      hubIds: [...hubIds],
      zoom: forceFullDetail ? 1 : vt.z,
    });
    lodBand = forceFullDetail ? 'detail' : zoomBand(vt.z);
    const rollup = viewResult.rollup instanceof Map ? viewResult.rollup : new Map();
    for (const [id, rec] of nodeEls) {
      const show = viewResult.visibleNodeIds.has(id);
      if (show) rec.g.removeAttribute('display'); else rec.g.setAttribute('display', 'none');
      if (rec.rollup) {
        const n = rollup.get(id) || 0;
        if (n && show) {
          rec.rollupText.textContent = `+${n}`;
          rec.rollup.removeAttribute('display');
        } else {
          rec.rollup.setAttribute('display', 'none');
        }
      }
      // search highlight
      rec.g.classList.toggle('dcv-hit', !!view.search.trim() && show
        && LAYOUT.matchesSearch(rec.n, view.search));
    }
    for (const rec of edgeRecs) {
      const show = viewResult.visibleEdgeKeys.has(rec.key);
      rec.hidden = !show;
      if (show) rec.gE.removeAttribute('display'); else rec.gE.setAttribute('display', 'none');
    }
    invalidateObstacles();
    routeAllEdges();
    refreshEdgeLabels();
    refreshGroups();
    updateCounts();
    setFocusDim(selectedId);
    if (refit) fit();
  }

  // --- toolbar ---------------------------------------------------------------
  const bar = hEl('div', { class: 'dcv-bar' });
  wrap.appendChild(bar);

  const searchInput = hEl('input', {
    class: 'dcv-search', type: 'search', placeholder: 'Find a node…',
    title: 'Find nodes by name, kind or category — Enter centers the first match',
  });
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      view = normalizeView({ ...view, search: searchInput.value });
      applyVisibility();
      emitView();
    }, 160);
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    centerFirstMatch();
  });

  const filterBtn = hEl('button', { class: 'dcv-btn', type: 'button', title: 'Filter by category, tier and restore layer' }, 'Filter');
  const declutterBtn = hEl('button', { class: 'dcv-btn', type: 'button', title: 'Hide the noisiest parts of the picture' }, 'Declutter');
  const focusBtn = hEl('button', { class: 'dcv-btn', type: 'button', title: 'Isolate the selected node’s neighborhood' }, 'Focus');
  const legendBtn = hEl('button', { class: 'dcv-btn', type: 'button', title: 'What the shapes, colors and lines mean' }, 'Legend');
  const fitBtn = hEl('button', { class: 'dcv-btn', type: 'button', title: 'Fit diagram to view' }, 'Fit');
  const resetViewBtn = hEl('button', { class: 'dcv-btn', type: 'button', title: 'Clear all filters, focus and search' }, 'Show all');
  const countsEl = hEl('span', { class: 'dcv-count' });

  bar.append(searchInput, filterBtn, declutterBtn, focusBtn, countsEl,
    hEl('div', { class: 'dcv-bar-spacer' }), resetViewBtn, legendBtn, fitBtn);

  // AI (or other host) actions — appended last so they read as extras.
  if (typeof toolbarExtras === 'function') {
    try {
      const extras = toolbarExtras(() => controller) || [];
      for (const node of (Array.isArray(extras) ? extras : [extras])) {
        if (node && node.nodeType) bar.appendChild(node);
      }
    } catch (err) { console.error('[diagram-canvas] toolbarExtras failed', err); }
  }

  function updateCounts() {
    const c = viewResult ? viewResult.counts : { nodesVisible: nodeById.size, nodesTotal: nodeById.size, edgesVisible: edgeRecs.size, edgesTotal: edgeRecs.size };
    const rolled = c.nodesRolledUp || 0;
    const hiddenN = c.nodesTotal - c.nodesVisible - rolled;
    const hiddenE = c.edgesTotal - c.edgesVisible;
    countsEl.innerHTML = `<b>${c.nodesVisible}</b> nodes · <b>${c.edgesVisible}</b> links`
      + (rolled ? ` <span style="opacity:.85" title="Resource pills folded into their component at this zoom — zoom in to unfold">(${rolled} folded in)</span>` : '')
      + (hiddenN > 0 || hiddenE ? ` <span style="opacity:.75">(${Math.max(0, hiddenN)} / ${hiddenE} hidden)</span>` : '');
    const active = !!(view.categories || view.tiers || view.layers || view.focusId
      || view.hideOutbound || view.hideSharedInfra || view.hidePills || view.search.trim());
    resetViewBtn.classList.toggle('dcv-on', active);
    filterBtn.classList.toggle('dcv-on', !!(view.categories || view.tiers || view.layers));
    declutterBtn.classList.toggle('dcv-on', !!(view.hideOutbound || view.hideSharedInfra || view.hidePills));
    focusBtn.classList.toggle('dcv-on', !!view.focusId);
  }

  // popover plumbing: one open at a time, dismissed on outside click / Esc
  const pops = [];
  function makePop(anchorBtn, build) {
    const pop = hEl('div', { class: 'dcv-pop' });
    pop.hidden = true;
    wrap.appendChild(pop);
    const rec = { pop, anchorBtn, build, built: false };
    pops.push(rec);
    anchorBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasOpen = !pop.hidden;
      for (const p of pops) p.pop.hidden = true;
      if (wasOpen) return;
      pop.textContent = '';
      build(pop);
      pop.hidden = false;
      // position under the button, clamped to the wrap
      const wr = wrap.getBoundingClientRect();
      const br = anchorBtn.getBoundingClientRect();
      pop.style.top = `${br.bottom - wr.top + 6}px`;
      const w = pop.offsetWidth || 300;
      let left = br.left - wr.left;
      if (left + w > wr.width - 10) left = Math.max(10, wr.width - w - 10);
      pop.style.left = `${left}px`;
    });
    return rec;
  }
  wrap.addEventListener('pointerdown', (ev) => {
    if (pops.every((p) => p.pop.hidden)) return;
    if (ev.target.closest && (ev.target.closest('.dcv-pop') || ev.target.closest('.dcv-btn'))) return;
    for (const p of pops) p.pop.hidden = true;
  });

  function chipRow(items, selected, onToggle, labelFor) {
    const box = hEl('div', { class: 'dcv-chips' });
    for (const it of items) {
      const on = selected ? selected.includes(it.key) : false;
      const chip = hEl('button', { class: 'dcv-chip' + (on ? ' dcv-on' : ''), type: 'button' },
        labelFor ? labelFor(it.key) : it.key, hEl('i', null, it.count));
      chip.addEventListener('click', () => { onToggle(it.key); });
      box.appendChild(chip);
    }
    return box;
  }

  function toggleIn(list, key, all) {
    const cur = list ? list.slice() : all.slice();
    const i = cur.indexOf(key);
    if (i === -1) cur.push(key); else cur.splice(i, 1);
    // all selected (or none) == no filter
    if (!cur.length || cur.length === all.length) return null;
    return cur;
  }

  makePop(filterBtn, (pop) => {
    const facets = (viewResult || applyView(currentGraph(), view, { hubIds: [...hubIds] })).facets;
    const catKeys = facets.categories.map((c) => c.key);
    const tierKeys = facets.tiers.map((c) => c.key);
    const layerKeys = facets.layers.map((c) => c.key);
    pop.append(
      hEl('p', { class: 'dcv-pop-title' }, 'Category'),
      chipRow(facets.categories, view.categories, (k) => {
        view = normalizeView({ ...view, categories: toggleIn(view.categories, k, catKeys) });
        applyVisibility(); emitView(); refreshOpenPop(filterBtn);
      }, (k) => CATEGORY_LABEL[k] || k),
      hEl('p', { class: 'dcv-pop-title' }, 'Tier'),
      chipRow(facets.tiers, view.tiers, (k) => {
        view = normalizeView({ ...view, tiers: toggleIn(view.tiers, k, tierKeys) });
        applyVisibility(); emitView(); refreshOpenPop(filterBtn);
      }, (k) => (k === 'none' ? 'no tier' : `tier ${k}`)),
      hEl('p', { class: 'dcv-pop-title' }, 'Restore layer'),
      chipRow(facets.layers, view.layers, (k) => {
        view = normalizeView({ ...view, layers: toggleIn(view.layers, k, layerKeys) });
        applyVisibility(); emitView(); refreshOpenPop(filterBtn);
      }, (k) => (k === 'none' ? 'unmapped' : (LAYER_LABEL[k] || k))),
      hEl('p', { class: 'dcv-hint' }, 'Chips are additive — selecting none (or all) means “no filter”. Resource pills always follow their component.'),
    );
  });

  makePop(declutterBtn, (pop) => {
    const mk = (labelText, key, hint) => {
      const cb = hEl('input', { type: 'checkbox' });
      cb.checked = !!view[key];
      cb.addEventListener('change', () => {
        view = normalizeView({ ...view, [key]: cb.checked });
        applyVisibility(); emitView();
      });
      return hEl('div', null,
        hEl('div', { class: 'dcv-row' }, hEl('label', null, cb, labelText)),
        hint ? hEl('p', { class: 'dcv-hint', style: 'margin:-2px 0 6px 22px' }, hint) : null);
    };
    pop.append(
      hEl('p', { class: 'dcv-pop-title' }, 'Declutter'),
      mk('Hide outbound-call edges', 'hideOutbound', 'The dashed blue arrows to third-party / external targets.'),
      mk('Hide shared-infrastructure edges', 'hideSharedInfra',
        hubIds.size
          ? `${hubIds.size} shared node${hubIds.size === 1 ? '' : 's'} (degree ≥ ${hubInfo.threshold}) — e.g. a shared VPC, IAM role or KMS key. Their members are shown by the amber “shared by N” label instead of N lines.`
          : 'No shared-infrastructure hubs detected in this diagram.'),
      mk('Hide small resource pills', 'hidePills', 'The compact discovered-resource nodes injected by ⊕ expansion and resource maps.'),
      hEl('hr'),
      hEl('p', { class: 'dcv-pop-title' }, 'Level of detail'),
      (() => {
        const cb = hEl('input', { type: 'checkbox' });
        cb.checked = view.lod !== 'off';
        cb.addEventListener('change', () => {
          view = normalizeView({ ...view, lod: cb.checked ? 'auto' : 'off' });
          applyVisibility(); emitView();
        });
        return hEl('div', null,
          hEl('div', { class: 'dcv-row' }, hEl('label', null, cb, 'Fold resource pills when zoomed out')),
          hEl('p', { class: 'dcv-hint', style: 'margin:-2px 0 6px 22px' },
            `Below ${Math.round(Z_PILLS * 100)}% zoom a pill's label is smaller than 4px — unreadable. Instead of painting `
            + 'that, each pill folds into its component, which shows a “+N” badge. Zoom past the threshold and they come back. '
            + 'Nothing is filtered out: this is the same graph at the detail the zoom can carry.'),
          hEl('p', { class: 'dcv-hint', style: 'margin:-2px 0 6px 22px' },
            viewResult && viewResult.lod && viewResult.lod.rolledUp
              ? `${viewResult.lod.rolledUp} pill${viewResult.lod.rolledUp === 1 ? '' : 's'} folded in right now (zoom ${Math.round(vt.z * 100)}%).`
              : `Currently at ${Math.round(vt.z * 100)}% zoom — nothing is folded.`));
      })(),
      hEl('hr'),
      hEl('p', { class: 'dcv-hint' }, hubAutoOn
        ? 'Shared-infrastructure edges start hidden on this diagram because it is dense enough that they would dominate the picture.'
        : 'This diagram is small enough that every edge is drawn by default.'),
    );
  });

  makePop(focusBtn, (pop) => {
    const sel = selectedId ? nodeById.get(selectedId) : null;
    const hops = view.focusHops;
    const hopRow = hEl('div', { class: 'dcv-chips' });
    for (const h of [1, 2, 3]) {
      const chip = hEl('button', { class: 'dcv-chip' + (hops === h ? ' dcv-on' : ''), type: 'button' }, `${h} hop${h === 1 ? '' : 's'}`);
      chip.addEventListener('click', () => {
        view = normalizeView({ ...view, focusHops: h });
        if (view.focusId) { applyVisibility({ refit: true }); }
        emitView();
        refreshOpenPop(focusBtn);
      });
      hopRow.appendChild(chip);
    }
    const onBtn = hEl('button', { class: 'dcv-btn' + (view.focusId ? ' dcv-on' : ''), type: 'button' },
      view.focusId ? 'Focus is on — clear' : (sel ? `Isolate “${sel.label || selectedId}”` : 'Select a node first'));
    onBtn.disabled = !view.focusId && !sel;
    onBtn.addEventListener('click', () => {
      if (view.focusId) view = normalizeView({ ...view, focusId: null });
      else if (selectedId) view = normalizeView({ ...view, focusId: selectedId });
      applyVisibility({ refit: true });
      emitView();
      refreshOpenPop(focusBtn);
    });
    let factsBox = null;
    if (selectedId) {
      const f = dependencyFacts(currentGraph(), selectedId);
      const nameOf = (id) => nodeById.get(id)?.label || id;
      const list = (arr) => (arr.length
        ? arr.slice(0, 6).map(nameOf).join(', ') + (arr.length > 6 ? ` +${arr.length - 6} more` : '')
        : 'none');
      factsBox = hEl('div', null,
        hEl('p', { class: 'dcv-pop-title' }, 'Dependency reading'),
        hEl('p', { class: 'dcv-hint' }, `Depends on (${f.dependsOn.length}): ${list(f.dependsOn)}`),
        hEl('p', { class: 'dcv-hint' }, `Depended on by (${f.dependents.length}): ${list(f.dependents)}`),
        hEl('p', { class: 'dcv-hint' }, `Blast radius if it fails: ${f.blastRadius.length} component${f.blastRadius.length === 1 ? '' : 's'}`),
        f.outbound.length ? hEl('p', { class: 'dcv-hint' }, `Outbound calls (${f.outbound.length}): ${list(f.outbound)}`) : null);
    }
    pop.append(
      hEl('p', { class: 'dcv-pop-title' }, 'Focus mode'),
      hEl('div', { class: 'dcv-row' }, onBtn),
      hEl('p', { class: 'dcv-pop-title' }, 'Neighborhood size'),
      hopRow,
      hEl('p', { class: 'dcv-hint' }, 'Focus keeps the selected node and everything within N hops (in either direction) and hides the rest.'),
      factsBox);
  });

  makePop(legendBtn, (pop) => buildLegend(pop));

  function refreshOpenPop(btn) {
    const rec = pops.find((p) => p.anchorBtn === btn);
    if (!rec || rec.pop.hidden) return;
    rec.pop.textContent = '';
    rec.build(rec.pop);
  }

  resetViewBtn.addEventListener('click', () => {
    view = normalizeView({ focusHops: view.focusHops });
    searchInput.value = '';
    applyVisibility({ refit: true });
    emitView();
    for (const p of pops) if (!p.pop.hidden) refreshOpenPop(p.anchorBtn);
  });
  fitBtn.addEventListener('click', fit);

  function emitView() {
    if (typeof onViewChange !== 'function') return;
    try { onViewChange({ ...view }); } catch (err) { console.error('[diagram-canvas] onViewChange failed', err); }
  }

  function centerFirstMatch() {
    const q = searchInput.value.trim();
    if (!q) return;
    const hit = [...nodeById.entries()]
      .filter(([id, n]) => viewResult?.visibleNodeIds.has(id) && LAYOUT.matchesSearch(n, q))
      .sort((a, b) => String(a[1].label || a[0]).localeCompare(String(b[1].label || b[0])))[0];
    if (!hit) return;
    centerOn(hit[0]);
    selectNode(hit[0]);
  }

  function centerOn(id) {
    const p = posOf(id);
    const s = sizeOfId(id);
    const r = svg.getBoundingClientRect();
    const W = r.width || wrap.clientWidth || 900;
    const H = r.height || wrap.clientHeight || 600;
    vt.z = Math.max(vt.z, 0.85);
    vt.x = W / 2 - (p.x + s.w / 2) * vt.z;
    vt.y = H / 2 - (p.y + s.h / 2) * vt.z;
    applyView2();
  }

  // --- legend ----------------------------------------------------------------
  const LEGEND_ITEMS = () => {
    const items = [];
    const sw = (inner) => `<svg width="34" height="18" viewBox="0 0 34 18">${inner}</svg>`;
    items.push(['node', sw(`<rect x="1" y="2" width="32" height="14" rx="4" fill="${DARK.card}" stroke="${DARK.cardBorder}"/><path d="M2.5 5 L2.5 13" stroke="${DARK.tier0}" stroke-width="2.5" stroke-linecap="round"/>`),
      'Tier-0 component', 'Red spine on the left edge — business-critical.']);
    items.push(['node', sw(`<rect x="1" y="2" width="32" height="14" rx="4" fill="${DARK.card}" stroke="${DARK.cardBorder}" stroke-dasharray="4 3"/>`),
      'Third-party', 'Dashed border — a dependency you do not operate.']);
    items.push(['node', sw(`<rect x="4" y="4" width="26" height="10" rx="3" fill="${DARK.card}" fill-opacity="0.55" stroke="${DARK.cardBorder}" stroke-opacity="0.6"/>`),
      'Resource pill', 'A discovered AWS resource, subordinate to its component.']);
    if (hubIds.size) {
      items.push(['node', sw(`<rect x="1" y="2" width="32" height="14" rx="4" fill="${DARK.card}" stroke="${DARK.hub}" stroke-width="1.5"/>`),
        `Shared infrastructure (${hubIds.size})`,
        `Amber border + “shared by N”. Degree ≥ ${hubInfo.threshold}, so its member links are summarized instead of drawn${view.hideSharedInfra ? ' (currently hidden)' : ' (currently drawn)'}.`]);
    }
    items.push(['edge', sw(`<path d="M1 9 H26" stroke="${DARK.edge}" stroke-width="1.5"/><path d="M26,5.5 L33,9 L26,12.5 Z" fill="${DARK.edge}"/>`),
      'Dependency', 'A → B means A depends on B. Follow arrows to find what must come up first.']);
    items.push(['edge', sw(`<path d="M1 9 H26" stroke="${DARK.accent}" stroke-width="1.5" stroke-dasharray="5 4"/><path d="M26,5.5 L33,9 L26,12.5 Z" fill="${DARK.accent}"/>`),
      'Outbound call', 'Leaves the inventory — a third-party or external target.']);
    items.push(['edge', sw(`<path d="M1 9 H27" stroke="${DARK.relation}" stroke-width="1"/><path d="M27,6 L33,9 L27,12 Z" fill="${DARK.relation}"/>`),
      'Resource relation', 'Between discovered resources (secured-by, in-subnet, encrypted-by…).']);
    return items;
  };

  function buildLegend(pop) {
    pop.append(hEl('p', { class: 'dcv-pop-title' }, 'Nodes'));
    for (const [kind, swatch, label, note] of LEGEND_ITEMS()) {
      if (kind !== 'node') continue;
      const row = hEl('div', { class: 'dcv-leg-item' });
      const box = hEl('span', { class: 'dcv-leg-swatch' });
      box.innerHTML = swatch;
      row.append(box, hEl('span', null, label));
      pop.append(row, note ? hEl('div', { class: 'dcv-leg-note' }, note) : null);
    }
    pop.append(hEl('p', { class: 'dcv-pop-title' }, 'Links'));
    for (const [kind, swatch, label, note] of LEGEND_ITEMS()) {
      if (kind !== 'edge') continue;
      const row = hEl('div', { class: 'dcv-leg-item' });
      const box = hEl('span', { class: 'dcv-leg-swatch' });
      box.innerHTML = swatch;
      row.append(box, hEl('span', null, label));
      pop.append(row, note ? hEl('div', { class: 'dcv-leg-note' }, note) : null);
    }
    pop.append(hEl('hr'),
      hEl('p', { class: 'dcv-hint' },
        'Parallel links between the same pair are fanned apart, and the two directions of a mutual dependency are offset so both stay visible.'),
      hEl('p', { class: 'dcv-hint' },
        obstacleRouting()
          ? 'Links bend around node boxes they would otherwise cross.'
          : 'This diagram is large, so links are drawn directly (obstacle-aware routing is off above ~420 nodes / ~460 links) — use Declutter and Focus to thin it out.'),
      hEl('p', { class: 'dcv-hint' }, 'Zoom out far enough and sub-labels, then all labels, are dropped so what remains stays readable.'));
  }

  // --- focus dimming (hover/selection) ---------------------------------------
  let dragging = false;
  let selectedId = null;
  function setFocusDim(nodeId) {
    if (nodeId === null || !nodeEls.has(nodeId)) {
      for (const { g } of nodeEls.values()) g.classList.remove('dcv-dim');
      for (const rec of edgeRecs) rec.gE.classList.remove('dcv-dim');
      return;
    }
    const related = new Set([nodeId]);
    const litEdges = new Set();
    for (const rec of edgesByNode.get(nodeId) || []) {
      if (rec.hidden) continue;
      related.add(rec.e.from); related.add(rec.e.to); litEdges.add(rec);
    }
    for (const [id, { g }] of nodeEls) g.classList.toggle('dcv-dim', !related.has(id));
    for (const rec of edgeRecs) rec.gE.classList.toggle('dcv-dim', !litEdges.has(rec));
  }

  // --- hover tooltip ----------------------------------------------------------
  let tipEl = null, tipTimer = null;
  function hideTip() {
    clearTimeout(tipTimer); tipTimer = null;
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }
  function showTip(n, g) {
    hideTip();
    const id = String(n.id);
    const badgeText = nodeBadges
      ? (nodeBadges[id] ?? (n.componentId ? nodeBadges[String(n.componentId)] : undefined))
      : undefined;
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute; z-index:6; pointer-events:none; max-width:290px;'
      + `background:${DARK.card}; border:1px solid ${DARK.cardBorder}; border-radius:8px;`
      + `padding:8px 11px; font:12px ${FONT_STACK}; color:${DARK.text};`
      + 'box-shadow:0 10px 32px rgba(0,0,0,.5);';
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const kindBadge = n.k8sKind || n.rtype || n.kind || n.category || '';
    const badgeHtml = badgeText
      ? String(badgeText).split('\n').filter((l) => l.trim() !== '')
        .map((l) => `<div style="color:${DARK.accent}; margin-top:4px;">${esc(l)}</div>`).join('')
      : '';
    // Dependency reading right in the tooltip — the owner's priority question.
    let depHtml = '';
    if (!n.small) {
      const f = dependencyFacts(currentGraph(), id);
      const bits = [];
      if (f.dependsOn.length) bits.push(`depends on ${f.dependsOn.length}`);
      if (f.dependents.length) bits.push(`${f.dependents.length} depend${f.dependents.length === 1 ? 's' : ''} on it`);
      if (f.blastRadius.length) bits.push(`blast radius ${f.blastRadius.length}`);
      if (hubIds.has(id)) bits.push(`shared by ${(hubMembership[id] || []).length}`);
      if (bits.length) depHtml = `<div style="color:${DARK.muted}; margin-top:5px;">${esc(bits.join(' · '))}</div>`;
    }
    div.innerHTML =
      '<div style="display:flex; align-items:center; gap:8px;">'
      + `<span style="font-weight:600;">${esc(n.label ?? n.id)}</span>`
      + (kindBadge ? `<span style="border:1px solid ${DARK.cardBorder}; border-radius:999px; padding:0 7px; font-size:10.5px; color:${DARK.muted}; white-space:nowrap;">${esc(kindBadge)}</span>` : '')
      + '</div>'
      + (n.sub ? `<div style="color:${DARK.muted}; margin-top:2px;">${esc(n.sub)}</div>` : '')
      + depHtml
      + badgeHtml;
    wrap.appendChild(div);
    const wr = wrap.getBoundingClientRect();
    const nr = g.getBoundingClientRect();
    let x = nr.left - wr.left + 4;
    let y = nr.bottom - wr.top + 8;
    const tw = div.offsetWidth, th = div.offsetHeight;
    if (x + tw > wr.width - 8) x = Math.max(8, wr.width - tw - 8);
    if (y + th > wr.height - 8) y = Math.max(8, nr.top - wr.top - th - 8);
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    tipEl = div;
  }
  function scheduleTip(n, g) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { if (!dragging) showTip(n, g); }, 350);
  }

  // --- interaction: node hover/click/drag ---------------------------------------
  let changeTimer = null;
  const emitChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      try { onChange(allPositions()); } catch (err) { console.error('[diagram-canvas] onChange failed', err); }
    }, 400);
  };

  function selectNode(id) {
    for (const { g } of nodeEls.values()) g.classList.remove('dcv-selected');
    selectedId = id;
    if (id) nodeEls.get(id)?.g.classList.add('dcv-selected');
    setFocusDim(selectedId);
    refreshOpenPop(focusBtn);
    if (typeof onSelect === 'function') {
      try { onSelect(id ? nodeById.get(id) || null : null); } catch (err) { console.error('[diagram-canvas] onSelect failed', err); }
    }
  }

  function attachNodeInteractions(id) {
    const rec = nodeEls.get(id);
    if (!rec) return;
    const { n, g } = rec;
    let downAt = null;
    g.addEventListener('pointerenter', () => {
      if (dragging) return;
      setFocusDim(id);
      scheduleTip(n, g);
      if (typeof onNodeHover === 'function') { try { onNodeHover(n); } catch (err) { console.error('[diagram-canvas] onNodeHover failed', err); } }
    });
    g.addEventListener('pointerleave', () => {
      if (!dragging) setFocusDim(selectedId);
      hideTip();
      if (typeof onNodeHover === 'function') { try { onNodeHover(null); } catch (err) { console.error('[diagram-canvas] onNodeHover failed', err); } }
    });
    g.addEventListener('pointerdown', (ev) => {
      downAt = { x: ev.clientX, y: ev.clientY };
      hideTip();
    });
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const was = g.classList.contains('dcv-selected');
      selectNode(was ? null : id);
      if (!selectedId) setFocusDim(id); // hovering anyway
      if (typeof onNodeClick === 'function') {
        const dx = downAt ? ev.clientX - downAt.x : 0;
        const dy = downAt ? ev.clientY - downAt.y : 0;
        if (dx * dx + dy * dy < 25) {
          try { onNodeClick(n); } catch (err) { console.error('[diagram-canvas] onNodeClick failed', err); }
        }
      }
    });

    if (readOnly) return;
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
        invalidateObstacles();
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
        if (moved) { refreshEdgeLabels(); emitChange(); }
      };
      g.addEventListener('pointermove', onMove);
      g.addEventListener('pointerup', onUp);
      g.addEventListener('pointercancel', onUp);
    });
  }

  for (const id of nodeEls.keys()) attachNodeInteractions(id);

  // --- interaction: pan + zoom -----------------------------------------------------
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target !== svg && ev.target !== gridRect && ev.target !== viewport
      && !gGroups.contains(ev.target)) return;
    if (selectedId !== null) { selectNode(null); setFocusDim(null); }
    const sx = ev.clientX, sy = ev.clientY, ox = vt.x, oy = vt.y;
    svg.setPointerCapture(ev.pointerId);
    wrap.classList.add('dcv-grabbing');
    const onMove = (mv) => {
      vt.x = ox + (mv.clientX - sx);
      vt.y = oy + (mv.clientY - sy);
      viewport.setAttribute('transform', `translate(${vt.x},${vt.y}) scale(${vt.z})`);
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
    hideTip();
    const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    const nz = Math.max(0.18, Math.min(2.5, vt.z * factor));
    if (nz === vt.z) return;
    const r = svg.getBoundingClientRect();
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const wx = (sx - vt.x) / vt.z, wy = (sy - vt.y) / vt.z;
    vt.z = nz;
    vt.x = sx - wx * nz;
    vt.y = sy - wy * nz;
    applyView2();
  };
  svg.addEventListener('wheel', onWheel, { passive: false });

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      let closed = false;
      for (const p of pops) if (!p.pop.hidden) { p.pop.hidden = true; closed = true; }
      if (!closed && selectedId) selectNode(null);
    }
  };
  wrap.addEventListener('keydown', onKey);

  // --- expansion state ---------------------------------------------------------
  const expansions = new Map();
  const injectedRefs = new Map();
  const edgeRefs = new Map();

  const expansionNodeMap = () => {
    const out = {};
    for (const [pid, rec] of expansions) out[pid] = rec.nodes;
    return out;
  };
  const expansionEdgeMap = () => {
    const out = {};
    for (const [pid, rec] of expansions) out[pid] = rec.edgeKeys;
    return out;
  };

  function removeNode(id) {
    const rec = nodeEls.get(id);
    if (!rec) return;
    rec.g.remove();
    nodeEls.delete(id);
    nodeById.delete(id);
    delete custom[id];
    edgesByNode.delete(id);
    if (selectedId === id) selectedId = null;
  }

  function expandNode(nodeId, payload = {}) {
    if (destroyed) return;
    const pid = String(nodeId);
    if (!nodeEls.has(pid)) return;
    if (expansions.has(pid)) return; // idempotent per nodeId
    const incoming = safeNodes(payload);
    const rec = { nodes: [], edgeKeys: [] };
    const newly = [];
    for (const n of incoming) {
      const id = String(n.id);
      if (id === pid) continue;
      if (nodeById.has(id)) {
        if (injectedRefs.has(id)) {
          injectedRefs.set(id, injectedRefs.get(id) + 1);
          rec.nodes.push(id);
        }
        continue;
      }
      nodeById.set(id, n);
      injectedRefs.set(id, 1);
      rec.nodes.push(id);
      newly.push(n);
      renderNode(n);
      attachNodeInteractions(id);
    }

    const pp = posOf(pid);
    const ps = sizeOfId(pid);
    const fan = computeExpansionLayout({ x: pp.x, y: pp.y, w: ps.w, h: ps.h }, newly.length);
    const occupied = new Set();
    for (const [id, p] of Object.entries(allPositions())) {
      if (!newly.some((n) => String(n.id) === id)) occupied.add(`${p.x},${p.y}`);
    }
    newly.forEach((n, i) => {
      const id = String(n.id);
      const p = savedPositions[id] ? { ...savedPositions[id] } : { ...fan[i] };
      let k = `${p.x},${p.y}`;
      while (occupied.has(k)) {
        p.x = snap(p.x + GRID);
        p.y = snap(p.y + GRID * 2);
        k = `${p.x},${p.y}`;
      }
      occupied.add(k);
      custom[id] = p;
    });

    const seenHere = new Set();
    const newEdges = [];
    for (const raw of (Array.isArray(payload.edges) ? payload.edges : [])) {
      if (!raw || raw.from === undefined || raw.to === undefined) continue;
      const from = String(raw.from), to = String(raw.to);
      if (from === to) continue;
      if (!nodeById.has(from) || !nodeById.has(to)) continue;
      const e = { from, to, kind: raw.kind === 'outbound' ? 'outbound' : 'dependency', label: raw.label || '' };
      const key = edgeKeyOf(e);
      if (baseEdgeKeys.has(key) || seenHere.has(key)) continue;
      seenHere.add(key);
      const existing = edgeRefs.get(key);
      if (existing && !existing.rec.removed) {
        existing.count++;
        rec.edgeKeys.push(key);
      } else {
        newEdges.push(e);
        rec.edgeKeys.push(key);
      }
    }
    // Re-bundle so injected parallels fan apart like base ones.
    bundles = groupParallelEdges([...edgeRecs].map((r) => r.e).concat(newEdges));
    for (const r of edgeRecs) r.bundle = bundles.get(r.key) || r.bundle;
    for (const e of newEdges) {
      const erec = addEdgeRec(e, { injected: true });
      edgeRefs.set(erec.key, { rec: erec, count: 1 });
    }

    expansions.set(pid, rec);
    for (const n of newly) placeNode(String(n.id));
    applyVisibility();
    setExpanderState(pid, true);
    emitChange();
  }

  function collapseNode(nodeId) {
    if (destroyed) return;
    const pid = String(nodeId);
    const rec = expansions.get(pid);
    if (!rec) return;

    const dropNodes = new Set(collapseRemovals(expansionNodeMap(), pid));
    const dropEdges = new Set(collapseRemovals(expansionEdgeMap(), pid));
    expansions.delete(pid);

    for (const key of rec.edgeKeys) {
      const er = edgeRefs.get(key);
      if (!er) continue;
      er.count--;
      if (dropEdges.has(key) || er.count <= 0) {
        removeEdgeRec(er.rec);
        edgeRefs.delete(key);
      }
    }
    for (const id of rec.nodes) {
      const c = (injectedRefs.get(id) || 0) - 1;
      if (!dropNodes.has(id) && c > 0) { injectedRefs.set(id, c); continue; }
      injectedRefs.delete(id);
      const p = posOf(id);
      savedPositions[id] = { x: p.x, y: p.y };
      for (const er of [...(edgesByNode.get(id) || [])]) removeEdgeRec(er);
      removeNode(id);
    }
    for (const [key, er] of [...edgeRefs]) if (er.rec.removed) edgeRefs.delete(key);

    hideTip();
    applyVisibility();
    setExpanderState(pid, false);
    emitChange();
  }

  function repositionExpansions() {
    for (const [pid, rec] of expansions) {
      const live = rec.nodes.filter((id) => injectedRefs.has(id));
      if (!live.length) continue;
      const pp = posOf(pid);
      const ps = sizeOfId(pid);
      const fan = computeExpansionLayout({ x: pp.x, y: pp.y, w: ps.w, h: ps.h }, live.length);
      live.forEach((id, i) => { custom[id] = { ...fan[i] }; });
    }
  }

  // --- initial paint -----------------------------------------------------------------
  placeAll();
  applyVisibility();
  applyView2();
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

  // Level of detail is a SCREEN concern: a file exported while zoomed out must
  // still contain every resource pill. Unfold, export, refold.
  async function exportSvg() {
    const folded = !!(viewResult && viewResult.lod && viewResult.lod.rolledUp);
    if (!folded) return exportSvgInner();
    forceFullDetail = true;
    applyVisibility();
    try { return await exportSvgInner(); }
    finally { forceFullDetail = false; applyVisibility(); }
  }

  // Designed light-theme SVG for docs: title + generated date, a framed plot
  // area, generous padding, and the legend baked in so the artifact explains
  // itself. Only what is currently VISIBLE is exported (filters included), and
  // the header says so.
  async function exportSvgInner() {
    const T = LIGHT;
    const pos = visiblePositions();
    const vg = visibleGroups();
    const b = contentBounds(pos, vg, sizeOfId, GROUP_OPTS);
    const PAD = 40;
    const HEADER = title || subtitle ? 74 : 44;
    const LEGEND_W = 250;
    const plotW = Math.ceil(b.w + PAD * 2);
    const plotH = Math.ceil(b.h + PAD * 2);
    const legendRows = LEGEND_ITEMS();
    const legendH = 44 + legendRows.length * 40;
    const bodyH = Math.max(plotH, legendH + PAD);
    const W = plotW + LEGEND_W;
    const H = HEADER + bodyH + 34; // + footer
    const off = { x: PAD - b.x, y: HEADER + PAD - b.y };
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${escXml(FONT_STACK)}">`);
    parts.push(`<defs>
      <marker id="xarr-dep" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 Z" fill="${T.edge}"/></marker>
      <marker id="xarr-out" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 Z" fill="${T.accent}"/></marker>
      <marker id="xarr-rel" markerWidth="8" markerHeight="7" refX="7" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.5 L0,7 Z" fill="${T.relation}"/></marker>
    </defs>`);
    parts.push(`<rect width="${W}" height="${H}" fill="${T.bg}"/>`);

    // header
    const now = new Date();
    const dateText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (title || subtitle) {
      if (title) parts.push(`<text x="${PAD}" y="38" fill="${T.title}" font-size="19" font-weight="700">${escXml(title)}</text>`);
      if (subtitle) parts.push(`<text x="${PAD}" y="${title ? 58 : 38}" fill="${T.muted}" font-size="12">${escXml(subtitle)}</text>`);
    } else {
      parts.push(`<text x="${PAD}" y="30" fill="${T.title}" font-size="17" font-weight="700">DR Compass diagram</text>`);
    }
    parts.push(`<line x1="${PAD}" y1="${HEADER - 12}" x2="${W - PAD}" y2="${HEADER - 12}" stroke="${T.frame}"/>`);

    // plot frame
    parts.push(`<rect x="${PAD / 2}" y="${HEADER - 4}" width="${plotW - PAD / 2 + 8}" height="${bodyH}" rx="10" fill="${T.panel}" stroke="${T.frame}"/>`);
    parts.push(`<g transform="translate(${off.x},${off.y})">`);

    for (const g of vg) {
      const memberIds = g.nodeIds.filter((id) => pos[String(id)]);
      const gb = memberIds.length ? groupBounds({ nodeIds: memberIds }, pos, sizeOfId, GROUP_OPTS) : null;
      if (!gb) continue;
      const text = String(g.label || g.id || '').toUpperCase();
      const tw = textWidth(text, `700 10px ${FONT_STACK}`) + 16;
      parts.push(`<rect x="${gb.x}" y="${gb.y}" width="${gb.w}" height="${gb.h}" rx="13" fill="${T.groupFill}" stroke="${T.groupStroke}"/>`);
      parts.push(`<rect x="${gb.x + 10}" y="${gb.y + 5}" width="${Math.min(tw, Math.max(40, gb.w - 20))}" height="17" rx="5" fill="${T.bg}" stroke="${T.groupStroke}"/>`);
      parts.push(`<text x="${gb.x + 18}" y="${gb.y + 17}" fill="${T.muted}" font-size="10" font-weight="700" letter-spacing="0.08em">${escXml(text)}</text>`);
    }

    for (const rec of edgeRecs) {
      if (rec.hidden) continue;
      const e = rec.e;
      if (!pos[e.from] || !pos[e.to]) continue;
      const isOut = e.kind === 'outbound';
      const { path, mid } = routeEdge({
        p1: pos[e.from], s1: sizeOfId(e.from), p2: pos[e.to], s2: sizeOfId(e.to),
        bundle: rec.bundle,
        waypoints: (!custom[e.from] && !custom[e.to]) ? waypoints[rec.key] : null,
        obstacles: obstaclesFor(rec),
      });
      const stroke = isOut ? T.accent : (rec.bothSmall ? T.relation : T.edge);
      const marker = isOut ? 'xarr-out' : (rec.bothSmall ? 'xarr-rel' : 'xarr-dep');
      parts.push(`<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${rec.bothSmall ? 1 : 1.5}"${isOut ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#${marker})" opacity="0.9"/>`);
      if (e.label && rec.labelShown) {
        const w = textWidth(e.label, `11px ${FONT_STACK}`) + 10;
        parts.push(`<rect x="${mid.x - w / 2}" y="${mid.y - 16}" width="${w}" height="16" rx="4" fill="${T.labelBg}" opacity="0.94"/>`);
        parts.push(`<text x="${mid.x}" y="${mid.y - 4}" fill="${T.muted}" font-size="11" text-anchor="middle">${escXml(e.label)}</text>`);
      }
    }

    for (const n of nodeById.values()) {
      const id = String(n.id);
      const p = pos[id];
      if (!p) continue;
      const small = !!n.small;
      const { w: NW, h: NH } = sizeOfNode(n);
      const isThird = !small && n.category === 'third-party';
      const isTier0 = !small && num(n.tier) === 0;
      const isHub = hubIds.has(id);
      parts.push(`<g transform="translate(${p.x},${p.y})">`);
      parts.push(`<rect width="${NW}" height="${NH}" rx="${small ? 8 : 10}" fill="${T.card}" stroke="${isHub ? T.hub : T.cardBorder}"${isHub ? ' stroke-width="1.5"' : ''}${small ? ' fill-opacity="0.7" stroke-opacity="0.75"' : ''}${isThird ? ' stroke-dasharray="5 4"' : ''}/>`);
      if (isTier0) parts.push(`<path d="M 1.5 12 L 1.5 ${NH - 12}" stroke="${T.tier0}" stroke-width="3" stroke-linecap="round" opacity="0.9"/>`);
      const iconSize = small ? 20 : 36;
      let iconMarkup = null;
      if (n._iconFile) {
        const uri = await iconDataUri(n._iconFile);
        if (uri) iconMarkup = `<image x="0" y="0" width="${iconSize}" height="${iconSize}" href="${uri}"/>`;
      }
      if (!iconMarkup) {
        const gm = glyphMarkup(glyphCategoryFor(n));
        iconMarkup = small ? `<g transform="scale(${(iconSize / 36).toFixed(4)})">${gm}</g>` : gm;
      }
      parts.push(`<g transform="translate(${small ? '8,10' : '12,14'})">${iconMarkup}</g>`);
      if (small) {
        parts.push(`<text x="34" y="17" fill="${T.text}" font-size="11.5" font-weight="600">${escXml(n._dispLabel ?? n.label ?? id)}</text>`);
        const rt = n._dispSub ?? n.rtype ?? n.sub ?? '';
        if (rt) parts.push(`<text x="34" y="30" fill="${T.muted}" font-size="10">${escXml(rt)}</text>`);
      } else {
        const sub = n._dispSub ?? n.sub ?? '';
        parts.push(`<text x="58" y="${sub ? 29 : 37}" fill="${T.text}" font-size="12.5" font-weight="600">${escXml(n._dispLabel ?? n.label ?? id)}</text>`);
        if (sub) parts.push(`<text x="58" y="45" fill="${isHub ? T.hub : T.muted}" font-size="11">${escXml(sub)}</text>`);
      }
      parts.push('</g>');
    }
    parts.push('</g>');

    // legend column
    const lx = plotW + 12;
    parts.push(`<text x="${lx}" y="${HEADER + 16}" fill="${T.muted}" font-size="10" font-weight="700" letter-spacing="0.08em">LEGEND</text>`);
    let ly = HEADER + 40;
    for (const [, swatch, label, note] of legendRows) {
      const light = swatch
        .replace(new RegExp(DARK.card, 'g'), T.card)
        .replace(new RegExp(DARK.cardBorder, 'g'), T.cardBorder)
        .replace(new RegExp(DARK.edge, 'g'), T.edge)
        .replace(new RegExp(DARK.accent, 'g'), T.accent)
        .replace(new RegExp(DARK.relation, 'g'), T.relation)
        .replace(new RegExp(DARK.tier0, 'g'), T.tier0)
        .replace(new RegExp(DARK.hub, 'g'), T.hub);
      parts.push(`<g transform="translate(${lx},${ly - 13})">${light}</g>`);
      parts.push(`<text x="${lx + 42}" y="${ly}" fill="${T.title}" font-size="11.5" font-weight="600">${escXml(label)}</text>`);
      if (note) {
        // wrap the note to ~30 chars per line, max 2 lines
        const words = String(note).split(/\s+/);
        const lines = [];
        let cur = '';
        for (const wd of words) {
          if ((cur + ' ' + wd).trim().length > 32) { lines.push(cur.trim()); cur = wd; }
          else cur += ' ' + wd;
          if (lines.length === 2) break;
        }
        if (lines.length < 2 && cur.trim()) lines.push(cur.trim());
        lines.forEach((ln, i) => {
          parts.push(`<text x="${lx + 42}" y="${ly + 13 + i * 11}" fill="${T.muted}" font-size="9.5">${escXml(ln + (i === 1 && words.join(' ').length > 64 ? '…' : ''))}</text>`);
        });
      }
      ly += 40;
    }

    // footer
    const hiddenNote = viewResult && (viewResult.counts.nodesHidden || viewResult.counts.edgesHidden)
      ? ` · filtered view: ${viewResult.counts.nodesHidden} nodes / ${viewResult.counts.edgesHidden} links hidden`
      : '';
    parts.push(`<line x1="${PAD}" y1="${H - 26}" x2="${W - PAD}" y2="${H - 26}" stroke="${T.frame}"/>`);
    parts.push(`<text x="${PAD}" y="${H - 10}" fill="${T.muted}" font-size="10">Generated by DR Compass · ${escXml(dateText)} · ${viewResult ? viewResult.counts.nodesVisible : nodeById.size} nodes, ${viewResult ? viewResult.counts.edgesVisible : edgeRecs.size} links${escXml(hiddenNote)}</text>`);
    parts.push('</svg>');
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
  const relayout = () => {
    layoutOut = computeLayoutFull(template, { nodes, edges });
    base = layoutOut.positions;
    waypoints = layoutOut.waypoints || {};
  };
  const controller = {
    setTemplate(name) {
      if (destroyed) return;
      template = TEMPLATES.includes(name) ? name : 'category-grid';
      for (const k of Object.keys(custom)) delete custom[k];
      relayout();
      repositionExpansions();
      placeAll();
      applyVisibility();
      fit();
      emitChange();
    },
    getTemplate() { return template; },
    resetLayout() {
      if (destroyed) return;
      for (const k of Object.keys(custom)) delete custom[k];
      relayout();
      repositionExpansions();
      placeAll();
      applyVisibility();
      fit();
      emitChange();
    },
    getPositions() { return allPositions(); },
    setPositions(map) {
      if (destroyed || !map || typeof map !== 'object') return;
      for (const [k, v] of Object.entries(map)) {
        if (!v) continue;
        const x = num(v.x), y = num(v.y);
        if (x === null || y === null) continue;
        const id = String(k);
        savedPositions[id] = { x: snap(x), y: snap(y) };
        if (nodeById.has(id)) custom[id] = { x: snap(x), y: snap(y) };
      }
      placeAll();
      applyVisibility();
    },
    getView() { return { ...view }; },
    setView(partial) {
      if (destroyed) return;
      view = normalizeView({ ...view, ...(partial && typeof partial === 'object' ? partial : {}) });
      searchInput.value = view.search;
      applyVisibility();
      emitView();
    },
    focusNode(id, hops) {
      if (destroyed) return;
      const nid = id === null || id === undefined ? null : String(id);
      view = normalizeView({ ...view, focusId: nid, focusHops: hops ?? view.focusHops });
      if (nid) selectNode(nodeById.has(nid) ? nid : null);
      applyVisibility({ refit: true });
      emitView();
    },
    getSelectedNode() { return selectedId ? nodeById.get(selectedId) || null : null; },
    getStats() {
      const counts = viewResult ? viewResult.counts : null;
      return {
        template,
        nodes: nodeById.size,
        edges: edgeRecs.size,
        hubs: [...hubIds],
        hubThreshold: hubInfo.threshold,
        hubMembership,
        crossings: layoutOut.crossings ?? null,
        layoutBudget: layoutOut.budget || null,
        visible: counts ? { nodes: counts.nodesVisible, edges: counts.edgesVisible } : null,
        hidden: counts ? { nodes: counts.nodesHidden, edges: counts.edgesHidden } : null,
        // Level of detail: what the current zoom folded away, if anything.
        lod: viewResult && viewResult.lod ? { ...viewResult.lod } : null,
        zoom: vt.z,
      };
    },
    selectNode(id) { if (!destroyed) selectNode(id === null || id === undefined ? null : String(id)); },
    centerOn(id) { if (!destroyed && nodeById.has(String(id))) centerOn(String(id)); },
    expandNode,
    collapseNode,
    isExpanded(nodeId) { return expansions.has(String(nodeId)); },
    getExpandedState() {
      const out = {};
      for (const pid of expansions.keys()) out[pid] = true;
      return out;
    },
    exportSvg,
    exportPng,
    fit() { if (!destroyed) fit(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(changeTimer);
      clearTimeout(searchTimer);
      hideTip();
      svg.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('keydown', onKey);
      wrap.remove();
    },
  };
  return controller;
}

export default {
  createCanvas, computeLayout, computeLayoutFull, computeFlowRanks, resolveIcon,
  graphToCanvasNodes, computeExpansionLayout, collapseRemovals,
  detectHubs, collapseHubEdges, applyView, dependencyFacts,
  TEMPLATES, NODE_W, NODE_H, SMALL_W, SMALL_H,
};
