# DR Compass — first end-to-end journey report

**Who ran this:** an infrastructure engineer new to the tool, newly responsible for DR of a
Tier-0 payments platform, starting from an empty workspace. No AWS credentials on the
machine, so the credential-less paths were used throughout.

**Setup:** `DRCOMPASS_HOME=./.testhome-journey`, port 4695, v0.4.0. Brand-new workspace
`payments-core` (not the seed). Every action was taken through the real HTTP API, with the
payloads the page modules send, in the order the UI sends them. No real AWS account,
cluster or Arpio tenant was touched.

**What was built:** 7 components imported from a hand-crafted read-only discovery artifact
(ALB, EKS, Aurora global, 3 S3 buckets, 2 SQS queues, Secrets Manager) with 45 graph nodes
and 68 edges; a 5-workload Kubernetes snapshot; a 14-row flow-log CSV; 2 runbooks (one from
a template, one from the deployment order); 2 tests (one failed, then one passed); 3 gaps;
and the full export set.

**Verdict in one line:** the spine of this product — the honest-numbers contract, the
deployment-order engine, the workbook and the executive summary — is genuinely strong and
better than most commercial equivalents. But a first-time user ends up with an evidence
package containing fabricated observation counts, seven IP addresses presented as things to
deploy, a 36-step runbook with no commands and no time estimates, and five identically-named
draw.io files with identical contents. It is close, but it is not ready to hand to someone
other than its author.

---

## Top 10 problems, ranked by severity

### 1. Flow-log import fabricates observation counts from a byte column — BLOCKER

**What I did.** Uploaded a normal firewall export with headers
`start,end,srcaddr,srcname,dstaddr,dstname,dstport,protocol,action,bytes,packets`
through `POST /w/:ws/network/flows/analyze`, then applied the suggestions.

**What I expected.** "Observed N times" to mean N flow records.

**What happened.** Column detection mapped the `count` role onto the **`bytes`** column
(`server/lib/network-flows.js:218` scores `bytes|packets|…` at 8, and nothing else matched).
The UI then writes `purpose: "observed in network flows (${f.count}×)"`
(`web/js/pages/discover.js:3213`), so the component now carries:

```
target: 203.0.113.9  purpose: "observed in network flows (229110441×)"  observedCount: 229110441
```

That is 229 MB of traffic re-presented as 229 million connections. The number then travels,
unchallenged and comma-formatted for authority, into:
- the deployment-order notes ("EKS cluster calls it over tcp/22 for observed in network flows (229110441×)"),
- the generated runbook's preconditions,
- the **Outbound Calls** workbook sheet: `network-flows · observed 229,110,441`,
- the **Runtime** sheet, the `outbound-calls.csv`, and the DR package.

The workbook explicitly labels this row `Calls seen in imported flow data … flows prove,
declarations don't` — so the product is asserting provenance for a number it invented. This
is the single clearest violation of the product's own honest-numbers doctrine, and it is in
the stakeholder-facing artifact.

**Severity: blocker.** A number with false provenance in an audit pack is worse than no number.

---

### 2. Flow import discards the hostname columns and reports 100% confidence — HIGH

Same upload. The CSV has `srcname` (`auth-api`, `settlement-worker`) and `dstname`
(`api.stripe.com`, `sftp.clearinghouse.example`, `mastercard-vpn-gw.corp`). The detector
picked the raw-IP columns for both roles and reported `confidence: 1`.

Consequences:
- Every outbound call in the inventory is a bare IP. The docs sell this feature as "partner
  allowlists and static egress IPs… the classic game-day surprises" — you cannot arrange a
  partner allowlist for `34.196.7.12`.
- Because confidence is 1 and `a.warning` is unset, `shaky` is false in
  `web/js/pages/discover.js`, so the "Advanced — fix a column we got wrong" disclosure stays
  **closed**. A newcomer is given no reason to look.
- The workbook then has to add a whole summary row for the damage:
  `Destinations not resolved to a name: 8 · a bare IP or hash tells nobody anything`.
