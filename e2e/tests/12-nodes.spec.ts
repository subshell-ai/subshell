import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BASE_URL } from "../ports";
import { type RunningAgent, startAgent } from "../stub/agent";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** tmux spawn + first status poll take seconds; later asserts can be shorter. */
const SPAWN_TIMEOUT = 30_000;

/** The registry row fragment this spec reads (GET /api/nodes, NodeView). */
interface NodeRow {
  id: string;
  name: string;
  status: "online" | "offline";
  harnesses: { harnessId: string; installed: boolean; enabled: boolean }[];
  inventoryStale: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `check` until true or `SPAWN_TIMEOUT`; on timeout throws `label` +
 * the agent log tail. `tickMs` widens for TMUX-spawning checks (each probe
 * is a `spawnSync` blocking the worker; pane liveness moves on seconds, not
 * 500 ms) while pure-API polls keep the tight default.
 */
async function pollUntil(
  label: string,
  agent: RunningAgent | undefined,
  check: () => Promise<boolean>,
  tickMs = 500,
): Promise<void> {
  const deadline = Date.now() + SPAWN_TIMEOUT;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`${label}\n--- agent log tail ---\n${agent?.logTail() ?? "(agent never started)"}`);
    }
    await sleep(tickMs);
  }
}

/**
 * Absolute paths of every tmux socket under `tmuxBase`
 * (`$TMUX_TMPDIR/tmux-<uid>/<socket>`) — the agent is spawned with
 * TMUX_TMPDIR pointed there, so every server it daemonises is addressable
 * inside it, exactly like the stack's own teardown. The socket NAME is the
 * backend's `tmuxSocketFor(sessionId)` hash — deliberately not recomputed
 * here: enumerating the dir pins agent-side truth without coupling the spec
 * to the hashing scheme. Empty while the dir does not exist yet.
 */
function socketsUnder(tmuxBase: string): string[] {
  const uidDir = path.join(tmuxBase, `tmux-${process.getuid?.() ?? 0}`);
  try {
    return readdirSync(uidDir).map((s) => path.join(uidDir, s));
  } catch {
    return [];
  }
}

/** True when a tmux session named `paneName` lives on ANY server under `tmuxBase`. */
function nodeHasPane(tmuxBase: string, paneName: string): boolean {
  return socketsUnder(tmuxBase).some(
    (sock) => spawnSync("tmux", ["-S", sock, "has-session", "-t", paneName]).status === 0,
  );
}

/** Best-effort: kill every tmux server whose socket lives under `tmuxBase`. */
function sweepTmuxServers(tmuxBase: string): void {
  for (const sock of socketsUnder(tmuxBase)) {
    spawnSync("tmux", ["-S", sock, "kill-server"]);
  }
}

/**
 * Phase-1 nodes page, minimal contract (spec 2026-08-31 §9/§10): the seeded
 * `local` node renders online, and the Add-node flow mints a setup key whose
 * plaintext appears exactly once next to the install command that carries it
 * as `?setup_key=`. The key then survives the dialog close as a revocable
 * row in the Setup-keys card. No real enrollment here — the stub-agent
 * online/chips/launch path is the phase-3 spec.
 */
