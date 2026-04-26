/**
 * OS keyring abstraction for session JWTs.
 *
 * The real implementation delegates to `@napi-rs/keyring` (macOS
 * Keychain / Windows Credential Manager / Linux Secret Service).
 * The module is structured so tests can swap in an in-memory
 * implementation via `setKeyringBackend()` without loading the
 * native addon.
 *
 * Every operation also consults `PYLON_SESSION_TOKEN` env var:
 * when set, it wins over the keyring (for headless / CI /
 * container environments without an OS keyring).
 */

import { KeyringError } from './errors.js';

const SERVICE_NAME = 'pylon-cli';

export interface KeyringBackend {
  get(service: string, account: string): string | null;
  set(service: string, account: string, password: string): void;
  delete(service: string, account: string): boolean;
}

let backend: KeyringBackend | null = null;

/**
 * Load the real `@napi-rs/keyring` backend lazily. Importing at
 * module top-level would force tests to either mock the native
 * addon or load it (which fails in restricted CI). Lazy load
 * keeps the path clean.
 */
async function loadDefaultBackend(): Promise<KeyringBackend> {
  const { Entry } = await import('@napi-rs/keyring');
  return {
    get(service, account) {
      try {
        const entry = new Entry(service, account);
        return entry.getPassword();
      } catch {
        return null;
      }
    },
    set(service, account, password) {
      const entry = new Entry(service, account);
      entry.setPassword(password);
    },
    delete(service, account) {
      const entry = new Entry(service, account);
      try {
        return entry.deletePassword();
      } catch {
        return false;
      }
    },
  };
}

/** Swap the backend — used by tests. */
export function setKeyringBackend(b: KeyringBackend | null): void {
  backend = b;
}

async function ensureBackend(): Promise<KeyringBackend> {
  if (backend) return backend;
  backend = await loadDefaultBackend();
  return backend;
}

function accountKey(orgId: string): string {
  return `session:${orgId}`;
}

/**
 * Read the session JWT for an org. Precedence:
 *   1. `PYLON_SESSION_TOKEN` env var (headless override)
 *   2. OS keyring entry `pylon-cli:session:<orgId>`
 *   3. null
 */
export async function readSession(orgId: string): Promise<string | null> {
  const envOverride = process.env['PYLON_SESSION_TOKEN'];
  if (envOverride && envOverride.length > 0) return envOverride;
  const b = await ensureBackend();
  try {
    return b.get(SERVICE_NAME, accountKey(orgId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KeyringError(message);
  }
}

export async function writeSession(orgId: string, sessionJwt: string): Promise<void> {
  const b = await ensureBackend();
  try {
    b.set(SERVICE_NAME, accountKey(orgId), sessionJwt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KeyringError(message);
  }
}

/**
 * Delete the session for an org. Returns true if an entry was
 * removed, false if none existed. Env-var override sessions can't
 * be deleted (they live in the environment, not the keyring).
 */
export async function deleteSession(orgId: string): Promise<boolean> {
  const b = await ensureBackend();
  try {
    return b.delete(SERVICE_NAME, accountKey(orgId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KeyringError(message);
  }
}

export { SERVICE_NAME };
