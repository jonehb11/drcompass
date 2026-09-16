// Kubernetes discovery — shells out to the user's LOCAL kubectl with their own
// kubeconfig. STRICTLY read-only: only `kubectl get ...` and
// `kubectl config get-contexts|current-context` are ever executed, always via
// execFile with argument arrays (no shell). Secret/ConfigMap VALUES are never
// read — only the NAMES referenced by workload pod specs.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const KUBECTL_TIMEOUT = 30000;           // per-call process timeout
const REQUEST_TIMEOUT = '--request-timeout=20s'; // server-side timeout for `get`
const MAX_BUFFER = 64 * 1024 * 1024;
const CONCURRENCY = 3;

const NAME_RE = /^[a-zA-Z0-9._@:\/-]+$/;
const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job']);
const KIND_BY_KEY = {
  deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet',
  cronjobs: 'CronJob', jobs: 'Job',
};

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

function shortErr(e) {
  if (e.code === 'ENOENT') return 'kubectl binary not found';
  if (e.killed || e.signal === 'SIGTERM') return `timed out after ${KUBECTL_TIMEOUT / 1000}s`;
  const stderr = (e.stderr || '').toString().trim().split('\n').slice(-2).join(' ');
  return (stderr || e.message || 'unknown error').slice(0, 300);
}

// Hard whitelist: refuse anything that is not a read-only verb we expect.
function assertReadOnly(args) {
  const ok = args[0] === 'get'
    || (args[0] === 'config' && (args[1] === 'get-contexts' || args[1] === 'current-context'));
  if (!ok) throw new Error(`refusing non-read-only kubectl invocation: kubectl ${args.join(' ')}`);
}

async function kubectl(args, log) {
  assertReadOnly(args);
  if (log) log.push(`kubectl ${args.join(' ')}`);
  const { stdout } = await execFile('kubectl', args, {
    timeout: KUBECTL_TIMEOUT, maxBuffer: MAX_BUFFER, env: process.env,
  });
  return stdout.toString();
}

// A log array whose push() also invokes an optional onLog(line) callback —
// the central streaming hook for the scan. Sync callers (no onLog) get an
// ordinary array with identical behavior. (Deliberately duplicated from
// aws-discovery.makeLog to keep this lib free of AWS imports.)
function makeLog(onLog) {
  const log = [];
  if (typeof onLog !== 'function') return log;
  const raw = Array.prototype.push.bind(log);
  log.push = (...lines) => {
    for (const l of lines) {
      try { onLog(l); } catch { /* an observer must never break a scan */ }
    }
    return raw(...lines);
  };
  return log;
}

async function runLimited(tasks, limit = CONCURRENCY) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- contexts

export async function listContexts() {
  let names;
  try {
    const out = await kubectl(['config', 'get-contexts', '-o', 'name']);
    names = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return { kubectlFound: false, contexts: [] };
  }
  let current = '';
  try { current = (await kubectl(['config', 'current-context'])).trim(); } catch { /* no current context set */ }
  return { kubectlFound: true, contexts: names.map((n) => ({ name: n, current: n === current })) };
}

export async function kubectlFound() {
  return (await listContexts()).kubectlFound;
}

// ---------------------------------------------------------------- normalizer
// Shared by the live scan and the uploaded script artifact.

const asItems = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.items) ? x.items : []);
const strArr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
const plainLabels = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
};

