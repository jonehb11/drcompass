import { Router } from 'express';
import * as store from '../store.js';
// Environment / service scoping (docs/ENV-SERVICE-MODEL.md §3, §7). There is one
// definition of "adjudication in prod" and it lives in lib/scope.js — this route
// imports it rather than re-deriving anything.
import {
  scopeFromQuery, resolveScopeOrThrow, scopeCollection, scopeMeta,
} from '../lib/scope.js';

const r = Router();
const PREFIX = { components: 'cmp', runbooks: 'rbk', tests: 'tst', checklists: 'chk', gaps: 'gap', decisions: 'dec', contacts: 'per' };

// GET /w/:ws/c/:col[?envId=&serviceId=]
//
// No scope ⇒ the request never leaves the old code path, so the response is
// byte-identical to what it was before environments existed (§3). A scope ⇒ the
// collection is narrowed by lib/scope.js's rules for that collection and the
// response says what it was narrowed to.
r.get('/w/:ws/c/:col', (req, res, next) => {
  try {
    const { ws, col } = req.params;
    const items = store.getCollection(ws, col);
    const wanted = scopeFromQuery(req.query);
    if (!wanted.envId && !wanted.serviceId) { res.json({ items }); return; }

    // The workspace-wide component list is what lets scopeCollection tell a
    // DANGLING link from an out-of-scope one — an item whose only links are to
    // ids that no longer exist counts as unlinked and is KEPT, because a stale
    // id is a data-quality problem, not a reason to drop a workspace-wide
    // runbook from someone's recovery package (§7).
    const components = col === 'components' ? items : store.getCollection(ws, 'components');
    // An unknown envId/serviceId is a 404 carrying `available[]`, never an
    // empty list: silently returning zero rows for a typo is how someone
    // concludes a service has no components.
    const scope = resolveScopeOrThrow(ws, wanted, { components });
    const meta = scopeMeta(scope);
    res.json({ items: scopeCollection(col, items, scope, components), ...(meta ? { scope: meta } : {}) });
  } catch (e) { next(e); }
});

r.post('/w/:ws/c/:col', (req, res, next) => {
  try {
    const { ws, col } = req.params;
    const items = store.getCollection(ws, col);
    const item = { ...req.body, id: req.body?.id || store.newId(PREFIX[col] || 'itm'), updatedAt: new Date().toISOString() };
    items.push(item);
    store.saveCollection(ws, col, items);
    res.status(201).json(item);
  } catch (e) { next(e); }
});

r.put('/w/:ws/c/:col/:id', (req, res, next) => {
  try {
    const { ws, col, id } = req.params;
    const items = store.getCollection(ws, col);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw store.httpError(404, `no ${col} item '${id}'`);
    items[i] = { ...items[i], ...req.body, id, updatedAt: new Date().toISOString() };
    store.saveCollection(ws, col, items);
    res.json(items[i]);
  } catch (e) { next(e); }
});

r.delete('/w/:ws/c/:col/:id', (req, res, next) => {
  try {
    const { ws, col, id } = req.params;
    const items = store.getCollection(ws, col);
    const filtered = items.filter((x) => x.id !== id);
    if (filtered.length === items.length) throw store.httpError(404, `no ${col} item '${id}'`);
    store.saveCollection(ws, col, filtered);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
