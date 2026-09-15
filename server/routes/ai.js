// AI copilot routes: propose workspace operations from an instruction, apply
// a user-approved subset. Pre-mounted at /api by server/index.js.
import { Router } from 'express';
import * as store from '../store.js';
import { propose, claudeCliFound, validateOperations } from '../lib/ai-bridge.js';

const r = Router();
const PREFIX = { components: 'cmp', runbooks: 'rbk', tests: 'tst', checklists: 'chk', gaps: 'gap', decisions: 'dec', contacts: 'per' };

r.get('/ai/status', async (req, res, next) => {
  try { res.json({ claudeCliFound: await claudeCliFound() }); } catch (e) { next(e); }
});

r.post('/w/:ws/ai/propose', async (req, res, next) => {
  try {
    const { instruction, page } = req.body || {};
    if (!instruction || !String(instruction).trim()) throw store.httpError(400, 'instruction required');
    store.getWorkspace(req.params.ws); // 404 if missing
    res.json(await propose({ slug: req.params.ws, instruction: String(instruction), page: page ? String(page) : '' }));
  } catch (e) { next(e); }
});

// Apply ONLY the operations the client sends (the approved subset). Each op is
// re-validated against the live workspace and applied independently — one bad
// op never blocks the rest.
r.post('/w/:ws/ai/apply', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const ops = Array.isArray(req.body?.operations) ? req.body.operations : [];
    const applied = [];
    const errors = [];
    for (const raw of ops) {
      const label = `${raw?.op || '?'} ${raw?.collection || ''} ${raw?.id || ''}`.trim();
      try {
        const [op] = validateOperations(ws, [raw]); // fresh validation per op
        if (!op.valid) { errors.push(`${label}: ${op.problem}`); continue; }
        if (op.op === 'update-workspace') {
          const meta = store.saveWorkspace(ws, op.data);
          applied.push({ op: 'update-workspace', collection: 'workspace', id: ws, name: meta.name || ws });
        } else if (op.op === 'create') {
          const items = store.getCollection(ws, op.collection);
          const item = { ...op.data, id: store.newId(PREFIX[op.collection] || 'itm'), updatedAt: new Date().toISOString() };
          items.push(item);
          store.saveCollection(ws, op.collection, items);
          applied.push({ op: 'create', collection: op.collection, id: item.id, name: item.name || item.title || item.id });
        } else if (op.op === 'update') {
          const items = store.getCollection(ws, op.collection);
          const i = items.findIndex((x) => x.id === op.id);
          items[i] = { ...items[i], ...op.data, id: op.id, updatedAt: new Date().toISOString() };
          store.saveCollection(ws, op.collection, items);
          applied.push({ op: 'update', collection: op.collection, id: op.id, name: items[i].name || items[i].title || op.id });
        } else if (op.op === 'delete') {
          const items = store.getCollection(ws, op.collection);
          const victim = items.find((x) => x.id === op.id);
          store.saveCollection(ws, op.collection, items.filter((x) => x.id !== op.id));
          applied.push({ op: 'delete', collection: op.collection, id: op.id, name: victim?.name || victim?.title || op.id });
        } else {
          errors.push(`${label}: unsupported op`);
        }
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      }
    }
    res.json({ applied, errors });
  } catch (e) { next(e); }
});

export default r;
