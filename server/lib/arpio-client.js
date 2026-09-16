// Arpio (arpio.io) read-only API client.
//
// Auth (per https://docs.arpio.io/arpio-api-guide): an Arpio API key has two
// parts — an API key ID and a secret — sent together in one header:
//   X-Api-Key: <apiKeyId>:<secret>
// Keys are created in the Arpio console under Settings > Account Settings >
// API Keys. The account ID is the first randomized string in the console URL.
// Endpoints (from https://api.arpio.io/api/openapi.json):
//   GET /api/accounts                                   — accounts the key can access
//   GET /api/accounts/{id}/applications                 — applications
//   GET /api/accounts/{id}/applications/{app}/resources — protected resources
// Everything is wrapped so any network/HTTP failure degrades to
// { ok:false, message } — the UI shows the message and never crashes.
// The key is used per-request only and never persisted.

const BASE = 'https://api.arpio.io';
const TIMEOUT_MS = 15000;

function timedFetch(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

function snippet(text, n = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function guessCategory(type) {
  const t = String(type || '').toLowerCase();
  if (/(rds|aurora|dynamo|database|redshift|elasticache|redis)/.test(t)) return 'database';
  if (/(s3|bucket|efs|ebs|volume|fsx|storage)/.test(t)) return 'storage';
  if (/(sqs|sns|kinesis|kafka|msk|queue|stream)/.test(t)) return 'messaging-streaming';
  if (/(secret|kms|acm|certificate)/.test(t)) return 'security-secrets';
  if (/(route53|cloudfront|dns|apigateway|api-gateway)/.test(t)) return 'edge-dns';
  if (/(iam|role|identity)/.test(t)) return 'identity-access';
  if (/(vpc|subnet|security-group|elb|load-?balancer|network)/.test(t)) return 'networking';
  if (/(ec2|instance|eks|ecs|lambda|asg|autoscal|compute|k8s|kubernetes)/.test(t)) return 'compute';
  return 'other';
}

function guessLayer(category) {
  return { database: 'L3', storage: 'L3', 'messaging-streaming': 'L3', 'security-secrets': 'L3',
    'edge-dns': 'L5', 'identity-access': 'L0', networking: 'L2', compute: 'L4' }[category] || 'L4';
}

// ---- shape-agnostic response helpers -------------------------------------
// The Arpio OpenAPI spec declares application/json but no schemas, and field
// names vary between tenants/versions. Instead of guessing exact shapes we
// deep-search responses for what we need and report what we saw in a trace.

function describeShape(d) {
  if (Array.isArray(d)) return `array[${d.length}]`;
  if (d && typeof d === 'object') return `object{${Object.keys(d).slice(0, 8).join(',')}}`;
  return typeof d;
}

// Find the most plausible array of objects in a response, up to 3 levels deep.
// Prefers keys matching hints, then any array of objects, largest first.
export function findObjectArray(data, hints = [], depth = 0) {
  if (Array.isArray(data)) {
    return data.length === 0 || typeof data[0] === 'object' || typeof data[0] === 'string' ? data : null;
  }
  if (!data || typeof data !== 'object' || depth >= 3) return null;
  const entries = Object.entries(data);
  const lower = (s) => String(s).toLowerCase();
  for (const hint of hints) {
    for (const [k, v] of entries) {
      if (lower(k) === lower(hint) || lower(k).includes(lower(hint))) {
        const found = findObjectArray(v, hints, depth + 1);
        if (found) return found;
      }
    }
  }
  let best = null;
  for (const [, v] of entries) {
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'object')) {
      if (!best || v.length > best.length) best = v;
    }
  }
  if (best) return best;
  for (const [, v] of entries) {
    if (v && typeof v === 'object') {
      const found = findObjectArray(v, hints, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// First plausible id on an object: hinted keys (case-insensitive), then any
// *id/*Id key with a short scalar value.
export function pickId(obj, hints = []) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'string' || typeof obj === 'number') return String(obj);
  const lower = (s) => String(s).toLowerCase();
  for (const hint of hints) {
    for (const [k, v] of Object.entries(obj)) {
      if (lower(k) === lower(hint) && (typeof v === 'string' || typeof v === 'number') && String(v).length <= 128) {
        return String(v);
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/id$/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length <= 128) return String(v);
  }
  return null;
}

// Resource entries are sometimes wrapped ({resource: {...}, status: ...}).
function unwrapResource(entry) {
  if (typeof entry === 'string') return { arn: entry };
  if (entry && typeof entry === 'object') {
    for (const key of ['resource', 'awsResource', 'item']) {
      if (entry[key] && typeof entry[key] === 'object') return { ...entry[key], ...pickStatus(entry) };
    }
  }
  return entry;
}
function pickStatus(entry) {
  const out = {};
  for (const k of ['status', 'protectionStatus', 'state']) if (entry[k] !== undefined && typeof entry[k] !== 'object') out.status = entry[k];
  return out;
}

// Real Arpio resource entries (confirmed against a live tenant) look like:
//   { arn, type: 'k8sResource'|'acmCertificate'|..., source: {id,name,displayName},
//     target: {arn,id,name}, backupStatus: {state,timestamp}, restoreStatus: {...} }
// K8s items carry EKS-style ARNs with cluster/namespace/.../kind/name segments.
// Explicit selection rules live on the application detail endpoint
// (selectionRules), not on the resources listing.

export function backupNote(res) {
  const bs = res.backupStatus;
  if (bs && typeof bs === 'object' && (bs.state || bs.timestamp)) {
    return `backup ${bs.state || 'status unknown'}${bs.timestamp ? ` as of ${bs.timestamp}` : ''}`;
  }
  return res.status ? `status ${res.status}` : '';
}

export function mapResourceToProposal(raw, appName = '') {
  const res = unwrapResource(raw) || {};
  const src = (res.source && typeof res.source === 'object') ? res.source : {};
  const type = res.type || res.resourceType || res.service ||
    (typeof res.arn === 'string' && res.arn.startsWith('arn:') ? res.arn.split(':')[2] : '');
  const name = src.displayName || src.name || res.displayName || res.name || res.resourceName ||
    (typeof res.arn === 'string' ? res.arn.split(/[/:]/).pop() : '') || src.id || res.id || 'arpio-resource';
  const category = guessCategory(type || res.arn);
  const note = backupNote(res);
  return {
    name: String(name), category, tier: 1, owner: '', team: '',
    description: [type && `Arpio-protected ${type}`, appName && `application '${appName}'`,
      res.arn && `arn ${res.arn}`, res.region && `region ${res.region}`].filter(Boolean).join('; '),
    // Exact ARN promoted top-level: imported components carry it, and
    // enrichment describes that exact resource (no name guessing).
    arn: String(res.arn || src.arn || res.target?.arn || ''), region: String(res.region || ''),
    kind: String(type || 'arpio-resource').toLowerCase(),
    drStrategy: 'inherit', restoreLayer: guessLayer(category),
    replication: {
      mechanism: 'arpio-snapshot', rpoMinutes: res.rpoMinutes ?? null,
      notes: `Protected by Arpio (discovered via Arpio API)${note ? `; ${note}` : ''}`,
    },
    inRecoveryScope: 'yes', definedIn: '',
    dependsOn: [], outboundCalls: [], awsServices: [], secrets: [], endpoints: [],
    verification: { command: '', pass: '' },
    gaps: [], notes: '', tags: ['discovered', 'arpio'],
  };
}

// ---- k8sResource grouping -------------------------------------------------
// A protected EKS app can carry thousands of k8sResource rows (one per k8s
// object). Importing each as a component would be unusable, so we group them
// by cluster + namespace into one proposal per namespace — mirroring how the
// inventory models the application layer — with per-kind counts preserved.

export function parseK8sArn(arn) {
  // EKS-style: segments after the first '/'; namespace usually follows the
  // cluster segment, kind and name are the last two.
  const s = String(arn || '');
  const path = s.includes(':') ? s.slice(s.indexOf(':cluster/') >= 0 ? s.indexOf(':cluster/') + 1 : s.lastIndexOf(':') + 1) : s;
  const seg = path.split('/').filter(Boolean);
  if (!seg.length) return { cluster: '', namespace: '', kind: '', name: '' };
  const cluster = seg[0] === 'cluster' ? (seg[1] || '') : seg[0];
  const start = seg[0] === 'cluster' ? 2 : 1;
  const rest = seg.slice(start);
  const nsIdx = rest.indexOf('namespace');
  const namespace = nsIdx >= 0 ? (rest[nsIdx + 1] || '') : (rest.length >= 3 ? rest[0] : '');
  const name = rest[rest.length - 1] || '';
  const kind = rest.length >= 2 ? rest[rest.length - 2] : '';
  return { cluster, namespace, kind, name };
}

export function isK8sResource(res) {
  return /^k8s/i.test(String(res?.type || '')) ||
    /:cluster\//.test(String(res?.arn || '')) && /\/(Deployment|StatefulSet|DaemonSet|Service|ConfigMap|Secret|Pod|Ingress|CronJob|Job)\//i.test(String(res?.arn || ''));
}

export function groupK8sResources(entries, appName = '') {
  const groups = new Map(); // key cluster|ns
  for (const raw of entries) {
    const res = unwrapResource(raw) || {};
    const { cluster, namespace, kind } = parseK8sArn(res.arn || res.source?.arn || res.target?.arn || '');
    const ns = namespace || '(cluster-scoped)';
    const key = `${cluster}|${ns}`;
    let g = groups.get(key);
    if (!g) g = { cluster, namespace: ns, kinds: {}, count: 0, sampleArn: String(res.arn || '') };
    g.count++;
    if (kind) g.kinds[kind] = (g.kinds[kind] || 0) + 1;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const kindSummary = Object.entries(g.kinds).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, n]) => `${n} ${k}`).join(', ');
    return {
      name: `${g.namespace}${g.cluster ? ` (${g.cluster})` : ''}`,
      category: 'compute', tier: 1, owner: '', team: '',
      kind: 'k8s-namespace',
      description: `Arpio-protected Kubernetes namespace — ${g.count} objects${kindSummary ? ` (${kindSummary})` : ''}` +
        `${appName ? `; application '${appName}'` : ''}`,
      arn: '', region: '',
      drStrategy: 'inherit', restoreLayer: 'L4',
      replication: { mechanism: 'arpio-snapshot', rpoMinutes: null, notes: `Protected by Arpio; ${g.count} k8s objects in scope` },
      inRecoveryScope: 'yes', definedIn: '',
      dependsOn: [], outboundCalls: [], awsServices: ['EKS'], secrets: [], endpoints: [],
      verification: { command: '', pass: '' },
      gaps: [], notes: '', tags: ['discovered', 'arpio', 'k8s'],
    };
  });
}

