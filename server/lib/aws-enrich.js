// AWS resource-association enrichment ("Arpio-style depth").
// For each inventory component, finds the underlying AWS resource via the
// user's LOCAL `aws` CLI (read-only describe/list calls only) and walks its
// associations — security groups, subnets + AZs, IAM roles/policies, target
// groups, listeners, NACLs, KMS keys, tags, endpoints — into a per-workspace
// resource graph (object store name 'resource-graph').
//
// Graph shape (HARD CONTRACT — see SPEC / resources routes):
//   { updatedAt, nodes: { rid: {rid,type,service,name,arn,region,
//       componentIds,details,tags,source} }, edges: [{from,to,relation}] }
// `from`/`to` are node rids or component ids (cmp_*). Component ids never
// appear in `nodes`. `details` stays small — counts + key facts only, never
// full policy documents, never secret values.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from '../store.js';
import { awsCliFound, makeLog, awsArgs, resolveAuthVia, lbKind } from './aws-discovery.js';

const execFile = promisify(execFileCb);
const AWS_TIMEOUT = 30000;
const MAX_BUFFER = 32 * 1024 * 1024;
const CONCURRENCY = 3;

// Hard cap on FOLLOW-UP describes (the second-level calls that explain a
// resource: ENIs, SG rules, route tables, KMS, certificates, endpoints…).
// Primary collector calls are not counted; when the cap is hit the remaining
// follow-ups are skipped and every resource they would have explained gets an
// explicit "not checked (describe cap reached)" fact instead of silence.
const MAX_FOLLOWUP_CALLS = 160;
const FACT_MAX = 90;           // contract: a fact must fit a table cell
const MAX_FACTS_PER_NODE = 8;
const MAX_DETAILS_PER_COMPONENT = 80;

export const NODE_TYPES = [
  'security-group', 'subnet', 'vpc', 'route-table', 'nacl', 'availability-zone',
  'iam-role', 'iam-policy', 'instance-profile', 'target-group', 'listener',
  'load-balancer', 'kms-key', 'secret', 'log-group', 'alarm', 'sns-topic',
  'certificate', 'dns-record', 'hosted-zone', 'nodegroup', 'addon',
  'oidc-provider', 'db-subnet-group', 'parameter-group', 'vpc-endpoint',
  'nat-gateway', 'internet-gateway', 'elastic-ip', 'launch-template',
  'repository', 'bucket-policy', 'queue-policy', 'tag-match',
  'network-interface', 'other',
];
export const RELATIONS = [
  'secured-by', 'in-subnet', 'in-az', 'member-of', 'assumes-role', 'has-policy',
  'routes-to', 'targets', 'listens-on', 'encrypted-by', 'logs-to', 'alarmed-by',
  'resolves-to', 'uses', 'contains', 'tagged-match', 'has-interface',
];

// ---------------------------------------------------------------- utils

function shortErr(e) {
  if (e && e.code === 'ENOENT') return 'aws binary not found';
  if (e && (e.killed || e.signal === 'SIGTERM')) return `timed out after ${AWS_TIMEOUT / 1000}s`;
  const stderr = ((e && e.stderr) || '').toString().trim().split('\n').slice(-3).join(' ');
  return (stderr || (e && e.message) || 'unknown error').slice(0, 300);
}

// Why a follow-up describe did not produce an answer. Used to write the
// contract's explicit "not checked" facts instead of quietly omitting.
export function whyNotChecked(e) {
  if (e && e.capped) return 'describe cap reached';
  if (e && (e.killed || e.signal === 'SIGTERM')) return 'timed out';
  const s = `${(e && e.stderr) || ''} ${(e && e.message) || ''}`;
  if (/AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError|AccessDeniedException/i.test(s)) return 'access denied';
  if (/ExpiredToken|InvalidClientTokenId|credentials/i.test(s)) return 'credentials expired';
  return 'describe failed';
}

// A fact must be one short true sentence that fits a table cell.
export function fact(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= FACT_MAX ? t : `${t.slice(0, FACT_MAX - 1)}…`;
}

// Follow-up describe budget: take() throws a `capped` error once spent.
export function makeBudget(limit = MAX_FOLLOWUP_CALLS) {
  let used = 0;
  return {
    limit,
    get used() { return used; },
    get capped() { return used >= limit; },
    take() {
      if (used >= limit) {
        const e = new Error(`follow-up describe cap (${limit}) reached`);
        e.capped = true;
        throw e;
      }
      used += 1;
    },
  };
}
// Wrap a runner so every call it makes is charged to the budget.
export function budgetedRun(run, budget) {
  if (!budget) return run;
  return async (args, opts) => { budget.take(); return run(args, opts); };
}

// AWS tag list [{Key,Value}] (or {key,value}) -> plain object, capped.
function tagsOf(list) {
  const out = {};
  for (const t of Array.isArray(list) ? list.slice(0, 25) : []) {
    const k = t.Key ?? t.key; const v = t.Value ?? t.value;
    if (k != null) out[String(k)] = String(v ?? '');
  }
  return out;
}
// Map-shaped tags ({k:v}) pass through.
function tagsObj(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {}).slice(0, 25)) out[k] = String(v ?? '');
  return out;
}

const ID_PREFIXES = /^(sg|subnet|vpc|rtb|acl|igw|nat|eipalloc|vpce|lt|i|ami|eni)-/;

// Stable rid from an ARN: the resource part; bare EC2-style ids collapse to the id.
export function ridFromArn(arn) {
  if (!arn) return '';
  if (!arn.startsWith('arn:')) return arn;
  const resource = arn.split(':').slice(5).join(':');
  const last = resource.split('/').pop();
  if (ID_PREFIXES.test(last)) return last;
  return resource;
}

const ARN_SERVICE_NAMES = {
  ec2: 'EC2', elasticloadbalancing: 'ELB', iam: 'IAM', kms: 'KMS', s3: 'S3',
  sqs: 'SQS', sns: 'SNS', rds: 'RDS', eks: 'EKS', ecs: 'ECS', lambda: 'Lambda',
  logs: 'CloudWatch Logs', cloudwatch: 'CloudWatch', route53: 'Route 53',
  acm: 'ACM', secretsmanager: 'Secrets Manager', ecr: 'ECR',
  elasticache: 'ElastiCache', apigateway: 'API Gateway', dynamodb: 'DynamoDB',
  kinesis: 'Kinesis', firehose: 'Firehose', kafka: 'MSK', efs: 'EFS',
  backup: 'AWS Backup', events: 'EventBridge', states: 'Step Functions',
};

// Best-effort node type from an ARN (used by tag-based correlation).
export function typeFromArn(arn) {
  const parts = String(arn || '').split(':');
  const service = parts[2] || '';
  const resource = parts.slice(5).join(':');
  const head = resource.split('/')[0].split(':')[0];
  const table = {
    ec2: {
      'security-group': 'security-group', subnet: 'subnet', vpc: 'vpc',
      'route-table': 'route-table', 'network-acl': 'nacl',
      'natgateway': 'nat-gateway', 'internet-gateway': 'internet-gateway',
      'elastic-ip': 'elastic-ip', 'launch-template': 'launch-template',
      'vpc-endpoint': 'vpc-endpoint',
    },
    elasticloadbalancing: { loadbalancer: 'load-balancer', targetgroup: 'target-group', listener: 'listener' },
    iam: { role: 'iam-role', policy: 'iam-policy', 'oidc-provider': 'oidc-provider', 'instance-profile': 'instance-profile' },
    kms: { key: 'kms-key' },
    secretsmanager: { secret: 'secret' },
    logs: { 'log-group': 'log-group' },
    cloudwatch: { alarm: 'alarm' },
    acm: { certificate: 'certificate' },
    route53: { hostedzone: 'hosted-zone' },
    eks: { nodegroup: 'nodegroup', addon: 'addon' },
    rds: { subgrp: 'db-subnet-group', pg: 'parameter-group', 'cluster-pg': 'parameter-group' },
    ecr: { repository: 'repository' },
  };
  if (service === 'sns') return 'sns-topic';
  return (table[service] && table[service][head]) || 'other';
}
export function serviceFromArn(arn) {
  const svc = String(arn || '').split(':')[2] || '';
  return ARN_SERVICE_NAMES[svc] || (svc ? svc.toUpperCase() : '');
}

// ---------------------------------------------------------------- ARN parsing (exact-target matching)

// parseArn(arn) -> { arn, partition, service, region, account, resource,
//   resourceType, id, name, ... } | null.
// `id` is what the service's describe call takes; `name` is the human name
// (for secretsmanager the 6-char random suffix is stripped).
export function parseArn(arn) {
  const s = String(arn || '').trim();
  if (!s.startsWith('arn:')) return null;
  const parts = s.split(':');
  if (parts.length < 6) return null;
  const [, partition, service, region, account] = parts;
  const resource = parts.slice(5).join(':');
  if (!service || !resource) return null;
  const p = { arn: s, partition, service, region: region || '', account: account || '', resource, resourceType: '', id: '', name: '' };
  const slash = resource.split('/');
  const colon = resource.split(':');
  switch (service) {
    case 'elasticloadbalancing': {
      // loadbalancer/app|net|gwy/<name>/<hash> | loadbalancer/<classic-name>
      // targetgroup/<name>/<hash> | listener/app/<lb>/<hash>/<hash>
      p.resourceType = slash[0];
      if (slash[0] === 'loadbalancer') {
        p.lbType = ['app', 'net', 'gwy'].includes(slash[1]) ? slash[1] : '';
        p.name = p.lbType ? (slash[2] || '') : (slash[1] || '');
        p.id = p.name;
      } else if (slash[0] === 'targetgroup') {
        p.name = slash[1] || ''; p.id = p.name;
      } else { p.name = slash[2] || slash[1] || ''; p.id = p.name; }
      break;
    }
    case 'rds':          // cluster:<id> | db:<id> | subgrp:<n> | pg:<n> ...
    case 'elasticache': { // replicationgroup:<id> | cluster:<id> ...
      p.resourceType = colon[0]; p.id = colon.slice(1).join(':'); p.name = p.id;
      break;
    }
    case 'sqs': { // resource part IS the queue name
      p.resourceType = 'queue'; p.id = resource; p.name = resource;
      break;
    }
    case 's3': { // resource part is the bucket (maybe bucket/key)
      p.resourceType = 'bucket'; p.id = slash[0]; p.name = p.id;
      break;
    }
    case 'lambda': { // function:<name>[:qualifier]
      p.resourceType = colon[0] || 'function'; p.id = colon[1] || ''; p.name = p.id;
      p.qualifier = colon[2] || '';
      break;
    }
    case 'eks': { // cluster/<name> | nodegroup/<cluster>/<ng>/<id>
      p.resourceType = slash[0]; p.id = slash[1] || ''; p.name = p.id;
      break;
    }
    case 'secretsmanager': { // secret:<name>-<6char-suffix>
      p.resourceType = colon[0];
      p.id = colon.slice(1).join(':');
      p.name = p.id.replace(/-[A-Za-z0-9]{6}$/, '');
      break;
    }
    case 'execute-api': { // <api-id>/<stage>/...
      p.resourceType = 'api'; p.id = slash[0]; p.name = p.id;
      break;
    }
    case 'apigateway': { // /restapis/<id>/... | /apis/<id>/... (account is empty)
      p.resourceType = 'api';
      const seg = resource.replace(/^\/+/, '').split('/');
      p.id = (seg[0] === 'restapis' || seg[0] === 'apis') ? (seg[1] || '') : (seg[0] || '');
      p.name = p.id;
      break;
    }
    case 'kinesis':      // stream/<name>
    case 'dynamodb':     // table/<name>[/index/<idx>]
    case 'transfer':     // server/s-xxxx
    case 'efs':          // file-system/fs-xxxx
    case 'kafka': {      // cluster/<name>/<uuid>
      p.resourceType = slash[0]; p.id = slash[1] || ''; p.name = p.id;
      break;
    }
    case 'ecr': { // repository/<name-may-contain-slashes>
      p.resourceType = slash[0]; p.id = slash.slice(1).join('/'); p.name = p.id;
      break;
    }
    case 'ecs': { // cluster/<name> | service/<cluster>/<name> | task-definition/<fam>:<rev>
      p.resourceType = slash[0];
      p.id = slash[0] === 'service' ? (slash[2] || slash[1] || '') : (slash[1] || '');
      p.name = p.id;
      break;
    }
    case 'sns': { // resource part IS the topic name
      p.resourceType = 'topic'; p.id = resource; p.name = resource;
      break;
    }
    default: { // generic: type/id or type:id, else the bare resource
      if (slash.length > 1) { p.resourceType = slash[0]; p.id = slash.slice(1).join('/'); }
      else if (colon.length > 1) { p.resourceType = colon[0]; p.id = colon.slice(1).join(':'); }
      else { p.id = resource; }
      p.name = p.id;
    }
  }
  if (!p.id) return null;
  return p;
}

// ARN service -> collector able to describe that exact resource.
const ARN_COLLECTORS = {
  elasticloadbalancing: 'elbv2', eks: 'eks', rds: 'rds', elasticache: 'elasticache',
  lambda: 'lambda', sqs: 'sqs', s3: 's3', apigateway: 'apigateway',
  'execute-api': 'apigateway', secretsmanager: 'secrets', kinesis: 'kinesis',
  dynamodb: 'dynamodb', ecr: 'ecr', transfer: 'transfer',
};

// ---------------------------------------------------------------- matching

const GENERIC = new Set([
  'the', 'and', 'aws', 'service', 'services', 'cluster', 'clusters', 'queue',
  'queues', 'bucket', 'buckets', 'cache', 'caches', 'stream', 'streams',
  'streaming', 'table', 'tables', 'api', 'gateway', 'load', 'balancer',
  'aurora', 'redis', 'postgres', 'mysql', 'sqs', 'sns', 'kms', 'eks', 'ecs',
  'ecr', 'rds', 'elb', 'nlb', 'alb', 'vpc', 'iam', 'dns', 'cdn', 'acm', 'key',
  'keys', 'role', 'roles', 'manager', 'secrets', 'secret', 'database', 'dbs',
  'primary', 'workload', 'workloads', 'public', 'private', 'link', 'report',
  'reports', 'transfer', 'explicit', 'arns', 'repositories', 'lambda',
]);

function tokensOf(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC.has(t));
}

// Match tokens for a component: its name + endpoint names/hosts + secret prefixes.
export function componentTokens(c) {
  const toks = new Set(tokensOf(c.name));
  for (const e of c.endpoints || []) {
    for (const t of tokensOf(e.name)) toks.add(t);
    const host = String(e.url || '').replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0];
    for (const t of tokensOf(host)) toks.add(t);
  }
  for (const s of c.secrets || []) for (const t of tokensOf(String(s.name || '').split('/')[0])) toks.add(t);
  return [...toks];
}

// Score: total length of component tokens found inside the resource name
// (or resource-name tokens found inside a component token — plural/singular).
export function matchScore(resourceName, toks) {
  const rn = String(resourceName || '').toLowerCase();
  if (!rn) return 0;
  let score = 0;
  for (const t of toks) {
    if (rn.includes(t)) { score += t.length; continue; }
    if (tokensOf(rn).some((r) => t.includes(r) && r.length >= 4)) score += 4;
  }
  return score;
}

function bestMatch(list, nameOf, toks) {
  let best = null; let bestScore = 0;
  for (const item of list) {
    const s = matchScore(nameOf(item), toks);
    if (s > bestScore) { best = item; bestScore = s; }
  }
  return bestScore >= 4 ? best : null; // require one meaningful token
}
function allMatches(list, nameOf, toks, limit = 5) {
  return list.filter((item) => matchScore(nameOf(item), toks) >= 4).slice(0, limit);
}

// ---------------------------------------------------------------- graph builder

