/**
 * Tests for `pylon schema prepare` — exercises every output mode and
 * every documented exit code (10 reserved for push; 11 invalid_source;
 * 12 check_diff; 7 not_logged_in propagated from the existing surface).
 *
 * Reuses the memoryKeyring + setFetchImpl pattern from schema-commands
 * tests so no real network or OS keyring is touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareSchema } from '../commands/schema-prepare.js';
import { saveConfig } from '../config.js';
import {
  CheckDiffError,
  InvalidSourceError,
  NotLoggedInError,
  PylonCliError,
} from '../errors.js';
import { resetFetchImpl, setFetchImpl } from '../http.js';
import {
  setKeyringBackend,
  writeSession,
  type KeyringBackend,
} from '../keyring.js';

const ENV = 'PYLON_CLI_VERSION_OVERRIDE';

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

const validBareYaml = `version_tag: "0.1.0"
capabilities:
  - name: world.read
  - name: world.write
archetypes:
  - name: user
    capabilities: [world.read, world.write]
`;

let tmp: string;
let origCfg: string | undefined;
let origOrgId: string | undefined;
let origOverride: string | undefined;
let origStdoutWrite: typeof process.stdout.write;
let stdoutBuf: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pylon-prepare-'));
  origCfg = process.env['PYLON_CONFIG_PATH'];
  origOrgId = process.env['PYLON_ORG_ID'];
  origOverride = process.env[ENV];
  process.env['PYLON_CONFIG_PATH'] = join(tmp, 'config.yaml');
  delete process.env['PYLON_ORG_ID'];
  process.env[ENV] = '0.0.0-test';
  setKeyringBackend(memoryKeyring());
  saveConfig({
    default_org: 'acme',
    orgs: [{ id: 'acme', api_url: 'https://pylon.acme' }],
  });

  // Capture process.stdout.write so we can assert on it without
  // polluting test output. Real implementations preserved on tear-down.
  stdoutBuf = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    stdoutBuf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetFetchImpl();
  setKeyringBackend(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = origStdoutWrite;
  if (origCfg === undefined) delete process.env['PYLON_CONFIG_PATH'];
  else process.env['PYLON_CONFIG_PATH'] = origCfg;
  if (origOrgId === undefined) delete process.env['PYLON_ORG_ID'];
  else process.env['PYLON_ORG_ID'] = origOrgId;
  if (origOverride === undefined) delete process.env[ENV];
  else process.env[ENV] = origOverride;
});

describe('prepareSchema — stdout (default mode)', () => {
  it('writes canonical JSON to stdout, returns mode=stdout result', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, validBareYaml);

    const result = await prepareSchema({ app: 'olam', source: file });

    expect(result.mode).toBe('stdout');
    if (result.mode !== 'stdout') return; // type narrow
    expect(result.app).toBe('olam');
    expect(result.wireBytes).toBeGreaterThan(0);
    expect(result.prepared._prepared.cli_version).toBe('0.0.0-test');

    const wire = stdoutBuf.join('');
    expect(wire).toContain('"_prepared":');
    expect(wire).toContain('"olam:world.read"');
    expect(wire.endsWith('\n')).toBe(true);
  });
});

describe('prepareSchema — --out (file mode)', () => {
  it('writes canonical JSON to file with 0o644 + trailing newline', async () => {
    const file = join(tmp, 'schema.yaml');
    const out = join(tmp, 'prepared.json');
    writeFileSync(file, validBareYaml);

    const result = await prepareSchema({
      app: 'olam',
      source: file,
      out,
    });

    expect(result.mode).toBe('out');
    if (result.mode !== 'out') return;
    expect(result.outPath).toBe(out);

    const written = readFileSync(out, 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toContain('"olam:user"');
    // Stdout was NOT written to in --out mode.
    expect(stdoutBuf.join('')).toBe('');
  });

  it('throws InvalidSourceError (exit 11) when --out path is unwritable', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, validBareYaml);
    const out = join(tmp, 'no', 'such', 'dir', 'prepared.json');

    try {
      await prepareSchema({ app: 'olam', source: file, out });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSourceError);
      expect((err as PylonCliError).exitCode).toBe(11);
    }
  });
});

describe('prepareSchema — invalid input (exit 11)', () => {
  it('throws on missing source file', async () => {
    try {
      await prepareSchema({ app: 'olam', source: join(tmp, 'nonexistent.yaml') });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSourceError);
      expect((err as PylonCliError).exitCode).toBe(11);
      expect((err as Error).message).toMatch(/cannot read/);
    }
  });

  it('throws on bare-name violation (`:` in source name)', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(
      file,
      'version_tag: "0.1.0"\ncapabilities:\n  - name: olam:world.read\narchetypes: []\n',
    );

    try {
      await prepareSchema({ app: 'olam', source: file });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PylonCliError);
      expect((err as PylonCliError).exitCode).toBe(11);
      expect((err as Error).message).toMatch(/must not contain ":"/);
    }
  });

  it('throws on cycle in inherits', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(
      file,
      `version_tag: "0.1.0"
capabilities: []
archetypes:
  - name: a
    capabilities: []
    inherits: [b]
  - name: b
    capabilities: []
    inherits: [a]
`,
    );

    try {
      await prepareSchema({ app: 'olam', source: file });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as PylonCliError).exitCode).toBe(11);
      expect((err as Error).message).toMatch(/cycle/);
    }
  });
});

describe('prepareSchema — --check (drift detection)', () => {
  it('returns match when prepared body matches deployed body', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, validBareYaml);
    await writeSession('acme', 'session-jwt-fake');

    setFetchImpl(async (url) => {
      const u = new URL(url as string);
      if (u.pathname === '/apps/olam/schema/current') {
        // Server returns prefixed names + sorted capabilities (matching
        // what prefixAndSort would produce locally).
        return jsonRes(200, {
          version: 7,
          version_tag: '0.1.0',
          capabilities: [
            { name: 'olam:world.read' },
            { name: 'olam:world.write' },
          ],
          archetypes: [
            {
              name: 'olam:user',
              capabilities: ['olam:world.read', 'olam:world.write'],
            },
          ],
          pushed_by: 'someone@acme.com',
          pushed_at: 1700000000000,
        });
      }
      return jsonRes(404, {});
    });

    const result = await prepareSchema({
      app: 'olam',
      source: file,
      check: true,
    });

    expect(result.mode).toBe('check');
    if (result.mode !== 'check') return;
    expect(result.status).toBe('match');
    expect(result.currentVersion).toBe(7);
  });

  it('throws CheckDiffError (exit 12) when prepared diverges from deployed', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, validBareYaml);
    await writeSession('acme', 'session-jwt-fake');

    setFetchImpl(async (url) => {
      const u = new URL(url as string);
      if (u.pathname === '/apps/olam/schema/current') {
        // Server has a DIFFERENT schema (one fewer cap).
        return jsonRes(200, {
          version: 5,
          version_tag: '0.1.0',
          capabilities: [{ name: 'olam:world.read' }],
          archetypes: [
            { name: 'olam:user', capabilities: ['olam:world.read'] },
          ],
          pushed_by: 'someone@acme.com',
          pushed_at: 1700000000000,
        });
      }
      return jsonRes(404, {});
    });

    try {
      await prepareSchema({ app: 'olam', source: file, check: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CheckDiffError);
      expect((err as PylonCliError).exitCode).toBe(12);
      // Diff was written to stdout before the throw.
      const out = stdoutBuf.join('');
      expect(out).toMatch(/schema drift/);
      expect(out).toMatch(/^[+\- ] /m);
    }
  });

  it('throws NotLoggedInError (exit 7) when no session JWT for the org', async () => {
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, validBareYaml);
    // No writeSession call — keyring is empty.

    try {
      await prepareSchema({ app: 'olam', source: file, check: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotLoggedInError);
      expect((err as PylonCliError).exitCode).toBe(7);
    }
  });

  it('PYLON_SESSION_TOKEN env-var bypasses keyring and proceeds to fetch (closes T7 doc gap)', async () => {
    // adv-006: T7 boundary is JWT-only, not interactive-only. A CI
    // exporting PYLON_SESSION_TOKEN should be able to use --check.
    const file = join(tmp, 'schema.yaml');
    writeFileSync(file, validBareYaml);
    // Keyring stays empty; env supplies the JWT.
    const origToken = process.env['PYLON_SESSION_TOKEN'];
    process.env['PYLON_SESSION_TOKEN'] = 'session-jwt-from-env';
    try {
      let sawAuthHeader: string | undefined;
      setFetchImpl(async (url, init) => {
        const u = new URL(url as string);
        if (u.pathname === '/apps/olam/schema/current') {
          sawAuthHeader = (init?.headers as Record<string, string> | undefined)?.[
            'Authorization'
          ];
          return jsonRes(200, {
            version: 1,
            version_tag: '0.1.0',
            capabilities: [
              { name: 'olam:world.read' },
              { name: 'olam:world.write' },
            ],
            archetypes: [
              {
                name: 'olam:user',
                capabilities: ['olam:world.read', 'olam:world.write'],
              },
            ],
            pushed_by: 'env-ci@acme.com',
            pushed_at: 1700000000000,
          });
        }
        return jsonRes(404, {});
      });

      const result = await prepareSchema({
        app: 'olam',
        source: file,
        check: true,
      });
      expect(result.mode).toBe('check');
      if (result.mode !== 'check') return;
      expect(result.status).toBe('match');
      expect(sawAuthHeader).toBe('Bearer session-jwt-from-env');
    } finally {
      if (origToken === undefined) delete process.env['PYLON_SESSION_TOKEN'];
      else process.env['PYLON_SESSION_TOKEN'] = origToken;
    }
  });
});

describe('prepareSchema — flag combinations', () => {
  it('rejects --out and --check together (mutually exclusive)', async () => {
    // adv-003: silently dropping --out when --check is set would lose
    // user intent. The combination is now rejected explicitly.
    const file = join(tmp, 'schema.yaml');
    const out = join(tmp, 'prepared.json');
    writeFileSync(file, validBareYaml);

    try {
      await prepareSchema({
        app: 'olam',
        source: file,
        out,
        check: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSourceError);
      expect((err as PylonCliError).exitCode).toBe(11);
      expect((err as Error).message).toMatch(/mutually exclusive/);
    }
  });

  it('error messages JSON.stringify user-supplied paths (no terminal injection)', async () => {
    // adv-001: control chars in --source path must render as escape
    // sequences in the error message, not as literal terminal codes.
    const evilPath = join(tmp, 'has\x1b[2Jcontrol-chars.yaml');
    try {
      await prepareSchema({ app: 'olam', source: evilPath });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      // Raw clear-screen byte must NOT appear in the message verbatim;
      // it should be JSON-escaped inside the quoted path.
      expect(msg).not.toContain('\x1b[2J');
      // The quoted form of the path should appear instead.
      expect(msg).toMatch(/cannot read "/);
    }
  });
});
