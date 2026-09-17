# Getting started with DR Compass

This guide takes you from install to a working DR plan, page by page, in the
order a new DR owner should work.

## Install

Pick one:

```sh
# Homebrew (repo isn't named homebrew-*, so the URL is required)
brew tap jonehb11/drcompass https://github.com/jonehb11/drcompass
brew install jonehb11/drcompass/drcompass

# npm, global, from git
npm install -g github:jonehb11/drcompass

# From source
git clone https://github.com/jonehb11/drcompass.git
cd drcompass && npm install && npm start
```

Requires Node >= 18 (Homebrew installs its own).

## First launch

```sh
drcompass
```

The server starts on `http://localhost:4517` and opens your browser
(`--no-open` to skip, `-p` to change the port). On first run DR Compass seeds
an example workspace, **example-acme** — a fictional pharmacy-claims platform
with a complete inventory, runbooks, tests, checklists, and gaps. Browse it
first: it's the fastest way to see what a plan in flight looks like.

Its recovery mechanisms are deliberately the ones you can use on day one
without buying anything: an Aurora Global Database for the claims system of
record, AWS Backup cross-region copies for reference data, S3 Cross-Region
Replication for objects, ECR replication rules for images, Secrets Manager
replica secrets, KMS multi-Region keys, rebuilt caches, and a Terraform/GitOps
rebuild for everything that is shape rather than bytes. Two components are
deliberately left on a third-party recovery tool (Arpio), because the contrast
is the lesson: continuous native replication gives you a *current* copy, while
snapshot-based point-in-time recovery gives you a *consistent moment* — which
in the example's last test turned out to be 118 minutes old.

All data is plain JSON under `~/.drcompass/workspaces/<slug>/`. Use
`drcompass start --dir <path>` (or `DRCOMPASS_HOME`) to keep it in a git repo
instead.

Create your own workspace with the **＋** button next to the workspace
switcher in the sidebar, or from the terminal:

```sh
drcompass init my-platform --name "My Platform"
```

## A tour of every page

Work through the pages roughly in this order.

### 1. Dashboard

Your at-a-glance state: objectives (RTO/RPO targets vs. measured RTA/RPA),
inventory coverage, open gaps by severity, and recent tests. Early on it will
mostly show you what's missing — that's the point. Come back here weekly.

### 2. Where am I? (assessment)

Answer a short questionnaire across six pillars — inventory, data, runbooks,
testing, observability, governance. You get a per-pillar score, an overall
maturity level from 0 (none) to 5 (production-proven), and a ranked list of
next actions. Do this before anything else: it tells you where to start, and
re-taking it each month is your progress meter.

### 3. Inventory

The heart of the tool. Add every component that matters for recovery, one per
category (compute, networking, storage, database, messaging/streaming,
security/secrets, edge/DNS, identity/access, observability, third-party,
CI/CD control plane). For each component capture:

- **replication mechanism and RPO** — how the bytes (or the shape) actually
  get to the recovery region: `aurora-global`, `dynamodb-global-tables`,
  `s3-crr`, `ecr-replication`, `secrets-manager-replica`, `aws-backup-copy`,
  `multi-region-keys`, `iac`/`iac-gitops` for anything rebuilt from code,
  `rebuild` for caches, or a named third-party tool where you use one. "Rebuild
  cold" is a legitimate answer; a blank field on Tier-0 state is a gap
- **dependencies** (`dependsOn`) — what must be up before this can be
- **outbound calls** — especially third-party and SaaS calls, with their
  failover behavior (these are the classic game-day surprises)
- **AWS services and secrets** it uses, and whether secrets are replicated
- **restore layer** (L0 guardrails → L7 live cutover) and DR strategy
- **in recovery scope?** — yes / no / partial / unknown; "unknown" is a gap
- a **verification command** — how you'd prove it's healthy in the recovery
  region

Don't aim for completeness on day one. Tier-0 components first, dependencies
second, everything else as you learn. The **Discover** page (below) can
propose components for you.

### 4. Diagrams

Generated straight from the inventory — nothing to draw or keep in sync:
architecture, dependency graph, restore layer cake, failover sequence, region
pair, and data replication, plus per-component dependency views. Each renders
as Mermaid in the app; download draw.io XML or copy the Mermaid source for
Lucidchart. If a diagram looks wrong, fix the inventory, not the diagram.

### 5. Runbooks

Build the document someone else executes at 3 a.m. Start from a template and
adapt. The templates are peers, not a ranking — pick the one that matches how
your estate actually comes back: GitOps/IaC failover, AWS ARC Region Switch,
AWS Elastic Disaster Recovery, a game day, or third-party environment recovery
(Arpio). Steps are ordered by restore layer, and each
has a verify command, a pass criterion, an owner, a time estimate, and
optionally a **gate** (stop and check before proceeding). Include rollback
steps — a failover you can't back out of is a one-way door. Runbooks export
as Markdown from the Exports page.

