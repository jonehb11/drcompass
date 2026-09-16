// AWS "Scan & map" — Arpio-parity one-pass account scan.
//
// One pass produces the classic Component-shaped proposals from
// aws-discovery.js PLUS, for each proposal, its association tree (SGs,
// subnets + AZs, IAM, target groups, listeners, KMS, certs, tags, ...)
// walked with the aws-enrich collector suite, and cross-proposal dependency
// links so the UI can auto-select dependencies Arpio-style.
//
// Contract (HARD — the UI codes against this): every proposal is the
// Component shape plus
//   { key, arn, associations: [{rid,type,service,name,relation,arn,region,
//       details,tags,direct,inbound}],
//     associationEdges: [{from,to,relation}],   // rids only
//     dependsOnProposals: [key...], existing: bool }
//
// Three entry points share one code path:
//   scanMap()           — live CLI scan + association mapping
//   normalizeArtifact() — same discoverers/collectors replayed over the
//                         uploaded read-only script artifact
//   discoveryScript()   — generates that read-only bash script
import {
  awsCliFound, makeCliRunner, runDiscoverers, SERVICE_IDS,
} from './aws-discovery.js';
import {
  COLLECTORS, makeGraphBuilder, pickCollectors, ridFromArn,
  deepSecurityGroups, deepSubnets, deepRoles, deepVpcs,
} from './aws-enrich.js';

const CONCURRENCY = 3;

// ---------------------------------------------------------------- utils

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

function shortErr(e) {
  if (e && e.code === 'ENOENT') return 'aws binary not found';
  if (e && (e.killed || e.signal === 'SIGTERM')) return 'timed out';
  const stderr = ((e && e.stderr) || '').toString().trim().split('\n').slice(-3).join(' ');
  return (stderr || (e && e.message) || 'unknown error').slice(0, 300);
}

async function withConcurrency(tasks, limit = CONCURRENCY) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- runners

// Memoize identical read-only calls within one pass (the discoverer and the
// collector both describe the same cluster; 50 lambdas would otherwise each
// re-list functions).
export function makeCachedRunner(run) {
  const cache = new Map();
  return (args, opts = {}) => {
    const key = args.join(' ');
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve(run(args, opts)).catch((e) => { cache.delete(key); throw e; }));
    }
    return cache.get(key);
  };
}

