/**
 * `pylon role grant --email=<> --app=<> --archetype=<> [--capability=<>...]`
 *
 * Grant (or overwrite) a user's role for a given app. Requires
 * a session with `pylon:role.manage`.
 *
 * `--capability` can be passed multiple times; each is appended to
 * the archetype's preset. Commander's `collect` handles the
 * repetition.
 */

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { roleGrant } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface RoleGrantOptions {
  readonly email: string;
  readonly app: string;
  readonly archetype: string;
  readonly capability?: readonly string[];
  readonly org?: string;
}

export interface RoleGrantResult {
  readonly orgId: string;
  readonly appId: string;
  readonly emailHash: string;
  readonly archetype: string;
}

export async function grantRole(opts: RoleGrantOptions): Promise<RoleGrantResult> {
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

  const res = await roleGrant(record.api_url, session, {
    email: opts.email,
    app_id: opts.app,
    archetype: opts.archetype,
    ...(opts.capability && opts.capability.length > 0 ? { capabilities: opts.capability } : {}),
  });

  return {
    orgId,
    appId: res.app_id,
    emailHash: res.email_hash,
    archetype: res.archetype,
  };
}
