import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * **Server Settings → Service**, in a real browser against the real backend
 * (spec 2026-09-12): the page that moved every server-UP management surface
 * out of the Subshell Server desktop console and into the SPA, so a browser
 * on the LAN and a headless install get it too.
 *
 * This suite's stack is the ideal subject for three of these assertions, by
 * accident of how it boots:
 *
 * - It is spawned BY HAND (`stack.ts` runs `bun src/index.ts`), so no service
 *   manager claims its pid. That is exactly the state a self-restart must
 *   refuse rather than exit into, and it cannot be staged in a unit test —
 *   there, `isSupervised` is a pure function over an injected answer.
 * - It takes `SERVER_PORT`, `HOST`, `APP_BASE_URL` and `DATABASE_PATH` from
 *   the ENVIRONMENT rather than from a config.env, which is the same shape a
 *   systemd host has (`EnvironmentFile=` exports all five before the process
 *   starts). Those fields must render read-only, naming the variable, because
 *   a file write the next boot would mask is a success report for a change
 *   that never happens.
 * - It sets no `TRUSTED_ORIGINS`, so that one field is the control: it must
 *   stay editable while its neighbours do not.
 *
 * What is deliberately NOT here: pressing Restart. The button is disabled on
 * this stack, which is the assertion; and a spec that restarted the backend
 * would take the shared instance down under every later file
 * (`workers: 1`, one database, alphabetical order).
 */
test.describe("server service page", () => {
  test("reaches the page from the sidebar and reports how this server is deployed", async ({ page }) => {
    await page.goto("/");

    // Through the rail rather than by URL: the seventh child of the Server
    // Settings group is part of what shipped, and a route nobody can reach
    // is not a feature.
    await page.getByRole("button", { name: "Server Settings" }).click();
    await page.getByRole("link", { name: "Service", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/service$/);
    await expect(page.getByRole("heading", { name: "Service" })).toBeVisible();

    // Supervision: hand-started, so the page says so and the button is dead.
    await expect(page.getByText("Running, not supervised")).toBeVisible();
    const restart = page.getByRole("button", { name: "Restart server" });
    await expect(restart).toBeDisabled();
    await expect(page.getByText(/not running under a service manager/i)).toBeVisible();

    // Locations: real paths from the running process, not placeholders.
    await expect(page.getByText("Locations", { exact: true })).toBeVisible();
    await expect(page.getByText("Data directory")).toBeVisible();
    await expect(page.getByText("Server log", { exact: true }).first()).toBeVisible();
  });

  test("refuses a self-restart on a hand-started server, and stays up", async ({ page }) => {
    // The guard that stops a web page exiting a server into nothing. Driven
    // over HTTP rather than by clicking, because the button is correctly
    // disabled — this proves the SERVER refuses too, not only the UI.
    const res = await page.request.post("/api/admin/server/restart", { data: {} });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESTART_UNAVAILABLE");

    // Still answering afterwards: the refusal returned instead of scheduling.
    const alive = await page.request.get("/api/setup/status");
    expect(alive.ok()).toBe(true);
  });

  test("renders environment-owned addresses read-only, and the others editable", async ({ page }) => {
    await page.goto("/settings/service");

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

  test("keeps HTTP request lines out of the log until debug is turned on, live", async ({ page }) => {
    await page.goto("/settings/service");
    await expect(page.getByText("Server log", { exact: true }).first()).toBeVisible();

    // By ROLE, not by label: Base UI's Switch is a span, so it is named by
    // its `aria-label` rather than by the `<Label htmlFor>` beside it.
    const toggle = page.getByRole("switch", { name: "Debug logging" });
    await expect(toggle).toBeVisible();

    /** The server's own log tail, as the page reads it. */
    const tail = async () => {
      const res = await page.request.get("/api/admin/server/logs?lines=1000");
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { lines: { message: string }[]; capBytes: number };
      expect(body.capBytes).toBe(204_800);
      return body.lines.map((l) => l.message).join("\n");
    };

    // Off by default is the whole point of the option: a server that logged
    // every request by default would fill its own 200 KB cap with traffic.
    expect(await tail()).not.toContain("incoming request");

    try {
      await toggle.click();
      // Applied LIVE — no restart. The next request must already be written.
      await expect
        .poll(
          async () => {
            await page.request.get("/api/profiles");
            return (await tail()).includes("incoming request");
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      // And the page's own polling is still excluded, or a debug session
      // would fill the cap with itself before showing a user anything.
      expect(await tail()).not.toContain("/api/admin/server/logs");
    } finally {
      // Restore: the suite shares one backend, and later specs should not be
      // writing request lines into a capped file.
      const off = await page.request.put("/api/admin/server/logging", { data: { debug: false } });
      expect(off.ok()).toBe(true);
    }
  });

  test("the control-plane host reports no agent runtime of its own", async ({ page }) => {
    // `runtime` is an AGENT fact, gated on `kind === "agent"`. The local node
    // has no agent to report one, and its deployment facts are this very
    // page's — so a Runtime card there would be the same thing said twice,
    // from a worse source.
    const res = await page.request.get("/api/nodes/local");
    expect(res.ok()).toBe(true);
    expect((await res.json()) as { runtime?: unknown }).not.toHaveProperty("runtime");

    await page.goto("/nodes/local");
    await expect(page.getByText("Runtime", { exact: true })).toHaveCount(0);
  });

  test("About names the instance and the server version, with no desktop shell present", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("menuitem", { name: "About Subshell" }).click();

    const version = await page.request
      .get("/api/settings/public")
      .then(async (r) => ((await r.json()) as { serverVersion: string }).serverVersion);
    await expect(page.getByText(`Server ${version}`)).toBeVisible();

    // A browser is not a desktop shell, so the shell's own version line must
    // be absent — it is drawn from the user-agent marker, which only the
    // Subshell Server window carries.
    await expect(page.getByText(/Subshell Server \d/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Licence" })).toBeVisible();
  });
});
