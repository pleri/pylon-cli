/**
 * `pylon forget --org=<id>` — remove an org from local state entirely.
 *
 * Deletes BOTH the keyring session AND the config record. This is
 * the recovery path for ADR 004 pillar 4 (cache-vs-discovery
 * disagreement): when an admin has repurposed a URL or moved the
 * deployment, the user clears the stale anchor and re-establishes
 * trust via a fresh `pylon login --org-url=<url>`.
 *
 * If the forgotten org was the default, `default_org` is cleared.
 * Contrast with `logout`, which only removes the session.
 */

import {
  findOrgById,
  loadConfig,
  saveConfig,
  type PylonConfig,
} from '../config.js';
import { deleteSession } from '../keyring.js';
import { PylonCliError } from '../errors.js';

export interface ForgetOptions {
  readonly org: string;
}

export interface ForgetResult {
  readonly orgId: string;
  readonly removedSession: boolean;
  readonly removedFromConfig: boolean;
}

export async function forget(opts: ForgetOptions): Promise<ForgetResult> {
  const config = loadConfig();
  const record = findOrgById(config, opts.org);
  if (!record) {
    throw new PylonCliError(
      `Unknown org "${opts.org}". Known orgs: ${config.orgs.map((o) => o.id).join(', ') || '(none)'}.`,
      2,
    );
  }

  // 1) Drop the session (best-effort; keyring may say "no entry" if
  //    the user already logged out).
  const removedSession = await deleteSession(opts.org);

  // 2) Strip the record + clear default_org if it was pointing
  //    here. Build the new config without ever inserting
  //    `default_org: undefined` — YAML would serialise that as
  //    `default_org: null`, which is noisy but not harmful.
  const orgs = config.orgs.filter((o) => o.id !== opts.org);
  const keepDefault =
    config.default_org && config.default_org !== opts.org;
  const nextConfig: PylonConfig = keepDefault
    ? { default_org: config.default_org, orgs }
    : { orgs };
  saveConfig(nextConfig);

  return {
    orgId: opts.org,
    removedSession,
    removedFromConfig: true,
  };
}