// Per-proposal "focus" wrapper: narrows the top-level list calls the enrich
// collectors start from down to the proposal's exact resource (fresh ids from
// the scan — no re-matching heuristics). Sub-calls (describe-listeners,
// get-queue-attributes, ...) pass through untouched.
const FOCUS_FILTERS = new Map(Object.entries({
  'elbv2 describe-load-balancers': (res, ids) => ({ ...res, LoadBalancers: (res.LoadBalancers || []).filter((l) => ids.has(l.LoadBalancerName) || ids.has(l.LoadBalancerArn)) }),
  'eks list-clusters': (res, ids) => ({ ...res, clusters: (res.clusters || []).filter((c) => ids.has(c)) }),
  'rds describe-db-clusters': (res, ids) => ({ ...res, DBClusters: (res.DBClusters || []).filter((c) => ids.has(c.DBClusterIdentifier) || ids.has(c.DBClusterArn)) }),
  'rds describe-db-instances': (res, ids) => ({ ...res, DBInstances: (res.DBInstances || []).filter((i) => ids.has(i.DBInstanceIdentifier) || ids.has(i.DBInstanceArn)) }),
  'elasticache describe-replication-groups': (res, ids) => ({ ...res, ReplicationGroups: (res.ReplicationGroups || []).filter((g) => ids.has(g.ReplicationGroupId) || ids.has(g.ARN)) }),
  'elasticache describe-cache-clusters': (res, ids) => ({ ...res, CacheClusters: (res.CacheClusters || []).filter((c) => ids.has(c.CacheClusterId) || ids.has(c.ReplicationGroupId)) }),
  'lambda list-functions': (res, ids) => ({ ...res, Functions: (res.Functions || []).filter((f) => ids.has(f.FunctionName) || ids.has(f.FunctionArn)) }),
  'sqs list-queues': (res, ids) => ({ ...res, QueueUrls: (res.QueueUrls || []).filter((u) => ids.has(String(u).split('/').pop())) }),
  's3api list-buckets': (res, ids) => ({ ...res, Buckets: (res.Buckets || []).filter((b) => ids.has(b.Name)) }),
  'apigateway get-rest-apis': (res, ids) => ({ ...res, items: (res.items || []).filter((a) => ids.has(a.name) || ids.has(a.id)) }),
  'apigatewayv2 get-apis': (res, ids) => ({ ...res, Items: (res.Items || []).filter((a) => ids.has(a.Name) || ids.has(a.ApiId)) }),
  'route53 list-hosted-zones': (res, ids) => ({ ...res, HostedZones: (res.HostedZones || []).filter((z) => ids.has(String(z.Name || '').replace(/\.$/, '')) || ids.has(String(z.Id || '').replace(/^\/hostedzone\//, ''))) }),
}));

function makeFocusRun(run, idSet) {
  return async (args, opts = {}) => {
    const res = await run(args, opts);
    const filter = FOCUS_FILTERS.get(args.join(' '));
    return filter && idSet.size ? filter(res || {}, idSet) : res;
  };
}

function idSetOf(p) {
  const ids = new Set((p.mapRef && p.mapRef.names) || []);
  if (p.arn) ids.add(p.arn);
  ids.delete(''); ids.delete(undefined); ids.delete(null);
  return ids;
}

// Match tokens handed to the collectors: the exact resource identifiers,
// doubled so even 2-char names clear aws-enrich's minimum match score. This
// is targeting, not guessing — the list the collector sees is already
// focused to the proposal's own resource.
function focusToks(p) {
  const toks = [];
  for (const n of ((p.mapRef && p.mapRef.names) || []).slice(0, 25)) {
    const t = String(n || '').toLowerCase();
    if (t) toks.push(t, t);
  }
  return toks;
}

// ---------------------------------------------------------------- keys

export function proposalKeys(proposals) {
  const seen = new Map();
  return proposals.map((p) => {
    const ref = p.mapRef || {};
    const name = (ref.names && ref.names[0]) || p.name || 'unnamed';
    let key = p.arn || `${ref.svc || p.kind || 'aws'}:${name}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (n) key = `${key}#${n + 1}`;
    return key;
  });
}

// ---------------------------------------------------------------- mapping

// Runs the aws-enrich collector suite for every proposal (concurrency <= 3),
// then the shared deep passes (SG rules, subnets + AZs + route tables/NACLs,
// IAM roles + policies, VPCs). Returns the shared graph builder; nodes are
// attributed to proposal KEYS via componentIds.
export async function mapAssociations({ proposals, keys, region = '', run, errors }) {
  const g = makeGraphBuilder(region);
  const pendingSgs = new Set(); const pendingSubnets = new Set(); const pendingRoles = new Set();

  const tasks = proposals.map((p, i) => async () => {
    const key = keys[i];
    const collectors = pickCollectors(p);
    if (!collectors.length) return;
    const ctx = {
      run: makeFocusRun(run, idSetOf(p)),
      region, c: p, cid: key, toks: focusToks(p),
      found: () => {},
      softErr: (what, e) => errors.push(`${key}/${what}: ${shortErr(e)}`),
      addNode: (rid, type, service, name, opts = {}) => g.addNode(rid, type, service, name, { ...opts, componentId: key, source: 'aws-scan' }),
      addEdge: g.addEdge,
      wantSg: (id) => { if (id) pendingSgs.add(id); },
      wantSubnet: (id) => { if (id) pendingSubnets.add(id); },
      wantRole: (arn) => { if (arn) pendingRoles.add(arn); },
    };
    for (const name of collectors) {
      try { await COLLECTORS[name](ctx); } catch (e) { errors.push(`${key}/${name}: ${shortErr(e)}`); }
    }
  });
  await withConcurrency(tasks);

  if (pendingSgs.size) await deepSecurityGroups(run, g, pendingSgs, errors);
  if (pendingSubnets.size) await deepSubnets(run, g, pendingSubnets, errors);
  if (pendingRoles.size) await deepRoles(run, g, pendingRoles, errors);
  await deepVpcs(run, g, errors);
  return g;
}

// ---------------------------------------------------------------- contract assembly

// Per-proposal association tree = directed reach from {key + nodes attributed
// to key}. Deep-pass leaves (route tables, NACLs, policies, AZ facts) hang
// off attributed nodes and ride along; shared nodes (VPC, shared SG) appear
// in every proposal that reaches them — import dedupes by rid.
export function assembleContract(proposals, keys, g) {
  const out = proposals.map((p, i) => ({
    ...p, // mapRef is non-enumerable and does not survive the spread
    key: keys[i],
    arn: p.arn || '',
    associations: [],
    associationEdges: [],
    dependsOnProposals: [],
  }));
  if (!g) return out;

  const adj = new Map();
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  }

  for (let i = 0; i < out.length; i++) {
    const key = keys[i];
    const inSet = new Set([key]);
    for (const n of Object.values(g.nodes)) {
      if ((n.componentIds || []).includes(key)) inSet.add(n.rid);
    }
    const queue = [...inSet];
    while (queue.length) {
      const v = queue.shift();
      for (const next of adj.get(v) || []) {
        if (!inSet.has(next) && g.nodes[next]) { inSet.add(next); queue.push(next); }
      }
    }
    inSet.delete(key);

    const relFor = new Map(); const direct = new Set(); const inbound = new Set();
    for (const e of g.edges) {
      if (e.from === key && inSet.has(e.to)) { if (!relFor.has(e.to)) relFor.set(e.to, e.relation); direct.add(e.to); }
      else if (e.to === key && inSet.has(e.from)) { if (!relFor.has(e.from)) relFor.set(e.from, e.relation); direct.add(e.from); inbound.add(e.from); }
    }
    for (const e of g.edges) {
      if (inSet.has(e.from) && inSet.has(e.to) && !relFor.has(e.to)) relFor.set(e.to, e.relation);
    }

    out[i].associations = [...inSet].filter((rid) => g.nodes[rid]).map((rid) => {
      const n = g.nodes[rid];
      return {
        rid, type: n.type, service: n.service, name: n.name,
        relation: relFor.get(rid) || 'uses',
        arn: n.arn || '', region: n.region || '',
        details: n.details || {}, tags: n.tags || {},
        direct: direct.has(rid), inbound: inbound.has(rid),
      };
    });
    out[i].associationEdges = g.edges
      .filter((e) => e.from !== key && e.to !== key && inSet.has(e.from) && inSet.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, relation: e.relation }));
  }

  computeDependsOn(out, proposals);
  return out;
}

// Concrete cross-proposal dependencies ONLY: an identifier in proposal P's
// association set (rid / arn / exact name / terminal arn segment) equals
// another proposal Q's own resource id/arn/name. No shared-association or
// similarity guessing.
function computeDependsOn(out, proposals) {
  const identities = proposals.map((p, i) => {
    const ids = new Set();
    const add = (v) => { const s = String(v || '').trim().toLowerCase(); if (s.length >= 3) ids.add(s); };
    add(p.arn);
    if (p.arn) add(ridFromArn(p.arn));
    for (const n of (p.mapRef && p.mapRef.names) || []) add(n);
    return { key: out[i].key, ids };
  });

  for (let i = 0; i < out.length; i++) {
    const candidates = new Set();
    const add = (v) => { const s = String(v || '').trim().toLowerCase(); if (s.length >= 3) candidates.add(s); };
    for (const a of out[i].associations) {
      add(a.rid); add(a.arn); add(a.name);
      if (a.arn) add(ridFromArn(a.arn));
      add(String(a.rid).split(/[:/]/).pop());
      if (a.arn) add(String(a.arn).split(/[:/]/).pop());
    }
    const deps = new Set();
    for (let j = 0; j < identities.length; j++) {
      if (j === i || identities[j].key === out[i].key) continue;
      for (const id of identities[j].ids) {
        if (candidates.has(id)) { deps.add(identities[j].key); break; }
      }
    }
    out[i].dependsOnProposals = [...deps].sort();
  }
}

// ---------------------------------------------------------------- scan-map (live)

export async function scanMap({ profile = '', region = '', services = [], mapDependencies = true } = {}) {
  const log = []; const errors = [];
  if (!(await awsCliFound())) {
    return { proposals: [], log, errors: ['AWS CLI not found — install awscli and configure a profile'] };
  }
  if (!region) return { proposals: [], log, errors: ['A region is required (e.g. us-east-1)'] };

  const run = makeCachedRunner(makeCliRunner({ profile, region, log }));
  const { proposals, errors: discoverErrors } = await runDiscoverers({ services, region, run });
  errors.push(...discoverErrors);

  const keys = proposalKeys(proposals);
  let g = null;
  if (mapDependencies !== false && proposals.length) {
    g = await mapAssociations({ proposals, keys, region, run, errors });
  }
  return { proposals: assembleContract(proposals, keys, g), log, errors };
}

// ---------------------------------------------------------------- artifact replay

// Which raw.<service> block answers a service's primary list call.
const PRIMARY_CALLS = {
  'eks list-clusters': 'eks',
  'ecs list-clusters': 'ecs',
  'lambda list-functions': 'lambda',
  'autoscaling describe-auto-scaling-groups': 'ec2-asg',
  'rds describe-db-clusters': 'rds',
  'dynamodb list-tables': 'dynamodb',
  'elasticache describe-replication-groups': 'elasticache',
  'sqs list-queues': 'sqs',
  'sns list-topics': 'sns',
  'kinesis list-streams': 'kinesis',
  's3api list-buckets': 's3',
  'secretsmanager list-secrets --max-results 100': 'secrets',
  'route53 list-hosted-zones': 'route53',
  'cloudfront list-distributions': 'cloudfront',
  'elbv2 describe-load-balancers': 'elb',
  'apigateway get-rest-apis': 'apigateway',
  'ecr describe-repositories': 'ecr',
  'transfer list-servers': 'transfer',
  'kafka list-clusters': 'msk',
  'efs describe-file-systems': 'efs',
};

// The live deep passes batch ids (--group-ids a b c / Values=a,b,c); the
// script captures one id per call. Merge the per-id captures back together.
const BATCH_MERGES = [
  { head: ['ec2', 'describe-security-groups', '--group-ids'], list: 'SecurityGroups', idKey: 'GroupId', per: (id) => `ec2 describe-security-groups --group-ids ${id}` },
  { head: ['ec2', 'describe-subnets', '--subnet-ids'], list: 'Subnets', idKey: 'SubnetId', per: (id) => `ec2 describe-subnets --subnet-ids ${id}` },
  { head: ['ec2', 'describe-vpcs', '--vpc-ids'], list: 'Vpcs', idKey: 'VpcId', per: (id) => `ec2 describe-vpcs --vpc-ids ${id}` },
];
const FILTER_MERGES = [
  { head: 'ec2 describe-route-tables --filters Name=association.subnet-id,Values=', list: 'RouteTables', idKey: 'RouteTableId', per: (id) => `ec2 describe-route-tables --filters Name=association.subnet-id,Values=${id}` },
  { head: 'ec2 describe-network-acls --filters Name=association.subnet-id,Values=', list: 'NetworkAcls', idKey: 'NetworkAclId', per: (id) => `ec2 describe-network-acls --filters Name=association.subnet-id,Values=${id}` },
];

export function makeReplayRunner(raw, { log, errors }) {
  const associations = (raw && typeof raw.associations === 'object' && raw.associations) || {};
  const missing = new Set();
  const lookup = (key) => {
    if (Object.prototype.hasOwnProperty.call(associations, key)) return associations[key] || {};
    const svc = PRIMARY_CALLS[key];
    if (svc && raw && Object.prototype.hasOwnProperty.call(raw, svc)) return raw[svc] || {};
    return null;
  };
  const mergeById = (keysForIds, listName, idKey) => {
    const seen = new Set(); const items = [];
    let any = false;
    for (const k of keysForIds) {
      const v = lookup(k);
      if (v === null) continue;
      any = true;
      for (const item of v[listName] || []) {
        const id = item && item[idKey];
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        items.push(item);
      }
    }
    return any ? { [listName]: items } : null;
  };

  return async (args) => {
    const key = args.join(' ');
    log.push(`(artifact) aws ${key}`);

    let val = lookup(key);
    if (val === null) {
      for (const m of BATCH_MERGES) {
        if (args.length > m.head.length && m.head.every((h, i) => args[i] === h)) {
          val = mergeById(args.slice(m.head.length).map(m.per), m.list, m.idKey);
          break;
        }
      }
    }
    if (val === null) {
      for (const m of FILTER_MERGES) {
        if (key.startsWith(m.head)) {
          const ids = key.slice(m.head.length).split(',').filter(Boolean);
          val = mergeById(ids.map(m.per), m.list, m.idKey);
          break;
        }
      }
    }
    if (val === null) {
      if (!missing.has(key) && missing.size < 20) {
        missing.add(key);
        errors.push(`artifact: not captured: aws ${key}`);
      }
      return {};
    }
    return typeof val === 'object' && val !== null ? val : {};
  };
}

// Normalize an uploaded drcompass-aws-discovery.json artifact through the
// SAME discoverers + collectors + contract assembly as the live scan.
export async function normalizeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw httpError(400, 'unrecognized upload: expected the drcompass-aws-discovery.json artifact (a JSON object)');
  }
  const raw = artifact.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(400, 'unrecognized upload: artifact is missing its raw:{...} capture block — re-run drcompass-aws-discovery.sh');
  }
  const services = Object.keys(raw).filter((s) => s !== 'associations' && SERVICE_IDS.includes(s));
  if (!services.length) {
    throw httpError(400, `artifact contains no recognized services under raw (expected any of: ${SERVICE_IDS.join(', ')})`);
  }
  const region = typeof artifact.region === 'string' ? artifact.region : '';
  const log = []; const errors = [];

  const run = makeCachedRunner(makeReplayRunner(raw, { log, errors }));
  const { proposals, errors: discoverErrors } = await runDiscoverers({ services, region, run });
  errors.push(...discoverErrors);

  const keys = proposalKeys(proposals);
  const g = proposals.length ? await mapAssociations({ proposals, keys, region, run, errors }) : null;
  return {
    proposals: assembleContract(proposals, keys, g),
    log, errors,
    capturedAt: typeof artifact.capturedAt === 'string' ? artifact.capturedAt : '',
    region,
    services,
  };
}

