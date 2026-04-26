/**
 * `pylon login` — device-code flow (default) or browser redirect
 * (future, gated by --browser flag).
 *
 * Input precedence per ADR 003:
 *   1. --org=<id>
 *   2. --org-url=<url>       (resolves via /discover, persists to config)
 *   3. PYLON_ORG_ID env
 *   4. PYLON_ORG_URL env     (resolves via /discover)
 *   5. config default_org
 *   6. Interactive prompt    (only if TTY and config has orgs)
 *
 * On success: writes session JWT to OS keyring under
 * `pylon:session:<orgId>` and adds/updates the org record in
 * `~/.pylon/config.yaml`. If the caller is logging into a new
 * org, it also sets default_org unless config already has one.
 */

import { select } from '@inquirer/prompts';
import {
  findOrgById,
  findOrgByUrl,
  loadConfig,
  resolveOrgId,
  saveConfig,
  setDefaultOrg,
  upsertOrg,
  type OrgRecord,
  type PylonConfig,
} from '../config.js';
import { writeSession } from '../keyring.js';
import {
  deviceInit,
  devicePoll,
  discover,
  whoami,
  type DeviceInitResponse,
} from '../http.js';
import {
  DeviceAuthExpiredError,
  NoOrgSpecifiedError,
  PylonCliError,
} from '../errors.js';
import { requireSameOrigin } from '../url-safety.js';

export interface LoginOptions {
  readonly org?: string;
  readonly orgUrl?: string;
  readonly browser?: boolean;
  /**
   * Explicit override for cache-vs-discovery disagreement.
   * Without it, login fails closed if config already binds the
   * provided URL to a different `orgId`. See ADR 004 pillar 4.
   */
  readonly replace?: boolean;
}

/**
 * Entry point. Commander glues flags onto this; tests call it
 * directly. Returns an object describing what was persisted so
 * callers can print it nicely.
 */
export async function login(opts: LoginOptions): Promise<LoginResult> {
  const config = loadConfig();
  const { orgId, apiUrl, configAfterResolve } = await resolveTarget(config, opts);

  if (opts.browser) {
    // Browser redirect flow is out-of-scope for this first CLI PR;
    // documented as a follow-up per ADR 003. Use exit code 9 so
    // "feature not implemented" is distinguishable from the other
    // login failure modes.
    throw new PylonCliError(
      '--browser flow not yet implemented. Use device-code flow (default) for now.',
      9,
    );
  }

  const { sessionJwt } = await runDeviceCodeFlow(apiUrl, orgId);

  // Verify the token by calling /whoami — early feedback that the
  // session actually works before we persist it.
  const who = await whoami(apiUrl, sessionJwt);

  await writeSession(orgId, sessionJwt);

  // Set as default if no default exists yet.
  const finalConfig = configAfterResolve.default_org
    ? configAfterResolve
    : setDefaultOrg(configAfterResolve, orgId);
  saveConfig(finalConfig);

  return {
    orgId,
    apiUrl,
    email: who.email,
    sessionExpiresAt: who.session_expires_at,
  };
}

export interface LoginResult {
  readonly orgId: string;
  readonly apiUrl: string;
  readonly email: string;
  readonly sessionExpiresAt: number;
}

/**
 * Figure out WHICH org we're logging into and what its api_url is.
 * May call `/discover` if the caller provided a URL but no config
 * entry exists for it yet. Also returns the (possibly updated)
 * config so the caller can decide whether to save it.
 */
