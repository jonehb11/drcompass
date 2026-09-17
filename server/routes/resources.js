// Resource graph routes: deep AWS resource-association enrichment.
// The graph lives in the workspace object store under 'resource-graph':
//   { updatedAt, nodes: {rid: node}, edges: [{from,to,relation}] }
// `from`/`to` are node rids or component ids (cmp_*).
import { Router } from 'express';
import * as store from '../store.js';
import {
  enrichComponents, enrichByTag, mergeGraph, normalizeTagFilters, resolveEnvScope,
} from '../lib/aws-enrich.js';

const r = Router();
const GRAPH = 'resource-graph';

// Exported (additive) for the background-jobs route, which must produce
// byte-compatible results for the same operations.
export function loadGraph(slug) {
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
// GET /w/:ws/resources/graph?envId=env_prod[&serviceId=svc_x]
//   -> the same graph narrowed to the components of that environment/service
//      (contract §3). No scope -> today's behaviour, byte-identical.
r.get('/w/:ws/resources/graph', async (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws); // 404 if missing
    const g = loadGraph(req.params.ws);
    const componentId = String(req.query.componentId || '');
    const envId = String(req.query.envId || '');
    const serviceId = String(req.query.serviceId || '');

    if (!componentId && (envId || serviceId)) {
      const env = envId ? await resolveEnvScope(req.params.ws, envId) : null; // 404 on unknown
      const components = store.getCollection(req.params.ws, 'components');
      const inScope = components.filter((c) => (!env || c.envId === env.envId)
        && (!serviceId || c.serviceId === serviceId));
      if (serviceId && !components.some((c) => c.serviceId === serviceId)) {
        throw store.httpError(404, `unknown service '${serviceId}' — no component belongs to it`);
      }
      const ids = new Set(inScope.map((c) => c.id));
      const dist = reach(adjacency(g.edges, true), [...ids]);
      const nodes = {};
      for (const [rid, n] of Object.entries(g.nodes)) {
        const attributed = (n.componentIds || []).some((id) => ids.has(id));
        if (attributed || dist.has(rid)) nodes[rid] = n;
      }
      const present = (v) => !!nodes[v] || ids.has(v);
      const edges = g.edges.filter((e) => present(e.from) && present(e.to));
      const byType = {};
      for (const n of Object.values(nodes)) byType[n.type] = (byType[n.type] || 0) + 1;
      return res.json({
        updatedAt: g.updatedAt, nodes, edges, counts: { byType },
        scope: {
          envId: env ? env.envId : null, envName: env ? env.envName : null,
          serviceId: serviceId || null,
          serviceName: serviceId ? ((inScope[0] && inScope[0].serviceName) || serviceId) : null,
          componentCount: inScope.length,
        },
      });
    }

    // ?summary=1 — counts only. The Discover status strip needs four numbers;
    // shipping a multi-thousand-node graph to the browser for that is waste.
    if (!componentId && /^(1|true|yes)$/i.test(String(req.query.summary || ''))) {
      const nodes = Object.values(g.nodes || {});
      const byType = {};
      let linked = 0;
      const componentsWithResources = new Set();
      for (const n of nodes) {
        if (!n) continue;
        byType[n.type || 'other'] = (byType[n.type || 'other'] || 0) + 1;
        const ids = Array.isArray(n.componentIds) ? n.componentIds.filter(Boolean) : [];
        if (ids.length) { linked += 1; ids.forEach((id) => componentsWithResources.add(id)); }
      }
      return res.json({
        summary: true,
        updatedAt: g.updatedAt || null,
        nodeCount: nodes.length,
        edgeCount: (g.edges || []).length,
        linkedCount: linked,
        unlinkedCount: nodes.length - linked,
        componentsWithResources: componentsWithResources.size,
        byType,
      });
    }

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

// POST /w/:ws/resources/enrich {componentIds?, profile, region, target?, envId?}
// componentIds default: all components with awsServices (or an arn).
// target: 'arpio' — the Arpio-first overlay: only components tagged 'arpio'
// or carrying an arn with an arpio-* replication mechanism are enriched
// (exact describes against known ARNs; no account scan). 'all'/absent —
// existing behavior. Response gains `targeted: n` for the arpio overlay.
// envId (body or ?envId=) scopes the run to one environment: its components,
// its awsProfile, its primary region (contract §3/§4). Unknown id -> 404.
// Enrichment also writes component.resourceDetails — the per-component view
// of the same associations, each with its derived facts.
r.post('/w/:ws/resources/enrich', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const { componentIds = [], profile = '', region = '', target } = req.body || {};
    const envId = String((req.body && req.body.envId) || req.query.envId || '');
    if (target !== undefined && target !== null && !['arpio', 'all', ''].includes(String(target))) {
      throw store.httpError(400, "target must be 'arpio' or 'all'");
    }
    const result = await enrichComponents({
      slug: ws,
      componentIds: Array.isArray(componentIds) ? componentIds : [],
      profile: String(profile || ''), region: String(region || ''),
      target: String(target || ''), envId,
    });
    const { graph, stats } = runStats(loadGraph(ws), result);
    store.saveObject(ws, GRAPH, graph);
    const out = {
      ...stats, perComponent: result.perComponent, log: result.log, errors: result.errors,
      resourceDetails: Object.fromEntries(
        Object.entries(result.resourceDetails || {}).map(([id, list]) => [id, list.length])),
      followUpCalls: result.followUpCalls,
      followUpCapped: result.followUpCapped,
    };
    if (result.scope) out.scope = result.scope;
    if (result.targeted !== undefined) out.targeted = result.targeted;
    res.json(out);
  } catch (e) { next(e); }
});

