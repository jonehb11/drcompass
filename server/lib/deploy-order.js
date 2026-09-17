// Deployment / Recovery ORDER ENGINE.
//
// Answers the question an operator asks at 3am: "what do I bring up first, what
// can I do in parallel, and what is this thing waiting for?"
//
// The output is WAVES. Wave N contains everything whose prerequisites are all
// satisfied by waves 0..N-1, so a wave is a parallel batch and every wave
// boundary is a natural gate. Each item carries `waitsFor[]` — the real reason
// it cannot go earlier, in words an operator can act on.
//
// Everything here is PURE: computeDeployOrder(input) -> result, no I/O, no
// clock, no randomness. Same input (in any array order) -> identical output.
//
// ---------------------------------------------------------------------------
// HOW ORDER IS DECIDED — three sources, every edge tagged with provenance
// ---------------------------------------------------------------------------
//  (a) `component.dependsOn`      — the operator's own declaration. HARD, 1.0.
//  (b) resource-graph `relation`  — interpreted directionally per RELATION_RULES
//                                   below (each one reasoned about explicitly).
//  (c) the Kubernetes snapshot    — namespace -> serviceaccount/secret/configmap
//                                   /PVC -> workload -> service -> ingress, plus
//                                   what a pod MOUNTS and what it CALLS at
//                                   start-up. This is the part that decides
//                                   whether a pod comes up or CrashLoops.
//  (d) the TIER LADDER            — a SOFT floor derived from resource type. It
//                                   can only ever DELAY an item; it never
//                                   reorders anything past a real prerequisite.
//
// A note on honesty: where it is genuinely unclear whether X needs Y first, the
// edge is emitted with a lower `confidence` and a `why` that says what is
// unknown. Low-confidence edges are still enforced (so the order is safe) but
// they are the first things offered as a cycle break, and the UI can show them
// as "verify this".
//
// ---------------------------------------------------------------------------
// THE TIER LADDER (14 tiers) and WHY each one sits where it does
// ---------------------------------------------------------------------------
//  0  Account & guardrails        Organizations/SCPs, account settings, and
//                                 EXTERNAL PRECONDITIONS (a partner allowlist,
//                                 an approved static egress IP, credentials
//                                 valid in the recovery region). These are not
//                                 deployed — they are confirmed, and their lead
//                                 time is days, so they belong before wave 1.
//  1  Identity & encryption       IAM roles/policies/instance profiles, OIDC
//                                 providers, KMS keys. Everything else
//                                 references these, and an encrypted store
//                                 cannot be CREATED before its key exists.
//  2  Network foundation          VPC -> subnets -> IGW/NAT/EIP -> route tables
//                                 -> NACLs -> VPC endpoints -> security groups.
//                                 An SG needs its VPC; an SG rule that
//                                 references another SG needs that SG.
//  3  Certificates & DNS zones    ACM certs and hosted zones. A listener or CDN
//                                 distribution cannot reference a certificate
//                                 that does not exist yet, and DNS validation
//                                 has real lead time — so pre-provision.
//  4  Registries & artifacts      ECR repositories. No image in the recovery
//                                 region, no pod. Ever.
//  5  Secrets & parameters        Secrets Manager secrets, SSM parameters. The
//                                 single most common cause of a failed recovery
//                                 test, and the failure mode is an opaque
//                                 container error rather than "missing secret".
//  6  Data stores                 S3/EFS, DB subnet groups -> parameter groups
//                                 -> clusters -> instances, ElastiCache,
//                                 DynamoDB, SQS/SNS/Kinesis/MSK. Stateful, slow,
//                                 and every workload connects to one on boot.
//  7  Compute platform            EKS cluster -> CNI/kube-proxy addons ->
//                                 nodegroups -> remaining addons; ECS clusters;
//                                 launch templates/ASGs.
//  8  Cluster bootstrap           Namespaces -> service accounts -> secrets/
//                                 configmaps -> storage classes/PVCs -> CRDs and
//                                 controllers (ingress controller, cert-manager,
//                                 external-secrets, mesh). These MUST precede
//                                 workloads: an admission webhook that is not
//                                 Ready blocks pod admission.
//  9  Applications                Deployments/StatefulSets/DaemonSets/CronJobs,
//                                 ECS services, Lambdas. A StatefulSet only
//                                 after its PVCs are Bound.
// 10  Service exposure            Target groups -> load balancers -> listeners;
//                                 K8s Services -> Ingress. None of these has a
//                                 healthy backend until the pods are READY.
// 11  Edge & traffic management    API Gateway, CloudFront/CDN, WAF.
// 12  Verification & success bar   The functional business transaction, partner
//                                 end-to-end checks, alarms.
// 13  Live traffic cutover         Route 53 record flips, CDN origin switch,
//                                 ARC routing controls. Game-day only.
//
// Tier -> restore layer (the app's L0..L7 vocabulary, kept identical to
// server/routes/service.js so the workbook, diagrams and runbooks agree):
//   0->L0 1->L0 2->L2 3->L0 4->L1 5->L3 6->L3 7->L2 8->L2 9->L4 10->L5 11->L5
//   12->L6 13->L7
// The SOFT FLOOR uses layerRank(tier's layer), NOT the tier index: 8 floors
// instead of 14 keeps genuine parallelism (a lone S3 bucket is not pushed behind
// six tiers it has nothing to do with) while still producing the coarse
// "identity -> network -> data -> platform -> apps -> exposure -> cutover"
// reading the owner asked for.

// --------------------------------------------------------------- vocabulary

export const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
export const LAYER_LABEL = {
  L0: 'Guardrails & backups green',
  L1: 'Recovery launch & replication',
  L2: 'Platform — cluster, nodes, mesh',
  L3: 'Data & secrets',
  L4: 'Applications',
  L5: 'Edge & network reachability',
  L6: 'Functional success bar',
  L7: 'Live traffic cutover',
};
export const layerRank = (l) => {
  const i = LAYER_ORDER.indexOf(String(l || ''));
  return i < 0 ? 99 : i;
};

export const TIERS = [
  { tier: 0, name: 'Account & guardrails', layer: 'L0', why: 'account-level settings and external preconditions (partner allowlists, approved egress IPs, valid credentials) have lead times measured in days — they are confirmed before anything is deployed' },
  { tier: 1, name: 'Identity & encryption', layer: 'L0', why: 'every other resource references a role or a key, and an encrypted store cannot be created before its KMS key exists' },
  { tier: 2, name: 'Network foundation', layer: 'L2', why: 'nothing can be placed in a VPC that does not exist; security groups need the VPC, and rules that reference other groups need those groups' },
  { tier: 3, name: 'Certificates & DNS zones', layer: 'L0', why: 'listeners, API Gateway domains and CDN distributions reference a certificate by ARN, and DNS-validated issuance has real lead time' },
  { tier: 4, name: 'Registries & artifacts', layer: 'L1', why: 'no image in the recovery region means no pod — image availability is a precondition of every workload' },
  { tier: 5, name: 'Secrets & parameters', layer: 'L3', why: 'workloads read secrets and parameters at start-up; a missing one surfaces as an opaque container error, not as "missing secret"' },
  { tier: 6, name: 'Data stores', layer: 'L3', why: 'stateful, slow to restore, and connected to on boot — subnet groups and parameter groups first, then clusters, then instances' },
  { tier: 7, name: 'Compute platform', layer: 'L2', why: 'the cluster must exist before any Kubernetes object; CNI and kube-proxy before nodes can become Ready; nodegroups before anything can be scheduled' },
  { tier: 8, name: 'Cluster bootstrap', layer: 'L2', why: 'namespaces, service accounts, secrets/configmaps, storage classes and controllers must precede workloads — an admission webhook that is not Ready blocks pod admission' },
  { tier: 9, name: 'Applications', layer: 'L4', why: 'a workload can only start once everything it mounts, pulls and calls at start-up is there' },
  { tier: 10, name: 'Service exposure', layer: 'L5', why: 'target groups, load balancers, Services and Ingress have no healthy backend until the pods behind them pass readiness' },
  { tier: 11, name: 'Edge & traffic management', layer: 'L5', why: 'the front door (API Gateway, CDN, WAF) is pointed at an origin that already answers' },
  { tier: 12, name: 'Verification & success bar', layer: 'L6', why: 'a real business transaction end to end, plus the partner checks and alarms that only make sense once the stack answers' },
  { tier: 13, name: 'Live traffic cutover', layer: 'L7', why: 'DNS flips, CDN origin switches and routing controls put real users on the recovery region — last, and only once the success bar is met' },
];
const TIER_BY_N = new Map(TIERS.map((t) => [t.tier, t]));
const tierInfo = (n) => TIER_BY_N.get(n) || TIERS[TIERS.length - 1];
const tierFloor = (n) => layerRank(tierInfo(n).layer);

export const CATEGORY_LABEL = {
  compute: 'Compute',
  networking: 'Networking',
  storage: 'Storage',
  database: 'Database',
  'messaging-streaming': 'Messaging & streaming',
  'security-secrets': 'Security & secrets',
  'edge-dns': 'Edge & DNS',
  'identity-access': 'Identity & access',
  observability: 'Observability',
  'third-party': 'Third party',
  'cicd-control-plane': 'CI/CD & control plane',
  other: 'Other',
};
const CATEGORIES = Object.keys(CATEGORY_LABEL);
const cat = (c) => (CATEGORIES.includes(c) ? c : 'other');