async function resolveTarget(
  config: PylonConfig,
  opts: LoginOptions,
): Promise<{ orgId: string; apiUrl: string; configAfterResolve: PylonConfig }> {
  // 1) Explicit --org-url wins: discover the id and upsert.
  if (opts.orgUrl) {
    const discovered = await discover(opts.orgUrl);

    // ADR 004 pillar 4 — cache-vs-discovery disagreement.
    // If config already binds this URL to a different orgId, the
    // URL has been repurposed (or something is wrong). Fail closed.
    const existingByUrl = findOrgByUrl(config, discovered.api_url);
    if (existingByUrl && existingByUrl.id !== discovered.id && !opts.replace) {
      throw new PylonCliError(
        `Cache mismatch: config has orgId "${existingByUrl.id}" bound to this URL, ` +
          `but /discover now reports "${discovered.id}". ` +
          `If the URL was intentionally repurposed, run ` +
          `\`pylon forget --org=${existingByUrl.id}\` first, or pass --replace to overwrite.`,
        8,
      );
    }

    const record: OrgRecord = {
      id: discovered.id,
      api_url: discovered.api_url,
    };
    // When --replace is used to overwrite a stale URL binding, we
    // strip the old orgId entirely — keeping it around with no URL
    // would be confusing and it's presumably no longer reachable.
    const baseConfig =
      existingByUrl && existingByUrl.id !== discovered.id
        ? { ...config, orgs: config.orgs.filter((o) => o.id !== existingByUrl.id) }
        : config;
    return {
      orgId: discovered.id,
      apiUrl: discovered.api_url,
      configAfterResolve: upsertOrg(baseConfig, record),
    };
  }

  // 2) Everything else: try to resolve against config first.
  const resolved = resolveOrgId(config, {
    ...(opts.org ? { flagOrg: opts.org } : {}),
    ...(process.env['PYLON_ORG_ID'] ? { envOrgId: process.env['PYLON_ORG_ID'] } : {}),
    ...(process.env['PYLON_ORG_URL'] ? { envOrgUrl: process.env['PYLON_ORG_URL'] } : {}),
  });

  if (resolved) {
    const record = findOrgById(config, resolved);
    if (record) {
      return {
        orgId: resolved,
        apiUrl: record.api_url,
        configAfterResolve: config,
      };
    }
    // We have an id but no config record for it. If an env URL was
    // provided, discover against it. Otherwise fail.
    if (process.env['PYLON_ORG_URL']) {
      const discovered = await discover(process.env['PYLON_ORG_URL']);
      if (discovered.id !== resolved) {
        throw new PylonCliError(
          `Mismatched identity: PYLON_ORG_ID=${resolved} but URL discovered id=${discovered.id}`,
          8,
        );
      }
      const newRecord: OrgRecord = {
        id: discovered.id,
        api_url: discovered.api_url,
      };
      return {
        orgId: discovered.id,
        apiUrl: discovered.api_url,
        configAfterResolve: upsertOrg(config, newRecord),
      };
    }
    throw new NoOrgSpecifiedError();
  }

  // 3) Nothing resolved. If TTY and config has orgs, prompt.
  if (config.orgs.length > 0 && process.stdin.isTTY) {
    const pickedId = await select({
      message: 'Which org?',
      choices: config.orgs.map((o) => ({ name: o.id, value: o.id })),
    });
    const record = findOrgById(config, pickedId);
    if (!record) throw new NoOrgSpecifiedError();
    return { orgId: pickedId, apiUrl: record.api_url, configAfterResolve: config };
  }

  throw new NoOrgSpecifiedError();
}

/**
 * Device-code flow: init, display code, poll, return session JWT.
 * Timing comes from `/device/init` response so backend can tune
 * polling cadence. Hard timeout after `expires_in` seconds.
 */
async function runDeviceCodeFlow(
  apiUrl: string,
  orgId: string,
): Promise<{ sessionJwt: string }> {
  const init: DeviceInitResponse = await deviceInit(apiUrl, {
    client: 'pylon-cli',
    org_id: orgId,
  });

  // Defence against a spoofed `verification_url`: the URL we show
  // to the user for browser auth MUST be the same origin as the
  // Pylon they asked for. Otherwise we'd happily print a phishing
  // link that sends their SSO creds elsewhere.
  requireSameOrigin(apiUrl, init.verification_url, 'device.verification_url');

  printDeviceCodePrompt(init);

  const deadline = Date.now() + init.expires_in * 1000;
  let interval = Math.max(1, init.interval);

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const poll = await devicePoll(apiUrl, init.device_code);
    if (poll.status === 'authorised' && poll.session_jwt) {
      return { sessionJwt: poll.session_jwt };
    }
    if (poll.status === 'expired') {
      throw new DeviceAuthExpiredError();
    }
    // `pending` → keep polling.
  }

  throw new DeviceAuthExpiredError();
}

function printDeviceCodePrompt(init: DeviceInitResponse): void {
  // stdout because this is normal operational output; the caller
  // (top-level bin) controls verbosity.
  // eslint-disable-next-line no-console
  console.log('\n  Visit the following URL to authorise this device:');
  // eslint-disable-next-line no-console
  console.log(`    ${init.verification_url}`);
  // eslint-disable-next-line no-console
  console.log(`  And enter this one-time code:`);
  // eslint-disable-next-line no-console
  console.log(`    ${init.user_code}\n`);
  // eslint-disable-next-line no-console
  console.log('  Waiting for authorisation...');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
