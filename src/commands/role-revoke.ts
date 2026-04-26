import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { roleRevoke } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError, PylonCliError } from '../errors.js';

export interface RoleRevokeOptions {
  readonly app: string;
  readonly emailHash: string;
  readonly org?: string;
}

export interface RoleRevokeResult {
  readonly orgId: string;
  readonly appId: string;
  readonly emailHash: string;
  readonly revoked: boolean;
}

export async function revokeRole(opts: RoleRevokeOptions): Promise<RoleRevokeResult> {
  if (!/^[a-f0-9]{64}$/.test(opts.emailHash)) {
    throw new PylonCliError('email-hash must be a 64-char hex sha256', 2);
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

  const session = await readSession(orgId);
  if (!session) throw new NotLoggedInError(orgId);

  const result = await roleRevoke(record.api_url, session, opts.app, opts.emailHash);
  return {
    orgId,
    appId: result.app_id,
    emailHash: result.email_hash,
    revoked: result.revoked,
  };
}
