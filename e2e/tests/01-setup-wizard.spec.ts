import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_STATE } from "./helpers";

test("first-run wizard creates the admin; login and logout work", async ({ page, context }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/); // "/" redirects while needsSetup
  await expect(page.getByText("Welcome to Subshell")).toBeVisible();

  // Step 1/5 — Account
  await page.fill("#name", ADMIN.name);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  // A typo in the confirmation must block submit (there is no password reset
  // until the break-glass hatch; the wizard is the one place that matters).
  await page.fill("#password-confirm", "typo-does-not-match");
  await page.locator("#password-confirm").blur();
  await expect(page.getByText("Passwords do not match")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Account" })).toBeDisabled();
  await page.fill("#password-confirm", ADMIN.password);
  await page.getByRole("button", { name: "Create Account" }).click();

  // Step 2/5 — the network step (spec 2026-09-15 network-plugins §7.2). It is
  // optional and skipped here: connecting a real tailnet is not something an
  // e2e run can do, and the point of the screen is that it can be passed.
  await expect(page.getByText("Step 2 of 5")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect a Network" })).toBeVisible();
  // One primary button since 2026-09-18, and its word is host truth:
  // "Continue" iff some network is already joined/published ON THIS MACHINE
  // (a developer laptop running Tailscale can be; CI is not), "Skip for now"
  // otherwise. Both labels run the same advance, so the spec presses
  // whichever word the step shows — the flip itself is pinned deterministically
  // in `setup.test.tsx`, not here (e2e/AGENTS.md: assert wiring, not identity).
  await page.getByRole("button", { name: /Continue|Skip for now/ }).click();

  // Step 3/5 — tmux (spec 2026-09-15 §5.1; its own screen since 2026-09-17,
  // when it left the agent list, where it read as an agent named tmux). It is
  // what every local pane launches through, and before it the browser wizard
  // said so nowhere — the tmux screen lived only in the native Subshell
  // Server assistant, which a headless install never sees. This suite needs a
  // real tmux server to run at all, so the found state is the one to assert;
  // WHICH path is host truth, so the screen is asserted, not a filename.
  await expect(page.getByText("Step 3 of 5")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Install tmux" })).toBeVisible();
  await expect(page.getByRole("group", { name: "tmux" })).toContainText("Found at");

  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4/5 — the agent step, explicitly optional: a terminal plugin always
  // exists, so this step can never dead-end. Boot seeds every built-in plugin
  // here, so pi's row reads Detected (stub binary on PATH) and the others Not
  // found. And tmux is NOT among the rows — the whole point of its own step.
  await expect(page.getByText("Step 4 of 5")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add an Agent" })).toBeVisible();
  const piRow = page.getByRole("listitem", { name: "pi", exact: true });
  await expect(piRow).toBeVisible();
  await expect(piRow.getByText(/Detected/)).toBeVisible();
  await expect(page.getByRole("listitem", { name: "tmux", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Continue" }).click();

  // Step 5/5 — the launch step arrives filled in (Task 6's defaults), but
  // this spec's job is the admin handoff, not the launch: spec 15 owns the
  // end-to-end launch on a dedicated clean instance. "Skip" must finish
  // setup exactly like a launch does — this also pins that no stray pane
  // is left on the shared DB by the wizard itself.
  await expect(page.getByText("Step 5 of 5")).toBeVisible();
  // The wizard lands with a usable agent already picked, with no user act —
  // the wiring the old auto-filled profile combobox used to prove. WHICH
  // agent is host-dependent BY DESIGN of the stack: the local node's probe
  // reads this machine's real PATH, so tier 2 lands on "Claude Code" where
  // `claude` is installed and on "pi" where it is not. The default RULE is
  // unit-tested (subshell-compat's `defaultAgentId`, the form suites); this
  // spec pins only that the answered-empty subshells gate opens and the
  // form fills itself. Spec 15 owns the deterministic pick on a machine
  // whose detection is override-starved.
  await expect(page.locator("#setup-agent")).not.toHaveValue("");
  await expect(page.locator("#setup-working-dir")).not.toHaveValue("");
  // First run hides the Preset row entirely (spec 2026-09-13 §5): a brand-
  // new account has zero presets and the row would offer only "None".
  await expect(page.getByLabel("Preset")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start" })).toBeEnabled();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: "Subshells" })).toBeVisible();

  // The wizard must never show again on a DB with users.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);

  // Zero presets for a fresh admin (spec 2026-09-13): the registration-era
  // auto-seeding of a "Default" per harness is gone, along with the
  // unremovable flag and the DELETE-409 it carried — the launch is
  // harness-first and a preset is optional.
  const presets = await page.evaluate(async () => {
    return (await (await fetch("/api/presets")).json()) as unknown[];
  });
  expect(presets).toEqual([]);

  // Sign out through the sidebar user menu (spec 2026-09-02 settings-split
  // §3 — it replaced the bare Logout button), then real login through the form.
  await page.getByRole("button", { name: /Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/");

  // Hand the session to the specs that run after this one (workers: 1).
  // ADMIN_STATE is an absolute path (helpers.ts), so writer and reader agree
  // no matter which directory the run was launched from.
  await context.storageState({ path: ADMIN_STATE });
});
