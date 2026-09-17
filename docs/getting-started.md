# Getting started with DR Compass

From install to a working DR plan, page by page, in the order a new DR owner
should work.

## Install

Pick one:

```sh
# Homebrew (the repo isn't named homebrew-*, so the URL is required)
brew tap jonehb11/drcompass https://github.com/jonehb11/drcompass
brew install jonehb11/drcompass/drcompass

# npm, global, from git
npm install -g github:jonehb11/drcompass

# From source
git clone https://github.com/jonehb11/drcompass.git
cd drcompass && npm install && npm start
```

Requires Node >= 18 (Homebrew installs its own). There is no build step.

## First launch

```sh
drcompass
```

The server starts on `http://localhost:4517` and opens your browser (`--no-open`
to skip, `-p <port>` to change the port). On first run it seeds an example
workspace, **example-acme** — a fictional pharmacy-claims platform with a
complete inventory, a resource graph, a Kubernetes snapshot, a runbook, tests,
checklists and gaps. Browse it first: it is the fastest way to see what a plan in
flight looks like.

Its recovery mechanisms are deliberately the ones you can use on day one without
buying anything: an Aurora Global Database for the claims system of record, AWS
Backup cross-region copies for reference data, S3 Cross-Region Replication for
objects, ECR replication rules for images, Secrets Manager replica secrets, KMS
multi-Region keys, rebuilt caches, and a Terraform/GitOps rebuild for everything
that is shape rather than bytes. Two components are deliberately left on a
third-party recovery tool (Arpio), because the contrast is the lesson:
continuous native replication gives you a *current* copy, while snapshot-based
point-in-time recovery gives you a *consistent moment* — which in the example's
last test turned out to be 118 minutes old.

**The example's last test is recorded as failed, on purpose.** Watch how every
screen reports its RTA and RPA as *recorded by hand*, never as *measured*. That
is the product's central rule working; see
[measured-numbers.md](measured-numbers.md).

All data is plain JSON under `~/.drcompass/workspaces/<slug>/`. Use
`drcompass start --dir <path>` (or the `DRCOMPASS_HOME` environment variable) to
keep it in a git repo instead.

Create your own workspace with the **＋** button next to the workspace switcher
in the sidebar, or from the terminal:

```sh
drcompass init my-platform --name "My Platform"
```

## A tour of every page

The sidebar is grouped by the question each group answers. Work down it.

### Overview

Where you stand, in one screen: your maturity level, the recovery-time and
data-loss numbers **with their provenance** (measured / recorded by hand /
not measured yet), what is blocking you, what to do next, recent tests, and
readiness by restore layer. Early on it will mostly show you what is missing —
that is the point. Come back weekly.

A **Start here** card sits on top until the five foundations (assess, inventory,
map dependencies, draft a runbook, run a test) are done; it shrinks to a progress
strip as you go and disappears when you finish. It is driven by your data, not by
a "dismiss" button.

---

### 1 · Where you stand → Assessment

A short questionnaire across six pillars — inventory, data, runbooks, testing,
observability, governance. You get a per-pillar score, an overall maturity level
from 0 (none) to 5 (production-proven), and a ranked list of next actions.
Answers save automatically; there is no Save button.

Do this before anything else: it tells you where to start, and re-taking it each
month is your progress meter. The score is deliberately hard to inflate — it
divides by the *total* questions rather than the ones you answered, caps below
80 % completeness, and will not award a high level on evidence that has gone
stale.

---

### 2 · What you have → Inventory

The heart of the tool. Add every component that matters for recovery, one per
category (compute, networking, storage, database, messaging/streaming,
security/secrets, edge/DNS, identity/access, observability, third-party, CI/CD
control plane). For each component capture:

- **replication mechanism and RPO** — how the bytes (or the shape) actually get
  to the recovery region: `aurora-global`, `dynamodb-global-tables`, `s3-crr`,
  `ecr-replication`, `secrets-manager-replica`, `aws-backup-copy`,
  `multi-region-keys`, `iac`/`iac-gitops` for anything rebuilt from code,
  `rebuild` for caches, or a named third-party tool where you use one. "Rebuild
  cold" is a legitimate answer; a blank field on Tier-0 state is a gap
