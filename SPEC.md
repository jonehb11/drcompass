# DR Compass — architecture spec

This is the contract a contributor reads first. It describes what the code
**does today** (v0.4.0), not what it was originally planned to do.

DR Compass is a local-first disaster-recovery planning program: a CLI
(`drcompass`) that serves a web UI on localhost, stores everything as plain JSON
in a workspace directory, and derives diagrams, a deployment order, an Excel
workbook, runbooks and checklists from that JSON on demand.

**Stack:** Node >= 18, no build step, Express, a vanilla ES-module SPA, ExcelJS,
Mermaid (vendored from `node_modules`, served at `/vendor/mermaid/`).
**No TypeScript. No bundler. No new npm dependencies** beyond the five in
`package.json` (`express`, `exceljs`, `commander`, `open`, `mermaid`).

Two subsystems have their own contract documents and are **not** duplicated here;
read them before changing anything they cover:

- [`docs/measured-numbers.md`](docs/measured-numbers.md) — the single source of
  truth for every RTA/RPA number the product renders and for the severity of
  every risk finding (`server/lib/measured.js`).
- [`docs/deployment-order.md`](docs/deployment-order.md) — how recovery order is
  computed and what it refuses to guess (`server/lib/deploy-order.js`).

---

## 1. Layout

```
bin/drcompass.js              CLI (start | init | list | export)
server/index.js               createServer() — mounts every router
server/store.js               workspace JSON storage

server/routes/workspace.js    workspace meta CRUD                 (always mounted)
server/routes/collections.js  generic collection CRUD             (always mounted)
server/routes/knowledge.js    serves server/data/knowledge/*.md   (always mounted)
server/routes/assessment.js   maturity assessment + report
server/routes/diagrams.js     diagram list, mermaid, drawio, canvas
server/routes/exports.js      xlsx / csv / markdown / bundle
server/routes/discover.js     AWS discovery, auth, script, upload, Arpio
server/routes/recommend.js    strategy recommender + templates
server/routes/ai.js           Claude Code CLI bridge (propose/apply/…)
server/routes/layouts.js      saved icon-canvas layouts
server/routes/k8s.js          Kubernetes snapshot capture & storage
server/routes/resources.js    resource graph read + enrichment
server/routes/jobs.js         background discovery jobs
server/routes/network.js      firewall / flow-log import
server/routes/service.js      the service DR profile (risks, closure, posture)
server/routes/deploy-order.js deployment order, explain, to-runbook

server/lib/measured.js        RTA/RPA + severity contract  → docs/measured-numbers.md
server/lib/deploy-order.js    ordering engine              → docs/deployment-order.md
server/lib/diagram-gen.js     mermaid + drawio + canvas models
server/lib/xlsx-gen.js        the 10-sheet workbook, CSV datasets, exec summary
server/lib/aws-discovery.js   aws CLI enumeration + the handed-out shell script
server/lib/aws-scan-map.js    scan-and-map (resources + their association tree)
server/lib/aws-enrich.js      per-service association walkers
server/lib/k8s-discovery.js   kubectl snapshot + snapshot script + autolink
server/lib/network-flows.js   flow parsing, classification, source matching
server/lib/arpio-client.js    Arpio tenant API client
server/lib/ai-bridge.js       claude CLI invocation, context building, validation
server/lib/jobs.js            background-job engine

server/data/knowledge/*.md    Learn articles (16)
server/data/templates/*.json  runbooks.json, checklists.json, app-tests.json
server/data/strategy-catalog.json
server/data/seed/*.json       the example-acme workspace

web/index.html web/css/app.css               app shell (nav is hard-coded here)
web/js/app.js api.js ui.js onboarding.js     router, api client, ui helpers, journey state
web/js/assistant.js ai-actions.js            AI copilot drawer + contextual AI actions
web/js/diagram-layout.js diagram-canvas.js   pure layout engine + the icon canvas
web/js/measured.js resource-panel.js zip.js  number rendering, node drawer, client-side zip
web/js/pages/*.js                            one module per page (13)
web/assets/icons/**                          99 curated icons (see ICON-CREDITS.md)

CHANGELOG.md README.md CONTRIBUTING.md SPEC.md docs/ Formula/
```