// Names of configmaps/secrets referenced by a pod spec. Names ONLY — env
// literal values are never captured (only valueFrom.*Ref names).
function podRefs(podSpec) {
  const cms = new Set(); const secs = new Set();
  const containers = [...(podSpec?.containers || []), ...(podSpec?.initContainers || [])];
  for (const c of containers) {
    for (const ef of c.envFrom || []) {
      if (ef?.configMapRef?.name) cms.add(ef.configMapRef.name);
      if (ef?.secretRef?.name) secs.add(ef.secretRef.name);
    }
    for (const ev of c.env || []) {
      if (ev?.valueFrom?.configMapKeyRef?.name) cms.add(ev.valueFrom.configMapKeyRef.name);
      if (ev?.valueFrom?.secretKeyRef?.name) secs.add(ev.valueFrom.secretKeyRef.name);
    }
  }
  for (const v of podSpec?.volumes || []) {
    if (v?.configMap?.name) cms.add(v.configMap.name);
    if (v?.secret?.secretName) secs.add(v.secret.secretName);
    for (const s of v?.projected?.sources || []) {
      if (s?.configMap?.name) cms.add(s.configMap.name);
      if (s?.secret?.name) secs.add(s.secret.name);
    }
  }
  for (const ips of podSpec?.imagePullSecrets || []) if (ips?.name) secs.add(ips.name);
  return { configmaps: [...cms].sort(), secrets: [...secs].sort() };
}

function podImages(podSpec) {
  const imgs = new Set();
  for (const c of [...(podSpec?.containers || []), ...(podSpec?.initContainers || [])]) {
    if (c?.image) imgs.add(c.image);
  }
  return [...imgs];
}

// Flatten raw workloads: accepts a mixed items array (live scan) or the script
// artifact's keyed object { deployments: <List>, statefulsets: <List>, ... }.
function workloadItems(rawWorkloads) {
  if (Array.isArray(rawWorkloads) || (rawWorkloads && Array.isArray(rawWorkloads.items))) {
    return asItems(rawWorkloads).map((i) => [i, i?.kind || '']);
  }
  const out = [];
  if (rawWorkloads && typeof rawWorkloads === 'object') {
    for (const [key, kind] of Object.entries(KIND_BY_KEY)) {
      for (const i of asItems(rawWorkloads[key])) out.push([i, i?.kind || kind]);
    }
  }
  return out;
}

function normWorkload(item, kindHint, claimIndex, stsPrefixes) {
  const kind = WORKLOAD_KINDS.has(item?.kind) ? item.kind : kindHint;
  if (!WORKLOAD_KINDS.has(kind)) return null;
  const md = item?.metadata || {};
  const ns = md.namespace || '';
  const name = md.name || '';
  if (!ns || !name) return null;
  const spec = item.spec || {};
  const st = item.status || {};

  let podTemplate; let replicas;
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
      podTemplate = spec.template || {};
      replicas = { desired: spec.replicas ?? 1, ready: st.readyReplicas ?? 0 };
      break;
    case 'DaemonSet':
      podTemplate = spec.template || {};
      replicas = { desired: st.desiredNumberScheduled ?? 0, ready: st.numberReady ?? 0 };
      break;
    case 'CronJob':
      podTemplate = spec.jobTemplate?.spec?.template || {};
      replicas = { desired: spec.suspend ? 0 : 1, ready: Array.isArray(st.active) ? st.active.length : 0 };
      break;
    case 'Job':
      // Jobs spawned by a CronJob are noise — the CronJob itself is captured.
      if ((md.ownerReferences || []).some((o) => o?.kind === 'CronJob')) return null;
      podTemplate = spec.template || {};
      replicas = { desired: spec.completions ?? 1, ready: st.succeeded ?? 0 };
      break;
    default:
      return null;
  }

  const podSpec = podTemplate.spec || {};
  const uid = `${ns}/${kind}/${name}`;
  const refs = podRefs(podSpec);

  for (const v of podSpec.volumes || []) {
    const claim = v?.persistentVolumeClaim?.claimName;
    if (claim && !claimIndex.has(`${ns}/${claim}`)) claimIndex.set(`${ns}/${claim}`, uid);
  }
  if (kind === 'StatefulSet') {
    for (const t of spec.volumeClaimTemplates || []) {
      const tName = t?.metadata?.name;
      if (tName) stsPrefixes.push({ ns, prefix: `${tName}-${name}-`, uid });
    }
  }

  return {
    uid, namespace: ns, kind, name, replicas,
    images: podImages(podSpec),
    serviceAccount: podSpec.serviceAccountName || podSpec.serviceAccount || 'default',
    labels: plainLabels(podTemplate.metadata?.labels || md.labels),
    configmaps: refs.configmaps,
    secrets: refs.secrets,
    componentId: null,
  };
}

