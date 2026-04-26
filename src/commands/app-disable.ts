import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { appDisable } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface AppDisableOptions {
  readonly id: string;
  readonly org?: string;
}

export interface AppDisableResult {
  readonly orgId: string;
  readonly appId: string;
  readonly status: string;
}

export async function disableApp(opts: AppDisableOptions): Promise<AppDisableResult> {
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

  const result = await appDisable(record.api_url, session, opts.id);
  return {
    orgId,
    appId: result.app_id,
    status: result.status,
  };
}
