# ADR 006 — Split `pylon schema push` into prepare + push (CLI UX, not protocol boundary)

> **Numbering note:** the slot ADR 005 is reserved for "signing key
> rotation + kid header semantics" — a service-side decision tracked
> in the closed-source Pylon service repo (the rotation primitives live
> in the service's `tokens/keys.ts` + `tokens/verify.ts`). This ADR was
> originally drafted as 005 and renumbered to 006 to preserve the
> reservation (Phase D close audit adv-d3-001).

**Date:** 2026-04-25
**Status:** accepted
**Deciders:** CTO
**Related:** [PYLON_SDK_CONTRACT §3.4](../PYLON_SDK_CONTRACT.md). (ADR 001 — "Pylon as a service" — and the original GitHub issue #1 live in the closed-source Pylon service repo and aren't reproduced here; the relevant context is summarized inline below.)

## Context

Through v0.1.2, `pylon schema push --file <path>` did two things in one
breath:

1. **Generate the canonical schema artifact** — prefix every name with
   `<appId>:`, sort capabilities + archetypes + inner arrays, validate
   the structure.
2. **Publish** the result via `POST /apps/<id>/schema`.

Step 1 had no canonical implementation. Each consumer (starting with
Olam) was writing its own emit script — typically a `node -e` one-liner
that read a TypeScript module, prefixed names, and produced a JSON file
that became the `--file` argument. Two failure modes followed:

- **Drift between source and pushed artifact.** No client-side
  detection — Pylon's 422 was the first signal, or worse, the server
  silently accepted a malformed-but-namespaced payload.
- **Per-consumer prefix-policy duplication.** Pylon's `<app>:` rule
  leaked into every consumer's codebase. Future tweaks (reserved
  prefixes, nested namespaces) would have required every consumer to
  update their emit script in lockstep.

The conversation that surfaced the design was a working session on
Olam (a closed-source MCP that consumes Pylon): the per-consumer emit
script was committed, then gitignored after a Codex review flagged the
"two sources of truth" risk. The root cause sat in Pylon's CLI surface,
not in any one consumer's gitignore.

## Decision

Split the responsibilities into two CLI commands with a deterministic
artifact between them, ship as CLI 0.3.0:

| Command | Purpose | Determinism | Side effect |
|---|---|---|---|
| `pylon schema prepare --source <file> --app <id>` | Pure: validate → auto-prefix `<app>:` → sort keys → emit canonical JSON with `_prepared` marker | Pinned to `(source, cli_version)` | None — stdout / `--out` |
| `pylon schema push --file <prepared>.json --app <id>` | Publish ONLY a prepared artifact. Refuse raw input by default. | n/a (network) | `POST /apps/:id/schema` |

`--from-source` on push is the explicit one-shot escape hatch for
operators who want `prepare | push` in a single command without the
on-disk lockfile.

The `_prepared` marker carries three string fields:

```ts
interface PreparedMarker {
  readonly cli_version:    string;  // semver-shaped, ≤ 64 chars
  readonly source_sha256:  string;  // 64 lowercase hex chars
  readonly content_sha256: string;  // 64 lowercase hex chars
}
```

Crucially, this is **a CLI UX feature with provenance metadata, NOT a
protocol-level boundary.** Specifically:

- The CLI verifies `content_sha256` before posting — exit 10 if absent
  or mismatched, with an inline shell-pasteable remediation command.
- The server lifts `_prepared` off the request body, persists it on
  the `Schema` snapshot, and surfaces `cli_version` + `source_sha256`
  in the audit log. The server **does NOT** recompute `content_sha256`
  or otherwise enforce the marker — markerless pushes from
  `pylonSchemaClient.push()`, curl, or pre-0.3.0 CLIs continue to
  succeed.
- App token remains the only auth on push.

## Why a CLI UX, not a hard protocol boundary

Codex pushed back on the original framing twice during planning, and
both pushes are explicitly recorded here so future readers don't
mistake the seam for something it isn't:

**CP1 push-back.** "If `push` is supposed to refuse unprepared input,
keeping normalization only in `packages/cli` and not requiring the
marker server-side means the invariant is not real at the system
boundary." That's correct. We accept the framing critique: this is a
CLI UX feature plus durable provenance metadata, not a server-enforced
protocol invariant. The marker enables consumer-side tooling
(lockfile-style artifact tracking, `--check` drift detection in CI,
forensic answers to "which CLI emitted this push") without forcing
Pylon to grow a hard boundary that v0.1's SDK cannot honor.

**CP2 push-back.** "The CLI marker is bypassable; SDK pushes and
direct-curl pushes can submit semantically equivalent but
non-canonical payloads." Also correct. The compatibility matrix
documented in the planning trail covers all combinations; the upshot
is markerless pushes are a recognized first-class path, not a
discovered hole.

If a future consumer demands hard enforcement, the lift is small:
a server-side `PYLON_REQUIRE_PREPARED=1` env flag would reject
markerless pushes. The marker shape is already on the contract. We
chose not to ship that flag in v0.1 because the SDK push path
(`pylonSchemaClient.push()`) doesn't yet emit a marker, and breaking
it would force a coordinated SDK update we don't have a use case for.

## Consequences

### Positive

- **Lockfile-style artifact tracking.** Consumers commit the prepared
  JSON alongside source; CI runs `pylon schema prepare --source
  bare.yaml --app olam --out /tmp/check.json && diff -u
  schema.prepared.json /tmp/check.json` to catch drift before push.
- **Provenance.** `cli_version` + `source_sha256` in the audit log
  answers "which CLI emitted this version, and from which source
  bytes" without needing operator-side detective work.
- **Single source of namespace policy.** `<appId>:` prefix logic
  lives in `src/schema/normalize.ts`. No consumer
  re-implements it.
- **Determinism contract.** Same `(source, cli_version)` always
  produces byte-identical output; pinned via `PYLON_CLI_VERSION_OVERRIDE`
  for test fixtures.
- **No `prepared_at` in the marker.** Wall-clock would have defeated
  determinism; provenance survives via git history + `source_sha256`.

### Negative (accepted)

- **SDK `pylonSchemaClient.push()` is NOT marker-enforced; this is by
  design for v0.1.** Codex CP1 + CP2 reviews flagged this. We accept
  it as a CLI UX feature, not a protocol boundary. The marker is
  documented in `PYLON_SDK_CONTRACT §3.4` so a future SDK that grows
  a `prepareSchema()` helper has a stable spec to emit against.
- **Olam CI will break on its first `pylon schema push` invocation
  after upgrading to CLI 0.3.0** — by design. Exit 10 with an inline
  remediation command (`pylon schema prepare --source <given> --app
  <given> --out prepared.json`) is the operator-facing migration
  path. No deprecation cycle (Q1 resolution: hard-fail).
- **Server hardens `_prepared` shape but not content** — the server
  rejects oversized `cli_version`, non-semver shapes, and non-hex
  sha256 values (closes the audit-log/KV amplification + ANSI-injection
  vectors flagged by the Phase C close audit). It does NOT recompute
  `content_sha256` because doing so would conflate the integrity
  tripwire (operator-facing, accident-prevention) with auth
  enforcement (already covered by app-token).

## Alternatives considered

- **Server-side normalization** — POST bare YAML, server prefixes +
  sorts. Defeats determinism: the same source repo could produce
  different stored schemas across server versions. Codex rejected
  this in the issue thread.
- **SDK + CLI shared normalization** — lift the prepare logic into
  `@pleri/pylon-core` so MCPs can call `prepareSchema()` programmatically
  at deploy time. `@pleri/pylon/verify` has a hard 8KB gz budget; the
  YAML parser + validator don't fit. Shelling to the CLI from Wrangler
  Deploy is acceptable for deploy-time use cases.
- **Pre-commit hook sidecar** — ship a husky/pre-commit hook that
  prefixes + sorts on staged files. Doesn't help CI-only consumers.
- **Lockfile-in-response** — `push` accepts raw, returns canonical;
  CLI writes `schema.lock.json` next to the input. Read-only CI
  (PR checks) can't push to validate.
- **Deprecation flag cycle** (`--allow-unprepared` for one release).
  Olam is the only affected consumer; a grace period has no audience.
- **Hard protocol boundary now (server-required marker)** — would
  break SDK `pylonSchemaClient.push()`. Deferred to a future
  `PYLON_REQUIRE_PREPARED` env flag once a second consumer demands it.

## Verification

- Determinism: two back-to-back `pylon schema prepare` invocations
  on the same source produce byte-identical output. Pinned by the
  fixtures determinism round-trip in `src/schema/__tests__/`.
- Marker round-trip: server persists the marker on the snapshot and
  surfaces it on `GET /apps/:id/schema/current` and `GET
  /apps/:id/schema` (list). Pinned by the schema-handler test suite
  in the closed-source service's handler test suite.
- Defensive guard: any non-`_prepared` top-level `_*` key returns
  400 `invalid_schema`. Pinned in the same service test suite.
- Operator-facing remediation: `pushSchema({ file: rawYaml })`
  exits with code 10 and a multi-line message including the exact
  `pylon schema prepare ...` command. Pinned by the schema-commands
  test suite in `src/__tests__/`.