`server/index.js` mounts the first three routers directly and every other router
through `mountOptional()`: an import failure logs and installs a **feature-scoped**
501 fallback rather than taking the app down or swallowing later `/api` routes.
A UI that depends on an optional router must therefore degrade, not crash — see
the Runbooks page, which hides its deploy-order buttons until a probe succeeds.

---

## 2. Workspace storage

Workspaces live in `~/.drcompass/workspaces/<slug>/` (override: `DRCOMPASS_HOME`
env, or `drcompass start --dir <path>`). Slugs match
`/^[a-z0-9][a-z0-9-_]{0,63}$/i`. Each workspace is a folder of JSON files —
diff-able and git-versionable by design.

**Collections** (`server/store.js` `COLLECTIONS`), each a `{ "items": [...] }` file:

`components` · `runbooks` · `tests` · `checklists` · `gaps` · `decisions` · `contacts`

**Objects**, each a bare JSON object in its own file:

| file | written by | contents |
| --- | --- | --- |
| `workspace.json` | `workspace.js` | meta (regions, objectives, strategy, tooling) |
| `assessment.json` | `assessment.js` | `{ answers: {questionId: 0-4}, completedAt }` |
| `resource-graph.json` | `resources.js`, `discover.js`, `network.js` | discovered AWS resources + edges |
| `k8s.json` | `k8s.js` | the Kubernetes snapshot |
| `layouts.json` | `layouts.js` | per-diagram canvas positions |
| `discovery-jobs.json` | `lib/jobs.js` | the last 15 finished background jobs |

`server/store.js` exports:

```js
COLLECTIONS                                  // the 7 names above
homeDir() / wsRoot()
listWorkspaces() -> [{slug, name, updatedAt}]
createWorkspace(slug, meta) ; deleteWorkspace(slug)
getWorkspace(slug) -> meta  ; saveWorkspace(slug, meta)   // merges, stamps updatedAt
getCollection(slug, name) -> items[] ; saveCollection(slug, name, items)
getObject(slug, name) ; saveObject(slug, name, obj)
newId(prefix) -> 'cmp_ab12cd34'
seedExample()                                // copies server/data/seed on first run
httpError(status, message)
```

Unknown fields are preserved on round-trip; missing fields must degrade to a
safe default rather than throw. Both are load-bearing: workspaces outlive
releases and people hand-edit them.

---

## 3. Schemas

### `workspace.json`

```json
{ "slug": "example-acme", "name": "Acme Pharmacy", "org": "Acme Health",
  "description": "...",
  "regions": { "primary": "us-east-1", "recovery": "us-east-2" },
  "objectives": { "rtoMinutes": 60, "rpoMinutes": 30,
                  "rtaMinutes": null, "rpaMinutes": null,
                  "approved": false, "staleAfterDays": 180, "notes": "" },
  "strategy": "pilot-light",
  "tooling": ["gitops-iac", "region-switch"],
  "createdAt": "ISO", "updatedAt": "ISO" }
```

`strategy`: `backup-restore | pilot-light | warm-standby | active-active`
`tooling[]`: `arpio | region-switch | arc-routing-controls | elastic-dr |
gitops-iac | resilience-hub | backup` — a **list of peers**, not a vendor choice.
It only decides which runbook templates and recommendations surface.

`objectives.rtoMinutes` / `rpoMinutes` are **targets**. `rtaMinutes` / `rpaMinutes`
are hand-typed notes and are **never** evidence; see `docs/measured-numbers.md`.

### Component — `components.json`

```json
{ "id": "cmp_x", "name": "adjudication-service", "category": "compute",
  "tier": 0, "owner": "", "team": "", "description": "",
  "kind": "eks-workload", "arn": "",
  "drStrategy": "inherit", "restoreLayer": "L4",
  "replication": { "mechanism": "aurora-global", "rpoMinutes": 1, "notes": "" },
  "inRecoveryScope": "yes", "definedIn": "terraform/services/adjudication",
  "dependsOn": ["cmp_aurora_adj"],
  "outboundCalls": [ { "target": "partner-clearinghouse", "type": "third-party",
      "protocol": "https", "port": 443, "purpose": "claim switch",
      "failoverBehavior": "manual-allowlist", "critical": true,
      "source": "network-flows", "observedCount": 812,
      "namespace": "", "workload": "" } ],
  "awsServices": ["EKS", "Secrets Manager", "SQS"],
  "secrets": [ { "name": "adjudication/db-password", "arn": "",
                 "replicated": "yes", "notes": "" } ],
  "endpoints": [ { "name": "api", "url": "", "healthCheck": "/healthz" } ],
  "verification": { "command": "kubectl get deploy ...", "pass": "Ready" },
  "gaps": ["Kinesis stream not in recovery scope"], "notes": "", "tags": [] }
```

