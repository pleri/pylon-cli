/**
 * Config module tests.
 *
 * Every test routes through a per-test temp directory via
 * `PYLON_CONFIG_PATH` so nothing touches real $HOME.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findOrgById,
  findOrgByUrl,
  loadConfig,
  resolveOrgId,
  saveConfig,
  setDefaultOrg,
  upsertOrg,
  type PylonConfig,
} from '../config.js';

let tmp: string;
let originalConfigPath: string | undefined;
let originalOrgId: string | undefined;
let originalOrgUrl: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pylon-cli-config-'));
  originalConfigPath = process.env['PYLON_CONFIG_PATH'];
  originalOrgId = process.env['PYLON_ORG_ID'];
  originalOrgUrl = process.env['PYLON_ORG_URL'];
  process.env['PYLON_CONFIG_PATH'] = join(tmp, 'config.yaml');
  delete process.env['PYLON_ORG_ID'];
  delete process.env['PYLON_ORG_URL'];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env['PYLON_CONFIG_PATH'];
  else process.env['PYLON_CONFIG_PATH'] = originalConfigPath;
  if (originalOrgId === undefined) delete process.env['PYLON_ORG_ID'];
  else process.env['PYLON_ORG_ID'] = originalOrgId;
  if (originalOrgUrl === undefined) delete process.env['PYLON_ORG_URL'];
  else process.env['PYLON_ORG_URL'] = originalOrgUrl;
});

describe('loadConfig + saveConfig', () => {
  it('returns empty orgs when file does not exist', () => {
    const cfg = loadConfig();
    expect(cfg).toEqual({ orgs: [] });
  });

  it('roundtrips through YAML', () => {
    const cfg: PylonConfig = {
      default_org: 'acme',
      orgs: [
        { id: 'acme', api_url: 'https://pylon.acme.internal' },
        { id: 'beta', api_url: 'https://pylon-beta.acme.internal', aliases: ['beta.pylon.cloud'] },
      ],
    };
    saveConfig(cfg);
    const raw = readFileSync(process.env['PYLON_CONFIG_PATH']!, 'utf8');
    expect(raw).toContain('default_org: acme');
    expect(raw).toContain('id: acme');
    const back = loadConfig();
    expect(back.default_org).toBe('acme');
    expect(back.orgs).toHaveLength(2);
  });

  it('tolerates malformed config by defaulting to empty', () => {
    saveConfig({ orgs: [] });
    // Overwrite with junk:
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(process.env['PYLON_CONFIG_PATH']!, 'not: [valid: yaml');
    expect(() => loadConfig()).toThrow();
  });
});

describe('findOrgById / findOrgByUrl', () => {
  const cfg: PylonConfig = {
    orgs: [
      { id: 'acme', api_url: 'https://pylon.acme.internal' },
      { id: 'beta', api_url: 'https://pylon.beta.co', aliases: ['beta.pylon.cloud'] },
    ],
  };

  it('finds by id', () => {
    expect(findOrgById(cfg, 'acme')?.api_url).toBe('https://pylon.acme.internal');
    expect(findOrgById(cfg, 'nope')).toBeUndefined();
  });

  it('finds by exact api_url', () => {
    expect(findOrgByUrl(cfg, 'https://pylon.acme.internal')?.id).toBe('acme');
  });

  it('finds by alias', () => {
    expect(findOrgByUrl(cfg, 'https://beta.pylon.cloud')?.id).toBe('beta');
  });

  it('finds by url missing scheme', () => {
    expect(findOrgByUrl(cfg, 'pylon.acme.internal')?.id).toBe('acme');
  });

  it('finds by url with trailing slash / path', () => {
    expect(findOrgByUrl(cfg, 'https://pylon.acme.internal/')?.id).toBe('acme');
  });

  it('returns undefined on no match', () => {
    expect(findOrgByUrl(cfg, 'https://nope.example.com')).toBeUndefined();
  });
});

describe('resolveOrgId — precedence order', () => {
  const cfg: PylonConfig = {
    default_org: 'cfg-default',
    orgs: [
      { id: 'cfg-default', api_url: 'https://cfg.example' },
      { id: 'url-match', api_url: 'https://url.example' },
    ],
  };

  it('--org wins over everything', () => {
    expect(
      resolveOrgId(cfg, {
        flagOrg: 'flag-winner',
        flagOrgUrl: 'https://url.example',
        envOrgId: 'env-id',
        envOrgUrl: 'https://url.example',
      }),
    ).toBe('flag-winner');
  });

  it('--org-url resolves via config match, beats env', () => {
    expect(
      resolveOrgId(cfg, {
        flagOrgUrl: 'https://url.example',
        envOrgId: 'env-id',
      }),
    ).toBe('url-match');
  });

  it('--org-url returns undefined when no config match (caller must discover)', () => {
    expect(resolveOrgId(cfg, { flagOrgUrl: 'https://unknown.example' })).toBeUndefined();
  });

  it('PYLON_ORG_ID env beats PYLON_ORG_URL env', () => {
    expect(
      resolveOrgId(cfg, {
        envOrgId: 'env-id',
        envOrgUrl: 'https://url.example',
      }),
    ).toBe('env-id');
  });

  it('PYLON_ORG_URL env resolves via config match', () => {
    expect(resolveOrgId(cfg, { envOrgUrl: 'https://url.example' })).toBe('url-match');
  });

  it('falls back to default_org from config', () => {
    expect(resolveOrgId(cfg, {})).toBe('cfg-default');
  });

  it('returns undefined when nothing resolves', () => {
    const empty: PylonConfig = { orgs: [] };
    expect(resolveOrgId(empty, {})).toBeUndefined();
  });
});

describe('upsertOrg', () => {
  it('adds a new org in sorted order', () => {
    const cfg: PylonConfig = { orgs: [{ id: 'beta', api_url: 'https://b' }] };
    const next = upsertOrg(cfg, { id: 'acme', api_url: 'https://a' });
    expect(next.orgs.map((o) => o.id)).toEqual(['acme', 'beta']);
  });

  it('replaces an existing org by id', () => {
    const cfg: PylonConfig = { orgs: [{ id: 'acme', api_url: 'https://old' }] };
    const next = upsertOrg(cfg, { id: 'acme', api_url: 'https://new' });
    expect(next.orgs).toHaveLength(1);
    expect(next.orgs[0]!.api_url).toBe('https://new');
  });

  it('does not mutate the input', () => {
    const cfg: PylonConfig = { orgs: [{ id: 'acme', api_url: 'https://a' }] };
    upsertOrg(cfg, { id: 'beta', api_url: 'https://b' });
    expect(cfg.orgs).toHaveLength(1);
  });
});

describe('setDefaultOrg', () => {
  it('sets and preserves orgs', () => {
    const cfg: PylonConfig = { orgs: [{ id: 'acme', api_url: 'https://a' }] };
    const next = setDefaultOrg(cfg, 'acme');
    expect(next.default_org).toBe('acme');
    expect(next.orgs).toHaveLength(1);
  });
});
