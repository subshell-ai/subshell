import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_STATE } from "./helpers";

/**
 * Auth-experience spec (spec 2026-08-30): the signed-out guard + bare login
 * frame, and the instance-wide read-only roster. Uses fresh browser contexts
 * rather than test.use storageState because ONE test needs admin, member and
 * anonymous principals side by side.
 */

test("signed-out deep-link round-trips through /login?redirect", async ({ page }) => {
  await page.goto("/workspaces");
  // Only "on /login" is asserted here — TanStack owns the exact search-param
  // encoding, so the param's SHAPE is not the contract; the successful
  // landing on /workspaces below proves the param round-tripped.
  await expect(page).toHaveURL(/\/login/);
  expect(new URL(page.url()).searchParams.has("redirect")).toBe(true);
  // The login frame is bare: no sidebar (desktop), no drawer bar (mobile),
  // and no signed-in user menu (the post-split Account/Sign-out affordance).
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Account:/ })).toHaveCount(0);

  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
});

test("members are turned away from the roster page", async ({ browser }) => {
  // Admin mints the member through the API (admin context closes right after).
  const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
  const memberEmail = `member-${Date.now()}@subshell.test`;
  const member = {
    email: memberEmail,
    // The name is the email on purpose: `displayNamesByIds` prefers a real
    // name, so a distinct one here would change every label this suite reads.
    name: memberEmail,
    password: "member-pass-123",
    role: "user",
  } as const;
  const created = await adminCtx.request.post("/api/users", { data: member });
  expect(created.ok(), await created.text()).toBe(true);

  // Positive control: the SAME selectors used for the member below must be
  // PRESENT for an admin, proving they are non-vacuous. (First-draft lesson:
  // CardTitle renders a plain <div>, so getByRole("heading", …) selectors
  // could never match anything — the absence assertions passed structurally.)
  const adminPage = await adminCtx.newPage();
  await adminPage.goto("/settings/users");
  await expect(adminPage.getByRole("button", { name: "Add user" })).toBeVisible();
  // The audit trail left the roster page for one of its own under the Server
  // Settings group (spec 2026-09-11 grouped-navigation §4.4), so the control
  // that proves this selector can match has to follow it there.
  await adminPage.goto("/settings/audit");
  await expect(adminPage.getByText("Latest subshell lifecycle")).toBeVisible();
  await adminCtx.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", member.email);
  await page.fill("#password", member.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  // The roster became an admin page (spec 2026-09-14): a member gets the
  // guidance sentence every other admin page gives them, and no table at all.
  // The roster API is unchanged — it is what the sharing picker reads — but
  // this page is no longer the way to it.
  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByText("The user list is for instance admins")).toBeVisible();
  await expect(page.getByRole("cell", { name: member.email })).toHaveCount(0);
  // Management is invisible, not just disabled. Selectors target real
  // elements (the gated header button, the audit CardDescription), not
  // headings — CardTitle renders a <div>, so heading-role queries would be
  // vacuously true. The admin positive control above pins non-vacuity.
  await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
  // The audit trail is a page of its own now, and it gates the way every
  // admin page does: guidance, never the table. Asserting the guidance is
  // PRESENT as well as the table absent is what keeps this from passing on a
  // page that simply failed to render — and the page's own subtitle is
  // deliberately not the card's sentence, so this locator can only mean the
  // card.
  await page.goto("/settings/audit");
  await expect(page.getByText("Instance settings are for admins")).toBeVisible();
  await expect(page.getByText("Latest subshell lifecycle")).toHaveCount(0);

  // And unreachable: the API keeps enforcing, not just the UI hiding.
  const post = await ctx.request.post("/api/users", {
    data: { name: "Sneaky", email: `sneaky-${Date.now()}@subshell.test`, password: "sneaky-pass-123", role: "user" },
  });
  expect(post.status()).toBe(403);

  // /settings for members (spec 2026-09-02 settings-split §2/§7): the page
  // is honest guidance, not an error parade — and the Server nav entry
  // never renders for a member (the admin positive control for these
  // selectors lives in 08-mobile-shell's drawer flow).
  await page.goto("/settings");
  await expect(page.getByText("Instance settings are for admins")).toBeVisible();
  await expect(page.getByRole("link", { name: "Account settings" })).toBeVisible();
  await expect(page.getByText("Registration", { exact: true })).toHaveCount(0);
  // The admin pages are one collapsible group in the rail now (spec
  // 2026-09-11 grouped-navigation §2.1), so a member is missing the group
  // HEADER and every page inside it — Users among them, which used to be a
  // top-level entry every signed-in person could see. Asserting a label from
  // an older tree would pass for the wrong reason.
  const rail = page.locator("aside");
  await expect(rail.getByRole("button", { name: "Server Settings" })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "General" })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "Users" })).toHaveCount(0);
  await ctx.close();
});
