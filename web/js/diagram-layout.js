// DR Compass — pure diagram layout, edge routing, hub detection and filtering.
//
// Zero dependencies, zero DOM: every function here is a pure function of its
// arguments and is unit-tested in Node (see INTEGRATION-NOTES.md). The canvas
// engine (web/js/diagram-canvas.js) imports and re-exports these so older
// callers of `computeLayout` / `computeFlowRanks` keep working.
//
// Determinism is a hard requirement: same input → byte-identical output. That
// means no Math.random, no Date, no Object key-order assumptions beyond the
// insertion order we build ourselves, and every tie broken by an explicit
// comparator that ends in a node-id comparison.

export const NODE_W = 180;
export const NODE_H = 64;
export const SMALL_W = 150;
export const SMALL_H = 40;
export const GRID = 8;

export const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];

export const CATEGORY_ORDER = [
  'edge-dns', 'networking', 'compute', 'messaging-streaming', 'database',
  'storage', 'security-secrets', 'identity-access', 'cicd-control-plane',
  'observability', 'third-party', 'other',
];

export const snap = (v) => Math.round(v / GRID) * GRID;
export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export const sizeOfNode = (n) => (n && n.small ? { w: SMALL_W, h: SMALL_H } : { w: NODE_W, h: NODE_H });

export function catRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

export function byLabel(a, b) {
  return String(a.label || a.id).localeCompare(String(b.label || b.id))
    || String(a.id).localeCompare(String(b.id));
}

// ---------------------------------------------------------------------------
// Graph normalization
// ---------------------------------------------------------------------------

export function safeNodes(data) {
  const seen = new Set();
  const out = [];
  for (const n of (data && Array.isArray(data.nodes) ? data.nodes : [])) {
    if (!n || n.id === undefined || n.id === null) continue;
    const id = String(n.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(n);
  }
  return out;
}

export function safeEdges(data, ids) {
  const out = [];
  for (const e of (data && Array.isArray(data.edges) ? data.edges : [])) {
    if (!e || e.from === undefined || e.to === undefined) continue;
    const from = String(e.from), to = String(e.to);
    if (from === to) continue;                    // self-loops: skip
    if (ids && (!ids.has(from) || !ids.has(to))) continue; // dangling: skip
    out.push({
      from, to,
      kind: e.kind === 'outbound' ? 'outbound' : 'dependency',
      label: e.label || '',
    });
  }
  return out;
}

// Stable identity for an edge (used for visibility bookkeeping + bundling).
export const edgeKeyOf = (e) => `${e.from}→${e.to}|${e.kind}|${e.label || ''}`;

// Unordered pair key — bundles and bidirectional detection work on this.
export const pairKeyOf = (e) => (e.from < e.to ? `${e.from}↔${e.to}` : `${e.to}↔${e.from}`);

export function adjacency(edges) {
  const out = new Map(), inn = new Map(), all = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const e of edges) {
    push(out, e.from, e.to);
    push(inn, e.to, e.from);
    push(all, e.from, e.to);
    push(all, e.to, e.from);
  }
  return { out, inn, all };
}

export function degreeMap(nodes, edges) {
  const deg = new Map();
  for (const n of nodes) deg.set(String(n.id), 0);
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) || 0) + 1);
    deg.set(e.to, (deg.get(e.to) || 0) + 1);
  }
  return deg;
}

// ---------------------------------------------------------------------------
// Hub detection + shared-infrastructure collapse
// ---------------------------------------------------------------------------

// A "hub" is shared infrastructure: one node that half the graph touches
// (shared VPC, IAM role, KMS key, a cluster). Drawing N explicit edges to it
// is what produces the fan of lines the owner complains about.
//
// Rule (deterministic, documented in the canvas legend):
//   threshold = max(minDegree, median(nonZeroDegrees) * medianFactor,
//                   nodeCount * fraction)     ← tiny graphs never "have hubs"
//   a node is a hub when degree >= threshold AND
//     it is infrastructure-shaped (see SHARED_CATEGORIES / SHARED_RTYPES), or
//     degree >= threshold * sharedFactor      ← so a genuinely central business
//                                               service still counts
// The second clause matters: without it a busy *application* service (say an
// adjudication API with 7 links) gets labelled "shared infrastructure", which is
// wrong — the owner's complaint is about shared VPC / IAM / KMS fan-out.
export const HUB_DEFAULTS = { minDegree: 6, medianFactor: 3, fraction: 0.12, sharedFactor: 1.6 };

// Component categories that ARE shared infrastructure by nature.
export const SHARED_CATEGORIES = new Set([
  'networking', 'identity-access', 'security-secrets', 'edge-dns',
  'cicd-control-plane', 'observability',
]);

// Discovered-resource types that are shared by nature (resource pills carry a
// pseudo-category like '~res EC2', so they are classified by rtype instead).
export const SHARED_RTYPES = new Set([
  'vpc', 'subnet', 'security-group', 'nacl', 'route-table', 'nat-gateway',
  'internet-gateway', 'vpc-endpoint', 'availability-zone', 'load-balancer',
  'iam-role', 'iam-policy', 'instance-profile', 'oidc-provider',
  'kms-key', 'secret', 'certificate', 'log-group', 'db-subnet-group',
  'hosted-zone', 'parameter-group', 'launch-template',
]);

export function isSharedInfrastructure(node) {
  if (!node) return false;
  if (node.rtype && SHARED_RTYPES.has(String(node.rtype))) return true;
  return SHARED_CATEGORIES.has(String(node.category || ''));
}

export function detectHubs({ nodes, edges }, opts = {}) {
  const o = { ...HUB_DEFAULTS, ...opts };
  const ns = safeNodes({ nodes });
  const es = safeEdges({ edges }, new Set(ns.map((n) => String(n.id))));
  const deg = degreeMap(ns, es);
  const nonZero = [...deg.values()].filter((d) => d > 0).sort((a, b) => a - b);
  const median = nonZero.length
    ? (nonZero.length % 2
      ? nonZero[(nonZero.length - 1) / 2]
      : (nonZero[nonZero.length / 2 - 1] + nonZero[nonZero.length / 2]) / 2)
    : 0;
  const threshold = Math.max(
    o.minDegree,
    Math.ceil(median * o.medianFactor),
    Math.ceil(ns.length * o.fraction),
  );
  const highThreshold = Math.ceil(threshold * o.sharedFactor);
  const hubIds = ns
    .filter((n) => {
      const d = deg.get(String(n.id)) || 0;
      if (d < threshold) return false;
      return isSharedInfrastructure(n) || d >= highThreshold;
    })
    .map((n) => String(n.id))
    .sort();
  return { hubIds, threshold, highThreshold, degree: deg, median };
}

// Collapse the edges that only exist to attach members to shared infra.
// Returns the edges worth drawing plus the implicit membership we render as
// styling ("shared by N") instead of N lines.
export function collapseHubEdges({ nodes, edges }, hubIds) {
  const hubs = new Set((hubIds || []).map(String));
  const ns = safeNodes({ nodes });
  const es = safeEdges({ edges }, new Set(ns.map((n) => String(n.id))));
  const kept = [], hidden = [];
  const membership = new Map(); // hubId -> [memberId]
  for (const id of hubs) membership.set(id, []);
  for (const e of es) {
    const fromHub = hubs.has(e.from), toHub = hubs.has(e.to);
    // hub↔hub edges stay: they are the backbone, not the fan.
    if (fromHub && toHub) { kept.push(e); continue; }
    if (!fromHub && !toHub) { kept.push(e); continue; }
    const hub = fromHub ? e.from : e.to;
    const member = fromHub ? e.to : e.from;
    const list = membership.get(hub);
    if (!list.includes(member)) list.push(member);
    hidden.push(e);
  }
  const out = {};
  for (const [hub, members] of membership) out[hub] = members.slice().sort();
  return { edges: kept, hidden, membership: out };
}