`category` (canonical ids — use these everywhere, including the workbook and the
diagram grouping):
`compute | networking | storage | database | messaging-streaming |
security-secrets | edge-dns | identity-access | observability | third-party |
cicd-control-plane | other`

`restoreLayer` — the restore layer cake, ordered:
`L0` guardrails/backups green → `L1` recovery launch/replication → `L2` platform
(cluster, nodes, mesh) → `L3` data + secrets → `L4` applications → `L5`
edge/network reachability → `L6` functional success bar (a real business
transaction) → `L7` live traffic cutover.

`outboundCalls[].type`: `aws-service | third-party | saas | internal | on-prem`.
`source`/`observedCount`/`workload`/`namespace` are provenance written by the
network-flow importer; hand-entered calls omit them.
`inRecoveryScope`: `yes | no | partial | unknown` (`unknown` is a finding).
`replication.mechanism` is free text by design, but the seed and the UI use:
`aurora-global`, `dynamodb-global-tables`, `s3-crr`, `ecr-replication`,
`secrets-manager-replica`, `aws-backup-copy`, `multi-region-keys`, `iac`,
`iac-gitops`, `rebuild`, `none`, or a named third-party tool. A blank mechanism
on a stateful Tier-0 component is a gap, not a default.

### Runbook — `runbooks.json`

```json
{ "id": "rbk_x", "name": "Regional failover", "tooling": "gitops-iac",
  "scenario": "region-loss", "audience": "operator",
  "preconditions": ["Phase 0 checklist green"],
  "steps": [ { "id": "stp_1", "layer": "L1", "title": "Launch recovery",
      "detail": "...", "command": "", "verify": "", "pass": "",
      "owner": "", "estMinutes": 5, "record": "T0 timestamp",
      "componentIds": [], "gate": true } ],
  "rollback": [ ...same step shape... ],
  "linkedTestIds": [], "notes": "", "updatedAt": "ISO" }
```

`steps[].componentIds` is load-bearing beyond display: it is one of the three
ways a test can be said to **cover** a component (`docs/measured-numbers.md`),
and it is what `deploy-order` matches against when it attributes a step's
`estMinutes` to an ordered item.

### Test / exercise — `tests.json`

```json
{ "id": "tst_x", "name": "Dev recovery test #3", "type": "recovery-test",
  "status": "planned", "date": "2026-09-25",
  "runbookId": "rbk_x", "scope": "", "componentIds": [],
  "appTests": [ { "name": "claim adjudication returns claim_id",
      "command": "", "expected": "", "componentId": "",
      "critical": true, "result": "pass" } ],
  "timestamps": { "t0": null, "tFirstAccess": null, "t1": null },
  "results": { "rtaMinutes": null, "rpaMinutes": null, "cleanRun": false },
  "findings": [ { "title": "", "severity": "blocker", "gapId": "", "ticket": "" } ],
  "record": "markdown narrative", "updatedAt": "ISO" }
```

`type`: `recovery-test | game-day | tabletop | component-test | chaos`
`status`: `planned | in-progress | passed | failed | canceled`
`appTests[].result`: `pass | fail | ''`

**Only `status: 'passed'` produces evidence.** A failed run has a time to
failure, not an RTA. Everything downstream of this rule lives in
`server/lib/measured.js` — do not re-derive RTA/RPA anywhere else.

### Checklist — `checklists.json`

```json
{ "id": "chk_x", "name": "Phase 0 — before any launch", "kind": "phase0",
  "items": [ { "id": "itm_1", "text": "", "why": "", "proof": "",
               "owner": "", "done": false } ], "updatedAt": "ISO" }
```

`kind`: `phase0 | preflight | game-day | weekly | custom`

### Gap / Decision / Contact

