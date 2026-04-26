# `@pleri/pylon` — SDK Contract (v0.1)

Public contract for the `@pleri/pylon` package. Any change to the
surface described here is a semver-visible event. Consumers — and every
MCP that enrols into Pylon — can code against this document before the
implementation lands.

Status: **design-locked for v0.1.0** (revised after security /
performance / simplicity audits, 2026-04-23).

> **Note on package availability.** This doc lives in `pleri/pylon-cli`
> because it's the canonical wire-contract reference for any consumer
> talking to a Pylon service. Three packages are referenced throughout:
>
> - **`@pleri/pylon-cli`** — published, public, this repo. The CLI in
>   §3.5+ that admins/operators install via `npm install -g`.
> - **`@pleri/pylon`** — the runtime SDK package (§4–§5) that Workers
>   MCPs would import at request-handling time. **Not yet published**;
>   currently a closed implementation. Sections §4–§5 describe its
>   intended public surface as a contract you can build against, not
>   an `npm install`-able package.
> - **`@pleri/pylon-core`** — type substrate (`Capability`, `Archetype`,
>   `Actor`, error classes) imported by both `@pleri/pylon` and the
>   service. Also **not yet published**; same status as `@pleri/pylon`.
>
> Where the doc shows `npm install @pleri/pylon[-core]` or `import …
> from '@pleri/pylon[-core]'`, treat it as forward-looking documentation
> of the contract until the packages publish.

---

## 0. Mental model

Pylon issues three kinds of credential:

| Credential | TTL | Carrier | Source | Verifier |
|---|---|---|---|---|
| **Session JWT** | 24h | Bearer header (or env) | `pylon login` / `/device/complete` | SDK (signature + iss + aud; not hot path) |
| **Scoped token** | 30s | Bearer header to the MCP | SDK calls `POST /token` with session | SDK (signature + iss + aud + org + app + nbf + exp) |
| **App token** | rotatable | `X-Pylon-App-Token` header | `pylon app register` returns once; `pylon app token rotate` | Server-side only |

Per-request flow inside an MCP (hot path):

```
Client ──► MCP (CF Worker or stdio) ──► pylonClient.resolve(req)
                                          │
                                          ├─ cache hit? return the cached Actor (zero I/O, zero parse)
                                          │
                                          ├─ extract session token (from header or sessionToken config)
                                          ├─ singleflight mint: POST /token (session → scoped, 30s)
                                          │    ↳ JWKS cache (stale-while-revalidate, singleflight refresh)
                                          ├─ verify scoped (sig + iss + aud + org + app + nbf + exp)
                                          ├─ materialize Actor once; store in cache entry
                                          └─ return Actor<string>
```

Schema push (startup or CI, not hot path):

```
pylonSchemaClient.push(declaration) ──► POST /apps/:id/schema
                                         + X-Pylon-App-Token
                                         │
                                         ├─ additive    → { status: 'accepted', version }
                                         ├─ destructive → { status: 'pending_approval', version }
                                         │                 ↑ MCP continues on PREVIOUS version
                                         ├─ namespace violation → throws PylonSdkError(code: 'namespace_violation')
                                         └─ invalid schema    → throws PylonSdkError(code: 'invalid_schema')
```

Read this doc top-to-bottom once; after that, `§2.1` (surface) and
`§5` (recipes) are what you'll come back to.

---

## 1. Installation

```bash
# NOTE: @pleri/pylon is not yet published — see header note above.
# Snippet documents the intended install once the package ships.
pnpm add @pleri/pylon
# or
npm install @pleri/pylon
```

- Runtime: Node ≥ 22, Cloudflare Workers (any runtime with WHATWG `fetch` + Web Crypto).
- No `keytar` / native deps. No `inquirer`. Server-side only.
- ESM-only (`"type": "module"`).

### 1.1 Subpath exports

To keep Workers bundles small, `@pleri/pylon` ships three entry points:

| Import | Size target (gz) | Contains |
|---|---|---|
| `@pleri/pylon/verify` | ≤ 8 KB | `pylonClient`, `pylonGuard`, error class, re-exports from pylon-core |
| `@pleri/pylon/schema` | ≤ 5 KB | `pylonSchemaClient` + schema types |
| `@pleri/pylon` | ≤ 15 KB | Everything — use if you do both |

Workers MCPs that only verify requests at runtime should
`import from '@pleri/pylon/verify'` (schema push is a deploy-time
concern — see §5.3). Size budgets enforced in CI.

---

## 2. Public API

### 2.1 `pylonClient(config) → PylonClient`

The one factory most MCPs need.