function ingressBackend(backend) {
  if (!backend) return null;
  if (backend.service?.name) {
    return { service: backend.service.name, port: backend.service.port?.number ?? backend.service.port?.name ?? null };
  }
  if (backend.serviceName) return { service: backend.serviceName, port: backend.servicePort ?? null }; // legacy v1beta1
  return null;
}

// Defensive scrub: no `data`/`stringData`/`env` key may survive anywhere in a
// stored snapshot (belt-and-braces on top of the explicit field construction).
function deepStrip(obj) {
  if (Array.isArray(obj)) { for (const v of obj) deepStrip(v); return obj; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === 'data' || k === 'stringData' || k === 'env') delete obj[k];
      else deepStrip(obj[k]);
    }
  }
  return obj;
}

// raw = { namespaces, workloads (mixed array or keyed lists), services,
//         ingresses, pvcs, hpas, nodes } — each a kubectl List or items array.
// meta = { source, context, clusterName, capturedAt, only: [namespaces]|null }
function normalizeRaw(raw = {}, meta = {}) {
  const only = Array.isArray(meta.only) && meta.only.length ? new Set(meta.only) : null;
  const keepNs = (ns) => (only ? only.has(ns) : !SYSTEM_NS.has(ns));

  const nsMap = new Map();
  for (const item of asItems(raw.namespaces)) {
    const name = item?.metadata?.name;
    if (name && keepNs(name)) nsMap.set(name, { name, labels: plainLabels(item.metadata.labels) });
  }
  const touch = (ns) => { if (ns && keepNs(ns) && !nsMap.has(ns)) nsMap.set(ns, { name: ns, labels: {} }); };

  const workloads = [];
  const claimIndex = new Map();
  const stsPrefixes = [];
  for (const [item, kindHint] of workloadItems(raw.workloads)) {
    const w = normWorkload(item, kindHint, claimIndex, stsPrefixes);
    if (!w || !keepNs(w.namespace)) continue;
    touch(w.namespace);
    workloads.push(w);
  }

  const services = [];
  for (const item of asItems(raw.services)) {
    const md = item?.metadata || {}; const ns = md.namespace || '';
    if (!md.name || !keepNs(ns)) continue;
    touch(ns);
    const spec = item.spec || {};
    const selector = plainLabels(spec.selector);
    const entries = Object.entries(selector);
    const targets = entries.length
      ? workloads
        .filter((w) => w.namespace === ns && entries.every(([k, v]) => (w.labels || {})[k] === v))
        .map((w) => w.uid)
      : [];
    services.push({
      namespace: ns, name: md.name, type: spec.type || 'ClusterIP', selector,
      ports: (spec.ports || []).map((p) => ({ port: p?.port ?? null, targetPort: p?.targetPort ?? p?.port ?? null })),
      targets,
    });
  }

  const ingresses = [];
  for (const item of asItems(raw.ingresses)) {
    const md = item?.metadata || {}; const ns = md.namespace || '';
    if (!md.name || !keepNs(ns)) continue;
    touch(ns);
    const spec = item.spec || {};
    const hosts = []; const backends = []; const seen = new Set();
    const add = (b) => {
      const nb = ingressBackend(b);
      if (!nb) return;
      const key = `${nb.service}:${nb.port}`;
      if (!seen.has(key)) { seen.add(key); backends.push(nb); }
    };
    add(spec.defaultBackend || spec.backend);
    for (const rule of spec.rules || []) {
      if (rule?.host) hosts.push(rule.host);
      for (const p of rule?.http?.paths || []) add(p?.backend);
    }
    ingresses.push({
      namespace: ns, name: md.name,
      class: spec.ingressClassName || md.annotations?.['kubernetes.io/ingress.class'] || '',
      hosts, backends,
    });
  }

  const pvcs = [];
  for (const item of asItems(raw.pvcs)) {
    const md = item?.metadata || {}; const ns = md.namespace || '';
    if (!md.name || !keepNs(ns)) continue;
    touch(ns);
    const spec = item.spec || {};
    let boundTo = claimIndex.get(`${ns}/${md.name}`) || null;
    if (!boundTo) {
      const m = stsPrefixes.find((s) => s.ns === ns && md.name.startsWith(s.prefix));
      if (m) boundTo = m.uid;
    }
    pvcs.push({
      namespace: ns, name: md.name,
      storageClass: spec.storageClassName || '',
      size: spec.resources?.requests?.storage || item.status?.capacity?.storage || '',
      boundTo,
    });
  }

  const hpas = [];
  for (const item of asItems(raw.hpas)) {
    const md = item?.metadata || {}; const ns = md.namespace || '';
    if (!md.name || !keepNs(ns)) continue;
    touch(ns);
    const spec = item.spec || {};
    const ref = spec.scaleTargetRef || {};
    hpas.push({
      namespace: ns, name: md.name,
      target: ref.name ? `${ns}/${ref.kind || 'Deployment'}/${ref.name}` : '',
      min: spec.minReplicas ?? 1, max: spec.maxReplicas ?? null,
    });
  }

  const nodeItems = asItems(raw.nodes);
  const types = new Set(); let ready = 0;
  for (const n of nodeItems) {
    const labels = n?.metadata?.labels || {};
    const t = labels['node.kubernetes.io/instance-type'] || labels['beta.kubernetes.io/instance-type'];
    if (t) types.add(t);
    if ((n?.status?.conditions || []).some((c) => c?.type === 'Ready' && c?.status === 'True')) ready++;
  }

  return deepStrip({
    capturedAt: meta.capturedAt || new Date().toISOString(),
    source: meta.source === 'kubectl' ? 'kubectl' : 'upload',
    context: meta.context || '',
    clusterName: meta.clusterName || '',
    nodes: { count: nodeItems.length, instanceTypes: [...types].sort(), readyCount: ready },
    namespaces: [...nsMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    workloads: workloads.sort((a, b) => a.uid.localeCompare(b.uid)),
    services: services.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)),
    ingresses,
    pvcs,
    hpas,
  });
}

