import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ONE empirical proof that a piped `init` can interview a human at all
 * (spec 2026-09-26). The unit tests pin `acquirePromptInput`'s mechanics with
 * a fake fs; only a real kernel pty can answer what the design actually
 * hinges on — whether an attached `/dev/tty` carries prompts and keystrokes
 * end to end through bun. It is also the measurement that DECIDED the shipped
 * shape: the fd-0 swap the design proposed first was run here, and clack's
 * reader, bound to the pipe description fd 0 held at process start, starved
 * forever on a healthy terminal. The fallback the design named in the same
 * breath — the tty rides its own fd, the fd-based readers ask its questions —
 * is what this scenario keeps green. A regression of the whole property looks
 * exactly like this file's first red: no prompt text on the screen, because
 * init took its silent non-interactive path.
 *
 * The scenario is the exact live shape of the bug:
 *
 * - stdin is a CLOSED PIPE, what a drained `curl | bash` leaves;
 * - stdout/stderr are the pty slave, the healthy terminal case;
 * - the child gets its own session with the slave as controlling terminal
 *   (`setsid` + `TIOCSCTTY`), so `/dev/tty` resolves even when the test itself
 *   runs from a tmux pane or from a headless CI runner;
 * - the driver types Enter at the master every 0.4 s: an interview taking
 *   defaults, on the attached fd, is what "the attachment works" means here
 *   (the fd-0 SWAP is the rejected design; this proves the shipped fd path).
 *
 * python3 is the pty allocator (the repo has no pty dependency; the task
 * ruling sanctioned exactly this shape for this ONE scenario). A host without
 * python3 skips loudly rather than silently.
 *
 * Every HOME/config fact is PINNED to temp dirs for a second reason too: a
 * development-time version of this driver ran once WITHOUT them and rewrote
 * the developer's real `~/.config/subshell-server/config.env` (content came
 * back byte-equal under defaults-follow-the-file, but "verify it did no harm"
 * is not a shape a test suite gets to have). The env block below is that
 * lesson, encoded.
 */

const API_ROOT = join(import.meta.dir, "..", "..");

/** Forks `cmd` under a pty, feeds Enter periodically, logs the screen, exits with the child. */
const DRIVER = String.raw`
import os, pty, sys, fcntl, termios, select, time

log_path = sys.argv[1]
cmd = sys.argv[2:]

master, slave = pty.openpty()
r, w = os.pipe()

pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(r, 0)      # stdin: the drained pipe, exactly as under curl | bash
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    for fd in (master, slave, r, w):
        try:
            os.close(fd)
        except OSError:
            pass
    os.execvp(cmd[0], cmd)
    os._exit(127)

os.close(r)
os.close(slave)
os.close(w)            # the writer closes: reads of the child's stdin answer EOF

log = open(log_path, "wb")
deadline = time.time() + 75
next_type = time.time() + 1.2
typed = 0
status = None
quiet = 0.0
eof = False
while True:
    now = time.time()
    if now > deadline:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        break
    readable, _, _ = select.select([master], [], [], 0.2)
    if readable:
        try:
            data = os.read(master, 65536)
        except OSError:      # EIO once every slave end is closed: the child is gone
            data = None
        if data is None or data == b"":
            eof = True
        else:
            log.write(data)
            log.flush()
    elif status is not None and now > quiet:
        break                # reaped, and the master answered quiet: nothing left
    if status is None and not eof and now >= next_type and typed < 30:
        try:
            os.write(master, b"\r")
        except OSError:
            pass
        typed += 1
        next_type = now + 0.4
    if status is None:
        done, st = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = st
            quiet = now + 1.5
    if eof and status is not None:
        break
log.close()
sys.exit(os.waitstatus_to_exitcode(status) if status is not None else 124)
`;

describe("init under a real pty: the swapped interview is answered through the fd readers (spec 2026-09-26)", () => {
  test("piped stdin + terminal stdout: init attaches /dev/tty and completes the interview on that fd", async () => {
    if (!Bun.which("python3")) {
      console.warn("init-tty-pty: python3 not found on this host, scenario skipped");
      return;
    }
    const work = mkdtempSync(join(tmpdir(), `subshell-ttyswap-${process.pid}-`));
    const home = join(work, "home");
    const cfg = join(work, "cfg");
    mkdirSync(home);
    const logPath = join(work, "pty.log");
    const driver = join(work, "pty-driver.py");
    writeFileSync(driver, DRIVER);
    // PATH ALREADY lists ~/.local/bin so the PATH question is not part of
    // this interview; the temp HOME keeps any profile write (and bun's own
    // cache) off the developer's real home. The flags pin port and base URL
    // so the assertions hold no matter what a local .env carries; the HOST,
    // TRUSTED_ORIGINS and DATABASE_PATH questions still run for real, which
    // is the point: the fd-based readers must PROMPT on the attached tty and
    // carry a full interview (clack deliberately does NOT run on swapped
    // runs — that design was measured to strand; see tty-input.ts).
    const proc = Bun.spawn(
      [
        "python3",
        driver,
        logPath,
        process.execPath,
        "src/index.ts",
        "init",
        "--no-service",
        "--port",
        "3080",
        "--base-url",
        "http://localhost:3080",
      ],
      {
        cwd: API_ROOT,
        env: {
          HOME: home,
          PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin`,
          TERM: "xterm-256color",
          NODE_ENV: "development",
          SUBSHELL_SERVER_CONFIG_DIR: cfg,
          SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [_stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const screen = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const context = () =>
      `driver exit ${code}\n--- driver stderr ---\n${stderr.slice(0, 2000)}\n--- screen ---\n${screen.slice(0, 4000)}`;

    expect(code, context()).toBe(0);
    // The proof, stated twice: a question rendered by the fd-based reader on
    // the attached tty, and NOT the silent-default path a terminal-less run
    // would have taken.
    expect(screen, context()).toContain("Bind address");
    expect(screen, context()).not.toContain("not interactive");
    // And the answers crossed the other way: ENTER took the defaults and
    // the file landed.
    expect(readFileSync(join(cfg, "config.env"), "utf8")).toContain("SERVER_PORT=3080");
  }, 120_000);
});
