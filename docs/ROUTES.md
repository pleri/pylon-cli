# Pylon route classes — what to expose, what to gate

When a `pylon` CLI command produces:

```
gateway intercept on <METHOD> <PATH> → HTTP 3xx (Location: …cloudflareaccess.com/…)
```

…it means a Cloudflare Access policy is intercepting an endpoint that
shouldn't be CF-Access-protected. This page is the canonical map of
which Pylon endpoints belong to which class, and what "exempt" actually
means in each case.

## TL;DR for operators

CF Access at the Cloudflare edge has no Bearer-JWT mode. If it covers
a path that the CLI/SDK calls with `Authorization: Bearer <session_jwt>`
or `X-Pylon-App-Token: <token>`, it ignores those headers and redirects
to SSO. The CLI then sees a 302 instead of a JSON response.

So the only paths CF Access should _own_ are the **browser-rendered
HTML pages** that complete the device-code / login / bootstrap flows.
Everything else — every API endpoint the CLI or SDK calls — must
either be public or auth'd by Pylon's own JWT, and in **both** of
those cases must be excluded from CF Access interception at the edge.

## Three route classes

This is the distinction: "exempt from CF Access" ≠ "public". A path
can require strong auth and still need CF Access to leave it alone.

| Class | Auth mechanism | CF Access at edge | Who calls it |
|---|---|---|---|
| **A. Public** | none | **must be exempt** | CLI / SDK / monitoring, before any credential exists |
| **B. Pylon-authenticated** | `Authorization: Bearer <jwt>` or `X-Pylon-App-Token` (Pylon validates internally) | **must be exempt** | CLI / SDK after login (or with an app token) |
| **C. Browser-gated** | `Cf-Access-Jwt-Assertion` from CF Access | **CF Access required** | a browser walking through SSO |

Class B is the one that confuses operators. The endpoint _is_ strongly
authenticated — Pylon validates the JWT signature, issuer, audience,
expiry, and capability claims inside the Worker. CF Access just can't
do that validation, so it has to step out of the way.

## Per-endpoint matrix

### Class A — public (no credential at all)

| Method | Path | Caller | Why it's public |
|---|---|---|---|
| GET | `/discover` | CLI before any login | resolves org URL → org id; the CLI has no credential yet |
| POST | `/device/init` | CLI starting device-code flow | issues a one-time device code; auth happens after, in the browser |
| GET | `/device/poll` | CLI polling for completion | returns `pending` until the browser side finishes; the device code itself is the credential |
| GET | `/.well-known/pylon-keys` | every MCP SDK at boot, JWKS refresh | public signing keys; cannot leak anything |
| GET | `/health` | uptime monitor | liveness probe |
| GET | `/ready` | deployment pipeline | readiness probe (KV + signing key present) |

### Class B — Pylon-authenticated (Bearer or app token)

These are the paths the CLI calls _after_ login. The 302 you almost
certainly hit is one of these. Each carries its own credential that
Pylon validates internally; CF Access at the edge must let them
through to the Worker.

| Method | Path | Auth header | Caller |
|---|---|---|---|
| GET | `/whoami` | `Authorization: Bearer <session_jwt>` | `pylon whoami`, also called at the end of `pylon login` to verify the freshly-minted token |
| GET, POST, DELETE | `/apps`, `/apps/:appId` | `Authorization: Bearer <session_jwt>` | `pylon app list` / `pylon app register` / `pylon app disable` |
| POST, GET, DELETE | `/roles`, `/roles/:appId/:emailHash` | `Authorization: Bearer <session_jwt>` | `pylon role grant` / `pylon role list` / `pylon role revoke` |
| GET | `/audit` | `Authorization: Bearer <session_jwt>` | `pylon audit tail` |
| GET | `/apps/:appId/schema`, `/apps/:appId/schema/current` | `Authorization: Bearer <session_jwt>` | `pylon schema list`, `pylon schema current` |
| POST | `/apps/:appId/schema` | `X-Pylon-App-Token: <token>` | `pylon schema push` (uses the app token, not the session JWT) |
| POST | `/apps/:appId/schema/approve-migration` | `Authorization: Bearer <session_jwt>` | `pylon schema approve` |
| POST | `/token` | `Authorization: Bearer <session_jwt>` | MCP SDK (not the CLI) — exchanges the session JWT for a 30s scoped token |

