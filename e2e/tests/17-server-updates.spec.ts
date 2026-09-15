import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * **Server Settings → Updates**, in a real browser against the real backend
 * (spec 2026-09-15 §6).
 *
 * This stack is the AIR-GAPPED instance by construction: `stack.ts` sets
 * `SUBSHELL_RELEASE_URL=""`, because the default is the real GitHub API and
 * nothing in a test suite should reach it. So the page renders the one state
 * that has no local equivalent and that every deployment without a network
 * lives in permanently — "this instance cannot check, and here is why" — and
 * the assertion is that it says so rather than rendering an enabled button
 * against a release list it never read.
 *
 * What is deliberately NOT here: pressing Update. There is nothing to install,
 * the button is disabled (which IS the assertion), and a spec that updated the
 * backend would replace the binary every later file runs against
 * (`workers: 1`, one database, alphabetical order).
 */
test.describe("server updates page", () => {
  test("reaches the page from the sidebar and says why it cannot check", async ({ page }) => {
    await page.goto("/");

    // Through the rail rather than by URL: a route nobody can reach is not a
    // feature, and the nav entry is part of what shipped.
    await page.getByRole("button", { name: "Server Settings" }).click();
    await page.getByRole("link", { name: "Updates", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/updates$/);
    await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();

    // The reason, verbatim from the server's own `canApply.reasons` — the page
    // never invents one. Scoped to the Server card: the Nodes card states the
    // SAME cause in its own words two cards down, which is correct and is why
    // an unscoped locator here matches twice.
    await expect(
      page.getByText(/Updates are unavailable: no release source is configured \(SUBSHELL_RELEASE_URL is empty\)/),
    ).toBeVisible();

    // The unsupervised stack is refused for a second, independent reason, and
    // both are listed rather than the first one standing for all of them.
    await expect(page.getByText(/Updates are unavailable: .*not running under a service manager/)).toBeVisible();

    // Nothing to install, and nothing to check with.
    await expect(page.getByRole("button", { name: /^Update/ }).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Re-check" })).toBeDisabled();
  });

  test("renders all three cards, with the node and desktop sections saying what is missing", async ({ page }) => {
    await page.goto("/settings/updates");

    // Scoped to `main`: "Nodes" is also a rail link, and this is a claim about
    // the page's cards rather than about the navigation.
    const body = page.getByRole("main");
    await expect(body.getByText("Server", { exact: true })).toBeVisible();
    await expect(body.getByText("Nodes", { exact: true })).toBeVisible();
    await expect(body.getByText("Desktop apps", { exact: true })).toBeVisible();

    await expect(page.getByText(/No node release can be offered/)).toBeVisible();
    await expect(page.getByText(/No desktop release could be read/)).toBeVisible();
  });
});
