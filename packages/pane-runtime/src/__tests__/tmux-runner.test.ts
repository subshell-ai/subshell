import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import {
  assertSocketPathFits,
  TMUX_COMMAND_TIMEOUT_MS,
  TmuxRunner,
  TmuxTimeoutError,
  tmuxSocketFor,
  tmuxSocketPath,
} from "../tmux-runner.js";

const runner = new TmuxRunner();

/**
 * Sockets of every server this file spawns. Tests historically tracked only the
 * most recent socket and killed only the SUBSHELL — a mid-test assertion failure
 * skipped the kill, and a pane blocked on `read` outlived the suite (the server
 * never exits while a subshell lives). `afterAll` now reaps WHOLE servers for
 * every socket spawned here, so a failing test cannot leak a daemon.
 */
const spawnedSockets = new Set<string>();

let socketSeq = 0;

/**
 * Returns a fresh unique socket name, already registered for the afterAll
 * reaper. mktemp `-u`-style uniqueness (pid + ms + per-file counter): two
 * suites running in parallel — or two `freshSocket` calls inside one
 * millisecond — can never collide on a live server.
 */
function freshSocket(kind: string): string {
  socketSeq += 1;
  const socket = `subshell-test-${kind}-${process.pid}-${Date.now()}-${socketSeq}`;
  spawnedSockets.add(socket);
  return socket;
}

/**
 * Polls until `file` contains `needle`, returning its contents.
 *
 * Used instead of a fixed sleep for assertions that wait on tmux's
 * `pipe-pane` flushing through `cat >> file`: there is no interval worth
 * hardcoding, and on failure this reports what the file actually held.
 */