```ts
interface PylonConfig {
  /** HTTPS origin hosting /discover for this org. e.g. "https://pylon.acme.dev". */
  readonly orgUrl: string;

  /** This MCP's app id (slug). Must match the id registered via `pylon app register`. */
  readonly appId: string;

  /**
   * Expected orgId. Production deployments MUST set this. See §8.1.
   * Without it, the first /discover response is trusted unconditionally
   * (DNS-poisoning-vulnerable during first boot).
   */
  readonly expectedOrgId: string;

  /**
   * How the SDK gets a session JWT for the current caller.
   *   • string       — static token (env var, secrets manager)
   *   • (req) => str — per-request resolver; receives the Request passed to resolve()
   *   • omitted      — read "Authorization: Bearer <jwt>" from the Request passed to resolve()
   *
   * SECURITY: the function form's return value is trusted as a privileged
   * session JWT. Never return a value derived from end-user-controlled
   * input (e.g., a proxy header set by untrusted upstream). Only use it
   * for deployment-time config lookups.
   */
  readonly sessionToken?:
    | string
    | ((req?: Request) => string | null | Promise<string | null>);

  /** Inject fetch. Default: globalThis.fetch. */
  readonly fetch?: typeof fetch;

  /**
   * Inject a JWKS cache backed by shared storage (e.g. CF Workers KV)
   * so it survives isolate churn. Default: per-process Map.
   */
  readonly jwksCache?: JwksCache;

  /**
   * Structured event sink. Called on notable events
   * (cache miss, JWKS refresh, verify failure reason).
   * Never called with secrets or bearer values.
   */
  readonly onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

interface JwksCache {
  get(): Promise<{ keys: readonly Jwk[]; fetchedAt: number } | null>;
  set(value: { keys: readonly Jwk[]; fetchedAt: number }): Promise<void>;
}
```

Factory behaviour:

1. Validates `orgUrl` (HTTPS, no userinfo, no path) synchronously.
2. Does **no I/O at construction**. The first `resolve()` triggers
   discovery, then JWKS fetch. These run **serially** because JWKS
   is fetched from `discover.apiUrl` (not `orgUrl`) to preserve the
   same-origin guarantee from `/discover`.
3. Returns a `PylonClient` whose internal state includes a scoped-token
   cache (keyed by `(sessionToken, appId)` using the raw string as key —
   O(1) lookup, no hashing on hot path), a JWKS cache (5-min TTL,
   singleflighted refresh, stale-while-revalidate), and a discover cache.

### 2.2 `PylonClient`

```ts
class PylonClient {
  /**
   * Resolve the caller into an Actor with capabilities.
   * Returns null when no session token is available.
   * Never throws for "no session"; does throw for verification failure.
   *
   * Hot-path guarantees (cache hit):
   *   • Zero network I/O.
   *   • O(1) cache lookup (raw-string key).
   *   • Returns the same Actor instance for the life of the cache entry.
   *   • Actor.has(cap) is O(1) (Set-backed internally).
   *
   * Concurrent cache-miss requests for the same (sessionToken, appId)
   * are singleflighted to one POST /token call.
   */
  async resolve(input: Request | { bearer: string }): Promise<Actor<string> | null>;

  /**
   * Thin wrapper over pylon-core's requireCapability. Exposed so
   * consumers import from one package.
   *
   * Throws CapabilityDeniedError (from pylon-core) if the actor
   * lacks the cap. Returns void on success.
   */
  requireCapability(actor: Actor<string>, cap: string): void;

  /**
   * Structured error shape to surface when resolve() returns null.
   * Stable across versions. Body is free of bearer / session values.
   */
  readonly missingSessionError: {
    readonly status: 401;
    readonly code: 'no_session';
    readonly message: string;
  };
}
```

There is **no** public `mintScoped`, `refreshJwks`, or low-level
verify helper. Internal caches and refresh logic handle these
automatically (see §2.5).

### 2.3 `pylonGuard(client, options?)` — request guard

Wraps `resolve()` + capability check + error coalescing. This is
the function you call from a CF Worker or MCP request handler.

```ts
interface GuardOptions {
  readonly requiredCapability?: string;
  /** Customize the body shape returned on auth failure. Default: { error: code, message }. */
  readonly formatError?: (
    err: { status: number; code: string; message: string },
  ) => unknown;
}

interface GuardResult {
  readonly actor?: Actor<string>;
  readonly errorResponse?: { status: number; body: unknown };
}

function pylonGuard(
  client: PylonClient,
  options?: GuardOptions,
): (req: Request) => Promise<GuardResult>;
```

Behaviour:

