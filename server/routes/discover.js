// Discovery routes: AWS CLI scan, Arpio read-only API, local AI bridge.
import { Router } from 'express';
import * as store from '../store.js';
import { listProfiles, discover, awsCliFound, SERVICE_IDS } from '../lib/aws-discovery.js';
import { scanMap, normalizeArtifact, discoveryScript } from '../lib/aws-scan-map.js';
import { mergeGraph } from '../lib/aws-enrich.js';
import { ArpioClient } from '../lib/arpio-client.js';
import { ask, suggestComponents, claudeCliFound, serializeContext } from '../lib/ai-bridge.js';

const r = Router();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function markExisting(proposals, existing) {
  const byName = new Set(existing.map((c) => norm(c.name)));
  const byKindName = new Set(existing.map((c) => `${c.kind}::${norm(c.name)}`));
  const byArn = new Set(existing.map((c) => c.arn).filter(Boolean));
  return proposals.map((p) => ({
    ...p,
    existing: byName.has(norm(p.name)) || byKindName.has(`${p.kind}::${norm(p.name)}`)
      || !!(p.arn && byArn.has(p.arn)),
  }));
}

// ---------------------------------------------------------------- AWS

r.get('/discover/aws/profiles', async (req, res, next) => {
  try {
    res.json({ profiles: listProfiles(), awsCliFound: await awsCliFound(), services: SERVICE_IDS });
  } catch (e) { next(e); }
});

r.post('/w/:ws/discover/aws', async (req, res, next) => {
  try {
    const { profile = '', region = '', services = [] } = req.body || {};
    const result = await discover({ profile, region, services });
    const existing = store.getCollection(req.params.ws, 'components');
    res.json({ ...result, proposals: markExisting(result.proposals, existing) });
  } catch (e) { next(e); }
});

// Import proposals as components. Back-compat: classic (flat) proposals are
// imported exactly as before. Extended scan-map proposals additionally
//   - persist `arn` (additive schema field — part of the flat rest spread),
//   - wire component.dependsOn from dependsOnProposals (imported keys first,
//     then existing components whose arn/name matches the key),
//   - merge each proposal's associations + associationEdges into the
//     'resource-graph' object store (nodes attributed to the new component
//     id, source 'aws-scan'; deduped by rid via mergeGraph).
r.post('/w/:ws/discover/aws/import', (req, res, next) => {
  try {
    const proposals = Array.isArray(req.body?.proposals) ? req.body.proposals : [];
    if (!proposals.length) throw store.httpError(400, 'no proposals to import');
    const ws = req.params.ws;
    const items = store.getCollection(ws, 'components');
    const preExisting = [...items];
    const now = new Date().toISOString();

    const keyToId = new Map();
    const created = []; // [{cmp, p}]
    for (const p of proposals) {
      const { existing, id, key, associations, associationEdges, dependsOnProposals, mapRef, direct, inbound, ...rest } = p || {};
      if (!rest.name) continue;
      const cmp = { ...rest, id: store.newId('cmp'), updatedAt: now };
      items.push(cmp);
      created.push({ cmp, p });
      if (key && !keyToId.has(key)) keyToId.set(key, cmp.id);
    }

    // dependsOn wiring: key -> imported component, else an existing component
    // whose arn or (normalized) name matches the key.
    const keyName = (k) => String(k || '').includes(':') && !String(k).startsWith('arn:')
      ? String(k).split(':').slice(1).join(':') : String(k || '');
    const findExisting = (depKey) => {
      for (const c of preExisting) {
        if (c.arn && c.arn === depKey) return c.id;
        if (norm(c.name) && (norm(c.name) === norm(depKey) || norm(c.name) === norm(keyName(depKey)))) return c.id;
      }
      return null;
    };
    let linked = 0;
    for (const { cmp, p } of created) {
      const deps = Array.isArray(p?.dependsOnProposals) ? p.dependsOnProposals : [];
      for (const depKey of deps) {
        const target = keyToId.get(depKey) || findExisting(depKey);
        if (!target || target === cmp.id) continue;
        cmp.dependsOn = Array.isArray(cmp.dependsOn) ? cmp.dependsOn : [];
        if (!cmp.dependsOn.includes(target)) { cmp.dependsOn.push(target); linked++; }
      }
    }
    store.saveCollection(ws, 'components', items);

    // Merge association trees into the resource graph (only touched when at
    // least one extended proposal was imported — old-shape imports never
    // create/modify resource-graph.json).
    const additions = { nodes: {}, edges: [] };
    for (const { cmp, p } of created) {
      const assocs = Array.isArray(p?.associations) ? p.associations : [];
      for (const a of assocs) {
        if (!a || !a.rid) continue;
        let n = additions.nodes[a.rid];
        if (!n) {
          n = additions.nodes[a.rid] = {
            rid: a.rid, type: a.type || 'other', service: a.service || '',
            name: a.name || a.rid, arn: a.arn || '', region: a.region || '',
            componentIds: [], details: {}, tags: {}, source: 'aws-scan',
          };
        }
        if (!n.componentIds.includes(cmp.id)) n.componentIds.push(cmp.id);
        if (a.arn && !n.arn) n.arn = a.arn;
        Object.assign(n.details, a.details || {});
        Object.assign(n.tags, a.tags || {});
        if (a.direct) {
          additions.edges.push(a.inbound
            ? { from: a.rid, to: cmp.id, relation: a.relation || 'uses' }
            : { from: cmp.id, to: a.rid, relation: a.relation || 'uses' });
        }
      }
      for (const e of Array.isArray(p?.associationEdges) ? p.associationEdges : []) {
        if (e && e.from && e.to) additions.edges.push({ from: e.from, to: e.to, relation: e.relation || 'uses' });
      }
    }
    let graphNodesAdded = 0; let graphEdgesAdded = 0;
    if (Object.keys(additions.nodes).length || additions.edges.length) {
      const existingGraph = store.getObject(ws, 'resource-graph') || {};
      const { graph, stats } = mergeGraph(existingGraph, additions);
      store.saveObject(ws, 'resource-graph', graph);
      graphNodesAdded = stats.addedNodes;
      graphEdgesAdded = stats.addedEdges;
    }

    res.json({ imported: created.length, graphNodesAdded, graphEdgesAdded, linked });
  } catch (e) { next(e); }
});

