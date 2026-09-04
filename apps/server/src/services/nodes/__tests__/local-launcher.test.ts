import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness, TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
import { LocalLauncher } from "../local-launcher.js";
import type { LaunchPlan } from "../node-launcher.js";
import { subshellLogPath } from "../subshell-paths.js";

const tmux = new TmuxRunner();
const launcher = new LocalLauncher({ tmux });
const id = `launcher-test-${process.pid}`;
const socket = tmuxSocketFor(id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
  tmux.killSubshell(socket, id);
  tmux.cleanSocket(socket);
  void Bun.file(subshellLogPath(id))
    .unlink()
    .catch(() => {});
});

describe("LocalLauncher pane lifecycle (direct tmux seeding)", () => {
  beforeAll(() => {
    tmux.newSubshell(socket, id, tmpdir(), "sleep 30");
  });

  it("hasSubshell / capture / sendInput round-trip", async () => {
    expect(await launcher.hasSubshell(socket, id)).toBe(true);
    await launcher.sendInput(socket, id, "marker-not-typed\r"); // no Enter yet
    expect(await launcher.capture(socket, id)).toContain("marker-not-typed");
    await launcher.resize(socket, id, 120, 40);
    expect(await launcher.paneTitle(socket, id)).not.toBeNull();
    expect(await launcher.paneExitCode(socket, id)).toBeNull(); // still alive
  });

  it("log plumbing: readLogTail / readLog / tailStart disposer (pane seeded directly)", async () => {
    // `launch()`'s command assembly is covered byte-identically by the
    // pi-stub cases in subshell-manager.service.test.ts (routed through the
    // launcher by Step 3), so this file covers the LOG side: seed a pane
    // directly and pipe it to the launcher's own logPath, then read through
    // the launcher API.
    const lid = `${id}-log`;
    const lsock = tmuxSocketFor(lid);
    // The `sleep 0.2` is load-bearing: pipe-pane streams only what the pane
    // writes AFTER the pipe attaches (no scrollback replay), and a bare
    // `echo hi` loses that race deterministically on this host — the pane's
    // shell prints before the second tmux client call lands. Same reason the
    // production harnesses never hit this: real CLIs boot in 100ms+.
    tmux.newSubshell(lsock, lid, tmpdir(), "sleep 0.2; echo hi; sleep 6");
    tmux.pipePane(lsock, lid, subshellLogPath(lid));
    await sleep(400); // pipe-pane flush
    const tail = await launcher.readLogTail(lid);
    expect(tail.lines.join("\n")).toContain("hi");
    const read = await launcher.readLog(lid, 0, 1024);
    expect(read.bytes.byteLength).toBeGreaterThan(0);
    expect(read.next).toBe(read.bytes.byteLength);
    const chunks: Uint8Array[] = [];
    const stop = await launcher.tailStart(lid, "sub1", read.next, (b) => chunks.push(b));
    tmux.sendInput(lsock, lid, "streamed\r");
    await sleep(600);
    stop();
    const before = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(before).toBeGreaterThan(0);
    stop(); // disposer is idempotent
    tmux.sendInput(lsock, lid, "after-stop\r");
    await sleep(600);
    expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(before);
    tmux.killSubshell(lsock, lid);
    tmux.cleanSocket(lsock);
    await launcher.removeArtifacts([subshellLogPath(lid)]);
    expect((await launcher.readLogTail(lid)).lines).toEqual([]); // missing log = empty
  });

  it("paneSize reads the size back, which is what makes a resize acknowledgeable", async () => {
    // The 2026-09-04 root cause: a resize request that was lost or overtaken
    // left the pane at a size the browser did not share, and nothing noticed.
    // Reading back is what turns "I asked" into "the pane has".
    await launcher.resize(socket, id, 61, 17);
    expect(await launcher.paneSize(socket, id)).toEqual({ cols: 61, rows: 17 });
    await launcher.resize(socket, id, 51, 13);
    expect(await launcher.paneSize(socket, id)).toEqual({ cols: 51, rows: 13 });
    // A dead socket cannot be measured — callers then report what they applied.
    expect(await launcher.paneSize("subshell-no-such-socket", id)).toBeNull();
  });

  it("paneCursor answers for a live pane and null once it is gone", async () => {
    const cur = await launcher.paneCursor(socket, id);
    expect(cur).not.toBeNull();
    expect(Number.isInteger(cur?.x) && Number.isInteger(cur?.y)).toBe(true);
    // A dead socket answers null. (A GONE name on a LIVE server does not:
    // `display-message -t` falls through to the server's newest session and
    // prints that pane's cursor — same reason the attach path probes liveness
    // with `has-session`, never with a display-message.)
    expect(await launcher.paneCursor("subshell-no-such-socket", id)).toBeNull();
  });

  it("signalPaneWinch repaints the pane WITHOUT touching its geometry; dead pane ⇒ false", async () => {
    // The whole point of the winch route (vs the ±1 resize nudge): the app
    // gets a SIGWINCH it must answer with a repaint while tmux never reflows
    // the pane's history. A shell that traps WINCH and prints proves the
    // signal reached the pane's own process group; the width probe proves the
    // geometry never moved.
    const wid = `${id}-winch`;
    const wsock = tmuxSocketFor(wid);
    tmux.newSubshell(wsock, wid, tmpdir(), "trap 'echo WINCH-GOT' WINCH; while :; do sleep 0.2; done");
    await sleep(400); // the trap is installed once the shell reaches the loop
    try {
      const sizeBefore = tmux
        .run(["-L", wsock, "display-message", "-t", wid, "-p", "#{window_width}x#{window_height}"], {})
        .stdout.trim();
      expect(await launcher.signalPaneWinch(wsock, wid)).toBe(true);
      const deadline = Date.now() + 4000;
      let painted = "";
      while (Date.now() < deadline && !painted.includes("WINCH-GOT")) {
        painted = await launcher.capture(wsock, wid);
        await sleep(100);
      }
      expect(painted).toContain("WINCH-GOT"); // the signal arrived where it was aimed
      const sizeAfter = tmux
        .run(["-L", wsock, "display-message", "-t", wid, "-p", "#{window_width}x#{window_height}"], {})
        .stdout.trim();
      expect(sizeAfter).toBe(sizeBefore); // and NOTHING reflowed
    } finally {
      tmux.killSubshell(wsock, wid);
      tmux.cleanSocket(wsock);
    }
    // No pane, no signal — the caller must fall back to the resize nudge.
    expect(await launcher.signalPaneWinch(wsock, wid)).toBe(false);
  });

  it("terminate kills the subshell", async () => {
    await launcher.terminate(socket, id);
    expect(await launcher.hasSubshell(socket, id)).toBe(false);
  });
});