```json
{ "id": "gap_x", "title": "", "category": "security-secrets",
  "class": "missing-dependency", "severity": "blocker|high|medium|low",
  "componentId": "", "status": "open|accepted|resolved", "ticket": "", "notes": "" }
{ "id": "dec_x", "date": "", "title": "", "context": "", "decision": "",
  "owner": "", "status": "decided|pending|superseded" }
{ "id": "per_x", "name": "", "role": "", "responsibilities": "", "contact": "",
  "escalation": "" }
```

Gap severities come from `severityFor()` in `server/lib/measured.js` when the
product generates them, so the same condition cannot show two severities on two
pages.

### `assessment.json`

```json
{ "answers": { "<questionId>": 0 }, "completedAt": null }
```

The router computes per-pillar scores (`inventory`, `data`, `runbooks`,
`testing`, `observability`, `governance`), an overall level 0–5 (0 None,
1 Backups, 2 Documented, 3 Tested once, 4 Repeatable loop, 5 Production-proven),
`completeness`, evidence `caps`, and `nextActions[]`. **`questionCount` is 21 and
the pillars do not hold equal counts — read the count from the API, never
hard-code it.**

### `resource-graph.json`

```json
{ "updatedAt": "ISO",
  "nodes": { "<rid>": { "rid": "vpc-0aa1…", "type": "vpc", "service": "EC2",
      "name": "acme-prod-vpc", "arn": "", "region": "us-east-1",
      "componentIds": ["cmp_vpc"], "details": {}, "tags": {},
      "source": "aws-enrich" } },
  "edges": [ { "from": "cmp_apigw", "to": "loadbalancer/net/…", "relation": "uses" } ] }
```

Node keys are resource ids (`rid`) — AWS-native ids or ARN tails, so they may
contain `/`, `:` and `@`. A node whose `componentIds` is empty is **unlinked**:
discovery found it and nothing in the inventory claims it. That is a review
queue, not an error.

`relation` values in use: `uses`, `listens-on`, `targets`, `secured-by`,
`in-subnet`, `member-of`, `in-az`, `routes-to`, `contains`, `assumes-role`,
`has-policy`, `encrypted-by`, `logs-to`, `alarmed-by`, `tagged-match`,
`resolves-to`. The deployment-order engine reads several of these
**directionally** (`secured-by` ⇒ the security group comes first), so adding a
relation means deciding its direction there too.

`source`: `aws-enrich | aws-scan-map | arpio | network-import | ai-correlate`.

### `k8s.json`

```json
{ "capturedAt": "ISO", "source": "kubectl|upload", "context": "", "clusterName": "",
  "nodes": { "count": 0, "instanceTypes": [], "readyCount": 0 },
  "namespaces": [ { "name": "", "labels": {} } ],
  "workloads": [ { "uid": "<ns>/<Kind>/<name>", "namespace": "", "kind": "Deployment",
      "name": "", "replicas": {}, "images": [], "serviceAccount": "",
      "labels": {}, "configmaps": [], "secrets": [], "componentId": "" } ],
  "services":  [ { "namespace": "", "name": "", "type": "", "selector": {},
                   "ports": [], "targets": [] } ],
  "ingresses": [ { "namespace": "", "name": "", "class": "", "hosts": [], "backends": [] } ],
  "pvcs": [ { "namespace": "", "name": "", "storageClass": "", "size": "", "boundTo": "" } ],
  "hpas": [ { "namespace": "", "name": "", "target": "", "min": 0, "max": 0 } ] }
```

Secrets and ConfigMaps are recorded as **names only** — never values, never
`data`. This is a hard rule; a change that stores a value is a security bug.

### `layouts.json`

```json
{ "<diagramId>": { "positions": { "<nodeId>": { "x": 0, "y": 0 } },
                   "template": "category-grid|layer-rows|flow|null",
                   "expandedState": { "<nodeId>": true },
                   "updatedAt": "ISO" } }
```

### `discovery-jobs.json`

```json
{ "jobs": [ { "id": "", "kind": "aws-scan", "ws": "", "status": "running|done|error",
              "startedAt": "ISO", "finishedAt": "ISO", "elapsedMs": 0,
              "progress": ["[+1.2s] …"], "result": {}, "error": "" } ] }
```

