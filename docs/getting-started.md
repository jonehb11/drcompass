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
first: it's the fastest way to see what a finished plan looks like.

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

Build the document someone else executes at 3 a.m. Start from a template
(Arpio failover, AWS ARC Region switch, GitOps/IaC failover, Elastic Disaster
Recovery, game day) and adapt. Steps are ordered by restore layer, and each
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

Three ways to feed the inventory instead of typing it:

- **AWS** — scans your account via your local `aws` CLI and profiles and
  proposes components. Read-only; nothing is modified.
- **Arpio** — imports protected resources using a read-only Arpio API key.
- **AI** — asks your local Claude Code CLI (`claude -p`) to help, optionally
  with your workspace as context.

Everything arrives as *proposals* you review and accept — discovery never
writes to your inventory behind your back. Details and required permissions:
[integrations.md](integrations.md).

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
play. Set objectives early — every dashboard number is relative to them.

## Next step

Read [Running a DR program](dr-program-guide.md) for the quarter-long,
week-by-week arc that puts these pages in sequence.
