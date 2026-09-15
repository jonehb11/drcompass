# GitOps & IaC: the control plane outside the blast radius
<!-- section: Tooling | order: 100 -->

Recovery is a deployment under the worst possible conditions. Everything that makes
deployments boring — code, pipelines, immutability, review — is DR tooling. Four
principles turn IaC/GitOps from "how we ship" into "how we recover".

## 1. Your control plane must live outside the blast radius

If CI/CD, your git host, your artifact registry, or your orchestration tooling runs only
in the primary region, then the disaster takes out production *and the machinery that
rebuilds production*. Walk the chain and ask, for each link, "does this work while
us-east-1 is dark?":

| Link | Blast-radius check |
|---|---|
| Git hosting | SaaS (own region concentration?) or self-hosted in… which region? |
| CI/CD runners & pipeline state | Can a pipeline *execute* targeting the recovery region, from the recovery region or a third place? |
| Artifact/image registry | ECR replicated cross-region? Images pullable **before** the cluster needs them (that's an L2 gate) |
| IaC state (e.g., Terraform state bucket + lock table) | Replicated and reachable? Un-lockable state = unrecoverable shape |
| Secrets used *by* deployment | Deploy credentials valid for the recovery region, stored redundantly |
| The orchestrator of the failover itself | A Step Functions/Jenkins job in the primary region orchestrating that region's evacuation cannot work — this is why ARC Region switch executes from the region being *activated* ([Region switch](#/learn/07-tooling-region-switch)) |

This is the same principle AWS applies internally: Well-Architected
**REL11-BP04, "Rely on the data plane and not the control plane during recovery"**
([docs](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_withstand_component_failures_avoid_control_plane.html))
and the Builders' Library essay on **static stability** (Weiss & Furr): a statically
stable system keeps working when a dependency is impaired, because recovery doesn't
require calling the impaired thing
([builders' library](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/)).
Your deployment machinery is a dependency like any other.

## 2. Symmetry: failover changes one variable

The recovery region's definition should differ from the primary's by **one input** —
a region variable, a tfvars file, an ApplicationSet parameter — not by a parallel,
lovingly hand-maintained second codebase. Every hardcoded `us-east-1`, every regional
ARN pasted into an app config, every "the DR copy of this module is slightly different"
is a divergence that will surface at the worst moment. (This "one-variable" formulation
is practitioner convention rather than a single AWS doctrine, but the whitepaper's IaC
mandate points the same way: without IaC, restoring the workload "may be complex … and
possibly exceed your RTO"
([whitepaper](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)).)

Enforcement, not intention: lint for region literals; prefer logical names resolved
locally over full ARNs ([secrets pitfalls](#/learn/13-secrets-pitfalls)); and prove
symmetry by **actually applying the recovery variant on a schedule** — that's your
recovery-test loop's L1/L2. Config that hasn't been applied lately is config that has
drifted.

In DR Compass, the component field `definedIn` records where each component's IaC lives.
An empty `definedIn` on a tier-0 component means its shape exists only in the console —
file the gap.

## 3. Git is the source of truth — so truth must be in git

GitOps engines (Argo CD, Flux) make recovery a pointer flip: aim the recovery cluster at
the same repo/revision and reconciliation rebuilds L4 from truth. That only works if
truth is actually in git:

- **No console changes, ever, but especially during an event.** The 3am console hotfix
  is invisible to the next apply, which will silently revert it — or worse, the "fix"
  becomes load-bearing and unreproducible. During recovery, changes go through git even
  when it hurts; if an emergency console action is truly unavoidable, it's written down
  in the incident log *as a debt* and backported the same day.
- **Pin what you deploy.** `latest` tags and unpinned Helm charts mean the recovery
  region may build something different from what production ran. Reproducibility is an
  RTO feature.
- **Drift detection is Phase 0.** A clean `terraform plan` / synced Argo app against the
  recovery configuration, on a daily schedule, is the cheapest possible proof that the
  [shape problem](#/learn/03-two-problems) is still solved. Red plan = red Phase 0.

## 4. Data-plane bias in what you automate

When designing the failover path itself, prefer actions that are data-plane operations
of highly available systems (flip an ARC routing control, let DNS health checks answer)
over control-plane operations (edit Route 53 records, re-weight, create infrastructure)
— see [ARC & Route 53](#/learn/08-tooling-arc-route53). Corollary for pilot light: the
more that *already exists* in the recovery region, the fewer control-plane calls your
worst hour depends on. Pre-created infrastructure isn't just faster — it's a smaller set
of things that can refuse to be created while the cloud is having a bad day.

## The payoff

Done right, the runbook's L1–L4 collapses toward: *point the pipelines at the recovery
region; apply; let reconciliation converge; verify gates.* Boring. Every recovery test
then exercises the same path as every deploy, which means you test parts of your DR
posture dozens of times a day without noticing. That is the quiet end-state the
[case studies](#/learn/15-case-studies) all share: recovery machinery so routine it has
stopped being special.
