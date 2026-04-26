/**
 * `pylon schema prepare --source <path> --app <id> [--out <path>] [--check] [--org <id>]`
 *
 * Pure-by-default canonical-artifact generator. Reads YAML/JSON bare
 * source, runs the Phase A pipeline (parseSource → validateBare →
 * prefixAndSort → attachMarker → canonicalJson), writes canonical
 * JSON to stdout or `--out`.
 *
 * `--check` mode fetches the deployed schema (session JWT auth, same
 * surface as `pylon schema current`), canonicalizes its body, and
 * byte-compares against the freshly prepared body. Match → exit 0
 * silent (git-diff convention); drift → write a simple line-diff
 * to stdout and throw CheckDiffError (exit 12).
 *
 * Simplicity boundaries (design doc S1, S6):
 *   • No LCS / Myers diff — the line-diff just walks both canonical
 *     outputs in parallel. Adequate for schema-sized payloads; users
 *     wanting richer output can `--out` both forms and run their
 *     own diff tool.
 *   • No CLI-side schema classifier (additive vs destructive). The
 *     server already classifies on push; `--check` only tells you
 *     "match or drift", not "is this safe to push".
 */

import { writeFileSync, readFileSync } from 'node:fs';

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import {
  CheckDiffError,
  InvalidSourceError,
  NoOrgSpecifiedError,
  NotLoggedInError,
} from '../errors.js';
import { sanitizeServerMessage, schemaCurrent, type SchemaCurrentResponse } from '../http.js';
import { readSession } from '../keyring.js';
import { canonicalJson } from '../schema/canonical-json.js';
import { attachMarker, type PreparedSchema } from '../schema/marker.js';
import {
  parseSource,
  prefixAndSort,
  validateBare,
  type SchemaDeclaration,
} from '../schema/normalize.js';

export interface SchemaPrepareOptions {
  readonly app: string;
  readonly source: string;
  readonly out?: string;
  readonly check?: boolean;
  readonly org?: string;
}

export type SchemaPrepareResult =
  | {
      readonly mode: 'stdout';
      readonly app: string;
      readonly wireBytes: number;
      readonly prepared: PreparedSchema;
    }
  | {
      readonly mode: 'out';
      readonly app: string;
      readonly wireBytes: number;
      readonly outPath: string;
      readonly prepared: PreparedSchema;
    }
  | {
      readonly mode: 'check';
      readonly app: string;
      readonly status: 'match';
      readonly currentVersion: number;
      readonly prepared: PreparedSchema;
    };

export interface PreparedArtifact {
  readonly raw: string;
  readonly prepared: PreparedSchema;
  readonly wire: string;
}

/**
 * Pure pipeline: bare source on disk → prepared in-memory artifact +
 * canonical wire bytes. No stdout, no file write, no network.
 *
 * Exposed for callers (Phase C `pylon schema push --from-source`)
 * that need the in-memory result without the side-effects of
 * `prepareSchema`'s mode dispatch.
 */
export function preparePipeline(opts: {
  readonly app: string;
  readonly source: string;
}): PreparedArtifact {
  const raw = loadSourceFile(opts.source);
  const parsed = parseSource(raw, opts.source);
  const bare = validateBare(parsed, opts.app);
  const prefixed = prefixAndSort(bare, opts.app);
  const prepared = attachMarker(prefixed, raw);
  const wire = canonicalJson(prepared);
  return { raw, prepared, wire };
}

export async function prepareSchema(
  opts: SchemaPrepareOptions,
): Promise<SchemaPrepareResult> {
  // adv-003: --out + --check together would silently drop --out (check
  // returns first). Reject the combination explicitly so user intent
  // doesn't get lost.
  if (opts.check && opts.out !== undefined) {
    throw new InvalidSourceError(
      '--out and --check are mutually exclusive (use one prepare invocation per intent)',
    );
  }
  const { prepared, wire } = preparePipeline({ app: opts.app, source: opts.source });

  if (opts.check) {
    return runCheck(opts, prepared);
  }

  if (opts.out !== undefined) {
    try {
      writeFileSync(opts.out, wire, { mode: 0o644 });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // adv-001: wrap user-supplied path in JSON.stringify so newlines
      // / control chars in the path render as escape sequences. Sanitize
      // the wrapped Node error message too — Node's ENOENT echoes the
      // path verbatim inside its own message, which would re-introduce
      // raw bytes if not stripped.
      throw new InvalidSourceError(
        `cannot write ${JSON.stringify(opts.out)}: ${sanitizeServerMessage(reason)}`,
      );
    }
    return {
      mode: 'out',
      app: opts.app,
      wireBytes: wire.length,
      outPath: opts.out,
      prepared,
    };
  }

  process.stdout.write(wire);
  return {
    mode: 'stdout',
    app: opts.app,
    wireBytes: wire.length,
    prepared,
  };
}

function loadSourceFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // adv-001 (mirror): JSON.stringify the path + sanitize the wrapped
    // Node error message so control chars in either don't re-emerge as
    // raw bytes when the message hits an operator's terminal.
    throw new InvalidSourceError(
      `cannot read ${JSON.stringify(path)}: ${sanitizeServerMessage(reason)}`,
    );
  }
}

async function runCheck(
  opts: SchemaPrepareOptions,
  prepared: PreparedSchema,
): Promise<SchemaPrepareResult> {
  const config = loadConfig();
  const orgId = resolveOrgId(config, {
    ...(opts.org ? { flagOrg: opts.org } : {}),
    ...(process.env['PYLON_ORG_ID'] ? { envOrgId: process.env['PYLON_ORG_ID'] } : {}),
    ...(process.env['PYLON_ORG_URL'] ? { envOrgUrl: process.env['PYLON_ORG_URL'] } : {}),
  });
  if (!orgId) throw new NoOrgSpecifiedError();
  const record = findOrgById(config, orgId);
  if (!record) throw new NoOrgSpecifiedError();

  const session = await readSession(orgId);
  if (!session) {
    // T7: --check requires session JWT. App-token-only CI cannot use it.
    throw new NotLoggedInError(orgId);
  }

  const current = await schemaCurrent(record.api_url, session, opts.app);

  // Body-only canonical forms (strip the marker on both sides — the
  // deployed schema may carry one if Phase C has shipped, but the
  // body is what we're comparing).
  const preparedBody = canonicalJson(stripMarker(prepared));
  const currentBody = canonicalJson(toDeclaration(current));

  if (preparedBody === currentBody) {
    return {
      mode: 'check',
      app: opts.app,
      status: 'match',
      currentVersion: current.version,
      prepared,
    };
  }

  const diff = simpleLineDiff(currentBody, preparedBody);
  process.stdout.write(diff);
  throw new CheckDiffError(
    `prepared schema for "${opts.app}" differs from deployed (current version ${current.version}). See diff above.`,
  );
}

function stripMarker(prepared: PreparedSchema): SchemaDeclaration {
  return {
    version_tag: prepared.version_tag,
    capabilities: prepared.capabilities,
    archetypes: prepared.archetypes,
  };
}

function toDeclaration(current: SchemaCurrentResponse): SchemaDeclaration {
  return {
    version_tag: current.version_tag,
    capabilities: current.capabilities,
    archetypes: current.archetypes,
  };
}

/**
 * Cheap parallel line-walker. Marks identical lines with a leading
 * space, current-only with `-`, prepared-only with `+`. No LCS — when
 * lines insert/delete in the middle, downstream lines drift, but for
 * schema-sized canonical output the result is still readable and
 * meets S1 (no client-side diff engine).
 */
function simpleLineDiff(currentBody: string, preparedBody: string): string {
  const aLines = currentBody.split('\n');
  const bLines = preparedBody.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const out: string[] = [
    'schema drift between deployed (current) and prepared (-/+ below):',
    '',
  ];
  for (let i = 0; i < max; i++) {
    const al = i < aLines.length ? aLines[i] : undefined;
    const bl = i < bLines.length ? bLines[i] : undefined;
    if (al === bl) {
      out.push(`  ${al ?? ''}`);
    } else {
      if (al !== undefined) out.push(`- ${al}`);
      if (bl !== undefined) out.push(`+ ${bl}`);
    }
  }
  return out.join('\n') + '\n';
}
