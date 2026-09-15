# ARC routing controls & Route 53 failover: the traffic switch
<!-- section: Tooling | order: 80 -->

Everything else in the program exists so that, at the end, you can safely answer one
question: *which region gets the traffic?* Two AWS mechanisms answer it — Route 53
failover records driven by health checks, and ARC routing controls driving those health
checks like a hand-operated switch. Understanding the control-plane/data-plane split is
what separates designs that work during a regional event from designs that only work in
diagrams.

## The rule that governs everything: fail over on the data plane

Route 53's **control plane** (the APIs that create/update records) runs in **one region:
us-east-1**, and is optimized for consistency, not availability — and it is not covered
by the SLA. The **data planes** — DNS query answering and health-check evaluation — are
globally distributed and designed for **100% availability**
([Well-Architected REL11-BP04](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_withstand_component_failures_avoid_control_plane.html),
[fault isolation whitepaper](https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/appendix-b---edge-network-global-service-guidance.html)).

So: a failover that *edits records or re-weights routing policies during the event* is a
control-plane dependency on the very kind of infrastructure that may be impaired
(us-east-1 events have repeatedly degraded control planes — see the
[case studies](#/learn/15-case-studies)). A failover that only *changes health-check
state* rides the data plane. Design so the event-day action is data-plane only; record
changes are for peacetime. (If you must be able to edit public DNS during a us-east-1
impairment, Route 53's newer **accelerated recovery** for public hosted zones targets a
~60-minute RTO for record changes —
[docs](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/accelerated-recovery.html) —
useful, but a backstop, not a failover mechanism.)

## Route 53 failover records + health checks

- **Active-passive**: the **failover routing policy** — PRIMARY and SECONDARY records;
  Route 53 serves the secondary only when the primary's health checks fail
  ([failover types](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html)).
- **Active-active**: any non-failover policy (weighted, latency…); unhealthy records are
  simply dropped from answers.
- **Health check types** ([docs](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-types.html)):
  endpoint probes (HTTP/HTTPS/TCP from Route 53's checker fleet), **calculated** checks
  (aggregate other checks), **CloudWatch alarm** checks (evaluated against the alarm's
  metric stream directly), and **ARC routing control** checks — the on/off-switch kind.
- **TTL**: 60–120 seconds on failover-involved records is AWS's recommendation. Audit
  the whole chain — see [third-party dependencies](#/learn/14-third-party-dependencies)
  for the resolvers that ignore you.
- Endpoint health checks give you *automatic* failover — and automatic false positives.
  For regional evacuation most mature shops want a **human decision, machine execution**:
  that's what routing controls are for.

## ARC routing controls: health checks that don't check health

A **routing control** is a simple on/off switch hosted on a **cluster** — a data plane
of **five redundant regional endpoints** that changes state by quorum across five
regions ([docs](https://docs.aws.amazon.com/r53recovery/latest/dg/routing-control.html)).
Each routing control backs an ARC-type Route 53 health check attached to your failover
records: flip the control, the health check flips, DNS answers change. No record edits,
no probes guessing — a deliberate switch, with the ARC cluster carrying a
**100% monthly-uptime SLA** ([SLA](https://aws.amazon.com/application-recovery-controller/sla/)).

**Safety rules** keep humans-at-3am from making it worse:

- **Assertion rules** — constraints on state changes (e.g., "at least one region's
  control must remain On"), preventing fail-open/fail-nowhere states.
- **Gating rules** — a gating control that must itself be On before target controls can
  change, blocking both manual and automated flips (your "two-person rule" switch).
  Both can be overridden in a genuine emergency.

**Operational best practices** (AWS's own, and battle-tested —
[docs](https://docs.aws.amazon.com/r53recovery/latest/dg/route53-arc-best-practices.regional.html)):

| Practice | Why |
|---|---|
| Hard-code/bookmark all five cluster endpoints + routing control ARNs in the runbook | Discovery APIs are control plane; the event is not the time to look things up |
| Use the CLI/SDK against cluster endpoints, trying endpoints at random with retries — not the console | `UpdateRoutingControlState` is the highly available data plane; the console isn't |
| Keep purpose-built, long-lived credentials in a break-glass safe | Your SSO may be in the blast radius |
| TTL 60–120s; shorten client keepalives (e.g., ALB 3600s → ~300s) | Old connections pin traffic to the dead region long after DNS moves |
| Test the flip regularly | A switch nobody has thrown is a hypothesis |

Know the split here too: routing-control **configuration** APIs live in us-west-2 and
are explicitly *not* highly available; only the runtime state changes are
([data planes](https://docs.aws.amazon.com/r53recovery/latest/dg/data-and-control-planes.html)).
Build the controls in peacetime.

**Cost**: $2.50/hour per cluster (≈$1,825/month) — one cluster serves many applications
and control panels ([pricing](https://aws.amazon.com/application-recovery-controller/pricing)).

**Readiness checks**, ARC's old third leg, are **no longer open to new customers**
(existing customers continue) — and AWS itself warned against using them as a failover
trigger ([notice](https://docs.aws.amazon.com/r53recovery/latest/dg/recovery-readiness.html)).
The replacement for "am I ready?" is your Phase 0 checklist plus Region switch's
30-minute plan evaluation ([Region switch](#/learn/07-tooling-region-switch)) — don't
build new dependence on readiness checks.

## Putting it together

A clean L5/L7 design: failover records with 60s TTLs → ARC-type health checks → routing
controls guarded by an assertion rule → flipped either by your operator (runbook step,
CLI, five endpoints listed) or by a Region switch plan's **ARC routing control block**
as the final act after data and compute gates pass. The DNS layer never needs a
control-plane call while the world is on fire — that's the entire point.
