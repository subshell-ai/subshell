import { expect, test } from "@playwright/test";
import { ADMIN_STATE, openAgentPicker, pickAgent } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Uninstalling and reinstalling a plugin through **Settings → Plugins**, the
 * instance door that replaced the per-node Plugins card (spec 2026-09-10 §6/
 * §6.1). What this file has always pinned — the store and the launch picker
 * agreeing in the browser, not just in unit tests — survives the move intact;
 * what changed is that the store is ONE and the act is admin-only: removing
 * pi here removes it on the Server node AND on every enrolled node at once,
 * because the node view is the instance store crossed with that node's
 * detection. The dialog's keep-vs-delete question (the §6.1 blast-radius
 * prompt) gets its own assertions here too, since it has no other browser
 * coverage and the "keep" default is the one that must never regress.
 *
 * pi is the plugin under test because its binary is stubbed on the host
 * (stack.ts `PI_PATH`), so its rows are deterministic here. The spec always
 * restores it in `finally`: the suite shares one backend and one instance
 * store across specs (`workers: 1`), and a pi left uninstalled would cascade
 * into every later agent and launch assertion.
 */
test.describe("instance plugins", () => {
  /** The Installed card on /settings/plugins. */
  function installedCard(page: import("@playwright/test").Page) {
    return page.locator("div.rounded-lg", { has: page.getByText("Installed", { exact: true }) });
  }

  /** The pi row within it — the name span is the only exact "pi" in the row. */
  function piRow(page: import("@playwright/test").Page) {
    return installedCard(page)
      .locator("div.space-y-2")
      .filter({ has: page.getByText("pi", { exact: true }) });
  }

  async function storeHoldsPi(page: import("@playwright/test").Page): Promise<boolean> {
    const res = await page.request.get("/api/plugins");
    if (!res.ok()) return false;
    const view = (await res.json()) as { plugins: { id: string; installed: boolean }[] };
    return view.plugins.some((p) => p.id === "pi" && p.installed);
  }

  test("uninstall and reinstall pi through the page, and every node's rows and the picker follow", async ({ page }) => {
    let removed = false;
    try {
      // ── 1. The Installed card offers the enable switch and an Uninstall.
      await page.goto("/settings/plugins");
      await expect(piRow(page).getByRole("switch", { name: "pi enabled" })).toBeChecked();
      await expect(piRow(page).getByRole("button", { name: "Uninstall pi" })).toBeVisible();

      // ── 2. Uninstall through the §6.1 dialog. It states the instance-wide
      // consequence, names what uses the harness (fetched, not assumed), and
      // defaults to keep. What "keep" costs the preset store (`presetsRemoved`
      // on the DELETE) is API/unit turf — what the browser owes this file is
      // the store↔picker contract: the row leaves the store, the agent row
      // greys rather than vanishes (step 3), and reinstall makes it
      // selectable again (step 4).
      await piRow(page).getByRole("button", { name: "Uninstall pi" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Uninstall pi?" })).toBeVisible();
      await expect(dialog.getByText("stops offering it on every node")).toBeVisible();
      await expect(dialog.getByLabel("Keep the presets, unavailable until reinstalled")).toBeChecked();
      await dialog.getByRole("button", { name: "Uninstall" }).click();
      removed = true;
      await expect.poll(() => storeHoldsPi(page), { timeout: 10_000 }).toBe(false);
      await expect(piRow(page)).toHaveCount(0);

      // The catalog offers it back: "Add from this build" is this build's
      // embedded set minus the store's, and pi is the only difference.
      const catalog = page.locator("div.rounded-lg", { has: page.getByText("Add from this build", { exact: true }) });
      await expect(catalog.getByRole("button", { name: "Install pi" })).toBeVisible();

      // ── 3. The AGENT picker follows, and its reason is a SERVER fact:
      // the plugin left the instance store, so pi greys with "not installed
      // on this server" (spec 2026-09-13 §5 — the reason precedence reads the
      // control plane first; the node views being the store crossed with
      // detection is why the node row dropped too, but the agent option
      // names the store). (The node-option grey for a node MISSING a
      // detected binary is `lib/subshell-compat`'s unit-tested matrix; an
      // instance uninstall cannot reproduce it — it drops every node at
      // once.)
      await page.goto("/new");
      await openAgentPicker(page.getByPlaceholder("Choose an agent"));
      const piOption = page.getByRole("option", { name: "pi" });
      await expect(piOption).toHaveCount(1); // greyed ≠ gone
      // No `exact` name: a greyed option's accessible name carries its
      // reason ("pi not installed on this server"). Only pi's name has "pi".
      await expect(piOption).toBeDisabled();
      await expect(piOption.getByText("not installed on this server")).toBeVisible();
      await page.keyboard.press("Escape");

      // ── 4. Reinstall through the catalog: the built-in path, bytes from
      // the running binary, no network. Back to the page first: the picker
      // detour left us on /new, which has no cards.
      await page.goto("/settings/plugins");
      const catalogAgain = page.locator("div.rounded-lg", {
        has: page.getByText("Add from this build", { exact: true }),
      });
      await catalogAgain.getByRole("button", { name: "Install pi" }).click();
      await expect.poll(() => storeHoldsPi(page), { timeout: 10_000 }).toBe(true);
      removed = false;
      await expect(piRow(page).getByRole("button", { name: "Uninstall pi" })).toBeVisible();
      // Reinstall round-trips the grey: the agent is selectable again, and
      // this host is a clean target for it.
      await page.goto("/new");
      // The node picker is GONE on this instance (2026-09-12): the host is the
      // only place a subshell could run, so the field hides. That leaves the
      // AGENT select as where "the host has pi again" is observable — a
      // plugin the store lacks renders DISABLED, so `pickAgent` committing
      // this one is the same fact the old option-row assertion made.
      await expect(page.getByLabel("Node")).toHaveCount(0);
      await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
      await expect(page.locator("#picker-agent")).toHaveValue("pi");
      // And the form is launchable, which is the other half of "clean": the
      // dead-end hints that replace it when nothing can run are not on
      // screen (frozen copy, spec 2026-09-13: node-side and agent-side
      // variants).
      await expect(page.getByText(/Nothing installed on .* can run an agent|No available node can run/)).toHaveCount(0);
    } finally {
      if (removed) {
        const res = await page.request.post("/api/plugins", { data: { pluginId: "pi" } });
        expect(res.ok(), await res.text()).toBe(true);
      }
    }
    // Downstream specs run against this same backend and store; prove the
    // restore stuck rather than discovering it three files later as someone
    // else's failure.
    await expect.poll(() => storeHoldsPi(page), { timeout: 10_000 }).toBe(true);
  });
});
