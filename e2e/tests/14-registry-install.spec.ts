import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { shortTmuxBase } from "../stack";
import { type RunningNode, startNode } from "../stub/client";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Agent boot + enrollment + a real tmux spawn on the node; later polls are shorter. */
const SPAWN_TIMEOUT = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One harness row of a node view (`NodeHarnessViewSchema`; the fields this
 * spec reads — the row also carries the display name the web card renders). */
interface HarnessRow {
  harnessId: string;
  installed: boolean;
}

/** A node row fragment this spec reads (GET /api/nodes/:id, NodeView). */
interface NodeView {
  harnesses: HarnessRow[];
  inventoryStale: boolean;
}

/**
 * True when a tmux session named `paneName` lives on ANY server under
 * `tmuxBase` — spec 12's check, local copy, same reason: the agent daemonises
 * its servers under its own TMUX_TMPDIR, and the socket NAME is the server's
 * hash so the directory is enumerated rather than recomputed.
 */
function nodeHasPane(tmuxBase: string, paneName: string): boolean {
  const uidDir = path.join(tmuxBase, `tmux-${process.getuid?.() ?? 0}`);
  let sockets: string[];
  try {
    sockets = readdirSync(uidDir).map((s) => path.join(uidDir, s));
  } catch {
    return false;
  }
  return sockets.some((sock) => spawnSync("tmux", ["-S", sock, "has-session", "-t", paneName]).status === 0);
}

/** Best-effort: kill every tmux server whose socket lives under `tmuxBase`. */
function sweepTmuxServers(tmuxBase: string): void {
  const uidDir = path.join(tmuxBase, `tmux-${process.getuid?.() ?? 0}`);
  let sockets: string[];
  try {
    sockets = readdirSync(uidDir).map((s) => path.join(uidDir, s));
  } catch {
    return;
  }
  for (const sock of sockets) {
    spawnSync("tmux", ["-S", sock, "kill-server"]);
  }
}

/**
 * THE chain the whole inversion was for, end to end (spec 2026-09-10 §6 +
 * Task 9b): a plugin installed on the CONTROL PLANE from the fake registry
 * (stack.ts's :3198 — no public network, ever) becomes detectable and
 * launchable on an ENROLLED AGENT NODE that holds nothing. The agent gets a
 * fresh `--data-dir`, so it never had a `plugins/` directory and never will:
 * the argv, the detection rule and the MCP dialect all arrive on the wire.
 *
 * API-first, with one browser pass: the install door and every chain
 * assertion are API (this spec's tradition, and the picker/UI behaviour is
 * spec 11/13's turf), but the install itself goes through nothing less
 * instance-level than `POST /api/plugins` — the route the Settings → Plugins
 * page drives, which the spec then renders once to prove the row is there
 * with its identity.
 *
 * The agent's lifetime is fully inside try/finally like spec 12's: a
 * mid-story failure must never leave a daemon, a node row, a spent key, a
 * tmux server, or — the new leak class this spec owns — an INSTALLED PLUGIN
 * behind for the rest of the run, because a phantom harness in the instance
 * store puts a row in every later picker on every node. The uninstall at the
 * end of the happy path already clears it; the finally is cheap insurance
 * (the route answers the same way for an already-absent id).
 */