export class ArpioClient {
  // Accepts either ({ keyId, secret, accountId }) or a combined
  // "keyId:secret" string (with optional accountId as a second arg).
  constructor(key, accountId) {
    if (typeof key === 'object' && key !== null) {
      const { keyId, secret } = key;
      this.apiKey = keyId && secret ? `${keyId.trim()}:${secret.trim()}` : (key.apiKey || '').trim();
      this.accountId = (key.accountId || accountId || '').trim();
    } else {
      this.apiKey = String(key || '').trim();
      this.accountId = (accountId || '').trim();
    }
  }

  hasColonPair() { return this.apiKey.includes(':'); }

  async _get(path) {
    const url = `${BASE}${path}`;
    let res;
    try {
      res = await timedFetch(url, { headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' } });
    } catch (e) {
      const msg = e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : e.message;
      return { ok: false, message: `GET ${path}: ${msg}` };
    }
    const body = await res.text().catch(() => '');
    if (res.ok) {
      try { return { ok: true, data: JSON.parse(body) }; }
      catch { return { ok: false, message: `GET ${path}: non-JSON response (${snippet(body)})` }; }
    }
    let hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = this.hasColonPair()
        ? ' — check the key ID and secret (header format is X-Api-Key: <keyId>:<secret>)'
        : ' — Arpio keys have two parts; send them as <keyId>:<secret>';
    }
    return { ok: false, message: `GET ${path}: HTTP ${res.status} ${snippet(body)}${hint}` };
  }

  async probe() {
    if (!this.apiKey) return { ok: false, message: 'No API key provided' };
    if (!this.hasColonPair()) {
      return { ok: false, message: 'An Arpio API key has two parts (key ID and secret). Enter both — they are sent as "X-Api-Key: <keyId>:<secret>".' };
    }
    // If the caller supplied an account ID, scope to it directly (some keys
    // cannot list accounts but can read their own account's data).
    if (this.accountId) {
      const one = await this._get(`/api/accounts/${encodeURIComponent(this.accountId)}`);
      if (one.ok) return { ok: true, accounts: [{ id: this.accountId, ...one.data }] };
      // fall through to the list attempt so the user gets the better error
    }
    const r = await this._get('/api/accounts');
    if (!r.ok) return r;
    const accounts = findObjectArray(r.data, ['accounts', 'items', 'data', 'results']) || [];
    // A single account object (not a list) is also a valid answer.
    if (!accounts.length && r.data && typeof r.data === 'object' && !Array.isArray(r.data)
        && pickId(r.data, ['id', 'accountId', 'account_id'])) {
      return { ok: true, accounts: [r.data] };
    }
    return { ok: true, accounts };
  }

  // inventory({onLog}) — optional onLog(line) streams each trace line as it
  // is produced (trace lines never contain key material). Default: no-op.
  async inventory({ onLog } = {}) {
    const trace = [];
    const t = (line) => {
      trace.push(line);
      if (typeof onLog === 'function') {
        try { onLog(line); } catch { /* an observer must never break the walk */ }
      }
    };
    try {
      const probe = await this.probe();
      if (!probe.ok) return { ...probe, trace };
      const rawAccounts = probe.accounts;
      t(`accounts: ${rawAccounts.length} found${rawAccounts[0] ? ` (${describeShape(rawAccounts[0])})` : ''}`);

      const proposals = [];
      const notes = [];
      for (const acct of rawAccounts.slice(0, 10)) {
        const acctId = pickId(acct, ['id', 'accountId', 'account_id', 'accountID', 'arpioAccountId', 'uuid']);
        if (!acctId) { t(`  account skipped — no id-like field in ${describeShape(acct)}`); continue; }
        const acctLabel = acct.name || acct.displayName || acctId;

        const appsRes = await this._get(`/api/accounts/${encodeURIComponent(acctId)}/applications`);
        if (!appsRes.ok) { notes.push(appsRes.message); t(`  ${acctLabel}: applications → ${appsRes.message}`); continue; }
        const apps = findObjectArray(appsRes.data, ['applications', 'apps', 'items', 'data', 'results']) || [];
        t(`  ${acctLabel}: applications → 200, ${describeShape(appsRes.data)}, extracted ${apps.length}`);

        for (const app of apps.slice(0, 50)) {
          const appId = pickId(app, ['id', 'appId', 'applicationId', 'application_id', 'uuid']);
          const appName = app.name || app.displayName || appId || '';
          if (!appId) { t(`    app skipped — no id-like field in ${describeShape(app)}`); continue; }

          const resRes = await this._get(`/api/accounts/${encodeURIComponent(acctId)}/applications/${encodeURIComponent(appId)}/resources`);
          if (!resRes.ok) { notes.push(resRes.message); t(`    ${appName}: resources → ${resRes.message}`); continue; }
          const resources = findObjectArray(resRes.data,
            ['resources', 'protectedResources', 'resourceStatuses', 'statuses', 'items', 'data', 'results']) || [];
          t(`    ${appName}: resources → 200, ${describeShape(resRes.data)}, extracted ${resources.length}`);

          // Some tenants embed resources directly on the application object.
          const pool = resources.length ? resources
            : (findObjectArray(app, ['resources', 'protectedResources']) || []);
          if (!resources.length && pool.length) t(`    ${appName}: using ${pool.length} resources embedded on the application object`);

          // A protected EKS app can carry thousands of k8s object rows —
          // group those by cluster/namespace; AWS resources stay individual.
          const k8s = []; const aws = [];
          for (const r of pool.slice(0, 10000)) (isK8sResource(unwrapResource(r)) ? k8s : aws).push(r);
          const nsProposals = groupK8sResources(k8s, appName);
          if (k8s.length) t(`    ${appName}: ${k8s.length} k8s objects grouped into ${nsProposals.length} namespace proposal(s)`);
          if (aws.length) t(`    ${appName}: ${aws.length} AWS resource proposal(s)`);
          proposals.push(...nsProposals);
          for (const r of aws.slice(0, 1000)) proposals.push(mapResourceToProposal(r, appName));

          // Explicit selection rules live on the application detail endpoint —
          // surface their existence in the trace (informational only).
          if (pool.length) {
            const appDetail = await this._get(`/api/accounts/${encodeURIComponent(acctId)}/applications/${encodeURIComponent(appId)}`);
            const rules = appDetail.ok ? findObjectArray(appDetail.data, ['selectionRules', 'rules']) : null;
            if (rules?.length) t(`    ${appName}: application detail has ${rules.length} selection rule(s)`);
          }
        }

        // Diagnostic only: where else protected things might live for this tenant.
        if (!proposals.length) {
          const aws = await this._get(`/api/accounts/${encodeURIComponent(acctId)}/awsAccounts`);
          if (aws.ok) t(`  ${acctLabel}: awsAccounts → 200, ${describeShape(aws.data)} (diagnostic — not walked)`);
        }
      }

      if (!proposals.length) {
        return {
          ok: false,
          message: 'Connected to Arpio and authenticated, but extracted no protected resources. '
            + 'The trace below shows exactly what each endpoint returned — if a step shows data the client '
            + 'is not extracting, please share the trace (it contains no secrets) so the walk can be adjusted.',
          trace,
        };
      }
      return { ok: true, proposals, trace, message: notes.length ? `Partial: ${notes.slice(0, 3).join(' | ')}` : '' };
    } catch (e) {
      return { ok: false, message: `Arpio inventory failed: ${e.message}`, trace };
    }
  }
}
