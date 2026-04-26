#!/usr/bin/env node
/**
 * `pylon` — the binary entrypoint.
 *
 * Commander wiring. All logic lives in `commands/*`; this file is
 * just argument-parsing + output formatting + error → exit-code
 * translation.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { forget } from './commands/forget.js';
import { whoami } from './commands/whoami.js';
import { use } from './commands/use.js';
import { registerApp } from './commands/app-register.js';
import { listApps } from './commands/app-list.js';
import { disableApp } from './commands/app-disable.js';
import { grantRole } from './commands/role-grant.js';
import { listRoles } from './commands/role-list.js';
import { revokeRole } from './commands/role-revoke.js';
import { tailAudit } from './commands/audit-tail.js';
import { pushSchema } from './commands/schema-push.js';
import { prepareSchema } from './commands/schema-prepare.js';
import { getCurrentSchema } from './commands/schema-current.js';
import { listSchemaVersions } from './commands/schema-list.js';
import { approveSchema } from './commands/schema-approve.js';
import { PylonCliError } from './errors.js';

// Resolve package.json relative to this file. Works in all 3 layouts:
//   src/bin.ts                                → ../package.json  (vitest)
//   dist/bin.js                               → ../package.json  (local build)
//   node_modules/@pleri/pylon-cli/dist/bin.js → ../package.json  (installed)
const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8',
  ),
) as { version: string };

const program = new Command();

program
  .name('pylon')
  .description('Pylon — centralised RBAC + identity for MCP servers')
  .version(pkg.version);

// ── login ───────────────────────────────────────────────────────
program
  .command('login')
  .description('Authenticate against a Pylon org via device-code flow')
  .option('--org <id>', 'Org id (slug). Takes precedence over other resolvers.')
  .option('--org-url <url>', 'Org URL — resolved to id via /discover. Use on first login.')
  .option('--browser', '(not yet implemented) use browser redirect instead of device code')
  .option('--replace', 'Overwrite an existing config binding for this URL (ADR 004 pillar 4).')
  .action(async (opts) => {
    const result = await login({
      ...(opts.org ? { org: opts.org } : {}),
      ...(opts.orgUrl ? { orgUrl: opts.orgUrl } : {}),
      ...(opts.browser ? { browser: true } : {}),
      ...(opts.replace ? { replace: true } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `\n  ✓ logged in as ${result.email}\n` +
        `    org:     ${result.orgId}\n` +
        `    api:     ${result.apiUrl}\n` +
        `    expires: ${new Date(result.sessionExpiresAt).toISOString()}`,
    );
  });

// ── logout ──────────────────────────────────────────────────────
program
  .command('logout')
  .description('Remove the stored session for an org')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await logout({ ...(opts.org ? { org: opts.org } : {}) });
    // eslint-disable-next-line no-console
    console.log(
      result.removed
        ? `  ✓ logged out of ${result.orgId}`
        : `  (no session found for ${result.orgId})`,
    );
  });

// ── forget ──────────────────────────────────────────────────────
program
  .command('forget')
  .description('Remove an org from local state entirely (config + session). Recovery path for URL-repurposed or trust-anchor-changed orgs.')
  .requiredOption('--org <id>', 'Org id to forget')
  .action(async (opts) => {
    const result = await forget({ org: opts.org });
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ forgot ${result.orgId}` +
        `\n    config:  ${result.removedFromConfig ? 'removed' : 'unchanged'}` +
        `\n    session: ${result.removedSession ? 'cleared from keyring' : 'no entry to clear'}`,
    );
  });

// ── whoami ──────────────────────────────────────────────────────
program
  .command('whoami')
  .description('Show the active session and its archetype')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await whoami({ ...(opts.org ? { org: opts.org } : {}) });
    // eslint-disable-next-line no-console
    console.log(
      `  ${result.email}\n` +
        `    org:       ${result.orgId}\n` +
        `    archetype: ${result.archetype}\n` +
        `    expires:   ${new Date(result.sessionExpiresAt).toISOString()}`,
    );
  });

// ── use ─────────────────────────────────────────────────────────
program
  .command('use')
  .description('Switch the default org for subsequent commands')
  .requiredOption('--org <id>', 'Org id to make default')
  .action((opts) => {
    const result = use({ org: opts.org });
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ default org → ${result.orgId}` +
        (result.previousDefault ? ` (was ${result.previousDefault})` : ''),
    );
  });

// ── app namespace ───────────────────────────────────────────────
const app = program.command('app').description('Manage Pylon-enrolled apps');

app
  .command('register')
  .description('Enrol a new MCP into Pylon')
  .requiredOption('--name <name>', 'Human-readable app name (also used as slug)')
  .requiredOption('--owner <email>', 'Email of the engineer who owns this app')
  .option('--description <text>', 'Short description shown in admin UI')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await registerApp({
      name: opts.name,
      owner: opts.owner,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.org ? { org: opts.org } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `\n  ✓ app registered in ${result.orgId}\n` +
        `    appId:    ${result.appId}\n` +
        `    appToken: ${result.appToken}\n\n` +
        `  ⚠ Save the appToken now — it is NOT retrievable later.\n` +
        `    Deliver it to the engineer securely (1Password / encrypted email / etc.).`,
    );
  });

app
  .command('list')
  .description('List enrolled MCPs for the current org')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await listApps({ ...(opts.org ? { org: opts.org } : {}) });
    if (result.apps.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`  (no apps enrolled in ${result.orgId})`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`  ${result.apps.length} app(s) in ${result.orgId}:\n`);
    for (const a of result.apps) {
      // eslint-disable-next-line no-console
      console.log(
        `    ${a.app_id.padEnd(24)} ${a.status.padEnd(10)} owner: ${a.owner}`,
      );
    }
  });

app
  .command('disable')
  .description('Mark an app as disabled — /token will refuse to mint for it')
  .requiredOption('--id <appId>', 'App id to disable')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await disableApp({
      id: opts.id,
      ...(opts.org ? { org: opts.org } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ app "${result.appId}" status: ${result.status}\n` +
        `    (scoped tokens already issued remain valid until their 30s TTL)`,
    );
  });

// ── role namespace ──────────────────────────────────────────────
const role = program.command('role').description('Manage per-app user roles');

role
  .command('grant')
  .description('Grant (or overwrite) a user\'s role for an app')
  .requiredOption('--email <email>', 'User email (hashed client-side by Pylon)')
  .requiredOption('--app <appId>', 'App id (slug)')
  .requiredOption('--archetype <name>', 'Archetype to grant, e.g. admin / user')
  .option(
    '--capability <name>',
    'Additive capability on top of the archetype (repeatable)',
    (val: string, prev: string[] = []) => [...prev, val],
    [],
  )
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await grantRole({
      email: opts.email,
      app: opts.app,
      archetype: opts.archetype,
      ...(opts.capability && opts.capability.length > 0
        ? { capability: opts.capability as string[] }
        : {}),
      ...(opts.org ? { org: opts.org } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ role granted\n` +
        `    app:       ${result.appId}\n` +
        `    archetype: ${result.archetype}\n` +
        `    hash:      ${result.emailHash.slice(0, 12)}…`,
    );
  });

role
  .command('list')
  .description('List role grants for an app (opaque sha256 hashes)')
  .requiredOption('--app <appId>', 'App id (slug)')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await listRoles({
      app: opts.app,
      ...(opts.org ? { org: opts.org } : {}),
    });
    if (result.roles.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`  (no roles granted for app "${result.appId}")`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`  ${result.roles.length} role(s) for ${result.appId}:\n`);
    for (const r of result.roles) {
      // eslint-disable-next-line no-console
      console.log(
        `    ${r.email_hash.slice(0, 12)}…  ${r.archetype.padEnd(20)}` +
          (r.granted_by ? ` by: ${r.granted_by}` : ''),
      );
    }
  });

role
  .command('revoke')
  .description('Revoke a role by its 64-char sha256 email hash')
  .requiredOption('--app <appId>', 'App id (slug)')
  .requiredOption('--email-hash <hash>', '64-char hex sha256 of the target email')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await revokeRole({
      app: opts.app,
      emailHash: opts.emailHash,
      ...(opts.org ? { org: opts.org } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ role revoked for app "${result.appId}"\n` +
        `    hash:    ${result.emailHash.slice(0, 12)}…\n` +
        `    (the user's cached scoped tokens remain valid for up to 30s)`,
    );
  });

// ── audit namespace ─────────────────────────────────────────────
const audit = program.command('audit').description('Query the append-only audit log');

audit
  .command('tail')
  .description('Return recent audit entries, optionally filtered')
  .option('--limit <n>', 'Max entries (1-1000, default 100)', (v) => Number(v))
  .option('--since <epoch_ms>', 'Only entries with ts >= this', (v) => Number(v))
  .option(
    '--action <name>',
    'Filter: bootstrap.consumed | app.registered | app.disabled | app.token_rotated | role.granted | role.revoked | schema.pushed | schema.approved',
  )
  .option('--cursor <value>', 'Pagination cursor from a prior call')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await tailAudit({
      ...(opts.limit !== undefined ? { limit: opts.limit as number } : {}),
      ...(opts.since !== undefined ? { since: opts.since as number } : {}),
      ...(opts.action ? { action: opts.action as string } : {}),
      ...(opts.cursor ? { cursor: opts.cursor as string } : {}),
      ...(opts.org ? { org: opts.org as string } : {}),
    });
    if (result.entries.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`  (no audit entries for ${result.orgId} matching your filter)`);
      return;
    }
    for (const e of result.entries) {
      const when = new Date(e.ts).toISOString();
      // eslint-disable-next-line no-console
      console.log(
        `  ${when}  ${e.action.padEnd(20)} ${e.actor}` +
          (e.target ? ` → ${e.target}` : ''),
      );
    }
    if (result.nextCursor) {
      // eslint-disable-next-line no-console
      console.log(`\n  more available — re-run with --cursor=${result.nextCursor}`);
    }
  });

// ── schema namespace ────────────────────────────────────────────
const schema = program
  .command('schema')
  .description('Manage per-app capability schemas — push, inspect, approve migrations');

schema
  .command('push')
  .description('Push a prepared schema artifact for an MCP (app-token auth)')
  .requiredOption('--app <appId>', 'App id (slug)')
  .requiredOption(
    '--file <path>',
    'Path to a prepared schema JSON file (output of `pylon schema prepare`). Use --from-source to push a bare YAML/JSON source directly.',
  )
  .option(
    '--from-source',
    'Treat --file as a bare YAML/JSON source. Runs the prepare pipeline internally (validate + prefix + sort + mark) before posting. One-shot equivalent to `prepare | push`.',
  )
  .option(
    '--app-token <token>',
    'X-Pylon-App-Token value; pass "-" to read from stdin. PREFER PYLON_APP_TOKEN env to keep long-lived secrets out of shell history.',
  )
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await pushSchema({
      app: opts.app,
      file: opts.file,
      ...(opts.appToken ? { appToken: opts.appToken } : {}),
      ...(opts.fromSource ? { fromSource: true as const } : {}),
      ...(opts.org ? { org: opts.org } : {}),
    });
    if (result.response.status === 'accepted') {
      // eslint-disable-next-line no-console
      console.log(
        `  ✓ schema accepted\n` +
          `    app:     ${result.appId}\n` +
          `    version: ${result.response.version}`,
      );
    } else {
      const r = result.response;
      // eslint-disable-next-line no-console
      console.log(
        `  ⏸  schema pending admin approval (destructive change)\n` +
          `    app:              ${result.appId}\n` +
          `    proposed version: ${r.version}\n` +
          `    current version:  ${r.current_version}\n` +
          `    destructive changes: ${r.diff.changes.length}\n\n` +
          `  Review + approve:\n` +
          `    pylon schema approve --app ${result.appId} --version ${r.version}`,
      );
    }
  });

schema
  .command('current')
  .description('Show the currently-active schema for an app')
  .requiredOption('--app <appId>', 'App id (slug)')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await getCurrentSchema({
      app: opts.app,
      ...(opts.org ? { org: opts.org } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `  version ${result.version}  (tag: ${result.version_tag})\n` +
        `  pushed by ${result.pushed_by} at ${new Date(result.pushed_at).toISOString()}\n\n` +
        `  capabilities (${result.capabilities.length}):\n` +
        result.capabilities
          .map(
            (c) =>
              `    ${c.name}${c.description ? `  — ${c.description}` : ''}`,
          )
          .join('\n') +
        `\n\n  archetypes (${result.archetypes.length}):\n` +
        result.archetypes
          .map(
            (a) =>
              `    ${a.name}\n` +
              `      caps:     [${a.capabilities.join(', ')}]` +
              (a.inherits && a.inherits.length > 0
                ? `\n      inherits: [${a.inherits.join(', ')}]`
                : ''),
          )
          .join('\n'),
    );
  });

schema
  .command('list')
  .description('List all schema versions for an app')
  .requiredOption('--app <appId>', 'App id (slug)')
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await listSchemaVersions({
      app: opts.app,
      ...(opts.org ? { org: opts.org } : {}),
    });
    if (result.versions.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`  (no schema versions yet for app "${opts.app}")`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `  ${result.versions.length} version(s)  ` +
        `current=${result.current_version ?? 'none'}  ` +
        `pending=${result.pending_version ?? 'none'}\n`,
    );
    for (const v of result.versions) {
      const marker =
        v.version === result.current_version
          ? ' ← current'
          : v.version === result.pending_version
            ? ' ← pending approval'
            : '';
      // Provenance: cli_version + source_sha256[:12]. Absent when the
      // push didn't carry a `_prepared` marker (SDK / curl / pre-0.3.0).
      const provenance = v.prepared
        ? `  prep cli=${v.prepared.cli_version} src=${v.prepared.source_sha256.slice(0, 12)}…`
        : '';
      // eslint-disable-next-line no-console
      console.log(
        `    v${v.version.toString().padEnd(4)} ${v.version_tag.padEnd(16)} ` +
          `${new Date(v.pushed_at).toISOString()}  ${v.pushed_by}${marker}${provenance}`,
      );
    }
  });

schema
  .command('prepare')
  .description(
    'Generate the canonical schema artifact (validate + prefix + sort + mark) — pure, offline, deterministic',
  )
  .requiredOption('--source <path>', 'Path to bare YAML or JSON schema file')
  .requiredOption('--app <appId>', 'App id (slug) used as namespace prefix')
  .option('--out <path>', 'Write canonical JSON to file (default: stdout)')
  .option(
    '--check',
    'Compare prepared output against the deployed schema; exit 12 on drift (requires `pylon login`)',
  )
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await prepareSchema({
      app: opts.app,
      source: opts.source,
      ...(opts.out ? { out: opts.out } : {}),
      ...(opts.check ? { check: true as const } : {}),
      ...(opts.org ? { org: opts.org } : {}),
    });
    if (result.mode === 'stdout') {
      // The wire bytes have already been written to stdout. Print a
      // status line on stderr so it doesn't pollute the piped JSON.
      process.stderr.write(
        `  ✓ prepared (${result.wireBytes} bytes, cli ${result.prepared._prepared.cli_version})\n`,
      );
    } else if (result.mode === 'out') {
      // eslint-disable-next-line no-console
      console.log(
        `  ✓ prepared\n` +
          `    app:        ${result.app}\n` +
          `    written to: ${result.outPath}\n` +
          `    bytes:      ${result.wireBytes}\n` +
          `    cli:        ${result.prepared._prepared.cli_version}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `  ✓ no drift\n` +
          `    app:             ${result.app}\n` +
          `    deployed version: ${result.currentVersion}`,
      );
    }
  });

schema
  .command('approve')
  .description('Approve a pending destructive schema migration')
  .requiredOption('--app <appId>', 'App id (slug)')
  .requiredOption('--version <n>', 'Pending version to approve', (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      throw new PylonCliError(`--version must be a positive integer (got "${v}")`, 2);
    }
    return n;
  })
  .option('--org <id>', 'Org id. Defaults to the configured default_org.')
  .action(async (opts) => {
    const result = await approveSchema({
      app: opts.app,
      version: opts.version as number,
      ...(opts.org ? { org: opts.org } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ schema approved\n` +
        `    app:     ${result.appId}\n` +
        `    version: ${result.version} (now current)\n` +
        `    roles migrated: ${result.rolesMigrated}`,
    );
  });

// ── error wrapper ───────────────────────────────────────────────
program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof PylonCliError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  if (err instanceof Error) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write('error: unknown failure\n');
  process.exit(1);
});
