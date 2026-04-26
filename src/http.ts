/**
 * Pylon HTTP client for the CLI.
 *
 * Every call is plain `fetch` with JSON bodies. Errors become
 * `PylonHttpError` with the status code and the server-provided
 * error message when available.
 *
 * The `fetchImpl` indirection lets tests inject a stub without
 * mocking global fetch.
 */

import { PylonHttpError, DiscoveryError } from './errors.js';
import { requireSameOrigin, requireSecureUrl } from './url-safety.js';

export type FetchImpl = typeof fetch;

let fetchImpl: FetchImpl = globalThis.fetch;

/** Swap the fetch implementation — used by tests. */
export function setFetchImpl(impl: FetchImpl): void {
  fetchImpl = impl;
}

export function resetFetchImpl(): void {
  fetchImpl = globalThis.fetch;
}

export interface DiscoverResponse {
  readonly id: string;
  readonly name: string;
  readonly api_url: string;
}

export interface DeviceInitResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_url: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface DevicePollResponse {
  readonly status: 'pending' | 'authorised' | 'expired';
  readonly session_jwt?: string;
}

export interface WhoamiResponse {
  readonly email: string;
  readonly org_id: string;
  readonly archetype: string;
  readonly session_expires_at: number;
}

export interface TokenResponse {
  readonly scoped_token: string;
  readonly ttl: number;
}

export interface AppRegisterResponse {
  readonly app_id: string;
  readonly app_token: string;
}

export interface RoleGrantResponse {
  readonly email_hash: string;
  readonly app_id: string;
  readonly archetype: string;
}

/**
 * Strip ANSI escape codes + control characters + truncate. A
 * compromised or spoofed Pylon can embed `\x1b[2J` (clear-screen),
 * CRLF, or control-char payloads in `error.message`; bin.ts prints
 * that via console.log unescaped, which renders on the operator's
 * terminal or in CI logs and can fake command output (Phase 5 audit
 * SEC-M2; same class as SDK Phase 3 SEC-M2 orgMismatch fix).
 */
export function sanitizeServerMessage(s: string, maxLen = 512): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f]/g, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + '...' : stripped;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  // A gateway (Cloudflare Access, generic SSO proxy, corporate VPN
  // interceptor) sitting in front of Pylon can answer with an HTML
  // login page and either a 200 or a 3xx. Without `redirect:
  // 'manual'` on the fetch call, the client follows the 302 to the
  // identity provider and we'd end up JSON-parsing `<!DOCTYPE`,
  // producing the cryptic "Unexpected token '<'" error. With manual
  // redirects we see the 3xx directly and can give an actionable
  // message. All JSON endpoints below pass `redirect: 'manual'`.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    const location = res.headers.get('location') ?? '(no Location header)';
    throw new PylonHttpError(
      `gateway intercept: endpoint redirected (HTTP ${res.status} → ${sanitizeServerMessage(location, 256)}). ` +
        `A Cloudflare Access / SSO proxy is protecting a Pylon endpoint that should be public ` +
        `(e.g. /device/init, /device/poll). Fix the CF Access policy to bypass these paths.`,
      res.status,
    );
  }
  if (res.ok) {
    try {
      return (await res.json()) as T;
    } catch (err) {
      // Body wasn't JSON despite a 2xx — almost always means a
      // gateway handed us an HTML login page with 200 instead of
      // 3xx. Give the same actionable error.
      const reason = err instanceof Error ? err.message : String(err);
      throw new PylonHttpError(
        `non-JSON response from Pylon (${sanitizeServerMessage(reason, 128)}). ` +
          `A gateway may be returning an HTML page instead of forwarding to Pylon — ` +
          `check that your Cloudflare Access / SSO policy bypasses this endpoint.`,
        res.status,
      );
    }
  }
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    // non-json body; keep statusText
  }
  throw new PylonHttpError(sanitizeServerMessage(message), res.status);
}

function normaliseBaseUrl(url: string): string {
  const prefixed = url.includes('://') ? url : `https://${url}`;
  // Explicit URL parse rejects malformed inputs up-front (empty
  // host, embedded path traversal like `pylon.acme/../other`,
  // userinfo, etc.). `requireSecureUrl` enforces HTTPS-or-loopback.
  let parsed: URL;
  try {
    parsed = new URL(prefixed);
  } catch {
    throw new Error(`Malformed URL: "${url}"`);
  }
  if (!parsed.host || parsed.username || parsed.password) {
    throw new Error(`Invalid URL: "${url}" (host missing or userinfo present)`);
  }
  // Reconstruct from origin only — strips paths, queries,
  // fragments, and anything else that doesn't belong in a base URL.
  const base = `${parsed.protocol}//${parsed.host}`;
  requireSecureUrl(base);
  return base;
}

const ORG_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate the shape of a `/discover` response. Any response we
 * can't fully trust is rejected — the caller decides whether to
 * fall back or fail. This is the function between "network
 * returned 200" and "CLI persists this to config".
 */
