import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/**
 * The headline mobile assertion (spec §5): key-bar buttons must deliver the
 * exact bytes to a REAL tmux pane. xterm paints to WebGL, so truth is the
 * server-side pane log — the stub harness now echoes stdin via `cat -v`
 * (^C, ^[ appear literally).
 */
test("accessory key bar sends real bytes into the pane", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/new");
  await page.getByPlaceholder("Choose a profile").click();
  await page.getByRole("option", { name: "Default (pi)" }).click();
  await page.fill("#working-dir", "/tmp");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel drops over the fields/button below it, dismissing only on an outside
  // click or Escape (blur/fill don't close it). No modal on this page, so
  // Escape is the clean dismissal. Env-dependent: only bites when /tmp has
  // directory entries to populate the panel (CI's own playwright-artifacts-*).
  await page.keyboard.press("Escape");

  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Start subshell" }).click();
  await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });
  await tokenRes;
  await socket;
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

  const bar = page.getByRole("toolbar", { name: "Terminal special keys" });
  await expect(bar).toBeVisible(); // coarse pointer under device emulation
  // The shell pinning (`__root.tsx` viewport insets over top bar + page) must
  // leave the bar above the fold, not just in the DOM.
  await expect(bar).toBeInViewport();
  // Ten keys at 393px is the tight fit: the bar must show them all without
  // horizontal scrolling, or a thumb swipe silently hides the arrows.
  expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await bar.getByRole("button", { name: "Send Ctrl-C" }).click();
  await bar.getByRole("button", { name: "Send Escape" }).click();
  await bar.getByRole("button", { name: "Send Enter" }).click();

  // URL already asserted to be /subshells/<id>; "" only degrades a lookup to
  // a failed poll, never a false green.
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  const logText = async () => {
    const res = await page.request.get(`/api/subshells/${id}/log`);
    if (!res.ok()) return "";
    const body = (await res.json()) as { lines: string[] };
    return body.lines.join("\n");
  };
  await expect.poll(async () => (await logText()).includes("^C"), { timeout: SPAWN_TIMEOUT }).toBe(true);
  await expect.poll(async () => (await logText()).includes("^["), { timeout: 10_000 }).toBe(true);
  // Enter is CR — what a physical Enter sends; cat -v renders it ^M.
  await expect.poll(async () => (await logText()).includes("^M"), { timeout: 10_000 }).toBe(true);

  // The "/" button is a plain byte sender now (the old subshell palette that
  // intercepted it was removed): cat -v echoes it verbatim into the pane.
  await bar.getByRole("button", { name: "Send slash" }).click();
  await expect.poll(async () => (await logText()).includes("/"), { timeout: 10_000 }).toBe(true);

  // Clean up after itself (shared-DB ordering contract).
  expect((await page.request.post(`/api/subshells/${id}/terminate`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/subshells/${id}`)).ok()).toBe(true);
});
