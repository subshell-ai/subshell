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
 * Opens the launch form's AGENT picker, after waiting for the form to finish
 * filling ITSELF in.
 *
 * The form auto-defaults the agent (most recent subshell's harness when
 * usable, else the first usable non-Terminal one) and pre-fills the working
 * directory from the node's recents, each when its own query lands. Opening
 * the picker before that arrives means the selection changes while the popup
 * is open: Base UI syncs the input's text to the new selection, that text is
 * also the filter query, and every other option detaches from the DOM — so a
 * click retries against an element that never comes back, until the test times
 * out. It fires exactly when the machine is FAST, which is why CI liked it and
 * a laptop did not. (The profile picker had the same race for the same reason;
 * the auto-default just moved from the profile field to the agent field when
 * presets replaced profiles, 2026-09-13.)
 *
 * Waiting for the auto-selected value settles it: with the form at rest, the
 * open list is the full one and stays that way.
 */
export async function openAgentPicker(input: Locator): Promise<void> {
  await expect(input).not.toHaveValue("");
  await input.click();
}

/** {@link openAgentPicker}, then choose one by its exact label (plugin name). */
export async function pickAgent(input: Locator, label: string): Promise<void> {
  await openAgentPicker(input);
  await input.page().getByRole("option", { name: label, exact: true }).click();
}

/**
 * Choose a preset from the launch form's Preset select by its exact label
 * ("None" is always its first item).
 *
 * No settle wait here, unlike {@link openAgentPicker}: this is a Base UI
 * Select, not a type-to-filter combobox. Its trigger is a button, its options
 * do not filter against the trigger's text, and its value ("None" at rest) is
 * never empty — so the auto-selection race the agent picker guards has no
 * counterpart. Click the trigger, click the option.
 */
export async function pickPreset(page: Page, label: string, trigger = "#picker-preset"): Promise<void> {
  await page.locator(trigger).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/**
 * Dismiss the working-directory PANEL inside a dialog, without closing the
 * dialog itself.
 *
 * Measured on the launch dialog, 2026-09-11, because both plausible gestures
 * are wrong for one of the two overlays this form can raise:
 *
 * | overlay | Escape | click the dialog heading |
 * |---|---|---|
 * | combobox popup (agent, node) | closes the popup, dialog survives | never lands — the popup's dismiss layer covers the heading, so the click retries until the test times out |
 * | directory panel | closes the POPUP AND THE DIALOG — the panel's own key handler does not stop propagation | lands, dialog survives, typed path intact |
 *
 * So: Escape for a combobox, this for the directory panel. Getting it backwards
 * does not fail fast — it hangs a spec for its whole timeout, or leaves the
 * form reset with the submit button disabled and no dialog to speak of.
 */
export async function dismissDirectoryPanel(page: Page, heading = "New subshell"): Promise<void> {
  await page.getByRole("heading", { name: heading }).click();
}