function validateDiscoverResponse(raw: unknown, reachedUrl: string): DiscoverResponse {
  if (!raw || typeof raw !== 'object') {
    throw new DiscoveryError(reachedUrl, 'response body is not an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !ORG_ID_RE.test(r['id'])) {
    throw new DiscoveryError(
      reachedUrl,
      'invalid or missing `id` (expected lowercase slug, 1-64 chars)',
    );
  }
  if (typeof r['name'] !== 'string' || r['name'].length === 0) {
    throw new DiscoveryError(reachedUrl, 'invalid or missing `name`');
  }
  if (typeof r['api_url'] !== 'string') {
    throw new DiscoveryError(reachedUrl, 'invalid or missing `api_url`');
  }
  // The server cannot point us elsewhere. This is the single most
  // important check in the whole CLI — without it, a compromised
  // discover endpoint redirects the session JWT to attacker infra.
  requireSameOrigin(reachedUrl, r['api_url'], 'discover.api_url');
  return {
    id: r['id'],
    name: r['name'],
    api_url: r['api_url'],
  };
}

/**
 * Resolve an org's identity from a URL. Used both for initial
 * login (`--org-url=...`) and for SDK tenant resolution.
 */
export async function discover(orgUrl: string): Promise<DiscoverResponse> {
  const base = normaliseBaseUrl(orgUrl);
  let res: Response;
  try {
    // `redirect: 'manual'` so a cross-origin 3xx doesn't silently
    // move us to attacker-controlled infra; the same-origin check
    // on the response body wouldn't catch that because it compares
    // against our caller-supplied base, not `res.url`.
    res = await fetchImpl(`${base}/discover`, { method: 'GET', redirect: 'manual' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DiscoveryError(base, reason);
  }
  // `type === 'opaqueredirect'` in browsers, status 0 or 30x in
  // Node's undici with manual. Either way we refuse — a legitimate
  // Pylon doesn't redirect /discover.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new DiscoveryError(base, `refusing to follow redirect from /discover (status ${res.status})`);
  }
  if (!res.ok) {
    throw new DiscoveryError(base, `HTTP ${res.status}`);
  }
  const raw = await res.json();
  return validateDiscoverResponse(raw, base);
}

export async function deviceInit(
  apiUrl: string,
  args: { client: string; org_id?: string } = { client: 'pylon-cli' },
): Promise<DeviceInitResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/device/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    redirect: 'manual',
  });
  return jsonOrThrow<DeviceInitResponse>(res);
}

export async function devicePoll(
  apiUrl: string,
  deviceCode: string,
): Promise<DevicePollResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/device/poll?device_code=${encodeURIComponent(deviceCode)}`, {
    method: 'GET',
    redirect: 'manual',
  });
  return jsonOrThrow<DevicePollResponse>(res);
}

export async function whoami(
  apiUrl: string,
  sessionJwt: string,
): Promise<WhoamiResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/whoami`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionJwt}` },
    redirect: 'manual',
  });
  return jsonOrThrow<WhoamiResponse>(res);
}

export async function appRegister(
  apiUrl: string,
  sessionJwt: string,
  args: { name: string; owner: string; description?: string },
): Promise<AppRegisterResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/apps`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionJwt}`,
    },
    body: JSON.stringify(args),
    redirect: 'manual',
  });
  return jsonOrThrow<AppRegisterResponse>(res);
}

export async function roleGrant(
  apiUrl: string,
  sessionJwt: string,
  args: {
    email: string;
    app_id: string;
    archetype: string;
    capabilities?: readonly string[];
  },
): Promise<RoleGrantResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/roles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionJwt}`,
    },
    body: JSON.stringify(args),
    redirect: 'manual',
  });
  return jsonOrThrow<RoleGrantResponse>(res);
}

// ── Listings + delete + audit ─────────────────────────────────────

export interface RoleListItem {
  readonly email_hash: string;
  readonly app_id: string;
  readonly archetype: string;
  readonly capabilities?: readonly string[];
  readonly granted_at?: number;
  readonly granted_by?: string;
}

export async function roleList(
  apiUrl: string,
  sessionJwt: string,
  appId: string,
): Promise<{ roles: readonly RoleListItem[] }> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/roles?app_id=${encodeURIComponent(appId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionJwt}` },
    redirect: 'manual',
  });
  return jsonOrThrow<{ roles: RoleListItem[] }>(res);
}

export async function roleRevoke(
  apiUrl: string,
  sessionJwt: string,
  appId: string,
  emailHash: string,
): Promise<{ app_id: string; email_hash: string; revoked: boolean }> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(
    `${base}/roles/${encodeURIComponent(appId)}/${encodeURIComponent(emailHash)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionJwt}` },
      redirect: 'manual',
    },
  );
  return jsonOrThrow<{ app_id: string; email_hash: string; revoked: boolean }>(res);
}

export interface AppListItem {
  readonly app_id: string;
  readonly name: string;
  readonly owner: string;
  readonly description?: string;
  readonly status: 'active' | 'disabled';
  readonly created_at: number;
}

export async function appList(
  apiUrl: string,
  sessionJwt: string,
): Promise<{ apps: readonly AppListItem[] }> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/apps`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionJwt}` },
    redirect: 'manual',
  });
  return jsonOrThrow<{ apps: AppListItem[] }>(res);
}

export async function appDisable(
  apiUrl: string,
  sessionJwt: string,
  appId: string,
): Promise<{ app_id: string; status: string }> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/apps/${encodeURIComponent(appId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${sessionJwt}` },
    redirect: 'manual',
  });
  return jsonOrThrow<{ app_id: string; status: string }>(res);
}