// GET /w/:ws/resources/component/:id
//   -> the per-component dropdown, straight off the component:
//      {componentId, name, checkedAt, count, resources: [...resourceDetails]}
// Sourced from component.resourceDetails (what enrichment attached), with the
// graph consulted only to say whether the two views still agree.
r.get('/w/:ws/resources/component/:id', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const c = store.getCollection(ws, 'components').find((x) => x.id === req.params.id);
    if (!c) throw store.httpError(404, `unknown component '${req.params.id}'`);
    const resources = Array.isArray(c.resourceDetails) ? c.resourceDetails : [];
    const g = loadGraph(ws);
    const missingFromGraph = resources.filter((r) => !g.nodes[r.rid]).map((r) => r.rid);
    res.json({
      componentId: c.id,
      name: c.name || c.id,
      envId: c.envId === undefined ? null : c.envId,
      checkedAt: resources.length ? resources[0].checkedAt : null,
      count: resources.length,
      factCount: resources.reduce((n, r) => n + ((r.facts || []).length), 0),
      resources,
      agreesWithGraph: missingFromGraph.length === 0,
      missingFromGraph,
    });
  } catch (e) { next(e); }
});

// POST /w/:ws/resources/enrich-by-tag
//   {profile, region, tags: [{key, values: [...]}], proposeComponents?}
// Back-compat: {tagKey, tagValue} still accepted (converted to the list
// form). tags = AND across keys, values = OR within a key, exactly the
// resourcegroupstaggingapi --tag-filters semantics. Invalid filters -> 400.
// With proposeComponents:true, component-worthy matches also come back as
// Component-shaped `proposals` (arn set, `existing` deduped by arn/name),
// importable through the existing /discover/aws/import endpoint.
// Returns {addedNodes, updatedNodes, addedEdges, matched, proposals?,
//   perComponent, log, errors}.
r.post('/w/:ws/resources/enrich-by-tag', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const { profile = '', region = '', tags, tagKey = '', tagValue = '', proposeComponents = false } = req.body || {};
    const envId = String((req.body && req.body.envId) || req.query.envId || '');
    const filters = normalizeTagFilters({ tags, tagKey, tagValue }); // throws 400 on invalid filters
    const result = await enrichByTag({
      slug: ws, profile: String(profile || ''), region: String(region || ''),
      tags: filters.length ? filters : undefined,
      tagKey: String(tagKey || ''), tagValue: String(tagValue || ''),
      proposeComponents: !!proposeComponents, envId,
    });
    const { graph, stats } = runStats(loadGraph(ws), result);
    store.saveObject(ws, GRAPH, graph);
    const out = { ...stats, matched: result.matched, perComponent: result.perComponent, log: result.log, errors: result.errors };
    if (result.scope) out.scope = result.scope;
    if (result.proposals) out.proposals = result.proposals;
    res.json(out);
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
