import { expect, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, pickAgent, renameSubshell } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** tmux spawn + first status poll take seconds; later asserts can be shorter. */
const SPAWN_TIMEOUT = 30_000;

/**
 * The flagship path: create a real tmux session (stub `pi` binary, no
 * preset — the launch is harness-first since spec 2026-09-13), watch the
 * terminal attach, then terminate and delete.
 * xterm paints to a WebGL canvas, so "the terminal is live" is asserted
 * through server-side truth: the ws-token mint + /ws upgrade + the absence of
 * the reconnecting pill — never canvas pixels. Independent of spec 05's
 * leftover `e2e-pane` subshell; cleans up after itself.
 */
test("subshell: create -> attach -> terminate -> delete", async ({ page }) => {
  // Config leaves the 30 s default per-test timeout; real tmux spawn plus two
  // round-trips through confirm dialogs needs more headroom.
  test.setTimeout(120_000);

  // Unique per attempt (spec 07's pattern): a CI retry must not collide with
  // attempt 0's leftover subshell — duplicate cards would break the strict
  // list locators and mask the real failure. The launch form no longer asks
  // for a name, so the subshell is renamed once it exists.
  const name = `e2e-lifecycle-${test.info().retry}`;

  // Create from `/new`, which opens the launch DIALOG over the list. The
  // searchable picker's closed state is an <input>, so it is found by its
  // placeholder attribute. Options render as the plugin display name.
  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel pushes the buttons below it down the dialog's scroller; neither blur
  // nor fill closes it, and Escape takes the whole dialog with it (see the
  // table on `dismissDirectoryPanel`). Dismissing keeps the submit button
  // where the next step expects it. Env-dependent: only bites when /tmp has
  // directory entries to populate the panel (CI's own playwright-artifacts-*).
  await dismissDirectoryPanel(page);

  // The detail page mints a one-shot WS token (POST /api/auth/ws-token), then
  // opens /ws?subshell=… — both listeners must be armed BEFORE the click.
  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });

  await page.getByRole("button", { name: "Start subshell" }).click();
  // The POST spawns tmux before the navigate happens, hence the long leash.
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });

  // Terminal attached: token minted, socket opened, and the reconnecting pill
  // gone — it renders only while the socket is down, so count 0 IS the proof.
  await tokenRes;
  const ws = await socket;
  expect(ws.url()).toContain("/ws?subshell=");
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

  // The header badge shows the raw server status — proof the stub harness is
  // alive in its pane (a dead-on-arrival subshell would read "exited").
  await expect(page.getByText("running", { exact: true }).first()).toBeVisible({ timeout: SPAWN_TIMEOUT });

  await renameSubshell(page, name);

  // Close it from the subshells list via the actions menu + confirm.
  // "Close" is the human name for DELETE (spec 2026-09-03): it terminates
  // the live pane AND removes the row in one act — the old separate
  // Terminate step left the human UI together with this two-step flow.
  await page.goto("/");
  const actions = page.getByRole("button", { name: `Actions for ${name}` });
  await expect(actions).toBeVisible();
  await actions.click();
  await page.getByRole("menuitem", { name: "Close" }).click();
  await expect(page.getByText(`Close subshell "${name}"?`)).toBeVisible();
  await page.locator("[data-slot='dialog-content'] button", { hasText: /^Close$/ }).click();

  // Prove it is gone.
  await expect(page.getByText(name)).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
});
