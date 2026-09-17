# Changelog

All notable changes to DR Compass are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, minor releases may change schemas and API shapes;
workspace JSON is forward-compatible (unknown fields are preserved, missing fields
degrade to a safe default).

## [Unreleased]

### Added

- `CHANGELOG.md` (this file).
- `docs/examples/` — real artifacts exported from the bundled `example-acme`
  workspace (executive summary, Mermaid sources, draw.io XML, a rendering of the
  workbook's 10 sheets), so the README can show what the tool produces without
  inventing screenshots.

### Changed

- `SPEC.md` rewritten against the shipped code: the full route table, the object
  files that are not collections (`resource-graph`, `k8s`, `layouts`,
  `discovery-jobs`), and the subsystems added since v0.2.0 (service profile,
  deployment order, background jobs, measured numbers, network flows, AI action
  layer, saved layouts).
- `docs/getting-started.md`, `docs/integrations.md` and `docs/dr-program-guide.md`
  reconciled with the current navigation, endpoints and integration behaviour.
- README restructured around what the tool assumes, produces and refuses to do.

## [0.4.0] — 2026-09-17

The integrity release: a number is evidence only when a passed test produced it.

### Added

- `server/lib/measured.js` — the single source of truth for every RTA/RPA number
  the product renders, and for the severity of every risk finding. Contract:
  [`docs/measured-numbers.md`](docs/measured-numbers.md).
- Explicit test **coverage** rules: a test measures a subject only when it names
  it in `appTests[]`, in `componentIds`, or in a step of its linked runbook.
  Sharing a runbook with a sibling component does not count.
- Evidence ageing: measured numbers older than `staleAfterDays` (default 180)
  stay measured but are flagged stale.
- New risk rules for failure modes that actually cause regional outages:
  recovery-region quota/capacity headroom, IRSA/OIDC trust on a recovered
  cluster, regional ACM certificates, single-region KMS keys, ARNs pinned to the
  primary region, layer inversion, stale evidence, and dangling `dependsOn` ids.
  Each fires on evidence of a check — a runbook step, a checklist proof, a verify
  command — never on prose.
- Three assessment questions, including failback (previously absent) and whether
  the failover could be executed with the primary region *and* SSO both dark.
  `questionCount` is now 21 — read it from the API rather than hard-coding it.
- `risksAll`, `riskSummary`, `posture.numbers`, `posture.verdictDetail`,
  `posture.lastAttempt`, `posture.declared`, and assessment `completeness` /
  `caps` / `numbers` — all additive.

### Fixed

- The dashboard, executive summary, workbook and AI context presented a
  hand-typed `objectives.rtaMinutes` as a measured, "achieved" result — the
  number came from a test recorded as **failed**. Typed numbers now read
  "recorded by hand, not from a test" in neutral styling, everywhere.
- `verdict.overall` fired `met` when *either* RTO or RPO passed; it now requires
  both, and adds `partial`.
- RPO verdicts were judged against the component's replication mechanism rather
  than the business objective, so a mechanism claiming 1 minute against a
  30-minute business RPO raised a blocker while a mechanism claiming 240 against
  a 15-minute RPO was never reported.
- Assessment scores divided by *answered* questions, so six good answers out of
  eighteen yielded level 4. They now divide by the total, cap below 80 %
  completeness, and require recent evidence.
- Risk lists were wallpaper: repeated findings of the same rule now collapse into
  one ranked row (blockers are never folded), with the full set kept in
  `risksAll`.

### Changed

- The example workspace is vendor-neutral: 14 third-party-tool mechanisms became
  2, replaced by Aurora Global Database, S3 CRR, ECR replication, Secrets Manager
  replicas, AWS Backup copy and IaC rebuild. The two that remain are a deliberate
  teaching contrast. Arpio, ARC Region Switch, Elastic DR and GitOps read as peer
  options throughout the docs.
- The Tests page's copy-to-objectives action is disabled for any run that did not
  pass, and when it does fire it writes the test's identity alongside the digits.

## [0.3.0] — 2026-09-16

Deployment order, a rebuilt workbook, and a safety pass over the runbook guidance.

### Added

- **Deployment / recovery order engine** — works out what has to come back in
  what order and says why: a 14-tier ladder mapped onto L0–L7, a DAG built from
  declared dependencies, discovered graph edges read directionally, and type
  rules that act as a soft floor. Output is waves that can be built in parallel
  with a plain-language reason on every item (15 waves / 137 items on the example
  workspace). Contract: [`docs/deployment-order.md`](docs/deployment-order.md).
- Pod startup modelled properly: a workload's wave is
  `max(everything it mounts, pulls and calls at startup) + 1` — ServiceAccount
  and the OIDC/IRSA chain, every Secret and ConfigMap, PVCs and their storage
  class, the image registry, and every startup outbound call. Outbound calls are
  classified **startup** vs **runtime**; a service that starts before something
  it calls at startup is flagged as a blocker.
- Security groups split into create-then-apply-rules; fencing the old primary
  modelled as an ordering edge; third parties treated as preconditions to verify
  rather than things to deploy; backends require *Ready*, not merely created.
  Cycles are reported with a suggested break, never silently cut.
- New diagrams: `deploy-order` (wave bands), `deploy-order-<componentId>`, and
  `startup-dependencies-<componentId>`.
- Runbooks can be generated from the order, and an existing runbook can be
  checked *against* it — it reports steps that restore something before its
  prerequisites.

### Changed

- Workbook rebuilt from 18 thin sheets to 10 rich ones on one shared 11-column
  grid, with teaching title rows, freeze at A3, continuous zebra, derived status
  dropdowns and a Resource Graph tree nested six levels deep on real
  relationships. Outbound calls get their own audit sheet.
- UI subtraction pass: 270 fewer rendered elements, 127 fewer badges, 35 fewer
  table columns, 21 % less prose — with all 64 API calls unchanged. Pages with
  exactly one primary action went from 4/12 to 12/12.
- `onboarding.js` is the single source of truth for "where am I".

### Fixed

- **Safety.** A senior-DR-architect audit ([`docs/DR-VALIDATION.md`](docs/DR-VALIDATION.md))
  found guidance an operator could have followed at 3 a.m. and made an outage
  worse. The game-day emergency rollback flipped DNS back to a fenced primary
  with a demoted database; it now establishes which side is authoritative for
  writes, tests it, and branches. Region Switch never fenced the old primary
  before promotion and conflated switchover with failover; there is now an
  explicit fencing gate with different procedures per path.
- Traffic moved before the business transaction was proven. The order is now L5
  reachability → L6 via a direct endpoint with a `Host` header and no DNS change
  → approval → L7 cutover, and the recommender can no longer produce the
  inversion at all.
- ARC Region Switch has no practice mode and no `--mode failover`; the real
  values are `graceful` and `ungraceful`. Corrected everywhere.
- The Arpio runbook template told operators to turn isolated networking **off** —
  the control that stops a drill POSTing a real claim to a partner. It now stays
  on, with VPC endpoints as the egress fix. Its secrets gate used
  `describe-secret`, which proves neither the value nor KMS decrypt nor that the
  app's identity can read it; it now runs `get-secret-value` as the workload's
  own identity.
- Aurora Global Database supports 10 secondary regions, not 5 (the limit changed
  in May 2025). AWS Backup does not support ElastiCache — caches are routed to
  Global Datastore or their own snapshots. SQS and Kinesis no longer draft
  "promote/restore" steps, because neither has cross-region replication.
- The runbook generator overwrote every step's verify/pass with a generic string,
  destroying the L6 pass criterion.
- The new deploy-order page was not registered in `PAGES`, so every link to it
  silently fell back to Overview.

## [0.2.0] — 2026-09-16

Discovery grew up: dependency mapping, Kubernetes, network flows, background jobs
and an AI copilot.

### Added

- **AI copilot** — `Cmd/Ctrl+K` on every page. The local Claude Code CLI proposes
  create/update/delete operations against workspace data; each is validated
  server-side and applied only after per-operation approval. 17 contextual
  actions (fill in what is missing, infer dependencies, draft a verification
  command, review this runbook, write the test record, turn findings into gaps).
- **Icon canvas** — 99 curated official icons (AWS Architecture Icons, the
  Kubernetes community set, CNCF artwork) with a manifest mapping every component
  kind, service and category; credits in [`ICON-CREDITS.md`](ICON-CREDITS.md).
  Draggable cards with live edge re-routing, pan/zoom, snap-to-grid, focus-mode
  dimming, three deterministic auto-layout templates, and per-diagram saved
  layouts with a reset to the pristine layout.
- **Kubernetes discovery** — read-only `kubectl` scan behind a strict
  `get -o json` allowlist, plus a downloadable snapshot script and artifact
  upload for locked-down clusters. Secret and ConfigMap **names only**. New
  `k8s-cluster` and per-namespace diagrams.
- **Deep AWS resource enrichment** — per-component association walkers (ELB
  listeners/target groups/health/SGs/subnets/AZs, EKS nodegroups/OIDC/add-ons,
  RDS subnet and parameter groups/KMS, Lambda, SQS, S3, API Gateway, Secrets
  Manager, Route 53) merged into a per-workspace resource graph, and a resource
  detail drawer on any diagram node.
- **Scan & map** — one pass returns each discovered resource *with* its
  association tree and cross-resource dependency links; checking a proposal
  auto-selects its dependency closure. A downloadable read-only discovery script
  and artifact upload replay the same collectors on credential-less machines.
- **Network flows import** — a Discover tab that ingests a firewall/flow-log CSV
  **in the browser**, auto-detects columns, aggregates and classifies
  destinations, matches pod sources to components, and writes outbound calls plus
  graph edges with provenance.
- **Background discovery jobs** — all six discovery operations run as jobs with
  streamed progress, heartbeats and per-workspace persisted results. The UI
  re-attaches to running jobs on reload; sync endpoints are unchanged and the UI
  falls back to them when the jobs route is absent.
- **AWS SSO / aws-vault authentication** — the profile picker merges
  `~/.aws/config` and `aws-vault` profiles; a `sts get-caller-identity`
  pre-flight runs before every heavy action; an expired session offers an
  Authenticate button that launches `aws sso login`, polls, then auto-starts the
  action that was originally requested.
- **Service DR profile** — one page per service: what it needs to come back
  ordered L0→L7 with weak links flagged, what it is attached to, who it talks to,
  how it is recovered, what is in the way, its diagram inline, and a scoped DR
  package.
- **DR Package export** — a one-click zip (cover README, scoped workbook,
  diagrams as SVG + draw.io + Mermaid, runbooks, CSVs, manifest) from a minimal
  in-repo zip writer, plus a standalone diagram pack. Every export accepts
  `?componentId=` and covers that service plus its full dependency closure.
- Lucidchart-safe Mermaid flavour (`?flavor=lucid`) and a draw.io export
  (`?style=aws`) that emits `mxgraph.aws4` shape styles.
- AI correlation: the local `claude` CLI proposes links between unlinked
  resources / Kubernetes workloads and components, reviewed with confidence
  scores before applying.

### Changed

- Workflow-based navigation with live state, a "Start here" path that collapses
  as the program matures, a plain-language glossary with hover definitions, real
  `:focus-visible` styles (keyboard users previously had **no** focus
  indicator), a skip link, landmarks and route announcements.
- Diagram layout replaced with a real Sugiyama implementation (rank tightening,
  dummy nodes, 8-sweep crossing reduction, isotonic coordinate assignment):
  dependency-graph crossings 96 → 41, resource map 483 → 302. Plus
  obstacle-aware routing, parallel-edge bundling, hub detection and zoom-aware
  typography.
- Excel workbook redesigned as a hand-crafted tracker: merged titles, a coloured
  header bar, freeze at A3, zebra striping, collapsible row outlines, dropdown
  validations and conditional tints on status cells only.
- Discovery leads with "how do you want to find your resources?" instead of a
  wall of tabs, with a persistent status strip and advanced options behind
  disclosures.
- Arpio API keys are an ID + secret pair sent as `X-Api-Key: <keyId>:<secret>`;
  the Arpio resource walk is shape-agnostic with a structure-only diagnostic
  trace, and thousands of `k8sResource` rows group into one proposal per
  cluster/namespace.
- Mermaid limits raised to 1 MB / 10 000 edges; oversized diagrams now warn and
  point at the icon canvas instead of erroring.

### Fixed

- A failed feature router used to swallow every later `/api` route; the 501
  fallback is now scoped to paths naming that feature.
- `Download SVG` wrote the literal string `object Promise`.
- Print setup silently never applied (`fitToPage` was `false`).
- Resource-map generation seeds from `componentIds` membership, so all 13
  per-component maps generate (was 7).
- Canvas pages leaked their engine on navigation; there is now a teardown hook.

## [0.1.0] — 2026-09-15

Initial release. A local-first DR planning studio: inventory with
dependency / outbound-call / secret tracking, a maturity assessment,
auto-generated Mermaid and draw.io diagrams, a runbook builder (Arpio, ARC
Region Switch, GitOps/IaC, Elastic DR, game day), a test and checklist program
with measured RTA/RPA, Excel/CSV exports, and AWS / Arpio / AI discovery —
served as a web UI on localhost by the `drcompass` CLI.

[Unreleased]: https://github.com/jonehb11/drcompass/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jonehb11/drcompass/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jonehb11/drcompass/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jonehb11/drcompass/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jonehb11/drcompass/releases/tag/v0.1.0
