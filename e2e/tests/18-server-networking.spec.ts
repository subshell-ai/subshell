import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * **Server Settings → Networking**, in a real browser against the real
 * backend. The card-level behaviour of the network plugins is the wizard and
 * unit-test surface; what this file pins is the page's SHAPE since
 * 2026-09-17: it owns the Addresses card (moved from `/settings/service`,
 * where spec 16 now asserts its ABSENCE) and groups the installed networks
 * into one "Networks" card rather than a card per network.
 *
 * The Addresses assertions ride on an accident of how this suite's stack
 * boots: it takes `SERVER_PORT`, `HOST` and `APP_BASE_URL` from the
 * ENVIRONMENT rather than from a config.env — the same shape a systemd host
 * has (`EnvironmentFile=` exports them before the process starts). Those
 * fields must render read-only, naming the variable, because a file write
 * the next boot would mask is a success report for a change that never
 * happens. And the stack sets no `TRUSTED_ORIGINS`, so that one field is the
 * control: it must stay editable while its neighbours do not.
 *
 * What is deliberately NOT here: saving anything. A spec that wrote
 * `TRUSTED_ORIGINS` or restarted the server would reach under every later
 * file (`workers: 1`, one database, alphabetical order), and both halves are
 * already pinned against a mocked route in `components/__tests__/
 * addresses-card.test.tsx`.
 */
test.describe("server networking page", () => {
  test("reaches the page from the rail and carries the Addresses card", async ({ page }) => {
    await page.goto("/");

    // Through the rail rather than by URL: a route nobody can reach is not a
    // feature, and the page gained a form on 2026-09-17 rather than losing one.
    await page.getByRole("button", { name: "Server Settings" }).click();
    await page.getByRole("link", { name: "Networking", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/networking$/);
    await expect(page.getByRole("heading", { name: "Networking" })).toBeVisible();

    await expect(page.getByText("Addresses", { exact: true })).toBeVisible();

    // The systemd shape. Every one of these is exported before the process
    // starts, so config.env cannot change it and the form must not pretend
    // otherwise.
    for (const [label, key] of [
      ["Port", "SERVER_PORT"],
      ["Bind address", "HOST"],
      ["Public base URL", "APP_BASE_URL"],
    ] as const) {
      const field = page.getByLabel(label, { exact: true });
      await expect(field).toHaveAttribute("readonly", "");
      await expect(page.getByText(`Set by the environment (${key}); change it there.`)).toBeVisible();
    }

    // The control: this stack sets no TRUSTED_ORIGINS, so the one field the
    // environment does not own stays editable. Without this the assertions
    // above would pass on a form that was simply broken.
    const origins = page.getByLabel("Other addresses browsers will use", { exact: true });
    await expect(origins).not.toHaveAttribute("readonly", "");
    await expect(origins).toBeEditable();
  });

  test("prints this server's address line above the fields that write it", async ({ page }) => {
    // The line and the Addresses card are two views of one value, and the
    // pair is the page's whole story: what the server runs as, and what a
    // save would change after a restart.
    await page.goto("/settings/networking");
    await expect(page.getByText(/This server's address/)).toBeVisible();
    await expect(page.getByText("Addresses", { exact: true })).toBeVisible();
  });
});
