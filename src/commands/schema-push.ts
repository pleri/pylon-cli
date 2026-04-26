/**
 * `pylon schema push --app=<id> --file=<path> [--from-source] [--app-token=<t>]`
 *
 * Read a prepared schema artifact, verify its `_prepared` marker,
 * and POST it to the service with X-Pylon-App-Token auth. Returns
 * the server's classification (accepted / pending_approval) so the
 * CLI can print next steps.
 *
 * App token sourced from (in order):
 *   1. --app-token <value>   (direct — avoid in shared shells / CI logs)
 *   2. --app-token -         (read from stdin — safe in CI)
 *   3. PYLON_APP_TOKEN env   (preferred in CI)
 *   4. (fail — no sane default; tokens are secret)
 *
 * Marker gate (Phase C — CLI 0.3.0+ behavior):
 *   • Default mode: `--file` MUST be a prepared JSON artifact carrying
 *     a valid `_prepared` marker. Hand-edited or raw YAML inputs are
 *     refused with exit 10 + an inline remediation command.
 *   • `--from-source` mode: `--file` is treated as a bare YAML/JSON
 *     source. push runs the prepare pipeline internally and posts the
 *     resulting prepared body. Equivalent to `prepare | push` in one
 *     command — explicit opt-in to skip the lockfile-style artifact.
 *
 * Unlike the other CLI commands, this ONE does NOT use the session
 * JWT — contract §3.4 specifies app-token auth for push. Admin-side
 * schema operations (current / list / approve) DO use session.
 */

import { readFileSync } from 'node:fs';
import YAML from 'yaml';

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import {
  NoOrgSpecifiedError,
  PylonCliError,
  UnpreparedInputError,
} from '../errors.js';
import { schemaPush, type SchemaPushResponse } from '../http.js';
import { verifyMarker } from '../schema/marker.js';
import { preparePipeline } from './schema-prepare.js';

export interface SchemaPushOptions {
  readonly app: string;
  readonly file: string;
  readonly appToken?: string;
  readonly fromSource?: boolean;
  readonly org?: string;
}

export interface SchemaPushResult {
  readonly orgId: string;
  readonly appId: string;
  readonly response: SchemaPushResponse;
}

/**
 * Resolve app token from flag / env / stdin.
 *
 * `--app-token -` reads from stdin — keeps long-lived `pyat_*` tokens
 * out of shell history + process arg lists (Phase 5 audit SEC-M3).
 * Env var remains the preferred source in CI.
 */
function resolveAppToken(flagValue: string | undefined): string | null {
  if (flagValue === '-') {
    try {
      return readFileSync(0, 'utf8').trim();
    } catch {
      return null;
    }
  }
  if (flagValue && flagValue.length > 0) return flagValue;
  const env = process.env['PYLON_APP_TOKEN'];
  return env && env.length > 0 ? env : null;
}

export async function pushSchema(opts: SchemaPushOptions): Promise<SchemaPushResult> {
  const appToken = resolveAppToken(opts.appToken);
  if (!appToken) {
    throw new PylonCliError(
      'app token required; pass --app-token=<t>, --app-token=- (stdin), or set PYLON_APP_TOKEN',
      2,
    );
  }

  const config = loadConfig();
  const orgId = resolveOrgId(config, {
    ...(opts.org ? { flagOrg: opts.org } : {}),
    ...(process.env['PYLON_ORG_ID'] ? { envOrgId: process.env['PYLON_ORG_ID'] } : {}),
    ...(process.env['PYLON_ORG_URL'] ? { envOrgUrl: process.env['PYLON_ORG_URL'] } : {}),
  });
  if (!orgId) throw new NoOrgSpecifiedError();

  const record = findOrgById(config, orgId);
  if (!record) throw new NoOrgSpecifiedError();

  const body = opts.fromSource
    ? preparePipeline({ app: opts.app, source: opts.file }).prepared
    : verifyAndLoadPreparedFile(opts.file, opts.app);

  const response = await schemaPush(record.api_url, appToken, opts.app, body);

  return { orgId, appId: opts.app, response };
}

/**
 * Read a prepared artifact from disk and verify its `_prepared` marker
 * before returning. Throws UnpreparedInputError (exit 10) with an
 * inline remediation command on `unprepared_input` or `marker_tampered`.
 *
 * The remediation message is computed from the user's invocation
 * flags so they can copy-paste the fix instead of reading docs (T3
 * mitigation).
 */
function verifyAndLoadPreparedFile(filePath: string, appId: string): unknown {
  const parsed = loadSchemaFile(filePath);
  const verify = verifyMarker(parsed);
  if (verify.ok) return parsed;
  throw makeUnpreparedError(verify.code, filePath, appId);
}

function makeUnpreparedError(
  code: 'unprepared_input' | 'marker_tampered',
  filePath: string,
  appId: string,
): UnpreparedInputError {
  // JSON.stringify wraps the path in double quotes, escaping inner
  // quotes and control chars so the message is paste-safe in shell
  // and doesn't render literal escape codes in the operator's terminal
  // (mirrors A2 audit adv-005 + B audit adv-001).
  const fileQuoted = JSON.stringify(filePath);
  const appQuoted = JSON.stringify(appId);
  if (code === 'unprepared_input') {
    return new UnpreparedInputError(
      `${filePath} has no \`_prepared\` marker. Run prepare first:\n` +
        `    pylon schema prepare --source ${fileQuoted} --app ${appQuoted} --out prepared.json\n` +
        `    pylon schema push --file prepared.json --app ${appQuoted}\n` +
        `  Or, in one shot:\n` +
        `    pylon schema push --from-source --file ${fileQuoted} --app ${appQuoted}`,
    );
  }
  // marker_tampered
  return new UnpreparedInputError(
    `${filePath} carries a \`_prepared\` marker but its content_sha256 no longer matches the body — the file was hand-edited after \`pylon schema prepare\`. Re-prepare:\n` +
      `    pylon schema prepare --source <bare-source> --app ${appQuoted} --out ${fileQuoted}\n` +
      `    pylon schema push --file ${fileQuoted} --app ${appQuoted}`,
  );
}

function loadSchemaFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PylonCliError(`cannot read schema file: ${reason}`, 2);
  }
  // YAML.parse accepts valid JSON too, so one entry point handles both.
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PylonCliError(
      `schema file is not valid YAML or JSON: ${reason}`,
      2,
    );
  }

  // Shape guard — refuse to POST anything that doesn't look like a
  // Pylon schema. Prevents accidental secret exfiltration if an
  // operator tab-completes `--file .env` or similar (Phase 5 audit SEC-H1).
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PylonCliError(
      `${path} does not look like a Pylon schema (not an object)`,
      2,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['version_tag'] !== 'string' || obj['version_tag'].length === 0) {
    throw new PylonCliError(
      `${path} does not look like a Pylon schema (missing or empty version_tag)`,
      2,
    );
  }
  if (!Array.isArray(obj['capabilities'])) {
    throw new PylonCliError(
      `${path} does not look like a Pylon schema (capabilities must be an array)`,
      2,
    );
  }
  if (!Array.isArray(obj['archetypes'])) {
    throw new PylonCliError(
      `${path} does not look like a Pylon schema (archetypes must be an array)`,
      2,
    );
  }
  return parsed;
}
