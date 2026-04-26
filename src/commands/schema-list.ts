/**
 * `pylon schema list --app=<id>`
 *
 * List all schema versions for an app. Shows current + pending
 * pointers. Session JWT + pylon:app.manage required.
 */

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { schemaList, type SchemaListResponse } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface SchemaListOptions {
  readonly app: string;
  readonly org?: string;
}

export async function listSchemaVersions(
  opts: SchemaListOptions,
): Promise<SchemaListResponse> {
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

  return schemaList(record.api_url, session, opts.app);
}
