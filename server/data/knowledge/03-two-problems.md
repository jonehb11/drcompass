# The two problems: rebuilding the shape vs having the bytes
<!-- section: Start here | order: 30 -->

Every regional recovery decomposes into exactly two problems. Teams that blur them buy
the wrong tools and test the wrong things. Keep them separate in your head, your
inventory, and your budget.

## Problem 1: "Can I rebuild the shape?"

The *shape* is everything stateless-but-necessary: clusters, services, load balancers,
queues, topics, IAM roles, security groups, parameter values, DNS records, certificates.
It is **configuration** — information about how compute and plumbing should be arranged.

- **Solved by:** infrastructure-as-code executed in the recovery region, plus
  resource-graph tools (Arpio, and AWS discovery generally) that replicate or re-create
  environment configuration for you.
- **Failure mode:** drift. The console change nobody backported, the "temporary" security
  group rule, the Helm value set by hand. The shape you rebuild is the shape in git — if
  production's shape differs, your recovery differs.
- **Test:** can you stand up the whole stack in the recovery region from code, with no
  human copying values from the primary? If any step is "look at prod and do the same",
  the shape problem is unsolved.

## Problem 2: "Do I have the bytes?"

The *bytes* are the data: database contents, object storage, in-flight messages, secret
values, encryption keys. No amount of IaC regenerates a customer's order history.

- **Solved by:** replication and backup **only**. Aurora Global Database, S3 CRR,
  replica secrets, multi-Region KMS keys, cross-region backup copies, vendor snapshot
  replication. Physics applies: the bytes must already be in the recovery region (or
  restorable into it) *before* the disaster.
- **Failure mode:** silent staleness. Replication that stopped three weeks ago, a backup
  job that "succeeds" on an empty prefix, a secret rotated in the primary but not the
  replica. This is why Phase 0 checks replication lag and backup recency **daily**.
- **Test:** restore/promote in the recovery region and check the *newest* record's age.
  That number is your RPA.

## Why the separation matters

| | Shape | Bytes |
|---|---|---|
| Nature | Regenerable from source | Irreplaceable |
| Tooling | IaC, GitOps, resource-graph tools | Replication, backups |
| Cost driver | Engineering time | Storage + transfer, always-on replicas |
| Verified by | Clean environment build from git | Restore + data-freshness check |
| Ruined by | Drift | Lag, silent failure |
| RTO impact | How fast you can rebuild | How fast you can promote/restore |
| RPO impact | None | Entirely |

Concrete consequences:

- **A tool that solves one problem does not solve the other.** AWS Elastic Disaster
  Recovery replicates server bytes but won't rebuild your managed-service shape. Plain
  Terraform rebuilds shape but moves zero bytes. Arpio explicitly works both sides
  (resource graph + data replication) — when evaluating any tool, ask which problem each
  feature addresses.
- **Some things are secretly both.** A Secrets Manager secret is shape (the secret must
  exist, with the right name and ARN wiring) *and* bytes (the current value). KMS keys
  are shape (key policy, alias) and bytes (key material — which is why multi-Region keys
  exist). These dual citizens cause a disproportionate share of failed recoveries; see
  [secrets pitfalls](#/learn/13-secrets-pitfalls).
- **In-flight state is bytes people forget.** SQS queues and Kinesis streams have no
  native cross-region replication — the queue *definition* is shape and trivially
  rebuilt, but messages in flight at the moment of disaster are bytes you either
  architected around (idempotent producers that re-drive) or lost. Record the decision
  per component in the inventory (`replication.mechanism` and `rpoMinutes`).

In DR Compass, each component's `definedIn` answers the shape question ("where is the
code that rebuilds this?") and each component's `replication` block answers the bytes
question ("how do the bytes get to the recovery region, and how stale?"). If either field
is empty on a tier-0 component, that's a gap — file it.
