import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { assertSocketPathFits, TmuxRunner, tmuxSocketFor, tmuxSocketPath } from "../tmux-runner.js";
import { freshSocket, runner, socketSeq } from "./helpers/tmux-test-harness.js";

/**
 * Liveness and geometry probes against REAL servers: what counts as alive under
 * `remain-on-exit`, the tri-state socket probe, pane pid/size/cursor/exit-code
 * reads, and the socket-path guard. Split out of tmux-runner.test.ts.
 */
describe("TmuxRunner", () => {
  it("derives stable unique sockets", () => {
    const a = tmuxSocketFor("abc");
    const b = tmuxSocketFor("abc");
    const c = tmuxSocketFor("def");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^subshell-/);
  });

  it("creates and kills a subshell", async () => {
    const socket = freshSocket("subshell");
    runner.newSubshell(socket, "s1", "/tmp", "echo hello-test; exec sleep 30");
    expect(await runner.hasSubshell(socket, "s1")).toBe(true);

    // Give the shell a moment to render before capturing
    await Bun.sleep(300);
    const out = await runner.capturePane(socket, "s1");
    expect(out).toContain("hello-test");

    runner.killSubshell(socket, "s1");
    expect(await runner.hasSubshell(socket, "s1")).toBe(false);
  });

  it("reads a FINISHED pane as not alive, though `remain-on-exit` keeps its session", async () => {
    // The reason this asks `#{pane_dead}` rather than `has-session`: with
    // `remain-on-exit` the session outlives the process, so the old question
    // answered "alive" for a subshell whose command had ended. Every caller
    // here — the reconcile sweep, the attach gate, the node's maintenance CLI
    // — means "is there a LIVE pane".
    const socket = freshSocket("deadpane");
    runner.newSubshell(socket, "d1", "/tmp", "sh -c 'exit 3'");
    for (let i = 0; i < 40 && (await runner.hasSubshell(socket, "d1")); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await runner.hasSubshell(socket, "d1")).toBe(false);
    // …and only because tmux said `1`. The sweep's death branch is
    // destructive, so anything else it might answer is read as ALIVE — see
    // the method: unknown is not dead.
    expect(runner.listSubshellNames(socket)).toContain("d1");
    runner.killSubshell(socket, "d1");
  });

  it("lists subshell names on a socket in one spawn (batched liveness)", async () => {
    const socket = freshSocket("list");
    runner.newSubshell(socket, "ls-a", "/tmp", "exec sleep 30");
    runner.newSubshell(socket, "ls-b", "/tmp", "exec sleep 30");
    expect(runner.listSubshellNames(socket).sort()).toEqual(["ls-a", "ls-b"]);

    runner.killSubshell(socket, "ls-a");
    expect(runner.listSubshellNames(socket)).toEqual(["ls-b"]);
    runner.killSubshell(socket, "ls-b");
    // Server gone / no subshells: swallow-errors like hasSubshell — just empty.
    expect(runner.listSubshellNames(socket)).toEqual([]);
    expect(runner.listSubshellNames("subshell-no-such-server")).toEqual([]);
  });

  // Tri-state probe (design 2026-09-02 §1): the exit watcher must be able to
  // tell "socket answered, pane missing" (death) from "socket did not answer"
  // (blip-or-death — indistinguishable from here; the threshold decides).

  it("listSubshellsChecked: live socket ⇒ ok:true with every name", async () => {
    const socket = freshSocket("checked");
    runner.newSubshell(socket, "ck-a", "/tmp", "exec sleep 30");
    const probe = await runner.listSubshellsChecked(socket);
    expect(probe).toEqual({ ok: true, names: ["ck-a"] });
    runner.killSubshell(socket, "ck-a");
  });

  it("listSubshellsChecked: absent socket ⇒ ok:false whose detail names the socket/connection error", async () => {
    const socket = freshSocket("checked-absent"); // never started — no server, no socket file
    const probe = await runner.listSubshellsChecked(socket);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      // Real tmux 3.x answers "error connecting to /tmp/tmux-<uid>/<name>
      // (No such file or directory)" — the detail must carry enough for the
      // escalation log line to be diagnosable.
      expect(probe.detail).toContain(socket);
      expect(probe.detail).toMatch(/error connecting|no server/i);
    }
  });

  it("listSubshellsChecked: after the server dies ⇒ ok:false (where listSubshellNames lies with [])", async () => {
    const socket = freshSocket("checked-dead");
    runner.newSubshell(socket, "ck-d", "/tmp", "exec sleep 30");
    expect((await runner.listSubshellsChecked(socket)).ok).toBe(true);
    spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    const probe = await runner.listSubshellsChecked(socket);
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.detail.length).toBeGreaterThan(0);
  });
  it("relaunching on a just-emptied socket wins the server-shutdown race (restart path)", async () => {
    // THE restart bug: killing a socket's last subshell makes its tmux server
    // exit, but the socket file outlives the decision by a moment — a
    // `new-session` that connects in that window is answered by a server on
    // its way out, which dies under the client ("server exited unexpectedly")
    // having created nothing. `restartSubshell` reuses the row's socket with
    // the kill immediately before the spawn, so this is the normal case, not
    // a rare one: bare tmux reproduces it 5/5. Unretried it surfaced as a
    // restart button that throws and rolls the row back to `terminated`.
    const socket = freshSocket("revive-race");
    runner.newSubshell(socket, "s1", "/tmp", "exec sleep 30");
    runner.pipePane(socket, "s1", `/tmp/subshell-revive-race-${Date.now()}.log`);
    runner.killSubshell(socket, "s1"); // last subshell ⇒ the server starts exiting
    // Back-to-back, exactly as #reviveRow does — no sleep to paper over it.
    runner.newSubshell(socket, "s1", "/tmp", "exec sleep 30");
    expect(await runner.hasSubshell(socket, "s1")).toBe(true);
    runner.killSubshell(socket, "s1");
  });
  it("captures escape sequences with -e", async () => {
    const socket = freshSocket("esc");
    runner.newSubshell(socket, "s1", "/tmp", "printf '\\033[31mRED\\033[0m normal\\n'; exec sleep 30");
    await Bun.sleep(300);
    const out = await runner.capturePane(socket, "s1");
    expect(out).toContain("[31m");
    runner.killSubshell(socket, "s1");
  });

  it("panePid: names the pane's own process; a missing pane/socket answers null", async () => {
    const socket = freshSocket("pid");
    const pidFile = join(tmpdir(), `subshell-panepid-${process.pid}-${socketSeq}.txt`);
    try {
      // The pane's shell prints its OWN pid: tmux makes that shell the pane's
      // leader, so `#{pane_pid}` must report the same number — the exact
      // handle `signalPaneWinch` kills (`-pid` reaches the pane's group).
      runner.newSubshell(socket, "s1", "/tmp", `echo $$ > ${pidFile}; exec sleep 30`);
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(pidFile).exists()) && Date.now() < deadline) await Bun.sleep(25);
      const shellPid = Number((await Bun.file(pidFile).text()).trim());
      expect(Number.isInteger(shellPid) && shellPid > 0).toBe(true);
      expect(await runner.panePid(socket, "s1")).toBe(shellPid);
      // Gone names and gone sockets answer null — never a throw, never a 0.
      expect(await runner.panePid(socket, "no-such-session")).toBeNull();
      expect(await runner.panePid(freshSocket("pid-absent"), "s1")).toBeNull();
      runner.killSubshell(socket, "s1");
    } finally {
      try {
        unlinkSync(pidFile);
      } catch {
        // the shell never wrote it — nothing to clean
      }
    }
  });

  it("refuses an over-long socket path with an actionable error instead of tmux's 'File name too long'", () => {
    // A unix socket path cannot exceed the kernel's sun_path field (104 bytes
    // on macOS, 108 on Linux). tmux expands `-L <name>` to
    // $TMUX_TMPDIR/tmux-<uid>/<name>, so a long TMUX_TMPDIR breaks EVERY
    // subshell create — and tmux's own "File name too long" reached the
    // browser as a bare `API 500`, naming neither the path nor the limit.
    const previous = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = `/tmp/${"x".repeat(120)}`;
    try {
      expect(() => runner.newSubshell(freshSocket("toolong"), "s1", "/tmp", "exec sleep 30")).toThrow(
        /socket path.*too long/i,
      );
      // The message has to carry what a human needs to act: the offending
      // path, the limit it broke, and the variable that controls it.
      let message = "";
      try {
        runner.newSubshell(freshSocket("toolong2"), "s1", "/tmp", "exec sleep 30");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("TMUX_TMPDIR");
      // The USABLE length, one less than sun_path itself (104 on macOS, 108
      // on Linux) because the field has to hold a terminating NUL too.
      expect(message).toMatch(/\b(103|107)\b/);
    } finally {
      if (previous === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previous;
    }
  });

  it("measures the REALPATH tmux binds, not the lexical path", () => {
    // macOS resolves /tmp to /private/tmp — 8 bytes the lexical form never
    // shows. A base sized so the lexical socket path fits but the resolved one
    // does not used to pass this guard and then fail INSIDE tmux with the bare
    // "File name too long" the guard exists to replace.
    const previous = process.env.TMUX_TMPDIR;
    try {
      // socket path = base + "/tmux-<uid>/" + "subshell-<12 hex>"
      const tail = `/tmux-${process.getuid?.() ?? 0}/`.length + "subshell-000000000000".length;
      const base = `/tmp/${"y".repeat(Math.max(0, 100 - tail - "/tmp/".length))}`;
      process.env.TMUX_TMPDIR = base;
      const socketPath = tmuxSocketPath("subshell-000000000000");
      const lexical = `${base}/tmux-${process.getuid?.() ?? 0}/subshell-000000000000`;
      if (socketPath === lexical) return; // a platform where /tmp is not a symlink
      // The resolved path is longer, and it is the one that gets measured.
      expect(socketPath.length).toBeGreaterThan(lexical.length);
      expect(lexical.length).toBeLessThan(104);
      expect(() => assertSocketPathFits("subshell-000000000000")).toThrow(/too long/i);
      // ...and the message names BOTH spellings, since the operator only
      // recognises the one they configured.
      let message = "";
      try {
        assertSocketPathFits("subshell-000000000000");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(base);
    } finally {
      if (previous === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previous;
    }
  });

  it("allows a normal socket path (the guard does not fire on the default tmpdir)", async () => {
    const socket = freshSocket("guard-ok");
    runner.newSubshell(socket, "s1", "/tmp", "exec sleep 30");
    expect(await runner.hasSubshell(socket, "s1")).toBe(true);
    runner.killSubshell(socket, "s1");
  });

  it("paneSize: reads the window's REAL grid back, and answers null for a gone pane/socket", async () => {
    // The readback that makes a resize verifiable. A fire-and-forget resize
    // measured 51x13 requested against a pane sitting at 51x16, and a grid
    // that differs by one row makes a relative-positioning TUI paint every
    // later frame onto the wrong rows.
    const socket = freshSocket("panesize");
    runner.newSubshell(socket, "s1", "/tmp", "exec sleep 30");
    // Detached tmux windows are born at 80x24.
    expect(await runner.paneSize(socket, "s1")).toEqual({ cols: 80, rows: 24 });

    await runner.resizeWindow(socket, "s1", 92, 28);
    expect(await runner.paneSize(socket, "s1")).toEqual({ cols: 92, rows: 28 });

    // A second resize must be observable too — this is what proves the
    // last-write-wins claim rather than assuming it.
    await runner.resizeWindow(socket, "s1", 51, 13);
    expect(await runner.paneSize(socket, "s1")).toEqual({ cols: 51, rows: 13 });

    expect(await runner.paneSize(socket, "no-such-session")).toBeNull();
    expect(await runner.paneSize(freshSocket("panesize-absent"), "s1")).toBeNull();
    runner.killSubshell(socket, "s1");
  });

  it("paneCursor: reads the pane's viewport cursor, and answers null for a gone pane/socket", async () => {
    // The replay's cursor restore is only as true as this read: it must land
    // the client's cursor where the pane's actually is (the 2026-09-23
    // typing-off-screen report came from it being 16 rows away).
    const socket = freshSocket("panecursor");
    // Prints only AFTER a beat, so the first read sees a genuinely blank
    // pane: rows `a`, `b`, then `xyz` on row 2 leaves the cursor at x=3, y=2.
    runner.newSubshell(socket, "s1", "/tmp", "sh -c 'sleep 0.3; printf \"a\\nb\\nxyz\"; sleep 30'");
    expect(await runner.paneCursor(socket, "s1")).toEqual({ x: 0, y: 0 });

    await Bun.sleep(450);
    expect(await runner.paneCursor(socket, "s1")).toEqual({ x: 3, y: 2 });

    // GONE means gone: killed first (the server exits with its last session).
    // A bogus -t against a LIVE server is deliberately NOT tested as null —
    // tmux's display-message falls back to the current pane for formats that
    // need no window context, and the real callers never present that case
    // (one session per socket, and the cursor is read right behind a
    // capture that already named the same target).
    runner.killSubshell(socket, "s1");
    expect(await runner.paneCursor(socket, "s1")).toBeNull();
    expect(await runner.paneCursor(freshSocket("panecursor-absent"), "s1")).toBeNull();
  });

  describe("cleanSocket", () => {
    it("unlinks under TMUX_TMPDIR, which is where tmux put it", async () => {
      // The bug this pins: the old code joined process.env.TMPDIR, which on
      // macOS is a per-user /var/folders path holding no tmux sockets. tmux
      // itself resolves -L names under TMUX_TMPDIR ?? /tmp (tmuxSocketPath).
      const base = mkdtempSync(join(tmpdir(), "tmux-sock-test-"));
      const uid = process.getuid?.() ?? 0;
      const dir = join(base, `tmux-${uid}`);
      mkdirSync(dir, { recursive: true });
      const socket = "subshell-0123456789ab";
      const file = join(dir, socket);
      writeFileSync(file, "");
      const prev = process.env.TMUX_TMPDIR;
      process.env.TMUX_TMPDIR = base;
      try {
        await new TmuxRunner().cleanSocket(socket);
        expect(existsSync(file)).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = prev;
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
  /**
   * `remain-on-exit` makes a finished pane OBSERVABLE (spec 2026-09-19 §4.3),
   * and that changes what `has-session` means — so `hasSubshell` must not use
   * it. Before this, tmux destroyed the window, the session and (one server
   * per subshell) the server itself before anything could look: `pane_dead`
   * was unreadable and `exitCode` was structurally always null.
   */
  it("reports a finished pane as NOT alive, though its session still exists", async () => {
    const socket = freshSocket("dead");
    runner.newSubshell(socket, "d1", "/tmp", "sh -c 'exit 7'");
    // Wait for the command to finish rather than sleeping a fixed time.
    for (let i = 0; i < 40 && (await runner.hasSubshell(socket, "d1")); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await runner.hasSubshell(socket, "d1")).toBe(false);
    // The session is STILL THERE — which is exactly why `has-session` would
    // have answered true and called a dead subshell alive.
    expect(runner.listSubshellNames(socket)).toContain("d1");
  });

  /**
   * Polls `paneExitCode` itself rather than `hasSubshell` as a proxy. The
   * proxy raced: under the packages job's parallel load a single swallowed
   * tmux error answers `hasSubshell:false` immediately, the loop exited while
   * the pane was still alive, and `paneExitCode` correctly answered `null` —
   * the assertion then failed 24 ms in with no wait ever having happened.
   * `null` means "not readable YET", so "yet" is what we wait on.
   */
  async function waitForPaneExitCode(socket: string, name: string): Promise<number | null> {
    for (let i = 0; i < 40; i++) {
      const code = await runner.paneExitCode(socket, name);
      if (code !== null) return code;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  it("reads the exit status of a finished pane, which was previously unreachable", async () => {
    const socket = freshSocket("exitcode");
    runner.newSubshell(socket, "e1", "/tmp", "sh -c 'exit 7'");
    expect(await waitForPaneExitCode(socket, "e1")).toBe(7);
  });

  it("keeps a clean exit distinguishable from an unknown one", async () => {
    const socket = freshSocket("exitzero");
    runner.newSubshell(socket, "z1", "/tmp", "sh -c 'exit 0'");
    // 0 is a real answer; null means "could not be read".
    expect(await waitForPaneExitCode(socket, "z1")).toBe(0);
  });
  /**
   * The node's exit watcher acts on this list DIRECTLY — "a pane the socket
   * answered without is confirmed dead" — so a finished pane lingering here
   * (which `remain-on-exit` now makes it do) would mean no node-run subshell
   * was ever reported dead again. This is the regression that change would
   * otherwise have introduced, in the one place that catches it.
   */
  it("omits a finished pane, though its session still exists", async () => {
    const socket = freshSocket("checkedlive");
    runner.newSubshell(socket, "live1", "/tmp", "exec sleep 30");
    runner.newSubshell(socket, "gone1", "/tmp", "sh -c 'exit 3'");
    for (let i = 0; i < 40 && (await runner.hasSubshell(socket, "gone1")); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const probe = await runner.listSubshellsChecked(socket);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.names).toContain("live1");
    expect(probe.names).not.toContain("gone1");
    // The dead session is still THERE — which is exactly why listing names
    // alone stopped meaning "alive".
    expect(runner.listSubshellNames(socket)).toContain("gone1");
  });
});
