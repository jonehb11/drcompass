# DR Compass — domain validation

**Reviewer:** senior DR architect pass (domain correctness, not code review)
**Date:** 2026-09-16
**Method:** read the domain sources (`server/data/knowledge/*.md`, `server/data/templates/*.json`,
`server/data/strategy-catalog.json`, `server/data/seed/*`, `server/routes/service.js`,
`server/routes/assessment.js`, `server/routes/recommend.js`, `server/lib/xlsx-gen.js`,
`server/lib/ai-bridge.js`, `server/lib/diagram-gen.js`, `web/js/pages/{dashboard,service,settings}.js`)
and exercised the running app read-only on a private data dir
(`DRCOMPASS_HOME=.testhome-val`, port 4690): `GET /api/w/example-acme/service/cmp_adjudication`,
`GET /api/w/example-acme/export/executive-summary.md`.
No AWS account, cluster or Arpio tenant was touched. No source file was modified.

Each finding is tagged **[FACT]** (this is factually wrong or internally contradictory) or
**[JUDGEMENT]** (defensible as written; I would decide differently), with a confidence note
where I am not certain.

---

## 1. Executive verdict

**Would I trust it? Mostly yes on doctrine, not yet on numbers.**

The domain model is the best part of this product and it is genuinely good. The L0–L7 spine with
*gates, not timers*, the shape-vs-bytes split, the Phase 0 → Phase 1 → Phase 2 ladder, the
"success is a business transaction, not green pods" rule, and the knowledge base's sourcing
discipline (inline AWS doc links, explicit "vendor claim" caveats, the Slack "these were AZ-level,
not regional" honesty note) are better than the internal DR documentation at most organisations I
have reviewed. The app-test templates (`server/data/templates/app-tests.json`) — image provenance,
cold-cache tolerance, outbound egress probe, secrets-init log check — are exactly the right tests.
A competent engineer following the knowledge base would build a real program.

**The biggest risk is that the product breaks its own core rule on the one screen everyone looks
at.** DR Compass's stated integrity rule is *never present a target as an achievement, say
"unmeasured" when it is*. In the shipped seed workspace the dashboard renders **"47 min ·
Recovery time — measured"** in green, with the hover text **"Last test met the recovery time
target"**, and the board-ready export prints **"RTA measured | 47 min | Achieved, per workspace
objectives — inside the target"**. That 47 comes from `tst_aug01`, a test whose status is
**`failed`** with a blocker finding — and it reaches the tile via
`workspace.objectives.rtaMinutes`, a **free-text number field in Settings** with no link to any
test at all. Anyone can type 30 into that box and the tool will certify it. That single defect
(findings **H1–H5**) inverts the product's purpose: it makes confidently-wrong DR numbers easier
to produce, and prettier, than they were in a spreadsheet.

**The second risk is the Region-switch runbook.** It teaches a Region switch "practice mode" that
the product's own knowledge article explicitly says does not exist, uses a CLI flag that
contradicts the documented `graceful|ungraceful` modes, has **no fencing step for the old primary**
(while the GitOps runbook calls split-brain "the one failure worse than downtime"), has **no L3
secrets gate** (the #1 killer per the rest of the product), and **flips live traffic before any
functional verification**. And the game-day emergency rollback says "flip DNS straight back to the
primary FIRST, diagnose second" — which, after an Aurora switchover and a fenced primary, routes
live writes at a demoted database and orphans every write taken during the soak.

**Third:** the risk engine is strong on the failure modes it knows and silent on several that
actually take Tier-0 services down in a *regional* event — recovery-region **quota/capacity**,
**IRSA/OIDC trust on a recovered EKS cluster**, **regional ACM certificates**, **KMS single-region
keys**, **ARNs pinned to the primary region**, **layer inversions**, and **dangling dependency
ids** (computed and returned by the API, then never checked).

Net: I would let a team use this to *build* a program today. I would not let anyone quote a number
out of it to an auditor, an exec or a regulator until §6 is fixed, and I would not sign off on
running the Region switch or game-day templates as written (§4).

---

## 2. The restore-layer model (L0–L7)

Sources: `server/data/knowledge/04-restore-layer-cake.md`, `server/routes/service.js:33-47`,
`server/lib/diagram-gen.js:29-30,279-305`, `server/data/seed/components.json`.

The layering itself is sound and the rationale in the article ("L3 before L4 because apps started
before secrets exist will crash-loop and poison your signal"; "L6 before L7 because shifting live
traffic onto a stack that has never completed a business transaction converts their outage into
your incident") is correct and well argued. The "verification by dashboard" anti-pattern —
observability is itself a component, verify with direct commands — is the kind of detail that only
comes from having actually done this.

### L-1 · Layer inversions exist in the seed and nothing detects them — **high** — [FACT]

The L0–L7 order is used *as* the recovery order: `service.js` builds `closure.byLayer` by sorting
purely on `layerRank`, the `restore-layers` diagram chains `L0 --> L1 --> … --> L7`, and
`xlsx-gen.js:needsOf()` sorts a component's prerequisites by `layerOrder`. So a dependency that
sits at a *higher* layer than its consumer is an order the tool will print and an operator will
follow. Two exist in the shipped seed:

| Consumer | Layer | Depends on | Layer |
|---|---|---|---|
| `cmp_eks` (EKS cluster) | **L2** | `cmp_secrets` (Secrets Manager) | **L3** |
| `cmp_clearinghouse` (partner, tier 0) | **L6** | `cmp_cdn` (edge/allowlist) | **L7** |

Nothing in the repo checks this — `grep -rn "inversion" server/` returns only prose about Route 53
health-check inversion. **Why it matters:** the tool tells the operator to bring the platform up
before the secret store it declares a dependency on, and to verify the partner before the edge the
partner reaches you through. At 3am that is a wasted cycle at best and a mis-diagnosed failure at
worst (exactly the "L4 symptoms of an L3 cause" the article warns about).

**Fix:** (a) add a risk rule `layer-inversion` (severity high): for every component, flag any
`dependsOn` target whose `layerRank` is greater than the consumer's; (b) render the offending edge
on the `restore-layers` diagram instead of only the clean L0→L7 chain; (c) fix the seed — either
drop the `cmp_eks → cmp_secrets` edge (the cluster does not need the secret store; its *workloads*
do) or move the secret store to L0/L1 as a precondition, and move `cmp_clearinghouse` and
`cmp_sftp` to L5.

### L-2 · Third parties are at L6 in the seed; the knowledge base says L5 — **medium** — [FACT]

`14-third-party-dependencies.md:74-76` says every third party is a component "usually layer
**L5**", and `04-restore-layer-cake.md:29` gives "the clearinghouse allowlist L5" as its worked
example. The seed puts `cmp_clearinghouse` and `cmp_sftp` at **L6**. L6 is the functional success
bar; a partner is a *precondition* of that bar, not a member of it. **Why it matters:** partner
allowlist and egress-IP work is the one thing you cannot fix during the event (the article's own
framing). Scheduling it at L6 means you discover the miss after the L5 gate has already passed —
i.e. after the point at which you could still have done something about it.

### L-3 · L0 conflates pre-flight checks with foundational resources — **medium** — [JUDGEMENT]

The article defines L0 as "**Nothing is launched.** Confirm the preconditions of recovery: backups
recent, replication lag within RPO, IaC pipeline green, quotas/limits, break-glass access". The
seed then assigns `cmp_iam`, `cmp_kms` and `cmp_acm` to L0 — resources that must *exist*, not
checks that must be *green*. Both readings are defensible but the label ("Guardrails & backups
green") describes only one of them, so an operator reading the layer cake will not realise L0
contains identity, keys and certificates. **Fix:** relabel L0 "Preconditions & foundations" and add
identity/keys/certs/quotas to the article's L0 row, or split the two ideas explicitly.

### L-4 · No intra-layer ordering — **medium** — [JUDGEMENT]

L3 contains "promote the database" *and* "reconcile secrets" *and* "restore object data"; L2
contains VPC, cluster, nodes, mesh, ECR. The model cannot express that Aurora instance-class
scaling must precede promotion (the catalog's own note for `aurora-provisioned-scaling`), that
subnets precede security groups, or that target groups precede listeners. The Arpio runbook gets
this right by hand (step 6 data, step 7 secrets); the *model* does not. This is the gap the
deploy-order engine exists to fill — see §7.

### L-5 · Where ECR belongs is ambiguous across three sources — **low** — [FACT]

Seed: `cmp_ecr` = L1. Article: "ECR images pullable" is an **L2** exit gate. Arpio runbook: the
ops/ECR account is launched **first**, before the app account (step 3). All three put ECR before
pods, so no operator is harmed, but the product's own ordering source of truth disagrees with
itself in a way that will confuse anyone mapping their own estate.

---

## 3. The risk rules (`server/routes/service.js:262-427`)

Live check on the seed's Tier-0 service (`cmp_adjudication`): 19 risks — 2 blocker, 7 high,
10 medium.

**Rules that are right, with the right severity** (no action needed): `service-out-of-scope`,
`dependency-out-of-scope`, `unreplicated-secret` (blocker for `no` is correct — this is the real
#1 killer and the detail text about "an opaque container error, not 'missing secret'" is
accurate), `manual-third-party-failover`, `outbound-target-out-of-scope`, `manual-cutover`,
`no-runbook`, `no-test-coverage`, `test-failed`, `unlayered-dependency`. The
`outbound-target-out-of-scope` rule's undeclared-dependency branch ("It is NOT listed as a
dependency of X, so it never appears in the recovery order") is the single sharpest thing in the
engine — that is the classic hidden blocker and finding it automatically is real value.

### R-1 · `rpo-gap` compares against the wrong number — **high** — [FACT]

`posture.targetRpoMinutes = root.replication.rpoMinutes ?? meta.objectives.rpoMinutes`
(`service.js:566-568`), and `rpo-gap` fires when the measured RPA exceeds *that*. The component's
`replication.rpoMinutes` is a **mechanism capability** (Arpio's ~15-min snapshot cadence, Aurora's
lag); `objectives.rpoMinutes` is the **business tolerance**. Conflating them breaks both ways:

- **False blocker:** a component with `rpoMinutes: 1` (Aurora) measuring RPA 4 min raises a
  **blocker** — "measured data loss exceeds the RPO" — even when the business RPO is 60 minutes.
  Blocker is the severity that stops a program; spending it on replication jitter is how alert
  fatigue starts.
- **Missed breach (worse):** a component with a generous `rpoMinutes` (say 240) measuring RPA 120
  never raises anything, even when the *business* RPO is 15 minutes. The business objective is
  never compared at all once a component number exists.

**Fix:** always evaluate the business objective for the verdict and the severity; report the
mechanism RPO separately as "expected lag" and raise a distinct, lower-severity finding when
measured RPA exceeds the mechanism's own claim (that one means replication is unhealthy, not that
the business is exposed).

### R-2 · `missing-verification` is 37% of the risk list — **medium (fatigue)** — [JUDGEMENT]

7 of the 19 risks on `cmp_adjudication` are `missing-verification`, fired once per dependency at
fixed medium severity, including for `cmp_vpc` and `cmp_kms` — components whose recovery is
genuinely gated by their parent's check. Same shape for `unreplicated-secret`: `cmp_secrets` is
described as "~50 explicit ARNs", so a workspace that fills that array honestly produces up to 50
separate blockers for one condition. **Fix:** aggregate ("7 of 14 dependencies have no
verification command — worst: X, Y, Z"), weight severity by tier and layer, and exempt components
that are covered by a parent gate.

### R-3 · `replication-undefined` misses stateful non-`DATA_CATEGORIES` components — **medium** — [JUDGEMENT]

The rule only fires for `database | storage | messaging-streaming | security-secrets`
(`service.js:52`). It will not fire for a `compute` component that is stateful (EBS-backed EC2, a
StatefulSet with PVCs) or for `observability` (log/metric retention is data someone will ask for
during the post-incident review). **Fix:** drive it off "has persistent state" rather than
category, or add a `stateful` flag.

### R-4 · Dangling `dependsOn` ids are computed, returned, and never checked — **high** — [FACT]

`localClosure()` silently `continue`s on ids not present in the inventory
(`service.js:76` — "cycle-safe, drops dangling ids"), and the route dutifully returns
`closure.danglingDepIds` (`service.js:695`). `computeRisks()` never reads it. **Why it matters:**
a Tier-0 service whose dependency was renamed or deleted now has an invisible hole in its restore
order, and the tool reports a clean, shorter closure with no warning. This is one line of code and
a real 3am failure.

### R-5 · Missing rules for failure modes that genuinely cause regional outages — **high**

These are the ones I would add, roughly in value order. Each is checkable from data the inventory
already holds or from one new field.

1. **`quota-capacity-unverified`** — no field, no rule, no checklist item anywhere for
   recovery-region service quotas, instance-type availability or capacity reservations. The
   knowledge base names this three times (`05-strategy-matrix.md:56-60` "pilot light and warm
   standby both assume the recovery region will sell you the compute during a regional event — when
   everyone else is asking too"; `12-testing-program.md:18` lists it as a Phase 0 row;
   `07-tooling-region-switch.md:91` "scaling blocks don't guarantee capacity"). It is then absent
   from the Phase 0 template, the risk rules and the component schema. For a pilot-light Tier-0
   stack in a real regional event this is the most likely single cause of failure.
2. **`irsa-oidc-trust`** — a recovered or second EKS cluster has a **different OIDC issuer URL**,
   so every IRSA role trust policy must already trust it or every pod loses its AWS identity and
   fails to read secrets/S3 with an opaque error. The seed *models* this
   (`resource-graph.json:186-191`, "IRSA trust anchor — must be trusted in the recovery account
   before an event"; `components.json:890`) and `13-secrets-pitfalls.md:76` names it. There is no
   rule, and **no runbook step in any template checks it.**
3. **`arn-pinned-to-primary`** — `13-secrets-pitfalls.md:39-48` calls a full ARN pointing at the
   primary region "the single most common wiring failure" and says the `secrets[].arn` field exists
   "so the audit is a query, not a grep marathon". Nobody wrote the query. Flag any
   `secrets[].arn` (or endpoint URL) containing `regions.primary` on an in-scope component. Cheap,
   high value.
4. **`certificate-not-regional`** — ACM certificates are regional (and CloudFront's must be in
   us-east-1). `cmp_acm` is L0/in-scope with no check that a valid cert exists in the recovery
   region for each public endpoint. The game-day checklist has it as a manual item; the risk engine
   does not.
5. **`kms-single-region-key`** — `16-replication-mechanisms.md:56-58`: "replication of ciphertext
   you can't decrypt is a very durable form of data loss". No rule checks whether an encrypted
   store's key is multi-region or has a re-encryption plan.
6. **`layer-inversion`** — see L-1.
7. **`stale-evidence`** — nothing decays. One passed test in 2019 leaves `verdict: 'met'` and a
   green dashboard tile forever, contradicting `12-testing-program.md:82` ("findings expire") and
   the quarterly cadence in `02-dr-fundamentals.md:45-48`.
8. **`runbook-without-rollback` / `runbook-without-gates`** — `service.js:514-515` already computes
   `rollbackSteps` and `gates` per runbook and never checks them. A failover runbook with zero
   rollback steps is a one-way door; the product says so in prose
   (`02-dr-fundamentals.md:72`) and never enforces it.
9. **`control-plane-dependency-in-failover-path`** — the central design rule of
   `08-tooling-arc-route53.md` ("design so the event-day action is data-plane only") has no
   enforcement. A runbook step that edits Route 53 records, or a component whose failover
   mechanism is "update DNS record", is exactly the dependency the Oct 2025 us-east-1 event
   punished.
10. **`scheduler-double-run`** — batch/cron active in both regions after failover. The GitOps
    runbook step 6 calls this "a classic split-brain leftover"; there is no field or rule.
11. **`observability-out-of-scope`** — the seed's `cmp_observability` is `partial`, and it is the
    surface every runbook gate reads. The layer-cake article warns about it; no rule fires.
12. **`cache-cold-start-load`** — a Tier-0 database behind a cache that is rebuilt cold takes the
    full thundering herd at cutover. There is an app-test template for cold-cache correctness but
    nothing about the load consequence on the recovered database.

### R-6 · Severity disagreement between the two engines — **medium** — [FACT]

`recommend.js:detectGaps()` and `service.js:computeRisks()` judge the same conditions differently:
a tier-0 component out of recovery scope is **high** in `detectGaps` (`recommend.js:236`) and
**blocker** in `computeRisks` (`service.js:281`). Two pages will show different severities for the
same fact. Pick one table of severities and share it.

### R-7 · The outbound-call target resolver can mis-attribute — **medium** — [JUDGEMENT]

`targetResolver()` (`service.js:230-257`) matches on normalised substrings of ≥4 chars with a
hand-tuned score. "pricing" matches both `cmp_pricing` and `cmp_aurora_pricing`. The risk text then
asserts a scope problem about the resolved component by name. It does say "matched to inventory
component X", which is honest enough, but the finding should carry a confidence and be
user-confirmable — a wrong attribution here produces a wrong sentence about a real risk, which is
the most expensive kind of wrong.

---

## 4. The maturity assessment (`server/routes/assessment.js`)

**What is right, and it is the best-designed scoring model I have reviewed in a tool like this:**
the **evidence caps** (`assessment.js:329-332`). Self-reported level ≥3 requires a passed test, ≥4
requires two, ≥5 requires a passed **game day**, and ≥2 requires a runbook to exist. That is
exactly the discipline these questionnaires normally lack — an org cannot talk its way past level 2
without evidence in the workspace. The 18 questions are well written: each level description is a
recognisable state rather than an adverb ("A partial list lives in heads or scattered docs"), and
several encode real doctrine (`data-rpo` level 3 = "measured once in a real restore (RPA)";
`tst-successbar` level 3 = "a defined business transaction must succeed").

### A-1 · Unanswered questions are free — **medium** — [FACT]

`score = sum(answers) / (answeredCount × 4)` (`assessment.js:263-268`). Answering only the single
best question in each pillar yields six 100% pillars, `overall = 100`, and a raw level 5 — capped
by evidence to 4 if two tests have passed. **Why it matters:** the level is the headline on the
dashboard, and the tool will hand an org level 4 for 6 of 18 answers plus two green tests. **Fix:**
divide by `questionCount`, or refuse to publish a level below (say) 80% completeness and show
"incomplete" instead. The `nextActions` list does nudge "finish the maturity assessment" — but the
number is already printed by then.

### A-2 · No recency in the evidence caps — **medium** — [JUDGEMENT]

Two passed tests from three years ago still unlock level 4. Add a window (the KB's own cadence:
quarterly for Tier 0) so evidence expires.

### A-3 · The "Last achieved RTA" signal is self-asserted — **high** — [FACT]

`assessment.js:318-323` reads `objectives.rtaMinutes` and renders "Last achieved RTA: 47 min vs 60
target" with an `ok`/`err` colour. That field is hand-typed (§6, H-1). The assessment's other
signals are all derived from real collections; this one is not, and it is the only one that makes a
claim about achievement.

### A-4 · No question about failback — **high** — [JUDGEMENT]

`02-dr-fundamentals.md:72` says "untested failback means your recovery is a one-way door — plan the
return trip too", and then nothing in the 18 questions, the Phase 0 checklist or the preflight
checklist asks about it. For a regulated Tier-0 service the return trip is often the *harder* half
(DRS failback overwrites source disks; Aurora failback is a second failover). **Add it**, and
consider adding **recovery-region capacity/quota** (R-5.1) and **control-plane independence of the
failover path** ("could you execute the failover with the primary region and your SSO both dark?").

**What I would cut to make room** — [JUDGEMENT]: `obs-readiness` ("can you see DR readiness on a
normal day?") and `obs-drift` ("would you notice if replication broke or scope drifted?") overlap
by about 70%; merge them into one drift/readiness question.

---

## 5. Runbook and checklist templates

Sources: `server/data/templates/runbooks.json` (5 templates), `checklists.json` (4).

**What is right:** nearly every step carries a `verify` command *and* an observable `pass`
condition (not "looks fine"); layer tags on every step; "no failback without explicit approval"
(Arpio step 12) with the correct reason (in some tools failback has production side effects);
"failing back is a SECOND failover with the same risks — do not fail back on the day of the event"
(region-switch rb1) — that is senior judgement, correctly placed; the L5 direct-endpoint +
`Host:` header trick (Arpio step 9) to prove the edge without touching public DNS; the game-day
roll call and "rollback owner recites the rollback plan from memory" gates; and the same-day
findings triage step. The Phase 0 / preflight / game-day / weekly checklist set is well
proportioned and the `why` text on each item is the kind of thing that survives a skeptical
reading.

Now the problems. **I would not sign off on running the Region switch or game-day templates as
written.**

### RB-1 · The Region switch runbook teaches a feature that does not exist — **high** — [FACT]

`07-tooling-region-switch.md:56-66` states plainly: "**There is no separate practice mode** for
Region switch (scheduled 'practice runs' are an ARC *zonal autoshift* feature — a different
capability). You rehearse by **executing the plan in graceful mode**." The runbook template
contradicts this four times:

- preconditions: "Plan has completed at least one **practice-mode run** in the last quarter"
- step 1 pass: "Plan version matches **last practiced** version"
- step 3: "Start plan execution in real (**not practice**) mode", with
  `aws arc-region-switch start-plan-execution --plan-arn <arn> **--mode failover**`
- notes: "**Practice-mode runs** of the plan are the cheap rehearsal; do one per quarter minimum."

And `recommend.js:125` repeats it: "build the plan in BOTH regions and run **practice mode**
quarterly."

The `--mode failover` flag also contradicts the documented `graceful | ungraceful` modes
(`07-tooling-region-switch.md:58-61`), and *which mode you pick is the difference between an Aurora
switchover at RPO 0 and a failover that loses the replication lag*. **Why it matters:** an operator
looks for a button that isn't there and, worse, may believe the plan has been rehearsed when it
never has. **Fix:** rewrite the preconditions/step 3/notes around scheduled graceful-mode
executions, and make the mode choice an explicit, approved decision in step 2 with the data-loss
consequence spelled out.

### RB-2 · The Region switch runbook never fences the old primary — **blocker** — [FACT]

The GitOps template gets this exactly right — step 2, "Fence the old primary: disable writers
(avoid split-brain)… Split-brain is the one failure worse than downtime", with a real pass
condition ("connections drop to zero"). The Region switch template has **no equivalent step**. Its
step 4 says "the plan's database block promotes the recovery-region replica (e.g. Aurora Global
Database switchover/**failover**)" — conflating the two — and moves on.

**Why it matters:** the realistic regional event is a *gray* failure, not a clean crater (the Oct
2025 us-east-1 event, cited in the product's own case studies, is precisely this shape). An Aurora
Global **switchover** demotes the old writer for you; an **ungraceful failover** does not, and the
old region can keep taking writes from clients whose DNS hasn't moved. Two writers on a claims
ledger is unrecoverable in a way that downtime is not. **Fix:** insert an L1 fence gate before the
data block — scale old-region writers to zero if reachable, revoke DB security-group ingress, or
prove the old writer is demoted/unreachable — with the graceful-vs-ungraceful decision recorded.

### RB-3 · The Region switch runbook flips live traffic before any functional check — **high** — [FACT]

Order as written: step 4 data switchover (L3) → step 5 compute scale-up (L4) → **step 7 traffic
flip** → step 9 "verify functional success bar". The strongest rule in
`04-restore-layer-cake.md:49-52` is **L6 before L7**: "shifting live traffic onto a stack that has
never completed a business transaction converts a regional outage into a customer-facing incident
*you* caused." The Arpio template obeys it (step 9 direct endpoint, step 10 business transaction,
DNS never touched). This one does not, and the only pre-flip evidence is "apps Ready at production
capacity" — an L4 statement that `02-dr-fundamentals.md:53-66` explicitly says is not recovery.

Step 7 is also mislabelled **L5** when it is the live cutover (**L7**). **Fix:** add a
direct-endpoint business-transaction gate (Arpio steps 9–10 pattern) before the traffic block, and
relabel the traffic block L7.

### RB-4 · The Region switch runbook has no secrets gate and no image-provenance check — **high** — [FACT]

The product's own position is that secrets are the #1 recovery killer
(`13-secrets-pitfalls.md`, Phase 0 items 3–4, Arpio step 7 titled "tests usually die HERE") and
that a pod pulling its image cross-region from the dead primary "passes the test and fails the
disaster" (`app-tests.json`). Neither check appears in the Region switch runbook. A pilot-light
stack that has never resolved a secret in the recovery region will fail at step 5/6 with
misleading application symptoms — the exact mis-diagnosis the layer cake exists to prevent.

### RB-5 · Game-day emergency rollback is unsafe for a stateful service — **blocker** — [FACT]

`game-day` rollback rb1: "If live traffic is failing after the flip and the fix is not obvious
within the agreed patience window, **flip DNS straight back to the primary region FIRST, diagnose
second**. The primary is still healthy — that is what makes a game day safe."

The primary is **not** still healthy in the state this rollback runs in. Step 3 executes an
underlying failover runbook, which either **fences the old primary** (GitOps step 2: writers scaled
to zero, SG ingress revoked) or **switches over Aurora Global** (Region switch step 4), making the
old primary a demoted replica. Then step 7 soaks live traffic in the recovery region for 30–60
minutes, taking real writes there. Flipping DNS back at that point:

1. routes live writes at a fenced or read-only database → a customer-facing outage caused by the
   rollback itself; and
2. orphans every write taken during the soak — there is **no reconciliation step anywhere** for
   soak-window data.

Step 8 ("Planned return: reverse DNS flip + underlying runbook's failback") is the correct shape;
rb1 contradicts it under time pressure, which is when it will actually be read. **Fix:** branch the
rollback on "has data been promoted?" — if no (read-only exercise), DNS-first is fine and fast; if
yes, the sequence is quiesce → reverse switchover → verify writes → then DNS, with an explicit
data-reconciliation step and a named owner.

### RB-6 · Game day permits a snapshot-recovered stack to take live traffic — **high** — [FACT]

`game-day` step 3: "Run the chosen failover runbook (**snapshot recovery**, Region switch plan, or
GitOps flip)". A snapshot-recovered environment is, by construction, behind the live primary by up
to the recovery-point interval (~15 min for the Arpio template) — and the Arpio template itself
says "Phase 1 never touches public DNS or live traffic". Putting real customer traffic on a
point-in-time copy while the primary is still live and writing guarantees stale reads and divergent
writes. **Fix:** restrict game-day step 3 to runbooks whose data path is continuous
replication/promotion; state that snapshot tooling is Phase 1 only.

### RB-7 · The Arpio template advises disabling the one control that protects production — **high** — [FACT]

Arpio step 2: "Confirm the launch flags for a TEST: **isolated/sandbox networking OFF** where image
pulls and secrets resolution need real egress". But `06-tooling-arpio.md:20` describes the Network
Sandbox as the feature that "blocks outbound internet from the test environment … so drills can't
email your customers or call your partners."

So the runbook advises turning off the control that stops a drill from sending real claims to the
partner clearinghouse, submitting real settlement files over SFTP, or firing real webhooks — and
the stated reason (ECR pulls, Secrets Manager) is avoidable, because both are reachable through
**VPC endpoints** with no internet egress at all. The "'do not touch production' guards ON" clause
is not a verification and nothing checks it. **Fix:** default to sandbox **on** with VPC endpoints
for ECR/Secrets Manager/STS; if it must be off, add a gate whose pass condition is "no production
data-plane endpoint reachable from the recovered environment; outbound webhooks and schedulers
disabled", verified, not asserted.

### RB-8 · The Arpio secrets gate does not prove what it claims — **high** — [FACT]

Step 7's command is `aws secretsmanager describe-secret --secret-id "$s"` in a loop, pass condition
"no `ResourceNotFoundException`". `describe-secret` returns **metadata only**. It succeeds when the
replica exists with no usable value, when the KMS key is unavailable, and when the *application's*
role has no permission — and `13-secrets-pitfalls.md:75-77` says exactly that: "an admin's
`get-secret-value` proves the secret exists; only the *application's* role proves the IAM plumbing
(policies, OIDC trust, resource policies) also made the trip." The runbook does less than the
admin-level check the article calls insufficient. **Fix:** `get-secret-value` (which forces a KMS
decrypt) executed from the workload's own identity — e.g. `kubectl run` with the tier-0
ServiceAccount — plus the decrypt-probe and rotation-freeze rows from the article's L3 table.

### RB-9 · No mid-flight abort path in any runbook — **medium** — [JUDGEMENT]

Every rollback section assumes "we finished, now reverse". None answers "the data block succeeded
and the compute block failed — do we continue, hold, or reverse, and who decides?" That is the most
likely real shape of a bad failover. Add a decision gate with explicit states.

### RB-10 · DRS failback's destructive behaviour is not warned about — **medium** — [FACT, moderate confidence]

`elastic-dr` rb1: "start reversed replication (recovery instances become sources)". Reverse
replication writes onto the original-region volumes; if the original servers still hold data that
was never replicated forward, that data is overwritten. The template notes "the dangerous moments
are launch-type selection and failback" and then does not say *what* is dangerous about failback.
Also: no fencing of the original servers before a real recovery launch, and no note about
IP/hostname re-addressing for systems that reference those servers directly.

### RB-11 · Phase 0 is a subset of the Phase 0 the knowledge base mandates — **medium** — [FACT]

`12-testing-program.md:12-21` gives a seven-row Phase 0 table. The `phase0` checklist template
implements four of them and omits:

| In the book | In the template? |
|---|---|
| Recovery-region **quotas & capacity** ("vCPU/EIP/instance-type limits fail at the worst time") | **missing** |
| **IaC pipeline green; recovery-region plan clean** (drift detection) | **missing** (item 1 covers SCP changes only) |
| **Runbook freshness** (last-reviewed vs last prod change) | **missing** |

I would also add, from the KB's own content: a **KMS decrypt probe**, **IRSA/OIDC trust in the
recovery account**, and **ACM certificate present in the recovery region**. And `preflight` has no
item for "the previous test's blocker findings are closed or formally accepted", though
`12-testing-program.md:82` makes that a gate on the next test's "clean" rating.

### RB-12 · Summed `estMinutes` invites timer-driven advancement — **low** — [JUDGEMENT]

`service.js:516` sums `estMinutes` per runbook and the UI shows it. The layer cake says "timers are
how runbooks lie to you". The gates do govern advancement, so this is mild — but label the total
"planning estimate, not a schedule".

---

## 6. Knowledge base and strategy catalog — factual accuracy

Sources: `server/data/knowledge/*.md`, `server/data/strategy-catalog.json`.

**Overall: unusually accurate and well sourced.** I checked the AWS-specific claims I can verify
and the great majority are right and precisely stated, including several that are commonly got
wrong: Route 53's control plane is single-region (us-east-1) and not SLA-covered while the DNS and
health-check data planes are designed for 100% availability; ARC routing-control clusters are five
regional endpoints changing state by quorum with a 100% monthly-uptime SLA, while routing-control
*configuration* APIs are not highly available; ARC **readiness checks are closed to new
customers**; Aurora planned **switchover = RPO 0** but unplanned failover loses the lag, and
Aurora PostgreSQL can enforce a ceiling via `rds.global_db_rpo` (min 20s); S3 **RTC's 15-minute /
99.99% is a design goal while the SLA credit line is 99.9%** — quoted with exactly that
distinction; S3 CRR and ECR replication **only cover objects/images written after enabling**; KMS
single-region keys **cannot be converted** to multi-region; Secrets Manager replica secrets **keep
the same name** so name-based lookup fails over; **neither SQS nor Kinesis has native cross-region
replication**; DRS is scoped to EC2-hosted apps and databases and explicitly not RDS, at
$0.028/source-server/hour, as the successor to CloudEndure (EOL 31 Mar 2024); ARC cluster pricing
$2.50/hour. The "Design-goal ≠ SLA" and "Planned ≠ unplanned numbers" rules in
`16-replication-mechanisms.md:52-55` are the right rules stated the right way.

The case studies are sourced with primary links and carry honest caveats (the Slack note — "these
exercises are AZ- and service-level, not regional evacuation — cited for exercise *process*" — is a
model of how to do this). Netflix's 45–50 min → ~7 min via Project Nimble, the Sept 2015 DynamoDB
and Feb 2017 S3 us-east-1 events are correctly described.

### K-1 · "up to 10 secondary regions" for Aurora Global Database — **medium** — [FACT, ~85% confidence]

`16-replication-mechanisms.md:14`. AWS documents an Aurora global database as one primary Region
plus **up to five** read-only secondary Regions. Operationally harmless, but a reviewer who spots
it discounts the whole table — and this table's credibility is the product's main asset. Verify and
correct.

### K-2 · AWS Backup listed as covering ElastiCache — **medium** — [FACT, ~80% confidence]

`strategy-catalog.json:371`: `aws-backup-copy.kinds` includes `elasticache-redis`. AWS Backup's
supported-services list does not include ElastiCache; ElastiCache has its own snapshot/export
mechanism. This matters because all three seed Redis components are `drStrategy: backup-restore`,
so the tool would point an operator at a service that cannot protect them. Verify; if confirmed,
remove the kind and route Redis to Global Datastore or the explicit "rebuildable cache, measure
warm-up" path the KB already recommends.

### K-3 · "Practice mode" — **high** — [FACT] — see RB-1. The article is right; the runbook and
`recommend.js` are wrong. Fix the artifacts, not the article.

### K-4 · Route 53 health-check block is layered L5, and the plan generator orders by layer — **high** — [FACT]

`strategy-catalog.json:287-292` gives the **Route 53 health check** execution block `layer: "L5"`
while the ARC routing control block gets `L7`. Both move live public traffic;
`07-tooling-region-switch.md:48` hedges it as "L5/L7". Because
`recommend.js:regionSwitchPlan()` sorts the drafted plan **strictly by layer**
(`recommend.js:204-205`), a workspace whose edge maps to the health-check block gets a drafted plan
that flips public traffic **before L6**. The catalog itself says the opposite in the
`manual-approval` note: "always before the L7 traffic cutover". **Fix:** label it L7.

Related, same file: `blockTypeFor()` maps API Gateway (`category: edge-dns`, kind not matching
`/route53|dns/`) to `routing-control` — "ARC routing control / edge configuration change to shift
traffic". API Gateway is the edge *entry point*, not a traffic switch. `cmp_apigw` in the seed is
mislabelled this way today.

### K-5 · The drafted Region switch plan has no approval gate and no L6 verification — **high** — [FACT]

`regionSwitchPlan()` emits one step per (layer, blockType) group derived from components. No
component is a "success bar" or an "approval", so the generated plan contains **neither a
manual-approval block nor any L6 verification** — violating both the catalog's own note
(`strategy-catalog.json:276`) and the doctrine the product repeats everywhere ("human decides,
machine executes"). **Fix:** always inject a `manual-approval` block before any L7/traffic block
and an L6 verification step before it, regardless of inventory shape.

### K-6 · SQS/Kinesis drafted as "promote/restore" — **medium** — [FACT]

`blockTypeFor()` sends `messaging-streaming` to `data-switchover`, whose note reads
"Promote/restore recovery-region data stores; verify freshness before apps start"
(`recommend.js:161,175`). Neither SQS nor Kinesis can be promoted or restored — that is the
KB's own "hole in the menu" (`16-replication-mechanisms.md:25-43`). Route them to
`custom-lambda`/redrive with the accepted-loss decision surfaced.

### K-7 · `strategyFit` says a strategy "meets your targets" from hard-coded floors — **medium** — [JUDGEMENT]

`strategy-catalog.json` supplies **no** `rtoFloorMinutes`/`rpoFloorMinutes`, so `loadCatalog()`
always fills them from `FALLBACK_CATALOG` (backup-restore 240/60, pilot-light 30/15, warm-standby
10/5, active-active 1/1) and then prints "Typical pilot light recovery (~30m RTO / ~15m RPO floor)
**meets your targets**". That is an unmeasured, generic claim phrased as compliance — the thing
`05-strategy-matrix.md:39-43` forbids ("Never quote the column header as your RPO"). It also
ignores the article's own rule 5, "**let the data layer veto**": a workspace whose only mechanism is
a nightly snapshot copy is capped at backup-restore RPO no matter how warm the compute is, and the
fit engine will not notice. **Fix:** soften to "could plausibly support" and cross-check the
declared `replication.mechanism` set before declaring fit.

### K-8 · Missing replication mechanisms — **medium** — [JUDGEMENT]

The menu has no entry for **MSK / Kafka (MSK Replicator)**, **OpenSearch cross-cluster
replication**, **EFS replication**, **FSx**, **EBS snapshot / AMI copy**, or **DocumentDB /
Neptune global clusters** (which appear as Region switch blocks but not as mechanisms). Kafka in
particular is a very common Tier-0 stateful dependency, and an operator who has one finds nothing
and will improvise.

### K-9 · Vendor numbers presented as catalog facts — **low** — [JUDGEMENT]

`arpio-snapshot rpoSeconds: 900` and `arpio-realtime rpoSeconds: 5` sit in the same array, in the
same shape, as AWS-documented figures. The Arpio *article* caveats this correctly ("everything above
is the vendor's published claims (cited)… set `rpoMinutes` to what you've *observed* in drills, not
the brochure number"); the catalog does not. Add a `provenance: vendor-claim | aws-doc | measured`
field so consumers can render the difference.

### K-10 · Case-studies sourcing claim slightly overstated — **low** — [FACT]

The article opens "These studies are verified against **primary sources**", and the Capital One
"~70% reduction in average recovery time" is cited to a third-party dev.to write-up of a re:Invent
session. Either re-cite to the session itself or footnote the figure as secondary — the rest of the
article's sourcing discipline is good enough that this one stands out.

### K-11 · DynamoDB MRSC caveats omitted — **low** — [JUDGEMENT]

The entry notes "MRSC = RPO 0 (GA June 2025, same-account, limited regions)" but not the two
constraints that decide whether you can actually have it: it requires a **three-Region**
configuration (three replicas, or two plus a witness) and **cannot be enabled on an existing
table**.

---

## 7. The honest-numbers discipline — the product's core rule

This is where the audit found the most serious problems. The *doctrine* is stated better here than
anywhere else I have seen it written down: `02-dr-fundamentals.md:6-23` ("the iron rule: never
quote an unmeasured target"), the AI ground rules (`ai-bridge.js:17` — "RTO/RPO are TARGETS…
RTA/RPA are MEASURED… Never present a target as an achievement"), the exec-summary sheet's own
"how to quote numbers" block (`xlsx-gen.js:3502`), `unmeasured` rendered consistently in the
workbook and the test lists. And `service.js` mostly does the right thing: `posture.measured` is
derived only from a test record, `verdict` defaults to `'unmeasured'`.

Then the seam. Five defects, all sharing one root cause.

### H-1 · RTA/RPA are hand-typed, unlinked, and rendered as achievements — **blocker** — [FACT]

`workspace.objectives.rtaMinutes` / `rpaMinutes` are free number inputs in Settings
(`web/js/pages/settings.js:24-25,52-53`) with no reference to any test. They are then presented as
measurements:

- **Dashboard** (`dashboard.js:95-102`): `recoveryTile({ measured: obj.rtaMinutes, … label:
  'Recovery time — measured' })`, tinted green when `measured <= target`, with hover text
  **"Last test met the recovery time target"** — asserting a test result from a field no test
  wrote. The caption below even says "Big number = what your last test actually achieved."
- **Settings** (`settings.js:123-126`): a green badge, `"outage: 47 min measured vs 60 min target"`.
- **Workbook / DR package** (`xlsx-gen.js:950-958`): `pick()` **prefers** the hand-typed field over
  a real test measurement and labels its provenance `"workspace objectives"`.
- **Assessment** (`assessment.js:318-323`): signal "Last achieved RTA".
- **AI context** (`ai-bridge.js:470`): the model is *told* that
  `objectives.rtaMinutes/rpaMinutes` "are the MEASURED results copied from a real test" — so the
  copilot will faithfully repeat an unverified number, under instructions that forbid exactly that.

**Fix:** derive RTA/RPA only from test records (the `service.js` pattern), make the Settings fields
read-only mirrors of the selected test, and render the test name + date + status beside every
number, everywhere.

### H-2 · RTA is accepted from tests that FAILED — **blocker** — [FACT, verified live]

The shipped seed demonstrates the whole failure end to end. `tst_aug01`: `status: "failed"`,
`cleanRun: false`, 3 findings including a blocker, `results.rtaMinutes: 47`. That 47 is copied into
`workspace.objectives.rtaMinutes`. Result:

- Dashboard: **47 min, green, "Last test met the recovery time target."**
- `GET /export/executive-summary.md`, honest-numbers table:
  `| RTA measured | 47 min | **Achieved**, per workspace objectives — inside the target |`
- `service.js:570` computes `rtoMet: true` from the same failed test.

By the product's own definition this number cannot exist: RTA = T1 − T0 where T1 is the moment the
**L6 functional success bar** passes ("the clock stops at L6, never at 'the pods are up'",
`12-testing-program.md:77`). A failed test did not reach L6, so it has no RTA — it has a time to
failure. **Partial credit where due:** the exec summary's test-history table does show "Fail", and
next-action #2 says "Until it passes, the measured numbers above describe a failed run". But the
headline row is the thing that gets pasted into a deck, and it says *Achieved*. **Fix:** only
`status === 'passed'` may yield RTA; a failed run's duration is labelled "time to failure" and can
never satisfy an objective.

### H-3 · A service can display another service's measurement — **high** — [FACT]

`service.js:564` selects `posture.measured` from the newest passed/failed test that covers the
service **directly, through its dependency closure, or merely because it shares a runbook**
(`covers: 'direct' | 'closure' | 'runbook'`, computed at line 548). The verdict and the UI tile
(`web/js/pages/service.js:240-257`) show `RTA … / RPA …` and "Objectives met" without surfacing
`covers`. So a service that has never itself been in a test can display "Objectives met · RTA 38
min" because a sibling service's test used the same runbook. **Fix:** only `covers === 'direct'`
may produce a verdict; closure/runbook coverage renders as "inferred from a related test — not
measured for this service".

### H-4 · `verdict: 'met'` requires only ONE of the two objectives — **high** — [FACT]

`service.js:597-599`: `rtoMet === true || rpoMet === true → 'met'`, rendered as **"Objectives
met"** (plural). With RTA inside target and RPA never measured, the UI asserts both objectives are
met. **Fix:** require both non-null and true for `'met'`; otherwise `'partial'`, naming which one
is unmeasured.

### H-5 · The RPO the verdict is judged against is the mechanism's, not the business's — **high** — [FACT]

See **R-1**. `targetRpoMinutes` prefers `component.replication.rpoMinutes`, so "objectives met" can
be true against a replication capability while the business RPO is breached, and a mechanism-lag
miss can be escalated to blocker while the business is comfortably inside tolerance.

### H-6 · Nothing goes stale — **medium** — [JUDGEMENT]

No verdict, tile or level decays with age. One passed test makes a workspace permanently green,
against `02-dr-fundamentals.md`'s quarterly cadence and `12-testing-program.md:82`'s "findings
expire". **Fix:** a `staleAfterDays` on the workspace; render `'stale'` past it.

### H-7 · `cleanRun: false` never affects any verdict or sentence — **medium** — [JUDGEMENT]

`cleanRun` is carried through `posture.measured` and the exec model and used nowhere. A recovery
that reached L6 only after undocumented manual intervention is not a reproducible capability —
`12-testing-program.md:80` says the improvisation becomes a runbook change or a finding. Surface it
next to the number.

---

## 8. Deployment / recovery-order engine

**It is not there yet.** `server/lib/deploy-order.js` and `server/routes/deploy-order.js` do not
exist. The integration contract does: `server/index.js:58` mounts the route optionally;
`xlsx-gen.js:3126-3152` probes for any of
`deployOrder | buildDeployOrder | computeDeployOrder | deployOrderModel | getDeployOrder |
deploymentOrder | default` and renders a `{ waves, categoryOrder, cycles, unordered, stats }`
model. Two things about the consumer side are already right and worth keeping: cycles are
**reported, not silently broken** ("an order with a flagged cycle is safer than a clean-looking
order that is wrong" — correct), and `unordered` items are surfaced as "NOT PLACED IN ANY WAVE".

Since I cannot validate the engine, here is the acceptance checklist I would hold it to, derived
from the failure modes that actually waste an hour at 3am. Items marked ⚠ are things **today's**
artifacts get wrong, so the engine must not inherit them:

1. **Network before everything it contains:** VPC → subnets → route tables / NAT / IGW → security
   groups → VPC endpoints → EKS control plane → node groups. Note the genuine two-phase problem:
   SG *rules* that reference a peer SG require both SGs to exist first, so "create SG" and "apply
   SG rules" are separate nodes, not one.
2. **IAM and KMS before every consumer**, and specifically **OIDC provider → IRSA role trust →
   pods**. ⚠ Nothing in the product models this today (R-5.2); it is the single most likely
   silent failure on a *recovered* EKS cluster, because the new cluster has a new issuer URL.
3. **Secrets (and their KMS keys) before workloads.** ⚠ The seed has `cmp_eks` (L2) depending on
   `cmp_secrets` (L3) — the engine must flag that inversion rather than emit the order (L-1).
4. **ECR images present and pullable before any pod that references them**, and the image host must
   be the recovery-region registry (`app-tests.json` already has the right check).
5. **Target groups before listeners; listeners before DNS/alias records.**
6. **"Ready, not merely created"** must be the edge semantics: wave N+1 waits on wave N's
   *readiness gate* (nodes `Ready`, deployment `Available`, target group `healthy`, DB accepting
   writes), never on API-create success. This is the difference between the engine being useful and
   being a prettier `terraform graph`.
7. **Pods wait on both their mounts and their startup-call targets:** PVC → PV → EBS/EFS, *and*
   whatever they call during boot (DB, secret store, token endpoint) must be gated, not merely
   present.
8. **Third-party endpoints are verify-not-deploy preconditions.** `recommend.js:181` already has
   the right wording ("Must already be true in the recovery region before execution — verify,
   don't create") — reuse it, and place partner allowlist/egress verification at L5, **before** the
   success bar (⚠ contradicted by the seed's L6 placement, L-2).
9. **Intra-layer order must be expressible** — Aurora instance-class scaling before promotion;
   promotion before app connect (⚠ L-4: the L0–L7 spine cannot say this today).
10. **A fence edge on the old primary before any promotion** (⚠ RB-2).
11. **Do not silently drop dangling ids** the way `localClosure()` does (R-4); report them as
    unordered with a reason.
12. **Consume both `dependsOn` and the resource-graph edges**, and reject/flag layer inversions
    rather than sorting them away.

Until it lands, the ordering claims the product actually makes live in the L0–L7 spine (validated
in §2, with two inversions and no intra-layer order) and in the runbook templates (validated in
§5, with three ordering defects: no fencing, traffic before verification, and a DNS-first
rollback after data promotion).

---

## 9. The overall product claim

If a competent engineer new to DR used this end-to-end on a real Tier-0 service, they would come
out with a genuinely good inventory, a defensible layered runbook, a real test loop, and a
vocabulary that would hold up in a design review. Five things would still be missing or
misleading:

1. **Capacity and quota reality in the recovery region.** Named three times in the knowledge base,
   present in zero generated artifacts — no component field, no risk rule, no Phase 0 item. In an
   actual regional event, when every other tenant is scaling into the same region, this is the most
   likely reason a pilot-light Tier-0 stack does not come back. Today the tool would report a green
   posture right up to the `InsufficientInstanceCapacity` error.
2. **Failback.** "Untested failback means your recovery is a one-way door" appears in the
   fundamentals and is then never operationalised: no assessment question, no checklist, thin
   runbook coverage, and DRS's destructive reverse replication unflagged.
3. **Identity plumbing in the recovery region** — IRSA/OIDC trust, regional ACM certificates,
   break-glass that does not depend on the SSO that just died. Described well in prose (articles
   13 and 14), absent from every rule, checklist and runbook step.
4. **Cross-store recovery-point consistency.** "Aligned recovery points … all from the same sync
   set" is a pass condition in the Arpio runbook step 1, but no data model expresses consistency
   groups, so the tool cannot tell you that your Aurora recovery point and your S3 recovery point
   are 40 minutes apart — which is how you recover into a state your application has never seen.
5. **Safety of the test itself.** The sandbox-off advice (RB-7) means the first thing a new user
   does with this tool could be to send real test claims to a real partner from a recovered stack.

### The single highest-value thing to fix next

**Make every RTA/RPA in the product traceable to a *passed* test that *directly* covers the thing
being described, and never render "achieved", "measured" or "met" from a failed, indirect or
hand-typed number.**

That is findings **H-1 through H-5** as one change, in one place: a shared
`measuredNumbers(workspace, tests, componentId) → { value, testId, testName, date, status, covers,
cleanRun, isAchievement }` helper consumed by the dashboard tiles, `service.js:posture`,
`assessment.js` signals, `xlsx-gen.js:execModel`, and the AI context. Do it first because
(a) it is the product's stated reason to exist, (b) it is currently violated on the headline tile
*and* in the board-ready export *in the shipped seed data*, and (c) everything else in the tool —
every risk rule, every runbook, every maturity level — is only worth something if those two numbers
can be trusted.

---

## 10. Prioritised top 10

| # | Finding | Severity | Where |
|---|---|---|---|
| 1 | RTA/RPA are hand-typed, unlinked to any test, and rendered as "measured / achieved / target met" on the dashboard, in Settings, in the exec summary and in the AI context | **blocker** | H-1 · `dashboard.js:95-102`, `settings.js:24-25`, `xlsx-gen.js:950-958`, `ai-bridge.js:470` |
| 2 | RTA is accepted from **failed** tests; the seed ships a green "Last test met the recovery time target" sourced from a failed run with a blocker finding | **blocker** | H-2 · `service.js:564-599`, `xlsx-gen.js:947`, seed `tst_aug01` |
| 3 | Game-day emergency rollback flips DNS back to a fenced/demoted primary first, with no reconciliation of soak-window writes | **blocker** | RB-5 · `runbooks.json` `game-day` rollback 1 |
| 4 | Region switch runbook never fences the old primary before promotion, and conflates switchover with failover | **blocker** | RB-2 · `runbooks.json` `region-switch-failover` step 4 |
| 5 | Region switch runbook flips live traffic before any functional verification (and labels the cutover L5); the drafted ARC plan likewise has no approval gate and no L6 step | **high** | RB-3, K-4, K-5 · `runbooks.json` steps 7/9, `strategy-catalog.json:287-292`, `recommend.js:186-224` |
| 6 | Missing risk rules for the failure modes that actually cause regional outages — quota/capacity, IRSA/OIDC trust, regional certs, single-region KMS, primary-pinned ARNs, layer inversion, stale evidence, dangling dependency ids | **high** | R-4, R-5 · `service.js:262-427` |
| 7 | Region switch runbook teaches a nonexistent "practice mode" and the wrong `--mode` flag, contradicting the product's own article; repeated in `recommend.js` | **high** | RB-1, K-3 · `runbooks.json`, `recommend.js:125` vs `07-tooling-region-switch.md:56-66` |
| 8 | Arpio template tells operators to disable the network sandbox (the control that stops drills calling partners), and its secrets gate uses `describe-secret`, which proves neither value nor decrypt nor app identity | **high** | RB-7, RB-8 · `runbooks.json` steps 2 and 7 vs `06-tooling-arpio.md:20`, `13-secrets-pitfalls.md:75-77` |
| 9 | Verdict logic overstates: `'met'` on either objective alone, judged against the mechanism's RPO rather than the business RPO, and satisfiable by another service's test | **high** | H-3, H-4, H-5, R-1 · `service.js:548,566-599` |
| 10 | Layer inversions in the seed with no detector, third parties at L6 instead of L5, and Phase 0 missing the quota/drift/runbook-freshness rows its own article mandates | **medium–high** | L-1, L-2, RB-11 · seed `components.json`, `diagram-gen.js:279-305`, `checklists.json` `phase0` |

---

### Confidence notes

- Everything marked [FACT] about **internal contradictions** (KB vs template vs code) I verified by
  reading both sides; confidence high.
- H-1 and H-2 I verified against the **running app** (service-profile JSON and the generated
  `executive-summary.md` quoted verbatim above); confidence very high.
- Two **external** AWS facts I flag for verification rather than assert: Aurora Global Database's
  secondary-Region limit (K-1, I believe five, ~85%) and AWS Backup's coverage of ElastiCache
  (K-2, I believe unsupported, ~80%).
- Claims in the KB dated after mid-2026 (next-gen Resilience Hub GA, Region switch block additions
  of Dec 2025 / Feb 2026, the Oct 2025 DynamoDB DNS post-event summary, re:Invent 2025 ARC404) I
  could not independently verify; all carry inline citations, which is the right way to ship them.
- §8 is an acceptance checklist, not a validation: the deploy-order engine did not exist at the
  time of this pass.
