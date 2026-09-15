// Discovery routes: AWS CLI scan, Arpio read-only API, local AI bridge.
import { Router } from 'express';
import * as store from '../store.js';
import { listProfiles, discover, awsCliFound, SERVICE_IDS } from '../lib/aws-discovery.js';
import { ArpioClient } from '../lib/arpio-client.js';
import { ask, suggestComponents, claudeCliFound, serializeContext } from '../lib/ai-bridge.js';

const r = Router();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function markExisting(proposals, existing) {
  const byName = new Set(existing.map((c) => norm(c.name)));
  const byKindName = new Set(existing.map((c) => `${c.kind}::${norm(c.name)}`));
  return proposals.map((p) => ({
    ...p,
    existing: byName.has(norm(p.name)) || byKindName.has(`${p.kind}::${norm(p.name)}`),
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

r.post('/w/:ws/discover/aws/import', (req, res, next) => {
  try {
    const proposals = Array.isArray(req.body?.proposals) ? req.body.proposals : [];
    if (!proposals.length) throw store.httpError(400, 'no proposals to import');
    const ws = req.params.ws;
    const items = store.getCollection(ws, 'components');
    const now = new Date().toISOString();
    for (const p of proposals) {
      const { existing, id, ...rest } = p || {};
      if (!rest.name) continue;
      items.push({ ...rest, id: store.newId('cmp'), updatedAt: now });
    }
    store.saveCollection(ws, 'components', items);
    res.json({ imported: proposals.filter((p) => p && p.name).length });
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
    if (!inv.ok) return res.json({ ok: false, message: inv.message });
    const existing = store.getCollection(req.params.ws, 'components');
    res.json({ ok: true, proposals: markExisting(inv.proposals, existing), message: inv.message || '' });
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
