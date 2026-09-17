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

Pure function. No I/O, no store access, no throw on malformed input (missing/odd
fields degrade to `unmeasured` with a warning).

### "Covers" — the exposed definition

`coverageOf(test, componentId, options) -> 'direct' | 'closure' | 'runbook' | 'none'`

| value | when | measured-eligible |
|---|---|---|
| `direct` | the test **names the subject itself**: an `appTests[]` entry with `componentId === subject`, or `test.componentIds` / `test.componentId` includes it. Written by the person who ran the test, so it asserts "we exercised this component" — an observation. | **yes** |
| `runbook-step` | a step (or rollback step) of the test's `runbookId` runbook lists the component. This is authoring metadata about a *procedure*, not an observation about a *run*: the step may be skipped or gated out, no per-step outcome is recorded, and the deployment-order generator writes these by machine for nearly every component. | no |
| `closure` | the test names some component in the subject's dependency closure, but not the subject | no |
| `runbook` | the test merely shares a runbook with the subject (runbook linked / touches the closure), no step names the subject | no |
| `none` | no relationship | no |

For the **workspace** subject (`componentId === null`) every test is `direct` — a
workspace-level RTA is a workspace-level claim.

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

  rta: {
    minutes: number|null,
    state: 'measured'|'declared'|'unmeasured',
    source: 'test'|'typed'|null,
    test: { id, name, date, status, covers, cleanRun } | null,   // null ⇒ never render as evidence
    staleDays: number|null,        // whole days between test date and `now`
    stale: boolean,                // staleDays > threshold
    isAchievement: boolean,        // measured AND this metric's verdict === 'met'
    label: string,                 // 'measured' | 'declared (typed, not measured)' | 'unmeasured'
    note: string,                  // one plain sentence, always safe to print verbatim
  },
  rpa: { ...identical shape... },

  target: {
    rtoMinutes: number|null,          // business RTO (workspace objectives)
    rpoMinutes: number|null,          // business RPO (workspace objectives)  <-- verdicts judge THIS
    approved: boolean,
    mechanismRpoMinutes: number|null, // component replication capability — engineering detail ONLY
    rpoSource: 'business',            // constant; the business objective is always what a verdict uses
  },

  verdict: {
    rto: 'met'|'missed'|'unknown',
    rpo: 'met'|'missed'|'unknown',
    overall: 'met'|'missed'|'partial'|'unknown',
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
  - `'missed'` — either is `'missed'`
  - `'partial'` — one is `'met'`, the other `'unknown'`
  - `'unknown'` — both unknown
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
| `measured` (not stale) | "measured", "achieved", "met" — **only when `isAchievement`** | — |
| `measured` + `stale` | "measured <date> — evidence is N days old" | "currently meets" |
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
