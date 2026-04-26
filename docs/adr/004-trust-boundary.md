# ADR 004 — Trust boundary for `orgId` identity

**Date:** 2026-04-23
**Status:** accepted
**Deciders:** CTO
**Related:** [ADR 003](./003-cli-login-state-machine.md). ADRs 001 ("Pylon as a service") and 002 ("token storage and sharing") live in the closed-source Pylon service repo.

## Context

ADR 003 established `orgId` as the canonical tenant identifier:
short admin-chosen slug, keyring keyed by it, audit logs labelled
by it. That decision was correct as a naming choice, but it
quietly punted on four trust-model questions:

1. **Who issues `orgId`?** Admin? Discovery endpoint? Hashed from URL?
2. **How does the CLI authenticate `/discover`?** A response from
   `/discover` can claim any `orgId` and any `api_url`. What prevents
   a spoofed response from anchoring the user to the wrong org?
3. **What if cached `(orgId, api_url)` disagrees with later
   discovery?** Silent update? Loud refusal? User prompt?
4. **Can `orgId` change?** If yes, how does it propagate to already-
   logged-in users?

The audit on commit `7aebdb3` closed the most immediate hole
(same-origin check on server-supplied URLs). That's necessary but
not sufficient — it prevents in-protocol redirection but doesn't
address trust anchoring or recovery from disagreement. This ADR
closes the remaining gap.

## Decision

Four pillars:

### 1. `orgId` is admin-defined at deploy time and immutable

- Set once via the `PYLON_ORG_ID` wrangler env var on first Pylon
  deployment.
- Reported by `GET /discover` in the `id` field.
- **Never** changes for a given Pylon deployment. There is no
  "rename org" operation.
- If an org ever needs a new `orgId`, it's a new Pylon
  deployment. Users migrate by logging into the new org separately.

Rationale: `orgId` is the trust anchor for every cached session,
every audit log entry, every scoped-token `org` claim. Mutable
trust anchors are a contradiction.

### 2. Trust-on-first-use (TOFU) + same-origin pinning

The trust chain at first contact:

```
admin publishes <org-url> out-of-band
    (email, internal doc, onboarding wiki)
                    ↓
user runs `pylon login --org-url=<org-url>`
                    ↓
CLI fetches <org-url>/discover over HTTPS
    (CF Access authenticates the origin as "really this org")
                    ↓
CLI validates response shape + same-origin api_url
    (shipped in commit 7aebdb3)
                    ↓
CLI writes (orgId, api_url) into ~/.pylon/config.yaml
    — the anchoring moment —
                    ↓
All future trust in this orgId comes from this cached record
```

The out-of-band channel (admin telling the user the URL) is the
**initial** trust anchor. HTTPS + CF Access authenticates the
origin thereafter. No PKI; no signed metadata; no DNSSEC. This
matches what `gh auth login`, `gcloud auth login`, `aws configure`
all do today, and it's the right cost/benefit for a single-org
Pylon reached via admin-published URL.

### 3. Cross-org token isolation is cryptographic, not policy

Every scoped token Pylon issues carries:

```jsonc
{
  "sub": "user@company.com",
  "org": "<orgId>",           // from PYLON_ORG_ID
  "app": "<appId>",
  "caps": ["..."],
  "iat": <epoch>,
  "exp": <epoch + 30>
}
```

Signed by the org's signing key (per-deployment, not shared).
Two properties fall out:

- **Signature** prevents forgery. A token minted by org-A won't
  verify under org-B's pubkey.
- **`org` claim** prevents confusion. Even if somehow a signed
  token leaks into org-B's MCP, the SDK's `requireCapability`
  checks `org === expectedOrg` first and refuses.

This means cross-tenant token reuse is impossible by construction,
not by policy. No trust decision depends on the client behaving
correctly.

### 4. Cache-vs-discovery disagreement: fail closed

If a cached config record says `(orgId=acme, api_url=X)` and a
later `/discover` at X returns `orgId=beta`:

