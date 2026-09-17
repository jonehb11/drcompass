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
  child plans (two levels max, up to 25 children; up to 100 blocks per plan).
- Execution is **manual or triggered by CloudWatch alarms** (on ALARM or OK state).

Docs: [Region switch plans](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch-plans.html).

## The execution blocks (official list, as of late 2026)

From [Add execution blocks](https://docs.aws.amazon.com/r53recovery/latest/dg/working-with-rs-execution-blocks.html):

| Block | What it does | Typical layer |
|---|---|---|
| ARC Region switch plan | Execute child plans (multi-app orchestration) | all |
| Amazon EC2 Auto Scaling group | Scale EC2 compute in an ASG | L2 |
| Amazon EKS resource scaling | Scale EKS cluster pods | L2/L4 |
| Amazon ECS service scaling | Scale ECS service tasks | L2/L4 |
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

Two layer notes that decide whether a generated plan is safe:

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
- An **ungraceful** execution performs an Aurora **failover**, which does **not** demote
  the old writer. The old Region can keep accepting writes from every client whose DNS
  has not moved — and the realistic regional event is a *gray* failure, not a clean
  crater, so some of them will. Two writers on the same ledger is
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
They are not lost from disk; they are simply invisible to your new primary, and nobody
will find them for you. See the reconciliation step in the Region switch runbook template.

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
