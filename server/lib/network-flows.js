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
//
// TWO RULES THIS FILE EXISTS TO KEEP (both were broken; see docs/JOURNEY-REPORT.md
// problems 1 and 2, and docs/measured-numbers.md for why they matter):
//
//   1. A BYTE OR PACKET COLUMN IS NEVER AN OBSERVATION COUNT. `bytes` used to
//      score for the `count` role, so 229,110,441 bytes of traffic was written
//      into the inventory as "observed in network flows (229110441×)" and
//      travelled into the workbook under a header asserting that flows prove
//      what declarations do not. Traffic volume now has its own role (`volume`,
//      with a unit), and a column whose header says bytes/packets is REFUSED
//      the count role even when a human maps it there by hand. What is left in
//      `count` is always a real observation count: either a genuine count/hits
//      column, or the number of flow RECORDS that were aggregated.
//   2. A NAMED COLUMN BEATS A RAW-IP COLUMN, and a contested role is never
//      reported as certain. `srcname`/`dstname` now score above `src`/`dst`, the
//      runner-up column is kept (as an alias, so the IP behind a name and the
//      name behind an IP are both still available), and any role whose runner-up
//      was plausible is marked contested — which caps the confidence the UI
//      reads, which is what opens the "fix a column we got wrong" disclosure.
//
// Mapping objects carry a non-role `meta` key ({countUnit, volumeUnit,
// countRefused, alternatives, contested, sourceAliasCol, destinationAliasCol}).
// It rides on the mapping so it survives the route, which echoes `mapping`
// verbatim to the browser and hands the same object to aggregate().
import * as store from '../store.js';
import { mergeGraph } from './aws-enrich.js';

export const FLOW_ROLES = ['source', 'destination', 'port', 'protocol', 'action', 'count', 'volume'];
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

