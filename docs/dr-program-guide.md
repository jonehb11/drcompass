# Running a DR program with DR Compass

Disaster recovery fails when it's treated as a project — a document written,
approved, and shelved. It works as a **program**: a loop of inventory, test,
finding, fix that runs until recovery is boring. This guide is a realistic
first-quarter arc for one DR owner with part-time help, using DR Compass at
every step.

## The three durable artifacts

Everything the program produces boils down to three artifacts that must stay
true:

1. **The dependency inventory** — what actually runs, what it depends on, who
   it calls, where its secrets live, and what's in recovery scope. In DR
   Compass: **Inventory** (+ **Discover** to feed it, **Diagrams** to see it).
2. **The runbook** — the failover procedure someone *other than its author*
   can execute, with verify/pass criteria at every step. In DR Compass:
   **Runbooks**.
3. **The test record** — dated evidence with measured numbers and findings.
   In DR Compass: **Tests & game days**.

If an activity doesn't improve one of these three, it's probably theater.

## The honest-numbers rule

RTO and RPO are *targets* — what the business needs. RTA and RPA are
*measurements* — what a test actually achieved, timestamped. DR Compass keeps
them in separate fields on purpose, and enforces one rule everywhere:

> **A number is evidence only when a test that *passed* produced it.**
> RTA is T1 − T0, where T1 is the moment the L6 functional success bar passes. A
> test that did not pass never reached L6, so it has no RTA — it has a time to
> failure.

That has three consequences you will feel while running the program:

1. **A hand-typed number is never green.** You can record one in Settings, and
   the product will show it — labelled *recorded by hand, not from a test*, in
   neutral styling, on every screen and in every export. It is a note to self,
   not something to quote to an auditor.
2. **The test has to name the thing.** A passed test measures a *component* only
   when it names it: in its app-level checks, in its component list, or in a step
   of its linked runbook. Sharing a runbook with a sibling service does not count.
   This is why filling in `componentIds` on runbook steps is worth the minute it
   takes.
3. **Evidence ages.** Past 180 days (configurable) a measured number stays
   measured but is flagged stale, and the assessment stops awarding a high level
   for it. "We tested it in 2023" is not a recovery capability.

Never present a target as a measurement. A dashboard that says "RTO: 60 minutes"
without a measured RTA next to it is a hypothesis wearing a suit. The gap between
the two numbers *is* your program backlog.

The full contract, including how severity is decided and what every verdict
means, is in [measured-numbers.md](measured-numbers.md).

## A quarter, week by week

### Weeks 1–2 — Inventory + assessment

- Run the **Where am I?** assessment. Record your level; this is your
  baseline.
- Set objectives in **Settings** (RTO/RPO, regions, strategy) — even draft
  numbers. Mark them unapproved until leadership signs off; getting them
  approved is a Week-3 deliverable.
- Build the Tier-0 **Inventory**: run **Discover** against your AWS account
  (and your Kubernetes cluster, a flow-log export, or a third-party DR tool's
  API if you use one), accept and prune proposals, then hand-fill what
  discovery can't see — dependencies, outbound third-party calls, secrets,
  recovery scope.
- Every "unknown" in `inRecoveryScope` and every unreplicated secret goes in
  the gap list. Expect this list to be uncomfortably long. Good.

### Weeks 3–4 — Strategy + runbook

- Use the recommender and the **Diagrams** (restore layer cake, dependency
  graph) to pick a strategy per tier and settle tooling.
- Then do the part that actually sets your RPO: give **every stateful
  component a replication mechanism**. Start from what the services give you
  natively — Aurora Global Database, DynamoDB global tables, S3 Cross-Region
  Replication (and whether you need Replication Time Control), ECR replication
  rules, Secrets Manager replica secrets, KMS multi-Region keys, AWS Backup
  cross-region copy — and rebuild everything that is shape rather than bytes
  from IaC. Where a service has no native answer (SQS and Kinesis have none)
  or where a tool is genuinely doing the work, record that instead, by name.
  Orchestration products — ARC Region Switch, ARC routing controls, Elastic
  Disaster Recovery, a GitOps region flip, or a third-party environment
  recovery tool — are a separate decision from the mechanism, and they are
  peers. Write the choice down per component, with an RPO you can defend.
- Open **Deployment order**. It computes, from the inventory you just built,
  what has to come back in what order and why — waves that can be built in
  parallel, with a reason on every item. Read the cycles and the "could not be
  ordered" list first: those are inventory gaps wearing a different hat.
- Draft the primary failover **Runbook**. Either start from the closest template
  and order steps by restore layer, or press **Generate from deployment order**
  and let the waves become gated steps. Add verify/pass to every step, add
  rollback, mark gates, and list the components each step touches — that last
  field is what lets a passed test produce a measured number per service.
- Run **Check against deployment order** on the finished runbook. It flags any
  step that restores something before its prerequisites. Fix those now; at 3 a.m.
  they look like a CrashLoop nobody can explain.
- Tabletop it: walk the runbook with the team in a **Tests** entry of type
  `tabletop`. You'll find missing steps without touching infrastructure.

### Weeks 5–6 — Phase 0 green

- Work the **Phase 0 checklist** until every item is done *with proof*:
  backups verified restorable, replication healthy, secrets present in the
  recovery region, quotas raised, DNS TTLs sane, access for responders
  confirmed.
- Close (or formally accept) the blocker-severity gaps. Do not schedule a
  recovery test with open blockers — a test designed to fail teaches nothing.

### Weeks 7–8 — First recovery test

- Plan a **recovery test** in a non-production scope: link the runbook,
  define the app-test catalog ("what proves the business transaction
  works?"), assign owners.
- Execute. Record T0, first access, T1. Let DR Compass compute RTA/RPA. Write
  the narrative while it's fresh.
- Set the test's status honestly. If it did not pass, leave it `failed` — the
  product will refuse to quote its numbers as measured, and it is right to. The
  "record as this workspace's measured numbers" button stays disabled until a
  run passes.
- Every surprise becomes a **finding**, every finding a **gap** with severity
  and a ticket. A first test that "fails" with ten findings is a success —
  you just converted unknowns into a backlog.

### Weeks 9–11 — The iterate loop

- Fix the top findings; update the runbook and inventory as you go (the
  artifacts must stay true — a fix that isn't reflected in them will be
  re-discovered the hard way).
- Re-test. Shorter, scoped re-tests are fine: component tests for the pieces
  that broke, then another full recovery test. Watch measured RTA/RPA move
  toward the targets across test records.
- Re-run the assessment; the level should be climbing.

### Week 12 — Game day

- A **game day** is the graduation exercise: scheduled, announced, with real
  stakes appropriate to your maturity — up to and including live traffic
  cutover (restore layer L7) if measurements justify it.
- Use the game-day checklist and template. Fresh eyes execute the runbook;
  the author observes and takes notes.

### Week 13 — Decision gate

- Bring the artifacts to leadership: assessment trend, measured RTA/RPA vs.
  targets, gap list with what's fixed/accepted/open.
- Decide, and record it in **Decisions**: approve the objectives (or change
  them to what's actually achievable), fund the next quarter's gaps, set the
  test cadence going forward.

## After the quarter

The program continues at a sustainable cadence: weekly checklist, monthly
assessment glance, a recovery test every quarter, a game day once or twice a
year. Export the workbook for stakeholders each quarter. When people rotate,
the three artifacts are the onboarding.

The steady state you're aiming for: a failover test is a calendar event, not
an event.
