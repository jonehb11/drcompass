# Replication mechanisms: how the bytes get there
<!-- section: Strategies | order: 55 -->

Strategy columns are promises; replication mechanisms are how you keep them. This is
the menu for getting [the bytes](#/learn/03-two-problems) into the recovery region,
service by service, with the real numbers from AWS docs. Record the chosen mechanism on
every stateful component (`replication.mechanism`, `rpoMinutes`) — an empty field on
tier-0 state is a blocker gap.

## The menu

| Mechanism | Covers | Typical RPO | Notes |
|---|---|---|---|
| **Aurora Global Database** | Aurora MySQL/PostgreSQL | Lag typically **<1s**; planned **switchover = RPO 0**; unplanned failover = lag at failure | Storage-level async replication to up to 10 secondary regions. RTO "order of minutes". Aurora PostgreSQL can *enforce* an RPO ceiling (`rds.global_db_rpo`, min 20s) by blocking commits when lag exceeds it. [Docs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html) |
| **DynamoDB global tables** | DynamoDB | "Typically within a second"; **MRSC mode = RPO 0** (GA June 2025, same-account, limited regions) | Multi-active: every replica takes writes; last-writer-wins on conflict (eventual mode). No replication SLA — watch `ReplicationLatency`. [Docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html) |
| **S3 CRR + Replication Time Control** | S3 objects | RTC: **99.99% of objects within 15 min** (design goal; SLA credits kick in below 99.9%) | Replicates only objects written *after* enabling — run S3 Batch Replication for the backlog. Most objects replicate in seconds. [Docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html) |
| **ElastiCache Global Datastore** | Valkey/Redis (node-based) | "Typically under 1s"; RTO under a minute — **no SLA on either** | Primary + read-only secondary regions; promote to fail over. Often the right answer is instead: treat cache as rebuildable and measure warm-up time. [Docs](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Redis-Global-Datastore.html) |
| **ECR replication rules** | Container images | "Majority of images in <30 min" | Cross-region/cross-account; only images pushed *after* configuration; repo settings & lifecycle policies **not** replicated. Pullable-in-recovery-region is an L2 gate. [Docs](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html) |
| **Secrets Manager replica secrets** | Secret values + metadata | Rotation propagates automatically | Replica keeps the **same name** (ARN differs only by region) → name-based lookup fails over cleanly; per-region KMS key per replica; replica can be promoted to standalone. The keystone of [L3 secrets](#/learn/13-secrets-pitfalls). [Docs](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create-manage-multi-region-secrets.html) |
| **KMS multi-Region keys** | Key material | n/a (same key both sides) | Same key ID & material in each region — ciphertext moves without re-encryption. Can't convert an existing single-region key; policies/aliases are per-region shape; note some services (e.g., S3 CRR) re-encrypt with the destination key regardless. [Docs](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html) |
| **AWS Backup cross-region copy** | EBS/RDS/DynamoDB/EFS… recovery points | Backup cadence (hours) | Scheduled or on-demand copies to another region *and/or account* (account-level copies protect against account compromise). Copies re-encrypted with destination vault key; no copies out of cold storage. The floor under every fancier mechanism. [Docs](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html) |
| **DRS block replication** | EC2/on-prem server disks | Seconds | See [Elastic Disaster Recovery](#/learn/09-tooling-elastic-dr) |
| **Arpio recovery points / real-time** | Environment-wide (30+ services) | ~15 min (snapshot) / seconds (real-time) | See [Arpio](#/learn/06-tooling-arpio) |

## The hole in the menu: SQS and Kinesis

**Neither SQS nor Kinesis has native cross-region replication.** The queue/stream
*definition* is shape — trivially recreated by IaC. The **in-flight messages are bytes
with no managed mover**. Your options, in order of preference:

1. **Architect for loss**: idempotent producers that can re-drive from a durable source
   of truth (the DB, an S3 event archive). The queue becomes rebuildable state, RPO
   irrelevant. This is the answer for most workloads.
2. **Dual-write / fan-out**: SNS cross-region fan-out into queues in both regions
   ([AWS DR workshop pattern](https://disaster-recovery.workshop.aws/en/services/app_integration/sqs/active-active.html)),
   at the cost of dedup logic on the consumer side.
3. **Custom replicators** for Kinesis (aws-samples exist) — real engineering, real
   maintenance; justify against option 1 first.
4. **Accept and document the loss window** — a legitimate decision if made *in writing*
   in the decisions log, sized (max in-flight × processing lag), and re-validated in tests.

Whichever you choose, write it on the component. "We never decided" is the only wrong
answer.

## Rules for using the menu

- **Enabled is not working.** Every mechanism here fails silently — lag grows, a rule
  doesn't match a prefix, an agent stalls. Each replicated component needs a lag/recency
  metric checked **daily** (Phase 0), because current lag ≈ your RPA if the event is now.
- **Mind the "only after enabling" traps**: S3 CRR and ECR replication skip pre-existing
  objects/images. Backfill explicitly, then verify counts both sides.
- **Planned ≠ unplanned numbers.** Aurora's switchover is RPO 0; its failover is not.
  Quote the *unplanned* figure in your DR math — disasters don't schedule switchovers.
- **Design-goal ≠ SLA**: S3 RTC's 15-minute/99.99% is the design target; the SLA credit
  line is 99.9%. Quote precisely, especially to auditors.
- **Everything encrypted needs its key on the other side first.** Replication of
  ciphertext you can't decrypt is a very durable form of data loss
  ([secrets & KMS](#/learn/13-secrets-pitfalls)).
- **Strategy fit**: backup-copy mechanisms support backup & restore; continuous
  mechanisms (Aurora Global, global tables, CRR+RTC, Global Datastore) are what make
  pilot light and warm standby's RPO columns honest
  ([strategy matrix](#/learn/05-strategy-matrix)).
