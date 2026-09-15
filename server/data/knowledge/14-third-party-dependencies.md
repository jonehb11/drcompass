# Third parties: the dependencies you can't redeploy
<!-- section: Running the program | order: 140 -->

Your recovery region can be perfect — platform up, data fresh, apps green — and the
business still down, because a partner's firewall has never heard of your new egress IPs.
Third-party dependencies are the part of DR you cannot fix during the event, which means
all the work happens before it.

## The outbound-call inventory

For every component, record every call that leaves your control — that's the
`outboundCalls[]` array in the inventory (type: `third-party | saas | on-prem`). For each:

| Field | Question it answers |
|---|---|
| target | Who do we call? |
| protocol / purpose | How, and why does the business care? |
| **failoverBehavior** | What happens when we call from the recovery region? (`works | manual-allowlist | partner-change-required | unknown`) |
| critical | Does L6 fail without it? |

`unknown` is the honest default and every `unknown` on a tier-0 component is a gap.
The inventory review meeting where app teams fill this in is the cheapest recovery test
you'll ever run.

## The classic traps

### Partner allowlists and static egress IPs
Payment switches, clearinghouses, banks, and government gateways allowlist your source
IPs. Your recovery region NATs through *different* IPs unless you engineered otherwise.
Options, best first:

1. **Pre-register the recovery region's egress IPs with every partner now.** Allocate
   the recovery NAT gateway EIPs today (a few dollars a month) so the addresses exist to
   register — partner change windows are weeks, not minutes.
2. Front egress through something region-stable you control (e.g., a small egress proxy
   fleet with pre-registered EIPs in each region).
3. Accept a documented manual step — with the partner's emergency-change contact, SLA,
   and ticket template stored in Contacts. "Call Bob" is not a runbook step; Bob is on a beach.

### SFTP partners
Settlement files, eligibility feeds, remittance batches. Four separate failure surfaces:
their allowlist of your IPs (above), *your* allowlist of theirs, **host keys and SSH
credentials** (are the private keys in the recovery region's secret store?), and the batch
scheduler that pushes/pulls files (is it in recovery scope, and will it double-send or
skip a window on failover?). Test one real file exchange from the recovery region during
game day — nothing else proves this path.

### Auth pools and identity
If user identity lives in a regional service (e.g., a user pool tied to the primary
region) or an external IdP configured with regional callback URLs, recovered apps come up
with nobody able to log in. Verify: callback/redirect URLs cover recovery-region
endpoints; token signing keys/JWKS reachable; machine-to-machine credentials (client
secrets) present in the recovery region; and your own break-glass access does not depend
on the SSO that just went down with the region.

### DNS TTLs
The fastest failover in the world waits on the slowest cached record. Audit TTLs on every
name a customer or partner resolves: 60–300s is a reasonable failover TTL. But know the
limits — some partner systems and enterprise resolvers ignore TTLs, pin IPs in config
files, or cache for hours. For those partners the answer is a static, region-stable entry
point (anycast/Global Accelerator-style or your own stable VIP layer), not a faster TTL.
Also check TTLs on the *partner's* names you resolve: if their failover relies on DNS and
your service caches aggressively, the dependency cuts both ways.

### SaaS you depend on
Observability, paging, feature flags, email/SMS. Two questions each: does it work when
your primary region is down (is your PagerDuty/Slack integration wired through something
in the dead region?), and does *its* region concentration overlap yours? The Oct 2025
us-east-1 event took out plenty of vendors' control planes simultaneously — assume shared
fate unless verified otherwise, and keep the paging path independent of your own stack.

## Program mechanics

- Every third-party dependency is a **component** in the inventory (category:
  `third-party`, kind: `external`, usually layer **L5**), so it shows up in dependency
  diagrams and runbooks like everything else.
- Every partner has a **Contacts** entry: named humans, escalation path, emergency
  change process, expected turnaround.
- The runbook's L5 gate includes at least one **live partner probe** per critical
  partner (a test transaction, a handshake, an SFTP `ls`) — pass condition is the
  partner's system answering the recovery region.
- Re-verify allowlists **quarterly** (Phase 0-adjacent): partners repave firewalls too,
  and the registration you did last year silently expired with their network refresh.