- `resolve()` returns null → `{ errorResponse: { status: 401, code: 'no_session' } }`.
- `resolve()` throws `PylonSdkError` → `{ errorResponse: { status: err.status, code: err.code } }`.
  **The `.reason` sub-discriminator is NEVER placed in the response body.**
  It's emitted through `onEvent('token.verify.failed', { reason })` for
  internal observability only.
- `options.requiredCapability` present + actor lacks it →
  `{ errorResponse: { status: 403, code: 'insufficient_capability' } }`.
- Success → `{ actor }`.

`pylonGuard` exists primarily to enforce this error-coalescing invariant.
Consumers who want full control can call `client.resolve()` directly,
but they're responsible for not leaking `err.reason` to the wire.

### 2.4 Error model — one class

```ts
class PylonSdkError extends Error {
  readonly code:
    | 'no_session'
    | 'token_invalid'
    | 'org_mismatch'
    | 'schema_push_failed'
    | 'namespace_violation'
    | 'invalid_schema'
    | 'app_token_invalid';

  readonly status: number;     // HTTP status for responses

  /**
   * Sub-discriminator for internal logging. INTERNAL USE ONLY.
   * Never include in HTTP response bodies (pylonGuard strips it).
   *
   * For 'token_invalid':
   *   'malformed' | 'wrong_alg' | 'wrong_kid' | 'bad_signature'
   *   | 'expired' | 'not_yet_valid' | 'wrong_iss' | 'wrong_aud'
   *   | 'wrong_org' | 'wrong_app'
   */
  readonly reason?: string;

  /** Optional structured detail for the event sink. Never in HTTP body. */
  readonly detail?: Record<string, unknown>;
}
```

Why one class, not four: consumers `switch (err.code)` in practice;
`instanceof` ladders across four subclasses is noise. `.reason` stays
on the one class for internal log correlation without expanding the
public surface.

### 2.5 Re-exports from `@pleri/pylon-core`

For single-import ergonomics:

```ts
export {
  type Actor,
  type Archetype,
  type Capability,
  type RoleEntry,
  CapabilityDeniedError,
  UnresolvedActorError,
  UndeclaredRouteError,
  UnknownArchetypeError,
  ArchetypeCycleError,
  expandArchetype,
  hashEmail,
  requireCapability,
  hasCapability,
} from '@pleri/pylon-core';
```

### 2.6 `pylonSchemaClient(config) → PylonSchemaClient`

Separate object from `pylonClient`. Different auth (app token),
different lifecycle (deploy / boot, not per-request), different
audience (MCP authors + CI, not the hot path).

```ts
interface PylonSchemaConfig {
  readonly orgUrl: string;
  readonly appId: string;
  readonly appToken: string;      // X-Pylon-App-Token
  readonly expectedOrgId: string; // same production requirement as §2.1
  readonly fetch?: typeof fetch;
  readonly onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

class PylonSchemaClient {
  /**
   * Push (or re-push) a capability schema. Idempotent.
   * See §4 for SchemaDeclaration + diff semantics.
   *
   * Returns the server's classification. Does NOT throw on
   * 'pending_approval' — fail-open so the MCP keeps serving on
   * the previously-active version.
   *
   * Throws PylonSdkError on namespace_violation, invalid_schema,
   * app_token_invalid — those are deploy-time bugs that must fail loud.
   */
  async push(schema: SchemaDeclaration): Promise<SchemaPushResult>;

  /** GET /apps/:id/schema/current — what version is live right now. */
  async current(): Promise<Schema>;
}
```

Schema-specific types:

```ts
interface SchemaDeclaration {
  readonly version_tag: string;
  readonly capabilities: readonly Capability[];
  readonly archetypes:  readonly Archetype<string>[];
}

interface Schema extends SchemaDeclaration {
  readonly version: number;
  readonly pushed_by: string;
  readonly pushed_at: number;
}

type SchemaPushResult =
  | { readonly status: 'accepted'; readonly version: number }
  | {
      readonly status: 'pending_approval';
      readonly version: number;
      readonly current_version: number;
      readonly diff: SchemaDiff;
    };
```

