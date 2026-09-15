# 🧭 DR Compass

**The disaster recovery planning studio — inventory, dependencies, diagrams, runbooks, tests, and exports for AWS multi-region DR.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Disaster recovery is a program, not a project — and a plan that has never been
executed is a hypothesis, not a plan. What makes DR real over time are three
durable artifacts: a **dependency inventory** that reflects what actually runs,
a **runbook** that someone other than its author can execute, and a **test
record** with honest, measured numbers. DR Compass is a local-first studio for
keeping those three artifacts true: it runs entirely on your machine, stores
everything as plain JSON, and turns your inventory into diagrams, runbooks,
checklists, and spreadsheet exports on demand.

## Features

- 📦 **Inventory by category** — compute, networking, storage, database,
  messaging/streaming, security/secrets, edge/DNS, identity/access,
  observability, third-party, CI/CD control plane — with per-component
  dependencies, outbound third-party calls, AWS services, secrets, endpoints,
  and verification commands.
- 🧭 **Maturity assessment** ("Where am I?") — six pillars, a 0–5 maturity
  level, and a prioritized list of next actions that tells you where to start.
- ◈ **Auto-generated diagrams** — architecture, dependency graph, restore
  layer cake, failover sequence, region pair, and data replication — rendered
  as Mermaid in the UI and downloadable as draw.io XML; Lucidchart-friendly.
- ▣ **Icon canvas** — a draggable AWS-icon view of the same diagrams with
  per-diagram saved layouts, SVG/PNG export, and a draw.io download that uses
  the official AWS shape library (see [Integrations](docs/integrations.md)
  for icon credits).
- ☰ **Runbook builder** — layered, gated steps with verify/pass criteria and
  timestamps to record, plus templates for Arpio, AWS ARC Region switch,
  GitOps/IaC failover, Elastic Disaster Recovery, and game days.
- ⏱ **Test & game-day planner** — per-app test catalogs, T0/T1 timestamps
  that yield *measured* RTA/RPA, and findings that flow into a gap list.
- ☑ **Checklists** — Phase 0 (before any launch), pre-flight, game day, and
  weekly hygiene, each item with a "why" and a proof.
- ⇩ **One-click exports** — an Excel workbook (Google-Sheets-ready), per-sheet
  CSVs, and runbooks as Markdown.
- 🔍 **Discovery** — scan your AWS account using your local AWS CLI
  credentials, import from an Arpio read-only API key, or ask your local
  Claude Code CLI to help fill in the blanks.
- ✦ **AI copilot** — press `Cmd/Ctrl+K` on any page and tell your local
  Claude Code CLI what to change ("add a DynamoDB sessions table the checkout
  service depends on", "draft a game-day checklist for next month"). It
  proposes concrete edits to your inventory, runbooks, gaps, and checklists;
  you review each one and apply with a click. Nothing changes without your
  approval.
- ◆ **Built-in DR field guide** — a Learn section with DR fundamentals and
  public case studies, readable inside the app.

## Install

### Homebrew (macOS / Linux)

The GitHub repo is named `drcompass` (not `homebrew-drcompass`), so the tap
must be added with an explicit URL — Homebrew only infers the repository
location for taps named `homebrew-*`:

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

### CLI reference

| Command | What it does | Flags |
| --- | --- | --- |
| `drcompass` / `drcompass start` | Start the UI on localhost (default port 4517) and open your browser | `-p, --port <port>` · `--no-open` · `--dir <path>` (workspace data directory, overrides `~/.drcompass`) |
| `drcompass init <slug>` | Create a new empty workspace | `--name <name>` |
| `drcompass list` | List workspaces | |
| `drcompass export <slug>` | Export a workspace workbook to `.xlsx` | `--xlsx <path>` (default `dr-compass-export.xlsx`) |
| `drcompass --version` | Print the version | |

**Environment variables:** `DRCOMPASS_PORT` (server port, default 4517) ·
`DRCOMPASS_HOME` (data directory, default `~/.drcompass`).

## Quickstart

1. **Explore the example workspace.** First launch seeds `example-acme`, a
   fictional pharmacy-claims platform with a full Tier-0 inventory, runbooks,
   tests, and gaps — a worked example of what "done" looks like.
2. **Run the assessment.** Open **Where am I?**, answer the questions, and get
   a maturity level plus the next actions that matter most for you.
3. **Build your inventory.** Create a workspace and add components by category
   — or use **Discover** to propose them from your AWS account, an Arpio key,
   or your local Claude Code CLI. Capture dependencies, outbound third-party
   calls, secrets, and what's actually in recovery scope.
4. **Generate diagrams and exports.** The architecture, dependency, and
   restore-layer diagrams come straight from your inventory; export the Excel
   workbook for stakeholders who live in spreadsheets.
5. **Create a runbook and plan your first recovery test.** Start from a
   template, order steps by restore layer, then schedule a test: record T0/T1,
   get measured RTA/RPA, and turn findings into gaps.

## Data & privacy

Everything lives on your machine as plain JSON under `~/.drcompass`
(override with `DRCOMPASS_HOME` or `--dir`). Nothing is sent anywhere by the
app itself. AWS discovery shells out to your local `aws` CLI using your
existing profiles — credentials are never stored by DR Compass. An Arpio API
key is used for the request you make and is not persisted. The optional AI
assist shells out to your local `claude` CLI.

## Screenshots

Screenshots live in [`docs/screenshots/`](docs/screenshots/). *(Placeholder —
they'll land here once the UI is captured for v0.1.0.)*

## Architecture

Node >= 18, Express, and a vanilla ES-module SPA — no build step, no bundler,
no TypeScript. Workspaces are folders of plain JSON files, which makes them
diff-able and git-versionable: run `drcompass start --dir ./dr-data` inside a
repo and commit your DR plan alongside your infrastructure code. See
[SPEC.md](SPEC.md) for the full layout, schemas, and REST API.

## Roadmap ideas

- Import from Terraform/CloudFormation state to seed the inventory
- Scheduled test reminders and a DR-program calendar view
- Multi-cloud discovery (Azure, GCP)
- Runbook execution mode with live timestamp capture during a test
- Diff view between two test records ("did we get faster?")

## Documentation

- [Getting started](docs/getting-started.md) — install, first launch, and a tour of every page
- [Running a DR program](docs/dr-program-guide.md) — a quarter-long, week-by-week arc
- [Integrations](docs/integrations.md) — AWS CLI, Arpio, Claude Code, Lucidchart, draw.io, Google Sheets
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE) © 2026 Jonathan Baugham
