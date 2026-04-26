/**
 * Bare-form schema validation + canonicalisation.
 *
 * `parseSource`     — YAML or JSON → unknown (loud-fail on parse error).
 * `validateBare`    — unknown → BareSchema (loud-fail on every shape /
 *                     name / cross-reference / cycle violation; every
 *                     rejection throws `InvalidSourceError` (exit 11)).
 * `prefixAndSort`   — BareSchema → SchemaDeclaration with every name
 *                     prefixed `<appId>:` and every list sorted lex.
 *
 * Bare names match `/^[a-z0-9][a-z0-9._-]*$/` and MUST NOT contain
 * `:` — the prefix is added here, not authored. Cycle detection
 * runs an O(N + M) DFS locally (see `detectInheritsCycles`); we
 * avoid `expandArchetype` from `@pleri/pylon-core` because that
 * function is O(N · (N+M)) when used for whole-graph cycle scanning
 * and adversarially DOSable on large inputs.
 *
 * Input-size assumption: schemas with N capabilities + M archetypes
 * complete in under a second for N+M ≤ 1000. Beyond that, the
 * structural validation passes (one pass over each list) stay
 * linear; cycle detection stays O(N + M).
 *
 * The output type mirrors the schema declaration shape used by
 * `@pleri/pylon-service` and `@pleri/pylon`'s `pylonSchemaClient`,
 * but is defined locally — the CLI doesn't import either of those
 * packages and shouldn't.
 */

import YAML from 'yaml';

import { InvalidSourceError } from '../errors.js';

// ── name regex (must match server schema-validate.ts:16, sans prefix) ──

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// ── bare-form types ────────────────────────────────────────────────

export interface BareCapabilityDecl {
  readonly name: string;
  readonly description?: string;
}

export interface BareArchetype {
  readonly name: string;
  readonly description?: string;
  readonly inherits?: readonly string[];
  readonly capabilities: readonly string[];
}

export interface BareSchema {
  readonly version_tag: string;
  readonly capabilities: readonly BareCapabilityDecl[];
  readonly archetypes: readonly BareArchetype[];
}

// ── prefixed-form output (mirrors @pleri/pylon-service Schema shape) ──

export interface CapabilityDecl {
  readonly name: string;
  readonly description?: string;
}

export interface PrefixedArchetype {
  readonly name: string;
  readonly description?: string;
  readonly inherits?: readonly string[];
  readonly capabilities: readonly string[];
}

export interface SchemaDeclaration {
  readonly version_tag: string;
  readonly capabilities: readonly CapabilityDecl[];
  readonly archetypes: readonly PrefixedArchetype[];
}

// ── parseSource ────────────────────────────────────────────────────

/**
 * Parse YAML or JSON. `yaml` v2's `parse` accepts both, so one
 * entrypoint covers `.yaml` / `.yml` / `.json`. Path is used in
 * the error message for operator orientation; never in the parse.
 */
export function parseSource(raw: string, path: string): unknown {
  try {
    return YAML.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvalidSourceError(`cannot parse ${path}: ${reason}`);
  }
}

// ── validateBare ───────────────────────────────────────────────────

export function validateBare(parsed: unknown, appId: string): BareSchema {
  // appId is itself a bare name — the prefix added downstream is `<appId>:`.
  if (typeof appId !== 'string' || !NAME_RE.test(appId)) {
    throw fail(`appId ${JSON.stringify(appId)} must match ${NAME_RE.source}`);
  }
  if (appId.includes(':')) {
    throw fail(`appId ${JSON.stringify(appId)} must not contain ":"`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('schema must be an object');
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['version_tag'] !== 'string' || obj['version_tag'].length === 0) {
    const got = obj['version_tag'];
    const hint =
      typeof got === 'number'
        ? ' (YAML coerced an unquoted version to a number — quote it, e.g. `version_tag: "1.0"`)'
        : '';
    throw fail(
      `version_tag must be a non-empty string (got ${typeof got}: ${JSON.stringify(got)})${hint}`,
    );
  }
  if (!Array.isArray(obj['capabilities'])) {
    throw fail('capabilities must be an array');
  }
  if (!Array.isArray(obj['archetypes'])) {
    throw fail('archetypes must be an array');
  }

  const capabilities = validateCapabilities(obj['capabilities']);
  const capNames = new Set(capabilities.map((c) => c.name));
  const archetypes = validateArchetypes(obj['archetypes'], capNames);

  // Cycle detection — expandArchetype walks the DAG from each entrypoint
  // and throws on revisit. Discard the returned cap set; we only want
  // the side-effect throws.
  detectInheritsCycles(archetypes);

  return {
    version_tag: obj['version_tag'],
    capabilities,
    archetypes,
  };
}

function validateCapabilities(raw: readonly unknown[]): BareCapabilityDecl[] {
  const out: BareCapabilityDecl[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw fail('each capability must be an object');
    }
    const c = item as Record<string, unknown>;
    if (typeof c['name'] !== 'string') {
      throw fail('capability.name must be a string');
    }
    validateBareName(c['name'], 'capability');
    if (seen.has(c['name'])) {
      throw fail(`duplicate capability ${JSON.stringify(c['name'])}`);
    }
    seen.add(c['name']);
    if (c['description'] !== undefined && typeof c['description'] !== 'string') {
      throw fail(`capability ${JSON.stringify(c['name'])} description must be a string`);
    }
    out.push({
      name: c['name'],
      ...(typeof c['description'] === 'string' ? { description: c['description'] } : {}),
    });
  }
  return out;
}

