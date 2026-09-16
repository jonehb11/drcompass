// AWS discovery — shells out to the user's LOCAL `aws` CLI (v2) with their own
// profiles/credentials. Read-only list/describe calls only. Nothing is stored.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFile = promisify(execFileCb);
const AWS_TIMEOUT = 30000;
const MAX_BUFFER = 32 * 1024 * 1024;

// ---------------------------------------------------------------- profiles

function parseIniSections(file) {
  return parseIniSectionsDetailed(file).map((s) => s.name);
}

// [{name, body}] — body is the raw text of the section (for sso detection).
function parseIniSectionsDetailed(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const sections = [];
    let cur = null;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*\[\s*(.+?)\s*\]\s*$/);
      if (m) {
        cur = { name: m[1], body: '' };
        sections.push(cur);
      } else if (cur) {
        cur.body += line + '\n';
      }
    }
    return sections;
  } catch {
    return []; // missing/unreadable file → no profiles from it
  }
}

const profileSort = (a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b));

// ~/.aws/config + ~/.aws/credentials profiles, with an `sso` flag for config
// sections that carry sso_session/sso_start_url. [{name, sso}]
function listConfigProfiles() {
  const home = os.homedir();
  // In ~/.aws/config only [default] and [profile <name>] are profiles
  // ([sso-session x], [services x] are not).
  const byName = new Map();
  for (const s of parseIniSectionsDetailed(path.join(home, '.aws', 'config'))) {
    if (s.name !== 'default' && !/^profile\s+/.test(s.name)) continue;
    const name = s.name.replace(/^profile\s+/, '');
    if (!name) continue;
    const sso = /^\s*(sso_session|sso_start_url)\s*=/m.test(s.body);
    const cur = byName.get(name);
    byName.set(name, { name, sso: sso || !!(cur && cur.sso) });
  }
  for (const name of parseIniSections(path.join(home, '.aws', 'credentials'))) {
    if (name && !byName.has(name)) byName.set(name, { name, sso: false });
  }
  return [...byName.values()].sort((a, b) => profileSort(a.name, b.name));
}

// Back-compat thin wrapper: names only (config + credentials files, same
// dedupe/sort as before).
export function listProfiles() {
  return listConfigProfiles().map((p) => p.name);
}

export async function awsVaultFound() {
  try {
    await execFile('aws-vault', ['--version'], { timeout: 10000, env: process.env });
    return true;
  } catch {
    return false;
  }
}

// Profile names known to aws-vault. Prefers `aws-vault list --format=json`,
// falls back to parsing the plain table; aws-vault absent → []. Never throws.
export async function listVaultProfiles() {
  try {
    const { stdout } = await execFile('aws-vault', ['list', '--format=json'],
      { timeout: 10000, env: process.env });
    const parsed = JSON.parse(stdout.toString().trim());
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.profiles) ? parsed.profiles : []);
    const names = rows.map((r) => (typeof r === 'string' ? r
      : String(r?.ProfileName ?? r?.profile ?? r?.Name ?? r?.name ?? ''))).filter(Boolean);
    if (names.length) return [...new Set(names)];
  } catch { /* fall through to the plain-table parse */ }
  try {
    const { stdout } = await execFile('aws-vault', ['list'], { timeout: 10000, env: process.env });
    const names = [];
    for (const line of stdout.toString().split('\n')) {
      const first = line.trim().split(/\s+/)[0] || '';
      if (!first || first === '-' || /^=+$/.test(first)) continue;
      if (/^profile$/i.test(first)) continue; // header row
      names.push(first);
    }
    return [...new Set(names)];
  } catch {
    return []; // aws-vault absent/broken → no vault profiles
  }
}

