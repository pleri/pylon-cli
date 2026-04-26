import { findOrgById, loadConfig, resolveOrgId } from '../config.js';
import { readSession } from '../keyring.js';
import { auditQuery, type AuditEntry } from '../http.js';
import { NoOrgSpecifiedError, NotLoggedInError } from '../errors.js';

export interface AuditTailOptions {
  readonly since?: number;
  readonly limit?: number;
  readonly action?: string;
  readonly cursor?: string;
  readonly org?: string;
}

export interface AuditTailResult {
  readonly orgId: string;
  readonly entries: readonly AuditEntry[];
  readonly nextCursor?: string;
}

export async function tailAudit(opts: AuditTailOptions = {}): Promise<AuditTailResult> {
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

  const result = await auditQuery(record.api_url, session, {
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.action ? { action: opts.action } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  });
  return {
    orgId,
    entries: result.entries,
    ...(result.next_cursor ? { nextCursor: result.next_cursor } : {}),
  };
}