### Class C — browser-gated (CF Access required)

Only these paths actually need CF Access at the edge. They render
HTML for a real human in a browser, who has just completed (or is
about to complete) SSO. There's no Bearer header to use.

| Method | Path | Caller | What it does |
|---|---|---|---|
| GET | `/device` | browser, opened from the URL `pylon login` prints | renders the device-code confirmation page; CF Access SSO completes here |
| POST | `/device/complete` | browser, after CF Access SSO | exchanges the CF Access JWT for a session JWT and finalises the device code |
| GET, POST | `/login` | browser direct login (non-device) | exchanges CF Access JWT for session JWT |
| POST | `/bootstrap` | browser, first admin only | one-time self-grant of `pylon-admin` archetype; gated by `Cf-Access-Jwt-Assertion` and the `PYLON_BOOTSTRAP_ADMIN_EMAIL` secret |

## Recommended CF Access configuration

Two equivalent shapes; pick whichever fits your CF Access UI workflow.

### Pattern 1 — explicit exempt list (most common)

Cover `<org-url>/*` with your normal "members of @yourcompany.com"
policy, and add these exempt paths:

```
/.well-known/*
/health
/ready
/discover
/device/init
/device/poll
/whoami
/apps/*
/roles/*
/audit
/audit/*
/token
```

Note the wildcards on `/apps/*` and `/roles/*` — CF Access exempt
rules use glob matching, not prefix matching, so a literal `/apps`
won't cover `/apps/olam/schema`.

### Pattern 2 — protect only browser pages (cleaner, fewer surprises)

Cover only the browser surface with CF Access; leave everything else
unprotected at the edge. Pylon's own auth gates the API.

```
Protect: /device, /device/complete, /login, /bootstrap
Everything else: no CF Access policy
```

This shape matches how the system actually works: CF Access only
ever needed to authenticate the human-in-a-browser path. The API
surface was always going to authenticate itself with Pylon JWTs.

## Why CF Access can't carry Pylon JWTs through

CF Access is an L7 reverse proxy that authenticates by looking for
either:

- a `CF_Authorization` cookie set by a successful SSO session, or
- `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers (CF Access
  service tokens), or
- a `Cf-Access-Jwt-Assertion` header (rare — usually issued by CF
  Access itself, not consumed by it)

It does **not** look at `Authorization: Bearer <jwt>`. From CF Access's
perspective, a Bearer header is just an unrelated header, so an
unauthenticated request stays unauthenticated and gets redirected to
SSO. That's the 302 the CLI sees.

The CLI does not currently support CF Access service tokens (no flag
to set `CF-Access-Client-Id` / `CF-Access-Client-Secret`). If you need
to keep CF Access in front of API endpoints — for example, because
your compliance posture requires every external request to flow
through CF Access — that's a feature request worth filing; the
current shape of the CLI assumes Pattern 1 or Pattern 2 above.

## Troubleshooting checklist

1. Read the `gateway intercept on <METHOD> <PATH>` line in the error.
   That's the exact endpoint that 302'd.
2. Find the path in the matrix above. If it's Class A or Class B,
   it must be exempt from CF Access.
3. Add the path to your CF Access exempt list (Zero Trust → Access →
   Applications → your Pylon app → policy → exempt paths). Use the
   exact path or a glob that covers it.
4. Re-run the failing `pylon` command.

If the same path still 302's after you've added it to the exempt list,
the most common causes are:

- A typo in the exempt rule (CF Access uses globs, not prefixes —
  `/apps` won't cover `/apps/olam/schema`; you need `/apps/*`).
- A second, more permissive Access policy on the same hostname that
  re-asserts protection. Check for overlapping applications.
- A Workers Route that runs Pylon on a different hostname than the one
  CF Access protects.
