# The restore layer cake: gates, not timers
<!-- section: Start here | order: 40 -->

Recovery has a natural dependency order. Trying to start applications before data and
secrets exist, or cutting traffic before a business transaction has completed, wastes the
minutes you're trying to save and produces confusing half-failures. DR Compass models
this as eight layers, L0–L7. Every component carries a `restoreLayer`; every runbook step
belongs to a layer; every layer ends in a **verification you must pass before advancing**.

> **Gates, not timers.** You advance when the layer's check passes — never because
> "the docs say this takes 10 minutes". Timers are how runbooks lie to you.

## The layers

| Layer | Name | What happens | Exit gate (example verification) |
|---|---|---|---|
| **L0** | Guardrails & backups green | Nothing is launched. Confirm the *preconditions of recovery*: backups recent, replication lag within RPO, IaC pipeline green, quotas/limits in recovery region, break-glass access works | Phase 0 checklist 100% green, with timestamps |
| **L1** | Recovery launch / replication promote | Kick off environment creation: Arpio recovery point launch, Region switch plan execution, Terraform apply, restore jobs | Launch/apply completed without error; resources visible in recovery region |
| **L2** | Platform | Cluster and plumbing: EKS cluster + nodes, VPC reachability, mesh/ingress controllers, ECR images pullable | `kubectl get nodes` all Ready; a test pod pulls an image from regional ECR |
| **L3** | Data + secrets | Promote/verify databases, caches, object data; reconcile every secret and its KMS key | DB accepts writes as primary; newest-record age ≤ RPO; secret list reconciles 1:1 against inventory |
| **L4** | Applications | Deploy/scale workloads; run migrations if required | Every tier-0 deployment Ready; no crash loops; app logs clean of auth/connection errors |
| **L5** | Edge & reachability | Internal DNS, API Gateway/VPC links, NLB targets healthy, partner allowlists/egress IPs confirmed | Synthetic request traverses edge → app → DB in-region; partner test call succeeds |
| **L6** | Functional success bar | Execute the defined business transactions end to end | Every critical appTest passes with a correct result — **this stops the RTA clock** |
| **L7** | Live traffic cutover | Real user traffic shifts (DNS failover, ARC routing controls, Global Accelerator) — **game day only** | Error rate and latency at parity; business KPIs flowing |

## How to use it

**In the inventory.** Assign each component its layer: the Aurora cluster is L3, the
adjudication service L4, Route 53 records L5, the clearinghouse allowlist L5. The
`restore-layers` diagram then *is* your recovery order, generated, not hand-drawn.

**In the runbook.** Group steps by layer and mark layer boundaries as `gate: true`
steps. A gate step's `verify` is a command and its `pass` is an observable condition —
"looks fine" is not a pass condition. Record a timestamp at each gate; those timestamps
are how you later find that L3 ate 70% of your RTA.

**In the test.** Verify layer by layer and *stop at the first failed gate*. A failed L3
gate with a clean stop is a great test — you learned the real blocker without burning an
hour debugging L4 symptoms of an L3 cause (apps failing because secrets are missing look
like app bugs until you check the layer below).

## Why the gates are ordered this way

- **L0 before anything:** if backups/replication were already broken, launching just
  recovers the outage into the recovery region. Phase 0 red = stop.
- **L3 before L4:** applications started before data and secrets exist will start, fail,
  crash-loop, and poison your signal. The #1 cause of L4 chaos is an L3 shortcut —
  usually secrets (see [secrets pitfalls](#/learn/13-secrets-pitfalls)).
- **L6 before L7:** shifting live traffic onto a stack that has never completed a
  business transaction converts a regional outage into a customer-facing incident *you*
  caused. L7 is a separate, deliberate act with its own approval — in ordinary recovery
  tests you stop at L6 and tear down.

## Anti-patterns

- **The heroic parallel start** — launching all layers at once "to save time". You save
  nothing; the failures just arrive shuffled.
- **Timer-driven advancement** — "wait 15 minutes then proceed". Either the gate passes
  or it doesn't; a timer is a gate you were too rushed to define.
- **Verification by dashboard** — your observability stack is a component too (usually
  L2/L4). Until it's recovered, verify with direct commands, not graphs.
- **Skipping L5** — everything works from inside the VPC and no customer can reach it.
  Edge, DNS TTLs, and partner allowlists are recovery work, not launch-day config.
