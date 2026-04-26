/**
 * `pylon schema approve --app=<id> --version=<n>`
 *
 * Approve a pending destructive schema migration. Requires session
 * JWT with `pylon:schema.approve-migration`. The current pointer
 * advances to `version`; the pending record is cleared.
 *
 * Contract §3.6.
 */

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { schemaApprove } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface SchemaApproveOptions {
  readonly app: string;
  readonly version: number;
  readonly org?: string;
}

export interface SchemaApproveResult {
  readonly orgId: string;
  readonly appId: string;
  readonly version: number;
  readonly rolesMigrated: number;
}

export async function approveSchema(
  opts: SchemaApproveOptions,
): Promise<SchemaApproveResult> {
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

  const res = await schemaApprove(record.api_url, session, opts.app, opts.version);

  return {
    orgId,
    appId: opts.app,
    version: res.version,
    rolesMigrated: res.roles_migrated,
  };
}
