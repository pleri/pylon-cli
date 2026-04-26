import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { roleList, type RoleListItem } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface RoleListOptions {
  readonly app: string;
  readonly org?: string;
}

export interface RoleListResult {
  readonly orgId: string;
  readonly appId: string;
  readonly roles: readonly RoleListItem[];
}

export async function listRoles(opts: RoleListOptions): Promise<RoleListResult> {
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

  const { roles } = await roleList(record.api_url, session, opts.app);
  return { orgId, appId: opts.app, roles };
}
