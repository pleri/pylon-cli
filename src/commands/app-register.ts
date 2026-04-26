/**
 * `pylon app register --name=<> --owner=<> [--description=<>]`
 *
 * Enrol a new MCP into Pylon. Returns the `appId` + one-time
 * `appToken` — the caller is responsible for displaying the token
 * prominently and reminding the user that it cannot be retrieved
 * again.
 *
 * Requires a session with the `pylon:app.manage` capability. The
 * server enforces that; this CLI just forwards the request.
 */

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { appRegister } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface AppRegisterOptions {
  readonly name: string;
  readonly owner: string;
  readonly description?: string;
  readonly org?: string;
}

export interface AppRegisterResult {
  readonly orgId: string;
  readonly appId: string;
  readonly appToken: string;
}

export async function registerApp(opts: AppRegisterOptions): Promise<AppRegisterResult> {
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

  const res = await appRegister(record.api_url, session, {
    name: opts.name,
    owner: opts.owner,
    ...(opts.description ? { description: opts.description } : {}),
  });

  return {
    orgId,
    appId: res.app_id,
    appToken: res.app_token,
  };
}
