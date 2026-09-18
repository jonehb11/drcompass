# The MCP server

DR Compass ships a **Model Context Protocol** server, so Claude Desktop, Claude
Code, or anything else that speaks MCP can drive the whole product: read the
inventory, compute the recovery order, produce every export, read documents, and
— only if you say so — apply reviewed changes.

```sh
drcompass mcp                 # read-only. the default.
drcompass mcp --allow-writes  # plus the tools that change your plan
drcompass mcp --allow-ai-cli  # plus the tools that run your local AI CLI
drcompass mcp --dir ./dr-data # a workspace directory other than ~/.drcompass
```

It speaks **stdio**: your client launches it as a child process and talks
JSON-RPC 2.0 over its stdin/stdout. There is no port, no daemon and no network
listener (see [How it reaches the product](#how-it-reaches-the-product)).

---

## Client configuration

### Claude Code

```sh
# read-only — start here
claude mcp add drcompass -- drcompass mcp

# with writes, once you have seen what it proposes
claude mcp add drcompass -- drcompass mcp --allow-writes

# a workspace directory that is not ~/.drcompass
claude mcp add drcompass -- drcompass mcp --dir /path/to/dr-data
```

If `drcompass` is not on your `PATH` (you are running from a clone), point at
the entry script:

```sh
claude mcp add drcompass -- node /path/to/drcompass/bin/drcompass.js mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` —
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json` — and restart Claude
Desktop.

```json
{
  "mcpServers": {
    "drcompass": {
      "command": "drcompass",
      "args": ["mcp"]
    }
  }
}
```

With writes enabled, and an explicit data directory:

```json
{
  "mcpServers": {
    "drcompass": {
      "command": "drcompass",
      "args": ["mcp", "--allow-writes", "--dir", "/Users/you/dr-data"],
      "env": { "DRCOMPASS_MCP_ALLOW_WRITES": "1" }
    }
  }
}
```

`DRCOMPASS_MCP_ALLOW_WRITES=1` and `DRCOMPASS_MCP_ALLOW_AI_CLI=1` are the
environment-variable forms of the two flags, for clients that find it easier to
set an env var than to edit an argument list. Either form works; both default
to off.

### Any other client

Command `drcompass`, arguments `["mcp"]`, transport stdio. Nothing else is
required.

---

## The safety posture, and why it is like this

DR Compass exists to stop a number nobody measured being presented as measured.
The product has closed four separate doors where that could happen. **An MCP
server is the widest door of all** — it is reachable by any client, including a
small local model with nobody watching and no review step in front of it.

So:

**1. Reads are unrestricted.** Anything you want to know about the plan, you can
ask. All 35 read tools work by default.

**2. There is exactly one tool that can change plan data.** `apply_operations`.
It posts to the same `POST /w/:ws/ai/apply` endpoint the browser UI uses, which
is where `guardOperations()` and `validateOperations()` run. There is
deliberately **no** `create_component`, `update_test` or raw-collection write
tool anywhere in this server; adding one would be a road around the guard.

**3. Writes are off by default.** Without `--allow-writes`, `apply_operations`,
`upload_document` and `create_workspace` refuse — before touching anything —
with a message explaining how *the user* turns them on and what you can still do
meanwhile.

**4. The guard runs even when writes are on.** An AI proposal can only ever
propose a **planned** test. `results`, `timestamps`, `cleanRun`, top-level
`rtaMinutes`/`rpaMinutes`, and `componentIds` on an update are stripped — and
every strip is **reported** in `guardNotes`, because silently changing what
somebody approved would be its own kind of dishonesty.

**5. Nothing spawns another process by default.** `propose_operations`,
`ingest_document` and `ai_status` run DR Compass's configured local AI CLI: a
second AI process, handed a large part of your plan as a prompt, running for
minutes. That is a separate risk from "change my plan", so it has a separate
switch — `--allow-ai-cli` — and it is also off by default.

**6. No tool starts a cloud or cluster scan.** An AWS or Kubernetes scan runs
against a real account with your credentials. `discovery_status` and
`k8s_snapshot` read what discovery already captured; nothing here executes
`aws`, `aws-vault` or `kubectl`. Run discovery from the UI or the CLI, with a
person present.

### What can reach off this machine, and under which flag

This is worth stating exactly, because the first version of this server got it
wrong. A conformance sweep that called every tool with only its schema-required
arguments — which is what a model does when it decides a tool looks relevant —
found three tools reaching outside the process **in the read-only default**:
`discovery_status` executed `aws sts get-caller-identity` (a real AWS API call
with your credentials), `aws-vault list` and `kubectl config get-contexts`, and
`ai_status` and `propose_operations` executed the local `claude` CLI with a large
part of the DR plan as the prompt. None of that needed `--allow-writes`, because
none of it is a write. It was fixed by narrowing `discovery_status` to stored
data only and by adding the `--allow-ai-cli` gate.

As it now stands:

| Flag | Tools | What they can reach |
| --- | --- | --- |
| *(default)* | the other 35 | **Nothing off this machine.** No subprocess, no socket except the private UNIX one this server talks to itself on, no network. |
| `--allow-ai-cli` | `ai_status`, `propose_operations`, `ingest_document` | Spawn the local AI CLI configured in DR Compass (`claude` by default) and hand it plan context. Where *that* CLI then sends it is between you and its vendor. |
| `--allow-writes` | `apply_operations`, `upload_document`, `create_workspace` | Your workspace files on disk. No network. |

No flag, at any setting, makes a tool call AWS, Kubernetes or Arpio. That path
is not gated — it is absent. Run discovery from the UI or the CLI, where a person
is present to see it happen.

**7. It never creates a file you did not name.** See
[Files and large results](#files-and-large-results). That includes at startup:
unlike `drcompass start`, the MCP server does **not** seed the bundled example
workspace. An empty installation answers "no workspaces, here is how to make
one", because a server whose job is to stop invented numbers being read as real
should not hand a model an invented DR plan it never asked for.

**8. Hostile document text is redacted at this boundary.** DR Compass scans
uploaded documents for passages written to steer an AI. The store never alters
the text — citations must stay checkable byte for byte — but `get_document` and
`list_documents` replace flagged passages with a marker saying what was removed
and why. `includeRawText: true` returns them verbatim for citation checking.

### What this looks like

Without `--allow-writes`:

```
REFUSED — this DR Compass MCP server is running READ-ONLY, which is the default.

`apply_operations` changes data in the user's workspace, so it needs writes
switched on explicitly.
...
Nothing was written. What you can still do right now, without any change:
  * every read tool — the whole plan, every export, every diagram;
  * `preview_operations`, which runs the SAME honest-numbers guard and the SAME
    validator the write path runs, and tells you exactly what would change,
    including every field the guard would strip.
```

With `--allow-writes`, asking to create a passed test that measured four
minutes:

```jsonc
// what was sent
{ "op": "create", "collection": "tests", "data": {
    "name": "Full-estate failover", "status": "passed", "cleanRun": true,
    "rtaMinutes": 4, "results": { "rtaMinutes": 4 },
    "timestamps": { "t0": "...", "t1": "..." } } }

// what landed on disk
{ "name": "Full-estate failover", "status": "planned", "id": "tst_a8dfaea4" }
```

…and six `guardNotes` saying exactly what was removed and why. The executive
summary still reads **NOT PROVEN**.

---

## The tools

41 tools. `read` always works; `external` needs `--allow-ai-cli`; `write` needs
`--allow-writes`.

### Workspaces and scope

| Tool | Mode | What it does |
| --- | --- | --- |
| `list_workspaces` | read | Every workspace on this machine. Start here. |
| `get_workspace` | read | Settings, regions, strategy, tooling, environments, RTO/RPO objectives. |
| `create_workspace` | **write** | A new empty workspace. |
| `list_environments` | read | Environments with regions and component counts. |
| `list_services` | read | Services with tier, parent and membership. |
| `resolve_scope` | read | Resolve `envId`/`serviceId` the way every endpoint does, with warnings. |

### Inventory and analysis

| Tool | Mode | What it does |
| --- | --- | --- |
| `list_collection` | read | Any of components, runbooks, tests, checklists, gaps, decisions, contacts, services, documents. Scopable. |
| `service_profile` | read | One component's whole story, weakest links first. |
| `resource_graph` | read | The discovered AWS resource graph. `summary: true` first — it is large. |
| `component_resources` | read | Resources behind one component, with replication posture. |
| `deploy_order` | read | Computed recovery waves, `waitsFor` reasons, cycles, unplaced items. |
| `explain_deploy_order_item` | read | Why one item sits where it does. |
| `draft_runbook_from_deploy_order` | read | A draft runbook from the order. Writes nothing. |
| `recommend` | read | Ranked next actions with their triggers. |
| `assessment_report` | read | Six-pillar maturity report and level. |
| `blanks` | read | **What the plan leaves empty**, graded, with the exports each blank shows up in. |
| `pre_cutover_checklist` | read | The verifications that must pass before traffic moves. |
| `discovery_status` | read | What discovery has captured. Executes nothing. |
| `k8s_snapshot` | read | The stored Kubernetes snapshot. |

### Exports

| Tool | Mode | What it does |
| --- | --- | --- |
| `export_scope_preview` | read | What a scope covers — and `hiddenSentences`: what narrowing to it takes out of frame. |
| `export_workbook` | read | The `.xlsx` workbook. Needs an absolute `outputPath`. |
| `export_csv` | read | One sheet as CSV text. |
| `export_bundle` | read | Every CSV + runbook + workspace.json as one JSON document. |
| `export_executive_summary` | read | The executive one-pager, markdown. |
| `export_failover_brief` | read | "How we fail this over", markdown. |
| `export_runbook` | read | One runbook as `md` or `txt`. |

All of them take `envId`, `serviceId`, `componentId` and `componentIds`.

### Diagrams

| Tool | Mode | What it does |
| --- | --- | --- |
| `diagram_scopes` | read | What the picker offers, and the render limits. |
| `list_diagrams` | read | Every diagram this workspace can generate. |
| `get_diagram` | read | Mermaid source plus the model behind it. `flavor: "lucid"` for the Lucidchart subset. |
| `export_diagram` | read | `mmd`, `lucid`, `drawio` (with `awsStyle`), or `canvas`. |
| `list_solution_models` | read | Models extracted from solution documents. |

### Documents

| Tool | Mode | What it does |
| --- | --- | --- |
| `list_documents` | read | Documents with ingestion and applied history. |
| `get_document` | read | One document; flagged passages redacted unless `includeRawText`. |
| `upload_document` | **write** | Store extracted text. The server never parses binaries. |
| `ingest_document` | **external** | Run an ingestion flow → proposals with citations, fills, conflicts, guard notes, truncation. Applies nothing. |

### Propose and apply

| Tool | Mode | What it does |
| --- | --- | --- |
| `preview_operations` | read | **Dry run.** Same guard, same validator, no write. Use this before applying anything. |
| `propose_operations` | **external** | Ask DR Compass's own AI bridge for operations. |
| `ai_status` | **external** | Which local AI CLI is configured. |
| `apply_operations` | **write** | The only tool that changes plan data. |

### Field guide

`list_articles` and `get_article` — the 16 built-in DR articles.

---

## Resources

A workspace *is* a directory of plain JSON files, so those files are exposed as
MCP resources directly:

- `drcompass://workspace/{slug}/{file}.json` — `workspace.json`,
  `components.json`, `runbooks.json`, `tests.json`, `resource-graph.json`, and
  the rest, raw.
- `drcompass://knowledge/{id}` — a field-guide article as markdown.

Resources are read-only, and the path is validated twice: a regex on the slug
and filename, then a re-check that the resolved path is still inside the
workspace root.

For the product's *view* of the data — scoped, derived, with the honesty rules
applied — use the tools. The resources are the bytes on disk.

---

## Files and large results

The invariant is one sentence: **this server never creates a file you did not
name.**

- **No `outputPath`** → nothing is written. Text comes back inline; over 48 KB it
  is truncated inline with a note saying so. A read result over 60 KB comes back
  as a structure-preserving preview — and for lists of records that preview is an
  **index of every entry's id and name**, so you can see what is there and then
  ask about one of them.
- **`outputPath` given** → that file, at that path, and nothing else.
- **`outputPath` must be absolute.** An MCP server is spawned by your client, so
  its working directory is whatever the client chose; a relative path would write
  somewhere neither of you picked. It is also why a model filling in a
  placeholder cannot write anything.
- **`export_workbook` needs a path.** It is binary. Base64 of a spreadsheet is
  unreadable and would fill your context, and inventing a location in your data
  directory would be exactly the surprise this invariant exists to prevent. The
  refusal names the alternatives: the executive summary, the failover brief and
  the CSVs are all text and need no file.

---

## How it reaches the product

Every tool is one HTTP request against **the real Express app**, running
in-process and listening on a **UNIX domain socket inside a 0700 temporary
directory** (a named pipe on Windows), which is removed on exit.

Two reasons, both deliberate.

**No second implementation.** The renderers for the executive summary, the
failover brief, the runbook markdown, the terminal quick reference and the CSVs
are module-private to `server/routes/exports.js`, and the honest-numbers guard
runs *inside* the `/ai/apply` handler. An MCP server that imported libraries
would have had to rewrite them — and a second renderer is how the workbook and
the markdown start telling different stories about the same plan.

**No port.** `drcompass start` binds `127.0.0.1` on purpose, because this product
has no login. An MCP server is launched in the background by a client with
nobody watching, so opening a second unauthenticated TCP port for the life of a
chat session would be worse than what that warning describes. A UNIX socket in a
0700 directory is reachable only by you, is not on the network at all, and
cannot be found by a port scan.

**stdout is seized.** `server/mcp/stdio.js` captures the real
`process.stdout.write` at boot and replaces `process.stdout.write` with a
forwarder to stderr, so a stray `console.log` added anywhere in the 21 routers
this process loads can never corrupt the protocol stream — it surfaces on stderr
tagged `[stdout escaped, diverted]`. All diagnostics go to stderr prefixed
`[drcompass-mcp]`.

---

## Protocol details

- **Framing:** newline-delimited JSON — one JSON-RPC 2.0 object per line, UTF-8.
  That is MCP's stdio transport; `Content-Length` framing is LSP's convention,
  not this one.
- **Protocol versions:** negotiated over `2025-06-18`, `2025-03-26`,
  `2024-11-05`. An unknown request gets the newest we speak.
- **Methods:** `initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`, `resources/list`, `resources/read`,
  `resources/templates/list`. JSON-RPC batches are accepted.
- **No `prompts/list`.** This server publishes no prompts, so it does not
  advertise a `prompts` capability — and answering a method whose capability is
  not advertised makes the capability map a lie. Clients get `-32601`.
- **Errors:** protocol problems are JSON-RPC errors (`-32700` parse, `-32600`
  invalid request, `-32601` unknown method, `-32602` bad params, `-32603`
  internal). **Tool failures are not** — they come back as a normal result with
  `isError: true` and a readable message, which is what the spec wants and what
  a model can actually recover from.
- A malformed frame, an unknown method, an unknown tool, a traversal attempt in
  a resource URI: all answered, none fatal.

---

## Working with it

A good session looks like this:

1. `list_workspaces`, then `get_workspace`.
2. `blanks` and `export_executive_summary` — where does this plan actually
   stand, and what does it leave empty?
3. `deploy_order` and `service_profile` for the things that look weak.
4. Write the operations yourself, run **`preview_operations`**, and show the
   human the guarded diff — including everything the guard would strip.
5. Only then, with writes enabled and the human's agreement,
   `apply_operations` — and relay `guardNotes` verbatim.

And the rule the whole product is built on, which the tool descriptions repeat
because they are read by a model before it tries anything:

> RTO and RPO are **targets** somebody chose. RTA and RPA are **evidence**, and
> only when a test that actually passed produced them. If the executive summary
> says NOT PROVEN, say NOT PROVEN.

See [docs/measured-numbers.md](measured-numbers.md) for the full contract.
