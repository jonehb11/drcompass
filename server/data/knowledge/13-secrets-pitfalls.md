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

| Step | Command shape | Pass condition |
|---|---|---|
| Reconciliation diff (needed vs present-in-recovery) | `list-secrets` in the recovery region, `comm` against the signed-off list | Zero missing, zero stale > RPO |
| Decrypt probe: read one secret per KMS key in play | `get-secret-value` | Plaintext returned using recovery-region role |
| App-identity probe: from a pod/instance in the recovery region, fetch the secret each tier-0 service uses | `get-secret-value` run under the tier-0 ServiceAccount / instance role, with `sts get-caller-identity` beside it | Fetch succeeds via the app's own IAM role, not an admin's — and the caller identity proves it |
| Rotation freeze check | `list-secrets --query "SecretList[?RotationEnabled].NextRotationDate"` | No rotation mid-recovery; rotation lambdas either disabled or region-aware |

The third row matters most: an admin's `aws secretsmanager get-secret-value` proves the
secret exists; only the *application's* role proves the IAM plumbing (policies, OIDC
trust, resource policies) also made the trip. On a **recovered or second EKS cluster the
OIDC issuer URL is different**, so every IRSA role trust policy must already trust it or
every pod silently loses its AWS identity — and the failure surfaces as an opaque
container error, not as "missing secret".

### Do not use `describe-secret` as the gate

This one is worth stating flatly, because it is the check people reach for and it proves
almost nothing. `describe-secret` returns **metadata only** — the API reference says "It
does not include the encrypted secret value", and there is no `SecretString` field in its
response at all. It therefore **succeeds** when:

- the replica exists but holds no usable value (shape without bytes — the classic);
- the KMS key is unavailable, or its policy does not let you decrypt;
- *the application's* role has no permission at all, because you ran it as an admin.

Verified 2026-09-16: `DescribeSecret` is **absent** from the list of Secrets Manager
operations that require AWS KMS permissions, so it never exercises a decrypt.
`GetSecretValue` **is** on that list — it calls `kms:Decrypt` to unwrap the data key
before returning the value, which is exactly why it is the check worth running.
([DescribeSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DescribeSecret.html),
[KMS permissions](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html))

A single command covers rows 2 and 3 together: `get-secret-value`, executed from the
workload's own identity, in the recovery region. That proves existence, KMS decrypt, and
IAM/OIDC trust in one call. Anything less is a shape check wearing a bytes check's badge.

## Beyond the secret store

The same discipline applies to secret-shaped things that live elsewhere: TLS/ACM certs
(regional! API Gateway and NLB certs must exist in the recovery region), OIDC provider
configs for EKS service accounts, SSH keys for SFTP partners, API keys stored in partner
portals ([third-party dependencies](#/learn/14-third-party-dependencies)), and CI/CD
deploy credentials scoped to the recovery region. Inventory them all.