Job kinds: `aws-scan`, `aws-scan-map`, `enrich`, `enrich-by-tag`, `arpio`,
`k8s-scan`. One running job per `(workspace, kind)` — a second request gets
`409` with the running job's id. Running jobs live only in the process; finished
jobs are persisted (last 15 per workspace, progress trimmed to 100 lines, result
capped at ~4 MB). **No credentials are ever written into a job record.**

---

## 4. REST API

All JSON, base `/api`. Errors are `res.status(4xx|500).json({ error: "message" })`.
Any unmatched `/api` path returns `404 {error: "no such endpoint: …"}`; everything
else falls through to `web/index.html` (SPA routing).

### Workspaces & collections

| method + path | notes |
| --- | --- |
| `GET /api/workspaces` | `[{slug, name, updatedAt}]` |
| `POST /api/workspaces` | `{slug, name, …}` |
| `DELETE /api/workspaces/:ws` | |
| `GET/PUT /api/w/:ws/workspace` | meta; `PUT` merges |
| `GET /api/w/:ws/c/:col` | `{items}` — `:col` ∈ `COLLECTIONS` |
| `POST /api/w/:ws/c/:col` | body = item, id assigned |
| `PUT /api/w/:ws/c/:col/:id` · `DELETE /api/w/:ws/c/:col/:id` | |

### Assessment · recommend · knowledge · templates

| method + path | notes |
| --- | --- |
| `GET /api/w/:ws/assessment/questions` | the question bank (21 today) |
| `GET/PUT /api/w/:ws/assessment` | raw answers object |
| `GET /api/w/:ws/assessment/report` | pillars, level, signals, `nextActions`, `completeness`, `caps`, `numbers` |
| `POST /api/w/:ws/recommend` | `{strategy, tooling[], regionSwitch, gapsDetected[], gapSummary, numbers}` |
| `GET /api/w/:ws/templates/:kind` | `:kind` ∈ `runbooks` (5) · `checklists` (4) · `app-tests` (13) |
| `GET /api/knowledge` · `GET /api/knowledge/:id` | the 16 Learn articles |

### Service profile

`GET /api/w/:ws/service/:componentId` — the whole story of one service:
`{workspace, component, service, posture, closure, dependents, impact, graph,
outboundCalls, runbooks, tests, gaps, inlineGaps, k8sWorkloads, diagrams, risks,
risksAll, riskSummary, counts, generatedAt}`.

`posture.numbers` is the full `measuredNumbers()` result and is the key every
consumer should prefer. `risks` is the de-noised, ranked, collapsed list;
`risksAll` is every finding. The exact meaning of each `posture.*` key and each
risk rule is specified in [`docs/measured-numbers.md`](docs/measured-numbers.md).

### Deployment order

| method + path | notes |
| --- | --- |
| `GET /api/w/:ws/deploy-order[?componentId=]` | `{waves[], categoryOrder[], cycles[], unordered[], callOrderIssues[], calls[], stats, inputs, notes[]}` |
| `GET /api/w/:ws/deploy-order/explain/:id` (or `…/explain?id=`) | why one item sits where it does: `{item, summary, waitsFor[], chain[], unlocks[], cycles[], calls[]}`. Item ids: `cmp_*`, `res:<rid>`, `k8s:<ns>/<Kind>/<name>`, `ext:<slug>` — URL-encode them |
| `POST /api/w/:ws/deploy-order/to-runbook` | turns the order into a gated runbook |
| `POST /api/w/:ws/deploy-order/ai-assist` | asks the local CLI about one ordering edge |

Semantics: [`docs/deployment-order.md`](docs/deployment-order.md).

### Diagrams & layouts

| method + path | notes |
| --- | --- |
| `GET /api/w/:ws/diagrams` | `[{id, name, kind, section?, description, canvas}]` |
| `GET /api/w/:ws/diagrams/:id` | `{mermaid, notes}` |
| `GET /api/w/:ws/diagrams/:id/mmd[?flavor=lucid]` | Mermaid source download; `lucid` strips what Lucidchart cannot parse |
| `GET /api/w/:ws/diagrams/:id/drawio[?style=aws]` | draw.io XML; `aws` emits `mxgraph.aws4` shapes |
| `GET /api/w/:ws/diagrams/:id/canvas` | `{nodes, edges, …}` — the model the icon canvas lays out |
| `GET/PUT/DELETE /api/w/:ws/layouts/:diagramId` | saved canvas positions |

