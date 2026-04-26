/**
 * Typed errors for the CLI.
 *
 * Every error carries a stable `exitCode` so the top-level
 * `bin.ts` can translate to a non-zero process exit without
 * re-parsing messages. Exit codes mirror ADR 003 §"Error paths".
 */

export class PylonCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'PylonCliError';
  }
}

export class NoOrgSpecifiedError extends PylonCliError {
  constructor() {
    super(
      'No org specified. Pass --org=<id>, --org-url=<url>, or set PYLON_ORG_ID/PYLON_ORG_URL.',
      2,
    );
    this.name = 'NoOrgSpecifiedError';
  }
}

export class DiscoveryError extends PylonCliError {
  constructor(url: string, reason: string) {
    super(`No Pylon reachable at ${url}: ${reason}`, 3);
    this.name = 'DiscoveryError';
  }
}

export class DeviceAuthExpiredError extends PylonCliError {
  constructor() {
    super('Device authorisation expired — please run `pylon login` again.', 4);
    this.name = 'DeviceAuthExpiredError';
  }
}

export class KeyringError extends PylonCliError {
  constructor(reason: string) {
    super(`Could not access OS keyring: ${reason}`, 5);
    this.name = 'KeyringError';
  }
}

export class PylonHttpError extends PylonCliError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`Pylon returned ${status}: ${message}`, 6);
    this.name = 'PylonHttpError';
  }
}

export class NotLoggedInError extends PylonCliError {
  constructor(orgId: string) {
    super(
      `No active session for org "${orgId}". Run \`pylon login --org=${orgId}\`.`,
      7,
    );
    this.name = 'NotLoggedInError';
  }
}

export class UnpreparedInputError extends PylonCliError {
  constructor(detail: string) {
    super(`unprepared_input: ${detail}`, 10);
    this.name = 'UnpreparedInputError';
  }
}

export class InvalidSourceError extends PylonCliError {
  constructor(reason: string) {
    super(`invalid_source: ${reason}`, 11);
    this.name = 'InvalidSourceError';
  }
}

export class CheckDiffError extends PylonCliError {
  constructor(reason: string) {
    super(`check_diff: ${reason}`, 12);
    this.name = 'CheckDiffError';
  }
}
