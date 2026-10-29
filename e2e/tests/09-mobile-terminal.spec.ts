import { expect, test } from "@playwright/test";
import { ADMIN_STATE, dismissDirectoryPanel, newPaneId, pickAgent } from "./helpers";

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

  // The pane this launch creates, identified by what is NEW afterwards: the
  // URL names the WORKSPACE (the launch files its pane into it, spec
  // 2026-10-17), and the workspace a previous spec left can be the one joined.
  const before = new Set(
    ((await (await page.request.get("/api/subshells")).json()) as { id: string }[]).map((s) => s.id),
  );

  await page.goto("/new");
  await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
  await page.fill("#picker-working-dir", "/tmp");
  // The working-dir DirectoryPickerInput opened on focus and its fixed-height
  // panel drops over the fields/button below it, dismissing only on an outside
  // click or Escape (blur/fill don't close it). No modal on this page, so
  // Escape is the clean dismissal. Env-dependent: only bites when /tmp has
  // directory entries to populate the panel (CI's own playwright-artifacts-*).
  await dismissDirectoryPanel(page);

  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?subshell="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Start subshell" }).click();
  // Phone too: the launch lands as a tab in a workspace (spec 2026-10-17);
  // the key bar rides the pane component, not the route.
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: SPAWN_TIMEOUT });
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

  // The pane this launch added, by the same before/after diff (a previous
  // mobile spec's tab may still be open in the workspace the URL names).
  const id = await newPaneId(page, before);
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

test("conversation jump controls send Ctrl+Home and Ctrl+End through the mobile terminal", async ({ page }) => {
  const created = await page.request.post("/api/subshells", {
    data: { harnessId: "terminal", nodeId: "local", workingDir: "/tmp", name: "Mobile conversation keys" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  let workspaceId: string | undefined;
  try {
    const workspace = await page.request.post("/api/workspaces", {
      data: { name: "Mobile navigation", subshellId: id },
    });
    expect(workspace.ok()).toBe(true);
    workspaceId = (await workspace.json()).id;
    await page.goto(`/workspaces/${workspaceId}`);
    const bar = page.getByRole("toolbar", { name: "Terminal special keys" });
    await expect(bar.getByRole("button", { name: "Send Enter", exact: true })).toBeEnabled();
    // A real PTY consumer owns the alternate screen, as Codex does. Its byte
    // echo proves mobile taps traverse xterm, the websocket, and tmux.
    const started = await page.request.post(`/api/subshells/${id}/input`, {
      data: {
        text: "stty raw -echo; printf '\\033[?1049h\\033[?1h'; cat -v",
        submit: true,
      },
    });
    expect(started.ok()).toBe(true);
    for (const name of ["Send Ctrl+Home", "Send Ctrl+End"]) {
      const key = bar.getByRole("button", { name, exact: true });
      await expect(key).toBeVisible();
      await key.scrollIntoViewIfNeeded();
      await expect(key).toBeInViewport();
      await key.tap();
    }
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/subshells/${id}/log`);
        const body = (await res.json()) as { lines: string[] };
        return body.lines.join("\n");
      })
      .toContain("^[[1;5H^[[1;5F");
  } finally {
    if (workspaceId) await page.request.delete(`/api/workspaces/${workspaceId}`);
    await page.request.delete(`/api/subshells/${id}`);
  }
});
