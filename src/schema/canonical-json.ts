/**
 * Deterministic JSON serialization for the canonical schema artifact.
 *
 * Same input → byte-identical output across Node ≥ 22:
 *   • object keys sorted lexicographically by UTF-16 code-unit at every depth
 *   • strings (keys + values) NFC-normalized before serialization
 *   • numbers via ECMA-262 default `JSON.stringify`
 *   • 2-space indent, LF line endings, single trailing newline
 *
 * Arrays are NOT reordered. The caller is responsible for sorting array
 * contents when canonical order matters (see `prefixAndSort` in
 * normalize.ts).
 *
 * Throws on inputs JSON.stringify would silently coerce or drop:
 * `undefined`, `bigint`, `function`, `symbol`, non-finite numbers,
 * non-plain-prototype objects (`Date`, `Map`, `Set`, class instances),
 * object keys that collide after NFC normalization, and any
 * `__proto__` key (would alias the prototype setter and silently
 * drop the value during result construction). The whole point of
 * this module is determinism — silent coercion is an anti-feature
 * here.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    throw new Error('canonicalJson: undefined is not JSON-representable');
  }
  if (typeof value === 'bigint') {
    throw new Error('canonicalJson: bigint is not JSON-representable');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`canonicalJson: ${typeof value} is not JSON-representable`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(
      `canonicalJson: non-finite number (${String(value)}) is not JSON-representable`,
    );
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.normalize('NFC') : value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  // Plain object only — null-prototype objects accepted; everything else
  // (Date, Map, Set, RegExp, class instances) rejected to avoid silent
  // empty-object serialization.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    const tag = Object.prototype.toString.call(value);
    throw new Error(`canonicalJson: object has non-plain prototype: ${tag}`);
  }
  const entries: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const normalized = k.normalize('NFC');
    if (normalized === '__proto__') {
      // Reject `__proto__` because the result-construction loop below
      // does `out[k] = v`, which on this key invokes the prototype
      // setter instead of creating an own property — silently dropping
      // the value from the canonical output. A determinism module that
      // silently drops a key is broken at the integrity-tripwire seam.
      throw new Error(
        'canonicalJson: object key "__proto__" is not permitted; aliases the prototype setter and silently drops from canonical output',
      );
    }
    if (seen.has(normalized)) {
      throw new Error(
        `canonicalJson: duplicate key after NFC normalization: ${JSON.stringify(normalized)}`,
      );
    }
    seen.add(normalized);
    entries.push([normalized, canonicalize(v)]);
  }
  // UTF-16 code-unit comparison — stable across V8 versions, locale-independent.
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = v;
  }
  return out;
}