// --------------------------------------------------------------- tiny helpers

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const lower = (v) => str(v).toLowerCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniq = (xs) => [...new Set(xs)];
const clip = (s, n) => (str(s).length > n ? `${str(s).slice(0, n - 1)}…` : str(s));
const slug = (s) => lower(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';

// --------------------------------------------------------- relation semantics
//
// The resource graph's `relation` vocabulary (server/lib/aws-enrich.js RELATIONS)
// is an ASSOCIATION vocabulary, not an ordering one — so each relation needs an
// explicit reading. `prereq` says which endpoint must exist FIRST:
//   'to'     -> the edge target is the prerequisite (from waits for to)
//   'from'   -> the edge source is the prerequisite (to waits for from)
//   'ladder' -> the relation carries no inherent direction (`uses`, `contains`);
//               resolve it with the tier ladder — the lower (tier, rank) endpoint
//               is the prerequisite. Documented per case below.

export const RELATION_RULES = {
  'secured-by': {
    prereq: 'to', confidence: 0.95, kind: 'hard',
    why: (p) => `needs security group / NACL ${p} to exist first — you cannot attach a group that has not been created, and a rule that references another group needs that group`,
  },
  'in-subnet': {
    prereq: 'to', confidence: 0.95, kind: 'hard',
    why: (p) => `is placed in subnet ${p}, so the subnet must exist first`,
  },
  'in-az': {
    prereq: 'to', confidence: 0.5, kind: 'soft', skipIfNotDeployable: true,
    why: (p) => `sits in availability zone ${p}`,
  },
  'member-of': {
    prereq: 'to', confidence: 0.9, kind: 'hard',
    why: (p) => `belongs to ${p}, which has to exist before it can be created inside it`,
  },
  'assumes-role': {
    prereq: 'to', confidence: 0.95, kind: 'hard',
    why: (p) => `assumes IAM role ${p} — the role (and its trust policy) must exist before anything can assume it`,
  },
  'has-policy': {
    prereq: 'to', confidence: 0.85, kind: 'hard',
    why: (p) => `attaches policy ${p}; the policy document must exist before it can be attached`,
  },
  'routes-to': {
    prereq: 'to', confidence: 0.85, kind: 'hard',
    // A route's TARGET must exist before the route is written... except when the
    // "target" is itself the routing construct: a route-table association needs
    // the subnet, and a Gateway VPC endpoint is created WITH the route-table ids.
    exceptions: { 'route-table': 'from', 'vpc-endpoint': 'from' },
    why: (p) => `routes traffic to ${p}, which must exist before the route can be written`,
    whyReversed: (p) => `${p} is written into this routing construct, so this side is created first`,
  },
  targets: {
    prereq: 'to', confidence: 0.8, kind: 'hard',
    why: (p) => `forwards to target group ${p} — create the target group before the listener that forwards to it (creating it before the load balancer is harmless and keeps the listener step unblocked)`,
  },
  'listens-on': {
    prereq: 'from', confidence: 0.95, kind: 'hard',
    why: (p) => `is a listener on ${p}; a listener cannot be created before its load balancer`,
  },
  'encrypted-by': {
    prereq: 'to', confidence: 0.95, kind: 'hard',
    why: (p) => `is encrypted with ${p} — an encrypted resource cannot be CREATED before its key exists in the region`,
  },
  'logs-to': {
    prereq: 'to', confidence: 0.45, kind: 'soft',
    why: (p) => `writes to log group ${p}. Soft: log groups are normally auto-created on first write, so this only matters when you need a set retention or a customer-managed key`,
  },
  'alarmed-by': {
    prereq: 'from', confidence: 0.7, kind: 'soft',
    why: (p) => `is the alarm on ${p} — created after the thing it watches, so the rebuild does not page anyone and the alarm has a real metric to evaluate`,
  },
  'resolves-to': {
    prereq: 'to', confidence: 0.9, kind: 'hard',
    why: (p) => `resolves to ${p}, which must already answer before DNS points at it`,
  },
  uses: {
    prereq: 'ladder', confidence: 0.85, reversedConfidence: 0.7, kind: 'hard',
    // `uses` is the catch-all association and appears in BOTH directions in real
    // graphs: "listener uses certificate" (cert first) but also "bucket uses
    // bucket-policy" (bucket first). The tier ladder settles it.
    why: (p) => `uses ${p}, which has to exist first`,
    whyReversed: (p) => `${p} is attached to this resource, so this resource is created first`,
  },
  contains: {
    prereq: 'ladder', ladderDefault: 'from', confidence: 0.9, reversedConfidence: 0.8, kind: 'hard',
    // Containment usually means the container comes first ("VPC contains IGW",
    // "cluster contains nodegroup") — but not when the contained thing is
    // foundational: a DB subnet group is BUILT FROM existing subnets, an
    // instance profile is built from an existing role, and a hosted zone
    // pre-exists the record flip that "contains" it.
    why: (p) => `is created inside ${p}`,
    whyReversed: (p) => `is built from ${p}, which must already exist`,
  },
  'tagged-match': {
    prereq: 'to', confidence: 0.4, kind: 'soft',
    why: (p) => `was correlated to ${p} by a tag scan. Soft: a tag match is a guess, not a declared dependency — confirm it in Discover`,
  },
};

// ------------------------------------------------- type -> tier / rank / category
//
// `rank` orders items WITHIN a tier (used for within-wave sorting and to resolve
// `ladder` relations). Lower = earlier.

const NOT_DEPLOYABLE = {
  'availability-zone': 'an availability zone is a property of the region, not something you deploy — the subnets placed in it are what you create',
};

const NODE_TYPE_RULES = {
  // ---- tier 1: identity & encryption
  'kms-key': { tier: 1, rank: 0, category: 'security-secrets' },
  'oidc-provider': { tier: 1, rank: 5, category: 'identity-access' },
  'iam-policy': { tier: 1, rank: 10, category: 'identity-access' },
  'iam-role': { tier: 1, rank: 20, category: 'identity-access' },
  'instance-profile': { tier: 1, rank: 30, category: 'identity-access' },
  // ---- tier 2: network foundation
  vpc: { tier: 2, rank: 0, category: 'networking' },
  'elastic-ip': { tier: 2, rank: 5, category: 'networking' },
  subnet: { tier: 2, rank: 10, category: 'networking' },
  'internet-gateway': { tier: 2, rank: 15, category: 'networking' },
  'nat-gateway': { tier: 2, rank: 20, category: 'networking' },
  'route-table': { tier: 2, rank: 25, category: 'networking' },
  nacl: { tier: 2, rank: 30, category: 'networking' },
  'vpc-endpoint': { tier: 2, rank: 35, category: 'networking' },
  'security-group': { tier: 2, rank: 40, category: 'networking' },
  // ---- tier 3: certificates & zones
  certificate: { tier: 3, rank: 0, category: 'security-secrets' },
  'hosted-zone': { tier: 3, rank: 10, category: 'edge-dns' },
  // ---- tier 4: registries
  repository: { tier: 4, rank: 0, category: 'cicd-control-plane' },
  // ---- tier 5: secrets
  secret: { tier: 5, rank: 0, category: 'security-secrets' },
  // ---- tier 6: data stores + their prerequisites
  'db-subnet-group': { tier: 6, rank: 0, category: 'database' },
  'parameter-group': { tier: 6, rank: 5, category: 'database' },
  'log-group': { tier: 6, rank: 20, category: 'observability' },
  'bucket-policy': { tier: 6, rank: 30, category: 'storage' },
  'queue-policy': { tier: 6, rank: 30, category: 'messaging-streaming' },
  'sns-topic': { tier: 6, rank: 15, category: 'messaging-streaming' },
  // ---- tier 7: compute platform
  'launch-template': { tier: 7, rank: 5, category: 'compute' },
  addon: { tier: 7, rank: 10, category: 'compute' },
  nodegroup: { tier: 7, rank: 20, category: 'compute' },
  // ---- tier 10: exposure
  'target-group': { tier: 10, rank: 0, category: 'networking' },
  'load-balancer': { tier: 10, rank: 10, category: 'networking' },
  listener: { tier: 10, rank: 20, category: 'networking' },
  // ---- tier 12: verification wiring
  alarm: { tier: 12, rank: 30, category: 'observability' },
  // ---- tier 13: cutover
  'dns-record': { tier: 13, rank: 0, category: 'edge-dns' },
};

// `type: 'other'` is used by aws-enrich for the resources that matter most
// (EKS control plane, RDS clusters, queues, buckets, Lambdas, APIs) — their rid
// prefix is a stable, documented shape, so key off that.
const RID_RULES = [
  [/^eks\/cluster\//, { tier: 7, rank: 0, category: 'compute', kind: 'eks-cluster' }],
  [/^rds\/global\//, { tier: 6, rank: 8, category: 'database', kind: 'rds-global-cluster' }],
  [/^rds\/cluster\//, { tier: 6, rank: 10, category: 'database', kind: 'rds-cluster' }],
  [/^rds\/instance\//, { tier: 6, rank: 12, category: 'database', kind: 'rds-instance' }],
  [/^elasticache\//, { tier: 6, rank: 14, category: 'database', kind: 'elasticache' }],
  [/^cachesubnet\//, { tier: 6, rank: 0, category: 'database', kind: 'cache-subnet-group' }],
  [/^sqs\//, { tier: 6, rank: 16, category: 'messaging-streaming', kind: 'sqs-queue' }],
  [/^sns\//, { tier: 6, rank: 15, category: 'messaging-streaming', kind: 'sns-topic' }],
  [/^s3\//, { tier: 6, rank: 18, category: 'storage', kind: 's3-bucket' }],
  [/^kinesis\//, { tier: 6, rank: 22, category: 'messaging-streaming', kind: 'kinesis-stream' }],
  [/^dynamodb\//, { tier: 6, rank: 20, category: 'database', kind: 'dynamodb-table' }],
  [/^efs\//, { tier: 6, rank: 6, category: 'storage', kind: 'efs-file-system' }],
  [/^lambda\//, { tier: 9, rank: 20, category: 'compute', kind: 'lambda-function' }],
  [/^apigw\/vpclink\//, { tier: 11, rank: 5, category: 'edge-dns', kind: 'apigw-vpc-link' }],
  [/^apigw\//, { tier: 11, rank: 10, category: 'edge-dns', kind: 'api-gateway' }],
  [/^ecs\/cluster\//, { tier: 7, rank: 2, category: 'compute', kind: 'ecs-cluster' }],
  [/^ecs\/service\//, { tier: 9, rank: 15, category: 'compute', kind: 'ecs-service' }],
  [/^transfer\//, { tier: 6, rank: 26, category: 'storage', kind: 'transfer-server' }],
];

// Component `kind` is free text in practice, so match on normalized substrings.
//
// The value space is genuinely OPEN, and that is why each rule below lists the
// SPELLINGS rather than one canonical id. Five producers write this field and
// none of them agree:
//   aws-discovery.js   eks-cluster, elb, ec2-asg, sqs, aurora-postgres,
//                      rds-<engine>, elasticache-<engine>, transfer-family, …
//   aws-enrich.js      the tag-correlation path emits a SECOND vocabulary for
//                      the same resources: rds-cluster, rds-instance, elasticache
//   arpio-client.js    `String(type).toLowerCase()`, which for an ARN-derived
//                      row is the bare ARN SERVICE SEGMENT — elasticloadbalancing,
//                      secretsmanager, apigateway, elasticfilesystem — plus
//                      k8s-namespace for a grouped Kubernetes namespace
//   ai-bridge.js       whatever the model writes
//   the Inventory editor, which is a free-text input
// So `elb` (every ALB and NLB this product discovers) used to miss the load
// balancer rule and land in the NETWORK FOUNDATION tier — i.e. the plan told an
// operator to create the load balancer in the same wave as the VPC, before its
// own subnets and security group. Match every spelling, and see
// CATEGORY_FALLBACK below for what happens when nothing matches.
const COMPONENT_KIND_RULES = [
  [/^eks-cluster|^eks$|kubernetes-cluster/, { tier: 7, rank: 0, category: 'compute' }],
  [/^ecs-cluster/, { tier: 7, rank: 2, category: 'compute' }],
  // EC2 instances, Auto Scaling groups and launch templates are the compute
  // PLATFORM (tier 7), not applications: something is scheduled onto them.
  [/^ec2$|^ec2-|^asg$|auto-?scaling|launch-template/, { tier: 7, rank: 5, category: 'compute' }],
  // `k8s-namespace` is arpio-client's grouping of a whole protected namespace —
  // an application-layer object (its own restoreLayer is L4), not a bootstrap one.
  [/eks-workload|k8s-workload|k8s-namespace|^workload$|deployment|statefulset|daemonset/, { tier: 9, rank: 10, category: 'compute' }],
  [/ecs-service|fargate/, { tier: 9, rank: 15, category: 'compute' }],
  [/lambda|step-function/, { tier: 9, rank: 20, category: 'compute' }],
  [/aurora|^rds|postgres|mysql|mariadb|oracle|sqlserver|database|documentdb|^docdb|neptune|redshift/, { tier: 6, rank: 10, category: 'database' }],
  [/elasticache|redis|memcached|valkey/, { tier: 6, rank: 14, category: 'database' }],
  [/dynamodb/, { tier: 6, rank: 20, category: 'database' }],
  [/opensearch|elasticsearch/, { tier: 6, rank: 21, category: 'database' }],
  [/^s3$|bucket|object-store/, { tier: 6, rank: 18, category: 'storage' }],
  [/^efs|elasticfilesystem|filesystem|file-system|fsx/, { tier: 6, rank: 6, category: 'storage' }],
  [/^sqs|queue/, { tier: 6, rank: 16, category: 'messaging-streaming' }],
  [/^sns|topic/, { tier: 6, rank: 15, category: 'messaging-streaming' }],
  [/kinesis|firehose/, { tier: 6, rank: 22, category: 'messaging-streaming' }],
  [/msk|kafka/, { tier: 6, rank: 24, category: 'messaging-streaming' }],
  [/sftp|^transfer$|transfer-family|transfer-server/, { tier: 6, rank: 26, category: 'storage' }],
  [/secrets-manager|secretsmanager|^secrets|ssm-parameter|parameter-store|^ssm$/, { tier: 5, rank: 0, category: 'security-secrets' }],
  [/^kms|encryption-key/, { tier: 1, rank: 0, category: 'security-secrets' }],
  [/^iam|oidc|identity/, { tier: 1, rank: 20, category: 'identity-access' }],
  [/^acm|certificate/, { tier: 3, rank: 0, category: 'security-secrets' }],
  [/^ecr|registry|artifact/, { tier: 4, rank: 0, category: 'cicd-control-plane' }],
  [/^vpc|subnet|transit-gateway|direct-connect/, { tier: 2, rank: 0, category: 'networking' }],
  // EVERY load-balancer spelling this product can emit or a human can type:
  // aws-discovery's `elb`, the Arpio/ARN `elasticloadbalancing`, the API's
  // `elbv2`, the console's alb/nlb/gwlb/clb, and the written-out forms. A load
  // balancer is SERVICE EXPOSURE (tier 10): it needs its VPC, its subnets, its
  // security group and its target group first, and it has no healthy backend
  // until the pods behind it are Ready.
  [/^elbv?2?$|^alb$|^nlb$|^gwlb$|^clb$|load-?balancer|load_balancer|elasticloadbalancing|target-?group/, { tier: 10, rank: 10, category: 'networking' }],
  [/api-gateway|^apigw|^apigateway/, { tier: 11, rank: 10, category: 'edge-dns' }],
  [/^waf|shield/, { tier: 11, rank: 0, category: 'edge-dns' }],
  [/cloudfront|^cdn/, { tier: 13, rank: 5, category: 'edge-dns' }],
  [/route53|route-53|^dns/, { tier: 13, rank: 10, category: 'edge-dns' }],
  [/observability|monitoring|prometheus|grafana|logging/, { tier: 8, rank: 40, category: 'observability' }],
  [/^external$|third-party|partner|saas|on-prem/, { tier: 0, rank: 10, category: 'third-party' }],
];

// Where an UNRECOGNISED kind lands. This is the dangerous half of the table, so
// it is deliberately pessimistic rather than plausible.
//
// A fall-through carries NO evidence that the item is foundational — all we know
// is its category. Landing early therefore produces a positively wrong
// instruction ("create the load balancer before the VPC's subnets"), while
// landing late produces at worst an unnecessary wait: anything that genuinely
// needs an unrecognised item has a `dependsOn` or a resource-graph edge, and a
// real prerequisite always beats the tier floor. So each entry is the LATEST
// tier its category occupies in the table above — with two deliberate stops,
// noted inline, where the later tier is a GATE rather than a parking space —
// ranked last within that tier. Every item placed this way carries an
// "unrecognised kind" note and sets `unrecognised: true`, so the wave, the
// runbook step and the diagram can all repeat it instead of the warning being
// buried inside the item where the journey found it.
const CATEGORY_FALLBACK = {
  'identity-access': { tier: 1, rank: 90 },       // the table has identity at 1 only
  'security-secrets': { tier: 5, rank: 90 },      // 1 (kms) → 3 (acm) → 5 (secrets)
  // networking spans tier 2 (VPC/subnets/SGs) to tier 10 (LBs, listeners) — the
  // widest spread in the ladder, and the one the `elb` bug fell through.
  networking: { tier: 10, rank: 90 },
  storage: { tier: 6, rank: 90 },
  database: { tier: 6, rank: 90 },
  'messaging-streaming': { tier: 6, rank: 90 },
  compute: { tier: 9, rank: 90 },                 // 7 (clusters, EC2) → 9 (workloads)
  // STOP 1: edge-dns also occupies tier 13, but 13 is the LIVE TRAFFIC CUTOVER —
  // a deliberate, game-day-only gate, not somewhere to park something unknown.
  // An unrecognised edge component belongs with the front door, at 11.
  'edge-dns': { tier: 11, rank: 90 },
  // STOP 2: same reasoning for 12 (Verification & success bar). Tier 8 is where
  // every recognised observability component lands, and an observability stack
  // you cannot identify is still something you want up DURING the recovery, not
  // after the success bar it is supposed to help you evaluate.
  observability: { tier: 8, rank: 90 },
  'third-party': { tier: 0, rank: 90 },
  'cicd-control-plane': { tier: 4, rank: 90 },
  other: { tier: 6, rank: 90 },
};

// ---- Kubernetes ----------------------------------------------------------

const K8S_KIND_RULES = {
  Namespace: { tier: 8, rank: 0, category: 'compute' },
  StorageClass: { tier: 8, rank: 5, category: 'storage' },
  ServiceAccount: { tier: 8, rank: 10, category: 'identity-access' },
  Secret: { tier: 8, rank: 15, category: 'security-secrets' },
  ConfigMap: { tier: 8, rank: 20, category: 'security-secrets' },
  PersistentVolumeClaim: { tier: 8, rank: 30, category: 'storage' },
  Service: { tier: 10, rank: 30, category: 'networking' },
  Ingress: { tier: 10, rank: 40, category: 'networking' },
  HorizontalPodAutoscaler: { tier: 10, rank: 50, category: 'compute' },
};

// Cluster-bootstrap workloads: things OTHER pods depend on. Each carries the
// reason it must be Ready first, because that reason is what the operator needs.
const CONTROLLER_RULES = [
  { re: /kube-proxy/, role: 'networking', rank: 32, why: 'kube-proxy programs service routing on every node; without it in-cluster Service addresses do not work' },
  { re: /coredns|kube-dns/, role: 'cluster-dns', rank: 33, why: 'in-cluster DNS — every start-up connection made by name (including to AWS endpoints) depends on it resolving' },
  { re: /ebs-csi|efs-csi|csi-(driver|node|controller)/, role: 'storage-driver', rank: 34, why: 'binds PersistentVolumeClaims; a StatefulSet stays Pending until the CSI driver is running' },
  { re: /karpenter|cluster-autoscaler/, role: 'node-provisioner', rank: 35, why: 'provides schedulable capacity beyond the static nodegroups; without it pods can sit Pending' },
  { re: /external-secrets|secrets-store-csi|sealed-secrets|vault/, role: 'secrets-controller', rank: 36, why: 'materializes Kubernetes Secrets from the external store — pods that mount those secrets cannot start until it has synced them' },
  { re: /cert-manager/, role: 'webhook', rank: 37, why: 'issues in-cluster certificates and runs a mutating/validating webhook; if it is not Ready, admission of the objects it guards fails' },
  { re: /istiod|istio-pilot|linkerd-(destination|identity|proxy-injector)/, role: 'mesh-webhook', rank: 38, why: 'the sidecar injector is a mutating admission webhook — if it is not Ready, pod admission in an injected namespace fails or the pod starts without its sidecar and cannot reach anything through the mesh' },
  { re: /kyverno|gatekeeper|opa-/, role: 'webhook', rank: 38, why: 'a policy admission webhook — a webhook that is not Ready rejects or blocks pod admission' },
  { re: /aws-load-balancer-controller|alb-ingress|ingress-nginx|nginx-ingress|traefik|haproxy-ingress|contour/, role: 'ingress-controller', rank: 39, why: 'provisions the load balancer behind every Ingress and LoadBalancer Service — without it they never get an address' },
  { re: /external-dns/, role: 'dns-controller', rank: 39, why: 'writes the DNS records for Ingress hosts' },
  { re: /metrics-server/, role: 'metrics', rank: 34, why: 'HorizontalPodAutoscalers have no metrics to scale on without it' },
];
const OBSERVABILITY_RE = /prometheus|grafana|loki|tempo|jaeger|otel|opentelemetry|fluent|fluentbit|datadog|newrelic|splunk|victoria|thanos|alertmanager/;

function classifyWorkload(w) {
  const name = lower(w.name);
  for (const c of CONTROLLER_RULES) {
    if (c.re.test(name)) return { role: c.role, tier: 8, rank: c.rank, category: 'compute', why: c.why };
  }
  if (OBSERVABILITY_RE.test(name)) {
    return { role: 'observability', tier: 9, rank: 40, category: 'observability', why: '' };
  }
  return { role: 'app', tier: 9, rank: lower(w.kind) === 'cronjob' ? 20 : 10, category: 'compute', why: '' };
}

// --------------------------------------------------- outbound call classification
//
// `startup` = the call blocks recovery (the pod will not become Ready without
// it). `runtime` = it has to work before the success bar, but it does not block
// bring-up. `unknown` = say so; never guess confidently.
//
// Rules are evaluated in order; the first match wins. Each one states the
// confidence it carries and why.

const STORE_PROTOCOL_RE = /^(postgres|postgresql|pgsql|mysql|mariadb|mssql|tds|oracle|tns|redis|rediss|memcached|mongodb|mongo|amqp|amqps|kafka|jdbc|odbc|grpc|thrift|cql|cassandra)\b/;
const STORE_TARGET_RE = /aurora|\brds\b|postgres|mysql|mariadb|oracle|database|\bdb\b|redis|cache|elasticache|memcached|\bsqs\b|queue|kinesis|stream|dynamo|kafka|\bmsk\b|mongo|cassandra|elasticsearch|opensearch/;
const SECRET_TARGET_RE = /secret|parameter|param store|ssm|credential|token|api[- ]?key|password|vault|keystore|certificate|\bkms\b/;
const STARTUP_PHRASE_RE = /at (pod )?start|at startup|on start|start-?up|on boot|at boot|\bboot\b|init\b|bootstrap|image pull|pulls? image|migration|schema|connection pool|leader election|service discovery|config(uration)? load/;
const RUNTIME_PHRASE_RE = /batch|nightly|daily|hourly|weekly|report|reporting|settlement|remittance file|file exchange|webhook|callback|notification|notify|alert|page(r|d)?\b|audit|analytics|telemetry|metric|\blog(s|ging)?\b|backup|archive|export|reconcil|invoice|billing|statement|end[- ]of[- ]day/;

export const CALL_WHEN_RULES = [
  'explicit-phrase   startup 0.9  — the recorded purpose says the call happens at pod start / on boot / on image pull',
  'secret-target     startup 0.85 — the call fetches credentials or parameters, which the process needs before it can serve',
  'store-protocol    startup 0.85 — a database/cache/broker wire protocol: the connection is opened when the process starts',
  'store-target      startup 0.8  — the target names a data store, cache, queue or stream, which workloads connect to on boot',
  'batch-phrase      runtime 0.7  — batch / reporting / settlement / webhook traffic does not run at start-up',
  'flow-low-volume   runtime 0.5  — seen only a handful of times in the flow import; observed traffic is not proof of a start-up dependency',
  'flow-observed     unknown 0.5  — flow data records that the call happens, but cannot distinguish start-up from steady state',
  'external-critical unknown 0.4  — a critical partner call: whether the pod opens it on boot depends on client behaviour; the allowlist is a pre-event precondition either way',
  'mounted-reference startup 0.75 — the workload mounts a Secret/ConfigMap named after this target, so its address or credentials are read at start-up',
  'critical-internal startup 0.55 — marked critical and in-cluster/AWS: leaning start-up, not proven',
  'default           unknown 0.3  — nothing in the recorded purpose, protocol or flow data says whether this is opened at start-up',
];

/**
 * classifyCall(component, call, {k8s}) -> {when, confidence, why, rule}
 * Pure; exported so the workbook and diagram modules classify identically.
 */
export function classifyCall(component, call, opts = {}) {
  const c = call || {};
  const type = lower(c.type) || 'internal';
  const external = type === 'third-party' || type === 'saas' || type === 'on-prem';
  const text = `${lower(c.target)} ${lower(c.purpose)} ${lower(c.failoverBehavior)}`;
  const protocol = lower(c.protocol);
  const observed = num(c.observedCount);
  const fromFlows = lower(c.source) === 'network-flows';
  const out = (rule, when, confidence, why) => ({ rule, when, confidence, why });

  if (STARTUP_PHRASE_RE.test(text)) {
    return out('explicit-phrase', 'startup', 0.9,
      `the recorded purpose ("${clip(c.purpose || c.failoverBehavior, 80)}") says this happens at start-up, so the target has to answer before the workload is Ready`);
  }
  if (SECRET_TARGET_RE.test(lower(c.target)) || SECRET_TARGET_RE.test(lower(c.purpose))) {
    return out('secret-target', 'startup', 0.85,
      'fetches credentials or parameters — the process cannot serve until it has them, and a missing one surfaces as an opaque container error');
  }
  if (STORE_PROTOCOL_RE.test(protocol)) {
    return out('store-protocol', 'startup', 0.85,
      `opens a ${c.protocol} connection, which clients establish when the process starts — the store must accept connections before the workload is Ready`);
  }
  if (STORE_TARGET_RE.test(lower(c.target))) {
    return out('store-target', 'startup', 0.8,
      'the target is a data store, cache, queue or stream; workloads connect to these on boot');
  }
  if (RUNTIME_PHRASE_RE.test(text)) {
    return out('batch-phrase', 'runtime', 0.7,
      'batch / reporting / file-exchange traffic: it does not run at start-up, so it does not block bring-up — but it still has to work before the functional success bar');
  }
  if (fromFlows && observed !== null && observed < 10) {
    return out('flow-low-volume', 'runtime', 0.5,
      `seen only ${observed} time(s) in the firewall/flow import — observed traffic is not proof of a start-up dependency`);
  }
  if (fromFlows) {
    return out('flow-observed', 'unknown', 0.5,
      `imported from flow data${observed !== null ? ` (${observed} flows)` : ''} — flow records show the call happens but cannot distinguish start-up from steady state`);
  }
  if (external && c.critical) {
    return out('external-critical', 'unknown', 0.4,
      'a critical partner/SaaS call: whether the pod opens it on boot depends on the client, but the allowlist / egress IP / credentials are a pre-event precondition either way');
  }
  const mounted = mountedNames(component, opts.k8s);
  const tgtSlug = slug(c.target);
  if (tgtSlug.length >= 4 && mounted.some((m) => m.includes(tgtSlug) || tgtSlug.includes(m))) {
    return out('mounted-reference', 'startup', 0.75,
      'the workload mounts a Secret/ConfigMap named after this target, so its address or credentials are read at start-up');
  }
  if (c.critical && !external) {
    return out('critical-internal', 'startup', 0.55,
      'marked critical and in-cluster/AWS, so leaning start-up — not proven; confirm whether the client connects on boot or lazily');
  }
  return out('default', 'unknown', 0.3,
    'nothing in the recorded purpose, protocol or flow data says whether this is opened at start-up — record it, because it decides whether the call blocks recovery');
}

// Slugged names of every Secret/ConfigMap the component's workloads mount.
function mountedNames(component, k8s) {
  if (!component || !k8s) return [];
  const out = [];
  for (const w of arr(k8s.workloads)) {
    if (str(w && w.componentId) !== str(component.id)) continue;
    for (const s of arr(w.secrets)) out.push(slug(s));
    for (const m of arr(w.configmaps)) out.push(slug(m));
  }
  return uniq(out).filter((x) => x.length >= 4);
}

// -------------------------------------------------- fuzzy target -> component
// Mirrors server/routes/service.js targetResolver() exactly, so "Kinesis claim
// stream" resolves to the same component on both pages.
function targetResolver(components) {
  const normalize = (s) => lower(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const index = [];
  for (const c of arr(components)) {
    const push = (key, score) => {
      const k = normalize(key);
      if (k.length >= 4) index.push({ id: c.id, key: k, score });
    };
    push(c.name, 3);
    push(c.kind, 2);
    for (const [i, s] of arr(c.awsServices).entries()) push(s, i === 0 ? 1.5 : 1);
  }
  index.sort((a, b) => byStr(a.id, b.id) || byStr(a.key, b.key));
  return (target, fromId) => {
    const t = normalize(target);
    if (!t) return null;
    let best = null;
    for (const cand of index) {
      if (cand.id === fromId) continue;
      const hit = t.includes(cand.key) || cand.key.includes(t);
      if (!hit) continue;
      const score = cand.score + (cand.key === t ? 2 : 0);
      if (!best || score > best.score || (score === best.score && cand.key.length > best.key.length)) {
        best = { ...cand, score };
      }
    }
    return best ? best.id : null;
  };
}

// --------------------------------------------------------------- item factory

const PRECONDITION_WORDING =
  "Must already be true in the recovery region before execution — verify, don't create.";

function makeItem(o) {
  const t = tierInfo(o.tier);
  const declared = str(o.declaredLayer);
  const layer = LAYER_ORDER.includes(o.layer) ? o.layer
    : (LAYER_ORDER.includes(declared) ? declared : t.layer);
  return {
    id: str(o.id),
    name: str(o.name) || str(o.id),
    kind: str(o.kind) || 'other',
    // The resource-graph vocabulary for the same thing ('load-balancer' where
    // `kind` is the component's free-text 'elb'), set when a component and its own
    // resource node are merged. It is what the derived check commands key on,
    // because it is the reading that came with an exact rid.
    resourceKind: str(o.resourceKind),
    // The AWS resource's own name ('payments-alb') as opposed to the component's
    // display name ('ALB — payments-alb'). Only the former is addressable.
    resourceName: str(o.resourceName),
    // Ports an external precondition is actually called on, taken from the
    // outbound calls that produced it — so its reachability check can be a real
    // `nc -vz host 443` instead of a `<port>` placeholder.
    probePorts: [],
    category: cat(o.category),
    source: o.source,                 // component | resource | k8s | external | synthetic
    componentId: str(o.componentId),
    rid: str(o.rid),
    uid: str(o.uid),
    arn: str(o.arn),
    // Who runs this at 3am. Inherited from the component's `owner`, falling back
    // to its `team`; '' means nobody has been named, which the runbook says out
    // loud rather than printing an empty cell.
    owner: str(o.owner),
    tier: o.tier,
    tierName: t.name,
    tierRank: o.rank === undefined ? 50 : o.rank,
    layer,
    tierLayer: t.layer,
    layerMismatch: !!declared && declared !== t.layer && !o.suppressLayerMismatch,
    wave: -1,
    action: o.action || 'deploy',
    readinessGate: false,
    inCycle: false,
    provenance: 'no-prerequisites',
    waitsFor: [],
    notes: arr(o.notes).filter(Boolean),
    estMinutes: null,
    verify: str(o.verify),
    verifyPass: str(o.verifyPass),
    // true when the kind/type was NOT in the rule table and the item was placed
    // by the conservative category fall-through. Surfaced on the wave and in the
    // runbook step, not just in `notes`.
    unrecognised: !!o.unrecognised,
    inRecoveryScope: str(o.inRecoveryScope) || '',
  };
}

function ruleForComponent(c) {
  const kind = lower(c.kind);
  for (const [re, rule] of COMPONENT_KIND_RULES) {
    if (re.test(kind)) return { ...rule, category: cat(c.category) || rule.category, matched: true };
  }
  const fb = CATEGORY_FALLBACK[cat(c.category)] || CATEGORY_FALLBACK.other;
  return { ...fb, category: cat(c.category), matched: false };
}

// The note an unmatched item carries. Says what was not recognised, where it was
// put, that the placement is conservative rather than derived, and what overrides
// it — so a reader can never mistake a fall-through for an answer.
function unrecognisedNote(what, value, rule, category) {
  const t = tierInfo(rule.tier);
  return `unrecognised ${what} "${value || '(none)'}" — it is not in the ordering rule table, so this item was placed CONSERVATIVELY at ${t.name} (tier ${rule.tier}, ${t.layer}), the latest tier its category (${category}) occupies, and ranked last within it. That is a placeholder, not a derived position: nothing here claims it belongs in this wave. A declared dependsOn or a resource-graph edge overrides it; give it a recognised ${what} to have it ordered properly.`;
}

function ruleForNode(n) {
  const type = str(n.type);
  const direct = NODE_TYPE_RULES[type];
  if (direct) return { ...direct, kind: type, matched: true };
  const rid = str(n.rid);
  for (const [re, rule] of RID_RULES) if (re.test(rid)) return { ...rule, matched: true };
  const d = n.details || {};
  if (d.queue) return { tier: 6, rank: 16, category: 'messaging-streaming', kind: 'sqs-queue', matched: true };
  if (d.bucket) return { tier: 6, rank: 18, category: 'storage', kind: 's3-bucket', matched: true };
  // Same reasoning as CATEGORY_FALLBACK: last within the data-store tier, and
  // loudly flagged. `type: 'other'` with an unknown rid prefix is genuinely
  // unknown — aws-enrich uses 'other' for the things that matter most, but every
  // rid shape it emits for them is in RID_RULES above.
  return { tier: 6, rank: 90, category: 'other', kind: type || 'other', matched: false };
}

// -------------------------------------------------------------- graph builder
//
// One place that accumulates items and edges, so provenance is uniform.

function newGraph() {
  const items = new Map();
  const edges = new Map();     // `${from}|${to}` -> edge
  const skipped = [];
  const add = (o) => {
    const prev = items.get(o.id);
    if (prev) {
      // merge notes only; the first definition of an item wins its tier/kind
      for (const n of arr(o.notes)) if (!prev.notes.includes(n)) prev.notes.push(n);
      return prev;
    }
    const it = makeItem(o);
    items.set(it.id, it);
    return it;
  };
  const link = (from, to, e) => {
    if (!from || !to || from === to) return null;
    const key = `${from}|${to}`;
    const next = {
      from, to,
      requires: e.requires || 'exists',
      provenance: e.provenance,
      confidence: Math.max(0, Math.min(1, e.confidence)),
      why: str(e.why),
      kind: e.kind === 'soft' ? 'soft' : 'hard',
      provenances: [e.provenance],
    };
    const prev = edges.get(key);
    if (!prev) { edges.set(key, next); return next; }
    // Keep the strongest reading; remember every provenance that agrees.
    const rank = { verified: 2, ready: 2, exists: 1 };
    const better = next.confidence > prev.confidence
      || (next.confidence === prev.confidence && (rank[next.requires] || 0) > (rank[prev.requires] || 0));
    const merged = better ? { ...next } : { ...prev };
    merged.provenances = uniq([...prev.provenances, e.provenance]).sort(byStr);
    if (!better && (rank[next.requires] || 0) > (rank[merged.requires] || 0)) {
      merged.requires = next.requires;
      merged.why = next.why;
    }
    edges.set(key, merged);
    return merged;
  };
  const skip = (reason) => skipped.push(reason);
  return { items, edges, add, link, skip, skipped };
}

// ============================================================ MODEL BUILDING

const RES = (rid) => `res:${rid}`;
const K8S = (ns, kind, name) => `k8s:${ns || '-'}/${kind}/${name}`;
const EXT = (target) => `ext:${slug(target)}`;
const FENCE = (cid) => `fence:${cid}`;
const WRITER_STORE_RE = /aurora|\brds\b|postgres|mysql|mariadb|oracle|sqlserver|documentdb|neptune/;

// ---- 1. inventory components ---------------------------------------------

function addComponents(g, components, notes) {
  const byId = new Map(components.map((c) => [c.id, c]));
  for (const c of components) {
    const rule = ruleForComponent(c);
    const external = cat(c.category) === 'third-party' || /^external$|third-party|partner|saas|on-prem/.test(lower(c.kind));
    const itemNotes = [];
    if (!rule.matched) {
      itemNotes.push(unrecognisedNote('kind', str(c.kind), rule, cat(c.category)));
    }
    if (external) {
      itemNotes.push(`${PRECONDITION_WORDING} This is a partner/SaaS dependency: confirm the allowlist, the approved egress IP and the credentials for the recovery region.`);
      if (str(c.restoreLayer) === 'L6') {
        itemNotes.push('declared L6 (functional success bar), but a verify-not-create precondition belongs at L5 or earlier — before the success bar, not as part of it');
      }
    }
    if (lower(c.inRecoveryScope) === 'no') {
      itemNotes.push('NOT in the recovery scope — it will not be there. Anything that waits on it cannot complete.');
    }
    g.add({
      id: c.id, name: c.name, kind: c.kind || 'component', category: rule.category,
      source: 'component', componentId: c.id, arn: c.arn,
      owner: str(c.owner) || str(c.team),
      tier: external ? 0 : rule.tier, rank: external ? 10 : rule.rank,
      declaredLayer: c.restoreLayer,
      suppressLayerMismatch: external,
      unrecognised: !rule.matched && !external,
      action: external ? 'verify' : 'deploy',
      verify: (c.verification && c.verification.command) || '',
      verifyPass: (c.verification && c.verification.pass) || '',
      inRecoveryScope: c.inRecoveryScope,
      notes: itemNotes,
    });
  }
  // dependsOn -> edges, and dangling ids reported (never silently dropped).
  const dangling = [];
  for (const c of components) {
    for (const d of arr(c.dependsOn).map(str)) {
      if (!d) continue;
      if (!byId.has(d)) { dangling.push({ from: c.id, fromName: c.name, missing: d }); continue; }
      const p = byId.get(d);
      const pRule = ruleForComponent(p);
      const stateful = pRule.tier >= 6 || ['compute', 'database', 'storage', 'messaging-streaming'].includes(cat(p.category));
      g.link(d, c.id, {
        requires: stateful ? 'ready' : 'exists',
        provenance: 'dependsOn', confidence: 1, kind: 'hard',
        why: `${c.name} declares a dependency on ${p.name} in the inventory${stateful ? ' — it must be up and answering, not merely created' : ''}`,
      });
      // Layer inversion: a prerequisite that sits at a HIGHER restore layer than
      // its consumer is an order the rest of the app would print and an operator
      // would follow. Flag it here rather than sorting it away.
      const pl = layerRank(p.restoreLayer); const cl = layerRank(c.restoreLayer);
      if (pl < 99 && cl < 99 && pl > cl) {
        const it = g.items.get(c.id);
        const note = `layer inversion: depends on ${p.name} (${p.restoreLayer}, later in the restore order) although ${c.name} is ${c.restoreLayer} — one of the two restore layers is wrong`;
        if (it && !it.notes.includes(note)) it.notes.push(note);
      }
    }
  }
  if (dangling.length) {
    notes.push(`${dangling.length} declared dependenc${dangling.length === 1 ? 'y' : 'ies'} point at component ids that no longer exist — listed in "unordered" (they are holes in the restore order, not absences).`);
  }
  return { byId, dangling };
}

// ---- 2. resource graph ----------------------------------------------------

function addResources(g, graph, components) {
  const nodes = (graph && typeof graph.nodes === 'object' && graph.nodes) || {};
  const rids = Object.keys(nodes).sort(byStr);
  const notDeployable = [];
  const flowTargets = [];
  const suppressedRids = new Set();
  const compIds = new Set(components.map((c) => c.id));
  const compById = new Map(components.map((c) => [str(c.id), c]));
  const ownerOf = (cids) => {
    for (const cid of arr(cids)) {
      const c = compById.get(str(cid));
      if (c && (str(c.owner) || str(c.team))) return str(c.owner) || str(c.team);
    }
    return '';
  };

  for (const rid of rids) {
    const n = nodes[rid] || {};
    // A network-flow import writes a `net_<target>` node for every EXTERNAL
    // outbound target it applies (server/lib/network-flows.js). That node and the
    // `ext:` precondition the same call produces are the SAME THING seen twice —
    // and the node, having type 'other' and an unknown rid prefix, used to land in
    // the data-store tier, so the plan told an operator to deploy an IP address as
    // a data store. It is not deployable by definition: you cannot create a
    // partner's endpoint, you can only confirm you can reach it. Keep the
    // precondition, drop the phantom deployable — and reconcile the two after the
    // call pass so nothing is dropped without being accounted for.
    if (str(n.source) === 'network-import' || /^net_/.test(rid)) {
      flowTargets.push({ rid, name: str(n.name) || rid, componentIds: arr(n.componentIds).map(str) });
      suppressedRids.add(rid);
      continue;
    }
    const why = NOT_DEPLOYABLE[str(n.type)];
    if (why) { notDeployable.push({ rid, node: n, reason: why }); continue; }
    if (str(n.type) === 'tag-match' && !arr(n.componentIds).length) {
      notDeployable.push({
        rid, node: n,
        reason: 'found by a tag scan and not linked to any inventory component — link it in Discover (or ignore it) and it will be ordered',
      });
      continue;
    }
    const rule = ruleForNode(n);
    const itemNotes = [];
    if (!rule.matched) itemNotes.push(unrecognisedNote('resource type', str(n.type), rule, 'other'));
    if (str(n.details && n.details.note)) itemNotes.push(str(n.details.note));
    if (str(n.type) === 'oidc-provider') {
      itemNotes.push('a recovered EKS cluster gets a NEW OIDC issuer URL — every IRSA role trust policy must name the recovery cluster\'s issuer before a pod can assume its role. This is the classic silent failure on a recovered cluster.');
    }
    if (str(n.type) === 'certificate') {
      itemNotes.push('certificates are regional: the recovery region needs its own issued certificate, and DNS-validated issuance has lead time');
    }
    if (str(n.type) === 'kms-key' && n.details && n.details.multiRegion === false) {
      itemNotes.push('single-region key: a resource encrypted with it cannot be created in the recovery region until an equivalent key exists there');
    }
    g.add({
      id: RES(rid), name: n.name || rid, kind: rule.kind || n.type || 'other',
      category: rule.category, source: 'resource', rid, arn: n.arn,
      componentId: arr(n.componentIds)[0] || '',
      owner: ownerOf(n.componentIds),
      tier: rule.tier,
      rank: str(n.type) === 'addon' ? addonRank(n) : rule.rank,
      unrecognised: !rule.matched,
      notes: itemNotes,
    });
  }

  const idOf = (endpoint) => {
    const e = str(endpoint);
    if (compIds.has(e)) return e;
    if (nodes[e]) return RES(e);
    return null;
  };

  const rawEdges = arr(graph && graph.edges)
    .filter((e) => e && str(e.from) && str(e.to))
    .map((e) => ({ from: str(e.from), to: str(e.to), relation: str(e.relation) }))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to) || byStr(a.relation, b.relation));

  for (const e of rawEdges) {
    const rule = RELATION_RULES[e.relation];
    if (!rule) { g.skip(`unknown relation "${e.relation}"`); continue; }
    if (suppressedRids.has(e.from) || suppressedRids.has(e.to)) {
      // One shared reason, not one per IP: these all say the same thing.
      g.skip('an edge into a network-flow endpoint — that endpoint is a precondition to verify, not a node to deploy');
      continue;
    }
    const fromId = idOf(e.from); const toId = idOf(e.to);
    if (!fromId || !toId) {
      const missing = !fromId ? e.from : e.to;
      g.skip(`edge endpoint "${missing}" is neither a component nor a graph node`);
      continue;
    }
    const a = g.items.get(fromId); const b = g.items.get(toId);
    if (!a || !b) { g.skip(`edge endpoint is not a deployable resource (${!a ? e.from : e.to})`); continue; }

    let prereqSide = rule.prereq;
    let confidence = rule.confidence;
    let reversed = false;
    if (rule.exceptions && rule.exceptions[b.kind] && rule.exceptions[b.kind] !== rule.prereq) {
      prereqSide = rule.exceptions[b.kind];
      reversed = true;
      confidence = rule.reversedConfidence || Math.max(0.6, rule.confidence - 0.1);
    }
    if (prereqSide === 'ladder') {
      // No inherent direction: the lower (tier, rank) endpoint is the prerequisite.
      const aKey = [a.tier, a.tierRank]; const bKey = [b.tier, b.tierRank];
      const bIsLower = bKey[0] < aKey[0] || (bKey[0] === aKey[0] && bKey[1] < aKey[1]);
      const dflt = rule.ladderDefault || 'to';
      const tie = bKey[0] === aKey[0] && bKey[1] === aKey[1];
      // A tie between a component and a resource node attributed to that same
      // component means the node IS the component's concrete realization (the EKS
      // control plane for the EKS component, say). The component goes first: it
      // carries the declared dependencies the resource actually needs.
      if (tie && a.source === 'component' && b.componentId === a.id) prereqSide = 'from';
      else if (tie && b.source === 'component' && a.componentId === b.id) prereqSide = 'to';
      else prereqSide = bIsLower ? 'to' : (tie ? dflt : 'from');
      if (prereqSide !== dflt) {
        reversed = true;
        confidence = rule.reversedConfidence || confidence;
      }
    }

    const prereq = prereqSide === 'to' ? b : a;
    const dependent = prereqSide === 'to' ? a : b;
    const whyFn = reversed && rule.whyReversed ? rule.whyReversed : rule.why;
    const label = prereqSide === 'to' ? b.name : a.name;
    g.link(prereq.id, dependent.id, {
      requires: rule.requires || 'exists',
      provenance: `graph:${e.relation}${reversed ? '(reversed)' : ''}`,
      confidence, kind: rule.kind,
      why: `${dependent.name} ${whyFn(label)}`,
    });
  }

  // Security groups: create-then-apply-rules is genuinely two phases, because a
  // rule that references a PEER group needs that group to already exist. The
  // resource graph records rule COUNTS but not the peer references, so model one
  // explicit "apply rules" gate per VPC and say what is unknown.
  const sgs = [...g.items.values()].filter((i) => i.kind === 'security-group');
  if (sgs.length > 1) {
    const vpcOf = (i) => str((nodes[i.rid] && nodes[i.rid].details && nodes[i.rid].details.vpc) || '');
    const groups = new Map();
    for (const sg of sgs) {
      const key = vpcOf(sg) || '_';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sg);
    }
    for (const key of [...groups.keys()].sort(byStr)) {
      const members = groups.get(key).sort((a, b) => byStr(a.id, b.id));
      if (members.length < 2) continue;
      const vpcName = key !== '_' && nodes[key] ? (nodes[key].name || key) : '';
      const gateId = `res:${key !== '_' ? key : 'all'}#sg-rules`;
      g.add({
        id: gateId,
        name: `Apply security-group rules${vpcName ? ` — ${vpcName}` : ''} (${members.length} groups)`,
        kind: 'security-group-rules', category: 'networking', source: 'synthetic',
        tier: 2, rank: 45,
        notes: [
          'separate from creating the groups: a rule that references a PEER security group cannot be applied until that group exists, so create every group first, then apply rules',
          'the resource graph records rule counts, not which groups each rule references — this gate is therefore conservative: it waits for every group in the VPC',
        ],
      });
      for (const sg of members) {
        g.link(sg.id, gateId, {
          requires: 'exists', provenance: 'rule:sg-two-phase', confidence: 0.85, kind: 'hard',
          why: `rules can only be applied once ${sg.name} exists (a rule that references it fails otherwise)`,
        });
      }
      // Anything protected by one of these groups needs the RULES, not just the group.
      for (const edge of [...g.edges.values()]) {
        if (!edge.provenance.startsWith('graph:secured-by')) continue;
        if (!members.some((m) => m.id === edge.from)) continue;
        g.link(gateId, edge.to, {
          requires: 'exists', provenance: 'rule:sg-two-phase', confidence: 0.7, kind: 'soft',
          why: 'its security-group rules must be applied, not just the groups created — a group with no ingress rule is a silent connectivity failure',
        });
      }
    }
  }

  return { nodes, notDeployable, flowTargets };
}

// Reconcile the network-flow endpoints that addResources() held back against the
// `ext:` preconditions the call pass produced. A flow-derived external target and
// its precondition are one thing, so the precondition absorbs the evidence and
// the deployable disappears. Anything that finds no precondition is an ORPHAN and
// is reported in `unordered` — the point is that nothing vanishes silently.
function reconcileFlowTargets(g, flowTargets, calls, notes) {
  if (!arr(flowTargets).length) return [];
  const byTarget = new Map();
  for (const c of arr(calls)) {
    if (!c.external || !c.externalPreconditionId) continue;
    byTarget.set(slug(c.target), c.externalPreconditionId);
  }
  const orphans = [];
  let matched = 0;
  for (const ft of flowTargets) {
    const id = byTarget.get(slug(ft.name)) || (g.items.has(EXT(ft.name)) ? EXT(ft.name) : '');
    const it = id ? g.items.get(id) : null;
    if (!it) { orphans.push(ft); continue; }
    matched += 1;
    const note = `the flow import also wrote this endpoint into the resource graph as "${ft.rid}". That node and this precondition are the same thing, so it is NOT scheduled as a second, deployable item — you cannot create a partner's endpoint, only confirm you can reach it.`;
    if (!it.notes.includes(note)) it.notes.push(note);
  }
  if (matched) {
    notes.push(`${matched} endpoint(s) imported from flow data appear once, as wave-0 preconditions to verify. The resource-graph node the import also wrote for each one is deliberately not scheduled: it is the same endpoint, and an IP address is not something you deploy.`);
  }
  return orphans;
}

// ---- 2b. one thing, one item ----------------------------------------------
//
// A discovered component and the resource-graph node for the SAME AWS resource
// used to be scheduled as two separate items, in different waves, with different
// prerequisites and different verify text: "create the load balancer" in wave 7
// and again in wave 8, and a DLQ's resource node a wave BEFORE the DLQ component.
// The engine called that cosmetic. It is not — it is two contradictory
// instructions in the artifact whose entire purpose is to be unambiguous.
//
// The test for "same thing" is the ARN, because an ARN is an identity, not a
// resemblance: aws-discovery records `component.arn`, aws-enrich records the same
// string on the node it builds for that resource, and nothing else in the graph
// shares it. That is deliberately strict:
//   - rollup components (the "S3 buckets (3)" proposal, "Secrets Manager (3
//     secrets)") carry no ARN and keep their three bucket/secret nodes as
//     separate items, which is correct — they really are several things;
//   - ASSOCIATION nodes (security groups, subnets, target groups, listeners,
//     KMS keys) have their own ARNs and are never merged, which is also correct
//     — they are separate things that have to be built separately;
//   - the seed workspace predates the `arn` field entirely, so nothing there
//     merges and its order is unchanged.
//
// The survivor is the COMPONENT item: it is the id the rest of the app links to
// (runbook steps, tests, gaps, the service page). It absorbs the node's rid,
// notes and prerequisites, and — if the node's own type rule places it LATER — the
// node's tier, so a merge can never move an item earlier than either reading did.
function mergeComponentResources(g, components) {
  const byArn = new Map();
  for (const it of g.items.values()) {
    if (it.source !== 'resource' || !it.arn) continue;
    if (!byArn.has(it.arn)) byArn.set(it.arn, []);
    byArn.get(it.arn).push(it);
  }
  const remap = new Map();
  const merged = [];
  for (const c of components) {
    const key = str(c.arn);
    if (!key) continue;
    const ci = g.items.get(str(c.id));
    if (!ci || ci.source !== 'component') continue;
    const cands = (byArn.get(key) || [])
      .filter((r) => !remap.has(r.id) && (!r.componentId || r.componentId === ci.id));
    if (cands.length !== 1) continue;              // ambiguous — leave both alone
    const r = cands[0];

    if (!ci.rid) ci.rid = r.rid;
    // Keep the node's own type reading alongside the component's free-text kind:
    // 'elb' says what a human typed, 'load-balancer' is what the engine can build
    // a `describe-load-balancers` check from.
    if (!ci.resourceKind) ci.resourceKind = r.kind;
    if (!ci.resourceName) ci.resourceName = r.name;
    for (const n of r.notes) if (!ci.notes.includes(n)) ci.notes.push(n);
    if (!ci.verify && r.verify) ci.verify = r.verify;
    if (!ci.owner && r.owner) ci.owner = r.owner;
    // Conservative tier: whichever of the two readings is LATER.
    if (r.tier > ci.tier || (r.tier === ci.tier && r.tierRank > ci.tierRank)) {
      if (r.tier !== ci.tier) {
        ci.notes.push(`tier taken from the discovered resource (${tierInfo(r.tier).name}) rather than from the component kind "${ci.kind}" (${tierInfo(ci.tier).name}) — the later of the two readings, so merging can never pull this earlier than it was`);
      }
      const t = tierInfo(r.tier);
      ci.tier = r.tier; ci.tierRank = r.tierRank;
      ci.tierName = t.name; ci.tierLayer = t.layer;
      if (!LAYER_ORDER.includes(str(c.restoreLayer))) ci.layer = t.layer;
      if (ci.action !== 'verify') {
        ci.layerMismatch = !!str(c.restoreLayer) && str(c.restoreLayer) !== t.layer;
      }
    }
    ci.notes.push(`discovered resource "${r.rid}" is this component (same ARN), so the two are ONE item here carrying the union of both sets of prerequisites — previously they were scheduled separately, in different waves, with different verify text`);
    remap.set(r.id, ci.id);
    merged.push({ componentId: ci.id, name: ci.name, rid: r.rid });
    g.items.delete(r.id);
  }
  if (!remap.size) return merged;

  // Re-point every edge at the survivor, dropping the self-edge the merge creates
  // (the component "waiting for" its own resource node) and re-merging any pair
  // that now collides, keeping the strongest reading exactly as g.link() does.
  const rank = { verified: 2, ready: 2, exists: 1 };
  const next = new Map();
  for (const e of [...g.edges.values()]) {
    const from = remap.get(e.from) || e.from;
    const to = remap.get(e.to) || e.to;
    if (from === to || !g.items.has(from) || !g.items.has(to)) continue;
    const key = `${from}|${to}`;
    const cand = { ...e, from, to };
    const prev = next.get(key);
    if (!prev) { next.set(key, cand); continue; }
    const better = cand.confidence > prev.confidence
      || (cand.confidence === prev.confidence && (rank[cand.requires] || 0) > (rank[prev.requires] || 0));
    const m = better ? { ...cand } : { ...prev };
    m.provenances = uniq([...arr(prev.provenances), ...arr(cand.provenances)]).sort(byStr);
    next.set(key, m);
  }
  g.edges.clear();
  for (const [k, v] of next) g.edges.set(k, v);
  return merged;
}

// vpc-cni and kube-proxy are DaemonSets the nodes need in order to become Ready;
// CoreDNS and the CSI drivers need schedulable nodes first.
function addonRank(n) {
  const name = lower(n.name || n.rid);
  if (/vpc-cni|kube-proxy/.test(name)) return 8;
  return 25;
}

// ---- 3. the Kubernetes snapshot -------------------------------------------
//
// This is where pod-startup ordering lives. A Deployment is NOT deployable just
// because the cluster exists: everything it MOUNTS (service account, secrets,
// configmaps, PVCs), everything it PULLS (the registry) and everything it CALLS
// on boot has to be there first, or the pod CrashLoops / stays Pending / lands
// in CreateContainerConfigError.

function addK8s(g, k8s, ctx) {
  const snap = k8s && typeof k8s === 'object' ? k8s : {};
  const workloads = arr(snap.workloads).filter((w) => w && str(w.uid)).slice().sort((a, b) => byStr(a.uid, b.uid));
  const out = { workloads: [], byUid: new Map(), byComponent: new Map(), present: false };
  const hasAny = workloads.length || arr(snap.namespaces).length;
  if (!hasAny) return out;
  out.present = true;

  const nsItem = (ns) => {
    if (!ns) return null;
    const id = K8S('-', 'Namespace', ns);
    g.add({
      id, name: ns, kind: 'k8s-Namespace', category: 'compute', source: 'k8s',
      ...K8S_KIND_RULES.Namespace,
      notes: [],
    });
    for (const cid of ctx.clusterComponentIds) {
      g.link(cid, id, {
        requires: 'ready', provenance: 'k8s:cluster', confidence: 1, kind: 'hard',
        why: `the cluster must be up and its API reachable before namespace ${ns} can be created`,
      });
    }
    return id;
  };
  for (const ns of arr(snap.namespaces).map((n) => str(n && n.name)).filter(Boolean).sort(byStr)) nsItem(ns);

  // ---- per-workload prerequisites
  for (const w of workloads) {
    const ns = str(w.namespace);
    const cls = classifyWorkload(w);
    const id = `k8s:${w.uid}`;
    const comp = ctx.byId.get(str(w.componentId)) || null;
    const notes = [];
    if (cls.role !== 'app' && cls.why) notes.push(cls.why);
    if (comp) notes.push(`the concrete Kubernetes object behind ${comp.name} — the component's declared dependencies apply to it`);
    const it = g.add({
      id, name: w.name || w.uid, kind: `k8s-${w.kind || 'Workload'}`,
      category: cls.category, source: 'k8s', uid: str(w.uid),
      componentId: str(w.componentId),
      owner: comp ? (str(comp.owner) || str(comp.team)) : '',
      tier: cls.tier, rank: cls.rank,
      declaredLayer: comp ? '' : '',
      inRecoveryScope: comp ? comp.inRecoveryScope : '',
      notes,
    });
    it.role = cls.role;
    out.workloads.push({ w, id, cls });
    out.byUid.set(str(w.uid), id);
    if (w.componentId) {
      if (!out.byComponent.has(str(w.componentId))) out.byComponent.set(str(w.componentId), []);
      out.byComponent.get(str(w.componentId)).push({ w, id, cls });
    }

    const nsId = nsItem(ns);
    if (nsId) {
      g.link(nsId, id, {
        requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard',
        why: `namespace ${ns} must exist before anything can be created in it`,
      });
    }
    // the component it implements
    if (comp) {
      g.link(comp.id, id, {
        requires: 'exists', provenance: 'k8s:component', confidence: 0.9, kind: 'hard',
        why: `everything ${comp.name} declares as a dependency has to be there before its pods start`,
      });
    }
    // service account (+ IRSA)
    const sa = str(w.serviceAccount);
    if (sa) {
      const saId = K8S(ns, 'ServiceAccount', sa);
      g.add({
        id: saId, name: `${sa} (${ns})`, kind: 'k8s-ServiceAccount', category: 'identity-access',
        source: 'k8s', ...K8S_KIND_RULES.ServiceAccount,
        notes: ['for IRSA, its eks.amazonaws.com/role-arn annotation must name a role whose trust policy accepts THIS cluster\'s OIDC issuer — a recovered cluster has a new issuer URL'],
      });
      if (nsId) {
        g.link(nsId, saId, {
          requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard',
          why: `namespace ${ns} must exist first`,
        });
      }
      g.link(saId, id, {
        requires: 'exists', provenance: 'k8s:service-account', confidence: 0.95, kind: 'hard',
        why: `runs as ServiceAccount ${sa}; a missing service account leaves the pod unable to start, and a missing IRSA annotation leaves it without AWS credentials`,
      });
    }
    // mounted secrets
    for (const s of arr(w.secrets).map(str).filter(Boolean).sort(byStr)) {
      const sid = K8S(ns, 'Secret', s);
      g.add({
        id: sid, name: `${s} (${ns})`, kind: 'k8s-Secret', category: 'security-secrets',
        source: 'k8s', ...K8S_KIND_RULES.Secret, notes: [],
      });
      if (nsId) g.link(nsId, sid, { requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard', why: `namespace ${ns} must exist first` });
      g.link(sid, id, {
        requires: 'exists', provenance: 'k8s:mounts-secret', confidence: 0.95, kind: 'hard',
        why: `reads Secret ${s} at start-up — a missing Secret leaves the pod in CreateContainerConfigError, which does not say "missing secret"`,
      });
    }
    // mounted configmaps
    for (const m of arr(w.configmaps).map(str).filter(Boolean).sort(byStr)) {
      const cid = K8S(ns, 'ConfigMap', m);
      g.add({
        id: cid, name: `${m} (${ns})`, kind: 'k8s-ConfigMap', category: 'security-secrets',
        source: 'k8s', ...K8S_KIND_RULES.ConfigMap, notes: [],
      });
      if (nsId) g.link(nsId, cid, { requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard', why: `namespace ${ns} must exist first` });
      g.link(cid, id, {
        requires: 'exists', provenance: 'k8s:mounts-configmap', confidence: 0.9, kind: 'hard',
        why: `reads ConfigMap ${m} at start-up (env or mounted file) — a missing key is a start-up failure, not a warning`,
      });
    }
    // images -> registry
    for (const img of arr(w.images).map(str).filter(Boolean).sort(byStr)) addImagePrereq(g, img, id, ctx);
  }

  // ---- PVCs and storage classes
  for (const p of arr(snap.pvcs).filter(Boolean).slice().sort((a, b) => byStr(`${a.namespace}/${a.name}`, `${b.namespace}/${b.name}`))) {
    const ns = str(p.namespace); const name = str(p.name);
    if (!name) continue;
    const pid = K8S(ns, 'PersistentVolumeClaim', name);
    g.add({
      id: pid, name: `${name} (${ns})`, kind: 'k8s-PersistentVolumeClaim', category: 'storage',
      source: 'k8s', ...K8S_KIND_RULES.PersistentVolumeClaim,
      notes: ['the claim must be Bound (its PersistentVolume and the backing EBS/EFS volume provisioned) before the pod that mounts it can start'],
    });
    const nsId = ns ? nsItem(ns) : null;
    if (nsId) g.link(nsId, pid, { requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard', why: `namespace ${ns} must exist first` });
    const sc = str(p.storageClass);
    if (sc) {
      const scId = K8S('-', 'StorageClass', sc);
      g.add({
        id: scId, name: sc, kind: 'k8s-StorageClass', category: 'storage', source: 'k8s',
        ...K8S_KIND_RULES.StorageClass,
        notes: ['a StorageClass is only useful once its CSI driver is running — without it every claim stays Pending'],
      });
      for (const cid of ctx.clusterComponentIds) {
        g.link(cid, scId, { requires: 'ready', provenance: 'k8s:cluster', confidence: 1, kind: 'hard', why: 'the cluster must exist before a StorageClass can be created' });
      }
      g.link(scId, pid, {
        requires: 'exists', provenance: 'k8s:storage-class', confidence: 0.85, kind: 'hard',
        why: `is provisioned through StorageClass ${sc}; the class (and its CSI driver) must exist before the claim can bind`,
      });
    }
    const boundId = out.byUid.get(str(p.boundTo));
    if (boundId) {
      g.link(pid, boundId, {
        requires: 'ready', provenance: 'k8s:pvc', confidence: 0.9, kind: 'hard',
        why: `mounts PersistentVolumeClaim ${name}, which must be Bound before the pod can start (a StatefulSet stays Pending otherwise)`,
      });
    }
  }

  // ---- Services (endpoints only exist once pods are READY)
  const svcId = (ns, name) => K8S(ns, 'Service', name);
  for (const s of arr(snap.services).filter(Boolean).slice().sort((a, b) => byStr(`${a.namespace}/${a.name}`, `${b.namespace}/${b.name}`))) {
    const ns = str(s.namespace); const name = str(s.name);
    if (!name) continue;
    const id = svcId(ns, name);
    const lbType = /loadbalancer/i.test(str(s.type));
    g.add({
      id, name: `${name} (${ns})`, kind: 'k8s-Service', category: 'networking', source: 'k8s',
      ...K8S_KIND_RULES.Service,
      notes: lbType ? ['a LoadBalancer Service asks the cloud controller for a real load balancer — it stays <pending> until the controller provisions one AND a pod passes readiness'] : [],
    });
    const nsId = ns ? nsItem(ns) : null;
    if (nsId) g.link(nsId, id, { requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard', why: `namespace ${ns} must exist first` });
    const targets = arr(s.targets).map(str).filter(Boolean);
    const resolved = targets.length ? targets : matchBySelector(snap, s);
    for (const t of resolved.sort(byStr)) {
      const wid = out.byUid.get(t);
      if (!wid) continue;
      const wname = g.items.get(wid) ? g.items.get(wid).name : t;
      g.link(wid, id, {
        requires: 'ready', provenance: 'k8s:selects-workload', confidence: 0.95, kind: 'hard',
        why: `waits for ${wname} pods to be Ready, not just created — a Service has no endpoints until a pod passes its readiness probe`,
      });
    }
    if (!resolved.length) {
      const it = g.items.get(id);
      if (it) it.notes.push('no workload in the snapshot matches this Service\'s selector — confirm what backs it, because a Service with no endpoints looks healthy and serves nothing');
    }
  }

  // ---- Ingress
  for (const ing of arr(snap.ingresses).filter(Boolean).slice().sort((a, b) => byStr(`${a.namespace}/${a.name}`, `${b.namespace}/${b.name}`))) {
    const ns = str(ing.namespace); const name = str(ing.name);
    if (!name) continue;
    const id = K8S(ns, 'Ingress', name);
    g.add({
      id, name: `${name} (${ns})`, kind: 'k8s-Ingress', category: 'networking', source: 'k8s',
      ...K8S_KIND_RULES.Ingress,
      notes: [
        `class "${str(ing.class) || '(none)'}": the controller for this class must be running, or the Ingress never gets an address`,
        ...(arr(ing.hosts).length ? [`hosts ${arr(ing.hosts).map(str).join(', ')} still need a DNS record and a regional certificate — those are separate, later steps`] : []),
      ],
    });
    const nsId = ns ? nsItem(ns) : null;
    if (nsId) g.link(nsId, id, { requires: 'exists', provenance: 'k8s:namespace', confidence: 1, kind: 'hard', why: `namespace ${ns} must exist first` });
    for (const b of arr(ing.backends).filter(Boolean)) {
      const bid = svcId(str(b.namespace) || ns, str(b.service));
      if (!g.items.has(bid)) continue;
      g.link(bid, id, {
        requires: 'ready', provenance: 'k8s:ingress-backend', confidence: 0.9, kind: 'hard',
        why: `routes to Service ${str(b.service)}, which must already have Ready endpoints or the target group registers nothing healthy`,
      });
    }
  }

  // ---- HPAs
  for (const h of arr(snap.hpas).filter(Boolean).slice().sort((a, b) => byStr(`${a.namespace}/${a.name}`, `${b.namespace}/${b.name}`))) {
    const ns = str(h.namespace); const name = str(h.name);
    if (!name) continue;
    const id = K8S(ns, 'HorizontalPodAutoscaler', name);
    g.add({
      id, name: `${name} (${ns})`, kind: 'k8s-HorizontalPodAutoscaler', category: 'compute',
      source: 'k8s', ...K8S_KIND_RULES.HorizontalPodAutoscaler,
      notes: [`min ${num(h.min) ?? '?'} / max ${num(h.max) ?? '?'} — check the recovery region can actually provide the max before you rely on it`],
    });
    const tid = out.byUid.get(str(h.target));
    if (tid) {
      g.link(tid, id, {
        requires: 'exists', provenance: 'k8s:hpa-target', confidence: 0.9, kind: 'hard',
        why: `scales ${g.items.get(tid).name}, which must exist before the autoscaler can target it`,
      });
    }
  }

  // ---- controllers gate the workloads that need them
  addControllerEdges(g, out, snap);
  return out;
}

// Selector match fallback when a Service has no explicit targets[].
function matchBySelector(snap, svc) {
  const sel = svc && typeof svc.selector === 'object' ? svc.selector : null;
  if (!sel || !Object.keys(sel).length) return [];
  const out = [];
  for (const w of arr(snap.workloads)) {
    if (str(w.namespace) !== str(svc.namespace)) continue;
    const labels = (w.labels && typeof w.labels === 'object') ? w.labels : {};
    if (Object.entries(sel).every(([k, v]) => str(labels[k]) === str(v))) out.push(str(w.uid));
  }
  return out;
}

// An image reference tells us which registry has to be there — and whether it is
// a registry you control (ECR in your account) or a public one you merely need
// egress to.
function addImagePrereq(g, image, workloadId, ctx) {
  const ref = image.replace(/@sha256:[0-9a-f]+$/i, '');
  const firstSeg = ref.split('/')[0];
  // No registry host at all means Docker Hub — a public registry you need egress to.
  const host = firstSeg.includes('.') || firstSeg.includes(':') ? firstSeg : 'docker.io';
  const path = ref.startsWith(`${host}/`) ? ref.slice(host.length + 1) : ref;
  const repoPath = path.replace(/:[^/:]+$/, '');
  const lastSeg = repoPath.split('/').pop() || repoPath;
  const wl = g.items.get(workloadId);

  const publicHost = /^(public\.ecr\.aws|docker\.io|registry-1\.docker\.io|quay\.io|ghcr\.io|gcr\.io|k8s\.gcr\.io|registry\.k8s\.io|mcr\.microsoft\.com)$/i.test(host);
  if (publicHost) {
    const id = EXT(host);
    g.add({
      id, name: host, kind: 'external-precondition', category: 'third-party', source: 'external',
      tier: 0, rank: 5, action: 'verify',
      notes: [
        `${PRECONDITION_WORDING} A public registry is not yours to deploy: the recovery region needs working egress (NAT or a VPC endpoint) and the image has to still be there.`,
        'a public image that is not mirrored into your own registry is a third-party dependency in the pod-start path',
      ],
    });
    g.link(id, workloadId, {
      requires: 'verified', provenance: 'k8s:image-registry', confidence: 0.8, kind: 'hard',
      why: `pulls ${clip(ref, 70)} from ${host} — without egress to that registry the pod fails ImagePullBackOff`,
    });
    return;
  }

  // Private registry: prefer the specific repository node, then the ECR component.
  let linked = false;
  for (const node of ctx.repoNodes) {
    const rn = lower(node.name || node.rid);
    const seg = lower(lastSeg);
    if (seg.length >= 4 && (rn.includes(seg) || (rn.split('/').pop() || '').length >= 4 && seg.includes(rn.split('/').pop()))) {
      g.link(RES(node.rid), workloadId, {
        requires: 'exists', provenance: 'k8s:image-registry', confidence: 0.7, kind: 'hard',
        why: `pulls images from repository ${node.name} — no image in the recovery region, no pod (matched by name, so confirm the tag exists there too)`,
      });
      linked = true;
      break;
    }
  }
  const hadRepo = linked;
  for (const cid of ctx.registryComponentIds) {
    g.link(cid, workloadId, {
      requires: 'exists', provenance: 'k8s:image-registry', confidence: hadRepo ? 0.6 : 0.75, kind: 'hard',
      why: `pulls ${clip(ref, 70)} — the registry must hold this image in the recovery region before the pod can start`,
    });
    linked = true;
  }
  if (wl && host) {
    wl.notes.push(`image host ${host}: confirm it resolves to the RECOVERY-region registry, not the primary one — a cross-region pull is a hidden dependency on the region you just lost`);
  }
  if (!linked && wl) {
    wl.notes.push(`pulls ${clip(ref, 70)} but no registry component or repository matched — the image source cannot be ordered; add the registry to the inventory`);
  }
}

// Controllers and platform agents that other pods depend on.
function addControllerEdges(g, out, snap) {
  const controllers = out.workloads.filter((x) => x.cls.tier === 8);
  if (!controllers.length) return;
  const apps = out.workloads.filter((x) => x.cls.role === 'app');
  const byRole = (role) => controllers.filter((c) => c.cls.role === role);

  for (const c of byRole('ingress-controller')) {
    for (const it of g.items.values()) {
      if (it.kind !== 'k8s-Ingress' && it.kind !== 'k8s-Service') continue;
      g.link(c.id, it.id, {
        requires: 'ready', provenance: 'k8s:controller', confidence: it.kind === 'k8s-Ingress' ? 0.9 : 0.5,
        kind: it.kind === 'k8s-Ingress' ? 'hard' : 'soft',
        why: it.kind === 'k8s-Ingress'
          ? `${c.w.name} provisions the load balancer for this Ingress — until it is Ready the Ingress has no address and nothing reaches the pods`
          : `${c.w.name} provisions load balancers for LoadBalancer-type Services. Soft: only LoadBalancer Services need it, and the snapshot does not always record the type`,
      });
    }
  }
  for (const c of byRole('cluster-dns')) {
    for (const a of apps) {
      g.link(c.id, a.id, {
        requires: 'ready', provenance: 'k8s:controller', confidence: 0.6, kind: 'soft',
        why: `${c.w.name} resolves in-cluster and AWS endpoint names; a pod that opens connections by name at start-up fails without DNS. Soft: a pod with no name lookups on boot does not need it`,
      });
    }
  }
  for (const c of [...byRole('mesh-webhook'), ...byRole('webhook')]) {
    for (const a of apps) {
      if (str(a.w.namespace) === str(c.w.namespace)) continue;
      g.link(c.id, a.id, {
        requires: 'ready', provenance: 'k8s:admission-webhook', confidence: 0.45, kind: 'soft',
        why: `${c.w.name} runs an admission webhook: if it is not Ready, pod admission can fail outright or the pod starts without its sidecar and cannot reach anything. Soft: the snapshot does not record which namespaces have injection enabled — verify`,
      });
    }
  }
  for (const c of byRole('secrets-controller')) {
    for (const a of apps) {
      if (!arr(a.w.secrets).length) continue;
      g.link(c.id, a.id, {
        requires: 'ready', provenance: 'k8s:controller', confidence: 0.7, kind: 'soft',
        why: `${c.w.name} materializes the Kubernetes Secrets this pod mounts from the external store — the pod cannot start until they have synced`,
      });
    }
  }
  for (const c of byRole('storage-driver')) {
    for (const it of g.items.values()) {
      if (it.kind !== 'k8s-PersistentVolumeClaim') continue;
      g.link(c.id, it.id, {
        requires: 'ready', provenance: 'k8s:controller', confidence: 0.8, kind: 'hard',
        why: `${c.w.name} provisions and attaches the volume — without it the claim stays Pending forever`,
      });
    }
  }
  for (const c of byRole('node-provisioner')) {
    for (const a of apps) {
      g.link(c.id, a.id, {
        requires: 'ready', provenance: 'k8s:controller', confidence: 0.4, kind: 'soft',
        why: `${c.w.name} provides schedulable capacity beyond the static nodegroups. Soft: only needed when the nodegroups cannot hold the workload — but that is exactly the situation in a scaled-down recovery region`,
      });
    }
  }
  // metrics-server gates HPAs
  for (const c of byRole('metrics')) {
    for (const it of g.items.values()) {
      if (it.kind !== 'k8s-HorizontalPodAutoscaler') continue;
      g.link(c.id, it.id, {
        requires: 'ready', provenance: 'k8s:controller', confidence: 0.8, kind: 'hard',
        why: `${c.w.name} supplies the metrics this autoscaler scales on`,
      });
    }
  }
  void snap;
}

// ---- 4. cross-links between the AWS graph and the cluster -----------------

function addCrossLinks(g, ctx, k8sOut) {
  const { nodes } = ctx;

  // IRSA chain: OIDC provider -> IAM role -> ServiceAccount -> pod.
  // The graph already gives OIDC -> role (`uses`) and role -> policy.
  const saItems = [...g.items.values()].filter((i) => i.kind === 'k8s-ServiceAccount').sort((a, b) => byStr(a.id, b.id));
  for (const rid of Object.keys(nodes).sort(byStr)) {
    const n = nodes[rid];
    if (!n || str(n.type) !== 'iam-role') continue;
    const declared = str(n.details && n.details.serviceAccount);   // "ns/name"
    let matched = null; let how = '';
    if (declared) {
      const want = `k8s:${declared.split('/')[0]}/ServiceAccount/${declared.split('/').slice(1).join('/')}`;
      matched = saItems.find((s) => s.id === want) || null;
      if (matched) how = 'exact';
    }
    if (!matched && arr(n.componentIds).length) {
      // Fall back to the component: the role is attributed to a component whose
      // workload has exactly one service account.
      const cands = [];
      for (const cid of arr(n.componentIds)) {
        for (const wl of (k8sOut.byComponent.get(str(cid)) || [])) {
          const sa = str(wl.w.serviceAccount);
          if (sa) cands.push(K8S(str(wl.w.namespace), 'ServiceAccount', sa));
        }
      }
      const unique = uniq(cands).sort(byStr);
      if (unique.length === 1 && g.items.has(unique[0])) {
        matched = g.items.get(unique[0]);
        how = 'component';
      }
    }
    if (!matched) continue;
    g.link(RES(rid), matched.id, {
      requires: 'exists',
      provenance: how === 'exact' ? 'k8s:irsa' : 'k8s:irsa-inferred',
      confidence: how === 'exact' ? 0.9 : 0.6, kind: 'hard',
      why: how === 'exact'
        ? `IRSA: ${matched.name} is annotated with role ${n.name}; the role and its OIDC trust must exist before a pod using this service account can get AWS credentials`
        : `IRSA: role ${n.name} is attributed to the same component as ${matched.name}, so it is probably the role this service account assumes — matched via the component, NOT by an exact namespace/serviceaccount match, so verify the annotation`,
    });
  }

  // Secrets Manager secret -> the Kubernetes Secret materialized from it.
  const k8sSecrets = [...g.items.values()].filter((i) => i.kind === 'k8s-Secret').sort((a, b) => byStr(a.id, b.id));
  for (const rid of Object.keys(nodes).sort(byStr)) {
    const n = nodes[rid];
    if (!n || str(n.type) !== 'secret') continue;
    const target = slug(n.name || rid.replace(/^secret\//, ''));
    if (target.length < 4) continue;
    for (const ks of k8sSecrets) {
      const kName = slug(str(ks.name).replace(/\s*\([^)]*\)\s*$/, ''));
      if (kName !== target) continue;
      g.link(RES(rid), ks.id, {
        requires: 'exists', provenance: 'k8s:external-secret', confidence: 0.7, kind: 'hard',
        why: `the Kubernetes Secret has the same name as Secrets Manager secret ${n.name}, so it is materialized from it — the source secret (and its KMS key) must exist in the recovery region first. Matched by name, so confirm your sync mechanism`,
      });
    }
  }

  // Nodegroups: pods need schedulable nodes; the CNI must be in before nodes are Ready.
  const ngs = [...g.items.values()].filter((i) => i.kind === 'nodegroup').sort((a, b) => byStr(a.id, b.id));
  const addons = [...g.items.values()].filter((i) => i.kind === 'addon').sort((a, b) => byStr(a.id, b.id));
  for (const ng of ngs) {
    for (const a of addons) {
      if (!/vpc-cni|kube-proxy/.test(lower(a.name))) continue;
      g.link(a.id, ng.id, {
        requires: 'exists', provenance: 'rule:cni-before-nodes', confidence: 0.6, kind: 'soft',
        why: `${a.name} has to be installed before nodes can get pod networking and report Ready. Soft: EKS installs the default addons with the cluster, so this only bites when you manage them yourself`,
      });
    }
    for (const wl of k8sOut.workloads) {
      g.link(ng.id, wl.id, {
        requires: 'ready', provenance: 'rule:nodes-before-pods', confidence: 0.85, kind: 'hard',
        why: `pods need schedulable nodes — nodegroup ${ng.name} must be Active with Ready nodes, and the recovery region has to actually have the capacity`,
      });
    }
  }

  // Target groups / load balancers have no healthy backend until the pods behind
  // them pass readiness. Link them where the data actually says so: the target
  // group's health-check path matches a component's health endpoint.
  const tgs = [...g.items.values()].filter((i) => i.kind === 'target-group').sort((a, b) => byStr(a.id, b.id));
  for (const tg of tgs) {
    const n = nodes[tg.rid] || {};
    const hcPath = str(n.details && n.details.healthCheckPath);
    let linked = false;
    if (hcPath) {
      for (const c of ctx.components) {
        const hit = arr(c.endpoints).some((e) => str(e && e.healthCheck) && str(e.healthCheck) === hcPath);
        if (!hit) continue;
        for (const wl of (k8sOut.byComponent.get(c.id) || [])) {
          if (wl.cls.role !== 'app') continue;
          g.link(wl.id, tg.id, {
            requires: 'ready', provenance: 'graph:health-check-match', confidence: 0.7, kind: 'hard',
            why: `this target group health-checks ${hcPath}, which is ${c.name}'s health endpoint — it has no healthy targets until ${wl.w.name} pods are Ready, not merely created`,
          });
          linked = true;
        }
      }
    }
    if (!linked) {
      tg.notes.push('a target group has no healthy targets until its backends pass readiness — confirm which workload backs it (the engine could not match its health-check path to a component endpoint)');
    }
  }

  // Observability wiring hangs off the WORKLOAD, not just the component: an alarm
  // on a service that has not started yet evaluates nothing and pages nobody
  // usefully.
  for (const it of [...g.items.values()].sort((a, b) => byStr(a.id, b.id))) {
    if (it.kind !== 'alarm' || !it.componentId) continue;
    for (const wl of (k8sOut.byComponent.get(it.componentId) || [])) {
      if (wl.cls.role !== 'app') continue;
      g.link(wl.id, it.id, {
        requires: 'ready', provenance: 'rule:alarm-after-workload', confidence: 0.7, kind: 'soft',
        why: `watches ${wl.w.name}; create it once those pods are Ready so it has a real metric to evaluate and the rebuild does not page anyone`,
      });
    }
  }
}

// ---- 5. startup calls, external preconditions, fence gates ----------------

function addCalls(g, ctx, k8sOut, k8s) {
  const resolve = targetResolver(ctx.components);
  // Relaxed second pass, restricted to the caller's OWN declared dependencies.
  // The strict resolver (shared with the service page) needs a 4-character key,
  // so short service names like "ECR" never match — yet "ECR (recovery account)"
  // obviously means the ECR component the caller already declares. Narrowing the
  // search to declared dependencies makes a false positive harmless: the
  // dependsOn edge exists either way, so nothing new is ordered, and the call
  // stops being reported as unresolvable.
  const resolveAmongDeps = (c, target) => {
    const t = lower(target).replace(/[^a-z0-9]+/g, ' ').trim();
    if (!t) return null;
    let best = null;
    for (const d of arr(c.dependsOn).map(str).sort(byStr)) {
      const dep = ctx.byId.get(d);
      if (!dep) continue;
      const keys = [dep.kind, ...arr(dep.awsServices)]
        .map((k) => lower(k).replace(/[^a-z0-9]+/g, ' ').trim())
        .filter((k) => k.length >= 3);
      for (const k of keys) {
        if (!(t.includes(k) || k.includes(t))) continue;
        if (!best || k.length > best.len) best = { id: d, len: k.length };
      }
    }
    return best ? best.id : null;
  };
  const calls = [];
  for (const c of ctx.components) {
    for (const [i, raw] of arr(c.outboundCalls).filter(Boolean).entries()) {
      const when = classifyCall(c, raw, { k8s });
      const type = lower(raw.type) || 'internal';
      const external = type === 'third-party' || type === 'saas' || type === 'on-prem';
      let targetId = resolve(raw.target, c.id);
      let resolvedVia = targetId ? 'name-match' : '';
      if (!targetId) {
        targetId = resolveAmongDeps(c, raw.target);
        if (targetId) resolvedVia = 'dependsOn-relaxed';
      }
      const tc = targetId ? ctx.byId.get(targetId) : null;
      const workloadUid = str(raw.workload);
      const callerIds = [c.id];
      let workloadId = '';
      if (workloadUid && k8sOut.byUid.has(workloadUid)) {
        workloadId = k8sOut.byUid.get(workloadUid);
        callerIds.push(workloadId);
      }
      const call = {
        componentId: c.id, componentName: str(c.name), workload: workloadUid,
        index: i,
        target: str(raw.target), type,
        protocol: str(raw.protocol), port: num(raw.port), purpose: str(raw.purpose),
        failoverBehavior: str(raw.failoverBehavior), critical: !!raw.critical,
        source: str(raw.source), observedCount: num(raw.observedCount),
        when: when.when, whenConfidence: when.confidence, whenWhy: when.why, whenRule: when.rule,
        targetComponentId: external ? '' : (tc ? tc.id : ''),
        targetComponentName: external ? '' : (tc ? str(tc.name) : ''),
        targetResolvedVia: external ? '' : resolvedVia,
        external, externalPreconditionId: '',
        callerWave: null, calleeWave: null, ordered: null,
      };

      if (external) {
        // Not deployable — a precondition to VERIFY, with days of lead time.
        // If the inventory already carries this partner as a third-party component
        // that is itself a pure precondition (no declared dependencies of its own),
        // reuse it rather than emitting a duplicate. A third-party component that
        // DOES declare dependencies (e.g. the clearinghouse behind the CDN) is a
        // different thing — an end-to-end check that happens late — so the
        // precondition gets its own item and the two are cross-referenced.
        const reuse = tc && cat(tc.category) === 'third-party' && !arr(tc.dependsOn).length;
        const id = reuse ? tc.id : EXT(raw.target);
        call.externalPreconditionId = id;
        if (reuse) {
          const it = g.items.get(id);
          if (it) {
            it.action = 'verify';
            for (const n of [
              `${c.name} calls it over ${str(raw.protocol) || 'an unrecorded protocol'}${raw.purpose ? ` for ${raw.purpose}` : ''}.`,
              ...(raw.failoverBehavior ? [`recorded failover behaviour: "${raw.failoverBehavior}"`] : []),
            ]) if (!it.notes.includes(n)) it.notes.push(n);
          }
        } else if (tc) {
          g.add({
            id, name: str(raw.target) || 'external dependency', kind: 'external-precondition',
            category: 'third-party', source: 'external', tier: 0, rank: 10, action: 'verify',
            notes: [`the inventory also has ${tc.name} for this partner, but that component depends on ${arr(tc.dependsOn).length} other thing(s) and therefore lands late — the PRECONDITION (allowlist, egress IP, credentials) has to be true long before that end-to-end check runs`],
          });
        }
        const extItem = g.add({
          id, name: str(raw.target) || 'external dependency', kind: 'external-precondition',
          category: 'third-party', source: 'external', tier: 0, rank: 10, action: 'verify',
          notes: [
            PRECONDITION_WORDING,
            `${c.name} calls it over ${str(raw.protocol) || 'an unrecorded protocol'}${raw.purpose ? ` for ${raw.purpose}` : ''}.`,
            ...(raw.failoverBehavior ? [`recorded failover behaviour: "${raw.failoverBehavior}"`] : ['no failover behaviour recorded — assume it breaks after failover until someone writes down why it does not']),
            'arrange it before the event (partner allowlists and egress-IP approvals have lead times measured in days), then re-verify reachability FROM the recovery region at L5 — before the functional success bar, not as part of it',
          ],
        });
        // The port the call is actually made on, so the reachability check can be
        // a real `nc -vz host 443` rather than a placeholder. The schema carries
        // the port either as its own field or riding along in 'tcp/443'.
        const callPort = num(raw.port)
          || num(Number((/(\d{1,5})\s*$/.exec(str(raw.protocol)) || [])[1]));
        if (extItem && callPort && callPort > 0 && callPort < 65536 && !extItem.probePorts.includes(callPort)) {
          extItem.probePorts.push(callPort);
          extItem.probePorts.sort((x, y) => x - y);
        }
        for (const cid of callerIds) {
          g.link(id, cid, {
            requires: 'verified',
            provenance: `startup-call:${type}`,
            confidence: when.when === 'startup' ? 0.85 : (raw.critical ? 0.7 : 0.5),
            kind: when.when === 'startup' ? 'hard' : 'soft',
            why: raw.failoverBehavior
              ? `${str(raw.target)}: ${raw.failoverBehavior} — confirm it is true in the recovery region before this can serve`
              : `calls ${str(raw.target)} (${type}); it cannot be deployed, only verified — confirm the allowlist, egress IP and credentials from the recovery region`,
          });
        }
        // Deliberately NO edge to a third-party inventory component: those tend
        // to depend on the edge/CDN, and ordering a caller behind them would push
        // every application to the end of the plan.
        calls.push(call);
        continue;
      }

      if (tc && tc.id !== c.id) {
        const hardStartup = when.when === 'startup';
        const linkIt = hardStartup || (when.when === 'unknown' && raw.critical);
        if (linkIt) {
          const targetIsCompute = ['compute'].includes(cat(tc.category));
          for (const cid of callerIds) {
            g.link(tc.id, cid, {
              requires: 'ready',
              provenance: `startup-call:${type}`,
              confidence: hardStartup ? (raw.critical ? 0.8 : 0.65) : 0.4,
              kind: hardStartup ? 'hard' : 'soft',
              why: `${when.when === 'startup' ? 'opens a connection to' : 'may open a connection to'} ${str(raw.target)}${raw.protocol ? ` over ${raw.protocol}` : ''} at start-up${raw.purpose ? ` (${raw.purpose})` : ''} — ${tc.name} must be up and answering first${targetIsCompute ? ', which means its pods Ready, not merely created' : ''}${hardStartup ? '' : '. Soft: the engine could not confirm this is a start-up call, only that it is marked critical'}`,
            });
          }
          // If the callee runs in the cluster, wait for its pods to be Ready.
          for (const wl of (k8sOut.byComponent.get(tc.id) || [])) {
            if (wl.cls.role !== 'app') continue;
            for (const cid of callerIds) {
              g.link(wl.id, cid, {
                requires: 'ready', provenance: `startup-call:${type}`,
                confidence: hardStartup ? 0.75 : 0.4, kind: hardStartup ? 'hard' : 'soft',
                why: `waits for ${wl.w.name} pods to be Ready, not just created — ${c.name} calls ${tc.name} at start-up and an unready backend means a CrashLoop, not a retry-and-recover`,
              });
            }
          }
        }
      }
      calls.push(call);
    }
  }
  calls.sort((a, b) => byStr(a.componentId, b.componentId) || a.index - b.index);
  return calls;
}

// A fence gate: before any writer is promoted in the recovery region, the old
// primary must be proven demoted or unreachable. Split-brain on a ledger is the
// one failure worse than downtime — an ungraceful failover does NOT demote for you.
function addFenceGates(g, ctx) {
  const out = [];
  for (const c of ctx.components) {
    if (cat(c.category) !== 'database') continue;
    const sig = `${lower(c.kind)} ${lower(c.name)} ${arr(c.awsServices).map(lower).join(' ')}`;
    if (!WRITER_STORE_RE.test(sig)) continue;
    if (lower(c.inRecoveryScope) === 'no') continue;
    const id = FENCE(c.id);
    g.add({
      id, name: `Fence the old primary — ${c.name}`, kind: 'fence-gate',
      category: 'database', source: 'synthetic', componentId: c.id,
      tier: 6, rank: -10, layer: 'L1', suppressLayerMismatch: true,
      action: 'verify',
      verify: '',
      notes: [
        'prove the primary-region writer is demoted or unreachable BEFORE promoting or restoring here: scale old-region writers to zero if reachable, revoke the database security-group ingress, or show the writer is demoted',
        'a graceful Aurora Global switchover demotes the old writer for you; an ungraceful failover does NOT, and the old region can keep taking writes from clients whose DNS has not moved',
        'record which of the two happened — two writers on the same ledger is unrecoverable in a way that downtime is not',
        'this is an L1 recovery-launch gate placed immediately before the L3 data block it protects',
      ],
    });
    g.link(id, c.id, {
      requires: 'verified', provenance: 'rule:fence-before-promote', confidence: 0.9, kind: 'hard',
      why: `${c.name} is promoted or restored in the recovery region — the old primary must be fenced first or you get two writers`,
    });
    out.push(id);
  }
  return out;
}

// ================================================================== SOLVER

// Tarjan's strongly-connected components, iterative (a 300+ node graph must not
// blow the stack) and deterministic (ids and adjacency both sorted).
function stronglyConnected(ids, outAdj) {
  const index = new Map(); const low = new Map(); const onStack = new Set();
  const stack = []; const comps = []; let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    index.set(root, counter); low.set(root, counter); counter += 1;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, pi] = frame;
      const nbrs = outAdj.get(v) || [];
      if (pi < nbrs.length) {
        frame[1] += 1;
        const w = nbrs[pi];
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter += 1;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop(); onStack.delete(w); comp.push(w);
          if (w === v) break;
        }
        comps.push(comp.sort(byStr));
      }
    }
  }
  return comps;
}

const adjacency = (ids, edges) => {
  const out = new Map(ids.map((i) => [i, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from).push(e.to);
  for (const [k, v] of out) out.set(k, v.sort(byStr));
  return out;
};

// Detect every cycle and, for each, nominate the WEAKEST edge as the break.
// Nothing is ever dropped silently: every removal is reported.
function breakCycles(items, edges) {
  const ids = [...items.keys()].sort(byStr);
  let live = edges.slice();
  const cycles = [];
  const broken = [];
  for (let pass = 0; pass < 200; pass += 1) {
    const comps = stronglyConnected(ids, adjacency(ids, live));
    const loops = comps.filter((c) => c.length > 1);
    const selfLoops = live.filter((e) => e.from === e.to);
    if (!loops.length && !selfLoops.length) break;
    for (const e of selfLoops) live = live.filter((x) => x !== e);
    if (!loops.length) continue;
    // one break per pass per component, then re-run (a large SCC may need several)
    for (const comp of loops) {
      const member = new Set(comp);
      const inner = live
        .filter((e) => member.has(e.from) && member.has(e.to))
        .sort((a, b) => a.confidence - b.confidence
          || (a.kind === b.kind ? 0 : a.kind === 'soft' ? -1 : 1)
          || byStr(a.from, b.from) || byStr(a.to, b.to));
      const weakest = inner[0];
      if (!weakest) continue;
      live = live.filter((e) => e !== weakest);
      broken.push(weakest);
      const appToApp = comp.every((id) => {
        const it = items.get(id);
        return it && (it.tier === 9 || it.kind === 'k8s-Deployment' || it.kind === 'k8s-StatefulSet');
      });
      cycles.push({
        id: `cyc_${cycles.length + 1}`,
        nodes: comp.map((id) => {
          const it = items.get(id);
          return { id, name: it ? it.name : id, kind: it ? it.kind : '', wave: null };
        }),
        edges: inner.map(publicEdge),
        suggestedBreak: publicEdge(weakest),
        why: `These ${comp.length} items each wait on another one in the set, so no order satisfies all of them. `
          + `The weakest link is "${weakest.why}" (${weakest.provenance}, confidence ${weakest.confidence.toFixed(2)}) — the engine ignored THAT edge only, to produce an order, and is telling you rather than hiding it. `
          + (appToApp
            ? 'These are all application workloads calling each other. In production such a loop is survived by retry/backoff: whichever starts first CrashLoops until the other answers. Decide explicitly whether that is acceptable for your RTO, or start one of them with its dependency check disabled.'
            : 'Fix it by correcting the dependency that is wrong, or by splitting one item into a create step and a configure step (the way security groups genuinely need two phases).'),
        waves: [],
      });
    }
  }
  return { edges: live, cycles, broken };
}

const publicEdge = (e) => ({
  from: e.from, to: e.to, requires: e.requires, provenance: e.provenance,
  provenances: e.provenances, confidence: e.confidence, why: e.why, kind: e.kind,
});

// Longest-path levels over the acyclic edge set, with the tier ladder as a SOFT
// FLOOR: level(x) = max(tierFloor(x), 1 + max level of its prerequisites).
// The floor can only ever delay an item; a real prerequisite always wins.
function assignLevels(items, edges) {
  const ids = [...items.keys()].sort(byStr);
  const preds = new Map(ids.map((i) => [i, []]));
  const succs = new Map(ids.map((i) => [i, []]));
  for (const e of edges) {
    if (!preds.has(e.to) || !succs.has(e.from)) continue;
    preds.get(e.to).push(e);
    succs.get(e.from).push(e);
  }
  for (const [, v] of preds) v.sort((a, b) => byStr(a.from, b.from));
  const indeg = new Map(ids.map((i) => [i, preds.get(i).length]));
  const level = new Map(ids.map((i) => [i, tierFloor(items.get(i).tier)]));
  const queue = ids.filter((i) => indeg.get(i) === 0).sort(byStr);
  const order = [];
  while (queue.length) {
    const v = queue.shift();
    order.push(v);
    for (const e of succs.get(v).slice().sort((a, b) => byStr(a.to, b.to))) {
      level.set(e.to, Math.max(level.get(e.to), level.get(v) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) {
        queue.push(e.to);
        queue.sort(byStr);
      }
    }
  }
  return { level, preds, succs, topo: order };
}

// --------------------------------------------------------------- scope filter

function closureIds(components, rootId) {
  const byId = new Map(components.map((c) => [c.id, c]));
  if (!byId.has(rootId)) return null;
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = byId.get(queue.shift());
    for (const d of arr(cur && cur.dependsOn).map(str)) {
      if (seen.has(d) || !byId.has(d)) continue;
      seen.add(d); queue.push(d);
    }
  }
  for (const c of components) {
    if (seen.has(c.id)) continue;
    if (arr(c.dependsOn).map(str).includes(rootId)) seen.add(c.id);
  }
  return seen;
}

// Keep the seed items plus, transitively, everything they wait on — you cannot
// deploy a service without its prerequisites.
function restrictToScope(items, edges, seedIds) {
  const preds = new Map();
  for (const e of edges) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
  }
  const keep = new Set();
  const queue = [...seedIds].filter((i) => items.has(i)).sort(byStr);
  for (const s of queue) keep.add(s);
  while (queue.length) {
    const v = queue.shift();
    for (const p of (preds.get(v) || []).sort(byStr)) {
      if (keep.has(p) || !items.has(p)) continue;
      keep.add(p); queue.push(p);
    }
  }
  const kItems = new Map([...items.entries()].filter(([id]) => keep.has(id)));
  const kEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { items: kItems, edges: kEdges };
}

// ============================================================ THE MAIN ENTRY

/**
 * computeDeployOrder({components, graph, k8s, scope, options}) -> model
 * Pure and deterministic. No timestamp (the route stamps `generatedAt`).
 */
export function computeDeployOrder(input = {}) {
  const components = arr(input.components).filter((c) => c && str(c.id)).slice()
    .sort((a, b) => byStr(a.id, b.id));
  const graph = input.graph && typeof input.graph === 'object' ? input.graph : {};
  const k8s = input.k8s && typeof input.k8s === 'object' ? input.k8s : {};
  const scopeId = typeof input.scope === 'string' ? input.scope
    : (input.scope && typeof input.scope === 'object' ? str(input.scope.componentId) : '');
  const options = input.options && typeof input.options === 'object' ? input.options : {};

  const notes = [];
  const g = newGraph();

  // 1 — inventory
  const { byId, dangling } = addComponents(g, components, notes);

  // 2 — resource graph
  const { nodes, notDeployable, flowTargets } = addResources(g, graph, components);

  // context shared by the k8s / cross-link / call passes
  const ctx = {
    components, byId, nodes,
    clusterComponentIds: components
      .filter((c) => /eks-cluster|^eks$|kubernetes-cluster|ecs-cluster/.test(lower(c.kind)))
      .map((c) => c.id).sort(byStr),
    registryComponentIds: components
      .filter((c) => /^ecr|registry/.test(lower(c.kind)) || cat(c.category) === 'cicd-control-plane')
      .map((c) => c.id).sort(byStr),
    repoNodes: Object.keys(nodes).sort(byStr).map((rid) => nodes[rid])
      .filter((n) => n && str(n.type) === 'repository'),
  };

  // 3 — Kubernetes
  const k8sOut = addK8s(g, k8s, ctx);
  if (!k8sOut.present) {
    notes.push('No Kubernetes snapshot in this workspace — ordering is COMPONENT-level only. Pod-startup prerequisites (mounted secrets and configmaps, service accounts and their IRSA roles, PVCs, image pulls, in-cluster startup calls) cannot be modelled, and those are the things that actually stop a pod. Import a snapshot on the Kubernetes page for a real pod-level order.');
  }

  // 4 — cross-links, 5 — calls and fences
  addCrossLinks(g, ctx, k8sOut);
  if (options.fence !== false) addFenceGates(g, ctx);
  const calls = addCalls(g, ctx, k8sOut, k8s);

  // 6 — de-duplication, once every pass has contributed its edges.
  //   (a) a flow-derived external target and its `ext:` precondition are one
  //       thing: keep the precondition, drop the phantom deployable;
  //   (b) a component and the graph node for its own ARN are one thing: merge
  //       them into a single item carrying the union of their prerequisites.
  const flowOrphans = reconcileFlowTargets(g, flowTargets, calls, notes);
  const mergedResources = mergeComponentResources(g, components);
  if (mergedResources.length) {
    notes.push(`${mergedResources.length} component(s) were each scheduled twice — once as the component and once as the discovered resource with the same ARN. They are merged into one item apiece (${mergedResources.map((m) => m.name).join(', ')}), carrying the union of both sets of prerequisites. Association resources (security groups, subnets, target groups, listeners, keys) stay as their own items: they are separate things to build.`);
  }

  // ---- scope
  let items = g.items;
  let edges = [...g.edges.values()].sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to));
  let scope = null;
  if (scopeId) {
    const ids = closureIds(components, scopeId);
    if (!ids) {
      notes.push(`No component "${scopeId}" in this workspace — showing the whole workspace instead.`);
    } else {
      const seed = new Set(ids);
      for (const id of [...items.keys()]) {
        const it = items.get(id);
        if (it.componentId && ids.has(it.componentId)) seed.add(id);
        if (it.source === 'resource') {
          const n = nodes[it.rid];
          if (n && arr(n.componentIds).some((c) => ids.has(str(c)))) seed.add(id);
        }
      }
      const r = restrictToScope(items, edges, seed);
      items = r.items; edges = r.edges;
      scope = {
        componentId: scopeId,
        name: byId.has(scopeId) ? str(byId.get(scopeId).name) : scopeId,
        ids: [...ids].sort(byStr),
      };
    }
  }

  // ---- cycles, then levels
  const totalEdgeCount = edges.length;
  const { edges: acyclic, cycles, broken } = breakCycles(items, edges);
  const inCycle = new Set(cycles.flatMap((c) => c.nodes.map((n) => n.id)));
  const { level, preds, succs } = assignLevels(items, acyclic);

  // compact levels so there are no empty waves
  const used = [...new Set([...level.values()])].sort((a, b) => a - b);
  const waveOf = new Map(used.map((l, i) => [l, i]));
  for (const [id, it] of items) {
    it.wave = waveOf.get(level.get(id));
    it.inCycle = inCycle.has(id);
    if (it.inCycle) it.notes.push('part of a reported dependency cycle — see `cycles` for the loop and the suggested break; its position is provisional');
  }
  for (const c of cycles) {
    for (const n of c.nodes) n.wave = items.has(n.id) ? items.get(n.id).wave : null;
    c.waves = uniq(c.nodes.map((n) => n.wave).filter((w) => w !== null)).sort((a, b) => a - b);
  }

  // ---- readiness gates + estMinutes from the workspace's own runbook steps
  for (const e of acyclic) {
    if (e.requires === 'ready' && items.has(e.from)) items.get(e.from).readinessGate = true;
  }
  const estByComponent = runbookMinutes(input.runbooks);
  for (const it of items.values()) {
    if (it.componentId && estByComponent.has(it.componentId)) it.estMinutes = estByComponent.get(it.componentId);
  }

  // ---- waitsFor + provenance
  for (const [id, it] of items) {
    const myLevel = level.get(id);
    const list = (preds.get(id) || []).map((e) => {
      const p = items.get(e.from);
      return {
        id: e.from,
        name: p ? p.name : e.from,
        why: e.why,
        requires: e.requires,
        provenance: e.provenance,
        confidence: e.confidence,
        binding: level.get(e.from) + 1 === myLevel,
      };
    }).sort((a, b) => Number(b.binding) - Number(a.binding)
      || b.confidence - a.confidence || byStr(a.name, b.name));
    it.waitsFor = list;
    const bindingProv = list.filter((x) => x.binding).map((x) => x.provenance);
    it.provenance = provenanceLabel(bindingProv, list.length, myLevel > tierFloor(it.tier) ? '' : 'tier-floor');
    // an out-of-scope prerequisite is a hole in the plan
    for (const p of list) {
      const pi = items.get(p.id);
      if (pi && lower(pi.inRecoveryScope) === 'no') {
        const n = `waits on ${pi.name}, which is NOT in the recovery scope — that prerequisite will not be there, so this cannot complete as written`;
        if (!it.notes.includes(n)) it.notes.push(n);
      }
    }
  }

  // ---- waves
  const waveCount = used.length;
  const waves = [];
  for (let i = 0; i < waveCount; i += 1) {
    const mine = [...items.values()].filter((x) => x.wave === i)
      .sort((a, b) => a.tier - b.tier || a.tierRank - b.tierRank || byStr(a.name, b.name) || byStr(a.id, b.id));
    const groups = new Map();
    for (const it of mine) {
      if (!groups.has(it.category)) groups.set(it.category, []);
      groups.get(it.category).push(publicItem(it));
    }
    const categories = [...groups.entries()]
      .map(([category, list]) => ({
        category, label: CATEGORY_LABEL[category] || category, items: list,
        minTier: Math.min(...list.map((x) => x.tier)),
      }))
      .sort((a, b) => a.minTier - b.minTier || byStr(a.category, b.category))
      .map(({ category, label, items: list }) => ({ category, label, items: list }));
    const tierNames = [...new Set(mine.map((x) => x.tierName))];
    const counts = new Map();
    for (const it of mine) counts.set(it.tierName, (counts.get(it.tierName) || 0) + 1);
    const dominant = tierNames
      .sort((a, b) => (counts.get(b) - counts.get(a))
        || (Math.min(...mine.filter((x) => x.tierName === a).map((x) => x.tier))
          - Math.min(...mine.filter((x) => x.tierName === b).map((x) => x.tier))))
      .slice(0, 2);
    const layerCounts = new Map();
    for (const it of mine) layerCounts.set(it.layer, (layerCounts.get(it.layer) || 0) + 1);
    const layers = [...layerCounts.keys()].sort((a, b) => layerRank(a) - layerRank(b));
    // Most common layer wins; on a tie the LATER layer wins, because a wave that
    // contains an L7 traffic flip must be gated as L7 — never as something softer.
    const primaryLayer = layers.slice()
      .sort((a, b) => (layerCounts.get(b) - layerCounts.get(a)) || (layerRank(b) - layerRank(a)))[0] || '';
    const est = mine.map((x) => x.estMinutes).filter((x) => x !== null);
    waves.push({
      index: i,
      // `name` is display-ready ("Wave 3 · Data stores"); `title` is the same
      // label WITHOUT the "Wave N · " prefix, for consumers that add their own.
      name: `Wave ${i} · ${dominant.join(' + ') || 'Items'}`,
      title: dominant.join(' + ') || 'Items',
      layer: primaryLayer,
      layerLabel: LAYER_LABEL[primaryLayer] || '',
      layers,
      // `needsReview` keeps its original meaning — a cycle was broken here —
      // because the Deployment order page and the diagram both label it exactly
      // that way. `needsKindReview` and `reviewReasons` are the additive half: an
      // item whose kind the rule table did not recognise is sitting on a
      // conservative PLACEHOLDER rather than a derived position, and the journey
      // found that warning buried inside the item where nobody saw it. Saying it
      // at wave level is what lets the wave header, the runbook step and the
      // diagram repeat it.
      needsReview: mine.some((x) => x.inCycle),
      needsKindReview: mine.some((x) => x.unrecognised),
      reviewReasons: [
        ...(mine.some((x) => x.inCycle)
          ? [`${mine.filter((x) => x.inCycle).length} item(s) are in a reported dependency cycle — read "cycles" before running this wave.`] : []),
        ...(mine.some((x) => x.unrecognised)
          ? [`${mine.filter((x) => x.unrecognised).length} item(s) have a kind the ordering rule table does not recognise (${uniq(mine.filter((x) => x.unrecognised).map((x) => `"${x.kind}"`)).join(', ')}) and were placed conservatively, not derived — confirm this wave is where they belong.`] : []),
      ],
      parallelizable: true,
      estMinutes: est.length ? Math.max(...est) : null,
      estMinutesSource: est.length ? 'runbook-steps' : 'none',
      itemCount: mine.length,
      readinessGates: mine.filter((x) => x.readinessGate).map((x) => x.id),
      categories,
    });
  }

  // ---- category order, derived from where members actually land
  const categoryOrder = buildCategoryOrder(items);

  // ---- call wave comparison + residual issues
  const callIssues = resolveCallWaves(calls, items, k8sOut, acyclic, broken);

  // ---- unordered (nothing is lost: everything the engine could not place)
  const unordered = [
    ...notDeployable.map(({ rid, node, reason }) => ({
      id: RES(rid), name: str(node.name) || rid, kind: str(node.type) || 'other',
      category: cat(ruleForNode(node).category), reason,
      // `actionable` separates "you need to do something about this" from "this
      // is simply not a thing you deploy" — the UI and the AI assist both care.
      actionable: !NOT_DEPLOYABLE[str(node.type)],
    })),
    ...flowOrphans.map((ft) => ({
      id: RES(ft.rid), name: ft.name, kind: 'network-flow-endpoint', category: 'third-party',
      reason: `imported from flow data as an external target, but no outbound call in the inventory still names it, so there is no precondition to attach it to. It is NOT deployable — an endpoint you reach over the network is verified, never created. Either re-apply the flow suggestion that created it, or delete the node.`,
      actionable: true,
    })),
    ...dangling.map((d) => ({
      id: d.missing, name: d.missing, kind: 'missing-component', category: 'other',
      reason: `${d.fromName} declares a dependency on component id "${d.missing}", which no longer exists. It was renamed or deleted, so there is a HOLE in ${d.fromName}'s restore order — not an absence of one.`,
      actionable: true,
    })),
  ].sort((a, b) => byStr(a.id, b.id));

  if (broken.length) {
    notes.push(`${broken.length} edge(s) were set aside to produce an order, all of them reported in "cycles" with the reason. No edge was dropped silently.`);
  }
  const skippedSummary = summarize(g.skipped);
  if (skippedSummary.length) {
    notes.push(`Resource-graph edges not used for ordering: ${skippedSummary.join('; ')}.`);
  }

  const byTier = {}; const bySource = {};
  for (const it of items.values()) {
    byTier[it.tier] = (byTier[it.tier] || 0) + 1;
    bySource[it.source] = (bySource[it.source] || 0) + 1;
  }

  const result = {
    waves,
    categoryOrder,
    cycles,
    unordered,
    callOrderIssues: callIssues,
    calls,
    stats: {
      waveCount,
      itemCount: items.size,
      edgeCount: totalEdgeCount,
      cycleCount: cycles.length,
      unorderedCount: unordered.length,
      brokenEdgeCount: broken.length,
      callIssueCount: callIssues.length,
      longestChain: waveCount ? waveCount : 0,
      maxWaveWidth: waves.reduce((m, w) => Math.max(m, w.itemCount), 0),
      readinessGateCount: [...items.values()].filter((x) => x.readinessGate).length,
      softEdgeCount: acyclic.filter((e) => e.kind === 'soft').length,
      // Provisional placements, and the two kinds of duplicate the engine
      // collapsed — all three are things a reader should be able to see a count
      // of without walking every item.
      unrecognisedCount: [...items.values()].filter((x) => x.unrecognised).length,
      mergedComponentCount: mergedResources.length,
      flowEndpointDedupeCount: arr(flowTargets).length - flowOrphans.length,
      byTier,
      bySource,
    },
    inputs: {
      components: components.length,
      graphNodes: Object.keys(nodes).length,
      graphEdges: arr(graph.edges).length,
      k8s: k8sOut.present ? 'present' : 'absent',
      scope,
    },
    notes,
  };
  // Internals the exported helpers need. Non-enumerable so JSON.stringify (and
  // therefore every HTTP response and every determinism check) ignores it.
  Object.defineProperty(result, '_model', {
    value: { items, edges: acyclic, level, preds, succs, broken, k8s: k8sOut },
    enumerable: false, writable: false, configurable: true,
  });
  return result;
}

function provenanceLabel(bindingProvenances, predCount, floorHint) {
  if (!predCount) return floorHint === 'tier-floor' ? 'tier-floor' : 'no-prerequisites';
  const p = bindingProvenances[0] || '';
  if (p === 'dependsOn') return 'explicit-dependsOn';
  if (p.startsWith('graph:')) return 'resource-graph';
  if (p.startsWith('k8s:')) return 'k8s-snapshot';
  if (p.startsWith('startup-call:')) return 'startup-call';
  if (p.startsWith('rule:')) return 'tier-rule';
  return bindingProvenances.length ? 'resource-graph' : 'tier-floor';
}

function publicItem(it) {
  const { tierRank, role, ...rest } = it;
  void tierRank; void role;
  return rest;
}

function summarize(list) {
  const counts = new Map();
  for (const s of list) counts.set(s, (counts.get(s) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))
    .slice(0, 6).map(([s, n]) => `${n}× ${s}`);
}

// estMinutes is NEVER invented. It is only taken from the workspace's own
// runbook steps, and only from a step that names EXACTLY ONE component — a step
// covering five components does not tell you how long any one of them takes, and
// spreading its number across all five would manufacture a figure nobody
// measured.
function runbookMinutes(runbooks) {
  const out = new Map();
  for (const rb of arr(runbooks)) {
    for (const s of arr(rb && rb.steps)) {
      const m = num(s && s.estMinutes);
      const ids = uniq(arr(s && s.componentIds).map(str).filter(Boolean));
      if (m === null || ids.length !== 1) continue;
      out.set(ids[0], Math.max(out.get(ids[0]) || 0, m));
    }
  }
  return out;
}

const CATEGORY_RATIONALE = {
  'identity-access': 'IAM roles, policies and the OIDC trust anchor come first because every other resource references one of them, and a recovered cluster needs its IRSA trust rebuilt before any pod can get credentials.',
  'security-secrets': 'KMS keys, certificates and secrets: an encrypted store cannot be created before its key exists, and a workload that cannot read its secret fails with an opaque container error.',
  networking: 'The VPC, subnets, routing and security groups have to exist before anything can be placed in them — and security-group rules are a second phase, not part of creating the groups.',
  'cicd-control-plane': 'The registry has to hold the images in the recovery region before any pod can pull one.',
  storage: 'Buckets, file systems and volume claims are created before the workloads that mount or read them.',
  database: 'Stateful and slow: subnet and parameter groups, then the cluster, then promotion — with the old primary fenced first.',
  'messaging-streaming': 'Queues, topics and streams exist before producers and consumers start, so nothing starts up against a missing endpoint.',
  compute: 'The cluster and its nodes, then the bootstrap objects, then the applications — a workload can only start once everything it mounts, pulls and calls is there.',
  'edge-dns': 'The front door is pointed at an origin that already answers.',
  observability: 'Log destinations before the workloads that write to them; alarms after, so the rebuild does not page anyone.',
  'third-party': 'Not deployable — verified. Partner allowlists and approved egress IPs have lead times measured in days, so they are confirmed before anything else starts.',
  other: 'Placed by the engine\'s conservative default because the resource type is not in the rule table — review these.',
};

function buildCategoryOrder(items) {
  const byCat = new Map();
  for (const it of items.values()) {
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it);
  }
  const rows = [...byCat.entries()].map(([category, list]) => {
    const waves = list.map((x) => x.wave).sort((a, b) => a - b);
    const firstWave = waves[0];
    const lastWave = waves[waves.length - 1];
    const median = waves[Math.floor(waves.length / 2)];
    const example = list.slice().sort((a, b) => a.wave - b.wave || a.tier - b.tier || byStr(a.name, b.name))[0];
    return {
      category, label: CATEGORY_LABEL[category] || category,
      firstWave, lastWave, medianWave: median, itemCount: list.length,
      rationale: `${CATEGORY_RATIONALE[category] || ''} First appears in wave ${firstWave} (${example ? example.name : ''}), last in wave ${lastWave}, ${list.length} item${list.length === 1 ? '' : 's'}.`.trim(),
    };
  });
  rows.sort((a, b) => a.firstWave - b.firstWave || a.medianWave - b.medianWave
    || b.itemCount - a.itemCount || byStr(a.category, b.category));
  return rows;
}

// ---- call waves + the residual ordering issues -----------------------------

function resolveCallWaves(calls, items, k8sOut, acyclic, broken) {
  void acyclic;
  const brokenPairs = new Set(broken.map((e) => `${e.from}|${e.to}`));
  const waveOfComponent = (cid) => (items.has(cid) ? items.get(cid).wave : null);
  // "can actually answer" = its own wave, and its pods' waves if it runs in the cluster
  const readyWave = (cid) => {
    const own = waveOfComponent(cid);
    let w = own;
    for (const wl of (k8sOut.byComponent.get(cid) || [])) {
      if (wl.cls.role !== 'app') continue;
      const it = items.get(wl.id);
      if (it && (w === null || it.wave > w)) w = it.wave;
    }
    return w;
  };
  const issues = [];
  for (const call of calls) {
    const callerItemId = call.workload && k8sOut.byUid.has(call.workload)
      ? k8sOut.byUid.get(call.workload) : call.componentId;
    call.callerWave = items.has(callerItemId) ? items.get(callerItemId).wave : waveOfComponent(call.componentId);
    call.calleeWave = call.external
      ? (items.has(call.externalPreconditionId) ? items.get(call.externalPreconditionId).wave : null)
      : (call.targetComponentId ? readyWave(call.targetComponentId) : null);
    call.ordered = call.callerWave !== null && call.calleeWave !== null
      ? call.callerWave > call.calleeWave : null;

    const base = {
      componentId: call.componentId, componentName: call.componentName,
      workload: call.workload, target: call.target,
      targetComponentId: call.targetComponentId, when: call.when,
      callerWave: call.callerWave, calleeWave: call.calleeWave,
    };

    if (call.external) {
      issues.push({
        ...base, kind: 'external-precondition',
        severity: call.critical && call.when !== 'runtime' ? 'high' : 'medium',
        why: `${call.componentName} calls ${call.target} (${call.type})${call.critical ? ', marked critical' : ''}. It cannot be deployed — only verified. ${call.failoverBehavior ? `Recorded behaviour: "${call.failoverBehavior}".` : 'No failover behaviour is recorded, so assume it breaks after failover.'}`,
        suggestion: `Confirm before the event: the partner has allowlisted the recovery-region egress IPs, the credentials are valid there, and the endpoint is reachable from the recovery VPC. It is placed in wave ${call.calleeWave === null ? '0' : call.calleeWave} as a verify-not-create precondition; re-verify reachability at L5, before the functional success bar.`,
      });
      continue;
    }
    if (!call.targetComponentId) {
      issues.push({
        ...base, kind: 'unresolved-target',
        severity: call.critical ? 'high' : 'medium',
        why: `${call.componentName} calls "${call.target}" (${call.type})${call.critical ? ', marked critical' : ''} and no inventory component matches it, so the engine cannot place it in the order at all.`,
        suggestion: `Add "${call.target}" to the inventory (or point the call at the component that already represents it). Until then it never appears in any wave and nobody checks it during a recovery.`,
      });
      continue;
    }
    if (call.when === 'startup' && call.ordered === false) {
      const wasBroken = brokenPairs.has(`${call.targetComponentId}|${call.componentId}`)
        || brokenPairs.has(`${call.targetComponentId}|${callerItemId}`);
      issues.push({
        ...base, kind: 'startup-order',
        severity: call.critical ? 'blocker' : 'high',
        why: `${call.componentName} starts in wave ${call.callerWave} but calls ${call.targetComponentName}, which is not answering until wave ${call.calleeWave} — it will CrashLoop${wasBroken ? '. This is the edge the engine had to set aside to break a dependency cycle (see "cycles")' : ''}.`,
        suggestion: wasBroken
          ? 'Break the loop deliberately: start one side with its dependency check relaxed and rely on retry/backoff, or split it into a create step and a connect step. Record which you chose.'
          : `Move ${call.componentName} after ${call.targetComponentName}, or prove the client retries with backoff rather than failing its readiness probe.`,
      });
      continue;
    }
    if (call.when === 'unknown' && call.critical) {
      issues.push({
        ...base, kind: 'unclassified-critical',
        severity: 'medium',
        why: `${call.componentName} makes a CRITICAL call to ${call.target} and the engine cannot tell whether it happens at start-up: ${call.whenWhy}`,
        suggestion: 'Record it: set the purpose to say when the call is made (on boot, or only while serving). That single field decides whether this call blocks recovery or not.',
      });
    }
  }
  issues.sort((a, b) => ({ blocker: 0, high: 1, medium: 2 }[a.severity] - { blocker: 0, high: 1, medium: 2 }[b.severity])
    || byStr(a.componentId, b.componentId) || byStr(a.target, b.target));
  return issues;
}

// ============================================================ EXPLAIN ONE ITEM

/**
 * explainItem(result, id) -> {item, chain, waitsFor, unlocks, ...} | null
 * `chain` is the LONGEST path of prerequisites that ends at this item — i.e. the
 * critical path that decides its wave, walked back to a wave-0 starting point.
 */
export function explainItem(result, id) {
  const m = result && result._model;
  if (!m) return null;
  let key = id;
  if (!m.items.has(key)) {
    // A `res:<rid>` that was merged into its own component (same ARN) no longer
    // has an item of its own. Existing links, bookmarks and diagram ids still
    // use it, so resolve it to the survivor rather than 404-ing on an id the
    // engine itself used to emit.
    const rid = str(key).startsWith('res:') ? str(key).slice(4) : '';
    if (rid) {
      const alias = [...m.items.values()].find((x) => x.rid === rid && x.source === 'component');
      if (alias) key = alias.id;
    }
  }
  if (!m.items.has(key)) return null;
  const it = m.items.get(key);
  id = key;

  // walk back along binding predecessors (the ones that set the level)
  const chain = [];
  const seen = new Set();
  let cur = id;
  for (let guard = 0; guard < 1000; guard += 1) {
    const cit = m.items.get(cur);
    if (!cit || seen.has(cur)) break;
    seen.add(cur);
    const incoming = (m.preds.get(cur) || [])
      .filter((e) => m.level.get(e.from) + 1 === m.level.get(cur))
      .sort((a, b) => b.confidence - a.confidence || byStr(a.from, b.from));
    chain.push({
      id: cur, name: cit.name, kind: cit.kind, wave: cit.wave,
      tier: cit.tier, tierName: cit.tierName, layer: cit.layer,
      why: incoming.length ? incoming[0].why : (cit.wave === 0
        ? 'nothing has to happen before this — it can start in the first wave'
        : `nothing blocks it directly; it is held at wave ${cit.wave} by the tier rule for ${cit.tierName} (${cit.tierLayer}), which is a soft floor, not a hard prerequisite`),
      requires: incoming.length ? incoming[0].requires : '',
      provenance: incoming.length ? incoming[0].provenance : 'tier-floor',
      confidence: incoming.length ? incoming[0].confidence : null,
    });
    if (!incoming.length) break;
    cur = incoming[0].from;
  }
  chain.reverse();

  const unlocks = (m.succs.get(id) || []).map((e) => {
    const d = m.items.get(e.to);
    return {
      id: e.to, name: d ? d.name : e.to, wave: d ? d.wave : null,
      requires: e.requires, why: e.why, confidence: e.confidence,
      binding: m.level.get(id) + 1 === m.level.get(e.to),
    };
  }).sort((a, b) => Number(b.binding) - Number(a.binding) || byStr(a.name, b.name));

  const cycles = arr(result.cycles).filter((c) => c.nodes.some((n) => n.id === id));
  const bindingCount = it.waitsFor.filter((w) => w.binding).length;
  return {
    item: publicItem(it),
    summary: it.wave === 0
      ? `${it.name} is in the first wave: nothing in this workspace has to exist before it.`
      : `${it.name} is in wave ${it.wave} because ${bindingCount
        ? `${bindingCount === 1 ? 'one prerequisite finishes' : `${bindingCount} prerequisites finish`} in wave ${it.wave - 1}: ${it.waitsFor.filter((w) => w.binding).map((w) => w.name).join(', ')}`
        : `of the ${it.tierName} tier rule (${it.tierLayer}), a soft floor — no single prerequisite holds it there`}. The longest chain of prerequisites reaching it is ${chain.length} step${chain.length === 1 ? '' : 's'} long.`,
    waitsFor: it.waitsFor,
    chain,
    longestPathLength: chain.length,
    unlocks,
    cycles,
    calls: arr(result.calls).filter((c) => c.componentId === id
      || (it.componentId && c.componentId === it.componentId)
      || (it.uid && c.workload === it.uid)
      || c.targetComponentId === id
      || (it.componentId && c.targetComponentId === it.componentId)),
  };
}

// ====================================================== DERIVED CHECK COMMANDS
//
// `docs/getting-started.md` promises every generated step "a verify command, a
// pass criterion, an owner, a time estimate". Two of those used to be hard-coded
// empty strings, which in a 3am runbook is worse than an honest blank — it looks
// finished. The first end-to-end journey's verdict was that the template runbook
// is executable and the generated one is a table of contents.
//
// The rule here is the honest-numbers rule applied to commands: DERIVE, never
// invent. A check is emitted only from an identifier the workspace actually
// holds — the component's own recorded verification command, a Kubernetes
// object's namespace/kind/name, or an AWS resource's rid/ARN, all of which are
// exact rather than guessed. Where no identifier exists the generator says what
// the operator must supply, and why, instead of printing nothing.
//
// One subtlety decides whether these commands actually run: EVERYTHING is
// region-scoped. `subnet-0ab…`, `sg-0cd…` and every ARN name the PRIMARY region
// and do not exist in the recovery region. So EC2-family resources are looked up
// by the Name tag (which does travel), name-addressable services by name, and the
// few checks that can only be written against an ARN say so and ask for the
// recovery-region equivalent. Each check is a CREATED/READY check, not a
// deploy step: creating things is your tooling's job, and this module will not
// pretend to know it.

const seg = (rid, i) => str(rid).split('/')[i] || '';
const afterPrefix = (rid, p) => str(rid).startsWith(p) ? str(rid).slice(p.length) : '';
const EC2_ID_RE = /^(sg|subnet|vpc|rtb|acl|igw|nat|eipalloc|vpce|lt|eni|ami|i)-[0-9a-f]+$/i;

// kind -> [ec2 sub-command, response key, id field, human noun]
const EC2_LOOKUPS = {
  vpc: ['describe-vpcs', 'Vpcs', 'VpcId', 'VPC'],
  subnet: ['describe-subnets', 'Subnets', 'SubnetId', 'subnet'],
  'security-group': ['describe-security-groups', 'SecurityGroups', 'GroupId', 'security group'],
  'route-table': ['describe-route-tables', 'RouteTables', 'RouteTableId', 'route table'],
  nacl: ['describe-network-acls', 'NetworkAcls', 'NetworkAclId', 'network ACL'],
  'internet-gateway': ['describe-internet-gateways', 'InternetGateways', 'InternetGatewayId', 'internet gateway'],
  'nat-gateway': ['describe-nat-gateways', 'NatGateways', 'NatGatewayId', 'NAT gateway'],
  'vpc-endpoint': ['describe-vpc-endpoints', 'VpcEndpoints', 'VpcEndpointId', 'VPC endpoint'],
  'elastic-ip': ['describe-addresses', 'Addresses', 'AllocationId', 'elastic IP'],
  'launch-template': ['describe-launch-templates', 'LaunchTemplates', 'LaunchTemplateId', 'launch template'],
};

// `kubectl` is namespace-scoped for almost everything, so the namespace comes out
// of the item id (`k8s:<ns>/<Kind>/<name>`, and a workload's uid has the same
// shape). '-' is this module's marker for cluster-scoped.
function k8sCheck(it) {
  const parts = str(it.id).replace(/^k8s:/, '').split('/');
  if (parts.length < 3) return null;
  const ns = parts[0] === '-' ? '' : parts[0];
  const kind = lower(parts[1]);
  const name = parts.slice(2).join('/');
  if (!name) return null;
  const n = ns ? `-n ${ns} ` : '';
  const rollout = (res, noun) => ({
    command: `kubectl ${n}rollout status ${res}/${name} --timeout=5m`,
    pass: `the ${noun} reports all replicas updated, available and READY — "created" is not the same as "Ready", and everything downstream waits on Ready`,
  });
  switch (kind) {
    case 'deployment': return rollout('deploy', 'rollout');
    case 'statefulset': return rollout('statefulset', 'rollout');
    case 'daemonset': return rollout('daemonset', 'rollout');
    case 'cronjob': return {
      command: `kubectl ${n}get cronjob ${name} -o jsonpath='{.spec.suspend}{"\\n"}'`,
      pass: 'the CronJob exists and prints false (not suspended)',
    };
    case 'job': return {
      command: `kubectl ${n}get job ${name} -o jsonpath='{.status.succeeded}{"\\n"}'`,
      pass: 'at least one successful completion',
    };
    case 'namespace': return {
      command: `kubectl get namespace ${name} -o jsonpath='{.status.phase}{"\\n"}'`,
      pass: 'Active',
    };
    case 'serviceaccount': return {
      command: `kubectl ${n}get sa ${name} -o jsonpath='{.metadata.annotations.eks\\.amazonaws\\.com/role-arn}{"\\n"}'`,
      pass: 'the service account exists, and for IRSA prints a role ARN whose trust policy names THIS (recovered) cluster\'s OIDC issuer — a recovered cluster has a new issuer URL, and a stale trust policy fails silently with no AWS credentials in the pod',
    };
    case 'secret': return {
      command: `kubectl ${n}get secret ${name} -o jsonpath='{range .data}{"\\n"}{end}' && kubectl ${n}get secret ${name} -o jsonpath='{.data}' | tr ',' '\\n' | cut -d'"' -f2`,
      pass: `the Secret exists and carries the keys the pods mount — a missing key leaves the pod in CreateContainerConfigError, which does not say "missing secret"`,
    };
    case 'configmap': return {
      command: `kubectl ${n}get configmap ${name} -o jsonpath='{.data}' | head -c 400`,
      pass: 'the ConfigMap exists and its values point at the RECOVERY region, not the primary — a config map that still names the lost region is a silent failure',
    };
    case 'persistentvolumeclaim': return {
      command: `kubectl ${n}get pvc ${name} -o jsonpath='{.status.phase}{"\\n"}'`,
      pass: 'Bound (not Pending) — a StatefulSet stays Pending forever against an unbound claim',
    };
    case 'storageclass': return {
      command: `kubectl get storageclass ${name}`,
      pass: 'it exists AND its CSI driver pods are Running — the class alone binds nothing',
    };
    case 'service': return {
      command: `kubectl ${n}get endpoints ${name} -o jsonpath='{.subsets[*].addresses[*].ip}{"\\n"}'`,
      pass: 'at least one endpoint IP is listed — a Service with no endpoints looks healthy and serves nothing',
    };
    case 'ingress': return {
      command: `kubectl ${n}get ingress ${name} -o jsonpath='{.status.loadBalancer.ingress[0]}{"\\n"}'`,
      pass: 'an address or hostname is present (the controller has provisioned a load balancer), and that hostname resolves',
    };
    case 'horizontalpodautoscaler': return {
      command: `kubectl ${n}get hpa ${name}`,
      pass: 'TARGETS shows a real number, not <unknown> — <unknown> means metrics-server is not answering',
    };
    default: return null;
  }
}

// AWS resources, keyed on the kind the node rule assigned. `R` is the
// --region argument (the workspace's recovery region where it is recorded).
function awsCheck(it, R) {
  const rid = str(it.rid);
  // The AWS name, never the component's display name: `aws elbv2
  // describe-load-balancers --names "ALB — payments-alb"` is not a command.
  const name = str(it.resourceName) || str(it.name);
  const arn = str(it.arn);
  const reg = `--region ${R}`;
  // Prefer the resource-graph reading: a merged component carries both, and only
  // the resource one comes with an exact rid to address the thing by.
  const kind = str(it.resourceKind) || str(it.kind);
  const ec2 = EC2_LOOKUPS[kind];
  if (ec2) {
    const [op, key, idField, noun] = ec2;
    if (!name || EC2_ID_RE.test(name)) {
      return {
        supply: true,
        command: `# ${noun} "${rid}" has no Name tag in the discovery data, and that id belongs to the PRIMARY region.\n# SUPPLY the recovery-region id, then: aws ec2 ${op} ${reg} --${idField.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}s <id>`,
        pass: `the ${noun} exists in the recovery region. You have to name it: the engine has no recovery-region identifier for it.`,
      };
    }
    const filter = kind === 'security-group'
      ? `"Name=group-name,Values=${name}"`
      : `"Name=tag:Name,Values=${name}"`;
    return {
      command: `aws ec2 ${op} ${reg} --filters ${filter} --query '${key}[].${idField}' --output text`,
      pass: `exactly one id is printed. It is the RECOVERY-region id, NOT ${rid} — EC2 ids do not cross regions, so anything downstream that hard-codes the primary id is broken.`,
    };
  }
  const needArn = (what, cmd, pass) => (arn ? {
    supply: true,
    command: `# ${what}: this can only be addressed by ARN, and the one on record is the PRIMARY region's.\n# SUPPLY the recovery-region ARN in place of it, then:\n${cmd}`,
    pass,
  } : null);

  switch (kind) {
    case 'eks-cluster': return {
      command: `aws eks describe-cluster ${reg} --name ${seg(rid, 2) || name} --query 'cluster.status' --output text`,
      pass: 'ACTIVE, and `aws eks update-kubeconfig` against it succeeds — every Kubernetes step below needs the API server reachable',
    };
    case 'rds-cluster': return {
      command: `aws rds describe-db-clusters ${reg} --db-cluster-identifier ${seg(rid, 2) || name} --query 'DBClusters[0].[Status,Engine,MultiAZ]' --output text`,
      pass: 'available — and confirm this is the WRITER: a promoted secondary that is still read-only accepts connections and rejects every write',
    };
    case 'rds-global-cluster': return {
      command: `aws rds describe-global-clusters --global-cluster-identifier ${seg(rid, 2) || name} --query 'GlobalCluster.GlobalClusterMembers[*].[DBClusterArn,IsWriter]' --output text`,
      pass: 'exactly ONE member reports IsWriter=true, and it is the recovery-region cluster. Two writers on the same ledger is the failure worse than downtime.',
    };
    case 'rds-instance': return {
      command: `aws rds describe-db-instances ${reg} --db-instance-identifier ${seg(rid, 2) || name} --query 'DBInstances[0].DBInstanceStatus' --output text`,
      pass: 'available',
    };
    case 'elasticache': return {
      command: `aws elasticache describe-replication-groups ${reg} --replication-group-id ${seg(rid, 1) || name} --query 'ReplicationGroups[0].Status' --output text`,
      pass: 'available — and remember a cache that comes up EMPTY is normal; what matters is whether anything downstream treats it as a source of truth',
    };
    case 'sqs-queue': return {
      command: `aws sqs get-queue-url ${reg} --queue-name ${seg(rid, 1) || name} --output text`,
      pass: 'a queue URL in the RECOVERY region is returned. A queue is recreated EMPTY: messages in flight in the primary region do not travel, so decide explicitly whether the ones that were in it are lost, replayable, or must be reconciled.',
    };
    case 'sns-topic': return needArn(`SNS topic ${name}`,
      `aws sns get-topic-attributes ${reg} --topic-arn <recovery-region ARN> --query 'Attributes.SubscriptionsConfirmed' --output text`,
      'the topic exists and its subscriptions are confirmed — an unsubscribed topic accepts publishes and delivers nothing') || {
      command: `aws sns list-topics ${reg} --query "Topics[?ends_with(TopicArn, ':${name}')].TopicArn" --output text`,
      pass: 'the topic exists in the recovery region and its subscriptions are confirmed',
    };
    case 's3-bucket': return {
      command: `aws s3api head-bucket --bucket ${seg(rid, 1) || name} && aws s3api get-bucket-location --bucket ${seg(rid, 1) || name} --output text`,
      pass: 'the command exits 0 and the location is the RECOVERY region. S3 bucket names are global: reaching the PRIMARY bucket from the recovery region is not recovery, it is a dependency on the region you just lost.',
    };
    case 'kinesis-stream': return {
      command: `aws kinesis describe-stream-summary ${reg} --stream-name ${seg(rid, 1) || name} --query 'StreamDescriptionSummary.StreamStatus' --output text`,
      pass: 'ACTIVE',
    };
    case 'dynamodb-table': return {
      command: `aws dynamodb describe-table ${reg} --table-name ${seg(rid, 1) || name} --query 'Table.[TableStatus,ItemCount]' --output text`,
      pass: 'ACTIVE — and for a global table, that the recovery-region replica is the one being written to',
    };
    case 'efs-file-system': return {
      command: `aws efs describe-file-systems ${reg} --query "FileSystems[?Name=='${name}'].[FileSystemId,LifeCycleState]" --output text`,
      pass: 'available, and its mount targets exist in the recovery subnets — a file system with no mount target in the subnet the pod runs in never mounts',
    };
    case 'lambda-function': return {
      command: `aws lambda get-function-configuration ${reg} --function-name ${seg(rid, 1) || name} --query '[State,LastUpdateStatus]' --output text`,
      pass: 'Active / Successful',
    };
    case 'ecs-cluster': return {
      command: `aws ecs describe-clusters ${reg} --clusters ${seg(rid, 2) || name} --query 'clusters[0].status' --output text`,
      pass: 'ACTIVE',
    };
    case 'transfer-server': return {
      command: `aws transfer describe-server ${reg} --server-id ${seg(rid, 1) || name} --query 'Server.State' --output text`,
      pass: 'ONLINE — and its hostname is the one the PARTNER has in their config, which usually means a DNS alias, not the generated endpoint',
    };
    case 'load-balancer': return {
      command: `aws elbv2 describe-load-balancers ${reg} --names "${name}" --query 'LoadBalancers[0].[State.Code,DNSName]' --output text`,
      pass: 'active, and the DNS name resolves. "active" only means the load balancer exists — it says nothing about whether any target behind it is healthy (that is the target-group check).',
    };
    case 'target-group': return {
      command: `aws elbv2 describe-target-health ${reg} --target-group-arn "$(aws elbv2 describe-target-groups ${reg} --names "${name}" --query 'TargetGroups[0].TargetGroupArn' --output text)" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text`,
      pass: 'at least one target reports healthy. This is the step that actually proves the application is serving: an empty or all-unhealthy target group is the single most common "everything is green but nothing works".',
    };
    case 'listener': return {
      command: `aws elbv2 describe-listeners ${reg} --load-balancer-arn "$(aws elbv2 describe-load-balancers ${reg} --names "${seg(rid, 2)}" --query 'LoadBalancers[0].LoadBalancerArn' --output text)" --query 'Listeners[].[Protocol,Port,SslPolicy]' --output text`,
      pass: `a ${name} listener is present, and for HTTPS its certificate is the RECOVERY region's own issued certificate (certificates do not cross regions)`,
    };
    case 'certificate': return {
      command: `aws acm list-certificates ${reg} --query "CertificateSummaryList[?DomainName=='${name}'].[CertificateArn,Status]" --output text`,
      pass: 'ISSUED in the recovery region. A certificate is regional and DNS-validated issuance has real lead time — if this is not already ISSUED, nothing downstream that terminates TLS can come up today.',
    };
    case 'hosted-zone': return {
      command: `aws route53 get-hosted-zone --id ${seg(rid, 1) || name} --query 'HostedZone.[Name,ResourceRecordSetCount]' --output text`,
      pass: 'the zone exists (hosted zones are global, so this one is the same zone) — what changes at failover is the records in it, not the zone',
    };
    case 'secret': return {
      command: `aws secretsmanager describe-secret ${reg} --secret-id ${afterPrefix(rid, 'secret/') || name} --query '[Name,ARN,LastChangedDate]' --output text`,
      pass: 'it exists in the RECOVERY region (check the region segment of the returned ARN) and its current version is the value the workload expects. An unreplicated secret is the single most common cause of a failed recovery test, and the pod-side symptom is an opaque container error.',
    };
    case 'kms-key': {
      if (/^alias\//.test(name)) {
        return {
          command: `aws kms describe-key ${reg} --key-id ${name} --query 'KeyMetadata.[KeyState,MultiRegion]' --output text`,
          pass: 'Enabled. If MultiRegion is false, the recovery region needs its OWN key: an encrypted resource cannot be CREATED before its key exists there.',
        };
      }
      return {
        supply: true,
        command: `# KMS key "${rid}"${name && name !== rid ? ` (${name})` : ''}: a key id is region-scoped and no alias was discovered for it.\n# SUPPLY the recovery-region key id or alias, then:\n# aws kms describe-key ${reg} --key-id <alias/... or key-id> --query 'KeyMetadata.[KeyState,MultiRegion]' --output text`,
        pass: 'the recovery-region key (or the multi-Region replica of this one) is Enabled — an encrypted resource cannot be created before its key exists in the region.',
      };
    }
    case 'iam-role': return {
      command: `aws iam get-role --role-name ${afterPrefix(rid, 'role/') || name} --query 'Role.[Arn,AssumeRolePolicyDocument.Statement[0].Principal]' --output text`,
      pass: 'the role exists (IAM is global) AND its trust policy names the thing that will assume it here — for IRSA that is the RECOVERED cluster\'s OIDC issuer, which is a new URL',
    };
    case 'iam-policy': return {
      command: `aws iam list-policies --scope Local --query "Policies[?PolicyName=='${afterPrefix(rid, 'policy/') || name}'].Arn" --output text`,
      pass: 'the policy exists and is attached to the role that needs it (an AWS-managed policy will not be listed by --scope Local — that is fine, it is always there)',
    };
    case 'instance-profile': return {
      command: `aws iam get-instance-profile --instance-profile-name ${afterPrefix(rid, 'instance-profile/') || name} --query 'InstanceProfile.Roles[].RoleName' --output text`,
      pass: 'the profile exists and carries the expected role',
    };
    case 'oidc-provider': return {
      command: `aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text`,
      pass: 'the RECOVERED cluster\'s issuer URL is listed. It is a NEW url — not "' + clip(name, 60) + '". Every IRSA role trust policy has to name the new issuer, and until it does, pods get no AWS credentials and fail in ways that never mention IAM.',
    };
    case 'nodegroup': return {
      command: `aws eks describe-nodegroup ${reg} --cluster-name ${seg(rid, 2)} --nodegroup-name ${seg(rid, 3) || name} --query 'nodegroup.[status,scalingConfig.desiredSize]' --output text && kubectl get nodes --no-headers | grep -c ' Ready '`,
      pass: 'ACTIVE with the expected size, and that many nodes report Ready. A recovery region that cannot actually supply the instance type is the classic capacity surprise.',
    };
    case 'addon': return {
      command: `aws eks describe-addon ${reg} --cluster-name ${seg(rid, 2)} --addon-name ${seg(rid, 3) || name} --query 'addon.status' --output text`,
      pass: 'ACTIVE (not DEGRADED)',
    };
    case 'db-subnet-group': return {
      command: `aws rds describe-db-subnet-groups ${reg} --db-subnet-group-name ${afterPrefix(rid, 'dbsubnet/') || name} --query 'DBSubnetGroups[0].Subnets[].SubnetIdentifier' --output text`,
      pass: 'it exists and lists RECOVERY-region subnets in at least two AZs',
    };
    case 'parameter-group': return {
      command: `aws rds describe-db-cluster-parameter-groups ${reg} --db-cluster-parameter-group-name ${name} --query 'DBClusterParameterGroups[0].DBParameterGroupName' --output text  # for an instance group use: aws rds describe-db-parameter-groups`,
      pass: 'the group exists in the recovery region with the same non-default parameters',
    };
    case 'repository': return {
      command: `aws ecr describe-images ${reg} --repository-name ${name} --query 'length(imageDetails)' --output text`,
      pass: 'the repository exists in the RECOVERY region and holds the TAG the workload pulls — an empty repository in the right region is still ImagePullBackOff',
    };
    case 'log-group': return {
      command: `aws logs describe-log-groups ${reg} --log-group-name-prefix ${name} --query 'logGroups[0].logGroupName' --output text`,
      pass: 'it exists, or you accept auto-creation on first write (which loses retention and any customer-managed key)',
    };
    case 'alarm': return {
      command: `aws cloudwatch describe-alarms ${reg} --alarm-names ${name} --query 'MetricAlarms[0].StateValue' --output text`,
      pass: 'OK — and it is evaluating a real metric, not INSUFFICIENT_DATA, which is what an alarm on a resource that has not started yet reports',
    };
    case 'api-gateway': return {
      command: `aws apigatewayv2 get-api ${reg} --api-id ${seg(rid, 1)} --query '[Name,ApiEndpoint]' --output text  # a REST (v1) API instead: aws apigateway get-rest-api ${reg} --rest-api-id ${seg(rid, 1)}`,
      pass: 'the API exists in the recovery region and its STAGE is deployed — an API with no deployed stage returns 403 with no useful message. Note the api-id is region-scoped: substitute the recovery-region id.',
      supply: true,
    };
    default: return null;
  }
}

// The one check for a thing that is confirmed rather than built.
function preconditionCheck(it) {
  if (it.kind === 'fence-gate') {
    return {
      command: `# Fence the old primary BEFORE promoting or restoring here. Prove ONE of:\n#   - the old-region writer is scaled to zero / stopped, or\n#   - its database security-group ingress is revoked, or\n#   - it reports as a reader (a graceful switchover demotes it; an ungraceful failover does NOT).\n# Then record WHICH of the three you did, with a timestamp.`,
      pass: 'one of the three is demonstrably true and written down. Two writers on the same ledger is unrecoverable in a way that downtime is not.',
      supply: true,
    };
  }
  if (it.kind === 'external-precondition' || it.action === 'verify') {
    // The target may be an address the flow import captured, or a human label a
    // person typed ("Settlement SFTP (bank partner)"). Only the first is
    // dialable: `nc -vz Settlement SFTP (bank partner)` is not a command, and
    // printing it would be exactly the kind of plausible nonsense this generator
    // exists to avoid. So probe when there is an address, and ask for one when
    // there is not.
    const target = str(it.name);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target);
    const isHost = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(target);
    // Ports come from the outbound calls that produced this precondition, so they
    // are observed rather than assumed.
    const ports = arr(it.probePorts).slice(0, 3);
    const addressable = isIp || isHost;
    const lines = addressable
      ? (ports.length
        ? ports.map((p) => (p === 443 && isHost
          ? `curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 10 https://${target}/`
          : `nc -vz -w 5 ${target} ${p}`))
        : [isHost
          ? `curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 10 https://${target}/`
          : `nc -vz -w 5 ${target} <port>      # SUPPLY the port — none is recorded on the call`])
      : [`# SUPPLY the hostname or IP behind "${target}" — this is a label, not an address —`,
        `# then: nc -vz -w 5 <host> <port>   (or curl for an HTTPS endpoint)`];
    return {
      command: `# ${target} — reach it FROM the recovery VPC (a pod or a bastion there), not from your laptop:\n${lines.join('\n')}`,
      pass: `it answers from inside the recovery VPC, the partner's allowlist covers the recovery-region egress IP, and the credentials are valid there — all three, dated and initialled.`,
      supply: !addressable || !ports.length,
    };
  }
  return null;
}

// One item -> the best check available, most authoritative source first.
function checkFor(it, region) {
  const inv = str(it.verify);
  if (inv) {
    return {
      command: inv,
      pass: str(it.verifyPass) || 'the command succeeds — this is the verification recorded on the component in Inventory, so its pass criterion belongs there too',
      source: 'inventory',
    };
  }
  const pre = preconditionCheck(it);
  if (pre) return { ...pre, source: 'precondition' };
  if (it.source === 'k8s') {
    const k = k8sCheck(it);
    if (k) return { ...k, source: 'k8s' };
  }
  const a = awsCheck(it, region);
  if (a) return { ...a, source: 'aws' };
  return {
    supply: true,
    command: `# ${it.name} [${it.kind}]: the engine has no identifier it can build a check from.\n# SUPPLY one — record a verification command on the component in Inventory → Verification, and it will appear here.`,
    pass: 'you decide what "done" means for this item, and write it down before the next test.',
    source: 'none',
  };
}

// ============================================================ RUNBOOK DRAFT

/**
 * toRunbookDraft(result, {workspace, name, tooling, scenario, audience})
 * -> a SPEC-shaped runbook DRAFT (never written by this module).
 * One step per (wave, category); the last step of each wave is a gate.
 */
export function toRunbookDraft(result, opts = {}) {
  const ws = opts.workspace || {};
  const tooling = str(opts.tooling) || (arr(ws.tooling)[0] || '');
  const recoveryRegion = str(ws.regions && ws.regions.recovery);
  // Every AWS check below is written for the RECOVERY region. Use the workspace's
  // recorded recovery region when there is one; otherwise a shell variable the
  // operator sets once, which is honest about not knowing rather than defaulting
  // to a region and being quietly wrong in every command.
  const region = recoveryRegion || '"$DR_REGION"';
  const steps = [];
  let n = 0;
  const stepId = () => { n += 1; return `stp_${String(n).padStart(2, '0')}`; };
  // Verification blocks are the useful part of a step, but a 60-item wave must not
  // produce a 120-line one. Show the first CHECK_LIMIT and say how many are left.
  const CHECK_LIMIT = 10;
  let stepsNeedingSupply = 0;

  for (const wave of arr(result.waves)) {
    const groups = arr(wave.categories);
    for (const [gi, grp] of groups.entries()) {
      const last = gi === groups.length - 1;
      const items = arr(grp.items);
      const detailLines = items.slice(0, 25).map((it) => {
        // Show the most MEANINGFUL prerequisites (highest confidence), not just
        // the ones that happen to set the wave — a soft "the mesh webhook should
        // be up" reads far less usefully than "reads Secret x at start-up".
        const why = arr(it.waitsFor).slice()
          .sort((a, b) => b.confidence - a.confidence || Number(b.binding) - Number(a.binding))
          .slice(0, 2).map((w) => clip(w.why, 170));
        const because = why.length ? ` — ${why.join('; ')}` : '';
        return `• ${it.name} [${it.kind}${it.action !== 'deploy' ? `, ${it.action}` : ''}]${because}`;
      });
      if (items.length > 25) detailLines.push(`• …and ${items.length - 25} more (see the Deployment order view)`);
      const gates = items.filter((it) => it.readinessGate).map((it) => it.name).slice(0, 6);
      const est = items.map((it) => it.estMinutes).filter((x) => x !== null);
      const cycleItems = items.filter((it) => it.inCycle);

      // ---- per-item checks: derived, or an explicit "you must supply"
      const checks = items.map((it) => ({ it, check: checkFor(it, region) }));
      const shown = checks.slice(0, CHECK_LIMIT);
      const supplyCount = checks.filter((c) => c.check.supply || c.check.source === 'none').length;
      if (supplyCount) stepsNeedingSupply += 1;
      const verifyText = [
        ...shown.map(({ it, check }) => `# ${it.name}${it.kind ? ` [${it.kind}]` : ''}\n${check.command}`),
        ...(checks.length > CHECK_LIMIT
          ? [`# …and ${checks.length - CHECK_LIMIT} more item(s) in this step — the Deployment order view carries a check for each.`]
          : []),
      ].join('\n');
      // When every item in a step shares a pass criterion (a wave of subnets, a
      // wave of partner endpoints), say it once instead of N times.
      const distinctPass = uniq(shown.map(({ check }) => check.pass));
      const passText = [
        ...(distinctPass.length === 1 && shown.length > 1
          ? [`Every item in this step — ${distinctPass[0]}`]
          : shown.map(({ it, check }) => `${it.name}: ${check.pass}`)),
        ...(checks.length > CHECK_LIMIT ? [`…and the same for the remaining ${checks.length - CHECK_LIMIT} item(s).`] : []),
        ...(gates.length ? [`READY, not merely created: ${gates.join(', ')} — everything in the next wave assumes it.`] : []),
      ].join('\n');

      // ---- the deploy command. The engine will NOT author one: creating these
      // resources is your IaC's job, and a plausible-looking `terraform apply`
      // here would be exactly the kind of invented content this product refuses
      // everywhere else. So say precisely what has to be supplied, and name the
      // things it has to create. The exception is a step made only of things that
      // are CONFIRMED rather than built, where the check IS the step.
      const allVerify = items.length > 0 && items.every((it) => it.action === 'verify');
      const names = items.map((it) => it.name);
      const nameList = names.slice(0, 8).join(', ') + (names.length > 8 ? `, …and ${names.length - 8} more` : '');
      const commandText = allVerify
        ? [
          `# NOTHING IS CREATED IN THIS STEP. Every item here is confirmed, not deployed —`,
          `# a partner allowlist, an approved egress IP, a valid credential or a fenced old`,
          `# primary cannot be built during the event, and the lead time on arranging one is`,
          `# measured in days. Run the verification below and record who confirmed it, when.`,
          `# If any of it is not already true, this is a PRE-EVENT task, not a recovery step.`,
        ].join('\n')
        : [
          `# SUPPLY THE CREATE/RESTORE COMMAND FOR THIS STEP.`,
          `# DR Compass does not author it: it depends on your tooling${tooling ? ` (recorded here as "${tooling}")` : ' (none recorded on this workspace)'}, and a generated`,
          `# command that looked right would be worse than none. Replace this block with the apply /`,
          `# reconcile / restore invocation that creates, in the recovery region${recoveryRegion ? ` (${recoveryRegion})` : ''}:`,
          ...names.slice(0, 12).map((x) => `#   - ${x}`),
          ...(names.length > 12 ? [`#   - …and ${names.length - 12} more (listed in full above)`] : []),
          `# Everything in this step can run in PARALLEL; the verification below is what closes it.`,
        ].join('\n');

      // ---- owner, inherited from the components in this step
      const owners = uniq(items.map((it) => str(it.owner)).filter(Boolean)).sort(byStr);
      const ownerText = owners.length === 1 ? owners[0]
        : owners.length > 1
          ? `${owners.slice(0, 3).join(' / ')}${owners.length > 3 ? ` +${owners.length - 3} more` : ''}`
          : 'unassigned';

      // ---- the step's restore layer, from ITS OWN items.
      //
      // This used to be `wave.layer`, which is the wave's PRIMARY layer (the
      // most common one among everything in the wave, across all its category
      // groups). A wave that mixes an L2 subnet with a public L5 load balancer
      // therefore printed `L2` over the load balancer, and the document opened
      // at L6 (wave 0 is third-party preconditions, and a partner system is
      // declared L5/L6) before dropping to L1 — which reads as nonsense as a
      // restore narrative. An executor uses the layer tag to know where in the
      // restore cake they are standing; it has to be true of the step.
      const itemLayers = uniq(items.map((it) => str(it.layer)).filter(Boolean))
        .sort((a, b) => layerRank(a) - layerRank(b));
      // Things that are CONFIRMED rather than built are preconditions: their
      // place in the cake is L0 — before anything is launched — not the restore
      // layer of the partner system being confirmed.
      const allPrecondition = items.length > 0
        && (grp.category === 'third-party' || items.every((it) => it.kind === 'external-precondition'));
      const stepLayer = allPrecondition ? 'L0'
        // Otherwise the step is as late in the cake as the LATEST thing in it:
        // the step is not finished until its last item is up.
        : (itemLayers.length ? itemLayers[itemLayers.length - 1] : str(wave.layer));

      const notesBits = [];
      if (!allPrecondition && itemLayers.length > 1) {
        notesBits.push(`Restore layers in this step: ${itemLayers.join(', ')}. It is tagged ${stepLayer} — the latest of them — because the step is not done until its last item is up. ${itemLayers[0]} items here can start as soon as the previous gate passes.`);
      }
      if (allPrecondition && itemLayers.length) {
        notesBits.push(`Tagged L0: nothing in this step is created, so its place in the restore cake is "before launch", not the ${itemLayers.join('/')} of the systems being confirmed.`);
      }
      if (cycleItems.length) notesBits.push(`⚠ ${cycleItems.length} item(s) here are in a reported dependency cycle — read the cycle report before running this step.`);
      for (const r of arr(wave.reviewReasons)) notesBits.push(`⚠ ${r}`);
      if (!owners.length) notesBits.push('⚠ No owner: no component in this step records an `owner` or a `team`. Name one in Inventory — an unowned step at 3am is an unstarted step.');
      if (!est.length) notesBits.push('No time estimate: no runbook step in this workspace names exactly one of these components with an estMinutes, and the engine will not invent one. Fill it in from your next test.');
      if (supplyCount) notesBits.push(`${supplyCount} of ${items.length} item(s) here need something from you before the check runs — an identifier, a port, or a verification command. Each is marked SUPPLY in the verification block rather than left blank: the engine will not guess an identifier it does not have.`);

      steps.push({
        id: stepId(),
        layer: stepLayer,
        title: `Wave ${wave.index} — ${grp.label}`,
        detail: [
          allVerify
            ? `Confirm in parallel (${items.length} item${items.length === 1 ? '' : 's'}) — none of these is created here; they must already be true.`
            : `Deploy in parallel (${items.length} item${items.length === 1 ? '' : 's'}); every prerequisite is satisfied by wave ${wave.index === 0 ? '—' : `0..${wave.index - 1}`}.`,
          ...detailLines,
          ...notesBits,
        ].join('\n'),
        command: commandText,
        verify: verifyText,
        pass: passText || 'Every item in this step exists and its own verification passes.',
        owner: ownerText,
        estMinutes: est.length ? Math.max(...est) : null,
        record: last ? `Timestamp when wave ${wave.index} is green` : '',
        componentIds: uniq(items.map((it) => str(it.componentId)).filter(Boolean)),
        gate: last,
      });
    }
  }

  // ---- L6 and L7: the part no inventory can derive, and no runbook may omit.
  //
  // The engine orders what is in the inventory, and an inventory ends at "the
  // components are up". The product spends sixteen articles saying that is not
  // recovery — `04-restore-layer-cake.md:49-52`, "shifting live traffic onto a
  // stack that has never completed a business transaction converts a regional
  // outage into a customer-facing incident you caused"; `02-dr-fundamentals.md`,
  // "green pods are not recovery". A generated runbook that stops at L4/L5 hands
  // the operator an estate that is up and never tells them to prove it works or
  // to move traffic. So the draft appends both, marked plainly as SYNTHESISED
  // rather than ordered, with real pass criteria and the gate in front.
  let appended = 0;
  if (steps.length) {
    const allItems = arr(result.waves).flatMap((w) => arr(w.categories).flatMap((c) => arr(c.items)));
    const appNames = uniq(allItems
      .filter((it) => str(it.layer) === 'L4' && it.action !== 'verify')
      .map((it) => str(it.name)).filter(Boolean));
    const edgeNames = uniq(allItems
      .filter((it) => str(it.layer) === 'L7' || cat(it.category) === 'edge-dns')
      .map((it) => str(it.name)).filter(Boolean));
    const where = recoveryRegion || 'the recovery region';
    // A drill must not flip public DNS. The step still ships — the operator has
    // to know what they are NOT doing, and why — but it says so first.
    const isDrill = /\b(test|drill|exercise|rehearsal|phase ?1|dry ?run)\b/i.test(str(opts.scenario));
    const listOf = (names, n = 6) => names.slice(0, n).join(', ') + (names.length > n ? `, and ${names.length - n} more` : '');

    steps.push({
      id: stepId(),
      layer: 'L6',
      title: 'GATE — functional success bar: prove ONE business transaction end to end',
      detail: [
        'Everything above ends when the last component reports healthy. That is not recovery. Green pods, a Bound PVC and a 200 from a health endpoint prove the stack STARTED — they do not prove it can do the business\'s work from this region, and the gap between the two is where a regional event becomes an incident you caused.',
        'This step is SYNTHESISED, not ordered: nothing in this workspace records what a business transaction is here, and the engine will not invent one. Name the smallest transaction that goes all the way through the write path — one claim, one order, one payment — and run it against the recovery-region endpoint DIRECTLY, with public DNS untouched.',
        appNames.length ? `• Applications this order brings up: ${listOf(appNames)}. The transaction must exercise the tier-0 one, not the easiest one.` : '',
        '• The timestamp you record here is T1. RTA is T1 − T0. Nothing before this step has produced a recovery time — a stack that is up has a start-up time, not a recovery time.',
        '⚠ If this fails, STOP. Do not run the next step. A failed success bar with traffic still on the primary is a contained problem; a failed success bar after the traffic move is an outage you own.',
      ].filter(Boolean).join('\n'),
      command: [
        '# SUPPLY THE TRANSACTION. Only you know what "a claim went through" means here.',
        '# Run it against the RECOVERY-region endpoint, resolving PAST public DNS so that',
        '# nothing about this step depends on the flip that has not happened yet:',
        `curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 30 \\`,
        '  --resolve <public-host>:443:<recovery-endpoint-ip> \\',
        '  -X POST https://<public-host>/<transaction-path> -d @<transaction-body.json>',
        '# then PROVE THE EFFECT in the recovery-region datastore. An HTTP 200 is the',
        '# application agreeing to take the request, not evidence that it landed:',
        '#   psql -h <recovery-writer-endpoint> -c "SELECT * FROM <table> WHERE id = \'<txn-id>\'"',
        '# and check the downstream side effect too (the queue drained, the file left,',
        '# the partner acknowledged) — one of those is usually the thing that is broken.',
      ].join('\n'),
      verify: 'The transaction completes, and its effect is visible in the recovery-region datastore and in whatever it hands off to.',
      pass: 'ONE named business transaction completed end to end against the recovery-region endpoint, its id and timestamp written down, and its EFFECT confirmed in the data — not just an HTTP code. A health check, a login page, a green dashboard or a passing readiness probe is NOT a pass.',
      owner: 'operator, witnessed by a named business approver',
      estMinutes: null,
      record: 'Transaction id; the endpoint it ran against; the timestamp (this is T1); who witnessed it; and anything you deliberately did NOT exercise, so the next reader knows what this proves and what it does not.',
      componentIds: [],
      gate: true,
    });

    steps.push({
      id: stepId(),
      layer: 'L7',
      title: `${isDrill ? 'DO NOT RUN IN THIS SCENARIO — ' : ''}Move live traffic to ${where}`,
      detail: [
        isDrill
          ? `⚠ The scenario on this runbook is "${str(opts.scenario)}". A test does not move live traffic: stop after the success bar above, record the numbers, and tear down. This step is here so it is explicit what a test is NOT doing — running it turns the drill into a real cutover.`
          : 'This is the only step that puts real users on the recovery region, and it runs ONLY after the L6 gate above has passed with a named approver against it.',
        'It is L7, not L5. L5 is "the edge answers"; L7 is "customers are on it". Mislabelling the two is how a traffic move gets run before anything has completed a transaction.',
        edgeNames.length
          ? `• The edge/DNS items in this order are: ${listOf(edgeNames)}. They were CREATED earlier in the restore; this step is the FLIP, and it is a verify-and-approve action rather than a deploy.`
          : '• No edge or DNS component is recorded in this workspace, so the engine cannot name what you flip. Add the record, distribution or routing control to Inventory and it will appear here.',
        '• TTL decides how long this takes, and it is decided before the event, not during it. Check the current TTL on the record you are about to change before you change it.',
        '• Partner allowlists key on egress IP. If a partner has not allowlisted the recovery-region egress, the transaction that passed above will start failing the moment real volume arrives.',
      ].filter(Boolean).join('\n'),
      command: [
        '# SUPPLY THE FLIP for your own edge. The engine will not author a DNS change it',
        '# cannot justify from your data — the wrong change-batch here is a global outage.',
        '# Before: record what resolvers answer today, so "back" is a defined place.',
        'dig +short <public-host> @1.1.1.1; dig +short <public-host> @8.8.8.8',
        '# The flip (Route 53 example — substitute your own edge):',
        '#   aws route53 change-resource-record-sets --hosted-zone-id <zone> \\',
        '#     --change-batch file://cutover.json',
        '# After: watch resolvers CONVERGE, not just the API return 200.',
        'for i in 1 2 3 4 5; do dig +short <public-host> @1.1.1.1; sleep 30; done',
      ].join('\n'),
      verify: 'Public resolvers answer with the recovery-region target from more than one vantage point, and the SAME business transaction from the previous step now succeeds through the PUBLIC hostname.',
      pass: `Resolvers have converged; the business transaction succeeds through the public hostname; error rate and latency are flat for at least one full TTL past the flip. Any one of those failing means roll back to ${str(ws.regions && ws.regions.primary) || 'the primary region'} — which is a decision, with a named decider, not a reflex.`,
      owner: 'approver (the traffic move) + operator (the change)',
      estMinutes: null,
      record: 'Approver and time of approval; the pre-flip resolver answers; the flip time; the TTL; the first public transaction id after the flip; and the error-rate window you watched.',
      componentIds: [],
      gate: true,
    });
    appended = 2;
  }

  // ---- preconditions.
  //
  // This block is the FIRST thing a 3am operator reads, and it used to be
  // fourteen near-identical paragraphs about IP addresses: every external target
  // was listed twice, once in short form from waves[0] and once in long form from
  // callOrderIssues, with a suggestion string that is identical for all of them.
  // Merge on the target, keep the part that differs (who calls it, and how), and
  // state the shared instruction ONCE at the top.
  // Keyed on the SLUG, not the literal string: an inventory component called
  // "Settlement SFTP (bank partner)" and an outbound call recorded against
  // "settlement SFTP (bank partner)" are one partner, and printing both is how
  // this block grew to fourteen paragraphs in the first place.
  const externals = new Map();          // slug -> {name, callers:Set, detail:Set}
  const external = (name) => {
    const key = slug(name);
    if (!externals.has(key)) externals.set(key, { name: str(name), callers: new Set(), detail: new Set() });
    const e = externals.get(key);
    // Prefer the longer spelling as the display name — it is the one that
    // carries the qualifier a reader needs.
    if (str(name).length > e.name.length) e.name = str(name);
    return e;
  };
  for (const w of arr(result.waves).slice(0, 1)) {
    for (const c of arr(w.categories)) {
      if (c.category !== 'third-party') continue;
      for (const it of arr(c.items)) external(it.name);
    }
  }
  for (const i of arr(result.callOrderIssues)) {
    if (i.kind !== 'external-precondition') continue;
    const e = external(i.target);
    if (i.componentName) e.callers.add(i.componentName);
    if (i.severity === 'high') e.detail.add('critical, and not classified as runtime-only');
    if (i.when === 'startup') e.detail.add('called at start-up, so it blocks bring-up');
  }
  const externalLines = [...externals.values()].sort((a, b) => byStr(a.name, b.name)).map((e) => {
    const who = e.callers.size ? ` — called by ${[...e.callers].sort(byStr).join(', ')}` : '';
    const extra = e.detail.size ? ` (${[...e.detail].sort(byStr).join('; ')})` : '';
    return `${e.name}${who}${extra}`;
  });
  const preconditions = [
    ...(externalLines.length ? [
      `${externalLines.length} external endpoint${externalLines.length === 1 ? '' : 's'} must ALREADY be true before step 1 — ${PRECONDITION_WORDING} For each one, confirm from the RECOVERY region: the partner has allowlisted the recovery-region egress IP, the credentials are valid there, and the endpoint answers. Allowlist and egress-IP approvals have lead times measured in days, so none of this can be arranged during the event.`,
      ...externalLines,
    ] : []),
    ...arr(result.unordered).map((u) => `Unresolved: ${u.name} — ${u.reason}`),
    ...arr(result.cycles).map((c) => `Dependency cycle (${c.nodes.map((x) => x.name).join(' → ')}) — decide the break before running this.`),
  ];

  const notes = [
    'DRAFT generated from the deployment-order engine. Nothing here is a measurement: estMinutes is only filled in where a runbook step in this workspace already recorded one, and is null otherwise — fill it from your last test rather than estimating.',
    `WHAT THIS DOCUMENT IS. Every step carries a real, derived VERIFICATION command and a concrete pass criterion. It does NOT carry create/restore commands: those depend on your IaC, and this engine will not invent one it cannot justify from your data. So each step's \`command\` names exactly what you must supply.${stepsNeedingSupply ? ` ${stepsNeedingSupply} of ${steps.length} step(s) additionally need an identifier or a verification command from you, marked "SUPPLY" in the verification block.` : ''} Read it as an ORDERED, VERIFIABLE CHECKLIST that you attach your own commands to — not as a script you can run end to end.`,
    `Commands are written for the RECOVERY region${recoveryRegion ? ` (${recoveryRegion})` : ', which this workspace has not recorded — set DR_REGION in your shell before running any of them'}. Read this once: EC2 ids (vpc-, subnet-, sg-…) and ARNs are region-scoped and do NOT exist in the recovery region, so resources are looked up by Name tag or by name wherever that is possible, and the few checks that can only be written against an ARN say so and ask for the recovery-region equivalent. Anything in your own tooling that hard-codes a primary-region id is broken before you start.`,
    'Each wave boundary is a gate: the last step of every wave has gate:true because the next wave assumes this one is verified, not merely submitted.',
    appended
      ? 'THE LAST TWO STEPS ARE SYNTHESISED, NOT ORDERED. The restore order can only sort what is in your inventory, and an inventory ends at "the components are up" — which this product spends sixteen articles explaining is not recovery. So the draft appends an L6 functional success bar (prove ONE business transaction end to end against the recovery-region endpoint, with public DNS untouched) and the L7 traffic move behind it. Both need something from you: the L6 step needs the transaction, the L7 step needs your own edge change. Neither is optional, and the L6 gate is what makes the L7 step safe — the traffic move is the only step here that can turn a regional outage into an incident you caused.'
      : 'No steps were generated, so no success bar or traffic cutover was appended: there is nothing yet for them to follow.',
    `Each step's restore layer is the LATEST layer among its own items, not the wave's — a step that contains a public L5 load balancer is tagged L5 even when the rest of its wave is L2, because the step is not finished until its last item is up. Steps made only of things that are confirmed rather than built are tagged L0: their place in the cake is "before launch", not the restore layer of the partner system being confirmed.`,
    'No rollback is drafted on purpose. A rollback that was auto-generated is worse than none: it depends on your tooling, and on whether data has already been promoted (flipping back to a fenced primary after a soak orphans every write taken here). Author it against your own failover path.',
    result.inputs && result.inputs.k8s === 'absent'
      ? 'No Kubernetes snapshot was available, so the pod-level start-up prerequisites (mounted secrets, service accounts, PVCs, image pulls) are NOT in this draft.'
      : '',
  ].filter(Boolean);

  return {
    name: str(opts.name) || `Deployment order — ${str(ws.name) || 'recovery'}${result.inputs && result.inputs.scope ? ` (${result.inputs.scope.name})` : ''}`,
    tooling,
    scenario: str(opts.scenario) || 'region-loss',
    audience: str(opts.audience) || 'operator',
    preconditions: uniq(preconditions).slice(0, 40),
    steps,
    rollback: [],
    linkedTestIds: [],
    notes: notes.join('\n\n'),
  };
}

// ======================================================= AI-ASSIST SUBGRAPH

/**
 * ambiguousSubgraph(result, {limit}) -> ONLY the part the engine is unsure about:
 * cycle members, unordered items, and the lowest-confidence edges among them.
 * This is what gets sent to the local AI — never the whole workspace.
 */
export function ambiguousSubgraph(result, opts = {}) {
  const limit = num(opts.limit) || 60;
  const m = result && result._model;
  const ids = new Set();
  for (const c of arr(result.cycles)) for (const n of c.nodes) ids.add(n.id);
  for (const issue of arr(result.callOrderIssues)) {
    if (issue.kind === 'startup-order' || issue.kind === 'unresolved-target') {
      if (issue.componentId) ids.add(issue.componentId);
      if (issue.targetComponentId) ids.add(issue.targetComponentId);
    }
  }
  // neighbours of cycle members give the model enough context to judge a break
  if (m) {
    for (const id of [...ids]) {
      for (const e of (m.preds.get(id) || [])) if (ids.size < limit) ids.add(e.from);
      for (const e of (m.succs.get(id) || [])) if (ids.size < limit) ids.add(e.to);
    }
  }
  const nodeList = [...ids].sort(byStr).slice(0, limit).map((id) => {
    const it = m && m.items.get(id);
    return it ? {
      id, name: it.name, kind: it.kind, category: it.category,
      tier: it.tier, tierName: it.tierName, layer: it.layer, wave: it.wave,
      inCycle: it.inCycle, action: it.action,
    } : { id, name: id, kind: 'missing' };
  });
  const keep = new Set(nodeList.map((x) => x.id));
  const edgeList = m
    ? [...m.edges, ...m.broken].filter((e) => keep.has(e.from) && keep.has(e.to))
      .map((e) => ({ ...publicEdge(e), setAside: m.broken.includes(e) }))
      .sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to))
    : [];
  const unordered = arr(result.unordered).filter((u) => u.actionable !== false);
  // Unordered items ARE part of the question ("where does this belong?"), so put
  // them in the node list, and offer the inventory components as anchors the
  // model can attach them to.
  for (const u of unordered) {
    if (keep.has(u.id)) continue;
    nodeList.push({
      id: u.id, name: u.name, kind: u.kind, category: u.category,
      unordered: true, reason: u.reason,
    });
    keep.add(u.id);
  }
  const anchors = m
    ? [...m.items.values()].filter((i) => i.source === 'component')
      .sort((a, b) => byStr(a.id, b.id))
      .map((i) => ({ id: i.id, name: i.name, kind: i.kind, category: i.category, tier: i.tier, wave: i.wave }))
    : [];
  return {
    anchors,
    nodes: nodeList,
    edges: edgeList,
    cycles: arr(result.cycles).map((c) => ({
      id: c.id, nodes: c.nodes.map((n) => n.id), suggestedBreak: c.suggestedBreak, why: c.why,
    })),
    unordered,
    callOrderIssues: arr(result.callOrderIssues).filter((i) => i.severity !== 'medium'),
    empty: !nodeList.length && !unordered.length,
  };
}

// ====================================================== SLUG CONVENIENCE API

/**
 * deployOrder(slug, opts) -> the same model, loaded from the workspace store.
 * `opts.componentId` (or `opts.scope`) scopes it to one service's closure.
 * This is the signature the workbook and the routes both use.
 */
export async function deployOrder(slug, opts = {}) {
  const store = await import('../store.js');
  const scope = str(opts.componentId || opts.scope
    || (Array.isArray(opts.componentIds) ? opts.componentIds[0] : ''));
  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  return computeDeployOrder({
    components: read(() => store.getCollection(slug, 'components'), []),
    runbooks: read(() => store.getCollection(slug, 'runbooks'), []),
    graph: read(() => store.getObject(slug, 'resource-graph'), {}),
    k8s: read(() => store.getObject(slug, 'k8s'), {}),
    scope: scope || null,
    options: opts.options || {},
  });
}

export const buildDeployOrder = deployOrder;
export default deployOrder;