- `10.20.16.40:5432` is the Aurora cluster that is already in the inventory, in a subnet the
  resource graph already knows. It is recorded as an unresolved "internal" call, and the
  deployment order raises `unresolved-target` for it.

Two equally host-shaped columns tied and the lower index won. Reporting that as "100%
confident" is the bug; the tie itself is forgivable.

**Severity: high.**

---

### 3. `sourceSuggestions` asks the user for something the product already knows — HIGH

All four source IPs came back as:

```
{"source":"10.20.4.17","componentId":null,"confidence":0,
 "why":"private IP with no name — pick the component manually"}
```

At that moment the workspace contained: a resource graph with subnet `payments-app-1a`
(`10.20.4.0/23`, and `10.20.4.17` is in it), a Kubernetes snapshot with a workload literally
named `auth-api`, and a CSV column `srcname` whose value for that row is `auth-api`. Three
independent ways to answer its own question, all unused.

**Severity: high** — this is the "asks the user for something it could have worked out"
category in its purest form, and it is the step where most users will abandon the feature.

---

### 4. Discovery produces almost no `dependsOn`, and everything downstream depends on it — HIGH

The scan-and-map replay worked beautifully — 7 proposals, 45 graph nodes, 68 edges, **zero
errors**, rich associations (SGs, subnets, AZs, listeners, target groups, KMS, IAM, route
tables, NACLs). But `dependsOnProposals` was empty for 6 of 7 proposals. After import:

| component | dependsOn |
| --- | --- |
| ALB — payments-alb | `[]` |
| EKS cluster — payments-eks | `[]` |
| Aurora — payments-aurora | `[]` |
| S3 buckets (3) | `[]` |
| SQS — payments-auth-events | `[dlq]` |
| SQS — payments-settlement-dlq | `[]` |
| Secrets Manager | `[]` |

`computeDependsOn` (`server/lib/aws-scan-map.js:381-410`) requires an **exact** string match
between an identifier in P's association set and Q's own name/ARN. In real AWS nothing
matches: an ALB target group of type `ip` never names the EKS cluster, and the Aurora
security group's inbound rule points at `sg-0eks…` whose *name* is `payments-eks-cluster-sg`,
not `payments-eks`.

The strongest available signal is thrown away on purpose: `deepSecurityGroups`
(`server/lib/aws-enrich.js:~1180`) records only `inboundRules: (sg.IpPermissions||[]).length`
and never walks `UserIdGroupPairs`. SG-to-SG references are the most reliable machine-readable
statement of "A talks to B" inside a VPC, and they are reduced to a count.

Why this matters: dependency mapping is foundation #3 of five, and the deployment order,
the diagrams, the runbook and the restore-layer story are all generated from `dependsOn`.
A discovery-only user gets a plan built on one edge. The seed has 18 of 27 components with
hand-authored `dependsOn`, so this has never shown.

Also: the Discover page offers this user no path at all. `nextActions` only offers "Map
dependencies" when `awsComponentCount && !graph.resources` — which is false once you have
imported. There is no "infer component dependencies from the graph you already have".

**Severity: high.**

---

### 5. Every AWS load balancer is mis-tiered by the ordering engine — HIGH

The AWS discoverer emits `kind: 'elb'` for every ALB/NLB
(`server/lib/aws-discovery.js:481`). The ordering rule table has
`[/^alb$|^nlb$|load-balancer|target-group/, { tier: 10 }]`
(`server/lib/deploy-order.js:357`) — which `'elb'` does not match. It falls through to
`CATEGORY_FALLBACK.networking` = **tier 2**, an eight-tier error.

Measured, on the raw import before I added any dependencies by hand:

```
Wave 2 · Network foundation: payments-vpc, acl-…, ALB — payments-alb   ← ALB here
Wave 3 · …                 : payments-public-1a, payments-public-1b, payments-alb-sg
Wave 5                     : payments-api-tg
Wave 6                     : payments-alb (the resource node), EKS cluster
Wave 7                     : HTTPS:443 listener
```

