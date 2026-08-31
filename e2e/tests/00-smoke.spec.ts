import { expect, test } from "@playwright/test";

test("the stack is up and reports a pristine database", async ({ request }) => {
  const res = await request.get("/api/setup/status");
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { needsSetup: boolean; hasUsers: boolean };
  expect(body.needsSetup).toBe(true);
  expect(body.hasUsers).toBe(false);
});
