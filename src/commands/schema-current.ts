/**
 * `pylon schema current --app=<id>`
 *
 * Fetch the currently-active schema for an app. Requires session
 * JWT + pylon:app.manage (enforced server-side).
 */

import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { schemaCurrent, type SchemaCurrentResponse } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface SchemaCurrentOptions {
  readonly app: string;
  readonly org?: string;
}

export async function getCurrentSchema(
  opts: SchemaCurrentOptions,
): Promise<SchemaCurrentResponse> {
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

  return schemaCurrent(record.api_url, session, opts.app);
}
