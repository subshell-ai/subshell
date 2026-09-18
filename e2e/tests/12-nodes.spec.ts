import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BASE_URL } from "../ports";
import { shortTmuxBase } from "../stack";
import { AGENT_MAIN, type RunningAgent, startAgent } from "../stub/client";
import { ADMIN_STATE, dismissDirectoryPanel, openAgentPicker, pickAgent, renameSubshell } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** tmux spawn + first status poll take seconds; later asserts can be shorter. */
const SPAWN_TIMEOUT = 30_000;

/** The registry row fragment this spec reads (GET /api/nodes, NodeView). */
interface NodeRow {
  id: string;
  name: string;
  status: "online" | "offline";
  harnesses: { harnessId: string; installed: boolean }[];
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
 * backend's `tmuxSocketFor(subshellId)` hash — deliberately not recomputed
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
test("nodes: the server's own node renders online; Add-node mints a setup key + install command", async ({ page }) => {
  await page.goto("/nodes");
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();

  // Scoped to `main`, NOT the page: the admin sidebar once labelled its
  // /settings entry "Server" too, so a page-wide exact match resolved to two
  // elements and failed strict mode. The rail says "Server Settings" now
  // (spec 2026-09-11 grouped-navigation §2.1), which no longer collides under
  // `exact` — but the scoping stays, because this assertion is about the node
  // row and the rail is free to name the plane whatever an admin chooses.
  const body = page.locator("main");

  // The boot-seeded control-plane node: name + hostname line + online badge.
  // The row shows the HOSTNAME rather than claiming to be "this machine",
  // which is false for anyone not sitting at the server.
  await expect(body.getByText("Server", { exact: true })).toBeVisible();
  await expect(body.getByText("this machine", { exact: false })).not.toBeVisible();
  await expect(body.getByText("online", { exact: true })).toBeVisible();

  // Add node → one press → the reveal. There is no field any more: the node is
  // named by the machine that becomes it, so the first step IS the mint.
  await page.getByRole("button", { name: "Add node" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add a node" })).toBeVisible();
  await expect(dialog.locator("#node-name")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create setup key" }).click();

  await expect(dialog.getByRole("heading", { name: "Set up the new machine" })).toBeVisible();

  // The rendered install command: curl … /install.sh?setup_key=<the key> |
  // bash. Since 2026-09-18 the key's only carrier is a COMMAND (the
  // standalone box is gone; the air-gapped branch has two command rows,
  // alternatives that each carry it) — so the key is read OFF the command.
  // The count-0 is the box's RETURN alarm specifically: a bare key element's
  // text STARTS with `nsk_`, which is what `^` matches (commands start with
  // curl/subshell, so they never trip it, and a second command row must
  // not). The strict "no element embeds the key outside a command" count
  // lives in the unit suite.
  const command = dialog.locator("code", { hasText: "install.sh?setup_key=" });
  await expect(command).toBeVisible();
  // `mintedKey`, not `key`: Playwright's `page.keyboard` is in scope under the
  // fixture name too, and a shadowed input there is the kind of bug that only
  // shows up when someone later reaches for `keyboard` in this test.
  const mintedKey = ((await command.textContent()) ?? "").match(/setup_key=(nsk_[^"&\s]+)/)?.[1] ?? "";
  expect(mintedKey, "plaintext key rides the command").toMatch(/^nsk_/);
  await expect(dialog.getByText(/^nsk_/)).toHaveCount(0);
  await expect(command).toContainText(`?setup_key=${mintedKey}`);

  // The second path: the Subshell Client app takes two VALUES rather than a
  // command, so the key must be readable as a row of its own — which is the same
  // disclosure the card below makes, and the reason `^nsk_` counts differently here.
  await dialog.getByRole("button", { name: "Desktop App" }).click();
  await expect(dialog.getByRole("button", { name: "Copy server address" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy setup key" })).toBeVisible();
  await expect(dialog.getByText("Setup key", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Terminal" }).click();
  await expect(dialog.getByText(/^nsk_/)).toHaveCount(0); // back to one carrier: the command

  await dialog.getByRole("button", { name: "Done" }).click();

  // The minted key is LISTED, in full, after the dialog closes — the point of
  // storing it in the clear. Revocable as before, and now re-readable too, so a
  // closed dialog is no longer a re-mint.
  await expect(page.getByText("Setup keys", { exact: true })).toBeVisible();
  await expect(page.getByText(mintedKey, { exact: true })).toBeVisible();
  await expect(page.getByText("unused", { exact: true })).toBeVisible();
});

/**
 * Phase 3 (spec 2026-08-31 §6.6/§9/§11): the first automated REAL-protocol
 * remote launch. A real `subshell` (spawned from source via
 * `e2e/stub/client.ts` — no compiled binary, plan deviation #1) redeems a
 * setup key minted through the Add-node dialog, holds the signed node socket,
 * and hosts a subshell launched from the browser: online → inventory → chips
 * → tmux pane ON THE NODE → relayed log → WS attach → terminate → gone.
 *
 * Fixture choice (brief Step 2): ONE test, agent start/stop around a
 * try/finally. Specs 05/06 own tmux inside a single test's body and there is
 * no global fixture hook; a serial `describe` would skip the later tests on a
 * mid-story failure and the `afterAll` is not guaranteed to run before the
 * runner reports — one test's `finally` always runs, which is what the
 * no-leaves contract needs under `workers: 1`. Node/subshell names carry
 * `test.info().retry` (spec 06's idiom) so a CI retry never collides with
 * attempt 0's row (the temp DB survives attempts within a run).
 *
 * Detection model note (spec 2026-09-10 §4, supersedes the P3-T8b connect-
 * push behavior): the agent still pushes `ready`, a census, and an inventory
 * at connect, but the inventory is now an EMPTY claim — post-inversion the
 * node holds no plugin concept, and the server rightly refuses to apply an
 * empty array over the detection rows. What fills the harness list is the
 * plane's `detect` command, sent on request: this spec's Re-check POST is
 * that request, and the create-time gate's FRESHNESS rule (10-min TTL,
 * installed) is what the wait below proves.
 */
test("nodes: real agent from source enrolls, comes online, and hosts a remote launch", async ({ page, request }) => {
  // Agent boot + enrollment + a real tmux spawn on the node, all through the
  // browser path — far beyond the 30 s default.
  test.setTimeout(300_000);

  const nonce = test.info().retry;
  const nodeName = `e2e-node-${nonce}`;
  // No key label to clean up by: the list route answers with the key TEXT now,
  // which is exactly what this test minted and what the teardown below matches.
  const subshellName = `e2e-remote-${nonce}`;

  // ── 1. API truth: the server's own address is loopback under the e2e stack,
  // which is what makes the address dropdown carry exactly one row (step 2):
  // nothing else is reachable, and the old amber warning is gone.
  const pub = await request.get("/api/settings/public");
  expect(pub.ok(), await pub.text()).toBe(true);
  const { appBaseUrl } = (await pub.json()) as { appBaseUrl: string };
  expect(appBaseUrl).toBe(BASE_URL); // Task 3: appBaseUrl ≡ APP_BASE_URL ≡ the stack's origin

  // ── 2. Add-node dialog mints the key the agent will redeem; the rendered
  // command carries the SERVER's address and the address picker offers it.
  await page.goto("/nodes");
  await page.getByRole("button", { name: "Add node" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create setup key" }).click();
  await expect(dialog.getByRole("heading", { name: "Set up the new machine" })).toBeVisible();
  // The key's only carrier is a command now (the standalone box is gone,
  // 2026-09-18) — read it off the one-liner, not from a separate element.
  const command = dialog.locator("code", { hasText: "install.sh?setup_key=" });
  const setupKey = (((await command.textContent()) ?? "").match(/setup_key=(nsk_[^"&\s]+)/)?.[1] ?? "").trim();
  expect(setupKey, "plaintext key rides the command").toMatch(/^nsk_/);
  await expect(command).toContainText(`${BASE_URL}/install.sh?setup_key=${setupKey}`);
  // The dropdown stands where the amber loopback paragraph used to be. Its
  // one row is the base URL (a loopback-only stack knows no reachable
  // address), and the command carries no `&server=` — the selection IS
  // APP_BASE_URL, and a deviation is the only thing worth carrying.
  await expect(dialog.locator('[data-slot="select-trigger"]')).toBeVisible();
  await expect(command).not.toContainText("&server=");
  await dialog.getByRole("button", { name: "Done" }).click();

  // ── 3. The install script AS SERVED by this instance (Task 4 pins, through
  // the live route — not the template file): the SUBSHELL_DATA_DIR knob and the
  // runtime loopback case branch. Asserted BEFORE enrollment: the key spends
  // there and `peekValid` would downgrade this response to the usage script.
  const sh = await request.get(`/install.sh?setup_key=${setupKey}`);
  expect(sh.ok(), await sh.text()).toBe(true);
  const script = await sh.text();
  expect(script).toContain("SUBSHELL_DATA_DIR");
  // The name knob the revamp added: `curl … | SUBSHELL_NODE_NAME=… bash` is how a
  // scripted one-liner names the node, because argv cannot cross the pipe and
  // `setup` no longer guesses a hostname.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
  expect(script).toContain('if [ -n "${SUBSHELL_NODE_NAME:-}" ]; then');
  expect(script).toContain('SETUP_NAME_ARGS=(--name "$SUBSHELL_NODE_NAME")');
  expect(script).toMatch(/\*:\/\/localhost\*/); // the loopback warning's case branch
  expect(script).toContain(`SERVER="${BASE_URL}"`);
  // The `server` param the address dropdown carries, asserted on the LIVE
  // route (the bun test stages it through a plugin seam; this proves the
  // production registry answers the same way). localhost:3199 is the other
  // spelling of this stack's own origin; evil is nobody's origin.
  const baked = await request.get(
    `/install.sh?setup_key=${setupKey}&server=${encodeURIComponent("http://localhost:3199")}`,
  );
  expect(await baked.text()).toContain('SERVER="http://localhost:3199"');
  const refused = await request.get(
    `/install.sh?setup_key=${setupKey}&server=${encodeURIComponent("http://evil.invalid:3199")}`,
  );
  expect(await refused.text()).toContain(`SERVER="${BASE_URL}"`);

  // ── 4–7. The agent's lifetime is fully inside try/finally: a mid-story
  // failure must never leave a daemon, a node row, a spent key, or a tmux
  // server under the default socket dir for the rest of the run.
  const home = mkdtempSync(path.join(tmpdir(), "subshell-e2e-agent-"));
  const dataDir = path.join(home, "data");
  // NOT under `home`: a tmux socket path cannot exceed the kernel's sun_path
  // (104 bytes on macOS), and `home` is an os.tmpdir() mkdtemp whose macOS
  // form already spends ~75 of them (see shortTmuxBase in stack.ts).
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true }); // tmux will not mkdir the TMUX_TMPDIR base itself (stack.ts)
  let agent: RunningAgent | undefined;
  let nodeId: string | undefined;
  let subshellId: string | undefined;
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

    // Detection on demand (spec 2026-09-10 §4): nothing on the connect path
    // fills the harness rows any more, so drive the Re-check — the plane
    // ships its detect rules, the node probes its own PATH/PI_PATH, and the
    // parsed answers merge over the cache. pi must read installed because
    // the agent was spawned with PI_PATH (stub/client.ts).
    const recheck = await request.post(`/api/nodes/${nodeId}/recheck`);
    expect(recheck.ok(), await recheck.text()).toBe(true);
    await pollUntil("the re-check never produced a fresh snapshot with pi installed", agent, async () => {
      const res = await request.get("/api/nodes");
      if (!res.ok()) return false;
      const fresh = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
      return (
        fresh !== undefined && !fresh.inventoryStale && fresh.harnesses.some((h) => h.harnessId === "pi" && h.installed)
      );
    });
    // The harness list is the instance store CROSSED with this node's
    // detection: the plugin lives on the control plane (the agent has no
    // plugins directory to declare from), and "found its program here" is
    // the node's own fact. The row is the product of the two.
    const listed = await request.get("/api/nodes");
    const probed = ((await listed.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
    expect(probed?.harnesses.find((h) => h.harnessId === "pi")).toMatchObject({ installed: true });
    expect(probed?.inventoryStale).toBe(false);

    // ── 5. The /nodes page renders the row: name, online badge, pi chip.
    // The harness chips truncate at three with the rest behind "+N more" (six
    // of them used to crush the name column to one character), so reveal them
    // when the control is there. Whether pi lands inside the inline three
    // depends on what else this dev host has on its PATH, which is exactly the
    // identity a spec must not pin.
    await page.goto("/nodes");
    const nodeRowUi = page.locator("div.rounded-lg", { has: page.getByText(nodeName, { exact: true }) });
    await expect(nodeRowUi).toHaveCount(1);
    await expect(nodeRowUi.getByText("online", { exact: true })).toBeVisible();
    const moreHarnesses = nodeRowUi.getByRole("button", { name: /^\+\d+ more$/ });
    if (await moreHarnesses.count()) await moreHarnesses.click();
    await expect(nodeRowUi.getByText("pi", { exact: true })).toBeVisible();

    // ── 6. Remote launch through the browser: /new, the pi AGENT (no preset
    // — presets are optional since spec 2026-09-13), the e2e node, a temp
    // cwd. Terminal truth stays server-side (AGENTS.md):
    // ws-token + /ws upgrade + no reconnecting pill — never canvas text.
    const workingDir = mkdtempSync(path.join(home, "cwd"));

    // The pairing gate, instance-level form (spec 2026-09-10 §6.1): DISABLING
    // pi at the instance drops its row off EVERY node at once — the store is
    // one, so the old per-node removal no longer exists. The AGENT picker
    // must grey pi with its reason instead of hiding it (the 2026-09-02 rule,
    // now on the agent field — an instance-wide disable carries the
    // server-level reason; the node-option "no pi here" grey for a single
    // missing detection lives on in
    // `lib/subshell-compat`'s unit matrix — an instance disable cannot
    // reproduce it because it takes every node down together), and
    // re-enabling must restore everything with no state rebuilt.
    const disabled = await page.request.patch("/api/plugins/pi", { data: { enabled: false } });
    expect(disabled.ok(), await disabled.text()).toBe(true);

    await page.goto("/new"); // fresh load — the client refetches the plugin views
    await openAgentPicker(page.getByPlaceholder("Choose an agent"));
    // No `exact` name: a greyed option's accessible name carries its reason
    // ("pi disabled on this server"). Only pi's name contains "pi".
    const piOption = page.getByRole("option", { name: "pi" });
    await expect(piOption).toHaveCount(1); // greyed ≠ gone
    await expect(piOption).toBeDisabled(); // aria-disabled row (Base UI item)
    await expect(piOption.getByText("disabled on this server")).toBeVisible(); // server-level reason
    await page.keyboard.press("Escape");

    const enabled = await page.request.patch("/api/plugins/pi", { data: { enabled: true } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    // The re-enable is out-of-band (no mutation to invalidate the query) and
    // /new does not poll nodes — reload so the pickers refetch and see pi
    // offered again (the cached detection on THIS node is seconds old, so the
    // row comes back crossed with it untouched; an aria-disabled row would
    // swallow the real pick).
    const nodeOption = page.getByRole("option", { name: nodeName }); // substring: survives the " · linux/x64" suffix
    await page.goto("/new");
    await pickAgent(page.getByPlaceholder("Choose an agent"), "pi");
    await page.getByPlaceholder("Choose a node").click();
    await nodeOption.click();
    await page.fill("#picker-working-dir", workingDir);
    // The directory-picker panel opens on focus and covers the fields below;
    // a click on the dialog's heading is what closes it without closing the
    // dialog (spec 06's note). The Escape above is right for the COMBOBOX
    // popup, which is a different overlay with the opposite answer.
    await dismissDirectoryPanel(page);

    const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
      timeout: SPAWN_TIMEOUT,
    });
    const socket = page.waitForEvent("websocket", {
      predicate: (w) => w.url().includes("/ws?subshell="),
      timeout: SPAWN_TIMEOUT,
    });
    await page.getByRole("button", { name: "Start subshell" }).click();
    await expect(page).toHaveURL(/\/subshells\/.+/, { timeout: SPAWN_TIMEOUT });
    subshellId = new URL(page.url()).pathname.split("/").pop() as string;
    await tokenRes;
    const ws = await socket;
    expect(ws.url()).toContain("/ws?subshell=");
    // "running" on the detail badge: the control plane's launch RPC answered
    // ok AND the reconcile saw the pane alive — ON THE NODE's tmux server.
    await expect(page.getByText("running", { exact: true }).first()).toBeVisible({ timeout: SPAWN_TIMEOUT });
    await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
    // The launch form asks for no name; the row is addressed by one below.
    await renameSubshell(page, subshellName);

    // The pane is genuinely on the node (its own tmux server, under our
    // TMUX_TMPDIR — not the control plane's) …
    const pane = subshellId;
    await pollUntil(`no tmux pane "${pane}" on the node`, agent, async () => nodeHasPane(tmuxBase, pane), 1_500);
    // …and the log relay (log_read over the node socket) carries its output.
    // The one-shot startup banner can scroll out before pipe-pane attaches
    // (the agent pipes the pane only after new-session), so any `tick <n>` —
    // the stub's every-5s liveness line — is an equally valid signal.
    await pollUntil("relayed log never showed the stub banner or a tick line", agent, async () => {
      const res = await request.get(`/api/subshells/${pane}/log`);
      if (!res.ok()) return false;
      return /(stub harness ready|\btick \d+)/.test(((await res.json()) as { lines: string[] }).lines.join("\n"));
    });

    // ── 7. Close from the subshells list (spec 06's idiom): Close
    // terminates AND deletes in one act (spec 2026-09-03) — the row vanishes
    // and the pane dies on the node (has-session flips false once tmux
    // reaps it); its node artifacts unhook via remove_paths, leaving a clean
    // node for the teardown's node delete (no running subshells).
    await page.goto("/");
    const actions = page.getByRole("button", { name: `Actions for ${subshellName}` });
    await expect(actions).toBeVisible();
    await actions.click();
    await page.getByRole("menuitem", { name: "Close" }).click();
    await expect(page.getByText(`Close subshell "${subshellName}"?`)).toBeVisible();
    await page.locator("[data-slot='dialog-content'] button", { hasText: /^Close$/ }).click();
    await expect(page.getByText(subshellName)).toHaveCount(0, { timeout: SPAWN_TIMEOUT });
    await pollUntil(
      `pane "${pane}" outlived close on the node`,
      agent,
      async () => !nodeHasPane(tmuxBase, pane),
      1_500,
    );

    // ── 8. Maintenance, over the real wire in BOTH directions (spec
    // 2026-09-14). What only an end-to-end run can prove is the wire itself:
    // that the plane's push reaches a real agent's disk, that a real CLI's
    // write reaches the plane, and that the refusal survives the whole stack.
    // The stopping half — terminating other people's subshells — is pinned in
    // `set-node-maintenance.route.test.ts`, which can script a refused kill;
    // repeating it here would cost a second launch to prove less.
    const mirror = path.join(dataDir, "maintenance.json");
    const mirrorSays = (on: boolean): boolean => {
      if (!existsSync(mirror)) return false;
      try {
        return (JSON.parse(readFileSync(mirror, "utf8")) as { on: boolean }).on === on;
      } catch {
        return false; // a half-written file is not an answer
      }
    };
    // Plane → machine: the agent writes its OWN mirror, which is what makes
    // the node refuse launches even before the plane's own gate is consulted.
    const intoMaintenance = await request.put(`/api/nodes/${nodeId}/maintenance`, { data: { on: true } });
    expect(intoMaintenance.ok(), await intoMaintenance.text()).toBe(true);
    await pollUntil("the node never wrote the mirror the plane pushed", agent, async () => mirrorSays(true));

    // And the refusal reaches a caller as the node's reason rather than as a
    // generic failure — the 409 an older build answered 500 for.
    const refused = await request.post("/api/subshells", {
      data: { harnessId: "pi", workingDir, nodeId },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("NODE_IN_MAINTENANCE");

    const outOfMaintenance = await request.put(`/api/nodes/${nodeId}/maintenance`, { data: { on: false } });
    expect(outOfMaintenance.ok(), await outOfMaintenance.text()).toBe(true);
    await pollUntil("the node never cleared the mirror", agent, async () => mirrorSays(false));

    // Machine → plane: `subshell maintenance` writes the file, and the DAEMON
    // is what tells the plane — there is no IPC between the two processes, so
    // this also proves the heartbeat re-read actually fires.
    const cliEnv = { ...process.env, SUBSHELL_CONFIG_HOME: home, TMUX_TMPDIR: tmuxBase };
    const flip = spawnSync("bun", [AGENT_MAIN, "maintenance", "on", "--yes"], { env: cliEnv, encoding: "utf8" });
    expect(flip.status, `${flip.stdout ?? ""}${flip.stderr ?? ""}`).toBe(0);
    await pollUntil("the plane never learned the machine's own flip", agent, async () => {
      const res = await request.get(`/api/nodes/${nodeId}`);
      if (!res.ok()) return false;
      const view = (await res.json()) as { maintenance: boolean; maintenanceSource: string | null };
      // `source` is the half a person reads on the page: the machine said this,
      // not a browser.
      return view.maintenance === true && view.maintenanceSource === "node";
    });
    // Leave it launchable: the teardown below deletes the node, and a machine
    // left in maintenance would make the next run's failure message a puzzle.
    const unflip = spawnSync("bun", [AGENT_MAIN, "maintenance", "off"], { env: cliEnv, encoding: "utf8" });
    expect(unflip.status, `${unflip.stdout ?? ""}${unflip.stderr ?? ""}`).toBe(0);
    await pollUntil("the plane never learned the machine ended maintenance", agent, async () => {
      const res = await request.get(`/api/nodes/${nodeId}`);
      return res.ok() && ((await res.json()) as { maintenance: boolean }).maintenance === false;
    });
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
        keys: { id: string; key: string }[];
      };
      for (const k of keys.keys.filter((k) => k.key === setupKey)) {
        const rev = await request.delete(`/api/nodes/setup-keys/${k.id}`);
        if (!rev.ok() && rev.status() !== 404) leaks.push(`setup-key revoke: HTTP ${rev.status()}`);
      }
    } catch (err) {
      leaks.push(`setup-key revoke: ${String(err)}`);
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(tmuxBase), { recursive: true, force: true });
    if (leaks.length > 0) console.error(`[12-nodes] cleanup problems: ${leaks.join("; ")}`);
  }
});
