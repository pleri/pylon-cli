/**
 * Determinism + edge-case coverage for canonicalJson.
 *
 * Anchors design-doc T6 (canonicalJson Node-version drift). If any
 * of these tests start failing on a Node bump, the canonical-artifact
 * format is no longer deterministic — fix the implementation, not
 * the test.
 *
 * The "throws on …" tests pin canonicalJson's loud-failure contract:
 * silent coercion of unrepresentable values would defeat T6.
 */

import { describe, it, expect } from 'vitest';

import { canonicalJson } from '../canonical-json.js';

// Build NFC ("e-acute" as one code point U+00E9) vs NFD ("e" + combining
// acute U+0301) from explicit code points so neither the source file
// nor the editor can collapse the two forms before the test runs.
const CAFE_NFC = 'caf' + String.fromCodePoint(0x00e9);
const CAFE_NFD = 'cafe' + String.fromCodePoint(0x0301);

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    const input = { b: 1, a: { d: 2, c: 3 } };
    expect(canonicalJson(input)).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
    );
  });

  it('preserves array order, sorts keys inside array elements', () => {
    const input = [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ];
    expect(canonicalJson(input)).toBe(
      '[\n  {\n    "a": 2,\n    "b": 1\n  },\n  {\n    "c": 4,\n    "d": 3\n  }\n]\n',
    );
  });

  it('NFC-normalizes string values', () => {
    expect(CAFE_NFD === CAFE_NFC).toBe(false); // sanity: distinct sequences
    expect(canonicalJson({ name: CAFE_NFD })).toBe(canonicalJson({ name: CAFE_NFC }));
  });

  it('NFC-normalizes object keys', () => {
    expect(canonicalJson({ [CAFE_NFD]: 1 })).toBe(canonicalJson({ [CAFE_NFC]: 1 }));
  });

  it('throws on duplicate keys after NFC normalization (no silent overwrite)', () => {
    // Construct an object with two NFD-distinct but NFC-equivalent keys.
    // Object literal would dedupe at parse, so build via property assignment.
    const obj: Record<string, number> = {};
    obj[CAFE_NFC] = 1;
    obj[CAFE_NFD] = 2;
    expect(Object.keys(obj)).toHaveLength(2); // sanity: distinct in JS
    expect(() => canonicalJson(obj)).toThrow(/duplicate key after NFC normalization/);
  });

  it('handles primitives — null, booleans, finite numbers', () => {
    expect(canonicalJson(null)).toBe('null\n');
    expect(canonicalJson(true)).toBe('true\n');
    expect(canonicalJson(false)).toBe('false\n');
    expect(canonicalJson(0)).toBe('0\n');
    expect(canonicalJson(-0)).toBe('0\n'); // JSON.stringify drops the sign
    expect(canonicalJson(1.5)).toBe('1.5\n');
    expect(canonicalJson(1e21)).toBe('1e+21\n'); // ECMA-262 exponent form
  });

  it('throws on non-JSON-representable primitives', () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
    expect(() => canonicalJson(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(BigInt(1))).toThrow(/bigint/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/symbol/);
    expect(() => canonicalJson(() => undefined)).toThrow(/function/);
  });

  it('throws on `__proto__` keys at top level (would alias prototype setter)', () => {
    // JSON.parse produces an own enumerable `__proto__` key; this is the
    // realistic threat surface — a hand-authored / tampered prepared file.
    const obj = JSON.parse('{"__proto__":{"polluted":true},"name":"x"}') as unknown;
    expect(() => canonicalJson(obj)).toThrow(/__proto__/);
  });

  it('throws on `__proto__` keys nested inside the body', () => {
    const obj = JSON.parse('{"a":{"__proto__":{"polluted":true}}}') as unknown;
    expect(() => canonicalJson(obj)).toThrow(/__proto__/);
  });

  it('throws on `__proto__` keys nested inside an array element', () => {
    const obj = JSON.parse('{"items":[{"__proto__":1}]}') as unknown;
    expect(() => canonicalJson(obj)).toThrow(/__proto__/);
  });

  it('throws on objects with non-plain prototype (Date, Map, Set, class instance)', () => {
    expect(() => canonicalJson(new Date())).toThrow(/non-plain prototype/);
    expect(() => canonicalJson(new Map())).toThrow(/non-plain prototype/);
    expect(() => canonicalJson(new Set())).toThrow(/non-plain prototype/);
    expect(() => canonicalJson(/regex/)).toThrow(/non-plain prototype/);
    class Foo {
      x = 1;
    }
    expect(() => canonicalJson(new Foo())).toThrow(/non-plain prototype/);
  });

  it('accepts null-prototype objects (Object.create(null))', () => {
    const obj = Object.create(null) as Record<string, number>;
    obj.a = 1;
    obj.b = 2;
    expect(canonicalJson(obj)).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it('throws on nested non-JSON values', () => {
    expect(() => canonicalJson({ a: { b: NaN } })).toThrow(/non-finite/);
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined/);
    expect(() => canonicalJson({ a: [{ b: new Date() }] })).toThrow(/non-plain prototype/);
  });

  it('handles empty object and empty array', () => {
    expect(canonicalJson({})).toBe('{}\n');
    expect(canonicalJson([])).toBe('[]\n');
  });

  it('uses 2-space indent and LF line endings only', () => {
    const out = canonicalJson({ a: 1 });
    expect(out).toBe('{\n  "a": 1\n}\n');
    expect(out).not.toContain('\r');
  });

  it('always ends with a single trailing newline', () => {
    expect(canonicalJson({})).toMatch(/\n$/);
    expect(canonicalJson({})).not.toMatch(/\n\n$/);
    expect(canonicalJson({ a: 1 })).toMatch(/\n$/);
    expect(canonicalJson({ a: 1 })).not.toMatch(/\n\n$/);
  });

  it('determinism: stringify → parse → stringify is byte-identical', () => {
    const input = {
      version_tag: '0.1.0',
      capabilities: [
        { name: 'app:cap.b', description: 'second' },
        { name: 'app:cap.a' },
      ],
      archetypes: [
        { name: 'app:user', capabilities: ['app:cap.a'], inherits: [] },
      ],
    };
    const first = canonicalJson(input);
    const second = canonicalJson(JSON.parse(first));
    expect(first).toBe(second);
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it('determinism: same input twice produces identical output', () => {
    const input = { z: 1, a: 2, m: { y: 9, b: 8 } };
    expect(canonicalJson(input)).toBe(canonicalJson(input));
  });

  it('determinism: shuffled keys produce identical output to sorted input', () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('determinism: deep nesting (50 levels) round-trips byte-identically', () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 50; i++) {
      deep = { nest: deep };
    }
    const first = canonicalJson(deep);
    const second = canonicalJson(JSON.parse(first));
    expect(first).toBe(second);
  });
});
