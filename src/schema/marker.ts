/**
 * `_prepared` marker — provenance + accident-prevention tripwire for
 * the canonical schema artifact.
 *
 * Shape (per design doc + plan pass 2):
 *
 *   {
 *     cli_version:    string,   // semver from packages/cli/package.json
 *     source_sha256:  string,   // sha256 of the raw source file bytes
 *     content_sha256: string,   // sha256 of canonicalJson(body without _prepared)
 *   }
 *
 * `prepared_at` is intentionally absent — including a wall-clock would
 * defeat the byte-identical-output determinism guarantee. Provenance
 * survives via git history + the source hash.
 *
 * The marker is NOT cryptographic auth. App tokens remain the only
 * auth boundary on push. content_sha256 is a structural tripwire that
 * catches accidental hand-edits between `prepare` and `push`; it does
 * not defend against an attacker who can re-run `prepare`.
 *
 * `resolveCliVersion` honors `PYLON_CLI_VERSION_OVERRIDE` so test
 * fixtures can pin to `0.0.0-test` and not regenerate on every CLI
 * release (design doc T2).
 *
 * Override scope is EMISSION-ONLY by design:
 *   • `attachMarker` calls `resolveCliVersion` and the override flows
 *     into the emitted marker.
 *   • `verifyMarker` does NOT call `resolveCliVersion` and does NOT
 *     read `PYLON_CLI_VERSION_OVERRIDE`. Verification is platform-
 *     independent — it depends only on the marker's structural shape
 *     and `content_sha256` matching the body.
 *   • Future "reject pushes from unknown CLI versions" gating is a
 *     SERVER concern (audit log filtering, push acceptance policy)
 *     and must NOT couple back into client-side `verifyMarker`.
 *
 * If someone adds env-coupling to `verifyMarker`, the
 * "verifyMarker is platform-independent" tests fail — that's the
 * tripwire.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical-json.js';
import type { SchemaDeclaration } from './normalize.js';

export interface PreparedMarker {
  readonly cli_version: string;
  readonly source_sha256: string;
  readonly content_sha256: string;
}

export interface PreparedSchema extends SchemaDeclaration {
  readonly _prepared: PreparedMarker;
}

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'unprepared_input' | 'marker_tampered' };

const VERSION_OVERRIDE_ENV = 'PYLON_CLI_VERSION_OVERRIDE';

/**
 * Read the CLI's own package.json `version` field at runtime.
 *
 * Path resolution works against both the source layout (vitest /
 * tsx loads from `src/schema/marker.ts`) and the published layout
 * (Node loads from `dist/schema/marker.js`) — both sit two
 * directories below `package.json`.
 */
export function resolveCliVersion(): string {
  const override = process.env[VERSION_OVERRIDE_ENV];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const here = fileURLToPath(import.meta.url);
  const pkgPath = resolve(dirname(here), '..', '..', 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `resolveCliVersion: cannot read ${pkgPath}: ${reason}; set ${VERSION_OVERRIDE_ENV} to bypass`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const version = parsed['version'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      `resolveCliVersion: ${pkgPath} has no usable "version" field`,
    );
  }
  return version;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Wrap a canonical body with a `_prepared` marker. Refuses input that
 * already carries a marker — double-marking is always a bug at the
 * call site (re-running `prepare` should re-derive from source, not
 * decorate a prepared file).
 */
export function attachMarker(
  body: SchemaDeclaration,
  sourceRaw: string,
): PreparedSchema {
  if ('_prepared' in (body as unknown as Record<string, unknown>)) {
    throw new Error(
      'attachMarker: input already carries a `_prepared` marker; refusing to re-mark',
    );
  }
  const marker: PreparedMarker = {
    cli_version: resolveCliVersion(),
    source_sha256: sha256Hex(sourceRaw),
    content_sha256: sha256Hex(canonicalJson(body)),
  };
  return { ...body, _prepared: marker };
}

/**
 * Validate a parsed object's marker. Returns:
 *   - `{ ok: true }` if `_prepared` is structurally well-formed AND
 *     `content_sha256` matches the recomputed hash over the body
 *     (i.e. everything except `_prepared`).
 *   - `{ ok: false, code: 'unprepared_input' }` if no marker, or
 *     marker missing required fields, or input not an object.
 *   - `{ ok: false, code: 'marker_tampered' }` if the marker is
 *     well-shaped but the body's hash no longer matches.
 *
 * `cli_version` and `source_sha256` are NOT validated here — they
 * are informational provenance, not integrity guarantees.
 */
export function verifyMarker(parsed: unknown): VerifyResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'unprepared_input' };
  }
  const obj = parsed as Record<string, unknown>;
  const marker = obj['_prepared'];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return { ok: false, code: 'unprepared_input' };
  }
  const m = marker as Record<string, unknown>;
  if (
    typeof m['cli_version'] !== 'string' ||
    typeof m['source_sha256'] !== 'string' ||
    typeof m['content_sha256'] !== 'string'
  ) {
    return { ok: false, code: 'unprepared_input' };
  }
  // Strip _prepared by entry filter — non-mutating, avoids unused-binding lint.
  const rest = Object.fromEntries(
    Object.entries(obj).filter(([k]) => k !== '_prepared'),
  );
  // canonicalJson throws on undeterministic input (NFC collision,
  // `__proto__` key, non-plain-prototype object, undefined / bigint /
  // function / symbol / non-finite number). Any of those means the
  // wire payload was hand-edited or otherwise corrupted away from
  // what attachMarker would have emitted — semantically identical to
  // a content_sha256 mismatch, return marker_tampered rather than
  // letting the exception escape (keeps verifyMarker's three-state
  // return contract).
  let recomputed: string;
  try {
    recomputed = sha256Hex(canonicalJson(rest));
  } catch {
    return { ok: false, code: 'marker_tampered' };
  }
  if (recomputed !== m['content_sha256']) {
    return { ok: false, code: 'marker_tampered' };
  }
  return { ok: true };
}