Diagram ids generated today: `architecture`, `dependencies`, `restore-layers`,
`failover-sequence`, `region-pair`, `data-replication`,
`dependencies-<componentId>`, `resource-map`, `resource-map-<componentId>`,
`k8s-cluster`, `k8s-namespace-<namespace>`, `deploy-order`,
`deploy-order-<componentId>`, `startup-dependencies-<componentId>`.
The list endpoint is authoritative — it only offers what the current workspace
can actually produce, and each entry declares `canvas: true|false`
(`failover-sequence` is the one Mermaid-only diagram). Asking for a diagram whose
inputs are missing is a deliberate `409`/`404` with the action to take, e.g.
*"No Kubernetes snapshot yet — capture one in Discover → Kubernetes"*.

**SVG and PNG are rendered in the browser**, not by the server: Mermaid renders
client-side and the icon canvas serialises its own SVG. There is no
`/diagrams/:id/svg` endpoint.

### Exports

| method + path | notes |
| --- | --- |
| `GET /api/w/:ws/export/xlsx[?componentId=]` | the 10-sheet workbook |
| `GET /api/w/:ws/export/csv/:sheet[?componentId=]` | one of the 12 CSV datasets |
| `GET /api/w/:ws/export/executive-summary.md[?componentId=]` | the one-pager |
| `GET /api/w/:ws/export/runbook/:id.md` · `…/:id.txt` | markdown · terminal quick-ref |
| `GET /api/w/:ws/export/scope/:componentId` | preview of what a scoped package covers |
| `GET /api/w/:ws/export/bundle[?componentId=]` | `{generatedAt, files:[{name, content}]}` |

Workbook sheets, in order: **Executive Summary · How to use · Resource Graph ·
Runtime · Outbound Calls · Dependencies · Deployment Order · Tests · Runbooks ·
Workbench**. *Deployment Order* is conditional — it is written only when the
ordering engine returns waves, so a sparse workspace yields nine sheets.

The executive summary markdown and the workbook's *Executive Summary* sheet are
rendered from **one** model (`executiveSummaryModel()`), so the two can never
tell different stories.

CSV datasets (`CSV_SHEETS`): `components`, `outbound-calls`, `secrets`, `gaps`,
`runbook-steps`, `tests`, `checklists`, `decisions`, `contacts`,
`verification-catalog`, `resource-graph`, `k8s-workloads`.

`?componentId=` scopes any export to that service **plus its full dependency
closure**. The DR-package `.zip` is assembled **client-side** by `web/js/zip.js`
(a minimal STORE + CRC-32 writer) — that is why `/export/bundle` returns JSON
rather than a zip: no new dependencies.

### Discovery, Kubernetes, network, resources, jobs

| method + path | notes |
| --- | --- |
| `GET /api/discover/aws/profiles` | merged `~/.aws` + `aws-vault` profiles |
| `GET /api/discover/aws/auth/check` | `sts get-caller-identity` pre-flight |
| `POST /api/discover/aws/auth/login` · `GET …/login/:profile/status` | launches and polls `aws sso login` |
| `GET /api/discover/aws/script` | the read-only discovery shell script |
| `POST /api/w/:ws/discover/aws` · `…/aws/scan-map` | enumerate · enumerate + map associations |
| `POST /api/w/:ws/discover/aws/upload` | consume the script's JSON artifact |
| `POST /api/w/:ws/discover/aws/import` | write approved proposals into the workspace |
| `POST /api/w/:ws/discover/arpio` | `{apiKeyId, apiSecret}` or `{apiKey: "id:secret"}`, `accountId?` → proposals |
| `GET /api/discover/k8s/contexts` · `GET /api/discover/k8s/script` | |
| `POST /api/w/:ws/k8s/scan` · `…/k8s/upload` · `GET/DELETE /api/w/:ws/k8s` | |
| `POST /api/w/:ws/network/flows/analyze` · `…/apply` | parsed rows in, outbound calls out |
| `GET /api/w/:ws/resources/graph[?componentId=][&summary=1]` | `summary=1` is ~695 B vs ~31 KB |
| `POST /api/w/:ws/resources/enrich` · `…/enrich-by-tag` · `DELETE …/graph` | |
| `POST /api/w/:ws/jobs` | `{kind, params}` → `201 {jobId}`, or `409` if that kind is running |
| `GET /api/w/:ws/jobs` · `…/:id` · `…/:id/result` | |