test("a registry plugin installed on the control plane launches on a node that holds nothing", async ({
  page,
  request,
}) => {
  // Agent boot + enrollment + a real tmux spawn on the node, all through the
  // API — far beyond the 30 s default.
  test.setTimeout(300_000);

  const nonce = test.info().retry;
  const nodeName = `e2e-reg-${nonce}`;
  const subshellName = `e2e-reg-pane-${nonce}`;

  const home = mkdtempSync(path.join(tmpdir(), "subshell-e2e-reg-"));
  const dataDir = path.join(home, "data");
  // NOT under `home`: the sun_path budget (spec 12's note on shortTmuxBase).
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });
  let agent: RunningNode | undefined;
  let nodeId: string | undefined;
  let setupKeyId: string | undefined;
  let subshellId: string | undefined;
  let installed = false;
  try {
    // ── 1. The instance door. A `spec` fetches from the fake registry; the
    // bytes are load-checked IN THIS PROCESS and the response is the plugin's
    // row: installed, not built-in, carrying its manifest identity.
    const install = await request.post("/api/plugins", {
      data: { pluginId: "e2e-demo", spec: "e2e-demo@1.0.0" },
    });
    expect(install.ok(), await install.text()).toBe(true);
    installed = true;
    expect(await install.json()).toMatchObject({ id: "e2e-demo", name: "E2E demo", installed: true, builtIn: false });

    // ── 2. One browser pass: Settings → Plugins renders the row by its NAME
    // (the identity fix the per-node card never had — its catalog was
    // embedded-only and rendered third-party ids verbatim).
    await page.goto("/settings/plugins");
    const installedCard = page.locator("div.rounded-lg", { has: page.getByText("Installed", { exact: true }) });
    await expect(installedCard.getByText("E2E demo", { exact: true })).toBeVisible();

    // ── 3. A real agent on a pristine data dir. Setup key → enroll → run,
    // exactly spec 12's idiom; the env carries PI_PATH (stub/pi) which is
    // the ONLY harness binary this node has — and the only one the fixture's
    // detect block can find.
    // No body: the mint takes nothing since the node names itself. Posting the old
    // `label` would still pass — a route ignores what it does not read — which is
    // exactly why it should not be here.
    const keyRes = await request.post("/api/nodes/setup-keys");
    expect(keyRes.ok(), await keyRes.text()).toBe(true);
    const { id: mintedId, key } = (await keyRes.json()) as { id: string; key: string };
    setupKeyId = mintedId;
    agent = await startNode({ home, dataDir, tmuxBase, setupKey: key, name: nodeName });

    const deadline = Date.now() + SPAWN_TIMEOUT;
    for (;;) {
      const res = await request.get("/api/nodes");
      expect(res.ok(), await res.text()).toBe(true);
      const row = ((await res.json()) as { nodes: { id: string; name: string; status: string }[] }).nodes.find(
        (n) => n.name === nodeName,
      );
      if (row) nodeId = row.id;
      if (row?.status === "online") break;
      if (Date.now() > deadline) throw new Error(`node "${nodeName}" never came online\n${agent.logTail()}`);
      await sleep(500);
    }
    // The data dir holds NO plugins directory — nothing seeded it, because
    // post-inversion the agent has no plugin concept to seed.
    expect(readdirSync(dataDir).includes("plugins")).toBe(false);

    // ── 4. Task 9b's chain. GET /api/nodes/:id IS the request to re-probe
    // (spec 2026-09-10 §4: opening the node's page fires the plane's `detect`
    // command with the instance store's rules). The plugin the node never
    // heard of becomes DETECTED there, because its binary is the stub pi the
    // agent env names.
    const detectDeadline = Date.now() + SPAWN_TIMEOUT;
    for (;;) {
      const res = await request.get(`/api/nodes/${nodeId}`);
      if (res.ok()) {
        const view = (await res.json()) as NodeView;
        const demo = view.harnesses.find((h) => h.harnessId === "e2e-demo");
        if (demo?.installed) break;
      }
      if (Date.now() > detectDeadline) {
        throw new Error(`e2e-demo never became detectable on the node\n--- agent log ---\n${agent.logTail()}`);
      }
      await sleep(1_000);
    }

    // ── 5. And LAUNCHABLE: the launch is harness-first (spec 2026-09-13),
    // so the create POST names the plugin with NO presetId at all — which
    // also makes this the remote-host end-to-end proof of the empty-preset
    // argv path on a third-party plugin (apiVersion 2 + validatePreset).
    // API-first like this spec's tradition — the picker's UI for the same
    // state is spec 13's turf.
    const workingDir = mkdtempSync(path.join(home, "cwd"));
    const created = await request.post("/api/subshells", {
      data: { harnessId: "e2e-demo", workingDir, nodeId, name: subshellName },
    });
    expect(created.ok(), await created.text()).toBe(true);
    subshellId = (await created.json()).id as string;

    // Running = the launch RPC answered ok AND reconcile saw the pane alive.
    // The pane was spawned from the PLANE-built argv with the node-resolved
    // binary; the relayed log is read from the node's disk. Terminal truth
    // stays server-side (e2e AGENTS.md).
    const runDeadline = Date.now() + SPAWN_TIMEOUT;
    for (;;) {
      const res = await request.get(`/api/subshells/${subshellId}`);
      if (res.ok() && ((await res.json()) as { status: string }).status === "running") break;
      if (Date.now() > runDeadline) {
        throw new Error(`subshell never reached "running"\n--- agent log ---\n${agent.logTail()}`);
      }
      await sleep(1_000);
    }
    const logDeadline = Date.now() + SPAWN_TIMEOUT;
    for (;;) {
      const res = await request.get(`/api/subshells/${subshellId}/log`);
      if (res.ok()) {
        const lines = ((await res.json()) as { lines: string[] }).lines.join("\n");
        if (/(stub harness ready|\btick \d+)/.test(lines)) break;
      }
      if (Date.now() > logDeadline) {
        throw new Error(`relayed log never showed the stub harness\n--- agent log ---\n${agent.logTail()}`);
      }
      await sleep(1_500);
    }
    // The pane is genuinely on the NODE's tmux server, not the plane's.
    expect(nodeHasPane(tmuxBase, subshellId)).toBe(true);

    // ── 6. Close it, uninstall, and the node forgets the row: the harness
    // list is the instance store crossed with detection, so removing the
    // instance's copy removes it from every node without touching the node.
    await request.delete(`/api/subshells/${subshellId}`);
    subshellId = undefined;
    const un = await request.delete("/api/plugins/e2e-demo");
    expect(un.ok(), await un.text()).toBe(true);
    installed = false;
    const forgetDeadline = Date.now() + SPAWN_TIMEOUT;
    for (;;) {
      const res = await request.get(`/api/nodes/${nodeId}`);
      if (res.ok()) {
        const view = (await res.json()) as NodeView;
        if (!view.harnesses.some((h) => h.harnessId === "e2e-demo")) break;
      }
      if (Date.now() > forgetDeadline) throw new Error("the node never dropped the e2e-demo row after the uninstall");
      await sleep(1_000);
    }
  } finally {
    const leaks: string[] = [];
    // Order: pane, then daemon (the row must flip offline before DELETE),
    // then its tmux servers, then the rows only this API can remove, then
    // the plugin (the instance-wide leak this spec is responsible for).
    if (subshellId) {
      try {
        await request.delete(`/api/subshells/${subshellId}`);
      } catch (err) {
        leaks.push(`subshell delete: ${String(err)}`);
      }
    }
    try {
      await agent?.stop();
    } catch (err) {
      leaks.push(`agent stop: ${String(err)}`);
    }
    sweepTmuxServers(tmuxBase);
    if (nodeId) {
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
    if (setupKeyId) {
      try {
        await request.delete(`/api/nodes/setup-keys/${setupKeyId}`);
      } catch (err) {
        leaks.push(`setup-key revoke: ${String(err)}`);
      }
    }
    if (installed) {
      try {
        await request.delete("/api/plugins/e2e-demo");
      } catch (err) {
        leaks.push(`plugin uninstall: ${String(err)}`);
      }
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(tmuxBase), { recursive: true, force: true });
    if (leaks.length > 0) console.error(`[14-registry-install] cleanup problems: ${leaks.join("; ")}`);
  }
});
