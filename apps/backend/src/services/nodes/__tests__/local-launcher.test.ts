import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness, TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
import { LocalLauncher } from "../local-launcher.js";
import type { LaunchPlan } from "../node-launcher.js";
import { sessionLogPath } from "../session-paths.js";

const tmux = new TmuxRunner();
const launcher = new LocalLauncher({ tmux });
const id = `launcher-test-${process.pid}`;
const socket = tmuxSocketFor(id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
  tmux.killSession(socket, id);
  tmux.cleanSocket(socket);
  void Bun.file(sessionLogPath(id))
    .unlink()
    .catch(() => {});
});

describe("LocalLauncher pane lifecycle (direct tmux seeding)", () => {
  beforeAll(() => {
    tmux.newSession(socket, id, tmpdir(), "sleep 30");
  });

  it("hasSession / capture / sendInput round-trip", async () => {
    expect(await launcher.hasSession(socket, id)).toBe(true);
    await launcher.sendInput(socket, id, "marker-not-typed\r"); // no Enter yet
    expect(await launcher.capture(socket, id)).toContain("marker-not-typed");
    await launcher.resize(socket, id, 120, 40);
    expect(await launcher.paneTitle(socket, id)).not.toBeNull();
    expect(await launcher.paneExitCode(socket, id)).toBeNull(); // still alive
  });

  it("log plumbing: readLogTail / readLog / tailStart disposer (pane seeded directly)", async () => {
    // `launch()`'s command assembly is covered byte-identically by the
    // pi-stub cases in session-manager.service.test.ts (routed through the
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
    tmux.newSession(lsock, lid, tmpdir(), "sleep 0.2; echo hi; sleep 6");
    tmux.pipePane(lsock, lid, sessionLogPath(lid));
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
    tmux.killSession(lsock, lid);
    tmux.cleanSocket(lsock);
    await launcher.removeArtifacts([sessionLogPath(lid)]);
    expect((await launcher.readLogTail(lid)).lines).toEqual([]); // missing log = empty
  });

  it("terminate kills the session", async () => {
    await launcher.terminate(socket, id);
    expect(await launcher.hasSession(socket, id)).toBe(false);
  });
});

describe("LocalLauncher.deliverPrompt (real panes)", () => {
  it("types + submits once the pane shows output, and gives up on a never-settling pane", async () => {
    const pid = `${id}-prompt`;
    const psock = tmuxSocketFor(pid);
    // An interactive shell that prints a banner: capture settles, Enter runs
    // the typed echo, and the marker lands back in the pane.
    tmux.newSession(psock, pid, tmpdir(), "echo ready; exec sh");
    const delivered = await launcher.deliverPrompt(psock, pid, "echo delivered-marker", 5_000, 50);
    expect(delivered).toBe(true);
    await sleep(400); // the pane's shell needs a beat to run the echo
    expect(await launcher.capture(psock, pid)).toContain("delivered-marker");
    tmux.killSession(psock, pid);
    tmux.cleanSocket(psock);

    // A plain `sleep` pane never prints → capture stays blank → give up false.
    const bid = `${id}-blank`;
    const bsock = tmuxSocketFor(bid);
    tmux.newSession(bsock, bid, tmpdir(), "sleep 30");
    expect(await launcher.deliverPrompt(bsock, bid, "echo never", 250, 50)).toBe(false);
    tmux.killSession(bsock, bid);
    tmux.cleanSocket(bsock);
  }, 30_000);
});

describe("LocalLauncher.launch bestEffortLog (scripted tmux — no real spawn)", () => {
  /** Counts the spawn; pipePane always throws (simulated log-attach failure). */
  class ScriptedTmux extends TmuxRunner {
    spawns = 0;
    pipes = 0;
    override newSession(_socket: string, _sessionName: string, _cwd: string, _cmd: string): void {
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
    sessionName: "s",
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

  it("strict path: the same throw escapes (createSession's semantics)", async () => {
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