test("nodes: Local renders online; Add-node mints a setup key + install command", async ({ page }) => {
  await page.goto("/nodes");
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();

  // The boot-seeded control-plane node: name + machine line + online badge.
  // On this pristine-registry run `Local` is the only node, so the page-level
  // texts are unambiguous.
  await expect(page.getByText("Local", { exact: true })).toBeVisible();
  await expect(page.getByText("this machine", { exact: false })).toBeVisible();
  await expect(page.getByText("online", { exact: true })).toBeVisible();

  // Add node → name it → one-time reveal.
  await page.getByRole("button", { name: "Add node" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add a node" })).toBeVisible();
  await dialog.locator("#node-name").fill("e2e-box");
  await dialog.getByRole("button", { name: "Create setup key" }).click();

  await expect(dialog.getByRole("heading", { name: "Run this on the new machine" })).toBeVisible();
  const key = (await dialog.getByText(/^nsk_/).textContent()) ?? "";
  expect(key, "plaintext key is shown once").toMatch(/^nsk_/);

  // The rendered install command: curl … /install.sh?setup_key=<the key> | bash
  const command = dialog.locator("code", { hasText: "install.sh?setup_key=" });
  await expect(command).toBeVisible();
  await expect(command).toContainText(`?setup_key=${key}`);

  await dialog.getByRole("button", { name: "Done" }).click();

  // The minted key is listed for revocation after the dialog closes.
  await expect(page.getByText("Setup keys", { exact: true })).toBeVisible();
  await expect(page.getByText("e2e-box", { exact: true })).toBeVisible();
  await expect(page.getByText("unused", { exact: true })).toBeVisible();
});

/**
 * Phase 3 (spec 2026-08-31 §6.6/§9/§11): the first automated REAL-protocol
 * remote launch. A real `subshell` (spawned from source via
 * `e2e/stub/agent.ts` — no compiled binary, plan deviation #1) redeems a
 * setup key minted through the Add-node dialog, holds the signed node socket,
 * and hosts a session launched from the browser: online → inventory → chips
 * → tmux pane ON THE NODE → relayed log → WS attach → terminate → gone.
 *
 * Fixture choice (brief Step 2): ONE test, agent start/stop around a
 * try/finally. Specs 05/06 own tmux inside a single test's body and there is
 * no global fixture hook; a serial `describe` would skip the later tests on a
 * mid-story failure and the `afterAll` is not guaranteed to run before the
 * runner reports — one test's `finally` always runs, which is what the
 * no-leaves contract needs under `workers: 1`. Node/session names carry
 * `test.info().retry` (spec 06's idiom) so a CI retry never collides with
 * attempt 0's row (the temp DB survives attempts within a run).
 *
 * Protocol friction found (recorded for the errata; SINCE FIXED by P3-T8b):
 * inventory used to be PULL-ONLY — the agent pushed `ready` + `sessions_report`
 * at connect but never an inventory, and the create-time harness gate is strict
 * (FRESH snapshot saying installed), so a freshly enrolled node was ONLINE yet
 * rejected every launch with 409 "disabled or not installed" until something
 * sent the `inventory` command (the Re-check button / the POST this spec used
 * to make). The agent now PUSHES its first inventory after `ready` (after the
 * census — the backend reconcile applies exits first), so this spec waits for
 * the pushed snapshot instead of ordering a recheck.
 */
test("nodes: real agent from source enrolls, comes online, and hosts a remote launch", async ({ page, request }) => {
  // Agent boot + enrollment + a real tmux spawn on the node, all through the
  // browser path — far beyond the 30 s default.
  test.setTimeout(300_000);

  const nonce = test.info().retry;
  const nodeName = `e2e-node-${nonce}`;
  const keyLabel = `e2e-key-${nonce}`; // the dialog's LABEL — distinct from the node name so the /nodes row filter stays unambiguous
  const sessionName = `e2e-remote-${nonce}`;

  // ── 1. API truth: the server's own address is loopback under the e2e stack,
  // which is what makes the dialog's amber hint (step 2) a mandatory render.
  const pub = await request.get("/api/settings/public");
  expect(pub.ok(), await pub.text()).toBe(true);
  const { appBaseUrl } = (await pub.json()) as { appBaseUrl: string };
  expect(appBaseUrl).toBe(BASE_URL); // Task 3: appBaseUrl ≡ APP_BASE_URL ≡ the stack's origin

  // ── 2. Add-node dialog mints the key the agent will redeem; the rendered
  // command carries the SERVER's address and the loopback warning is visible.
  await page.goto("/nodes");
  await page.getByRole("button", { name: "Add node" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#node-name").fill(keyLabel);
  await dialog.getByRole("button", { name: "Create setup key" }).click();
  await expect(dialog.getByRole("heading", { name: "Run this on the new machine" })).toBeVisible();
  const setupKey = ((await dialog.getByText(/^nsk_/).textContent()) ?? "").trim();
  expect(setupKey, "plaintext key is shown once").toMatch(/^nsk_/);
  const command = dialog.locator("code", { hasText: "install.sh?setup_key=" });
  await expect(command).toContainText(`${BASE_URL}/install.sh?setup_key=${setupKey}`);
  await expect(dialog.getByText(/APP_BASE_URL points at loopback/)).toBeVisible(); // Task 3 pin
  await dialog.getByRole("button", { name: "Done" }).click();

  // ── 3. The install script AS SERVED by this instance (Task 4 pins, through
  // the live route — not the template file): the SUBSHELL_DATA_DIR knob and the
  // runtime loopback case branch. Asserted BEFORE enrollment: the key spends
  // there and `peekValid` would downgrade this response to the usage script.
  const sh = await request.get(`/install.sh?setup_key=${setupKey}`);
  expect(sh.ok(), await sh.text()).toBe(true);
  const script = await sh.text();
  expect(script).toContain("SUBSHELL_DATA_DIR");
  expect(script).toMatch(/\*:\/\/localhost\*/); // the loopback warning's case branch
  expect(script).toContain(`SERVER="${BASE_URL}"`);

  // ── 4–7. The agent's lifetime is fully inside try/finally: a mid-story
  // failure must never leave a daemon, a node row, a spent key, or a tmux
  // server under the default socket dir for the rest of the run.
  const home = mkdtempSync(path.join(tmpdir(), "subshell-e2e-agent-"));
  const dataDir = path.join(home, "data");
  const tmuxBase = path.join(home, "tmux");
  mkdirSync(tmuxBase, { recursive: true }); // tmux will not mkdir the TMUX_TMPDIR base itself (stack.ts)
  let agent: RunningAgent | undefined;
  let nodeId: string | undefined;
  let sessionId: string | undefined;
  try {
    agent = await startAgent({ home, dataDir, tmuxBase, setupKey, name: nodeName });

    // `ready` on the node socket flips the row online — poll the registry.
    // The row id is captured on EVERY iteration, not only on success: if the
    // online gate below fails, `finally` still has the id and can delete the
    // row (the no-node-row-leaves promise of the section header). The
    // in-predicate expect() keeps the fail-fast on a non-OK registry read
    // (the response body beats a generic timeout message).
    await pollUntil(`node "${nodeName}" never came online`, agent, async () => {
      const res = await request.get("/api/nodes");
      expect(res.ok(), await res.text()).toBe(true);
      const row = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.name === nodeName);
      if (row) nodeId = row.id;
      return row?.status === "online";
    });

    // P3-T8b: the agent PUSHES its first inventory after `ready` — no manual
    // Re-check POST here any more. Wait for the snapshot to land on the row,
    // then drive the harness card's PATCH through the REAL gate — with a fresh
    // snapshot in hand, enable is inventory-checked, and pi must read installed
    // because the agent was spawned with PI_PATH (stub/agent.ts).
    await pollUntil("the connect-time inventory push never reached the node row", agent, async () => {
      const res = await request.get("/api/nodes");
      if (!res.ok()) return false;
      const fresh = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
      return (
        fresh !== undefined && !fresh.inventoryStale && fresh.harnesses.some((h) => h.harnessId === "pi" && h.installed)
      );
    });
    const patch = await request.patch(`/api/nodes/${nodeId}/harnesses/pi`, { data: { enabled: true } });
    expect(patch.ok(), await patch.text()).toBe(true);
    const patched = (await patch.json()) as NodeRow;
    expect(patched.harnesses.find((h) => h.harnessId === "pi")).toMatchObject({ installed: true, enabled: true });
    expect(patched.inventoryStale).toBe(false);

    // ── 5. The /nodes page renders the row: name, online badge, pi chip.
    await page.goto("/nodes");
    const nodeRowUi = page.locator("div.rounded-lg", { has: page.getByText(nodeName, { exact: true }) });
    await expect(nodeRowUi).toHaveCount(1);
    await expect(nodeRowUi.getByText("online", { exact: true })).toBeVisible();
    await expect(nodeRowUi.getByText("pi", { exact: true })).toBeVisible();

    // ── 6. Remote launch through the browser: /new, pi's Default profile,
    // the e2e node, a temp cwd. Terminal truth stays server-side (AGENTS.md):
    // ws-token + /ws upgrade + no reconnecting pill — never canvas text.
    const workingDir = mkdtempSync(path.join(home, "cwd"));
    await page.goto("/new");
    await page.getByText("Choose a profile").click();
    await page.getByRole("option", { name: "Default (pi)", exact: true }).click();
    await page.locator("#node").click();
    await page.getByRole("option", { name: nodeName, exact: true }).click();
    await page.fill("#working-dir", workingDir);
    await page.fill("#name", sessionName);
    // The directory-picker panel opens on focus and covers the fields below;
    // Escape is the dismissal that works outside a modal (spec 06's note).
    await page.keyboard.press("Escape");

    const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
      timeout: SPAWN_TIMEOUT,
    });
    const socket = page.waitForEvent("websocket", {
      predicate: (w) => w.url().includes("/ws?session="),
      timeout: SPAWN_TIMEOUT,
    });
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(/\/sessions\/.+/, { timeout: SPAWN_TIMEOUT });
    sessionId = new URL(page.url()).pathname.split("/").pop() as string;
    await tokenRes;
    const ws = await socket;
    expect(ws.url()).toContain("/ws?session=");
    // "running" on the detail badge: the control plane's launch RPC answered
    // ok AND the reconcile saw the pane alive — ON THE NODE's tmux server.
    await expect(page.getByText("running", { exact: true }).first()).toBeVisible({ timeout: SPAWN_TIMEOUT });
    await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

    // The pane is genuinely on the node (its own tmux server, under our
    // TMUX_TMPDIR — not the control plane's) …
    const pane = sessionId;
    await pollUntil(`no tmux pane "${pane}" on the node`, agent, async () => nodeHasPane(tmuxBase, pane), 1_500);
    // …and the log relay (log_read over the node socket) carries its output.
    // The one-shot startup banner can scroll out before pipe-pane attaches
    // (the agent pipes the pane only after new-session), so any `tick <n>` —
    // the stub's every-5s liveness line — is an equally valid signal.
    await pollUntil("relayed log never showed the stub banner or a tick line", agent, async () => {
      const res = await request.get(`/api/sessions/${pane}/log`);
      if (!res.ok()) return false;
      return /(stub harness ready|\btick \d+)/.test(((await res.json()) as { lines: string[] }).lines.join("\n"));
    });

    // ── 7. Terminate from the sessions list (spec 06's idiom): the card
    // reaches "ended" via the agent's exit event, and the pane dies on the
    // node (has-session flips false once tmux reaps it).
    await page.goto("/");
    const actions = page.getByRole("button", { name: `Actions for ${sessionName}` });
    await expect(actions).toBeVisible();
    await actions.click();
    await page.getByRole("menuitem", { name: "Terminate" }).click();
    await expect(page.getByText(`Terminate session "${sessionName}"?`)).toBeVisible();
    await page.getByRole("button", { name: "Terminate" }).click();
    const card = page.getByRole("link").filter({ hasText: sessionName });
    await expect(card.getByText("ended", { exact: true })).toBeVisible({ timeout: SPAWN_TIMEOUT });
    await pollUntil(
      `pane "${pane}" outlived terminate on the node`,
      agent,
      async () => !nodeHasPane(tmuxBase, pane),
      1_500,
    );

    // Delete the row (its node artifacts unhook via remove_paths), leaving a
    // clean node for the teardown's node delete (no running sessions).
    await actions.click();
    await page.getByRole("menuitem", { name: "Delete session" }).click();
    await expect(page.getByText(`Delete session "${sessionName}"?`)).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(sessionName)).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
  } finally {
    const leaks: string[] = [];
    // Order matters: daemon first (the node must flip offline before DELETE),
    // then its tmux servers (outside the stack's scratch — our sweep only),
    // then the rows only this API can remove.
    try {
      await agent?.stop();
    } catch (err) {
      leaks.push(`agent stop: ${String(err)}`);
    }
    sweepTmuxServers(tmuxBase);
    if (nodeId) {
      // The registry's offline flip rides the socket close — retry the delete
      // through a stale-409 window rather than racing it.
      for (let i = 0; i < 10; i++) {
        try {
          const del = await request.delete(`/api/nodes/${nodeId}?force=true`);
          if (del.ok() || del.status() === 404) break;
          if (i === 9) leaks.push(`node delete: HTTP ${del.status()} ${(await del.text()).slice(0, 200)}`);
        } catch (err) {
          leaks.push(`node delete: ${String(err)}`);
          break;
        }
        await sleep(500);
      }
    }
    try {
      const keys = (await (await request.get("/api/nodes/setup-keys")).json()) as {
        keys: { id: string; label: string }[];
      };
      for (const k of keys.keys.filter((k) => k.label === keyLabel)) {
        const rev = await request.delete(`/api/nodes/setup-keys/${k.id}`);
        if (!rev.ok() && rev.status() !== 404) leaks.push(`setup-key revoke: HTTP ${rev.status()}`);
      }
    } catch (err) {
      leaks.push(`setup-key revoke: ${String(err)}`);
    }
    rmSync(home, { recursive: true, force: true });
    if (leaks.length > 0) console.error(`[12-nodes] cleanup problems: ${leaks.join("; ")}`);
  }
});
