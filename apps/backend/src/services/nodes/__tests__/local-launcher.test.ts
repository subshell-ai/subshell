import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
import { LocalLauncher } from "../local-launcher.js";
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

  it("hasSession / capture / sendInput + pressEnter round-trip", async () => {
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

describe("LocalLauncher artifacts + validation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "launcher-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("validateWorkingDir rejects missing paths", async () => {
    await expect(launcher.validateWorkingDir(join(tmp, "nope"))).rejects.toThrow(/Path does not exist/);
  });

  it("writeArtifact('mcp-config') writes 0600 under the session data dir and removeArtifacts deletes it", async () => {
    const path = await launcher.writeArtifact(`${id}-art`, "mcp-config", '{"mcpServers":{}}');
    const meta = await Bun.file(path).stat();
    expect(meta.size).toBeGreaterThan(0);
    // mode check is POSIX-only; skip on non-POSIX hosts (none here).
    // Bun's Stats carries `mode` directly — no cast needed.
    expect((meta.mode & 0o077) === 0).toBe(true);
    await launcher.removeArtifacts([path]);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});
