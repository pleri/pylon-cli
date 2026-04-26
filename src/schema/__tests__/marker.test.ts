/**
 * Marker emission + verification tests.
 *
 * Anchors the load-bearing contract A3 establishes for B1–B4 + Phase C:
 *
 *   1. `cli_version` is informational provenance — never an integrity
 *      or auth signal. `content_sha256` + the app token are the only
 *      integrity / auth boundaries.
 *   2. `PYLON_CLI_VERSION_OVERRIDE` is EMISSION-ONLY. `verifyMarker`
 *      never consults the env or `resolveCliVersion`. Verifying a
 *      marker on a different machine, with a different CLI version,
 *      with the override unset / set / set-to-something-else, yields
 *      the same result.
 *   3. Empty-string override is treated as unset (defensive: a CI
 *      that exports `PYLON_CLI_VERSION_OVERRIDE=""` should fall
 *      through to package.json, not produce a marker with an empty
 *      cli_version).
 *
 * If a future change makes verifyMarker consult resolveCliVersion or
 * env vars, the "verify is platform-independent" tests below will
 * fail. That is the trip wire.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.js';
import {
  attachMarker,
  resolveCliVersion,
  verifyMarker,
  type PreparedSchema,
  type VerifyResult,
} from '../marker.js';
import type { SchemaDeclaration } from '../normalize.js';

const ENV = 'PYLON_CLI_VERSION_OVERRIDE';

const sampleBody: SchemaDeclaration = {
  version_tag: '0.1.0',
  capabilities: [{ name: 'app:cap.a', description: 'first' }],
  archetypes: [
    { name: 'app:user', capabilities: ['app:cap.a'] },
  ],
};

let prevOverride: string | undefined;

beforeEach(() => {
  prevOverride = process.env[ENV];
  delete process.env[ENV];
});

afterEach(() => {
  if (prevOverride === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = prevOverride;
  }
});

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('resolveCliVersion', () => {
  it('honors PYLON_CLI_VERSION_OVERRIDE when set non-empty', () => {
    process.env[ENV] = '0.0.0-test';
    expect(resolveCliVersion()).toBe('0.0.0-test');
  });

  it('treats empty-string override as unset (falls through to package.json)', () => {
    process.env[ENV] = '';
    const v = resolveCliVersion();
    expect(v).not.toBe('');
    expect(v.length).toBeGreaterThan(0);
    // The actual value is the CLI's own package.json version (0.1.2 today,
    // 0.3.0 after Phase C9). Don't pin it — that would invert T2.
  });

  it('reads package.json when no override is set', () => {
    const v = resolveCliVersion();
    // Must look like a semver-ish string. Don't pin a specific value.
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('attachMarker', () => {
  beforeEach(() => {
    process.env[ENV] = '0.0.0-test';
  });

  it('attaches a marker with all three required fields', () => {
    const out = attachMarker(sampleBody, 'raw-yaml-source');
    expect(out._prepared.cli_version).toBe('0.0.0-test');
    expect(out._prepared.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out._prepared.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('source_sha256 equals sha256(sourceRaw)', () => {
    const source = 'version_tag: "0.1.0"\n';
    const out = attachMarker(sampleBody, source);
    expect(out._prepared.source_sha256).toBe(sha256Hex(source));
  });

  it('content_sha256 equals sha256(canonicalJson(body without marker))', () => {
    const out = attachMarker(sampleBody, 'src');
    expect(out._prepared.content_sha256).toBe(
      sha256Hex(canonicalJson(sampleBody)),
    );
  });

  it('preserves the body verbatim alongside the marker', () => {
    const out = attachMarker(sampleBody, 'src');
    expect(out.version_tag).toBe(sampleBody.version_tag);
    expect(out.capabilities).toEqual(sampleBody.capabilities);
    expect(out.archetypes).toEqual(sampleBody.archetypes);
  });

  it('refuses to re-mark a body that already carries _prepared', () => {
    const once = attachMarker(sampleBody, 'src');
    expect(() => attachMarker(once as unknown as SchemaDeclaration, 'src')).toThrow(
      /already carries a `_prepared` marker/,
    );
  });
});

describe('verifyMarker', () => {
  beforeEach(() => {
    process.env[ENV] = '0.0.0-test';
  });

  it('returns ok on a freshly-attached marker', () => {
    const out = attachMarker(sampleBody, 'src');
    expect(verifyMarker(out)).toEqual({ ok: true } satisfies VerifyResult);
  });

  it('returns unprepared_input on null / array / non-object', () => {
    expect(verifyMarker(null)).toEqual({ ok: false, code: 'unprepared_input' });
    expect(verifyMarker(undefined)).toEqual({ ok: false, code: 'unprepared_input' });
    expect(verifyMarker([])).toEqual({ ok: false, code: 'unprepared_input' });
    expect(verifyMarker('string')).toEqual({ ok: false, code: 'unprepared_input' });
    expect(verifyMarker(42)).toEqual({ ok: false, code: 'unprepared_input' });
  });

  it('returns unprepared_input on missing _prepared', () => {
    expect(verifyMarker({ ...sampleBody })).toEqual({
      ok: false,
      code: 'unprepared_input',
    });
  });

  it('returns unprepared_input when _prepared is not an object', () => {
    expect(verifyMarker({ ...sampleBody, _prepared: 'string' })).toEqual({
      ok: false,
      code: 'unprepared_input',
    });
    expect(verifyMarker({ ...sampleBody, _prepared: [] })).toEqual({
      ok: false,
      code: 'unprepared_input',
    });
    expect(verifyMarker({ ...sampleBody, _prepared: null })).toEqual({
      ok: false,
      code: 'unprepared_input',
    });
  });

  it('returns unprepared_input on missing or wrongly-typed marker fields', () => {
    const baseMarker = {
      cli_version: '0.0.0-test',
      source_sha256: 'a'.repeat(64),
      content_sha256: 'b'.repeat(64),
    };
    // each-field-required matrix
    for (const missing of ['cli_version', 'source_sha256', 'content_sha256'] as const) {
      const m = { ...baseMarker } as Record<string, unknown>;
      delete m[missing];
      expect(verifyMarker({ ...sampleBody, _prepared: m })).toEqual({
        ok: false,
        code: 'unprepared_input',
      });
    }
    // wrong-type matrix
    for (const field of ['cli_version', 'source_sha256', 'content_sha256'] as const) {
      const m = { ...baseMarker, [field]: 42 };
      expect(verifyMarker({ ...sampleBody, _prepared: m })).toEqual({
        ok: false,
        code: 'unprepared_input',
      });
    }
  });

  it('returns marker_tampered on body modification with valid marker shape', () => {
    const out = attachMarker(sampleBody, 'src') as PreparedSchema & {
      version_tag: string;
    };
    const tampered = { ...out, version_tag: '0.2.0' };
    expect(verifyMarker(tampered)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });
  });

  it('returns marker_tampered when content_sha256 is mutated', () => {
    const out = attachMarker(sampleBody, 'src');
    const tampered = {
      ...out,
      _prepared: { ...out._prepared, content_sha256: 'c'.repeat(64) },
    };
    expect(verifyMarker(tampered)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });
  });

  it('does NOT validate cli_version against the current CLI — informational only', () => {
    process.env[ENV] = '0.0.0-test';
    const out = attachMarker(sampleBody, 'src');
    // Mutate cli_version after attach; verifyMarker should still pass
    // because cli_version is provenance metadata, not integrity.
    const altered = {
      ...out,
      _prepared: { ...out._prepared, cli_version: '99.99.99-from-future' },
    };
    expect(verifyMarker(altered)).toEqual({ ok: true });
  });
});

describe('contract: override is EMISSION-ONLY', () => {
  it('verifyMarker is platform-independent — verifies regardless of env', () => {
    // Attach with one override
    process.env[ENV] = '0.0.0-test';
    const out = attachMarker(sampleBody, 'src');

    // Verify with override unset
    delete process.env[ENV];
    expect(verifyMarker(out)).toEqual({ ok: true });

    // Verify with a completely different override
    process.env[ENV] = '99.0.0-something-else';
    expect(verifyMarker(out)).toEqual({ ok: true });

    // Verify with empty-string override
    process.env[ENV] = '';
    expect(verifyMarker(out)).toEqual({ ok: true });
  });

  it('attachMarker IS affected by the override (emission semantics)', () => {
    process.env[ENV] = '0.0.0-test';
    const a = attachMarker(sampleBody, 'src');
    process.env[ENV] = '1.2.3-other';
    const b = attachMarker(sampleBody, 'src');
    expect(a._prepared.cli_version).toBe('0.0.0-test');
    expect(b._prepared.cli_version).toBe('1.2.3-other');
    // content_sha256 is identical because body is identical;
    // source_sha256 is identical because source is identical.
    expect(a._prepared.content_sha256).toBe(b._prepared.content_sha256);
    expect(a._prepared.source_sha256).toBe(b._prepared.source_sha256);
  });
});

describe('determinism: marker emission is reproducible per (source, override)', () => {
  it('same body + same source + same override → byte-identical PreparedSchema', () => {
    process.env[ENV] = '0.0.0-test';
    const a = canonicalJson(attachMarker(sampleBody, 'src'));
    const b = canonicalJson(attachMarker(sampleBody, 'src'));
    expect(a).toBe(b);
  });
});

describe('round-trip integrity (post-A3-audit hardening)', () => {
  beforeEach(() => {
    process.env[ENV] = '0.0.0-test';
  });

  it('verifyMarker accepts JSON.parse(canonicalJson(attach(...))) — wire-format round trip', () => {
    const out = attachMarker(sampleBody, 'src');
    const wire = canonicalJson(out);
    const reparsed = JSON.parse(wire) as unknown;
    expect(verifyMarker(reparsed)).toEqual({ ok: true });
  });

  it('returns marker_tampered on a wire payload with literal `__proto__` injected at top level', () => {
    const out = attachMarker(sampleBody, 'src');
    const wire = canonicalJson(out);
    const tampered = wire.replace(
      '{\n  "_prepared":',
      '{\n  "__proto__": {"polluted": true},\n  "_prepared":',
    );
    const reparsed = JSON.parse(tampered) as unknown;
    expect(verifyMarker(reparsed)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });
  });

  it('returns marker_tampered on a wire payload with `__proto__` injected inside the body', () => {
    const out = attachMarker(sampleBody, 'src');
    const wire = canonicalJson(out);
    const tampered = wire.replace(
      '"capabilities":',
      '"__proto__": {"polluted": true},\n  "capabilities":',
    );
    const reparsed = JSON.parse(tampered) as unknown;
    expect(verifyMarker(reparsed)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });
  });

  it('returns marker_tampered when canonicalJson rejects the recompute (e.g. non-finite number injected)', () => {
    // Build a payload that a hand-authored attacker could not produce via
    // JSON (NaN isn't JSON-representable), but which an in-memory mutation
    // could pass to verifyMarker. canonicalJson's own guards catch this;
    // verifyMarker translates the throw to marker_tampered, not a panic.
    const out = attachMarker(sampleBody, 'src') as unknown as Record<string, unknown>;
    const tampered = { ...out, version_tag: Number.NaN };
    expect(verifyMarker(tampered)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });
  });
});