// Should hub-collapse default to ON? Big graphs yes, small ones no — a 20-edge
// diagram reads fine with every line drawn.
export const HUB_AUTO_EDGES = 120;
export function shouldCollapseHubs({ nodes, edges }, hubIds) {
  const n = safeNodes({ nodes }).length;
  const e = (Array.isArray(edges) ? edges : []).length;
  return !!(hubIds && hubIds.length) && (e >= HUB_AUTO_EDGES || e > n * 2.2);
}

// ---------------------------------------------------------------------------
// Focus mode: N-hop neighborhood
// ---------------------------------------------------------------------------

// Undirected BFS by default (a DR reader wants "what touches this"), with
// per-hop direction bookkeeping so the caller can label upstream/downstream.
export function nHopNeighborhood(edges, rootIds, hops, opts = {}) {
  const { directed = false } = opts;
  const roots = (Array.isArray(rootIds) ? rootIds : [rootIds]).map(String).filter(Boolean);
  const maxHops = Math.max(0, Math.min(6, Number(hops) || 0));
  const { out, all } = adjacency(safeEdges({ edges }, null));
  const nbrs = directed ? out : all;
  const dist = new Map();
  let frontier = [];
  for (const r of roots) if (!dist.has(r)) { dist.set(r, 0); frontier.push(r); }
  for (let d = 0; d < maxHops; d++) {
    const next = [];
    for (const v of frontier) {
      for (const nb of nbrs.get(v) || []) {
        if (dist.has(nb)) continue;
        dist.set(nb, d + 1);
        next.push(nb);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return dist; // Map(id -> hop distance)
}

// Direct dependency answers for the "what breaks if this fails" reading.
export function dependencyFacts({ nodes, edges }, nodeId) {
  const id = String(nodeId);
  const ns = safeNodes({ nodes });
  const es = safeEdges({ edges }, new Set(ns.map((n) => String(n.id))));
  const deps = [], dependents = [], outbound = [];
  for (const e of es) {
    if (e.kind === 'outbound') {
      if (e.from === id) outbound.push(e.to);
      continue;
    }
    if (e.from === id) deps.push(e.to);       // id depends on e.to
    if (e.to === id) dependents.push(e.from); // e.from depends on id
  }
  // Transitive blast radius: everything that reaches `id` through dependencies.
  const revEdges = es.filter((e) => e.kind !== 'outbound').map((e) => ({ from: e.to, to: e.from, kind: 'dependency', label: '' }));
  const reach = nHopNeighborhood(revEdges, [id], 6, { directed: true });
  reach.delete(id);
  return {
    dependsOn: deps.sort(),
    dependents: dependents.sort(),
    outbound: outbound.sort(),
    blastRadius: [...reach.keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// Filtering (pure): what the toolbar chips/toggles decide to show
// ---------------------------------------------------------------------------

export const EMPTY_VIEW = {
  categories: null,   // null = all; else array of category strings
  tiers: null,        // null = all; else array of numbers (or 'none')
  layers: null,       // null = all; else array of layer strings (or 'none')
  focusId: null,
  focusHops: 1,
  hideOutbound: false,
  hideSharedInfra: false,
  hidePills: false,
  search: '',
};

export function normalizeView(v) {
  const s = { ...EMPTY_VIEW, ...(v && typeof v === 'object' ? v : {}) };
  const arr = (x) => (Array.isArray(x) && x.length ? x.map(String) : null);
  s.categories = arr(s.categories);
  s.layers = arr(s.layers);
  s.tiers = arr(s.tiers);
  s.focusId = s.focusId ? String(s.focusId) : null;
  s.focusHops = Math.max(1, Math.min(3, Number(s.focusHops) || 1));
  s.hideOutbound = !!s.hideOutbound;
  s.hideSharedInfra = !!s.hideSharedInfra;
  s.hidePills = !!s.hidePills;
  s.search = String(s.search || '');
  return s;
}

const tierKeyOf = (n) => (num(n && n.tier) === null ? 'none' : String(num(n.tier)));
const layerKeyOf = (n) => (n && LAYERS.includes(n.layer) ? n.layer : 'none');

export function matchesSearch(node, q) {
  if (!q) return true;
  const needle = String(q).trim().toLowerCase();
  if (!needle) return true;
  const hay = [node.label, node.id, node.sub, node.rtype, node.kind, node.category, node.namespace]
    .filter((v) => v !== undefined && v !== null)
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

// Returns which node ids and edge keys should be rendered, plus counts for the
// "N hidden" readout. `hubIds` comes from detectHubs; `hideSharedInfra` drops
// the hub fan-out edges (not the hub itself).
export function applyView({ nodes, edges }, view, opts = {}) {
  const s = normalizeView(view);
  const ns = safeNodes({ nodes });
  const ids = new Set(ns.map((n) => String(n.id)));
  const es = safeEdges({ edges }, ids);
  const byId = new Map(ns.map((n) => [String(n.id), n]));
  const hubs = new Set((opts.hubIds || []).map(String));

  // 1 — attribute filters (chips). A node kept by a chip filter keeps its pills.
  const attrOk = (n) => {
    if (s.categories && !s.categories.includes(String(n.category || 'other'))) return false;
    if (s.tiers && !s.tiers.includes(tierKeyOf(n))) return false;
    if (s.layers && !s.layers.includes(layerKeyOf(n))) return false;
    return true;
  };
  let visible = new Set();
  for (const n of ns) {
    const id = String(n.id);
    if (n.small && s.hidePills) continue;
    // Small pills ride along with their parent component: attribute chips are a
    // component-level idea, so a pill is judged by its own attrs only when it
    // carries them (resource pills use a pseudo-category '~res …').
    if (n.small && String(n.category || '').startsWith('~res')) { visible.add(id); continue; }
    if (!attrOk(n)) continue;
    visible.add(id);
  }

  // 2 — search narrows to matches plus their 1-hop context (so a hit is legible).
  if (s.search.trim()) {
    const hits = new Set();
    for (const n of ns) if (visible.has(String(n.id)) && matchesSearch(n, s.search)) hits.add(String(n.id));
    if (hits.size) {
      const near = nHopNeighborhood(es.filter((e) => visible.has(e.from) && visible.has(e.to)), [...hits], 1);
      const keep = new Set();
      for (const id of near.keys()) if (visible.has(id)) keep.add(id);
      for (const id of hits) keep.add(id);
      visible = keep;
    }
  }

  // 3 — focus mode isolates an N-hop neighborhood.
  let focusDist = null;
  if (s.focusId && ids.has(s.focusId)) {
    const scoped = es.filter((e) => visible.has(e.from) && visible.has(e.to));
    focusDist = nHopNeighborhood(scoped, [s.focusId], s.focusHops);
    const keep = new Set();
    for (const id of focusDist.keys()) keep.add(id);
    keep.add(s.focusId);
    visible = keep;
  }

  // 4 — edges
  const visibleEdges = [];
  const hiddenEdges = [];
  for (const e of es) {
    const key = edgeKeyOf(e);
    let show = visible.has(e.from) && visible.has(e.to);
    if (show && s.hideOutbound && e.kind === 'outbound') show = false;
    if (show && s.hideSharedInfra) {
      const fromHub = hubs.has(e.from), toHub = hubs.has(e.to);
      if (fromHub !== toHub) show = false; // fan-out edge to shared infra
    }
    (show ? visibleEdges : hiddenEdges).push({ e, key });
  }

  return {
    view: s,
    visibleNodeIds: visible,
    visibleEdgeKeys: new Set(visibleEdges.map((x) => x.key)),
    focusDist,
    counts: {
      nodesTotal: ns.length,
      nodesVisible: visible.size,
      nodesHidden: ns.length - visible.size,
      edgesTotal: es.length,
      edgesVisible: visibleEdges.length,
      edgesHidden: hiddenEdges.length,
    },
    // Facet options for the chips, with counts — built from the full graph so
    // the chip row does not flicker as filters change.
    facets: buildFacets(ns),
    byId,
  };
}

export function buildFacets(nodes) {
  const ns = safeNodes({ nodes });
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const cats = new Map(), tiers = new Map(), layers = new Map();
  for (const n of ns) {
    if (n.small) continue; // facets describe components, not resource pills
    bump(cats, String(n.category || 'other'));
    bump(tiers, tierKeyOf(n));
    bump(layers, layerKeyOf(n));
  }
  const sortCats = (a, b) => catRank(a[0]) - catRank(b[0]) || a[0].localeCompare(b[0]);
  const sortTier = (a, b) => (a[0] === 'none' ? 99 : Number(a[0])) - (b[0] === 'none' ? 99 : Number(b[0]));
  const sortLayer = (a, b) => {
    const ix = (k) => (k === 'none' ? 99 : LAYERS.indexOf(k));
    return ix(a[0]) - ix(b[0]);
  };
  return {
    categories: [...cats.entries()].sort(sortCats).map(([key, count]) => ({ key, count })),
    tiers: [...tiers.entries()].sort(sortTier).map(([key, count]) => ({ key, count })),
    layers: [...layers.entries()].sort(sortLayer).map(([key, count]) => ({ key, count })),
  };
}

// ---------------------------------------------------------------------------
// Ranking (layer assignment)
// ---------------------------------------------------------------------------

// Longest-path ranks along dependency edges (from.rank < to.rank), back-edges
// in cycles ignored. Outbound edges are soft constraints too, which fixes
// third-party targets landing in the wrong column when a node's only
// dependency edge disagrees with its ten outbound calls.
export function computeFlowRanks(data, opts = {}) {
  const { includeOutbound = true } = opts;
  const nodes = safeNodes(data);
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = safeEdges(data, ids);
  const constraints = edges.filter((e) => e.kind === 'dependency'
    || (includeOutbound && e.kind === 'outbound'));

  const preds = new Map();
  for (const e of constraints) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
  }
  const rank = new Map();
  const visiting = new Set();
  // Iterative longest-path with explicit stack (300+ node graphs must not risk
  // a recursion limit) — cycle back-edges are ignored, matching the old engine.
  const order = nodes.map((n) => String(n.id)).sort();
  for (const start of order) {
    if (rank.has(start)) continue;
    const stack = [{ id: start, i: 0, best: 0 }];
    visiting.add(start);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const ps = preds.get(top.id) || [];
      if (top.i < ps.length) {
        const p = ps[top.i++];
        if (visiting.has(p)) continue;             // back-edge inside a cycle
        if (rank.has(p)) { top.best = Math.max(top.best, rank.get(p) + 1); continue; }
        visiting.add(p);
        stack.push({ id: p, i: 0, best: 0 });
        continue;
      }
      rank.set(top.id, top.best);
      visiting.delete(top.id);
      stack.pop();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.best = Math.max(parent.best, top.best + 1);
      }
    }
  }
  for (const n of nodes) if (!rank.has(String(n.id))) rank.set(String(n.id), 0);
  return rank;
}

// Rank tightening: longest-path ranking spreads nodes as far right as possible,
// which manufactures long edges (and therefore dummies and crossings). Pull
// every node into the middle of its feasible window, repeatedly, in a fixed
// order. Pure, converges in a handful of passes, never violates from<to.
export function tightenRanks(rank, edges, opts = {}) {
  const passes = Math.max(0, Number(opts.passes ?? 4));
  const r = new Map(rank);
  const succ = new Map(), pred = new Map();
  for (const e of edges) {
    if (!r.has(e.from) || !r.has(e.to)) continue;
    if (!succ.has(e.from)) succ.set(e.from, []);
    succ.get(e.from).push(e.to);
    if (!pred.has(e.to)) pred.set(e.to, []);
    pred.get(e.to).push(e.from);
  }
  const ids = [...r.keys()].sort();
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (const id of ids) {
      const ps = pred.get(id) || [], ss = succ.get(id) || [];
      if (!ps.length && !ss.length) continue;
      let lo = -Infinity, hi = Infinity;
      for (const q of ps) if (r.get(q) !== undefined && r.get(q) < r.get(id)) lo = Math.max(lo, r.get(q) + 1);
      for (const q of ss) if (r.get(q) !== undefined && r.get(q) > r.get(id)) hi = Math.min(hi, r.get(q) - 1);
      if (lo === -Infinity && hi === Infinity) continue;
      // Sit adjacent to the denser side; with no predecessors, hug successors.
      let want;
      if (lo === -Infinity) want = hi;
      else if (hi === Infinity) want = lo;
      else want = ps.length >= ss.length ? lo : hi;
      if (!Number.isFinite(want)) continue;
      if (want !== r.get(id)) { r.set(id, want); moved = true; }
    }
    if (!moved) break;
  }
  // Re-base to 0 and close empty ranks so we never draw a blank column.
  const used = [...new Set([...r.values()])].sort((a, b) => a - b);
  const remap = new Map(used.map((v, i) => [v, i]));
  for (const [k, v] of r) r.set(k, remap.get(v));
  return r;
}

// ---------------------------------------------------------------------------
// Crossing counting
// ---------------------------------------------------------------------------

// Bilayer crossings by inversion count (merge sort) — the standard measure for
// a layered drawing, exact and O(E log E).
export function countInversions(seq) {
  const a = seq.slice();
  let count = 0;
  const buf = new Array(a.length);
  const sort = (lo, hi) => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid); sort(mid, hi);
    let i = lo, j = mid, k = lo;
    while (i < mid && j < hi) {
      if (a[i] <= a[j]) buf[k++] = a[i++];
      else { count += mid - i; buf[k++] = a[j++]; }
    }
    while (i < mid) buf[k++] = a[i++];
    while (j < hi) buf[k++] = a[j++];
    for (let t = lo; t < hi; t++) a[t] = buf[t];
  };
  sort(0, a.length);
  return count;
}

// layers: array of arrays of ids (top→bottom within each rank).
// links: [{from, to}] between consecutive layers only (dummies make that true).
export function countLayeredCrossings(layers, links) {
  const pos = new Map();
  layers.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)));
  const rankOf = new Map();
  layers.forEach((layer, r) => layer.forEach((id) => rankOf.set(id, r)));
  const byRank = new Map();
  for (const l of links) {
    const ra = rankOf.get(l.from), rb = rankOf.get(l.to);
    if (ra === undefined || rb === undefined) continue;
    const lo = Math.min(ra, rb);
    if (Math.abs(ra - rb) !== 1) continue;
    if (!byRank.has(lo)) byRank.set(lo, []);
    const [a, b] = ra < rb ? [l.from, l.to] : [l.to, l.from];
    byRank.get(lo).push([pos.get(a), pos.get(b)]);
  }
  let total = 0;
  for (const pairs of byRank.values()) {
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    total += countInversions(pairs.map((p) => p[1]));
  }
  return total;
}