// ---------------------------------------------------------------- script generator

// Self-contained READ-ONLY bash script for environments where the DR Compass
// box has no AWS credentials. Mirrors scan-map's CLI calls (including the
// association describes and deep passes) and assembles ONE artifact,
// drcompass-aws-discovery.json, via jq (fallback python3) — same
// dual-assembler pattern as the k8s snapshot script. Never reads secret
// values; never embeds credentials.
export function discoveryScript({ services = [] } = {}) {
  const svcList = (services.length ? services : SERVICE_IDS).filter((s) => SERVICE_IDS.includes(s));
  return `#!/usr/bin/env bash
# drcompass-aws-discovery.sh — READ-ONLY AWS discovery capture for DR Compass.
#
# Runs ONLY read-only aws CLI calls (describe*/list*/get*) mirroring the
# DR Compass "Scan & map" pass — the primary inventory lists plus the
# association describes (security groups, subnets, IAM roles/policies,
# target groups, listeners, KMS, VPCs, ...). Assembles ONE artifact in the
# current directory:
#     drcompass-aws-discovery.json
# Upload that file in DR Compass -> Discover -> AWS -> "Upload artifact".
#
# No credentials or secret VALUES ever enter the artifact:
#   - Secrets Manager access is list-secrets / describe-secret only
#     (metadata; get-secret-value is never called).
#   - Only your local profile name (not keys) is recorded; redact PROFILE
#     if even the name is sensitive.
#
# Usage:
#   REGION=us-east-1 bash drcompass-aws-discovery.sh
#   PROFILE=prod REGION=us-east-1 bash drcompass-aws-discovery.sh
#   SERVICES="eks elb rds" REGION=us-east-1 bash drcompass-aws-discovery.sh
#
# Requires: aws CLI v2, plus jq or python3 (for JSON assembly).
set -euo pipefail

OUT="drcompass-aws-discovery.json"
SERVICES="\${SERVICES:-${svcList.join(' ')}}"
PROFILE="\${PROFILE:-}"

command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not found on PATH" >&2; exit 1; }

TOOL=""
if command -v jq >/dev/null 2>&1; then TOOL="jq"
elif command -v python3 >/dev/null 2>&1; then TOOL="python3"
else
  echo "ERROR: neither jq nor python3 found — install one of them and re-run" >&2
  exit 1
fi
echo "JSON assembler: $TOOL"

REGION="\${REGION:-$(aws \${PROFILE:+--profile "$PROFILE"} configure get region 2>/dev/null || true)}"
if [ -z "$REGION" ]; then
  echo "ERROR: no region — run with REGION=us-east-1 (or set one on the profile)" >&2
  exit 1
fi

AWS=(aws --output json --no-cli-pager --region "$REGION")
if [ -n "$PROFILE" ]; then AWS+=(--profile "$PROFILE"); fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
N=0
touch "$TMP/want_sg.txt" "$TMP/want_subnet.txt" "$TMP/want_vpc.txt" "$TMP/want_role.txt" "$TMP/want_cachesub.txt"

# --- helpers -----------------------------------------------------------

cat > "$TMP/walk.py" <<'PYWALK'
import json, sys
expr, path = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
vals = [data]
for seg in expr.split('|'):
    seg = seg.strip().replace('?', '').lstrip('.')
    parts = [p for p in seg.split('.') if p]
    cur = list(vals)
    for part in parts:
        arr = part.endswith('[]')
        name = part[:-2] if arr else part
        nxt = []
        for c in cur:
            if name:
                if isinstance(c, dict) and name in c:
                    c = c[name]
                else:
                    continue
            if arr:
                if isinstance(c, list):
                    nxt.extend(c)
            else:
                nxt.append(c)
        cur = nxt
    vals = cur
for v in vals:
    if isinstance(v, (str, int)) and str(v).strip():
        print(v)
PYWALK

cat > "$TMP/wrap.py" <<'PYWRAP'
import json, sys
field, name, rawf, outf = sys.argv[1:5]
try:
    with open(rawf) as fh:
        txt = fh.read().strip()
    value = json.loads(txt) if txt else None
except Exception:
    value = None
with open(outf, 'w') as fh:
    json.dump({field: name, 'value': value}, fh)
PYWRAP

json_wrap() { # json_wrap <field> <name> <rawfile> <outfile>
  if [ "$TOOL" = "jq" ]; then
    jq -n --arg f "$1" --arg k "$2" --slurpfile v "$3" '{($f): $k, value: ($v[0] // null)}' > "$4" 2>/dev/null \\
      || printf '{"%s":"%s","value":null}' "$1" "$2" > "$4"
  else
    python3 "$TMP/wrap.py" "$1" "$2" "$3" "$4"
  fi
}

extract() { # extract <jq-lite path expr> <file>
  { if [ "$TOOL" = "jq" ]; then jq -r "$1" "$2" 2>/dev/null || true
    else python3 "$TMP/walk.py" "$1" "$2" 2>/dev/null || true; fi
  } | grep -vx 'null' | grep -v '^$' || true
}

run_aws() { # run_aws <rawfile> <aws args...>
  local rawf="$1"; shift
  if ! "\${AWS[@]}" "$@" > "$rawf" 2>"$TMP/err.txt"; then
    echo "    WARN: 'aws $*' failed — recorded as empty" >&2
    tail -2 "$TMP/err.txt" | sed 's/^/      /' >&2 || true
    echo '{}' > "$rawf"
  fi
}

cap() { # cap <aws args...> — capture one association call, keyed verbatim
  local key="$*"
  N=$((N+1))
  local f
  f="$(printf '%s/cap_%05d.json' "$TMP" "$N")"
  echo "  aws $key"
  run_aws "$TMP/last.json" "$@"
  json_wrap key "$key" "$TMP/last.json" "$f"
}

primary() { # primary <service-id> <aws args...> — a service's main list call
  local svc="$1"; shift
  echo "== $svc: aws $*"
  run_aws "$TMP/p_$svc.raw" "$@"
  json_wrap svc "$svc" "$TMP/p_$svc.raw" "$TMP/svc_$svc.json"
}

want() { case " $SERVICES " in *" $1 "*) return 0;; *) return 1;; esac; }

echo "Capturing READ-ONLY AWS discovery (region: $REGION, profile: \${PROFILE:-default})"
echo "Services: $SERVICES"

# --- per-service captures ---------------------------------------------

if want eks; then
  primary eks eks list-clusters
  for c in $(extract '.clusters[]?' "$TMP/p_eks.raw" | head -20); do
    cap eks describe-cluster --name "$c"
    cp "$TMP/last.json" "$TMP/eks_c.json"
    extract '.cluster.resourcesVpcConfig.securityGroupIds[]?' "$TMP/eks_c.json" >> "$TMP/want_sg.txt"
    extract '.cluster.resourcesVpcConfig.clusterSecurityGroupId?' "$TMP/eks_c.json" >> "$TMP/want_sg.txt"
    extract '.cluster.resourcesVpcConfig.subnetIds[]?' "$TMP/eks_c.json" >> "$TMP/want_subnet.txt"
    extract '.cluster.resourcesVpcConfig.vpcId?' "$TMP/eks_c.json" >> "$TMP/want_vpc.txt"
    cap eks list-nodegroups --cluster-name "$c"
    cp "$TMP/last.json" "$TMP/eks_ng.json"
    for ng in $(extract '.nodegroups[]?' "$TMP/eks_ng.json" | head -10); do
      cap eks describe-nodegroup --cluster-name "$c" --nodegroup-name "$ng"
      extract '.nodegroup.nodeRole?' "$TMP/last.json" >> "$TMP/want_role.txt"
    done
    cap eks list-addons --cluster-name "$c"
  done
fi

if want elb; then
  primary elb elbv2 describe-load-balancers
  extract '.LoadBalancers[]? | .SecurityGroups[]?' "$TMP/p_elb.raw" >> "$TMP/want_sg.txt"
  extract '.LoadBalancers[]? | .AvailabilityZones[]? | .SubnetId?' "$TMP/p_elb.raw" >> "$TMP/want_subnet.txt"
  extract '.LoadBalancers[]? | .VpcId?' "$TMP/p_elb.raw" >> "$TMP/want_vpc.txt"
  for arn in $(extract '.LoadBalancers[]? | .LoadBalancerArn?' "$TMP/p_elb.raw" | head -25); do
    cap elbv2 describe-listeners --load-balancer-arn "$arn"
    cap elbv2 describe-target-groups --load-balancer-arn "$arn"
    cp "$TMP/last.json" "$TMP/elb_tgs.json"
    extract '.TargetGroups[]? | .VpcId?' "$TMP/elb_tgs.json" >> "$TMP/want_vpc.txt"
    for tg in $(extract '.TargetGroups[]? | .TargetGroupArn?' "$TMP/elb_tgs.json" | head -10); do
      cap elbv2 describe-target-health --target-group-arn "$tg"
    done
  done
fi

if want rds; then
  primary rds rds describe-db-clusters
  cap rds describe-global-clusters
  cap rds describe-db-instances
  cp "$TMP/last.json" "$TMP/rds_inst.json"
  extract '.DBClusters[]? | .VpcSecurityGroups[]? | .VpcSecurityGroupId?' "$TMP/p_rds.raw" >> "$TMP/want_sg.txt"
  extract '.DBInstances[]? | .VpcSecurityGroups[]? | .VpcSecurityGroupId?' "$TMP/rds_inst.json" >> "$TMP/want_sg.txt"
  for sn in $( { extract '.DBClusters[]? | .DBSubnetGroup?' "$TMP/p_rds.raw"; extract '.DBInstances[]? | .DBSubnetGroup.DBSubnetGroupName?' "$TMP/rds_inst.json"; } | sort -u | head -10 ); do
    cap rds describe-db-subnet-groups --db-subnet-group-name "$sn"
    extract '.DBSubnetGroups[]? | .Subnets[]? | .SubnetIdentifier?' "$TMP/last.json" >> "$TMP/want_subnet.txt"
    extract '.DBSubnetGroups[]? | .VpcId?' "$TMP/last.json" >> "$TMP/want_vpc.txt"
  done
fi

if want elasticache; then
  primary elasticache elasticache describe-replication-groups
  cap elasticache describe-cache-clusters
  cp "$TMP/last.json" "$TMP/ec_cc.json"
  extract '.CacheClusters[]? | .SecurityGroups[]? | .SecurityGroupId?' "$TMP/ec_cc.json" >> "$TMP/want_sg.txt"
  extract '.CacheClusters[]? | .CacheSubnetGroupName?' "$TMP/ec_cc.json" >> "$TMP/want_cachesub.txt"
  for id in $(extract '.ReplicationGroups[]? | .MemberClusters[]?' "$TMP/p_elasticache.raw" | head -10); do
    cap elasticache describe-cache-clusters --cache-cluster-id "$id"
    extract '.CacheClusters[]? | .SecurityGroups[]? | .SecurityGroupId?' "$TMP/last.json" >> "$TMP/want_sg.txt"
    extract '.CacheClusters[]? | .CacheSubnetGroupName?' "$TMP/last.json" >> "$TMP/want_cachesub.txt"
  done
  for sn in $(sort -u "$TMP/want_cachesub.txt" | head -10); do
    cap elasticache describe-cache-subnet-groups --cache-subnet-group-name "$sn"
    extract '.CacheSubnetGroups[]? | .Subnets[]? | .SubnetIdentifier?' "$TMP/last.json" >> "$TMP/want_subnet.txt"
  done
fi

if want lambda; then
  primary lambda lambda list-functions
  for fn in $(extract '.Functions[]? | .FunctionName?' "$TMP/p_lambda.raw" | head -25); do
    cap lambda get-function-configuration --function-name "$fn"
    extract '.Role?' "$TMP/last.json" >> "$TMP/want_role.txt"
    extract '.VpcConfig.SecurityGroupIds[]?' "$TMP/last.json" >> "$TMP/want_sg.txt"
    extract '.VpcConfig.SubnetIds[]?' "$TMP/last.json" >> "$TMP/want_subnet.txt"
  done
fi

if want sqs; then
  primary sqs sqs list-queues
  for u in $(extract '.QueueUrls[]?' "$TMP/p_sqs.raw" | head -50); do
    cap sqs get-queue-attributes --queue-url "$u" --attribute-names All
  done
fi

if want s3; then
  primary s3 s3api list-buckets
  for b in $(extract '.Buckets[]? | .Name?' "$TMP/p_s3.raw" | head -25); do
    cap s3api get-bucket-encryption --bucket "$b"
    cap s3api get-bucket-versioning --bucket "$b"
    cap s3api get-bucket-replication --bucket "$b"
    cap s3api get-public-access-block --bucket "$b"
    cap s3api get-bucket-policy --bucket "$b"
  done
fi

if want apigateway; then
  primary apigateway apigateway get-rest-apis
  cap apigatewayv2 get-apis
  cap apigateway get-vpc-links
  cap apigateway get-domain-names
  for id in $(extract '.items[]? | .id?' "$TMP/p_apigateway.raw" | head -10); do
    cap apigateway get-stages --rest-api-id "$id"
  done
fi

if want secrets; then
  primary secrets secretsmanager list-secrets --max-results 100
  for a in $(extract '.SecretList[]? | .ARN?' "$TMP/p_secrets.raw" | head -10); do
    cap secretsmanager describe-secret --secret-id "$a"
  done
fi

if want route53; then
  primary route53 route53 list-hosted-zones
  for z in $(extract '.HostedZones[]? | .Id?' "$TMP/p_route53.raw" | head -3); do
    zid="\${z##*/}"
    cap route53 list-resource-record-sets --hosted-zone-id "$zid" --max-items 200
  done
fi

if want ecs; then
  primary ecs ecs list-clusters
  for arn in $(extract '.clusterArns[]?' "$TMP/p_ecs.raw" | head -10); do
    cap ecs list-services --cluster "$arn"
  done
fi

if want dynamodb; then
  primary dynamodb dynamodb list-tables
  for t in $(extract '.TableNames[]?' "$TMP/p_dynamodb.raw" | head -25); do
    cap dynamodb describe-table --table-name "$t"
  done
fi

if want ec2-asg; then primary ec2-asg autoscaling describe-auto-scaling-groups; fi
if want sns; then primary sns sns list-topics; fi
if want kinesis; then primary kinesis kinesis list-streams; fi
if want cloudfront; then primary cloudfront cloudfront list-distributions; fi
if want ecr; then primary ecr ecr describe-repositories; fi
if want transfer; then primary transfer transfer list-servers; fi
if want msk; then primary msk kafka list-clusters; fi
if want efs; then primary efs efs describe-file-systems; fi

# --- shared association deep passes ------------------------------------

echo "== deep: security groups / subnets / IAM / VPCs"
for id in $(sort -u "$TMP/want_sg.txt" | head -100); do
  cap ec2 describe-security-groups --group-ids "$id"
  extract '.SecurityGroups[]? | .VpcId?' "$TMP/last.json" >> "$TMP/want_vpc.txt"
done
for id in $(sort -u "$TMP/want_subnet.txt" | head -60); do
  cap ec2 describe-subnets --subnet-ids "$id"
  extract '.Subnets[]? | .VpcId?' "$TMP/last.json" >> "$TMP/want_vpc.txt"
  cap ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$id"
  cap ec2 describe-network-acls --filters "Name=association.subnet-id,Values=$id"
done
for arn in $(sort -u "$TMP/want_role.txt" | head -15); do
  rname="\${arn##*/}"
  cap iam get-role --role-name "$rname"
  cap iam list-attached-role-policies --role-name "$rname"
done
for id in $(sort -u "$TMP/want_vpc.txt" | head -20); do
  cap ec2 describe-vpcs --vpc-ids "$id"
done

# --- assemble the artifact ---------------------------------------------

echo "Assembling $OUT with $TOOL ..."
FILES=()
for f in "$TMP"/svc_*.json "$TMP"/cap_*.json; do
  [ -f "$f" ] && FILES+=("$f")
done
if [ "\${#FILES[@]}" -eq 0 ]; then
  echo "ERROR: nothing was captured (check SERVICES / credentials)" >&2
  exit 1
fi

if [ "$TOOL" = "jq" ]; then
  jq -s \\
    --arg gen "drcompass-aws-discovery.sh" \\
    --arg cap "$CAPTURED_AT" \\
    --arg prof "\${PROFILE:-default}" \\
    --arg region "$REGION" \\
    '{ generatedBy: $gen, capturedAt: $cap, profile: $prof, region: $region,
       raw: (
         ( [ .[] | select(.svc) | { key: .svc, value: .value } ] | from_entries )
         + { associations: ( [ .[] | select(.key) | { key: .key, value: .value } ] | from_entries ) } ) }' \\
    "\${FILES[@]}" > "$OUT"
else
  python3 - "$TMP" "$OUT" "\${PROFILE:-default}" "$REGION" "$CAPTURED_AT" <<'PYASM'
import json, sys, os, glob
tmp, out, prof, region, cap = sys.argv[1:6]
raw = {}
assoc = {}
def load(f):
    try:
        with open(f) as fh:
            return json.load(fh)
    except Exception:
        return None
for f in sorted(glob.glob(os.path.join(tmp, 'svc_*.json'))):
    d = load(f)
    if isinstance(d, dict) and d.get('svc'):
        raw[d['svc']] = d.get('value')
for f in sorted(glob.glob(os.path.join(tmp, 'cap_*.json'))):
    d = load(f)
    if isinstance(d, dict) and d.get('key'):
        assoc[d['key']] = d.get('value')
raw['associations'] = assoc
artifact = {
    'generatedBy': 'drcompass-aws-discovery.sh',
    'capturedAt': cap,
    'profile': prof,
    'region': region,
    'raw': raw,
}
with open(out, 'w') as fh:
    json.dump(artifact, fh, indent=2)
PYASM
fi

echo ""
echo "Done: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "Upload this file in DR Compass -> Discover -> AWS -> Upload artifact"
`;
}
