/**
 * HTTP client tests — fetch is injected via `setFetchImpl` so
 * nothing hits a real Pylon.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  appRegister,
  deviceInit,
  devicePoll,
  discover,
  normaliseBaseUrl,
  resetFetchImpl,
  roleGrant,
  setFetchImpl,
  whoami,
} from '../http.js';
import { DiscoveryError, PylonHttpError } from '../errors.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetFetchImpl();
});

describe('normaliseBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normaliseBaseUrl('https://pylon.x/')).toBe('https://pylon.x');
  });
  it('adds https scheme when missing', () => {
    expect(normaliseBaseUrl('pylon.x')).toBe('https://pylon.x');
  });
});

describe('discover', () => {
  it('returns the discovery payload on 200', async () => {
    setFetchImpl(async (url) => {
      expect(String(url)).toBe('https://pylon.acme/discover');
      return jsonResponse(200, {
        id: 'acme',
        name: 'Acme',
        api_url: 'https://pylon.acme',
      });
    });
    const r = await discover('https://pylon.acme');
    expect(r.id).toBe('acme');
  });

  it('throws DiscoveryError on network failure', async () => {
    setFetchImpl(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(discover('https://pylon.nowhere')).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('throws DiscoveryError on non-200', async () => {
    setFetchImpl(async () => new Response('nope', { status: 404 }));
    await expect(discover('https://pylon.acme')).rejects.toBeInstanceOf(DiscoveryError);
  });

  // ── shape validation ────────────────────────────────────────
  it('rejects a response missing `id`', async () => {
    setFetchImpl(async () =>
      jsonResponse(200, { name: 'Acme', api_url: 'https://pylon.acme' }),
    );
    await expect(discover('https://pylon.acme')).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('rejects an `id` that is not a valid slug', async () => {
    setFetchImpl(async () =>
      jsonResponse(200, { id: 'Acme Co!', name: 'Acme', api_url: 'https://pylon.acme' }),
    );
    await expect(discover('https://pylon.acme')).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('rejects a response missing `name`', async () => {
    setFetchImpl(async () =>
      jsonResponse(200, { id: 'acme', api_url: 'https://pylon.acme' }),
    );
    await expect(discover('https://pylon.acme')).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('rejects a response with non-string `api_url`', async () => {
    setFetchImpl(async () => jsonResponse(200, { id: 'acme', name: 'Acme', api_url: 42 }));
    await expect(discover('https://pylon.acme')).rejects.toBeInstanceOf(DiscoveryError);
  });

  // ── cross-origin defence ────────────────────────────────────
  it('rejects an api_url that is cross-origin with the URL we reached', async () => {
    setFetchImpl(async () =>
      jsonResponse(200, {
        id: 'acme',
        name: 'Acme',
        api_url: 'https://attacker.example',
      }),
    );
    await expect(discover('https://pylon.acme')).rejects.toThrow(/same origin/i);
  });

  // ── insecure URL rejection ──────────────────────────────────
  it('rejects http:// input to a non-loopback host before even fetching', async () => {
    // fetch is never called — the safety layer catches it at normaliseBaseUrl.
    setFetchImpl(async () => {
      throw new Error('should not have been called');
    });
    await expect(discover('http://pylon.acme')).rejects.toThrow(/HTTPS is required/);
  });

  it('accepts http://localhost for dev', async () => {
    setFetchImpl(async () =>
      jsonResponse(200, {
        id: 'dev',
        name: 'Dev',
        api_url: 'http://localhost:8787',
      }),
    );
    const r = await discover('http://localhost:8787');
    expect(r.id).toBe('dev');
  });

  // ── redirect defence ────────────────────────────────────────
  it('refuses to follow a 3xx from /discover', async () => {
    // Cross-origin redirect to attacker: fetch with redirect:manual
    // returns the redirect status directly, we must refuse.
    setFetchImpl(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/discover' },
      }),
    );
    await expect(discover('https://pylon.acme')).rejects.toThrow(/redirect/i);
  });

  // ── URL validation ──────────────────────────────────────────
  it('rejects userinfo in the URL', async () => {
    setFetchImpl(async () => {
      throw new Error('should not be called');
    });
    await expect(discover('https://attacker@pylon.acme')).rejects.toThrow(
      /userinfo|Invalid URL|Malformed/,
    );
  });

  it('strips paths / queries before fetching /discover', async () => {
    setFetchImpl(async (url) => {
      // Must normalise to `https://pylon.acme/discover` regardless
      // of what the user typed.
      expect(String(url)).toBe('https://pylon.acme/discover');
      return jsonResponse(200, {
        id: 'acme',
        name: 'Acme',
        api_url: 'https://pylon.acme',
      });
    });
    await discover('https://pylon.acme/some/path?x=1');
  });
});

describe('deviceInit', () => {
  it('posts client + org_id and returns the payload', async () => {
    setFetchImpl(async (url, init) => {
      expect(String(url)).toBe('https://pylon.acme/device/init');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ client: 'pylon-cli', org_id: 'acme' });
      return jsonResponse(200, {
        device_code: 'dev-code',
        user_code: 'ABC-123',
        verification_url: 'https://pylon.acme/device',
        expires_in: 300,
        interval: 5,
      });
    });
    const r = await deviceInit('https://pylon.acme', { client: 'pylon-cli', org_id: 'acme' });
    expect(r.user_code).toBe('ABC-123');
  });

  it('propagates server errors via PylonHttpError', async () => {
    setFetchImpl(async () => jsonResponse(500, { error: 'boom' }));
    await expect(
      deviceInit('https://pylon.acme', { client: 'pylon-cli' }),
    ).rejects.toMatchObject({ status: 500, message: expect.stringContaining('boom') });
  });
});

describe('devicePoll', () => {
  it('returns pending while authorisation incomplete', async () => {
    setFetchImpl(async (url) => {
      expect(String(url)).toContain('device_code=abc');
      return jsonResponse(200, { status: 'pending' });
    });
    const r = await devicePoll('https://pylon.acme', 'abc');
    expect(r.status).toBe('pending');
  });

  it('returns authorised with session_jwt when done', async () => {
    setFetchImpl(async () =>
      jsonResponse(200, { status: 'authorised', session_jwt: 'jwt-xyz' }),
    );
    const r = await devicePoll('https://pylon.acme', 'abc');
    expect(r.status).toBe('authorised');
    expect(r.session_jwt).toBe('jwt-xyz');
  });

  it('sets redirect: manual so a gateway intercept is visible', async () => {
    let capturedInit: RequestInit | undefined;
    setFetchImpl(async (_url, init) => {
      capturedInit = init;
      return jsonResponse(200, { status: 'pending' });
    });
    await devicePoll('https://pylon.acme', 'abc');
    expect(capturedInit?.redirect).toBe('manual');
  });

  it('gives a gateway-intercept error when CF Access returns 302 to SSO', async () => {
    // Reproduces the real "Unexpected token '<'" CLI crash: a
    // Cloudflare Access policy gates /device/poll and answers with
    // a 302 to the identity provider. Without manual redirects the
    // client would follow to an HTML login page; with them we see
    // the 3xx and raise a targeted error pointing at the policy.
    setFetchImpl(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://idp.cloudflareaccess.com/login?kid=abc' },
        }),
    );
    await expect(devicePoll('https://pylon.acme', 'abc')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof PylonHttpError &&
        err.status === 302 &&
        /gateway intercept/i.test(err.message) &&
        /Cloudflare Access/.test(err.message),
    );
  });

  it('gives a gateway-intercept error when the body is HTML not JSON', async () => {
    // A gateway can also swallow the request and return an HTML
    // login page with 200. Same actionable message.
    setFetchImpl(
      async () =>
        new Response('<!DOCTYPE html><html><body>Login</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(devicePoll('https://pylon.acme', 'abc')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof PylonHttpError &&
        err.status === 200 &&
        /non-JSON response/i.test(err.message) &&
        /Cloudflare Access/.test(err.message),
    );
  });
});

describe('whoami', () => {
  it('sends Authorization bearer header', async () => {
    setFetchImpl(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer jwt-x');
      return jsonResponse(200, {
        email: 'user@co',
        org_id: 'acme',
        archetype: 'user',
        session_expires_at: 123,
      });
    });
    const r = await whoami('https://pylon.acme', 'jwt-x');
    expect(r.email).toBe('user@co');
  });
});

describe('appRegister', () => {
  it('posts name + owner + description', async () => {
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('my-mcp');
      expect(body.owner).toBe('eng@co');
      expect(body.description).toBe('test');
      return jsonResponse(200, { app_id: 'my-mcp', app_token: 'tok_XYZ' });
    });
    const r = await appRegister('https://pylon.acme', 'jwt', {
      name: 'my-mcp',
      owner: 'eng@co',
      description: 'test',
    });
    expect(r.app_id).toBe('my-mcp');
    expect(r.app_token).toBe('tok_XYZ');
  });
});

describe('roleGrant', () => {
  it('posts email + app_id + archetype + capabilities', async () => {
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        email: 'alice@co',
        app_id: 'my-mcp',
        archetype: 'admin',
        capabilities: ['my-mcp:extra'],
      });
      return jsonResponse(200, {
        email_hash: 'a'.repeat(64),
        app_id: 'my-mcp',
        archetype: 'admin',
      });
    });
    const r = await roleGrant('https://pylon.acme', 'jwt', {
      email: 'alice@co',
      app_id: 'my-mcp',
      archetype: 'admin',
      capabilities: ['my-mcp:extra'],
    });
    expect(r.email_hash).toHaveLength(64);
  });
});

describe('PylonHttpError shape', () => {
  it('carries status and extracted error message', async () => {
    setFetchImpl(async () => jsonResponse(403, { error: 'denied' }));
    try {
      await whoami('https://pylon.acme', 'jwt');
    } catch (err) {
      expect(err).toBeInstanceOf(PylonHttpError);
      if (err instanceof PylonHttpError) {
        expect(err.status).toBe(403);
        expect(err.message).toContain('denied');
      }
    }
  });
});
