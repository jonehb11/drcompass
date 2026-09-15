# AWS Resilience Hub: the continuous assessor
<!-- section: Tooling | order: 110 -->

AWS Resilience Hub is the "am I still as resilient as I claim?" service: you declare
RTO/RPO targets as a policy, model your application, and it continuously assesses the
gap between policy and reality. Think of it as an automated second opinion on parts of
your Phase 0 — useful, cheap, and frequently misunderstood as something that *makes*
you resilient. It doesn't. It tells you where you aren't.

## What it actually does

([What is Resilience Hub](https://docs.aws.amazon.com/resilience-hub/latest/userguide/what-is.html),
[concepts](https://docs.aws.amazon.com/resilience-hub/latest/userguide/concepts-terms.html))

- **Resiliency policy**: your RTO/RPO targets, per disruption type.
- **Application**: a modeled group of AWS resources (imported from CloudFormation,
  Terraform state, Resource Groups, EKS…) organized into **AppComponents**.
- **Assessment**: evaluates estimated RTO/RPO against policy for four disruption types —
  Application, Cloud Infrastructure, **AZ disruption**, and **Region incident** — and
  returns "Policy met" / "Policy breached" per component, plus a **resiliency score**.
- **Recommendations**: configuration changes (e.g., "this RDS has no cross-region
  replica"), **CloudWatch alarms** to create, **SOPs** as Systems Manager runbooks, and
  **AWS FIS experiment templates** you can run from the console — a paved on-ramp to
  chaos testing.
- **Drift detection**: flags when a previously-compliant component now breaches policy,
  or when resources changed under the model; scheduled assessments + SNS notifications
  ([what's new](https://aws.amazon.com/about-aws/whats-new/2024/05/aws-resilience-hub-resilience-drift-detection)).
  Since Dec 2024 it also detects and incorporates your existing CloudWatch alarms.

**Pricing**: $15 per application per month (first 3 apps free for 6 months) on the
classic model ([pricing](https://aws.amazon.com/resilience-hub/pricing/)).

**2026 note**: AWS shipped a **next-generation Resilience Hub** (GA May 28, 2026) — a new
model of systems/user-journeys/services, automated dependency discovery, generative-AI
failure-mode analysis, composable policies, and a separate v2 API; the classic
experience continues and migration is at your own pace
([announcement](https://aws.amazon.com/about-aws/whats-new/2026/05/aws-announces-next-gen-aws-resilience-hub/)).
If you're adopting fresh, evaluate the next-gen model first.

## Where it earns its $15

- **The estimated-RTO/RPO gap report for the Region incident disruption type** is a
  machine-generated version of the conversation this whole program exists to force —
  "your policy says 60 minutes; this component's configuration can't deliver that."
  Excellent ammunition for the [decision gate](#/learn/01-where-to-start).
- **Drift detection** catches the quiet regressions — the new microservice with no
  backups, the replica someone deleted "temporarily" — between your quarterly reviews.
  Wire its SNS notifications into the same place as Phase 0 failures.
- **Coverage honesty**: because it reads your IaC, it assesses what you *actually
  deployed*, catching the components your inventory forgot. Diff its resource list
  against your DR Compass inventory both directions — each list audits the other.
- **FIS integration** lowers the activation energy for component-level fault injection
  (the `component-test` and `chaos` test types in the Tests page).

## What it is not

- **Not a recovery orchestrator.** It has no failover button; that's
  [Region switch](#/learn/07-tooling-region-switch) and your runbooks.
- **Not a replicator.** It recommends replication; it doesn't perform it
  ([mechanisms](#/learn/16-replication-mechanisms)).
- **Not a test.** Its RTO/RPO figures are *estimates from configuration*. An estimate is
  a better hypothesis, not a measurement — RTA still comes only from executed,
  timestamped tests ([fundamentals](#/learn/02-dr-fundamentals)). Never paste a
  Resilience Hub estimate into the RTA field.
- **Blind to what AWS can't see**: third-party dependencies, partner allowlists, your
  runbook quality, whether humans know their roles. Its score can be green while your
  recovery is impossible for reasons in the
  [third-party article](#/learn/14-third-party-dependencies).

## Verdict

Adopt it if you're on AWS with IaC — the cost is trivial and the drift detection alone
justifies it. Treat its assessment as an *input* to your gaps list (each "policy
breached" finding becomes a Gap in DR Compass with a real severity), never as the
program's scoreboard. The scoreboard is your last test's RTA.
