# DR Compass — Architecture Spec (contract for all builders)

DR Compass is a local-first disaster-recovery planning program: a CLI (`drcompass`)
that runs a web UI on localhost, stores everything as plain JSON in a workspace
directory, and generates diagrams, Excel workbooks, runbooks, and checklists.

**Stack:** Node >= 18 (no build step), Express, vanilla ES-module SPA, ExcelJS,
Mermaid (vendored from node_modules, served at `/vendor/mermaid/`).
**No TypeScript. No bundler. No new npm dependencies** beyond package.json
(express, exceljs, commander, open, mermaid).

## Layout & file ownership

```
bin/drcompass.js          CLI (core)
server/index.js           createServer() — mounts everything (core)
server/store.js           workspace JSON storage (core)
server/routes/collections.js  generic CRUD (core)
server/routes/workspace.js    workspace meta CRUD (core)
server/routes/knowledge.js    serves server/data/knowledge/*.md (core)
server/routes/assessment.js   maturity assessment  [agent: inventory-ui]
server/routes/diagrams.js     mermaid/drawio generation [agent: diagrams]
server/routes/exports.js      xlsx/csv/md exports  [agent: exports]
server/routes/discover.js     aws / arpio / ai discovery [agent: discovery]
server/routes/recommend.js    strategy + Region-switch recommender [agent: runbooks-tests]
server/lib/diagram-gen.js     [agent: diagrams]
server/lib/xlsx-gen.js        [agent: exports]
server/lib/aws-discovery.js   [agent: discovery]
server/lib/arpio-client.js    [agent: discovery]
server/lib/ai-bridge.js       [agent: discovery]
server/data/knowledge/*.md    [agent: research-knowledge]
server/data/strategy-catalog.json  [agent: research-knowledge]
server/data/templates/*.json  runbook/checklist/test templates [agent: runbooks-tests]
server/data/seed/*.json       example workspace (core; agents may enrich fields they own)
web/index.html  web/css/app.css  web/js/app.js  web/js/api.js  web/js/ui.js (core)
web/js/pages/dashboard.js     [agent: inventory-ui]
web/js/pages/inventory.js     [agent: inventory-ui]
web/js/pages/assessment.js    [agent: inventory-ui]
web/js/pages/diagrams.js      [agent: diagrams]
web/js/pages/runbooks.js      [agent: runbooks-tests]
web/js/pages/tests.js         [agent: runbooks-tests]
web/js/pages/checklists.js    [agent: runbooks-tests]
web/js/pages/discover.js      [agent: discovery]
web/js/pages/exports.js       [agent: exports]
web/js/pages/learn.js         [agent: research-knowledge]
web/js/pages/settings.js      (core)
Formula/drcompass.rb  README.md  docs/*  [agent: packaging-docs]
```

Own ONLY your files. Shared files (index.html, app.js, server/index.js) are
pre-wired — do not edit them; if something is missing, note it in
`INTEGRATION-NOTES.md` (append-only, create if absent).

## Workspace storage

Workspaces live in `~/.drcompass/workspaces/<slug>/` (override:
`DRCOMPASS_HOME` env or `--dir`). Each workspace is a folder of JSON files:

- `workspace.json` — meta (see schema)
- `components.json`, `runbooks.json`, `tests.json`, `checklists.json`,
  `gaps.json`, `decisions.json`, `contacts.json`, `assessment.json` — each
  `{ "items": [...] }` except assessment (object).

`server/store.js` exports:
```js
listWorkspaces() -> [{slug, name, updatedAt}]
createWorkspace(slug, meta) ; deleteWorkspace(slug)
getWorkspace(slug) -> meta ; saveWorkspace(slug, meta)
getCollection(slug, name) -> items[] ; saveCollection(slug, name, items)
getObject(slug, name) / saveObject(slug, name, obj)   // e.g. assessment
newId(prefix) -> 'cmp_ab12cd34'
seedExample() -> creates 'example-acme' from server/data/seed if missing
```

## Core schemas

### workspace.json
```json
{ "slug": "example-acme", "name": "Acme Pharmacy", "org": "Acme Health",
  "description": "...",
  "regions": { "primary": "us-east-1", "recovery": "us-east-2" },
  "objectives": { "rtoMinutes": 60, "rpoMinutes": 30,
                  "rtaMinutes": null, "rpaMinutes": null,
                  "approved": false, "notes": "" },
  "strategy": "pilot-light",
  "tooling": ["arpio", "region-switch"],
  "createdAt": "ISO", "updatedAt": "ISO" }
```
`strategy`: `backup-restore | pilot-light | warm-standby | active-active`
`tooling[]`: `arpio | region-switch | arc-routing-controls | elastic-dr | gitops-iac | resilience-hub | backup`