(`SchemaDiff` shape is server-defined; consumers can log it but
shouldn't pattern-match on its internals — see §4.)

**On the `_prepared` marker (v0.3 CLI behavior, opt-in for SDK):**
`pylonSchemaClient.push()` does NOT generate a `_prepared` marker
on the request body. The server treats the marker as opaque
provenance metadata — pushes without it continue to work and round-trip
through `Schema` with `prepared` absent. The marker is emitted by
`pylon schema prepare` (CLI 0.3.0+) for the lockfile-style consumer
flow; it is not part of the SDK push surface in v0.1. If a future
consumer demands a hard server-side enforcement boundary, the marker
shape is already defined in §3.4 / §4.1 and the SDK can grow a
matching emission helper at that time. App-token remains the only
auth on push regardless of marker presence.

---

## 3. HTTP contract (what the SDK calls)

All endpoints relative to `apiUrl` from `/discover`. JSON bodies.
Errors: `{ error: string, message?: string }` with the HTTP status
carrying the failure class.

### 3.1 `GET /discover` · unauthenticated

```json
{ "id": "acme", "name": "Acme Robotics", "api_url": "https://pylon.acme.dev" }
```

Validated client-side: `id` matches `/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/`,
`api_url` **same origin** as the request URL, `name` non-empty string.
`redirect: 'manual'` — a 3xx aborts with `code: 'discover_failed'`.

### 3.2 `POST /token` · Authorization: Bearer \<session_jwt\>

```json
// Request
{ "app_id": "olam" }

// 200
{ "scoped_token": "<jwt>", "ttl": 30, "expires_at": 1745451234567 }

// 400 invalid_app_id · 401 no_session|expired|org_mismatch · 403 app_disabled
```

Scoped-token claims (**iss** + **aud** + **nbf** added in v0.1 audit —
hardens against cross-tenant replay and clock-drift issues):

```jsonc
{
  "iss":  "https://pylon.acme.dev",  // issuer = apiUrl
  "aud":  "olam",                    // audience = appId
  "sub":  "alice@co",                // user email
  "org":  "acme",                    // orgId
  "app":  "olam",                    // appId (duplicated for diff-check rigor)
  "caps": ["olam:world.read", "olam:world.write"],
  "iat":  1745451200,
  "nbf":  1745451200,                // not-before (== iat at mint)
  "exp":  1745451230                 // iat + 30
}
```

The SDK verifies: signature (EdDSA / Ed25519), `iss === apiUrl`,
`aud === appId`, `org === expectedOrgId`, `app === appId`,
`now() >= nbf`, `now() < exp - 2s` (2s clock-skew pad).

### 3.3 `GET /.well-known/pylon-keys` · unauthenticated · Cache-Control: max-age=300

```json
{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "...", "kid": "...", "alg": "EdDSA", "use": "sig" } ] }
```

SDK behaviour:

- **Stale-while-revalidate:** serve cached JWKS during a background refresh.
- **Singleflight:** concurrent refreshes coalesce to one fetch.
- **Auto-retry on kid-miss:** if a token's `kid` isn't in the cache,
  the SDK triggers one refresh + retry before throwing `wrong_kid`.
  Closes the 5-min rotation window for legitimate key cycles.
- **Backoff on 5xx:** exponential backoff (1s→30s cap), serve last
  good cache until recovered. No request amplification.

### 3.4 `POST /apps/:id/schema` · X-Pylon-App-Token

**Namespace enforcement applies to both capabilities AND archetype
`inherits` edges** (tightened in v0.1 audit — prevents privilege
escalation via cross-namespace inheritance).

A push to `/apps/olam/schema`:

- Every `Capability.name` must match `/^olam:[a-z0-9._-]+$/`.
- Every `Archetype.name` must match `/^olam:[a-z0-9._-]+$/`.
- Every entry in `Archetype.inherits` must also be `olam:*`.
  An olam archetype may NOT inherit from `pylon:*` or any other namespace.
- Violations return 422 with `code: 'namespace_violation'`.

```json
// Request body — markerless (SDK / curl path; always accepted)
{
  "version_tag": "0.3.0",
  "capabilities": [{ "name": "olam:world.read", "description": "..." }],
  "archetypes":  [{ "name": "olam:viewer", "capabilities": ["olam:world.read"], "inherits": [] }]
}

// Request body — with optional `_prepared` marker (CLI 0.3.0+ path)
{
  "version_tag": "0.3.0",
  "capabilities": [{ "name": "olam:world.read", "description": "..." }],
  "archetypes":  [{ "name": "olam:viewer", "capabilities": ["olam:world.read"], "inherits": [] }],
  "_prepared": {
    "cli_version":    "0.3.0",
    "source_sha256":  "f1a6125cd6a0945586ee09d2fbc286e08dce3272879e7d797f959a7718e56498",
    "content_sha256": "0bc3...64hex"
  }
}

// 200 — additive, auto-accepted
{ "status": "accepted",         "version": 5 }

// 200 — destructive, awaiting admin approval
{ "status": "pending_approval", "version": 5, "diff": {...}, "current_version": 4 }

// 422 — namespace violation
{ "error": "namespace_violation", "message": "archetype 'olam:x' inherits 'pylon:admin' (cross-namespace)" }

// 400 — malformed `_prepared` (server validates shape only, not content_sha256)
{ "error": "invalid_schema", "detail": "_prepared.cli_version must look like a semver" }
```

**Marker semantics (v0.3+).** `_prepared` is an OPTIONAL top-level
field. Three required string fields when present:

```ts
interface PreparedMarker {
  readonly cli_version:    string;  // semver-shaped, ≤ 64 chars
  readonly source_sha256:  string;  // 64 lowercase hex chars
  readonly content_sha256: string;  // 64 lowercase hex chars
}
```

The server:

- Lifts `_prepared` off the request body BEFORE namespace validation;
  validation runs against the unmarked declaration.
- Persists the marker on the snapshot if present (`Schema.prepared`).
- Records `cli_version` + `source_sha256` in the audit row's `detail`
  block when present.
- Does NOT recompute or verify `content_sha256` — that's a CLI-side
  integrity tripwire, not a server-side gate.
- Rejects any OTHER top-level `_*` key with 400 `invalid_schema` —
  `_prepared` is the single allowlisted reserved key.

The canonical-JSON form `content_sha256` hashes over is defined by
`pylon schema prepare`: lexicographically sorted keys at every depth,
NFC-normalized strings, ECMA-262 `JSON.stringify` numbers, 2-space
indent, LF line endings, single trailing newline. See
[`docs/CLI.md`](./CLI.md) for operator-facing behavior and
[ADR 006](./adr/006-schema-prepare.md) for the framing rationale.

### 3.5 `GET /apps/:id/schema/current` · Authorization: Bearer \<session_jwt\>

```json
// Response body — `prepared` field is OPTIONAL (present iff the
// version was pushed via CLI 0.3.0+; absent for SDK / curl / pre-0.3.0)
{
  "version": 4,
  "version_tag": "0.2.1",
  "capabilities": [...],
  "archetypes": [...],
  "pushed_by": "alice@co",
  "pushed_at": 1745400000000,
  "prepared": {
    "cli_version":    "0.3.0",
    "source_sha256":  "f1a6...",
    "content_sha256": "0bc3..."
  }
}
```

The `GET /apps/:id/schema` (list) endpoint surfaces `prepared` per
version on the same shape — present per row iff that version's
push carried a marker. CLI `pylon schema list` renders
`cli_version` + the first 12 hex chars of `source_sha256` for
markered rows.

### 3.6 `POST /apps/:id/schema/approve-migration` · session JWT + `pylon:schema.approve-migration`

```json
// Request: { "version": 5 }
// 200:     { "status": "approved", "version": 5, "roles_migrated": 12 }
// 404 if no pending proposal for that version
```

### 3.7 `POST /apps/:id/token/rotate` · session JWT + `pylon:app.manage` · **v0.1.x**

Rotates the app token. Old token invalidated immediately; new token
returned once. Tracked for v0.1.x because app-token leak has no other
recovery path; the endpoint is on the contract now so SDKs can code
against it.

```json
// 200
{ "app_id": "olam", "app_token": "pyat_...", "rotated_at": 1745451234567 }
```

### 3.8 Endpoints **not** in the SDK surface

- `GET /whoami` · `POST /login` · `POST /device/*` · `POST /apps` ·
  admin role/audit endpoints — CLI territory, not MCP runtime.

---

## 4. Schema model

### 4.1 Declaration type

```ts
interface SchemaDeclaration {
  readonly version_tag: string;       // human label, not used for diffing
  readonly capabilities: readonly Capability[];
  readonly archetypes:  readonly Archetype<string>[];
}

// Persisted snapshot — `prepared` is optional provenance metadata
// (see §3.4 for emission semantics). Never gates push acceptance.
interface PreparedMarker {
  readonly cli_version:    string;  // semver-shaped, ≤ 64 chars
  readonly source_sha256:  string;  // 64 lowercase hex chars
  readonly content_sha256: string;  // 64 lowercase hex chars
}

interface Schema extends SchemaDeclaration {
  readonly version: number;
  readonly pushed_by: string;
  readonly pushed_at: number;
  readonly prepared?: PreparedMarker;
}
```

`Capability` / `Archetype` come from `@pleri/pylon-core`:

```ts
interface Capability {
  readonly name: string;         // /^<appId>:[a-z0-9._-]+$/
  readonly description?: string;
}

interface Archetype<TCap extends string> {
  readonly name: string;         // /^<appId>:[a-z0-9._-]+$/
  readonly capabilities: readonly TCap[];
  readonly inherits?: readonly string[];   // must match same <appId>: prefix
  readonly description?: string;
}
```

### 4.2 Diff classification (server-side)

| Change | Classification |
|---|---|
| New capability | additive |
| New archetype | additive |
| New `inherits` edge (same namespace) | additive |
| Expanded capability list on existing archetype (superset) | additive |
| Removed / renamed capability | **destructive** |
| Removed / renamed archetype | **destructive** |
| Removed `inherits` edge | **destructive** |
| Shrunk capability list on existing archetype | **destructive** |
| Description-only change | additive (cosmetic) |

Additive only → auto-accepted, version bump.
Any destructive change → pending admin approval (stored at
`schema:<orgId>:<appId>:pending`).

**Caveat for MCP authors (from v0.1 audit):** expanded archetype
capability lists are **additive by design**. Admins approving schema
pushes are responsible for reviewing the full version diff, including
what caps an archetype now includes transitively via inherits, before
rubber-stamping.

### 4.3 Storage

- `schema:<orgId>:<appId>:<version>` — immutable snapshot.
- `schema:<orgId>:<appId>:current` — active version pointer.
- `schema:<orgId>:<appId>:pending` — awaiting approval (one at a time).

### 4.4 Fail-open on `pending_approval`

```ts
const result = await schemaClient.push(declaration);
if (result.status === 'pending_approval') {
  onEvent('pylon.schema.pending_approval', {
    proposed_version: result.version,
    current_version:  result.current_version,
  });
  // MCP continues on result.current_version. No throw.
}
```

**Defensive guidance:** if your MCP code calls `requireCapability(actor, 'olam:new-cap')`
for a cap that was added in the proposed-but-not-yet-approved schema,
every call will throw `CapabilityDeniedError`. For caps that may be
mid-migration, prefer `hasCapability()` with a graceful fallback.

---

## 5. Integration recipes

### 5.1 MCP Cloudflare Worker

```ts
import { pylonClient, pylonGuard } from '@pleri/pylon/verify';

const client = pylonClient({
  orgUrl:         env.PYLON_ORG_URL,
  appId:          'olam',
  expectedOrgId:  env.PYLON_ORG_ID,           // REQUIRED in production (see §8.1)
  // sessionToken omitted → reads Authorization: Bearer from Request.
  jwksCache: {                                // share JWKS across isolates
    async get() { return env.PYLON_CACHE.get('jwks', 'json'); },
    async set(v) { await env.PYLON_CACHE.put('jwks', JSON.stringify(v), { expirationTtl: 600 }); },
  },
});

const guard = pylonGuard(client, { requiredCapability: 'olam:world.read' });

export default {
  async fetch(request: Request): Promise<Response> {
    const { actor, errorResponse } = await guard(request);
    if (errorResponse) {
      return new Response(JSON.stringify(errorResponse.body), {
        status: errorResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return handleAuthenticated(request, actor);
  },
};
```

### 5.2 MCP stdio server

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { pylonClient } from '@pleri/pylon/verify';

const client = pylonClient({
  orgUrl:         process.env.PYLON_ORG_URL!,
  appId:          'olam',
  expectedOrgId:  process.env.PYLON_ORG_ID!,
  sessionToken:   process.env.PYLON_SESSION_TOKEN!,  // long-lived, injected by auth-service
});

const server = new Server({ name: 'olam-mcp', version: '0.3.0' });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const actor = await client.resolve({ bearer: process.env.PYLON_SESSION_TOKEN! });
  if (!actor) throw new McpError(client.missingSessionError);

  const cap = CAPABILITY_FOR_TOOL[req.params.name];
  if (cap) client.requireCapability(actor, cap);

  return callTool(req, actor);
});
```

### 5.3 Schema push — CI-first, runtime-fallback

**Recommended (CI / deploy-time):**

```bash
# In .github/workflows/deploy.yml:
- run: npx -p @pleri/pylon-cli pylon schema push \
         --app olam \
         --file ./capabilities.yaml \
         --app-token $PYLON_APP_TOKEN
