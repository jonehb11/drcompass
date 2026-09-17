# 🧭 DR Compass

**A local-first disaster-recovery planning studio for AWS multi-region DR:
inventory, dependencies, recovery order, diagrams, runbooks, tests and exports.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Disaster recovery is a program, not a project — and a plan that has never been
executed is a hypothesis, not a plan. What makes DR real over time are three
durable artifacts: a **dependency inventory** that reflects what actually runs, a
**runbook** someone other than its author can execute, and a **test record** with
honest, measured numbers.

DR Compass keeps those three true. It runs entirely on your machine, stores
everything as plain JSON, and derives everything else — diagrams, a computed
recovery order, runbooks, checklists, a spreadsheet workbook — from that JSON on
demand.

```sh
brew tap jonehb11/drcompass https://github.com/jonehb11/drcompass
brew install jonehb11/drcompass/drcompass
drcompass
```

## What it assumes

**An AWS account, and nothing else.** No agent, no SaaS account, no sign-up, no
network egress from the app itself.

The mechanisms it plans around are the ones you already have: Aurora Global
Database, DynamoDB global tables, S3 Cross-Region Replication, ECR replication
rules, Secrets Manager replica secrets, KMS multi-Region keys, AWS Backup
cross-region copy, and an IaC rebuild for everything that is shape rather than
bytes. Orchestration tools sit alongside as **peer options, not prerequisites**:
AWS ARC Region Switch, Route 53 ARC routing controls, AWS Elastic Disaster
Recovery, a GitOps/IaC region flip, or a third-party environment-recovery product
such as Arpio. Pick per component, record the choice with an honest RPO, and the
tool plans around whatever you picked.

Optional, only if you have them: your `aws` CLI (discovery), your `kubectl`
(cluster snapshot), a firewall or flow-log export (egress), and the Claude Code
CLI (the AI layer). Each is additive; none is required.

## What's in it

**Inventory** by category, with dependencies, outbound third-party calls, AWS
services, secrets, endpoints and a verification command per component ·
**Assessment** — six pillars, a 0–5 maturity level, ranked next actions ·
**Service profile** — one service's whole story, weak links first ·
**Deployment order** — computed recovery waves with a reason on every item ·
**Diagrams** — Mermaid plus a draggable icon canvas with official AWS /
Kubernetes / CNCF icons and saved layouts · **Runbooks** with gated, layered
steps and rollback, generatable from the deployment order and checkable against
it · **Tests & game days** with T0/T1 timestamps and measured RTA/RPA ·
**Checklists** where every item has a *why* and a *proof* · **Discovery** from
your AWS account, a Kubernetes cluster, a flow-log export or Arpio ·
**AI copilot** (`Cmd/Ctrl+K`) via your local Claude Code CLI, review-before-apply ·
**Exports** · a built-in **DR field guide** of 16 articles.

A tour of every page: [docs/getting-started.md](docs/getting-started.md).

## What it produces

Real output from the bundled example workspace lives in
[`docs/examples/`](docs/examples/):

- **[An executive one-pager](docs/examples/executive-summary.md)** — what is
  covered, the honest numbers, the top risks with owners, the test history, the
  next actions. The artifact you take to a review.
- **[Diagrams](docs/examples/diagrams.md)** generated from the inventory —
  architecture, dependency graph, restore layer cake, data replication map,
  failover sequence, region pair, resource maps, Kubernetes namespaces,
  deployment-order waves. Rendered live in the app; downloadable as Mermaid, SVG,
  PNG and [draw.io XML with official AWS shapes](docs/examples/architecture.drawio).
- **[A 10-sheet Excel workbook](docs/examples/workbook-structure.md)** spined on
  recovery order, print-ready and Google-Sheets-ready, for everyone who lives in
  spreadsheets.
- **Runbooks** as Markdown plus a terminal-friendly quick-ref, **12 CSVs**, and a
  one-click **DR package** zip scoped to a single service and its full dependency
  closure.

## The honest-numbers rule

RTO and RPO are targets. RTA and RPA are measurements. DR Compass will not let
you confuse them.

> **A number is evidence only when a test that *passed* produced it.** RTA is
> T1 − T0, where T1 is the moment the functional success bar passes. A test that
> did not pass never reached it, so it has no RTA — only a time to failure.

A number you type by hand is *declared*, and every screen and export says so, in
neutral styling, next to the number. A passed test's number carries its
provenance — test id, name, date — and goes stale after 180 days. A test measures
a component only when it actually names it; sharing a runbook with a sibling
service does not count.

This matters because the alternative is what most DR dashboards do: show a target
in green and let everyone believe it was achieved. The bundled example workspace
is a regression test for this — its last test failed, and you can watch every
surface report its numbers as declared rather than measured.

## How it decides things

Two places where the product makes a claim a practitioner should be able to
audit. Both are documented rather than buried:

- **[docs/measured-numbers.md](docs/measured-numbers.md)** — what counts as
  evidence, how a test is said to *cover* a component, how every risk severity is
  decided, and the exact words each state is allowed to be rendered with.
- **[docs/deployment-order.md](docs/deployment-order.md)** — how recovery order
  is computed (declared dependencies, discovered graph edges read directionally,
  then type rules as a soft floor), why pods are the hard part, and what it
  refuses to guess.

If you disagree with an answer, those two files tell you which rule produced it.

## What it will not do

