import { expect, type Page } from "@playwright/test";

/**
 * The single admin account the wizard creates; later specs reuse its session.
 * NB: the TLD must be all letters — better-auth's sign-up validation rejects
 * digit-containing TLDs (".e2e") with "[body.email] Invalid email address".
 */
export const ADMIN = {
  name: "E2E Admin",
  email: "admin@subshell.test",
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

/**
 * The name the server gave the subshell created most recently.
 *
 * The launch form stopped asking for a name (2026-09-11): the server names a
 * subshell after its start time and renaming is its own act, so a spec that
 * needs to address a row by its accessible name ("Actions for <name>") asks
 * what the name IS rather than choosing it up front.
 *
 * "Most recently" is unambiguous here because `playwright.config.ts` pins
 * `workers: 1` and `fullyParallel: false` — one spec touches the instance at a
 * time — and `GET /api/subshells` returns `createdAt` descending.
 */
export async function newestSubshellName(page: Page): Promise<string> {
  const res = await page.request.get("/api/subshells");
  expect(res.ok()).toBe(true);
  // The route answers a BARE array (`t.Array(SubshellSchema)`), not an envelope.
  const subshells = (await res.json()) as { name: string }[];
  expect(subshells.length).toBeGreaterThan(0);
  return subshells[0].name;
}

/**
 * Renames the subshell whose detail page is open, through the header's
 * in-place editor — the affordance that became the ONLY way to name a
 * subshell when the launch form stopped asking (2026-09-11).
 *
 * Specs use it for the reason they used to type a name into the form: a
 * unique, self-chosen label to address the row by. The default the server
 * applies is minute-granular, so two attempts of the same test can otherwise
 * share a name and make every `Actions for <name>` locator ambiguous.
 */
export async function renameSubshell(page: Page, name: string): Promise<void> {
  const title = page.getByRole("button", { name: "Rename subshell" });
  await title.click();
  // Button and input carry the same aria-label; only one of them is mounted.
  const input = page.getByRole("textbox", { name: "Rename subshell" });
  await input.fill(name);
  await input.press("Enter");
  await expect(title).toHaveText(name);
}
