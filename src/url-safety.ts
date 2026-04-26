/**
 * URL safety helpers.
 *
 * The CLI moves a session JWT across the network and trusts server
 * responses to tell it where to send that session. Two rules keep
 * that honest:
 *
 *   1. HTTPS required for non-loopback targets. http:// to a
 *      public host would leak the session on first transit.
 *   2. Server-supplied URLs (from `/discover`, from `/device/init`'s
 *      `verification_url`) must be same-origin as the URL we
 *      actually reached. A compromised or spoofed Pylon that returns
 *      `api_url: https://attacker.com` would otherwise trick us into
 *      persisting attacker-controlled routing in the config.
 *
 * The check is origin-level (scheme + host + port); path differences
 * are fine, port differences are not (they're a different origin).
 */

export class InsecureUrlError extends Error {
  constructor(url: string) {
    super(
      `Refusing to use insecure URL "${url}" — HTTPS is required for non-loopback hosts. ` +
        `Only http://localhost, http://127.0.0.1, and http://[::1] are allowed for dev.`,
    );
    this.name = 'InsecureUrlError';
  }
}

export class OriginMismatchError extends Error {
  constructor(expected: string, actual: string, context: string) {
    super(
      `${context}: expected same origin as ${expected}, got ${actual}. ` +
        `Refusing to trust a server-supplied URL from a different origin.`,
    );
    this.name = 'OriginMismatchError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Throw if the URL is http:// to a non-loopback host. Pass through
 * otherwise. Returns the parsed URL for convenience.
 */
export function requireSecureUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed;
  }
  throw new InsecureUrlError(url);
}

/**
 * Compare two URLs as origins (scheme + host + port). Returns
 * true only if they match. Throws `InsecureUrlError` if either
 * URL fails the HTTPS check — malformed or insecure URLs can't
 * be trusted to compare.
 */
export function sameOrigin(a: string, b: string): boolean {
  const ua = requireSecureUrl(a);
  const ub = requireSecureUrl(b);
  return ua.protocol === ub.protocol && ua.host === ub.host;
}

/**
 * Assert the server-supplied URL shares an origin with the URL we
 * actually reached. Otherwise: throw so the CLI bails out loudly
 * rather than silently trusting a spoofed redirect.
 */
export function requireSameOrigin(
  reached: string,
  supplied: string,
  context: string,
): void {
  if (!sameOrigin(reached, supplied)) {
    throw new OriginMismatchError(reached, supplied, context);
  }
}
