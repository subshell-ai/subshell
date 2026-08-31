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
  // and no Logout affordance anywhere.
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
  await expect(page.getByText("Logout")).toHaveCount(0);

  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
});

test("members see the roster but no management UI", async ({ browser }) => {
  // Admin mints the member through the API (admin context closes right after).
  const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
  const member = {
    email: `member-${Date.now()}@mote.test`,
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
  await adminPage.goto("/users");
  await expect(adminPage.getByRole("button", { name: "Add user" })).toBeVisible();
  await expect(adminPage.getByText("Latest session lifecycle")).toBeVisible();
  await adminCtx.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", member.email);
  await page.fill("#password", member.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  // The roster is real: the member's own row is there.
  await expect(page.getByRole("cell", { name: member.email })).toBeVisible();
  // Management is invisible, not just disabled. Selectors target real
  // elements (the gated submit button, the audit CardDescription), not
  // headings — CardTitle renders a <div>, so heading-role queries would be
  // vacuously true. The admin positive control above pins non-vacuity.
  await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
  await expect(page.getByText("Latest session lifecycle")).toHaveCount(0);

  // And unreachable: the API keeps enforcing, not just the UI hiding.
  const post = await ctx.request.post("/api/users", {
    data: { email: `sneaky-${Date.now()}@mote.test`, password: "sneaky-pass-123", role: "user" },
  });
  expect(post.status()).toBe(403);
  await ctx.close();
});
