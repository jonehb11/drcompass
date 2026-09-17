# Measured numbers — the contract

**Status:** stable. `server/lib/measured.js` is the single source of truth for every
RTA / RPA number the product renders, and for the severity of every risk finding.
Consumers: `server/routes/service.js`, `server/routes/assessment.js`,
`server/routes/recommend.js`, `server/lib/xlsx-gen.js`, `server/lib/ai-bridge.js`,
`web/js/pages/*`.

## The rule this file exists to enforce

> RTA = T1 − T0, where T1 is the moment the **L6 functional success bar** passes.
> A test that did not pass never reached L6, so **it has no RTA**. It has a time to failure.

Therefore:

- A number is **measured** only if it came from a test whose `status === 'passed'`
  **and** that test **directly covers** the subject (definition below).
- A hand-typed number (`workspace.objectives.rtaMinutes` / `rpaMinutes`) is **declared**,
  never measured. It may be displayed, but never with the words *measured*, *achieved*,
  *met*, *target met*, or a green "pass" treatment.
- Every number that is displayed as evidence must carry its provenance
  (test id, name, date, status). **No provenance ⇒ not evidence.**

## API

```js
import {
  measuredNumbers,        // the helper
  objectiveFor,           // WHOSE objective a scope is judged against
  coverageOf,             // the "covers" predicate, exposed
  severityFor,            // the ONE severity table (both risk engines)
  RISK_SEVERITY,
  DEFAULT_STALE_AFTER_DAYS, // 180
  staleAfterDaysFor,      // (workspace) -> configured threshold
  formatNumber,           // display string for one metric entry
} from '../lib/measured.js';
```

### `measuredNumbers(workspace, tests, componentId = null, options = {})`

- `workspace` — the workspace meta object (`store.getWorkspace(slug)`). Reads
  `objectives.{rtoMinutes,rpoMinutes,rtaMinutes,rpaMinutes,approved,staleAfterDays}`.
- `tests` — the tests collection. Accepts **either** raw store records
  (`t.results.rtaMinutes`) **or** the flattened shape `service.js` builds
  (`t.rtaMinutes`). Both are normalised internally.
- `componentId` — the subject. `null` / omitted ⇒ the **workspace** is the subject.
- `options` (all optional):
  | key | meaning |
  |---|---|
  | `components` | components collection — enables mechanism-RPO and closure lookups |
  | `component` | the already-resolved subject component (skips the lookup) |
  | `runbooks` | runbooks collection — enables runbook-**step** coverage (see below) |
  | `closureIds` | `Set`/array of the subject's dependency-closure ids |
  | `staleAfterDays` | override the threshold (default: workspace, then 180) |
  | `now` | `Date`/ISO for deterministic tests |
  | `target` | **whose objective this subject is committed to**, when it is not the workspace's — see below |

Pure function. No I/O, no store access, no throw on malformed input (missing/odd
fields degrade to `unmeasured` with a warning).

### Whose objective — `objectiveFor()` and `options.target`

A target is a **commitment, and a commitment belongs to somebody**. `services[].objectives`
carries the one with `approved: true` and the BIA that set it; `workspace.objectives`
carries engineering's proposal. Judging a service against the workspace figure is wrong in
both directions — it reported 30 minutes of tolerated data loss where the signed BIA says
15, and it judged a dev environment against production's approved commitment.

```js
objectiveFor({ workspace, services, environments, serviceId, envId }) -> {
  rtoMinutes, rpoMinutes, approved, source,
  level: 'service' | 'environment' | 'workspace' | 'none',
  owner,                       // 'adjudication service' / 'Dev environment' / 'the workspace'
  none,                        // true ⇒ this scope has NO objective of its own
  fromWorkspace,               // true ⇒ nothing narrower applied
  workspace: { rtoMinutes, rpoMinutes, approved },   // always carried, named as the workspace's
  conflict: { rtoMinutes, rpoMinutes, approved, summary } | null,
}
```

Resolution order: the scoped **service**, then the scoped **environment**, then the
**workspace**. Two rules it will not bend, and neither may a consumer:

