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
  for (const path of ["/api/subshells", "/api/presets", "/api/workspaces"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
  }
});

test("login page renders with its form", async ({ page }) => {
  await page.goto("/login");
  // The title is `Sign in to {instanceName ?? "Subshell"}` (login.tsx:89):
  // the instance name rides an anonymous async query and defaults to the
  // HOST'S NAME (spec 2026-09-08), so the word after "to" is either the
  // wordmark fallback or this machine — whichever one wins the render race.
  // Match the prefix; the identity of the plane is not this test's claim,
  // the form below it is.
  await expect(page.getByText(/^Sign in to /)).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
});
