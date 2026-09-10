import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Installing and removing plugins on the CONTROL-PLANE HOST, through the same
 * Plugins card every node page renders (spec 2026-09-09 §11, phase 2b).
 *
 * The agent-node twin of this flow lives in 12-nodes.spec.ts; what this file
 * pins is that `local` is not special: the same card, the same two routes
 * (`POST`/`DELETE /api/nodes/local/plugins`), the same visible consequence in
 * the launch picker. Before phase 2b this page showed no actions on the host
 * at all, and before 2a the host had an enable table instead of a plugins
 * directory — the picker assertions below are what make "one meaning for
 * this host offers X" observable rather than aspirational.
 *
 * pi is the plugin under test because its binary is stubbed on the host
 * (stack.ts `PI_PATH`), so its rows are deterministic here. The spec always
 * restores it in `finally`: the suite shares one backend and one data dir
 * across specs (`workers: 1`), and a pi left uninstalled would cascade into
 * every later profile and launch assertion.
 */
test.describe("control-plane host plugins", () => {
  /** The Plugins card on /nodes/local. */
  function card(page: import("@playwright/test").Page) {
    return page.locator("div.rounded-lg", { has: page.getByText("Plugins", { exact: true }) });
  }

  /** The pi row within it — the name span is the only exact "pi" in the card. */
  function piRow(page: import("@playwright/test").Page) {
    return card(page)
      .locator("div.space-y-1")
      .filter({ has: page.getByText("pi", { exact: true }) });
  }

  async function hostDeclaresPi(page: import("@playwright/test").Page): Promise<boolean> {
    const res = await page.request.get("/api/nodes/local");
    if (!res.ok()) return false;
    const view = (await res.json()) as { harnesses: { harnessId: string }[] };
    return view.harnesses.some((h) => h.harnessId === "pi");
  }

  test("remove and reinstall pi through the card, and the launch picker follows", async ({ page }) => {
    let removed = false;
    try {
      // ── 1. The card offers Remove on the host, like on any node.
      await page.goto("/nodes/local");
      await expect(piRow(page).getByRole("button", { name: "Remove" })).toBeVisible();

      // ── 2. Remove it. The route deletes the directory and rewrites the
      // mirror in the same call, so one poll settles both.
      await piRow(page).getByRole("button", { name: "Remove" }).click();
      await expect.poll(() => hostDeclaresPi(page), { timeout: 10_000 }).toBe(false);
      removed = true;
      await expect(piRow(page)).toHaveCount(0);

      // The card now offers it back: the catalog is this build's plugins minus
      // the declared set, and pi is the only difference.
      await expect(card(page).getByRole("button", { name: "Install" })).toBeVisible();

      // ── 3. The picker reflects the host, greyed rather than hidden. The
      // node pick DEFAULTS to "local" (`emptyNewSubshellForm`), so the
      // profile list is already paired against this host: pi's Default is
      // grey with the reason right on it. The node-side "no pi here" grey
      // this spec set out to assert is unreachable with one node — every
      // profile that would grey Server is itself greyed first, and the
      // default pick cannot be cleared — so the grey travels on the profile
      // side here, where spec 12 pins the node side for agent nodes.
      // Fresh load: the node query does not poll.
      await page.goto("/new");
      await page.getByPlaceholder("Choose a profile").click();
      const piOption = page.getByRole("option", { name: /Default \(pi\)/ });
      await expect(piOption).toHaveCount(1);
      // No `exact` name: a greyed option's accessible name carries its
      // reason ("Default (pi) not installed on this node").
      await expect(piOption).toBeDisabled();
      await expect(piOption.getByText("not installed on this node")).toBeVisible();
      await page.keyboard.press("Escape");

      // ── 4. Reinstall through the card. Back to the node page first: the
      // picker detour left us on /new, where there is no Plugins card. This
      // is the built-in path: the bytes come from the running build, not a
      // network — phase 3 adds the registry behind the same two routes.
      await page.goto("/nodes/local");
      await card(page).getByRole("button", { name: "Install" }).click();
      await expect.poll(() => hostDeclaresPi(page), { timeout: 10_000 }).toBe(true);
      removed = false;
      await expect(piRow(page).getByRole("button", { name: "Remove" })).toBeVisible();

      // ── 5. And the picker un-greys with it: the grey is a live mirror of
      // the host's declaration, not a latch. With pi back, its Default is
      // selectable again, and paired against that profile the Server node is
      // a clean option (the node option label carries " · os/arch", hence no
      // `exact`).
      await page.goto("/new");
      await page.getByPlaceholder("Choose a profile").click();
      await page.getByRole("option", { name: "Default (pi)", exact: true }).click();
      await page.getByPlaceholder("Choose a node").click();
      const serverOption = page.getByRole("option", { name: "Server" });
      await expect(serverOption).toHaveCount(1);
      await expect(serverOption).toBeEnabled();
      await expect(serverOption.getByText("no pi here")).toHaveCount(0);
      await page.keyboard.press("Escape");
    } finally {
      if (removed) {
        const res = await page.request.post("/api/nodes/local/plugins", { data: { pluginId: "pi" } });
        expect(res.ok(), await res.text()).toBe(true);
      }
    }
    // Downstream specs run against this same backend; prove the restore stuck
    // rather than discovering it three files later as someone else's failure.
    await expect.poll(() => hostDeclaresPi(page), { timeout: 10_000 }).toBe(true);
  });
});
