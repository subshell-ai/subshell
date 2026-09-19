import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * **Server Settings → Updates**, in a real browser against the real backend
 * (spec 2026-09-15 §6; one Components table since 2026-09-17).
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

    // The reasons, verbatim from the server's own `canApply.reasons` — the
    // page never invents one. Each is pinned by its own prefix: the Nodes
    // rows state the SAME cause in their own words ("No node release can be
    // offered: …") further down the same table, which is correct — and is why
    // a bare substring of the cause would match twice.
    await expect(
      page.getByText(/Updates are unavailable: no release source is configured \(SUBSHELL_RELEASE_URL is empty\)/),
    ).toBeVisible();

    // The unsupervised stack is refused for a second, independent reason, and
    // both are listed rather than the first one standing for all of them.
    await expect(page.getByText(/Updates are unavailable: .*not running under a service manager/)).toBeVisible();

    // Nothing to install, and nothing to check with — the Server row's two
    // buttons, and the row says its state through them being disabled.
    await expect(page.getByRole("button", { name: /^Update/ }).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Re-check" })).toBeDisabled();
  });

  test("renders the Components table, with the node and desktop rows saying what is missing", async ({ page }) => {
    await page.goto("/settings/updates");

    // Scoped to `main`: "Nodes" is also a rail link, and this is a claim about
    // the page's table rather than about the navigation.
    const body = page.getByRole("main");
    await expect(body.getByText("Components", { exact: true })).toBeVisible();

    // The columns every row answers, and the rows themselves in the
    // operator's order: desktop apps, Server, Nodes last. ("Update" is the
    // fourth column's heading but also the disabled button's label, so it is
    // asserted as the button in the test above rather than as text here.)
    await expect(body.getByText("Name", { exact: true })).toBeVisible();
    await expect(body.getByText("Running", { exact: true })).toBeVisible();
    await expect(body.getByText("Newest", { exact: true })).toBeVisible();
    await expect(body.getByText("Subshell Server App", { exact: true })).toBeVisible();
    await expect(body.getByText("Subshell Client App", { exact: true })).toBeVisible();
    await expect(body.getByText("Server", { exact: true })).toBeVisible();
    await expect(body.getByText("Nodes", { exact: true })).toBeVisible();

    // The air-gapped answers, each stated once: the fleet names why it has no
    // release, the desktop rows name that they could read none, and an
    // instance with no machines says so rather than rendering an empty section.
    await expect(page.getByText(/No node release can be offered/)).toBeVisible();
    await expect(page.getByText(/No desktop release could be read/)).toBeVisible();
    await expect(page.getByText("No machines are enrolled as nodes.")).toBeVisible();

    // After the row anchors above (so this is an absence in a rendered table,
    // not an empty page): the assistant button is the Server APP's row, and a
    // browser never raises it.
    await expect(body.getByRole("button", { name: "Open the update assistant" })).toHaveCount(0);
  });
});
