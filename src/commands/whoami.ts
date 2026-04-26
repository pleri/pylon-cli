/**
 * `pylon whoami [--org=<id>]` — report the active identity.
 *
 * Reads the session from keyring / env, calls `/whoami` against the
 * org's api_url, returns the payload. Does not renew or mutate
 * anything.
 */

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { whoami as whoamiHttp } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface WhoamiOptions {
  readonly org?: string;
}

export interface WhoamiResult {
  readonly orgId: string;
  readonly apiUrl: string;
  readonly email: string;
  readonly archetype: string;
  readonly sessionExpiresAt: number;
}

export async function whoami(opts: WhoamiOptions): Promise<WhoamiResult> {
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
  if (!session) throw new NotLoggedInError(orgId);

  const info = await whoamiHttp(record.api_url, session);
  return {
    orgId,
    apiUrl: record.api_url,
    email: info.email,
    archetype: info.archetype,
    sessionExpiresAt: info.session_expires_at,
  };
}