// What the reader actually sees: pairs of straight node-center-to-node-center
// segments that properly cross. Works for ANY layout (so the old and new
// algorithms can be compared on the same footing). O(E²) — fine at 600 edges.
export function countGeometricCrossings(positions, edges, sizeOf) {
  const dims = sizeOf || (() => ({ w: NODE_W, h: NODE_H }));
  const segs = [];
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const p1 = positions[String(e.from)], p2 = positions[String(e.to)];
    if (!p1 || !p2) continue;
    const s1 = dims(String(e.from)) || { w: NODE_W, h: NODE_H };
    const s2 = dims(String(e.to)) || { w: NODE_W, h: NODE_H };
    segs.push({
      from: String(e.from), to: String(e.to),
      a: { x: p1.x + s1.w / 2, y: p1.y + s1.h / 2 },
      b: { x: p2.x + s2.w / 2, y: p2.y + s2.h / 2 },
    });
  }
  let count = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i], t = segs[j];
      // Edges sharing an endpoint always "meet" — that is not a crossing.
      if (s.from === t.from || s.from === t.to || s.to === t.from || s.to === t.to) continue;
      if (segmentsIntersect(s.a, s.b, t.a, t.b)) count++;
    }
  }
  return count;
}

// How many edges pass through an unrelated node's box — the "lines through
// boxes" defect, counted so tests can assert it goes down.
export function countNodeEdgeOverlaps(positions, edges, sizeOf, nodeIds) {
  const dims = sizeOf || (() => ({ w: NODE_W, h: NODE_H }));
  const ids = nodeIds || Object.keys(positions);
  let count = 0;
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const p1 = positions[String(e.from)], p2 = positions[String(e.to)];
    if (!p1 || !p2) continue;
    const s1 = dims(String(e.from)), s2 = dims(String(e.to));
    const a = { x: p1.x + s1.w / 2, y: p1.y + s1.h / 2 };
    const b = { x: p2.x + s2.w / 2, y: p2.y + s2.h / 2 };
    for (const id of ids) {
      if (id === String(e.from) || id === String(e.to)) continue;
      const p = positions[id];
      if (!p) continue;
      const s = dims(id);
      if (segIntersectsRect(a, b, { x: p.x, y: p.y, w: s.w, h: s.h })) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

const orient = (p, q, r) => {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  return v > 1e-9 ? 1 : (v < -1e-9 ? -1 : 0);
};

export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  // Proper crossing only — collinear touching is not a crossing.
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function segIntersectsRect(a, b, r) {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const c = [
    { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, c[i], c[(i + 1) % 4])) return true;
  }
  return false;
}

export function inflate(r, by) {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

// Do two node boxes overlap? (strict — touching edges are fine)
export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function findOverlaps(positions, sizeOf) {
  const dims = sizeOf || (() => ({ w: NODE_W, h: NODE_H }));
  const entries = Object.entries(positions).sort((a, b) => a[0].localeCompare(b[0]));
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const [ida, pa] = entries[i];
    const sa = dims(ida) || { w: NODE_W, h: NODE_H };
    const ra = { x: pa.x, y: pa.y, w: sa.w, h: sa.h };
    for (let j = i + 1; j < entries.length; j++) {
      const [idb, pb] = entries[j];
      const sb = dims(idb) || { w: NODE_W, h: NODE_H };
      if (boxesOverlap(ra, { x: pb.x, y: pb.y, w: sb.w, h: sb.h })) out.push([ida, idb]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Within-rank coordinate assignment: weighted isotonic regression
// ---------------------------------------------------------------------------

// Place an ordered list of boxes on one axis as close to their target centers
// as possible while keeping the order and a minimum gap. Solved exactly with
// weighted pool-adjacent-violators (isotonic regression), so:
//   * separation is guaranteed (no overlap, ever),
//   * the result is the L2-optimal straightening of the edges,
//   * it is deterministic and allocation-light.
// items: [{target, weight, size}] in order. Returns center coordinates.
export function isotonicPlace(items, gap) {
  const n = items.length;
  if (!n) return [];
  const g = Number.isFinite(gap) ? gap : 24;
  // offset_i = minimum center distance from item 0 to item i
  const offset = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    offset[i] = offset[i - 1] + items[i - 1].size / 2 + g + items[i].size / 2;
  }
  // z_i = center_i - offset_i must be non-decreasing... actually equal-or-greater:
  // center_i >= center_{i-1} + minDist  <=>  z_i >= z_{i-1}. Isotonic on z.
  const blocks = []; // {w, wv, count}
  for (let i = 0; i < n; i++) {
    const t = items[i].target - offset[i];
    const w = Math.max(1e-6, Number(items[i].weight) || 1);
    let blk = { w, wv: w * t, count: 1 };
    while (blocks.length && (blocks[blocks.length - 1].wv / blocks[blocks.length - 1].w) > (blk.wv / blk.w) - 1e-12) {
      const prev = blocks.pop();
      blk = { w: prev.w + blk.w, wv: prev.wv + blk.wv, count: prev.count + blk.count };
    }
    blocks.push(blk);
  }
  const out = new Array(n);
  let i = 0;
  for (const blk of blocks) {
    const v = blk.wv / blk.w;
    for (let k = 0; k < blk.count; k++, i++) out[i] = v + offset[i];
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = xs.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// ---------------------------------------------------------------------------
// The layered "flow" layout (Sugiyama: rank → order → coordinates)
// ---------------------------------------------------------------------------

export const FLOW_DEFAULTS = {
  sweeps: 8,          // ordering sweeps (each = one down + one up pass)
  transpose: true,    // adjacent-exchange pass after every sweep
  alignIters: 6,      // coordinate relaxation passes
  nodeGap: 24,        // min vertical gap between full nodes in a rank
  dummyGap: 12,
  rankGapMin: 96,
  rankGapMax: 260,
  dummySize: 8,
};

// Build the layered graph, inserting dummy nodes so that every link connects
// consecutive ranks. This is what stops long edges cutting through ranks.
export function buildLayeredGraph({ nodes, edges }, rank, opts = {}) {
  const o = { ...FLOW_DEFAULTS, ...opts };
  const ns = safeNodes({ nodes });
  const ids = new Set(ns.map((n) => String(n.id)));
  const es = safeEdges({ edges }, ids);
  const maxRank = Math.max(0, ...[...rank.values()]);
  const layers = [];
  for (let r = 0; r <= maxRank; r++) layers.push([]);
  const meta = new Map(); // id -> {real, size, edgeKey?}
  for (const n of ns.slice().sort(byLabel)) {
    const id = String(n.id);
    const r = rank.get(id) ?? 0;
    layers[r].push(id);
    meta.set(id, { real: true, node: n, size: sizeOfNode(n).h, width: sizeOfNode(n).w, rank: r });
  }
  const links = [];       // consecutive-rank links (with dummies)
  const chains = new Map(); // edgeKey -> [dummyIds] in rank order
  let dummySeq = 0;
  for (const e of es) {
    const r1 = rank.get(e.from) ?? 0, r2 = rank.get(e.to) ?? 0;
    const key = edgeKeyOf(e);
    if (Math.abs(r2 - r1) <= 1) {
      if (r1 !== r2) links.push({ from: e.from, to: e.to, edgeKey: key });
      continue; // same-rank edges get no chain; they are routed around
    }
    const step = r2 > r1 ? 1 : -1;
    const chain = [];
    let prev = e.from;
    for (let r = r1 + step; r !== r2; r += step) {
      const did = ` d${dummySeq++}`;
      layers[r].push(did);
      meta.set(did, { real: false, size: o.dummySize, width: o.dummySize, rank: r, edgeKey: key });
      links.push({ from: prev, to: did, edgeKey: key });
      chain.push(did);
      prev = did;
    }
    links.push({ from: prev, to: e.to, edgeKey: key });
    chains.set(key, step > 0 ? chain : chain.slice().reverse());
  }
  return { layers, links, meta, chains, edges: es, nodes: ns };
}

// Multi-sweep crossing reduction: alternating barycenter and median heuristics,
// each followed by an adjacent-transposition pass, keeping the best ordering
// seen. Deterministic: every tie falls back to the previous index, then the id.
export function orderLayers(layers, links, opts = {}) {
  const o = { ...FLOW_DEFAULTS, ...opts };
  const work = layers.map((l) => l.slice());
  const R = work.length;

  // --- integer-index everything once: the hot loops then touch typed arrays
  // only (no Map.get on strings, no per-swap allocation). -------------------
  const idNum = new Map();
  const ids = [];
  for (const layer of work) {
    for (const id of layer) {
      if (!idNum.has(id)) { idNum.set(id, ids.length); ids.push(id); }
    }
  }
  const N = ids.length;
  const rankOf = new Int32Array(N).fill(-1);
  work.forEach((layer, r) => layer.forEach((id) => { rankOf[idNum.get(id)] = r; }));
  const order = work.map((layer) => Int32Array.from(layer, (id) => idNum.get(id)));
  const posArr = new Int32Array(N);
  const reindex = () => {
    for (let r = 0; r < R; r++) {
      const arr = order[r];
      for (let i = 0; i < arr.length; i++) posArr[arr[i]] = i;
    }
  };
  reindex();

  const succ = Array.from({ length: N }, () => []);
  const pred = Array.from({ length: N }, () => []);
  const corridorPairs = Array.from({ length: Math.max(0, R - 1) }, () => []);
  for (const l of links) {
    const fa = idNum.get(l.from), fb = idNum.get(l.to);
    if (fa === undefined || fb === undefined) continue;
    const ra = rankOf[fa], rb = rankOf[fb];
    if (ra < 0 || rb < 0) continue;
    const [a, b] = ra <= rb ? [fa, fb] : [fb, fa];
    succ[a].push(b);
    pred[b].push(a);
    const lo = Math.min(ra, rb);
    if (Math.abs(ra - rb) === 1 && lo < corridorPairs.length) corridorPairs[lo].push(a, b);
  }
  const corridor = corridorPairs.map((flat) => Int32Array.from(flat));
  // reusable buffers sized to the widest corridor
  const widest = corridor.reduce((m, c) => Math.max(m, c.length / 2), 0);
  const keyBuf = new Float64Array(Math.max(1, widest));
  const secBuf = new Int32Array(Math.max(1, widest));
  const sortIdx = new Int32Array(Math.max(1, widest));
  const mergeBuf = new Int32Array(Math.max(1, widest));

  const corridorCrossings = (r) => {
    if (r < 0 || r >= corridor.length) return 0;
    const flat = corridor[r];
    const n = flat.length >> 1;
    if (n < 2) return 0;
    for (let i = 0; i < n; i++) {
      const a = posArr[flat[2 * i]], b = posArr[flat[2 * i + 1]];
      keyBuf[i] = a * 100000 + b; // stable composite sort key
      secBuf[i] = b;
      sortIdx[i] = i;
    }
    const idxView = sortIdx.subarray(0, n);
    // Array#sort on a subarray view of a typed array is a numeric sort.
    const arr = Array.prototype.slice.call(idxView);
    arr.sort((p, q) => keyBuf[p] - keyBuf[q]);
    for (let i = 0; i < n; i++) mergeBuf[i] = secBuf[arr[i]];
    // merge-sort inversion count over mergeBuf[0..n)
    let count = 0;
    const a2 = mergeBuf;
    const tmp = new Int32Array(n);
    const msort = (lo, hi) => {
      if (hi - lo < 2) return;
      const mid = (lo + hi) >> 1;
      msort(lo, mid); msort(mid, hi);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        if (a2[i] <= a2[j]) tmp[k++] = a2[i++];
        else { count += mid - i; tmp[k++] = a2[j++]; }
      }
      while (i < mid) tmp[k++] = a2[i++];
      while (j < hi) tmp[k++] = a2[j++];
      for (let t = lo; t < hi; t++) a2[t] = tmp[t];
    };
    msort(0, n);
    return count;
  };
  const totalCrossings = () => {
    let t = 0;
    for (let r = 0; r < corridor.length; r++) t += corridorCrossings(r);
    return t;
  };

  let bestX = totalCrossings();
  let best = order.map((arr) => Array.from(arr));

  const sortLayer = (r, refs, useMedian) => {
    const arr = order[r];
    if (arr.length < 2) return;
    const val = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      const rf = refs[v];
      if (!rf.length) { val[i] = posArr[v]; continue; }
      if (useMedian) {
        const xs = [];
        for (const m of rf) xs.push(posArr[m]);
        xs.sort((p, q) => p - q);
        const mid = xs.length >> 1;
        val[i] = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
      } else {
        let sum = 0;
        for (const m of rf) sum += posArr[m];
        val[i] = sum / rf.length;
      }
    }
    const withVal = Array.from(arr, (v, i) => [v, val[i], posArr[v]]);
    withVal.sort((p, q) => p[1] - q[1] || p[2] - q[2] || ids[p[0]].localeCompare(ids[q[0]]));
    for (let i = 0; i < arr.length; i++) { arr[i] = withVal[i][0]; posArr[arr[i]] = i; }
  };

  // Adjacent-exchange pass: swap neighbours whenever it strictly reduces the
  // crossings in the two corridors the swap can affect.
  const transposePass = () => {
    for (let r = 0; r < R; r++) {
      const arr = order[r];
      for (let i = 0; i + 1 < arr.length; i++) {
        const before = corridorCrossings(r - 1) + corridorCrossings(r);
        if (before === 0) continue;
        const A = arr[i], B = arr[i + 1];
        arr[i] = B; arr[i + 1] = A;
        posArr[B] = i; posArr[A] = i + 1;
        if (corridorCrossings(r - 1) + corridorCrossings(r) < before) continue;
        arr[i] = A; arr[i + 1] = B;
        posArr[A] = i; posArr[B] = i + 1;
      }
    }
  };

  // Adaptive effort: big graphs get fewer sweeps so a template switch stays
  // interactive. Callers can always pass explicit sweeps/transpose.
  const linkCount = links.length;
  const sweeps = Math.max(1, Number(
    opts.sweeps !== undefined ? opts.sweeps
      : (linkCount > 1500 ? 4 : linkCount > 600 ? 6 : o.sweeps),
  ) || 1);
  const doTranspose = opts.transpose !== undefined ? !!opts.transpose : (N <= 900);
  const transposeSweeps = linkCount > 1500 ? 1 : 3;

  for (let s = 0; s < sweeps; s++) {
    const useMedian = s % 2 === 1;
    for (let r = 1; r < R; r++) sortLayer(r, pred, useMedian);
    for (let r = R - 2; r >= 0; r--) sortLayer(r, succ, useMedian);
    if (doTranspose && s < transposeSweeps) transposePass();
    const x = totalCrossings();
    if (x < bestX) { bestX = x; best = order.map((arr) => Array.from(arr)); }
    if (bestX === 0) break;
  }
  return { layers: best.map((arr) => arr.map((v) => ids[v])), crossings: bestX };
}

// Coordinate assignment: iterate median-of-neighbors targets through the
// isotonic placer so that edges straighten without any box ever overlapping.
export function assignCoordinates(ordered, links, meta, opts = {}) {
  const o = { ...FLOW_DEFAULTS, ...opts };
  const rankOf = new Map();
  ordered.forEach((layer, r) => layer.forEach((id) => rankOf.set(id, r)));
  const succ = new Map(), pred = new Map();
  for (const l of links) {
    const ra = rankOf.get(l.from), rb = rankOf.get(l.to);
    if (ra === undefined || rb === undefined) continue;
    const [a, b] = ra <= rb ? [l.from, l.to] : [l.to, l.from];
    if (!succ.has(a)) succ.set(a, []);
    succ.get(a).push(b);
    if (!pred.has(b)) pred.set(b, []);
    pred.get(b).push(a);
  }
  const center = new Map();
  const sizeOf = (id) => (meta.get(id)?.size ?? NODE_H);
  const gapFor = (layer) => (layer.some((id) => meta.get(id)?.real) ? o.nodeGap : o.dummyGap);
  const weightOf = (id) => {
    const m = meta.get(id);
    if (!m) return 1;
    // Dummies get the highest weight so long edges come out straight; hub-ish
    // real nodes next; leaves last.
    if (!m.real) return 8;
    const d = (succ.get(id)?.length || 0) + (pred.get(id)?.length || 0);
    return 1 + Math.min(4, d * 0.5);
  };

  // seed: stacked in order
  for (const layer of ordered) {
    const items = layer.map((id) => ({ target: 0, weight: 1, size: sizeOf(id) }));
    let acc = 0;
    layer.forEach((id, i) => {
      acc += i === 0 ? sizeOf(id) / 2 : (sizeOf(layer[i - 1]) / 2 + gapFor(layer) + sizeOf(id) / 2);
      center.set(id, acc);
    });
    void items;
  }

  const relax = (refMap) => {
    for (const layer of ordered) {
      if (!layer.length) continue;
      const items = layer.map((id) => {
        const refs = (refMap.get(id) || []).map((m) => center.get(m)).filter((v) => Number.isFinite(v));
        const t = refs.length ? median(refs) : center.get(id);
        return { target: Number.isFinite(t) ? t : 0, weight: weightOf(id), size: sizeOf(id) };
      });
      const placed = isotonicPlace(items, gapFor(layer));
      layer.forEach((id, i) => center.set(id, placed[i]));
    }
  };

  const iters = Math.max(1, Number(o.alignIters) || 1);
  for (let k = 0; k < iters; k++) {
    // down pass (align to predecessors), then up pass (align to successors)
    relax(pred);
    for (let r = ordered.length - 1; r >= 0; r--) {
      const layer = ordered[r];
      if (!layer.length) continue;
      const items = layer.map((id) => {
        const refs = (succ.get(id) || []).map((m) => center.get(m)).filter((v) => Number.isFinite(v));
        const t = refs.length ? median(refs) : center.get(id);
        return { target: Number.isFinite(t) ? t : 0, weight: weightOf(id), size: sizeOf(id) };
      });
      const placed = isotonicPlace(items, gapFor(layer));
      layer.forEach((id, i) => center.set(id, placed[i]));
    }
  }
  return center;
}

// Rank X positions: separation tuned to the widest node in the rank and to how
// many edges have to fit (and be labeled) in the corridor.
export function rankXPositions(ordered, links, meta, opts = {}) {
  const o = { ...FLOW_DEFAULTS, ...opts };
  const rankOf = new Map();
  ordered.forEach((layer, r) => layer.forEach((id) => rankOf.set(id, r)));
  const between = new Array(Math.max(0, ordered.length - 1)).fill(0);
  for (const l of links) {
    const ra = rankOf.get(l.from), rb = rankOf.get(l.to);
    if (ra === undefined || rb === undefined) continue;
    const lo = Math.min(ra, rb);
    if (Math.abs(ra - rb) === 1 && lo < between.length) between[lo]++;
  }
  const widthOf = (layer) => Math.max(0, ...layer.map((id) => meta.get(id)?.width ?? NODE_W));
  const xs = [];
  let x = 0;
  for (let r = 0; r < ordered.length; r++) {
    xs.push(x);
    const w = widthOf(ordered[r]) || NODE_W;
    const density = between[r] || 0;
    const gap = Math.round(Math.max(o.rankGapMin, Math.min(o.rankGapMax, o.rankGapMin + Math.sqrt(density) * 22)));
    x += w + gap;
  }
  return xs;
}

// The whole flow pipeline. Returns positions plus the routing waypoints that
// the edge router uses to bend long edges around intervening ranks.
export function layeredFlowLayout(data, opts = {}) {
  const o = { ...FLOW_DEFAULTS, ...opts };
  const nodes = safeNodes(data);
  if (!nodes.length) return { positions: {}, waypoints: {}, crossings: 0, ranks: new Map(), layers: [] };
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = safeEdges(data, ids);

  const rank0 = computeFlowRanks({ nodes, edges });
  const rank = tightenRanks(rank0, edges.filter((e) => e.kind === 'dependency' || e.kind === 'outbound'), { passes: o.tightenPasses ?? 4 });

  const built = buildLayeredGraph({ nodes, edges }, rank, o);
  const { layers: ordered, crossings } = orderLayers(built.layers, built.links, o);
  const center = assignCoordinates(ordered, built.links, built.meta, o);
  const xs = rankXPositions(ordered, built.links, built.meta, o);

  // Normalize so the drawing starts at a small positive origin.
  let minY = Infinity;
  for (const layer of ordered) {
    for (const id of layer) {
      const m = built.meta.get(id);
      const c = center.get(id);
      if (!Number.isFinite(c)) continue;
      minY = Math.min(minY, c - (m?.size ?? NODE_H) / 2);
    }
  }
  if (!Number.isFinite(minY)) minY = 0;
  const OX = 48, OY = 48;

  const positions = {};
  const rankOfId = new Map();
  ordered.forEach((layer, r) => layer.forEach((id) => rankOfId.set(id, r)));
  for (const layer of ordered) {
    for (const id of layer) {
      const m = built.meta.get(id);
      if (!m || !m.real) continue;
      const c = center.get(id);
      const r = rankOfId.get(id);
      positions[id] = {
        x: snap(OX + xs[r]),
        y: snap(OY + (Number.isFinite(c) ? c : 0) - minY - m.size / 2),
      };
    }
  }
  // Guarantee separation survives the 8px snap: walk each rank in order and
  // push anything that got too close.
  for (const layer of ordered) {
    let prevBottom = -Infinity, prevId = null;
    for (const id of layer) {
      const m = built.meta.get(id);
      if (!m || !m.real || !positions[id]) continue;
      if (prevId !== null && positions[id].y < prevBottom + GRID) {
        positions[id].y = snap(prevBottom + GRID);
      }
      prevBottom = positions[id].y + m.size;
      prevId = id;
    }
  }

  // Waypoints for long edges: the dummy chain centers, in world coordinates.
  const waypoints = {};
  for (const [key, chain] of built.chains) {
    const pts = chain.map((did) => {
      const m = built.meta.get(did);
      const c = center.get(did);
      const r = rankOfId.get(did);
      return {
        x: OX + xs[r] + (m?.width ?? 8) / 2,
        y: OY + (Number.isFinite(c) ? c : 0) - minY,
      };
    }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length) waypoints[key] = pts;
  }

  return { positions, waypoints, crossings, ranks: rank, layers: ordered, meta: built.meta };
}

// The pre-existing 2-sweep barycenter flow layout, kept verbatim in behavior so
// tests can measure the crossing reduction the new pipeline achieves.
export function layoutFlowLegacy(data) {
  const nodes = safeNodes(data);
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = safeEdges(data, ids);
  const rank = computeFlowRanks(data, { includeOutbound: false });

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
  return positions;
}

// ---------------------------------------------------------------------------
// Template 1: category-grid — one column band per category
// ---------------------------------------------------------------------------

// Bands are ordered by CATEGORY_ORDER; within a band, members are sorted by
// tier then by the barycenter of the bands they connect to, which pulls related
// nodes level with each other and takes a chunk of crossings out for free.
export function layoutCategoryGrid(data, opts = {}) {
  const nodes = safeNodes(data);
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = safeEdges(data, ids);
  const cols = new Map();
  for (const n of nodes) {
    const cat = n.category || 'other';
    if (!cols.has(cat)) cols.set(cat, []);
    cols.get(cat).push(n);
  }
  const order = [...cols.keys()].sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b));
  const bandIndex = new Map(order.map((c, i) => [c, i]));
  const catOf = new Map(nodes.map((n) => [String(n.id), n.category || 'other']));
  const { all } = adjacency(edges);

  const COL_GAP = 84, ROW_GAP = 22, SUB_GAP = 26, MAX_ROWS = 8;
  const positions = {};
  let x0 = 48;
  for (const cat of order) {
    const members = cols.get(cat).slice().sort((a, b) => {
      const ta = num(a.tier) ?? 9, tb = num(b.tier) ?? 9;
      if (ta !== tb) return ta - tb;
      const bary = (n) => {
        const bs = (all.get(String(n.id)) || [])
          .map((m) => bandIndex.get(catOf.get(m)))
          .filter((v) => v !== undefined);
        return bs.length ? bs.reduce((s, v) => s + v, 0) / bs.length : bandIndex.get(cat);
      };
      const ba = bary(a), bb = bary(b);
      if (ba !== bb) return ba - bb;
      return byLabel(a, b);
    });
    const subCols = Math.max(1, Math.ceil(members.length / MAX_ROWS));
    const rows = Math.ceil(members.length / subCols);
    const colW = Math.max(NODE_W, ...members.map((n) => sizeOfNode(n).w));
    members.forEach((n, i) => {
      const sc = Math.floor(i / rows), row = i % rows;
      positions[String(n.id)] = {
        x: snap(x0 + sc * (colW + SUB_GAP)),
        y: snap(56 + row * (NODE_H + ROW_GAP)),
      };
    });
    x0 += subCols * colW + (subCols - 1) * SUB_GAP + COL_GAP;
  }
  void opts;
  return positions;
}

// ---------------------------------------------------------------------------
// Template 2: layer-rows — the restore layer cake, L0 top → L7 bottom
// ---------------------------------------------------------------------------

export function layoutLayerRows(data, opts = {}) {
  const nodes = safeNodes(data);
  const rows = new Map();
  for (const n of nodes) {
    const layer = LAYERS.includes(n.layer) ? n.layer : '~unlayered';
    if (!rows.has(layer)) rows.set(layer, []);
    rows.get(layer).push(n);
  }
  const order = [...LAYERS.filter((l) => rows.has(l)), ...(rows.has('~unlayered') ? ['~unlayered'] : [])];
  const X_GAP = 34, LINE_GAP = 20, ROW_GAP = 76, PER_LINE = 5;
  const positions = {};
  let y0 = 56;
  for (const layer of order) {
    const members = rows.get(layer).slice()
      .sort((a, b) => catRank(a.category) - catRank(b.category) || byLabel(a, b));
    const cellW = Math.max(NODE_W, ...members.map((n) => sizeOfNode(n).w));
    members.forEach((n, i) => {
      const line = Math.floor(i / PER_LINE), col = i % PER_LINE;
      positions[String(n.id)] = {
        x: snap(56 + col * (cellW + X_GAP)),
        y: snap(y0 + line * (NODE_H + LINE_GAP)),
      };
    });
    const lines = Math.max(1, Math.ceil(members.length / PER_LINE));
    y0 += lines * (NODE_H + LINE_GAP) + ROW_GAP;
  }
  void opts;
  return positions;
}

export const TEMPLATES = ['category-grid', 'layer-rows', 'flow'];

// Dispatcher — deterministic, returns {nodeId: {x, y}} for every node.
// `computeLayoutFull` additionally hands back waypoints/crossings for 'flow'.
export function computeLayoutFull(template, data, opts = {}) {
  const t = TEMPLATES.includes(template) ? template : 'category-grid';
  if (t === 'flow') return layeredFlowLayout(data, opts);
  const positions = t === 'layer-rows' ? layoutLayerRows(data, opts) : layoutCategoryGrid(data, opts);
  return { positions, waypoints: {}, crossings: null };
}

export function computeLayout(template, data, opts = {}) {
  return computeLayoutFull(template, data, opts).positions;
}

// ---------------------------------------------------------------------------
// Edge routing
// ---------------------------------------------------------------------------

export const ROUTE_DEFAULTS = {
  bundleGap: 13,        // perpendicular spacing between parallel edges
  bidiOffset: 11,       // extra separation for a↔b pairs
  obstaclePad: 7,
  detours: [0, 34, -34, 68, -68, 112, -112, 170, -170],
  maxObstacles: 700,    // above this, skip the obstacle scan (perf guard)
};

// Group edges that share an unordered endpoint pair so parallel and
// bidirectional edges can be fanned apart instead of drawn on top of each
// other. Deterministic: sorted by direction then edge key.
export function groupParallelEdges(edges) {
  const groups = new Map();
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const k = pairKeyOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = new Map(); // edgeKey -> {index, count, reversed, bidi}
  for (const [, list] of groups) {
    // Canonical direction = the lexicographically smaller endpoint as source.
    const canonical = list.reduce((min, e) => (String(e.from) < min ? String(e.from) : min), String(list[0].from));
    const forward = [], backward = [];
    for (const e of list) (String(e.from) === canonical ? forward : backward).push(e);
    const bidi = forward.length > 0 && backward.length > 0;
    // Bundle index is computed WITHIN a direction: same-direction parallels fan
    // apart, while the two directions of a pair are separated by routeEdge's
    // bidi offset (applied in each edge's own normal frame, so they land on
    // opposite geometric sides).
    for (const [dir, reversed] of [[forward, false], [backward, true]]) {
      const sorted = dir.slice().sort((a, b) => edgeKeyOf(a).localeCompare(edgeKeyOf(b)));
      sorted.forEach((e, i) => {
        out.set(edgeKeyOf(e), { index: i, count: sorted.length, reversed, bidi });
      });
    }
  }
  return out;
}

// Pick the two facing anchor points on the endpoint boxes.
export function edgeAnchors(p1, s1, p2, s2) {
  const a1 = s1 || { w: NODE_W, h: NODE_H };
  const a2 = s2 || { w: NODE_W, h: NODE_H };
  const c1 = { x: p1.x + a1.w / 2, y: p1.y + a1.h / 2 };
  const c2 = { x: p2.x + a2.w / 2, y: p2.y + a2.h / 2 };
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const s = dx >= 0 ? 1 : -1;
    return {
      a: { x: c1.x + s * (a1.w / 2), y: c1.y },
      b: { x: c2.x - s * (a2.w / 2), y: c2.y },
      axis: 'x', sign: s, c1, c2,
    };
  }
  const s = dy >= 0 ? 1 : -1;
  return {
    a: { x: c1.x, y: c1.y + s * (a1.h / 2) },
    b: { x: c2.x, y: c2.y - s * (a2.h / 2) },
    axis: 'y', sign: s, c1, c2,
  };
}

// Smooth path through a point list (Catmull-Rom → cubic bezier). Two points
// degrade to a straight-ish bezier, which keeps short edges crisp.
export function catmullRomPath(points, tension = 0.5) {
  const p = points.filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  if (p.length < 2) return '';
  if (p.length === 2) {
    const [a, b] = p;
    const dx = (b.x - a.x) / 2, dy = (b.y - a.y) / 2;
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const c1 = horizontal ? { x: a.x + dx, y: a.y } : { x: a.x, y: a.y + dy };
    const c2 = horizontal ? { x: b.x - dx, y: b.y } : { x: b.x, y: b.y - dy };
    return `M ${r2(a.x)} ${r2(a.y)} C ${r2(c1.x)} ${r2(c1.y)}, ${r2(c2.x)} ${r2(c2.y)}, ${r2(b.x)} ${r2(b.y)}`;
  }
  let d = `M ${r2(p[0].x)} ${r2(p[0].y)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i];
    const p1 = p[i], p2 = p[i + 1];
    const p3 = p[i + 2] || p2;
    const c1 = { x: p1.x + ((p2.x - p0.x) / 6) * tension * 2, y: p1.y + ((p2.y - p0.y) / 6) * tension * 2 };
    const c2 = { x: p2.x - ((p3.x - p1.x) / 6) * tension * 2, y: p2.y - ((p3.y - p1.y) / 6) * tension * 2 };
    d += ` C ${r2(c1.x)} ${r2(c1.y)}, ${r2(c2.x)} ${r2(c2.y)}, ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return d;
}

const r2 = (v) => Math.round(v * 100) / 100;

function polylineHitsAny(points, obstacles) {
  let hits = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    for (const r of obstacles) {
      if (segIntersectsRect(points[i], points[i + 1], r)) hits++;
    }
  }
  return hits;
}