### 6. Tests & game days

Plan and record recovery tests, game days, tabletops, component tests, and
chaos experiments. Each test links to a runbook, carries a catalog of
app-level tests ("claim adjudication returns a claim_id"), and records
T0 / first-access / T1 timestamps — from which DR Compass computes your
**measured RTA and RPA**. Findings become entries in the gap list. The test
record is the artifact that turns your plan from hypothesis into evidence.

### 7. Checklists

Phase 0 (things that must be green before any recovery launch), pre-flight,
game-day, and weekly hygiene checklists, plus custom ones. Each item has a
"why" and a "proof" field — a checklist item you can't prove is a wish.

### 8. Discover

Ways to feed the inventory instead of typing it. Discover opens on **Start
here**, which asks one question — *how do you want to find your resources?* —
and gives you paths worded by the access you actually have, each stating what it
needs and what it gives you:

- **"I have AWS access on this machine"** → scans the account through your own
  `aws` CLI profile and maps each resource's dependencies. 1–5 minutes.
- **"I can't run AWS credentials here"** → downloads a read-only bash script you
  run somewhere else (a jump host, a build box); you upload the JSON it writes
  and get the same reviewable proposals.
- **"I have a Kubernetes cluster"** → snapshots namespaces, workloads, services
  and ingresses via your own `kubectl`, and links workloads to components.
- **"I have a firewall / flow-log export"** → a CSV/TSV of who talked to whom
  becomes outbound calls on your components. The file is parsed in your browser
  and never uploaded.
- **"I already protect things with Arpio"** → optional, for estates that use
  that third-party DR product: imports what Arpio protects using a read-only
  API key, then maps dependencies for *exactly those* resources — no
  account-wide scan. Nothing else in DR Compass depends on it.
- **"I'd rather talk it through first"** → asks your local Claude Code CLI
  (`claude -p`) what the plan is missing, optionally with your workspace as
  context; its suggestions come back as importable proposals.

Once the workspace has components, **Start here** becomes a short *what's next /
what's stale* list instead, and a **status strip** sits above the tabs at all
times: components in inventory, resources mapped in the graph, resources still
needing review, the Kubernetes snapshot and its age, outbound calls learned from
flow data, and the last run of every source. Each number has an action next to
it, so a returning user can see what's already done without re-running anything.

The underlying tabs are still there — **Start here · AWS account · Kubernetes ·
Network flows · Arpio · Ask AI** — and every deep link still works:
`#/<workspace>/discover/aws`, `/k8s`, `/network`, `/arpio`, `/ai`, plus the new
`/start`. A second segment jumps to one card, e.g.
`#/<workspace>/discover/aws/tag` opens "Find resources by tag".

Two things got plainer names (the old ones are kept in the glossary tooltips and
in the text of each card, because other pages and older docs still use them):
**"deep enrichment" is now "Map dependencies"**, and **"correlate by tag" is now
"Find resources by tag"**. Advanced knobs — which services to scan, which
components to map, extra tag filters, manual column mapping for a flow export —
are folded behind **Advanced** disclosures with the sensible default shown.

Every action states its outcome before you click it ("Reads your account and
proposes components — nothing is imported until you review it. Read-only.
Usually 1–5 minutes."), every result appears next to the button that produced it
and ends with an explicit next step, and long runs continue server-side if you
refresh or navigate away. Everything arrives as *proposals* you review and
accept — discovery never writes to your inventory behind your back. Details and
required permissions: [integrations.md](integrations.md).

### 9. Exports

One-click Excel workbook of the whole workspace (opens cleanly in Google
Sheets), per-sheet CSVs, runbooks as Markdown, and a full bundle. This is how
the plan reaches auditors, leadership, and spreadsheet-native stakeholders.

### 10. Learn DR

The built-in field guide: where to start, DR fundamentals, the two problems
every DR program must solve, and public case studies. Short reads designed
for the moments the tool raises a question ("what's a restore layer cake?").

### 11. Settings

Workspace metadata: name and org, primary/recovery regions, RTO/RPO
objectives (and whether they're formally approved), overall strategy
(backup-restore, pilot light, warm standby, active-active), and tooling in
play. Tooling is a list, not a choice of vendor: tick GitOps/IaC, AWS Region
Switch, ARC routing controls, Elastic Disaster Recovery, AWS Backup, Resilience
Hub and/or Arpio, in whatever combination is true for you — it only affects
which runbook templates and recommendations are surfaced. Set objectives early
— every dashboard number is relative to them.

## Next step

Read [Running a DR program](dr-program-guide.md) for the quarter-long,
week-by-week arc that puts these pages in sequence.
