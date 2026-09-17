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
| **Aurora Global Database** | Aurora MySQL/PostgreSQL | Lag typically **<1s**; planned **switchover = RPO 0**; unplanned failover = lag at failure | Storage-level async replication to **up to 10** secondary Regions — re-verified 2026-09-16: "An Aurora global database has a primary DB cluster in one Region, and up to 10 secondary DB clusters in different Regions" ([docs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)). The limit was **5** until [May 2025](https://aws.amazon.com/about-aws/whats-new/2025/05/amazon-aurora-global-database-support-10-secondary-region-clusters/), so older material (and reviewers) will say 5. RTO "order of minutes". Aurora PostgreSQL can *enforce* an RPO ceiling (`rds.global_db_rpo`, valid range 20s – 2,147,483,647s) by blocking commits when lag exceeds it — PostgreSQL only, not MySQL. |
| **DynamoDB global tables** | DynamoDB | "Typically within a second"; **MRSC mode = RPO 0** (GA June 2025, same-account, limited regions) | Multi-active: every replica takes writes; last-writer-wins on conflict (eventual mode). No replication SLA — watch `ReplicationLatency`. [Docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html) |
| **S3 CRR + Replication Time Control** | S3 objects | RTC: **99.99% of objects within 15 min** (design goal; SLA credits kick in below 99.9%) | Replicates only objects written *after* enabling — run S3 Batch Replication for the backlog. Most objects replicate in seconds. [Docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html) |
| **ElastiCache Global Datastore** | Valkey/Redis (node-based) | "Typically under 1s"; RTO under a minute — **no SLA on either** | Primary + read-only secondary regions; promote to fail over. Often the right answer is instead: treat cache as rebuildable and measure warm-up time. **AWS Backup does not protect ElastiCache** (see the note under this table) — if you are not using Global Datastore, your options are ElastiCache's own automatic/manual backups with cross-Region backup copy, or accepting a cold cache. [Docs](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Redis-Global-Datastore.html) |
| **ECR replication rules** | Container images | "Majority of images in <30 min" | Cross-region/cross-account; only images pushed *after* configuration; repo settings & lifecycle policies **not** replicated. Pullable-in-recovery-region is an L2 gate. [Docs](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html) |
| **Secrets Manager replica secrets** | Secret values + metadata | Rotation propagates automatically | Replica keeps the **same name** (ARN differs only by region) → name-based lookup fails over cleanly; per-region KMS key per replica; replica can be promoted to standalone. The keystone of [L3 secrets](#/learn/13-secrets-pitfalls). [Docs](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create-manage-multi-region-secrets.html) |
| **KMS multi-Region keys** | Key material | n/a (same key both sides) | Same key ID & material in each region — ciphertext moves without re-encryption. Can't convert an existing single-region key; policies/aliases are per-region shape; note some services (e.g., S3 CRR) re-encrypt with the destination key regardless. [Docs](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html) |
| **AWS Backup cross-region copy** | EBS/RDS/Aurora/DynamoDB/EFS/FSx/S3/DocumentDB/Neptune/Redshift/EC2/EKS… recovery points — **not ElastiCache, not MemoryDB** | Backup cadence (hours) | Scheduled or on-demand copies to another region *and/or account* (account-level copies protect against account compromise). Copies re-encrypted with destination vault key; no copies out of cold storage. The floor under every fancier mechanism — but only for resource types on the supported list, so check yours. [Cross-region copy](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html) · [supported resources](https://docs.aws.amazon.com/aws-backup/latest/devguide/working-with-supported-services.html) |
| **DRS block replication** | EC2/on-prem server disks | Seconds | See [Elastic Disaster Recovery](#/learn/09-tooling-elastic-dr) |
| **Arpio recovery points / real-time** | Environment-wide (30+ services) | ~15 min (snapshot) / seconds (real-time) | See [Arpio](#/learn/06-tooling-arpio) |

## The other hole: AWS Backup does not cover caches

**AWS Backup does not support Amazon ElastiCache — or Amazon MemoryDB.** Verified
2026-09-16 against the exhaustive
[supported-resources list](https://docs.aws.amazon.com/aws-backup/latest/devguide/working-with-supported-services.html):
neither service appears anywhere on it. This matters because "cache is on backup &
restore" is a very easy sentence to write in an inventory, and it points at a service
that cannot protect the resource. What you actually have:

- **ElastiCache's own backups** — manual and automatic snapshots stored in S3, with
  cross-Region **backup copy** as a separate operation. Note the coverage limit: backup
  and restore are supported only for Valkey, Redis OSS, and **Serverless** Memcached;
  provisioned (non-serverless) Memcached clusters have no backup capability at all
  ([docs](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/backups.html)).
- **Global Datastore** for live cross-Region replication (row above).
- **Treat the cache as rebuildable** and measure the warm-up cost instead — usually the
  right answer, and the one the [strategy matrix](#/learn/05-strategy-matrix) prefers. If
  you choose this, the number you owe the program is not an RPO; it is *how much extra
  load the cold cache puts on the recovered database at cutover*, measured in a test.

MemoryDB uses its own snapshot mechanism, not AWS Backup — do not assume it is covered
because it is "the durable one".

## The hole in the menu: SQS and Kinesis

**Neither SQS nor Kinesis has native cross-region replication.** Re-checked 2026-09-16:
no such feature exists in either service, and none shipped in 2025–26. (Note what is
*not* a substitute: an SQS **redrive policy / DLQ** is same-Region durability, and
**EventBridge global endpoints** — which genuinely do fail a custom event *bus* over to a
second Region on a Route 53 health check — apply to EventBridge, not to your queues and
streams.)

The queue/stream *definition* is shape — trivially recreated by IaC. The **in-flight
messages are bytes with no managed mover**. Your options, in order of preference:

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

**What happens to the in-flight messages themselves.** Be careful here, because it is the
question everyone asks and AWS does not document it directly (we looked; there is no
primary-source statement on regional-failover behaviour for SQS or Kinesis in-flight
data — so treat the next paragraph as engineering inference, not an AWS commitment, and
validate it in your own test).

Structurally: a queue or stream is a *regional* resource. Messages already sitting in the
impaired Region's queue are not moved anywhere and are not deleted; they are simply
**unreachable for the duration of the impairment**, and they reappear when the Region
does. A DR consumer reading a second-Region queue or replica stream has only what was
dual-written or replicated *before* the impairment began. So the operational consequences
are the ones to plan for, and none of them is "the messages fail over":

1. **During the event** you process only what reached the recovery Region. Size that gap
   (max in-flight × processing lag) and write it down as an accepted loss window, or
   re-drive from the durable source of truth.
2. **After the primary comes back** the old queue starts delivering its backlog — hours-old
   messages arriving into a system whose database has moved on. This is the failure people
   do not plan for. Decide in advance: purge, drain to a quarantine queue for manual
   review, or process idempotently with a staleness check. Record the decision.
3. **Visibility timeouts and consumer offsets** do not transfer. A Kinesis consumer in the
   recovery Region has its own checkpoint (or none), so expect reprocessing from the
   replica's earliest available point — idempotency is not optional.
4. **Do not point new consumers at the impaired Region to "drain it"** during the event.
   That is a dependency on the failed Region inside your recovery path.

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
