import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

/**
 * End-to-end subshell sharing (spec 2026-08-31 §4) with two real users.
 *
 * One context can't hold two principals, so — like spec 10 — this drives
 * `browser.newContext` directly: an admin context mints a member + a subshell,
 * PUTs a share, and a fresh member context observes the result. The API carries
 * the fine-grained assertions (the `access` field, 404 on a private id); the UI
 * assertion is the one that matters to a human — a `view` grantee gets NO
 * actions menu, an `edit` grantee does.
 */
const PASSWORD = "share-member-1";
const SPAWN_TIMEOUT = 30_000;

test("sharing: view is read-only, edit manages, private subshells are invisible", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await browser.newContext({ storageState: ADMIN_STATE });

  const member = { email: `share-${Date.now()}@subshell.test`, password: PASSWORD, role: "user" };
  const created = await admin.request.post("/api/users", { data: member });
  expect(created.ok(), await created.text()).toBe(true);

  // Harness-first launch (spec 2026-09-13): no preset lookup — a preset is
  // optional and a fresh account owns none.
  const mkSubshell = async (name: string): Promise<string> => {
    const res = await admin.request.post("/api/subshells", {
      data: { harnessId: "pi", workingDir: "/tmp", name },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  const sharedId = await mkSubshell("shared-target");
  const privateId = await mkSubshell("private-target");

  const memberBrowser = await browser.newContext();
  const page = await memberBrowser.newPage();
  await page.goto("/login");
  await page.fill("#email", member.email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: SPAWN_TIMEOUT });

  try {
    // PRIVATE target: not even visible to the member — 404, not 403 (no probe).
    expect((await memberBrowser.request.get(`/api/subshells/${privateId}`)).status()).toBe(404);

    // Share the target at VIEW. The member now sees it, read-only.
    expect(
      (
        await admin.request.put(`/api/subshells/${sharedId}/shares`, {
          data: { shares: [{ granteeUserId: null, permission: "view" }] },
        })
      ).ok(),
    ).toBe(true);
    const asView = await (await memberBrowser.request.get(`/api/subshells/${sharedId}`)).json();
    expect(asView.access).toBe("view");

    await page.goto(`/subshells/${sharedId}`);
    // A viewer has no actions menu at all (the component returns null for view).
    await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);

    // Escalate to EDIT. The member's effective access rises and the menu appears.
    await admin.request.put(`/api/subshells/${sharedId}/shares`, {
      data: { shares: [{ granteeUserId: null, permission: "edit" }] },
    });
    const asEdit = await (await memberBrowser.request.get(`/api/subshells/${sharedId}`)).json();
    expect(asEdit.access).toBe("edit");
    await page.goto(`/subshells/${sharedId}`);
    await expect(page.getByRole("button", { name: /^Actions for / })).toBeVisible({ timeout: SPAWN_TIMEOUT });

    // Revoke entirely: the subshell vanishes from the member again (404).
    await admin.request.put(`/api/subshells/${sharedId}/shares`, { data: { shares: [] } });
    expect((await memberBrowser.request.get(`/api/subshells/${sharedId}`)).status()).toBe(404);
  } finally {
    for (const id of [sharedId, privateId]) await admin.request.delete(`/api/subshells/${id}`);
    await memberBrowser.close();
    await admin.close();
  }
});