1. **A scope with no objective of its own does not inherit one.** `level: 'none'`, both
   numbers `null`, and therefore **no verdict** — no claim is reached against a number that
   was never that scope's commitment. The workspace figure is still carried, named as the
   workspace's, so a renderer can show it without lending it.
2. **A disagreement is reported, not resolved.** `conflict` holds the workspace's numbers
   and a one-line summary. Printing one number and dropping the other is how the wrong one
   reaches a board.

`objectiveFor()` answers with **data only**. The sentences an export prints are composed by
the renderer (`xlsx-gen.js:resolveObjectives`, the same rule with the export path's prose;
its object is a valid `options.target`). `test/objective-scope.test.js` pins the two to the
same answer, case for case.

**`options.target`** is used **verbatim**: `measuredNumbers()` never re-resolves it and
never falls back to the workspace number behind the caller's back. It decides only *which*
number a measured value is compared with — it can never make a claim more certain. What
counts as measured is untouched by it; a declared or unmeasured number stays exactly that
beside an approved service target, and `none` means every verdict is `'unknown'` and
`isAchievement` is `false`.

On the override path `target` also carries `level`, `owner`, `source` and `none`, so a
renderer can say whose number it used without asking a second question. **Without an
override the shape is unchanged** — every unscoped consumer, and every serialized AI
context, sees exactly what it always has.