export interface AuditEntry {
  readonly ts: number;
  readonly action: string;
  readonly actor: string;
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
  readonly org: string;
}

export async function auditQuery(
  apiUrl: string,
  sessionJwt: string,
  args: {
    since?: number;
    limit?: number;
    action?: string;
    cursor?: string;
  } = {},
): Promise<{ entries: readonly AuditEntry[]; next_cursor?: string }> {
  const base = normaliseBaseUrl(apiUrl);
  const qs = new URLSearchParams();
  if (args.since !== undefined) qs.set('since', String(args.since));
  if (args.limit !== undefined) qs.set('limit', String(args.limit));
  if (args.action) qs.set('action', args.action);
  if (args.cursor) qs.set('cursor', args.cursor);
  const query = qs.toString();
  const res = await fetchImpl(`${base}/audit${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionJwt}` },
    redirect: 'manual',
  });
  return jsonOrThrow<{ entries: AuditEntry[]; next_cursor?: string }>(res);
}

// ── Schema endpoints (contract §3.4-§3.6) ─────────────────────────

export interface SchemaDiffChange {
  readonly type: string;
  readonly name?: string;
  readonly archetype?: string;
  readonly caps?: readonly string[];
  readonly inherits?: readonly string[];
}

export interface SchemaDiff {
  readonly kind: 'additive' | 'destructive';
  readonly changes: readonly SchemaDiffChange[];
}

export type SchemaPushResponse =
  | { readonly status: 'accepted'; readonly version: number }
  | {
      readonly status: 'pending_approval';
      readonly version: number;
      readonly current_version: number;
      readonly diff: SchemaDiff;
    };

export async function schemaPush(
  apiUrl: string,
  appToken: string,
  appId: string,
  body: unknown,
): Promise<SchemaPushResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/apps/${encodeURIComponent(appId)}/schema`, {
    method: 'POST',
    headers: {
      'X-Pylon-App-Token': appToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  return jsonOrThrow<SchemaPushResponse>(res);
}

export interface SchemaCurrentResponse {
  readonly version: number;
  readonly version_tag: string;
  readonly capabilities: readonly { name: string; description?: string }[];
  readonly archetypes: readonly {
    name: string;
    capabilities: readonly string[];
    inherits?: readonly string[];
    description?: string;
  }[];
  readonly pushed_by: string;
  readonly pushed_at: number;
}

export async function schemaCurrent(
  apiUrl: string,
  sessionJwt: string,
  appId: string,
): Promise<SchemaCurrentResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(
    `${base}/apps/${encodeURIComponent(appId)}/schema/current`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${sessionJwt}` },
      redirect: 'manual',
    },
  );
  return jsonOrThrow<SchemaCurrentResponse>(res);
}

export interface SchemaListItem {
  readonly version: number;
  readonly version_tag: string;
  readonly pushed_by: string;
  readonly pushed_at: number;
  /**
   * Provenance marker emitted by `pylon schema prepare`. Present
   * iff the version was pushed via a CLI 0.3.0+ that ran the
   * prepare pipeline. Absent for SDK / curl / pre-0.3.0 pushes.
   */
  readonly prepared?: {
    readonly cli_version: string;
    readonly source_sha256: string;
    readonly content_sha256: string;
  };
}

export interface SchemaListResponse {
  readonly versions: readonly SchemaListItem[];
  readonly current_version: number | null;
  readonly pending_version: number | null;
}

export async function schemaList(
  apiUrl: string,
  sessionJwt: string,
  appId: string,
): Promise<SchemaListResponse> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(`${base}/apps/${encodeURIComponent(appId)}/schema`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sessionJwt}` },
    redirect: 'manual',
  });
  return jsonOrThrow<SchemaListResponse>(res);
}

export async function schemaApprove(
  apiUrl: string,
  sessionJwt: string,
  appId: string,
  version: number,
): Promise<{ status: 'approved'; version: number; roles_migrated: number }> {
  const base = normaliseBaseUrl(apiUrl);
  const res = await fetchImpl(
    `${base}/apps/${encodeURIComponent(appId)}/schema/approve-migration`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version }),
      redirect: 'manual',
    },
  );
  return jsonOrThrow<{ status: 'approved'; version: number; roles_migrated: number }>(res);
}

export { normaliseBaseUrl };