async function waitForFileToContain(file: string, needle: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
    if (last.includes(needle)) return last;
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)} in ${file}; saw ${JSON.stringify(last)}`,
  );
}

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

  it("streams output to a pipe-pane file", async () => {
    const socket = freshSocket("pipe");
    const outFile = `/tmp/subshell-pipe-${Date.now()}.txt`;
    // pipe-pane only captures output written AFTER it attaches. This test used
    // to echo at subshell start and then attach, so it raced the attach and
    // usually captured nothing. Start a pane that stays quiet until it is fed
    // input, attach, and only then produce the output being asserted on.
    // Ordering needs no sleep: `pipePane` is synchronous and the `sendInput`
    // after it is awaited, so pipe-pane has fully applied before any input is
    // issued — and the pty buffers that input even if `read` has not been
    // reached yet, so no output can escape the capture window.
    runner.newSubshell(socket, "s1", "/tmp", "bash -c 'read l; echo piped-$l; exec sleep 30'");
    runner.pipePane(socket, "s1", outFile);
    await runner.sendInput(socket, "s1", "line\r");
    try {
      // Poll for the content rather than sleeping a guessed interval: this is
      // waiting on pipe-pane's `cat >> file` to flush, which has no bound worth
      // hardcoding. Fast when it works, and it fails with the file's actual
      // contents rather than a bare timeout.
      const content = await waitForFileToContain(outFile, "piped-line", 3000);
      // The tty echo of "line" cannot satisfy this — only the `echo` can emit
      // the "piped-" prefix.
      expect(content).toContain("piped-line");
    } finally {
      // try/finally so a failed assertion does not leak the file into /tmp.
      if (existsSync(outFile)) unlinkSync(outFile);
      runner.killSubshell(socket, "s1");
    }
  });

  it("creates the pipe-pane file 0600, whatever the caller's umask", async () => {
    // The pane log is the plaintext transcript of everything the terminal
    // rendered — including whatever the operator typed, since a tty echoes.
    // tmux's shell CREATES the file (`cat >>`), so there is no mode argument
    // to pass: the `umask 077` in the pipe-pane command is the only thing
    // standing between that transcript and a world-readable 0644 file. This
    // asserts the real end-to-end mode, not the command string — a shell that
    // parsed the umask differently would still pass an argv assertion.
    const socket = freshSocket("pipe-mode");
    const outFile = `/tmp/subshell-pipe-mode-${Date.now()}.txt`;
    // Deliberately permissive: without the umask in the command, `cat` would
    // create this file 0666 and the assertion below would read 0666.
    const previous = process.umask(0o000);
    try {
      runner.newSubshell(socket, "s1", "/tmp", "bash -c 'read l; echo piped-$l; exec sleep 30'");
      runner.pipePane(socket, "s1", outFile);
      await runner.sendInput(socket, "s1", "line\r");
      await waitForFileToContain(outFile, "piped-line", 3000);
      expect(statSync(outFile).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      if (existsSync(outFile)) unlinkSync(outFile);
      runner.killSubshell(socket, "s1");
    }
  });

  it("pipe-pane single-quotes the output path (shell-inert, no $() execution)", async () => {
    // `pipe-pane -o` runs through tmux's shell, so the `cat >> <path>` command
    // must survive as ONE literal argv element with the path quoted. The old
    // JSON.stringify-based escaping neutralized `"` but not `$`, backticks or
    // `;`. Assert on the exact argv tmux would receive, via a stub binary that
    // dumps its arguments (no real tmux, nothing executed).
    const stubDir = mkdtempSync(join(tmpdir(), "subshell-tmux-stub-"));
    const argvFile = join(stubDir, "argv.txt");
    const stub = join(stubDir, "tmux-stub");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`, { mode: 0o755 });
    try {
      // Includes a `'` so shellQuote's close-quote/escaped-quote/reopen idiom
      // `'\''` is proven AT this argv boundary too, not only in the
      // harness-command test. The expectation is a hardcoded literal so the
      // assertion cannot drift into tautology with shellQuote itself.
      const hostile = "/tmp/x$(touch /tmp/pwned)`id`y'z.txt";
      new TmuxRunner(stub).pipePane("sock", "s1", hostile);
      const argv = (await Bun.file(argvFile).text()).trim().split("\n");
      expect(argv).toEqual([
        "-L",
        "sock",
        "pipe-pane",
        "-t",
        "s1",
        "-o",
        "(umask 077; cat >> '/tmp/x$(touch /tmp/pwned)`id`y'\\''z.txt')",
      ]);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("sends input to the subshell, submitting only on an explicit CR", async () => {
    const socket = freshSocket("key");
    runner.newSubshell(socket, "s1", "/tmp", "bash -c 'read line; echo got-$line; exec sleep 30'");
    await Bun.sleep(300);
    // Typed one keystroke at a time, exactly as xterm's onData delivers it.
    for (const ch of "typed-input") {
      await runner.sendInput(socket, "s1", ch);
    }
    await Bun.sleep(400);
    // Still being edited: the characters are echoed but the line is not
    // submitted, because no CR has been sent yet.
    expect(await runner.capturePane(socket, "s1")).not.toContain("got-t");
    await runner.sendInput(socket, "s1", "\r");
    await Bun.sleep(500);
    const out = await runner.capturePane(socket, "s1");
    expect(out).toContain("typed-input");
    expect(out).toContain("got-typed-input");
    runner.killSubshell(socket, "s1");
  });

  // Polls, never sleeps: the fixed 400/500 ms windows this test used to carry
  // raced tmux+bash+stty startup on a loaded CI runner (first chunks lost) and
  // could kill `cat` before its tail flushed \u2014 a flake with no diagnostic.
  it("forwards input byte-exactly (control bytes, escapes, UTF-8, literal text)", async () => {
    const socket = freshSocket("raw");
    const outFile = `/tmp/subshell-raw-${Date.now()}.bin`;
    const readyFile = `${outFile}.ready`;
    // Raw mode + no echo so the pty adds no translation of its own; whatever
    // arrives in the file is exactly what tmux delivered to the process. The
    // sentinel is written AFTER stty, so "ready" means the reader is live.
    // (`cat > file`, not `>>`: the append form lagged its flush here and
    // reported a short file even though every byte had been delivered.)
    runner.newSubshell(socket, "s1", "/tmp", `bash -c 'stty raw -echo; echo ready > ${readyFile}; cat > ${outFile}'`);
    await waitForFileToContain(readyFile, "ready", 4_000);
    // Key names, flag-looking text and backslash escapes must all stay
    // literal, and control/escape bytes must pass through untouched.
    const sent = ["Enter", "C-c", "-x", "a\\nb", "\x1b[A", "\x04", "\r", "h\u00e9llo\u2192"];
    for (const chunk of sent) {
      await runner.sendInput(socket, "s1", chunk);
    }
    const expected = new Uint8Array(await new Blob([sent.join("")]).arrayBuffer());
    // Drain to the full byte length before killing the pane. The comparison
    // reads arrayBuffer, not text(): text() would decode UTF-8 and make the
    // lengths incomparable ("h\u00e9llo\u2192" is 7 chars, 11 bytes).
    const deadline = Date.now() + 4_000;
    let received = new Uint8Array(0);
    while (Date.now() < deadline) {
      if (await Bun.file(outFile).exists()) {
        received = new Uint8Array(await Bun.file(outFile).arrayBuffer());
        if (received.length >= expected.length) break;
      }
      await Bun.sleep(25);
    }
    runner.killSubshell(socket, "s1");
    expect(
      received.length,
      `pane received ${received.length} of ${expected.length} bytes; got ${JSON.stringify(Array.from(received))}`,
    ).toBe(expected.length);
    expect(Array.from(received)).toEqual(Array.from(expected));
    unlinkSync(outFile);
    unlinkSync(readyFile);
  }, 15_000);

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

  it("retries only the shutdown race — a real refusal throws on the first answer", async () => {
    // The retry must not swallow genuine failures (bad cwd, duplicate name):
    // those are answers the caller needs immediately, not after a stall. A
    // stub tmux counts its invocations, so "did not retry" is observable.
    const stubDir = mkdtempSync(join(tmpdir(), "subshell-tmux-race-stub-"));
    const countFile = join(stubDir, "count.txt");
    const stub = join(stubDir, "tmux-stub");
    // Fails twice with the race message, then succeeds — and prints a
    // different, non-race error when asked to be a "real refusal" (arg 2).
    writeFileSync(
      stub,
      `#!/bin/sh
n=$(cat '${countFile}' 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > '${countFile}'
case "$2" in
  refuse) echo "duplicate subshell: s1" >&2; exit 1 ;;
esac
if [ "$n" -le 2 ]; then echo "server exited unexpectedly" >&2; exit 1; fi
exit 0
`,
      { mode: 0o755 },
    );
    try {
      // Race message ⇒ retried until it succeeds (3rd attempt).
      new TmuxRunner(stub).newSubshell("sock", "s1", "/tmp", "cmd");
      expect((await Bun.file(countFile).text()).trim()).toBe("3");

      // A non-race failure ⇒ exactly ONE attempt, error surfaced verbatim.
      writeFileSync(countFile, "0");
      expect(() => new TmuxRunner(stub).newSubshell("refuse", "s1", "/tmp", "cmd")).toThrow(/duplicate subshell/);
      expect((await Bun.file(countFile).text()).trim()).toBe("1");
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("gives up (rather than hanging) when the race never clears", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "subshell-tmux-race-forever-"));
    const countFile = join(stubDir, "count.txt");
    const stub = join(stubDir, "tmux-stub");
    writeFileSync(
      stub,
      `#!/bin/sh
n=$(cat '${countFile}' 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > '${countFile}'
echo "server exited unexpectedly" >&2; exit 1
`,
      { mode: 0o755 },
    );
    try {
      expect(() => new TmuxRunner(stub).newSubshell("sock", "s1", "/tmp", "cmd")).toThrow(/server exited unexpectedly/);
      // Bounded: the initial attempt plus the retry budget, never an endless spin.
      expect((await Bun.file(countFile).text()).trim()).toBe("4");
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
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

  describe("the pane hot path is async, and ordered anyway", () => {
    /**
     * Writes an executable stub in a temp dir and returns both paths. The
     * caller `rmSync`s the directory; nothing real is spawned.
     */
    function writeStub(script: string): { dir: string; path: string } {
      const dir = mkdtempSync(join(tmpdir(), "subshell-tmux-async-"));
      const path = join(dir, "tmux-stub");
      writeFileSync(path, script, { mode: 0o755 });
      return { dir, path };
    }

    it("delivers unawaited keystrokes in call order", async () => {
      // The WS handler fires `void launcher.sendInput(...)` per keystroke, so
      // nothing awaits between frames. When these commands were `spawnSync`
      // that ordering was free; with `Bun.spawn` the OS decides, and a typed
      // "hello" can reach tmux as "hlelo". 50 DISTINCT characters, because a
      // repeated one cannot tell an ordered delivery from a shuffled one.
      const socket = freshSocket("order");
      const outFile = join(tmpdir(), `subshell-order-${process.pid}-${Date.now()}.bin`);
      const readyFile = `${outFile}.ready`;
      // Raw + no echo: the file holds exactly what tmux delivered, with no
      // line discipline reordering or translating anything of its own.
      runner.newSubshell(socket, "s1", "/tmp", `bash -c 'stty raw -echo; echo ready > ${readyFile}; cat > ${outFile}'`);
      try {
        await waitForFileToContain(readyFile, "ready", 4_000);
        const sent = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
        expect(new Set(sent).size).toBe(50);
        // NOT awaited between calls — the point of the test.
        const pending = [...sent].map((ch) => runner.sendInput(socket, "s1", ch));
        await Promise.all(pending);
        const deadline = Date.now() + 5_000;
        let received = "";
        while (Date.now() < deadline) {
          received = (await Bun.file(outFile).exists()) ? await Bun.file(outFile).text() : "";
          if (received.length >= sent.length) break;
          await Bun.sleep(25);
        }
        expect(received).toBe(sent);
      } finally {
        runner.killSubshell(socket, "s1");
        rmSync(outFile, { force: true });
        rmSync(readyFile, { force: true });
      }
    });

    it("holds Enter behind the text even when the text's spawn is slower", async () => {
      // The real-tmux twin below is an end-to-end check and cannot force the
      // race: two send-keys spawns of the same shape usually finish in order
      // by luck. Here the stub makes the TEXT slow, so an unchained pressEnter
      // provably wins — an empty line submitted at the prompt while the text
      // arrives after it, which is a prompt that silently never runs.
      const seen = join(tmpdir(), `subshell-enter-order-${process.pid}-${Date.now()}.txt`);
      const { dir, path } = writeStub(
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "the-prompt" ]; then sleep 0.3; echo text >> "' +
          seen +
          '"; exit 0; fi\n' +
          '  if [ "$a" = "Enter" ]; then echo enter >> "' +
          seen +
          '"; exit 0; fi\n' +
          "done\nexit 0\n",
      );
      try {
        const tmux = new TmuxRunner(path);
        // Unawaited between the two, exactly as `deliverPrompt` issues them.
        const typed = tmux.sendInput("sock", "s1", "the-prompt");
        const entered = tmux.pressEnter("sock", "s1");
        await Promise.all([typed, entered]);
        expect(await Bun.file(seen).text()).toBe("text\nenter\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(seen, { force: true });
      }
    });

    it("submits the text it was given, not an empty line before it", async () => {
      // Prompt delivery is sendInput-then-pressEnter. As two independent async
      // spawns the Enter can win, submitting an empty line while the text
      // lands at a prompt nobody submits — a prompt that silently never runs.
      const socket = freshSocket("enter-order");
      runner.newSubshell(socket, "s1", "/tmp", "bash -c 'read line; echo got-$line; exec sleep 30'");
      try {
        await Bun.sleep(300);
        // Both unawaited, in this order, exactly as `deliverPrompt` issues them.
        const typed = runner.sendInput(socket, "s1", "ordered-prompt");
        const entered = runner.pressEnter(socket, "s1");
        await Promise.all([typed, entered]);
        const deadline = Date.now() + 5_000;
        let out = "";
        while (Date.now() < deadline) {
          out = await runner.capturePane(socket, "s1");
          if (out.includes("got-")) break;
          await Bun.sleep(25);
        }
        expect(out).toContain("got-ordered-prompt");
      } finally {
        runner.killSubshell(socket, "s1");
      }
    });

    it("leaves the event loop free while a slow tmux runs", async () => {
      // The defect this whole change exists for: one `spawnSync` froze the
      // WHOLE server for its duration — every attached pane's 50ms tail pump,
      // every other viewer's frames, and all HTTP. A stub that sleeps stands
      // in for a tmux on a loaded host.
      const { dir, path } = writeStub("#!/bin/sh\nsleep 0.5\nprintf 'captured\\n'\n");
      try {
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
        }, 10);
        try {
          const out = await new TmuxRunner(path).capturePane("sock", "s1");
          expect(out).toContain("captured");
        } finally {
          clearInterval(timer);
        }
        // ~50 ticks fit in 500ms; assert a fraction of that so a loaded
        // machine cannot flake it. Under `spawnSync` this is exactly 0.
        expect(ticks).toBeGreaterThanOrEqual(10);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("gives up on a wedged tmux instead of swallowing the keystroke", async () => {
      // Async spawns removed the whole-process stall, and put a new failure in
      // its place: a tmux that never answers used to leave `sendInput` pending
      // forever. Nothing settled, nothing rejected, nothing logged, and every
      // later keystroke for that pane queued behind it — one pane's keyboard
      // silently dead, with the WS handler's `logFailure` never firing.
      const { dir, path } = writeStub("#!/bin/sh\nsleep 30\n");
      try {
        const tmux = new TmuxRunner(path, { timeoutMs: 250 });
        const started = Date.now();
        await expect(tmux.sendInput("sock", "s1", "x")).rejects.toThrow(/timed out after 250 ?ms/);
        // Rejected on the deadline rather than on the stub's own 30 s exit.
        expect(Date.now() - started).toBeLessThan(5_000);
        // …and the pane's chain DRAINED: the next keystroke is not stuck behind
        // the one that hung, which is the half that makes the timeout useful.
        await expect(tmux.sendInput("sock", "s1", "y")).rejects.toThrow(/timed out/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("hasSubshell: tmux SAYING no is false; tmux saying NOTHING throws", async () => {
      // The whole point of `TmuxTimeoutError`. `false` used to mean both, and
      // the server's reconcile sweep acts on it destructively — so a wedged
      // tmux client revoked a live subshell's token, stamped `endedAt` and
      // pushed a death notification for a pane that was still running.
      const absent = freshSocket("liveness-absent"); // never started: tmux answers, with "no"
      expect(await runner.hasSubshell(absent, "s1")).toBe(false);

      const { dir, path } = writeStub("#!/bin/sh\nsleep 30\n");
      try {
        const wedged = new TmuxRunner(path, { timeoutMs: 250 });
        await expect(wedged.hasSubshell("sock", "s1")).rejects.toThrow(TmuxTimeoutError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("defaults that deadline to TMUX_COMMAND_TIMEOUT_MS", () => {
      // The constant is what production runs on; the test above overrides it,
      // so without this nothing pins the wiring or the value.
      expect(TMUX_COMMAND_TIMEOUT_MS).toBe(15_000);
    });

    it("keeps a pane's queue usable after one input fails", async () => {
      // The chain kept per pane is the swallowed form on purpose: a rejected
      // tail would reject every keystroke queued behind it, so one dead frame
      // would read as a broken keyboard until the socket was reopened.
      const { dir, path } = writeStub(
        '#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "BOOM" ]; then\n    echo "refused" >&2\n    exit 1\n  fi\ndone\nexit 0\n',
      );
      try {
        const tmux = new TmuxRunner(path);
        await expect(tmux.sendInput("sock", "s1", "BOOM")).rejects.toThrow("refused");
        // Same socket + session, i.e. the same chain the failure ran on.
        await expect(tmux.sendInput("sock", "s1", "after")).resolves.toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not serialize one pane's input behind another's", async () => {
      // A single global lock would make the async conversion pointless: the
      // whole reason for it is that one pane's slow tmux must not hold up
      // anyone else's keystrokes.
      //
      // Asserted as OVERLAP, not as wall-clock. The first version of this gave
      // the two spawns 700 ms and measured 515-539 ms on an idle 18-core Mac —
      // a margin a 2-core hosted runner would eat, turning a correctness test
      // into a load gauge. The stub instead records a start and a finish line
      // per invocation, and the claim becomes what the test actually means:
      // the second pane's spawn STARTED before the first one's FINISHED.
      // Serialized, that is impossible at any speed.
      const marks = join(tmpdir(), `subshell-overlap-${process.pid}-${Date.now()}.txt`);
      const { dir, path } = writeStub(
        `#!/bin/sh\necho "start $2" >> "${marks}"\nsleep 0.4\necho "finish $2" >> "${marks}"\nexit 0\n`,
      );
      try {
        const tmux = new TmuxRunner(path);
        await Promise.all([tmux.sendInput("sock-a", "s1", "x"), tmux.sendInput("sock-b", "s1", "x")]);
        const lines = (await Bun.file(marks).text()).trim().split("\n");
        // `$2` is the socket name in `-L <socket> send-keys …`.
        expect(lines.filter((l) => l.startsWith("start"))).toHaveLength(2);
        const firstFinish = lines.findIndex((l) => l.startsWith("finish"));
        const lastStart = lines.map((l) => l.startsWith("start")).lastIndexOf(true);
        expect(lastStart).toBeLessThan(firstFinish);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(marks, { force: true });
      }
    });
  });
});

afterAll(async () => {
  // kill-server (not kill-session) on every socket this file touched: tears
  // the daemon down even when a failed assertion skipped the per-test kill.
  // Already-dead sockets error out; that is expected and ignored.
  //
  // Then UNLINK, because killing the server does not remove its socket file —
  // that is the same leak `cleanSocket` exists to close in production, and
  // this suite has no throwaway `TMUX_TMPDIR` the way the server's does, so
  // its sockets land in the developer's real tmux dir and stayed there. A few
  // hundred had accumulated by 2026-09-15.
  const runner = new TmuxRunner();
  for (const socket of spawnedSockets) {
    spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    await runner.cleanSocket(socket);
  }
  spawnedSockets.clear();
});
