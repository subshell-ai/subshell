import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness, TmuxRunner, tmuxSocketFor } from "@internal/pane-runtime";
import { TRUE_BINARY } from "@/__tests__/helpers/true-binary.js";
import { TAIL_BACKSTOP_MS } from "@/services/nodes/log-tail.js";
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
  void tmux.cleanSocket(socket);
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
    const total = () => chunks.reduce((n, c) => n + c.byteLength, 0);
    tmux.sendInput(lsock, lid, "streamed\r");
    // POLL rather than sleep a fixed span. tailStart delivers on an fs.watch
    // event with a TAIL_BACKSTOP_MS (1s) poll behind it, and only Linux's
    // inotify is prompt: macOS coalesces FSEvents, so a fixed 600ms wait —
    // shorter than the backstop itself — lost the race deterministically on a
    // Mac and passed in CI. The deadline is comfortably past the backstop, so
    // this asserts the same delivery on both platforms.
    const deadline = Date.now() + 5000;
    while (total() === 0 && Date.now() < deadline) await sleep(50);
    stop();
    const before = total();
    expect(before).toBeGreaterThan(0);
    stop(); // disposer is idempotent
    tmux.sendInput(lsock, lid, "after-stop\r");
    // A fixed wait is right for proving ABSENCE, but it has to outlast the
    // backstop or a stopped tailer would look quiet merely by being polled.
    await sleep(TAIL_BACKSTOP_MS + 500);
    expect(total()).toBe(before);
    tmux.killSubshell(lsock, lid);
    void tmux.cleanSocket(lsock);
    await launcher.removeArtifacts([subshellLogPath(lid)]);
    expect((await launcher.readLogTail(lid)).lines).toEqual([]); // missing log = empty
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
      void tmux.cleanSocket(wsock);
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
    void tmux.cleanSocket(psock);

    // A plain `sleep` pane never prints → capture stays blank → give up false.
    const bid = `${id}-blank`;
    const bsock = tmuxSocketFor(bid);
    tmux.newSubshell(bsock, bid, tmpdir(), "sleep 30");
    expect(await launcher.deliverPrompt(bsock, bid, "echo never", 250, 50)).toBe(false);
    tmux.killSubshell(bsock, bid);
    void tmux.cleanSocket(bsock);
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
  if (!pi) throw new Error("pi harness plugin missing from allHarnesses()");
  const plan = (bestEffortLog: boolean): LaunchPlan => ({
    id: `launch-besteffort-${process.pid}`,
    socket: tmuxSocketFor(`launch-besteffort-${process.pid}`),
    harness: pi,
    binary: TRUE_BINARY,
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
