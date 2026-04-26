/**
 * Keyring tests — use an injected in-memory backend so we never
 * hit the real OS keyring. The env-var override path is exercised
 * explicitly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSession,
  readSession,
  setKeyringBackend,
  writeSession,
  type KeyringBackend,
} from '../keyring.js';

function memoryBackend(): KeyringBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get(service, account) {
      return store.get(`${service}:${account}`) ?? null;
    },
    set(service, account, password) {
      store.set(`${service}:${account}`, password);
    },
    delete(service, account) {
      return store.delete(`${service}:${account}`);
    },
  };
}

let original: string | undefined;

beforeEach(() => {
  original = process.env['PYLON_SESSION_TOKEN'];
  delete process.env['PYLON_SESSION_TOKEN'];
  setKeyringBackend(memoryBackend());
});

afterEach(() => {
  setKeyringBackend(null);
  if (original === undefined) delete process.env['PYLON_SESSION_TOKEN'];
  else process.env['PYLON_SESSION_TOKEN'] = original;
});

describe('keyring — in-memory backend', () => {
  it('write then read returns the stored value', async () => {
    await writeSession('acme', 'jwt-abc');
    expect(await readSession('acme')).toBe('jwt-abc');
  });

  it('read returns null when no entry', async () => {
    expect(await readSession('acme')).toBeNull();
  });

  it('write replaces prior value', async () => {
    await writeSession('acme', 'jwt-old');
    await writeSession('acme', 'jwt-new');
    expect(await readSession('acme')).toBe('jwt-new');
  });

  it('delete returns true when entry existed', async () => {
    await writeSession('acme', 'jwt-abc');
    expect(await deleteSession('acme')).toBe(true);
    expect(await readSession('acme')).toBeNull();
  });

  it('delete returns false when no entry', async () => {
    expect(await deleteSession('acme')).toBe(false);
  });

  it('keys by org — two orgs are independent', async () => {
    await writeSession('acme', 'jwt-acme');
    await writeSession('beta', 'jwt-beta');
    expect(await readSession('acme')).toBe('jwt-acme');
    expect(await readSession('beta')).toBe('jwt-beta');
  });
});

describe('keyring — PYLON_SESSION_TOKEN env override', () => {
  it('env value wins over keyring contents', async () => {
    await writeSession('acme', 'from-keyring');
    process.env['PYLON_SESSION_TOKEN'] = 'from-env';
    expect(await readSession('acme')).toBe('from-env');
  });

  it('env value applies to any orgId', async () => {
    process.env['PYLON_SESSION_TOKEN'] = 'single-env-token';
    expect(await readSession('acme')).toBe('single-env-token');
    expect(await readSession('beta')).toBe('single-env-token');
  });

  it('env value ignored when empty string', async () => {
    await writeSession('acme', 'keyring-value');
    process.env['PYLON_SESSION_TOKEN'] = '';
    expect(await readSession('acme')).toBe('keyring-value');
  });
});