```

CI push keeps schema changes out of the runtime boot path (no extra
network call on cold isolates) and gates the deploy on schema acceptance.

**Runtime fallback (stdio MCPs, dev loops):**

```ts
import { pylonSchemaClient } from '@pleri/pylon/schema';
import { OLAM_SCHEMA } from './capabilities.js';

const schema = pylonSchemaClient({
  orgUrl:         process.env.PYLON_ORG_URL!,
  appId:          'olam',
  appToken:       process.env.PYLON_APP_TOKEN!,
  expectedOrgId:  process.env.PYLON_ORG_ID!,
  onEvent: (event, detail) => logger.info(event, detail),
});

try {
  const result = await schema.push(OLAM_SCHEMA);
  if (result.status === 'pending_approval') {
    logger.warn('schema pending admin approval', {
      proposed: result.version,
      current:  result.current_version,
    });
  }
} catch (err) {
  if (err.code === 'namespace_violation' || err.code === 'invalid_schema') {
    throw err;  // Developer bug. Fail loudly.
  }
  logger.warn('schema push failed; continuing on current version', { error: String(err) });
}
```

---

## 6. Testing

### 6.1 Test plan (v0.1.0 acceptance)

| Area | Assertion | File |
|---|---|---|
| `discoverOrg` (internal) | happy path, same-origin safety, redirect refusal | `discover.test.ts` |
| JWKS cache | hits, 5-min TTL, stale-while-revalidate, singleflight refresh | `jwks.test.ts` |
| JWKS kid-miss | auto-refresh + retry, coalesces concurrent kid-misses | `jwks.test.ts` |
| JWKS 5xx | backoff, serve-last-good, no request amplification | `jwks.test.ts` |
| Verify | accepts valid; rejects expired / not_yet_valid / wrong_alg / wrong_kid / bad_sig / wrong_iss / wrong_aud / wrong_org / wrong_app | `verify.test.ts` |
| Mint (internal) | POSTs with session; 400/401/403 → correct `code` + `reason` | `mint.test.ts` |
| Mint singleflight | concurrent cache-misses coalesce to one POST | `mint.test.ts` |
| Scoped-token cache | hits within TTL, evicts on expiry, keyed by (sessionToken, appId) | `cache.test.ts` |
| `claimsToActor` (internal) | round-trips sub/org/app/caps; Set-backed has() | `actor.test.ts` |
| `pylonClient.resolve` | end-to-end Request → Actor; null on no session | `client.test.ts` |
| `pylonClient.resolve` | rejects on org mismatch (`expectedOrgId`) | `client.test.ts` |
| `pylonGuard` | 401 on no session; 401 on token_invalid; 403 on missing cap; `{ actor }` on success | `guard.test.ts` |
| `pylonGuard` coalescing | `err.reason` never appears in errorResponse.body | `guard.test.ts` |
| Schema push additive | returns `{ status: 'accepted', version }` | `schema.test.ts` |
| Schema push destructive | returns `{ status: 'pending_approval' }`, does NOT throw | `schema.test.ts` |
| Schema push namespace violation | throws PylonSdkError(code: 'namespace_violation') incl. inherits check | `schema.test.ts` |

Target: **≥ 90% branch coverage** on public exports. Every test
injects `fetch` — zero real network.

### 6.2 Mocking for MCP-side tests

```ts
import { vi } from 'vitest';
import type { PylonClient } from '@pleri/pylon/verify';