// ---------------------------------------------------------------- scan (live)

export async function scan({ context = '', namespaces = [], onLog } = {}) {
  const log = makeLog(onLog); const errors = [];
  context = String(context || '').trim();
  if (context && !NAME_RE.test(context)) throw httpError(400, `invalid context name: ${context}`);
  const wanted = (Array.isArray(namespaces) ? namespaces : []).map((n) => String(n || '').trim()).filter(Boolean);
  for (const ns of wanted) {
    if (!NAME_RE.test(ns)) throw httpError(400, `invalid namespace name: ${ns}`);
  }

  if (!(await kubectlFound())) {
    return { snapshot: null, log, errors: ['kubectl not found — install kubectl and configure cluster access, or use the downloadable snapshot script'] };
  }

  const ctxArgs = context ? ['--context', context] : [];
  const get = async (resources, ns) => {
    const args = ['get', resources, ...(ns ? ['-n', ns] : []), '-o', 'json', REQUEST_TIMEOUT, ...ctxArgs];
    const out = await kubectl(args, log);
    return out.trim() ? JSON.parse(out) : { items: [] };
  };

  // 1. namespaces
  let nsItems = [];
  try { nsItems = asItems(await get('namespaces')); }
  catch (e) { errors.push(`namespaces: ${shortErr(e)}`); }
  const allNames = nsItems.map((i) => i?.metadata?.name).filter(Boolean);
  const targets = wanted.length ? wanted : allNames.filter((n) => !SYSTEM_NS.has(n));
  if (!targets.length) {
    return { snapshot: null, log, errors: [...errors, 'no namespaces to scan — could not list namespaces and none were specified'] };
  }
  const nsRaw = [...nsItems];
  for (const ns of wanted) {
    if (!allNames.includes(ns)) nsRaw.push({ metadata: { name: ns, labels: {} } });
  }

  // 2. nodes + per-namespace resources, limited concurrency
  const buckets = { workloads: [], services: [], ingresses: [], pvcs: [], hpas: [], nodes: [] };
  const tasks = [async () => {
    try { buckets.nodes = asItems(await get('nodes')); }
    catch (e) { errors.push(`nodes: ${shortErr(e)}`); }
  }];
  const perNs = [
    ['deployments,statefulsets,daemonsets,cronjobs,jobs', 'workloads'],
    ['services', 'services'],
    ['ingresses', 'ingresses'],
    ['pvc', 'pvcs'],
    ['hpa', 'hpas'],
  ];
  for (const ns of targets) {
    for (const [resources, bucket] of perNs) {
      tasks.push(async () => {
        try { buckets[bucket].push(...asItems(await get(resources, ns))); }
        catch (e) { errors.push(`${ns}/${resources}: ${shortErr(e)}`); }
      });
    }
  }
  await runLimited(tasks);

  const snapshot = normalizeRaw(
    { namespaces: nsRaw, workloads: buckets.workloads, services: buckets.services,
      ingresses: buckets.ingresses, pvcs: buckets.pvcs, hpas: buckets.hpas, nodes: buckets.nodes },
    { source: 'kubectl', context,
      clusterName: context.includes('/') ? context.split('/').pop() : context,
      only: targets },
  );
  return { snapshot, log, errors };
}