// Route one edge. Pure: given endpoint boxes, optional waypoints (from the
// layered layout's dummy chain), bundle info and the obstacle rects of other
// nodes, return the path string plus a label anchor.
export function routeEdge(spec, opts = {}) {
  const o = { ...ROUTE_DEFAULTS, ...opts };
  const { p1, s1, p2, s2 } = spec;
  const bundle = spec.bundle || { index: 0, count: 1, reversed: false, bidi: false };
  const anchors = edgeAnchors(p1, s1, p2, s2);
  const { a, b } = anchors;

  // Perpendicular unit vector of the a→b chord.
  const vx = b.x - a.x, vy = b.y - a.y;
  const len = Math.hypot(vx, vy) || 1;
  const nx = -vy / len, ny = vx / len;

  // Bundle spread + bidirectional separation, in perpendicular units.
  const spread = bundle.count > 1
    ? (bundle.index - (bundle.count - 1) / 2) * o.bundleGap
    : 0;
  // The perpendicular normal is derived from THIS edge's chord, so it already
  // flips for the reverse direction — a constant positive offset therefore puts
  // the two directions of an a↔b pair on opposite geometric sides.
  const bidi = bundle.bidi ? o.bidiOffset : 0;
  const baseOffset = spread + bidi;

  const waypoints = Array.isArray(spec.waypoints) ? spec.waypoints.filter(Boolean) : [];
  const obstacles = Array.isArray(spec.obstacles) && spec.obstacles.length <= o.maxObstacles
    ? spec.obstacles : [];

  const build = (extra) => {
    const off = baseOffset + extra;
    const mids = waypoints.length
      ? waypoints.map((w) => ({ x: w.x + nx * off * 0.6, y: w.y + ny * off * 0.6 }))
      : (off === 0 ? [] : [{ x: (a.x + b.x) / 2 + nx * off, y: (a.y + b.y) / 2 + ny * off }]);
    return [a, ...mids, b];
  };

  let pts = build(0);
  if (obstacles.length) {
    let bestPts = pts;
    let bestHits = polylineHitsAny(pts, obstacles);
    if (bestHits > 0) {
      for (const d of o.detours) {
        if (d === 0) continue;
        const cand = build(d);
        const hits = polylineHitsAny(cand, obstacles);
        if (hits < bestHits) { bestHits = hits; bestPts = cand; }
        if (bestHits === 0) break;
      }
    }
    pts = bestPts;
  }

  const path = catmullRomPath(pts);
  // Label anchor: middle of the polyline, nudged off the line so the plate does
  // not sit on the stroke.
  const midIdx = (pts.length - 1) / 2;
  const lo = Math.floor(midIdx), hi = Math.ceil(midIdx);
  const mid = {
    x: (pts[lo].x + pts[hi].x) / 2,
    y: (pts[lo].y + pts[hi].y) / 2,
  };
  return { path, mid, points: pts };
}

