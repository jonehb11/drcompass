// Background discovery jobs — POST to start, poll for progress, fetch the
// result when done. Each kind wraps one of the existing sync operations and
// replicates that route's post-processing EXACTLY (same lib functions, same
// store writes), so a job's `result` is byte-compatible with the sync
// endpoint's response for the same params. See server/lib/jobs.js for the
// engine (registry, heartbeat, persistence, caps).
//
//   POST /api/w/:ws/jobs {kind, params}   -> 201 {jobId, kind, envId, startedAt}
//        unknown kind / invalid params    -> 400 {error}
//        unknown params.envId             -> 404 {error}
//        duplicate (ws, kind, envId)      -> 409 {error, jobId}
//   GET  /api/w/:ws/jobs[?envId=]         -> {jobs:[summaries, newest-first]}
//   GET  /api/w/:ws/jobs/:id              -> full job view with progress
//   GET  /api/w/:ws/jobs/:id/result       -> just the result (404 until done)
//
// ENVIRONMENTS: every kind takes `params.envId`. It decides which account the
// run happens in (profile/region/kube-context default to that environment's),
// what the result is tagged with, and which running job it can collide with —
// a prod scan and a dev scan never block each other. No envId ⇒ everything
// below behaves exactly as it did before environments existed.
import { Router } from 'express';
import * as store from '../store.js';
import { startJob, getJob, listJobs, jobView } from '../lib/jobs.js';
import { discover } from '../lib/aws-discovery.js';
import { scanMap } from '../lib/aws-scan-map.js';
import { enrichComponents, enrichByTag, mergeGraph, normalizeTagFilters } from '../lib/aws-enrich.js';
import { ArpioClient } from '../lib/arpio-client.js';
import { scan as k8sScan, autoLink } from '../lib/k8s-discovery.js';
import {
  resolveDiscoveryEnv, envConnection, envScope, reviewProposals, tagProposals,
} from './discover.js';
import { summarize as k8sSummarize, writeSnapshot } from './k8s.js';
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
// Each entry: (ws, params, env) -> { startLine, run(onLog) -> result,
// summarize }, where `env` is the resolved environment (or null when the run
// is unscoped). Validation throws 400-shaped errors; `run` replicates the
// sync route, including its environment handling, so a job's result stays
// byte-compatible with the synchronous endpoint for the same params.

// " in prod (profile acme-prod, region us-east-1)" — or nothing at all when
// the run is unscoped, so existing start lines are unchanged.
const envLine = (env) => (env ? ` [env ${env.name}]` : '');

// The scan result, plus the scope block the sync routes return.
const withScope = (result, env) => {
  const scope = envScope(env);
  return scope ? { ...result, scope } : result;
};

// Components this environment owns (all of them when unscoped).
const envComponents = (ws, env) => {
  const all = store.getCollection(ws, 'components');
  return env ? all.filter((c) => String(c?.envId || '') === env.id) : all;
};

