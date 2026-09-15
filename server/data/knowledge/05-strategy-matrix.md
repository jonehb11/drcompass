# The four strategies: an honest matrix
<!-- section: Strategies | order: 50 -->

AWS's whitepaper *Disaster Recovery of Workloads on AWS* defines four multi-Region
strategies, in increasing order of cost and complexity and decreasing RTO/RPO. The
framing is good; most write-ups sand off the honest parts. Here is the matrix with the
sharp edges left on.

## The matrix

| | Backup & restore | Pilot light | Warm standby | Multi-site active/active |
|---|---|---|---|---|
| **RTO** (official framing) | Hours (up to ~24h) | 10s of minutes | Minutes | Near zero — potentially zero |
| **RPO** (official framing) | Hours (PITR can reach ~minutes) | Minutes | Seconds | Near zero (except data-corruption events) |
| **What runs in recovery region** | Nothing — backups + IaC only | Data replication live; core infra provisioned; compute **off** | Scaled-down but **fully functional** copy, always on | Full capacity, serving live traffic |
| **Can it serve traffic right now?** | No | No — action required first | Yes, at reduced capacity | Yes, at full capacity |
| **Steady-state cost** | Storage + copies (very low) | Low–medium: replication + idle infra | Medium–high: everything running small | ~2× production, plus routing machinery |
| **Complexity** | Low | Medium | Medium–high | High — and it never stops being high |
| **Failure mode it hides** | Restore never tested; RTO fictional | "Turning on compute" is 40 untested steps | Scale-up hits quota/capacity limits at the worst time | Correctness: write conflicts, replication assumptions baked into app code |
| **Testing burden** | Restore drills | Full recovery-test loop | Recovery-test loop + scale-up drills | Continuous — evacuation must be routine |

Source framing: the whitepaper's strategy chapter and Well-Architected REL13-BP02
([disaster-recovery-options-in-the-cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html),
[REL13-BP02](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_disaster_recovery.html)).

## The distinctions people get wrong

**Pilot light vs warm standby** is a bright official line: pilot light *cannot process
requests without additional action*; warm standby *can handle traffic (at reduced
capacity) immediately*. If your "warm standby" needs a Terraform apply before it serves a
request, it's a pilot light and its RTO is pilot-light RTO. Say so.

**Active/active is not a bigger warm standby.** There's no failover — you *evacuate* a
region. That forces application-level decisions about writes (the whitepaper's write
global / write local / write partitioned patterns: Aurora Global for write-global,
DynamoDB global tables' last-writer-wins for write-local). It's an architecture, not a
DR add-on, and it makes *every* deploy a multi-region deploy forever.

**"RPO in seconds" is a property of the replication, not the strategy.** A warm standby
whose S3 replication silently stopped has an RPO of "since the incident began". The
strategy sets the ceiling; Phase 0 monitoring sets the floor. Never quote the column
header as your RPO — quote your last measured RPA
([fundamentals](#/learn/02-dr-fundamentals)).

## How to choose

1. **Start from the tier, not the tech.** Map the business tolerance (tier table in
   [fundamentals](#/learn/02-dr-fundamentals)) to the RTO/RPO row. Tier 3 + active/active
   is money on fire; tier 0 + backup & restore is a resignation letter with extra steps.
2. **Mix strategies across the estate.** One workspace, one *default* strategy
   (Settings), with per-component overrides (`drStrategy`) for the exceptions — the
   tier-3 wiki on backup & restore, the tier-0 ledger on warm standby.
3. **Price the test loop, not just the infrastructure.** A strategy you can't afford to
   test monthly is a strategy you don't have. Pilot light with a rock-solid monthly test
   beats an untested warm standby — measured RTA beats theoretical RTO every time.
4. **Check capacity assumptions.** Pilot light and warm standby both assume the recovery
   region will sell you the compute during a regional event — when everyone else is
   asking too. Quotas raised in advance, and capacity reservations for tier-0, are part
   of the strategy's price. (Even AWS's Region switch scaling blocks explicitly don't
   guarantee capacity and recommend on-demand capacity reservations.)
5. **Let the data layer veto.** Your database's replication options constrain the whole
   column: Aurora Global Database supports seconds-RPO strategies; a database restored
   from nightly snapshots caps you at backup & restore RPO no matter how warm the
   compute is. See [replication mechanisms](#/learn/16-replication-mechanisms).

## Movement between columns

Programs mature rightward: backup & restore → pilot light is mostly replication work
([the bytes](#/learn/03-two-problems)); pilot light → warm standby is mostly compute cost;
warm standby → active/active is an application rewrite. Plan the first two as program
milestones. Treat the third as a product decision that needs its own business case.
