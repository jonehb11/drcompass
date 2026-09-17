# Environments, services and documents — the contract

This is the binding contract for the v0.7 model change. Every agent codes
against it. Additive only: existing workspaces must keep working untouched.

## 1. Why

A workspace is one **system you are responsible for recovering** (Acme Pharmacy).
Inside it:

- it runs in several **environments** — dev, staging, prod — which are
  different accounts, different regions, and are recovered separately;
- it is made of several **services** — adjudication, remittance, pharmacy,
  pricing — each owning a slice of the components;
- a **component** belongs to exactly one environment and at most one service.

You must be able to say: *"the DR package for **Acme Pharmacy / adjudication /
prod**"* and get exactly that.

## 2. Schema

### `workspace.json` — additive

```jsonc
{
  "environments": [
    { "id": "env_dev", "name": "Dev", "slug": "dev",
      "regions": { "primary": "us-east-1", "recovery": "us-east-2" },
      "accountId": "",            // informational
      "awsProfile": "",           // which local profile scans THIS env
      "kubeContext": "",          // which kubectl context snapshots THIS env
      "tierDefault": null,        // default tier for components discovered here
      "isProduction": false,
      "notes": "" }
  ],
  "defaultEnvId": "env_dev"       // what the UI opens on
}
```

Absent `environments` ⇒ the workspace is single-environment. Never fabricate
one; treat `env: null` as "unassigned" and say so.

### `services.json` — NEW collection (`{ "items": [...] }`)

```jsonc
{ "id": "svc_x", "name": "adjudication", "slug": "adjudication",
  "envId": "env_prod",            // a service instance is per-environment
  "tier": 0,
  "owner": "", "team": "",
  "description": "",
  "businessImpact": "",           // from a BIA when one is uploaded
  "objectives": { "rtoMinutes": null, "rpoMinutes": null,
                  "approved": false, "source": "" },   // source: "BIA 2026-03" etc
  "componentIds": [],             // membership is stored here AND on the component
  "parentServiceId": null,        // sub-service of another service, optional
  "notes": "", "tags": [] }
```

Membership is written in both places; `services.js` keeps them consistent on
write. Readers should prefer `component.serviceId`.

### Component — additive fields

```jsonc
{ "envId": "env_prod",            // null = unassigned
  "serviceId": "svc_x",           // null = unassigned
  "resourceDetails": [            // see §4 — what enrichment attaches
    { "rid": "sg-0abc", "type": "security-group", "name": "adj-sg",
      "relation": "secured-by",
      "facts": ["allows inbound tcp/8080 from sg-0alb (the ALB)",
                "allows egress tcp/443 to 0.0.0.0/0"],
      "details": { }, "source": "aws-enrich", "checkedAt": "ISO" } ] }
```

### `documents.json` — NEW collection

```jsonc
{ "id": "doc_x", "name": "Acme Pharmacy BIA 2026.pdf",
  "kind": "bia|solution|test-plan|runbook-notes|other",
  "uploadedAt": "ISO", "bytes": 0, "mime": "",
  "text": "…extracted plain text…",        // capped; see §5
  "summary": "",                            // AI-written, reviewed
  "appliesTo": { "envId": null, "serviceId": null },
  "extracted": { },                         // AI proposals, NOT applied
  "status": "uploaded|summarised|applied" }
```

## 3. Scoping — every read endpoint

Accept `?envId=` and `?serviceId=` (either, both, neither) and scope to them:

`/c/:col` · `/service/:id` · `/deploy-order` · `/diagrams` and every diagram
· `/resources/graph` · `/export/*` · `/recommend` · `/assessment/report` ·
`/k8s` · `/network/*`

Rules: unknown id ⇒ 404 with a clear message. No scope ⇒ today's behaviour,
byte-identical. A scoped response says what it was scoped to
(`scope: {envId, envName, serviceId, serviceName, componentCount}`).

## 4. Enrichment depth (§ what Arpio does)

When enrichment walks a component, it must attach **the associated resources
AND a human sentence about each**, onto `component.resourceDetails`, not only
into the graph. An ELB must come back with its security groups, network
interfaces, listeners, target groups, subnets and AZs — and facts like:

- `"allows inbound tcp/443 from 0.0.0.0/0"`
- `"allows egress tcp/5432 to sg-0db (the Aurora security group)"`
- `"listener TLS:443 → target group adj-tg (3/3 healthy)"`
- `"lives in subnet-0a (us-east-1a), subnet-0b (us-east-1b)"`

