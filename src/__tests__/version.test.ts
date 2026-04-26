import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, '../../package.json');
const BIN_PATH = join(__dirname, '../../dist/bin.js');

describe('pylon --version', () => {
  it('matches package.json version (regression: v0.1.0 shipped reporting 0.0.1)', () => {
    if (!existsSync(BIN_PATH)) {
      throw new Error(
        `dist/bin.js not found at ${BIN_PATH}. Run \`pnpm build\` before \`pnpm test\`.`,
      );
    }

    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string };
    const out = execFileSync(process.execPath, [BIN_PATH, '--version'], {
      encoding: 'utf8',
    }).trim();

    expect(out).toBe(pkg.version);
  });
});
