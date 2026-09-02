import { expect, test } from "@playwright/test";

/**
 * Protection is API-side, and this spec pins that real enforcement (it would
 * catch a future "oops, data leaks when logged out" regression). The frontend
 * now ALSO has a client-side route guard (auth-experience spec, 2026-08-30):
 * signed-out visitors on guarded routes are redirected to
 * `/login?redirect=<path>` — spec 10 pins that round-trip — with first-run
 * precedence to `/setup` while the instance has no users. The redirect is
 * UX only; the 401s below remain the actual security boundary.
 */
test("protected APIs reject anonymous callers", async ({ request }) => {
  for (const path of ["/api/sessions", "/api/profiles", "/api/workspaces"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
  }
});

test("login page renders with its form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Sign in to Subshell")).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
});
