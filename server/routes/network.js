// Network / firewall flow import routes.
//
// The browser parses the CSV/TSV locally and posts only the parsed cells —
// the raw export file is never uploaded anywhere, and these rows go no further
// than this local server (they are analyzed in memory and never written to
// disk; only the confirmed assignments are persisted).
import { Router } from 'express';
import * as store from '../store.js';
import {
  detectColumns, resolveMapping, aggregate, suggestSources, applyFlows,
  MAX_ROWS, MAX_COLUMNS, MAX_FLOWS, FLOW_ROLES,
} from '../lib/network-flows.js';

const r = Router();

const MAX_CELL = 512;
const MAX_ASSIGNMENTS = 20000;

// Rows arrive as string cells; numbers/nulls are tolerated and coerced.
function validateGrid(body) {
  const headers = body?.headers;
  const rows = body?.rows;
  if (!Array.isArray(headers) || !headers.length) throw store.httpError(400, 'headers must be a non-empty array');
  if (headers.length > MAX_COLUMNS) throw store.httpError(400, `too many columns: ${headers.length} (max ${MAX_COLUMNS})`);
  if (!Array.isArray(rows)) throw store.httpError(400, 'rows must be an array');
  if (rows.length > MAX_ROWS) throw store.httpError(400, `too many rows: ${rows.length} (max ${MAX_ROWS})`);

  const cleanHeaders = headers.map((hd) => {
    if (hd !== null && hd !== undefined && typeof hd === 'object') throw store.httpError(400, 'headers must be strings');
    return String(hd ?? '').slice(0, MAX_CELL);
  });
  const cleanRows = rows.map((row, i) => {
    if (!Array.isArray(row)) throw store.httpError(400, `row ${i} is not an array`);
    if (row.length > MAX_COLUMNS) throw store.httpError(400, `row ${i} has ${row.length} columns (max ${MAX_COLUMNS})`);
    return row.map((cell) => {
      if (cell !== null && cell !== undefined && typeof cell === 'object') {
        throw store.httpError(400, `row ${i} contains a non-scalar cell`);
      }
      return String(cell ?? '').slice(0, MAX_CELL);
    });
  });
  return { headers: cleanHeaders, rows: cleanRows };
}

function hasMapping(m) {
  return !!m && typeof m === 'object' && FLOW_ROLES.some((role) => m[role] !== null && m[role] !== undefined && m[role] !== '');
}

// POST /w/:ws/network/flows/analyze {headers, rows, mapping?}
//   -> {mapping, detected, confidence, roleConfidence, headers, flows,
//       sourceSuggestions, stats, truncated}
// Without `mapping` the columns are auto-detected; with one (indices or header
// names) that mapping is used verbatim so the user can correct a bad guess.
r.post('/w/:ws/network/flows/analyze', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 if missing
    const { headers, rows } = validateGrid(req.body);

    const detection = detectColumns(headers, rows.slice(0, 200));
    const manual = hasMapping(req.body?.mapping);
    const mapping = manual ? resolveMapping(req.body.mapping, headers) : detection.mapping;
    if (mapping.source === null && mapping.destination === null) {
      // Not an error — the UI shows the mapping card so the user can pick.
      return res.json({
        mapping, detected: detection.mapping, confidence: 0,
        roleConfidence: detection.roleConfidence, headers,
        flows: [], sourceSuggestions: [], truncated: false,
        stats: { rowsRead: 0, rowsSkipped: rows.length, totalFlows: 0, totalCount: 0, rowsDropped: 0 },
        warning: 'Could not tell which columns hold the source and destination — pick them below.',
      });
    }

    const agg = aggregate(rows, mapping, { maxRows: MAX_ROWS, maxFlows: MAX_FLOWS });
    const components = store.getCollection(ws, 'components');
    const k8s = store.getObject(ws, 'k8s') || null;
    const sourceSuggestions = suggestSources(agg.flows, components, k8s);

    res.json({
      mapping,
      detected: detection.mapping,
      confidence: manual ? 1 : detection.confidence,
      roleConfidence: detection.roleConfidence,
      headers,
      flows: agg.flows,
      sourceSuggestions,
      truncated: agg.truncated,
      stats: {
        rowsRead: agg.rowsRead, rowsSkipped: agg.rowsSkipped, rowsDropped: agg.rowsDropped,
        totalFlows: agg.totalFlows, returnedFlows: agg.flows.length,
        totalCount: agg.totalCount, uniqueSources: sourceSuggestions.length,
        maxFlows: MAX_FLOWS,
      },
      k8sWorkloads: Array.isArray(k8s?.workloads) ? k8s.workloads.length : 0,
    });
  } catch (e) { next(e); }
});

// POST /w/:ws/network/flows/apply {assignments}
//   assignments: [{componentId, target, type, protocol, port, purpose,
//                  critical, observedCount?, workload?}]
//   -> {componentsUpdated, callsAdded, graphNodesAdded, graphEdgesAdded, skipped}
r.post('/w/:ws/network/flows/apply', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws);
    const assignments = req.body?.assignments;
    if (!Array.isArray(assignments) || !assignments.length) {
      throw store.httpError(400, 'assignments must be a non-empty array');
    }
    if (assignments.length > MAX_ASSIGNMENTS) {
      throw store.httpError(400, `too many assignments: ${assignments.length} (max ${MAX_ASSIGNMENTS})`);
    }
    const ids = new Set(store.getCollection(ws, 'components').map((c) => c.id));
    for (const [i, a] of assignments.entries()) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw store.httpError(400, `assignment ${i} is not an object`);
      const cid = String(a.componentId || '');
      if (!cid) throw store.httpError(400, `assignment ${i}: componentId is required`);
      if (!ids.has(cid)) throw store.httpError(400, `assignment ${i}: no such component '${cid}'`);
      if (typeof a.target !== 'string' || !a.target.trim()) {
        throw store.httpError(400, `assignment ${i}: target must be a non-empty string`);
      }
      if (a.target.length > 300) throw store.httpError(400, `assignment ${i}: target too long (max 300 chars)`);
      if (a.purpose !== undefined && typeof a.purpose !== 'string') {
        throw store.httpError(400, `assignment ${i}: purpose must be a string`);
      }
      if (a.purpose && a.purpose.length > 300) throw store.httpError(400, `assignment ${i}: purpose too long (max 300 chars)`);
    }
    res.json(applyFlows({ slug: ws, assignments }));
  } catch (e) { next(e); }
});

export default r;
