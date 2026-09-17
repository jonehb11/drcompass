# Replication mechanisms: how the bytes get there
<!-- section: Strategies | order: 55 -->

Strategy columns are promises; replication mechanisms are how you keep them. This is
the menu for getting [the bytes](#/learn/03-two-problems) into the recovery region,
service by service, with the real numbers from AWS docs — and, where AWS publishes no
number, a row that says so instead of inventing one. Record the chosen mechanism on
every stateful component (`replication.mechanism`, `rpoMinutes`) — an empty field on
tier-0 state is a blocker gap.

## The menu

| Mechanism | Covers | Typical RPO | Notes |
|---|---|---|---|
| **Aurora Global Database** | Aurora MySQL/PostgreSQL | Lag typically **<1s**; planned **switchover = RPO 0**; unplanned failover = lag at failure | Storage-level async replication to **up to 10** secondary Regions — re-verified twice, 2026-09-16 and 2026-09-17, against the Aurora User Guide, which reads verbatim: *"An Aurora global database has a primary DB cluster in one Region, and up to 10 secondary DB clusters in different Regions"* ([Aurora global databases](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)). The limit was **5** until [May 2025](https://aws.amazon.com/about-aws/whats-new/2025/05/amazon-aurora-global-database-support-10-secondary-region-clusters/). **This has now been "corrected" back to 5 by two separate reviews. It is 10.** Anything that says 5 — older blog posts, third-party courseware, and the AWS *DR whitepaper*, which is itself stale here — predates the May 2025 change. Check the User Guide page above before changing this number. RTO "order of minutes". Aurora PostgreSQL can *enforce* an RPO ceiling (`rds.global_db_rpo`, valid range 20s – 2,147,483,647s) by blocking commits when lag exceeds it — PostgreSQL only, not MySQL. |
| **DynamoDB global tables** | DynamoDB | MREC: "typically within a second"; **MRSC mode = RPO 0** | Multi-active: every replica takes writes; last-writer-wins on conflict in MREC. No replication SLA — watch `ReplicationLatency` (MRSC does not publish that metric). **MRSC has two constraints that decide whether you can have it at all**, both verbatim from [How global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html) (verified 2026-09-17): (1) *"A MRSC global table must be deployed in exactly three Regions"* — three replicas, **or two replicas plus a witness** (a third Region holding the data, managed by DynamoDB, invisible in your account, not readable or writable); and (2) *"You create a MRSC global table by adding one replica and a witness or two replicas to an existing DynamoDB table that contains no data… Converting a single-Region table to a MRSC global table with existing items is not supported."* **You cannot migrate a live Tier-0 table into MRSC** — plan a new table and a data migration, or do not plan MRSC. Also fixed Region sets (US / EU / AP, no crossing), no TTL, no LSIs, no transactions, and the consistency mode cannot be changed after creation. [Global tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html) |
| **S3 CRR + Replication Time Control** | S3 objects | **99.9% of objects within 15 min** — what the user guide says today; see the design-goal/SLA rule below | Replicates only objects written *after* enabling — run S3 Batch Replication for the backlog. Verbatim, re-verified 2026-09-17: *"S3 RTC replicates most objects that you upload to Amazon S3 in seconds, and 99.9 percent of those objects within 15 minutes"* ([RTC user guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)). The SLA is a **separate document with its own number** ([S3 RTC SLA](https://aws.amazon.com/s3/sla-rtc/)). |
| **ElastiCache Global Datastore** | Valkey/Redis (node-based) | "Typically under 1s"; RTO under a minute — **no SLA on either** | Primary + read-only secondary regions; promote to fail over. Often the right answer is instead: treat cache as rebuildable and measure warm-up time. **AWS Backup does not protect ElastiCache** (see the note under this table) — if you are not using Global Datastore, your options are ElastiCache's own automatic/manual backups with cross-Region backup copy, or accepting a cold cache. [Docs](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Redis-Global-Datastore.html) |
| **ECR replication rules** | Container images | *"The majority of images replicate in less than 30 minutes"* | Cross-region/cross-account; only content pushed or restored *after* configuration is replicated. What is **not** replicated, verbatim (re-verified 2026-09-17): *"Repository policies, including IAM policies, and lifecycle policies aren't replicated"* — and the fix for the rest: *"Repository settings aren't replicated by default, you can replicate the repository settings using repository creation templates. These settings include tag mutability, encryption, repository permissions, and lifecycle policies."* Read that as: policies attached to an *existing* repository do not travel, but a [repository creation template](https://docs.aws.amazon.com/AmazonECR/latest/userguide/repository-creation-templates.html) applies them to repositories ECR creates in the destination — which is the supported way to stop the recovery-region registry being a bare image store. (That reading reconciles two adjacent bullets on the same AWS page; AWS does not spell out the distinction itself.) Pullable-in-recovery-region is an L2 gate. [Docs](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html) |
| **Secrets Manager replica secrets** | Secret values + metadata | Rotation propagates automatically | Replica keeps the **same name** (ARN differs only by region) → name-based lookup fails over cleanly; per-region KMS key per replica; replica can be promoted to standalone. The keystone of [L3 secrets](#/learn/13-secrets-pitfalls). [Docs](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create-manage-multi-region-secrets.html) |
| **KMS multi-Region keys** | Key material | n/a (same key both sides) | Same key ID & material in each region — ciphertext moves without re-encryption. Can't convert an existing single-region key; policies/aliases are per-region shape; note some services (e.g., S3 CRR) re-encrypt with the destination key regardless. [Docs](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html) |
| **AWS Backup cross-region copy** | EBS/RDS/Aurora/DynamoDB/EFS/FSx/S3/DocumentDB/Neptune/Redshift/EC2/EKS… recovery points — **not ElastiCache, not MemoryDB** | Backup cadence (hours) | Scheduled or on-demand copies to another region *and/or account* (account-level copies protect against account compromise). Copies re-encrypted with destination vault key; no copies out of cold storage. The floor under every fancier mechanism — but only for resource types on the supported list, so check yours. [Cross-region copy](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html) · [supported resources](https://docs.aws.amazon.com/aws-backup/latest/devguide/working-with-supported-services.html) |
| **MSK Replicator** | Amazon MSK (Kafka) topics | **AWS publishes no lag or RPO figure** — measure it | *"automatic asynchronous replication of data and consumer group offsets between MSK clusters"*, plus topic configurations and ACLs. Cross-Region and same-Region. **Both clusters must be in the same AWS account** for MSK-to-MSK. Region-limited — check the list. Because there is no published number, the RPO you record for Kafka must come from an observed lag in your own drill, not from this table. [Docs](https://docs.aws.amazon.com/msk/latest/developerguide/msk-replicator.html) |
| **OpenSearch cross-cluster replication** | OpenSearch Service domains | **No published RPO** — derive it from the checkpoints | Active-passive: a *follower* index pulls from a *leader* index, cross-Region or cross-account. Prerequisites that catch people: Elasticsearch 7.10 / OpenSearch 1.1+, fine-grained access control **and** node-to-node encryption on, `index.soft_deletes.enabled` on the leader. A domain connects to at most 20 others; no UltraWarm or cold indexes; not on M3/T2/T3. **Replication paused for more than 12 hours cannot be resumed** — you stop, delete the follower index and start over, which is a real RTO event of its own. Measure lag from the leader/follower checkpoint values. [Docs](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/replication.html) |
| **EFS replication** | EFS file systems | **RPO 15 min** for most file systems | *"After the initial replication is finished, Amazon EFS maintains a Recovery Point Objective (RPO) of 15 minutes for most file systems"* — with the exception spelled out: *"if the source file system has files that change very frequently and has either more than 100 million files or files that are larger than 100 GB, replication may take longer than 15 minutes."* Not point-in-time consistent: changes transfer against a **Last synced time**, so alarm on `TimeSinceLastSync`, which *is* your RPA. Cross-Region and cross-account; fail over to the replica and fail back. [Docs](https://docs.aws.amazon.com/efs/latest/ug/efs-replication.html) |
| **FSx** (depends on the file-system type) | FSx for NetApp ONTAP, OpenZFS, Windows, Lustre | Schedule-driven: ONTAP **as frequently as every 5 min** | **ONTAP**: NetApp SnapMirror, in-Region or cross-Region — *"Replication can be scheduled as frequently as every 5 minutes"*; volume-level only, and **synchronous SnapMirror (including StrictSync) is not supported** ([ONTAP](https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/scheduled-replication.html)). **OpenZFS**: on-demand snapshot replication *"between file systems within and across AWS Regions and accounts"* via `CopySnapshotAndUpdateVolume`, full or incremental, cross-account through AWS RAM; periodic replication is a scheduler you run on top of that API, not a managed cadence ([on-demand](https://docs.aws.amazon.com/fsx/latest/OpenZFSGuide/on-demand-replication.html), [periodic](https://docs.aws.amazon.com/fsx/latest/OpenZFSGuide/ongoing-periodic-data-replication.html)). **Windows and Lustre**: no native cross-Region replication verified here — the cross-Region path is AWS Backup copy (row below); check your exact type on the supported-resources list before recording it. |
| **EBS snapshot / AMI copy** | EBS volumes, EC2 AMIs | = your snapshot schedule (DLM or AWS Backup) | `copy-snapshot` across Regions and accounts; AWS names disaster recovery as a use case. Two things that surprise people in a drill: **the first cross-Region copy is always a full copy** (*"If you copy a snapshot to a new Region, a full (non-incremental) copy is created"*), and later copies are incremental only while the previous copy still exists in the destination and the KMS key matches. Encrypted snapshots need `kms:Decrypt`/`ReEncrypt`/`CreateGrant` on both sides — the classic "replicated ciphertext you can't decrypt". 20 concurrent copy requests per destination. [Docs](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-copy-snapshot.html) |
| **DocumentDB global clusters** | DocumentDB | *"Latency is typically under a second"*; RPO *"typically measured in seconds"* | *"A global cluster consists of one primary Region and up to 10 read-only secondary Regions."* AWS states a *"typical Recovery Time Objective (RTO) of under a minute"* to promote a secondary. Not on v3.6; not on db.t3/t4g/r4; switchover and global failover are unsupported when Regions run different engine versions (manual failover still works). There is an ARC [Region switch](#/learn/07-tooling-region-switch) block for it. [Docs](https://docs.aws.amazon.com/documentdb/latest/developerguide/global-clusters.html) |
| **Neptune global database** | Neptune | *"latency typically under a second"* | *"A Neptune global database consists of a primary DB cluster in one region, and up to five secondary DB clusters in different regions"* — note **five**, not Aurora's ten; do not carry the Aurora number across. Two failover paths, and they are not equivalent: **managed planned failover** relocates the primary with no data loss, while an unplanned outage needs the manual **detach-and-promote**, which breaks the topology and has to be rebuilt afterwards. Region-limited; no auto-scaling on secondaries. There is an ARC Region switch block for it. [Docs](https://docs.aws.amazon.com/neptune/latest/userguide/neptune-global-database.html) |
| **DRS block replication** | EC2/on-prem server disks | Seconds | See [Elastic Disaster Recovery](#/learn/09-tooling-elastic-dr) |
| **Arpio recovery points / real-time** | Environment-wide (30+ services) | ~15 min (snapshot) / seconds (real-time) — **vendor-published, not AWS-documented** | See [Arpio](#/learn/06-tooling-arpio). Every other row in this table is an AWS figure from an AWS page; these two are the vendor's own claims. Record what you observe in a drill, not the brochure number. |

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
- **Design-goal ≠ SLA — and check which page your number is on.** S3 RTC is the worked
  example, because three different figures circulate and only one of them is the contract:
  - The **user guide** today: *"S3 RTC replicates most objects that you upload to Amazon S3
    in seconds, and 99.9 percent of those objects within 15 minutes"*
    ([RTC user guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html),
    re-verified 2026-09-17).
  - The **SLA**, a separate document, commits to a *"Monthly 15-minute Replication
    Percentage"* per Region pair per account, with service credits at **below 99.9%** (10%),
    **below 98.0%** (25%) and **below 95.0%** (100%)
    ([S3 RTC SLA](https://aws.amazon.com/s3/sla-rtc/)).
  - **99.99%** is the *design* figure from the 2019 launch announcement, which stated both
    numbers in one breath — designed to *"replicate 99.99% of objects within 15 minutes
    after upload"*, backed by an SLA to *"replicate 99.9% of objects within 15 minutes
    during any billing month"*
    ([launch](https://aws.amazon.com/about-aws/whats-new/2019/11/amazon-s3-replication-time-control-for-predictable-replication-time-backed-by-sla)).

  Earlier editions of this article quoted **99.99%** and cited it to the *user guide*, which
  does not say that. Corrected. If you are quoting to an auditor, quote the **SLA** number
  and name the SLA: a design goal is not a commitment, and a launch blog is not a contract.
- **Everything encrypted needs its key on the other side first.** Replication of
  ciphertext you can't decrypt is a very durable form of data loss
  ([secrets & KMS](#/learn/13-secrets-pitfalls)).
- **Strategy fit**: backup-copy mechanisms support backup & restore; continuous
  mechanisms (Aurora Global, global tables, CRR+RTC, Global Datastore) are what make
  pilot light and warm standby's RPO columns honest
  ([strategy matrix](#/learn/05-strategy-matrix)).
