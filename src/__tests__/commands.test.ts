/**
 * Command-level tests — thread fetch + keyring stubs through the
 * real command implementations. No process.exit, no real network,
 * no real keyring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { login } from '../commands/login.js';
import { logout } from '../commands/logout.js';
import { forget } from '../commands/forget.js';
import { use } from '../commands/use.js';
import { whoami } from '../commands/whoami.js';
import { registerApp } from '../commands/app-register.js';
import { grantRole } from '../commands/role-grant.js';

import { loadConfig, saveConfig, type PylonConfig } from '../config.js';
import { resetFetchImpl, setFetchImpl } from '../http.js';
import { setKeyringBackend, type KeyringBackend } from '../keyring.js';
import {
  NoOrgSpecifiedError,
  NotLoggedInError,
  PylonCliError,
} from '../errors.js';

function memoryKeyring(): KeyringBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (s, a) => store.get(`${s}:${a}`) ?? null,
    set: (s, a, p) => {
      store.set(`${s}:${a}`, p);
    },
    delete: (s, a) => store.delete(`${s}:${a}`),
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let tmp: string;
let origCfg: string | undefined;
let origOrgId: string | undefined;
let origOrgUrl: string | undefined;
let origSession: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pylon-cli-cmd-'));
  origCfg = process.env['PYLON_CONFIG_PATH'];
  origOrgId = process.env['PYLON_ORG_ID'];
  origOrgUrl = process.env['PYLON_ORG_URL'];
  origSession = process.env['PYLON_SESSION_TOKEN'];
  process.env['PYLON_CONFIG_PATH'] = join(tmp, 'config.yaml');
  delete process.env['PYLON_ORG_ID'];
  delete process.env['PYLON_ORG_URL'];
  delete process.env['PYLON_SESSION_TOKEN'];
  setKeyringBackend(memoryKeyring());
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetFetchImpl();
  setKeyringBackend(null);
  if (origCfg === undefined) delete process.env['PYLON_CONFIG_PATH'];
  else process.env['PYLON_CONFIG_PATH'] = origCfg;
  if (origOrgId === undefined) delete process.env['PYLON_ORG_ID'];
  else process.env['PYLON_ORG_ID'] = origOrgId;
  if (origOrgUrl === undefined) delete process.env['PYLON_ORG_URL'];
  else process.env['PYLON_ORG_URL'] = origOrgUrl;
  if (origSession === undefined) delete process.env['PYLON_SESSION_TOKEN'];
  else process.env['PYLON_SESSION_TOKEN'] = origSession;
});

// ---------------------------------------------------------------------------
// use
// ---------------------------------------------------------------------------

describe('use', () => {
  it('switches default_org for a known org', () => {
    saveConfig({
      default_org: 'acme',
      orgs: [
        { id: 'acme', api_url: 'https://pylon.acme' },
        { id: 'beta', api_url: 'https://pylon.beta' },
      ],
    });
    const r = use({ org: 'beta' });
    expect(r.orgId).toBe('beta');
    expect(r.previousDefault).toBe('acme');
    expect(loadConfig().default_org).toBe('beta');
  });

  it('errors with helpful message on unknown org', () => {
    saveConfig({ orgs: [{ id: 'acme', api_url: 'https://x' }] });
    expect(() => use({ org: 'nope' })).toThrow(PylonCliError);
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('logout', () => {
  it('removes an existing session', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    // Pre-seed keyring via writeSession isn't exposed; use the backend:
    setKeyringBackend({
      get: () => 'existing-jwt',
      set: () => {},
      delete: () => true,
    });
    const r = await logout({});
    expect(r.orgId).toBe('acme');
    expect(r.removed).toBe(true);
  });

  it('returns removed=false when no session exists', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    const r = await logout({});
    expect(r.removed).toBe(false);
  });

  it('errors when no org resolves', async () => {
    await expect(logout({})).rejects.toBeInstanceOf(NoOrgSpecifiedError);
  });
});

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

describe('whoami', () => {
  const cfg: PylonConfig = {
    default_org: 'acme',
    orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
  };

  it('calls /whoami against the org api_url with bearer token', async () => {
    saveConfig(cfg);
    // Seed session via env override:
    process.env['PYLON_SESSION_TOKEN'] = 'session-xyz';
    setFetchImpl(async (url, init) => {
      expect(String(url)).toBe('https://pylon.acme/whoami');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer session-xyz');
      return jsonRes(200, {
        email: 'admin@co',
        org_id: 'acme',
        archetype: 'pylon-admin',
        session_expires_at: 9999,
      });
    });
    const r = await whoami({});
    expect(r.email).toBe('admin@co');
    expect(r.archetype).toBe('pylon-admin');
  });

  it('throws NotLoggedInError when no session exists', async () => {
    saveConfig(cfg);
    await expect(whoami({})).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

// ---------------------------------------------------------------------------
// login — device code flow
// ---------------------------------------------------------------------------

describe('login — device-code flow', () => {
  it('discovers, polls, saves session, sets default', async () => {
    let pollCount = 0;
    setFetchImpl(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/discover')) {
        return jsonRes(200, {
          id: 'acme',
          name: 'Acme',
          api_url: 'https://pylon.acme',
        });
      }
      if (u.endsWith('/device/init')) {
        return jsonRes(200, {
          device_code: 'DEV-CODE',
          user_code: 'ABC-123',
          verification_url: 'https://pylon.acme/device',
          expires_in: 300,
          interval: 0, // poll immediately in tests
        });
      }
      if (u.includes('/device/poll')) {
        pollCount += 1;
        if (pollCount < 2) return jsonRes(200, { status: 'pending' });
        return jsonRes(200, { status: 'authorised', session_jwt: 'jwt-fresh' });
      }
      if (u.endsWith('/whoami')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer jwt-fresh');
        return jsonRes(200, {
          email: 'admin@co',
          org_id: 'acme',
          archetype: 'pylon-admin',
          session_expires_at: 8888,
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });

    const result = await login({ orgUrl: 'https://pylon.acme' });
    expect(result.orgId).toBe('acme');
    expect(result.email).toBe('admin@co');
    expect(pollCount).toBe(2);

    // Config persisted + default set (since no prior default):
    const cfg = loadConfig();
    expect(cfg.default_org).toBe('acme');
    expect(cfg.orgs).toHaveLength(1);
    expect(cfg.orgs[0]!.api_url).toBe('https://pylon.acme');
  });

  it('fails closed when config has a different orgId bound to this URL (ADR 004 pillar 4)', async () => {
    // Pre-seed config: URL X → orgId "acme"
    saveConfig({
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    // Malicious or confused /discover now claims URL X is orgId "beta"
    setFetchImpl(async () =>
      jsonRes(200, {
        id: 'beta',
        name: 'Beta',
        api_url: 'https://pylon.acme',
      }),
    );
    await expect(login({ orgUrl: 'https://pylon.acme' })).rejects.toThrow(
      /Cache mismatch.*acme.*beta/s,
    );
    // Config unchanged
    expect(loadConfig().orgs[0]!.id).toBe('acme');
  });

  it('--replace overrides the cache-mismatch guard', async () => {
    saveConfig({
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    setFetchImpl(async (url) => {
      const u = String(url);
      if (u.endsWith('/discover')) {
        return jsonRes(200, {
          id: 'beta',
          name: 'Beta',
          api_url: 'https://pylon.acme',
        });
      }
      if (u.endsWith('/device/init')) {
        return jsonRes(200, {
          device_code: 'DEV',
          user_code: 'ABC',
          verification_url: 'https://pylon.acme/device',
          expires_in: 300,
          interval: 0,
        });
      }
      if (u.includes('/device/poll')) {
        return jsonRes(200, { status: 'authorised', session_jwt: 'jwt' });
      }
      if (u.endsWith('/whoami')) {
        return jsonRes(200, {
          email: 'u@co',
          org_id: 'beta',
          archetype: 'user',
          session_expires_at: 1,
        });
      }
      throw new Error('unexpected ' + u);
    });
    const result = await login({ orgUrl: 'https://pylon.acme', replace: true });
    expect(result.orgId).toBe('beta');
    // Config now reflects the new binding.
    const cfg = loadConfig();
    expect(cfg.orgs).toHaveLength(1);
    expect(cfg.orgs[0]!.id).toBe('beta');
  });

  it('rejects a verification_url that points elsewhere (phishing defence)', async () => {
    setFetchImpl(async (url) => {
      const u = String(url);
      if (u.endsWith('/discover')) {
        return jsonRes(200, {
          id: 'acme',
          name: 'Acme',
          api_url: 'https://pylon.acme',
        });
      }
      if (u.endsWith('/device/init')) {
        // Malicious server returns a verification_url to a different origin —
        // login must refuse to print it.
        return jsonRes(200, {
          device_code: 'DEV',
          user_code: 'ABC',
          verification_url: 'https://attacker.example/phish',
          expires_in: 300,
          interval: 0,
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    await expect(login({ orgUrl: 'https://pylon.acme' })).rejects.toThrow(/same origin/i);
  });

  it('rejects --browser for now (not yet implemented)', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    await expect(login({ browser: true })).rejects.toThrow(/browser/);
  });

  it('errors when no org can be resolved', async () => {
    await expect(login({})).rejects.toBeInstanceOf(NoOrgSpecifiedError);
  });
});

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

describe('forget', () => {
  it('removes both config record and keyring session', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [
        { id: 'acme', api_url: 'https://pylon.acme' },
        { id: 'beta', api_url: 'https://pylon.beta' },
      ],
    });
    setKeyringBackend({
      get: () => 'existing-jwt',
      set: () => {},
      delete: () => true,
    });
    const r = await forget({ org: 'acme' });
    expect(r.orgId).toBe('acme');
    expect(r.removedSession).toBe(true);
    expect(r.removedFromConfig).toBe(true);

    const cfg = loadConfig();
    expect(cfg.orgs.map((o) => o.id)).toEqual(['beta']);
    // default_org was pointing at the forgotten org → cleared
    expect(cfg.default_org).toBeUndefined();
  });

  it('preserves default_org when forgetting a non-default org', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [
        { id: 'acme', api_url: 'https://pylon.acme' },
        { id: 'beta', api_url: 'https://pylon.beta' },
      ],
    });
    await forget({ org: 'beta' });
    expect(loadConfig().default_org).toBe('acme');
  });

  it('errors on unknown org', async () => {
    saveConfig({ orgs: [] });
    await expect(forget({ org: 'nope' })).rejects.toThrow(/Unknown org/);
  });

  it('returns removedSession=false when no session existed', async () => {
    saveConfig({ orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }] });
    // default memoryKeyring from beforeEach has nothing stored
    const r = await forget({ org: 'acme' });
    expect(r.removedSession).toBe(false);
    expect(r.removedFromConfig).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerApp + grantRole — thin HTTP wrappers
// ---------------------------------------------------------------------------

describe('registerApp', () => {
  it('requires a session', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    await expect(
      registerApp({ name: 'my-mcp', owner: 'eng@co' }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('forwards name/owner/description to /apps', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    process.env['PYLON_SESSION_TOKEN'] = 'admin-jwt';
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        name: 'my-mcp',
        owner: 'eng@co',
        description: 'does things',
      });
      return jsonRes(200, { app_id: 'my-mcp', app_token: 'tok_ABC' });
    });
    const r = await registerApp({
      name: 'my-mcp',
      owner: 'eng@co',
      description: 'does things',
    });
    expect(r.appId).toBe('my-mcp');
    expect(r.appToken).toBe('tok_ABC');
  });
});

describe('grantRole', () => {
  it('forwards email/app/archetype/capabilities to /roles', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    process.env['PYLON_SESSION_TOKEN'] = 'admin-jwt';
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        email: 'alice@co',
        app_id: 'my-mcp',
        archetype: 'admin',
        capabilities: ['my-mcp:extra'],
      });
      return jsonRes(200, {
        email_hash: 'f'.repeat(64),
        app_id: 'my-mcp',
        archetype: 'admin',
      });
    });
    const r = await grantRole({
      email: 'alice@co',
      app: 'my-mcp',
      archetype: 'admin',
      capability: ['my-mcp:extra'],
    });
    expect(r.emailHash).toHaveLength(64);
    expect(r.archetype).toBe('admin');
  });

  it('omits capabilities when none provided', async () => {
    saveConfig({
      default_org: 'acme',
      orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
    });
    process.env['PYLON_SESSION_TOKEN'] = 'admin-jwt';
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.capabilities).toBeUndefined();
      return jsonRes(200, {
        email_hash: '0'.repeat(64),
        app_id: 'my-mcp',
        archetype: 'user',
      });
    });
    await grantRole({
      email: 'bob@co',
      app: 'my-mcp',
      archetype: 'user',
    });
  });
});
