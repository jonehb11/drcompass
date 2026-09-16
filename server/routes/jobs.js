// Background discovery jobs — POST to start, poll for progress, fetch the
// result when done. Each kind wraps one of the existing sync operations and
// replicates that route's post-processing EXACTLY (same lib functions, same
// store writes), so a job's `result` is byte-compatible with the sync
// endpoint's response for the same params. See server/lib/jobs.js for the
// engine (registry, heartbeat, persistence, caps).
//
//   POST /api/w/:ws/jobs {kind, params}   -> 201 {jobId, kind, startedAt}
//        unknown kind / invalid params    -> 400 {error}
//        duplicate (ws, kind) running     -> 409 {error, jobId}
//   GET  /api/w/:ws/jobs                  -> {jobs:[summaries, newest-first]}
//   GET  /api/w/:ws/jobs/:id              -> full job view with progress
//   GET  /api/w/:ws/jobs/:id/result       -> just the result (404 until done)
import { Router } from 'express';
import * as store from '../store.js';
import { startJob, getJob, listJobs, jobView } from '../lib/jobs.js';
import { discover } from '../lib/aws-discovery.js';
import { scanMap } from '../lib/aws-scan-map.js';
import { enrichComponents, enrichByTag, mergeGraph, normalizeTagFilters } from '../lib/aws-enrich.js';
import { ArpioClient } from '../lib/arpio-client.js';
import { scan as k8sScan, autoLink } from '../lib/k8s-discovery.js';
import { markExisting } from './discover.js';
import { summarize as k8sSummarize } from './k8s.js';
import { loadGraph } from './resources.js';

const r = Router();
const GRAPH = 'resource-graph';

// ------------------------------------------------------------ param helpers

const bad = (msg) => store.httpError(400, msg);

function optStr(v, name) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${name} must be a string`);
  return String(v);
}
function optArr(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${name} must be an array`);
  return v;
}

// Mirrors k8s-discovery's own charset guard so malformed names 400 at POST
// time (like the sync route) instead of becoming error jobs.
const K8S_NAME_RE = /^[a-zA-Z0-9._@:\/-]+$/;

// ------------------------------------------------------------ job kinds
// Each entry: (ws, params) -> { startLine, run(onLog) -> result, summarize }.
// Validation throws 400-shaped errors; `run` replicates the sync route.

