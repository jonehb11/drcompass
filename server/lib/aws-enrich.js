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
import { awsCliFound } from './aws-discovery.js';

const execFile = promisify(execFileCb);
const AWS_TIMEOUT = 30000;
const MAX_BUFFER = 32 * 1024 * 1024;
const CONCURRENCY = 3;

export const NODE_TYPES = [
  'security-group', 'subnet', 'vpc', 'route-table', 'nacl', 'availability-zone',
  'iam-role', 'iam-policy', 'instance-profile', 'target-group', 'listener',
  'load-balancer', 'kms-key', 'secret', 'log-group', 'alarm', 'sns-topic',
  'certificate', 'dns-record', 'hosted-zone', 'nodegroup', 'addon',
  'oidc-provider', 'db-subnet-group', 'parameter-group', 'vpc-endpoint',
  'nat-gateway', 'internet-gateway', 'elastic-ip', 'launch-template',
  'repository', 'bucket-policy', 'queue-policy', 'tag-match', 'other',
];
export const RELATIONS = [
  'secured-by', 'in-subnet', 'in-az', 'member-of', 'assumes-role', 'has-policy',
  'routes-to', 'targets', 'listens-on', 'encrypted-by', 'logs-to', 'alarmed-by',
  'resolves-to', 'uses', 'contains', 'tagged-match',
];

// ---------------------------------------------------------------- utils