// Merged profile sources for the UI:
//   [{name, source: 'config'|'vault'|'both', sso, vault}]
// deduped by name; 'default' first, then alphabetical.
export async function listProfilesDetailed() {
  const config = listConfigProfiles();
  const vault = new Set(await listVaultProfiles());
  const out = config.map((p) => ({
    name: p.name,
    source: vault.has(p.name) ? 'both' : 'config',
    sso: p.sso,
    vault: vault.has(p.name),
  }));
  const known = new Set(config.map((p) => p.name));
  for (const name of vault) {
    if (!known.has(name)) out.push({ name, source: 'vault', sso: false, vault: true });
  }
  out.sort((a, b) => profileSort(a.name, b.name));
  return out;
}

// ------------------------------------------------------------ exec mechanism
// awsArgs(profile, args, {via}) -> {bin, args} for one aws CLI invocation.
//   via 'vault'  -> aws-vault exec <profile> -- aws <args>   (no --profile)
//   otherwise    -> aws <args> [--profile <profile>]
export function awsArgs(profile, args, { via = 'profile' } = {}) {
  if (via === 'vault' && profile) {
    return { bin: 'aws-vault', args: ['exec', profile, '--', 'aws', ...args] };
  }
  return { bin: 'aws', args: [...args, ...(profile ? ['--profile', profile] : [])] };
}

// resolveAuthVia(profile, authVia) -> 'vault' | 'profile'.
// An explicit authVia wins; otherwise auto: 'vault' only when the profile is
// vault-only (known to aws-vault but absent from ~/.aws/config|credentials).
export async function resolveAuthVia(profile, authVia = '') {
  if (authVia === 'vault' || authVia === 'profile') return authVia;
  if (!profile) return 'profile';
  try {
    const detailed = await listProfilesDetailed();
    const p = detailed.find((x) => x.name === profile);
    if (p && p.source === 'vault') return 'vault';
  } catch { /* auto-detection is best-effort */ }
  return 'profile';
}

