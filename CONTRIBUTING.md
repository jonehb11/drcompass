# Contributing to DR Compass

Thanks for considering a contribution. This is a deliberately small, boring
codebase — please help keep it that way.

## Dev setup

```sh
git clone https://github.com/jonehb11/drcompass.git
cd drcompass
npm install
npm run dev        # starts the server and opens http://localhost:4517
```

Requires Node >= 18. To develop against throwaway data instead of your real
`~/.drcompass`, use:

```sh
DRCOMPASS_HOME=./.testhome node bin/drcompass.js start --no-open
```

(`.testhome` is gitignored.)

## The no-build philosophy

There is **no build step** and we intend to keep it that way:

- Plain Node >= 18 ES modules on the server, vanilla ES-module SPA in the
  browser. No TypeScript, no bundler, no transpiling, no framework.
- **No new npm dependencies** beyond the existing ones (express, exceljs,
  commander, open, mermaid). If a feature seems to need a dependency, it
  probably needs a smaller design. (This is why the export bundle is JSON,
  not a zip.)
- Mermaid is vendored from `node_modules` and served at `/vendor/mermaid/`.
- Storage is plain JSON files — diff-able, git-versionable, no database.

Edit a file, refresh the browser (restart `node` for server changes). That's
the whole toolchain.

## File layout

See [SPEC.md](SPEC.md) for the authoritative layout, schemas, and REST API.
In short:

```
bin/drcompass.js          CLI (start | init | list | export)
server/index.js           createServer() — mounts every router
server/store.js           workspace JSON storage
server/routes/*.js        16 API routers; 3 are always mounted, the rest are
                          optional and degrade to a scoped 501
server/lib/*.js           measured, deploy-order, diagram-gen, xlsx-gen,
                          aws-discovery, aws-scan-map, aws-enrich,
                          k8s-discovery, network-flows, arpio-client,
                          ai-bridge, jobs
server/data/knowledge/    Learn-page markdown (16 articles)
server/data/templates/    runbook/checklist/app-test templates (JSON)
server/data/seed/         the example-acme workspace
web/index.html, css/, js/ app shell, router, api client, ui helpers
web/js/pages/*.js         one module per page (13); exports { title, render }
web/assets/icons/         99 curated icons — see ICON-CREDITS.md
docs/, Formula/           documentation and Homebrew formula
```

Conventions worth knowing:

- API errors: `res.status(4xx|500).json({ error: "message" })`.
- Page modules export `{ title, async render(el, ctx), destroy? }` with
  `ctx = { ws, api, ui, params, navigate }`.
- Style with the custom properties and helper classes in `web/css/app.css`;
  avoid per-page style blocks beyond small scoped tweaks.
- **Never re-derive RTA/RPA or a risk severity.** `server/lib/measured.js` is the
  only place either is decided — see [docs/measured-numbers.md](docs/measured-numbers.md).
  On the client, render numbers through `web/js/measured.js` so the
  measured / declared / unmeasured vocabulary stays consistent.
- `web/js/diagram-layout.js` must stay pure and deterministic: no DOM, no
  `Math.random`, no `Date`, every tie broken by an explicit comparator.
- Discovery is read-only and writes nothing without an explicit import. The
  Kubernetes scanner hard-refuses any `kubectl` verb but `get`, and Secrets /
  ConfigMaps are captured as names only.
- Workspace JSON must round-trip: preserve unknown fields, and degrade on
  missing ones instead of throwing. People hand-edit these files.
- The seed workspace is fictional: no real account numbers, company names,
  person names, or internal URLs anywhere in the repo. Its last test is
  deliberately `failed` — it is the regression test for the honest-numbers rule,
  so don't "fix" it.

## PR flow

`main` is protected — all changes land via pull request.

1. Fork (or branch, for collaborators) and make your change.
2. Keep PRs small and single-purpose; note any schema or API changes and
   update SPEC.md in the same PR. User-visible changes get a line in
   [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]`.
3. Sanity-check locally: `node bin/drcompass.js --version`, start the app,
   click through the pages your change touches, and exercise the example
   workspace. If you touched exports or diagrams, regenerate
   [`docs/examples/`](docs/examples/) — its README lists the exact commands.
4. Open a PR against `main` describing what changed and why. For behavior
   changes, a before/after screenshot of the relevant page helps a lot.

Bug reports and feature ideas are welcome as GitHub issues — for DR-practice
questions, include what the tool told you vs. what you expected it to say.

## License

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