const KINDS = {

  // POST /w/:ws/discover/aws — discover() + markExisting
  'aws-scan': (ws, p) => {
    const profile = optStr(p.profile, 'profile');
    const region = optStr(p.region, 'region');
    const services = optArr(p.services, 'services');
    const authVia = optStr(p.authVia, 'authVia');
    return {
      startLine: `started aws-scan (profile ${profile || 'default'}, region ${region || '(none)'}, ${services.length || 'all'} services)`,
      run: async (onLog) => {
        const result = await discover({ profile, region, services, authVia, onLog });
        const existing = store.getCollection(ws, 'components');
        return { ...result, proposals: markExisting(result.proposals, existing) };
      },
      summarize: (res) => `${(res.proposals || []).length} proposals, ${(res.errors || []).length} errors`,
    };
  },

  // POST /w/:ws/discover/aws/scan-map — scanMap() + markExisting
  'aws-scan-map': (ws, p) => {
    const profile = optStr(p.profile, 'profile');
    const region = optStr(p.region, 'region');
    const services = optArr(p.services, 'services');
    const mapDependencies = p.mapDependencies !== false;
    const authVia = optStr(p.authVia, 'authVia');
    return {
      startLine: `started aws-scan-map (profile ${profile || 'default'}, region ${region || '(none)'}, ${services.length || 'all'} services${mapDependencies ? '' : ', no dependency mapping'})`,
      run: async (onLog) => {
        const result = await scanMap({
          profile: String(profile || ''), region: String(region || ''),
          services: Array.isArray(services) ? services : [],
          mapDependencies, authVia, onLog,
        });
        const existing = store.getCollection(ws, 'components');
        return { ...result, proposals: markExisting(result.proposals, existing) };
      },
      summarize: (res) => `${(res.proposals || []).length} proposals, ${(res.errors || []).length} errors`,
    };
  },

  // POST /w/:ws/resources/enrich — enrichComponents() + graph merge/save
  'enrich': (ws, p) => {
    const componentIds = optArr(p.componentIds, 'componentIds');
    const profile = optStr(p.profile, 'profile');
    const region = optStr(p.region, 'region');
    const target = p.target;
    const authVia = optStr(p.authVia, 'authVia');
    if (target !== undefined && target !== null && !['arpio', 'all', ''].includes(String(target))) {
      throw bad("target must be 'arpio' or 'all'");
    }
    return {
      startLine: `started enrich (profile ${profile || 'default'}, region ${region || '(none)'}, ${componentIds.length || 'all AWS-linked'} components${target ? `, target ${target}` : ''})`,
      run: async (onLog) => {
        const result = await enrichComponents({
          slug: ws,
          componentIds: Array.isArray(componentIds) ? componentIds : [],
          profile: String(profile || ''), region: String(region || ''),
          target: String(target || ''), authVia, onLog,
        });
        const { graph, stats } = mergeGraph(loadGraph(ws), result);
        store.saveObject(ws, GRAPH, graph);
        const out = { ...stats, perComponent: result.perComponent, log: result.log, errors: result.errors };
        if (result.targeted !== undefined) out.targeted = result.targeted;
        return out;
      },
      summarize: (res) => (res.targeted !== undefined
        ? `targeted ${res.targeted}, added ${res.addedNodes} nodes`
        : `${(res.perComponent || []).length} components enriched, added ${res.addedNodes} nodes, ${(res.errors || []).length} errors`),
    };
  },

  // POST /w/:ws/resources/enrich-by-tag — enrichByTag() + graph merge/save
  'enrich-by-tag': (ws, p) => {
    const profile = optStr(p.profile, 'profile');
    const region = optStr(p.region, 'region');
    const tagKey = optStr(p.tagKey, 'tagKey');
    const tagValue = optStr(p.tagValue, 'tagValue');
    const proposeComponents = !!p.proposeComponents;
    const authVia = optStr(p.authVia, 'authVia');
    const filters = normalizeTagFilters({ tags: p.tags, tagKey, tagValue }); // throws 400 on invalid filters
    const filterDesc = filters.map((f) => `${f.key}=${f.values.join('|')}`).join(' AND ');
    return {
      startLine: `started enrich-by-tag (profile ${profile || 'default'}, region ${region || '(none)'}, ${filterDesc || 'no tag filters'}${proposeComponents ? ', proposing components' : ''})`,
      run: async (onLog) => {
        const result = await enrichByTag({
          slug: ws, profile: String(profile || ''), region: String(region || ''),
          tags: filters.length ? filters : undefined,
          tagKey: String(tagKey || ''), tagValue: String(tagValue || ''),
          proposeComponents, authVia, onLog,
        });
        const { graph, stats } = mergeGraph(loadGraph(ws), result);
        store.saveObject(ws, GRAPH, graph);
        const out = { ...stats, matched: result.matched, perComponent: result.perComponent, log: result.log, errors: result.errors };
        if (result.proposals) out.proposals = result.proposals;
        return out;
      },
      summarize: (res) => (res.proposals
        ? `matched ${res.matched}, ${res.proposals.length} proposals, added ${res.addedNodes} nodes`
        : `matched ${res.matched}, added ${res.addedNodes} nodes, ${(res.errors || []).length} errors`),
    };
  },

  // POST /w/:ws/discover/arpio — ArpioClient inventory + markExisting.
  // The API key lives ONLY in this closure for the life of the run — it is
  // never placed on the job record, progress lines, or persisted results
  // (trace lines from the client contain no key material by design).
  'arpio': (ws, p) => {
    const keyId = String(p.apiKeyId || '').trim();
    const secret = String(p.apiSecret || '').trim();
    const combined = String(p.apiKey || '').trim();
    const accountId = String(p.accountId || '').trim();
    const apiKey = keyId && secret ? `${keyId}:${secret}` : combined;
    if (!apiKey) throw bad('An Arpio API key (key ID + secret) is required');
    return {
      startLine: `started arpio (account ${accountId || '(all accessible)'})`,
      run: async (onLog) => {
        const client = new ArpioClient(apiKey, accountId); // key used per-request only; never persisted
        const inv = await client.inventory({ onLog });
        if (!inv.ok) return { ok: false, message: inv.message, trace: inv.trace || [] };
        const existing = store.getCollection(ws, 'components');
        return { ok: true, proposals: markExisting(inv.proposals, existing), message: inv.message || '', trace: inv.trace || [] };
      },
      summarize: (res) => (res.ok
        ? `${(res.proposals || []).length} proposals from Arpio`
        : `Arpio: ${String(res.message || 'failed').slice(0, 150)}`),
    };
  },

  // POST /w/:ws/k8s/scan — scan() + autoLink + save. A scan that yields no
  // snapshot (kubectl missing / unreachable context) becomes an ERROR job
  // (there is no snapshot to store or render); its log still streams into
  // progress and the reason lands in `error`.
  'k8s-scan': (ws, p) => {
    const context = optStr(p.context, 'context').trim();
    const namespaces = optArr(p.namespaces, 'namespaces').map((n) => String(n || '').trim()).filter(Boolean);
    if (context && !K8S_NAME_RE.test(context)) throw bad(`invalid context name: ${context}`);
    for (const ns of namespaces) {
      if (!K8S_NAME_RE.test(ns)) throw bad(`invalid namespace name: ${ns}`);
    }
    return {
      startLine: `started k8s-scan (context ${context || '(current)'}, ${namespaces.length || 'all'} namespaces)`,
      run: async (onLog) => {
        const { snapshot, log, errors } = await k8sScan({ context, namespaces, onLog });
        if (!snapshot) {
          throw new Error(errors[errors.length - 1] || 'k8s scan produced no snapshot');
        }
        const components = store.getCollection(ws, 'components');
        const linked = autoLink(snapshot, components);
        store.saveObject(ws, 'k8s', snapshot);
        return { summary: k8sSummarize(snapshot, linked), log, errors };
      },
      summarize: (res) => `${res.summary.workloads} workloads, ${res.summary.namespaces} namespaces${res.summary.linked ? `, ${res.summary.linked} linked` : ''}`,
    };
  },
};