### Component (components.json items[])
```json
{ "id": "cmp_x", "name": "adjudication-service", "category": "compute",
  "tier": 0, "owner": "", "team": "", "description": "",
  "kind": "eks-workload",
  "drStrategy": "inherit", "restoreLayer": "L4",
  "replication": { "mechanism": "arpio-snapshot", "rpoMinutes": 30, "notes": "" },
  "inRecoveryScope": "yes", "definedIn": "terraform/services/adjudication",
  "dependsOn": ["cmp_aurora_adj"],
  "outboundCalls": [ { "target": "partner-clearinghouse", "type": "third-party",
      "protocol": "https", "purpose": "claim switch",
      "failoverBehavior": "manual-allowlist", "critical": true } ],
  "awsServices": ["EKS", "Secrets Manager", "SQS"],
  "secrets": [ { "name": "adjudication/db-password",
      "arn": "", "replicated": "yes", "notes": "" } ],
  "endpoints": [ { "name": "api", "url": "", "healthCheck": "/healthz" } ],
  "verification": { "command": "kubectl get deploy ...", "pass": "Ready" },
  "gaps": ["Kinesis stream not in recovery scope"], "notes": "", "tags": [] }
```
`category` (canonical list — use these ids everywhere):
`compute | networking | storage | database | messaging-streaming |
security-secrets | edge-dns | identity-access | observability |
third-party | cicd-control-plane | other`

`restoreLayer` — the restore "layer cake", ordered:
`L0` guardrails/backups green → `L1` recovery launch/replication →
`L2` platform (cluster, nodes, mesh) → `L3` data + secrets → `L4` applications →
`L5` edge/network reachability → `L6` functional success bar (business
transaction) → `L7` live traffic cutover (game day only).

`outboundCalls[].type`: `aws-service | third-party | saas | internal | on-prem`
`inRecoveryScope`: `yes | no | partial | unknown`

### Runbook (runbooks.json)
```json
{ "id": "rbk_x", "name": "Regional failover — Arpio", "tooling": "arpio",
  "scenario": "region-loss", "audience": "operator",
  "preconditions": ["Phase 0 checklist green"],
  "steps": [ { "id": "stp_1", "layer": "L1", "title": "Launch recovery",
      "detail": "...", "command": "", "verify": "", "pass": "",
      "owner": "", "estMinutes": 5, "record": "T0 timestamp",
      "componentIds": [], "gate": true } ],
  "rollback": [ ...same step shape... ],
  "linkedTestIds": [], "notes": "", "updatedAt": "ISO" }
```

### Test / exercise (tests.json)
```json
{ "id": "tst_x", "name": "Dev recovery test #3", "type": "recovery-test",
  "status": "planned", "date": "2026-09-17",
  "runbookId": "rbk_x", "scope": "",
  "appTests": [ { "name": "claim adjudication returns claim_id",
      "command": "", "expected": "", "componentId": "", "critical": true } ],
  "timestamps": { "t0": null, "tFirstAccess": null, "t1": null },
  "results": { "rtaMinutes": null, "rpaMinutes": null, "cleanRun": false },
  "findings": [ { "title": "", "severity": "blocker", "gapId": "", "ticket": "" } ],
  "record": "markdown narrative", "updatedAt": "ISO" }
```
`type`: `recovery-test | game-day | tabletop | component-test | chaos`
`status`: `planned | in-progress | passed | failed | canceled`

### Checklist (checklists.json)
```json
{ "id": "chk_x", "name": "Phase 0 — before any launch", "kind": "phase0",
  "items": [ { "id": "itm_1", "text": "", "why": "", "proof": "",
               "owner": "", "done": false } ], "updatedAt": "ISO" }
```
`kind`: `phase0 | preflight | game-day | weekly | custom`

### Gap / Decision / Contact
```json
{ "id": "gap_x", "title": "", "category": "security-secrets", "class":
  "missing-dependency", "severity": "blocker|high|medium|low",
  "componentId": "", "status": "open|accepted|resolved", "ticket": "", "notes": "" }
{ "id": "dec_x", "date": "", "title": "", "context": "", "decision": "",
  "owner": "", "status": "decided|pending" }
{ "id": "per_x", "name": "", "role": "", "responsibilities": "", "contact": "",
  "escalation": "" }
```

### assessment.json (object, not collection)
```json
{ "answers": { "<questionId>": 0-4 }, "completedAt": null }
```
Assessment router computes per-pillar scores (pillars: inventory, data,
runbooks, testing, observability, governance), overall level 0–5
(0 None, 1 Backups, 2 Documented, 3 Tested once, 4 Repeatable loop,
5 Production-proven), and returns `nextActions[]`.