Facts are short, true, and derived from the describe output — never invented.
Where a describe was not run or was denied, say so rather than omitting.

## 5. Documents

`POST /w/:ws/documents` accepts `{name, kind, mime, text}` (client extracts
text from PDF/DOCX where it can; plain text and markdown always work).
Server caps stored text at 1 MB and says when it truncated. The AI reads a
document only when the user asks it to, and every proposal it makes from one
is reviewed before it is applied — same operations contract as everything else.

## 6. Migration

A workspace with no `environments` and no `services` works exactly as today.
Adding an environment must not require re-importing anything: components stay
`envId: null` until assigned, and the UI offers a bulk assign. Nothing
auto-assigns silently.

## 7. scope.js API

`server/lib/scope.js` is the shared scoping helper. Every route that accepts
`?envId=` / `?serviceId=` imports it rather than re-deriving the rules — there
is one definition of "adjudication in prod" and this is it.

```js
import {
  resolveScope, resolveScopeOrThrow, scopeFromQuery,
  scopeComponents, scopeCollection, scopeCollectionDetailed,
  scopeMeta, describeScope, componentRefs,
  listEnvironments, getEnvironment, defaultEnvId,
  listServices, getService, findByIdOrSlug,
  descendantServiceIds, ancestorServiceIds, serviceTree, wouldCycle,
  normalizeEnvironment, normalizeService, slugify,
  SCOPED_COLLECTIONS, UNASSIGNED,
} from '../lib/scope.js';
```

### The four you will actually use

```js
resolveScope(slug, { envId, serviceId }, opts?) -> scope
scopeComponents(components, scope)              -> Component[]
scopeCollection(name, items, scope, components?, options?) -> Item[]
describeScope(scope)                            -> string
```

**`resolveScope(slug, { envId, serviceId }, opts?)`** returns:

```js
{
  ok: true,                  // false only when an id did not resolve
  active: false,             // false = NO SCOPE. Do nothing differently.
  slug: 'example-acme',
  query:  { envId, serviceId },      // what was asked for, normalized
  envId: null, envName: '', env: null,          // env: the full object
  serviceId: null, serviceName: '', service: null,
  serviceIds: [],            // the service AND its sub-services, at any depth
  componentIds: new Set(),   // every component id in scope
  componentCount: 0,
  totalComponents: 27,       // the workspace total, for "11 of 27"
  warnings: [],              // human strings; an empty result explains itself
  error: null,               // when !ok: { status:404, message, field, value, available[] }
}
```

- `envId` / `serviceId` accept **an id, a slug, or a name** (`?envId=prod`
  works as well as `?envId=env_prod`).
- Blank, `all`, `any`, `null` ⇒ **not scoped**.
- The literal `unassigned` (exported as `UNASSIGNED`) ⇒ components with **no**
  environment / **no** service. This is what the bulk-assign UI reads.
- **An unknown id never returns an empty list.** It returns `ok:false` with a
  404-shaped `error` that also carries `available[]` so you can render a useful
  message. `resolveScope` never throws; `resolveScopeOrThrow` throws a
  `store.httpError(404, …)` instead, which is what a route in a `try/catch`
  wants.
- `opts` is `{ workspace, components, services }` — pass what you have already
  read and it will not re-read the files.

**`scopeComponents(components, scope)`** — filters, preserving order. An
**inactive, null or failed** scope returns **the same array reference** it was
given. That is the mechanism behind §3's "no scope ⇒ byte-identical": an
unscoped request cannot take a different code path because there is no
different code path to take.

**`scopeCollection(name, items, scope, components?, options?)`**

| `name` | rule |
|---|---|
| `components` | by `envId` / `serviceId` |
| `services` | the scoped service **and its sub-services**, and/or the environment |
| `documents` | by `appliesTo.{envId, serviceId}` |
| `gaps`, `tests`, `runbooks`, `checklists` | by the components they **link to**, at any nesting depth (`componentId`, `componentIds`, `steps[].componentIds`, `appTests[].componentId`, …) |
| anything else (`decisions`, `contacts`) | returned **unchanged** |

An item that links to **no** component is **KEPT** — a workspace-wide runbook
applies to every service, and dropping it from a scoped DR package would lose
the procedure someone is meant to follow. Pass `{ unlinked: 'drop' }` for the
strict reading.

