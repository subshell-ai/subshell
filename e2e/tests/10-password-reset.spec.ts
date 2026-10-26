import { expect, test } from "@playwright/test";
import { BASE_URL } from "../ports";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("an admin resets a password with masked matching fields and the user can sign in", async ({ page, browser }) => {
  const email = `reset-${Date.now()}@subshell.test`;
  const oldPassword = "old-reset-password-1";
  const newPassword = "new-reset-password-2";
  const created = await page.request.post("/api/users", {
    data: { name: "Password reset test", email, password: oldPassword, role: "admin" },
  });
  expect(created.ok()).toBe(true);
  const member = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const signedIn = await member.request.post("/api/auth/sign-in/email", {
      data: { email, password: oldPassword },
    });
    expect(signedIn.ok()).toBe(true);
    await page.goto("/settings/users");
    await page.getByRole("button", { name: `Actions for ${email}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Reset password", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const password = dialog.getByLabel("New password", { exact: true });
    const confirmation = dialog.getByLabel("Confirm new password", { exact: true });
    const submit = dialog.getByRole("button", { name: "Reset and sign out" });
    await expect(password).toHaveAttribute("type", "password");
    await expect(confirmation).toHaveAttribute("type", "password");
    await password.fill("cancelled-password");
    await confirmation.fill("cancelled-confirmation");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: `Actions for ${email}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Reset password", exact: true }).click();
    await expect(password).toHaveValue("");
    await expect(confirmation).toHaveValue("");
    await expect(submit).toBeDisabled();
    await password.fill(newPassword);
    await expect(submit).toBeDisabled();
    await confirmation.fill("different-password");
    await expect(submit).toBeDisabled();
    await confirmation.fill(newPassword);
    await submit.click();
    await expect(dialog.getByText(/Password changed\./)).toBeVisible();
    await expect(dialog.getByText(newPassword, { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: `Actions for ${email}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Reset password", exact: true }).click();
    await expect(password).toHaveValue("");
    await expect(confirmation).toHaveValue("");
    await expect(submit).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await member.request.get("/api/subshells")).status()).toBe(401);
    const rejected = await member.request.post("/api/auth/sign-in/email", {
      headers: { origin: BASE_URL },
      data: { email, password: oldPassword },
    });
    expect(rejected.status()).toBe(401);
    const loginPage = await member.newPage();
    await loginPage.goto("/login");
    await loginPage.fill("#email", email);
    await loginPage.fill("#password", newPassword);
    await loginPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(loginPage.getByRole("button", { name: "Account: Password reset test", exact: true })).toBeVisible();
    expect((await member.request.get("/api/subshells")).status()).toBe(200);
  } finally {
    await member.close();
  }
});