## REST API (all JSON; base `/api`; workspace slug in path)

- `GET /api/workspaces` · `POST /api/workspaces` `{slug,name,...}` ·
  `DELETE /api/workspaces/:ws`
- `GET/PUT /api/w/:ws/workspace`
- Generic collections (`components|runbooks|tests|checklists|gaps|decisions|contacts`):
  `GET /api/w/:ws/c/:col` → `{items}` · `POST /api/w/:ws/c/:col` (body=item,
  id assigned) · `PUT /api/w/:ws/c/:col/:id` · `DELETE /api/w/:ws/c/:col/:id`
- `GET /api/w/:ws/assessment` · `PUT /api/w/:ws/assessment` ·
  `GET /api/w/:ws/assessment/report`
- `GET /api/w/:ws/diagrams` → list `[{id,name,kind}]` ·
  `GET /api/w/:ws/diagrams/:id` → `{mermaid, notes}` ·
  `GET /api/w/:ws/diagrams/:id/drawio` → XML download.
  Diagram ids at minimum: `architecture`, `dependencies`,
  `dependencies-<componentId>`, `restore-layers`, `failover-sequence`,
  `region-pair`, `data-replication`.
- `GET /api/w/:ws/export/xlsx` → workbook download (Content-Disposition).
  `GET /api/w/:ws/export/csv/:sheet` · `GET /api/w/:ws/export/runbook/:id.md`
  · `GET /api/w/:ws/export/bundle` → zip? NO — no new deps; return
  `{files:[{name,content}]}` JSON instead.
- `POST /api/w/:ws/discover/aws` `{profile, region, services[]}` →
  `{proposals:[Component-shaped], log[]}` (shells out to `aws` CLI; degrade
  gracefully if missing). `GET /api/discover/aws/profiles` (parse ~/.aws).
- `POST /api/w/:ws/discover/arpio` `{apiKey, accountId?}` → proposals.
- `POST /api/w/:ws/ai/ask` `{prompt, includeContext:true}` → `{answer}`
  (shells `claude -p`, non-interactive; 120s timeout; helpful error if CLI absent).
- `POST /api/w/:ws/recommend` → strategy/tooling recommendation incl. Region
  switch plan skeleton (which execution blocks per component; order by layer).
- `GET /api/knowledge` → `[{id,title,section}]` · `GET /api/knowledge/:id` →
  `{title, markdown}`.

Errors: `res.status(4xx|500).json({error: "message"})`.

## Frontend contract

`web/index.html` — app shell with sidebar nav + `<main id="outlet">`.
Hash routing: `#/:ws/:page[/:sub]`. `web/js/app.js` resolves the page module
from `web/js/pages/<page>.js`, which must export:
```js
export default { title: 'Inventory', async render(el, ctx) { ... } }
// ctx = { ws, api, ui, params, navigate(hash) }
```
`web/js/api.js` exports `api.get/post/put/del(path)` (path under `/api`).
`web/js/ui.js` exports helpers: `h(tag, attrs, ...children)`, `card()`,
`table()`, `modal()`, `toast(msg, kind)`, `confirmDialog()`, `badge()`,
`empty()`, `markdown(md)` (small renderer, already provided).

Style: use `web/css/app.css` custom properties (`--bg,--panel,--text,--muted,
--accent,--ok,--warn,--err,--border`, class helpers `.card,.btn,.btn-primary,
.badge,.grid,.table,...`). Dark, professional, calm; generous spacing. Do not
add per-page <style> blocks except small scoped tweaks via `<style>` string in
your module.

Mermaid: `import mermaid from '/vendor/mermaid/mermaid.esm.min.mjs'` inside
pages that need it (diagrams page). Initialize once with dark theme.

## Seed workspace ("example-acme")

Fictional "Acme Pharmacy" Tier-0 stack, modeled on a realistic
pharmacy-claims platform: EKS workloads (adjudication, pricing, pharmacy,
remittance), Aurora ×3, Redis ×2, SQS queues, Kinesis streams, S3 buckets,
Secrets Manager, API GW + VPC Link + NLB, Route53, CDN/edge allowlist,
partner clearinghouse (third-party), SFTP settlement (third-party), ECR,
IAM/OIDC, observability stack. NO real account numbers, company names,
person names, or internal URLs anywhere in the repo.

## CLI

`drcompass` (no args) = `drcompass start`: starts server on `--port` (default
4517), opens browser unless `--no-open`. Also: `init <slug>`, `list`,
`export <slug> --xlsx <path>`, `--version`. `DRCOMPASS_PORT`,
`DRCOMPASS_HOME` env supported.