Everything discovery returns is a **proposal**. Nothing is written to the
inventory without an explicit import call carrying the user's selection.
Details, auth flows and least-privilege policies: [`docs/integrations.md`](docs/integrations.md).

### AI (local Claude Code CLI)

| method + path | notes |
| --- | --- |
| `GET /api/ai/status` | `{claudeCliFound}` — used by every contextual AI button |
| `GET /api/discover/ai/status` | the same probe, used only by the Discover page |
| `POST /api/w/:ws/ai/answer` | focused prose answer (read-only) |
| `POST /api/w/:ws/ai/ask` | legacy `{prompt, includeContext}` shape |
| `POST /api/w/:ws/ai/draft` | "make me a thing" → validated operations, applies nothing |
| `POST /api/w/:ws/ai/review` | critique one object → `{ok, markdown, findings[]}` |
| `POST /api/w/:ws/ai/narrative` | prose for humans (`NARRATIVE_KINDS`) |
| `POST /api/w/:ws/ai/context` | introspection: what context *would* be sent. No CLI call |
| `POST /api/w/:ws/ai/propose` | instruction → proposed operations |
| `POST /api/w/:ws/ai/apply` | apply **only** the operations the client sends |
| `POST /api/w/:ws/ai/correlate` · `…/correlate/apply` | link unlinked resources / workloads to components |
| `POST /api/w/:ws/ai/suggest` | discovery-flavoured suggestions |
| `POST /api/w/:ws/ai/deploy-order` | opinion on an ordering subgraph — suggestions only, never applied |

The CLI is invoked as `claude -p <prompt> --output-format text` with a **180-second**
timeout and a 20 MB buffer. Every prompt is prefixed with the honest-numbers
rules, so the model cannot describe a declared number as measured.

**The write boundary is `/ai/apply` and `/ai/correlate/apply`.** Every other AI
endpoint is read-only.
`/ai/apply` re-validates each operation against the live workspace and applies
them independently, so one bad operation never blocks the rest.

Quirk worth knowing: `discover.js` is mounted before `ai.js` and also defines
`POST /w/:ws/ai/ask`, so **discover's handler wins**. `ai.js` keeps its copy so
the focused-context contract still holds if discover's is ever removed.

---

## 5. Frontend contract

`web/index.html` is the app shell: a sidebar whose nav is **hard-coded there**
(not generated from the page modules) plus `<main id="outlet">`.

Hash routing: `#/:ws/:page[/:param1[/:param2]]`. `web/js/app.js` resolves the
page module from `PAGES` and imports `web/js/pages/<page>.js`, which must export:

```js
export default {
  title: 'Inventory',
  async render(el, ctx) { /* … */ },   // ctx = { ws, api, ui, params, navigate }
  destroy() {},                        // optional teardown (canvas pages need it)
};
```

An unknown page slug falls back to `dashboard`; an unknown workspace slug
redirects to the first workspace. The document title is `` `${mod.title} · DR Compass` ``.

The 13 pages, in nav order and grouping:

| group | nav label | slug | module |
| --- | --- | --- | --- |
| — | Overview | `dashboard` | `dashboard.js` |
| 1 · Where you stand | Assessment | `assessment` | `assessment.js` |
| 2 · What you have | Inventory | `inventory` | `inventory.js` |
| | Service profile | `service` | `service.js` |
| | Discover | `discover` | `discover.js` |
| | Diagrams | `diagrams` | `diagrams.js` |
| 3 · How it comes back | Deployment order | `deploy-order` | `deploy-order.js` |
| | Runbooks | `runbooks` | `runbooks.js` |
| | Checklists | `checklists` | `checklists.js` |
| 4 · Proof it works | Tests | `tests` | `tests.js` |
| | Exports | `exports` | `exports.js` |
| Setup & learning | Learn | `learn` | `learn.js` |
| | Settings | `settings` | `settings.js` |