// Volume cells are additive but may legitimately be 0 (a denied flow moves no
// bytes), so unlike normCount() this returns 0 rather than 1 for "no number".
function normVolume(v) {
  const s = String(v ?? '').trim().replace(/[,_\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return 0;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------- units
//
// The one question that decides whether a number may be called an observation
// count: does this column's HEADER say it holds traffic volume?

const BYTES_HEADER_RE = /\b(bytes?|octets?|kbytes?|mbytes?|gbytes?|kb|mb|gb|kib|mib|gib)\b|^(numbytes|bytecount|totalbytes|bytestotal)$/;
const PACKETS_HEADER_RE = /\b(packets?|pkts?|pkt|datagrams?|frames?)\b|^(numpackets|packetcount|totalpackets)$/;

// unitOfHeader('Total Bytes') -> 'bytes' · 'packets sent' -> 'packets' · else ''
export function unitOfHeader(header) {
  const n = normHeader(header).replace(/ /g, ' ');
  const squashed = normHeader(header).replace(/ /g, '');
  if (BYTES_HEADER_RE.test(n) || BYTES_HEADER_RE.test(squashed)) return 'bytes';
  if (PACKETS_HEADER_RE.test(n) || PACKETS_HEADER_RE.test(squashed)) return 'packets';
  return '';
}

// 229110441 -> '229 MB'. Decimal units, because that is what a firewall export
// and every network bill mean by MB.
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return `${Math.round(v)} B`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let x = v / 1000;
  let i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} ${units[i]}`;
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// observationLabel(obs) -> the honest phrase for what was actually observed.
// `countBasis` says what `count` IS: 'count-column' (a real hits/sessions
// column) or 'records' (the number of flow rows that aggregated into this
// flow). Volume, when present, is reported as volume — never as a count.
export function observationLabel({ count, countBasis, bytes, packets } = {}) {
  const parts = [];
  const n = Number(count);
  if (Number.isFinite(n) && n > 0) {
    parts.push(countBasis === 'count-column' ? `${n.toLocaleString('en-US')}×` : plural(n, 'flow record'));
  }
  const b = Number(bytes);
  if (Number.isFinite(b) && b > 0) parts.push(`${formatBytes(b)} of traffic`);
  const p = Number(packets);
  if (Number.isFinite(p) && p > 0) parts.push(plural(p, 'packet'));
  return parts.join(', ');
}

export const DEFAULT_PURPOSE = 'observed in network flows';

// The ONE purpose string. The browser sends what this produced during
// analyze(); applyFlows() rebuilds the identical sentence for any caller that
// sends none, so the client and the server can no longer word it differently.
export function flowPurpose(obs) {
  const label = observationLabel(obs || {});
  return label ? `${DEFAULT_PURPOSE} (${label})` : DEFAULT_PURPOSE;
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
  // Named source/destination columns score ABOVE their raw-IP twins: a partner
  // allowlist can be written for "api.stripe.com" and cannot be written for
  // "34.196.7.12". The glued spellings (srcname, dsthost) are listed explicitly
  // because normHeader() does not split them into words.
  source: [
    [/^(srcname|sourcename|srchost|sourcehost|srcworkload|sourceworkload|srcpod|sourcepod|srcapp|sourceapp|srcfqdn|sourcefqdn)$/, 11],
    [/^(src|source|from|client|origin) (name|host|hostname|workload|pod|app|fqdn|service)$/, 11],
    [/^(src|source|saddr|srcaddr|srcip|sourceip|sourceaddr|sourceaddress|from|client|origin)$/, 10],
    [/^src (ip|addr|address)$/, 10],
    [/^source (ip|addr|address)$/, 10],
    [/^(from|client|origin) (ip|addr|address)$/, 9],
    [/^(pod|workload|app|reporter|instance)( name)?$/, 6],
    [/\b(src|source|from|client)\b/, 5],
  ],
  destination: [
    [/^(dstname|destname|destinationname|dsthost|desthost|destinationhost|dstfqdn|destfqdn|dstservice|destservice|dstworkload|destworkload)$/, 11],
    [/^(dst|dest|destination|to|server|remote|target|upstream|peer) (name|host|hostname|fqdn|workload|service|domain)$/, 11],
    [/^(dst|dest|destination|daddr|dstaddr|dstip|destip|destinationip|destaddr|destinationaddress|to|server|remote|target)$/, 10],
    [/^dst (ip|addr|address)$/, 10],
    [/^(dest|destination) (ip|addr|address)$/, 10],
    [/^(to|server|remote|target|upstream|peer) (ip|addr|address|cluster)$/, 9],
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
  // `count` is an OBSERVATION count and nothing else. Byte and packet columns
  // are deliberately absent — they belong to `volume` below, and any column
  // whose header names a unit is refused this role outright (see refuseVolume).
  count: [
    [/^(count|hits|hit count|sessions|session count|flows|flow count|repeat count|repeats|connections|connection count|requests|request count|events|event count|occurrences|samples|conn count)$/, 10],
    [/^(num|number of|no of|n) (flows|sessions|connections|requests|events|hits|records)$/, 9],
    [/\b(count|hits|sessions|connections|requests|events)\b/, 5],
  ],
  // Traffic volume. Separate role, separate word, never a multiplier.
  volume: [
    [/^(bytes|packets|octets|bytes sent|bytes in|bytes out|bytes total|total bytes|packets sent|packets in|packets out|total packets|numpackets|numbytes|byte count|packet count|tx bytes|rx bytes|kilobytes|megabytes)$/, 10],
    [/\b(bytes?|octets?|packets?|pkts?)\b/, 7],
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

// A bare workload name: "auth-api", "settlement-worker", "ns/workload" — no
// dot required, which is exactly why the old `host` probe scored a srcname
// column at 0 and let the raw-IP column win.
const BARE_NAME_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9_.-]*[a-z0-9])?)?$/i;

// Fraction-of-values shape probes; each returns 0..1.
// `host` = addressable (IP or dotted name) · `ip` = raw address ·
// `name` = something with a name in it (dotted or bare) that is NOT an address.
function shapes(values) {
  const n = values.length || 1;
  let host = 0, port = 0, int = 0, proto = 0, action = 0, ip = 0, name = 0;
  for (const raw of values) {
    const v = raw.trim();
    const h = normHost(v);
    const isAddr = isIpv4(h) || isIpv6(h);
    const dotted = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i.test(h);
    if (isAddr || dotted) host++;
    if (isAddr) ip++;
    else if ((dotted || BARE_NAME_RE.test(h)) && /[a-z]/i.test(h) && h.length > 1 && !ACTION_WORDS.has(lc(h))) name++;
    if (normPort(v) !== null) port++;
    if (/^\d{1,12}$/.test(v.replace(/[,_]/g, ''))) int++;
    const p = lc(v);
    if (['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'gre', 'esp', '6', '17', '1'].includes(p)) proto++;
    if (ACTION_WORDS.has(p)) action++;
  }
  return {
    host: host / n, port: port / n, int: int / n, proto: proto / n,
    action: action / n, ip: ip / n, name: name / n,
  };
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
        const hostish = Math.max(sh.host, sh.name);
        if (hostish >= 0.6) score += 3; else if (hostish >= 0.3) score += 1; else if (sh.port >= 0.9) score -= 4;
        // A column of names is worth more than a column of addresses: a name
        // survives a failover and an allowlist can be written against it.
        if (sh.name >= 0.6) score += 2;
      }
      if (role === 'port') score += sh.port >= 0.8 ? 3 : -3;
      if (role === 'protocol') score += sh.proto >= 0.6 ? 4 : -1;
      if (role === 'action') score += sh.action >= 0.6 ? 4 : -1;
      if (role === 'count') score += sh.int >= 0.9 ? 2 : -4;
      if (role === 'volume') {
        score += sh.int >= 0.9 ? 2 : -4;
        if (unitOfHeader(headers[col]) === 'bytes') score += 1; // bytes over packets when both exist
      }
      if (score > 0) candidates.push({ role, col, score });
    }
  });

  // Greedy one-to-one assignment: best (role, column) pair wins, both retire.
  candidates.sort((a, b) => b.score - a.score || a.col - b.col || FLOW_ROLES.indexOf(a.role) - FLOW_ROLES.indexOf(b.role));
  const mapping = {
    source: null, destination: null, port: null, protocol: null,
    action: null, count: null, volume: null,
  };
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
    const hosty = free().filter((i) => {
      const s = shapeByCol[i];
      return Math.max(s.host, s.name) >= 0.6 && s.port < 0.9 && s.proto < 0.5 && s.action < 0.5;
    });
    // A headerless export that carries BOTH addresses and names uses the names
    // for both roles — but only when there are two of them, so the src/dst
    // order that column position implies is never scrambled.
    const named = hosty.filter((i) => shapeByCol[i].name >= 0.6);
    const pick = named.length >= 2 ? named : hosty;
    for (const role of ['source', 'destination']) {
      if (mapping[role] === null && pick.length) claim(role, pick.shift());
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

  // ---- what we rejected, and how sure we are allowed to sound about it
  //
  // A role is CONTESTED when a second column was a plausible candidate for it
  // (score within 3 of the winner, or 8+ on its own). Two host-shaped columns
  // tying and the lower index winning is forgivable; calling that 100%
  // confident is the bug — it is what keeps the "fix a column we got wrong"
  // disclosure shut on an import that got the column wrong.
  const alternatives = {};
  const contested = [];
  for (const role of FLOW_ROLES) {
    if (mapping[role] === null) continue;
    const win = roleScore[role] || 0;
    const rivals = candidates
      .filter((c) => c.role === role && c.col !== mapping[role])
      .sort((a, b) => b.score - a.score || a.col - b.col);
    const seen = new Set();
    const list = [];
    for (const c of rivals) {
      if (seen.has(c.col)) continue;
      seen.add(c.col);
      // A column already doing another job is not an alternative for this one.
      const takenBy = FLOW_ROLES.find((r) => r !== role && mapping[r] === c.col) || null;
      if (takenBy) continue;
      if (c.score >= 8 || c.score >= win - 3) {
        list.push({ col: c.col, header: headers[c.col], score: c.score, takenBy: null });
      }
    }
    if (list.length) {
      alternatives[role] = list;
      contested.push(role);
    }
  }

  const roleConfidence = {};
  for (const role of FLOW_ROLES) {
    let rc = mapping[role] === null ? 0 : Math.min(1, (roleScore[role] || 0) / 13);
    if (contested.includes(role)) rc = Math.min(rc, 0.55); // a coin-toss is not a certainty
    roleConfidence[role] = rc;
  }
  // Overall confidence weights the fields the aggregation actually needs.
  const weights = { source: 0.35, destination: 0.35, port: 0.2, protocol: 0.1 };
  let confidence = 0;
  for (const [role, w] of Object.entries(weights)) confidence += w * roleConfidence[role];
  // One contested field the aggregation depends on is enough to say "look at
  // this" — the UI opens its mapping editor below 0.6.
  if (contested.some((r) => r in weights)) confidence = Math.min(confidence, 0.55);

  annotateMapping(mapping, headers, { alternatives, contested, shapeByCol });
  return {
    mapping,
    confidence: Math.round(confidence * 100) / 100,
    headers,
    roleConfidence,
    alternatives,
    contested,
  };
}

// Non-role metadata that travels WITH the mapping (the route echoes `mapping`
// to the browser and hands the same object to aggregate(), so this is the one
// channel that reaches both without every caller having to be taught a new
// field). Idempotent: safe to call on a mapping that already carries a meta.
function annotateMapping(mapping, headers = [], { alternatives = {}, contested = [], shapeByCol = null, aliases = {} } = {}) {
  const hdr = (i) => (i === null || i === undefined ? '' : String(headers[i] ?? ''));
  const meta = {
    countUnit: '', volumeUnit: '', countRefused: null,
    alternatives, contested,
    sourceAliasCol: null, destinationAliasCol: null,
  };

  // RULE 1, enforced last and unconditionally: a column whose header says
  // bytes or packets can never hold an observation count, however it got here
  // — detection, an API caller, or a human picking it in the mapping editor.
  const countUnit = unitOfHeader(hdr(mapping.count));
  if (mapping.count !== null && mapping.count !== undefined && countUnit) {
    meta.countRefused = {
      col: mapping.count,
      header: hdr(mapping.count),
      unit: countUnit,
      why: `"${hdr(mapping.count)}" holds ${countUnit}, which is traffic volume, not a number of observations — `
        + `it is recorded as ${countUnit} and the observation count comes from the flow records themselves`,
    };
    if (mapping.volume === null || mapping.volume === undefined) mapping.volume = mapping.count;
    mapping.count = null;
  }
  meta.countUnit = mapping.count === null || mapping.count === undefined ? '' : 'count';
  if (mapping.volume !== null && mapping.volume !== undefined) {
    meta.volumeUnit = unitOfHeader(hdr(mapping.volume)) || 'unknown';
  }

  // The runner-up for a host role is kept as an ALIAS, not thrown away: it is
  // the IP behind a name (or the name behind an IP), and suggestSources() uses
  // both when it tries to work out which component a source is.
  for (const role of ['source', 'destination']) {
    if (mapping[role] === null || mapping[role] === undefined) continue;
    const alts = alternatives[role] || [];
    const usable = alts.find((a) => a.col !== mapping[role] && !a.takenBy);
    if (aliases[role] !== undefined && aliases[role] !== null && aliases[role] !== mapping[role]) {
      meta[`${role}AliasCol`] = aliases[role];
    } else if (usable) meta[`${role}AliasCol`] = usable.col;
    else if (shapeByCol) {
      // No scored rival, but an unclaimed host/name column may still be one.
      const used = new Set(FLOW_ROLES.map((r) => mapping[r]).filter((v) => v !== null && v !== undefined));
      const cand = headers.map((_, i) => i).find((i) => !used.has(i)
        && shapeByCol[i] && Math.max(shapeByCol[i].host, shapeByCol[i].name) >= 0.6
        && shapeByCol[i].port < 0.9 && shapeByCol[i].proto < 0.5 && shapeByCol[i].action < 0.5
        // only pair a name with an address and vice versa
        && (shapeByCol[i].name >= 0.6) !== (shapeByCol[mapping[role]]?.name >= 0.6)
        && new RegExp(role === 'source' ? '\\b(src|source|from|client)' : '\\b(dst|dest|destination|to|remote|target)')
          .test(normHeader(hdr(i))));
      if (cand !== undefined) meta[`${role}AliasCol`] = cand;
    }
  }

  mapping.meta = meta;
  return mapping;
}

// Accepts {source: 0} or {source: 'Source address'}; returns index-or-null.
// The result carries the same `meta` a detected mapping does — including the
// byte/packet refusal, so a hand-picked "Count / hits = bytes" is corrected
// here too rather than being taken at its word.
export function resolveMapping(mapping, headers = []) {
  const norms = (headers || []).map(normHeader);
  const out = { source: null, destination: null, port: null, protocol: null, action: null, count: null, volume: null };
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
  // A manual mapping has no scoring behind it, so there are no alternatives to
  // report — but the unit refusal and the alias pairing still apply.
  const aliases = {};
  for (const role of ['source', 'destination']) {
    if (out[role] === null) continue;
    const other = role === 'source' ? /\b(src|source|from|client)/ : /\b(dst|dest|destination|to|remote|target)/;
    const used = new Set(FLOW_ROLES.map((r) => out[r]).filter((v) => v !== null));
    const cand = norms.findIndex((n, i) => !used.has(i) && other.test(n));
    if (cand >= 0) aliases[role] = cand;
  }
  return annotateMapping(out, headers, { alternatives: {}, contested: [], aliases });
}

// ---------------------------------------------------------------- aggregate

// aggregate(rows, mapping, {maxRows}) ->
//   { flows, truncated, totalFlows, rowsRead, rowsSkipped, totalCount,
//     totalBytes, totalPackets, countBasis }
// flows: [{source, destination, port, protocol, count, countBasis, records,
//          bytes, packets, sourceAlias, destinationAlias, sampleActions,
//          destType, destLabel, observedLabel, purpose}]
// deduped on (source, destination, port, protocol), counts summed, count desc,
// capped at MAX_FLOWS (truncated=true says the tail was dropped).
//
// `count` is an observation count and only ever an observation count:
//   countBasis 'count-column' — summed from a real count/hits/sessions column
//   countBasis 'records'      — the number of flow rows that landed on this flow
// Traffic volume is reported separately as `bytes` / `packets`, and each flow
// carries the sentence the UI and the store both use for it (`purpose`), so the
// client and the server can never disagree about what a flow said.
export function aggregate(rows, mapping, { maxRows = MAX_ROWS, maxFlows = MAX_FLOWS } = {}) {
  const m = mapping || {};
  const meta = m.meta || {};
  const all = Array.isArray(rows) ? rows : [];
  const limit = Math.min(all.length, maxRows);
  const byKey = new Map();
  let rowsSkipped = 0;
  let totalCount = 0;
  let totalBytes = 0;
  let totalPackets = 0;

  const has = (v) => v !== null && v !== undefined;
  const countBasis = has(m.count) ? 'count-column' : 'records';
  const volumeUnit = has(m.volume) ? (meta.volumeUnit || 'unknown') : '';
  const srcAlias = meta.sourceAliasCol;
  const dstAlias = meta.destinationAliasCol;

  for (let i = 0; i < limit; i++) {
    const row = all[i];
    if (!Array.isArray(row)) { rowsSkipped++; continue; }
    const source = has(m.source) ? normHost(row[m.source]) : '';
    const destination = has(m.destination) ? normHost(row[m.destination]) : '';
    if (!source || !destination) { rowsSkipped++; continue; }
    const port = has(m.port) ? normPort(row[m.port]) : null;
    const protocol = has(m.protocol) ? normProtocol(row[m.protocol]) : '';
    const count = has(m.count) ? normCount(row[m.count]) : 1;
    const volume = has(m.volume) ? normVolume(row[m.volume]) : 0;
    const action = has(m.action) ? lc(row[m.action]) : '';

    const key = `${source}|${destination}|${port ?? ''}|${protocol}`;
    let f = byKey.get(key);
    if (!f) {
      const cls = classifyTarget(destination);
      f = {
        source, destination, port, protocol,
        count: 0, countBasis, records: 0,
        bytes: volumeUnit === 'bytes' ? 0 : null,
        packets: volumeUnit === 'packets' ? 0 : null,
        sourceAlias: '', destinationAlias: '',
        sampleActions: [],
        destType: cls.type, destLabel: cls.label,
      };
      byKey.set(key, f);
    }
    f.count += count;
    f.records += 1;
    totalCount += count;
    if (volumeUnit === 'bytes') { f.bytes += volume; totalBytes += volume; }
    else if (volumeUnit === 'packets') { f.packets += volume; totalPackets += volume; }
    // The column we did NOT take for this role is kept, not discarded: it is
    // the IP behind a name (or the name behind an IP), and it is how
    // suggestSources() answers a question the export already answered.
    if (has(srcAlias) && !f.sourceAlias) f.sourceAlias = normHost(row[srcAlias]);
    if (has(dstAlias) && !f.destinationAlias) f.destinationAlias = normHost(row[dstAlias]);
    if (action && f.sampleActions.length < 4 && !f.sampleActions.includes(action)) f.sampleActions.push(action);
  }

  for (const f of byKey.values()) {
    f.observedLabel = observationLabel(f);
    f.purpose = flowPurpose(f);
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
    countBasis,
    totalBytes: volumeUnit === 'bytes' ? totalBytes : null,
    totalPackets: volumeUnit === 'packets' ? totalPackets : null,
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

// ---- IP → subnet → component, from the resource graph the workspace already has
//
// Problem 3 in docs/JOURNEY-REPORT.md: every private source IP came back as
// "private IP with no name — pick the component manually" while the workspace
// held the subnet CIDR that contains it, a k8s workload with the exact name,
// and a srcname column holding that name. All three are used now.

function ipToLong(ip) {
  if (!isIpv4(ip)) return null;
  return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
}
function parseCidr(cidr) {
  const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})\s*$/.exec(String(cidr || ''));
  if (!m) return null;
  const base = ipToLong(m[1]);
  const bits = Number(m[2]);
  if (base === null || !(bits >= 0 && bits <= 32)) return null;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, bits, text: `${m[1]}/${bits}` };
}
function cidrContains(net, ipLong) {
  return net && ipLong !== null && ((ipLong & net.mask) >>> 0) === net.base;
}

// Any node field that could hold a literal address, so an ENI/instance/endpoint
// node matches its IP exactly (a stronger answer than the enclosing subnet).
const IP_DETAIL_KEYS = [
  'ip', 'privateIp', 'privateIpAddress', 'publicIp', 'publicIpAddress', 'address',
  'primaryIp', 'clusterIp', 'nodeIp', 'endpointIp', 'ipAddress',
];

// buildGraphIndex(graph) -> { nets: [...], exact: Map(ip -> [node]), subnets, nodes }
function buildGraphIndex(graph) {
  const nodesObj = graph && typeof graph.nodes === 'object' && graph.nodes ? graph.nodes : {};
  const nodes = Array.isArray(nodesObj) ? nodesObj : Object.values(nodesObj);
  const nets = [];
  const exact = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const d = n.details || {};
    for (const key of ['cidr', 'cidrBlock', 'CidrBlock']) {
      const net = parseCidr(d[key]);
      if (net) { nets.push({ net, node: n }); break; }
    }
    const addrs = new Set();
    for (const k of IP_DETAIL_KEYS) if (d[k] && isIpv4(String(d[k]).trim())) addrs.add(String(d[k]).trim());
    if (isIpv4(String(n.name || '').trim())) addrs.add(String(n.name).trim());
    for (const a of addrs) {
      if (!exact.has(a)) exact.set(a, []);
      exact.get(a).push(n);
    }
  }
  // Most specific subnet first, so /23 beats the /16 that contains it.
  nets.sort((a, b) => b.net.bits - a.net.bits);
  return { nets, exact, nodes };
}

const nodeLabel = (n) => `${n.type || 'resource'} ${n.name || n.rid || ''}`.trim();

// suggestSources(flows, components, k8sSnapshot, opts) ->
//   [{source, flowCount, componentId, componentName, workloadUid, workload,
//     confidence, why, matchedOn, candidates, lookedAt}]
// `workload` is the '<namespace>/<name>' form carried onto written calls.
// `opts.graph` is the workspace resource graph; when it is not supplied the
// graph is located from the component ids (see findGraphForComponents), so a
// caller that has not been taught about it still gets subnet resolution.
export function suggestSources(flows, components = [], k8sSnapshot = null, opts = {}) {
  const comps = Array.isArray(components) ? components : [];
  const byId = new Map(comps.map((c) => [c.id, c]));
  const compIds = new Set(comps.map((c) => c.id));
  const workloads = Array.isArray(k8sSnapshot?.workloads) ? k8sSnapshot.workloads : [];
  const services = Array.isArray(k8sSnapshot?.services) ? k8sSnapshot.services : [];
  const graph = opts.graph !== undefined ? opts.graph : findGraphForComponents(comps);
  const gx = buildGraphIndex(graph);
  const subnetCount = gx.nets.length;

  // k8s workload by uid, so a Service can be followed to what it selects.
  const wlByUid = new Map(workloads.filter((w) => w && w.uid).map((w) => [w.uid, w]));

  const counts = new Map();
  const aliases = new Map(); // source -> the other column's value for it
  for (const f of Array.isArray(flows) ? flows : []) {
    if (!f || !f.source) continue;
    counts.set(f.source, (counts.get(f.source) || 0) + 1);
    if (f.sourceAlias && !aliases.has(f.source)) aliases.set(f.source, f.sourceAlias);
  }

  const out = [];
  for (const [source, flowCount] of counts) {
    const alias = aliases.get(source) || '';
    const base = {
      source, flowCount, componentId: null, componentName: '', workloadUid: null,
      workload: '', confidence: 0, why: '', matchedOn: '', candidates: [], lookedAt: [],
    };
    let best = null;
    const consider = (cand) => { if (!best || cand.confidence > best.confidence) best = cand; };
    const lookedAt = [];
    const candidates = [];

    // Names to try: the source itself, plus the alias column when it holds a
    // name (the srcname column the importer did not take for the source role).
    const primary = sourceNames(source);
    const aliasNames = alias && alias !== source ? sourceNames(alias) : { names: [], namespace: '', isIp: true };
    const names = [...new Set([...primary.names, ...aliasNames.names])];
    const namespace = primary.namespace || aliasNames.namespace;
    const nameSource = primary.names.length ? '' : (aliasNames.names.length ? alias : '');

    lookedAt.push(`${workloads.length} k8s workload${workloads.length === 1 ? '' : 's'}`);
    lookedAt.push(`${comps.length} component name${comps.length === 1 ? '' : 's'}`);

    if (names.length) {
      const via = nameSource ? ` (from the name column: ${nameSource})` : '';
      // 1) k8s workloads (name, then namespace) — these carry a componentId.
      for (const w of workloads) {
        if (!w || !w.name) continue;
        for (const n of names) {
          const s = nameScore(n, w.name);
          if (s >= 0.5) {
            consider({
              componentId: w.componentId || null, workloadUid: w.uid || null,
              confidence: Math.min(0.97, s * (namespace && w.namespace === namespace ? 1 : 0.95)),
              matchedOn: 'k8s-workload',
              why: `k8s workload ${w.namespace || '?'}/${w.name}${s === 1 ? '' : ' (fuzzy name match)'}${via}`,
            });
          }
        }
        if (namespace && w.namespace === namespace) {
          consider({
            componentId: w.componentId || null, workloadUid: w.uid || null,
            confidence: 0.7, matchedOn: 'k8s-namespace',
            why: `k8s namespace ${w.namespace} (service DNS name)${via}`,
          });
        }
      }
      // 1b) a k8s Service name, followed to the workloads it selects.
      if (!best || best.confidence < 0.9) {
        for (const svc of services) {
          if (!svc || !svc.name) continue;
          for (const n of names) {
            if (nameScore(n, svc.name) < 0.9) continue;
            for (const uid of svc.targets || []) {
              const w = wlByUid.get(uid);
              if (!w) continue;
              consider({
                componentId: w.componentId || null, workloadUid: w.uid || null,
                confidence: 0.85, matchedOn: 'k8s-service',
                why: `k8s Service ${svc.namespace || '?'}/${svc.name} selects ${w.namespace || '?'}/${w.name}${via}`,
              });
            }
          }
        }
      }
      // 2) component names.
      if (!best || best.confidence < 0.9) {
        for (const n of [...names, namespace].filter(Boolean)) {
          for (const c of comps) {
            const s = nameScore(n, c.name);
            if (s >= 0.5) {
              consider({
                componentId: c.id, workloadUid: null, confidence: Math.min(0.95, s * 0.95),
                matchedOn: 'component-name',
                why: `${s === 1 ? `component name "${c.name}"` : `component "${c.name}" (fuzzy name match)`}${via}`,
              });
            }
          }
        }
      }
    }

    // 3) The address itself — the source, or the address column the importer
    //    did not take for the source role.
    const ips = [source, alias].filter((v) => v && isIpv4(normHost(v))).map((v) => normHost(v));
    if ((!best || best.confidence < 0.9) && ips.length && (subnetCount || gx.exact.size)) {
      lookedAt.push(`${subnetCount} subnet/VPC CIDR${subnetCount === 1 ? '' : 's'} in the resource graph`);
      for (const ip of [...new Set(ips)]) {
        const via = ip === source ? '' : ` (from the address column: ${ip})`;
        // 3a) a resource whose own address IS this IP.
        for (const n of gx.exact.get(ip) || []) {
          const owners = (n.componentIds || []).filter((id) => compIds.has(id));
          if (owners.length === 1) {
            consider({
              componentId: owners[0], workloadUid: null, confidence: 0.9, matchedOn: 'graph-resource',
              why: `${ip} is ${nodeLabel(n)} in the resource graph, which belongs to this component${via}`,
            });
          } else if (owners.length > 1) {
            for (const id of owners) {
              candidates.push({ componentId: id, componentName: byId.get(id)?.name || id, why: `shares ${nodeLabel(n)}` });
            }
          }
        }
        // 3b) the most specific subnet CIDR that contains it.
        const hit = gx.nets.find((x) => cidrContains(x.net, ipToLong(ip)));
        if (hit) {
          const owners = [...new Set((hit.node.componentIds || []).filter((id) => compIds.has(id)))];
          const where = `${ip} is inside ${hit.node.name || hit.node.rid} (${hit.net.text})`;
          if (owners.length === 1) {
            consider({
              componentId: owners[0], workloadUid: null,
              confidence: hit.net.bits >= 24 ? 0.75 : 0.65,
              matchedOn: 'graph-subnet',
              why: `${where} in the resource graph, and that ${hit.node.type || 'network'} belongs to one component${via}`,
            });
          } else if (owners.length > 1) {
            for (const id of owners) {
              candidates.push({ componentId: id, componentName: byId.get(id)?.name || id, why: where });
            }
            if (!best) {
              base.why = `${where} — ${owners.length} components use that ${hit.node.type || 'network'} `
                + `(${owners.map((id) => byId.get(id)?.name || id).join(', ')}); pick the one that owns this workload`;
            }
          } else if (!best && !base.why) {
            base.why = `${where} in the resource graph, but no component is linked to that `
              + `${hit.node.type || 'network'} yet`;
          }
        }
      }
    }

    if (!best || !best.componentId) {
      const searched = lookedAt.length ? ` Searched ${lookedAt.join(', ')}.` : '';
      const partial = base.why || (best?.why ? `${best.why} — no linked component` : '');
      const why = partial
        ? `${partial}.${searched} Pick the component manually.`
        : unresolvedWhy(source, alias, names.length > 0, lookedAt);
      out.push({ ...base, why, candidates, lookedAt });
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
      matchedOn: best.matchedOn || '',
      candidates,
      lookedAt,
    });
  }
  out.sort((a, b) => b.flowCount - a.flowCount || a.source.localeCompare(b.source));
  return out;
}

// "Pick it manually" is only an honest answer when it says what was searched.
function unresolvedWhy(source, alias, hadNames, lookedAt) {
  const what = isIpv4(normHost(source)) || isIpv6(normHost(source))
    ? `${isPrivateIp(source) ? 'private IP' : 'IP address'} ${source}${alias ? ` (also seen as "${alias}")` : ''}`
    : `"${source}"`;
  const searched = lookedAt.length ? ` Searched ${lookedAt.join(', ')}.` : '';
  const nothing = hadNames
    ? 'nothing matched by name'
    : 'the export carries no name column for it, and it is not inside any subnet the resource graph knows';
  return `${what}: ${nothing}.${searched} Pick the component manually.`;
}

// The resource graph lives in the workspace, and suggestSources() is handed
// components rather than a slug. Rather than make every caller pass the graph
// (opts.graph short-circuits this), find the workspace those component ids
// belong to and read its graph. Component ids are random per workspace, so the
// match is unambiguous; a miss simply means no IP resolution.
const graphCache = new Map(); // slug -> {at, graph}
const GRAPH_TTL_MS = 2000;

function findGraphForComponents(components) {
  const ids = new Set((components || []).map((c) => c && c.id).filter(Boolean));
  if (!ids.size) return null;
  let slugs = [];
  try { slugs = store.listWorkspaces().map((w) => w.slug); } catch { return null; }
  for (const slug of slugs) {
    let items = [];
    try { items = store.getCollection(slug, 'components'); } catch { continue; }
    if (!items.some((c) => c && ids.has(c.id))) continue;
    const hit = graphCache.get(slug);
    const now = Date.now();
    if (hit && now - hit.at < GRAPH_TTL_MS) return hit.graph;
    let graph = null;
    try { graph = store.getObject(slug, 'resource-graph') || null; } catch { graph = null; }
    graphCache.set(slug, { at: now, graph });
    return graph;
  }
  return null;
}

// ---------------------------------------------------------------- apply

const OUTBOUND_TYPES = new Set(['aws-service', 'third-party', 'saas', 'internal', 'on-prem']);

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
//                observedCount?, countBasis?, observedBytes?, observedPackets?,
//                workload?}]
// Writes each assignment onto its component's outboundCalls (deduped on
// target + port + protocol) and, for non-internal targets, merges a
// `net_<slug>` node + a `uses` edge into the resource graph.
//
// Each written call carries additive provenance fields the Excel "Egress /
// Outbound Calls" sheet reads: source:'network-flows', observedCount (always a
// number of OBSERVATIONS, with observedBasis saying whether those are flow
// records or a real count column), observedBytes/observedPackets when the
// export carried traffic volume, workload ('<namespace>/<name>' when the source
// matched a k8s workload) and a numeric `port` alongside the 'tcp/443'-style
// protocol. Re-applying the same flow never appends a second entry — it raises
// each observed figure to the larger value.
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
    const critical = a.critical === true;
    const observed = Number(a.observedCount) > 0 ? Math.floor(Number(a.observedCount)) : 1;
    // Volume is recorded as volume. It is additive provenance, never a count:
    // nothing downstream may turn 229,110,441 bytes into 229 million calls.
    const bytes = Number(a.observedBytes) > 0 ? Math.floor(Number(a.observedBytes)) : 0;
    const packets = Number(a.observedPackets) > 0 ? Math.floor(Number(a.observedPackets)) : 0;
    const countBasis = a.countBasis === 'count-column' ? 'count-column' : 'records';
    const purpose = String(a.purpose || '').trim()
      || flowPurpose({ count: observed, countBasis, bytes, packets });
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
      // Re-apply: never a second row — raise the observed figures instead.
      const prev = Number(existing.observedCount) > 0 ? Math.floor(Number(existing.observedCount)) : 0;
      const prevBytes = Number(existing.observedBytes) > 0 ? Math.floor(Number(existing.observedBytes)) : 0;
      const prevPackets = Number(existing.observedPackets) > 0 ? Math.floor(Number(existing.observedPackets)) : 0;
      if (observed > prev || bytes > prevBytes || packets > prevPackets) {
        if (observed > prev) existing.observedCount = observed;
        if (bytes > prevBytes) existing.observedBytes = bytes;
        if (packets > prevPackets) existing.observedPackets = packets;
        if (existing.source === 'network-flows') {
          existing.purpose = flowPurpose({
            count: Math.max(observed, prev),
            countBasis: existing.observedBasis || countBasis,
            bytes: existing.observedBytes,
            packets: existing.observedPackets,
          });
        }
        if (workload && !existing.workload) existing.workload = workload;
        cmp.updatedAt = now;
        touched.add(cmp.id);
      }
    } else {
      const call = {
        target, type, protocol: proto, purpose,
        failoverBehavior: '', critical,
        // additive provenance (read defensively by the Excel egress sheet).
        // observedCount is a number of OBSERVATIONS — flow records, or the
        // sum of a real count column, and `observedBasis` says which.
        source: 'network-flows', observedCount: observed, observedBasis: countBasis,
        port: port ?? null,
      };
      if (bytes > 0) call.observedBytes = bytes;
      if (packets > 0) call.observedPackets = packets;
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
        componentIds: [],
        details: {
          port: normPort(a.port) || null, protocol: proto,
          observedCount: 0, observedBytes: 0, observedPackets: 0,
        },
        tags: {}, source: 'network-import',
      };
    }
    if (!node.componentIds.includes(cmp.id)) node.componentIds.push(cmp.id);
    node.details.observedCount += observed;
    node.details.observedBytes = (node.details.observedBytes || 0) + bytes;
    node.details.observedPackets = (node.details.observedPackets || 0) + packets;
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
