# `pylon` CLI reference

Every command supports `--help` for terse inline docs. This page is
the narrative version with worked examples.

## Install

The CLI is published as `@pleri/pylon-cli` on npm:

```bash
npm install -g @pleri/pylon-cli
pylon --version
```

Or one-shot via `npx`:

```bash
npx -p @pleri/pylon-cli pylon <command>
```

For local development from this repo (after cloning):

```bash
pnpm install
pnpm build
pnpm exec pylon <command>       # invokes dist/bin.js
```

Every example below uses the bare `pylon` form.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic failure |
| 2 | No org specified and none could be resolved |
| 3 | Discovery failed (can't reach Pylon) |
| 4 | Device authorisation expired |
| 5 | OS keyring error |
| 6 | Pylon returned a non-success HTTP response |
| 7 | No session for the resolved org |
| 8 | Cache vs. discovery mismatch (ADR 004 pillar 4) |
| 9 | `--browser` flow not yet implemented |
| 10 | Schema push received unprepared input — run `pylon schema prepare` first or pass `--from-source` |
| 11 | Schema source failed validation (malformed name, cycle, dup, dangling inherits) |
| 12 | `pylon schema prepare --check` found drift between prepared source and deployed schema |

## Authentication

### `pylon login`

Authenticate against a Pylon via device-code flow.

```bash
pylon login --org-url=https://pylon.acme.internal
pylon login --org=acme                    # after first login
pylon login                               # default org from config
pylon login --org-url=... --replace       # overwrite stale binding
```

What happens:
1. CLI prints a short code and URL.
2. You open the URL, complete SSO, enter the code.
3. CLI polls `/device/poll` until authorised.
4. Session JWT is written to your OS keyring.
5. Org metadata is written to `~/.pylon/config.yaml`.

### `pylon whoami`

Show the active session for the current or a specific org.

```bash
pylon whoami
pylon whoami --org=acme
```

Hits `GET /whoami` — server returns `email`, `org_id`, `archetype`,
expiry. A dead/expired session returns exit 7 with a loud error.

### `pylon logout`

Clear the session for an org (keyring only; config is preserved).

```bash
pylon logout               # current default org
pylon logout --org=acme    # specific
```

### `pylon forget`

Remove an org entirely — session _and_ config record.

```bash
pylon forget --org=<slug>
```

Used when an admin has repointed a Pylon URL to a different org;
see ADR 004 pillar 4.

### `pylon use`

Switch the default org.

```bash
pylon use --org=beta
```

Requires the org already be in `~/.pylon/config.yaml` (i.e. you've
logged in to it at least once).

## Admin: app registry

All commands below require `pylon:app.manage`. A fresh Pylon grants
this only to `pylon-admin` — the email that consumed `/bootstrap`.

### `pylon app register`

Enrol a new MCP. Returns a one-time `appToken`.

```bash
pylon app register \
  --name=olam \
  --owner=engineer@acme.com \
  --description="Isolated development worlds"
```

Output (one-time, copy immediately):

```
✓ app registered in acme
   appId:    olam
   appToken: pyat_abc123...

⚠ Save the appToken now — it is NOT retrievable later.
   Deliver it to the engineer securely (1Password / encrypted email / etc.).
```

The engineer sets the token as a wrangler secret on their MCP
worker: `wrangler secret put PYLON_APP_TOKEN`.

Registering over a disabled app of the same id rotates the token
(mints new, orphans old hash). That's the supported rotation
pattern.

## Admin: role management

All below require `pylon:role.manage`.

### `pylon role grant`

Grant a role to a user for a specific enrolled MCP.

```bash
pylon role grant \
  --email=alice@acme.com \
  --app=olam \
  --archetype=admin

# With additive capabilities beyond the archetype default:
pylon role grant \
  --email=bob@acme.com \
  --app=olam \
  --archetype=user \
  --capability=olam:world.archive \
  --capability=olam:pr-gate.decide
```

The `<archetype>` name is whatever the MCP declared in its schema.
Pylon stores it as-is; schema-aware validation lands with the /apps/:id/schema
endpoints (step 3c).

Special case: `--app=pylon` grants a role for managing Pylon itself.
Valid archetypes here are `pylon-user`, `pylon-auditor`, `pylon-admin`.

```bash
# Promote someone to Pylon admin:
pylon role grant --email=cto@acme.com --app=pylon --archetype=pylon-admin
```

### `pylon role list`

List all grants for one app.

```bash
pylon role list --app=olam
```

Output shows sha256 email hashes, not plaintext emails. To
identify a user: the email → hash mapping is deterministic
(sha256 of trimmed lowercase email), so you can look up a known
email by hashing it yourself.

### `pylon role revoke`

Revoke a role by its sha256 email hash.

```bash
pylon role revoke --email-hash=<64-char-hex>
```

Cached scoped tokens the user already holds are valid for up to
30 seconds past revoke. New `/token` calls from that user return
empty caps (or 403 if the app is disabled).

## Admin: audit

### `pylon audit tail`

Query the append-only audit log.

```bash
pylon audit tail                                      # last 100 entries
pylon audit tail --limit=500
pylon audit tail --action=role.granted
pylon audit tail --since=$(date -u -v-1d +%s)000      # last 24h (macOS)
pylon audit tail --since=$(date -u -d '1 day ago' +%s)000  # last 24h (GNU)
```

Pagination: when output ends with a `next_cursor`, pass it back:

```bash
pylon audit tail --cursor=<cursor-from-previous-response>
```

Valid `--action` values: `bootstrap.consumed`, `app.registered`,
`app.disabled`, `app.token_rotated`, `role.granted`, `role.revoked`,
`schema.pushed`, `schema.approved`.

## Admin / MCP-author: schema

Every MCP enrolled into Pylon declares its capability schema (the
list of `<appId>:*` caps + archetypes) via the schema commands.
Pushing is an app-scoped credential (the app token from
`pylon app register`); inspecting + approving use the admin's
session JWT.

The schema flow is two steps:

1. **`pylon schema prepare`** turns a bare YAML/JSON source into a
   canonical `prepared.json` artifact carrying a `_prepared` marker
   (provenance + integrity tripwire). Output is byte-deterministic
   per `(source, cli_version)` — commit it alongside the source for
   lockfile-style change review.
2. **`pylon schema push`** posts that prepared artifact to the
   service. Refuses to push raw / hand-edited input by default; pass
   `--from-source` to fuse the two steps into one shot.

The split exists so consumers (Olam, future MCPs) don't each
re-implement the namespace prefix + sort + validate logic. See
[ADR 006](./adr/006-schema-prepare.md) for the rationale.

### `pylon schema prepare`

Generate the canonical schema artifact from a bare source file.
Pure / offline / no network. Same `(source, cli_version)` always
produces byte-identical output.

```bash
# Default: write canonical JSON to stdout (status line goes to stderr).
pylon schema prepare --source schema.yaml --app olam > prepared.json

# Write to a file with 0o644 perms + trailing newline:
pylon schema prepare --source schema.yaml --app olam --out prepared.json

# Verify prepared output matches the deployed schema (CI drift check).
# Requires `pylon login`; exits 12 + prints a line-diff on mismatch.
pylon schema prepare --source schema.yaml --app olam --check
```

**Bare source format** (YAML or JSON; YAML.parse accepts both).
Names are bare — no `<appId>:` prefix; the prepare step adds it:

```yaml
version_tag: "0.1.0"
capabilities:
  - name: world.read
    description: Read worlds
  - name: world.write
archetypes:
  - name: user
    capabilities: [world.read]
  - name: admin
    capabilities: [world.read, world.write]
    inherits: [user]
```

**Validation rejects** (each → exit 11): names containing `:` (the
prefix is added here, not authored), names not matching
`/^[a-z0-9][a-z0-9._-]*$/`, duplicate cap or archetype names,
archetype.capabilities referencing an undeclared cap, dangling
`inherits` reference, or a cycle in the `inherits` DAG.

The marker shape is fixed at three string fields:

```json
{
  "_prepared": {
    "cli_version": "0.3.0",
    "source_sha256": "f1a6...",
    "content_sha256": "0bc3..."
  }
}
```

`source_sha256` records which raw source produced the artifact;
`content_sha256` is the integrity tripwire — `pylon schema push`
recomputes it and refuses bodies whose hash no longer matches
(catches hand-edits between prepare and push). `cli_version` is
informational provenance; the server treats the marker as opaque
metadata. App-token remains the only auth on push.

Test fixtures pin the marker via `PYLON_CLI_VERSION_OVERRIDE`:

```bash
PYLON_CLI_VERSION_OVERRIDE=0.0.0-test pylon schema prepare \
  --source bare.yaml --app example --out fixture.prepared.json
```

### `pylon schema push`

Push a **prepared** schema artifact to Pylon. Uses
`X-Pylon-App-Token` auth — the forever-valid token returned once by
`pylon app register`.

```bash
# Recommended: prepare → commit → push (CI lockfile-style):
pylon schema prepare --source schema.yaml --app olam --out schema.prepared.json
PYLON_APP_TOKEN=pyat_... pylon schema push --app olam \
  --file schema.prepared.json

# One-shot equivalent — runs the prepare pipeline in-memory before posting:
PYLON_APP_TOKEN=pyat_... pylon schema push --from-source --app olam \
  --file schema.yaml

# Explicit flag (fine on your laptop; DANGEROUS in shared shells + CI):
pylon schema push --app olam --file schema.prepared.json \
  --app-token pyat_...

# Stdin (safe for secret managers):
vault read -field=token pylon/olam \
  | pylon schema push --app olam --file schema.prepared.json --app-token -
```

If `--file` does not carry a valid `_prepared` marker, push exits
with code 10 and prints a multi-line remediation message naming the
exact `pylon schema prepare` command to run with your file/app.
Pass `--from-source` to bypass the marker requirement when the
input is bare YAML/JSON you want prepared and posted in one step.

**Push outcomes**:

| Outcome | Meaning |
|---|---|
| `accepted` | Additive diff (new caps / archetypes / inherits edges, expanded archetype cap lists). Version bumped, current pointer advanced. |
| `pending_approval` | Destructive diff (removed/renamed caps, shrunk archetypes, removed inherits). Current pointer **unchanged**; admin must approve. The MCP keeps serving on the previous version. |

The CLI verifies the marker BEFORE POSTing, so a tab-completed
`--file .env` never leaves the laptop.

### `pylon schema current`

Show the active schema for an app. Session JWT + `pylon:app.manage`.

```bash
pylon schema current --app olam
#   version 3  (tag: 0.2.1)
#   pushed by alice@co at 2026-04-22T18:32:05.103Z
#
#   capabilities (5):
#     olam:world.read  — Read worlds
#     olam:world.write
#     ...
#
#   archetypes (2):
#     olam:user
#       caps:     [olam:world.read]
#     olam:admin
#       caps:     [olam:world.read, olam:world.write]
```

### `pylon schema list`

List all versions for an app, with current + pending pointers.
Versions pushed via CLI 0.3.0+ carry a `_prepared` marker — the
list view renders `cli_version` + the first 12 hex chars of
`source_sha256` as the `prep` column. Pre-0.3.0 / SDK / curl pushes
have no marker; the column is omitted on those rows.

```bash
pylon schema list --app olam
#   3 version(s)  current=2  pending=3
#
#     v1    0.1.0             2026-04-18T12:00:01.000Z  eng@co
#     v2    0.2.0             2026-04-22T09:15:32.000Z  eng@co  ← current  prep cli=0.3.0 src=f1a6125cd6a0…
#     v3    0.3.0             2026-04-23T17:04:11.000Z  eng@co  ← pending approval  prep cli=0.3.0 src=ab12cd34ef56…
```

### `pylon schema approve`

Approve a pending destructive migration. Session JWT +
`pylon:schema.approve-migration`.

```bash
pylon schema approve --app olam --version 3
#   ✓ schema approved
#     app:     olam
#     version: 3 (now current)
#     roles migrated: 0
```

Only the pylon-admin archetype (or an explicit
`pylon:schema.approve-migration` grant) can run this. Approval:
advances the current pointer, clears the pending record, writes
an audit entry (`schema.approved`).

## Configuration

### Where things live

| Thing | Path | Persisted? |
|-------|------|------------|
| Session JWTs | OS keyring: `pylon:session:<orgId>` | Yes, 24h TTL |
| Org metadata | `~/.pylon/config.yaml` | Yes, permanent |
| Scoped tokens | MCP process memory only | No |

### `~/.pylon/config.yaml`

```yaml
default_org: acme
orgs:
  - id: acme
    api_url: https://pylon.acme.internal
    default: true
  - id: acme-staging
    api_url: https://pylon-staging.acme.internal
```

Safe to commit to dotfiles. No secrets here — just URL+id metadata.

### Environment variable overrides

| Variable | Purpose |
|----------|---------|
| `PYLON_ORG_URL` | Override the resolved org URL (CI, containers) |
| `PYLON_ORG_ID` | Override the resolved org id |
| `PYLON_SESSION_TOKEN` | Session JWT when no keyring is available |
| `PYLON_APP_TOKEN` | Forever-valid app token for `pylon schema push` (CI) |
| `PYLON_CONFIG_PATH` | Alternative config file path (tests + CI) |

Precedence at resolve time: flag > env > config > interactive
prompt (TTY only).

## Help + diagnostics

```bash
pylon --version
pylon --help
pylon <subcommand> --help
```

Any command printing a non-zero exit code also writes a specific
error message to stderr. See the exit-code table above.