- **dependencies** (`dependsOn`) — what must be up before this can be
- **outbound calls** — especially third-party and SaaS calls, with their failover
  behaviour (these are the classic game-day surprises)
- **AWS services and secrets** it uses, and whether each secret is replicated
- **restore layer** (L0 guardrails → L7 live cutover) and DR strategy
- **in recovery scope?** — yes / no / partial / unknown; "unknown" is a gap
- a **verification command** — how you would prove it is healthy in the recovery
  region

A banner above the table tells you how many components have no verification
command and how many have no restore layer, with a button to filter to exactly
those. The **Dependency explorer** tab shows, for any component, what must come
back first and what breaks without it.

Don't aim for completeness on day one. Tier-0 components first, dependencies
second, everything else as you learn. **Discover** (below) can propose components
for you.

### Service profile

One service at a time, and the page to open when someone asks "what happens to
*X* if we lose the region?". It answers, in order: what it needs to come back
(ordered by restore layer, with the weak links called out), what it is attached
to, who it talks to, how it is recovered, what is in the way, its Kubernetes
workloads, and its diagram inline.

The risk list is de-duplicated and ranked by what actually blocks recovery, so it
does not become wallpaper. From here you can download a **scoped DR package** —
that service plus its entire dependency closure — or jump to its deployment
order.

### Discover

Ways to feed the inventory instead of typing it. Discover opens on **Start
here**, which asks one question — *how do you want to find your resources?* — and
offers paths worded by the access you actually have:

- **"I have AWS access on this machine"** → scans the account through your own
  `aws` CLI profile and maps each resource's dependencies. 1–5 minutes.
- **"I can't run AWS credentials here"** → downloads a read-only bash script you
  run somewhere else (a jump host, a build box); upload the JSON it writes and
  get the same reviewable proposals.
- **"I already protect things with a third-party tool (Arpio)"** → imports what
  Arpio protects using a read-only API key, then maps dependencies for *exactly
  those* resources.

Also available: **Kubernetes** (snapshots namespaces, workloads, services,
ingresses, PVCs and HPAs via your own `kubectl`), **Network flows** (a
firewall/flow-log export becomes outbound calls — parsed in your browser, never
uploaded), and **Ask AI** (your local Claude Code CLI, asked what the plan is
missing).

Once the workspace has components, **Start here** becomes a *what's next / what's
stale* list, and a **status strip** sits above the tabs: components in inventory,
resources mapped, resources still needing review, the Kubernetes snapshot and its
age, outbound calls learned from flow data, and the last run of every source.

The tabs are **Start here · AWS account · Kubernetes · Network flows · Arpio ·
Ask AI**. Clicking a tab does not change the URL, but deep links work:
`#/<workspace>/discover/aws`, `/k8s`, `/network`, `/arpio`, `/ai`, `/start`. A
second segment jumps to one card, e.g. `#/<workspace>/discover/aws/tag` opens
"Find resources by tag".