// ---------------------------------------------------------------- upload

export function normalizeUpload(parsed) {
  const warnings = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'unrecognized upload: expected the drcompass-k8s-snapshot.json artifact (a JSON object)');
  }

  // (a) raw artifact produced by the downloadable script
  if (parsed.raw && typeof parsed.raw === 'object' && !Array.isArray(parsed.raw)) {
    const requested = strArr(parsed.requestedNamespaces).filter((n) => NAME_RE.test(n));
    const snapshot = normalizeRaw(parsed.raw, {
      source: 'upload',
      context: typeof parsed.context === 'string' ? parsed.context : '',
      clusterName: typeof parsed.clusterName === 'string' && parsed.clusterName
        ? parsed.clusterName
        : (typeof parsed.context === 'string' && parsed.context.includes('/') ? parsed.context.split('/').pop() : parsed.context || ''),
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
      only: requested.length ? requested : null,
    });
    if (!snapshot.workloads.length) warnings.push('no workloads found in the artifact — check the script output and RBAC permissions');
    if (!snapshot.namespaces.length) warnings.push('no namespaces found in the artifact');
    if (!snapshot.nodes.count) warnings.push('no node information in the artifact (get nodes may have failed)');
    return { snapshot, warnings };
  }

  // (b) already-normalized snapshot — rebuild field-by-field (defensive: only
  // whitelisted fields survive, so no data/stringData/env can slip through).
  if (Array.isArray(parsed.workloads) || Array.isArray(parsed.namespaces)) {
    const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
    const str = (v, d = '') => (typeof v === 'string' ? v : d);
    let dropped = 0;

    const workloads = (Array.isArray(parsed.workloads) ? parsed.workloads : []).map((w) => {
      const kind = WORKLOAD_KINDS.has(w?.kind) ? w.kind : null;
      const ns = str(w?.namespace); const name = str(w?.name);
      if (!kind || !ns || !name) { dropped++; return null; }
      return {
        uid: str(w.uid) || `${ns}/${kind}/${name}`,
        namespace: ns, kind, name,
        replicas: { desired: num(w?.replicas?.desired), ready: num(w?.replicas?.ready) },
        images: strArr(w?.images),
        serviceAccount: str(w?.serviceAccount),
        labels: plainLabels(w?.labels),
        configmaps: strArr(w?.configmaps),
        secrets: strArr(w?.secrets),
        componentId: typeof w?.componentId === 'string' && w.componentId ? w.componentId : null,
      };
    }).filter(Boolean);
    if (dropped) warnings.push(`workloads: skipped ${dropped} entries missing kind/namespace/name`);

    const services = (Array.isArray(parsed.services) ? parsed.services : []).map((s) => {
      const ns = str(s?.namespace); const name = str(s?.name);
      if (!ns || !name) return null;
      const selector = plainLabels(s?.selector);
      let targets = strArr(s?.targets);
      if (!targets.length && Object.keys(selector).length) {
        const entries = Object.entries(selector);
        targets = workloads
          .filter((w) => w.namespace === ns && entries.every(([k, v]) => w.labels[k] === v))
          .map((w) => w.uid);
      }
      return {
        namespace: ns, name,
        type: ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(s?.type) ? s.type : 'ClusterIP',
        selector,
        ports: (Array.isArray(s?.ports) ? s.ports : [])
          .map((p) => ({ port: p?.port ?? null, targetPort: p?.targetPort ?? p?.port ?? null })),
        targets,
      };
    }).filter(Boolean);

    const ingresses = (Array.isArray(parsed.ingresses) ? parsed.ingresses : []).map((i) => {
      const ns = str(i?.namespace); const name = str(i?.name);
      if (!ns || !name) return null;
      return {
        namespace: ns, name, class: str(i?.class), hosts: strArr(i?.hosts),
        backends: (Array.isArray(i?.backends) ? i.backends : [])
          .filter((b) => b && typeof b.service === 'string')
          .map((b) => ({ service: b.service, port: b.port ?? null })),
      };
    }).filter(Boolean);

    const pvcs = (Array.isArray(parsed.pvcs) ? parsed.pvcs : []).map((p) => {
      const ns = str(p?.namespace); const name = str(p?.name);
      if (!ns || !name) return null;
      return {
        namespace: ns, name, storageClass: str(p?.storageClass), size: str(p?.size),
        boundTo: typeof p?.boundTo === 'string' && p.boundTo ? p.boundTo : null,
      };
    }).filter(Boolean);

    const hpas = (Array.isArray(parsed.hpas) ? parsed.hpas : []).map((h) => {
      const ns = str(h?.namespace); const name = str(h?.name);
      if (!ns || !name) return null;
      return { namespace: ns, name, target: str(h?.target), min: num(h?.min, 1), max: Number.isFinite(h?.max) ? h.max : null };
    }).filter(Boolean);

    const nsMap = new Map();
    for (const n of Array.isArray(parsed.namespaces) ? parsed.namespaces : []) {
      const name = str(n?.name);
      if (name) nsMap.set(name, { name, labels: plainLabels(n?.labels) });
    }
    for (const w of workloads) if (!nsMap.has(w.namespace)) nsMap.set(w.namespace, { name: w.namespace, labels: {} });

    const snapshot = deepStrip({
      capturedAt: str(parsed.capturedAt) || new Date().toISOString(),
      source: parsed.source === 'kubectl' ? 'kubectl' : 'upload',
      context: str(parsed.context),
      clusterName: str(parsed.clusterName),
      nodes: {
        count: num(parsed.nodes?.count),
        instanceTypes: strArr(parsed.nodes?.instanceTypes),
        readyCount: num(parsed.nodes?.readyCount),
      },
      namespaces: [...nsMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      workloads, services, ingresses, pvcs, hpas,
    });
    if (!workloads.length) warnings.push('snapshot contains no workloads');
    return { snapshot, warnings };
  }

  throw httpError(400, 'unrecognized upload: expected {raw: {...}} from drcompass-k8s-snapshot.sh, or an already-normalized snapshot with workloads[]');
}

