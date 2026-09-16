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
  if (/(ec2|instance|eks|ecs|lambda|asg|autoscal|compute)/.test(t)) return 'compute';
  return 'other';
}

function guessLayer(category) {
  return { database: 'L3', storage: 'L3', 'messaging-streaming': 'L3', 'security-secrets': 'L3',
    'edge-dns': 'L5', 'identity-access': 'L0', networking: 'L2', compute: 'L4' }[category] || 'L4';
}

export function mapResourceToProposal(res, appName = '') {
  const type = res.type || res.resourceType || res.service || '';
  const name = res.name || res.displayName || res.id || res.arn?.split('/').pop() || 'arpio-resource';
  const category = guessCategory(type || res.arn);
  return {
    name: String(name), category, tier: 1, owner: '', team: '',
    description: [type && `Arpio-protected ${type}`, appName && `application '${appName}'`,
      res.arn && `arn ${res.arn}`, res.region && `region ${res.region}`].filter(Boolean).join('; '),
    // Exact ARN promoted top-level: imported components carry it, and
    // enrichment describes that exact resource (no name guessing).
    arn: String(res.arn || ''), region: String(res.region || ''),
    kind: String(type || 'arpio-resource').toLowerCase(),
    drStrategy: 'inherit', restoreLayer: guessLayer(category),
    replication: { mechanism: 'arpio-snapshot', rpoMinutes: res.rpoMinutes ?? null, notes: 'Protected by Arpio (discovered via Arpio API)' },
    inRecoveryScope: 'yes', definedIn: '',
    dependsOn: [], outboundCalls: [], awsServices: [], secrets: [], endpoints: [],
    verification: { command: '', pass: '' },
    gaps: [], notes: '', tags: ['discovered', 'arpio'],
  };
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
    const d = r.data;
    const accounts = Array.isArray(d) ? d : (d.accounts || d.items || d.data || []);
    return { ok: true, accounts: Array.isArray(accounts) ? accounts : [] };
  }

  async inventory() {
    try {
      const probe = await this.probe();
      if (!probe.ok) return probe;
      const proposals = [];
      const notes = [];
      for (const acct of probe.accounts.slice(0, 10)) {
        const acctId = acct.id || acct.accountId || acct.arpioAccountId;
        if (!acctId) continue;
        const appsRes = await this._get(`/api/accounts/${encodeURIComponent(acctId)}/applications`);
        if (!appsRes.ok) { notes.push(appsRes.message); continue; }
        const d = appsRes.data;
        const apps = Array.isArray(d) ? d : (d.applications || d.items || d.data || []);
        for (const app of (Array.isArray(apps) ? apps : []).slice(0, 50)) {
          const appId = app.id || app.applicationId;
          const appName = app.name || appId || '';
          if (!appId) continue;
          const resRes = await this._get(`/api/accounts/${encodeURIComponent(acctId)}/applications/${encodeURIComponent(appId)}/resources`);
          if (!resRes.ok) { notes.push(resRes.message); continue; }
          const rd = resRes.data;
          const resources = Array.isArray(rd) ? rd : (rd.resources || rd.items || rd.data || []);
          for (const r of (Array.isArray(resources) ? resources : []).slice(0, 200)) {
            proposals.push(mapResourceToProposal(r, appName));
          }
        }
      }
      if (!proposals.length) {
        return {
          ok: false,
          message: `Connected to Arpio but found no protected resources at the expected paths.${notes.length ? ` Details: ${notes.slice(0, 3).join(' | ')}` : ''} Your tenant's API version may use different endpoints — see server/lib/arpio-client.js.`,
        };
      }
      return { ok: true, proposals, message: notes.length ? `Partial: ${notes.slice(0, 3).join(' | ')}` : '' };
    } catch (e) {
      return { ok: false, message: `Arpio inventory failed: ${e.message}` };
    }
  }
}
