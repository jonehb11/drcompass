# Deployment / recovery order

Most DR plans list *what* must come back. This one works out **what order it has
to come back in** — and, just as importantly, says why.

The order is computed, not typed. It comes from your inventory, your resource
graph and your Kubernetes snapshot, so it changes when your system changes.

## What you get

**Waves.** Everything in a wave can be built in parallel; nothing in wave *N*
can start until wave *N−1* is done. On the example workspace that comes out as
15 waves and 137 items.

**A reason on every item.** Each one records what it waits for, in operator
language — "reads secret `adjudication/db-password` at startup", "pulls images
from this registry", "has no healthy targets until `adjudication-deploy` pods
are Ready, not merely created".

**A category order** derived from where things actually land, not hardcoded:
third-party preconditions → secrets/identity → certificates and DNS zones →
registries → network → compute platform → data stores → applications →
exposure → cutover.

**Honest gaps.** Cycles are reported with a suggested break, never silently
cut. Items that can't be ordered are listed with a reason and whether you can
do anything about it.

## The rules behind it

Order comes from three sources, and every edge records which one it came from
so you can audit it:

1. **Declared dependencies** — `dependsOn` in your inventory. Highest confidence.
2. **Discovered relationships** — the resource graph's edges, read
   directionally: `secured-by` means the security group first, `in-subnet`
   means the subnet first, `encrypted-by` means the KMS key first.
3. **Type rules** — a 14-tier ladder for things no edge captures. These act as
   a *soft floor*: they can delay an item, never reorder it past a real
   prerequisite.

A few decisions worth knowing about, because they are not obvious:

- **Security groups are two steps, not one.** Creating a group and applying its
  rules are separated, because a rule that references a peer group needs that
  group to exist. A group with no ingress is a silent connectivity failure.
- **Fence before promote.** Demoting the old primary is modelled as an ordering
  edge before the data tier, not left to the operator's memory. Split-brain is
  the one failure worse than downtime.
- **Third parties are verified, not deployed.** A partner allowlist, an approved
  egress IP or a valid credential can't be built in wave 3 — it has to be true
  before you start, so it lands in wave 0 as a precondition to confirm.
- **"Ready" is different from "created".** A target group has no healthy
  backends until pods pass readiness, so the edge requires readiness and says so.
- **Public image registries are a precondition too.** If the recovery region
  can't reach `public.ecr.aws`, pods fail with `ImagePullBackOff`.

## Pods are the hard part

A workload is not deployable just because its cluster exists. Its wave is
`max(everything it mounts, everything it pulls, everything it calls at startup) + 1`:

- the ServiceAccount, and for IRSA the chain OIDC provider → IAM role → policy
- every Secret and ConfigMap it references, and the Secrets Manager secret
  behind a materialised Kubernetes secret (so the chain reads KMS → SM secret →
  K8s Secret → pod)
- its PVCs, their StorageClass and the CSI driver
- the registry it pulls images from
- **every outbound call it makes on startup** — the database it dials, the
  queue it drains, the in-cluster service it calls

That last one is why outbound calls are classified **startup** vs **runtime**.
A startup call blocks recovery; a batch call at 2am does not. Where the
classification isn't clear from the data, it says `unknown` with a reason
rather than guessing.

If a service starts in an earlier wave than something it calls at startup, that
is reported as a blocker — it would CrashLoop.

## Where to find it

- **In the app** — the Deployment order page, and inline on each Service profile.
- **In the workbook** — the *Deployment Order* sheet: wave → category → resource,
  expandable, with the waiting reason on every row.
- **In diagrams** — `deploy-order` (wave bands) and
  `startup-dependencies-<service>` (what a workload mounts and calls).
- **As a runbook** — generate one from the order; waves become gated steps. The
  runbook editor can also check an existing runbook *against* the order and flag
  steps that restore something before its prerequisites.
- **Over HTTP** — `GET /api/w/:ws/deploy-order[?componentId=]`,
  `…/deploy-order/explain/:id`, `POST …/deploy-order/to-runbook`.

## What it will not do

It won't invent timings. An item only carries an estimate when a runbook step in
your own workspace names exactly that one component; otherwise it says so and
tells you to fill the number in from a real test. A plausible-looking schedule
built from guesses is worse than no schedule.