// ---------------------------------------------------------------- auto-link

const LINKABLE_KINDS = new Set(['eks-workload', 'ecs-service', 'k8s-workload', 'workload', 'eks-cluster', 'ecs-cluster']);

function fuzzyName(name) {
  let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let prev;
  do { prev = s; s = s.replace(/-(service|svc|deploy|deployment|api|app)$/, ''); } while (s !== prev);
  return s;
}

// Sets workload.componentId (when not already set) by fuzzy-matching component
// names against the workload name or its namespace. Returns how many linked.
export function autoLink(snapshot, components = []) {
  if (!snapshot || !Array.isArray(snapshot.workloads)) return 0;
  const index = new Map();
  for (const c of Array.isArray(components) ? components : []) {
    if (!c || !c.id || !LINKABLE_KINDS.has(c.kind)) continue;
    const key = fuzzyName(c.name);
    if (key && !index.has(key)) index.set(key, c.id);
  }
  let linked = 0;
  for (const w of snapshot.workloads) {
    if (w.componentId) continue;
    const id = index.get(fuzzyName(w.name)) || index.get(fuzzyName(w.namespace));
    if (id) { w.componentId = id; linked++; }
  }
  return linked;
}

// ---------------------------------------------------------------- script

// Self-contained READ-ONLY bash script users run against their own cluster.
// It produces drcompass-k8s-snapshot.json (the raw-shape artifact accepted by
// normalizeUpload). Assembly uses jq when present, else python3.
export function snapshotScript() {
  return `#!/usr/bin/env bash
# drcompass-k8s-snapshot.sh — READ-ONLY Kubernetes snapshot for DR Compass.
#
# Runs only "kubectl get ... -o json" (never write verbs) and assembles one
# artifact file in the current directory:
#     drcompass-k8s-snapshot.json
# Upload that file in DR Compass -> Discover -> Kubernetes.
#
# Secret/ConfigMap VALUES are never read — only workload specs, which
# reference configmaps/secrets by NAME.
#
# Usage:
#   bash drcompass-k8s-snapshot.sh
#   CONTEXT=my-context bash drcompass-k8s-snapshot.sh
#   NAMESPACES="ns-a ns-b" bash drcompass-k8s-snapshot.sh
# (default: every namespace visible to you; system namespaces are filtered
#  out at import time)
#
# Requires: kubectl, plus jq or python3 (for JSON assembly).
set -euo pipefail

OUT="drcompass-k8s-snapshot.json"

command -v kubectl >/dev/null 2>&1 || { echo "ERROR: kubectl not found on PATH" >&2; exit 1; }

TOOL=""
if command -v jq >/dev/null 2>&1; then TOOL="jq"
elif command -v python3 >/dev/null 2>&1; then TOOL="python3"
else
  echo "ERROR: neither jq nor python3 found — install one of them and re-run" >&2
  exit 1
fi
echo "JSON assembler: $TOOL"

KUBECTL=(kubectl --request-timeout=20s)
if [ -n "\${CONTEXT:-}" ]; then KUBECTL+=(--context "$CONTEXT"); fi
CTX="\${CONTEXT:-$(kubectl config current-context 2>/dev/null || echo "")}"
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

grab() { # grab <file-stem> <kubectl get args...>
  local stem="$1"; shift
  echo "  kubectl get $*"
  if ! "\${KUBECTL[@]}" get "$@" -o json > "$TMP/$stem.json" 2>"$TMP/$stem.err"; then
    echo "  WARN: 'kubectl get $*' failed — continuing with an empty list:" >&2
    sed 's/^/        /' "$TMP/$stem.err" >&2 || true
    echo '{"items":[]}' > "$TMP/$stem.json"
  fi
}

echo "Capturing READ-ONLY cluster snapshot (context: \${CTX:-<kubeconfig default>}) ..."
grab namespaces namespaces
grab nodes nodes

RESOURCES="deployments statefulsets daemonsets cronjobs jobs services ingresses pvc hpa"
if [ -n "\${NAMESPACES:-}" ]; then
  NS_LIST="$(echo "$NAMESPACES" | tr ',' ' ')"
  for ns in $NS_LIST; do
    case "$ns" in
      (*[!a-zA-Z0-9._-]*) echo "ERROR: invalid namespace name: $ns" >&2; exit 1;;
    esac
  done
  echo "Limiting to namespaces: $NS_LIST"
  for res in $RESOURCES; do
    mkdir -p "$TMP/$res.d"
    for ns in $NS_LIST; do grab "$res.d/$ns" "$res" -n "$ns"; done
    if [ "$TOOL" = "jq" ]; then
      jq -s '{items: (map(.items // []) | add)}' "$TMP/$res.d"/*.json > "$TMP/$res.json"
    else
      python3 - "$TMP/$res.d" "$TMP/$res.json" <<'PYMERGE'
import json, sys, os
d, out = sys.argv[1], sys.argv[2]
items = []
for f in sorted(os.listdir(d)):
    if not f.endswith('.json'):
        continue
    try:
        with open(os.path.join(d, f)) as fh:
            items.extend(json.load(fh).get('items') or [])
    except Exception:
        pass
with open(out, 'w') as fh:
    json.dump({'items': items}, fh)
PYMERGE
    fi
  done
else
  for res in $RESOURCES; do grab "$res" "$res" --all-namespaces; done
fi

echo "Assembling $OUT with $TOOL ..."
if [ "$TOOL" = "jq" ]; then
  jq -n \\
    --arg generatedBy "drcompass-k8s-snapshot.sh" \\
    --arg capturedAt "$CAPTURED_AT" \\
    --arg context "$CTX" \\
    --arg requested "\${NAMESPACES:-}" \\
    --slurpfile namespaces "$TMP/namespaces.json" \\
    --slurpfile deployments "$TMP/deployments.json" \\
    --slurpfile statefulsets "$TMP/statefulsets.json" \\
    --slurpfile daemonsets "$TMP/daemonsets.json" \\
    --slurpfile cronjobs "$TMP/cronjobs.json" \\
    --slurpfile jobs "$TMP/jobs.json" \\
    --slurpfile services "$TMP/services.json" \\
    --slurpfile ingresses "$TMP/ingresses.json" \\
    --slurpfile pvcs "$TMP/pvc.json" \\
    --slurpfile hpas "$TMP/hpa.json" \\
    --slurpfile nodes "$TMP/nodes.json" \\
    '{generatedBy: $generatedBy, capturedAt: $capturedAt, context: $context,
      requestedNamespaces: ($requested | split("[,[:space:]]+"; "") | map(select(length > 0))),
      raw: {
        namespaces: $namespaces[0],
        workloads: { deployments: $deployments[0], statefulsets: $statefulsets[0],
                     daemonsets: $daemonsets[0], cronjobs: $cronjobs[0], jobs: $jobs[0] },
        services: $services[0], ingresses: $ingresses[0],
        pvcs: $pvcs[0], hpas: $hpas[0], nodes: $nodes[0] } }' \\
    > "$OUT"
else
  python3 - "$TMP" "$OUT" "$CTX" "$CAPTURED_AT" "\${NAMESPACES:-}" <<'PYASM'
import json, sys, os, re
tmp, out, ctx, cap, req = sys.argv[1:6]
def load(stem):
    try:
        with open(os.path.join(tmp, stem + '.json')) as fh:
            return json.load(fh)
    except Exception:
        return {'items': []}
artifact = {
    'generatedBy': 'drcompass-k8s-snapshot.sh',
    'capturedAt': cap,
    'context': ctx,
    'requestedNamespaces': [s for s in re.split(r'[\\s,]+', req) if s],
    'raw': {
        'namespaces': load('namespaces'),
        'workloads': {k: load(k) for k in ('deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'jobs')},
        'services': load('services'),
        'ingresses': load('ingresses'),
        'pvcs': load('pvc'),
        'hpas': load('hpa'),
        'nodes': load('nodes'),
    },
}
with open(out, 'w') as fh:
    json.dump(artifact, fh, indent=2)
PYASM
fi

echo ""
echo "Done: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "Upload this file in DR Compass -> Discover -> Kubernetes"
`;
}
