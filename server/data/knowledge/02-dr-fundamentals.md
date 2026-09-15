# DR fundamentals: targets, tiers, and what "recovered" means
<!-- section: Start here | order: 20 -->

Four ideas carry the whole discipline. Get these right and the rest is engineering.

## 1. RTO/RPO are targets. RTA/RPA are facts.

| Term | Meaning | Who owns it |
|---|---|---|
| **RTO** — Recovery Time Objective | How long the business says it can tolerate being down | The business (signed off) |
| **RPO** — Recovery Point Objective | How much data loss (in time) the business can tolerate | The business (signed off) |
| **RTA** — Recovery Time Achieved | How long recovery *actually took* in your last measured test | Engineering (measured) |
| **RPA** — Recovery Point Achieved | How much data you *actually lost/lagged* in your last measured test | Engineering (measured) |

The iron rule: **never quote an unmeasured target.** "Our RTO is one hour" is meaningless
until a timestamped test shows RTA ≤ 60 minutes. Until then the honest sentence is: "Our
target is one hour; our last measured RTA was 4h 12m; here is the gap list." DR Compass
keeps both pairs side by side in Settings for exactly this reason — the dashboard shows
the delta, not just the aspiration.

RPA comes from evidence too: replication lag at the moment you cut over, or the age of
the newest restored record versus the source. If your replication monitoring can't tell
you the lag, your RPA is "unknown", which is a finding.

## 2. Tier the estate — one number per component

| Tier | Meaning | Typical target posture |
|---|---|---|
| **0** | Business stops. Revenue, safety, or legal exposure within minutes–hours | Minutes–low hours RTO; minutes RPO; tested quarterly |
| **1** | Severe degradation; workarounds exist for a day | Hours RTO; ≤1h RPO |
| **2** | Internal pain, external invisibility | Same-day RTO; daily RPO |
| **3** | Nobody outside the team notices for a week | Backup & restore; best effort |

Tiering is a business conversation with an engineering vocabulary. Its payoff: you spend
warm-standby money only on tier 0/1, and you can say "no" to gold-plating tier 3 with a
straight face. Every component in the Inventory carries its tier; sort by it whenever
you're deciding what to fix next.

## 3. DR is a program, not a project

A project ends. Your architecture doesn't. Every sprint adds a queue, a secret, a partner
call — each one silently out of recovery scope until someone puts it in. A DR "project"
produces a binder that is wrong within a quarter. A DR **program** is a loop:

- **daily**: Phase 0 checklist green (backups, replication lag, pipeline health)
- **weekly/monthly**: recovery-test loop in a lower environment
- **quarterly**: game day; re-run the maturity assessment; re-review the inventory
- **continuously**: findings → tickets → runbook edits → next test

> A plan that hasn't been executed is a hypothesis. A plan executed once is an anecdote.
> A plan executed on a schedule with measured RTA/RPA is a capability.

## 4. Success is a business transaction, not green pods

The recovery is done when **a real business transaction completes end to end** in the
recovery region — a claim adjudicates, an order books, a payment settles — and the answer
is *correct*. It is not done when:

- pods are Running (they may be crash-looping on a missing secret)
- health endpoints return 200 (liveness checks rarely touch the database)
- the dashboard is green (your observability stack may itself be broken in-region)

Define the success bar as an executable check — the SPEC calls this the **L6 functional
success bar** — and store it on the test (appTests) so every exercise runs the same
transaction. "Kubectl says Ready" is an L4 statement. Recovery is declared at L6, and
RTA's clock stops at L6, not before.

## Corollaries worth taping to a monitor

- If you haven't tested restore, you don't have backups; you have hope with a retention policy.
- The recovery region's IAM, quotas, and networking are part of the product, not an afterthought.
- Untested failback means your "recovery" is a one-way door — plan the return trip too.
- The most likely disaster is not a hurricane; it's a bad deploy, a deleted table, or an expired credential. Regional DR machinery must not be so exotic that nobody dares use it for the common cases.