const KINDS = {

  // POST /w/:ws/discover/aws — discover() + markExisting
  'aws-scan': (ws, p, env) => {
    const { profile, region } = envConnection(env, {
      profile: optStr(p.profile, 'profile'), region: optStr(p.region, 'region'),
    });
    const services = optArr(p.services, 'services');
    const authVia = optStr(p.authVia, 'authVia');
    return {
      startLine: `started aws-scan${envLine(env)} (profile ${profile || 'default'}, region ${region || '(none)'}, ${services.length || 'all'} services)`,
      run: async (onLog) => {
        const result = await discover({ profile, region, services, authVia, onLog });
        return withScope({ ...result, proposals: reviewProposals(ws, result.proposals, env) }, env);
      },
      summarize: (res) => `${(res.proposals || []).length} proposals, ${(res.errors || []).length} errors`,
    };
  },

  // POST /w/:ws/discover/aws/scan-map — scanMap() + markExisting
  'aws-scan-map': (ws, p, env) => {
    const { profile, region } = envConnection(env, {
      profile: optStr(p.profile, 'profile'), region: optStr(p.region, 'region'),
    });
    const services = optArr(p.services, 'services');
    const mapDependencies = p.mapDependencies !== false;
    const authVia = optStr(p.authVia, 'authVia');
    return {
      startLine: `started aws-scan-map${envLine(env)} (profile ${profile || 'default'}, region ${region || '(none)'}, ${services.length || 'all'} services${mapDependencies ? '' : ', no dependency mapping'})`,
      run: async (onLog) => {
        const result = await scanMap({
          profile: String(profile || ''), region: String(region || ''),
          services: Array.isArray(services) ? services : [],
          mapDependencies, authVia, onLog,
        });
        return withScope({ ...result, proposals: reviewProposals(ws, result.proposals, env) }, env);
      },
      summarize: (res) => `${(res.proposals || []).length} proposals, ${(res.errors || []).length} errors`,
    };
  },

  // POST /w/:ws/resources/enrich — enrichComponents() + graph merge/save.
  // `envId` goes through to aws-enrich so it walks only that environment's
  // components and tags what it finds; the default component set is that
  // environment's, not the workspace's.
  'enrich': (ws, p, env) => {
    const componentIds = optArr(p.componentIds, 'componentIds');
    const { profile, region } = envConnection(env, {
      profile: optStr(p.profile, 'profile'), region: optStr(p.region, 'region'),
    });
    const target = p.target;
    const authVia = optStr(p.authVia, 'authVia');
    if (target !== undefined && target !== null && !['arpio', 'all', ''].includes(String(target))) {
      throw bad("target must be 'arpio' or 'all'");
    }
    return {
      startLine: `started enrich${envLine(env)} (profile ${profile || 'default'}, region ${region || '(none)'}, ${componentIds.length || 'all AWS-linked'} components${target ? `, target ${target}` : ''})`,
      run: async (onLog) => {
        const result = await enrichComponents({
          slug: ws,
          componentIds: Array.isArray(componentIds) ? componentIds : [],
          profile: String(profile || ''), region: String(region || ''),
          target: String(target || ''), authVia, onLog,
          ...(env ? { envId: env.id } : {}),
        });
        const { graph, stats } = mergeGraph(loadGraph(ws), result);
        store.saveObject(ws, GRAPH, graph);
        // Same fields, in the same order, as POST /w/:ws/resources/enrich.
        const out = {
          ...stats, perComponent: result.perComponent, log: result.log, errors: result.errors,
          resourceDetails: Object.fromEntries(
            Object.entries(result.resourceDetails || {}).map(([id, list]) => [id, list.length])),
          followUpCalls: result.followUpCalls,
          followUpCapped: result.followUpCapped,
        };
        if (result.scope) out.scope = result.scope;
        else if (env) out.scope = envScope(env);
        if (result.targeted !== undefined) out.targeted = result.targeted;
        return out;
      },
      summarize: (res) => (res.targeted !== undefined
        ? `targeted ${res.targeted}, added ${res.addedNodes} nodes`
        : `${(res.perComponent || []).length} components enriched, added ${res.addedNodes} nodes, ${(res.errors || []).length} errors`),
    };
  },

  // POST /w/:ws/resources/enrich-by-tag — enrichByTag() + graph merge/save
  'enrich-by-tag': (ws, p, env) => {
    const { profile, region } = envConnection(env, {
      profile: optStr(p.profile, 'profile'), region: optStr(p.region, 'region'),
    });
    const tagKey = optStr(p.tagKey, 'tagKey');
    const tagValue = optStr(p.tagValue, 'tagValue');
    const proposeComponents = !!p.proposeComponents;
    const authVia = optStr(p.authVia, 'authVia');
    const filters = normalizeTagFilters({ tags: p.tags, tagKey, tagValue }); // throws 400 on invalid filters
    const filterDesc = filters.map((f) => `${f.key}=${f.values.join('|')}`).join(' AND ');
    return {
      startLine: `started enrich-by-tag${envLine(env)} (profile ${profile || 'default'}, region ${region || '(none)'}, ${filterDesc || 'no tag filters'}${proposeComponents ? ', proposing components' : ''})`,
      run: async (onLog) => {
        const result = await enrichByTag({
          slug: ws, profile: String(profile || ''), region: String(region || ''),
          tags: filters.length ? filters : undefined,
          tagKey: String(tagKey || ''), tagValue: String(tagValue || ''),
          proposeComponents, authVia, onLog,
          ...(env ? { envId: env.id } : {}),
        });
        const { graph, stats } = mergeGraph(loadGraph(ws), result);
        store.saveObject(ws, GRAPH, graph);
        const out = { ...stats, matched: result.matched, perComponent: result.perComponent, log: result.log, errors: result.errors };
        if (result.scope) out.scope = result.scope;
        else if (env) out.scope = envScope(env);
        // Proposals come back exactly as the sync route returns them (the lib
        // already dedupes them by arn/name), then get the environment stamp so
        // importing them lands in this environment.
        if (result.proposals) out.proposals = tagProposals(result.proposals, env);
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
  'arpio': (ws, p, env) => {
    const keyId = String(p.apiKeyId || '').trim();
    const secret = String(p.apiSecret || '').trim();
    const combined = String(p.apiKey || '').trim();
    const accountId = String(p.accountId || '').trim();
    const apiKey = keyId && secret ? `${keyId}:${secret}` : combined;
    if (!apiKey) throw bad('An Arpio API key (key ID + secret) is required');
    return {
      startLine: `started arpio${envLine(env)} (account ${accountId || '(all accessible)'})`,
      run: async (onLog) => {
        const client = new ArpioClient(apiKey, accountId); // key used per-request only; never persisted
        const inv = await client.inventory({ onLog });
        if (!inv.ok) return { ok: false, message: inv.message, trace: inv.trace || [] };
        return withScope({
          ok: true, proposals: reviewProposals(ws, inv.proposals, env),
          message: inv.message || '', trace: inv.trace || [],
        }, env);
      },
      summarize: (res) => (res.ok
        ? `${(res.proposals || []).length} proposals from Arpio`
        : `Arpio: ${String(res.message || 'failed').slice(0, 150)}`),
    };
  },

  // POST /w/:ws/k8s/scan — scan() + autoLink + save. A scan that yields no
  // snapshot (kubectl missing / unreachable context) becomes an ERROR job
  // (there is no snapshot to store or render); its log still streams into
  // progress and the reason lands in `error`. The snapshot is stored under
  // the environment being scanned (see routes/k8s.js for the shape).
  'k8s-scan': (ws, p, env) => {
    const context = (optStr(p.context, 'context').trim() || (env ? env.kubeContext : '')).trim();
    const namespaces = optArr(p.namespaces, 'namespaces').map((n) => String(n || '').trim()).filter(Boolean);
    if (context && !K8S_NAME_RE.test(context)) throw bad(`invalid context name: ${context}`);
    for (const ns of namespaces) {
      if (!K8S_NAME_RE.test(ns)) throw bad(`invalid namespace name: ${ns}`);
    }
    return {
      startLine: `started k8s-scan${envLine(env)} (context ${context || '(current)'}, ${namespaces.length || 'all'} namespaces)`,
      run: async (onLog) => {
        const { snapshot, log, errors } = await k8sScan({ context, namespaces, onLog });
        if (!snapshot) {
          throw new Error(errors[errors.length - 1] || 'k8s scan produced no snapshot');
        }
        const linked = autoLink(snapshot, envComponents(ws, env));
        writeSnapshot(ws, env, snapshot);
        return withScope({ summary: k8sSummarize(snapshot, linked), log, errors }, env);
      },
      summarize: (res) => `${res.summary.workloads} workloads, ${res.summary.namespaces} namespaces${res.summary.linked ? `, ${res.summary.linked} linked` : ''}`,
    };
  },
};

// ------------------------------------------------------------ routes

r.post('/w/:ws/jobs', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const workspace = store.getWorkspace(ws); // 404 before starting anything
    const { kind, params } = req.body || {};
    const make = KINDS[kind];
    if (!make) {
      throw bad(`unknown job kind: ${String(kind || '(none)')} — expected one of ${Object.keys(KINDS).join(', ')}`);
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      throw bad('params must be an object');
    }
    const p = params || {};
    // 404 on an unknown environment BEFORE anything is started: a scan that
    // silently ran unscoped would write components nobody can find.
    const env = resolveDiscoveryEnv(ws, p.envId, { workspace });
    const spec = make(ws, p, env); // throws 400 on invalid params shape
    const out = startJob({ ws, kind, envId: env ? env.id : '', envName: env ? env.name : '', ...spec });
    if (out.conflict) {
      return res.status(409).json({
        error: env
          ? `a ${kind} job is already running for the ${env.name} environment — poll it or wait for it to finish (another environment can start its own now)`
          : `a ${kind} job is already running in this workspace — poll it or wait for it to finish`,
        jobId: out.conflict.id,
        ...(env ? { envId: env.id } : {}),
      });
    }
    res.status(201).json({
      jobId: out.job.id, kind, startedAt: out.job.startedAt,
      ...(env ? { envId: env.id, envName: env.name } : {}),
    });
  } catch (e) { next(e); }
});

// ?envId= narrows the list to one environment ('unassigned'/'' for runs with
// none); without it every job comes back, each carrying its own envId, which
// is what the Discover status strip reads.
r.get('/w/:ws/jobs', (req, res, next) => {
  try {
    const ws = req.params.ws;
    const workspace = store.getWorkspace(ws);
    const raw = req.query.envId;
    if (raw === undefined || raw === null || String(raw) === '') {
      return res.json({ jobs: listJobs(ws) });
    }
    if (String(raw).toLowerCase() === 'unassigned') return res.json({ jobs: listJobs(ws, { envId: '' }) });
    const env = resolveDiscoveryEnv(ws, raw, { workspace });
    res.json({ jobs: env ? listJobs(ws, { envId: env.id }) : listJobs(ws) });
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
