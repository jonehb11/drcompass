# Case studies: what good looks like in public
<!-- section: Case studies | order: 150 -->

Everything in this knowledge base is practiced somewhere at scale, in public. These
studies are verified against primary sources (engineering blogs, AWS post-event
summaries, re:Invent sessions); claims we couldn't verify are flagged rather than
repeated. The common thread: **the companies that survive regional events are the ones
for whom regional failover is routine, rehearsed, and measured.**

## Netflix: evacuation as a habit

The founding example of regional DR as a *practice* rather than a plan.

- **2013 — active-active**: Netflix built multi-regional active-active with DNS-based
  traffic switching and introduced **Chaos Kong**, the exercise that evacuates an entire
  region ([Active-Active for Multi-Regional Resiliency](https://netflixtechblog.com/active-active-for-multi-regional-resiliency-c47719f6685b)).
- **2015 — the payoff**: when DynamoDB failed in us-east-1 (Sept 20, 2015) and took down
  much of the internet, Netflix "sidestepped any significant impact" — because regular
  Chaos Kong runs (roughly every few weeks) meant evacuating the region was just
  Tuesday ([Chaos Engineering Upgraded](https://netflixtechblog.com/chaos-engineering-upgraded-878d341f15fa); AWS post-event: [aws.amazon.com/message/5467D2](https://aws.amazon.com/message/5467D2)).
- **2018 — engineering the RTA down**: evacuation took **~45–50 minutes**, dominated by
  waiting for savior regions to scale. **Project Nimble** pre-provisions "hot standby"
  shadow capacity inside live clusters and shifts traffic progressively at the proxy
  (Zuul) layer before DNS cutover — bringing failover to **~7 minutes**, cost-neutral
  ([Project Nimble](https://netflixtechblog.com/project-nimble-region-evacuation-reimagined-d0d0568254d4),
  [How Netflix does failovers in 7 minutes flat](https://opensource.com/article/18/4/how-netflix-does-failovers-7-minutes-flat)).

**Lessons**: (1) RTA improvement came from *pre-provisioned capacity*, not faster
reactions — reactive scaling was the bottleneck, exactly the capacity caveat in the
[strategy matrix](#/learn/05-strategy-matrix). (2) 45 minutes → 7 minutes happened
because they measured every run — you can only compress a number you record. (3) The
confidence to use the mechanism in a real event came from scheduled production practice.

## Capital One: from runbooks to automated recovery

A regulated bank running mission-critical workloads across regions on AWS.

- **re:Invent 2023 (FSI314)**: multi-Region patterns with Route 53, Auto Scaling,
  DynamoDB and Aurora; cell-based architecture; game days and chaos engineering as
  continual practice ([session](https://www.youtube.com/watch?v=hgIqWCRKA2k),
  [slides](https://d1.awsstatic.com/events/Summits/reinvent2023/FSI314_Capital-One-Achieving-resiliency-to-run-mission-critical-applications.pdf)).
- **re:Invent 2025 (ARC404)**: their current shape — automated dependency mapping built
  from live telemetry (metrics/errors/logs/traces), **~70% reduction in average recovery
  time** across resiliency tiers through recovery automation, adoption of **ARC Region
  switch** for orchestrated regional failover with a *human making the go/no-go call
  and machines executing*, and continuous testing with AWS Fault Injection Service
  ([session notes](https://dev.to/kazuya_dev/aws-reinvent-2025-building-resilient-multi-region-applications-with-capital-one-arc404-3h77)).
- Their chaos-engineering-at-enterprise posts document the organizational side —
  starting small, regional autonomy, avoiding cross-region dependencies
  ([Continuous Chaos](https://www.capitalone.com/tech/software-engineering/continuous-chaos-introducing-chaos-engineering-into-devops-practices/)).

**Lessons**: (1) Dependency maps decay — Capital One stopped trusting hand-maintained
inventories and generates the graph from telemetry; your inventory review cadence is the
budget version of the same insight. (2) "Human decides, machine executes" is the mature
failover pattern — the same split this guide draws between the decision to declare and
the [Region switch plan](#/learn/07-tooling-region-switch) that executes. (3) Tiering
drives investment: the 70% figure is *across tiers*, not uniform gold-plating.

## Vanguard: hazard analysis before chaos

- **re:Invent 2022 (ARC306)**: Vanguard's chief cloud architect presented their global
  multi-region strategy for investment platforms — active-passive vs active-active
  decisions, data consistency, routing
  ([session](https://www.youtube.com/watch?v=ilgpzlE7Hds)).
- **FMEA-driven chaos**: mission-critical teams must run **failure mode & effects
  analysis**; FMEA output becomes the hypothesis list for chaos experiments on their
  in-house platform ("Climate of Chaos" — experiment templates, emergency stop)
  ([AWS DevOps Blog](https://aws.amazon.com/blogs/devops/hazard-analysis-and-chaos-engineering-at-vanguard-group/),
  [SREcon20 talk](https://www.usenix.org/conference/srecon20americas/presentation/yakomin)).

**Lesson**: enumerate failure modes *first*, then test the ones that matter — the
structured version of this guide's gaps-before-game-days ordering. Random chaos finds
random things; targeted chaos validates your actual risk register.

## Slack: making exercises approachable

- **Disasterpiece Theater** (Richard Crowley, 2019): planned, well-announced production
  fault-injection exercises — rehearse in dev, go/no-go review, execute in production,
  debrief measuring time-to-detect and time-to-resolve. Dozens run; they surfaced real
  flaws (cache inconsistency, an AZ network partition that took three attempts to
  simulate correctly)
  ([slack.engineering](https://slack.engineering/disasterpiece-theater-slacks-process-for-approachable-chaos-engineering/)).
- Honesty note: Slack's published exercises are **AZ- and service-level**, not regional
  evacuation — cited here for exercise *process*, not multi-region architecture.

**Lessons**: (1) The dev-rehearsal → go/no-go → production → debrief loop is this
guide's [Phase 1 → Phase 2 ladder](#/learn/12-testing-program) with different names.
(2) "It took three attempts to simulate the failure correctly" — even *breaking* things
properly requires practice. (3) Announced, supervised exercises with abort criteria got
a fast-moving company to test in production without heroics.

## Fidelity: chaos on the money path

- **re:Invent 2024 (FSI318)**: Fidelity's SRE organization on chaos engineering at scale
  with AWS FIS against their modernized trade-processing/Order Management System,
  including data flow across regions
  ([session](https://www.youtube.com/watch?v=mYKNR0UXwMc)).

**Lesson**: fault injection is applied to the *most* critical path, not the safest one —
if the trade path can be tested, your claims path can too.

## The motivating incidents

| Incident | What happened | The lesson it bought |
|---|---|---|
| **DynamoDB, us-east-1, Sept 20 2015** | Metadata subsystem overload; ~5h of elevated errors; took down major sites ([AWS summary](https://aws.amazon.com/message/5467D2)) | Practiced evacuation works: Netflix left the region and barely noticed |
| **S3, us-east-1, Feb 28 2017** | Operator playbook typo removed too many index servers; S3 down ~4h, cascading to ELB/RDS/etc. **Other regions unaffected** ([AWS summary](https://aws.amazon.com/message/41926)) | The canonical argument for regional isolation — and for the most likely disaster being an operational mistake, not weather |
| **DynamoDB DNS, us-east-1, Oct 19–20 2025** | Latent race in DynamoDB's automated DNS management left an **empty DNS record** for the regional endpoint; ~14.5h to full recovery; cascaded into EC2 launches, NLB health checks, Lambda/ECS/EKS/STS ([AWS summary](https://aws.amazon.com/message/101925)) | Control planes and service dependencies share fate within a region; failovers relying on us-east-1 control-plane calls were part of the outage, not the escape from it — see [ARC & Route 53](#/learn/08-tooling-arc-route53) |

## The pattern

Across every study: **inventory and dependency truth kept current (increasingly by
automation) → pre-provisioned capacity and data already in place → data-plane switch →
humans deciding, machines executing → and above all, a schedule.** Netflix's 7 minutes,
Capital One's 70%, Slack's dozens of exercises are all the same sentence: they did it
again and again, measured it, and fixed what the measurement showed. That is the whole
program — the rest is [details](#/learn/01-where-to-start).
