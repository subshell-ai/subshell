/**
 * Terminal acquisition for `subshell-server init` (spec 2026-09-26).
 *
 * The piped one-liner (`curl -fsSL … | bash`) used to hang SILENTLY on some
 * macOS terminals, and the hang was the SCRIPT's doing: its final act was
 * `exec < /dev/tty` under a `[ -t 1 ]` guard, which tested stdout while
 * rewiring stdin, and the /dev/tty OPEN itself can block (Terminal's
 * "Restored session" reproduces it) — killing the install before `init`
 * rendered anything. That block is gone from the script; this module is where
 * `init` decides its own prompt input, and the one property the whole design
 * hangs on is that the open here CANNOT WAIT: O_NONBLOCK makes the kernel
 * answer ENXIO instead of parking in the same blocking open that hung the old
 * script.
 *
 * WHY THE TTY RIDES ITS OWN FD AND NEVER REPLACES FD 0 (measured, not
 * theorized): the shipped shape was supposed to be "close fd 0, re-open the
 * tty, lowest-free-fd lands it on stdin" — the design named a fallback for
 * exactly the case the pty scenario then caught. On bun 1.4.2, `process.stdin`
 * binds the descriptor that fd 0 held AT PROCESS START: after the swap, clack
 * kept reading the long-dead pipe description, its prompts rendered
 * perfectly, and the interview hung forever on a healthy terminal
 * (`__tests__/init-tty-pty.test.ts` reproduces it in seconds). So the tty
 * stays on the fd the open returned, and the SWAPPED run routes every prompt
 * through the fd-based readers below — the tmux offer's `promptLineSync` was
 * already `readSync`-on-an-fd shaped, and the swapped case simply points that
 * shape at the tty fd. The direct-run case is untouched: clack exactly as
 * before. The pty scenario keeps proving the OTHER half: the bytes really do
 * arrive on the attached fd.
 */

import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from "node:fs";

/** The device the swap attaches. */
const CONTROLLING_TTY = "/dev/tty";

/** Injectable fs/stdio facts so the open is unit-testable without a tty. */
export interface TtyIo {
  /** Whether fd 0 is already a terminal (production: `process.stdin.isTTY`). */
  stdinIsTTY: boolean;
  /** `fs.openSync`, injectable so a suite can fake the tty without one. */
  open: (path: string, flags: number) => number;
  /** `fs.closeSync` — production calls it on NOTHING in the success path; see above. */
  close: (fd: number) => void;
  /** The open flags to use, injectable so a test can assert O_NONBLOCK rides. */
  constants: { readonly O_RDONLY: number; readonly O_NONBLOCK: number };
}

/** What one acquisition attempt concluded. */
export interface PromptInput {
  /** True when `init` may run the interactive interview. */
  interactive: boolean;
  /** True when the controlling terminal was attached for this run. */
  swapped: boolean;
  /** The attached tty's fd, when swapped. Every prompt of the run reads it. */
  fd?: number;
  /** One-line explanation, for a test to pin and a human to read. */
  reason: string;
}

/** The production seams: the real fd 0, the real open. */
function realIo(): TtyIo {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    open: (path, flags) => openSync(path, flags),
    close: (fd) => void closeSync(fd),
    constants: { O_RDONLY: fsConstants.O_RDONLY, O_NONBLOCK: fsConstants.O_NONBLOCK },
  };
}

/**
 * Decide `init`'s prompt input: use stdin when it is a terminal, else ATTACH
 * the controlling terminal on its own fd, else stay non-interactive. Every
 * failure mode lands on `{ interactive: false }` with a reason — the caller
 * prints its taken defaults and the command still completes, which is the
 * whole defect this closes (a hang that printed nothing).
 */
export function acquirePromptInput(io: TtyIo = realIo()): PromptInput {
  if (io.stdinIsTTY) return { interactive: true, swapped: false, reason: "stdin is already a terminal" };
  try {
    // O_NONBLOCK is the load-bearing word: with it the kernel answers ENXIO
    // ("no controlling terminal") here instead of BLOCKING here, which is the
    // exact hang the piped installer used to suffer at this syscall.
    const fd = io.open(CONTROLLING_TTY, io.constants.O_RDONLY | io.constants.O_NONBLOCK);
    return { interactive: true, swapped: true, fd, reason: `attached the controlling terminal on fd ${fd}` };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      interactive: false,
      swapped: false,
      reason: `no controlling terminal to attach (${CONTROLLING_TTY} said: ${detail})`,
    };
  }
}

/** Decode a line's worth of bytes collected one at a time from an fd. */
function decodeLine(bytes: number[]): string {
  return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}

/**
 * Ask one line against a caller-chosen fd: `writeSync(1, …)` + one-byte
 * blocking `readSync(fd, …)` until LF. This is `cli.ts`'s `promptLineSync`
 * generalized from "fd 0" to any fd, which is the whole fallback shape: a
 * swapped run's clack cannot see the attached tty (see the header), so its
 * text AND yes/no questions come through here instead, where a byte-per-read
 * on a canonical tty simply blocks on the driver until a line exists.
 *
 * EOF (closed stdin, hangup) returns null so the caller aborts with zero
 * writes, matching clack's cancel contract. EAGAIN (the O_NONBLOCK open the
 * tty arrives with, or any non-blocking stdin under some launcher) parks
 * briefly and retries rather than fabricating an answer.
 */
export function readLineSync(fd: number, question: string, def: string): string | null {
  writeSync(1, `${question} [${def}]: `);
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, one, 0, 1, null);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Bun.sleepSync(5);
        continue;
      }
      if (code === "EIO") return null; // hangup on the far end — treat as closed stdin
      throw err;
    }
    if (n === 0) return bytes.length > 0 ? decodeLine(bytes) : null;
    if (one[0] === 0x0a) return decodeLine(bytes);
    bytes.push(one[0] as number);
  }
}

/**
 * The yes/no reader for a swapped run: ENTER takes `def`, y/yes and n/no take
 * their words, anything else re-asks (clack re-asks the same way), and EOF is
 * the same `null` cancel every prompt seam uses.
 */
export function confirmLineOn(fd: number, question: string, def: boolean): boolean | null {
  for (;;) {
    const line = readLineSync(fd, question, def ? "Y/n" : "y/N");
    if (line === null) return null;
    const t = line.trim().toLowerCase();
    if (t === "") return def;
    if (t === "y" || t === "yes") return true;
    if (t === "n" || t === "no") return false;
    writeSync(1, "Please answer y or n.\n");
  }
}
