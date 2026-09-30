import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_COMMAND_TIMEOUT_MS, TmuxRunner, TmuxTimeoutError } from "../tmux-runner.js";
import { semicolonFrames as frames, freshSocket, runner, writeStub } from "./helpers/tmux-test-harness.js";

/**
 * What tmux RECEIVES: every assertion here runs against a stub binary that
 * dumps its argv, so the emitted command strings are pinned without a server
 * (issue #244 trailing-`;`, the pipe-pane child, the shutdown-race retry, the
 * async hot path, the capturePane mode preamble). Split out of
 * tmux-runner.test.ts, whose single-file runtime was the package floor under
 * `--parallel`.
 */
describe("TmuxRunner", () => {
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

  it("pipe-pane with a child runs the flushing capture verb (--file), never cat", async () => {
    // Host-independent guard for the uutils-`cat` fix: production always passes
    // a child (the self-invoked `pane-log` verb), and the emitted command must
    // be `exec <self…> pane-log --file <quoted path>` — NOT a bare `cat >>`
    // (which buffers on a uutils host). Asserted on the exact argv tmux receives
    // via a stub, so it cannot pass by accident of the test host's `cat`.
    const stubDir = mkdtempSync(join(tmpdir(), "subshell-tmux-stub-"));
    const argvFile = join(stubDir, "argv.txt");
    const stub = join(stubDir, "tmux-stub");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`, { mode: 0o755 });
    try {
      const hostile = "/tmp/a b'c.log";
      new TmuxRunner(stub).pipePane("sock", "s1", hostile, {
        command: "/usr/bin/bun",
        args: ["/opt/child.ts", "pane-log"],
      });
      const argv = (await Bun.file(argvFile).text()).trim().split("\n");
      expect(argv).toEqual([
        "-L",
        "sock",
        "pipe-pane",
        "-t",
        "s1",
        "-o",
        `(umask 077; exec '/usr/bin/bun' '/opt/child.ts' 'pane-log' --file '/tmp/a b'\\''c.log')`,
      ]);
      // Back-compat: the no-child fallback still emits `cat >>` (unresolved
      // self-path on a control-plane host that has neither binary — rare).
      const argvFile2 = join(stubDir, "argv2.txt");
      const stub2 = join(stubDir, "tmux-stub2");
      writeFileSync(stub2, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile2}"\n`, { mode: 0o755 });
      new TmuxRunner(stub2).pipePane("sock", "s1", "/tmp/plain.log");
      const argv2 = (await Bun.file(argvFile2).text()).trim().split("\n");
      expect(argv2.at(-1)).toBe("(umask 077; cat >> '/tmp/plain.log')");
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  // Issue #244: tmux's command parser eats a trailing `;` out of every string
  // argument BEFORE `-l` can make it literal (full account on
  // encodeTrailingSemicolon), so a `;` typed into a pane typed nothing at all,
  // `x;` typed `x`, and a cwd ending in one split the launch command in two.
  describe("frames and cwds ending in `;` survive tmux's parser", () => {
    it("sendInput spawns send-keys with the trailing `;` re-escaped (stub argv)", async () => {
      // What tmux RECEIVES is the fix; what it then DELIVERS to a pane is the
      // real-tmux test below. Same stub shape as the pipe-pane argv assertions.
      const stubDir = mkdtempSync(join(tmpdir(), "subshell-tmux-stub-"));
      const argvFile = join(stubDir, "argv.txt");
      const stub = join(stubDir, "tmux-stub");
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`, { mode: 0o755 });
      try {
        const tmux = new TmuxRunner(stub);
        for (const { payload, encoded } of frames) {
          await tmux.sendInput("sock", "s1", payload);
          const argv = (await Bun.file(argvFile).text()).trim().split("\n");
          expect(argv).toEqual(["-L", "sock", "send-keys", "-t", "s1", "-l", "--", encoded]);
        }
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it("newSubshell re-escapes the cwd, never its intentional `;` separators (stub argv)", async () => {
      const stubDir = mkdtempSync(join(tmpdir(), "subshell-tmux-stub-"));
      const argvFile = join(stubDir, "argv.txt");
      const stub = join(stubDir, "tmux-stub");
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`, { mode: 0o755 });
      try {
        // The cwd ends in `;` AND carries one mid-path: only the trailing one
        // is a parser hazard. The exact-match list below is also the count:
        // the lone `";"` after the command must stay a BARE separator —
        // escaping it would fuse `set-option` into the harness's own command
        // line instead of chaining it after the spawn.
        new TmuxRunner(stub).newSubshell("sock", "s1", "/tmp/a;b;", "exec sleep 30");
        const argv = (await Bun.file(argvFile).text()).trim().split("\n");
        expect(argv).toEqual([
          "-L",
          "sock",
          "new-session",
          "-d",
          "-s",
          "s1",
          "-c",
          "/tmp/a;b\\;",
          "exec sleep 30",
          ";",
          "set-option",
          "-t",
          "s1",
          "remain-on-exit",
          "on",
        ]);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });
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

  describe("the pane hot path is async, and ordered anyway", () => {
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
  describe("capturePane leads with an authoritative mode statement", () => {
    /**
     * A tmux stub that answers exactly the two commands `capturePane` issues
     * (`display-message` for the mode flags, `capture-pane` for the grid),
     * each body deciding that command's stdout and exit. `echo` adds the
     * trailing newline real tmux adds, which the preamble's read trims.
     */
    function modeStub(displayBody: string, captureBody: string, argvPath?: string): { dir: string; path: string } {
      const dir = mkdtempSync(join(tmpdir(), "subshell-mode-"));
      const path = join(dir, "tmux-stub");
      const record = argvPath ? `printf '%s\\n' "$@" >> '${argvPath}'; ` : "";
      writeFileSync(
        path,
        "#!/bin/sh\n" +
          'for a in "$@"; do\n' +
          `  if [ "$a" = "display-message" ]; then ${record}${displayBody} fi\n` +
          `  if [ "$a" = "capture-pane" ]; then ${captureBody} fi\n` +
          "done\nexit 0\n",
        { mode: 0o755 },
      );
      return { dir, path };
    }
    const answer = (flags: string) => `echo '${flags}'; exit 0;`;
    const GRID = "echo 'grid'; exit 0;";
    const run = async (displayBody: string, captureBody: string) => {
      const { dir, path } = modeStub(displayBody, captureBody);
      try {
        return await new TmuxRunner(path).capturePane("sock", "s1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("states all five modes, in order, as h or l per flag", async () => {
      // The mapping was verified live on tmux 3.7c. This vector pins the
      // DECODE side: `1:0:1:0:1` has every adjacent pair different, so a
      // swap of two decsets entries or an off-by-one in the positional
      // read changes the exact string (`1:0:0:1:1`, the shape a Claude
      // Code 2.1.283 pane measured, could not see a standard/button
      // swap). The stub answers without reading the format string, so
      // the QUERY side is the verbatim argv pin that follows.
      expect(await run(answer("1:0:1:0:1"), GRID)).toBe(
        "\x1b[?1049h\x1b[?1000l\x1b[?1002h\x1b[?1003l\x1b[?1006hgrid\n",
      );
    });

    it("queries the flags in the decoded order: the format string, verbatim", async () => {
      // Tokens are read POSITIONALLY, so the order of the variables in
      // the format string is part of the contract, and the stub cannot
      // catch its reordering: a swapped or "alphabetized" pair would
      // misannounce 1000/1002/1003 to every client with every other test
      // green (the precedent: the tmux 3.4 format-variable history
      // narrated in `SESSION_LIVENESS_FORMAT`, tmux-runner.ts). Pinned
      // argv, the pipePane tests' shape.
      const marks = join(tmpdir(), `subshell-mode-argv-${process.pid}-${Date.now()}.txt`);
      const { dir, path } = modeStub(answer("0:0:0:0:0"), GRID, marks);
      try {
        await new TmuxRunner(path).capturePane("sock", "s1");
        expect((await Bun.file(marks).text()).trim().split("\n")).toEqual([
          "-L",
          "sock",
          "display-message",
          "-t",
          "s1",
          "-p",
          "#{alternate_on}:#{mouse_standard_flag}:#{mouse_button_flag}:#{mouse_all_flag}:#{mouse_sgr_flag}",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(marks, { force: true });
      }
    });

    it("answers an all-off pane too: the l forms are the point", async () => {
      // Silence here would strand a poll-path client in a mode the app has
      // dropped; the full statement is idempotent no-ops for a fresh one.
      expect(await run(answer("0:0:0:0:0"), GRID)).toBe(
        "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006lgrid\n",
      );
    });

    it("stays SILENT, not all-off, when a flag did not answer", async () => {
      // A tmux too old for one variable yields an empty token; inventing an
      // OFF there would let a poll re-send CLEAR a mode the client learned
      // from live bytes. Unknown must mean no statement at all. `"01"`
      // pins strict equality over truthiness: a `tokens[i] &&`-style
      // refactor would read it as ON.
      expect(await run(answer("1::0:1:1"), GRID)).toBe("grid\n");
      expect(await run(answer("1:01:0:1:1"), GRID)).toBe("grid\n");
      expect(await run(answer("garbage"), GRID)).toBe("grid\n");
    });

    it("a display-message failure costs the statement, never the capture", async () => {
      // tmux ANSWERING "no" (or nothing usable) about modes still ships the
      // grid byte-for-byte: losing the decoration is no reason to lose the
      // capture it decorates.
      expect(await run("echo 'no pane' >&2; exit 1;", GRID)).toBe("grid\n");
    });

    it("capture-pane still throws when IT fails", async () => {
      // paneModePreamble swallows; capturePane must not. captureStable's
      // null handling and the booting attach's 4004 refusal read the throw.
      await expect(run(answer("0:0:0:0:0"), "echo 'no server' >&2; exit 1;")).rejects.toThrow(/no server/);
    });

    it("gives up on the mode read at its own 2.5 s deadline", async () => {
      // The hardcoded cap is production wiring, same class as the
      // TMUX_COMMAND_TIMEOUT_MS pin above: the preamble must never double
      // an attach's wait on a wedged tmux. The stub answers modes only after
      // 5 s; the run must end on the 2.5 s cap, silent, with the capture
      // delivered.
      const started = Date.now();
      const out = await run("sleep 5; echo '0:0:0:0:0'; exit 0;", GRID);
      const elapsed = Date.now() - started;
      expect(out).toBe("grid\n");
      expect(elapsed).toBeGreaterThanOrEqual(2_400);
      expect(elapsed).toBeLessThan(4_900);
    });
  });
});
