# Where to start: the DR roadmap
<!-- section: Start here | order: 10 -->

You've been asked to "make sure we can survive losing a region." Here is the order of
operations that works, and where each step lives in DR Compass. Do the steps in order —
each one produces the raw material the next one needs.

> A DR plan that has never been executed is a hypothesis. The whole roadmap below exists
> to turn a hypothesis into a measured, repeatable capability.

## The roadmap

| Step | What you produce | DR Compass page |
|---|---|---|
| 1. Baseline honestly | A maturity score and the next 3 actions | **Assessment** |
| 2. Inventory everything | Every component, tiered, with an owner | **Inventory** (+ **Discover** to import from AWS/Arpio) |
| 3. Map dependencies | Dependency + data-replication diagrams; the outbound-call list | **Inventory** (dependsOn, outboundCalls) → **Diagrams** |
| 4. Pick a strategy | One of the four AWS strategies, per tier | **Settings** (strategy), informed by the [strategy matrix](#/learn/05-strategy-matrix) |
| 5. Write the runbook | Ordered, layer-by-layer steps with verify/pass criteria | **Runbooks** |
| 6. Build the Phase 0 checklist | The "is recovery even possible today?" daily list | **Checklists** (kind: phase0) |
| 7. Run the recovery-test loop | Timestamped test records; RTA/RPA measured, findings triaged | **Tests** |
| 8. Game day | A live (or production-shaped) exercise with real traffic cutover | **Tests** (type: game-day) |
| 9. Decision gate | Business sign-off: measured RTA/RPA vs targets, accepted gaps | **Settings** (objectives approved) + decisions log |

## Step by step

### 1. Baseline honestly (30 minutes)
Take the maturity assessment before you build anything. Most teams discover they are at
level 1 ("we have backups") while believing they are at level 3 ("we've tested"). The
assessment's per-pillar scores tell you which of the steps below deserves your first two
weeks.

### 2. Inventory everything (the unglamorous week)
You cannot recover what you haven't listed. For every component record: category, **tier**
(0 = the business stops without it), **kind** (aurora-postgres, eks-workload, sqs…),
where it's defined in IaC, and whether it is **in recovery scope**. "Unknown" is a legal
answer and a finding — the point of the inventory is to make unknowns visible, not to look
finished. Use **Discover** to propose components from your AWS account or Arpio's resource
graph, then curate; never trust auto-discovery blindly.

### 3. Map dependencies
Two graphs matter:

- **dependsOn** — what must exist before this component works (its database, its queue, its secrets).
- **outboundCalls** — everything it calls that *you don't control*: partners, SaaS, other teams. This list is where recoveries die. See [third-party dependencies](#/learn/14-third-party-dependencies).

Generate the diagrams and put them in front of the app teams. Every "oh, we also call…"
you hear in that meeting is a production incident you just avoided.

### 4. Pick a strategy — per tier, not per company
Backup & restore for tier 3, pilot light or warm standby for tier 0/1 is a normal answer.
One strategy for everything is how you pay active-active prices for a wiki. Read the
[strategy matrix](#/learn/05-strategy-matrix), then record the decision and its rationale.

### 5. Write the runbook against the restore layer cake
Order steps by layer — L0 guardrails through L7 cutover — with a **verification and a pass
condition for every step**. Gates, not timers: you advance when the check passes, not when
five minutes have elapsed. See [the restore layer cake](#/learn/04-restore-layer-cake).

### 6. Phase 0: the daily "could we even?" checklist
Before any launch is attempted, a short list must be green **every day**: backups
succeeded, replication lag within RPO, IaC pipeline green, secrets reconciled, recovery
region quotas in place. If Phase 0 is red, your RPO is a lie and your runbook starts with
archaeology. This checklist is cheap to automate and is the single highest-value artifact
for a young program.

### 7. The recovery-test loop
Now execute: pre-flight → launch into the recovery region → verify **layer by layer** →
record timestamps → conclude → triage every finding into a ticket, a gap, or a runbook
edit. Write the record the same day, especially the ugly ones. Details in
[the testing program](#/learn/12-testing-program). Your first test will fail. That is the
test working.

### 8. Game day
When the loop produces clean runs, graduate to a game day: real people, real timers,
ideally real traffic (L7). This is where you discover the human and organizational gaps —
paging, decision authority, comms.

### 9. The decision gate
Take measured RTA/RPA to the business next to the targets. Either they approve, they fund
the gap, or they consciously accept the risk — in writing, in the decisions log. Never
quote a target you haven't measured; see [DR fundamentals](#/learn/02-dr-fundamentals).

## Then loop
DR is a program, not a project: the inventory drifts, the app teams ship, the partners
change IPs. Re-run the assessment quarterly, keep Phase 0 green daily, and keep testing.
