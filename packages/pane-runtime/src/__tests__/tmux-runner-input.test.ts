import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { semicolonFrames as frames, freshSocket, runner, waitForFileToContain } from "./helpers/tmux-test-harness.js";

/**
 * What tmux DELIVERS: keystroke and pipe-pane capture round-trips through REAL
 * servers — streamed output, byte-exact input (control bytes, escapes, UTF-8,
 * the issue #244 trailing-`;` frames), and keystroke ORDER across unawaited
 * spawns. Split out of tmux-runner.test.ts.
 */
describe("TmuxRunner", () => {
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
  it("streams a newline-less chunk through the child (uutils-cat regression)", async () => {
    // End-to-end through REAL tmux: the child is `bun <shim> pane-log --file …`,
    // the pane emits a chunk with NO trailing newline, and it must reach the
    // file at once. A buffering child (uutils `cat >>`) holds it; this is the
    // shape a live terminal echo has, and the whole reason the child is ours.
    const socket = freshSocket("panlog");
    const outFile = `/tmp/subshell-panlog-${Date.now()}.txt`;
    const modPath = new URL("../pane-log.js", import.meta.url).pathname;
    const shim = `/tmp/subshell-panlog-shim-${Date.now()}.ts`;
    writeFileSync(
      shim,
      `import { appendStdinToLogFile } from ${JSON.stringify(modPath)};
const a = process.argv.slice(2);
appendStdinToLogFile(a[a.indexOf("--file") + 1]);
`,
    );
    try {
      runner.newSubshell(socket, "s1", "/tmp", `bash -c 'read l; printf noeol-chunk; exec sleep 30'`);
      runner.pipePane(socket, "s1", outFile, { command: process.execPath, args: [shim, "pane-log"] });
      await runner.sendInput(socket, "s1", "go\r");
      // No EOF, no newline after `noeol-chunk` — only a flushing child shows it.
      await waitForFileToContain(outFile, "noeol-chunk", 3000);
    } finally {
      if (existsSync(outFile)) unlinkSync(outFile);
      if (existsSync(shim)) unlinkSync(shim);
      runner.killSubshell(socket, "s1");
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

  // Issue #244's delivery half: what the stub pins in the argv file, these
  // observe reaching a pane.
  describe("frames and cwds ending in `;` survive tmux's parser", () => {
    it("every frame reaches the pane byte-exactly, including bare `;` (real tmux)", async () => {
      // The reporter's symptom, end-to-end. `cat` runs in raw mode with echo
      // OFF into a file, so the bytes the process RECEIVED are the record —
      // the same discipline as the byte-exactness test above, chosen over
      // capture-pane because `capture-pane -e` can carry `;` inside escape
      // codes, which would false-positive a bare-`;` assertion on the bug.
      const socket = freshSocket("semicolon");
      const outFile = `/tmp/subshell-semicolon-${process.pid}-${Date.now()}.bin`;
      const readyFile = `${outFile}.ready`;
      runner.newSubshell(socket, "s1", "/tmp", `bash -c 'stty raw -echo; echo ready > ${readyFile}; cat > ${outFile}'`);
      try {
        await waitForFileToContain(readyFile, "ready", 4_000);
        for (const { payload } of frames) {
          await runner.sendInput(socket, "s1", payload);
        }
        const expected = new TextEncoder().encode(frames.map((f) => f.payload).join(""));
        const deadline = Date.now() + 5_000;
        let received = new Uint8Array(0);
        while (Date.now() < deadline) {
          if (await Bun.file(outFile).exists()) {
            received = new Uint8Array(await Bun.file(outFile).arrayBuffer());
            if (received.length >= expected.length) break;
          }
          await Bun.sleep(25);
        }
        expect(
          received.length,
          `pane received ${JSON.stringify(new TextDecoder().decode(received))}, expected ${expected.length} bytes`,
        ).toBe(expected.length);
        expect(Array.from(received)).toEqual(Array.from(expected));
      } finally {
        runner.killSubshell(socket, "s1");
        rmSync(outFile, { force: true });
        rmSync(readyFile, { force: true });
      }
    }, 15_000);

    it("a cwd ending in `;` lands the pane in that directory (real tmux)", async () => {
      // The stub test above pins what tmux RECEIVES for `-c`; this observes
      // the COMPOSITION. Unfixed, the parser terminated the launch command AT
      // the cwd — the rest of the argv became a garbage second command, tmux
      // answered non-zero, and `newSubshell` threw before a pane existed.
      // The pane prints its cwd into a sentinel file rather than a capture
      // assertion because `pwd` reports the PHYSICAL path (macOS tmpdir lives
      // under /private/ behind a symlink), so the check pins the unique
      // directory name WITH its trailing `;` — the ending every spelling of
      // the path shares, and the exact byte the parser used to eat.
      const base = `subshell-semi-cwd-${process.pid}-${Date.now()};`;
      const dir = join(tmpdir(), base);
      mkdirSync(dir);
      const outFile = join(tmpdir(), `subshell-semi-cwd-pwd-${process.pid}-${Date.now()}.txt`);
      const socket = freshSocket("semicwd");
      try {
        runner.newSubshell(socket, "s1", dir, `pwd > ${outFile}; sleep 30`);
        const content = await waitForFileToContain(outFile, base, 4_000);
        expect(content.trim().endsWith(base)).toBe(true);
      } finally {
        runner.killSubshell(socket, "s1");
        rmSync(dir, { recursive: true, force: true });
        rmSync(outFile, { force: true });
      }
    }, 15_000);
  });

  describe("the pane hot path is async, and ordered anyway", () => {
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
  });
});
