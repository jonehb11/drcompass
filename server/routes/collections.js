import { Router } from 'express';
import * as store from '../store.js';

const r = Router();
const PREFIX = { components: 'cmp', runbooks: 'rbk', tests: 'tst', checklists: 'chk', gaps: 'gap', decisions: 'dec', contacts: 'per' };

r.get('/w/:ws/c/:col', (req, res, next) => {
  try { res.json({ items: store.getCollection(req.params.ws, req.params.col) }); } catch (e) { next(e); }
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
