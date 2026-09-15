# Integrations

DR Compass is local-first: every integration below runs from your machine,
with your credentials, and produces *proposals* or *files* you control. The
app itself never stores cloud credentials.

## AWS CLI discovery

The **Discover → AWS** page shells out to your local `aws` CLI to enumerate
resources in a region and propose inventory components. Requirements:

- `aws` CLI v2 installed and on your `PATH`
- a configured profile (`~/.aws/config` / `~/.aws/credentials`); DR Compass
  lists your profiles and lets you pick one, plus a region and the services
  to scan
- discovery degrades gracefully if the CLI is missing — you'll get a clear
  message, not a crash

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
