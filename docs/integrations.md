# Integrations

DR Compass is local-first: every integration below runs from your machine,
with your credentials, and produces *proposals* or *files* you control. The
app itself never stores cloud credentials.

## AWS CLI discovery (scan & map)

The **Discover → AWS** page shells out to your local `aws` CLI to enumerate
resources in a region and propose inventory components. With **Map
dependencies** on (the default), the scan also pulls each resource's
associations — security groups, subnets & AZs, IAM roles, target groups,
KMS keys, tags — the way a recovery tool builds its resource graph.
Requirements:

- `aws` CLI v2 installed and on your `PATH`
- a configured profile (`~/.aws/config` / `~/.aws/credentials`); DR Compass
  lists your profiles and lets you pick one, plus a region and the services
  to scan
- discovery degrades gracefully if the CLI is missing — you'll get a clear
  message, not a crash (and the script path below still works)

### Authenticating (SSO & aws-vault)

The profile picker merges two sources: profiles from `~/.aws/config` /
`~/.aws/credentials` (SSO profiles are labeled **(SSO)**) and, when
`aws-vault` is installed, the profiles in your vault (**(aws-vault)**, or
**(SSO · vault)** when a profile appears in both). Vault-only profiles run
every CLI call as `aws-vault exec <profile> -- aws …` instead of
`--profile`; the command log shows exactly which form ran.

Before any heavy AWS action (Scan & map, Enrich, Arpio overlay, Pull by
tags) DR Compass runs a **credential pre-flight** — one
`sts get-caller-identity` through your own CLI. A valid session shows
"✓ authenticated as *account*" and the action starts immediately. An
expired session shows an inline **Authenticate** card instead: clicking it
launches `aws sso login --profile <name>` (or `aws-vault exec`, which opens
its own browser/keychain prompt) *on your machine* — the sign-in happens in
your browser on AWS's own page. The UI polls until the session works, then
auto-starts the action you originally asked for. Profiles with static keys
have no login flow to launch; refresh those in your terminal.

Credentials never touch DR Compass: it only ever sees the resulting
identity metadata (account id + role ARN) and the CLI's stderr text —
tokens, keys, and browser cookies stay with the AWS CLI / aws-vault / your
OS keychain.

Scan results appear as a **proposal tree**: each proposed component row can
be expanded to show the mapped resources that come along with it (they are
informational — importing a component always brings its mapped resources),
and shows a "→ depends on" line when it depends on other proposals in the
same result. **Checking a proposal automatically selects everything in its
dependency closure** — check an ALB and its target groups' services,
security groups, and so on come too. Unchecking something another selected
proposal depends on is allowed, but the row is flagged with a "needed by …"
warning so you don't strand a dependency by accident. Importing writes the
components to the inventory and their mapped resources into the resource
graph (explore them on the Diagrams page by clicking nodes).

**No credentials on the machine running DR Compass?** Next to the scan
controls, download the **read-only discovery script** — plain bash around
the same `list`/`describe` calls, scoped to the services you selected. Run
it wherever your credentials live (a bastion, CI, a locked-down laptop),
read it first if you like, then drop the JSON artifact it produces onto the
upload zone: you get the exact same proposal tree to review and import.