- This is never legitimate (pillar 1: `orgId` doesn't change).
- The CLI refuses to use the session, prints a loud warning, and
  suggests `pylon forget --org=acme` to clear the cache if the
  user really believes the URL has been repurposed.

Matching cases that should all fail closed:
- Cached `api_url=X` but stored `orgId` ≠ discovery's `id` → refuse.
- Two config entries share the same `api_url` but different `orgId`s
  → refuse with a message asking the user to reconcile.
- User runs `pylon login --org-url=X` and config already has a
  different `orgId` bound to X → refuse; offer `--replace` as
  explicit override.

This catches:
- DNS takeover of a Pylon's hostname.
- Admin accidentally re-pointing `pylon.company.internal` at a
  different Pylon deployment.
- An attacker getting control of the origin mid-session.

## Forces

**UX vs strict verification.** Signed discovery metadata + key
distribution would add security against in-transit MITM at first
contact. It would also add: a separate key-distribution pipeline,
a signature-verification dependency in the CLI, and a recovery
story when the distribution channel itself is compromised. For a
single-org Pylon reached via admin-published URL, HTTPS + CF
Access + TOFU is the right cost/benefit. Revisit if/when Pylon
grows a federated / cross-org story.

**Admin ergonomics.** Signing key rotation must NOT invalidate
users' sessions. We use `kid` in JWT header + multi-active-key
verification window (ADR 002). Routine rotation is transparent.

**Observability.** Cross-org token reuse attempts must be logged
and alertable. The SDK's signature-verification failure path
logs `{ expected_org, claimed_org, app }` so an incident responder
can tell "bad token" from "cross-org token reuse attempt".

## Alternatives rejected

### A. Signed discovery metadata (distributed out-of-band)

Pylon signs `/discover` response with a long-lived keypair. The
user's CLI receives the public key from the admin out-of-band (as a
fingerprint in the onboarding email). First contact verifies the
signature.

**Rejected because:** the same out-of-band channel that delivers
the pubkey already delivers the URL itself. The pubkey adds defence
only against a compromised network path between user and Pylon —
which HTTPS + CF Access already cover. Marginal security benefit
for real complexity (key format, rotation, revocation, deployment).

### B. DNS-based verification (DNSSEC + DANE)

Bind Pylon's TLS cert fingerprint or signing pubkey to a DNSSEC-
signed TLSA record.

**Rejected because:** DNSSEC is not widely deployed at the resolver
tier; DANE even less so. Adds a hard dependency on infrastructure
the org probably doesn't control and certainly can't debug.

### C. Trust every `/discover` response (pre-audit behaviour)

**Rejected because:** a compromised `/discover` could redirect
token minting to attacker-controlled URLs. Audit commit `7aebdb3`
already closed this.

### D. `orgId` = hash of `api_url`

Makes `orgId` unspoofable by tying it to transport.

**Rejected per ADR 003:** ties identity to transport forever;
URL changes become org-identity changes. Stability matters more
than unspoofability; pillar 3 gives us unspoofability via crypto
anyway.

## Consequences

### Positive

- **First-contact trust chain is explainable in one paragraph.**
  HTTPS + CF Access + admin-delivered URL + same-origin check.
- **Zero new infrastructure.** Every mechanism is already in the
  design.
- **Cross-org isolation is cryptographic.** Not a code discipline
  that can regress.
- **Stable audit anchor.** `orgId` never changes, so "what did
  Alice do in org `acme` last week" is a query that keeps working
  forever.

### Negative

- **TOFU has the standard weakness.** A MITM of the very first
  `/discover` (compromised CA, CDN takeover) anchors the user to
  the wrong org and stays. Mitigations: CF Access on the Pylon
  origin, and the same-origin check limits the blast radius (we
  can't redirect to attacker.com, only get confused about the id
  at the anchored origin).
- **`orgId` change = new Pylon deployment.** No renaming
  operation. Accepted as an operational constraint.
- **Cache mismatch is a sharp edge.** User who repurposes a URL
  must run `pylon forget`. Better than silent cross-org drift.

## Implementation hooks

Code touch-points this ADR produces:

| File | Change |
|------|--------|
| `src/commands/login.ts` | Before upserting, reject if config already has a different `orgId` bound to this `api_url` (unless `--replace`). |
| `src/commands/forget.ts` | **New command**: `pylon forget --org=<id>` removes the config record + its keyring session. The recovery path for cache-vs-discovery disagreement. |
| `src/bin.ts` | Wire the new `forget` command. |
| Pylon service `discover` handler (closed-source) | Reads `env.PYLON_ORG_ID`, returns `{ id, name, api_url }`. |
| Pylon service token signer (closed-source) | Embed `org: env.PYLON_ORG_ID` in every minted token. |
| `@pleri/pylon` SDK `verify` (closed-source) | Verify signature + `org === configuredOrgId`. Log signature/org failures with `{ expected_org, claimed_org }`. |

The CLI changes land in this PR (they're ~50 LOC and close the
pillar-4 gap today). Service and SDK changes wait for their own PRs.

## Status tracking

- ADR 005 (deferred): signing key rotation + `kid` header
  semantics. Slot reserved; lives in the closed-source service
  repo if/when accepted.
- ADR 006 (accepted, in this repo): split `pylon schema push` into
  `prepare` + `push` — a CLI UX + provenance feature, not a
  protocol-level boundary. See [`./006-schema-prepare.md`](./006-schema-prepare.md).
