# Arpio: environment-level DR as a service
<!-- section: Tooling | order: 60 -->

[Arpio](https://arpio.io/) is a commercial DR SaaS for AWS (and Azure) that attacks
*both* halves of the recovery problem — [shape and bytes](#/learn/03-two-problems) — as
one product: it discovers your environment as a resource graph, replicates data and
infrastructure configuration to another region and/or account, and launches a working
copy on demand. If your stack leans on managed services (Aurora, SQS, EKS, Secrets
Manager…), it occupies the gap that server-replication tools like
[Elastic Disaster Recovery](#/learn/09-tooling-elastic-dr) leave open.

## The model

| Concept | What it means |
|---|---|
| **Resource graph** | Arpio "continuously analyzes your applications, maps dependencies, replicates infrastructure" — it discovers resources *and their relationships*, so what launches is an environment, not a pile of resources ([how it works](https://arpio.io/how-it-works/)) |
| **Recovery points** | You set an RPO per application; that RPO drives how often Arpio captures the environment and replicates it. Recovery points can be applied and rolled back ([docs](https://docs.arpio.io/apply-a-recovery-point)) |
| **RPO granularity** | Snapshot-based replication bottoms out "usually around 15 minutes"; **real-time replication** (riding native AWS replication for EC2, Aurora, DynamoDB, S3) brings RPO "to seconds" ([docs](https://docs.arpio.io/real-time-rpo-replication)) |
| **Recovery environment** | A cross-region and/or **cross-account** pilot-light twin, kept turned down (Arpio cites customer-reported DR cost of ~1–2% of production) that launches "in minutes"; can preserve IPs and DNS naming ([how it works](https://arpio.io/how-it-works/)) |
| **Test drills** | Launch the recovery environment in isolation while production keeps serving. The optional **Network Sandbox** blocks outbound internet from the test environment (inbound allowed for validation) — so drills can't email your customers or call your partners. One-click teardown ([docs](https://docs.arpio.io/network-sandbox)) |
| **Failback** | "Failback to your primary environment with the click of a button, or continue running in your recovery environment" ([arpio.io](https://arpio.io/)) |
| **Air-gap / ransomware** | Multi-account protocol with immutable backups in an air-gapped "bunker" account; quarantined recovery for compromise scenarios ([how it works](https://arpio.io/how-it-works/)) |

That last row matters beyond ransomware: cross-**account** recovery also protects
against the disasters that are really account compromises or fat-fingered `terraform
destroy` — regional DR alone doesn't.

## Coverage

Arpio's docs list roughly 36 supported AWS services (marketing says "50+ services,
115+ resource types"): EC2/EBS, VPC, ECS, EKS, ECR, Lambda, Aurora, RDS (+ Proxy),
DynamoDB, S3, EFS, FSx, ElastiCache, OpenSearch, MSK, MQ, SQS, SNS, EventBridge,
Step Functions, API Gateway, Cognito, Route 53, ACM, IAM, KMS, Secrets Manager, SSM,
Transfer Family, Transit Gateway, WAF, CloudWatch and more
([supported resources](https://docs.arpio.io/supported-aws-resource-overview)).
Diligence still required: check *your* inventory's kinds against the list, per resource
type — "supports EKS" and "replicates every field of your EKS setup you rely on" are
different claims. Your DR Compass inventory's kind column is exactly the checklist for
that conversation.

## Pricing shape

Licensing counts **"core resources"** only — server-like things: VMs, databases,
filesystems — not data volume; you pay your own AWS storage/transfer costs (Arpio never
stores your data). Published tiers: Standard **$12k/yr** (25 core resources, RPO ≥ ~15
min); Premium **$36k/yr** (50 resources, real-time RPO, network sandbox, automated
failback); Enterprise custom ([pricing](https://arpio.io/pricing/),
[what counts](https://docs.arpio.io/what-resources-count-against-my-arpio-subscription)).

## Where it fits — and where it doesn't

**Fits:**

- Teams without mature IaC coverage: the resource graph replicates shape you never wrote
  down. (Then still pursue IaC — see [GitOps & IaC](#/learn/10-tooling-gitops-iac);
  recovery tooling shouldn't be the only place your architecture is recorded.)
- Managed-service-heavy stacks that DRS can't touch.
- Programs that will actually use the sandbox: isolated, teardown-safe drills remove the
  #1 excuse for not testing monthly.
- Pilot-light strategies wanting seconds-to-minutes RPO without engineering every
  replication pipeline by hand.

**Doesn't replace:**

- **Your runbook and test program.** Arpio executes L1 (and much of L2/L3 shape); your
  gates, L6 success bar, secrets reconciliation, and partner checks remain yours.
- **Traffic switching** — pair with [Route 53/ARC](#/learn/08-tooling-arc-route53) for L5/L7.
- **Third-party and cross-boundary dependencies** — no tool recovers a partner allowlist.

**Caveat emptor**: everything above is the vendor's published claims (cited); the 1–2%
cost figure is customer-reported, not audited. Run the proof-of-value against your own
tier-0 application and *measure the drill* — the sandbox makes that cheap, so there's no
excuse to buy on the datasheet.

In DR Compass, mark components protected by Arpio with
`replication.mechanism: "arpio-snapshot"` (or `arpio-realtime`) and set `rpoMinutes` to
what you've *observed* in drills, not the brochure number.
