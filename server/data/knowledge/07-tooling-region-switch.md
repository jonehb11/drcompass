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
| Amazon Route 53 health check | Redirect DNS-based traffic to target Regions | L5/L7 |
| Lambda event source mapping | Enable/disable an event source mapping | L4 |

Notable absences (verified): **no DynamoDB block, no Global Accelerator block** — global
tables don't need a switchover, and anything else goes through the Custom action Lambda
block. Note how well the list maps onto the [restore layer cake](#/learn/04-restore-layer-cake):
databases before compute scaling before routing, with manual-approval blocks as your gates.

## Graceful vs ungraceful — and the "no practice mode" truth

`StartPlanExecution` takes a mode: **graceful** (planned — every block runs its safe
path, e.g. Aurora *switchover* with RPO 0) or **ungraceful** (regional emergency —
blocks take the lossy-but-fast path, e.g. Aurora *failover* with potential data loss,
Lambda blocks skipped). Configure both paths per block up front, while calm.

There is **no separate practice mode** for Region switch (scheduled "practice runs" are
an ARC *zonal autoshift* feature — a different capability). You rehearse by **executing
the plan in graceful mode** on a schedule — which is exactly your recovery-test loop's
L1–L5. What you do get continuously:

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
