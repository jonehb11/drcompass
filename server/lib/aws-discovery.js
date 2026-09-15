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
  try {
    const text = fs.readFileSync(file, 'utf8');
    const names = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*\[\s*(.+?)\s*\]\s*$/);
      if (m) names.push(m[1]);
    }
    return names;
  } catch {
    return []; // missing/unreadable file → no profiles from it
  }
}

export function listProfiles() {
  const home = os.homedir();
  // In ~/.aws/config only [default] and [profile <name>] are profiles
  // ([sso-session x], [services x] are not).
  const fromConfig = parseIniSections(path.join(home, '.aws', 'config'))
    .filter((s) => s === 'default' || /^profile\s+/.test(s))
    .map((s) => s.replace(/^profile\s+/, ''));
  const fromCreds = parseIniSections(path.join(home, '.aws', 'credentials'));
  const all = [...new Set([...fromCreds, ...fromConfig])].filter(Boolean);
  all.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  return all;
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
function prop(over) {
  return {
    name: '', category: 'other', tier: 1, owner: '', team: '', description: '',
    kind: '', drStrategy: 'inherit', restoreLayer: 'L4',
    replication: { mechanism: 'unknown', rpoMinutes: null, notes: '' },
    inRecoveryScope: 'unknown', definedIn: '',
    dependsOn: [], outboundCalls: [], awsServices: [], secrets: [], endpoints: [],
    verification: { command: '', pass: '' },
    gaps: [], notes: '', tags: ['discovered'],
    ...over,
    replication: { mechanism: 'unknown', rpoMinutes: null, notes: '', ...(over.replication || {}) },
  };
}

const facts = (parts) => parts.filter(Boolean).join('; ');

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
      }));
      try {
        const { serviceArns = [] } = await run(['ecs', 'list-services', '--cluster', arn]);
        for (const sArn of serviceArns.slice(0, 50)) {
          const sname = sArn.split('/').pop();
          add(prop({
            name: `${sname} (ECS)`, category: 'compute', kind: 'ecs-service',
            restoreLayer: 'L4', awsServices: ['ECS'],
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
        replication: replicas.length
          ? { mechanism: 'dynamodb-global-tables', notes: `Global table replicas: ${replicas.map((r) => r.RegionName).join(', ')}` }
          : {},
        description: facts([`DynamoDB table`, d?.BillingModeSummary?.BillingMode || (d ? 'PROVISIONED' : null),
          d?.ItemCount != null ? `~${d.ItemCount} items` : null,
          replicas.length ? `global table (${replicas.length} replicas)` : null]),
      }));
    }
    for (const t of TableNames.slice(25)) {
      add(prop({ name: `DynamoDB — ${t}`, category: 'database', kind: 'dynamodb', restoreLayer: 'L3', awsServices: ['DynamoDB'], description: 'DynamoDB table' }));
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
      }));
    }
  },

  async kinesis({ run, add }) {
    const { StreamNames = [] } = await run(['kinesis', 'list-streams']);
    for (const s of StreamNames.slice(0, 100)) {
      add(prop({
        name: `Kinesis — ${s}`, category: 'messaging-streaming', kind: 'kinesis',
        restoreLayer: 'L3', awsServices: ['Kinesis'],
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
        description: facts(['REST API', a.endpointConfiguration?.types?.join('/'), `id ${a.id}`]),
      }));
    }
    try {
      const v2 = await run(['apigatewayv2', 'get-apis']);
      for (const a of (v2.Items || []).slice(0, 50)) {
        add(prop({
          name: `API Gateway — ${a.Name}`, category: 'edge-dns', kind: 'api-gateway',
          restoreLayer: 'L5', awsServices: ['API Gateway'],
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
      description: `Container image repositories: ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', …' : ''}. Images must exist in the recovery region before pods/tasks start — consider ECR cross-region replication.`,
    }));
  },

  async transfer({ run, add }) {
    const { Servers = [] } = await run(['transfer', 'list-servers']);
    for (const s of Servers.slice(0, 20)) {
      add(prop({
        name: `Transfer Family — ${s.ServerId}`, category: 'storage', kind: 'transfer-family',
        restoreLayer: 'L5', awsServices: ['Transfer Family'],
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

export async function discover({ profile = '', region = '', services = [] } = {}) {
  const log = [];
  const errors = [];
  const proposals = [];

  if (!(await awsCliFound())) {
    return { proposals, log, errors: ['AWS CLI not found — install awscli and configure a profile'] };
  }
  if (!region) return { proposals, log, errors: ['A region is required (e.g. us-east-1)'] };

  const wanted = (services && services.length ? services : SERVICE_IDS)
    .filter((s) => DISCOVERERS[s]);

  const useProfile = profile && profile !== 'default' ? profile : '';

  const makeRun = () => async (args, { global: isGlobal = false } = {}) => {
    const full = [...args, '--output', 'json', '--no-cli-pager'];
    if (!isGlobal) full.push('--region', region);
    if (useProfile) full.push('--profile', useProfile);
    log.push(`aws ${full.join(' ')}`);
    const { stdout } = await execFile('aws', full, {
      timeout: AWS_TIMEOUT, maxBuffer: MAX_BUFFER, env: process.env,
    });
    const out = stdout.toString().trim();
    return out ? JSON.parse(out) : {};
  };

  const tasks = wanted.map((svc) => async () => {
    try {
      await DISCOVERERS[svc]({ run: makeRun(), region, add: (p) => proposals.push(p) });
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

  return { proposals, log, errors };
}