describe("LocalLauncher.deliverPrompt (real panes)", () => {
  it("types + submits once the pane shows output, and gives up on a never-settling pane", async () => {
    const pid = `${id}-prompt`;
    const psock = tmuxSocketFor(pid);
    // An interactive shell that prints a banner: capture settles, Enter runs
    // the typed echo, and the marker lands back in the pane.
    tmux.newSubshell(psock, pid, tmpdir(), "echo ready; exec sh");
    const delivered = await launcher.deliverPrompt(psock, pid, "echo delivered-marker", 5_000, 50);
    expect(delivered).toBe(true);
    await sleep(400); // the pane's shell needs a beat to run the echo
    expect(await launcher.capture(psock, pid)).toContain("delivered-marker");
    tmux.killSubshell(psock, pid);
    tmux.cleanSocket(psock);

    // A plain `sleep` pane never prints → capture stays blank → give up false.
    const bid = `${id}-blank`;
    const bsock = tmuxSocketFor(bid);
    tmux.newSubshell(bsock, bid, tmpdir(), "sleep 30");
    expect(await launcher.deliverPrompt(bsock, bid, "echo never", 250, 50)).toBe(false);
    tmux.killSubshell(bsock, bid);
    tmux.cleanSocket(bsock);
  }, 30_000);
});

describe("LocalLauncher.launch bestEffortLog (scripted tmux — no real spawn)", () => {
  /** Counts the spawn; pipePane always throws (simulated log-attach failure). */
  class ScriptedTmux extends TmuxRunner {
    spawns = 0;
    pipes = 0;
    override newSubshell(_socket: string, _sessionName: string, _cwd: string, _cmd: string): void {
      this.spawns++;
    }
    override pipePane(): void {
      this.pipes++;
      throw new Error("pipe-pane attach failed (test)");
    }
  }
  const scripted = new ScriptedTmux();
  const launcher2 = new LocalLauncher({ tmux: scripted });
  const pi = getHarness("pi");
  if (!pi) throw new Error("pi harness plugin missing from ALL_HARNESSES");
  const plan = (bestEffortLog: boolean): LaunchPlan => ({
    id: `launch-besteffort-${process.pid}`,
    socket: tmuxSocketFor(`launch-besteffort-${process.pid}`),
    harness: pi,
    binary: "/bin/true",
    cwd: tmpdir(),
    profile: {
      name: "p",
      description: null,
      env: {},
      flags: [],
      settings: null,
      configIsolation: false,
      restartOnExit: false,
    },
    subshellName: "s",
    subshellEnv: {},
    bestEffortLog,
  });

  it("bestEffortLog: a throwing pipe-pane inside the guarded region does not fail the launch", async () => {
    // The log-dir mkdir lives in this SAME guarded region (launch(): a mkdir
    // throw after the spawn must not escape a revive either); pipePane is the
    // cheap throw seam that pins the region — the mkdir shares it by
    // construction, both sit inside the one try block.
    await expect(launcher2.launch(plan(true))).resolves.toBeUndefined();
    expect(scripted.spawns).toBe(1);
    expect(scripted.pipes).toBe(1); // attach was attempted…
  });

  it("strict path: the same throw escapes (createSubshell's semantics)", async () => {
    await expect(launcher2.launch(plan(false))).rejects.toThrow(/pipe-pane/);
    expect(scripted.spawns).toBe(2);
    expect(scripted.pipes).toBe(2);
  });
});

describe("LocalLauncher artifacts + validation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "launcher-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("validateWorkingDir rejects missing paths", async () => {
    await expect(launcher.validateWorkingDir(join(tmp, "nope"))).rejects.toThrow(/Path does not exist/);
  });
});
