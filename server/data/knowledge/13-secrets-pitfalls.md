# Secrets: the #1 recovery killer
<!-- section: Running the program | order: 130 -->

Ask anyone who has run real recovery tests what broke first. It was secrets. Applications
launched into a perfect L2 platform with perfect L3 data will crash-loop for hours on one
missing secret — and the symptoms masquerade as application bugs, so you burn RTA
debugging the wrong layer. Treat secrets as a first-class recovery workstream with its
own inventory, reconciliation, and verification.

## Why secrets kill recoveries

- **They're invisible until runtime.** IaC can create a secret's *container* without its
  *value*. Everything applies cleanly; nothing works.
- **They drift silently.** A password rotated in the primary region on Tuesday doesn't
  fail over until the disaster, months later. Nothing alerts on "replica exists but is stale"
  unless you build it.
- **They're dual citizens** ([two problems](#/learn/03-two-problems)): shape (the secret
  must exist at the right name/ARN) *and* bytes (the current value must be there).
- **They fan out.** One database has one endpoint but its password may be referenced by
  six services, two Lambda functions, and a CI job — each with its own way of resolving it.

## The reconciliation discipline

Maintain, and diff **daily** (it's a Phase 0 item), three lists:

1. **What applications need** — every secret referenced by every in-scope component.
   In DR Compass this is the `secrets[]` array on each component; the exports page can
   produce the consolidated list.
2. **What exists in the primary region** — from the secret store's API.
3. **What exists (with a fresh value) in the recovery region** — replica secrets, with
   last-sync timestamps.

Recovery requires 1 ⊆ 3. Any secret in list 1 missing from list 3 is a blocker-severity
gap on the component that needs it. The diff is scriptable in an afternoon and pays for
itself on the first run.

## ARNs vs logical names — decide, and be consistent

The single most common wiring failure: an app in the recovery region holding a
**full ARN pointing at the primary region**.

| Approach | How it fails | How to make it work |
|---|---|---|
| **Explicit ARN** (`arn:aws:secretsmanager:us-east-1:…:secret:app/db-abc123`) | Region and account are baked in; in the recovery region the app faithfully calls the dead region | Template the region/account (one variable — see [GitOps symmetry](#/learn/10-tooling-gitops-iac)); never hardcode a regional ARN in an app config |
| **Logical name** (`app/db-password`, resolved against the local region) | Fails only if the name doesn't exist locally — which reconciliation catches | Prefer this. Secrets Manager replica secrets keep the **same name** in every region, so name-based resolution fails over automatically |

Audit for the hybrid horror: most services use names, two use ARNs "temporarily". The
inventory's `secrets[].arn` field exists so the audit is a query, not a grep marathon.

## KMS: the secret under the secrets

Every encrypted secret (and every encrypted snapshot, bucket object, and database)
depends on a KMS key. A perfectly replicated secret you cannot decrypt is not recovered.

- **Multi-Region keys (MRKs)** are the clean answer: same key material and same key ID
  suffix in each region, so ciphertext and key references survive the move. Replica
  secrets can be configured to encrypt with a per-region KMS key — do this deliberately,
  not by default-key accident.
- **Single-region CMKs are a trap**: snapshots copied cross-region must be re-encrypted;
  key *policies* (who may decrypt) must exist in the recovery region too — key policy is
  shape, and it drifts like all shape.
- Put "test decrypt one secret and one snapshot in the recovery region using
  recovery-region credentials" in the recovery-test runbook at L3. It's a one-liner that
  has saved entire game days.

## Verification steps that belong in every runbook (L3)

| Step | Pass condition |
|---|---|
| Reconciliation diff (needed vs present-in-recovery) | Zero missing, zero stale > RPO |
| Decrypt probe: read one secret per KMS key in play | Plaintext returned using recovery-region role |
| App-identity probe: from a pod/instance in the recovery region, fetch the secret each tier-0 service uses | Fetch succeeds via the app's own IAM role, not an admin's |
| Rotation freeze check | No rotation mid-recovery; rotation lambdas either disabled or region-aware |

The third row matters most: an admin's `aws secretsmanager get-secret-value` proves the
secret exists; only the *application's* role proves the IAM plumbing (policies, OIDC
trust, resource policies) also made the trip.

## Beyond the secret store

The same discipline applies to secret-shaped things that live elsewhere: TLS/ACM certs
(regional! API Gateway and NLB certs must exist in the recovery region), OIDC provider
configs for EKS service accounts, SSH keys for SFTP partners, API keys stored in partner
portals ([third-party dependencies](#/learn/14-third-party-dependencies)), and CI/CD
deploy credentials scoped to the recovery region. Inventory them all.