function shortErr(e) {
  if (e && e.code === 'ENOENT') return 'aws binary not found';
  if (e && (e.killed || e.signal === 'SIGTERM')) return `timed out after ${AWS_TIMEOUT / 1000}s`;
  const stderr = ((e && e.stderr) || '').toString().trim().split('\n').slice(-3).join(' ');
  return (stderr || (e && e.message) || 'unknown error').slice(0, 300);
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
    if (keys.length > 15) for (const k of keys.slice(15)) delete n.details[k];
    return n;
  }
  function addEdge(from, to, relation) {
    if (!from || !to || from === to) return;
    const k = `${from}|${to}|${relation}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, relation });
  }
  return { nodes, edges, addNode, addEdge };
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
//     wantSg(id), wantSubnet(id), wantRole(arn) }
// addNode here attributes the component id automatically.

const COLLECTORS = {

  async elbv2(ctx) {
    const { LoadBalancers = [] } = await ctx.run(['elbv2', 'describe-load-balancers']);
    const lb = bestMatch(LoadBalancers, (l) => l.LoadBalancerName, ctx.toks);
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
        ctx.addNode(rid, 'listener', 'ELB', `${l.Protocol}:${l.Port}`, {
          arn: l.ListenerArn, details: { protocol: l.Protocol, port: l.Port },
        });
        ctx.addEdge(lbRid, rid, 'listens-on');
        const cert = (l.Certificates || [])[0];
        if (cert && cert.CertificateArn) {
          const crid = ridFromArn(cert.CertificateArn);
          ctx.addNode(crid, 'certificate', 'ACM', crid.split('/').pop(), { arn: cert.CertificateArn });
          ctx.addEdge(rid, crid, 'uses');
        }
      }
    } catch (e) { ctx.softErr('elbv2 listeners', e); }
    try {
      const { TargetGroups = [] } = await ctx.run(['elbv2', 'describe-target-groups', '--load-balancer-arn', lb.LoadBalancerArn]);
      for (const tg of TargetGroups.slice(0, 10)) {
        const rid = ridFromArn(tg.TargetGroupArn);
        ctx.addNode(rid, 'target-group', 'ELB', tg.TargetGroupName, {
          arn: tg.TargetGroupArn,
          details: {
            protocol: tg.Protocol, port: tg.Port, targetType: tg.TargetType,
            healthCheckPath: tg.HealthCheckPath || '', healthCheckPort: tg.HealthCheckPort,
          },
        });
        ctx.addEdge(lbRid, rid, 'targets');
        if (tg.VpcId) ctx.addEdge(rid, tg.VpcId, 'member-of');
        try {
          const { TargetHealthDescriptions = [] } = await ctx.run(['elbv2', 'describe-target-health', '--target-group-arn', tg.TargetGroupArn]);
          const healthy = TargetHealthDescriptions.filter((t) => t.TargetHealth && t.TargetHealth.State === 'healthy').length;
          ctx.addNode(rid, 'target-group', 'ELB', tg.TargetGroupName, {
            details: { healthyTargets: healthy, totalTargets: TargetHealthDescriptions.length },
          });
        } catch (e) { ctx.softErr('elbv2 target-health', e); }
      }
    } catch (e) { ctx.softErr('elbv2 target-groups', e); }
  },

  async eks(ctx) {
    const { clusters = [] } = await ctx.run(['eks', 'list-clusters']);
    let name = bestMatch(clusters.map((n) => ({ n })), (x) => x.n, ctx.toks);
    name = name ? name.n : (clusters.length === 1 ? clusters[0] : null);
    if (!name) return;
    ctx.found();
    const { cluster: cl = {} } = await ctx.run(['eks', 'describe-cluster', '--name', name]);
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
      for (const a of addons.slice(0, 15)) {
        const rid = `eks/addon/${name}/${a}`;
        ctx.addNode(rid, 'addon', 'EKS', a);
        ctx.addEdge(ctx.cid, rid, 'contains');
      }
    } catch (e) { ctx.softErr('eks addons', e); }
  },

  async rds(ctx) {
    let matched = false;
    try {
      const { DBClusters = [] } = await ctx.run(['rds', 'describe-db-clusters']);
      const c = bestMatch(DBClusters, (x) => x.DBClusterIdentifier, ctx.toks);
      if (c) {
        matched = true;
        ctx.found();
        const rid = `rds/cluster/${c.DBClusterIdentifier}`;
        ctx.addNode(rid, 'other', 'RDS', c.DBClusterIdentifier, {
          arn: c.DBClusterArn || '', tags: tagsOf(c.TagList),
          details: {
            engine: `${c.Engine || ''} ${c.EngineVersion || ''}`.trim(),
            multiAZ: !!c.MultiAZ, encrypted: !!c.StorageEncrypted,
            iamDatabaseAuthentication: !!c.IAMDatabaseAuthenticationEnabled,
            members: (c.DBClusterMembers || []).length, status: c.Status,
          },
        });
        ctx.addEdge(ctx.cid, rid, 'uses');
        for (const sg of c.VpcSecurityGroups || []) {
          if (!sg.VpcSecurityGroupId) continue;
          ctx.wantSg(sg.VpcSecurityGroupId);
          ctx.addNode(sg.VpcSecurityGroupId, 'security-group', 'EC2', sg.VpcSecurityGroupId);
          ctx.addEdge(ctx.cid, sg.VpcSecurityGroupId, 'secured-by');
        }
        if (c.DBSubnetGroup) await rdsSubnetGroup(ctx, c.DBSubnetGroup);
        if (c.DBClusterParameterGroup) {
          const pg = `rds/pg/${c.DBClusterParameterGroup}`;
          ctx.addNode(pg, 'parameter-group', 'RDS', c.DBClusterParameterGroup);
          ctx.addEdge(ctx.cid, pg, 'uses');
        }
        if (c.KmsKeyId) {
          const k = ridFromArn(c.KmsKeyId);
          ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: c.KmsKeyId.startsWith('arn:') ? c.KmsKeyId : '' });
          ctx.addEdge(ctx.cid, k, 'encrypted-by');
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
    // standalone instance fallback
    const { DBInstances = [] } = await ctx.run(['rds', 'describe-db-instances']);
    const i = bestMatch(DBInstances.filter((x) => !x.DBClusterIdentifier), (x) => x.DBInstanceIdentifier, ctx.toks);
    if (!i) return;
    ctx.found();
    const rid = `rds/instance/${i.DBInstanceIdentifier}`;
    ctx.addNode(rid, 'other', 'RDS', i.DBInstanceIdentifier, {
      arn: i.DBInstanceArn || '', tags: tagsOf(i.TagList),
      details: {
        engine: `${i.Engine || ''} ${i.EngineVersion || ''}`.trim(),
        class: i.DBInstanceClass, multiAZ: !!i.MultiAZ, encrypted: !!i.StorageEncrypted,
      },
    });
    ctx.addEdge(ctx.cid, rid, 'uses');
    for (const sg of i.VpcSecurityGroups || []) {
      if (!sg.VpcSecurityGroupId) continue;
      ctx.wantSg(sg.VpcSecurityGroupId);
      ctx.addNode(sg.VpcSecurityGroupId, 'security-group', 'EC2', sg.VpcSecurityGroupId);
      ctx.addEdge(ctx.cid, sg.VpcSecurityGroupId, 'secured-by');
    }
    if (i.DBSubnetGroup && i.DBSubnetGroup.DBSubnetGroupName) await rdsSubnetGroup(ctx, i.DBSubnetGroup.DBSubnetGroupName);
    if (i.KmsKeyId) {
      const k = ridFromArn(i.KmsKeyId);
      ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop());
      ctx.addEdge(ctx.cid, k, 'encrypted-by');
    }
  },

  async elasticache(ctx) {
    let cacheClusterIds = [];
    try {
      const { ReplicationGroups = [] } = await ctx.run(['elasticache', 'describe-replication-groups']);
      const rg = bestMatch(ReplicationGroups, (x) => `${x.ReplicationGroupId} ${x.Description || ''}`, ctx.toks);
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
      const { CacheClusters = [] } = await ctx.run(['elasticache', 'describe-cache-clusters']);
      const c = bestMatch(CacheClusters, (x) => x.CacheClusterId, ctx.toks);
      if (!c) return;
      ctx.found();
      cacheClusterIds = [c.CacheClusterId];
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
    const { Functions = [] } = await ctx.run(['lambda', 'list-functions']);
    const f = bestMatch(Functions, (x) => x.FunctionName, ctx.toks);
    if (!f) return;
    ctx.found();
    const cfg = await ctx.run(['lambda', 'get-function-configuration', '--function-name', f.FunctionName]);
    const rid = `lambda/${cfg.FunctionName}`;
    ctx.addNode(rid, 'other', 'Lambda', cfg.FunctionName, {
      arn: cfg.FunctionArn || '',
      details: {
        runtime: cfg.Runtime, memoryMB: cfg.MemorySize, timeoutSec: cfg.Timeout,
        layers: (cfg.Layers || []).length,
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
    if (cfg.KMSKeyArn) {
      const k = ridFromArn(cfg.KMSKeyArn);
      ctx.addNode(k, 'kms-key', 'KMS', k.split('/').pop(), { arn: cfg.KMSKeyArn });
      ctx.addEdge(ctx.cid, k, 'encrypted-by');
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
    const { QueueUrls = [] } = await ctx.run(['sqs', 'list-queues']);
    const matched = allMatches(QueueUrls.map((u) => ({ url: u, name: u.split('/').pop() })), (q) => q.name, ctx.toks, 5);
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
    const { Buckets = [] } = await ctx.run(['s3api', 'list-buckets']);
    const matched = allMatches(Buckets, (b) => b.Name, ctx.toks, 3);
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
    try {
      const { items = [] } = await ctx.run(['apigateway', 'get-rest-apis']);
      const api = bestMatch(items, (a) => a.name, ctx.toks);
      if (api) {
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
    try {
      const v2 = await ctx.run(['apigatewayv2', 'get-apis']);
      const api = bestMatch(v2.Items || [], (a) => a.Name, ctx.toks);
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
    for (const s of (ctx.c.secrets || []).slice(0, 10)) {
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
          ctx.addNode(rrid, 'dns-record', 'Route 53', name, {
            details: {
              type: rec.Type,
              alias: rec.AliasTarget ? rec.AliasTarget.DNSName : '',
              values: (rec.ResourceRecords || []).length,
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
  if (/\b(elb|nlb|alb)\b|load-?balancer/.test(kind) || has('elb')) picks.add('elbv2');
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

async function deepSecurityGroups(run, g, sgIds, errors) {
  const ids = [...sgIds].slice(0, 100);
  for (const batch of chunk(ids, 50)) {
    try {
      const { SecurityGroups = [] } = await run(['ec2', 'describe-security-groups', '--group-ids', ...batch]);
      for (const sg of SecurityGroups) {
        g.addNode(sg.GroupId, 'security-group', 'EC2', sg.GroupName || sg.GroupId, {
          tags: tagsOf(sg.Tags),
          details: {
            inboundRules: (sg.IpPermissions || []).length,
            outboundRules: (sg.IpPermissionsEgress || []).length,
            vpc: sg.VpcId || '',
          },
        });
        if (sg.VpcId) {
          g.addNode(sg.VpcId, 'vpc', 'EC2', sg.VpcId);
          g.addEdge(sg.GroupId, sg.VpcId, 'member-of');
        }
      }
    } catch (e) { errors.push(`sg-deep: ${shortErr(e)}`); }
  }
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
          details: { cidr: s.CidrBlock, az: s.AvailabilityZone, vpc: s.VpcId || '' },
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
    } catch (e) { errors.push(`subnet-deep: ${shortErr(e)}`); }
  }
  try {
    const { RouteTables = [] } = await run(['ec2', 'describe-route-tables', '--filters', `Name=association.subnet-id,Values=${ids.join(',')}`]);
    for (const rt of RouteTables) {
      g.addNode(rt.RouteTableId, 'route-table', 'EC2', (tagsOf(rt.Tags) || {}).Name || rt.RouteTableId, {
        tags: tagsOf(rt.Tags), details: { routes: (rt.Routes || []).length },
      });
      for (const a of rt.Associations || []) {
        if (a.SubnetId && subnetIds.has(a.SubnetId)) g.addEdge(a.SubnetId, rt.RouteTableId, 'routes-to');
      }
    }
  } catch (e) { errors.push(`route-table-deep: ${shortErr(e)}`); }
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
        details: { trust: [...principals].slice(0, 5).join(', ') },
      });
    } catch (e) { errors.push(`iam get-role(${roleName}): ${shortErr(e)}`); }
    try {
      const { AttachedPolicies = [] } = await run(['iam', 'list-attached-role-policies', '--role-name', roleName], { global: true });
      for (const p of AttachedPolicies.slice(0, 15)) {
        const prid = ridFromArn(p.PolicyArn);
        g.addNode(prid, 'iam-policy', 'IAM', p.PolicyName, { arn: p.PolicyArn });
        g.addEdge(rid, prid, 'has-policy');
      }
    } catch (e) { errors.push(`iam role-policies(${roleName}): ${shortErr(e)}`); }
  }
}

async function deepVpcs(run, g, errors) {
  const vpcIds = Object.values(g.nodes).filter((n) => n.type === 'vpc').map((n) => n.rid).slice(0, 20);
  if (!vpcIds.length) return;
  try {
    const { Vpcs = [] } = await run(['ec2', 'describe-vpcs', '--vpc-ids', ...vpcIds]);
    for (const v of Vpcs) {
      const name = (tagsOf(v.Tags) || {}).Name || v.VpcId;
      g.addNode(v.VpcId, 'vpc', 'EC2', name, { tags: tagsOf(v.Tags), details: { cidr: v.CidrBlock } });
    }
  } catch (e) { errors.push(`vpc-deep: ${shortErr(e)}`); }
}

// ---------------------------------------------------------------- runners

function makeRunner({ region, profile, log }) {
  const useProfile = profile && profile !== 'default' ? profile : '';
  return async function run(args, { global: isGlobal = false } = {}) {
    const full = [...args, '--output', 'json', '--no-cli-pager'];
    if (!isGlobal && region) full.push('--region', region);
    if (useProfile) full.push('--profile', useProfile);
    log.push(`aws ${full.join(' ')}`);
    const { stdout } = await execFile('aws', full, { timeout: AWS_TIMEOUT, maxBuffer: MAX_BUFFER, env: process.env });
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

// enrichComponents({slug, componentIds, profile, region})
//   -> { nodes, edges, perComponent, log, errors }
// Callers merge into the stored graph with mergeGraph() and save.
export async function enrichComponents({ slug, componentIds = [], profile = '', region = '' } = {}) {
  const log = []; const errors = [];
  const g = makeGraphBuilder(region);
  const perComponent = [];
  const empty = { nodes: g.nodes, edges: g.edges, perComponent, log, errors };
  if (!(await awsCliFound())) { errors.push('AWS CLI not found — install awscli and configure a profile'); return empty; }
  if (!region) { errors.push('A region is required (e.g. us-east-1)'); return empty; }

  const all = store.getCollection(slug, 'components');
  const targets = componentIds.length
    ? all.filter((c) => componentIds.includes(c.id))
    : all.filter((c) => (c.awsServices || []).length);
  for (const id of componentIds) {
    if (!all.some((c) => c.id === id)) errors.push(`unknown component id: ${id}`);
  }

  const run = makeRunner({ region, profile, log });
  const pendingSgs = new Set(); const pendingSubnets = new Set(); const pendingRoles = new Set();

  const tasks = targets.map((c) => async () => {
    const toks = componentTokens(c);
    let found = false;
    const before = new Set(Object.keys(g.nodes).filter((rid) => g.nodes[rid].componentIds.includes(c.id)));
    const ctx = {
      run, region, c, cid: c.id, toks,
      found: () => { found = true; },
      softErr: (what, e) => errors.push(`${c.id}/${what}: ${shortErr(e)}`),
      addNode: (rid, type, service, name, opts = {}) => g.addNode(rid, type, service, name, { ...opts, componentId: c.id }),
      addEdge: g.addEdge,
      wantSg: (id) => { if (id) pendingSgs.add(id); },
      wantSubnet: (id) => { if (id) pendingSubnets.add(id); },
      wantRole: (arn) => { if (arn) pendingRoles.add(arn); },
    };
    for (const name of pickCollectors(c)) {
      try { await COLLECTORS[name](ctx); } catch (e) { errors.push(`${c.id}/${name}: ${shortErr(e)}`); }
    }
    const nodeCount = Object.values(g.nodes)
      .filter((n) => n.componentIds.includes(c.id) && !before.has(n.rid)).length;
    perComponent.push({ componentId: c.id, found, nodes: nodeCount });
  });
  await withConcurrency(tasks);

  // Deep association walks over everything collected anywhere.
  if (pendingSgs.size) await deepSecurityGroups(run, g, pendingSgs, errors);
  if (pendingSubnets.size) await deepSubnets(run, g, pendingSubnets, errors);
  if (pendingRoles.size) await deepRoles(run, g, pendingRoles, errors);
  await deepVpcs(run, g, errors);

  return { nodes: g.nodes, edges: g.edges, perComponent, log, errors };
}

// enrichByTag({slug, profile, region, tagKey, tagValue})
//   -> { nodes, edges, perComponent, log, errors }
// Uses the Resource Groups Tagging API; each found resource becomes a node,
// linked to the best-matching component with a tagged-match edge (unlinked
// but visible when nothing matches well enough).
export async function enrichByTag({ slug, profile = '', region = '', tagKey = '', tagValue = '' } = {}) {
  const log = []; const errors = [];
  const g = makeGraphBuilder(region);
  const perComponent = [];
  const empty = { nodes: g.nodes, edges: g.edges, perComponent, log, errors };
  if (!(await awsCliFound())) { errors.push('AWS CLI not found — install awscli and configure a profile'); return empty; }
  if (!region) { errors.push('A region is required (e.g. us-east-1)'); return empty; }
  if (!tagKey || !tagValue) { errors.push('tagKey and tagValue are required'); return empty; }

  const components = store.getCollection(slug, 'components');
  const compToks = components.map((c) => ({ id: c.id, toks: componentTokens(c) }));
  const run = makeRunner({ region, profile, log });
  const perComp = new Map();

  let token = '';
  for (let page = 0; page < 3; page++) {
    const args = ['resourcegroupstaggingapi', 'get-resources',
      '--tag-filters', `Key=${tagKey},Values=${tagValue}`, '--max-items', '100'];
    if (token) args.push('--starting-token', token);
    let res;
    try { res = await run(args); } catch (e) { errors.push(`tagging-api: ${shortErr(e)}`); break; }
    for (const r of res.ResourceTagMappingList || []) {
      const arn = r.ResourceARN || '';
      const rid = ridFromArn(arn);
      if (!rid) continue;
      const tags = tagsOf(r.Tags);
      const name = tags.Name || rid.split(/[:/]/).pop();
      const node = g.addNode(rid, typeFromArn(arn), serviceFromArn(arn), name, {
        arn, tags, source: 'aws-enrich-tag', details: { matchedTag: `${tagKey}=${tagValue}` },
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
    }
    token = res.NextToken || '';
    if (!token) break;
  }
  for (const [componentId, nodes] of perComp) perComponent.push({ componentId, found: true, nodes });
  return { nodes: g.nodes, edges: g.edges, perComponent, log, errors };
}