Three warnings are scope-aware as a result: *"RTO/RPO are not approved by the business"*
now names the owner (and does not fire at all beside an approved service objective — it was
reading the workspace's approval flag about a number the workspace does not own); a scope
with none of its own says so; and an unreconciled conflict is stated.

`verdict.why` gains a closing sentence naming whose objective was used whenever it was not
the workspace's.

### "Covers" — the exposed definition

`coverageOf(test, componentId, options) -> 'direct' | 'scoped' | 'runbook-step' | 'closure' | 'runbook' | 'none'`

| value | when | measured-eligible |
|---|---|---|
| `direct` | the test **names the subject itself**: an `appTests[]` entry with `componentId === subject`, or `test.componentIds` / `test.componentId` includes it. Written by the person who ran the test, so it asserts "we exercised this component" — an observation. For the **workspace** subject: the test named **no** components (a whole-estate exercise) or named **every** component in the critical set (below). | **yes** |
| `scoped` | **workspace subject only.** The test named components, and they are not the workspace's critical set. Real evidence — about those components. | no |
| `runbook-step` | a step (or rollback step) of the test's `runbookId` runbook lists the component. This is authoring metadata about a *procedure*, not an observation about a *run*: the step may be skipped or gated out, no per-step outcome is recorded, and the deployment-order generator writes these by machine for nearly every component. | no |
| `closure` | the test names some component in the subject's dependency closure, but not the subject | no |
| `runbook` | the test merely shares a runbook with the subject (runbook linked / touches the closure), no step names the subject | no |
| `none` | no relationship | no |

### The workspace subject — what a workspace number is a claim about (audit NEW-2)

This contract used to end one subject short. For the workspace it said *"every
test is `direct`: a workspace-level RTA is a workspace-level claim"*, which
inverted the reasoning the rest of the file rests on. **A test is a claim about
what it exercised**, and the workspace is not something you can exercise — it is
the set of components. So one honest test record (a passed drill that restored a
Tier-3 log bucket, `componentIds: ["cmp_logs"]`, RTA 5 min) produced
`RTA measured 5 min · Inside the RTO target` on the board-facing executive
summary of a workspace whose **Tier-0 Payments API had never been tested**,
together with *"No actions fall out of the current data"* — while the Payments
API's own page correctly refused the same number. The truthful surface was the
one an engineer opens; the false one was the one that goes in the board pack.

**The rule.**

1. A test that **names no components** is a whole-estate exercise. Nothing
   narrows the claim, so it covers the workspace (`direct`).
2. A test that **names components** covers the workspace only if the named set
   includes every component in the **critical set**.
3. Anything else is `scoped` — evidence, reported with the subject it is
   evidence *for*, never a workspace-level measurement.

**The critical set** (`criticalSet(components)`, exported from
`web/js/coverage.js`) is the in-scope components at the **most critical tier the
workspace actually has**: Tier 0 where there is one, otherwise the lowest tier
recorded. Components explicitly `inRecoveryScope: 'no'` are excluded — nobody is
claiming they come back. `partial` and `unknown` are *included*: an undecided
scope is not a decision to abandon it. When no component carries a tier the set
is `known: false`, and a test that names components is `scoped` — **not knowing
what matters is not proof that it was covered.**

Why this rule and not the alternatives:

- *Weight coverage by tier/scope/L6 and produce a discounted number.* Rejected.
  A weighted RTA is a new number nobody measured, and the contract's whole
  premise is that a number either came from a passed test of the subject or it
  did not. There is no honest way to average "5 minutes for a log bucket" into a
  workspace figure.
- *Keep the number and add a `scopeNote`.* Rejected as the primary mechanism:
  the exec summary, the workbook cover and the AI context all read the **state**,
  and a caveat beside a green "measured · inside target" is the pattern this
  product exists to stop. The naming is kept — as `scope.measuredFor`, beside a
  number that is honestly `unmeasured` — so nothing is lost but the claim.
- *Refuse unless a Tier-0 component was covered.* This is what is implemented,
  generalised so a workspace whose most critical thing is Tier 1 still has a
  most critical thing.

Passing `options.components` is therefore load-bearing at workspace level. Every
server caller does (`service.js`, `assessment.js`, `recommend.js`, `xlsx-gen.js`,
`ai-bridge.js`), and the browser pages pass `snap.components`. **Without it the
rule under-claims rather than over-claims**: a test that names components cannot
be shown to cover the critical set, so it is `scoped`. That direction is
deliberate — the failure being fixed is a claim broader than its evidence.

The consequence, stated plainly: refusing the workspace claim never destroys the
evidence. The component the test named keeps its measured number, with its
provenance, on its own page. `unmeasured` at workspace level is a statement
about the estate, not about the test.

#### `scope` — the additive block this produces

```js
scope: {
  kind: 'workspace' | 'component',
  rule: string,                  // one sentence, safe to print
  criticalKnown: boolean,        // false ⇒ nothing is tiered; the claim cannot be checked
  criticalTier: number|null,     // 0 where there is a Tier 0
  critical: [ { id, name, tier, testedBy: {id,name,date,status,covers}|null } ],
  untestedCritical: [ { id, name, tier } ],   // never quote a workspace number while this is non-empty
  claimAllowed: boolean,
  measuredFor: { ids, names, label } | null,  // what the measured number IS evidence for
}
```

`testedBy` counts a passed test that names the component **or** one that names
nothing at all (a whole-estate exercise speaks for every component in it).

**Consumers must not go quiet while `untestedCritical` is non-empty.**
`xlsx-gen.js:execModel` raises the next action *"Run a recovery test that covers
&lt;names&gt;"* directly under the blockers, so the executive summary and the workbook
can no longer print *"No actions fall out of the current data"* while a Tier-0
service has never been in a passing test. The AI context carries the same block,
and `MEASURED_LEGEND` tells the model never to present a workspace number as
evidence for anything named there.

Two extra guards on an otherwise-`direct` passed test:

1. **Per-component contradiction.** If the test's `appTests[]` entry for the subject has
   `result === 'fail'`, the number is **not** measured for that subject (state
   `unmeasured`, warning emitted) — a green overall test does not make a red component test green.
2. **`cleanRun: false`.** Still measured (the bar was reached), but `test.cleanRun === false`
   is surfaced in `note` and in `warnings`: a run that needed undocumented manual
   intervention is not a reproducible capability.

RTA and RPA are selected **independently**: each takes the most recent qualifying test
that carries a non-null value for *that* metric, so the two may come from different tests
and each carries its own provenance.

### Return shape

```js
{
  subject: { kind: 'component'|'workspace', componentId: string|null, name: string },
  scope:   { ...the block above... },   // what this number is a claim ABOUT

  rta: {
    minutes: number|null,
    state: 'measured'|'declared'|'unmeasured',
    source: 'test'|'typed'|null,
    test: { id, name, date, status, covers, cleanRun } | null,   // null ⇒ never render as evidence
    staleDays: number|null,        // whole days between test date and `now`
    stale: boolean,                // staleDays > threshold
    isAchievement: boolean,        // verdict === 'met' AND NOT stale AND test.cleanRun !== false.
                                   // The ONLY flag that licenses "achieved" / "currently meets".
                                   // A caveated number keeps state 'measured' and keeps its value —
                                   // it just stops being a claim about the present (NEW-10).
    label: string,                 // 'measured' | 'declared (typed, not measured)' | 'unmeasured'
    note: string,                  // one plain sentence, always safe to print verbatim
  },
  rpa: { ...identical shape... },

  target: {
    rtoMinutes: number|null,          // business RTO — the workspace's, or options.target's
    rpoMinutes: number|null,          // business RPO — same  <-- verdicts judge THIS
    approved: boolean,
    mechanismRpoMinutes: number|null, // component replication capability — engineering detail ONLY
    rpoSource: 'business',            // constant; the business objective is always what a verdict uses
    // ONLY on the options.target path (see "Whose objective" above):
    level, owner, source, none,       // whose commitment this is; none ⇒ no target, no verdict
  },

  verdict: {
    rto: 'met'|'missed'|'unknown',     // the pure numeric comparison, always
    rpo: 'met'|'missed'|'unknown',     // (staleness/cleanliness never move these)
    overall: 'met'|'met-with-caveats'|'missed'|'partial'|'unknown',
    why: string,
  },

  evidence: {
    staleAfterDays: number,
    consideredTests: number,     // tests examined
    qualifyingTests: number,     // passed AND direct
    lastPassedTest: { id, name, date, status, covers, cleanRun } | null,
    lastAttempt:    { id, name, date, status, covers, cleanRun, rtaMinutes, rpaMinutes } | null,
                                 // newest passed OR failed covering test — for "last test" UI, never for a claim
  },

  warnings: [ string, ... ],
}
```

### Verdict rules (audit item 9)

- `verdict.rto` is `'unknown'` unless `rta.state === 'measured'` **and**
  `target.rtoMinutes` is a number. Then `'met'` if `rta.minutes <= rtoMinutes`, else `'missed'`.
- `verdict.rpo` is the same against **`target.rpoMinutes` — the business RPO**. The
  component's `replication.rpoMinutes` is a *mechanism capability* and is reported only as
  `target.mechanismRpoMinutes`; it never decides a verdict.
- `verdict.overall`:
  - `'met'` — **both** `rto` and `rpo` are `'met'` (was: either ⇒ met. That was the bug.)
    **and** neither number is caveated (see below).
  - `'met-with-caveats'` — both are `'met'`, and the evidence behind at least one of
    them is **stale** or came from a run with **`cleanRun: false`**. Both numbers were
    inside target *on the day*; neither is a claim about what the system does *now*.
    A consumer testing for `'met'` must not match this, and a renderer must give it a
    caution treatment, never a green "currently meets" (validation NEW-10).
  - `'missed'` — either is `'missed'`
  - `'partial'` — one is `'met'`, the other `'unknown'`
  - `'unknown'` — both unknown

  The **per-metric** `rto` / `rpo` verdicts stay the pure numeric comparison: a caveat
  is a fact about the evidence, not about whether 12 ≤ 60. Consumers that tint from
  `verdict.rto` handle staleness themselves (`routes/assessment.js` already does).
- `why` names which objective is unmeasured, e.g.
  *"Recovery time met (47 ≤ 60 min) but data loss was never measured — cannot claim objectives met."*

### Staleness

`staleAfterDays` = `options.staleAfterDays` ?? `workspace.objectives.staleAfterDays` ??
`workspace.staleAfterDays` ?? **180**. Evidence past the threshold stays `state: 'measured'`
(it *was* measured) but sets `stale: true`, says so in `note`, and adds a warning. UIs should
render stale evidence in a caution treatment, not green.

### How to render (for the pages / workbook / AI context)

| `state` | allowed words | forbidden |
|---|---|---|
| `measured` (not stale, clean run) | "measured", "achieved", "met" — **only when `isAchievement`** | — |
| `measured` + `stale` | "measured <date> — evidence is N days old" | "currently meets", "achieved" |
| `measured` + `cleanRun: false` | "reached the bar on <date>, after manual intervention" | "currently meets", "achieved", "reproducible" |
| `declared` | "declared target", "typed in Settings — not measured", "unverified" | measured / achieved / met / any green tick |
| `unmeasured` | "unmeasured" | any number presented as a result |

`formatNumber(entry, { unit: 'min' })` returns a ready sentence, e.g.
`"47 min — declared (typed in Settings, not linked to any passed test)"`.

## The shared severity table (audit R-6)

`severityFor(rule, ctx = {}) -> 'blocker'|'high'|'medium'|'low'` is the **only** place a
severity is decided. `service.js:computeRisks()` and `recommend.js:detectGaps()` both call
it, so the same condition can no longer show two severities on two pages.

`ctx` keys read: `tier`, `scope`, `replicated`, `critical`, `count`, `hasFailoverBehavior`.
Canonical resolutions (the previously disagreeing ones are marked ✱):

| rule | severity |
|---|---|
| `service-out-of-scope` / `component-out-of-scope` ✱ | `no` → tier ≤ 0 **blocker**, tier 1 **high**, else **medium**; `partial`/`unknown` one step down |
| `unreplicated-secret` ✱ | `replicated: 'no'` → tier ≤ 0 **blocker**, else **high**; unknown → **high** / **medium** by tier |
| `missing-verification` ✱ | the subject service itself (`isRoot: true`) → **high**; a dependency → tier ≤ 0 **medium**, else **low** (firing high once per dependency is how a risk list becomes wallpaper) |
| `dangling-dependency` | **high** |
| `layer-inversion` | **high** |
| `quota-capacity-unverified` | tier ≤ 0 **high**, else **medium** |
| `irsa-oidc-trust` | **high** |
| `acm-cert-not-regional` | **high** (tier ≥ 2 → medium) |
| `kms-single-region-key` | **high** |
| `arn-pinned-to-primary` | **high** |
| `cutover-gate-unsound` | **high** — the gate exists and is populated but cannot do its job (every check advisory, or the approval placed before it). One step below `cutover-without-verification`, which is a missing capability rather than a wrong flag. |
| `stale-evidence` | **medium** (tier ≤ 0 → **high**) |
| `rpo-gap` (measured RPA > **business** RPO) | **blocker** |
| `replication-lag-exceeds-mechanism` (measured RPA > mechanism RPO, business RPO OK) | **medium** |
| `rta-gap` | **high** |
| `unverified-objective` (typed RTA/RPA with no passing test behind it) | **high** |
| `outbound-target-out-of-scope` | critical → **high**, else **medium**; a **low-confidence** target match is reported one step down, phrased as a possible match, and carries its alternatives |
| `runbook-without-rollback` | a rollback that names no returning action → **medium**; none at all → tier ≤ 1 **high**, else **medium** |
| `control-plane-dependency-in-failover-path` | tier ≤ 1 **high**, else **medium** |
| `scheduler-double-run` | tier ≤ 0 **high**, else **medium** |
| `cache-cold-start-load` | backing store out of scope → **low** (the scope rule is already saying something louder); else tier ≤ 0 **high**, tier 1 **medium**, else **low** |

**This table is a reading aid, not the contract.** `RISK_SEVERITY` is the full
map — 30 rules at the time of writing — and `severityFor()` is the only thing
that decides a severity. A rule that appears in the export and not here is the
table's bug, not the code's.

`BLOCKS_RECOVERY` is a deliberately small set: a rule belongs in it only if it
stops the recovery *itself*. `runbook-without-rollback` blocks the return trip,
`scheduler-double-run` corrupts data after recovery, and `cache-cold-start-load`
degrades it — none of them are in the set, because inflating it is how ranking
stops meaning anything.

## What counts as PROOF for a risk rule (audit NEW-3)

Six rules — `quota-capacity-unverified`, `irsa-oidc-trust`,
`acm-cert-not-regional`, `kms-single-region-key`, `scheduler-double-run`,
`cache-cold-start-load` — fire on the **absence of proof**. That made
`proofState()` in `server/routes/service.js` the second load-bearing predicate
in the product, and it was answering a different question from the one this file
argues for. It matched the concatenated text of **every runbook in the
workspace**, step titles included, with no check that anything had been
executed, gated, or attached to anything. A `draft` runbook linked to nothing,
whose single step had an empty `command`, an empty `verify` and an empty `pass`,
and whose *title* read *"Someday check vcpu quota and the oidc issuer url"*,
silenced both `quota-capacity-unverified` and `irsa-oidc-trust` — while the same
response still reported `no-runbook` for that service. The product asserted that
no runbook covers this service and that a runbook proves its quota question, in
one payload.

`buildProof()` now splits the index in two, and only the first half can satisfy
a rule:

| bucket | what goes in it |
|---|---|
| `proof.evidence` | an **executable** step — a `command`, or a `verify` **and** a `pass` — in a runbook that is **not a draft** and **is linked** to this service or its closure (the runbook, or one of its steps, names something in `closureIds`); a checklist item that is **ticked and records a `proof`**; a component `verification.command` |
| `proof.claimed` | everything else that merely says the words: draft or unattached runbooks, steps with nothing to run, unticked checklist items, items ticked with no proof, a `verification.pass` with no command |

`proofState(proof, re)` returns:

| state | meaning | silences the rule? |
|---|---|---|
| `verified` | something in `proof.evidence` matches | yes |
| `claimed` | only `proof.claimed` matches, or a checklist item is ticked with no proof | **no** — the finding stands, and says *"a runbook mentions this but nothing records that it was run"* |
| `listed-not-done` | a checklist item names it and is not ticked | **no** |
| `none` | nothing anywhere | **no** |

Every rule that consumed `proofState` reports the state in its `proofState`
extra, so a reader can tell "nobody has written this down" from "somebody wrote
it down and nobody ran it". `kms-single-region-key`'s "we cannot tell" branch
tested `=== 'none'`, meaning a single mention took the branch away; it now tests
`!== 'verified'`, and the break-glass exemption in
`control-plane-dependency-in-failover-path` likewise requires evidence rather
than the word.

This is the same argument `web/js/coverage.js` makes about test coverage, in the
other engine: **breadth generated by a machine, or asserted in prose, is not
evidence produced by a run.**

### Return paths (audit NEW-6)

`runbook-without-rollback` compares a forward hazard regex with a return-path
regex, and the two were maintained by hand and drifted: `TRAFFIC_MOVE_RE` knew
`shift traffic` and `RETURN_TRAFFIC_RE` did not know `shift … back`, so the rule
fired on a rollback step titled *"Shift traffic back to us-east-1"* — quoting
the step and then denying it said what it says. A false positive on the only
clean workspace anyone could build is how a risk list becomes wallpaper.

`namesReturnPath(text, explicitRe, forwardRe)` now accepts a return path either
way: the explicit list (extended with `shift … back`, `move … back`,
`return traffic`, `roll back the dns/traffic/record`), **or** the forward
vocabulary plus a reversing word (`REVERSE_QUALIFIER_RE`: back, reverse, revert,
undo, again, original, previous, primary region, old writer…). The two halves
can no longer drift: a verb added to a forward regex becomes a return verb the
moment someone writes "back" beside it. An end state with no verb ("traffic is
healthy in us-west-2") is still not a rollback, and a forward-only step is still
not a way home.

## Risk output shape (de-noising, additive)

`service.js` keeps `risks` and every existing key on a risk
(`rule, severity, title, detail, componentId, componentName`, plus the rule-specific extras).
Added, never renamed:

- `risks[].aggregated: boolean`, `risks[].count: number`, `risks[].items: [{componentId, componentName, note}]`
  — repeated same-rule findings collapse into ONE risk whose title carries the count and the list.
- `risks[].blocksRecovery: boolean` and `risks[].rank: number` — ranking is
  `severity → blocksRecovery → tier → title`.
- `risksAll` — every finding, uncollapsed and uncapped. Nothing is lost, it is only folded.
- `riskSummary` — `{ total, shown, collapsed, byRule: {rule: count}, bySeverity: {...} }`.
- `counts.risksAll`, `counts.risksShown` alongside the existing `counts.risks`.

Collapsing happens per `rule` once a rule has more than **3** findings; blockers are never
collapsed away and never capped.

## What changed in `posture` (`GET /api/w/:ws/service/:id`)

Every existing key is still present. Meanings that changed are called out:

| key | before | now |
|---|---|---|
| `posture.measured` | newest **passed or failed** test with numbers | **only** measured evidence (passed + direct). `null` when there is none — the seed's failed `tst_aug01` no longer appears here |
| `posture.rtoMet` / `rpoMet` | booleans from that test | `true`/`false` only from measured evidence, else `null` |
| `posture.verdict` | `'met'` when **either** objective passed | `'met'` only when **both** pass; adds `'partial'` |
| `posture.targetRpoMinutes` | component mechanism RPO, falling back to business | the **business** RPO |
| `posture.rpoSource` | `'component'`/`'workspace'` | `'business'` |

Also changed: **which tests appear in the response's `tests[]`**. That is the
same question as "does this test cover this service", so it is answered by
`coverageOf()` instead of a second local rule. The old filter read `appTests[]`
and the runbook link only, so a test naming the component in `componentIds` —
the shape `measuredNumbers` calls `direct` — was absent from the list, and the
payload could carry `no-test-coverage: high` beside *"RTA measured 22 min by a
test that directly covers this service"*. `tests[].covers` now carries the
shared vocabulary (so `runbook-step` can appear where `runbook` used to).

New (additive) keys:

- `posture.numbers` — the entire `measuredNumbers()` result. **Prefer this.**
- `posture.mechanismRpoMinutes` — the component's replication capability (engineering detail).
- `posture.verdictDetail` — `{ rto, rpo, overall, why }`.
- `posture.lastAttempt` — newest passed/failed covering test with its numbers, explicitly
  **not** a claim; render as "last test" only.
- `posture.declared` — `{ rtaMinutes, rpaMinutes }` typed in Settings, so a page can show
  them labelled as declared without re-reading `workspace.objectives`.
- `posture.warnings` — string list, safe to print.

## Assessment (`GET /api/w/:ws/assessment/report`)

Additive keys: `completeness` (0–100), `incomplete` (boolean), `caps` (array of
`{reason, cappedTo}` explaining every evidence cap applied), `numbers` (workspace-level
`measuredNumbers()` result). Existing keys (`pillars`, `level`, `levelLabel`,
`overallScore`, `answeredTotal`, `questionCount`, `signals`, `nextActions`) all remain.

Behaviour changes: pillar scores divide by **`questionCount`**, not `answeredCount`
(each pillar also reports `answeredScore`, the old number, as a ceiling — never as the
score); evidence caps require a **recent** passed test; the "Last achieved RTA" signal is
now sourced from `measuredNumbers()` and reads *declared* or *unmeasured* when it is.

Three questions added; every existing id is unchanged (answers are keyed by id, so ids are
only ever added):

| id | pillar | subject |
|---|---|---|
| `rbk-failback` | runbooks | the return trip — untested failback is a one-way door |
| `rbk-controlplane` | runbooks | could you execute the failover with the primary region *and* your SSO dark? |
| `inv-capacity` | inventory | will the recovery region actually sell you the compute? |

`QUESTIONS.length` is now **21**; pillars no longer hold equal counts (runbooks 5,
inventory 4, the rest 3), which is fine because `overallScore` is the mean of the pillar
percentages. Read the count from the API, never hard-code 18.

## Recommend (`POST /api/w/:ws/recommend`)

`gapsDetected[]` entries keep `title`, `severity`, `componentId`, `why`, and gain `rule`.
The array is now sorted by severity. Severities come from `severityFor()`, so a Tier-0
component out of recovery scope is a **blocker** here and a **blocker** on the service
profile — it used to be `high` in one and `blocker` in the other (audit R-6). A new gap
`unverified-objective` fires when `objectives.rtaMinutes`/`rpaMinutes` are typed but no
passed test backs them, and `stale-evidence` when the measured numbers are past the
threshold. Additive: `gapSummary` (`{total, byRule, bySeverity}`) and `numbers` (the
workspace-level `measuredNumbers()` result).

`strategy.fit` is judged against **targets only** — it answers "could this strategy
plausibly support your objectives", and deliberately does not reason from RTA/RPA at all.

## Worked example — the shipped seed

`example-acme` / `cmp_adjudication`. `tst_aug01` is `status: 'failed'` with a blocker
finding and `results.rtaMinutes: 47`; `workspace.objectives.rtaMinutes` is `47`.

Verbatim from `GET /api/w/example-acme/service/cmp_adjudication` → `posture.numbers`:

```js
rta: { minutes: 47, state: 'declared', source: 'typed', test: null,
       isAchievement: false,
       note: 'Typed in Settings. No passed test has measured a recovery time for '
           + 'adjudication-service, so this number is not evidence.' }

verdict: { rto: 'unknown', rpo: 'unknown', overall: 'unknown',
           why: 'recovery time is declared but never measured; data loss is declared but '
              + 'never measured. Nothing measured, so there is nothing to judge against '
              + 'the objectives.' }

warnings: [ 'The newest test covering adjudication-service (Dev recovery test #2 — August, '
          + '2026-08-28) FAILED with a blocker finding ("Two adjudication secrets missing in '
          + 'us-east-2 — secrets-init crash loop killed the claim path") — a failed run has no '
          + 'RTA, only a time to failure. Its numbers are not evidence and must never be '
          + 'labelled measured, achieved or met.', ... ]

posture.measured: null   posture.rtoMet: null
posture.rpoSource: 'business'   posture.targetRpoMinutes: 30   posture.mechanismRpoMinutes: null
```

Nothing anywhere may print "47 min · measured", "Achieved" or a green tick for this workspace.

## Worked example — a workspace number that is not the workspace's

`lie-test`: RTO 60 / RPO 30, approved. Two components — `cmp_tier0` "Payments
API" (Tier 0, in scope) and `cmp_logs` "Log archive bucket" (Tier 3, in scope).
One honest test record: `status: 'passed'`, `cleanRun: true`,
`componentIds: ['cmp_logs']`, `results: { rtaMinutes: 5, rpaMinutes: 2 }`.

```js
coverageOf(tst_tiny, null, { components })  // -> 'scoped'
coverageOf(tst_tiny, 'cmp_logs')            // -> 'direct'

// workspace subject
rta: { minutes: null, state: 'unmeasured', isAchievement: false,
       note: 'No passed test has measured a recovery time for lie-test. S3 log bucket restore '
           + 'drill (2026-09-10) passed and recorded 5 min, but it covered Log archive bucket — '
           + 'that is a measurement of Log archive bucket, not of lie-test. Payments API (Tier 0) '
           + 'has never been covered by a passed test.' }
verdict: { rto: 'unknown', rpo: 'unknown', overall: 'unknown' }
scope.untestedCritical: [ { id: 'cmp_tier0', name: 'Payments API', tier: 0 } ]

// component subject — the evidence is not destroyed, it is placed
measuredNumbers(ws, tests, 'cmp_logs').rta  // -> { minutes: 5, state: 'measured', ... }
```

`GET /export/executive-summary.md` renders
`| RTA **unmeasured** | **not measured yet** | …that note… |` and a next action
*"Run a recovery test that covers Payments API"*. A workspace whose passed test
names every in-scope Tier-0 component, or names none at all, is unaffected: it
still reads `RTA measured 22 min … Inside the RTO target`.