// ------------------------------------------------------------ routes

r.post('/w/:ws/jobs', (req, res, next) => {
  try {
    const ws = req.params.ws;
    store.getWorkspace(ws); // 404 before starting anything
    const { kind, params } = req.body || {};
    const make = KINDS[kind];
    if (!make) {
      throw bad(`unknown job kind: ${String(kind || '(none)')} — expected one of ${Object.keys(KINDS).join(', ')}`);
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      throw bad('params must be an object');
    }
    const spec = make(ws, params || {}); // throws 400 on invalid params shape
    const out = startJob({ ws, kind, ...spec });
    if (out.conflict) {
      return res.status(409).json({
        error: `a ${kind} job is already running in this workspace — poll it or wait for it to finish`,
        jobId: out.conflict.id,
      });
    }
    res.status(201).json({ jobId: out.job.id, kind, startedAt: out.job.startedAt });
  } catch (e) { next(e); }
});

r.get('/w/:ws/jobs', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    res.json({ jobs: listJobs(req.params.ws) });
  } catch (e) { next(e); }
});

r.get('/w/:ws/jobs/:id', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const job = getJob(req.params.ws, req.params.id);
    if (!job) throw store.httpError(404, 'unknown job (the server may have restarted while it ran)');
    res.json(jobView(job));
  } catch (e) { next(e); }
});

r.get('/w/:ws/jobs/:id/result', (req, res, next) => {
  try {
    store.getWorkspace(req.params.ws);
    const job = getJob(req.params.ws, req.params.id);
    if (!job) throw store.httpError(404, 'unknown job (the server may have restarted while it ran)');
    if (job.status === 'running') throw store.httpError(404, 'job still running — no result yet');
    if (job.status === 'error') throw store.httpError(404, `job failed: ${job.error}`);
    res.json(job.result);
  } catch (e) { next(e); }
});

export default r;