function validateArchetypes(
  raw: readonly unknown[],
  declaredCaps: ReadonlySet<string>,
): BareArchetype[] {
  const out: BareArchetype[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw fail('each archetype must be an object');
    }
    const a = item as Record<string, unknown>;
    if (typeof a['name'] !== 'string') {
      throw fail('archetype.name must be a string');
    }
    validateBareName(a['name'], 'archetype');
    if (seen.has(a['name'])) {
      throw fail(`duplicate archetype ${JSON.stringify(a['name'])}`);
    }
    seen.add(a['name']);
    if (!Array.isArray(a['capabilities'])) {
      throw fail(`archetype ${JSON.stringify(a['name'])} capabilities must be an array`);
    }
    const archCaps = validateArchetypeCaps(a['name'], a['capabilities'], declaredCaps);
    if (a['description'] !== undefined && typeof a['description'] !== 'string') {
      throw fail(`archetype ${JSON.stringify(a['name'])} description must be a string`);
    }
    const inherits = a['inherits'] !== undefined
      ? validateArchetypeInherits(a['name'], a['inherits'])
      : undefined;
    out.push({
      name: a['name'],
      ...(typeof a['description'] === 'string' ? { description: a['description'] } : {}),
      capabilities: archCaps,
      ...(inherits !== undefined ? { inherits } : {}),
    });
  }

  // After all archetypes are collected, cross-check inherits names exist.
  const archNames = new Set(out.map((a) => a.name));
  for (const a of out) {
    for (const parent of a.inherits ?? []) {
      if (!archNames.has(parent)) {
        throw fail(
          `archetype ${JSON.stringify(a.name)} inherits unknown archetype ${JSON.stringify(parent)}`,
        );
      }
    }
  }

  return out;
}

function validateArchetypeCaps(
  archName: string,
  raw: readonly unknown[],
  declaredCaps: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const cap of raw) {
    if (typeof cap !== 'string') {
      throw fail(`archetype ${JSON.stringify(archName)} capability entry must be a string`);
    }
    validateBareName(cap, `archetype ${JSON.stringify(archName)} capability`);
    if (!declaredCaps.has(cap)) {
      throw fail(
        `archetype ${JSON.stringify(archName)} references undeclared capability ${JSON.stringify(cap)}`,
      );
    }
    out.push(cap);
  }
  return out;
}

function validateArchetypeInherits(
  archName: string,
  raw: unknown,
): string[] {
  if (!Array.isArray(raw)) {
    throw fail(`archetype ${JSON.stringify(archName)} inherits must be an array`);
  }
  const out: string[] = [];
  for (const parent of raw) {
    if (typeof parent !== 'string') {
      throw fail(`archetype ${JSON.stringify(archName)} inherits entry must be a string`);
    }
    validateBareName(parent, `archetype ${JSON.stringify(archName)} inherits`);
    out.push(parent);
  }
  return out;
}

function validateBareName(name: string, what: string): void {
  if (name.includes(':')) {
    throw fail(
      `${what} name ${JSON.stringify(name)} must not contain ":" — bare names only; \`pylon schema prepare\` adds the prefix`,
    );
  }
  if (!NAME_RE.test(name)) {
    throw fail(`${what} name ${JSON.stringify(name)} must match ${NAME_RE.source}`);
  }
}

function detectInheritsCycles(archetypes: readonly BareArchetype[]): void {
  // O(N + M) DFS with on-stack tracking. The earlier cross-ref check
  // guarantees every parent name resolves, so byName.get() is always
  // defined within the walk.
  //
  // We don't reuse `expandArchetype` from @pleri/pylon-core: that
  // function rebuilds its registry Map per call, making whole-graph
  // cycle detection O(N · (N+M)) and adversarially DOSable. Local
  // single-pass DFS is bounded and keeps the CLI free of a core dep.
  const byName = new Map(archetypes.map((a) => [a.name, a]));
  const fullyExplored = new Set<string>();
  const onStack = new Set<string>();
  const path: string[] = [];

  function visit(name: string): void {
    if (fullyExplored.has(name)) return;
    if (onStack.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = path.slice(cycleStart);
      cycle.push(name);
      throw fail(`cycle in archetype inherits: ${cycle.join(' -> ')}`);
    }
    onStack.add(name);
    path.push(name);
    const arch = byName.get(name);
    if (arch) {
      for (const parent of arch.inherits ?? []) {
        visit(parent);
      }
    }
    path.pop();
    onStack.delete(name);
    fullyExplored.add(name);
  }

  for (const a of archetypes) {
    visit(a.name);
  }
}

function fail(reason: string): InvalidSourceError {
  return new InvalidSourceError(reason);
}

// ── prefixAndSort ──────────────────────────────────────────────────

export function prefixAndSort(bare: BareSchema, appId: string): SchemaDeclaration {
  const prefix = (n: string): string => `${appId}:${n}`;
  const byName = (
    a: { readonly name: string },
    b: { readonly name: string },
  ): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const capabilities = bare.capabilities
    .map<CapabilityDecl>((c) => ({
      name: prefix(c.name),
      ...(c.description !== undefined ? { description: c.description } : {}),
    }))
    .sort(byName);

  const archetypes = bare.archetypes
    .map<PrefixedArchetype>((a) => {
      const sortedCaps = [...a.capabilities].sort().map(prefix);
      const sortedInherits = a.inherits
        ? [...a.inherits].sort().map(prefix)
        : undefined;
      return {
        name: prefix(a.name),
        ...(a.description !== undefined ? { description: a.description } : {}),
        capabilities: sortedCaps,
        ...(sortedInherits !== undefined ? { inherits: sortedInherits } : {}),
      };
    })
    .sort(byName);

  return {
    version_tag: bare.version_tag,
    capabilities,
    archetypes,
  };
}
