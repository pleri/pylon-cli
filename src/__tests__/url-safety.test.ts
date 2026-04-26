import { describe, expect, it } from 'vitest';
import {
  InsecureUrlError,
  OriginMismatchError,
  requireSameOrigin,
  requireSecureUrl,
  sameOrigin,
} from '../url-safety.js';

describe('requireSecureUrl', () => {
  it('accepts https URLs', () => {
    expect(requireSecureUrl('https://pylon.example').host).toBe('pylon.example');
  });

  it('accepts http://localhost (dev loopback)', () => {
    expect(requireSecureUrl('http://localhost:8787').protocol).toBe('http:');
  });

  it('accepts http://127.0.0.1 and http://[::1]', () => {
    expect(() => requireSecureUrl('http://127.0.0.1:3000')).not.toThrow();
    expect(() => requireSecureUrl('http://[::1]:3000')).not.toThrow();
  });

  it('rejects http:// to a public host', () => {
    expect(() => requireSecureUrl('http://pylon.example')).toThrow(InsecureUrlError);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => requireSecureUrl('ftp://pylon.example')).toThrow(InsecureUrlError);
    expect(() => requireSecureUrl('file:///etc/passwd')).toThrow(InsecureUrlError);
  });
});

describe('sameOrigin', () => {
  it('true for identical origins', () => {
    expect(sameOrigin('https://pylon.example/a', 'https://pylon.example/b')).toBe(true);
  });

  it('false when hosts differ', () => {
    expect(sameOrigin('https://a.example', 'https://b.example')).toBe(false);
  });

  it('false when ports differ', () => {
    expect(sameOrigin('https://a.example:443', 'https://a.example:8443')).toBe(false);
  });

  it('false when schemes differ (even same host)', () => {
    expect(() => sameOrigin('http://pylon.example', 'https://pylon.example')).toThrow(
      InsecureUrlError,
    );
  });
});

describe('requireSameOrigin', () => {
  it('passes when origins match', () => {
    expect(() =>
      requireSameOrigin('https://pylon.example', 'https://pylon.example/whatever', 'test'),
    ).not.toThrow();
  });

  it('throws OriginMismatchError on cross-origin', () => {
    expect(() =>
      requireSameOrigin('https://pylon.example', 'https://attacker.example', 'discover.api_url'),
    ).toThrow(OriginMismatchError);
  });

  it('error message identifies the context + both origins', () => {
    try {
      requireSameOrigin('https://pylon.acme', 'https://evil.co', 'discover.api_url');
      expect.fail('should have thrown');
    } catch (err) {
      if (err instanceof OriginMismatchError) {
        expect(err.message).toContain('discover.api_url');
        expect(err.message).toContain('pylon.acme');
        expect(err.message).toContain('evil.co');
      }
    }
  });
});
