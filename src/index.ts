/**
 * Library entry — re-export every command + supporting module so
 * tests and potential SDK integrations can import from
 * `@pleri/pylon-cli` instead of reaching into subpaths.
 */

export { login, type LoginOptions, type LoginResult } from './commands/login.js';
export { logout, type LogoutOptions, type LogoutResult } from './commands/logout.js';
export { forget, type ForgetOptions, type ForgetResult } from './commands/forget.js';
export { whoami, type WhoamiOptions, type WhoamiResult } from './commands/whoami.js';
export { use, type UseOptions, type UseResult } from './commands/use.js';
export {
  registerApp,
  type AppRegisterOptions,
  type AppRegisterResult,
} from './commands/app-register.js';
export {
  listApps,
  type AppListOptions,
  type AppListResult,
} from './commands/app-list.js';
export {
  disableApp,
  type AppDisableOptions,
  type AppDisableResult,
} from './commands/app-disable.js';
export {
  grantRole,
  type RoleGrantOptions,
  type RoleGrantResult,
} from './commands/role-grant.js';
export {
  listRoles,
  type RoleListOptions,
  type RoleListResult,
} from './commands/role-list.js';
export {
  revokeRole,
  type RoleRevokeOptions,
  type RoleRevokeResult,
} from './commands/role-revoke.js';
export {
  tailAudit,
  type AuditTailOptions,
  type AuditTailResult,
} from './commands/audit-tail.js';

export * as config from './config.js';
export * as keyring from './keyring.js';
export * as http from './http.js';
export * from './errors.js';
