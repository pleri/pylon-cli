/**
 * `pylon use --org=<id>` — switch the default org.
 *
 * Pure config mutation; no network, no keyring. The org must
 * already exist in config (ie the user has logged into it before).
 */

import { findOrgById, loadConfig, saveConfig, setDefaultOrg } from '../config.js';
import { PylonCliError } from '../errors.js';

export interface UseOptions {
  readonly org: string;
}

export interface UseResult {
  readonly orgId: string;
  readonly previousDefault: string | undefined;
}

export function use(opts: UseOptions): UseResult {
  const config = loadConfig();
  const record = findOrgById(config, opts.org);
  if (!record) {
    throw new PylonCliError(
      `Unknown org "${opts.org}". Known orgs: ${config.orgs.map((o) => o.id).join(', ') || '(none)'}. ` +
        `Run \`pylon login --org-url=<url>\` first.`,
      2,
    );
  }
  const previous = config.default_org;
  saveConfig(setDefaultOrg(config, opts.org));
  return {
    orgId: opts.org,
    ...(previous ? { previousDefault: previous } : { previousDefault: undefined }),
  };
}