**Pass `components` whenever you have it.** It is what lets the helper tell a
**dangling** link from an out-of-scope one: with the list, an item whose only
links are to ids that no longer exist counts as unlinked and is kept; without
it, those ids look exactly like real out-of-scope components and the item is
dropped. A stale id is a data-quality problem, not a reason to delete a runbook
from someone's recovery package.

`scopeCollectionDetailed(...)` returns `{ items, kept, dropped, unlinked, rule }`
when you need to tell the user what was filtered and why.

**`scopeMeta(scope)`** returns the block §3 requires on a scoped response —
`{ envId, envName, serviceId, serviceName, componentCount }`, plus
`subServiceIds` and `warnings` when they apply — or **`null`** when the scope is
inactive, so an unscoped response stays exactly as it was:

```js
const scope = resolveScopeOrThrow(ws, req.query);
const items = scopeCollection('gaps', all, scope, components);
res.json({ items, ...(scopeMeta(scope) ? { scope: scopeMeta(scope) } : {}) });
```

**`describeScope(scope)`** — one sentence, never empty:

> `Scoped to adjudication and its 2 sub-services, in the Production environment — 11 of 27 components.`
> `The whole workspace — all 27 components.`

An empty scope says *why* it is empty ("nothing is assigned to this scope yet,
so this is empty because of missing assignment, not because nothing exists") —
never a bare `0`.

### Hierarchy helpers

`descendantServiceIds(services, id)` → `Set` containing the service **and every
sub-service beneath it**. `ancestorServiceIds`, `serviceTree` (nested, and it
surfaces dangling/looped nodes at the top level rather than losing them), and
`wouldCycle(services, id, parentId)` — all cycle-safe against corrupt data on
disk.

### Endpoints

Environments (`server/routes/environments.js`) — stored on `workspace.json`:

```
GET    /w/:ws/environments                      list + per-env counts + unassigned counts
POST   /w/:ws/environments                      create (first one becomes the default)
POST   /w/:ws/environments/reorder              { ids: [] }
GET    /w/:ws/environments/:id                  one, with its members
PUT    /w/:ws/environments/:id                  update
DELETE /w/:ws/environments/:id                  ?reassignTo=<envId> | ?unassign=true
POST   /w/:ws/environments/:id/default          set the default
POST   /w/:ws/environments/:id/assign           { componentIds: [], remove: [], mode: 'add'|'replace' }
GET    /w/:ws/unassigned                        ?dimension=either|both|env|service
GET    /w/:ws/scope                             ?envId=&serviceId= — the resolver over HTTP
```

Services (`server/routes/services.js`) — `services.json`:

```
GET    /w/:ws/services                          ?tree=1  ?envId=
POST   /w/:ws/services                          create (parentServiceId for a sub-service)
GET    /w/:ws/services/:id                      members, inherited members, children, `requires`
PUT    /w/:ws/services/:id                      update (parent change is cycle-guarded)
DELETE /w/:ws/services/:id                      ?reassignTo= | ?unassign=true ;
                                                ?reparentTo= | ?promoteChildren=true | ?cascade=true
POST   /w/:ws/services/:id/members              { add: [], remove: [] }   bulk, one atomic write
POST   /w/:ws/services/:id/assign               { componentIds: [], mode: 'add'|'replace' }
```

Both `assign` endpoints take `mode:'replace'`, which makes the posted list the
**whole** membership — that is what a checkbox list saves.

### Invariants the routes guarantee

1. **`component.serviceId` ↔ `service.componentIds` agree after every write.**
   Every mutation path writes `component.serviceId` and then **rebuilds** every
   `service.componentIds` from the components. One direction is derived, so the
   two cannot drift, and a component can only ever be in one service.
2. **A component has exactly one environment and at most one service.**
   Assigning it elsewhere **moves** it, and every move is reported in the
   response (`moved: [{ componentId, from, fromName, to }]`) — never silent.
3. **Nothing is deleted out from under its members.** Deleting an environment
   or a service with members (or sub-services) is refused with a `409` naming
   **every** hazard at once, until the request says what should happen. The
   success response says what it did.
4. **Cycles in `parentServiceId` are rejected** with the chain that proves it.
5. **A dangling `serviceId` is flagged, not believed.** `GET /w/:ws/unassigned`
   marks it `danglingServiceId: true`, and the next write clears it.
6. **Nothing auto-assigns.** A workspace with no environments and no services
   behaves exactly as it did before v0.7, and adding an environment never
   requires a re-import.
