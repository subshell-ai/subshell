import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { TmuxRunner, tmuxSocketFor } from "../tmux-runner.js";

const runner = new TmuxRunner();

/**
 * Sockets of every server this file spawns. Tests historically tracked only the
 * most recent socket and killed only the SESSION — a mid-test assertion failure
 * skipped the kill, and a pane blocked on `read` outlived the suite (the server
 * never exits while a session lives). `afterAll` now reaps WHOLE servers for
 * every socket spawned here, so a failing test cannot leak a daemon.
 */
const spawnedSockets = new Set<string>();

/**
 * Returns a fresh unique socket name, already registered for the afterAll
 * reaper.
 */
function freshSocket(kind: string): string {
  const socket = `mote-test-${kind}-${Date.now()}`;
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
    expect(a).toMatch(/^mote-/);
  });

  it("creates and kills a session", async () => {
    const socket = freshSocket("session");
    runner.newSession(socket, "s1", "/tmp", "echo hello-test; exec sleep 30");
    expect(runner.hasSession(socket, "s1")).toBe(true);

    // Give the shell a moment to render before capturing
    await Bun.sleep(300);
    const out = runner.capturePane(socket, "s1");
    expect(out).toContain("hello-test");

    runner.killSession(socket, "s1");
    expect(runner.hasSession(socket, "s1")).toBe(false);
  });

  it("streams output to a pipe-pane file", async () => {
    const socket = freshSocket("pipe");
    const outFile = `/tmp/mote-pipe-${Date.now()}.txt`;
    // pipe-pane only captures output written AFTER it attaches. This test used
    // to echo at session start and then attach, so it raced the attach and
    // usually captured nothing. Start a pane that stays quiet until it is fed
    // input, attach, and only then produce the output being asserted on.
    // Ordering needs no sleep: TmuxRunner.run uses spawnSync, so pipe-pane has
    // fully applied before sendInput is issued, and the pty buffers the input
    // even if `read` has not been reached yet — so no output can escape the
    // capture window.
    runner.newSession(socket, "s1", "/tmp", "bash -c 'read l; echo piped-$l; exec sleep 30'");
    runner.pipePane(socket, "s1", outFile);
    runner.sendInput(socket, "s1", "line\r");
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
      runner.killSession(socket, "s1");
    }
  });

  it("pipe-pane single-quotes the output path (shell-inert, no $() execution)", async () => {
    // `pipe-pane -o` runs through tmux's shell, so the `cat >> <path>` command
    // must survive as ONE literal argv element with the path quoted. The old
    // JSON.stringify-based escaping neutralized `"` but not `$`, backticks or
    // `;`. Assert on the exact argv tmux would receive, via a stub binary that
    // dumps its arguments (no real tmux, nothing executed).
    const stubDir = mkdtempSync(join(tmpdir(), "mote-tmux-stub-"));
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
        "cat >> '/tmp/x$(touch /tmp/pwned)`id`y'\\''z.txt'",
      ]);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("sends input to the session, submitting only on an explicit CR", async () => {
    const socket = freshSocket("key");
    runner.newSession(socket, "s1", "/tmp", "bash -c 'read line; echo got-$line; exec sleep 30'");
    await Bun.sleep(300);
    // Typed one keystroke at a time, exactly as xterm's onData delivers it.
    for (const ch of "typed-input") {
      runner.sendInput(socket, "s1", ch);
    }
    await Bun.sleep(400);
    // Still being edited: the characters are echoed but the line is not
    // submitted, because no CR has been sent yet.
    expect(runner.capturePane(socket, "s1")).not.toContain("got-t");
    runner.sendInput(socket, "s1", "\r");
    await Bun.sleep(500);
    const out = runner.capturePane(socket, "s1");
    expect(out).toContain("typed-input");
    expect(out).toContain("got-typed-input");
    runner.killSession(socket, "s1");
  });

  // Polls, never sleeps: the fixed 400/500 ms windows this test used to carry
  // raced tmux+bash+stty startup on a loaded CI runner (first chunks lost) and
  // could kill `cat` before its tail flushed \u2014 a flake with no diagnostic.
  it("forwards input byte-exactly (control bytes, escapes, UTF-8, literal text)", async () => {
    const socket = freshSocket("raw");
    const outFile = `/tmp/mote-raw-${Date.now()}.bin`;
    const readyFile = `${outFile}.ready`;
    // Raw mode + no echo so the pty adds no translation of its own; whatever
    // arrives in the file is exactly what tmux delivered to the process. The
    // sentinel is written AFTER stty, so "ready" means the reader is live.
    // (`cat > file`, not `>>`: the append form lagged its flush here and
    // reported a short file even though every byte had been delivered.)
    runner.newSession(socket, "s1", "/tmp", `bash -c 'stty raw -echo; echo ready > ${readyFile}; cat > ${outFile}'`);
    await waitForFileToContain(readyFile, "ready", 4_000);
    // Key names, flag-looking text and backslash escapes must all stay
    // literal, and control/escape bytes must pass through untouched.
    const sent = ["Enter", "C-c", "-x", "a\\nb", "\x1b[A", "\x04", "\r", "h\u00e9llo\u2192"];
    for (const chunk of sent) {
      runner.sendInput(socket, "s1", chunk);
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
    runner.killSession(socket, "s1");
    expect(
      received.length,
      `pane received ${received.length} of ${expected.length} bytes; got ${JSON.stringify(Array.from(received))}`,
    ).toBe(expected.length);
    expect(Array.from(received)).toEqual(Array.from(expected));
    unlinkSync(outFile);
    unlinkSync(readyFile);
  }, 15_000);

  it("captures escape sequences with -e", async () => {
    const socket = freshSocket("esc");
    runner.newSession(socket, "s1", "/tmp", "printf '\\033[31mRED\\033[0m normal\\n'; exec sleep 30");
    await Bun.sleep(300);
    const out = runner.capturePane(socket, "s1");
    expect(out).toContain("[31m");
    runner.killSession(socket, "s1");
  });
});

afterAll(() => {
  // kill-server (not kill-session) on every socket this file touched: tears
  // the daemon down even when a failed assertion skipped the per-test kill.
  // Already-dead sockets error out; that is expected and ignored.
  for (const socket of spawnedSockets) {
    spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  }
  spawnedSockets.clear();
});
