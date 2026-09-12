import { expect, type Locator, type Page } from "@playwright/test";

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

/** Every subshell id the signed-in user can see right now. */
export async function subshellIds(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/subshells");
  expect(res.ok()).toBe(true);
  // The route answers a BARE array (`t.Array(SubshellSchema)`), not an envelope.
  return ((await res.json()) as { id: string }[]).map((s) => s.id);
}

/**
 * The name the server gave the subshell that appeared since `before` was
 * sampled — waiting for it, because a launch returns after a real tmux spawn.
 *
 * The launch form stopped asking for a name (2026-09-11): the server names a
 * subshell after its start time. A spec with a detail page in front of it
 * should call {@link renameSubshell} instead and keep addressing the row by a
 * name it chose; this is for the one path that never opens one.
 */
export async function newSubshellName(page: Page, before: string[], timeout = 30_000): Promise<string> {
  let name = "";
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/subshells");
        if (!res.ok()) return 0;
        const fresh = ((await res.json()) as { id: string; name: string }[]).filter((s) => !before.includes(s.id));
        name = fresh[0]?.name ?? "";
        return fresh.length;
      },
      { timeout },
    )
    .toBeGreaterThan(0);
  return name;
}

/**
 * Renames the subshell whose detail page is open, to a name the caller chose.
 *
 * Specs use it for the reason they used to type a name into the launch form,
 * which stopped asking (2026-09-11): a unique, self-chosen label to address
 * the row by. The server's own default is minute-granular, so two attempts of
 * the same test can otherwise share a name and make every `Actions for <name>`
 * locator ambiguous.
 *
 * Both layouts are covered because the product has two: wide, the header
 * title edits in place; below the tiling breakpoint it is display-only text
 * and the rename is the actions menu's "Edit title" dialog.
 */
export async function renameSubshell(page: Page, name: string): Promise<void> {
  // Present in both layouts — waiting on it means the header has rendered, so
  // the inline editor's absence below is a layout fact rather than a race.
  const actions = page.getByRole("button", { name: /^Actions for / }).first();
  await actions.waitFor();
  const inline = page.getByRole("button", { name: "Rename subshell" });
  if (await inline.isVisible()) {
    await inline.click();
    // Button and input carry the same aria-label; only one is ever mounted.
    const field = page.getByRole("textbox", { name: "Rename subshell" });
    await field.fill(name);
    await field.press("Enter");
    await expect(inline).toHaveText(name);
    return;
  }
  await actions.click();
  await page.getByRole("menuitem", { name: "Edit title" }).click();
  await page.getByRole("textbox", { name: "New subshell title" }).fill(name);
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

/**
 * Opens the launch form's profile picker, after waiting for the form to finish
 * filling ITSELF in.
 *
 * The form auto-selects the first launchable profile and pre-fills the working
 * directory from the node's recents, each when its own query lands. Opening
 * the picker before that arrives means the selection changes while the popup
 * is open: Base UI syncs the input's text to the new selection, that text is
 * also the filter query, and every other option detaches from the DOM — so a
 * click retries against an element that never comes back, until the test times
 * out. It fires exactly when the machine is FAST, which is why CI liked it and
 * a laptop did not.
 *
 * Waiting for the auto-selected value settles it: with the form at rest, the
 * open list is the full one and stays that way.
 */
export async function openProfilePicker(input: Locator): Promise<void> {
  await expect(input).not.toHaveValue("");
  await input.click();
}

/** {@link openProfilePicker}, then choose one by its exact label. */
export async function pickProfile(input: Locator, label: string): Promise<void> {
  await openProfilePicker(input);
  await input.page().getByRole("option", { name: label, exact: true }).click();
}
