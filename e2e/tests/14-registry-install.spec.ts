import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Registry installs through the control plane's owned door (spec
 * 2026-09-09-registry). The bytes come from stack.ts's fake registry
 * (port 3198) — no public network in the suite, ever. There is no web
 * input for a spec yet (phase 4 owns the UI); this spec pins the API +
 * mirror half, which is everything the card will later drive.
 *
 * Like spec 13, the removal is restorable in a `finally`: the suite shares
 * one backend and one data dir, and an `e2e-demo` left installed would put a
 * phantom harness in every later picker. The uninstall at the end of the
 * happy path already clears it — the route answers the same way for an
 * already-absent id, so the finally is cheap insurance, not a second act.
 */
test("install a third-party plugin from the registry on the host, and the node reports it", async ({
  page,
  request,
}) => {
  let installed = false;
  try {
    const install = await request.post("/api/nodes/local/plugins", {
      data: { pluginId: "e2e-demo", spec: "e2e-demo@1.0.0" },
    });
    expect(install.ok(), await install.text()).toBe(true);
    installed = true;
    await expect
      .poll(
        async () => {
          const res = await request.get("/api/nodes/local");
          if (!res.ok()) return false;
          const view = (await res.json()) as { harnesses: { harnessId: string }[] };
          return view.harnesses.some((h) => h.harnessId === "e2e-demo");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.goto("/nodes/local");
    // The row reads by ID, not display name — on purpose, not a loosened
    // assertion. The card's label is `catalog.find(id)?.name ?? id`
    // (node-harness-card.tsx), and the catalog is this build's embedded
    // harnesses (`GET /api/setup/harnesses`); `NodeHarnessViewSchema` carries
    // no name, so a plugin the build does not embed renders by id. That is
    // the pre-existing display gap phase 4's card work inherits — pinning
    // "E2E demo" here would demand a UI change this spec does not own.
    await expect(
      page.locator("div.rounded-lg", { has: page.getByText("Plugins", { exact: true }) }).getByText("e2e-demo", {
        exact: true,
      }),
    ).toBeVisible();
    // The install record rode the swap — and uninstalling by id removes the
    // directory the record lives in, which is the sidecar's whole lifecycle
    // (spec §2.4: absence means embedded again).
    const res = await request.delete("/api/nodes/local/plugins/e2e-demo");
    expect(res.ok(), await res.text()).toBe(true);
    installed = false;
    await expect
      .poll(async () => {
        const view = (await (await request.get("/api/nodes/local")).json()) as { harnesses: { harnessId: string }[] };
        return view.harnesses.some((h) => h.harnessId === "e2e-demo");
      })
      .toBe(false);
  } finally {
    if (installed) {
      await request.delete("/api/nodes/local/plugins/e2e-demo");
    }
  }
});