The plan says to create the load balancer in the same wave as the VPC — **before its own
subnets and security group**. The item carries `layerMismatch: true` and the note
*"kind \"elb\" is not in the ordering rule table — placed by its category (networking);
review the tier if this is wrong"*, but that note is buried in the item and does not reach
the wave header, the diagram or the runbook step. It is also the *only* `layerMismatch` in
the whole plan, which makes the warning easy to miss.

The seed workspace has no load balancer component at all (seed kinds: `eks-cluster,
eks-workload, aurora-postgres, elasticache-redis, sqs, kinesis, s3, secrets-manager,
api-gateway, route53, cdn, ecr, vpc, iam, kms, acm, external, observability`), which is
exactly why this was never caught. `ec2-asg` is also unmatched, though harmlessly.

**Severity: high** — a wrong recovery order is the one thing this page must never produce.

---

### 6. The runbook generated from the deployment order has no commands, no owners and no time estimates — HIGH

`POST /w/:ws/deploy-order/to-runbook` produced 36 steps, 12 gates, 16 preconditions. Every
single step has:

- `command: ''` — hard-coded at `server/lib/deploy-order.js:2321`
- `owner: ''` — hard-coded at `server/lib/deploy-order.js:2326`
- `estMinutes: null` — 0 of 95 order items carry one, so `Math.max(...est)` never fires
- 25 of 36 steps have no verify command either

`docs/getting-started.md` §5 promises: *"each has a verify command, a pass criterion, an
owner, a time estimate, and optionally a gate."* Two of those four are structurally
impossible from this generator, and the third (estimate) has no source.

The consequence is visible in one screen of the workbook's **Runbooks** sheet, where the two
runbooks sit side by side:

```
row 9   Regional failover — GitOps  | step 1 | flux get kustomizations …   | operator | 10 | Yes
row 36  Deployment order            | step 1 | (blank)                     | (blank)  |    | No
```

The template runbook is executable. The generated one — the product's flagship feature,
the thing the whole ordering engine exists to produce — is a table of contents. With
`rtoMinutes: 120` set as the target, nothing anywhere can say whether the 36 steps fit in
120 minutes.

**Would I execute it at 3am?** I would use it to *check* an order I already understood. I
could not execute from it. Answer: no.

**Severity: high.**

---

### 7. Third-party endpoints appear twice in the plan, once as "verify" and once as "deploy" — HIGH

Each flow-derived target is emitted as **two** items in the same deployment order:

| | id | wave | category | action | note |
| --- | --- | --- | --- | --- | --- |
| a | `ext:192-0-2-77` | 0 | third-party | verify | "Must already be true… verify, don't create." |
| b | `res:net_192-0-2-77` | 3 | **other** | **deploy** | *"resource type \"other\" is not in the ordering rule table — placed in the data-store tier as a conservative default"* (`server/lib/deploy-order.js:758`) |

