/**
 * Schema CLI commands — tests wire fetch + keyring stubs through
 * the real command impls. No process.exit, no real network / keyring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pushSchema } from '../commands/schema-push.js';
import { getCurrentSchema } from '../commands/schema-current.js';
import { listSchemaVersions } from '../commands/schema-list.js';
import { approveSchema } from '../commands/schema-approve.js';

import { saveConfig } from '../config.js';
import { resetFetchImpl, setFetchImpl } from '../http.js';
import { setKeyringBackend, writeSession, type KeyringBackend } from '../keyring.js';
import { NotLoggedInError, PylonCliError } from '../errors.js';

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
let origAppToken: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pylon-schema-'));
  origCfg = process.env['PYLON_CONFIG_PATH'];
  origOrgId = process.env['PYLON_ORG_ID'];
  origAppToken = process.env['PYLON_APP_TOKEN'];
  process.env['PYLON_CONFIG_PATH'] = join(tmp, 'config.yaml');
  delete process.env['PYLON_ORG_ID'];
  delete process.env['PYLON_APP_TOKEN'];
  setKeyringBackend(memoryKeyring());
  saveConfig({
    default_org: 'acme',
    orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetFetchImpl();
  setKeyringBackend(null);
  if (origCfg === undefined) delete process.env['PYLON_CONFIG_PATH'];
  else process.env['PYLON_CONFIG_PATH'] = origCfg;
  if (origOrgId === undefined) delete process.env['PYLON_ORG_ID'];
  else process.env['PYLON_ORG_ID'] = origOrgId;
  if (origAppToken === undefined) delete process.env['PYLON_APP_TOKEN'];
  else process.env['PYLON_APP_TOKEN'] = origAppToken;
});

// ── schema push ───────────────────────────────────────────────────

describe('schema push', () => {
  it('reads YAML file and POSTs, returns accepted (--from-source mode)', async () => {
    // Phase C: push refuses unmarked input by default. These existing
    // tests use bare YAML for ergonomics; --from-source runs the
    // prepare pipeline internally before posting. C8 will add the
    // marker-required-by-default coverage.
    const file = join(tmp, 'schema.yaml');
    writeFileSync(
      file,
      `version_tag: "0.1.0"
capabilities:
  - name: world.read
    description: Read worlds
archetypes:
  - name: user
    capabilities: [world.read]
`,
    );
    let sawHeader: string | undefined;
    let sawBody: Record<string, unknown> | undefined;
    setFetchImpl(async (url, init) => {
      const u = new URL(url as string);
      if (u.pathname === '/apps/olam/schema' && init?.method === 'POST') {
        sawHeader = (init.headers as Record<string, string>)['X-Pylon-App-Token'];
        sawBody = JSON.parse(init.body as string);
        return jsonRes(200, { status: 'accepted', version: 1 });
      }
      return jsonRes(404, {});
    });
    const result = await pushSchema({
      app: 'olam',
      file,
      appToken: 'pyat_test',
      fromSource: true,
    });
    expect(result.response).toEqual({ status: 'accepted', version: 1 });
    expect(sawHeader).toBe('pyat_test');
    expect(sawBody?.['version_tag']).toBe('0.1.0');
    // Pipeline prefixed `world.read` → `olam:world.read` and attached marker.
    expect(sawBody?.['_prepared']).toBeDefined();
  });

  it('reads JSON file (YAML.parse handles JSON too) — --from-source', async () => {
    const file = join(tmp, 'schema.json');
    writeFileSync(
      file,
      JSON.stringify({
        version_tag: '0.1.0',
        capabilities: [{ name: 'x' }],
        archetypes: [],
      }),
    );
    setFetchImpl(async () => jsonRes(200, { status: 'accepted', version: 1 }));
    const result = await pushSchema({
      app: 'olam',
      file,
      appToken: 'pyat_test',
      fromSource: true,
    });
    expect(result.response.status).toBe('accepted');
  });

  it('falls back to PYLON_APP_TOKEN env when --app-token not passed', async () => {
    process.env['PYLON_APP_TOKEN'] = 'pyat_from_env';
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, 'version_tag: "0.1.0"\ncapabilities: []\narchetypes: []\n');
    let sawHeader: string | undefined;
    setFetchImpl(async (_url, init) => {
      sawHeader = (init?.headers as Record<string, string>)['X-Pylon-App-Token'];
      return jsonRes(200, { status: 'accepted', version: 1 });
    });
    await pushSchema({ app: 'olam', file, fromSource: true });
    expect(sawHeader).toBe('pyat_from_env');
  });

  it('errors when no app token present', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, 'version_tag: "0.1.0"\ncapabilities: []\narchetypes: []\n');
    await expect(pushSchema({ app: 'olam', file })).rejects.toBeInstanceOf(
      PylonCliError,
    );
  });

  it('errors when file is missing', async () => {
    await expect(
      pushSchema({ app: 'olam', file: '/nonexistent.yaml', appToken: 'pyat_test' }),
    ).rejects.toBeInstanceOf(PylonCliError);
  });

  it('errors when file is malformed YAML', async () => {
    const file = join(tmp, 'bad.yaml');
    writeFileSync(file, ':\n:\n  - invalid\n');
    await expect(
      pushSchema({ app: 'olam', file, appToken: 'pyat_test' }),
    ).rejects.toBeInstanceOf(PylonCliError);
  });

  it('rejects files that parse but are not schema-shaped (SEC-H1 exfil guard)', async () => {
    // Simulate accidentally pointing --file at .env — parses as YAML
    // but has no version_tag / capabilities / archetypes. Secrets
    // must never leave the laptop.
    const file = join(tmp, 'accidental.env');
    writeFileSync(file, 'AWS_ACCESS_KEY_ID: AKIA1234\nAWS_SECRET: secret\n');
    let fetchCalled = false;
    setFetchImpl(async () => {
      fetchCalled = true;
      return jsonRes(200, { status: 'accepted', version: 1 });
    });
    await expect(
      pushSchema({ app: 'olam', file, appToken: 'pyat_test' }),
    ).rejects.toBeInstanceOf(PylonCliError);
    expect(fetchCalled).toBe(false);
  });

  it('rejects a schema missing version_tag', async () => {
    const file = join(tmp, 'partial.yaml');
    writeFileSync(file, 'capabilities: []\narchetypes: []\n');
    await expect(
      pushSchema({ app: 'olam', file, appToken: 'pyat_test' }),
    ).rejects.toBeInstanceOf(PylonCliError);
  });

  it('rejects a schema where capabilities is not an array', async () => {
    const file = join(tmp, 'bad-shape.yaml');
    writeFileSync(
      file,
      'version_tag: "0.1.0"\ncapabilities: not-an-array\narchetypes: []\n',
    );
    await expect(
      pushSchema({ app: 'olam', file, appToken: 'pyat_test' }),
    ).rejects.toBeInstanceOf(PylonCliError);
  });

  it('passes pending_approval response through verbatim', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, 'version_tag: "0.2.0"\ncapabilities: []\narchetypes: []\n');
    setFetchImpl(async () =>
      jsonRes(200, {
        status: 'pending_approval',
        version: 2,
        current_version: 1,
        diff: { kind: 'destructive', changes: [{ type: 'cap_removed', name: 'olam:x' }] },
      }),
    );
    const result = await pushSchema({
      app: 'olam',
      file,
      appToken: 'pyat_test',
      fromSource: true,
    });
    expect(result.response.status).toBe('pending_approval');
    if (result.response.status === 'pending_approval') {
      expect(result.response.version).toBe(2);
      expect(result.response.current_version).toBe(1);
    }
  });
});

// ── schema push — marker gate (Phase C) ───────────────────────────

describe('schema push — marker gate', () => {
  const ENV = 'PYLON_CLI_VERSION_OVERRIDE';
  let prevOverride: string | undefined;

  beforeEach(() => {
    prevOverride = process.env[ENV];
    process.env[ENV] = '0.0.0-test';
  });

  afterEach(() => {
    if (prevOverride === undefined) delete process.env[ENV];
    else process.env[ENV] = prevOverride;
  });

  it('rejects raw YAML (no marker) with exit 10 + inline remediation command', async () => {
    const file = join(tmp, 'raw.yaml');
    writeFileSync(
      file,
      'version_tag: "0.1.0"\ncapabilities: [{ name: "olam:cap" }]\narchetypes: []\n',
    );
    let fetchCalled = false;
    setFetchImpl(async () => {
      fetchCalled = true;
      return jsonRes(200, { status: 'accepted', version: 1 });
    });

    try {
      await pushSchema({ app: 'olam', file, appToken: 'pyat_test' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PylonCliError);
      expect((err as PylonCliError).exitCode).toBe(10);
      const msg = (err as Error).message;
      expect(msg).toMatch(/unprepared_input/);
      // Inline remediation: prepare → push two-shot AND --from-source one-shot
      expect(msg).toMatch(/pylon schema prepare --source/);
      expect(msg).toMatch(/--from-source/);
      // Paths/app should appear in the message (JSON.stringify-quoted)
      expect(msg).toMatch(/"olam"/);
      expect(fetchCalled).toBe(false);
    }
  });

  it('rejects tampered prepared file (content_sha256 mismatch) with exit 10', async () => {
    // Use the schema/marker module directly to construct a valid
    // prepared body, then mutate it post-attach to simulate
    // hand-edit between prepare and push.
    const { canonicalJson } = await import('../schema/canonical-json.js');
    const { attachMarker } = await import('../schema/marker.js');
    const prepared = attachMarker(
      {
        version_tag: '0.1.0',
        capabilities: [{ name: 'olam:cap' }],
        archetypes: [{ name: 'olam:user', capabilities: ['olam:cap'] }],
      },
      'fake-source',
    );
    const wire = canonicalJson(prepared);
    // Mutate the version_tag in the wire to force content_sha256 mismatch.
    const tampered = wire.replace('"0.1.0"', '"99.0.0"');
    const file = join(tmp, 'tampered.json');
    writeFileSync(file, tampered);

    setFetchImpl(async () => jsonRes(200, { status: 'accepted', version: 1 }));

    try {
      await pushSchema({ app: 'olam', file, appToken: 'pyat_test' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PylonCliError);
      expect((err as PylonCliError).exitCode).toBe(10);
      const msg = (err as Error).message;
      expect(msg).toMatch(/hand-edited/);
      expect(msg).toMatch(/Re-prepare/);
    }
  });

  it('--from-source posts prepared body with marker (server receives _prepared)', async () => {
    const file = join(tmp, 'bare.yaml');
    writeFileSync(
      file,
      'version_tag: "0.1.0"\ncapabilities: [{ name: cap }]\narchetypes: []\n',
    );
    let postedBody: Record<string, unknown> | undefined;
    setFetchImpl(async (_url, init) => {
      postedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonRes(200, { status: 'accepted', version: 1 });
    });

    await pushSchema({
      app: 'olam',
      file,
      appToken: 'pyat_test',
      fromSource: true,
    });

    expect(postedBody?.['_prepared']).toBeDefined();
    const marker = postedBody?.['_prepared'] as Record<string, unknown>;
    expect(marker['cli_version']).toBe('0.0.0-test');
    expect(marker['source_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(marker['content_sha256']).toMatch(/^[0-9a-f]{64}$/);
    // Pipeline prefixed `cap` → `olam:cap`
    expect((postedBody?.['capabilities'] as { name: string }[])[0]?.name).toBe(
      'olam:cap',
    );
  });

  it('accepts a properly-prepared file (no --from-source) — happy path', async () => {
    // Prepare an artifact via the live pipeline, write it to disk,
    // then push without --from-source. verifyMarker passes; POST runs.
    const { canonicalJson } = await import('../schema/canonical-json.js');
    const { attachMarker } = await import('../schema/marker.js');
    const prepared = attachMarker(
      {
        version_tag: '0.1.0',
        capabilities: [{ name: 'olam:cap' }],
        archetypes: [{ name: 'olam:user', capabilities: ['olam:cap'] }],
      },
      'src',
    );
    const file = join(tmp, 'prepared.json');
    writeFileSync(file, canonicalJson(prepared));
    let postedBody: Record<string, unknown> | undefined;
    setFetchImpl(async (_url, init) => {
      postedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonRes(200, { status: 'accepted', version: 1 });
    });

    const result = await pushSchema({
      app: 'olam',
      file,
      appToken: 'pyat_test',
    });
    expect(result.response.status).toBe('accepted');
    expect(postedBody?.['_prepared']).toBeDefined();
  });
});

// ── schema current ────────────────────────────────────────────────

describe('schema current', () => {
  it('returns current schema when session valid', async () => {
    await writeSession('acme', 'session-jwt');
    setFetchImpl(async () =>
      jsonRes(200, {
        version: 4,
        version_tag: '0.4.0',
        capabilities: [{ name: 'olam:world.read' }],
        archetypes: [{ name: 'olam:user', capabilities: ['olam:world.read'] }],
        pushed_by: 'alice@co',
        pushed_at: 1700000000000,
      }),
    );
    const result = await getCurrentSchema({ app: 'olam' });
    expect(result.version).toBe(4);
    expect(result.capabilities).toHaveLength(1);
  });

  it('throws NotLoggedInError when no session', async () => {
    await expect(getCurrentSchema({ app: 'olam' })).rejects.toBeInstanceOf(
      NotLoggedInError,
    );
  });
});

// ── schema list ───────────────────────────────────────────────────

describe('schema list', () => {
  it('returns version list + current/pending pointers', async () => {
    await writeSession('acme', 'session-jwt');
    setFetchImpl(async () =>
      jsonRes(200, {
        versions: [
          { version: 1, version_tag: '0.1', pushed_by: 'a@co', pushed_at: 1 },
          { version: 2, version_tag: '0.2', pushed_by: 'a@co', pushed_at: 2 },
          { version: 3, version_tag: '0.3', pushed_by: 'b@co', pushed_at: 3 },
        ],
        current_version: 2,
        pending_version: 3,
      }),
    );
    const result = await listSchemaVersions({ app: 'olam' });
    expect(result.versions).toHaveLength(3);
    expect(result.current_version).toBe(2);
    expect(result.pending_version).toBe(3);
  });

  it('handles empty app (no versions yet)', async () => {
    await writeSession('acme', 'session-jwt');
    setFetchImpl(async () =>
      jsonRes(200, { versions: [], current_version: null, pending_version: null }),
    );
    const result = await listSchemaVersions({ app: 'olam' });
    expect(result.versions).toEqual([]);
  });

  it('surfaces `prepared` marker fields on markered versions; absent on markerless (Phase C)', async () => {
    await writeSession('acme', 'session-jwt');
    setFetchImpl(async () =>
      jsonRes(200, {
        versions: [
          // markerless — pre-0.3.0 / SDK / curl push
          {
            version: 1,
            version_tag: '0.1',
            pushed_by: 'sdk@co',
            pushed_at: 1,
          },
          // markered — CLI 0.3.0+ push via prepare
          {
            version: 2,
            version_tag: '0.2',
            pushed_by: 'ci@co',
            pushed_at: 2,
            prepared: {
              cli_version: '0.3.0',
              source_sha256: 'a'.repeat(64),
              content_sha256: 'b'.repeat(64),
            },
          },
        ],
        current_version: 2,
        pending_version: null,
      }),
    );
    const result = await listSchemaVersions({ app: 'olam' });
    expect(result.versions[0]?.prepared).toBeUndefined();
    expect(result.versions[1]?.prepared).toEqual({
      cli_version: '0.3.0',
      source_sha256: 'a'.repeat(64),
      content_sha256: 'b'.repeat(64),
    });
  });
});

// ── schema approve ────────────────────────────────────────────────

describe('schema approve', () => {
  it('approves a pending migration, returns new current + migrated count', async () => {
    await writeSession('acme', 'session-jwt');
    let sawBody: Record<string, unknown> | undefined;
    setFetchImpl(async (url, init) => {
      const u = new URL(url as string);
      if (u.pathname === '/apps/olam/schema/approve-migration' && init?.method === 'POST') {
        sawBody = JSON.parse(init.body as string);
        return jsonRes(200, { status: 'approved', version: 3, roles_migrated: 7 });
      }
      return jsonRes(404, {});
    });
    const result = await approveSchema({ app: 'olam', version: 3 });
    expect(result.version).toBe(3);
    expect(result.rolesMigrated).toBe(7);
    expect(sawBody?.['version']).toBe(3);
  });

  it('throws NotLoggedInError when no session', async () => {
    await expect(
      approveSchema({ app: 'olam', version: 1 }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});
