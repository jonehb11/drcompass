// Discovery routes: AWS CLI scan, Arpio read-only API, local AI bridge.
//
// ENVIRONMENT AWARENESS (v0.7, docs/ENV-SERVICE-MODEL.md)
// Every discovery path takes an optional `envId`. When one is given, the scan
// runs against THAT environment's account — its `awsProfile`, its
// `regions.primary`, its `kubeContext` — and everything it proposes carries
// `envId`, so an import lands in that environment and nowhere else. When no
// `envId` is given (a workspace with no environments, or a deliberate
// unscoped run) every response and every write is byte-identical to what it
// was before environments existed: no `scope` block, no `envId` on proposals
// or components, no change to the resource graph.
import { Router } from 'express';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from '../store.js';
import {
  listProfiles, listProfilesDetailed, discover, awsCliFound, awsVaultFound,
  awsArgs, resolveAuthVia, SERVICE_IDS,
} from '../lib/aws-discovery.js';
import { scanMap, normalizeArtifact, discoveryScript } from '../lib/aws-scan-map.js';
import { mergeGraph } from '../lib/aws-enrich.js';
import { ArpioClient } from '../lib/arpio-client.js';
import { ask, suggestComponents, claudeCliFound, serializeContext } from '../lib/ai-bridge.js';
import { listEnvironments, getEnvironment, UNASSIGNED } from '../lib/scope.js';

const r = Router();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ------------------------------------------------------------ environments
// One resolver for every discovery path, exported so the jobs, k8s and
// network routes scope the same way (and can never drift from this one).
//
// Returns null for "no environment" — a blank id, 'all'/'any', or the literal
// 'unassigned' (which for a WRITE means exactly the same thing: leave it
// untagged). An id that names no environment is a 404 with the known ids,
// never a silent unscoped run: scanning prod and quietly writing components
// with no environment is how an inventory becomes untrustworthy.

const BLANK_ENV = new Set(['', 'all', 'any', 'null', 'undefined']);

export function resolveDiscoveryEnv(ws, envId, { workspace = null } = {}) {
  const id = String(envId ?? '').trim();
  if (BLANK_ENV.has(id.toLowerCase())) return null;
  const meta = workspace || store.getWorkspace(ws);
  if (id.toLowerCase() === UNASSIGNED) return null; // "unassigned" == untagged
  const env = getEnvironment(ws, id, meta);
  if (!env) {
    const envs = listEnvironments(ws, meta);
    throw store.httpError(404, envs.length
      ? `no environment '${id}' in workspace '${ws}' — known environments: ${envs.map((e) => `${e.id} (${e.name})`).join(', ')}`
      : `no environment '${id}': workspace '${ws}' has no environments defined, so discovery here is single-environment`);
  }
  return {
    id: String(env.id),
    name: String(env.name || env.id),
    slug: String(env.slug || env.id),
    env,
    // What this environment scans WITH. A caller may override any of them
    // (the UI pre-fills them and lets the user edit); these are the defaults
    // that make "pick prod, press scan" do the right thing.
    profile: String(env.awsProfile || ''),
    region: String(env.regions?.primary || meta.regions?.primary || ''),
    kubeContext: String(env.kubeContext || ''),
  };
}

// Caller's explicit profile/region win; blanks fall back to the environment's.
export function envConnection(envInfo, body = {}) {
  const profile = String(body?.profile ?? '').trim() || (envInfo ? envInfo.profile : '');
  const region = String(body?.region ?? '').trim() || (envInfo ? envInfo.region : '');
  return { profile, region };
}

// The `scope:` block §3 of the contract requires on a scoped response, and
// nothing at all when the run was unscoped.
export function envScope(envInfo, extra = {}) {
  if (!envInfo) return null;
  return {
    envId: envInfo.id, envName: envInfo.name, envSlug: envInfo.slug,
    awsProfile: envInfo.profile, region: envInfo.region, kubeContext: envInfo.kubeContext,
    ...extra,
  };
}

