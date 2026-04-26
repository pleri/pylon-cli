/**
 * `pylon logout [--org=<id>]` — delete a session from the keyring.
 *
 * Does NOT remove the org record from `~/.pylon/config.yaml` —
 * logout is just about session state. Use `pylon forget --org=<id>`
 * to remove the config entry too (future command).
 */

import { loadConfig, resolveOrgId } from '../config.js';
import { deleteSession } from '../keyring.js';
import { NoOrgSpecifiedError } from '../errors.js';

export interface LogoutOptions {
  readonly org?: string;
}

export interface LogoutResult {
  readonly orgId: string;
  readonly removed: boolean;
}

export async function logout(opts: LogoutOptions): Promise<LogoutResult> {
  const config = loadConfig();
  const orgId = resolveOrgId(config, {
    ...(opts.org ? { flagOrg: opts.org } : {}),
    ...(process.env['PYLON_ORG_ID'] ? { envOrgId: process.env['PYLON_ORG_ID'] } : {}),
    ...(process.env['PYLON_ORG_URL'] ? { envOrgUrl: process.env['PYLON_ORG_URL'] } : {}),
  });
  if (!orgId) throw new NoOrgSpecifiedError();
  const removed = await deleteSession(orgId);
  return { orgId, removed };
}