Seven targets × two = 14 items. In the generated runbook this becomes step 1
("Wave 0 — Third party: 192.0.2.77, 198.51.100.24, …") and step 10 ("Wave 3 — **Other**:
192.0.2.77, 198.51.100.24, …"). Step 10 instructs an operator to **deploy an IP address as
a data store**. That is a step that cannot be executed, and it is in the printed quick-ref.

The same duplication shows in the deploy-order diagram (`dw0` has 7
`· external-precondition` nodes, `dw3` has the same 7 as `· other`), so a stakeholder sees
the same IPs in two waves.

Related, same root cause: the preconditions block that opens the runbook, the Markdown
export, the `RUNBOOK-QUICKREF.txt` and the workbook Runbooks sheet is **14 near-identical
paragraphs about IP addresses** before any step. This is the first thing a 3am operator
reads. Each target is listed twice (short form from `waves[0]`, long form from
`callOrderIssues`) — see the precondition assembly in `toRunbookDraft`.

**Severity: high** (unexecutable steps + the runbook's opening page is noise).

---

### 8. Every AWS component appears twice in the plan, in different waves — MEDIUM-HIGH

Distinct from #7. Each imported component is scheduled once as a component and once as its
own discovered resource node:

| thing | component item | resource item |
| --- | --- | --- |
| ALB | `cmp_91d518a9` wave 7 | `res:loadbalancer/app/payments-alb/…` wave 8 |
| Aurora | `cmp_5365ab63` wave 5 | `res:rds/cluster/payments-aurora` wave 6 |
| EKS | `cmp_d9acde57` wave 6 | `res:eks/cluster/payments-eks` wave 7 |
| SQS auth-events | `cmp_89f84386` wave 5 | `res:sqs/payments-auth-events` wave 6 |
| SQS dlq | `cmp_435163ae` wave 4 | `res:sqs/payments-settlement-dlq` wave 3 |

The two copies carry *different* prerequisites and *different* verify text. The ALB
component has `waitsFor: [EKS]` and the inventory verify command; the ALB resource has
`waitsFor: [target-group, SG, 2 subnets, VPC, the component itself, sg-rules]` and "No
verification command is recorded". The runbook therefore contains "create the load balancer"
twice, one wave apart, and the DLQ resource is scheduled a wave *before* the DLQ component.

The itemCount of 95 for a 7-component workspace is inflated by this. On the seed, where
components have no `arn` and the resource graph was authored alongside them, the effect is
presumably smaller.

**Severity: medium-high** — confusing rather than wrong, but confusing in the artifact whose
whole purpose is to be unambiguous.

---

### 9. The workbook's "ARN" column contains the tier; five draw.io exports are the same file — MEDIUM-HIGH

Two separate export defects, both invisible on the seed.

**(a) ARN column holds the tier.** On the **Dependencies** sheet, header row 2 column 10 is
`ARN`; data rows contain `Tier 0` / `Tier 1`:

```
row2   … 9:"In DR scope?"  10:"ARN"  11:"Resources/links"
row5   … 9:"Yes"           10:"Tier 0"
row26  … 9:"Yes"           10:"Tier 0"
```

Source: `server/lib/xlsx-gen.js:2616` — `arn: c.tier != null ? \`Tier ${c.tier}\` : ''`.
Every one of my components has a real ARN (`arn:aws:eks:us-east-1:…`) from discovery and it
is nowhere in the workbook or in `components.csv`. The seed's components predate the `arn`
field entirely, so the column just looked blank and nobody noticed.

**(b) Five diagram exports are byte-identical.** `architecture`, `dependencies`,
`restore-layers`, `region-pair` and `resource-map` all return the *same* draw.io XML,
differing only in the `modified=` timestamp (5987 bytes each, plain; 6966–6972 AWS-style).
Confirmed by diff. `server/routes/diagrams.js:229-231` is explicit about it — *"For
non-architecture diagrams, export the architecture-style drawio of that diagram's component
subset"* — but the Exports page ships them into the DR package as
`diagrams/region-pair.drawio` labelled *"Region pair — editable in draw.io"*. Worst case:
`resource-map.drawio` contains **13 boxes**, while the Diagrams page advertises the same
diagram as *"Resource map — 52 AWS resources across 7 components"*.

**Severity: medium-high** — a stakeholder opens the file and gets the wrong picture with no
warning.

---

### 10. Per-component "measured / met" is claimed for components the test never touched — MEDIUM-HIGH

After one passed test with **no** `componentId`, no `componentIds`, and no `componentId` on
any of its 9 app tests, every service profile reports:

```
SQS — payments-settlement-dlq  => measured: {test:"DR test #2", covers:"direct", rta:94}  verdict: met
S3 buckets (3)                 => measured: {test:"DR test #2", covers:"direct", rta:94}  verdict: met
Secrets Manager (3 secrets)    => measured: {test:"DR test #2", covers:"direct", rta:94}  verdict: met
```

`coverageOf` (`server/lib/measured.js:98`) returns `'direct'` when *a runbook step names the
component* and the test links that runbook. The deployment-order-generated runbook attaches
`componentIds` to nearly every step for nearly every component, so linking it to one test
marks the **entire workspace** as directly covered by that test.

The browser twin disagrees by design. `web/js/measured.js:50-58`:

> *"a component number needs the component named on the test itself, **never inferred from a
> shared runbook** or a dependency closure."*

Same contract, two implementations, opposite answers — and the file's own header says it is
"the browser twin, not a second opinion". The S3 component is `inRecoveryScope: partial` and
still shows `verdict: met`.

**Severity: medium-high.** This is the one place where the otherwise-excellent honest-numbers
machinery over-claims.

---

## Other findings, by category

### Things that only work because of the seed

| # | Finding | Where |
| --- | --- | --- |
| a | `kind: 'elb'` unmatched by the ordering rules — the seed has no load balancer | `deploy-order.js:357` |
| b | The `ARN` column holds the tier — the seed's components have no `arn` field | `xlsx-gen.js:2616` |
| c | *"Stores marked rebuilt cold on failover are caches — they carry no data across and simply refill"* is emitted whenever any store has `mechanism: 'rebuild'`. In my workspace those two stores are **SQS queues** — an auth-event queue and a **settlement DLQ holding unprocessed financial messages**. Calling them caches that "simply refill" is materially wrong DR advice. It is true only for the seed, whose `rebuild` components are ElastiCache. | `diagram-gen.js:500` |
| d | The K8s tab renders `Cluster: —` for every workspace. The snapshot stores `clusterName`; the UI reads `snap.cluster`. The diagram generator uses the right key (`diagram-gen.js:776,815,930`), so the diagram title is correct while the tab beside it is blank. Pre-existing on the seed too. | `discover.js:1414`, `discover.js:2579` |
| e | Discovery sets `dependsOn: []`, `inRecoveryScope: 'unknown'`, `tier: 1` and no verification command on every proposal. The seed has 18/27 with dependencies and 17/27 with verification commands, all hand-authored. | `aws-discovery.js:176` (`prop()`) |

### Contradictions between two surfaces

| # | Finding |
| --- | --- |
| f | **The assessment's roadmap punishes answering honestly.** With 0 answers, `nextActions` correctly leads with "Build your component inventory". After answering *three* inventory questions honestly low, inventory scores 6% while five untouched pillars score 0%, `weakest` sorts them first (`assessment.js:503`, `a.score - b.score`), and inventory drops off the 6-item list entirely — for a workspace with **zero components**. The same page's own summary card gets this right (`web/js/pages/assessment.js:100-102` sorts unanswered pillars to `-1` and picks `pillars.find(p => p.answeredCount)`), so the server and the client disagree about what "weakest" means, on the same screen. |
| g | With a completed assessment and an empty inventory, the roadmap's #2 action is **"Run your first recovery test"** and inventory is #6. You cannot test nothing. Meanwhile the sidebar and Start-here card say the next thing is "Build the inventory", and the end-of-page band says "Set RTO/RPO targets". Three different "next" on one screen. |
| h | **"Level 0 — None"** is printed on the dashboard, the Workbench sheet (status `Fail`, red) and the executive summary — next to "Recovery time measured 94 min, target 120, met" and "Tests passed: 1". The level is self-reported and never re-prompted; nothing in the progression model says "re-score after a passed test". A stakeholder reading the exec pack sees "maturity: None" for a program with measured evidence. |
| i | **Restore layer cake shows L4 Applications as `(no components mapped)`** while the deployment order has a Wave 9 "Applications" with 5 Kubernetes workloads. The restore-layer diagram reads only `components`, not the k8s snapshot (`diagram-gen.js:289`). 5 of 8 layers render as empty placeholders. The failover-sequence diagram inherits this: it goes `DR->>Data` then `Apps->>Edge`, with `Apps` never having been told to do anything. |
| j | **Outbound Calls sheet: "Calls that BLOCK recovery: 0 — Pass (green)"** and **"Calls needing an allowlist / static egress IP: 0 — Pass (green)"**, while gap #1 in the same workbook is a **blocker** reading *"Card-network partner has not allowlisted the us-west-2 NAT egress IPs"*. Flow-imported calls get `critical: false` and `failoverBehavior: ''` and nothing ever asks. |
| k | **Runtime sheet says "1 service"** and the Outbound Calls sheet says the EKS component has *"no workload in the cluster snapshot"* — while the Diagrams page lists *"Kubernetes cluster — 5 workloads across 2 namespaces"*. `autoLink` returned `linked: 0`. |
| l | Recording three blocker/high findings on a failed test leaves the dashboard's "What is blocking you" card **empty** and the assessment signal **"Open blocker gaps: 0 (ok)"** green, until you manually click "→ create gap" on each finding. The docs say "findings flow into a gap list"; they do not flow, they are carried by hand. |

### Dead ends and things it could have worked out

| # | Finding |
| --- | --- |
| m | **The credential-less discovery path records no job.** Upload goes through `POST /w/:ws/discover/aws/upload` (`discover.js:306`), which never writes a job row. So `GET /w/:ws/jobs` stays `[]`, and the returning-user Discover list says: *"Scan the AWS account again — **No account scan has been recorded in this workspace** — a scan proposes anything your inventory is missing."* Minutes after a successful 45-node import. The status strip's "Last run" tiles are likewise blank. The whole point of the credential-less path is that it is the *only* path some users have. |
| n | **"deps ≥ 60%" outranks two open blockers.** After a passed test with 2 open blocker gaps, `nextAction()` returns foundation `deps` ("Map dependencies — 57% of resources have dependencies recorded"), because `programSteps` requires `depsPct >= 60` before it will look at blockers. My 3 uncovered components (S3, Secrets Manager, DLQ) are genuine leaves with no upstream dependencies. The only way to reach 60% is to record a dependency that is not true. |
| o | **Findings lose their detail on the way to a gap.** The finding editor exposes only title / severity / ticket; `f.detail` has no field in the UI. The "→ create gap" handler (`web/js/pages/tests.js:365`) copies title, severity and ticket, sets `componentId: ''`, and drops the detail. Every gap in my exec summary and workbook reads `owner: unassigned · component: workspace-wide`, even though the finding named the exact components. The AI noticed this unprompted: *"the gap's `componentId` is empty."* |
| p | **Checklists are never asked for.** The five foundations contain no checklist step, `nextAction` never returns one, and the Workbench sheet renders `0/0 checklists` with the Phase 0 gate section empty — while the workbook's own hard-rules section and the docs both call Phase 0 the thing that must be green before any launch. A user who follows the product's guidance exactly never creates one. |
| q | **`firstRunWelcome()` is unreachable.** `seedExample()` runs on every start (`bin/drcompass.js:16`), so `workspaces` is never empty and the welcome screen only renders when the server is down — in which case it correctly shows the error variant. The "Welcome to DR Compass / Create your first workspace" screen has no reachable happy path. |
| r | **Exec summary points at a sheet that does not exist.** *"Drive each to yes or no on the **Secrets Reconciliation sheet**"* — it is a section inside **Workbench**, and "How to use" lists only 10 sheets. |
| s | The KMS alias `alias/aws/sqs` renders as a resource named **`sqs`** of type `kms-key`, inside a **gate** step ("Wave 0 — Security & secrets"). "Create KMS key `sqs`" is neither executable nor creatable — it is an AWS-managed key. |

### Smaller things

- The workbook and the runbook Markdown print `Tooling: iac-gitops` / `Iac gitops`. The
  canonical tooling ids are `gitops-iac` / `backup` (`web/js/ui.js:396-403`), while
  `README.md` and `docs/getting-started.md` use `iac`/`iac-gitops` for *replication
  mechanisms*. The two vocabularies are one keystroke apart and the humanizer silently
  title-cases anything it does not recognise instead of flagging it.
- `region-pair` legend says *"red means no replication path exists today"*, but the red
  `linkStyle` is deliberately applied to the DNS "flip on failover" arrow — which has no
  replication path by definition. The legend makes it read as a problem.
- `data-replication` covers database/storage/messaging only, so **Secrets Manager is absent
  from the replication map** — the one thing the product repeatedly calls "the #1 test
  killer".
- `components.csv` has no ARN column even though components now carry ARNs.
- `POST /w/:ws/ai/answer` requires the selector nested as `{context:{kind:'workspace'}}`.
  With no context, `ask()` still shells out to `claude -p` with `cwd: process.cwd()` —
  the DR Compass repo — and the model answered by reading the source tree: *"I looked in the
  repo for a plan and found only docs and example diagrams."* A no-context question should
  not send the local CLI browsing the installation directory.
- Empty-workspace behaviour is clean: `deploy-order`, `diagrams`, `xlsx`, `bundle` and the
  exec summary all return 200 with honest "not set / not measured / no open gaps are
  recorded — either the plan is genuinely clean, or the gaps have not been written down".
  Nothing crashes. The empty `architecture` mermaid is `flowchart LR` plus classDefs and no
  nodes, which is valid but blank.

---

## How far a genuine newcomer gets

**They get all the way to a DR package — and that is the problem.** Nothing blocks them.
Every step returns 200. The failure mode is not a wall, it is a plausible-looking artifact
with fabricated numbers in it.

Concretely, the path and where it bends:

1. **First run → create workspace.** Clean. The dialog asks four things and explains each.
   The dashboard immediately tells you what to do next. **Works.**
2. **Assessment.** 21 honest low answers → "Level 0 — None". Correct and useful. But the
   roadmap it produces is wrong for their position (finding f/g), and the three "next"
   affordances on the same screen disagree. **First point of confusion, ~5 minutes in.**
3. **Discovery without credentials.** The script is excellent — genuinely read-only,
   well-commented, dual jq/python3 assembler, honest about what it does and does not capture.
   The replay was flawless (0 errors on a 56-association artifact). Proposals are rich and
   reviewable. **The best part of the product.** But it lands 7 components with no
   dependencies, no scope, and no verification commands, and it leaves no trace in the job
   log (finding m).
4. **Map dependencies.** *There is no path.* The page offers nothing for someone who has just
   imported; the only route is typing `dependsOn` by hand in the Inventory editor. **The
   first real dead end** — and the one that decides whether everything downstream is useful.
   A user who does not realise this is what "57% mapped" means will carry a broken plan
   forward.
5. **Diagrams & deployment order.** With hand-authored dependencies the order is *good* —
   guardrails → IAM → VPC → subnets/SGs → route tables/secrets → data stores → EKS →
   addons/namespaces → nodegroup/SAs/PVCs → applications → services → ingress, with
   genuinely excellent per-edge reasons. Without them, the ALB lands in wave 2 (finding 5).
   Either way the plan contains 14 items that cannot be deployed and 5 duplicated components.
6. **Runbook.** They will conclude the tool cannot write a runbook and go back to the
   template. **Second, larger disappointment.**
7. **Tests.** The honest-numbers path is the strongest thing here and works exactly as
   advertised. A failed run yields no measurement, cites the failed test by name, and refuses
   promotion. **Works, and is a genuine differentiator.**
8. **Exports.** They ship a pack whose exec summary is excellent and whose supporting files
   contain `observed 229,110,441`, a tier in the ARN column, and five identical draw.io files.
   **They will not notice until a stakeholder does.**
9. **Next day.** The dashboard is right. The Discover page tells them to scan an account
   they already scanned.

**Realistic damage point: step 4, about 20 minutes in.** Realistic *embarrassment* point:
step 8, when someone opens the workbook.

---

## What works well enough to leave alone

- **The honest-numbers contract** (`server/lib/measured.js`, `docs/measured-numbers.md`) is
  the best thing in this codebase. A failed run produced `state: "unmeasured"` with the note
  *"The last completed test (DR test #1) failed"*; the workbook labelled its 167 minutes
  *"RTA reading (NOT a measurement — run did not pass) · 167 min — time to failure, not a
  recovery time"*; the passed run carried *"The run was NOT clean… not yet a reproducible
  capability"* everywhere the number appeared. The one leak is finding 10 — fix the
  server/browser divergence and this is genuinely excellent.
- **The read-only discovery script and its replay.** Zero errors reconstructing 7 proposals
  and 45 graph nodes from a hand-built artifact, including the batch/filter merge logic for
  per-id captures. The script's safety framing (never `get-secret-value`, redact the profile
  name) is right. Do not touch this.
- **Association enrichment.** The per-proposal association trees are the most impressive
  output in the product — SG → VPC, subnet → AZ → route table → NACL, listener → certificate
  → target group, db-subnet-group → subnets, KMS. Only the SG-to-SG edge is missing (#4).
- **The deployment-order *reasons*.** Every edge carries a sentence a human can check —
  *"reads Secret aurora-app-credentials at start-up — a missing Secret leaves the pod in
  CreateContainerConfigError, which does not say 'missing secret'"*,
  *"a Service has no endpoints until a pod passes its readiness probe"*,
  *"an encrypted resource cannot be CREATED before its key exists in the region"*.
  The two-phase security-group rule step and the synthetic "Fence the old primary" gate are
  real DR expertise encoded correctly. The refusal to auto-draft a rollback, with its
  reasoning, is exactly right.
- **The executive summary (Markdown and the workbook sheet).** Both are ready to hand to a
  CFO today, modulo the numbers coming into them. The "Test history — what has actually been
  proven" section is honest about the failed run.
- **The workbook's structure** — "How to use" first, honest-numbers rule restated as hard
  rules, grouped rows, derived Status column, DR strategy reference. Nothing needed
  explaining to me.
- **Empty and degraded states.** Every endpoint on a zero-component workspace returned 200
  with a sentence explaining the emptiness rather than a blank or a crash. `mountOptional`'s
  scoped 501 fallback is thoughtful.
- **The AI path, once given context.** One correctly-shaped call returned a sharper answer
  than most of my own findings: it named the right blocker, explained the L6 failure mode,
  spotted that the inventory has no third-party component for the card network, spotted the
  empty `componentId` on the gap, and questioned whether the passed test's success bar
  actually exercised the partner call. That is real value.

---

## Verdict

**Not yet ready for someone other than its author — but much closer than that sounds.**

The architecture is sound and the DR judgement encoded in it is better than most commercial
tools. What is missing is the pass that only a first user can force: the seed workspace has
been the only workspace, and it happens to have `dependsOn` hand-authored, no load balancer,
no `arn` field, and caches rather than queues as its `rebuild` stores. Four of the ten
problems above exist purely because of those four accidents.

Three things gate readiness, in order:

1. **Stop emitting numbers you did not measure.** Fix the `count`→`bytes` mapping, or refuse
   to print `(N×)` unless the mapped column is genuinely a count. A DR tool whose entire
   pitch is "honest numbers" cannot ship `observed 229,110,441` into an audit pack.
2. **Give the discovery-only user a dependency path.** Walk `UserIdGroupPairs`, use the
   resource graph's target-group/subnet reach, and offer "infer dependencies from the graph"
   on the Discover page. Right now foundation #3 of five has no route through the product.
3. **Make the generated runbook executable, or stop calling it a runbook.** Commands, owners
   and estimates are all hard-coded empty. Either derive them (from the component's
   verification command, the tooling, the restore layer) or rename the output to what it
   actually is — an ordered checklist — and say so in the docs.

After that: the `elb` rule-table entry, the ARN column, the per-diagram draw.io, the
duplicated items, and the server/browser `coversDirectly` divergence are all small, local
fixes. None of them are architectural.

---

*Generated 2026-09-17 from a single end-to-end run on an isolated data directory. No real
AWS account, Kubernetes cluster or Arpio tenant was contacted. Two AI calls were made against
the local `claude` CLI. No source file was modified.*