Routable sub-paths: `service/:componentId`, `discover/:view[/:focus]`,
`diagrams/:diagramId`, `deploy-order/:componentId`, `runbooks/:runbookId`,
`checklists/:checklistId`, `tests/:testId`, `learn/:articleId`. The Discover and
Inventory in-page tabs are **not** in the hash; only inbound deep links set them.

Shared modules:

- `web/js/api.js` — `api.get/post/put/del(path)`, path relative to `/api`.
- `web/js/ui.js` — `h()`, `card()`, `table()`, `modal()`, `toast()`,
  `confirmDialog()`, `badge()`, `empty()`, `markdown()`, `term()` (glossary
  popovers), `snapshot()` (a 6-second cached parallel fetch of the seven things
  nearly every page needs), `aiRow()` / `aiPanel()`.
- `web/js/onboarding.js` — the single source of truth for "where am I in the
  program": breadcrumbs, the per-page next-step band, the Overview "Start here"
  card and the sidebar progress line. Done-state is always derived from data,
  never from a "user has seen it" flag.
- `web/js/measured.js` — the browser mirror of `server/lib/measured.js`:
  `measuredNumbers()`, `coversDirectly()`, `describe()`, `fromPosture()` (prefer
  this — it reads the server's `posture.numbers` rather than recomputing) and
  `VERDICT`. Use it rather than formatting RTA/RPA by hand, and when the server
  rule changes, change both.
- `web/js/ai-actions.js` — the one review-before-apply primitive behind every
  contextual AI button. If the local `claude` CLI is absent the buttons render
  disabled with an install hint; if the module itself fails to load, AI rows
  render nothing at all.
- `web/js/assistant.js` — the `Cmd/Ctrl+K` copilot drawer (`Esc` closes,
  `Cmd/Ctrl+Enter` sends). Conversation is in-memory only.
- `web/js/diagram-layout.js` — **pure, DOM-free and deterministic**: same input,
  byte-identical output. No `Math.random`, no `Date`, every tie broken by a
  comparator ending in a node-id comparison. `diagram-canvas.js` imports and
  re-exports it.

Style: use the custom properties and helper classes in `web/css/app.css`
(`--bg, --panel, --text, --muted, --accent, --ok, --warn, --err, --border`;
`.card, .btn, .btn-primary, .badge, .grid, .table`). Dark, calm, generous
spacing. Avoid per-page `<style>` blocks beyond small scoped tweaks. Keyboard
focus styles are real `:focus-visible` rules — do not remove them.

Mermaid is imported per-page as
`import mermaid from '/vendor/mermaid/mermaid.esm.min.mjs'` and initialised once
with the dark theme; limits are raised to 1 MB / 10 000 edges, and an oversized
diagram warns and points at the icon canvas rather than throwing.

---

## 6. The example workspace

`seedExample()` copies `server/data/seed/` to `example-acme` on first run if it
is not already there. It is a fictional Tier-0 pharmacy-claims platform —
27 components, a 57-node / 89-edge resource graph, a 10-workload Kubernetes
snapshot, one runbook, two tests, one checklist, seven gaps.

It is deliberately **vendor-neutral and mid-flight**: the data comes across on
AWS-native replication (Aurora Global Database, S3 CRR, ECR replication, Secrets
Manager replicas, AWS Backup copy), the shape is rebuilt from Terraform/GitOps,
and exactly two components remain on a third-party recovery tool so the two
models — a *current* copy versus a *consistent moment* — sit side by side. Its
last test is recorded as **failed**, so every surface must report its numbers as
declared, never measured. That is the seed's main job: it is the regression test
for the honest-numbers rule.

**No real account numbers, company names, person names or internal URLs anywhere
in the repo.**

---

## 7. CLI

```
drcompass [start]            start the UI (default command)
  -p, --port <port>          default 4517, or $DRCOMPASS_PORT
  --no-open                  do not open a browser
  --dir <path>               workspace data directory (sets DRCOMPASS_HOME)
drcompass init <slug>        create an empty workspace   [--name <name>]
drcompass list               list workspaces (slug, tab, name)
drcompass export <slug>      write the workbook          [--xlsx <path>]
drcompass --version / --help
```

Environment: `DRCOMPASS_PORT`, `DRCOMPASS_HOME`. `start` seeds the example
workspace; `init`, `list` and `export` do not.
