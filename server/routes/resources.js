// Resource graph routes: deep AWS resource-association enrichment.
// The graph lives in the workspace object store under 'resource-graph':
//   { updatedAt, nodes: {rid: node}, edges: [{from,to,relation}] }
// `from`/`to` are node rids or component ids (cmp_*).
import { Router } from 'express';
import * as store from '../store.js';
import { enrichComponents, enrichByTag, mergeGraph } from '../lib/aws-enrich.js';

const r = Router();
const GRAPH = 'resource-graph';

function loadGraph(slug) {
  const g = store.getObject(slug, GRAPH) || {};
  return { updatedAt: g.updatedAt || null, nodes: g.nodes || {}, edges: Array.isArray(g.edges) ? g.edges : [] };
}

function adjacency(edges, directed = false) {
  const adj = new Map();
  const push = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of edges) {
    push(e.from, e.to);
    if (!directed) push(e.to, e.from);
  }
  return adj;
}

function reach(adj, starts, maxHops = Infinity) {
  const dist = new Map(starts.map((s) => [s, 0]));
  const queue = [...starts];
  while (queue.length) {
    const v = queue.shift();
    const d = dist.get(v);
    if (d >= maxHops) continue;
    for (const n of adj.get(v) || []) {
      if (!dist.has(n)) { dist.set(n, d + 1); queue.push(n); }
    }
  }
  return dist;
}

// ---------------------------------------------------------------- read

// GET /w/:ws/resources/graph            -> full graph
// GET /w/:ws/resources/graph?componentId=cmp_x
//   -> subgraph within 2 hops of cmp_x + involved edges + counts.byType
r.get('/w/:ws/resources/graph', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 if missing
    const g = loadGraph(req.params.ws);
    const componentId = String(req.query.componentId || '');
    if (!componentId) return res.json(g);

    const adj = adjacency(g.edges);
    const dist = reach(adj, [componentId], 2);
    // Attribute-like leaves (an included subnet's AZ, an included listener's
    // certificate, an included node's KMS key) ride along one extra hop so the
    // detail panel tells the whole story.
    const LEAF_TYPES = new Set(['availability-zone', 'certificate', 'kms-key']);
    for (const e of g.edges) {
      if (dist.has(e.from) && !dist.has(e.to) && g.nodes[e.to] && LEAF_TYPES.has(g.nodes[e.to].type)) {
        dist.set(e.to, 3);
      }
    }
    const nodes = {};
    for (const [rid, n] of Object.entries(g.nodes)) if (dist.has(rid)) nodes[rid] = n;
    const inScope = (v) => dist.has(v) && (nodes[v] || v.startsWith('cmp_'));
    const edges = g.edges.filter((e) => inScope(e.from) && inScope(e.to));
    const byType = {};
    for (const n of Object.values(nodes)) byType[n.type] = (byType[n.type] || 0) + 1;
    res.json({ updatedAt: g.updatedAt, componentId, nodes, edges, counts: { byType } });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- enrich

function runStats(existing, additions) {
  const { graph, stats } = mergeGraph(existing, additions);
  return { graph, stats };
}

// POST /w/:ws/resources/enrich {componentIds?, profile, region}
// componentIds default: all components with awsServices.
r.post('/w/:ws/resources/enrich', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const { componentIds = [], profile = '', region = '' } = req.body || {};
    const result = await enrichComponents({
      slug: ws,
      componentIds: Array.isArray(componentIds) ? componentIds : [],
      profile: String(profile || ''), region: String(region || ''),
    });
    const { graph, stats } = runStats(loadGraph(ws), result);
    store.saveObject(ws, GRAPH, graph);
    res.json({ ...stats, perComponent: result.perComponent, log: result.log, errors: result.errors });
  } catch (e) { next(e); }
});

// POST /w/:ws/resources/enrich-by-tag {profile, region, tagKey, tagValue}
r.post('/w/:ws/resources/enrich-by-tag', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const { profile = '', region = '', tagKey = '', tagValue = '' } = req.body || {};
    const result = await enrichByTag({
      slug: ws, profile: String(profile || ''), region: String(region || ''),
      tagKey: String(tagKey || ''), tagValue: String(tagValue || ''),
    });
    const { graph, stats } = runStats(loadGraph(ws), result);
    store.saveObject(ws, GRAPH, graph);
    res.json({ ...stats, perComponent: result.perComponent, log: result.log, errors: result.errors });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- delete

// DELETE /w/:ws/resources/graph?componentId=cmp_x
//   -> remove that component's edges + nodes that only existed for it.
// DELETE /w/:ws/resources/graph  -> clear the whole graph.
r.delete('/w/:ws/resources/graph', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const componentId = String(req.query.componentId || '');
    const g = loadGraph(ws);
    if (!componentId) {
      const removedNodes = Object.keys(g.nodes).length;
      const removedEdges = g.edges.length;
      store.saveObject(ws, GRAPH, { updatedAt: new Date().toISOString(), nodes: {}, edges: [] });
      return res.json({ cleared: true, removedNodes, removedEdges });
    }

    // Directed reach (component -> resource -> sub-resource) marks the
    // territory that belonged to this component before deletion.
    const before = reach(adjacency(g.edges, true), [componentId]);

    const edges = g.edges.filter((e) => e.from !== componentId && e.to !== componentId);
    const removedEdges = g.edges.length - edges.length;
    for (const n of Object.values(g.nodes)) {
      n.componentIds = (n.componentIds || []).filter((id) => id !== componentId);
    }

    // Anchors that keep nodes alive: any other component still present in
    // edges or in a node's componentIds.
    const anchors = new Set();
    for (const e of edges) {
      if (String(e.from).startsWith('cmp_') && e.from !== componentId) anchors.add(e.from);
      if (String(e.to).startsWith('cmp_') && e.to !== componentId) anchors.add(e.to);
    }
    for (const [rid, n] of Object.entries(g.nodes)) if ((n.componentIds || []).length) anchors.add(rid);
    const keep = reach(adjacency(edges, true), [...anchors]);

    const removedNodes = [];
    for (const rid of Object.keys(g.nodes)) {
      if (before.has(rid) && !keep.has(rid)) { removedNodes.push(rid); delete g.nodes[rid]; }
    }
    const isPresent = (v) => g.nodes[v] || String(v).startsWith('cmp_');
    const finalEdges = edges.filter((e) => isPresent(e.from) && isPresent(e.to));

    store.saveObject(ws, GRAPH, { updatedAt: new Date().toISOString(), nodes: g.nodes, edges: finalEdges });
    res.json({ componentId, removedNodes: removedNodes.length, removedEdges: removedEdges + (edges.length - finalEdges.length) });
  } catch (e) { next(e); }
});

export default r;