export async function awsCliFound() {
  try {
    await execFile('aws', ['--version'], { timeout: 10000, env: process.env });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- helpers

function shortErr(e) {
  if (e.code === 'ENOENT') return 'aws binary not found';
  if (e.killed || e.signal === 'SIGTERM') return `timed out after ${AWS_TIMEOUT / 1000}s`;
  const stderr = (e.stderr || '').toString().trim().split('\n').slice(-3).join(' ');
  return (stderr || e.message || 'unknown error').slice(0, 300);
}

// Full, defaulted Component shape for a proposal (id assigned at import time).
// `arn` is an additive schema field (persisted at import). `mapRef` carries the
// exact resource identity ({svc, names[]}) for the scan&map association pass —
// it is defined NON-enumerable so JSON responses and object spreads never
// carry it (the classic /discover/aws payload stays shape-compatible).
function prop(over) {
  const { mapRef, ...rest } = over;
  const p = {
    name: '', category: 'other', tier: 1, owner: '', team: '', description: '',
    kind: '', arn: '', drStrategy: 'inherit', restoreLayer: 'L4',
    replication: { mechanism: 'unknown', rpoMinutes: null, notes: '' },
    inRecoveryScope: 'unknown', definedIn: '',
    dependsOn: [], outboundCalls: [], awsServices: [], secrets: [], endpoints: [],
    verification: { command: '', pass: '' },
    gaps: [], notes: '', tags: ['discovered'],
    ...rest,
    arn: rest.arn || '',
    replication: { mechanism: 'unknown', rpoMinutes: null, notes: '', ...(rest.replication || {}) },
  };
  if (mapRef) Object.defineProperty(p, 'mapRef', { value: mapRef, enumerable: false });
  return p;
}

const facts = (parts) => parts.filter(Boolean).join('; ');

// makeLog(onLog) -> a plain log array whose push() ALSO invokes the optional
// onLog(line) callback. This is the one central streaming hook: every runner
// and inline `log.push(...)` flows through it, and sync callers (no onLog)
// get back an ordinary array with identical behavior.
export function makeLog(onLog) {
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

// ---------------------------------------------------------------- per-service discoverers
// Each receives a ctx: { run(args, {global}), region, add(proposal) }.
// run() logs the exact command, executes it, and returns parsed JSON.

const DISCOVERERS = {
  async eks({ run, add }) {
    const { clusters = [] } = await run(['eks', 'list-clusters']);
    for (const name of clusters.slice(0, 20)) {
      let d = null;
      try { d = (await run(['eks', 'describe-cluster', '--name', name])).cluster; } catch { /* facts optional */ }
      add(prop({
        name: `EKS cluster — ${name}`, category: 'compute', kind: 'eks-cluster',
        restoreLayer: 'L2', awsServices: ['EKS', 'EC2', 'ELB'],
        arn: d?.arn || '', mapRef: { svc: 'eks', names: [name] },
        description: facts([`EKS cluster '${name}'`, d?.version && `Kubernetes ${d.version}`,
          d?.status && `status ${d.status}`, d?.resourcesVpcConfig?.subnetIds && `${d.resourcesVpcConfig.subnetIds.length} subnets`]),
      }));
    }
  },

  async ecs({ run, add }) {
    const { clusterArns = [] } = await run(['ecs', 'list-clusters']);
    for (const arn of clusterArns.slice(0, 10)) {
      const cname = arn.split('/').pop();
      add(prop({
        name: `ECS cluster — ${cname}`, category: 'compute', kind: 'ecs-cluster',
        restoreLayer: 'L2', awsServices: ['ECS'], description: `ECS cluster '${cname}'`,
        arn, mapRef: { svc: 'ecs', names: [cname] },
      }));
      try {
        const { serviceArns = [] } = await run(['ecs', 'list-services', '--cluster', arn]);
        for (const sArn of serviceArns.slice(0, 50)) {
          const sname = sArn.split('/').pop();
          add(prop({
            name: `${sname} (ECS)`, category: 'compute', kind: 'ecs-service',
            restoreLayer: 'L4', awsServices: ['ECS'],
            arn: sArn, mapRef: { svc: 'ecs', names: [sname] },
            description: `ECS service '${sname}' in cluster '${cname}'`,
          }));
        }
      } catch { /* services listing optional per cluster */ }
    }
  },

  async lambda({ run, add }) {
    const { Functions = [] } = await run(['lambda', 'list-functions']);
    for (const f of Functions.slice(0, 100)) {
      add(prop({
        name: `${f.FunctionName} (Lambda)`, category: 'compute', kind: 'lambda',
        restoreLayer: 'L4', awsServices: ['Lambda'],
        arn: f.FunctionArn || '', mapRef: { svc: 'lambda', names: [f.FunctionName] },
        description: facts([`Lambda function`, f.Runtime && `runtime ${f.Runtime}`,
          f.MemorySize && `${f.MemorySize}MB`, f.Timeout && `timeout ${f.Timeout}s`]),
      }));
    }
  },

  async 'ec2-asg'({ run, add }) {
    const { AutoScalingGroups = [] } = await run(['autoscaling', 'describe-auto-scaling-groups']);
    for (const g of AutoScalingGroups.slice(0, 50)) {
      const multiAz = (g.AvailabilityZones || []).length > 1;
      add(prop({
        name: `ASG — ${g.AutoScalingGroupName}`, category: 'compute', kind: 'ec2-asg',
        restoreLayer: 'L4', awsServices: ['EC2', 'Auto Scaling'],
        arn: g.AutoScalingGroupARN || '', mapRef: { svc: 'ec2-asg', names: [g.AutoScalingGroupName] },
        description: facts([`Auto Scaling group`, `min ${g.MinSize}/desired ${g.DesiredCapacity}/max ${g.MaxSize}`,
          multiAz ? `multi-AZ (${g.AvailabilityZones.length} AZs)` : 'single-AZ']),
      }));
    }
  },

  async rds({ run, add }) {
    let globalMembers = new Set();
    try {
      const { GlobalClusters = [] } = await run(['rds', 'describe-global-clusters']);
      for (const gc of GlobalClusters) for (const m of gc.GlobalClusterMembers || []) globalMembers.add(m.DBClusterArn);
    } catch { /* global-clusters is supplemental; permission optional */ }

    const { DBClusters = [] } = await run(['rds', 'describe-db-clusters']);
    const clusterMembers = new Set();
    for (const c of DBClusters.slice(0, 50)) {
      for (const m of c.DBClusterMembers || []) clusterMembers.add(m.DBInstanceIdentifier);
      const isGlobal = globalMembers.has(c.DBClusterArn);
      const aurora = (c.Engine || '').startsWith('aurora');
      const kind = c.Engine === 'aurora-postgresql' ? 'aurora-postgres'
        : c.Engine === 'aurora-mysql' ? 'aurora-mysql' : `rds-${c.Engine || 'unknown'}`;
      add(prop({
        name: `${aurora ? 'Aurora' : 'RDS'} — ${c.DBClusterIdentifier}`, category: 'database', kind,
        restoreLayer: 'L3', awsServices: [aurora ? 'Aurora' : 'RDS', 'KMS'],
        arn: c.DBClusterArn || '', mapRef: { svc: 'rds', names: [c.DBClusterIdentifier] },
        replication: isGlobal
          ? { mechanism: 'aurora-global', notes: 'Aurora Global Database detected — cross-region replica in place' }
          : { mechanism: 'unknown', notes: '' },
        description: facts([`${c.Engine} ${c.EngineVersion || ''}`.trim(),
          c.MultiAZ ? 'multi-AZ' : null, isGlobal ? 'member of an Aurora Global Database' : null,
          c.StorageEncrypted ? 'encrypted' : 'NOT encrypted']),
      }));
    }

    const { DBInstances = [] } = await run(['rds', 'describe-db-instances']);
    for (const i of DBInstances.slice(0, 50)) {
      if (i.DBClusterIdentifier || clusterMembers.has(i.DBInstanceIdentifier)) continue; // covered by cluster
      const replicaNote = (i.ReadReplicaDBInstanceIdentifiers || []).length
        ? `${i.ReadReplicaDBInstanceIdentifiers.length} read replica(s)` : null;
      add(prop({
        name: `RDS — ${i.DBInstanceIdentifier}`, category: 'database', kind: `rds-${i.Engine || 'unknown'}`,
        restoreLayer: 'L3', awsServices: ['RDS', 'KMS'],
        arn: i.DBInstanceArn || '', mapRef: { svc: 'rds', names: [i.DBInstanceIdentifier] },
        replication: replicaNote ? { mechanism: 'unknown', notes: replicaNote } : {},
        description: facts([`${i.Engine} ${i.EngineVersion || ''}`.trim(), i.DBInstanceClass,
          i.MultiAZ ? 'multi-AZ' : 'single-AZ', replicaNote, i.StorageEncrypted ? 'encrypted' : 'NOT encrypted']),
      }));
    }
  },

  async dynamodb({ run, add }) {
    const { TableNames = [] } = await run(['dynamodb', 'list-tables']);
    for (const t of TableNames.slice(0, 25)) {
      let d = null;
      try { d = (await run(['dynamodb', 'describe-table', '--table-name', t])).Table; } catch { /* facts optional */ }
      const replicas = d?.Replicas || [];
      add(prop({
        name: `DynamoDB — ${t}`, category: 'database', kind: 'dynamodb',
        restoreLayer: 'L3', awsServices: ['DynamoDB'],
        arn: d?.TableArn || '', mapRef: { svc: 'dynamodb', names: [t] },
        replication: replicas.length
          ? { mechanism: 'dynamodb-global-tables', notes: `Global table replicas: ${replicas.map((r) => r.RegionName).join(', ')}` }
          : {},
        description: facts([`DynamoDB table`, d?.BillingModeSummary?.BillingMode || (d ? 'PROVISIONED' : null),
          d?.ItemCount != null ? `~${d.ItemCount} items` : null,
          replicas.length ? `global table (${replicas.length} replicas)` : null]),
      }));
    }
    for (const t of TableNames.slice(25)) {
      add(prop({ name: `DynamoDB — ${t}`, category: 'database', kind: 'dynamodb', restoreLayer: 'L3', awsServices: ['DynamoDB'], mapRef: { svc: 'dynamodb', names: [t] }, description: 'DynamoDB table' }));
    }
  },

  async elasticache({ run, add }) {
    const { ReplicationGroups = [] } = await run(['elasticache', 'describe-replication-groups']);
    const inRg = new Set();
    for (const rg of ReplicationGroups.slice(0, 50)) {
      for (const m of rg.MemberClusters || []) inRg.add(m);
      const globalId = rg.GlobalReplicationGroupInfo?.GlobalReplicationGroupId;
      add(prop({
        name: `ElastiCache — ${rg.ReplicationGroupId}`, category: 'database', kind: 'elasticache-redis',
        restoreLayer: 'L3', awsServices: ['ElastiCache'],
        arn: rg.ARN || '', mapRef: { svc: 'elasticache', names: [rg.ReplicationGroupId] },
        replication: globalId
          ? { mechanism: 'elasticache-global-datastore', notes: `Global Datastore '${globalId}' detected` }
          : {},
        description: facts(['Redis replication group',
          rg.MultiAZ === 'enabled' ? 'multi-AZ' : null,
          rg.ClusterEnabled ? 'cluster mode' : null,
          `${(rg.MemberClusters || []).length} node(s)`, globalId ? 'Global Datastore member' : null]),
      }));
    }
    try {
      const { CacheClusters = [] } = await run(['elasticache', 'describe-cache-clusters']);
      for (const c of CacheClusters.slice(0, 50)) {
        if (c.ReplicationGroupId || inRg.has(c.CacheClusterId)) continue;
        add(prop({
          name: `ElastiCache — ${c.CacheClusterId}`, category: 'database',
          kind: c.Engine === 'redis' ? 'elasticache-redis' : `elasticache-${c.Engine}`,
          restoreLayer: 'L3', awsServices: ['ElastiCache'],
          arn: c.ARN || '', mapRef: { svc: 'elasticache', names: [c.CacheClusterId] },
          description: facts([`${c.Engine} ${c.EngineVersion || ''}`.trim(), c.CacheNodeType, 'standalone cache cluster']),
        }));
      }
    } catch { /* standalone clusters optional */ }
  },

  async sqs({ run, add }) {
    const { QueueUrls = [] } = await run(['sqs', 'list-queues']);
    for (const url of QueueUrls.slice(0, 100)) {
      const name = url.split('/').pop();
      add(prop({
        name: `SQS — ${name}`, category: 'messaging-streaming', kind: 'sqs',
        restoreLayer: 'L3', awsServices: ['SQS'],
        mapRef: { svc: 'sqs', names: [name] },
        description: facts(['SQS queue', name.endsWith('.fifo') ? 'FIFO' : 'standard',
          'in-flight messages at the recovery point are lost']),
      }));
    }
  },

  async sns({ run, add }) {
    const { Topics = [] } = await run(['sns', 'list-topics']);
    for (const t of Topics.slice(0, 100)) {
      const name = (t.TopicArn || '').split(':').pop();
      add(prop({
        name: `SNS — ${name}`, category: 'messaging-streaming', kind: 'sns',
        restoreLayer: 'L3', awsServices: ['SNS'], description: `SNS topic (subscriptions must be re-created in recovery region)`,
        arn: t.TopicArn || '', mapRef: { svc: 'sns', names: [name] },
      }));
    }
  },

  async kinesis({ run, add }) {
    const { StreamNames = [] } = await run(['kinesis', 'list-streams']);
    for (const s of StreamNames.slice(0, 100)) {
      add(prop({
        name: `Kinesis — ${s}`, category: 'messaging-streaming', kind: 'kinesis',
        restoreLayer: 'L3', awsServices: ['Kinesis'],
        mapRef: { svc: 'kinesis', names: [s] },
        description: 'Kinesis data stream — stream data is not replicated cross-region by default',
      }));
    }
  },

  async s3({ run, add, region }) {
    // Batched on purpose: names only, no per-bucket calls.
    const { Buckets = [] } = await run(['s3api', 'list-buckets']);
    if (!Buckets.length) return;
    const names = Buckets.map((b) => b.Name);
    const shown = names.slice(0, 30).join(', ');
    add(prop({
      name: `S3 buckets (${names.length})`, category: 'storage', kind: 's3',
      restoreLayer: 'L3', awsServices: ['S3'],
      mapRef: { svc: 's3', names: names.slice(0, 25) },
      description: `${names.length} bucket(s) visible from ${region}: ${shown}${names.length > 30 ? ', …' : ''}. Split into per-workload components and check which need cross-region replication.`,
      notes: 'S3 bucket list is account-global; per-bucket regions not queried during discovery.',
    }));
  },

  async secrets({ run, add }) {
    // Names + ARNs ONLY. Secret values are never read.
    const { SecretList = [] } = await run(['secretsmanager', 'list-secrets', '--max-results', '100']);
    if (!SecretList.length) return;
    add(prop({
      name: `Secrets Manager (${SecretList.length} secrets)`, category: 'security-secrets', kind: 'secrets-manager',
      restoreLayer: 'L3', awsServices: ['Secrets Manager', 'KMS'],
      mapRef: { svc: 'secrets', names: [] },
      secrets: SecretList.slice(0, 100).map((s) => ({ name: s.Name, arn: s.ARN || '', replicated: 'unknown', notes: '' })),
      description: `${SecretList.length} secret(s) listed (names + ARNs only — values never read). Reconcile against the runtime logical names your apps resolve at start.`,
    }));
  },

  async route53({ run, add }) {
    const { HostedZones = [] } = await run(['route53', 'list-hosted-zones'], { global: true });
    for (const z of HostedZones.slice(0, 50)) {
      add(prop({
        name: `Route 53 — ${z.Name.replace(/\.$/, '')}`, category: 'edge-dns', kind: 'route53',
        restoreLayer: 'L7', awsServices: ['Route 53'],
        mapRef: { svc: 'route53', names: [z.Name.replace(/\.$/, ''), String(z.Id || '').replace(/^\/hostedzone\//, '')].filter(Boolean) },
        replication: { mechanism: 'n/a-global', notes: 'Route 53 is a global service' },
        description: facts([z.Config?.PrivateZone ? 'private hosted zone' : 'public hosted zone',
          `${z.ResourceRecordSetCount} record sets`, 'DNS flip is the live-cutover layer (L7)']),
      }));
    }
  },

  async cloudfront({ run, add }) {
    const res = await run(['cloudfront', 'list-distributions'], { global: true });
    const items = res.DistributionList?.Items || [];
    for (const d of items.slice(0, 50)) {
      const aliases = d.Aliases?.Items || [];
      add(prop({
        name: `CloudFront — ${aliases[0] || d.DomainName}`, category: 'edge-dns', kind: 'cloudfront',
        restoreLayer: 'L5', awsServices: ['CloudFront'],
        arn: d.ARN || '', mapRef: { svc: 'cloudfront', names: [d.Id].filter(Boolean) },
        replication: { mechanism: 'n/a-global', notes: 'CloudFront is a global service; origins must fail over' },
        description: facts([`distribution ${d.Id}`, d.Enabled ? 'enabled' : 'DISABLED',
          aliases.length ? `aliases: ${aliases.join(', ')}` : null,
          d.Origins?.Items?.length ? `${d.Origins.Items.length} origin(s)` : null]),
      }));
    }
  },

  async elb({ run, add }) {
    const { LoadBalancers = [] } = await run(['elbv2', 'describe-load-balancers']);
    for (const lb of LoadBalancers.slice(0, 50)) {
      add(prop({
        name: `${lb.Type?.toUpperCase() === 'NETWORK' ? 'NLB' : lb.Type === 'application' ? 'ALB' : 'ELB'} — ${lb.LoadBalancerName}`,
        category: 'networking', kind: 'elb',
        restoreLayer: 'L5', awsServices: ['ELB'],
        arn: lb.LoadBalancerArn || '', mapRef: { svc: 'elb', names: [lb.LoadBalancerName] },
        description: facts([`${lb.Type} load balancer`, lb.Scheme,
          `${(lb.AvailabilityZones || []).length} AZs`, lb.State?.Code]),
      }));
    }
  },

  async apigateway({ run, add }) {
    const { items = [] } = await run(['apigateway', 'get-rest-apis']);
    for (const a of items.slice(0, 50)) {
      add(prop({
        name: `API Gateway — ${a.name}`, category: 'edge-dns', kind: 'api-gateway',
        restoreLayer: 'L5', awsServices: ['API Gateway'],
        mapRef: { svc: 'apigateway', names: [a.name, a.id].filter(Boolean) },
        description: facts(['REST API', a.endpointConfiguration?.types?.join('/'), `id ${a.id}`]),
      }));
    }
    try {
      const v2 = await run(['apigatewayv2', 'get-apis']);
      for (const a of (v2.Items || []).slice(0, 50)) {
        add(prop({
          name: `API Gateway — ${a.Name}`, category: 'edge-dns', kind: 'api-gateway',
          restoreLayer: 'L5', awsServices: ['API Gateway'],
          mapRef: { svc: 'apigateway', names: [a.Name, a.ApiId].filter(Boolean) },
          description: facts([`${a.ProtocolType} API`, `id ${a.ApiId}`]),
        }));
      }
    } catch { /* v2 APIs optional */ }
  },

  async ecr({ run, add }) {
    const { repositories = [] } = await run(['ecr', 'describe-repositories']);
    if (!repositories.length) return;
    const names = repositories.map((r) => r.repositoryName);
    add(prop({
      name: `ECR — ${names.length} repositories`, category: 'cicd-control-plane', kind: 'ecr',
      restoreLayer: 'L1', awsServices: ['ECR'],
      mapRef: { svc: 'ecr', names: names.slice(0, 25) },
      description: `Container image repositories: ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', …' : ''}. Images must exist in the recovery region before pods/tasks start — consider ECR cross-region replication.`,
    }));
  },

  async transfer({ run, add }) {
    const { Servers = [] } = await run(['transfer', 'list-servers']);
    for (const s of Servers.slice(0, 20)) {
      add(prop({
        name: `Transfer Family — ${s.ServerId}`, category: 'storage', kind: 'transfer-family',
        restoreLayer: 'L5', awsServices: ['Transfer Family'],
        arn: s.Arn || '', mapRef: { svc: 'transfer', names: [s.ServerId] },
        description: facts([`SFTP/AS2 server`, s.EndpointType && `endpoint ${s.EndpointType}`, s.State,
          'partner-facing endpoint — partners may pin hostname/IP']),
      }));
    }
  },

  async msk({ run, add }) {
    const { ClusterInfoList = [] } = await run(['kafka', 'list-clusters']);
    for (const c of ClusterInfoList.slice(0, 20)) {
      add(prop({
        name: `MSK — ${c.ClusterName}`, category: 'messaging-streaming', kind: 'msk',
        restoreLayer: 'L3', awsServices: ['MSK'],
        arn: c.ClusterArn || '', mapRef: { svc: 'msk', names: [c.ClusterName] },
        description: facts(['Managed Kafka cluster', c.CurrentBrokerSoftwareInfo?.KafkaVersion && `Kafka ${c.CurrentBrokerSoftwareInfo.KafkaVersion}`,
          c.NumberOfBrokerNodes && `${c.NumberOfBrokerNodes} brokers`, c.State]),
      }));
    }
  },

  async efs({ run, add }) {
    const { FileSystems = [] } = await run(['efs', 'describe-file-systems']);
    for (const f of FileSystems.slice(0, 50)) {
      add(prop({
        name: `EFS — ${f.Name || f.FileSystemId}`, category: 'storage', kind: 'efs',
        restoreLayer: 'L3', awsServices: ['EFS'],
        arn: f.FileSystemArn || '', mapRef: { svc: 'efs', names: [f.FileSystemId, f.Name].filter(Boolean) },
        replication: f.ReplicationOverwriteProtection ? {} : {},
        description: facts(['EFS file system', f.PerformanceMode, f.Encrypted ? 'encrypted' : 'NOT encrypted',
          f.NumberOfMountTargets != null ? `${f.NumberOfMountTargets} mount targets` : null,
          'check EFS replication configuration for cross-region copy']),
      }));
    }
  },
};

export const SERVICE_IDS = Object.keys(DISCOVERERS);

// ---------------------------------------------------------------- discover()

// Run the per-service discoverers against an injected runner. `run(args,
// {global})` must return parsed JSON for an aws CLI invocation — the live
// scan shells out; the scan&map artifact upload replays captured output
// through the very same discoverers (see aws-scan-map.js).
export async function runDiscoverers({ services = [], region = '', run } = {}) {
  const errors = [];
  const proposals = [];
  const wanted = (services && services.length ? services : SERVICE_IDS)
    .filter((s) => DISCOVERERS[s]);

  const tasks = wanted.map((svc) => async () => {
    try {
      await DISCOVERERS[svc]({ run, region, add: (p) => proposals.push(p) });
    } catch (e) {
      errors.push(`${svc}: ${shortErr(e)}`);
    }
  });

  // limited concurrency (3 at a time) so we don't hammer the CLI/API
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);

  return { proposals, errors };
}

export function makeCliRunner({ profile = '', region = '', log = [], via = 'profile' } = {}) {
  // via 'vault' needs the profile name verbatim (even 'default'); otherwise
  // 'default' means "no --profile" exactly as before.
  const vaultMode = via === 'vault' && !!profile;
  const useProfile = vaultMode ? profile : (profile && profile !== 'default' ? profile : '');
  return async (args, { global: isGlobal = false } = {}) => {
    const full = [...args, '--output', 'json', '--no-cli-pager'];
    if (!isGlobal) full.push('--region', region);
    const { bin, args: spawnArgs } = awsArgs(useProfile, full, { via: vaultMode ? 'vault' : 'profile' });
    log.push(vaultMode ? `aws-vault exec ${useProfile} -- aws ${full.join(' ')}` : `aws ${spawnArgs.join(' ')}`);
    const { stdout } = await execFile(bin, spawnArgs, {
      timeout: AWS_TIMEOUT, maxBuffer: MAX_BUFFER, env: process.env,
    });
    const out = stdout.toString().trim();
    return out ? JSON.parse(out) : {};
  };
}

export async function discover({ profile = '', region = '', services = [], authVia = '', onLog } = {}) {
  const log = makeLog(onLog);

  if (!(await awsCliFound())) {
    return { proposals: [], log, errors: ['AWS CLI not found — install awscli and configure a profile'] };
  }
  if (!region) return { proposals: [], log, errors: ['A region is required (e.g. us-east-1)'] };

  const via = await resolveAuthVia(profile, authVia);
  const run = makeCliRunner({ profile, region, log, via });
  const { proposals, errors } = await runDiscoverers({ services, region, run });
  return { proposals, log, errors };
}
