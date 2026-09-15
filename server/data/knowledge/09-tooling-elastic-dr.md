# AWS Elastic Disaster Recovery (DRS): great tool, narrow lane
<!-- section: Tooling | order: 90 -->

AWS Elastic Disaster Recovery (DRS) is AWS's server-replication DR service — the
successor to CloudEndure (which was discontinued March 31, 2024). It does one thing
extremely well, and buying it for the wrong architecture is one of the most common DR
procurement mistakes. Know the lane before you sign.

## What it is

- An **AWS Replication Agent** on each source server performs **continuous block-level
  replication** — it captures disk blocks as they're written (no snapshot cycles),
  compressed and encrypted in transit
  ([FAQ](https://aws.amazon.com/disaster-recovery/faqs/)).
- Blocks land in a low-cost **staging area** in your target region/account: lightweight
  replication servers plus cheap EBS — you are *not* paying for a standby copy of your
  fleet.
- On a drill or a real recovery, DRS launches your servers as native EC2 instances
  "within minutes", from the latest state **or a prior point in time** (crucial for
  ransomware/corruption — the latest bytes are the poisoned bytes)
  ([what is DRS](https://docs.aws.amazon.com/drs/latest/userguide/what-is-drs.html)).
- **Non-disruptive drills** and **failback** to the source are built in.
- AWS positions it as "RPOs of seconds, RTOs of minutes" — effectively pilot-light cost
  with warm-standby-ish recovery characteristics for the servers it protects.

**Sources it supports**: physical servers, VMware, Hyper-V, other clouds, and EC2
itself (cross-AZ or cross-region).

## Pricing

**$0.028 per source server per hour** (~$20/server/month), flat regardless of disk size,
including drills and point-in-time recovery — plus normal AWS charges for staging
resources and for recovery instances while they run. AWS's own worked example: 100
servers / 30 TB ≈ $6,389/month all-in
([pricing](https://aws.amazon.com/disaster-recovery/pricing/)).

## When it fits

| Situation | Why DRS is right |
|---|---|
| On-prem / other-cloud servers → AWS as the recovery site | Its original core use case; agent-based, hypervisor-agnostic |
| Lift-and-shift estates: apps and databases **on EC2** | Block-level replication captures everything — OS, config drift, the cron job nobody documented |
| Legacy servers nobody can rebuild from code | The [shape problem](#/learn/03-two-problems) is unsolvable by IaC when there is no IaC; DRS clones the shape *and* the bytes |
| Ransomware concerns on server estates | Point-in-time recovery to before the encryption event |

## When NOT to buy it

Here is the sentence to read twice, from AWS's own DR whitepaper: DRS protects
server-hosted applications and databases and applies to AWS workloads only "**if they
consist only of applications and databases hosted on EC2 (that is, not RDS)**"
([whitepaper](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)).

So do **not** buy DRS when:

- **You have no meaningful EC2 fleet.** A stack of EKS-on-managed-nodes, Aurora, SQS,
  Kinesis, S3, Lambda and Secrets Manager gives DRS almost nothing to replicate.
  Replicating EKS *worker nodes* block-by-block is actively wrong — nodes are cattle;
  the cluster's state lives in the control plane, ECR, and git.
- **Your databases are managed** (Aurora/RDS/DynamoDB): the right tools are the native
  ones — Aurora Global Database, global tables, cross-region backup copies
  ([replication mechanisms](#/learn/16-replication-mechanisms)).
- **You expect it to recover your environment.** DRS recovers *servers into* an
  environment; VPCs, load balancers, DNS, IAM, queues, secrets must exist via IaC or a
  tool like [Arpio](#/learn/06-tooling-arpio). "The servers are up" is L2 of an
  eight-layer cake.

The test: count the tier-0/1 components in your inventory whose kind is genuinely
"a server whose disk contents are the asset." If that number is near zero — as it is for
the cloud-native seed workspace in this app — DRS solves a problem you don't have, and
every dollar and hour it consumes comes out of the tooling that solves the problems you
do have.

## If you do run it

- Drills are cheap and non-disruptive — put them in the Phase 1 loop like everything
  else, and measure RTA from written timestamps, not the console's optimism.
- Replication lag and agent health are Phase 0 checks (a silently stalled agent is a
  growing RPA).
- Launch settings (subnet, instance type, security groups) are shape — keep them in IaC
  or at least reviewed on a schedule; they drift.
- Mark DRS-protected components in DR Compass with
  `replication.mechanism: "drs-block-replication"` and the *measured* `rpoMinutes`.