Discovery is strictly read-only. The simplest setup is the AWS-managed
`ReadOnlyAccess` policy on the role/user behind the profile. For a
least-privilege profile, `Describe*`/`List*`/`Get*` on the scanned services
is enough — for example:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ec2:Describe*",
      "eks:ListClusters", "eks:DescribeCluster",
      "rds:Describe*",
      "elasticache:Describe*",
      "dynamodb:ListTables", "dynamodb:DescribeTable",
      "s3:ListAllMyBuckets", "s3:GetBucketLocation",
      "sqs:ListQueues", "sqs:GetQueueAttributes",
      "kinesis:ListStreams", "kinesis:DescribeStreamSummary",
      "sns:ListTopics",
      "lambda:ListFunctions",
      "secretsmanager:ListSecrets",
      "kms:ListKeys", "kms:ListAliases",
      "route53:ListHostedZones", "route53:ListResourceRecordSets",
      "cloudfront:ListDistributions",
      "apigateway:GET",
      "elasticloadbalancing:Describe*",
      "ecr:DescribeRepositories",
      "ecs:ListClusters", "ecs:DescribeClusters",
      "iam:ListRoles", "iam:ListOpenIDConnectProviders",
      "cloudwatch:DescribeAlarms",
      "backup:ListBackupVaults", "backup:ListBackupPlans"
    ],
    "Resource": "*"
  }]
}
```

Trim this to the services you actually scan. Everything returned is a
proposal you review before it touches your inventory.

## Arpio

If you use [Arpio](https://arpio.io) for cross-region protection, **Discover
→ Arpio** imports your protected resources as component proposals.

Create a **read-only** API key in the Arpio console under **Settings →
Account Settings → API Keys**. Arpio hands you the key in two parts — an
**API key ID** and a **secret** — and both are required: requests
authenticate with the header `X-Api-Key: <keyId>:<secret>` (see the
[Arpio API guide](https://docs.arpio.io/arpio-api-guide)). Enter each part
in its own field, or paste the pre-combined `keyId:secret` string into the
key ID field. Your **account ID** (the first randomized string in your
Arpio console URL, optional in the form) scopes the scan when the key can't
list accounts.

The key is used for that request only — it is not written to disk. Imported
components arrive pre-annotated with replication information where Arpio
provides it.

## Claude Code CLI (AI assist)

If the [Claude Code](https://claude.com/claude-code) CLI is installed and
authenticated locally, **Discover → AI** (and AI-assist prompts elsewhere)
shell out to `claude -p` non-interactively — for example to draft component
descriptions, suggest missing dependencies, or sanity-check a runbook. You
can opt to include your workspace as context; the call runs entirely through
your local CLI and your own Anthropic account. Requests time out after 120
seconds, and you get a helpful error if the CLI isn't present. No CLI, no AI
— the feature is fully optional.

## Lucidchart

Every diagram is available as Mermaid source. In Lucidchart, use **Insert →
Diagram as code → Mermaid** and paste the source from the Diagrams page for
an editable Lucidchart shape set. If you use Lucid's MCP server with an AI
agent (such as Claude Code), you can also hand the Mermaid source to the
agent and have it create the Lucidchart document for you.

## draw.io / diagrams.net

Each diagram has a **Download draw.io XML** action. Open the `.drawio` file
in the [diagrams.net](https://app.diagrams.net) editor or the draw.io desktop
app and edit freely. (diagrams.net can also insert Mermaid directly via
**Extras → Edit Diagram** / Mermaid insert, if you prefer the text route.)

## Google Sheets / Excel

The Exports page produces:

- **Workbook (.xlsx)** — the whole workspace, one sheet per collection.
  Import into Google Sheets via **File → Import → Upload** (or drag it into
  Drive and open with Sheets). Also available from the terminal:
  `drcompass export <slug> --xlsx plan.xlsx`.
- **CSVs** — one per sheet, for piping into anything. In Sheets: **File →
  Import → Upload → Replace/Insert**.
- **Runbook Markdown** — paste into your wiki of record.

Exports are generated on demand from the JSON workspace, so they're always
current — regenerate rather than edit the spreadsheet when the plan changes.

## Kubernetes / EKS application layer

**Discover → Kubernetes** captures the *application* layer of a cluster —
namespaces, workloads (Deployments/StatefulSets/DaemonSets/CronJobs),
Services, and Ingresses — and links what it finds to your inventory
components. Three capture paths, all strictly read-only:

1. **Scan with kubectl** — DR Compass shells out to your local `kubectl`
   with your own kubeconfig. Only read-only `kubectl get -o json` commands
   run (the exact commands appear in the log); nothing in the cluster is
   modified, and no cluster credentials are read, sent, or stored. Pick a
   context (your current one is pre-selected) and optionally restrict to a
   comma-separated namespace list — blank scans all application namespaces.
2. **Run a script yourself** — for locked-down environments where the
   machine running DR Compass has no cluster access. Download the snapshot
   script, run it wherever you *do* have access (a bastion, a CI runner —
   it only reads), and upload the JSON artifact it produces back on the
   Kubernetes tab. You can (and should) read the script first: it is plain
   bash around the same read-only `kubectl get` calls.
3. **Ask the AI copilot** — with a snapshot stored, the copilot
   (Cmd/Ctrl+K) can help interpret it, link workloads to inventory
   components, or draft components for workloads you haven't cataloged.

What the snapshot contains: object names, namespaces, labels, replica
counts, images, service/ingress wiring, and references between them.
For Secrets and ConfigMaps it records **names only — never values or
data**. The stored snapshot shows its capture time, source (kubectl scan
or uploaded artifact), and cluster, feeds the `k8s-cluster` diagram, and
can be re-scanned or deleted at any time from the same tab.

RBAC for a least-privilege scan (or script) identity: `get`/`list` on
`namespaces`, `deployments`, `statefulsets`, `daemonsets`, `cronjobs`,
`pods`, `services`, `ingresses`, and (names only) `secrets`/`configmaps` —
the built-in `view` ClusterRole is a convenient superset.

## Deep AWS resource enrichment

The AWS scan proposes components; **deep enrichment** (Discover → AWS →
*Deep enrichment*) goes a level further and pulls each component's real
associations into the resource graph you see when you click a node on the
Diagrams page. Per service, that means for example:

- **ELB/ALB/NLB** → listeners, target groups (and their health), security
  groups, subnets & AZs, ACM certificates
- **EKS** → nodegroups, the OIDC provider, add-ons, cluster security
  groups and subnets
- **RDS/Aurora** → DB subnet groups, parameter groups, security groups,
  the KMS key, and AZ placement
- **Lambda** → execution role, VPC config (subnets/SGs), event source
  mappings
- **ElastiCache / MSK / EFS** → subnet groups, security groups, KMS
- **Everything** → IAM roles and attached policies, tags, security
  groups, subnets and their AZs

Run it against selected inventory components (any component that lists
AWS services is eligible), or use one of the focused modes below.

### Arpio-first overlay

If you protect workloads with [Arpio](https://arpio.io), the fastest
high-precision path is **Arpio first**: import your protected resources on
the **Discover → Arpio** tab (API key, read-only), then press **Arpio
overlay → Map dependencies for Arpio-imported components** on the AWS tab.
The overlay enriches *only* the components that came from Arpio, matching
them by their exact ARNs — no account-wide scan, no name guessing. In the
results, "matched by" shows **exact** (ARN) for these; heuristic name
matches show as **name**. If the overlay reports zero targeted components,
import on the Arpio tab first.

### Correlate by tag (multi-tag filters)

**Correlate by tag** sweeps the region for resources by tag and is great
for finding what your inventory missed. Build a list of tag filters — each
row is a tag key plus one or more comma-separated values. Semantics: a
resource must match **every row** (AND across rows), and within a row
**any listed value** counts (OR within values). So `app = claims-platform,
pricing` plus `env = prod` finds prod resources of either app. Matched
resources land in the resource graph; unmatched-to-inventory ones stay
*unlinked* so you can review them before adopting them. With **Propose
components for app-level matches** on, app-level resources you don't have
components for come back as proposals in the same review-and-import tree
as a scan. Your filter list is remembered locally in the browser.

Enrichment shells out to the same local AWS CLI as discovery and is
read-only end to end — `Describe*`/`List*`/`Get*` calls only, all shown in
the command log. The least-privilege policy in the
[AWS CLI discovery](#aws-cli-discovery-scan--map) section above covers it; add
`elasticloadbalancing:Describe*`, `acm:ListCertificates`,
`iam:ListAttachedRolePolicies`, `eks:ListNodegroups`,
`eks:DescribeNodegroup`, `eks:ListAddons`, and
`tag:GetResources` if you trimmed that policy down.
