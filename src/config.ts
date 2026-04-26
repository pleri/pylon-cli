/**
 * Pylon CLI configuration — `~/.pylon/config.yaml`.
 *
 * Format (shape-stable; additions are non-breaking):
 *
 *   default_org: company
 *   orgs:
 *     - id: company
 *       api_url: https://pylon.company.internal
 *       aliases: [company.pylon.cloud]
 *       default: true
 *
 * The config holds ONLY org metadata. Sessions live in the OS
 * keyring (`./keyring.ts`), never here. The config is safe to
 * commit into dotfiles.
 *
 * `PYLON_CONFIG_PATH` env var overrides the default path — used by
 * tests and by users with non-standard HOME.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface OrgRecord {
  readonly id: string;
  readonly api_url: string;
  readonly aliases?: readonly string[];
  readonly default?: boolean;
}

export interface PylonConfig {
  readonly default_org?: string;
  readonly orgs: readonly OrgRecord[];
}

function configPath(): string {
  const override = process.env['PYLON_CONFIG_PATH'];
  if (override && override.length > 0) return override;
  return join(homedir(), '.pylon', 'config.yaml');
}

export function loadConfig(): PylonConfig {
  const path = configPath();
  if (!existsSync(path)) return { orgs: [] };
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as Partial<PylonConfig> | null;
  if (!parsed || typeof parsed !== 'object') return { orgs: [] };
  return {
    ...(typeof parsed.default_org === 'string' ? { default_org: parsed.default_org } : {}),
    orgs: Array.isArray(parsed.orgs) ? parsed.orgs : [],
  };
}

export function saveConfig(config: PylonConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(config), 'utf8');
}

/**
 * Find an org record by id. Returns undefined if unknown. O(n) but
 * n is tiny (humans have fewer than ~10 orgs on one machine).
 */
export function findOrgById(config: PylonConfig, id: string): OrgRecord | undefined {
  return config.orgs.find((o) => o.id === id);
}

/**
 * Find an org record by api_url or alias.
 */
export function findOrgByUrl(config: PylonConfig, url: string): OrgRecord | undefined {
  const normalised = normaliseUrl(url);
  return config.orgs.find((o) =>
    normaliseUrl(o.api_url) === normalised ||
    (o.aliases ?? []).some((a) => normaliseUrl(a) === normalised),
  );
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Upsert an org record; if an org with the same id exists, replace
 * it. Returns a new config object (never mutates input).
 */
export function upsertOrg(config: PylonConfig, org: OrgRecord): PylonConfig {
  const others = config.orgs.filter((o) => o.id !== org.id);
  return {
    ...config,
    orgs: [...others, org].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Resolve the org id the user meant given: explicit --org flag,
 * explicit --org-url flag (which must already be in config to resolve
 * offline), and env vars. Does NOT perform network discovery —
 * `login.ts` handles that separately before calling this.
 */
export function resolveOrgId(
  config: PylonConfig,
  options: {
    flagOrg?: string;
    flagOrgUrl?: string;
    envOrgId?: string;
    envOrgUrl?: string;
  },
): string | undefined {
  if (options.flagOrg) return options.flagOrg;
  if (options.flagOrgUrl) {
    const found = findOrgByUrl(config, options.flagOrgUrl);
    return found?.id;
  }
  if (options.envOrgId) return options.envOrgId;
  if (options.envOrgUrl) {
    const found = findOrgByUrl(config, options.envOrgUrl);
    return found?.id;
  }
  if (config.default_org) return config.default_org;
  return undefined;
}

export function setDefaultOrg(config: PylonConfig, id: string): PylonConfig {
  return { ...config, default_org: id };
}

export { configPath };
