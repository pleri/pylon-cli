# Changelog

All notable changes to `@pleri/pylon-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases tag the repo with `v<semver>` (e.g. `v0.3.0`); the publish
workflow fires on tag push and ships to npm with provenance.

## [Unreleased]

(no unreleased changes)

## [0.3.0] — 2026-04-25

This is a behavioral-change release. **Existing CI invocations of
`pylon schema push --file <raw>.yaml` will start exiting with code 10.**
The migration is mechanical and the exit-10 error message names the
exact `pylon schema prepare` command to run with your invocation's
file/app args. See the **Migration** section below for the full
playbook.

ADR: [`docs/adr/006-schema-prepare.md`](./docs/adr/006-schema-prepare.md) ·
Operator docs: [`docs/CLI.md`](./docs/CLI.md) · [`docs/PYLON_SDK_CONTRACT.md`](./docs/PYLON_SDK_CONTRACT.md) §3.4

### Added

- **`pylon schema prepare`** — pure / offline / deterministic
  canonical-artifact step. Reads bare YAML/JSON, validates names +
  cross-references + cycles, prefixes `<appId>:`, sorts keys + arrays
  lexicographically, attaches a `_prepared` marker (provenance +
  integrity tripwire) and emits canonical JSON. Same `(source,
  cli_version)` produces byte-identical output across machines.
- **`--from-source` flag on `pylon schema push`** — explicit one-shot
  opt-in that fuses `prepare | push` into a single command for
  operators who don't want the on-disk lockfile.
- **`PYLON_CLI_VERSION_OVERRIDE` env var** — pins `cli_version` in the
  marker for test fixtures so they survive CLI version bumps.
- **Marker fields on `pylon schema list`** — versions pushed via CLI
  0.3.0+ render `prep cli=<semver> src=<12hex>…` per row; pre-0.3.0 /
  SDK / curl pushes render unchanged (no marker column).
- **Exit codes 10 / 11 / 12** — see updated table in `docs/CLI.md`:
  `unprepared_input`, `invalid_source`, `check_diff`.

### Changed

- **`pylon schema push` now requires a prepared artifact by default.**
  Refuses raw YAML/JSON input with exit 10 and prints a multi-line
  inline remediation message naming the exact `pylon schema prepare`
  command to run. Use `--from-source` to bypass the marker requirement
  in one shot.
- **`docs/PYLON_SDK_CONTRACT.md` §3.4 / §3.5 / §4.1** updated with the
  optional `_prepared` request field, optional `prepared` response
  field, and the `PreparedMarker` type. **The (closed-source) SDK's
  `pylonSchemaClient.push()` does NOT generate the marker** —
  markerless pushes continue to work (see ADR 006 for the framing
  rationale).
- **`.gitattributes`** at repo root pins LF line endings for fixtures
  + a repo-wide `* text=auto eol=lf` default. Without this, Windows
  clones with `core.autocrlf=true` would silently break the
  byte-identity contract at the git layer.

### Migration (existing CLI consumers)

If your CI was running `pylon schema push --file schema.yaml --app olam`,
you have two paths:

**Option A — recommended for CI: commit a prepared artifact.**
Mirrors the lockfile pattern. Catches drift in PR review:

```bash
# In your repo, alongside schema.yaml:
pylon schema prepare --source schema.yaml --app olam --out schema.prepared.json
git add schema.prepared.json
# Commit both files. CI then pushes the prepared one:
pylon schema push --file schema.prepared.json --app olam --app-token "$PYLON_APP_TOKEN"
```

A drift check in CI catches source/prepared divergence before push:

```bash
pylon schema prepare --source schema.yaml --app olam --out /tmp/check.json
diff -u schema.prepared.json /tmp/check.json   # exits non-zero on drift
```

**Option B — one-shot: keep posting bare source.**
Simpler if you don't want the on-disk artifact:

```bash
pylon schema push --from-source --file schema.yaml --app olam --app-token "$PYLON_APP_TOKEN"
```

Either path works; pick based on whether you want the prepared
artifact in git history.

### Server-side companion (closed-source service)

The Pylon service was updated additively to support markers; no
service-side migration is required for older CLI clients:

- The service accepts the optional `_prepared` field on
  `POST /apps/:id/schema` request bodies, persists it on the snapshot
  as `Schema.prepared`, and surfaces it on `GET /apps/:id/schema/current`
  + `GET /apps/:id/schema` (list).
- Marker shape is validated structurally — `cli_version` must be
  semver-shaped and ≤ 64 chars; `source_sha256` and `content_sha256`
  must be exactly 64 lowercase hex chars. Invalid markers return 400
  `invalid_schema`.
- Audit-log `detail` block carries `cli_version` + `source_sha256` for
  forensic queries. `content_sha256` is intentionally omitted —
  it's the marker's self-hash and adds no information beyond the
  existing `version` reference.
- Markerless pushes continue to be accepted and produce snapshots with
  `prepared` absent (SDK / curl / pre-0.3.0 CLI parity).

### Internal

- 207 tests pass (12 test files) covering: canonical-JSON determinism,
  bare-source parse + validate, `_prepared` marker emit + verify,
  fixture round-trip byte-identity, all command paths.
- Cross-platform LF pinning via `.gitattributes`.
- Three CP3 close audits during development (Phase A, B, C); all
  CRITICAL + HIGH + MEDIUM findings closed before merge.

### Notes (post-publish-from-pylon-cli)

- **Copyright holder is `Ernie Sim`.** The previous `0.2.x` line was
  published from the pylon workspace and listed `ein-sof` in
  `LICENSE`. This `0.3.0` release — the first published from
  `pleri/pylon-cli` — carries the new attribution. Same MIT license
  terms; only the `LICENSE` attribution line differs.

[Unreleased]: https://github.com/pleri/pylon-cli/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/pleri/pylon-cli/releases/tag/v0.3.0
