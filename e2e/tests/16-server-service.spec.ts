import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * **Server Settings → Service**, in a real browser against the real backend
 * (spec 2026-09-12): the page that moved every server-UP management surface
 * out of the Subshell Server desktop console and into the SPA, so a browser
 * on the LAN and a headless install get it too.
 *
 * This suite's stack is the ideal subject for these assertions, by accident
 * of how it boots:
 *
 * - It is spawned BY HAND (`stack.ts` runs `bun src/index.ts`), so no service
 *   manager claims its pid. That is exactly the state a self-restart must
 *   refuse rather than exit into, and it cannot be staged in a unit test —
 *   there, `isSupervised` is a pure function over an injected answer.
 *
 * The other accident-of-boot facts — the environment-owned address fields
 * and the unset `TRUSTED_ORIGINS` — still hold of this stack, but they are
 * asserted where the Addresses card lives now: spec 18, /settings/networking.
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

    // The Server log CARD is on this page — its title, not the Locations row
    // that used to answer this selector. The Locations card moved to
    // /settings/status on 2026-09-14 and is asserted there instead; with both
    // strings identical, dropping this would have left the move unproven on
    // either page.
    await expect(page.getByText("Server log", { exact: true })).toBeVisible();
  });

  test("the Locations card is on Status, not Service, and states this process's real paths", async ({ page }) => {
    await page.goto("/");

    // Through the rail for the same reason the Service test does it: the card
    // moved between two sibling pages, so "it renders" is only half the claim
    // — the half that regresses is which page a person reaches it from.
    await page.getByRole("button", { name: "Server Settings" }).click();
    await page.getByRole("link", { name: "Status", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/status$/);

    await expect(page.getByText("Locations", { exact: true })).toBeVisible();
    await expect(page.getByText("Data directory")).toBeVisible();

    // A real path from the running process, not a placeholder: `stack.ts`
    // gives this backend an mkdtemp SUBSHELL_SERVER_DATA_DIR, so the deployment
    // view must echo the directory the server was actually started with. A
    // card wired to the wrong field renders an em-dash and passes every
    // title assertion above.
    const paths = (await (await page.request.get("/api/admin/server")).json()) as {
      paths: { dataDir: string | null };
    };
    expect(paths.paths.dataDir).toBeTruthy();
    await expect(page.getByText(paths.paths.dataDir as string).first()).toBeVisible();

    // And it is GONE from Service — the move, rather than a copy. The
    // Server log title is asserted FIRST because it is the anchor that makes
    // the next line mean anything: `toHaveCount(0)` is satisfied by a page
    // that has not rendered yet, so without waiting for something this page
    // really does draw, a regression putting the card back here would race
    // past the check rather than fail it. (The Addresses card moved the same
    // way in the other direction on 2026-09-17 — it is asserted on
    // /settings/networking, in spec 18.)
    await page.goto("/settings/service");
    await expect(page.getByText("Server log", { exact: true })).toBeVisible();
    await expect(page.getByText("Locations", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Addresses", { exact: true })).toHaveCount(0);
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

  test("answers whether this server comes back, and never offers a switch a browser cannot mean", async ({ page }) => {
    // Deliberately not "nothing is installed". The stack is hand-spawned, but
    // it runs with the developer's own HOME, so whether a launchd plist or a
    // systemd unit exists is a property of the machine running the suite —
    // true on a laptop with Subshell Server installed, false in CI. Asserting
    // either would be a test that passes in one place and fails in the other.
    //
    // What IS invariant is the pair that can actually regress: this page is a
    // BROWSER, so the choice must be absent, and whatever sentence it does
    // draw must come from the server's own answer rather than from a rule the
    // card re-derived.
    const view = (await (await page.request.get("/api/admin/server")).json()) as {
      service: { installed: boolean; enabled: boolean | null; manager: string | null; linger: boolean | null };
    };
    await page.goto("/settings/service");
    await expect(page.getByText("How this server runs")).toBeVisible();

    // The supervision CHOICE belongs to the Subshell Server app, which this is
    // not. Both of these existed here until 2026-09-15 and both were dead
    // controls: radios naming a mode this machine may have no app for, and a
    // "Start at login" switch that reads as a desktop session on a server.
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Start at login" })).toHaveCount(0);

    const service = view.service;
    if (!service.installed) {
      await expect(page.getByText("Started by hand. Nothing brings it back when it stops.")).toBeVisible();
      await expect(page.getByText("subshell-server service install")).toBeVisible();
    } else if (service.enabled === false) {
      await expect(page.getByText("Will not come back after a reboot.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Start automatically" })).toBeEnabled();
    } else if (service.manager === "systemd" && service.enabled === true) {
      // The whole point of the change, where the suite runs on Linux: an
      // ENABLED unit still dies at logout unless the account lingers, so the
      // page must distinguish the two rather than say "starts at login" and
      // leave a headless operator believing their server is armed.
      await expect(
        page.getByText(
          service.linger === true ? /without anyone logging in/ : /stops when you log out|If nobody logs in to/,
        ),
      ).toBeVisible();
      if (service.linger !== true) await expect(page.getByText("loginctl enable-linger $USER")).toBeVisible();
    }

    // And the SERVER refuses independently of what the UI drew — the same
    // shape as the restart guard above, and for the same reason: an absent
    // control is not a security boundary.
    const usable = service.manager !== "app" && service.installed && service.enabled !== null;
    if (!usable) {
      const res = await page.request.post("/api/admin/server/autostart", { data: { enabled: true } });
      expect(res.status()).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("AUTOSTART_UNAVAILABLE");
    }
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
            await page.request.get("/api/presets");
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
    // The About box labels the two version lines "Desktop app" and "CLI"
    // (web b859bee — "Server"/"Subshell Server" were two strings one word
    // apart for two programs), and the CLI line is the server binary's
    // version this test reads from public settings.
    await expect(page.getByText(`CLI ${version}`)).toBeVisible();

    // A browser is not a desktop shell, so the shell's own version line must
    // be absent — it is drawn from the user-agent marker, which only the
    // Subshell Server window carries. Matched on the CURRENT label: pinning
    // the retired "Subshell Server {n}" here would pass vacuously the day
    // the marker is present (the line moved to "Desktop app {n}").
    await expect(page.getByText(/Desktop app \d/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Licence" })).toBeVisible();
  });
});
