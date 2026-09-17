// Deployment / recovery ORDER API.
//
//   GET  /w/:ws/deploy-order[?componentId=cmp_x]   the wave plan
//   GET  /w/:ws/deploy-order/explain/:id           why ONE item sits where it does
//   POST /w/:ws/deploy-order/ai-assist             AI suggestions for the ambiguous bits
//   POST /w/:ws/deploy-order/to-runbook            a runbook DRAFT (returned, never written)
//
// All read-only. Every ordering decision comes from server/lib/deploy-order.js,
// which is pure — this file only loads the workspace, stamps `generatedAt`, and
// shapes errors.
import { Router } from 'express';
import * as store from '../store.js';
import {
  deployOrder, explainItem, toRunbookDraft, ambiguousSubgraph,
} from '../lib/deploy-order.js';

const r = Router();

const str = (v) => (v === null || v === undefined ? '' : String(v));

// ids contain '/' and ':' (res:s3/bucket, k8s:ns/Deployment/name). Express
// decodes a single path segment for us, so an encodeURIComponent-ed id arrives
// intact; `?id=` is offered as well for callers that would rather not encode.
function wantedId(req) {
  const fromPath = str(req.params.id);
  if (fromPath) return fromPath;
  return str(req.query.id);
}

async function load(req) {
  const slug = req.params.ws;
  store.getWorkspace(slug); // 404s on an unknown workspace
  const componentId = str(req.query.componentId || req.body?.componentId);
  const result = await deployOrder(slug, { componentId });
  return { slug, result };
}

r.get('/w/:ws/deploy-order', async (req, res, next) => {
  try {
    const { result } = await load(req);
    res.json({ ...result, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

const explain = async (req, res, next) => {
  try {
    const id = wantedId(req);
    if (!id) throw store.httpError(400, 'pass the item id in the path (URL-encoded) or as ?id=');
    const { result } = await load(req);
    const out = explainItem(result, id);
    if (!out) {
      throw store.httpError(404, `no item "${id}" in this deployment order. Item ids are cmp_* for components, res:<rid> for discovered resources, k8s:<ns>/<Kind>/<name> for Kubernetes objects, ext:<slug> for external preconditions.`);
    }
    res.json({
      ...out,
      scope: result.inputs.scope,
      stats: { waveCount: result.stats.waveCount, itemCount: result.stats.itemCount },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
};
r.get('/w/:ws/deploy-order/explain/:id', explain);
r.get('/w/:ws/deploy-order/explain', explain);

r.post('/w/:ws/deploy-order/to-runbook', async (req, res, next) => {
  try {
    const { slug, result } = await load(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const workspace = store.getWorkspace(slug);
    const runbook = toRunbookDraft(result, {
      workspace,
      name: body.name, tooling: body.tooling, scenario: body.scenario, audience: body.audience,
    });
    // Counts a reader can check the draft against before trusting it. Every step
    // now carries a derived verification command and a concrete pass criterion,
    // so the useful question is no longer "how many are blank" (none are) but
    // "how much of this still needs something from me" — which is what
    // `stepsNeedingInput` and `stepsWithoutOwner` answer honestly.
    const needsInput = runbook.steps.filter((s) => /\bSUPPLY\b/.test(String(s.verify || '')));
    res.json({
      runbook,
      draft: true,
      stats: {
        steps: runbook.steps.length,
        gates: runbook.steps.filter((s) => s.gate).length,
        waves: result.stats.waveCount,
        preconditions: runbook.preconditions.length,
        stepsWithoutVerifyCommand: runbook.steps.filter((s) => !String(s.verify || '').trim()).length,
        stepsNeedingInput: needsInput.length,
        stepsWithoutOwner: runbook.steps.filter((s) => !String(s.owner || '').trim() || s.owner === 'unassigned').length,
        stepsWithoutEstimate: runbook.steps.filter((s) => s.estMinutes === null).length,
        estMinutes: runbook.steps.reduce((n, s) => n + (Number(s.estMinutes) || 0), 0) || null,
      },
      note: 'This is a DRAFT for review — nothing was written. POST it to /api/w/:ws/c/runbooks unchanged to keep it. '
        + 'Every step carries a derived VERIFICATION command and a pass criterion; none carries a create/restore command, '
        + 'because that depends on your tooling and the engine will not invent one — each step says exactly what you must supply.',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

r.post('/w/:ws/deploy-order/ai-assist', async (req, res, next) => {
  try {
    const { slug, result } = await load(req);
    const subgraph = ambiguousSubgraph(result, { limit: 60 });
    if (subgraph.empty) {
      res.json({
        ok: true, suggestions: [],
        message: 'Nothing ambiguous to ask about: no cycles, nothing unordered, and every resolvable start-up call is already ordered correctly.',
        subgraph: { nodes: 0, edges: 0 },
      });
      return;
    }
    let bridge;
    try {
      bridge = await import('../lib/ai-bridge.js');
    } catch (e) {
      throw store.httpError(501, `AI bridge unavailable: ${e.message}`);
    }
    if (typeof bridge.suggestOrdering !== 'function') {
      throw store.httpError(501, 'the AI bridge in this build has no suggestOrdering() — update server/lib/ai-bridge.js');
    }
    const out = await bridge.suggestOrdering({ slug, subgraph });
    res.json({
      ...out,
      subgraph: {
        nodes: subgraph.nodes.length, edges: subgraph.edges.length,
        cycles: subgraph.cycles.length, unordered: subgraph.unordered.length,
      },
      note: 'Suggestions only — nothing was applied. Each one names the edge it would add or remove so you can judge it yourself.',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

export default r;
