/**
 * The single admin account the wizard creates; later specs reuse its session.
 * NB: the TLD must be all letters — better-auth's sign-up validation rejects
 * digit-containing TLDs (".e2e") with "[body.email] Invalid email address".
 */
export const ADMIN = {
  name: "E2E Admin",
  email: "admin@mote.test",
  password: "e2e-admin-pass-1",
} as const;

/**
 * Storage-state handoff: spec 01 writes it, 02–07 load it via test.use.
 * Resolved against THIS module's URL so it is absolute regardless of the
 * process CWD — Playwright resolves relative storageState paths against the
 * CWD, so a plain ".auth/admin.json" would drift when the config is invoked
 * from outside e2e/ (e.g. a manual `playwright test --config
 * e2e/playwright.config.ts` from the repo root). The URL here and the
 * rm/mkdir in global-setup.ts both anchor to e2e/, so writer and reader
 * always share one file.
 */
export const ADMIN_STATE = new URL("../.auth/admin.json", import.meta.url).pathname;
