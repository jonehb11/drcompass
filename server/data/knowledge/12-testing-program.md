# The testing program: Phase 0 → recovery tests → game day
<!-- section: Running the program | order: 120 -->

Testing is the program. Everything else — inventory, runbooks, tooling — exists so that
a test can be run, measured, and improved. Structure it in three phases; don't skip ahead.

## Phase 0 — the daily "could we even?" checklist

Phase 0 asks: *if the disaster happened right now, are the preconditions of recovery
true?* It runs (ideally automated) every day, and it is green or the program stops.

| Check | Why | Proof to record |
|---|---|---|
| Backups completed within window | No backup, no floor under your RPO | Job IDs + completion timestamps |
| Replication lag ≤ RPO (each replicated store) | Lag *is* your RPA if you fail over now | Lag metric snapshot per store |
| IaC pipeline green; recovery-region plan clean | A broken pipeline means rebuilding shape by hand | Last successful run link |
| Secrets reconciled (primary vs replica list) | #1 recovery killer; drift is silent | Diff output: zero missing |
| Recovery-region quotas & capacity | vCPU/EIP/instance-type limits fail at the worst time | Quota report vs required |
| Break-glass access works | You may need to log in while SSO is down | Last verified date |
| Runbook freshness | A runbook older than the architecture is fiction | Last-reviewed date vs last prod change |

Build this in **Checklists** (kind: `phase0`), give every item an owner and a `proof`
field. A red item is a finding *today*, not on game day.

## Phase 1 — the recovery-test loop

A recovery test launches the stack in the recovery region, in a lower environment, on a
schedule. The loop, each iteration:

1. **Pre-flight.** Phase 0 green; scope declared (which components, which layers, target
   duration); the runbook version pinned; a scribe assigned. Create the test in
   **Tests** with its linked runbook *before* you start.
2. **Launch.** Execute the runbook from L1. Record **T0** (decision/start), first access
   to recovery environment (**tFirstAccess**), and a timestamp at every layer gate.
   Written timestamps — chat messages count, memories don't. **RTA is computed from
   written timestamps only.**
3. **Verify layer by layer.** Advance gate by gate ([layer cake](#/learn/04-restore-layer-cake)).
   Stop at the first failed gate if it can't be fixed inside the test window; a clean
   stop at a real blocker is a successful test.
4. **Record T1** when the L6 functional bar passes — the business transaction completes
   correctly. RTA = T1 − T0. RPA = measured data staleness at promotion. Enter both in
   the test's results.
5. **Conclude.** Tear down (or fail back), confirm cost cleanup, thank the humans.
6. **Triage every finding — same day.** Each finding becomes exactly one of:
   - a **ticket** (engineering fix, tracked to closure),
   - a **gap** (accepted or awaiting decision — file it in Gaps with severity),
   - a **runbook edit** (the step was wrong/missing — fix it *now*, while it's fresh).

**Write the test record the same day, including the ugly ones.** Especially the ugly
ones — a record that says "L3 failed: replica secret missing for `pricing/db-password`,
1h52m lost to diagnosis" is worth ten green checkmarks. Sanitized test records are how
programs convince themselves they're ready while measuring nothing. The `record` field
takes a markdown narrative; write it like an incident review: timeline, surprises,
decisions, quotes.

**Cadence:** monthly is a good start; the loop's value compounds when the *same* test is
repeated and RTA visibly drops from 6h to 90m over four iterations. Track every
iteration in **Tests** so the dashboard shows the trend.

## Phase 2 — game day

When Phase 1 produces clean runs at target RTA twice in a row, graduate:

- **Production-shaped** (or production), with the real edge: DNS failover, partner
  connectivity, real allowlists — the L5/L7 material Phase 1 can't fully exercise.
- **Real people under real timers.** On-call gets paged; the runbook is followed by
  someone who didn't write it; leadership plays their actual decision role
  ("do we declare? who approves L7?").
- **Optionally live cutover (L7)** with business sign-off, during a low-traffic window,
  with a rehearsed rollback. Companies that are good at this ([case studies](#/learn/15-case-studies))
  treat live regional failover as routine maintenance, not a stunt — that's the end state.
- Tabletop variants (talk through the runbook against a surprise scenario) are cheap and
  find decision-authority and comms gaps; log them as `tabletop` tests.

## Rules that keep the program honest

- **The clock stops at L6**, never at "the pods are up".
- **No unmeasured claims**: RTA/RPA quoted anywhere must trace to a test record's timestamps.
- **A test with zero findings** means the test was too easy — widen scope or add surprise.
- **Never fix-forward silently**: if an operator improvised during the test, the runbook
  gets the improvisation, or the improvisation was wrong and gets a finding.
- **Findings expire**: an open blocker finding older than one test cycle blocks the next
  test's "clean" rating.
