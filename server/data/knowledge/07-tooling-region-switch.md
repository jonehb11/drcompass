# ARC Region switch: orchestrating the failover
<!-- section: Tooling | order: 70 -->

**Region switch**, part of Amazon Application Recovery Controller (ARC), is AWS's
managed orchestrator for multi-Region failover — GA August 1, 2025
([launch post](https://aws.amazon.com/blogs/aws/introducing-amazon-application-recovery-controller-region-switch-a-multi-region-application-recovery-service/)).
It turns your runbook's L1–L5 mechanics into an executable, evaluated, reportable plan.
It does **not** replace the runbook: it executes the steps a machine can execute; your
runbook still owns the decision to declare, the human verifications, and L6.

## The model: plans → workflows → steps → execution blocks

- A **plan** covers one multi-Region application (any two Regions; cross-account
  resources supported via a target IAM role). Plans execute under an IAM role you
  specify.
- **Workflows** activate or deactivate a Region — active/passive apps use activation
  workflows; active/active apps pair an activation with a deactivation.
- Workflows contain **steps** (sequential); each step contains **execution blocks**
  (blocks within a step run in **parallel**). That's how you express ordering — there is
  no separate "parallel/sequential container" block type.
- **Parent/child plans**: a parent plan orchestrates multiple applications by embedding
  child plans through the *ARC Region switch plan* execution block. AWS documents the
  depth but **not** the width: *"The hierarchy is limited to two levels, but one parent
  plan can include multiple child plans"*
  ([child plans](https://docs.aws.amazon.com/r53recovery/latest/dg/working-with-rs-child-plan.html)),
  and the block page says only that it *"does not support additional levels of child
  plans, and limits the number of parent child plans"*
  ([block](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch-plan-block.html)).
  **AWS publishes no number for that limit** — so neither do we.
  **Correction:** earlier editions of this article said "up to 25 children". That is not
  an AWS quota. The
  [Region switch quota table](https://docs.aws.amazon.com/r53recovery/latest/dg/quotas.region-switch.html)
  (re-verified 2026-09-17) has exactly five rows: plans per account **10** (increase on
  request), execution blocks per plan **100**, parallel execution blocks per step **20**,
  CloudWatch alarms per trigger condition **10**, and **Route 53 health-check execution
  blocks per plan 25**. The 25 was that last row, misattributed to child plans. The limit
  that will actually bite is the first one: at 10 plans per account, a parent plan has at
  most 9 children before you need a quota increase.
- Execution is **manual or triggered by CloudWatch alarms** (on ALARM or OK state).

Docs: [Region switch plans](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch-plans.html).

## The execution blocks (official list, as of late 2026)

From [Add execution blocks](https://docs.aws.amazon.com/r53recovery/latest/dg/working-with-rs-execution-blocks.html):

| Block | What it does | Typical layer |
|---|---|---|
| ARC Region switch plan | Execute child plans (multi-app orchestration) | all |
| Amazon EC2 Auto Scaling group | Scale EC2 compute in an ASG | L2 |
| Amazon EKS resource scaling | Scale EKS cluster pods | L4 |
| Amazon ECS service scaling | Scale ECS service tasks | L4 |
| ARC routing control | Flip routing controls to redirect traffic | L7 |
| Amazon Aurora Global Database | Switchover/failover of an Aurora global database | L3 |
| Aurora Provisioned Scaling | Scale Aurora instances to match the source Region's class | L3 |
| Aurora Serverless Scaling | Scale Aurora Serverless capacity | L3 |
| Amazon DocumentDB Global Cluster | DocumentDB global cluster recovery | L3 |
| Amazon Neptune Global Cluster | Neptune global database recovery | L3 |
| Amazon RDS Promote Read Replica | Promote an RDS read replica to standalone | L3 |
| Amazon RDS Create Cross-Region Replica | Re-create a replica (post-recovery) | post |
| Amazon RDS Switchover Read Replica | Switch over an RDS Oracle replica | L3 |
| Manual approval | Human gate: approve or cancel before proceeding | gates |
| Custom action Lambda | Run a Lambda for anything not covered | any |
| Amazon Route 53 health check | Redirect DNS-based traffic to target Regions | **L7** |
| Lambda event source mapping | Enable/disable an event source mapping | L4 |

Notable absences (verified): **no DynamoDB block, no Global Accelerator block** — global
tables don't need a switchover, and anything else goes through the Custom action Lambda
block. Note how well the list maps onto the [restore layer cake](#/learn/04-restore-layer-cake):
databases before compute scaling before routing, with manual-approval blocks as your gates.

Three layer notes that decide whether a generated plan is safe:

- **The pod/task scaling blocks are L4, not L2.** They were previously hedged as "L2/L4"
  here while `strategy-catalog.json` carried `"layer": "L4"` — and the catalog is the copy
  the plan generator sorts on, so the hedge could only ever mislead a reader, never the
  machine. Scaling an ASG is L2 (platform capacity); scaling *pods or tasks* is the
  workload coming up, which is L4. Corrected here to match the data.

- **Both traffic blocks are L7.** The Route 53 health-check block and the ARC
  routing-control block *both move live public traffic*, so both are the L7 cutover — the
  health-check block was previously hedged as "L5/L7" here and labelled L5 in DR Compass's
  strategy catalog, which (because a drafted plan is ordered by layer) put the traffic flip
  *before* the L6 verification. That is the one ordering the layer cake forbids. Corrected:
  L7, after a manual-approval block, which itself comes after your L6 proof.
- **There is no execution block for L6.** Nothing in the list proves a business
  transaction, because no resource *is* a success bar. So a plan drafted purely from an
  inventory contains no evidence that anything works. Implement L6 as a Custom action
  Lambda that fails the plan on a bad business response, and/or hold on a manual-approval
  block while a human runs the transaction. DR Compass's plan generator now always injects
  both an L6 verification and the approval blocks for this reason.

## The CLI surface (verified 2026-09-16)

Worth getting exactly right, because two different parameters are routinely confused:

| Operation | CLI | Notes |
|---|---|---|
| Read a plan from a Region | `get-plan-in-region` (`get-plan` for the control-plane view) | Read it from the Region you are activating |
| Evaluation status | `get-plan-evaluation-status` | Runs automatically ~every 30 min |
| **Start an execution** | `start-plan-execution` | **Required:** `--plan-arn`, `--target-region`, `--action`. **Optional:** `--mode`, `--comment`, `--latest-version`, `--recovery-execution-id`, `--client-token` |
| Watch an execution | `get-plan-execution`, `list-plan-executions`, `list-plan-execution-events` | Data plane, per Region |
| Approve/deny a gate | `approve-plan-execution-step --approval approve\|decline` | Needs `--plan-arn`, `--execution-id`, `--step-name`. Declining **cancels** the execution |
| Abort | `cancel-plan-execution` | The mid-flight abort path |

- `--action` is **required** and takes `activate | deactivate | postRecovery` — which
  *direction*, plus the post-event workflow that re-arms replication (that one needs
  `--recovery-execution-id` and both Regions healthy).
- `--mode` is **optional**, **defaults to `graceful`**, and takes exactly
  `graceful | ungraceful` — lowercase. **There is no `failover` mode value.** If you see
  `--mode failover` in a runbook, that runbook has never been run.

Sources:
[StartPlanExecution API](https://docs.aws.amazon.com/arc-region-switch/latest/api/API_StartPlanExecution.html),
[CLI reference](https://docs.aws.amazon.com/cli/latest/reference/arc-region-switch/start-plan-execution.html),
[approve-plan-execution-step](https://docs.aws.amazon.com/cli/latest/reference/arc-region-switch/approve-plan-execution-step.html),
[manual approval block](https://docs.aws.amazon.com/r53recovery/latest/dg/manual-approval-block.html).

## Graceful vs ungraceful — and the "no practice mode" truth

`StartPlanExecution` takes a mode: **graceful** (planned — every block runs its safe
path, e.g. Aurora *switchover* with RPO 0) or **ungraceful** (regional emergency —
blocks take the lossy-but-fast path, e.g. Aurora *failover* with potential data loss,
Lambda blocks skipped). Configure both paths per block up front, while calm.

A third workflow exists alongside the two modes: **post-recovery**
(`--action postRecovery`), which runs after a successful recovery to re-arm replication
and prepare for the next event. It requires both Regions healthy and runs in the Region
that was previously impaired.

There is **no separate practice mode** for Region switch (scheduled "practice runs" are
an ARC *zonal autoshift* feature — a different capability). Re-verified 2026-09-16: the
`StartPlanExecution` parameter list contains only `action` and `mode`; there is no
practice, simulate or dry-run parameter anywhere in the API, the CLI, or the execution
documentation. Be sceptical here — generic web search confidently asserts a
"practice/recovery mode" for Region switch that does not exist in any AWS source. You
rehearse by **executing the plan in graceful mode** on a schedule — which is exactly your
recovery-test loop's L1–L6. AWS says so itself: "We recommend that you also test
application recovery by executing your Region switch plan, and that you don't rely solely
on Region switch plan evaluation." What you do get continuously:

- **Plan evaluation**: automatic on every create/update and **every 30 minutes** —
  verifies IAM permissions, resource configuration, and running capacity; warnings
  surface in the console, EventBridge, and `GetPlanEvaluationStatus`. AWS explicitly
  says evaluation is not a substitute for executing the plan. Treat evaluation warnings
  as a Phase 0 checklist input.
- **RTO measurement built in**: you set an RTO on the plan and configure Regional
  application **health alarms**; Region switch reports actual recovery time = execution
  time + time until the alarms go green. That's an RTA machine — feed it into your test
  records rather than inventing a parallel stopwatch.
- **Execution reports** (Dec 2025): a PDF per execution delivered to S3 — timeline,
  config at execution time, warnings, alarm history. Attach it to the test record.

## What the orchestrator will not do for you: fence the old primary

Region switch executes the blocks you gave it. Nothing in that list fences the Region you
are leaving, and the mode you choose decides whether that matters:

- A **graceful** execution running an Aurora Global Database **switchover** demotes the
  old writer for you as part of the operation, and requires a healthy primary. You still
  quiesce the old Region's writers and schedulers first, so nothing is in flight across
  the cut.
- An **ungraceful** execution performs an Aurora **failover**. AWS *does* try to stop
  writes in the old Region, and the load-bearing word is *try*: **"When you initiate a
  managed failover, Aurora also attempts to halt write traffic through the
  highly-available Aurora storage layer. We refer to this mechanism as 'write fencing'…
  Because fencing writes is a best-effort attempt, it's possible that writes might be
  momentarily accepted in the old primary Region, causing split-brain issues."**
  ([Aurora User Guide — managed failovers](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html#aurora-global-database-failover.managed-unplanned),
  verified 2026-09-17.)

  **Correction:** earlier editions of this article said the failover "does not demote the
  old writer". That was wrong, and it understated AWS. What is true is narrower — and
  changes nothing about what you should do:

  - **Best-effort is not a guarantee, and it is not instant.** Aurora emits an RDS Event
    when writes were stopped, and a *different* event when the attempt **timed out** —
    AWS names multiple-AZ failure in the old Region as the case where fencing "doesn't
    succeed in a timely manner". The events are recorded on the old cluster if it is
    reachable on the network, otherwise on the new primary. Those events are the only
    machine-readable answer to "was it actually fenced?" — read them, and record the
    answer in the incident log.
  - **It fences the storage layer, not your clients.** Every pod in the old Region whose
    DNS has not moved keeps trying to write, and the realistic regional event is a *gray*
    failure, not a clean crater. AWS's own pre-failover advice is the advice to copy: take
    applications offline first, connect through the **global writer endpoint** (its value
    survives the promotion), and cut the DNS cache TTL to ~5 s — because *"Although Aurora
    attempts to block writes in the old primary Region, the action is not guaranteed to
    succeed."*
  - **Manual failover has no fencing at all.** The detach-and-promote path — the one you
    take when the two Regions run incompatible engine versions — begins with AWS telling
    *you* to "stop issuing DML statements and other write operations". There is no service
    doing it for you on that path.

  So fence it yourself anyway, and plan as though the fence did not happen. Two writers on
  the same ledger is
  [the one failure worse than downtime](#/learn/10-tooling-gitops-iac): downtime you
  recover from, divergent writes you reconcile by hand, if at all.

So a fence step belongs in the runbook **before** the data block, on both paths: quiesce
or scale old-Region writers to zero, revoke the old writer's database security-group
ingress, disable old-Region schedulers and Lambda event source mappings, and take the old
Region's **edge** out of service so stale-DNS clients cannot keep writing there. Fencing
the edge matters as much as fencing the database. If the old Region is unreachable you
cannot fence it — record that explicitly, with the split-brain risk accepted and a named
reconciliation owner, rather than leaving the step blank.

And plan the **reconciliation** before you need it: after an ungraceful failover, writes
the old primary accepted but never replicated are not in the ledger you are now serving.

**Do not tell your team they are gone. AWS tries to hand them back to you.** Earlier
editions of this article said "nobody will find them for you" — that was wrong, and it is
an expensive kind of wrong, because it is the difference between "those writes are lost"
and "those writes are in a snapshot nobody went to look for". From the Aurora User Guide
([managed failovers](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html#aurora-global-database-failover.managed-unplanned),
verified 2026-09-17):

> *"Before creating the new storage volume in the AWS Region, Aurora attempts to take a
> snapshot of the old storage volume at the point of failure. That way, you can restore
> the snapshot and recover any of the missing data from it. If this operation is
> successful, Aurora places this snapshot named
> `rds:unplanned-global-failover-{name-of-old-primary-DB-cluster}-{timestamp}` in the
> snapshot section of the AWS Management Console."*

So the reconciliation step has a command. Run it against the **old primary's** Region:

```
aws rds describe-db-cluster-snapshots --region <old-primary-region> \
  --query "DBClusterSnapshots[?starts_with(DBClusterSnapshotIdentifier,'rds:unplanned-global-failover-')].[DBClusterSnapshotIdentifier,SnapshotCreateTime,Status,SnapshotType]" \
  --output table
```

(AWS documents `DescribeDBClusterSnapshots` as the way to find it but does not say which
`SnapshotType` it carries, which is why this filters on the name prefix rather than the
type. Read the type off the output before you write any retention rule around it.)

Four things to know before you rely on this:

1. **It is not there during the event.** Aurora takes it when it rebuilds the old Region's
   storage volume, which happens *"as soon as that Region is healthy and available again"*.
   Looking for it at 03:20 will find nothing. This belongs in the **post-event**
   reconciliation, not in the cutover.
2. **"Attempts" means it can fail.** AWS says *"if this operation is successful"*. A
   failure bad enough to take the Region can take the snapshot with it. Record its presence
   or absence explicitly — "we checked and there was no snapshot" is a finding; silence is
   not.
3. **It expires.** *"The snapshot of the old storage volume is a system snapshot that's
   subject to the backup retention period configured on the old primary cluster. To
   preserve this snapshot outside of the retention period, you can copy it to save it as a
   manual snapshot."* Copy it to a manual snapshot on day one. A system snapshot ageing out
   is how a recoverable reconciliation quietly becomes an unrecoverable one.
4. **It is documented for the MANAGED failover path.** The manual detach-and-promote path
   carries no such statement. If you failed over by detaching a secondary, assume there is
   no snapshot and say so.

And it is not an undo. Restoring it gives you a **second cluster** holding the old Region's
state at the point of failure; deciding which of those rows belong in the ledger you are now
serving is application work, done by hand, by a named owner. That is exactly why the
reconciliation step exists — see it in the Region switch runbook template.

## The part that makes it trustworthy: data-plane execution

Plans are configured through a control plane in us-east-1, but **execution, pause,
cancel, and update-execution are data-plane operations with an independent data plane
and console in each Region** — you execute from the Region you are *activating*, so
recovery takes no dependency on the failed Region
([data and control planes](https://docs.aws.amazon.com/r53recovery/latest/dg/data-and-control-planes-rs.html)).
This is the property home-grown orchestrators almost never have: a Step Functions state
machine in the primary region orchestrating that region's own evacuation is a joke that
writes itself. See [GitOps & IaC](#/learn/10-tooling-gitops-iac) for the general principle.

Also honest in the docs: **scaling blocks don't guarantee capacity** — AWS recommends
on-demand capacity reservations for critical apps. The orchestrator asks; the region
answers.

## Cost and fit

- **$70 per plan per month** ([pricing](https://docs.aws.amazon.com/r53recovery/latest/dg/pricing-rs.html)) plus S3 for reports. Cheap against one hour of outage; budget per application.
- **Best for**: AWS-native stacks whose failover is expressible in the blocks above —
  Aurora + EKS/ECS/ASG + Route 53/ARC routing is precisely the sweet spot. Post-recovery
  workflows (Feb 2026) even automate re-arming replication after the event.
- **Not for**: rebuilding infrastructure that doesn't exist yet (it scales and switches
  what's already deployed — pilot light *provisioning* remains IaC/Arpio work),
  non-AWS dependencies, or data replication itself. It orchestrates the switch; the
  bytes must already be flowing ([two problems](#/learn/03-two-problems)).

In DR Compass, the recommend engine maps your inventory's component kinds onto these
blocks to draft a plan skeleton — check it against the runbook, then build the real plan
in AWS (console, CloudFormation, or Terraform, all supported).