// Stamp the environment onto proposals so the import route (and the review
// table) know where they belong. Unscoped: the SAME array, untouched.
export function tagProposals(proposals, envInfo) {
  if (!envInfo || !Array.isArray(proposals)) return proposals;
  return proposals.map((p) => (p && typeof p === 'object'
    ? { ...p, envId: envInfo.id, envName: envInfo.name } : p));
}

const compEnv = (c) => String(c?.envId || '');

// Exported (additive) for the background-jobs route, which must produce
// byte-compatible results for the same operations.
//
// Environment rule (§5 of the brief): a prod scan that proposes a component
// whose name already exists in DEV has NOT found something that already
// exists — those are two different resources in two different accounts. So
// `existing` is decided within the scanned environment only, and the
// cross-environment namesakes are reported separately, as information, on
// `existingInOtherEnvs`. With no envId the match is workspace-wide, exactly
// as it always was.
export function markExisting(proposals, existing, envInfo = null, { environments = [] } = {}) {
  const envId = envInfo ? envInfo.id : '';
  const mine = envId ? existing.filter((c) => compEnv(c) === envId) : existing;
  const byName = new Set(mine.map((c) => norm(c.name)));
  const byKindName = new Set(mine.map((c) => `${c.kind}::${norm(c.name)}`));
  const byArn = new Set(mine.map((c) => c.arn).filter(Boolean));

  // name -> [{envId, envName}] for components living in OTHER environments.
  const elsewhere = new Map();
  if (envId) {
    const envNames = new Map(environments.map((e) => [String(e.id), String(e.name || e.id)]));
    for (const c of existing) {
      const ce = compEnv(c);
      if (ce === envId) continue;
      const key = norm(c.name);
      if (!key) continue;
      if (!elsewhere.has(key)) elsewhere.set(key, []);
      const list = elsewhere.get(key);
      const label = ce ? (envNames.get(ce) || ce) : 'unassigned';
      if (!list.some((x) => x.envId === ce)) list.push({ envId: ce, envName: label, componentId: c.id });
    }
  }

  return proposals.map((p) => {
    const hits = envId ? (elsewhere.get(norm(p.name)) || []) : [];
    return {
      ...p,
      existing: byName.has(norm(p.name)) || byKindName.has(`${p.kind}::${norm(p.name)}`)
        || !!(p.arn && byArn.has(p.arn)),
      ...(hits.length ? { existingInOtherEnvs: hits } : {}),
    };
  });
}

// markExisting + tagProposals for a scanned result, in one place. Exported so
// the jobs route produces byte-identical proposals for the same operation.
export function reviewProposals(ws, proposals, envInfo) {
  const existing = store.getCollection(ws, 'components');
  const environments = envInfo ? listEnvironments(ws) : [];
  return markExisting(tagProposals(proposals, envInfo), existing, envInfo, { environments });
}

// ---------------------------------------------------------------- AWS

r.get('/discover/aws/profiles', async (req, res, next) => {
  try {
    // Additive: `profiles` (names, ~/.aws only — unchanged shape) plus
    // `profilesDetailed` merging ~/.aws with aws-vault's profile list.
    const [cliFound, vaultFound, profilesDetailed] = await Promise.all([
      awsCliFound(), awsVaultFound(), listProfilesDetailed(),
    ]);
    res.json({
      profiles: listProfiles(), profilesDetailed,
      awsCliFound: cliFound, awsVaultFound: vaultFound, services: SERVICE_IDS,
    });
  } catch (e) { next(e); }
});

