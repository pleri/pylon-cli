# `@pleri/pylon-cli`

Command-line interface for the Pylon authorization platform — schema
management, app + role admin, audit-tail viewer.

This CLI talks to a Pylon service over HTTP. The service is currently
a closed implementation; the wire contract this CLI implements is
documented in [`docs/PYLON_SDK_CONTRACT.md`](docs/PYLON_SDK_CONTRACT.md).

## Install

```bash
npm install -g @pleri/pylon-cli
pylon --version
```

Or one-shot via `npx`:

```bash
# Replace the URL with your org's actual Pylon endpoint:
npx -p @pleri/pylon-cli pylon login --org-url=https://pylon.example.com
```

For local development from this repo:

```bash
pnpm install
pnpm build
pnpm test
pnpm exec pylon <command>
```

## Quick start

```bash
# 1. Log in to your org's Pylon (device-code flow):
pylon login --org-url=https://pylon.example.com   # ← replace with your org's URL
# → opens a browser tab; enter the one-time code; press enter.

# 2. Confirm:
pylon whoami

# 3. Manage schema (admin / MCP author):
pylon schema prepare --source schema.yaml --app myapp --out schema.prepared.json
pylon schema push --file schema.prepared.json --app myapp \
  --app-token "$PYLON_APP_TOKEN"
```

The full command reference is in [`docs/CLI.md`](docs/CLI.md).

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/CLI.md`](docs/CLI.md) | Command reference, exit codes, worked examples |
| [`docs/PYLON_SDK_CONTRACT.md`](docs/PYLON_SDK_CONTRACT.md) | Wire-level contract this CLI implements (HTTP/JSON shapes, auth flow, schema push semantics) |
| [`docs/adr/003-cli-login-state-machine.md`](docs/adr/003-cli-login-state-machine.md) | Device-code login state machine, identity primacy, library choices |
| [`docs/adr/004-trust-boundary.md`](docs/adr/004-trust-boundary.md) | Trust boundary for `orgId`; cache-vs-discovery resolution; `pylon forget` recovery path |
| [`docs/adr/006-schema-prepare.md`](docs/adr/006-schema-prepare.md) | Why `schema push` was split into `prepare` + `push` (CLI UX + provenance, not protocol boundary) |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-version changes, migration playbooks |

## Releases

Releases are tagged with `v<semver>` (e.g. `v0.3.0`, `v0.3.1`,
`v0.4.0`). Pushing a tag triggers the publish workflow at
`.github/workflows/publish.yml`, which publishes to npm via the
[Trusted Publisher OIDC flow](https://docs.npmjs.com/trusted-publishers) —
provenance attestation visible on the npm package page.

The maintainer's release procedure is documented in `CHANGELOG.md`
above each version's entry; the runbook is to bump `version` in
`package.json`, update `CHANGELOG.md`, merge to `main`, then tag
`v<semver>` at the merge commit and push the tag.

## Issues + contributions

[Open an issue](https://github.com/pleri/pylon-cli/issues) for bugs in
the CLI or this repo's docs. Issues about the Pylon service itself
(server bugs, auth failures, deploy questions) are handled out-of-band
by the service team.

Contributions welcome — fork, branch, PR. The repo follows
Conventional Commits; CI runs `pnpm build && pnpm test`.

## Provenance + lineage

Every published version carries an [npm provenance attestation](https://docs.npmjs.com/generating-provenance-statements) signed by Sigstore. To verify the bundle for a specific version:

```bash
# Fetch the attestation bundle from the npm registry:
curl https://registry.npmjs.org/-/npm/v1/attestations/@pleri%2fpylon-cli@0.3.0

# Or look up the sigstore transparency-log entry directly:
# https://search.sigstore.dev/?logIndex=1390906936  (0.3.0)
```

`gh attestation verify` may return 404 against this package depending on which GitHub-side endpoint it queries. The npm registry attestation URL above is the canonical fallback — it returns the SLSA provenance bundle and the npm publish attestation as inline JSON.

This package was previously published from a closed-source monorepo (`pleri/pylon`, internal). Versions `0.1.0`, `0.1.1`, `0.1.2` shipped from there without provenance. From `0.3.0` onwards, all releases come from this repo with provenance attestation; `0.2.x` was intentionally skipped to signal the boundary. See [ADR 006](docs/adr/006-schema-prepare.md) for the framing rationale.

## License

[MIT](LICENSE) © Ernie Sim
