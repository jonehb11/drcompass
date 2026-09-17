# What DR Compass produces

These files are **real output**, not mock-ups. Each was exported from the
`example-acme` workspace that ships with the app and seeds itself on first run,
using the commands listed below. Nothing here was written by hand or touched
after export, except `workbook-structure.md`, which is a markdown rendering of a
real `.xlsx` (spreadsheets do not display in a repo).

| File | What it is | How it was produced |
| --- | --- | --- |
| [`executive-summary.md`](executive-summary.md) | The one-pager for leadership: what is covered, the honest numbers, the top risks with owners, the test history, the next actions. | `GET /api/w/example-acme/export/executive-summary.md` (Exports → *One file at a time*) |
| [`diagrams.md`](diagrams.md) | Three generated diagrams, rendered. | `GET /api/w/example-acme/diagrams/<id>/mmd` |
| [`data-replication.mmd`](data-replication.mmd) · [`restore-layers.mmd`](restore-layers.mmd) · [`architecture.mmd`](architecture.mmd) | The raw Mermaid sources behind those diagrams. | as above |
| [`architecture.drawio`](architecture.drawio) | The same architecture diagram as draw.io XML using the official AWS shape library. | `GET /api/w/example-acme/diagrams/architecture/drawio?style=aws` |
| [`workbook-structure.md`](workbook-structure.md) | All 10 sheets of the DR workbook: each sheet's banner, headers and first rows. | `drcompass export example-acme --xlsx example.xlsx`, then rendered to markdown |

## Reproduce them yourself

```sh
drcompass start --no-open --dir ./scratch-home    # seeds example-acme, serves :4517
curl -s localhost:4517/api/w/example-acme/export/executive-summary.md
curl -s localhost:4517/api/w/example-acme/diagrams/data-replication/mmd
curl -s 'localhost:4517/api/w/example-acme/diagrams/architecture/drawio?style=aws'

DRCOMPASS_HOME=./scratch-home drcompass export example-acme --xlsx example.xlsx
```

Your own numbers will differ; the *shape* will not.

## What is deliberately missing

**There are no UI screenshots here.** The rendered SVG and PNG exports, the
draggable icon canvas and the pages themselves are produced in the browser, so
they cannot be captured by the headless pipeline that generated this directory.
Rather than ship a picture of something that does not exist, this folder carries
only artifacts the server itself emits. Run `drcompass` and look at the real
thing — it takes about ten seconds and the example workspace is already there.

## Provenance

Generated on **2026-09-17** from DR Compass **v0.4.0** against the shipped seed
workspace. These are a point-in-time snapshot: the executive summary in
particular is dated, and the app tells you so at the foot of every copy it
produces.