// Which edge labels can be shown without colliding? Greedy by priority
// (dependency before outbound, then shorter label), reserving a plate per
// label. Pure, so it is testable and stable frame to frame.
export function selectEdgeLabels(candidates, opts = {}) {
  const maxLabels = Number.isFinite(opts.maxLabels) ? opts.maxLabels : 40;
  const plateH = opts.plateH ?? 16;
  const charW = opts.charW ?? 6.1;
  const list = candidates.slice().sort((a, b) => {
    const ka = a.kind === 'outbound' ? 1 : 0, kb = b.kind === 'outbound' ? 1 : 0;
    return ka - kb
      || String(a.label).length - String(b.label).length
      || String(a.key).localeCompare(String(b.key));
  });
  const taken = [];
  const shown = [];
  for (const c of list) {
    if (shown.length >= maxLabels) break;
    const w = Math.max(18, String(c.label).length * charW + 10);
    const rect = { x: c.mid.x - w / 2, y: c.mid.y - plateH, w, h: plateH };
    if (taken.some((t) => boxesOverlap(rect, t))) continue;
    taken.push(rect);
    shown.push(c.key);
  }
  return new Set(shown);
}

// ---------------------------------------------------------------------------
// Group containers
// ---------------------------------------------------------------------------

// Bounds for a group box. `titleBand` reserves space ABOVE the members so the
// group title can never collide with a node.
export function groupBounds(group, positions, sizeOf, opts = {}) {
  const pad = opts.pad ?? 18;
  const band = opts.titleBand ?? 26;
  const dims = sizeOf || (() => ({ w: NODE_W, h: NODE_H }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (const id of group.nodeIds || []) {
    const p = positions[String(id)];
    if (!p) continue;
    const s = dims(String(id)) || { w: NODE_W, h: NODE_H };
    count++;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  if (!count) return null;
  return {
    x: minX - pad,
    y: minY - pad - band,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2 + band,
    band,
    count,
  };
}

export function contentBounds(positions, groups, sizeOf, opts = {}) {
  const dims = sizeOf || (() => ({ w: NODE_W, h: NODE_H }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, p] of Object.entries(positions)) {
    const s = dims(id) || { w: NODE_W, h: NODE_H };
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  for (const g of groups || []) {
    const b = groupBounds(g, positions, sizeOf, opts);
    if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: NODE_W, h: NODE_H };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// Expansion helpers (kept here so the canvas module stays about rendering)
// ---------------------------------------------------------------------------

export function graphToCanvasNodes(subgraph, parentId, existingIds = []) {
  const src = subgraph && typeof subgraph === 'object'
    && subgraph.nodes && typeof subgraph.nodes === 'object' ? subgraph.nodes : {};
  const pid = String(parentId);
  const nodes = [];
  for (const [rid, n] of Object.entries(src)) {
    if (String(rid) === pid) continue;
    const type = (n && n.type) || 'other';
    nodes.push({
      id: rid,
      label: (n && n.name) || rid,
      sub: type,
      small: true,
      rtype: type,
      awsServices: n && n.service ? [n.service] : [],
    });
  }
  const present = new Set([pid]);
  for (const n of nodes) present.add(String(n.id));
  for (const id of Array.isArray(existingIds) ? existingIds : []) present.add(String(id));
  const edges = [];
  for (const e of (subgraph && Array.isArray(subgraph.edges) ? subgraph.edges : [])) {
    if (!e || e.from === undefined || e.from === null || e.to === undefined || e.to === null) continue;
    if (!present.has(String(e.from)) || !present.has(String(e.to))) continue;
    edges.push({ from: e.from, to: e.to, kind: 'dependency', label: e.relation || '' });
  }
  return { nodes, edges };
}

export function computeExpansionLayout(parent, count) {
  const out = [];
  if (!parent || !Number.isFinite(count) || count <= 0) return out;
  const px = Number(parent.x) || 0, py = Number(parent.y) || 0;
  const pw = Number.isFinite(Number(parent.w)) ? Number(parent.w) : NODE_W;
  const ph = Number.isFinite(Number(parent.h)) ? Number(parent.h) : NODE_H;
  const cx = px + pw;
  const cy = py + ph / 2;
  let placed = 0, ring = 0;
  while (placed < count) {
    const cap = 5 + ring * 3;
    const n = Math.min(cap, count - placed);
    const radius = 220 + ring * 190;
    const span = Math.min(Math.PI * 0.9, Math.max(0, n - 1) * 0.34);
    for (let i = 0; i < n; i++) {
      const ang = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      out.push({
        x: snap(cx + Math.cos(ang) * radius),
        y: snap(cy + Math.sin(ang) * radius - SMALL_H / 2),
      });
      placed++;
    }
    ring++;
  }
  return out;
}

export function collapseRemovals(expandedMap, parentId) {
  const pid = String(parentId);
  const mine = (expandedMap && expandedMap[pid]) || [];
  const others = new Set();
  for (const [k, ids] of Object.entries(expandedMap || {})) {
    if (String(k) === pid) continue;
    for (const id of Array.isArray(ids) ? ids : []) others.add(String(id));
  }
  return mine.filter((id) => !others.has(String(id)));
}

export default {
  NODE_W, NODE_H, SMALL_W, SMALL_H, GRID, LAYERS, CATEGORY_ORDER, TEMPLATES,
  computeLayout, computeLayoutFull, computeFlowRanks, tightenRanks,
  layeredFlowLayout, layoutFlowLegacy, layoutCategoryGrid, layoutLayerRows,
  buildLayeredGraph, orderLayers, assignCoordinates, rankXPositions,
  countInversions, countLayeredCrossings, countGeometricCrossings,
  countNodeEdgeOverlaps, isotonicPlace, findOverlaps, boxesOverlap,
  segmentsIntersect, segIntersectsRect, pointInRect, inflate,
  detectHubs, collapseHubEdges, shouldCollapseHubs, nHopNeighborhood,
  isSharedInfrastructure, SHARED_CATEGORIES, SHARED_RTYPES,
  dependencyFacts, applyView, normalizeView, buildFacets, matchesSearch,
  groupParallelEdges, edgeAnchors, routeEdge, catmullRomPath, selectEdgeLabels,
  groupBounds, contentBounds, safeNodes, safeEdges, edgeKeyOf, pairKeyOf,
  graphToCanvasNodes, computeExpansionLayout, collapseRemovals, sizeOfNode,
};
