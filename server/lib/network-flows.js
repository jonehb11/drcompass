// Network / firewall flow-log importer.
//
// Takes an already-parsed tabular export (the browser parses the CSV/TSV — the
// raw file never leaves the user's machine, and even the parsed rows only go
// to this local server) and answers the question "which of my pods make
// outbound calls, and to whom?".
//
// Pipeline:
//   detectColumns(headers, sampleRows) -> which column is source/destination/…
//   aggregate(rows, mapping)           -> unique (src, dst, port, proto) flows
//   classifyTarget(dest)               -> aws-service | saas | internal | third-party
//   suggestSources(flows, comps, k8s)  -> which component/workload each source is
//   applyFlows({slug, assignments})    -> writes outboundCalls + resource-graph
//
// Column mapping is expressed as COLUMN INDICES ({source: 0, port: 3, …});
// `null` means "not mapped". resolveMapping() also accepts header names so the
// API can take either shape.
import * as store from '../store.js';
import { mergeGraph } from './aws-enrich.js';

export const FLOW_ROLES = ['source', 'destination', 'port', 'protocol', 'action', 'count'];
export const MAX_FLOWS = 2000;
export const MAX_COLUMNS = 20;
export const MAX_ROWS = 100000;

// ---------------------------------------------------------------- normalizing

const lc = (v) => String(v ?? '').trim().toLowerCase();

