/**
 * Reference-fixture round-trip — A4 verification + A5 phase-A close.
 *
 * Pins the committed `reference.prepared.json` to byte-identity with
 * the live pipeline. Any change to canonicalJson, normalize, or
 * marker that disturbs canonical output will fail this test before
 * downstream consumers (Phase B `prepare`, Phase C push) silently
 * drift.
 *
 * To regenerate the fixture see
 * `src/schema/__fixtures__/README.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../canonical-json.js';
import { attachMarker, verifyMarker } from '../marker.js';
import { parseSource, prefixAndSort, validateBare } from '../normalize.js';

const ENV = 'PYLON_CLI_VERSION_OVERRIDE';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', '__fixtures__');
const bareYamlPath = resolve(fixturesDir, 'reference.bare.yaml');
const preparedJsonPath = resolve(fixturesDir, 'reference.prepared.json');

let prevOverride: string | undefined;

beforeEach(() => {
  prevOverride = process.env[ENV];
  process.env[ENV] = '0.0.0-test';
});

afterEach(() => {
  if (prevOverride === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = prevOverride;
  }
});

describe('fixtures: reference.bare.yaml → reference.prepared.json', () => {
  it('full pipeline produces byte-identical output to the committed prepared.json', () => {
    const rawBare = readFileSync(bareYamlPath, 'utf8');
    const expected = readFileSync(preparedJsonPath, 'utf8');

    const parsed = parseSource(rawBare, bareYamlPath);
    const bare = validateBare(parsed, 'example');
    const prefixed = prefixAndSort(bare, 'example');
    const prepared = attachMarker(prefixed, rawBare);
    const actual = canonicalJson(prepared);

    expect(actual).toBe(expected);
    expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
  });

  it('bare YAML on disk has the exact source bytes pinned in the prepared marker (catches CRLF drift)', () => {
    // adv-001: a Windows clone with core.autocrlf=true silently rewrites
    // LF→CRLF on checkout. Without this assertion, the byte-identity test
    // above would still pass on Windows (the pipeline regenerates the
    // fixture from the CRLF source), but cross-platform consumers would
    // see source_sha256 differ between Linux CI and Windows dev. .gitattributes
    // pins LF; this test fails LOUD if .gitattributes ever stops working.
    const rawBare = readFileSync(bareYamlPath, 'utf8');
    const sourceSha = createHash('sha256').update(rawBare, 'utf8').digest('hex');
    expect(sourceSha).toBe(
      '81a6125cd6a0945586ee09d2fbc286e08dce3272879e7d797f959a7718e56498',
    );
    expect(rawBare).not.toContain('\r');
  });

  it('committed prepared.json is independently verifiable from disk', () => {
    // Load the on-disk artifact and run verifyMarker without re-running
    // the pipeline. Pins the contract that any operator checking out
    // this branch can `cat reference.prepared.json | verifyMarker` and
    // get ok — independently of whether canonicalJson behaves the same
    // on their machine.
    const expected = readFileSync(preparedJsonPath, 'utf8');
    const reparsed = JSON.parse(expected) as unknown;
    expect(verifyMarker(reparsed)).toEqual({ ok: true });
  });

  it('prepared.json ends with a single trailing newline', () => {
    const expected = readFileSync(preparedJsonPath, 'utf8');
    expect(expected.endsWith('\n')).toBe(true);
    expect(expected.endsWith('\n\n')).toBe(false);
  });

  it('prepared.json contains LF only (no CR characters)', () => {
    const expected = readFileSync(preparedJsonPath, 'utf8');
    expect(expected).not.toContain('\r');
  });

  it('regenerating the fixture twice in a row is byte-identical (determinism)', () => {
    const rawBare = readFileSync(bareYamlPath, 'utf8');
    const run = (): string => {
      const parsed = parseSource(rawBare, bareYamlPath);
      const bare = validateBare(parsed, 'example');
      const prefixed = prefixAndSort(bare, 'example');
      const prepared = attachMarker(prefixed, rawBare);
      return canonicalJson(prepared);
    };
    expect(run()).toBe(run());
  });

  // A5 — Phase A end-to-end smoke. Ties together A1 (canonical-json),
  // A2 (normalize), A3 (marker), A4 (fixtures) through the public API
  // in the exact shape Phase B's `pylon schema prepare` and Phase C's
  // `pylon schema push` will use.
  it('phase A E2E: bare YAML → wire JSON → verified marker → tamper detection', () => {
    const rawBare = readFileSync(bareYamlPath, 'utf8');

    // Forward path (what `pylon schema prepare` will do).
    const parsed = parseSource(rawBare, bareYamlPath);
    const bare = validateBare(parsed, 'example');
    const prefixed = prefixAndSort(bare, 'example');
    const prepared = attachMarker(prefixed, rawBare);
    const wire = canonicalJson(prepared);

    // Wire format is human-readable JSON with deterministic shape.
    expect(wire).toContain('"_prepared":');
    expect(wire.endsWith('\n')).toBe(true);

    // Reverse path (what `pylon schema push` consumer will do).
    const reparsed = JSON.parse(wire) as unknown;
    expect(verifyMarker(reparsed)).toEqual({ ok: true });

    // Tamper detection (someone hand-edited the prepared file).
    const tamperedVersion = wire.replace('"0.1.0"', '"0.2.0"');
    expect(verifyMarker(JSON.parse(tamperedVersion) as unknown)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });

    // Tamper EVERY occurrence of the cap name (it appears 3× in the
    // wire — once in capabilities[], plus once each in user's and
    // viewer's archetype.capabilities[]). Using replace() instead of
    // replaceAll() would only mutate the first occurrence and let the
    // later positions stay un-protected if a future canonicalization
    // refactor changed array order (audit adv-004).
    const tamperedCap = wire.replaceAll(
      '"example:world.read"',
      '"example:world.god-mode"',
    );
    expect(tamperedCap).not.toContain('"example:world.read"');
    expect(verifyMarker(JSON.parse(tamperedCap) as unknown)).toEqual({
      ok: false,
      code: 'marker_tampered',
    });
  });

  it('wire-round-trip is idempotent: canonicalJson(JSON.parse(wire)) === wire', () => {
    // Phase C's `pylon schema push` will read the prepared file from
    // disk, JSON.parse it, and possibly re-canonicalize it for
    // transmission. If canonicalize is not idempotent on its own
    // canonical output, prepare's content_sha256 wouldn't survive the
    // wire round trip — the marker integrity contract collapses
    // (audit adv-005). Pin the property here so any future change
    // that breaks idempotence fails loud.
    const wire = readFileSync(preparedJsonPath, 'utf8');
    const reparsed = JSON.parse(wire) as unknown;
    expect(canonicalJson(reparsed)).toBe(wire);
  });
});
