# Integrations

DR Compass is local-first. Every integration below runs **from your machine,
with your credentials**, and produces *proposals* or *files* you control. The app
stores no cloud credentials, and nothing is written to your inventory without an
explicit import that carries your selection.

| Integration | Needs | Direction |
| --- | --- | --- |
| [AWS CLI discovery](#aws-cli-discovery) | your `aws` CLI + a profile | read-only, in |
| [Read-only discovery script](#no-credentials-here-run-the-script-somewhere-else) | bash + `aws` + `jq` or `python3` | read-only, in |
| [Resource enrichment](#deep-resource-enrichment) | the same AWS CLI | read-only, in |
| [Kubernetes](#kubernetes--eks-application-layer) | your `kubectl` + kubeconfig | read-only, in |
| [Network / firewall flows](#networkflow-log-import) | a delimited export | parsed in your browser |
| [Arpio](#arpio) | a read-only Arpio API key | read-only, in |
| [Claude Code CLI](#claude-code-cli-the-ai-layer) | `claude` on your `PATH` | local, review-before-apply |
| [Lucidchart](#lucidchart) · [draw.io](#drawio--diagramsnet) · [Google Sheets](#google-sheets--excel) | nothing | out |

Long-running AWS, Arpio and Kubernetes operations run as
[background jobs](#background-jobs) — you can refresh or navigate away.

---

## AWS CLI discovery

**Discover → AWS account** shells out to your local `aws` CLI to enumerate
resources in one region and propose inventory components.

Requirements:

- `aws` CLI v2 on your `PATH` and a configured profile
  (`~/.aws/config` / `~/.aws/credentials`). DR Compass lists your profiles and
  lets you pick one, plus a region and the services to scan.
- If the CLI is missing you get a clear message, not a crash — and the
  [script path](#no-credentials-here-run-the-script-somewhere-else) still works.

Every call is executed with an argument array (never a shell string), gets
`--output json --no-cli-pager`, and times out after 30 seconds. The exact command
line for each call appears in the log panel, so you can read and re-run anything
it did.

**Services it knows how to scan** (20): EKS, ECS, Lambda, EC2 Auto Scaling, RDS
(including global clusters), DynamoDB, ElastiCache, SQS, SNS, Kinesis, S3,
Secrets Manager, Route 53, CloudFront, ELB/ALB/NLB, API Gateway (v1 and v2), ECR,
Transfer Family, MSK, EFS.

Secrets Manager is enumerated with `list-secrets` / `describe-secret` only.
**`get-secret-value` is never called** — DR Compass records that a secret exists
and whether it is replicated, never its value.

### Two scan modes

**Scan & map** (the default, labelled *Map dependencies*) does one pass that
returns each discovered resource **with** its association tree — security groups,
subnets and AZs, IAM roles and attached policies, target groups and listeners,
KMS keys, certificates, tags — plus cross-resource dependency links. Results
appear as a **proposal tree**: expand a row to see the resources that come with
it, and a "→ depends on" line when it depends on another proposal in the same
result. **Checking a proposal automatically selects its whole dependency
closure.** Unchecking something another selected proposal needs is allowed but
flagged "needed by …", so you cannot strand a dependency by accident.

Dependency links are computed only from **concrete identity matches** (a resource
id, an ARN, an exact name, or a terminal ARN segment of at least three
characters). There is no fuzzy "these names look similar" guessing.

**Plain scan** skips the association pass and returns flat component proposals.
It is faster; it writes nothing into the resource graph.

Importing writes the components into your inventory, wires `dependsOn` from the
proposal graph, and merges the mapped resources into the workspace resource
graph (explore them on the Diagrams page by clicking a node).

### Authenticating — SSO and aws-vault

The profile picker merges two sources: profiles parsed from `~/.aws/config` and
`~/.aws/credentials` (SSO profiles are labelled **(SSO)**) and, when `aws-vault`
is installed, the profiles in your vault (**(aws-vault)**, or **(SSO · vault)**
when a profile appears in both). A vault-only profile runs every CLI call as
`aws-vault exec <profile> -- aws …` instead of `--profile <name>`; the log shows
which form ran.

Before any heavy AWS action DR Compass runs a **credential pre-flight** — one
`aws sts get-caller-identity` through your own CLI. A valid session shows
"✓ authenticated as *account*" and the action starts immediately. An expired
session shows an inline **Authenticate** card instead:

| profile type | what the button runs |
| --- | --- |
| SSO | `aws sso login --profile <name>` — opens your browser on AWS's own page |
| aws-vault | `aws-vault exec <profile> -- aws sts get-caller-identity` — aws-vault raises its own browser/keychain prompt |
| static keys | nothing to launch; refresh them in your terminal |

The UI polls until the session works, then auto-starts the action you originally
asked for. A login gets four minutes before it is abandoned; a second login for
the same profile is refused with "a login for '…' is already in progress".

Credentials never touch DR Compass. It sees the resulting identity metadata
(account id and role ARN) and the CLI's stderr text; tokens, keys and browser
cookies stay with the AWS CLI, aws-vault and your OS keychain. Login state lives
in memory and is never written to disk.

### Permissions

Discovery and enrichment are strictly read-only: `Describe*` / `List*` / `Get*`,
plus `sts:GetCallerIdentity` and `tag:GetResources`. The simplest setup is the
AWS-managed **`ReadOnlyAccess`** policy on the role or user behind the profile.

For a least-privilege profile, this covers everything the current code can issue.
Trim it to the services you actually scan:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "sts:GetCallerIdentity",
      "tag:GetResources",
      "ec2:Describe*",
      "autoscaling:DescribeAutoScalingGroups",
      "eks:ListClusters", "eks:DescribeCluster",
      "eks:ListNodegroups", "eks:DescribeNodegroup", "eks:ListAddons",
      "ecs:ListClusters", "ecs:DescribeClusters", "ecs:ListServices",
      "lambda:ListFunctions", "lambda:GetFunctionConfiguration",
      "rds:Describe*",
      "elasticache:DescribeReplicationGroups", "elasticache:DescribeCacheClusters",
      "elasticache:DescribeCacheSubnetGroups",
      "dynamodb:ListTables", "dynamodb:DescribeTable",
      "s3:ListAllMyBuckets", "s3:GetBucketLocation",
      "s3:GetEncryptionConfiguration", "s3:GetBucketVersioning",
      "s3:GetReplicationConfiguration", "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketPolicy",
      "sqs:ListQueues", "sqs:GetQueueUrl", "sqs:GetQueueAttributes",
      "sns:ListTopics",
      "kinesis:ListStreams", "kinesis:DescribeStreamSummary",
      "secretsmanager:ListSecrets", "secretsmanager:DescribeSecret",
      "kms:ListKeys", "kms:ListAliases", "kms:DescribeKey",
      "route53:ListHostedZones", "route53:ListResourceRecordSets",
      "cloudfront:ListDistributions",
      "apigateway:GET",
      "elasticloadbalancing:Describe*",
      "acm:ListCertificates", "acm:DescribeCertificate",
      "ecr:DescribeRepositories",
      "transfer:ListServers", "transfer:DescribeServer",
      "kafka:ListClusters",
      "elasticfilesystem:DescribeFileSystems",
      "iam:ListRoles", "iam:GetRole", "iam:ListAttachedRolePolicies",
      "iam:ListOpenIDConnectProviders",
      "cloudwatch:DescribeAlarms",
      "backup:ListBackupVaults", "backup:ListBackupPlans"
    ],
    "Resource": "*"
  }]
}
```

`iam:GetRole` and `iam:ListAttachedRolePolicies` return role **metadata and
policy names**; DR Compass never stores policy documents.

### No credentials here? Run the script somewhere else

Next to the scan controls, download the **read-only discovery script**. It is
plain bash wrapped around the same `list` / `describe` calls, scoped to the
services you selected — read it first if you like.

```sh
REGION=us-east-1 bash drcompass-aws-discovery.sh
PROFILE=prod REGION=us-east-1 bash drcompass-aws-discovery.sh
SERVICES="eks elb rds" REGION=us-east-1 bash drcompass-aws-discovery.sh
```

It needs the AWS CLI **plus `jq` or `python3`** (it assembles JSON; jq is
preferred, python3 is the fallback). It writes
`drcompass-aws-discovery.json` — a capture block of raw API responses keyed by
the exact command that produced them, with the profile **name** but no
credentials. Run it on a bastion, a CI runner or a locked-down laptop, then drop
the artifact onto the upload zone: the server replays the same collectors
against the captured responses and you get the identical proposal tree to review
and import. Calls the script did not capture are reported rather than silently
skipped.

### Deep resource enrichment

The scan proposes components; **enrichment** pulls each component's real
associations into the resource graph you see when you click a node on the
Diagrams page. Per service, that means for example:

- **ELB / ALB / NLB** → listeners, target groups and their health, security
  groups, subnets and AZs, ACM certificates
- **EKS** → nodegroups, the OIDC provider, add-ons, cluster security groups and
  subnets
- **RDS / Aurora** → DB subnet groups, parameter groups, security groups, the
  KMS key, AZ placement
- **Lambda** → execution role, VPC config, event source mappings
- **ElastiCache / MSK / EFS** → subnet groups, security groups, KMS
- **S3** → encryption, versioning, replication configuration, public-access block
- **Everything** → IAM roles and attached policy names, tags, security groups,
  subnets and their AZs

A component that carries a real **ARN** is enriched by exact ARN lookup
(`matched by: exact`). Without one, a name heuristic picks the collectors
(`matched by: name`), and a component nothing matches reports `none` rather than
quietly finding nothing.

**Arpio-first overlay.** If you protect workloads with Arpio, import on the
Arpio tab first (those proposals carry exact ARNs), then press **Arpio overlay**
on the AWS tab. It enriches *only* the Arpio-imported components, by ARN — no
account-wide scan, no name guessing. Zero targeted components means you have not
imported on the Arpio tab yet.

**Find resources by tag** (formerly "correlate by tag") sweeps the region through
the Resource Groups Tagging API and is how you find what your inventory missed.
Build a list of tag filters — each row is a key plus one or more comma-separated
values. Semantics: a resource must match **every row** (AND across rows) and
**any listed value** within a row (OR). Limits: 10 filters, 20 values per key,
three pages of 100 results. Matched resources land in the resource graph; ones
that match no component stay **unlinked** so you can review them. With *Propose
components for app-level matches* on, they also come back as importable
proposals. Your filter list is remembered in your browser.

---

## Kubernetes / EKS application layer

**Discover → Kubernetes** captures the *application* layer of a cluster —
namespaces, workloads (Deployments, StatefulSets, DaemonSets, CronJobs, Jobs),
Services, Ingresses, PVCs and HPAs — and links what it finds to your inventory
components. Three capture paths, all strictly read-only:

1. **Scan with kubectl.** DR Compass shells out to your local `kubectl` with
   your own kubeconfig. A hard allowlist refuses anything that is not
   `kubectl get …`, `kubectl config get-contexts` or `kubectl config
   current-context`; every call carries `-o json --request-timeout=20s` and the
   exact command appears in the log. Pick a context (your current one is
   pre-selected) and optionally a comma-separated namespace list — blank scans
   every namespace except `kube-system`, `kube-public` and `kube-node-lease`.
2. **Run the snapshot script yourself**, for environments where the machine
   running DR Compass has no cluster access. It needs `kubectl` plus `jq` or
   `python3`, takes `CONTEXT` and `NAMESPACES` from the environment, and writes
   `drcompass-k8s-snapshot.json`. Upload that on the Kubernetes tab.
3. **Upload a snapshot you already have.** The same upload endpoint also accepts
   an already-normalised snapshot (anything carrying `workloads[]` or
   `namespaces[]`), rebuilt field-by-field from a whitelist. That is the hook for
   a cluster inventory your own tooling produces.

What the snapshot contains: object names, namespaces, labels, replica counts,
images, service accounts, service and ingress wiring, PVC and HPA targets, and
the references between them. For Secrets and ConfigMaps it records **names
only** — a post-processing pass deletes any `data`, `stringData` or `env` key
anywhere in the snapshot before it is stored. Workload names are fuzzy-matched
to your components (role suffixes like `-service`, `-svc`, `-api`, `-deploy` are
stripped) and linked automatically.

The stored snapshot shows its capture time, source (`kubectl` or `upload`) and
cluster, feeds the `k8s-cluster` and per-namespace diagrams, and can be re-scanned
or deleted from the same tab.

Once a snapshot exists, the **AI copilot** (`Cmd/Ctrl+K`) and **AI correlate**
can propose links between workloads and components you have not cataloged — as
proposals you approve, never as writes.

RBAC for a least-privilege scan identity: `get` / `list` on `namespaces`,
`nodes`, `deployments`, `statefulsets`, `daemonsets`, `cronjobs`, `jobs`,
`services`, `ingresses`, `persistentvolumeclaims`, `horizontalpodautoscalers`,
and (names only) `secrets` / `configmaps`. The built-in `view` ClusterRole is a
convenient superset.

---

## Network/flow-log import

**Discover → Network flows** turns a firewall or flow-log export into the answer
to "which of my workloads calls out, and to whom?" — the egress picture a DR plan
needs before anyone writes a partner allowlist.

**Supported inputs.** Any delimited text export with (at least) a source, a
destination and a destination port: a Palo Alto traffic log, a VPC or
security-group flow-log export, an istio egress report, or a hand-rolled
`from,to,port,proto` sheet. The delimiter (tab, comma, semicolon, pipe) is voted
from the header line. Quoted fields, embedded commas and CRLF are handled; up to
100,000 data rows and 20 columns are read, and the UI says so when it had to stop
early.

**Column auto-detection.** Header names are matched first (`src`/`source`/
`srcaddr`/`from`/`client` → source; `dst`/`dest`/`to`/`server` → destination;
`dport`/`dst_port`/`destination port` → port; `proto`/`protocol`;
`action`/`verdict`; `hits`/`count`/`sessions`/`bytes`), then the *values* are
probed for the shape the role implies — addresses, ports in 1–65535,
`tcp`/`udp`/`6`/`17`, allow/deny words, integers. Value shape confirms or
overrides a weak name guess, and a "Source Port" column is never mistaken for the
source or for the destination port. The result is a mapping card with a
confidence badge; fix any role from its dropdown and press **Re-analyze** — you
only have to get it right once per export format.

**Local-only handling.** The export is parsed **in your browser**; the file is
never uploaded. Only the parsed cells are posted to the DR Compass server running
on your own machine, which aggregates them in memory. Nothing is written to disk
until you press **Apply** — and then only the flows you assigned.

**What you get.** Flows are deduplicated on (source, destination, port,
protocol) with counts summed, sorted by volume, capped at 2,000 unique flows, and
each destination is classified:

- **aws-service** — `sqs.us-east-1.amazonaws.com` → *SQS (us-east-1)*
- **saas** — a short known list (PagerDuty, Datadog, GitHub, Slack, Stripe…)
- **internal** — RFC1918 and CGNAT ranges, `*.svc`, `*.cluster.local`,
  `*.internal`, `*.local`, `*.corp`, EC2 internal names
- **third-party** — the safe default, and the list worth reviewing

Each unique source is matched to a component or Kubernetes workload:
ReplicaSet/pod hash suffixes are stripped
(`adjudication-deploy-7d9f8b6c4d-x2k9p` → the adjudication component), `svc` DNS
names resolve through the namespace, `ns/workload` (istio) is understood, and
role words are ignored so `pricing-svc` finds `pricing-service` while
`billing-service` never matches `pharmacy-service`. A bare IP with no name gets
no suggestion — assign those yourself.

**What gets written.** On **Apply**, each assigned source's flows become
`outboundCalls` entries on its component: `target` (the friendly label),
`type` from the classification, `protocol` in `tcp/443` form plus a numeric
`port`, a `purpose` naming the observation, and provenance —
`source: "network-flows"`, `observedCount`, and the workload when it was matched
to Kubernetes. The workbook's **Outbound Calls** sheet reads that provenance.
Calls are deduplicated on target + port + protocol, so re-importing next
quarter's export raises the observed count instead of duplicating rows. External
targets also become resource-graph nodes (`net_<target>`, source
`network-import`) with a `uses` edge from the component. Internal-to-internal
traffic is recorded as outbound calls only — **DR Compass never invents
`dependsOn` links from flow data.**

**Tip:** run this *before* you define partner allowlists or firewall rules for
the recovery region. The third-party and SaaS rows are exactly the egress the
recovery region has to reproduce — and the ones a partner has to allowlist from
new IPs.

---

## Arpio

Optional. If you use [Arpio](https://arpio.io) for cross-region protection,
**Discover → Arpio** imports your protected resources as component proposals.
Nothing else in DR Compass depends on it.

Create a **read-only** API key in the Arpio console under **Settings → Account
Settings → API Keys**. Arpio hands you the key in two parts — an **API key ID**
and a **secret** — and both are required: requests authenticate with the header
`X-Api-Key: <keyId>:<secret>` (see the
[Arpio API guide](https://docs.arpio.io/arpio-api-guide)). Enter each part in its
own field, or paste a pre-combined `keyId:secret` string. Your **account ID**
(the first randomized string in your Arpio console URL, optional) scopes the scan
when the key cannot list accounts.

The client walks `/api/accounts` → `/api/accounts/{id}/applications` →
`…/resources`, and traces every step (structure only, never key material) so a
mismatch is self-diagnosing — the trace is shown on both success and failure.
Kubernetes resources are grouped into one proposal per cluster/namespace with
per-kind counts, so a 2,000-object application reviews as a handful of rows; AWS
resources arrive individually with their ARN promoted and
`replication.mechanism: arpio-recovery-point` pre-filled.

**The key is used for that request only and is never written to disk** — not to
the workspace, and not into a background job's record, progress or result.

---

## Claude Code CLI (the AI layer)

Optional and entirely local. If the [Claude Code](https://claude.com/claude-code)
CLI is installed and signed in, DR Compass shells out to it:

```
claude -p <prompt> --output-format text
```

180-second timeout, run under your own account. No CLI, no AI — every AI control
renders disabled with an install hint rather than failing. There are two ways in:

**The copilot.** `Cmd/Ctrl+K` on any page opens a drawer. Tell it what to change
("add a DynamoDB sessions table the checkout service depends on", "draft a
game-day checklist for next month") and it returns a list of concrete
**operations** — create, update, delete against a collection, or a workspace-meta
update. The conversation is in-memory only.

**Contextual actions.** Most pages carry a row of AI buttons scoped to what you
are looking at: *Find gaps in this inventory*, *Draft a verification command*,
*Review this runbook*, *Write the test record*, *Turn findings into gaps*,
*Explain this diagram*, *Draft an executive summary*. These send a **focused**
context — the object in front of you, not your whole workspace.

**The approval model, precisely.** Every AI endpoint is read-only except
`/ai/apply` and `/ai/correlate/apply`. Proposals come back annotated: an
operation the server cannot validate against the live workspace is returned
flagged and greyed out rather than dropped. You tick the ones you want; only
those are sent back, and each is **re-validated independently** at apply time, so
one bad operation never blocks the rest. Ids are always assigned by the server —
a model-invented id is stripped. **Nothing changes without your click.**

Prompts are prefixed with the honest-numbers rules from
[`measured-numbers.md`](measured-numbers.md), so the model is told, every time,
that a hand-typed RTA is *declared* and never *measured*.

**AI correlate** is the same pattern applied to discovery: given unlinked
resource-graph nodes or Kubernetes workloads, it proposes which component each
belongs to with a confidence score. Applying it only sets a component id and adds
a `uses` edge.

---

## Background jobs

AWS scan, scan & map, enrich, find-by-tag, Arpio import and the kubectl scan all
run as **server-side jobs**. The Discover page shows a live activity card with an
elapsed timer and streamed progress lines — "safe to leave or refresh, the job
keeps running" — and re-attaches to a running job when you come back. Finished
jobs are kept (the last 15 per workspace) so you can reopen their results.

One running job per kind per workspace: starting a second gets a clear "already
running" with the running job's id. **No credentials are ever written into a job
record.** A job that was still running when the server stopped is simply gone —
re-run it.

---

## Lucidchart

Every diagram is available as Mermaid source. In Lucidchart: **Insert → Diagram
as code → Mermaid**, then paste.

Lucid's importer accepts a narrow subset of Mermaid and fails the *whole* diagram
on anything outside it, so use the **Lucid flavour**: the *Copy for Lucidchart*
and *Download .mmd (Lucid)* actions on the Diagrams page (or `?flavor=lucid` on
the `.mmd` endpoint). It removes what Lucid rejects — `classDef`, `class`,
`style`, `linkStyle`, `%%{init}%%` directives, `direction` inside a subgraph,
nested subgraphs, HTML tags, non-rectangular node shapes, edge labels in
`-->|…|` form, and non-ASCII characters — and prepends a comment saying exactly
how many lines it changed, so nothing is removed silently.

If you use Lucid's MCP server with an agent such as Claude Code, hand it the
Lucid-flavour source and have the agent create the document.

## draw.io / diagrams.net

Each diagram has a **Download draw.io XML** action, in two styles:

- **plain** — swimlanes per category, rounded boxes, orthogonal dependency edges.
  Third parties are dashed; Tier-0 components are bold-bordered.
- **AWS shapes** (`?style=aws`, the *Download draw.io (AWS shapes)* button on the
  icon canvas) — uses diagrams.net's own built-in `mxgraph.aws4` shape library,
  so it renders with official AWS service icons and no extra library to install.
  A component kind with no AWS icon falls back to a plain box, so the file always
  opens.

Open the `.drawio` file in [diagrams.net](https://app.diagrams.net) or the
desktop app and edit freely.

## SVG and PNG

Rendered images come from the Diagrams page in your browser — **Download .svg**
next to the Mermaid view, and **Download SVG / Download PNG** on the icon canvas
(a designed light-theme export with a legend and the icons inlined). There is no
server-side image endpoint, which is why
[`docs/examples/`](examples/) carries Mermaid and draw.io sources rather than
pictures.

## Google Sheets / Excel

The Exports page produces:

- **Workbook (.xlsx)** — the whole workspace, or one service and its dependency
  closure. Ten sheets: *Executive Summary · How to use · Resource Graph ·
  Runtime · Outbound Calls · Dependencies · Deployment Order · Tests · Runbooks ·
  Workbench* (*Deployment Order* appears once the ordering engine has something
  to say). Import into Google Sheets via **File → Import → Upload**, or drag it
  into Drive and open with Sheets. Row outlines, freeze panes and dropdowns
  survive the import; conditional tints mostly do. Also available from the
  terminal: `drcompass export <slug> --xlsx plan.xlsx`.
- **Executive summary (.md)** — the same one-pager as the workbook's first sheet,
  rendered from the same model, for a wiki or an email.
- **CSVs** — twelve datasets (`components`, `outbound-calls`, `secrets`, `gaps`,
  `runbook-steps`, `tests`, `checklists`, `decisions`, `contacts`,
  `verification-catalog`, `resource-graph`, `k8s-workloads`) for piping into
  anything. In Sheets: **File → Import → Upload → Replace/Insert**.
- **Runbook Markdown** and a terminal-friendly **quick-ref `.txt`** — the second
  is what you want open in another window during an incident.
- **DR package (.zip)** — everything above for one service, plus diagrams and a
  cover README. The zip is assembled **in your browser**, so nothing leaves your
  machine.

Exports are generated on demand from the JSON workspace, so they are always
current — regenerate rather than edit the spreadsheet when the plan changes.

See [`docs/examples/`](examples/) for real output from the bundled example
workspace.