function makeGraphBuilder(region) {
  const nodes = {}; const edges = []; const seen = new Set();
  // Run-scoped sentences that cannot be derived from a node's stored details
  // afterwards — chiefly "X not checked (access denied)".
  const notes = {};
  function addNote(rid, text) {
    const f = fact(text);
    if (!rid || !f) return;
    const list = notes[rid] || (notes[rid] = []);
    if (!list.includes(f) && list.length < MAX_FACTS_PER_NODE) list.push(f);
  }
  function addNode(rid, type, service, name, opts = {}) {
    if (!rid) return null;
    const { arn = '', details = {}, tags = {}, componentId = null, source = 'aws-enrich' } = opts;
    let n = nodes[rid];
    if (!n) {
      n = nodes[rid] = {
        rid, type, service, name: name || rid, arn, region,
        componentIds: [], details: {}, tags: {}, source,
      };
    }
    if (componentId && !n.componentIds.includes(componentId)) n.componentIds.push(componentId);
    if (arn && !n.arn) n.arn = arn;
    if (name && (n.name === n.rid || !n.name)) n.name = name;
    if (type && n.type === 'other' && type !== 'other') n.type = type;
    Object.assign(n.details, details);
    Object.assign(n.tags, tags);
    // keep details small
    const keys = Object.keys(n.details);
    if (keys.length > 20) for (const k of keys.slice(20)) delete n.details[k];
    return n;
  }
  function addEdge(from, to, relation) {
    if (!from || !to || from === to) return;
    const k = `${from}|${to}|${relation}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, relation });
  }
  return { nodes, edges, notes, addNode, addEdge, addNote };
}

// mergeGraph(existing, additions) -> { graph, stats }
// Nodes keyed by rid (union componentIds, newer details/tags win);
// edges deduped by from+to+relation.
export function mergeGraph(existing, additions) {
  const graph = {
    updatedAt: new Date().toISOString(),
    nodes: { ...((existing && existing.nodes) || {}) },
    edges: [...((existing && existing.edges) || [])],
  };
  const stats = { addedNodes: 0, updatedNodes: 0, addedEdges: 0 };
  for (const [rid, n] of Object.entries((additions && additions.nodes) || {})) {
    const cur = graph.nodes[rid];
    if (!cur) { graph.nodes[rid] = n; stats.addedNodes++; continue; }
    graph.nodes[rid] = {
      ...cur, ...n,
      name: n.name && n.name !== rid ? n.name : cur.name,
      arn: n.arn || cur.arn,
      componentIds: [...new Set([...(cur.componentIds || []), ...(n.componentIds || [])])],
      details: { ...(cur.details || {}), ...(n.details || {}) },
      tags: { ...(cur.tags || {}), ...(n.tags || {}) },
    };
    stats.updatedNodes++;
  }
  const seen = new Set(graph.edges.map((e) => `${e.from}|${e.to}|${e.relation}`));
  for (const e of (additions && additions.edges) || []) {
    const k = `${e.from}|${e.to}|${e.relation}`;
    if (seen.has(k)) continue;
    seen.add(k);
    graph.edges.push(e);
    stats.addedEdges++;
  }
  return { graph, stats };
}

// ---------------------------------------------------------------- collectors
// Each collector gets ctx:
//   { run, region, c (component), cid, toks, found(), addNode, addEdge,
//     wantSg(id), wantSubnet(id), wantRole(arn),
//     deep(args)      — a BUDGETED runner for follow-up describes,
//     wantEnis(rid, filters, label), wantKms(idOrArn), wantCert(arn),
//     note(rid, text) — a run-scoped fact ("… not checked (access denied)") }
// addNode here attributes the component id automatically.
// ctx.deep/wantEnis/wantKms/wantCert/note are additive; a caller that builds
// its own ctx (aws-scan-map) may omit them, so every use goes through these
// no-op-safe shims.

const noop = () => {};
// targetgroup/<name>/<hash> -> <name>  (never the literal word 'targetgroup')
function tgNameFromArn(arn) {
  const p = parseArn(arn);
  if (p && p.resourceType === 'targetgroup' && p.name) return p.name;
  const rid = ridFromArn(arn);
  const parts = String(rid).split('/');
  return parts[1] || rid;
}
function ctxDeep(ctx) { return typeof ctx.deep === 'function' ? ctx.deep : ctx.run; }
function ctxNote(ctx) { return typeof ctx.note === 'function' ? ctx.note : noop; }
function ctxWantEnis(ctx) { return typeof ctx.wantEnis === 'function' ? ctx.wantEnis : noop; }
function ctxWantKms(ctx) { return typeof ctx.wantKms === 'function' ? ctx.wantKms : noop; }
function ctxWantCert(ctx) { return typeof ctx.wantCert === 'function' ? ctx.wantCert : noop; }

const COLLECTORS = {

  async elbv2(ctx) {
    const a = ctx.arn && ctx.arn.service === 'elasticloadbalancing' ? ctx.arn : null;
    if (a && a.resourceType === 'targetgroup') {
      // exact target group: describe it directly and stop there
      const { TargetGroups = [] } = await ctx.run(['elbv2', 'describe-target-groups', '--target-group-arns', a.arn]);
      const tg = TargetGroups[0];
      if (!tg) return;
      ctx.found();
      const rid = ridFromArn(tg.TargetGroupArn);
      ctx.addNode(rid, 'target-group', 'ELB', tg.TargetGroupName, {
        arn: tg.TargetGroupArn,
        details: {
          protocol: tg.Protocol, port: tg.Port, targetType: tg.TargetType,
          healthCheckPath: tg.HealthCheckPath || '', healthCheckPort: tg.HealthCheckPort,
        },
      });
      ctx.addEdge(ctx.cid, rid, 'uses');
      if (tg.VpcId) {
        ctx.addNode(tg.VpcId, 'vpc', 'EC2', tg.VpcId);
        ctx.addEdge(rid, tg.VpcId, 'member-of');
      }
      return;
    }
    let lb;
    if (a && a.resourceType === 'loadbalancer') {
      const { LoadBalancers = [] } = await ctx.run(['elbv2', 'describe-load-balancers', '--load-balancer-arns', a.arn]);
      lb = LoadBalancers[0] || null;
    } else {
      const { LoadBalancers = [] } = await ctx.run(['elbv2', 'describe-load-balancers']);
      lb = bestMatch(LoadBalancers, (l) => l.LoadBalancerName, ctx.toks);
    }
    if (!lb) return;
    ctx.found();
    const lbRid = ridFromArn(lb.LoadBalancerArn);
    ctx.addNode(lbRid, 'load-balancer', 'ELB', lb.LoadBalancerName, {
      arn: lb.LoadBalancerArn,
      details: {
        type: lb.Type, scheme: lb.Scheme, state: lb.State && lb.State.Code,
        dnsName: lb.DNSName, azs: (lb.AvailabilityZones || []).length,
      },
    });
    ctx.addEdge(ctx.cid, lbRid, 'uses');
    // Network interfaces: the ALB/NLB's own ENIs carry the description
    // "ELB app/<name>/<hash>" — an exact filter, not a guess.
    const lbSuffix = String(lb.LoadBalancerArn || '').split('loadbalancer/')[1] || '';
    if (lbSuffix) {
      ctxWantEnis(ctx)(lbRid, [`Name=description,Values=ELB ${lbSuffix}`], `load balancer ${lb.LoadBalancerName}`);
    }
    if (lb.VpcId) {
      ctx.addNode(lb.VpcId, 'vpc', 'EC2', lb.VpcId);
      ctx.addEdge(lbRid, lb.VpcId, 'member-of');
    }
    for (const sg of lb.SecurityGroups || []) {
      ctx.wantSg(sg);
      ctx.addNode(sg, 'security-group', 'EC2', sg);
      ctx.addEdge(lbRid, sg, 'secured-by');
    }
    for (const az of lb.AvailabilityZones || []) {
      if (az.SubnetId) {
        ctx.wantSubnet(az.SubnetId);
        ctx.addNode(az.SubnetId, 'subnet', 'EC2', az.SubnetId, { details: { az: az.ZoneName } });
        ctx.addEdge(lbRid, az.SubnetId, 'in-subnet');
        if (az.ZoneName) {
          ctx.addNode(az.ZoneName, 'availability-zone', 'EC2', az.ZoneName);
          ctx.addEdge(az.SubnetId, az.ZoneName, 'in-az');
        }
      }
    }
    try {
      const { Listeners = [] } = await ctx.run(['elbv2', 'describe-listeners', '--load-balancer-arn', lb.LoadBalancerArn]);
      for (const l of Listeners.slice(0, 10)) {
        const rid = ridFromArn(l.ListenerArn);
        // Default action: what the listener actually does with a request.
        const actions = Array.isArray(l.DefaultActions) ? l.DefaultActions : [];
        const forward = actions.find((x) => x && x.Type === 'forward');
        const redirect = actions.find((x) => x && x.Type === 'redirect');
        const fixed = actions.find((x) => x && x.Type === 'fixed-response');
        const fwdArns = forward
          ? [forward.TargetGroupArn, ...(((forward.ForwardConfig || {}).TargetGroups) || []).map((t) => t.TargetGroupArn)]
            .filter(Boolean)
          : [];
        let defaultAction = (actions[0] && actions[0].Type) || '';
        if (redirect) {
          const r = redirect.RedirectConfig || {};
          defaultAction = `redirect to ${r.Protocol || '#{protocol}'}:${r.Port || '#{port}'}${r.StatusCode ? ` (${r.StatusCode})` : ''}`;
        } else if (fixed) {
          defaultAction = `fixed response ${(fixed.FixedResponseConfig || {}).StatusCode || ''}`.trim();
        } else if (fwdArns.length) {
          defaultAction = 'forward';
        }
        ctx.addNode(rid, 'listener', 'ELB', `${l.Protocol}:${l.Port}`, {
          arn: l.ListenerArn,
          details: {
            protocol: l.Protocol, port: l.Port,
            sslPolicy: l.SslPolicy || '',
            certificates: (l.Certificates || []).length,
            defaultAction,
            forwardsTo: fwdArns.map((x) => tgNameFromArn(x)).join(', '),
            rules: (l.AlpnPolicy || []).length ? (l.AlpnPolicy || []).join(',') : undefined,
          },
        });
        ctx.addEdge(lbRid, rid, 'listens-on');
        for (const tgArn of fwdArns.slice(0, 5)) {
          const tgRid = ridFromArn(tgArn);
          ctx.addNode(tgRid, 'target-group', 'ELB', tgNameFromArn(tgArn), { arn: tgArn });
          ctx.addEdge(rid, tgRid, 'routes-to');
        }
        for (const cert of (l.Certificates || []).slice(0, 3)) {
          if (!cert || !cert.CertificateArn) continue;
          const crid = ridFromArn(cert.CertificateArn);
          ctx.addNode(crid, 'certificate', 'ACM', crid.split('/').pop(), {
            arn: cert.CertificateArn,
            details: cert.IsDefault ? { defaultForListener: true } : {},
          });
          ctx.addEdge(rid, crid, 'uses');
          ctxWantCert(ctx)(cert.CertificateArn);
        }
      }
    } catch (e) { ctx.softErr('elbv2 listeners', e); ctxNote(ctx)(lbRid, `listeners not checked (${whyNotChecked(e)})`); }
    try {
      const { TargetGroups = [] } = await ctx.run(['elbv2', 'describe-target-groups', '--load-balancer-arn', lb.LoadBalancerArn]);
      for (const tg of TargetGroups.slice(0, 10)) {
        const rid = ridFromArn(tg.TargetGroupArn);
        ctx.addNode(rid, 'target-group', 'ELB', tg.TargetGroupName, {
          arn: tg.TargetGroupArn,
          details: {
            protocol: tg.Protocol, port: tg.Port, targetType: tg.TargetType,
            healthCheckPath: tg.HealthCheckPath || '', healthCheckPort: tg.HealthCheckPort,
            healthCheckProtocol: tg.HealthCheckProtocol || '',
            healthCheckIntervalSec: tg.HealthCheckIntervalSeconds,
            healthCheckTimeoutSec: tg.HealthCheckTimeoutSeconds,
            healthyThreshold: tg.HealthyThresholdCount,
            unhealthyThreshold: tg.UnhealthyThresholdCount,
            matcher: (tg.Matcher && (tg.Matcher.HttpCode || tg.Matcher.GrpcCode)) || '',
          },
        });
        ctx.addEdge(lbRid, rid, 'targets');
        if (tg.VpcId) ctx.addEdge(rid, tg.VpcId, 'member-of');
        try {
          const { TargetHealthDescriptions = [] } = await ctx.run(['elbv2', 'describe-target-health', '--target-group-arn', tg.TargetGroupArn]);
          const healthy = TargetHealthDescriptions.filter((t) => t.TargetHealth && t.TargetHealth.State === 'healthy').length;
          // The registered target ids are what turns "the ALB has a target
          // group" into "the ALB sends traffic to THAT workload" — an ip
          // target lands in a subnet, an instance id / lambda arn names a
          // resource outright. Small sample only (details stays small).
          const targetIds = [...new Set(TargetHealthDescriptions
            .map((t) => (t.Target && t.Target.Id) || '').filter(Boolean))].slice(0, 6);
          // Why the unhealthy ones are unhealthy, in the API's own words.
          const unhealthyReason = [...new Set(TargetHealthDescriptions
            .filter((t) => t.TargetHealth && t.TargetHealth.State !== 'healthy')
            .map((t) => t.TargetHealth.Reason || t.TargetHealth.State).filter(Boolean))].slice(0, 2).join(', ');
          ctx.addNode(rid, 'target-group', 'ELB', tg.TargetGroupName, {
            details: {
              healthyTargets: healthy, totalTargets: TargetHealthDescriptions.length,
              targets: targetIds.join(', '),
              unhealthyReason,
            },
          });
        } catch (e) {
          ctx.softErr('elbv2 target-health', e);
          ctxNote(ctx)(rid, `target health not checked (${whyNotChecked(e)})`);
        }
      }
    } catch (e) {
      ctx.softErr('elbv2 target-groups', e);
      ctxNote(ctx)(lbRid, `target groups not checked (${whyNotChecked(e)})`);
    }
  },

  async eks(ctx) {
    let name;
    const byArn = !!(ctx.arn && ctx.arn.service === 'eks' && ctx.arn.resourceType === 'cluster');
    if (byArn) {
      name = ctx.arn.id; // exact cluster from ARN — no list/guess
    } else {
      const { clusters = [] } = await ctx.run(['eks', 'list-clusters']);
      const m = bestMatch(clusters.map((n) => ({ n })), (x) => x.n, ctx.toks);
      name = m ? m.n : (clusters.length === 1 ? clusters[0] : null);
      if (name) ctx.found();
    }
    if (!name) return;
    const { cluster: cl = {} } = await ctx.run(['eks', 'describe-cluster', '--name', name]);
    if (byArn) ctx.found(); // describe succeeded against the exact ARN target
    const cpRid = `eks/cluster/${name}`;
    ctx.addNode(cpRid, 'other', 'EKS', `${name} (control plane)`, {
      arn: cl.arn || '', tags: tagsObj(cl.tags),
      details: {
        version: cl.version, status: cl.status,
        endpointPublicAccess: !!(cl.resourcesVpcConfig && cl.resourcesVpcConfig.endpointPublicAccess),
        endpointPrivateAccess: !!(cl.resourcesVpcConfig && cl.resourcesVpcConfig.endpointPrivateAccess),
      },
    });
    ctx.addEdge(ctx.cid, cpRid, 'uses');
    // The control plane's cross-account ENIs are described exactly:
    // "Amazon EKS <cluster>".
    ctxWantEnis(ctx)(cpRid, [`Name=description,Values=Amazon EKS ${name}`], `EKS cluster ${name}`);
    const vpcCfg = cl.resourcesVpcConfig || {};
    const sgs = [...new Set([vpcCfg.clusterSecurityGroupId, ...(vpcCfg.securityGroupIds || [])])].filter(Boolean);
    for (const sg of sgs) {
      ctx.wantSg(sg);
      ctx.addNode(sg, 'security-group', 'EC2', sg, {
        details: sg === vpcCfg.clusterSecurityGroupId ? { eksClusterSg: true } : {},
      });
      ctx.addEdge(ctx.cid, sg, 'secured-by');
    }
    for (const sub of (vpcCfg.subnetIds || []).slice(0, 12)) {
      ctx.wantSubnet(sub);
      ctx.addNode(sub, 'subnet', 'EC2', sub);
      ctx.addEdge(ctx.cid, sub, 'in-subnet');
    }
    if (vpcCfg.vpcId) {
      ctx.addNode(vpcCfg.vpcId, 'vpc', 'EC2', vpcCfg.vpcId);
      ctx.addEdge(ctx.cid, vpcCfg.vpcId, 'member-of');
    }
    const issuer = cl.identity && cl.identity.oidc && cl.identity.oidc.issuer;
    if (issuer) {
      const oidcRid = issuer.replace(/^https?:\/\//, '');
      ctx.addNode(oidcRid, 'oidc-provider', 'IAM', oidcRid);
      ctx.addEdge(ctx.cid, oidcRid, 'uses');
    }
    try {
      const { nodegroups = [] } = await ctx.run(['eks', 'list-nodegroups', '--cluster-name', name]);
      for (const ng of nodegroups.slice(0, 10)) {
        const { nodegroup: d = {} } = await ctx.run(['eks', 'describe-nodegroup', '--cluster-name', name, '--nodegroup-name', ng]);
        const rid = `eks/ng/${name}/${ng}`;
        ctx.addNode(rid, 'nodegroup', 'EKS', ng, {
          arn: d.nodegroupArn || '', tags: tagsObj(d.tags),
          details: {
            instanceTypes: (d.instanceTypes || []).join(','), amiType: d.amiType,
            capacityType: d.capacityType, status: d.status,
            desired: d.scalingConfig && d.scalingConfig.desiredSize,
            min: d.scalingConfig && d.scalingConfig.minSize,
            max: d.scalingConfig && d.scalingConfig.maxSize,
          },
        });
        ctx.addEdge(ctx.cid, rid, 'contains');
        if (d.nodeRole) {
          const roleRid = ridFromArn(d.nodeRole);
          ctx.wantRole(d.nodeRole);
          ctx.addNode(roleRid, 'iam-role', 'IAM', roleRid.split('/').pop(), { arn: d.nodeRole });
          ctx.addEdge(rid, roleRid, 'assumes-role');
        }
        if (d.launchTemplate && d.launchTemplate.id) {
          ctx.addNode(d.launchTemplate.id, 'launch-template', 'EC2', d.launchTemplate.name || d.launchTemplate.id, {
            details: { version: d.launchTemplate.version },
          });
          ctx.addEdge(rid, d.launchTemplate.id, 'uses');
        }
      }
    } catch (e) { ctx.softErr('eks nodegroups', e); }
    try {
      const { addons = [] } = await ctx.run(['eks', 'list-addons', '--cluster-name', name]);
      for (const [i, a] of addons.slice(0, 15).entries()) {
        const rid = `eks/addon/${name}/${a}`;
        ctx.addNode(rid, 'addon', 'EKS', a);
        ctx.addEdge(ctx.cid, rid, 'contains');
        if (i >= 4) { ctxNote(ctx)(rid, 'addon version not checked (only 4 addons described per cluster)'); continue; }
        try {
          const { addon: ad = {} } = await ctxDeep(ctx)(['eks', 'describe-addon', '--cluster-name', name, '--addon-name', a]);
          ctx.addNode(rid, 'addon', 'EKS', a, {
            arn: ad.addonArn || '',
            details: {
              addonVersion: ad.addonVersion || '', status: ad.status || '',
              serviceAccountRole: ad.serviceAccountRoleArn ? String(ad.serviceAccountRoleArn).split('/').pop() : '',
            },
          });
          if (ad.serviceAccountRoleArn) {
            const roleRid = ridFromArn(ad.serviceAccountRoleArn);
            ctx.wantRole(ad.serviceAccountRoleArn);
            ctx.addNode(roleRid, 'iam-role', 'IAM', roleRid.split('/').pop(), { arn: ad.serviceAccountRoleArn });
            ctx.addEdge(rid, roleRid, 'assumes-role');
          }
        } catch (e) {
          ctx.softErr(`eks describe-addon(${a})`, e);
          ctxNote(ctx)(rid, `addon detail not checked (${whyNotChecked(e)})`);
        }
      }
    } catch (e) { ctx.softErr('eks addons', e); }
  },

  async rds(ctx) {
    const a = ctx.arn && ctx.arn.service === 'rds' ? ctx.arn : null;
    let matched = false;
    if (!a || a.resourceType === 'cluster') try {
      const args = a
        ? ['rds', 'describe-db-clusters', '--db-cluster-identifier', a.id]
        : ['rds', 'describe-db-clusters'];
      const { DBClusters = [] } = await ctx.run(args);
      const c = a ? DBClusters[0] : bestMatch(DBClusters, (x) => x.DBClusterIdentifier, ctx.toks);
      if (c) {
        matched = true;
        ctx.found();
        const rid = `rds/cluster/${c.DBClusterIdentifier}`;
        ctx.addNode(rid, 'other', 'RDS', c.DBClusterIdentifier, {
          arn: c.DBClusterArn || '', tags: tagsOf(c.TagList),
          details: {
            engine: `${c.Engine || ''} ${c.EngineVersion || ''}`.trim(),
            engineMode: c.EngineMode || '',
            multiAZ: !!c.MultiAZ, encrypted: !!c.StorageEncrypted,
            iamDatabaseAuthentication: !!c.IAMDatabaseAuthenticationEnabled,
            members: (c.DBClusterMembers || []).length, status: c.Status,
            writer: (c.DBClusterMembers || []).filter((m) => m.IsClusterWriter)
              .map((m) => m.DBInstanceIdentifier).join(', '),
            readers: (c.DBClusterMembers || []).filter((m) => !m.IsClusterWriter)
              .map((m) => m.DBInstanceIdentifier).slice(0, 4).join(', '),
            endpoint: c.Endpoint || '', readerEndpoint: c.ReaderEndpoint || '', port: c.Port,
            backupRetentionDays: c.BackupRetentionPeriod,
            backupWindow: c.PreferredBackupWindow || '',
            maintenanceWindow: c.PreferredMaintenanceWindow || '',
            deletionProtection: !!c.DeletionProtection,
            parameterGroup: c.DBClusterParameterGroup || '',
            subnetGroup: typeof c.DBSubnetGroup === 'string' ? c.DBSubnetGroup : '',
            azs: (c.AvailabilityZones || []).join(', '),
          },
        });
        ctx.addEdge(ctx.cid, rid, 'uses');
        const dbSgIds = [];
        for (const sg of c.VpcSecurityGroups || []) {
          if (!sg.VpcSecurityGroupId) continue;
          dbSgIds.push(sg.VpcSecurityGroupId);
          ctx.wantSg(sg.VpcSecurityGroupId);
          ctx.addNode(sg.VpcSecurityGroupId, 'security-group', 'EC2', sg.VpcSecurityGroupId);
          ctx.addEdge(ctx.cid, sg.VpcSecurityGroupId, 'secured-by');
        }
        // An RDS ENI is described "RDSNetworkInterface"; AND-ed with this
        // cluster's own security group that is an exact association.
        if (dbSgIds.length) {
          ctxWantEnis(ctx)(rid, [
            'Name=description,Values=RDSNetworkInterface',
            `Name=group-id,Values=${dbSgIds.slice(0, 5).join(',')}`,
          ], `db cluster ${c.DBClusterIdentifier}`);
        }
        if (c.DBSubnetGroup) await rdsSubnetGroup(ctx, c.DBSubnetGroup);
        if (c.DBClusterParameterGroup) {
          const pg = `rds/pg/${c.DBClusterParameterGroup}`;
          ctx.addNode(pg, 'parameter-group', 'RDS', c.DBClusterParameterGroup, {
            details: { clusterParameterGroup: true },
          });
          ctx.addEdge(ctx.cid, pg, 'uses');
        }
        if (c.KmsKeyId) {
          const k = ridFromArn(c.KmsKeyId);
          ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: c.KmsKeyId.startsWith('arn:') ? c.KmsKeyId : '' });
          ctx.addEdge(ctx.cid, k, 'encrypted-by');
          ctxWantKms(ctx)(c.KmsKeyId);
        }
        try {
          const { GlobalClusters = [] } = await ctx.run(['rds', 'describe-global-clusters']);
          for (const gc of GlobalClusters) {
            if ((gc.GlobalClusterMembers || []).some((m) => m.DBClusterArn === c.DBClusterArn)) {
              const grid = `rds/global/${gc.GlobalClusterIdentifier}`;
              ctx.addNode(grid, 'other', 'RDS', gc.GlobalClusterIdentifier, {
                arn: gc.GlobalClusterArn || '',
                details: { globalCluster: true, members: (gc.GlobalClusterMembers || []).length },
              });
              ctx.addEdge(ctx.cid, grid, 'member-of');
            }
          }
        } catch (e) { ctx.softErr('rds global-clusters', e); }
      }
    } catch (e) { ctx.softErr('rds clusters', e); }
    if (matched) return;
    if (a && a.resourceType !== 'db') return; // exact cluster target failed — no name fallback
    // standalone instance (direct by ARN id, else heuristic fallback)
    let i;
    if (a) {
      const { DBInstances = [] } = await ctx.run(['rds', 'describe-db-instances', '--db-instance-identifier', a.id]);
      i = DBInstances[0];
    } else {
      const { DBInstances = [] } = await ctx.run(['rds', 'describe-db-instances']);
      i = bestMatch(DBInstances.filter((x) => !x.DBClusterIdentifier), (x) => x.DBInstanceIdentifier, ctx.toks);
    }
    if (!i) return;
    ctx.found();
    const rid = `rds/instance/${i.DBInstanceIdentifier}`;
    ctx.addNode(rid, 'other', 'RDS', i.DBInstanceIdentifier, {
      arn: i.DBInstanceArn || '', tags: tagsOf(i.TagList),
      details: {
        engine: `${i.Engine || ''} ${i.EngineVersion || ''}`.trim(),
        class: i.DBInstanceClass, multiAZ: !!i.MultiAZ, encrypted: !!i.StorageEncrypted,
        az: i.AvailabilityZone || '', secondaryAz: i.SecondaryAvailabilityZone || '',
        endpoint: (i.Endpoint && i.Endpoint.Address) || '', port: (i.Endpoint && i.Endpoint.Port),
        backupRetentionDays: i.BackupRetentionPeriod,
        backupWindow: i.PreferredBackupWindow || '',
        maintenanceWindow: i.PreferredMaintenanceWindow || '',
        deletionProtection: !!i.DeletionProtection,
        publiclyAccessible: !!i.PubliclyAccessible,
        parameterGroup: (i.DBParameterGroups || []).map((p) => p.DBParameterGroupName).join(', '),
        subnetGroup: (i.DBSubnetGroup && i.DBSubnetGroup.DBSubnetGroupName) || '',
        status: i.DBInstanceStatus || '',
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
    const instSgIds = [];
    for (const sg of i.VpcSecurityGroups || []) {
      if (!sg.VpcSecurityGroupId) continue;
      instSgIds.push(sg.VpcSecurityGroupId);
      ctx.wantSg(sg.VpcSecurityGroupId);
      ctx.addNode(sg.VpcSecurityGroupId, 'security-group', 'EC2', sg.VpcSecurityGroupId);
      ctx.addEdge(ctx.cid, sg.VpcSecurityGroupId, 'secured-by');
    }
    if (instSgIds.length) {
      ctxWantEnis(ctx)(rid, [
        'Name=description,Values=RDSNetworkInterface',
        `Name=group-id,Values=${instSgIds.slice(0, 5).join(',')}`,
      ], `db instance ${i.DBInstanceIdentifier}`);
    }
    for (const p of (i.DBParameterGroups || []).slice(0, 3)) {
      if (!p.DBParameterGroupName) continue;
      const pg = `rds/pg/${p.DBParameterGroupName}`;
      ctx.addNode(pg, 'parameter-group', 'RDS', p.DBParameterGroupName, {
        details: { applyStatus: p.ParameterApplyStatus || '' },
      });
      ctx.addEdge(ctx.cid, pg, 'uses');
    }
    if (i.DBSubnetGroup && i.DBSubnetGroup.DBSubnetGroupName) await rdsSubnetGroup(ctx, i.DBSubnetGroup.DBSubnetGroupName);
    if (i.KmsKeyId) {
      const k = ridFromArn(i.KmsKeyId);
      ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: String(i.KmsKeyId).startsWith('arn:') ? i.KmsKeyId : '' });
      ctx.addEdge(ctx.cid, k, 'encrypted-by');
      ctxWantKms(ctx)(i.KmsKeyId);
    }
  },

  async elasticache(ctx) {
    const a = ctx.arn && ctx.arn.service === 'elasticache' ? ctx.arn : null;
    let cacheClusterIds = [];
    if (!a || a.resourceType === 'replicationgroup') try {
      const args = a
        ? ['elasticache', 'describe-replication-groups', '--replication-group-id', a.id]
        : ['elasticache', 'describe-replication-groups'];
      const { ReplicationGroups = [] } = await ctx.run(args);
      const rg = a ? ReplicationGroups[0] : bestMatch(ReplicationGroups, (x) => `${x.ReplicationGroupId} ${x.Description || ''}`, ctx.toks);
      if (rg) {
        ctx.found();
        const rid = `elasticache/${rg.ReplicationGroupId}`;
        ctx.addNode(rid, 'other', 'ElastiCache', rg.ReplicationGroupId, {
          arn: rg.ARN || '',
          details: {
            multiAZ: rg.MultiAZ, clusterEnabled: !!rg.ClusterEnabled,
            nodes: (rg.MemberClusters || []).length,
            atRestEncryption: !!rg.AtRestEncryptionEnabled, transitEncryption: !!rg.TransitEncryptionEnabled,
          },
        });
        ctx.addEdge(ctx.cid, rid, 'uses');
        if (rg.KmsKeyId) {
          const k = ridFromArn(rg.KmsKeyId);
          ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop());
          ctx.addEdge(ctx.cid, k, 'encrypted-by');
        }
        cacheClusterIds = (rg.MemberClusters || []).slice(0, 1);
      }
    } catch (e) { ctx.softErr('elasticache replication-groups', e); }
    if (!cacheClusterIds.length) {
      if (a && a.resourceType !== 'cluster') return; // exact rg target failed — no name fallback
      if (a) {
        const { CacheClusters = [] } = await ctx.run(['elasticache', 'describe-cache-clusters', '--cache-cluster-id', a.id]);
        if (!CacheClusters[0]) return;
        ctx.found();
        cacheClusterIds = [a.id];
      } else {
        const { CacheClusters = [] } = await ctx.run(['elasticache', 'describe-cache-clusters']);
        const c = bestMatch(CacheClusters, (x) => x.CacheClusterId, ctx.toks);
        if (!c) return;
        ctx.found();
        cacheClusterIds = [c.CacheClusterId];
      }
    }
    try {
      const { CacheClusters = [] } = await ctx.run(['elasticache', 'describe-cache-clusters', '--cache-cluster-id', cacheClusterIds[0]]);
      const cc = CacheClusters[0] || {};
      for (const sg of cc.SecurityGroups || []) {
        if (!sg.SecurityGroupId) continue;
        ctx.wantSg(sg.SecurityGroupId);
        ctx.addNode(sg.SecurityGroupId, 'security-group', 'EC2', sg.SecurityGroupId);
        ctx.addEdge(ctx.cid, sg.SecurityGroupId, 'secured-by');
      }
      if (cc.CacheSubnetGroupName) {
        const sgRid = `cachesubnet/${cc.CacheSubnetGroupName}`;
        ctx.addNode(sgRid, 'db-subnet-group', 'ElastiCache', cc.CacheSubnetGroupName);
        ctx.addEdge(ctx.cid, sgRid, 'uses');
        try {
          const { CacheSubnetGroups = [] } = await ctx.run(['elasticache', 'describe-cache-subnet-groups', '--cache-subnet-group-name', cc.CacheSubnetGroupName]);
          for (const sub of (CacheSubnetGroups[0] && CacheSubnetGroups[0].Subnets) || []) {
            const id = sub.SubnetIdentifier;
            if (!id) continue;
            ctx.wantSubnet(id);
            ctx.addNode(id, 'subnet', 'EC2', id);
            ctx.addEdge(sgRid, id, 'contains');
            const az = sub.SubnetAvailabilityZone && sub.SubnetAvailabilityZone.Name;
            if (az) {
              ctx.addNode(az, 'availability-zone', 'EC2', az);
              ctx.addEdge(id, az, 'in-az');
            }
          }
        } catch (e) { ctx.softErr('elasticache subnet-groups', e); }
      }
    } catch (e) { ctx.softErr('elasticache cache-clusters', e); }
  },

  async lambda(ctx) {
    const byArn = !!(ctx.arn && ctx.arn.service === 'lambda' && ctx.arn.resourceType === 'function');
    let fnName;
    if (byArn) {
      fnName = ctx.arn.id; // exact function from ARN — no list/guess
    } else {
      const { Functions = [] } = await ctx.run(['lambda', 'list-functions']);
      const f = bestMatch(Functions, (x) => x.FunctionName, ctx.toks);
      if (!f) return;
      ctx.found();
      fnName = f.FunctionName;
    }
    const cfg = await ctx.run(['lambda', 'get-function-configuration', '--function-name', fnName]);
    if (byArn) ctx.found();
    const rid = `lambda/${cfg.FunctionName}`;
    ctx.addNode(rid, 'other', 'Lambda', cfg.FunctionName, {
      arn: cfg.FunctionArn || '',
      details: {
        runtime: cfg.Runtime, memoryMB: cfg.MemorySize, timeoutSec: cfg.Timeout,
        layers: (cfg.Layers || []).length,
        handler: cfg.Handler || '',
        architectures: (cfg.Architectures || []).join(','),
        packageType: cfg.PackageType || '',
        state: cfg.State || '', lastUpdateStatus: cfg.LastUpdateStatus || '',
        // COUNT only — environment values are secrets and are never stored.
        envVars: Object.keys((cfg.Environment && cfg.Environment.Variables) || {}).length,
        reservedConcurrency: cfg.ReservedConcurrentExecutions,
        ephemeralStorageMB: (cfg.EphemeralStorage && cfg.EphemeralStorage.Size),
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
    if (cfg.Role) {
      const roleRid = ridFromArn(cfg.Role);
      ctx.wantRole(cfg.Role);
      ctx.addNode(roleRid, 'iam-role', 'IAM', roleRid.split('/').pop(), { arn: cfg.Role });
      ctx.addEdge(ctx.cid, roleRid, 'assumes-role');
    }
    const vc = cfg.VpcConfig || {};
    for (const sg of vc.SecurityGroupIds || []) {
      ctx.wantSg(sg);
      ctx.addNode(sg, 'security-group', 'EC2', sg);
      ctx.addEdge(ctx.cid, sg, 'secured-by');
    }
    for (const sub of vc.SubnetIds || []) {
      ctx.wantSubnet(sub);
      ctx.addNode(sub, 'subnet', 'EC2', sub);
      ctx.addEdge(ctx.cid, sub, 'in-subnet');
    }
    // A VPC-attached function's Hyperplane ENIs are described
    // "AWS Lambda VPC ENI-<function>-<uuid>" — wildcard-matched exactly.
    if ((vc.SubnetIds || []).length) {
      ctxWantEnis(ctx)(rid, [`Name=description,Values=AWS Lambda VPC ENI-${cfg.FunctionName}-*`], `function ${cfg.FunctionName}`);
    }
    if (cfg.KMSKeyArn) {
      const k = ridFromArn(cfg.KMSKeyArn);
      ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: cfg.KMSKeyArn });
      ctx.addEdge(ctx.cid, k, 'encrypted-by');
      ctxWantKms(ctx)(cfg.KMSKeyArn);
    }
    const dlq = cfg.DeadLetterConfig && cfg.DeadLetterConfig.TargetArn;
    if (dlq) {
      const drid = ridFromArn(dlq);
      const isSns = dlq.split(':')[2] === 'sns';
      ctx.addNode(drid, isSns ? 'sns-topic' : 'other', isSns ? 'SNS' : 'SQS', drid.split(/[:/]/).pop(), {
        arn: dlq, details: isSns ? {} : { queue: true, dlq: true },
      });
      ctx.addEdge(ctx.cid, drid, 'routes-to');
    }
  },

  async sqs(ctx) {
    let matched;
    if (ctx.arn && ctx.arn.service === 'sqs') {
      // exact queue from ARN — resolve its URL directly, no listing
      const { QueueUrl = '' } = await ctx.run(['sqs', 'get-queue-url', '--queue-name', ctx.arn.id]);
      matched = QueueUrl ? [{ url: QueueUrl, name: ctx.arn.id }] : [];
    } else {
      const { QueueUrls = [] } = await ctx.run(['sqs', 'list-queues']);
      matched = allMatches(QueueUrls.map((u) => ({ url: u, name: u.split('/').pop() })), (q) => q.name, ctx.toks, 5);
    }
    for (const q of matched) {
      ctx.found();
      let attrs = {};
      try {
        const res = await ctx.run(['sqs', 'get-queue-attributes', '--queue-url', q.url, '--attribute-names', 'All']);
        attrs = res.Attributes || {};
      } catch (e) { ctx.softErr('sqs attributes', e); }
      const rid = `sqs/${q.name}`;
      ctx.addNode(rid, 'other', 'SQS', q.name, {
        arn: attrs.QueueArn || '',
        details: { queue: true, fifo: q.name.endsWith('.fifo'), visibilityTimeout: attrs.VisibilityTimeout },
      });
      ctx.addEdge(ctx.cid, rid, 'uses');
      if (attrs.KmsMasterKeyId) {
        const k = ridFromArn(attrs.KmsMasterKeyId);
        ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop());
        ctx.addEdge(rid, k, 'encrypted-by');
      }
      if (attrs.RedrivePolicy) {
        try {
          const rp = JSON.parse(attrs.RedrivePolicy);
          if (rp.deadLetterTargetArn) {
            const dn = rp.deadLetterTargetArn.split(':').pop();
            ctx.addNode(`sqs/${dn}`, 'other', 'SQS', dn, {
              arn: rp.deadLetterTargetArn, details: { queue: true, dlq: true, maxReceiveCount: rp.maxReceiveCount },
            });
            ctx.addEdge(rid, `sqs/${dn}`, 'routes-to');
          }
        } catch { /* malformed redrive policy — skip */ }
      }
      if (attrs.Policy) {
        try {
          const statements = (JSON.parse(attrs.Policy).Statement || []).length;
          ctx.addNode(`${rid}/policy`, 'queue-policy', 'SQS', `${q.name} policy`, { details: { statements } });
          ctx.addEdge(rid, `${rid}/policy`, 'uses');
        } catch { /* statement count only; unparseable — skip */ }
      }
    }
  },

  async s3(ctx) {
    let matched;
    if (ctx.arn && ctx.arn.service === 's3') {
      // exact bucket from ARN — verify it exists, no listing
      await ctx.run(['s3api', 'head-bucket', '--bucket', ctx.arn.id]);
      matched = [{ Name: ctx.arn.id }];
    } else {
      const { Buckets = [] } = await ctx.run(['s3api', 'list-buckets']);
      matched = allMatches(Buckets, (b) => b.Name, ctx.toks, 3);
    }
    for (const b of matched) {
      ctx.found();
      const rid = `s3/${b.Name}`;
      const details = {};
      try {
        const enc = await ctx.run(['s3api', 'get-bucket-encryption', '--bucket', b.Name]);
        const rule = ((enc.ServerSideEncryptionConfiguration || {}).Rules || [])[0] || {};
        const sse = rule.ApplyServerSideEncryptionByDefault || {};
        details.encryption = sse.SSEAlgorithm || 'none';
        if (sse.KMSMasterKeyID) {
          const k = ridFromArn(sse.KMSMasterKeyID);
          ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: sse.KMSMasterKeyID.startsWith('arn:') ? sse.KMSMasterKeyID : '' });
          ctx.addEdge(rid, k, 'encrypted-by');
        }
      } catch { details.encryption = 'none/unknown'; }
      try {
        const v = await ctx.run(['s3api', 'get-bucket-versioning', '--bucket', b.Name]);
        details.versioning = v.Status || 'Disabled';
      } catch { /* optional */ }
      try {
        const rep = await ctx.run(['s3api', 'get-bucket-replication', '--bucket', b.Name]);
        details.replication = `${((rep.ReplicationConfiguration || {}).Rules || []).length} rule(s)`;
      } catch { details.replication = 'none'; }
      try {
        const pab = await ctx.run(['s3api', 'get-public-access-block', '--bucket', b.Name]);
        const c = pab.PublicAccessBlockConfiguration || {};
        details.publicAccessBlock = (c.BlockPublicAcls && c.BlockPublicPolicy && c.IgnorePublicAcls && c.RestrictPublicBuckets)
          ? 'all-blocked' : 'partial';
      } catch { details.publicAccessBlock = 'not-set'; }
      ctx.addNode(rid, 'other', 'S3', b.Name, { details: { bucket: true, ...details } });
      ctx.addEdge(ctx.cid, rid, 'uses');
      try {
        const pol = await ctx.run(['s3api', 'get-bucket-policy', '--bucket', b.Name]);
        const statements = (JSON.parse(pol.Policy || '{}').Statement || []).length;
        ctx.addNode(`${rid}/policy`, 'bucket-policy', 'S3', `${b.Name} policy`, { details: { statements } });
        ctx.addEdge(rid, `${rid}/policy`, 'uses');
      } catch { /* no bucket policy */ }
    }
  },

  async apigateway(ctx) {
    const byArn = ctx.arn && (ctx.arn.service === 'apigateway' || ctx.arn.service === 'execute-api')
      ? ctx.arn : null;
    let matchedV1 = false;
    try {
      let api;
      if (byArn) {
        // exact API from ARN (REST first; HTTP/WebSocket handled by v2 below)
        api = await ctx.run(['apigateway', 'get-rest-api', '--rest-api-id', byArn.id]);
        if (!api || !api.id) api = null;
      } else {
        const { items = [] } = await ctx.run(['apigateway', 'get-rest-apis']);
        api = bestMatch(items, (a) => a.name, ctx.toks);
      }
      if (api) {
        matchedV1 = true;
        ctx.found();
        const rid = `apigw/${api.id}`;
        const details = {
          protocol: 'REST', apiId: api.id,
          endpointTypes: ((api.endpointConfiguration || {}).types || []).join(','),
        };
        try {
          const { item = [] } = await ctx.run(['apigateway', 'get-stages', '--rest-api-id', api.id]);
          details.stages = item.length;
        } catch (e) { ctx.softErr('apigateway stages', e); }
        ctx.addNode(rid, 'other', 'API Gateway', api.name, { details, tags: tagsObj(api.tags) });
        ctx.addEdge(ctx.cid, rid, 'uses');
        try {
          const { items: links = [] } = await ctx.run(['apigateway', 'get-vpc-links']);
          for (const l of links.slice(0, 3)) {
            const lrid = `apigw/vpclink/${l.id}`;
            ctx.addNode(lrid, 'other', 'API Gateway', l.name || l.id, { details: { vpcLink: true, status: l.status } });
            ctx.addEdge(rid, lrid, 'uses');
            for (const t of l.targetArns || []) {
              const lbRid = ridFromArn(t);
              ctx.addNode(lbRid, 'load-balancer', 'ELB', lbRid.split('/')[2] || lbRid, { arn: t });
              ctx.addEdge(lrid, lbRid, 'routes-to');
            }
          }
        } catch (e) { ctx.softErr('apigateway vpc-links', e); }
        try {
          const { items: domains = [] } = await ctx.run(['apigateway', 'get-domain-names']);
          for (const d of domains.slice(0, 5)) {
            const cert = d.regionalCertificateArn || d.certificateArn;
            const drid = `dns/${d.domainName}`;
            ctx.addNode(drid, 'dns-record', 'API Gateway', d.domainName, { details: { customDomain: true } });
            ctx.addEdge(drid, ctx.cid, 'resolves-to');
            if (cert) {
              const crid = ridFromArn(cert);
              ctx.addNode(crid, 'certificate', 'ACM', crid.split('/').pop(), { arn: cert });
              ctx.addEdge(drid, crid, 'uses');
            }
          }
        } catch (e) { ctx.softErr('apigateway domains', e); }
      }
    } catch (e) { ctx.softErr('apigateway v1', e); }
    if (byArn && matchedV1) return;
    try {
      let api;
      if (byArn) {
        api = await ctx.run(['apigatewayv2', 'get-api', '--api-id', byArn.id]);
        if (!api || !api.ApiId) api = null;
      } else {
        const v2 = await ctx.run(['apigatewayv2', 'get-apis']);
        api = bestMatch(v2.Items || [], (a) => a.Name, ctx.toks);
      }
      if (api) {
        ctx.found();
        const rid = `apigw/${api.ApiId}`;
        ctx.addNode(rid, 'other', 'API Gateway', api.Name, {
          details: { protocol: api.ProtocolType, apiId: api.ApiId }, tags: tagsObj(api.Tags),
        });
        ctx.addEdge(ctx.cid, rid, 'uses');
      }
    } catch (e) { ctx.softErr('apigateway v2', e); }
  },

  async secrets(ctx) {
    // Exact ids only: component.arn (secretsmanager) plus secrets[].arn/name.
    const refs = (ctx.c.secrets || []).slice(0, 10);
    if (ctx.arn && ctx.arn.service === 'secretsmanager'
        && !refs.some((s) => s.arn === ctx.arn.arn)) {
      refs.unshift({ name: ctx.arn.name, arn: ctx.arn.arn });
    }
    for (const s of refs.slice(0, 10)) {
      if (!s.name && !s.arn) continue;
      try {
        const d = await ctx.run(['secretsmanager', 'describe-secret', '--secret-id', s.arn || s.name]);
        const rid = `secret/${d.Name || s.name}`;
        ctx.addNode(rid, 'secret', 'Secrets Manager', d.Name || s.name, {
          arn: d.ARN || '', tags: tagsOf(d.Tags),
          details: {
            rotationEnabled: !!d.RotationEnabled,
            replicaRegions: (d.ReplicationStatus || []).map((r) => r.Region).join(',') || 'none',
          },
        });
        ctx.addEdge(ctx.cid, rid, 'uses');
        ctx.found();
        if (d.KmsKeyId) {
          const k = ridFromArn(d.KmsKeyId);
          ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: d.KmsKeyId.startsWith('arn:') ? d.KmsKeyId : '' });
          ctx.addEdge(rid, k, 'encrypted-by');
        }
      } catch (e) { ctx.softErr(`secrets(${s.name})`, e); }
    }
  },

  async route53(ctx) {
    const { HostedZones = [] } = await ctx.run(['route53', 'list-hosted-zones'], { global: true });
    const isDnsComponent = /route\s?53/i.test(ctx.c.kind || '') || ctx.c.kind === 'route53';
    const zones = HostedZones.slice(0, 10);
    if (isDnsComponent && zones.length) ctx.found();
    for (const z of zones) {
      const zid = z.Id.replace(/^\/hostedzone\//, '');
      const zrid = `hostedzone/${zid}`;
      if (isDnsComponent) {
        ctx.addNode(zrid, 'hosted-zone', 'Route 53', z.Name.replace(/\.$/, ''), {
          details: {
            privateZone: !!(z.Config && z.Config.PrivateZone),
            recordSets: z.ResourceRecordSetCount,
          },
        });
        ctx.addEdge(ctx.cid, zrid, 'contains');
      }
    }
    // Record matching against this component's domain-ish candidates.
    if (!ctx.toks.length) return;
    for (const z of zones.slice(0, 3)) {
      const zid = z.Id.replace(/^\/hostedzone\//, '');
      const zrid = `hostedzone/${zid}`;
      try {
        const { ResourceRecordSets = [] } = await ctx.run(
          ['route53', 'list-resource-record-sets', '--hosted-zone-id', zid, '--max-items', '200'], { global: true });
        for (const rec of ResourceRecordSets) {
          if (!['A', 'AAAA', 'CNAME'].includes(rec.Type)) continue;
          if (matchScore(rec.Name, ctx.toks) < 4) continue;
          const name = rec.Name.replace(/\.$/, '');
          const rrid = `dns/${name}/${rec.Type}`;
          const alias = rec.AliasTarget ? String(rec.AliasTarget.DNSName || '').replace(/\.$/, '') : '';
          ctx.addNode(rrid, 'dns-record', 'Route 53', name, {
            details: {
              type: rec.Type,
              alias,
              values: (rec.ResourceRecords || []).length,
              // what it actually points at — the first answers, verbatim
              pointsTo: alias || (rec.ResourceRecords || []).map((v) => v.Value).slice(0, 3).join(', '),
              ttl: rec.TTL,
              routingPolicy: rec.Failover ? `failover ${rec.Failover}`
                : (rec.Weight != null ? `weighted ${rec.Weight}`
                  : (rec.Region ? `latency ${rec.Region}` : (rec.GeoLocation ? 'geolocation' : 'simple'))),
              setIdentifier: rec.SetIdentifier || '',
              healthCheckId: rec.HealthCheckId || '',
              evaluateTargetHealth: rec.AliasTarget ? !!rec.AliasTarget.EvaluateTargetHealth : undefined,
            },
          });
          ctx.addNode(zrid, 'hosted-zone', 'Route 53', z.Name.replace(/\.$/, ''));
          ctx.addEdge(rrid, zrid, 'member-of');
          ctx.addEdge(rrid, ctx.cid, 'resolves-to');
          ctx.found();
        }
      } catch (e) { ctx.softErr('route53 records', e); }
    }
  },

  // -------- ARN-only collectors (reached only via component.arn routing) ----

  async kinesis(ctx) {
    if (!ctx.arn || ctx.arn.service !== 'kinesis' || ctx.arn.resourceType !== 'stream') return;
    const { StreamDescriptionSummary: d = {} } = await ctx.run(
      ['kinesis', 'describe-stream-summary', '--stream-name', ctx.arn.id]);
    ctx.found();
    const rid = `kinesis/${d.StreamName || ctx.arn.id}`;
    ctx.addNode(rid, 'other', 'Kinesis', d.StreamName || ctx.arn.id, {
      arn: d.StreamARN || ctx.arn.arn,
      details: {
        stream: true, status: d.StreamStatus, shards: d.OpenShardCount,
        retentionHours: d.RetentionPeriodHours, encryption: d.EncryptionType || 'NONE',
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
    if (d.KeyId) {
      const k = ridFromArn(d.KeyId);
      ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: String(d.KeyId).startsWith('arn:') ? d.KeyId : '' });
      ctx.addEdge(rid, k, 'encrypted-by');
    }
  },

  async dynamodb(ctx) {
    if (!ctx.arn || ctx.arn.service !== 'dynamodb' || ctx.arn.resourceType !== 'table') return;
    const { Table: t = {} } = await ctx.run(['dynamodb', 'describe-table', '--table-name', ctx.arn.id]);
    ctx.found();
    const rid = `dynamodb/${t.TableName || ctx.arn.id}`;
    ctx.addNode(rid, 'other', 'DynamoDB', t.TableName || ctx.arn.id, {
      arn: t.TableArn || ctx.arn.arn,
      details: {
        table: true, status: t.TableStatus,
        billing: (t.BillingModeSummary && t.BillingModeSummary.BillingMode) || 'PROVISIONED',
        globalTable: (t.Replicas || []).length > 0,
        streamEnabled: !!(t.StreamSpecification && t.StreamSpecification.StreamEnabled),
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
    const kms = t.SSEDescription && t.SSEDescription.KMSMasterKeyArn;
    if (kms) {
      const k = ridFromArn(kms);
      ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: kms });
      ctx.addEdge(rid, k, 'encrypted-by');
    }
  },

  async ecr(ctx) {
    if (!ctx.arn || ctx.arn.service !== 'ecr' || ctx.arn.resourceType !== 'repository') return;
    const { repositories = [] } = await ctx.run(
      ['ecr', 'describe-repositories', '--repository-names', ctx.arn.id]);
    const repo = repositories[0];
    if (!repo) return;
    ctx.found();
    const rid = ridFromArn(repo.repositoryArn) || `ecr/${repo.repositoryName}`;
    ctx.addNode(rid, 'repository', 'ECR', repo.repositoryName, {
      arn: repo.repositoryArn || ctx.arn.arn,
      details: {
        scanOnPush: !!(repo.imageScanningConfiguration && repo.imageScanningConfiguration.scanOnPush),
        tagMutability: repo.imageTagMutability, encryption: (repo.encryptionConfiguration || {}).encryptionType || '',
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
  },

  async transfer(ctx) {
    if (!ctx.arn || ctx.arn.service !== 'transfer' || ctx.arn.resourceType !== 'server') return;
    const { Server: s = {} } = await ctx.run(['transfer', 'describe-server', '--server-id', ctx.arn.id]);
    ctx.found();
    const rid = `transfer/${s.ServerId || ctx.arn.id}`;
    ctx.addNode(rid, 'other', 'Transfer Family', s.ServerId || ctx.arn.id, {
      arn: s.Arn || ctx.arn.arn,
      details: {
        transferServer: true, state: s.State, endpointType: s.EndpointType,
        protocols: (s.Protocols || []).join(','), domain: s.Domain || '',
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
    const vpcCfg = (s.EndpointDetails || {});
    for (const sg of vpcCfg.SecurityGroupIds || []) {
      ctx.wantSg(sg);
      ctx.addNode(sg, 'security-group', 'EC2', sg);
      ctx.addEdge(rid, sg, 'secured-by');
    }
    for (const sub of vpcCfg.SubnetIds || []) {
      ctx.wantSubnet(sub);
      ctx.addNode(sub, 'subnet', 'EC2', sub);
      ctx.addEdge(rid, sub, 'in-subnet');
    }
  },
};

async function rdsSubnetGroup(ctx, nameOrObj) {
  const name = typeof nameOrObj === 'string' ? nameOrObj : nameOrObj.DBSubnetGroupName;
  if (!name) return;
  const rid = `dbsubnet/${name}`;
  ctx.addNode(rid, 'db-subnet-group', 'RDS', name);
  ctx.addEdge(ctx.cid, rid, 'uses');
  try {
    const { DBSubnetGroups = [] } = await ctx.run(['rds', 'describe-db-subnet-groups', '--db-subnet-group-name', name]);
    const g = DBSubnetGroups[0] || {};
    if (g.VpcId) {
      ctx.addNode(g.VpcId, 'vpc', 'EC2', g.VpcId);
      ctx.addEdge(rid, g.VpcId, 'member-of');
    }
    for (const sub of (g.Subnets || []).slice(0, 12)) {
      const id = sub.SubnetIdentifier;
      if (!id) continue;
      ctx.wantSubnet(id);
      ctx.addNode(id, 'subnet', 'EC2', id);
      ctx.addEdge(rid, id, 'contains');
      const az = sub.SubnetAvailabilityZone && sub.SubnetAvailabilityZone.Name;
      if (az) {
        ctx.addNode(az, 'availability-zone', 'EC2', az);
        ctx.addEdge(id, az, 'in-az');
      }
    }
  } catch (e) { ctx.softErr('rds db-subnet-groups', e); }
}

// Which collectors apply to a component.
export function pickCollectors(c) {
  const kind = String(c.kind || '').toLowerCase();
  const svcs = (c.awsServices || []).map((s) => String(s).toLowerCase());
  const has = (s) => svcs.some((x) => x.includes(s));
  const picks = new Set();
  if (/\b(elb|nlb|alb|gwlb)\b|load-?balancer/.test(kind) || has('elb')) picks.add('elbv2');
  if (kind === 'eks-cluster' || (has('eks') && !/workload/.test(kind))) picks.add('eks');
  if (/aurora|rds/.test(kind) || has('aurora') || has('rds')) picks.add('rds');
  if (/elasticache|redis|memcached/.test(kind) || has('elasticache')) picks.add('elasticache');
  if (/lambda/.test(kind) || has('lambda')) picks.add('lambda');
  if (kind === 'sqs' || has('sqs')) picks.add('sqs');
  if (kind === 's3' || has('s3')) picks.add('s3');
  if (/api-?gateway/.test(kind) || has('api gateway')) picks.add('apigateway');
  if ((c.secrets || []).some((s) => s.name || s.arn) || kind === 'secrets-manager' || has('secrets manager')) picks.add('secrets');
  if (/route\s?53/.test(kind) || has('route 53') || has('route53')) picks.add('route53');
  return [...picks];
}

// ---------------------------------------------------------------- deep passes

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ---- security-group rule facts ------------------------------------------
// An SG-to-SG reference is the most reliable machine-readable statement of
// "A talks to B" inside a VPC, so the peer/port facts are PRESERVED rather
// than reduced to a rule count. The encoding is deliberately compact and
// deterministic — `sg-0abc:tcp/5432` pairs joined by '; ' — so it stays small
// in `details` (the graph contract's "counts + key facts, never raw JSON")
// and is still exactly parseable by parseSgRuleFacts() below.

const MAX_SG_PEERS = 10;
const MAX_SG_CIDRS = 6;

// One IpPermission -> 'tcp/5432' | 'tcp/8000-8100' | 'all'
export function sgPortLabel(perm) {
  const proto = perm && perm.IpProtocol != null ? String(perm.IpProtocol) : '';
  if (!proto || proto === '-1') return 'all';
  const from = perm.FromPort; const to = perm.ToPort;
  if (from == null && to == null) return proto;
  if (from === to || to == null) return `${proto}/${from}`;
  return `${proto}/${from}-${to}`;
}

// [IpPermission] -> { peers: ['sg-x:tcp/5432'], cidrs: ['10.0.0.0/8:tcp/22'] }
export function sgRuleFacts(perms) {
  const peers = []; const cidrs = [];
  const seenP = new Set(); const seenC = new Set();
  for (const p of Array.isArray(perms) ? perms : []) {
    const port = sgPortLabel(p);
    for (const u of p.UserIdGroupPairs || []) {
      if (!u || !u.GroupId) continue;
      const k = `${u.GroupId}:${port}`;
      if (seenP.has(k)) continue;
      seenP.add(k); peers.push(k);
    }
    for (const r of [...(p.IpRanges || []), ...(p.Ipv6Ranges || [])]) {
      const c = r && (r.CidrIp || r.CidrIpv6);
      if (!c) continue;
      const k = `${c}:${port}`;
      if (seenC.has(k)) continue;
      seenC.add(k); cidrs.push(k);
    }
    for (const pl of p.PrefixListIds || []) {
      const id = pl && pl.PrefixListId;
      if (!id) continue;
      const k = `${id}:${port}`;
      if (seenC.has(k)) continue;
      seenC.add(k); cidrs.push(k);
    }
  }
  return { peers, cidrs };
}

// The inverse of the encoding above: 'sg-x:tcp/5432; sg-y:all'
//   -> [{ id: 'sg-x', port: 'tcp/5432' }, { id: 'sg-y', port: 'all' }]
// Tolerates undefined/'' (an SG captured before this field existed).
export function parseSgRuleFacts(s) {
  const out = [];
  for (const part of String(s || '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.lastIndexOf(':');
    if (i <= 0) { out.push({ id: t, port: 'all' }); continue; }
    out.push({ id: t.slice(0, i), port: t.slice(i + 1) || 'all' });
  }
  return out;
}

async function deepSecurityGroups(run, g, sgIds, errors) {
  const ids = [...sgIds].slice(0, 100);
  for (const batch of chunk(ids, 50)) {
    try {
      const { SecurityGroups = [] } = await run(['ec2', 'describe-security-groups', '--group-ids', ...batch]);
      const returned = new Set(SecurityGroups.map((s) => s.GroupId));
      for (const id of batch) {
        if (!returned.has(id) && g.addNote) g.addNote(id, 'security group rules not checked (not returned by describe)');
      }
      for (const sg of SecurityGroups) {
        const inbound = sgRuleFacts(sg.IpPermissions);
        const egress = sgRuleFacts(sg.IpPermissionsEgress);
        g.addNode(sg.GroupId, 'security-group', 'EC2', sg.GroupName || sg.GroupId, {
          tags: tagsOf(sg.Tags),
          details: {
            inboundRules: (sg.IpPermissions || []).length,
            outboundRules: (sg.IpPermissionsEgress || []).length,
            vpc: sg.VpcId || '',
            // who may reach THIS group, and on what — the dependency signal
            inboundFromSgs: inbound.peers.slice(0, MAX_SG_PEERS).join('; '),
            inboundFromCidrs: inbound.cidrs.slice(0, MAX_SG_CIDRS).join('; '),
            inboundPeerCount: inbound.peers.length,
            // where THIS group is allowed to go (explicit egress only)
            outboundToSgs: egress.peers.slice(0, MAX_SG_PEERS).join('; '),
            outboundToCidrs: egress.cidrs.slice(0, MAX_SG_CIDRS).join('; '),
            outboundPeerCount: egress.peers.length,
            description: (sg.Description || '').slice(0, 80),
          },
        });
        if (sg.VpcId) {
          g.addNode(sg.VpcId, 'vpc', 'EC2', sg.VpcId);
          g.addEdge(sg.GroupId, sg.VpcId, 'member-of');
        }
      }
    } catch (e) {
      errors.push(`sg-deep: ${shortErr(e)}`);
      const why = whyNotChecked(e);
      for (const id of batch) if (g.addNote) g.addNote(id, `security group rules not checked (${why})`);
    }
  }
}

// Where a route table's 0.0.0.0/0 goes — the whole public/private question.
function defaultRouteOf(rt) {
  for (const r of (rt && rt.Routes) || []) {
    const dest = r.DestinationCidrBlock || r.DestinationIpv6CidrBlock || '';
    if (dest !== '0.0.0.0/0' && dest !== '::/0') continue;
    const via = r.GatewayId || r.NatGatewayId || r.TransitGatewayId
      || r.VpcPeeringConnectionId || r.NetworkInterfaceId || r.InstanceId || r.CarrierGatewayId || '';
    if (!via) continue;
    return { via, state: r.State || '' };
  }
  return null;
}

async function deepSubnets(run, g, subnetIds, errors) {
  const ids = [...subnetIds].slice(0, 60);
  if (!ids.length) return;
  for (const batch of chunk(ids, 50)) {
    try {
      const { Subnets = [] } = await run(['ec2', 'describe-subnets', '--subnet-ids', ...batch]);
      for (const s of Subnets) {
        const name = (tagsOf(s.Tags) || {}).Name || s.SubnetId;
        g.addNode(s.SubnetId, 'subnet', 'EC2', name, {
          tags: tagsOf(s.Tags),
          details: {
            cidr: s.CidrBlock, az: s.AvailabilityZone, azId: s.AvailabilityZoneId || '',
            vpc: s.VpcId || '',
            availableIps: s.AvailableIpAddressCount,
            mapPublicIpOnLaunch: !!s.MapPublicIpOnLaunch,
            defaultForAz: !!s.DefaultForAz,
          },
        });
        if (s.AvailabilityZone) {
          g.addNode(s.AvailabilityZone, 'availability-zone', 'EC2', s.AvailabilityZone);
          g.addEdge(s.SubnetId, s.AvailabilityZone, 'in-az');
        }
        if (s.VpcId) {
          g.addNode(s.VpcId, 'vpc', 'EC2', s.VpcId);
          g.addEdge(s.SubnetId, s.VpcId, 'member-of');
        }
      }
    } catch (e) {
      errors.push(`subnet-deep: ${shortErr(e)}`);
      const why = whyNotChecked(e);
      for (const id of batch) if (g.addNote) g.addNote(id, `subnet attributes not checked (${why})`);
    }
  }
  const gatewayIds = new Set();
  try {
    const { RouteTables = [] } = await run(['ec2', 'describe-route-tables', '--filters', `Name=association.subnet-id,Values=${ids.join(',')}`]);
    for (const rt of RouteTables) {
      const def = defaultRouteOf(rt);
      const via = def ? def.via : '';
      const reach = !via ? 'isolated'
        : (/^igw-/.test(via) ? 'public' : (/^nat-/.test(via) ? 'private (NAT)' : `private (via ${via})`));
      g.addNode(rt.RouteTableId, 'route-table', 'EC2', (tagsOf(rt.Tags) || {}).Name || rt.RouteTableId, {
        tags: tagsOf(rt.Tags),
        details: {
          routes: (rt.Routes || []).length,
          defaultRouteVia: via,
          reachability: reach,
          main: (rt.Associations || []).some((a) => a.Main),
        },
      });
      if (via && /^(igw|nat)-/.test(via)) {
        gatewayIds.add(via);
        g.addNode(via, /^igw-/.test(via) ? 'internet-gateway' : 'nat-gateway', 'EC2', via, {
          details: { vpc: rt.VpcId || '', viaRouteTable: rt.RouteTableId },
        });
        g.addEdge(rt.RouteTableId, via, 'routes-to');
      }
      for (const a of rt.Associations || []) {
        if (a.SubnetId && subnetIds.has(a.SubnetId)) {
          g.addEdge(a.SubnetId, rt.RouteTableId, 'routes-to');
          // The subnet itself carries the answer, so a reader never has to
          // walk to the route table to learn public-vs-private.
          g.addNode(a.SubnetId, 'subnet', 'EC2', '', {
            details: { reachability: reach, defaultRouteVia: via, routeTable: rt.RouteTableId },
          });
        }
      }
    }
    for (const id of ids) {
      const n = g.nodes[id];
      if (n && n.details && n.details.reachability === undefined && g.addNote) {
        g.addNote(id, 'no route table association returned — public/private not determined');
      }
    }
  } catch (e) {
    errors.push(`route-table-deep: ${shortErr(e)}`);
    const why = whyNotChecked(e);
    for (const id of ids) if (g.addNote) g.addNote(id, `route table not checked (${why}) — public/private unknown`);
  }
  // NAT gateways named by a default route: where they live and their EIP.
  const natIds = [...gatewayIds].filter((x) => x.startsWith('nat-')).slice(0, 4);
  if (natIds.length) {
    try {
      const { NatGateways = [] } = await run(['ec2', 'describe-nat-gateways', '--nat-gateway-ids', ...natIds]);
      for (const nat of NatGateways) {
        const addr = (nat.NatGatewayAddresses || [])[0] || {};
        g.addNode(nat.NatGatewayId, 'nat-gateway', 'EC2', (tagsOf(nat.Tags) || {}).Name || nat.NatGatewayId, {
          tags: tagsOf(nat.Tags),
          details: {
            state: nat.State || '', subnet: nat.SubnetId || '', vpc: nat.VpcId || '',
            publicIp: addr.PublicIp || '', connectivity: nat.ConnectivityType || 'public',
          },
        });
        if (nat.SubnetId) g.addEdge(nat.NatGatewayId, nat.SubnetId, 'in-subnet');
      }
    } catch (e) {
      errors.push(`nat-gateway-deep: ${shortErr(e)}`);
      const why = whyNotChecked(e);
      for (const id of natIds) if (g.addNote) g.addNote(id, `NAT gateway not checked (${why})`);
    }
  }
  try {
    const { NetworkAcls = [] } = await run(['ec2', 'describe-network-acls', '--filters', `Name=association.subnet-id,Values=${ids.join(',')}`]);
    for (const acl of NetworkAcls) {
      g.addNode(acl.NetworkAclId, 'nacl', 'EC2', (tagsOf(acl.Tags) || {}).Name || acl.NetworkAclId, {
        tags: tagsOf(acl.Tags), details: { rules: (acl.Entries || []).length, default: !!acl.IsDefault },
      });
      for (const a of acl.Associations || []) {
        if (a.SubnetId && subnetIds.has(a.SubnetId)) g.addEdge(a.SubnetId, acl.NetworkAclId, 'secured-by');
      }
    }
  } catch (e) { errors.push(`nacl-deep: ${shortErr(e)}`); }
}

async function deepRoles(run, g, roleArns, errors) {
  for (const arn of [...roleArns].slice(0, 15)) {
    const roleName = arn.split('/').pop();
    const rid = ridFromArn(arn);
    try {
      const { Role = {} } = await run(['iam', 'get-role', '--role-name', roleName], { global: true });
      const doc = Role.AssumeRolePolicyDocument || {};
      const principals = new Set();
      const stmts = Array.isArray(doc.Statement) ? doc.Statement : (doc.Statement ? [doc.Statement] : []);
      for (const st of stmts) {
        const p = st.Principal || {};
        for (const v of [p.Service, p.Federated, p.AWS]) {
          for (const x of Array.isArray(v) ? v : (v ? [v] : [])) principals.add(String(x).split('/').pop().slice(0, 60));
        }
      }
      g.addNode(rid, 'iam-role', 'IAM', roleName, {
        arn, tags: tagsOf(Role.Tags),
        details: {
          trust: [...principals].slice(0, 5).join(', '),
          maxSessionHours: Role.MaxSessionDuration ? Math.round(Role.MaxSessionDuration / 360) / 10 : undefined,
          permissionsBoundary: (Role.PermissionsBoundary && Role.PermissionsBoundary.PermissionsBoundaryArn)
            ? String(Role.PermissionsBoundary.PermissionsBoundaryArn).split('/').pop() : '',
          path: Role.Path || '/',
        },
      });
    } catch (e) {
      errors.push(`iam get-role(${roleName}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(rid, `trust policy not checked (${whyNotChecked(e)})`);
    }
    try {
      const { AttachedPolicies = [] } = await run(['iam', 'list-attached-role-policies', '--role-name', roleName], { global: true });
      for (const p of AttachedPolicies.slice(0, 15)) {
        const prid = ridFromArn(p.PolicyArn);
        g.addNode(prid, 'iam-policy', 'IAM', p.PolicyName, {
          arn: p.PolicyArn,
          details: { managed: !String(p.PolicyArn || '').includes(':aws:policy/') ? 'customer' : 'aws' },
        });
        g.addEdge(rid, prid, 'has-policy');
      }
      g.addNode(rid, 'iam-role', 'IAM', roleName, {
        details: {
          attachedPolicies: AttachedPolicies.length,
          attachedPolicyNames: AttachedPolicies.slice(0, 6).map((p) => p.PolicyName).join(', '),
        },
      });
    } catch (e) {
      errors.push(`iam role-policies(${roleName}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(rid, `attached policies not checked (${whyNotChecked(e)})`);
    }
    try {
      const { PolicyNames = [] } = await run(['iam', 'list-role-policies', '--role-name', roleName], { global: true });
      g.addNode(rid, 'iam-role', 'IAM', roleName, {
        details: {
          inlinePolicies: PolicyNames.length,
          inlinePolicyNames: PolicyNames.slice(0, 6).join(', '),
        },
      });
    } catch (e) {
      errors.push(`iam inline-policies(${roleName}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(rid, `inline policies not checked (${whyNotChecked(e)})`);
    }
  }
}

async function deepVpcs(run, g, errors) {
  const vpcIds = Object.values(g.nodes).filter((n) => n.type === 'vpc').map((n) => n.rid).slice(0, 20);
  if (!vpcIds.length) return;
  try {
    const { Vpcs = [] } = await run(['ec2', 'describe-vpcs', '--vpc-ids', ...vpcIds]);
    for (const v of Vpcs) {
      const name = (tagsOf(v.Tags) || {}).Name || v.VpcId;
      g.addNode(v.VpcId, 'vpc', 'EC2', name, {
        tags: tagsOf(v.Tags),
        details: {
          cidr: v.CidrBlock,
          extraCidrs: (v.CidrBlockAssociationSet || []).map((a) => a.CidrBlock)
            .filter((c) => c && c !== v.CidrBlock).slice(0, 3).join(', '),
          tenancy: v.InstanceTenancy || '', isDefault: !!v.IsDefault,
        },
      });
    }
  } catch (e) {
    errors.push(`vpc-deep: ${shortErr(e)}`);
    const why = whyNotChecked(e);
    for (const id of vpcIds) if (g.addNote) g.addNote(id, `VPC attributes not checked (${why})`);
  }
}

// ---- network interfaces --------------------------------------------------
// The user's headline ask: "an ELB has a security group and a network
// interface". Each scope carries EXACT filters built from the resource's own
// identifiers (an ELB ENI's description is literally "ELB app/<name>/<hash>"),
// so what comes back belongs to that resource — never a guess.

const MAX_ENI_SCOPES = 12;
const MAX_ENIS_PER_SCOPE = 8;

async function deepNetworkInterfaces(run, g, scopes, errors, { pendingSgs, pendingSubnets } = {}) {
  const entries = [...scopes.entries()].slice(0, MAX_ENI_SCOPES);
  if (scopes.size > MAX_ENI_SCOPES) {
    for (const [rid] of [...scopes.entries()].slice(MAX_ENI_SCOPES)) {
      if (g.addNote) g.addNote(rid, `network interfaces not checked (only ${MAX_ENI_SCOPES} resources per run)`);
    }
  }
  for (const [scopeRid, scope] of entries) {
    const filters = (scope && scope.filters) || [];
    if (!filters.length) continue;
    let list;
    try {
      const res = await run(['ec2', 'describe-network-interfaces', '--filters', ...filters]);
      list = res.NetworkInterfaces || [];
    } catch (e) {
      errors.push(`eni-deep(${scopeRid}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(scopeRid, `network interfaces not checked (${whyNotChecked(e)})`);
      continue;
    }
    if (!list.length) {
      if (g.addNote) g.addNote(scopeRid, 'no network interfaces matched this resource');
      continue;
    }
    if (list.length > MAX_ENIS_PER_SCOPE && g.addNote) {
      g.addNote(scopeRid, `${list.length} network interfaces, first ${MAX_ENIS_PER_SCOPE} attached`);
    }
    for (const eni of list.slice(0, MAX_ENIS_PER_SCOPE)) {
      const id = eni.NetworkInterfaceId;
      if (!id) continue;
      const assoc = eni.Association || {};
      const attach = eni.Attachment || {};
      const sgIds = (eni.Groups || []).map((x) => x.GroupId).filter(Boolean);
      g.addNode(id, 'network-interface', 'EC2', id, {
        tags: tagsOf((eni.TagSet || [])),
        details: {
          privateIp: eni.PrivateIpAddress || '',
          publicIp: assoc.PublicIp || '',
          subnet: eni.SubnetId || '',
          az: eni.AvailabilityZone || '',
          vpc: eni.VpcId || '',
          status: eni.Status || '',
          interfaceType: eni.InterfaceType || 'interface',
          description: String(eni.Description || '').slice(0, 80),
          attachedTo: attach.InstanceId || attach.InstanceOwnerId || '',
          sourceDestCheck: eni.SourceDestCheck,
          securityGroups: sgIds.join(', '),
          ipCount: (eni.PrivateIpAddresses || []).length || (eni.PrivateIpAddress ? 1 : 0),
        },
      });
      g.addEdge(scopeRid, id, 'has-interface');
      if (eni.SubnetId) {
        if (pendingSubnets) pendingSubnets.add(eni.SubnetId);
        g.addNode(eni.SubnetId, 'subnet', 'EC2', eni.SubnetId,
          eni.AvailabilityZone ? { details: { az: eni.AvailabilityZone } } : {});
        g.addEdge(id, eni.SubnetId, 'in-subnet');
      }
      for (const sgId of sgIds) {
        if (pendingSgs) pendingSgs.add(sgId);
        g.addNode(sgId, 'security-group', 'EC2', sgId);
        g.addEdge(id, sgId, 'secured-by');
      }
    }
  }
}

// ---- KMS keys ------------------------------------------------------------

const MAX_KMS_KEYS = 8;

async function deepKmsKeys(run, g, extraKeyIds, errors) {
  const fromGraph = Object.values(g.nodes).filter((n) => n.type === 'kms-key').map((n) => n.arn || n.rid);
  const ids = [...new Set([...fromGraph, ...(extraKeyIds || [])])].filter(Boolean).slice(0, MAX_KMS_KEYS);
  for (const keyId of ids) {
    const rid = ridFromArn(keyId);
    try {
      const { KeyMetadata: k = {} } = await run(['kms', 'describe-key', '--key-id', keyId]);
      g.addNode(rid, 'kms-key', 'KMS', k.Description ? String(k.Description).slice(0, 40) : rid.split('/').pop(), {
        arn: k.Arn || (String(keyId).startsWith('arn:') ? keyId : ''),
        details: {
          keyManager: k.KeyManager || '', keyState: k.KeyState || '',
          enabled: !!k.Enabled, keySpec: k.KeySpec || k.CustomerMasterKeySpec || '',
          keyUsage: k.KeyUsage || '',
          multiRegion: !!k.MultiRegion,
          multiRegionRole: (k.MultiRegionConfiguration && k.MultiRegionConfiguration.MultiRegionKeyType) || '',
          primaryRegion: (k.MultiRegionConfiguration && k.MultiRegionConfiguration.PrimaryKey
            && k.MultiRegionConfiguration.PrimaryKey.Region) || '',
          origin: k.Origin || '',
        },
      });
    } catch (e) {
      errors.push(`kms describe-key(${rid}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(rid, `key metadata not checked (${whyNotChecked(e)})`);
      continue;
    }
    try {
      const rot = await run(['kms', 'get-key-rotation-status', '--key-id', keyId]);
      g.addNode(rid, 'kms-key', 'KMS', '', {
        details: { rotationEnabled: !!rot.KeyRotationEnabled },
      });
    } catch (e) {
      errors.push(`kms rotation(${rid}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(rid, `key rotation not checked (${whyNotChecked(e)})`);
    }
  }
}

// ---- ACM certificates ----------------------------------------------------

const MAX_CERTS = 6;

async function deepCertificates(run, g, certArns, errors) {
  const arns = [...new Set([...(certArns || [])])].filter(Boolean).slice(0, MAX_CERTS);
  for (const arn of arns) {
    const rid = ridFromArn(arn);
    try {
      const { Certificate: c = {} } = await run(['acm', 'describe-certificate', '--certificate-arn', arn]);
      g.addNode(rid, 'certificate', 'ACM', c.DomainName || rid.split('/').pop(), {
        arn: c.CertificateArn || arn,
        details: {
          domain: c.DomainName || '',
          altNames: (c.SubjectAlternativeNames || []).filter((n) => n !== c.DomainName).slice(0, 3).join(', '),
          status: c.Status || '',
          notAfter: c.NotAfter ? String(c.NotAfter).slice(0, 10) : '',
          inUseBy: (c.InUseBy || []).length,
          renewalEligibility: c.RenewalEligibility || '',
          keyAlgorithm: c.KeyAlgorithm || '',
          certType: c.Type || '',
        },
      });
    } catch (e) {
      errors.push(`acm describe-certificate(${rid}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(rid, `certificate not checked (${whyNotChecked(e)})`);
    }
  }
}

// ---- VPC endpoints -------------------------------------------------------
// What the workload can reach privately (and therefore what must exist in the
// recovery region before it works).

const MAX_ENDPOINT_VPCS = 3;
const MAX_ENDPOINTS_PER_VPC = 12;

async function deepVpcEndpoints(run, g, errors) {
  const vpcIds = Object.values(g.nodes).filter((n) => n.type === 'vpc').map((n) => n.rid).slice(0, MAX_ENDPOINT_VPCS);
  for (const vpcId of vpcIds) {
    try {
      const { VpcEndpoints = [] } = await run(['ec2', 'describe-vpc-endpoints', '--filters', `Name=vpc-id,Values=${vpcId}`]);
      for (const ep of VpcEndpoints.slice(0, MAX_ENDPOINTS_PER_VPC)) {
        const id = ep.VpcEndpointId;
        if (!id) continue;
        g.addNode(id, 'vpc-endpoint', 'EC2', (tagsOf(ep.Tags) || {}).Name || String(ep.ServiceName || id).split('.').pop(), {
          tags: tagsOf(ep.Tags),
          details: {
            serviceName: ep.ServiceName || '',
            endpointType: ep.VpcEndpointType || '',
            state: ep.State || '',
            privateDns: !!ep.PrivateDnsEnabled,
            subnets: (ep.SubnetIds || []).length,
            securityGroups: (ep.Groups || []).map((x) => x.GroupId).filter(Boolean).join(', '),
            vpc: vpcId,
          },
        });
        g.addEdge(vpcId, id, 'contains');
        for (const sub of (ep.SubnetIds || []).slice(0, 6)) {
          if (g.nodes[sub]) g.addEdge(id, sub, 'in-subnet');
        }
      }
    } catch (e) {
      errors.push(`vpc-endpoint-deep(${vpcId}): ${shortErr(e)}`);
      if (g.addNote) g.addNote(vpcId, `VPC endpoints not checked (${whyNotChecked(e)})`);
    }
  }
}

// ---------------------------------------------------------------- facts
// §4 of docs/ENV-SERVICE-MODEL.md: every associated resource carries short
// TRUE sentences derived from the describe output. Nothing here invents a
// value — every sentence is a rendering of a field that a describe returned,
// and where a describe did not run the node carries an explicit
// "… not checked (reason)" note instead (graph.notes, written at call sites).

const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);

function factSink(limit = MAX_FACTS_PER_NODE) {
  const out = [];
  const add = (s) => {
    if (out.length >= limit) return false;
    const f = fact(s);
    if (!f || out.includes(f)) return false;
    out.push(f);
    return true;
  };
  return { out, add };
}

// 'sg-0abc' -> 'sg-0abc (adj-alb-sg)' when the graph knows the name.
function label(graph, rid) {
  const n = graph && graph.nodes && graph.nodes[rid];
  if (!n || !n.name || n.name === rid) return rid;
  return `${rid} (${n.name})`;
}

function outEdgesOf(graph, rid) {
  return (graph.edges || []).filter((e) => e.from === rid);
}
function neighbours(graph, rid, relation, type) {
  return outEdgesOf(graph, rid)
    .filter((e) => (!relation || e.relation === relation))
    .map((e) => graph.nodes[e.to])
    .filter((n) => n && (!type || n.type === type));
}

const humanKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

function sgFacts(d, sink, graph) {
  const inPeers = parseSgRuleFacts(d.inboundFromSgs);
  const inCidrs = parseSgRuleFacts(d.inboundFromCidrs);
  const outPeers = parseSgRuleFacts(d.outboundToSgs);
  const outCidrs = parseSgRuleFacts(d.outboundToCidrs);
  let shown = 0; let total = inPeers.length + inCidrs.length + outPeers.length + outCidrs.length;
  for (const p of inPeers.slice(0, 3)) { if (sink.add(`allows inbound ${p.port} from ${label(graph, p.id)}`)) shown++; }
  for (const c of inCidrs.slice(0, 2)) { if (sink.add(`allows inbound ${c.port} from ${c.id}`)) shown++; }
  for (const p of outPeers.slice(0, 2)) { if (sink.add(`allows egress ${p.port} to ${label(graph, p.id)}`)) shown++; }
  for (const c of outCidrs.slice(0, 2)) { if (sink.add(`allows egress ${c.port} to ${c.id}`)) shown++; }
  if (d.inboundRules === 0) sink.add('no inbound rules — nothing may reach it through this group');
  if (d.outboundRules === 0) sink.add('no egress rules — all outbound traffic denied by this group');
  if (total > shown) sink.add(`+${total - shown} further rules not listed here`);
}

function subnetFacts(d, sink) {
  if (has(d.cidr) || has(d.az)) {
    sink.add(`${has(d.cidr) ? d.cidr : 'cidr not checked'}${has(d.az) ? ` in ${d.az}` : ''}`);
  }
  if (has(d.reachability)) {
    const via = has(d.defaultRouteVia) ? ` via ${d.defaultRouteVia}` : '';
    if (d.reachability === 'public') sink.add(`public subnet — default route${via}`);
    else if (d.reachability === 'isolated') sink.add('isolated subnet — no 0.0.0.0/0 route');
    else sink.add(`${d.reachability} subnet — default route${via}`);
  }
  if (has(d.routeTable)) sink.add(`route table ${d.routeTable}`);
  if (d.mapPublicIpOnLaunch === true) sink.add('auto-assigns public IPs on launch');
  if (has(d.availableIps)) sink.add(`${d.availableIps} free IP addresses`);
}

function eniFacts(d, sink) {
  const where = [has(d.subnet) ? `in ${d.subnet}` : '', has(d.az) ? `(${d.az})` : ''].filter(Boolean).join(' ');
  if (has(d.privateIp) || where) sink.add(`${has(d.privateIp) ? d.privateIp : 'interface'} ${where}`.trim());
  if (has(d.publicIp)) sink.add(`has public IP ${d.publicIp}`);
  if (has(d.status) || has(d.interfaceType)) {
    sink.add(`${d.interfaceType || 'interface'}, status ${d.status || 'unknown'}`);
  }
  if (has(d.securityGroups)) sink.add(`secured by ${d.securityGroups}`);
  if (has(d.description)) sink.add(`described "${d.description}"`);
}

function listenerFacts(node, d, sink, graph) {
  const tgs = neighbours(graph, node.rid, 'routes-to', 'target-group');
  const proto = `${d.protocol || '?'}:${d.port != null ? d.port : '?'}`;
  if (tgs.length) {
    for (const tg of tgs.slice(0, 2)) {
      const td = tg.details || {};
      const health = (td.healthyTargets != null && td.totalTargets != null)
        ? ` (${td.healthyTargets}/${td.totalTargets} healthy)` : '';
      sink.add(`listener ${proto} → target group ${tg.name}${health}`);
    }
  } else if (has(d.defaultAction)) {
    sink.add(`listener ${proto} → ${d.defaultAction}`);
  } else {
    sink.add(`listener ${proto}`);
  }
  if (has(d.sslPolicy)) sink.add(`TLS policy ${d.sslPolicy}`);
  const certs = neighbours(graph, node.rid, 'uses', 'certificate');
  for (const c of certs.slice(0, 2)) {
    const cd = c.details || {};
    sink.add(`presents certificate ${cd.domain || c.name}${has(cd.status) ? ` (${cd.status})` : ''}`);
  }
  if (!certs.length && d.certificates === 0 && /HTTPS|TLS/i.test(String(d.protocol || ''))) {
    sink.add('no certificate returned for a TLS listener');
  }
}

function targetGroupFacts(d, sink) {
  if (has(d.protocol) || has(d.port)) {
    sink.add(`${d.protocol || ''}:${d.port != null ? d.port : '?'} to ${d.targetType || 'registered'} targets`.trim());
  }
  const hc = [];
  if (has(d.healthCheckProtocol) || has(d.healthCheckPath)) {
    hc.push(`${d.healthCheckProtocol || ''} ${d.healthCheckPath || ''}`.trim());
  }
  if (has(d.healthCheckPort)) hc.push(`on port ${d.healthCheckPort}`);
  if (has(d.healthCheckIntervalSec)) hc.push(`every ${d.healthCheckIntervalSec}s`);
  if (hc.length) sink.add(`health check ${hc.join(' ')}`);
  if (has(d.healthyThreshold) || has(d.matcher)) {
    sink.add(`healthy after ${d.healthyThreshold != null ? d.healthyThreshold : '?'} checks${has(d.matcher) ? `, expects ${d.matcher}` : ''}`);
  }
  if (d.healthyTargets != null && d.totalTargets != null) {
    sink.add(`${d.healthyTargets} of ${d.totalTargets} registered targets healthy`);
  }
  if (has(d.targets)) sink.add(`targets ${d.targets}`);
  if (has(d.unhealthyReason)) sink.add(`unhealthy reason: ${d.unhealthyReason}`);
}

function loadBalancerFacts(node, d, sink, graph) {
  if (has(d.type) || has(d.scheme)) {
    sink.add(`${d.scheme || ''} ${d.type || ''} load balancer${has(d.state) ? `, state ${d.state}` : ''}`.trim());
  }
  const subnets = neighbours(graph, node.rid, 'in-subnet', 'subnet');
  if (subnets.length) {
    const where = subnets.slice(0, 3)
      .map((s) => `${s.rid}${(s.details && s.details.az) ? ` (${s.details.az})` : ''}`).join(', ');
    sink.add(`lives in ${where}`);
  }
  const sgs = neighbours(graph, node.rid, 'secured-by', 'security-group');
  if (sgs.length) sink.add(`secured by ${sgs.slice(0, 3).map((s) => label(graph, s.rid)).join(', ')}`);
  if (has(d.dnsName)) sink.add(`answers on ${d.dnsName}`);
}

function rdsFacts(d, sink) {
  const head = d.globalCluster ? '' : [
    d.engine,
    has(d.members) ? `${d.members} members` : '',
    typeof d.multiAZ === 'boolean' ? (d.multiAZ ? 'multi-AZ' : 'single-AZ') : '',
  ].filter(Boolean).join(', ');
  if (head) sink.add(head);
  if (has(d.writer)) sink.add(`writer ${d.writer}${has(d.readers) ? `, readers ${d.readers}` : ''}`);
  if (d.encrypted === true) sink.add('storage encrypted at rest');
  else if (d.encrypted === false) sink.add('storage NOT encrypted at rest');
  if (has(d.endpoint)) sink.add(`endpoint ${d.endpoint}${has(d.port) ? `:${d.port}` : ''}`);
  if (has(d.backupRetentionDays)) {
    sink.add(`backups retained ${d.backupRetentionDays} day(s)${has(d.backupWindow) ? `, window ${d.backupWindow} UTC` : ''}`);
  }
  if (has(d.maintenanceWindow)) sink.add(`maintenance window ${d.maintenanceWindow} UTC`);
  if (has(d.parameterGroup)) sink.add(`parameter group ${d.parameterGroup}${has(d.subnetGroup) ? `, subnet group ${d.subnetGroup}` : ''}`);
  if (d.deletionProtection === false) sink.add('deletion protection off');
  if (d.publiclyAccessible === true) sink.add('publicly accessible');
  if (d.globalCluster === true) sink.add(`global cluster with ${d.members} member cluster(s)`);
}

function iamRoleFacts(d, sink) {
  if (has(d.trust)) sink.add(`trusted by ${d.trust}`);
  if (has(d.attachedPolicies)) {
    sink.add(`${d.attachedPolicies} attached policies${has(d.attachedPolicyNames) ? `: ${d.attachedPolicyNames}` : ''}`);
  }
  if (has(d.inlinePolicies)) {
    sink.add(d.inlinePolicies === 0 ? 'no inline policies'
      : `${d.inlinePolicies} inline policies${has(d.inlinePolicyNames) ? `: ${d.inlinePolicyNames}` : ''}`);
  }
  if (has(d.permissionsBoundary)) sink.add(`permissions boundary ${d.permissionsBoundary}`);
}

function kmsFacts(d, sink) {
  if (has(d.keyManager) || has(d.keyState)) {
    sink.add(`${d.keyManager === 'CUSTOMER' ? 'customer-managed' : (d.keyManager === 'AWS' ? 'AWS-managed' : 'key')} key${has(d.keyState) ? `, state ${d.keyState}` : ''}`);
  }
  if (d.rotationEnabled === true) sink.add('automatic key rotation enabled');
  else if (d.rotationEnabled === false) sink.add('automatic key rotation disabled');
  if (d.multiRegion === true) {
    sink.add(`multi-region key${has(d.multiRegionRole) ? ` (${d.multiRegionRole})` : ''}${has(d.primaryRegion) ? `, primary in ${d.primaryRegion}` : ''}`);
  } else if (d.multiRegion === false) {
    sink.add('single-region key — a replica must exist in the recovery region');
  }
  if (has(d.keyUsage)) sink.add(`usage ${d.keyUsage}${has(d.keySpec) ? `, spec ${d.keySpec}` : ''}`);
}

function certFacts(d, sink) {
  if (has(d.domain)) sink.add(`certificate for ${d.domain}${has(d.altNames) ? ` (+ ${d.altNames})` : ''}`);
  if (has(d.status)) sink.add(`status ${d.status}${has(d.notAfter) ? `, expires ${d.notAfter}` : ''}`);
  if (has(d.inUseBy)) sink.add(`in use by ${d.inUseBy} resource(s)`);
  if (has(d.certType)) sink.add(`${d.certType} certificate${has(d.renewalEligibility) ? `, renewal ${d.renewalEligibility}` : ''}`);
}

function endpointFacts(d, sink) {
  const kind = String(d.endpointType || 'VPC').toLowerCase();
  if (has(d.serviceName)) sink.add(`${kind} endpoint for ${d.serviceName}`);
  if (has(d.state)) {
    sink.add(kind === 'gateway'
      ? `state ${d.state} — attached to route tables, not subnets`
      : `state ${d.state}${d.privateDns === true ? ', private DNS enabled' : (d.privateDns === false ? ', private DNS disabled' : '')}`);
  }
  if (has(d.subnets) && d.subnets > 0) sink.add(`present in ${d.subnets} subnet(s)`);
  if (has(d.securityGroups)) sink.add(`secured by ${d.securityGroups}`);
}

function dnsFacts(d, sink) {
  if (has(d.pointsTo)) sink.add(`${d.type || 'record'} ${d.alias ? 'alias ' : ''}→ ${d.pointsTo}`);
  if (has(d.routingPolicy) && d.routingPolicy !== 'simple') {
    sink.add(`${d.routingPolicy} routing${has(d.setIdentifier) ? ` (${d.setIdentifier})` : ''}`);
  }
  if (has(d.healthCheckId)) sink.add(`health check ${d.healthCheckId} attached`);
  if (has(d.ttl)) sink.add(`TTL ${d.ttl}s`);
  if (d.evaluateTargetHealth === true) sink.add('alias evaluates target health');
}

// node.type -> facts. Types not listed fall through to serviceFacts/generic.
const TYPE_FACTS = {
  'security-group': (n, d, s, g) => sgFacts(d, s, g),
  subnet: (n, d, s) => subnetFacts(d, s),
  'network-interface': (n, d, s) => eniFacts(d, s),
  listener: (n, d, s, g) => listenerFacts(n, d, s, g),
  'target-group': (n, d, s) => targetGroupFacts(d, s),
  'load-balancer': (n, d, s, g) => loadBalancerFacts(n, d, s, g),
  'iam-role': (n, d, s) => iamRoleFacts(d, s),
  'kms-key': (n, d, s) => kmsFacts(d, s),
  certificate: (n, d, s) => certFacts(d, s),
  'vpc-endpoint': (n, d, s) => endpointFacts(d, s),
  'dns-record': (n, d, s) => dnsFacts(d, s),
  vpc: (n, d, s) => {
    if (has(d.cidr)) s.add(`cidr ${d.cidr}${has(d.extraCidrs) ? ` (+ ${d.extraCidrs})` : ''}`);
    if (has(d.tenancy)) s.add(`${d.tenancy} tenancy${d.isDefault ? ', the default VPC' : ''}`);
  },
  'route-table': (n, d, s) => {
    if (has(d.routes)) s.add(`${d.routes} routes${has(d.defaultRouteVia) ? `, 0.0.0.0/0 via ${d.defaultRouteVia}` : ', no default route'}`);
    if (has(d.reachability)) s.add(`makes its subnets ${d.reachability}`);
    if (d.main === true) s.add('the VPC main route table');
  },
  'nat-gateway': (n, d, s) => {
    if (has(d.subnet)) s.add(`NAT gateway in ${d.subnet}${has(d.state) ? `, state ${d.state}` : ''}`);
    if (has(d.publicIp)) s.add(`egresses from ${d.publicIp}`);
    if (!has(d.subnet) && has(d.viaRouteTable)) s.add(`NAT gateway carrying 0.0.0.0/0 for ${d.viaRouteTable}`);
  },
  'internet-gateway': (n, d, s) => {
    s.add(`internet gateway${has(d.vpc) ? ` for ${d.vpc}` : ''}`);
    if (has(d.viaRouteTable)) s.add(`carries 0.0.0.0/0 for ${d.viaRouteTable} — the public path`);
  },
  'oidc-provider': (n, d, s) => {
    s.add(`OIDC provider ${String(n.rid).split('/id/').pop()} — IAM roles for service accounts`);
  },
  'launch-template': (n, d, s) => {
    s.add(`launch template ${n.name || n.rid}${has(d.version) ? ` version ${d.version}` : ''}`);
  },
  addon: (n, d, s) => {
    if (has(d.addonVersion)) s.add(`addon ${n.name || n.rid} ${d.addonVersion}${has(d.status) ? `, ${d.status}` : ''}`);
    else s.add(`EKS managed addon ${n.name || n.rid}`);
    if (has(d.serviceAccountRole)) s.add(`runs as service account role ${d.serviceAccountRole}`);
  },
  nacl: (n, d, s) => {
    if (has(d.rules)) s.add(`${d.rules} network ACL entries${d.default ? ' (the default ACL)' : ''}`);
  },
  'availability-zone': (n, d, s) => s.add(`availability zone ${n.name || n.rid}`),
  'hosted-zone': (n, d, s) => {
    if (has(d.recordSets)) s.add(`${d.recordSets} record sets${d.privateZone ? ', private zone' : ', public zone'}`);
  },
  secret: (n, d, s) => {
    if (d.rotationEnabled === true) s.add('rotation enabled');
    else if (d.rotationEnabled === false) s.add('rotation not enabled');
    if (has(d.replicaRegions)) {
      s.add(d.replicaRegions === 'none' ? 'no replica regions — must be recreated in recovery'
        : `replicated to ${d.replicaRegions}`);
    }
  },
  'db-subnet-group': (n, d, s, g) => {
    const subs = neighbours(g, n.rid, 'contains', 'subnet');
    const azs = [...new Set(subs.map((x) => (x.details || {}).az).filter(Boolean))];
    s.add(`db subnet group ${n.name || n.rid}${subs.length ? ` — ${subs.length} subnets` : ''}${azs.length ? ` in ${azs.join(', ')}` : ''}`);
  },
  'parameter-group': (n, d, s) => s.add(`${d.clusterParameterGroup ? 'cluster ' : ''}parameter group ${n.name || n.rid}`),
  nodegroup: (n, d, s) => {
    if (has(d.instanceTypes)) s.add(`${d.instanceTypes} ${d.capacityType || ''} nodes, ${d.amiType || ''}`.trim());
    if (has(d.desired)) s.add(`scaling ${d.min}/${d.desired}/${d.max} (min/desired/max)`);
    if (has(d.status)) s.add(`status ${d.status}`);
  },
  'iam-policy': (n, d, s) => s.add(`${d.managed === 'aws' ? 'AWS-managed' : 'customer-managed'} policy ${n.name || n.rid}`),
};

// node.service -> facts, for the 'other'-typed service principals.
const SERVICE_FACTS = {
  RDS: (n, d, s) => rdsFacts(d, s),
  Lambda: (n, d, s) => {
    if (has(d.runtime) || has(d.memoryMB)) s.add(`${d.runtime || 'function'}, ${d.memoryMB}MB, ${d.timeoutSec}s timeout`);
    if (has(d.handler)) s.add(`handler ${d.handler}${has(d.architectures) ? ` on ${d.architectures}` : ''}`);
    if (has(d.envVars)) s.add(`${d.envVars} environment variables (values not read)`);
    if (has(d.state)) s.add(`state ${d.state}${has(d.lastUpdateStatus) ? `, last update ${d.lastUpdateStatus}` : ''}`);
    if (has(d.reservedConcurrency)) s.add(`reserved concurrency ${d.reservedConcurrency}`);
  },
  EKS: (n, d, s) => {
    if (has(d.version)) s.add(`Kubernetes ${d.version}${has(d.status) ? `, status ${d.status}` : ''}`);
    if (d.endpointPublicAccess !== undefined || d.endpointPrivateAccess !== undefined) {
      const pub = !!d.endpointPublicAccess; const priv = !!d.endpointPrivateAccess;
      s.add(`API endpoint ${pub && priv ? 'public and private' : (pub ? 'public only' : (priv ? 'private only' : 'neither public nor private'))}`);
    }
  },
  SQS: (n, d, s) => {
    if (d.dlq) s.add(`dead-letter queue${has(d.maxReceiveCount) ? `, after ${d.maxReceiveCount} receives` : ''}`);
    else if (d.queue) s.add(`queue${d.fifo ? ' (FIFO)' : ''}${has(d.visibilityTimeout) ? `, visibility timeout ${d.visibilityTimeout}s` : ''}`);
  },
  S3: (n, d, s) => {
    if (has(d.encryption)) s.add(`encryption ${d.encryption}`);
    if (has(d.versioning)) s.add(`versioning ${d.versioning}`);
    if (has(d.replication)) s.add(`cross-region replication: ${d.replication}`);
    if (has(d.publicAccessBlock)) s.add(`public access block ${d.publicAccessBlock}`);
  },
  ElastiCache: (n, d, s) => {
    if (has(d.nodes)) s.add(`${d.nodes} node(s)${d.clusterEnabled ? ', cluster mode on' : ''}`);
    if (has(d.multiAZ)) s.add(`multi-AZ ${d.multiAZ}`);
    if (d.atRestEncryption !== undefined) s.add(`encryption at rest ${d.atRestEncryption ? 'on' : 'off'}, in transit ${d.transitEncryption ? 'on' : 'off'}`);
  },
  Kinesis: (n, d, s) => {
    if (has(d.shards)) s.add(`${d.shards} open shards, ${d.retentionHours}h retention`);
    if (has(d.encryption)) s.add(`encryption ${d.encryption}`);
  },
  DynamoDB: (n, d, s) => {
    if (has(d.billing)) s.add(`${d.billing} billing${has(d.status) ? `, status ${d.status}` : ''}`);
    if (d.globalTable !== undefined) s.add(d.globalTable ? 'global table with replicas' : 'not a global table');
    if (d.streamEnabled !== undefined) s.add(`streams ${d.streamEnabled ? 'enabled' : 'disabled'}`);
  },
  'API Gateway': (n, d, s) => {
    if (has(d.protocol)) s.add(`${d.protocol} API${has(d.apiId) ? ` ${d.apiId}` : ''}`);
    if (has(d.stages)) s.add(`${d.stages} stage(s) deployed`);
    if (d.vpcLink) s.add(`VPC link${has(d.status) ? `, status ${d.status}` : ''}`);
  },
  ECR: (n, d, s) => {
    if (has(d.tagMutability)) s.add(`tags ${d.tagMutability}, scan on push ${d.scanOnPush ? 'on' : 'off'}`);
    if (has(d.encryption)) s.add(`encryption ${d.encryption}`);
  },
  'Transfer Family': (n, d, s) => {
    if (has(d.protocols)) s.add(`${d.protocols} server, endpoint ${d.endpointType || ''}`.trim());
    if (has(d.state)) s.add(`state ${d.state}`);
  },
};

const GENERIC_SKIP = new Set(['matchedTag', 'targets', 'securityGroups']);

// factsFor(node, graph) -> short true sentences about this resource.
export function factsFor(node, graph = { nodes: {}, edges: [], notes: {} }) {
  if (!node) return [];
  const sink = factSink();
  const d = node.details || {};
  const gen = TYPE_FACTS[node.type] || (node.type === 'other' ? SERVICE_FACTS[node.service] : null);
  if (gen) gen(node, d, sink, graph);
  // Whatever the resource is, if describe-network-interfaces attached ENIs to
  // it, say so here — this is the user's "an ELB has a network interface".
  const enis = neighbours(graph, node.rid, 'has-interface', 'network-interface');
  if (enis.length) {
    const azs = [...new Set(enis.map((e) => (e.details || {}).az).filter(Boolean))];
    sink.add(enis.length === 1
      ? `1 network interface ${enis[0].rid}${azs.length ? ` in ${azs[0]}` : ''}`
      : `${enis.length} network interfaces${azs.length ? ` in ${azs.join(', ')}` : ''}`);
  }
  if (!sink.out.length) {
    // Last resort: render up to three describe fields as plain statements.
    for (const [k, v] of Object.entries(d)) {
      if (GENERIC_SKIP.has(k) || !has(v)) continue;
      if (typeof v === 'object') continue;
      if (!sink.add(`${humanKey(k)}: ${v}`)) break;
      if (sink.out.length >= 3) break;
    }
  }
  // Run-scoped notes ("… not checked (access denied)") always get through.
  for (const note of ((graph.notes || {})[node.rid]) || []) sink.add(note);
  if (!sink.out.length) sink.add('found, but no describe detail was returned for it');
  return sink.out;
}

// ------------------------------------------------- component resourceDetails
// The contract's second view of the same truth (§2 Component.resourceDetails):
// everything reachable from the component, each with its facts, so the
// workbook and the UI can render a per-component dropdown without walking the
// graph. Built FROM the graph, so the two cannot disagree.

const RELATION_ORDER = [
  'uses', 'secured-by', 'has-interface', 'listens-on', 'targets', 'routes-to',
  'in-subnet', 'in-az', 'member-of', 'contains', 'assumes-role', 'has-policy',
  'encrypted-by', 'resolves-to', 'logs-to', 'alarmed-by', 'tagged-match',
];

// Reached, but nothing further hangs off them that belongs to THIS component
// (a VPC endpoint's subnets are the endpoint's, not the workload's).
const NO_EXPAND_TYPES = new Set([
  'availability-zone', 'certificate', 'kms-key', 'iam-policy', 'vpc-endpoint',
  'nacl', 'internet-gateway', 'addon', 'oidc-provider', 'launch-template',
]);

export function buildResourceDetails(graph, componentId, { checkedAt = new Date().toISOString(), maxHops = 4, limit = MAX_DETAILS_PER_COMPONENT } = {}) {
  const nodes = graph.nodes || {};
  const out = new Map(); // rid -> {relation, hops}
  let frontier = [componentId];
  const seen = new Set([componentId]);
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next = [];
    for (const from of frontier) {
      for (const e of (graph.edges || [])) {
        if (e.from !== from || seen.has(e.to)) continue;
        if (String(e.to).startsWith('cmp_')) continue; // another component, not a resource
        seen.add(e.to);
        const n = nodes[e.to];
        if (n) {
          out.set(e.to, { relation: e.relation, hops: hop });
          if (!NO_EXPAND_TYPES.has(n.type)) next.push(e.to);
        }
      }
    }
    frontier = next;
  }
  // Nodes attributed to this component that no directed edge reached.
  for (const [rid, n] of Object.entries(nodes)) {
    if (out.has(rid) || !(n.componentIds || []).includes(componentId)) continue;
    const inEdge = (graph.edges || []).find((e) => e.to === rid);
    out.set(rid, { relation: (inEdge && inEdge.relation) || 'uses', hops: 1 });
  }
  const entries = [...out.entries()].map(([rid, meta]) => {
    const n = nodes[rid];
    return {
      rid,
      type: n.type || 'other',
      name: n.name || rid,
      service: n.service || '',
      arn: n.arn || '',
      relation: meta.relation,
      hops: meta.hops,
      facts: factsFor(n, graph),
      details: { ...(n.details || {}) },
      source: n.source || 'aws-enrich',
      checkedAt,
    };
  });
  entries.sort((a, b) => (a.hops - b.hops)
    || (RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation))
    || String(a.type).localeCompare(String(b.type))
    || String(a.name).localeCompare(String(b.name)));
  return { entries: entries.slice(0, limit), truncated: Math.max(0, entries.length - limit) };
}

// Write resourceDetails onto the components themselves (the contract says the
// component carries them, not only the graph). Only the components this run
// enriched are touched; everything else on the component is left alone.
export function applyResourceDetails(slug, byComponent) {
  const ids = Object.keys(byComponent || {});
  if (!ids.length) return 0;
  const components = store.getCollection(slug, 'components');
  let changed = 0;
  for (const c of components) {
    if (!Object.prototype.hasOwnProperty.call(byComponent, c.id)) continue;
    c.resourceDetails = byComponent[c.id];
    changed++;
  }
  if (changed) store.saveCollection(slug, 'components', components);
  return changed;
}

// ---------------------------------------------------------------- environment scope
// §3: enrichment runs against the profile/region of the environment being
// enriched. server/lib/scope.js is owned by another agent and may land after
// this file — it is imported defensively and this module falls back to
// reading workspace.json itself (and to workspace-level behaviour when the
// workspace has no environments at all).

let scopeModPromise = null;
async function loadScopeModule() {
  if (!scopeModPromise) scopeModPromise = import('./scope.js').catch(() => null);
  return scopeModPromise;
}

// resolveEnvScope(slug, envId) -> null (no scope) | {envId, envName, profile,
//   region, recoveryRegion, kubeContext, source}
// Throws a 404-shaped error for an unknown envId.
export async function resolveEnvScope(slug, envId) {
  const id = String(envId || '').trim();
  if (!id) return null;
  const shape = (env, source) => ({
    envId: env.id || id,
    envName: env.name || env.slug || env.id || id,
    profile: String(env.awsProfile || ''),
    region: String((env.regions && env.regions.primary) || env.region || ''),
    recoveryRegion: String((env.regions && env.regions.recovery) || ''),
    kubeContext: String(env.kubeContext || ''),
    source,
  });
  const mod = await loadScopeModule();
  if (mod) {
    for (const fn of ['resolveEnvironment', 'getEnvironment', 'findEnvironment', 'resolveEnv']) {
      if (typeof mod[fn] !== 'function') continue;
      try {
        const env = await mod[fn](slug, id);
        if (env && (env.id || env.name)) return shape(env, `scope.js:${fn}`);
      } catch (e) {
        if (e && e.status === 404) throw e;
        // any other failure: fall through to the workspace.json fallback
      }
    }
  }
  const ws = store.getWorkspace(slug) || {};
  const envs = Array.isArray(ws.environments) ? ws.environments : [];
  const env = envs.find((e) => e && (e.id === id || e.slug === id));
  if (!env) {
    throw store.httpError(404, envs.length
      ? `unknown environment '${id}' (known: ${envs.map((e) => e.id).join(', ')})`
      : `unknown environment '${id}' — this workspace has no environments`);
  }
  return shape(env, 'workspace.json');
}

// ---------------------------------------------------------------- runners

function makeRunner({ region, profile, log, via = 'profile' }) {
  // via 'vault' needs the profile name verbatim (even 'default'); otherwise
  // 'default' means "no --profile" exactly as before.
  const vaultMode = via === 'vault' && !!profile;
  const useProfile = vaultMode ? profile : (profile && profile !== 'default' ? profile : '');
  return async function run(args, { global: isGlobal = false } = {}) {
    const full = [...args, '--output', 'json', '--no-cli-pager'];
    if (!isGlobal && region) full.push('--region', region);
    const { bin, args: spawnArgs } = awsArgs(useProfile, full, { via: vaultMode ? 'vault' : 'profile' });
    log.push(vaultMode ? `aws-vault exec ${useProfile} -- aws ${full.join(' ')}` : `aws ${spawnArgs.join(' ')}`);
    const { stdout } = await execFile(bin, spawnArgs, { timeout: AWS_TIMEOUT, maxBuffer: MAX_BUFFER, env: process.env });
    const out = stdout.toString().trim();
    return out ? JSON.parse(out) : {};
  };
}

async function withConcurrency(tasks, limit = CONCURRENCY) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

// enrichComponents({slug, componentIds, profile, region, target, envId})
//   -> { nodes, edges, perComponent, resourceDetails, log, errors,
//        followUpCalls, followUpCapped, scope?, targeted? }
// target 'arpio' (the Arpio-first overlay) narrows to components tagged
// 'arpio' OR carrying an arn with an arpio-* replication mechanism — with
// ARN-first matching only exact describes run, no account scan.
// envId scopes the run to ONE environment: its components, its awsProfile and
// its primary region (an explicit profile/region argument still wins).
// Callers merge into the stored graph with mergeGraph() and save;
// component.resourceDetails is written here so every caller agrees.
export async function enrichComponents({ slug, componentIds = [], profile = '', region = '', target = '', authVia = '', envId = '', onLog } = {}) {
  const log = makeLog(onLog); const errors = [];
  const perComponent = [];

  // Environment scope first: it may supply the profile and the region.
  const scope = await resolveEnvScope(slug, envId); // throws 404 on unknown id
  if (scope) {
    if (!profile && scope.profile) profile = scope.profile;
    if (!region && scope.region) region = scope.region;
    log.push(`scope: environment ${scope.envName} (${scope.envId}) via ${scope.source}`
      + `${scope.profile ? `, profile ${scope.profile}` : ', no awsProfile set'}`
      + `${scope.region ? `, region ${scope.region}` : ''}`);
  }
  const g = makeGraphBuilder(region);

  const all = store.getCollection(slug, 'components');
  const inScope = (c) => !scope || c.envId === scope.envId;
  let targets = componentIds.length
    ? all.filter((c) => componentIds.includes(c.id))
    : all.filter((c) => (c.awsServices || []).length || c.arn);
  for (const id of componentIds) {
    if (!all.some((c) => c.id === id)) errors.push(`unknown component id: ${id}`);
  }
  let targeted;
  if (target === 'arpio') {
    const isArpio = (c) => (Array.isArray(c.tags) && c.tags.includes('arpio'))
      || (!!c.arn && String((c.replication || {}).mechanism || '').startsWith('arpio'));
    targets = (componentIds.length ? targets : all).filter(isArpio);
    targeted = targets.length;
    log.push(`Arpio overlay: ${targeted} components targeted by ARN`);
  }
  if (scope) {
    const before = targets.length;
    targets = targets.filter(inScope);
    log.push(`scope: ${targets.length} of ${before} components belong to ${scope.envName}`);
    if (targeted !== undefined) targeted = targets.length;
  }

  const scopeOut = scope ? {
    envId: scope.envId, envName: scope.envName, componentCount: targets.length,
    profile: scope.profile, region: scope.region,
  } : undefined;
  const empty = {
    nodes: g.nodes, edges: g.edges, perComponent, resourceDetails: {},
    log, errors, followUpCalls: 0, followUpCapped: false,
  };
  if (scopeOut) empty.scope = scopeOut;
  if (targeted !== undefined) empty.targeted = targeted;
  if (!(await awsCliFound())) { errors.push('AWS CLI not found — install awscli and configure a profile'); return empty; }
  if (!region) {
    errors.push(scope
      ? `A region is required — environment ${scope.envName} has no regions.primary and none was passed`
      : 'A region is required (e.g. us-east-1)');
    return empty;
  }

  const run = makeRunner({ region, profile, log, via: await resolveAuthVia(profile, authVia) });
  // Every follow-up describe (the ones that EXPLAIN a resource) is charged to
  // one budget; primary collector calls are not.
  const budget = makeBudget(MAX_FOLLOWUP_CALLS);
  const deep = budgetedRun(run, budget);
  const pendingSgs = new Set(); const pendingSubnets = new Set(); const pendingRoles = new Set();
  const pendingEnis = new Map(); const pendingKms = new Set(); const pendingCerts = new Set();

  const tasks = targets.map((c) => async () => {
    const toks = componentTokens(c);
    let found = false;
    // ARN-first: an exact arn on the component routes straight to one
    // collector driven at that resource; name heuristics only as fallback.
    const parsed = c.arn ? parseArn(c.arn) : null;
    const arnCollector = parsed ? ARN_COLLECTORS[parsed.service] : null;
    if (c.arn && !parsed) {
      log.push(`${c.id}: unparseable arn '${c.arn}' — falling back to name heuristics`);
    } else if (parsed && !arnCollector) {
      log.push(`${c.id}: no direct collector for arn service '${parsed.service}' — falling back to name heuristics`);
    }
    const byArn = !!(parsed && arnCollector);
    if (byArn) log.push(`${c.id}: exact-target describe via arn (${parsed.service} ${parsed.resourceType || ''} ${parsed.id})`.replace(/\s+/g, ' '));
    const before = new Set(Object.keys(g.nodes).filter((rid) => g.nodes[rid].componentIds.includes(c.id)));
    const ctx = {
      run, region, c, cid: c.id, toks,
      arn: byArn ? parsed : null,
      found: () => { found = true; },
      softErr: (what, e) => errors.push(`${c.id}/${what}: ${shortErr(e)}`),
      addNode: (rid, type, service, name, opts = {}) => g.addNode(rid, type, service, name, { ...opts, componentId: c.id }),
      addEdge: g.addEdge,
      wantSg: (id) => { if (id) pendingSgs.add(id); },
      wantSubnet: (id) => { if (id) pendingSubnets.add(id); },
      wantRole: (arn) => { if (arn) pendingRoles.add(arn); },
      deep,
      wantEnis: (rid, filters, what) => { if (rid && (filters || []).length && !pendingEnis.has(rid)) pendingEnis.set(rid, { filters, what }); },
      wantKms: (id) => { if (id) pendingKms.add(id); },
      wantCert: (arn) => { if (arn) pendingCerts.add(arn); },
      note: (rid, text) => g.addNote(rid, text),
    };
    const collectors = byArn ? [arnCollector] : pickCollectors(c);
    // secrets[].arn stays honored even when the component arn drives elsewhere
    if (byArn && arnCollector !== 'secrets' && (c.secrets || []).some((s) => s.arn || s.name)) collectors.push('secrets');
    for (const name of collectors) {
      try { await COLLECTORS[name](ctx); } catch (e) { errors.push(`${c.id}/${name}: ${shortErr(e)}`); }
    }
    const nodeCount = Object.values(g.nodes)
      .filter((n) => n.componentIds.includes(c.id) && !before.has(n.rid)).length;
    const matchedBy = found ? (byArn ? 'arn' : 'name') : 'none';
    perComponent.push({ componentId: c.id, found, nodes: nodeCount, matchedBy });
  });
  await withConcurrency(tasks);

  // Deep association walks over everything collected anywhere. ENIs run first:
  // they discover further subnets and security groups that the passes below
  // then explain. Every one of these is charged to the follow-up budget.
  if (pendingEnis.size) await deepNetworkInterfaces(deep, g, pendingEnis, errors, { pendingSgs, pendingSubnets });
  if (pendingSgs.size) await deepSecurityGroups(deep, g, pendingSgs, errors);
  if (pendingSubnets.size) await deepSubnets(deep, g, pendingSubnets, errors);
  if (pendingRoles.size) await deepRoles(deep, g, pendingRoles, errors);
  await deepVpcs(deep, g, errors);
  await deepKmsKeys(deep, g, pendingKms, errors);
  if (pendingCerts.size) await deepCertificates(deep, g, pendingCerts, errors);
  await deepVpcEndpoints(deep, g, errors);

  if (budget.capped) {
    const msg = `follow-up describe cap reached (${budget.limit} calls) — some resources are marked "not checked"`;
    errors.push(msg);
    log.push(msg);
  }
  log.push(`follow-up describes: ${budget.used}/${budget.limit}`);

  // Facts ride on the graph node as well as on the component, from the same
  // derivation, so the two views are byte-identical where they overlap.
  for (const n of Object.values(g.nodes)) n.facts = factsFor(n, g);

  // The component-side view of the same truth (contract §4). Built from the
  // graph this run produced, so the two views cannot disagree.
  const checkedAt = new Date().toISOString();
  const resourceDetails = {};
  for (const p of perComponent) {
    const built = buildResourceDetails(g, p.componentId, { checkedAt });
    resourceDetails[p.componentId] = built.entries;
    p.resources = built.entries.length;
    p.facts = built.entries.reduce((n, e) => n + e.facts.length, 0);
    if (built.truncated) {
      p.resourcesTruncated = built.truncated;
      log.push(`${p.componentId}: ${built.truncated} further associated resources not attached (cap ${MAX_DETAILS_PER_COMPONENT})`);
    }
  }
  try {
    const written = applyResourceDetails(slug, resourceDetails);
    log.push(`resourceDetails written to ${written} component(s)`);
  } catch (e) {
    errors.push(`resourceDetails write failed: ${shortErr(e)}`);
  }

  const out = {
    nodes: g.nodes, edges: g.edges, notes: g.notes, perComponent, resourceDetails,
    log, errors, followUpCalls: budget.used, followUpCapped: budget.capped,
  };
  if (scopeOut) out.scope = { ...scopeOut, componentCount: targets.length };
  if (targeted !== undefined) out.targeted = targeted;
  return out;
}

// ------------------------------------------------------------ tag filters

const MAX_TAG_FILTERS = 10;
const MAX_TAG_VALUES = 20;

function tagFilterError(message) {
  const e = new Error(message); e.status = 400; return e;
}

// normalizeTagFilters({tags, tagKey, tagValue}) -> [{key, values:[...]}, ...]
// Accepts the list form or the legacy single {tagKey, tagValue} pair (which
// converts to a one-entry list). Returns [] when nothing was provided;
// throws (with .status=400) when filters are present but invalid.
// Semantics match `resourcegroupstaggingapi --tag-filters`: AND across keys,
// OR within a key's values.
export function normalizeTagFilters({ tags, tagKey, tagValue } = {}) {
  let list = Array.isArray(tags) ? tags : null;
  if (!list && (tagKey || tagValue)) {
    if (!tagKey || !tagValue) return []; // legacy pair incomplete — caller reports
    list = [{ key: tagKey, values: [tagValue] }];
  }
  if (!list) return [];
  if (list.length > MAX_TAG_FILTERS) throw tagFilterError(`too many tag filters (max ${MAX_TAG_FILTERS})`);
  const out = [];
  for (const f of list) {
    const key = String((f && f.key) ?? '').trim();
    let values = Array.isArray(f && f.values) ? f.values : (f && f.value != null ? [f.value] : []);
    values = values.map((v) => String(v ?? '').trim()).filter(Boolean);
    if (!key) throw tagFilterError('each tag filter needs a non-empty key');
    if (key.length > 128) throw tagFilterError(`tag key too long (max 128): ${key.slice(0, 40)}…`);
    if (!values.length) throw tagFilterError(`tag filter '${key}' needs at least one value`);
    if (values.length > MAX_TAG_VALUES) throw tagFilterError(`tag filter '${key}' has too many values (max ${MAX_TAG_VALUES})`);
    for (const v of values) {
      if (v.length > 256) throw tagFilterError(`tag value too long (max 256) for key '${key}'`);
    }
    if ([key, ...values].some((s) => /[,= -]/.test(s))) {
      throw tagFilterError('tag keys/values must not contain commas, equals signs, or control characters');
    }
    out.push({ key, values });
  }
  return out;
}

// Component-worthy ARN services -> proposal category/kind (aws-discovery style).
function proposalMappingFor(parsed) {
  const { service, resourceType: rt } = parsed;
  switch (service) {
    case 'elasticloadbalancing': {
      // ALB/NLB/GWLB are different DR objects and, more practically, `elb` is
      // matched by nothing in the deployment-order rule table (it fell through
      // to the networking category default, eight tiers too early). The ARN
      // already says which one it is: loadbalancer/app|net|gwy/<name>.
      if (rt !== 'loadbalancer') return null;
      const lb = lbKind(parsed.lbType);
      return { category: 'networking', kind: lb.kind, restoreLayer: 'L5', label: lb.label, aws: ['ELB'] };
    }
    case 'rds':
      if (rt !== 'cluster' && rt !== 'db') return null;
      return { category: 'database', kind: rt === 'cluster' ? 'rds-cluster' : 'rds-instance', restoreLayer: 'L3', label: 'RDS', aws: ['RDS'] };
    case 'elasticache':
      if (rt !== 'replicationgroup' && rt !== 'cluster') return null;
      return { category: 'database', kind: 'elasticache', restoreLayer: 'L3', label: 'ElastiCache', aws: ['ElastiCache'] };
    case 'sqs': return { category: 'messaging-streaming', kind: 'sqs', restoreLayer: 'L3', label: 'SQS', aws: ['SQS'] };
    case 'sns': return { category: 'messaging-streaming', kind: 'sns', restoreLayer: 'L3', label: 'SNS', aws: ['SNS'] };
    case 'kinesis':
      return rt === 'stream' ? { category: 'messaging-streaming', kind: 'kinesis', restoreLayer: 'L3', label: 'Kinesis', aws: ['Kinesis'] } : null;
    case 's3': return { category: 'storage', kind: 's3', restoreLayer: 'L3', label: 'S3', aws: ['S3'] };
    case 'lambda':
      return rt === 'function' ? { category: 'compute', kind: 'lambda', restoreLayer: 'L4', label: 'Lambda', aws: ['Lambda'] } : null;
    case 'eks':
      return rt === 'cluster' ? { category: 'compute', kind: 'eks-cluster', restoreLayer: 'L2', label: 'EKS cluster', aws: ['EKS', 'EC2', 'ELB'] } : null;
    case 'ecs':
      if (rt === 'service') return { category: 'compute', kind: 'ecs-service', restoreLayer: 'L4', label: 'ECS service', aws: ['ECS'] };
      if (rt === 'cluster') return { category: 'compute', kind: 'ecs-cluster', restoreLayer: 'L2', label: 'ECS cluster', aws: ['ECS'] };
      return null;
    case 'dynamodb':
      return rt === 'table' ? { category: 'database', kind: 'dynamodb', restoreLayer: 'L3', label: 'DynamoDB', aws: ['DynamoDB'] } : null;
    case 'apigateway':
    case 'execute-api':
      return { category: 'edge-dns', kind: 'api-gateway', restoreLayer: 'L5', label: 'API Gateway', aws: ['API Gateway'] };
    case 'ecr':
      return rt === 'repository' ? { category: 'cicd-control-plane', kind: 'ecr', restoreLayer: 'L4', label: 'ECR', aws: ['ECR'] } : null;
    case 'transfer':
      return rt === 'server' ? { category: 'storage', kind: 'transfer-family', restoreLayer: 'L3', label: 'Transfer Family', aws: ['Transfer Family'] } : null;
    case 'kafka':
      return rt === 'cluster' ? { category: 'messaging-streaming', kind: 'msk', restoreLayer: 'L3', label: 'MSK', aws: ['MSK'] } : null;
    case 'efs':
      return rt === 'file-system' ? { category: 'storage', kind: 'efs', restoreLayer: 'L3', label: 'EFS', aws: ['EFS'] } : null;
    default: return null;
  }
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// enrichByTag({slug, profile, region, tags:[{key,values}], proposeComponents})
//   -> { nodes, edges, matched, proposals?, perComponent, log, errors }
// Back-compat: {tagKey, tagValue} still accepted (converted to the list form).
// Uses the Resource Groups Tagging API (AND across keys, OR within values);
// each found resource becomes a node, linked to the best-matching component
// with a tagged-match edge (unlinked but visible when nothing matches well
// enough). With proposeComponents, component-worthy matches also come back
// as Component-shaped proposals (arn set, deduped against current components
// by arn or name via `existing`).
export async function enrichByTag({ slug, profile = '', region = '', tags, tagKey = '', tagValue = '', proposeComponents = false, authVia = '', envId = '', onLog } = {}) {
  const log = makeLog(onLog); const errors = [];
  const scope = await resolveEnvScope(slug, envId); // throws 404 on unknown id
  if (scope) {
    if (!profile && scope.profile) profile = scope.profile;
    if (!region && scope.region) region = scope.region;
    log.push(`scope: environment ${scope.envName} (${scope.envId}) via ${scope.source}`);
  }
  const g = makeGraphBuilder(region);
  const perComponent = [];
  const empty = { nodes: g.nodes, edges: g.edges, matched: 0, perComponent, log, errors };
  if (scope) empty.scope = { envId: scope.envId, envName: scope.envName, profile: scope.profile, region: scope.region };
  if (proposeComponents) empty.proposals = [];
  let filters;
  try { filters = normalizeTagFilters({ tags, tagKey, tagValue }); }
  catch (e) { errors.push(e.message); return empty; }
  if (!(await awsCliFound())) { errors.push('AWS CLI not found — install awscli and configure a profile'); return empty; }
  if (!region) { errors.push('A region is required (e.g. us-east-1)'); return empty; }
  if (!filters.length) { errors.push('tagKey and tagValue are required (or tags: [{key, values}])'); return empty; }

  const allComponents = store.getCollection(slug, 'components');
  // A tag match is only linked to a component of the scoped environment.
  const components = scope ? allComponents.filter((c) => c.envId === scope.envId) : allComponents;
  const compToks = components.map((c) => ({ id: c.id, toks: componentTokens(c) }));
  const existingArns = new Set(components.map((c) => c.arn).filter(Boolean));
  const existingNames = new Set(components.map((c) => normName(c.name)));
  const run = makeRunner({ region, profile, log, via: await resolveAuthVia(profile, authVia) });
  const perComp = new Map();
  const proposals = [];
  const proposedArns = new Set();
  const filterArgs = filters.map((f) => `Key=${f.key},Values=${f.values.join(',')}`);
  const filterDesc = filters.map((f) => `${f.key}=${f.values.join('|')}`).join(' AND ');
  let matched = 0;

  let token = '';
  for (let page = 0; page < 3; page++) {
    const args = ['resourcegroupstaggingapi', 'get-resources',
      '--tag-filters', ...filterArgs, '--max-items', '100'];
    if (token) args.push('--starting-token', token);
    let res;
    try { res = await run(args); } catch (e) { errors.push(`tagging-api: ${shortErr(e)}`); break; }
    for (const r of res.ResourceTagMappingList || []) {
      const arn = r.ResourceARN || '';
      const rid = ridFromArn(arn);
      if (!rid) continue;
      matched++;
      const tagMap = tagsOf(r.Tags);
      const name = tagMap.Name || rid.split(/[:/]/).pop();
      const node = g.addNode(rid, typeFromArn(arn), serviceFromArn(arn), name, {
        arn, tags: tagMap, source: 'aws-enrich-tag', details: { matchedTag: filterDesc },
      });
      // best matching component by name similarity
      let best = null; let bestScore = 0;
      for (const ct of compToks) {
        const s = Math.max(matchScore(name, ct.toks), matchScore(rid, ct.toks));
        if (s > bestScore) { best = ct.id; bestScore = s; }
      }
      if (best && bestScore >= 4) {
        if (!node.componentIds.includes(best)) node.componentIds.push(best);
        g.addEdge(best, rid, 'tagged-match');
        perComp.set(best, (perComp.get(best) || 0) + 1);
      }
      // component-worthy matches also become Component-shaped proposals
      if (proposeComponents && !proposedArns.has(arn)) {
        const parsed = parseArn(arn);
        const mapping = parsed ? proposalMappingFor(parsed) : null;
        if (mapping) {
          proposedArns.add(arn);
          const bare = tagMap.Name || parsed.name || parsed.id;
          const propName = `${mapping.label} — ${bare}`;
          const tagPairs = Object.entries(tagMap).slice(0, 6).map(([k, v]) => (v ? `${k}:${v}` : k));
          proposals.push({
            name: propName, category: mapping.category, tier: 1, owner: '', team: '',
            description: `Tag-matched ${mapping.label} (${filterDesc}); arn ${arn}`,
            kind: mapping.kind, arn, region: parsed.region || region,
            drStrategy: 'inherit', restoreLayer: mapping.restoreLayer,
            replication: { mechanism: 'unknown', rpoMinutes: null, notes: '' },
            inRecoveryScope: 'unknown', definedIn: '',
            dependsOn: [], outboundCalls: [], awsServices: mapping.aws,
            secrets: [], endpoints: [], verification: { command: '', pass: '' },
            gaps: [], notes: '', tags: ['discovered', 'tag-scan', ...tagPairs],
            existing: existingArns.has(arn) || existingNames.has(normName(propName)) || existingNames.has(normName(bare)),
          });
        }
      }
    }
    token = res.NextToken || '';
    if (!token) break;
  }
  for (const [componentId, nodes] of perComp) perComponent.push({ componentId, found: true, nodes });
  for (const n of Object.values(g.nodes)) n.facts = factsFor(n, g);
  const out = { nodes: g.nodes, edges: g.edges, matched, perComponent, log, errors };
  if (scope) out.scope = { envId: scope.envId, envName: scope.envName, componentCount: components.length, profile: scope.profile, region: scope.region };
  if (proposeComponents) out.proposals = proposals;
  return out;
}

// ---------------------------------------------------------------- additive exports
// For server/lib/aws-scan-map.js (scan&map orchestrator), which drives the
// collector suite against freshly-scanned resources. Additive only — nothing
// above changes.
export {
  COLLECTORS, makeGraphBuilder, makeRunner, deepSecurityGroups, deepSubnets,
  deepRoles, deepVpcs, deepNetworkInterfaces, deepKmsKeys, deepCertificates,
  deepVpcEndpoints,
};
// sgRuleFacts / parseSgRuleFacts / sgPortLabel are exported at their definitions.