// One-pass Arpio-parity scan: proposals WITH association trees and
// cross-proposal dependency links (contract shape — see aws-scan-map.js).
r.post('/w/:ws/discover/aws/scan-map', async (req, res, next) => {
  try {
    const { profile = '', region = '', services = [], mapDependencies = true } = req.body || {};
    const result = await scanMap({
      profile: String(profile || ''), region: String(region || ''),
      services: Array.isArray(services) ? services : [],
      mapDependencies: mapDependencies !== false,
    });
    const existing = store.getCollection(req.params.ws, 'components');
    res.json({ ...result, proposals: markExisting(result.proposals, existing) });
  } catch (e) { next(e); }
});

// Downloadable READ-ONLY discovery script for environments where this box
// has no AWS credentials. ?services=a,b,c limits the capture.
r.get('/discover/aws/script', (req, res, next) => {
  try {
    const services = String(req.query.services || '').split(',')
      .map((s) => s.trim()).filter((s) => SERVICE_IDS.includes(s));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="drcompass-aws-discovery.sh"');
    res.send(discoveryScript({ services }));
  } catch (e) { next(e); }
});

// Upload the script's artifact — normalized through the SAME discoverers +
// collectors as scan-map. Review-only: nothing is imported here.
r.post('/w/:ws/discover/aws/upload', async (req, res, next) => {
  try {
    const result = await normalizeArtifact(req.body);
    const existing = store.getCollection(req.params.ws, 'components');
    res.json({ ...result, proposals: markExisting(result.proposals, existing) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- Arpio

r.post('/w/:ws/discover/arpio', async (req, res, next) => {
  try {
    // Accept the two-part key (keyId + secret) or a pre-combined
    // "keyId:secret" string; optional accountId scopes the scan.
    const keyId = String(req.body?.apiKeyId || '').trim();
    const secret = String(req.body?.apiSecret || '').trim();
    const combined = String(req.body?.apiKey || '').trim();
    const accountId = String(req.body?.accountId || '').trim();
    const apiKey = keyId && secret ? `${keyId}:${secret}` : combined;
    if (!apiKey) return res.json({ ok: false, message: 'An Arpio API key (key ID + secret) is required' });
    const client = new ArpioClient(apiKey, accountId); // key used per-request only; never persisted
    const inv = await client.inventory();
    if (!inv.ok) return res.json({ ok: false, message: inv.message, trace: inv.trace || [] });
    const existing = store.getCollection(req.params.ws, 'components');
    res.json({ ok: true, proposals: markExisting(inv.proposals, existing), message: inv.message || '', trace: inv.trace || [] });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- AI

r.get('/discover/ai/status', async (req, res, next) => {
  try {
    res.json({ claudeCliFound: await claudeCliFound() });
  } catch (e) { next(e); }
});

r.post('/w/:ws/ai/ask', async (req, res, next) => {
  try {
    const { prompt = '', includeContext = false } = req.body || {};
    let context;
    if (includeContext) {
      const workspace = store.getWorkspace(req.params.ws);
      const components = store.getCollection(req.params.ws, 'components');
      context = serializeContext({ workspace, components });
    }
    const result = await ask({ prompt, context });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/w/:ws/ai/suggest', async (req, res, next) => {
  try {
    const { freeText = '' } = req.body || {};
    const workspace = store.getWorkspace(req.params.ws);
    const components = store.getCollection(req.params.ws, 'components');
    const result = await suggestComponents({ workspace, components, freeText });
    if (result.ok && Array.isArray(result.proposals)) {
      result.proposals = markExisting(result.proposals, components);
    }
    res.json(result);
  } catch (e) { next(e); }
});

export default r;