r.post('/w/:ws/discover/aws', async (req, res, next) => {
  try {
    const { services = [], authVia = '' } = req.body || {};
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.body?.envId);
    const { profile, region } = envConnection(envInfo, req.body);
    const result = await discover({ profile, region, services, authVia: String(authVia || '') });
    const scope = envScope(envInfo);
    res.json({
      ...result,
      proposals: reviewProposals(req.params.ws, result.proposals, envInfo),
      ...(scope ? { scope } : {}),
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------ AWS auth
// Credential pre-flight + login launcher. DR Compass never reads, stores, or
// proxies credentials: the check is one `sts get-caller-identity` through the
// user's own CLI, and login spawns `aws sso login` / `aws-vault exec` which
// open the browser / OS prompt ON THIS MACHINE. Only identity metadata
// (account id + role ARN) and stderr snippets ever reach the UI.

const execFile = promisify(execFileCb);
const PROFILE_RE = /^[\w@.:\/-]{1,128}$/;
const AUTH_CHECK_TIMEOUT = 20000;
const LOGIN_TIMEOUT = 240000;

const stderrSnippet = (e) => ((e && e.stderr) || '').toString().trim()
  .split('\n').slice(-3).join(' ').slice(0, 300)
  || String((e && e.message) || 'unknown error').slice(0, 300);

function checkProfileName(profile) {
  if (profile && !PROFILE_RE.test(profile)) {
    throw store.httpError(400, 'invalid profile name');
  }
}

// How a profile can (re)authenticate: 'sso' | 'vault' | 'keys'.
async function loginMethodFor(profile, via) {
  let detail = null;
  try { detail = (await listProfilesDetailed()).find((p) => p.name === profile) || null; }
  catch { /* best effort */ }
  if (via === 'vault' || (detail && detail.source === 'vault')) return 'vault';
  if (detail && detail.sso) return 'sso';
  if (detail && detail.vault) return 'vault'; // in vault too — vault can refresh it
  return 'keys';
}

r.get('/discover/aws/auth/check', async (req, res, next) => {
  try {
    const profile = String(req.query.profile || '').trim();
    checkProfileName(profile);
    const via = await resolveAuthVia(profile, String(req.query.via || ''));
    // vault mode needs the profile name verbatim; profile mode treats
    // 'default' as "no --profile" (matching the scan runners).
    const effProfile = via === 'vault' ? profile : (profile !== 'default' ? profile : '');
    const { bin, args } = awsArgs(effProfile,
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { via });
    try {
      const { stdout } = await execFile(bin, args, {
        timeout: AUTH_CHECK_TIMEOUT, maxBuffer: 1024 * 1024, env: process.env,
      });
      const id = JSON.parse(stdout.toString().trim() || '{}');
      return res.json({ ok: true, via, identity: { account: id.Account || '', arn: id.Arn || '' } });
    } catch (e) {
      const method = await loginMethodFor(profile, via);
      const canLogin = method === 'sso' || method === 'vault';
      const loginHint = method === 'sso'
        ? `Runs \`aws sso login --profile ${profile || 'default'}\` and opens your browser`
        : method === 'vault'
          ? `Runs \`aws-vault exec ${profile}\` — aws-vault opens its own browser/keychain prompt`
          : 'This profile uses static keys — refresh credentials in your terminal';
      return res.json({
        ok: false, via, error: stderrSnippet(e),
        canLogin, method, loginHint,
      });
    }
  } catch (e) { next(e); }
});

// One login process per profile at a time, tracked in-memory only.
const logins = new Map(); // profile -> {running, startedAt, method, exitCode, ok, stderrTail}

r.post('/discover/aws/auth/login', async (req, res, next) => {
  try {
    const profile = String(req.body?.profile || '').trim();
    checkProfileName(profile);
    if (!profile) throw store.httpError(400, 'a profile is required to launch a login');
    const cur = logins.get(profile);
    if (cur && cur.running) {
      return res.status(409).json({
        error: `a login for '${profile}' is already in progress — finish it in your browser, or wait for it to time out`,
      });
    }
    const via = await resolveAuthVia(profile, String(req.body?.via || ''));
    const method = await loginMethodFor(profile, via);
    if (method === 'keys') {
      throw store.httpError(400,
        `profile '${profile}' has no login flow (static keys) — refresh credentials in your terminal`);
    }
    const [bin, ...args] = method === 'vault'
      ? ['aws-vault', 'exec', profile, '--', 'aws', 'sts', 'get-caller-identity', '--no-cli-pager']
      : ['aws', 'sso', 'login', '--profile', profile];

    const rec = { running: true, startedAt: new Date().toISOString(), method, exitCode: null, ok: null, stderrTail: '' };
    logins.set(profile, rec);
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, LOGIN_TIMEOUT);
    if (typeof killer.unref === 'function') killer.unref();
    child.on('error', (e) => {
      clearTimeout(killer);
      rec.running = false; rec.ok = false; rec.exitCode = -1;
      rec.stderrTail = (e && e.message) || 'failed to start the login process';
    });
    child.on('exit', (code) => {
      clearTimeout(killer);
      rec.running = false;
      rec.exitCode = code;
      rec.ok = code === 0;
      rec.stderrTail = stderrTail.trim().slice(-500);
    });
    res.json({ started: true, method });
  } catch (e) { next(e); }
});

r.get('/discover/aws/auth/login/:profile/status', (req, res, next) => {
  try {
    const profile = String(req.params.profile || '').trim();
    checkProfileName(profile);
    const rec = logins.get(profile);
    if (!rec) return res.json({ running: false });
    res.json({
      running: rec.running, method: rec.method, startedAt: rec.startedAt,
      exitCode: rec.exitCode, ok: rec.ok, stderrTail: rec.stderrTail,
    });
  } catch (e) { next(e); }
});

// Import proposals as components. Back-compat: classic (flat) proposals are
// imported exactly as before. Extended scan-map proposals additionally
//   - persist `arn` (additive schema field — part of the flat rest spread),
//   - wire component.dependsOn from dependsOnProposals (imported keys first,
//     then existing components whose arn/name matches the key),
//   - merge each proposal's associations + associationEdges into the
//     'resource-graph' object store (nodes attributed to the new component
//     id, source 'aws-scan'; deduped by rid via mergeGraph).
r.post('/w/:ws/discover/aws/import', (req, res, next) => {
  try {
    const proposals = Array.isArray(req.body?.proposals) ? req.body.proposals : [];
    if (!proposals.length) throw store.httpError(400, 'no proposals to import');
    const ws = req.params.ws;
    // The environment comes from the request; failing that, from the
    // proposals themselves (a scan stamps every proposal it returns), so a
    // client that simply posts back what it was given still lands in the
    // right environment.
    const envInfo = resolveDiscoveryEnv(ws, req.body?.envId
      ?? proposals.find((p) => p && p.envId)?.envId);
    const envId = envInfo ? envInfo.id : '';
    const items = store.getCollection(ws, 'components');
    // Dependency wiring only ever links within the environment being
    // imported — an adjudication-service in dev is not what a prod component
    // depends on, however identical the name.
    const preExisting = envId ? items.filter((c) => compEnv(c) === envId) : [...items];
    const now = new Date().toISOString();

    const keyToId = new Map();
    const created = []; // [{cmp, p}]
    for (const p of proposals) {
      const { existing, id, key, associations, associationEdges, dependsOnProposals, mapRef, direct, inbound,
        envName, existingInOtherEnvs, ...rest } = p || {};
      if (!rest.name) continue;
      const cmp = { ...rest, id: store.newId('cmp'), updatedAt: now };
      // envId is written only when there is one — an unscoped import produces
      // exactly the component shape it always did.
      if (envId) cmp.envId = envId;
      items.push(cmp);
      created.push({ cmp, p });
      if (key && !keyToId.has(key)) keyToId.set(key, cmp.id);
    }

    // dependsOn wiring: key -> imported component, else an existing component
    // whose arn or (normalized) name matches the key.
    const keyName = (k) => String(k || '').includes(':') && !String(k).startsWith('arn:')
      ? String(k).split(':').slice(1).join(':') : String(k || '');
    const findExisting = (depKey) => {
      for (const c of preExisting) {
        if (c.arn && c.arn === depKey) return c.id;
        if (norm(c.name) && (norm(c.name) === norm(depKey) || norm(c.name) === norm(keyName(depKey)))) return c.id;
      }
      return null;
    };
    let linked = 0;
    for (const { cmp, p } of created) {
      const deps = Array.isArray(p?.dependsOnProposals) ? p.dependsOnProposals : [];
      for (const depKey of deps) {
        const target = keyToId.get(depKey) || findExisting(depKey);
        if (!target || target === cmp.id) continue;
        cmp.dependsOn = Array.isArray(cmp.dependsOn) ? cmp.dependsOn : [];
        if (!cmp.dependsOn.includes(target)) { cmp.dependsOn.push(target); linked++; }
      }
    }
    store.saveCollection(ws, 'components', items);

    // Merge association trees into the resource graph (only touched when at
    // least one extended proposal was imported — old-shape imports never
    // create/modify resource-graph.json).
    const additions = { nodes: {}, edges: [] };
    for (const { cmp, p } of created) {
      const assocs = Array.isArray(p?.associations) ? p.associations : [];
      for (const a of assocs) {
        if (!a || !a.rid) continue;
        let n = additions.nodes[a.rid];
        if (!n) {
          n = additions.nodes[a.rid] = {
            rid: a.rid, type: a.type || 'other', service: a.service || '',
            name: a.name || a.rid, arn: a.arn || '', region: a.region || '',
            componentIds: [], details: {}, tags: {}, source: 'aws-scan',
            // Additive: which environment's account this resource was seen in.
            ...(envId ? { envId } : {}),
          };
        }
        if (!n.componentIds.includes(cmp.id)) n.componentIds.push(cmp.id);
        if (a.arn && !n.arn) n.arn = a.arn;
        Object.assign(n.details, a.details || {});
        Object.assign(n.tags, a.tags || {});
        if (a.direct) {
          additions.edges.push(a.inbound
            ? { from: a.rid, to: cmp.id, relation: a.relation || 'uses' }
            : { from: cmp.id, to: a.rid, relation: a.relation || 'uses' });
        }
      }
      for (const e of Array.isArray(p?.associationEdges) ? p.associationEdges : []) {
        if (e && e.from && e.to) additions.edges.push({ from: e.from, to: e.to, relation: e.relation || 'uses' });
      }
    }
    let graphNodesAdded = 0; let graphEdgesAdded = 0;
    if (Object.keys(additions.nodes).length || additions.edges.length) {
      const existingGraph = store.getObject(ws, 'resource-graph') || {};
      const { graph, stats } = mergeGraph(existingGraph, additions);
      store.saveObject(ws, 'resource-graph', graph);
      graphNodesAdded = stats.addedNodes;
      graphEdgesAdded = stats.addedEdges;
    }

    const scope = envScope(envInfo, { componentCount: created.length });
    res.json({
      imported: created.length, graphNodesAdded, graphEdgesAdded, linked,
      ...(scope ? { scope, envId } : {}),
    });
  } catch (e) { next(e); }
});

// One-pass Arpio-parity scan: proposals WITH association trees and
// cross-proposal dependency links (contract shape — see aws-scan-map.js).
r.post('/w/:ws/discover/aws/scan-map', async (req, res, next) => {
  try {
    const { services = [], mapDependencies = true, authVia = '' } = req.body || {};
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.body?.envId);
    const { profile, region } = envConnection(envInfo, req.body);
    const result = await scanMap({
      profile: String(profile || ''), region: String(region || ''),
      services: Array.isArray(services) ? services : [],
      mapDependencies: mapDependencies !== false,
      authVia: String(authVia || ''),
    });
    const scope = envScope(envInfo);
    res.json({
      ...result,
      proposals: reviewProposals(req.params.ws, result.proposals, envInfo),
      ...(scope ? { scope } : {}),
    });
  } catch (e) { next(e); }
});

// A shell-safe double-quoted literal (the values are an environment name, an
// id and an AWS profile/region — all already charset-limited, but a script we
// hand someone to run gets belt and braces).
const shq = (v) => String(v ?? '').replace(/[\\$"`]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 200);

// Make the generated read-only script carry its environment: it defaults
// PROFILE/REGION to that environment's, and it records `envId`/`envName`
// inside the artifact it writes, so the upload lands back in the same
// environment even if it is opened days later on a different machine.
//
// Both edits are made WITHOUT touching aws-scan-map.js's generator: the
// preamble goes in after the shebang (where PROFILE/REGION are still unset,
// so the script's own `${PROFILE:-}` defaults pick ours up), and the artifact
// stamp is appended after the script's own assembly step.
export function envAwareScript(text, envInfo) {
  if (!envInfo) return text;
  const lines = String(text).split('\n');
  const at = lines[0].startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, [
    '',
    `# ---- DR Compass environment: ${shq(envInfo.name)} (${shq(envInfo.id)}) ----`,
    '# This capture is FOR THAT ENVIRONMENT. PROFILE/REGION below are its own;',
    '# override them on the command line if this box names them differently.',
    `DRCOMPASS_ENV_ID="${shq(envInfo.id)}"`,
    `DRCOMPASS_ENV_NAME="${shq(envInfo.name)}"`,
    ...(envInfo.profile ? [`PROFILE="\${PROFILE:-${shq(envInfo.profile)}}"`] : []),
    ...(envInfo.region ? [`REGION="\${REGION:-${shq(envInfo.region)}}"`] : []),
    '',
  ].join('\n'));
  return `${lines.join('\n')}
# ---- stamp the environment into the artifact --------------------------
if [ -f "$OUT" ] && [ -n "\${DRCOMPASS_ENV_ID:-}" ]; then
  if [ "$TOOL" = "jq" ]; then
    jq --arg id "$DRCOMPASS_ENV_ID" --arg name "$DRCOMPASS_ENV_NAME" \\
      '. + {envId: $id, envName: $name}' "$OUT" > "$OUT.env" && mv "$OUT.env" "$OUT"
  else
    python3 - "$OUT" "$DRCOMPASS_ENV_ID" "$DRCOMPASS_ENV_NAME" <<'PYENVSTAMP'
import json, sys
out, env_id, env_name = sys.argv[1:4]
with open(out) as fh:
    data = json.load(fh)
data['envId'] = env_id
data['envName'] = env_name
with open(out, 'w') as fh:
    json.dump(data, fh, indent=2)
PYENVSTAMP
  fi
  echo "Recorded DR Compass environment: $DRCOMPASS_ENV_NAME ($DRCOMPASS_ENV_ID)"
fi
`;
}

function sendScript(res, { services, envInfo }) {
  const name = envInfo
    ? `drcompass-aws-discovery-${String(envInfo.slug || envInfo.id).replace(/[^a-zA-Z0-9._-]+/g, '-')}.sh`
    : 'drcompass-aws-discovery.sh';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(envAwareScript(discoveryScript({ services }), envInfo));
}

const scriptServices = (q) => String(q || '').split(',')
  .map((s) => s.trim()).filter((s) => SERVICE_IDS.includes(s));

// Downloadable READ-ONLY discovery script for environments where this box
// has no AWS credentials. ?services=a,b,c limits the capture.
r.get('/discover/aws/script', (req, res, next) => {
  try {
    sendScript(res, { services: scriptServices(req.query.services), envInfo: null });
  } catch (e) { next(e); }
});

// Same script, for one environment of one workspace: its profile, its region,
// and an artifact that says which environment it was captured for.
r.get('/w/:ws/discover/aws/script', (req, res, next) => {
  try {
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.query.envId);
    sendScript(res, { services: scriptServices(req.query.services), envInfo });
  } catch (e) { next(e); }
});

// Upload the script's artifact — normalized through the SAME discoverers +
// collectors as scan-map. Review-only: nothing is imported here.
//
// The environment is whichever the UI is pointed at (`targetEnvId`), falling
// back to the one the artifact itself records. When the two disagree the
// upload still works — you may genuinely be importing a prod capture into a
// prod environment you renamed — but the response says so rather than
// quietly filing prod resources under dev.
r.post('/w/:ws/discover/aws/upload', async (req, res, next) => {
  try {
    const ws = req.params.ws;
    const target = String(req.body?.targetEnvId ?? '').trim();
    const artifactEnvRaw = String(req.body?.envId ?? '').trim();
    const envInfo = resolveDiscoveryEnv(ws, target || artifactEnvRaw);
    const warnings = [];
    if (target && artifactEnvRaw && envInfo && artifactEnvRaw !== envInfo.id) {
      warnings.push(`this artifact records environment '${String(req.body?.envName || artifactEnvRaw)}' but you are importing it into '${envInfo.name}' — check that is what you meant`);
    }
    const result = await normalizeArtifact(req.body);
    const scope = envScope(envInfo);
    res.json({
      ...result,
      errors: [...(result.errors || []), ...warnings],
      proposals: reviewProposals(ws, result.proposals, envInfo),
      ...(scope ? { scope } : {}),
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- Arpio

r.post('/w/:ws/discover/arpio', async (req, res, next) => {
  try {
    // Accept the two-part key (keyId + secret) or a pre-combined
    // "keyId:secret" string; optional accountId scopes the scan.
    const keyId = String(req.body?.apiKeyId || '').trim();
    const secret = String(req.body?.apiSecret || '').trim();
    const combined = String(req.body?.apiKey || '').trim();
    const accountId = String(req.body?.accountId || '').trim();
    const apiKey = keyId && secret ? `${keyId}:${secret}` : combined;
    if (!apiKey) return res.json({ ok: false, message: 'An Arpio API key (key ID + secret) is required' });
    // An Arpio tenant protects one account, so its import belongs to one
    // environment too.
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.body?.envId);
    const client = new ArpioClient(apiKey, accountId); // key used per-request only; never persisted
    const inv = await client.inventory();
    if (!inv.ok) return res.json({ ok: false, message: inv.message, trace: inv.trace || [] });
    const scope = envScope(envInfo);
    res.json({
      ok: true,
      proposals: reviewProposals(req.params.ws, inv.proposals, envInfo),
      message: inv.message || '', trace: inv.trace || [],
      ...(scope ? { scope } : {}),
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- AI

r.get('/discover/ai/status', async (req, res, next) => {
  try {
    res.json({ claudeCliFound: await claudeCliFound() });
  } catch (e) { next(e); }
});

r.post('/w/:ws/ai/ask', async (req, res, next) => {
  try {
    const { prompt = '', includeContext = false } = req.body || {};
    let context;
    if (includeContext) {
      const workspace = store.getWorkspace(req.params.ws);
      const components = store.getCollection(req.params.ws, 'components');
      context = serializeContext({ workspace, components });
    }
    const result = await ask({ prompt, context });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/w/:ws/ai/suggest', async (req, res, next) => {
  try {
    const { freeText = '' } = req.body || {};
    const workspace = store.getWorkspace(req.params.ws);
    const components = store.getCollection(req.params.ws, 'components');
    const envInfo = resolveDiscoveryEnv(req.params.ws, req.body?.envId, { workspace });
    const result = await suggestComponents({ workspace, components, freeText });
    if (result.ok && Array.isArray(result.proposals)) {
      result.proposals = reviewProposals(req.params.ws, result.proposals, envInfo);
      const scope = envScope(envInfo);
      if (scope) result.scope = scope;
    }
    res.json(result);
  } catch (e) { next(e); }
});

export default r;