Every action states its outcome before you click it ("Reads your account and
proposes components — nothing is imported until you review it. Read-only.
Usually 1–5 minutes."), results appear next to the button that produced them and
end with an explicit next step, and long runs continue server-side if you refresh
or navigate away. **Everything arrives as proposals you review and accept —
discovery never writes to your inventory behind your back.** Details and required
permissions: [integrations.md](integrations.md).

### Diagrams

Generated straight from the inventory, the resource graph and the Kubernetes
snapshot — nothing to draw or keep in sync. Architecture, dependency graph,
restore layer cake, failover sequence, region pair, data replication, per-component
dependencies, the resource map, per-namespace Kubernetes views, deployment-order
waves and per-service startup dependencies.

Two views: **Mermaid** (the text-rendered diagram, with *Copy Mermaid*,
*Copy for Lucidchart* and `.mmd` / `.drawio` / `.svg` downloads) and **Icon
canvas** (official AWS / Kubernetes / CNCF icons, draggable, with saved layouts
per diagram, SVG and PNG export, and a draw.io download that uses the official
AWS shape library). The toggle only appears for diagrams that support both.

On the canvas, **⊕ a component** to fan out its discovered security groups,
subnets, IAM roles and more, right where it sits. Clicking any node opens a
detail drawer.

If a diagram looks wrong, fix the inventory, not the diagram.

---

### 3 · How it comes back → Deployment order

Most DR plans list *what* must come back. This page works out **what order** —
waves that can be built in parallel, with a plain-language reason on every item
("reads secret `adjudication/db-password` at startup", "has no healthy targets
until pods are Ready, not merely created"). It is computed from your inventory,
resource graph and Kubernetes snapshot, so it changes when your system does.

Scope it to one service or the whole workspace, then generate a gated runbook
straight from it. Cycles, unorderable items and unsafe startup calls are reported
rather than hidden. How the order is derived, and what it deliberately refuses to
guess: [deployment-order.md](deployment-order.md).

### Runbooks

Build the document someone else executes at 3 a.m. Start from a template and
adapt — the templates are peers, not a ranking: GitOps/IaC failover, AWS ARC
Region Switch, AWS Elastic Disaster Recovery, a game day, or third-party
environment recovery (Arpio). Or press **Generate from deployment order** and
turn the computed waves into gated steps.

Each step has a layer, a verify command, a pass criterion, an owner, a time
estimate, optional `componentIds`, and optionally a **gate** (stop and check
before proceeding). Include rollback steps — a failover you cannot back out of is
a one-way door.

**Check against deployment order** takes an existing runbook and flags steps that
restore something before its prerequisites. Runbooks export as Markdown and as a
terminal quick-ref from the Exports page.

Listing a component on a step is not cosmetic: it is one of the three ways a test
can be said to *cover* that component, which is what lets a passed test produce
a measured number for it.

### Checklists

Phase 0 (things that must be green before any recovery launch), pre-flight,
game-day and weekly hygiene checklists, plus custom ones. Each item has a "why"
and a "proof" field — a checklist item you cannot prove is a wish. A checklist
prints cleanly for the day of the exercise.

---

### 4 · Proof it works → Tests

Plan and record recovery tests, game days, tabletops, component tests and chaos
experiments. Each test links to a runbook, carries a catalog of app-level checks
("claim adjudication returns a `claim_id`"), and records T0 / first-access / T1
timestamps — from which DR Compass computes your **measured RTA and RPA**.
Findings become entries in the gap list.

The **Record as this workspace's measured numbers** button is deliberately
disabled for any run that did not pass, and when it does fire it writes the
test's identity alongside the digits. A failed run has a time to failure, not a
recovery time.

The test record is the artifact that turns your plan from hypothesis into
evidence.

### Exports

Turn the workspace into artifacts you can hand over. The primary action is a
**DR package** — a zip for one service (plus its full dependency closure) or the
whole workspace, containing an executive one-pager, the Excel workbook, diagrams
as SVG / draw.io / Mermaid, runbooks as Markdown plus a terminal quick-ref, CSVs
and a cover README. The zip is assembled in your browser.

Individually: the **workbook** (10 sheets, spined on recovery order, opens
cleanly in Google Sheets), the **executive summary** as Markdown, **12 CSVs**,
per-runbook Markdown and quick-ref, and a standalone diagram pack.

See [`examples/`](examples/) for real output from the example workspace.

---

### Setup & learning → Learn

The built-in field guide, 16 articles across *Start here*, *Strategies*,
*Tooling*, *Running the program* and *Case studies*. Short reads designed for the
moments the tool raises a question ("what's a restore layer cake?"), with an
AI button to ask how each one applies to your own stack.

### Settings

Workspace metadata: name and org, primary/recovery regions, RTO/RPO objectives
(and whether they are formally approved), the hand-recorded RTA/RPA fields with
their provenance shown next to them, overall strategy (backup-restore, pilot
light, warm standby, active-active) and the tooling in play.

Tooling is a **list, not a vendor choice**: tick GitOps/IaC, AWS Region Switch,
ARC routing controls, Elastic Disaster Recovery, AWS Backup, Resilience Hub
and/or Arpio, in whatever combination is true for you. It only affects which
runbook templates and recommendations are surfaced.

Set objectives early — every dashboard number is relative to them.

---

## Keyboard

| Key | What it does |
| --- | --- |
| `Cmd/Ctrl + K` | open or close the AI copilot drawer |
| `Cmd/Ctrl + Enter` | send the copilot message |
| `Esc` | close the copilot, a node drawer, a canvas popover, or clear a selection |

## Next step

Read [Running a DR program](dr-program-guide.md) for the quarter-long,
week-by-week arc that puts these pages in sequence.