export function makeMockPylonClient(overrides: Partial<PylonClient> = {}): PylonClient {
  return {
    resolve: vi.fn().mockResolvedValue(null),
    requireCapability: vi.fn(),
    missingSessionError: { status: 401, code: 'no_session', message: 'No session' },
    ...overrides,
  } as PylonClient;
}
```

### 6.3 Test vectors

Shipped in the SDK's `__fixtures__/vectors.json`:

- Known Ed25519 keypair (test-only — `exp` fixed at 0, refuse-to-use-in-prod banner).
- Sample session JWT + scoped token pair with known claims.
- Two-org JWKS for cross-org rejection tests.

Reusable by downstream MCPs for their integration tests.

---

## 7. Versioning

- SemVer. Public surface = every symbol in §2 **and** every HTTP shape in §3.
- Pre-1.0: minor bumps (0.1 → 0.2) may break; documented in `CHANGELOG.md`.
- `@pleri/pylon` and `@pleri/pylon-service` ship **in lockstep** for
  §3 shapes. The scoped-token claim format and schema-push contract
  are joint surfaces.

---

## 8. Security model

### 8.1 Production checklist

**Before shipping an MCP with `@pleri/pylon`:**

- [ ] `expectedOrgId` set to the pinned org slug. This is the **only**
      defence against DNS-poisoned first-boot discovery. Omitting it
      in production is a real vulnerability, not a hypothetical one.
- [ ] `sessionToken` (if set) sourced from a secrets manager or
      deployment-time env injection. **Never** from a user-controlled
      header or query param.
- [ ] `appToken` (if using `pylonSchemaClient`) stored in a secrets
      manager. Leak recovery = rotate via `pylon app token rotate`.
- [ ] All errors surfaced by `pylonGuard`. Custom `formatError` never
      includes `err.reason`.
- [ ] `onEvent` wired to a log pipeline that does **not** redact
      bearer values (they're never in event detail) but **does** redact
      the structured detail fields that may contain PII (e.g., `sub`).

### 8.2 Threat model highlights

- **Cross-tenant replay:** defended by `iss` + `aud` + `org` + `app`
  claim checks (all four required; any single miss is fatal).
- **Key compromise:** 5-min JWKS cache + auto-refresh on kid-miss +
  kid rotation via `pylon` admin. Acceptable window: ≤ 5 min.
  `forceRefresh` is rate-floored to 1 call per 1 s to prevent
  attacker-crafted kid-miss loops from amplifying JWKS traffic
  during an origin 5xx window.
- **Token-endpoint DoS:** singleflight mint per `(sessionToken, appId)`.
  At 10k req/s sharing one session, ≤ 1 mint per 30s window.
  `verifyScopedToken` also enforces an 8 KB token-length cap before
  parsing to defend against JSON-bomb bearers.
- **Log-scraped token replay:** `nbf` + 2s skew pad + 30s TTL.
  Even with immediate scrape, attacker has ≤ 30s window against a
  narrow audience (`aud: olam` can only call olam).
- **Evil /discover:** `expectedOrgId` check + same-origin `api_url`
  + refuse-to-follow-redirect.
- **Schema namespace escape:** §3.4 namespace enforcement on both
  capability names and archetype `inherits` edges.
- **Server-message reflection:** both the SDK (runtime + schema push)
  and the CLI use STATIC client-authored messages on error paths.
  Attacker-controlled bytes from a compromised Pylon land in
  `err.detail.serverMessage` (internal log only), never in
  `err.message` or wire response bodies. `pylonGuard` strips `err.reason`.
- **Server `diff` amplification:** `pylonSchemaClient.push` caps the
  returned diff at 1000 entries + validates `kind` ∈
  {additive,destructive}.
- **Session-source throws:** `SessionSource` function form is wrapped
  in try/catch; throws become `PylonSdkError(token_invalid)`, never
  raw exceptions escaping to the host framework.

### 8.3 JwksCache integrity (out-of-scope)

The injectable `JwksCache` interface (contract §2.1) is a trust
boundary the SDK does NOT verify cryptographically. A JwksCache
implementation (typically Workers KV-backed for cross-isolate
sharing) is the operator's responsibility to protect. If an
attacker can write to the cache, they can mint arbitrary scoped
tokens under their own signing key. Mitigation lives in the cache
layer (restrict write access, or implement integrity-checked entries).
The in-memory default (no injection) is not exposed to external
writes and is the safe choice unless cross-isolate sharing is
required.

---

## 9. Non-goals

- Not an admin tool. Use `@pleri/pylon-cli` for `pylon app register`,
  `pylon role grant`, `pylon schema approve`.
- Not a user-auth client. CLI owns the device-code flow and keyring.
- Not a transport library. Bring your own (stdio, SSE, HTTP).
- No cross-org federation in v0.1. `expectedOrgId` is a single id.

---

## 10. Open items before v0.1.0 ships

- [ ] `@pleri/pylon-service`: `POST /apps/:id/schema*` routes + KV storage + diff classifier (step 3c).
- [ ] `@pleri/pylon-service`: `POST /apps/:id/token/rotate` (stretch for v0.1.0; otherwise v0.1.1).
- [ ] `@pleri/pylon-service`: scoped-token mint adds `iss`, `aud`, `nbf` claims.
- [ ] `@pleri/pylon-cli`: `pylon schema push / diff / current / approve` commands.
- [ ] `@pleri/pylon`: full TDD build (§6 test plan).
- [ ] `__fixtures__/vectors.json` generation script.
- [ ] CI bundle-size budget gate (`@pleri/pylon/verify` ≤ 8 KB gz).
- [ ] End-to-end integration test: admin register → MCP push (additive) → accepted; admin register → MCP push (destructive) → pending → admin approves.

Tracked in the original feature plan; the public outcome is documented
across §1–§10 above.

---

## 11. Changelog

- **v0.1.0 (unreleased, 2026-04-23)** — First public release.
  Contract revised after parallel security / performance / simplicity
  audits: added `iss` + `aud` + `nbf` claims; cut low-level primitives
  from public surface; collapsed `SessionSource` to `sessionToken`;
  collapsed error hierarchy to one class; split `pushSchema` to
  `pylonSchemaClient`; added subpath exports; added singleflight +
  stale-while-revalidate + backoff guarantees; mandated `expectedOrgId`
  for production; added namespace enforcement to archetype `inherits`.