- **It will not fail anything over.** DR Compass is read-only against your
  infrastructure. It never mutates an AWS account or a cluster, and it has no
  execution mode. Discovery issues `describe` / `list` / `get` calls and nothing
  else; the Kubernetes scanner hard-refuses any `kubectl` invocation that is not
  `get` (plus the two `config` reads it needs to list your contexts).
- **It will not invent numbers.** No estimated RTOs, no plausible-looking
  schedules. A deployment-order item carries a time estimate only when a runbook
  step in your own workspace names exactly that component; otherwise it says so.
- **It will not write to your inventory on its own.** Everything discovery and
  the AI produce arrives as proposals you review and approve, item by item.
- **It will not store your credentials.** AWS discovery shells out to your local
  `aws` CLI and only ever sees the resulting identity metadata. An Arpio key is
  used for the one request you make and never written to disk. The AI shells out
  to your local `claude` CLI, under your own account.
- **It will not phone home.** Nothing is sent anywhere by the app.
- **It is not multi-cloud, and not a monitoring tool.** AWS and Kubernetes today.
  It plans and records; it does not watch.

## Install

### Homebrew (macOS / Linux)

The GitHub repo is named `drcompass` (not `homebrew-drcompass`), so the tap must
be added with an explicit URL — Homebrew only infers the repository location for
taps named `homebrew-*`:

```sh
brew tap jonehb11/drcompass https://github.com/jonehb11/drcompass
brew install jonehb11/drcompass/drcompass
```

### npm (global, from git)

```sh
npm install -g github:jonehb11/drcompass
```

### From source

```sh
git clone https://github.com/jonehb11/drcompass.git
cd drcompass
npm install
npm start          # starts the server without opening a browser
```

## Usage

```sh
drcompass          # start the studio and open http://localhost:4517
```

| Command | What it does | Flags |
| --- | --- | --- |
| `drcompass` / `drcompass start` | Start the UI on localhost (default port 4517) and open your browser. Seeds the example workspace on first run | `-p, --port <port>` · `--no-open` · `--dir <path>` (data directory, overrides `~/.drcompass`) |
| `drcompass init <slug>` | Create a new empty workspace | `--name <name>` |
| `drcompass list` | List workspaces (slug, tab, name) | |
| `drcompass export <slug>` | Write the workbook to an `.xlsx` file | `--xlsx <path>` (default `dr-compass-export.xlsx`) |
| `drcompass --version` · `--help` | | |

**Environment:** `DRCOMPASS_PORT` (default 4517) · `DRCOMPASS_HOME` (default
`~/.drcompass`). `init`, `list` and `export` read the same data directory as
`start`, so set `DRCOMPASS_HOME` for all of them or none.

## Quickstart

1. **Explore the example workspace.** First launch seeds `example-acme`, a
   fictional pharmacy-claims platform mid-flight: a full Tier-0 inventory, a
   resource graph, a Kubernetes snapshot, a runbook, tests and real gaps. Its
   data comes across on AWS-native replication and its platform is rebuilt from
   IaC, with two components left on a third-party recovery tool so you can see
   both models — and their very different RPO stories — side by side.
2. **Run the assessment.** Answer the questions, get a maturity level and the
   next actions that matter most for you.
3. **Build your inventory.** Add components by category, or use **Discover** to
   propose them from your AWS account, a Kubernetes cluster, a flow-log export,
   or your local Claude Code CLI. Give every stateful component a replication
   mechanism and an honest RPO — "rebuild cold" is a legitimate answer; a blank
   field is not.
4. **Read the deployment order**, then generate a runbook from it and check the
   runbook back against it.
5. **Plan your first recovery test.** Record T0/T1, get measured RTA/RPA, turn
   findings into gaps.

## Screenshots

**There are none yet.** UI screenshots are pending — the artifacts in
[`docs/examples/`](docs/examples/) are real exported output instead, produced by
the commands listed in that folder's README. Run `drcompass` if you want to see
the pages; the example workspace is already there.

## Architecture

Node >= 18, Express, and a vanilla ES-module SPA — no build step, no bundler, no
TypeScript, five runtime dependencies. Workspaces are folders of plain JSON
files, which makes them diff-able and git-versionable: run
`drcompass start --dir ./dr-data` inside a repo and commit your DR plan alongside
your infrastructure code.

[SPEC.md](SPEC.md) is the contract — storage layout, schemas, the full REST API,
and the frontend conventions.

## Documentation

- [Getting started](docs/getting-started.md) — install, first launch, and a tour of every page
- [Running a DR program](docs/dr-program-guide.md) — a quarter-long, week-by-week arc
- [Integrations](docs/integrations.md) — AWS CLI and SSO, the read-only discovery script, Kubernetes, flow-log import, Arpio, the Claude Code CLI, Lucidchart, draw.io, Google Sheets
- [Measured numbers](docs/measured-numbers.md) · [Deployment order](docs/deployment-order.md) — the two contracts
- [Domain validation](docs/DR-VALIDATION.md) — a senior-DR-architect review of the guidance this tool gives, findings and all. The fixes it drove are in the [changelog](CHANGELOG.md#030--2026-09-16)
- [Examples](docs/examples/) — real generated output
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Icon credits](ICON-CREDITS.md)

## Roadmap ideas

- Import from Terraform/CloudFormation state to seed the inventory
- Scheduled test reminders and a DR-program calendar view
- Runbook execution mode with live timestamp capture during a test
- Diff view between two test records ("did we get faster?")

## License

[MIT](LICENSE) © 2026 Jonathan Baugham