// Header -> comparable form: "Destination Port" / "dst_port" -> "destination port".
function normHeader(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
// Free text -> token list, for name matching.
function tokens(v) {
  return String(v ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(v) {
  const m = IPV4_RE.exec(String(v || '').trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
function isIpv6(v) {
  const s = String(v || '').trim();
  return s.includes(':') && /^[0-9a-f:]+$/i.test(s) && (s.match(/:/g) || []).length >= 2;
}
export function isPrivateIp(v) {
  const s = String(v || '').trim();
  if (isIpv6(s)) return /^(::1$|fc|fd|fe80)/i.test(s);
  if (!isIpv4(s)) return false;
  const [a, b] = s.split('.').map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — cluster/NAT ranges
  return false;
}

// Host field -> bare lowercase host. Strips scheme, path, trailing dot and a
// trailing :port (IPv6 literals are left alone unless bracketed).
export function normHost(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');   // scheme
  s = s.split('/')[0].split('?')[0];                // path/query
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s); // [::1]:443
  if (bracket) return bracket[1].toLowerCase();
  if (!isIpv6(s)) {
    const hostPort = /^(.+):(\d{1,5})$/.exec(s);    // host:443 (single colon only)
    if (hostPort && !hostPort[1].includes(':')) s = hostPort[1];
  }
  return s.replace(/\.$/, '').toLowerCase();
}

const PROTO_NUMBERS = { 1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 58: 'icmpv6', 132: 'sctp' };

export function normProtocol(v) {
  const s = lc(v);
  if (!s) return '';
  if (/^\d+$/.test(s)) return PROTO_NUMBERS[Number(s)] || `proto-${s}`;
  const first = s.split(/[\s/]+/)[0];
  return first.replace(/[^a-z0-9+-]/g, '') || '';
}

export function normPort(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

function normCount(v) {
  const s = String(v ?? '').trim().replace(/[,_\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return 1;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function slugifyTarget(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80) || 'target';
}

// ---------------------------------------------------------------- classify

const AWS_SERVICE_LABELS = {
  sqs: 'SQS', sns: 'SNS', s3: 'S3', rds: 'RDS', dynamodb: 'DynamoDB', kinesis: 'Kinesis',
  firehose: 'Firehose', secretsmanager: 'Secrets Manager', ssm: 'SSM', kms: 'KMS',
  ecr: 'ECR', 'ecr-dkr': 'ECR', 'ecr-api': 'ECR', eks: 'EKS', ecs: 'ECS', lambda: 'Lambda',
  logs: 'CloudWatch Logs', monitoring: 'CloudWatch', events: 'EventBridge',
  'elasticloadbalancing': 'ELB', 'execute-api': 'API Gateway', sts: 'STS', athena: 'Athena',
  elasticache: 'ElastiCache', 'cache': 'ElastiCache', es: 'OpenSearch', kafka: 'MSK',
  efs: 'EFS', 'elasticfilesystem': 'EFS', states: 'Step Functions', transfer: 'Transfer',
  glue: 'Glue', sagemaker: 'SageMaker', backup: 'AWS Backup', ec2: 'EC2', autoscaling: 'Auto Scaling',
};
const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]?)?-(north|south|east|west|central|northeast|northwest|southeast|southwest)-\d$/;

// A small, deliberately short SaaS list — anything unknown stays 'third-party',
// which is the safer default for a DR allowlist review.
const SAAS = [
  ['pagerduty.com', 'PagerDuty'], ['datadoghq.com', 'Datadog'], ['datadoghq.eu', 'Datadog'],
  ['datadog.com', 'Datadog'], ['github.com', 'GitHub'], ['githubusercontent.com', 'GitHub'],
  ['slack.com', 'Slack'], ['stripe.com', 'Stripe'], ['twilio.com', 'Twilio'],
  ['sendgrid.net', 'SendGrid'], ['okta.com', 'Okta'], ['auth0.com', 'Auth0'],
  ['atlassian.net', 'Atlassian'], ['newrelic.com', 'New Relic'], ['splunk.com', 'Splunk'],
  ['sumologic.com', 'Sumo Logic'], ['snowflakecomputing.com', 'Snowflake'],
  ['salesforce.com', 'Salesforce'], ['sentry.io', 'Sentry'], ['launchdarkly.com', 'LaunchDarkly'],
  ['segment.com', 'Segment'], ['docker.io', 'Docker Hub'], ['npmjs.org', 'npm'],
  ['cloudflare.com', 'Cloudflare'], ['googleapis.com', 'Google APIs'], ['zoom.us', 'Zoom'],
  ['servicenow.com', 'ServiceNow'], ['elastic-cloud.com', 'Elastic Cloud'],
];

const INTERNAL_SUFFIXES = [
  '.svc', '.svc.cluster.local', '.cluster.local', '.internal', '.local', '.lan',
  '.intranet', '.corp', '.localdomain',
];

function awsLabel(host) {
  const labels = host.split('.');
  const drop = labels.length - (host.endsWith('.amazonaws.com.cn') ? 3 : 2);
  const parts = labels.slice(0, Math.max(0, drop));
  const region = parts.find((p) => REGION_RE.test(p)) || '';
  let service = '';
  for (let i = parts.length - 1; i >= 0; i--) {         // right-to-left: the
    const p = parts[i];                                  // service label sits
    if (AWS_SERVICE_LABELS[p]) { service = p; break; }    // closest to the apex
  }
  if (!service) {
    const ri = parts.indexOf(region);
    service = (ri > 0 ? parts[ri - 1] : parts[parts.length - 1]) || 'AWS';
  }
  const name = AWS_SERVICE_LABELS[service] || service.toUpperCase();
  return region ? `${name} (${region})` : name;
}

// classifyTarget(dest) -> { type, label }
export function classifyTarget(dest) {
  const host = normHost(dest);
  if (!host) return { type: 'third-party', label: '' };

  if (/(^|\.)amazonaws\.com(\.cn)?$/.test(host)) return { type: 'aws-service', label: awsLabel(host) };
  if (/(^|\.)aws\.amazon\.com$/.test(host)) return { type: 'aws-service', label: 'AWS console/API' };

  if (isPrivateIp(host)) return { type: 'internal', label: host };
  if (INTERNAL_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    return { type: 'internal', label: host };
  }
  if (/(^|\.)(ec2|compute)\.internal$/.test(host)) return { type: 'internal', label: host };

  for (const [domain, label] of SAAS) {
    if (host === domain || host.endsWith(`.${domain}`)) return { type: 'saas', label };
  }
  return { type: 'third-party', label: host };
}

// ---------------------------------------------------------------- detection

// role -> [regex, weight] against the normalized header text.
const HEADER_RULES = {
  port: [
    [/^(dst|dest|destination|remote|server|svc|service)[ ]?(port|prt|pt)$/, 10],
    [/^(dport|dstport|dpt|destport|destinationport)$/, 10],
    [/\b(dst|dest|destination)\b.*\bport\b/, 9],
    [/^port$/, 8],
    [/\bport\b/, 5],
  ],
  source: [
    [/^(src|source|saddr|srcaddr|srcip|sourceip|sourceaddr|sourceaddress|from|client|origin)$/, 10],
    [/^src (ip|addr|address|host|name)$/, 10],
    [/^source (ip|addr|address|host|name|workload|pod|app)$/, 10],
    [/^(from|client|origin) (ip|addr|address|host|name)$/, 9],
    [/^(pod|workload|app|reporter|instance)( name)?$/, 6],
    [/\b(src|source|from|client)\b/, 5],
  ],
  destination: [
    [/^(dst|dest|destination|daddr|dstaddr|dstip|destip|destinationip|destaddr|destinationaddress|to|server|remote|target)$/, 10],
    [/^dst (ip|addr|address|host|name)$/, 10],
    [/^(dest|destination) (ip|addr|address|host|name|workload|service|fqdn)$/, 10],
    [/^(to|server|remote|target|upstream|peer) (ip|addr|address|host|name|cluster)$/, 9],
    [/^(fqdn|url|hostname|domain|upstream)$/, 6],
    [/\b(dst|dest|destination|to|upstream|remote)\b/, 5],
  ],
  protocol: [
    [/^(proto|protocol|ipproto|ip protocol|ipprotocol|transport|l4 protocol)$/, 10],
    [/^(protocol|proto) (name|number|id)$/, 9],
    [/\b(proto|protocol)\b/, 5],
  ],
  action: [
    [/^(action|verdict|decision|disposition|result|outcome|policy action)$/, 10],
    [/^(allowed|denied|accept|status|response flags)$/, 7],
    [/\b(action|verdict|disposition)\b/, 5],
  ],
  count: [
    [/^(count|hits|hit count|sessions|session count|flows|repeat count|connections|requests|events)$/, 10],
    [/^(bytes|packets|bytes sent|packets sent|numpackets|numbytes|total bytes)$/, 8],
    [/\b(count|hits|sessions|bytes|packets|requests)\b/, 5],
  ],
};

// Roles that must never sit on a column whose name is about ports.
const HOST_ROLES = new Set(['source', 'destination']);

function columnValues(sampleRows, idx, limit = 200) {
  const out = [];
  for (const row of sampleRows || []) {
    if (!Array.isArray(row)) continue;
    const v = String(row[idx] ?? '').trim();
    if (v) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

const ACTION_WORDS = new Set([
  'allow', 'allowed', 'deny', 'denied', 'accept', 'accepted', 'reject', 'rejected',
  'drop', 'dropped', 'block', 'blocked', 'permit', 'ok', 'pass', 'alert', 'reset-both',
  'reset-client', 'reset-server', 'skipped', 'nodata',
]);

// Fraction-of-values shape probes; each returns 0..1.
function shapes(values) {
  const n = values.length || 1;
  let host = 0, port = 0, int = 0, proto = 0, action = 0;
  for (const raw of values) {
    const v = raw.trim();
    const h = normHost(v);
    if (isIpv4(h) || isIpv6(h) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i.test(h)) host++;
    if (normPort(v) !== null) port++;
    if (/^\d{1,12}$/.test(v.replace(/[,_]/g, ''))) int++;
    const p = lc(v);
    if (['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'gre', 'esp', '6', '17', '1'].includes(p)) proto++;
    if (ACTION_WORDS.has(p)) action++;
  }
  return { host: host / n, port: port / n, int: int / n, proto: proto / n, action: action / n };
}

// detectColumns(headerRow, sampleRows) -> { mapping, confidence, headers, roleConfidence }
// Header-name heuristics first, then value-shape checks as tie-breakers and
// as the only signal when headers are unhelpful ("col1,col2,…").
export function detectColumns(headerRow, sampleRows = []) {
  const headers = (Array.isArray(headerRow) ? headerRow : []).slice(0, MAX_COLUMNS).map((x) => String(x ?? ''));
  const norms = headers.map(normHeader);
  const shapeByCol = headers.map((_, i) => shapes(columnValues(sampleRows, i)));

  const candidates = []; // {role, col, score}
  headers.forEach((_, col) => {
    const name = norms[col];
    const sh = shapeByCol[col];
    const looksPortName = /\bport\b|^dpt$|^spt$/.test(name);
    const isSourcePortName = /\b(src|source|client|from)\b/.test(name) && looksPortName;
    for (const role of FLOW_ROLES) {
      if (HOST_ROLES.has(role) && looksPortName) continue; // "source port" is not the source
      let score = 0;
      for (const [re, w] of HEADER_RULES[role]) {
        if (re.test(name)) { score = Math.max(score, w); break; }
      }
      if (role === 'port' && isSourcePortName) score = Math.min(score, 2); // prefer dst port
      if (score <= 0) continue; // shape alone never claims a role — see the fallbacks below
      // Value-shape evidence, confirming or undercutting the header name.
      if (role === 'source' || role === 'destination') {
        if (sh.host >= 0.6) score += 3; else if (sh.host >= 0.3) score += 1; else if (sh.port >= 0.9) score -= 4;
      }
      if (role === 'port') score += sh.port >= 0.8 ? 3 : -3;
      if (role === 'protocol') score += sh.proto >= 0.6 ? 4 : -1;
      if (role === 'action') score += sh.action >= 0.6 ? 4 : -1;
      if (role === 'count') score += sh.int >= 0.9 ? 2 : -4;
      if (score > 0) candidates.push({ role, col, score });
    }
  });

  // Greedy one-to-one assignment: best (role, column) pair wins, both retire.
  candidates.sort((a, b) => b.score - a.score || a.col - b.col || FLOW_ROLES.indexOf(a.role) - FLOW_ROLES.indexOf(b.role));
  const mapping = { source: null, destination: null, port: null, protocol: null, action: null, count: null };
  const roleScore = {};
  const usedCols = new Set();
  for (const c of candidates) {
    if (mapping[c.role] !== null || usedCols.has(c.col)) continue;
    mapping[c.role] = c.col;
    roleScore[c.role] = c.score;
    usedCols.add(c.col);
  }

  // Shape-only fallbacks for exports whose headers say nothing useful
  // ("col1,col2,…" or a re-exported dump). Only unclaimed columns, and only
  // on strong shape evidence — a header-named column always wins.
  const free = () => headers.map((_, i) => i).filter((i) => !usedCols.has(i));
  const claim = (role, col, score = 2) => { mapping[role] = col; roleScore[role] = score; usedCols.add(col); };
  if (mapping.source === null || mapping.destination === null) {
    const hosty = free().filter((i) => shapeByCol[i].host >= 0.6 && shapeByCol[i].port < 0.9);
    for (const role of ['source', 'destination']) {
      if (mapping[role] === null && hosty.length) claim(role, hosty.shift());
    }
  }
  if (mapping.protocol === null) {
    const c = free().find((i) => shapeByCol[i].proto >= 0.8);
    if (c !== undefined) claim('protocol', c);
  }
  if (mapping.action === null) {
    const c = free().find((i) => shapeByCol[i].action >= 0.8);
    if (c !== undefined) claim('action', c);
  }
  // A port fallback only when no header mentioned a port at all — otherwise a
  // column of small integers (packets, bytes) would masquerade as the port.
  if (mapping.port === null && !norms.some((n) => /\bport\b|^dpt$/.test(n))) {
    const c = free().find((i) => shapeByCol[i].port >= 0.95);
    if (c !== undefined) claim('port', c);
  }

  const roleConfidence = {};
  for (const role of FLOW_ROLES) {
    roleConfidence[role] = mapping[role] === null ? 0 : Math.min(1, (roleScore[role] || 0) / 13);
  }
  // Overall confidence weights the fields the aggregation actually needs.
  const weights = { source: 0.35, destination: 0.35, port: 0.2, protocol: 0.1 };
  let confidence = 0;
  for (const [role, w] of Object.entries(weights)) confidence += w * roleConfidence[role];
  return { mapping, confidence: Math.round(confidence * 100) / 100, headers, roleConfidence };
}

// Accepts {source: 0} or {source: 'Source address'}; returns index-or-null.
export function resolveMapping(mapping, headers = []) {
  const norms = (headers || []).map(normHeader);
  const out = { source: null, destination: null, port: null, protocol: null, action: null, count: null };
  for (const role of FLOW_ROLES) {
    const v = mapping ? mapping[role] : null;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < headers.length) { out[role] = v; continue; }
    const s = String(v);
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 0 && n < headers.length) out[role] = n;
      continue;
    }
    const i = norms.indexOf(normHeader(s));
    if (i >= 0) out[role] = i;
  }
  return out;
}

// ---------------------------------------------------------------- aggregate

// aggregate(rows, mapping, {maxRows}) ->
//   { flows, truncated, totalFlows, rowsRead, rowsSkipped, totalCount }
// flows: [{source, destination, port, protocol, count, sampleActions, destType, destLabel}]
// deduped on (source, destination, port, protocol), counts summed, count desc,
// capped at MAX_FLOWS (truncated=true says the tail was dropped).
export function aggregate(rows, mapping, { maxRows = MAX_ROWS, maxFlows = MAX_FLOWS } = {}) {
  const m = mapping || {};
  const all = Array.isArray(rows) ? rows : [];
  const limit = Math.min(all.length, maxRows);
  const byKey = new Map();
  let rowsSkipped = 0;
  let totalCount = 0;

  for (let i = 0; i < limit; i++) {
    const row = all[i];
    if (!Array.isArray(row)) { rowsSkipped++; continue; }
    const source = m.source === null || m.source === undefined ? '' : normHost(row[m.source]);
    const destination = m.destination === null || m.destination === undefined ? '' : normHost(row[m.destination]);
    if (!source || !destination) { rowsSkipped++; continue; }
    const port = m.port === null || m.port === undefined ? null : normPort(row[m.port]);
    const protocol = m.protocol === null || m.protocol === undefined ? '' : normProtocol(row[m.protocol]);
    const count = m.count === null || m.count === undefined ? 1 : normCount(row[m.count]);
    const action = m.action === null || m.action === undefined ? '' : lc(row[m.action]);

    const key = `${source}|${destination}|${port ?? ''}|${protocol}`;
    let f = byKey.get(key);
    if (!f) {
      const cls = classifyTarget(destination);
      f = {
        source, destination, port, protocol, count: 0, sampleActions: [],
        destType: cls.type, destLabel: cls.label,
      };
      byKey.set(key, f);
    }
    f.count += count;
    totalCount += count;
    if (action && f.sampleActions.length < 4 && !f.sampleActions.includes(action)) f.sampleActions.push(action);
  }

  const sorted = [...byKey.values()].sort((a, b) =>
    b.count - a.count
    || a.source.localeCompare(b.source)
    || a.destination.localeCompare(b.destination)
    || (a.port || 0) - (b.port || 0));
  const totalFlows = sorted.length;
  const flows = sorted.slice(0, maxFlows);
  return {
    flows,
    truncated: totalFlows > flows.length || all.length > limit,
    totalFlows,
    rowsRead: limit,
    rowsSkipped,
    rowsDropped: Math.max(0, all.length - limit),
    totalCount,
  };
}

// ---------------------------------------------------------------- suggest

// Pod/ReplicaSet suffixes: two trailing hash-ish segments at most. A segment
// only counts as a hash when it mixes digits with letters (or is long hex), so
// real names like "pharmacy-service" or "claims-api" survive intact.
const HASHY = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{5,10}$|^[0-9a-f]{8,10}$/;

export function stripPodHash(name) {
  let parts = String(name || '').split('-').filter(Boolean);
  for (let i = 0; i < 2 && parts.length > 1; i++) {
    const last = parts[parts.length - 1];
    if (!HASHY.test(last)) break;
    parts = parts.slice(0, -1);
  }
  return parts.join('-');
}

// Turn a source field into candidate names: a bare pod name, a k8s DNS name
// (svc.ns.svc.cluster.local), or an istio-style "ns/workload".
function sourceNames(source) {
  const host = normHost(source);
  if (!host || isIpv4(host) || isIpv6(host)) return { names: [], namespace: '', isIp: true };
  if (host.includes('/')) {
    const [ns, wl] = host.split('/');
    return { names: [stripPodHash(wl), wl].filter(Boolean), namespace: ns, isIp: false };
  }
  const labels = host.split('.');
  const dns = labels.length > 1 && /\b(svc|cluster|local|internal)\b/.test(host);
  const name = labels[0];
  const namespace = dns && labels.length > 1 ? labels[1] : '';
  const names = [...new Set([stripPodHash(name), name, stripPodHash(host), host].filter(Boolean))];
  return { names, namespace, isIp: false };
}

// Role words carry no identity: "pricing-svc", "pricing-service" and
// "pricing-deploy" are the same thing, while "billing-service" is not
// "pharmacy-service" just because both end in "service".
const GENERIC_TOKENS = new Set([
  'service', 'services', 'svc', 'srv', 'api', 'apis', 'deploy', 'deployment',
  'app', 'apps', 'server', 'web', 'cluster', 'prod', 'production', 'sts',
  'statefulset', 'daemonset', 'rs', 'pod', 'workload', 'main', 'primary',
]);
function coreTokens(v) {
  const all = tokens(v);
  const core = all.filter((t) => !GENERIC_TOKENS.has(t));
  return core.length ? core : all; // a name that is ALL role words keeps them
}

// Name similarity 0..1 on the identity-bearing tokens, with a containment
// boost: "adjudication-deploy" ~ component "adjudication-service" -> 0.9.
function nameScore(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.length || !B.length) return 0;
  if (A.join('-') === B.join('-')) return 1;
  const ca = coreTokens(a); const cb = coreTokens(b);
  if (ca.join('-') === cb.join('-')) return 0.9;
  const sa = new Set(ca); const sb = new Set(cb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  if (!inter) return 0; // no shared identity token — not a match at any score
  const union = new Set([...sa, ...sb]).size;
  let score = inter / union;
  const ja = ca.join(''); const jb = cb.join('');
  if (ja.includes(jb) || jb.includes(ja)) score = Math.max(score, 0.8);
  return Math.round(score * 100) / 100;
}

// 'adjudication-service/Deployment/adjudication-deploy' -> 'adjudication-service/adjudication-deploy'
export function workloadLabel(uid) {
  const parts = String(uid || '').split('/').filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}/${parts[parts.length - 1]}`;
  return parts.join('/');
}

// suggestSources(flows, components, k8sSnapshot) ->
//   [{source, flowCount, componentId, componentName, workloadUid, workload,
//     confidence, why}]
// `workload` is the '<namespace>/<name>' form carried onto written calls.
export function suggestSources(flows, components = [], k8sSnapshot = null) {
  const comps = Array.isArray(components) ? components : [];
  const byId = new Map(comps.map((c) => [c.id, c]));
  const workloads = Array.isArray(k8sSnapshot?.workloads) ? k8sSnapshot.workloads : [];

  const counts = new Map();
  for (const f of Array.isArray(flows) ? flows : []) {
    if (!f || !f.source) continue;
    counts.set(f.source, (counts.get(f.source) || 0) + 1);
  }

  const out = [];
  for (const [source, flowCount] of counts) {
    const { names, namespace, isIp } = sourceNames(source);
    const base = {
      source, flowCount, componentId: null, componentName: '', workloadUid: null,
      workload: '', confidence: 0, why: '',
    };
    if (isIp) {
      out.push({
        ...base,
        why: isPrivateIp(source)
          ? 'private IP with no name — pick the component manually'
          : 'IP address with no name — pick the component manually',
      });
      continue;
    }

    let best = null;
    const consider = (cand) => { if (!best || cand.confidence > best.confidence) best = cand; };

    // 1) k8s workloads (name, then namespace) — these carry a componentId.
    for (const w of workloads) {
      if (!w || !w.name) continue;
      for (const n of names) {
        const s = nameScore(n, w.name);
        if (s >= 0.5) {
          consider({
            componentId: w.componentId || null, workloadUid: w.uid || null,
            confidence: Math.min(0.97, s * (namespace && w.namespace === namespace ? 1 : 0.95)),
            why: `k8s workload ${w.namespace || '?'}/${w.name}${s === 1 ? '' : ' (fuzzy name match)'}`,
          });
        }
      }
      if (namespace && w.namespace === namespace) {
        consider({
          componentId: w.componentId || null, workloadUid: w.uid || null,
          confidence: 0.7,
          why: `k8s namespace ${w.namespace} (service DNS name)`,
        });
      }
    }
    // 2) k8s namespace name matching a component (no workload match needed).
    if (!best || best.confidence < 0.9) {
      for (const n of [...names, namespace].filter(Boolean)) {
        for (const c of comps) {
          const s = nameScore(n, c.name);
          if (s >= 0.5) {
            consider({
              componentId: c.id, workloadUid: null, confidence: Math.min(0.95, s * 0.95),
              why: s === 1 ? `component name "${c.name}"` : `component "${c.name}" (fuzzy name match)`,
            });
          }
        }
      }
    }

    if (!best || !best.componentId) {
      out.push({ ...base, why: best?.why ? `${best.why} — no linked component` : 'no confident match — pick the component manually' });
      continue;
    }
    out.push({
      ...base,
      componentId: best.componentId,
      componentName: byId.get(best.componentId)?.name || '',
      workloadUid: best.workloadUid,
      workload: workloadLabel(best.workloadUid),
      confidence: Math.round(best.confidence * 100) / 100,
      why: best.why,
    });
  }
  out.sort((a, b) => b.flowCount - a.flowCount || a.source.localeCompare(b.source));
  return out;
}

// ---------------------------------------------------------------- apply

const OUTBOUND_TYPES = new Set(['aws-service', 'third-party', 'saas', 'internal', 'on-prem']);
const DEFAULT_PURPOSE = 'observed in network flows';

// Schema has `protocol` only, so the port rides along as 'tcp/443'.
function protocolField(protocol, port) {
  const p = normProtocol(protocol) || (port === 443 ? 'tcp' : '');
  const n = normPort(port);
  if (p && n) return p.includes('/') ? p : `${p}/${n}`;
  if (p) return p;
  return n ? String(n) : '';
}

// applyFlows({slug, assignments}) -> {componentsUpdated, callsAdded, graphNodesAdded, …}
// assignments: [{componentId, target, type, protocol, port, purpose, critical,
//                observedCount?, workload?}]
// Writes each assignment onto its component's outboundCalls (deduped on
// target + port + protocol) and, for non-internal targets, merges a
// `net_<slug>` node + a `uses` edge into the resource graph.
//
// Each written call carries additive provenance fields the Excel "Egress /
// Outbound Calls" sheet reads: source:'network-flows', observedCount, workload
// ('<namespace>/<name>' when the source matched a k8s workload) and a numeric
// `port` alongside the 'tcp/443'-style protocol. Re-applying the same flow
// never appends a second entry — it raises observedCount to the larger value.
// (firstSeen/lastSeen are deliberately absent: flow exports feeding this path
// are aggregated counts, with no timestamp column in the mapping contract.)
export function applyFlows({ slug, assignments = [] } = {}) {
  const items = store.getCollection(slug, 'components');
  const byId = new Map(items.map((c) => [c.id, c]));
  const list = Array.isArray(assignments) ? assignments : [];

  const touched = new Set();
  let callsAdded = 0;
  let skipped = 0;
  const additions = { nodes: {}, edges: [] };
  const edgeSeen = new Set();
  const now = new Date().toISOString();

  for (const a of list) {
    const cmp = byId.get(String(a?.componentId || ''));
    const target = String(a?.target || '').trim();
    if (!cmp || !target) { skipped++; continue; }

    const type = OUTBOUND_TYPES.has(String(a.type)) ? String(a.type) : 'third-party';
    const port = normPort(a.port);
    const proto = protocolField(a.protocol, a.port);
    const purpose = String(a.purpose || '').trim() || DEFAULT_PURPOSE;
    const critical = a.critical === true;
    const observed = Number(a.observedCount) > 0 ? Math.floor(Number(a.observedCount)) : 1;
    const workload = String(a.workload || '').trim().slice(0, 200);

    if (!Array.isArray(cmp.outboundCalls)) cmp.outboundCalls = [];
    const callKey = (c) => [
      String(c?.target || '').toLowerCase(),
      normPort(c?.port) ?? '',
      String(c?.protocol || '').toLowerCase(),
    ].join('|');
    const key = `${target.toLowerCase()}|${port ?? ''}|${proto.toLowerCase()}`;
    const existing = cmp.outboundCalls.find((c) => callKey(c) === key);
    if (existing) {
      // Re-apply: never a second row — raise the observed count instead.
      const prev = Number(existing.observedCount) > 0 ? Math.floor(Number(existing.observedCount)) : 0;
      if (observed > prev) {
        existing.observedCount = observed;
        if (workload && !existing.workload) existing.workload = workload;
        cmp.updatedAt = now;
        touched.add(cmp.id);
      }
    } else {
      const call = {
        target, type, protocol: proto, purpose,
        failoverBehavior: '', critical,
        // additive provenance (read defensively by the Excel egress sheet)
        source: 'network-flows', observedCount: observed, port: port ?? null,
      };
      if (workload) call.workload = workload;
      cmp.outboundCalls.push(call);
      callsAdded++;
      cmp.updatedAt = now;
      touched.add(cmp.id);
    }

    // Graph: external targets become nodes; internal chatter stays as an
    // outbound call only (the UI says so too).
    if (type === 'internal') continue;
    const rid = `net_${slugifyTarget(target)}`;
    let node = additions.nodes[rid];
    if (!node) {
      node = additions.nodes[rid] = {
        rid, type: 'other', service: '', name: target, arn: '', region: '',
        componentIds: [], details: { port: normPort(a.port) || null, protocol: proto, observedCount: 0 },
        tags: {}, source: 'network-import',
      };
    }
    if (!node.componentIds.includes(cmp.id)) node.componentIds.push(cmp.id);
    node.details.observedCount += observed;
    const ek = `${cmp.id}|${rid}|uses`;
    if (!edgeSeen.has(ek)) {
      edgeSeen.add(ek);
      additions.edges.push({ from: cmp.id, to: rid, relation: 'uses' });
    }
  }

  if (touched.size) store.saveCollection(slug, 'components', items);

  let graphNodesAdded = 0; let graphEdgesAdded = 0;
  if (Object.keys(additions.nodes).length || additions.edges.length) {
    const existing = store.getObject(slug, 'resource-graph') || {};
    const { graph, stats } = mergeGraph(existing, additions);
    store.saveObject(slug, 'resource-graph', graph);
    graphNodesAdded = stats.addedNodes;
    graphEdgesAdded = stats.addedEdges;
  }

  return {
    componentsUpdated: touched.size,
    callsAdded,
    graphNodesAdded,
    graphEdgesAdded,
    skipped,
  };
}
