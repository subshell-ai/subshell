import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSH_RUNTIME_SERVE_IN_USE_EXIT } from "@internal/subshell-protocol";
import { startCallbackDoors } from "../callback-sock.js";
import { runRuntimeServe } from "../serve.js";
import * as stdioModule from "../stdio.js";

/**
 * The occupied-destination signal (review m2): a second `runtime-serve` on a
 * destination that already carries a live session dies at the SHARED door's
 * bind, and that death must exit {@link SSH_RUNTIME_SERVE_IN_USE_EXIT} - the
 * code the broker's classifier names `session_in_use` - while every OTHER
 * bootstrap posture keeps its own reading. The stdio pair is mocked the way
 * `serve-throw-drop.test.ts` mocks it (the test process's stdin/stdout are
 * not the session); the doors are the real thing, because the bind is what
 * this suite is about.
 *
 * - live listener on `<dataDir>/callback.sock` → the named busy exit (before
 *   the fix this was a bare throw the CLI turned into exit 1, which the
 *   classifier read as "binary missing" on a machine running the binary);
 * - a fresh dir → hello, transport close, exit 0 (the busy code is for the
 *   bind refusal, not for booting);
 * - a STALE socket file (inode with no listener) → unlink-and-bind, exit 0
 *   (the reconcile-on-reopen path the design requires must not read busy).
 */

const realStdio = { ...stdioModule };

class RecordingWriter {
  get bufferedAmount(): number {
    return 0;
  }
  writeFrame(frame: unknown): void {
    written.push(frame);
  }
}
const written: unknown[] = [];
let diags: string[] = [];

interface Captured {
  onFrame(raw: unknown): void;
  onDone(reason: string): void;
}
/** Every `startStdinReader` the serve loop made (the busy path must make none). */
let captures: Captured[] = [];

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function pollUntil(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pollUntil timed out: ${what}`);
}

beforeAll(() => {
  mock.module("../stdio.js", () => ({
    ...realStdio,
    redirectConsoleToStderr: () => {},
    RuntimeWriter: RecordingWriter,
    diag: (line: string) => {
      diags.push(line);
    },
    startStdinReader: (onFrame: (raw: unknown) => void, onDone: (reason: string) => void) => {
      captures.push({ onFrame, onDone });
    },
  }));
});

afterAll(async () => {
  mock.module("../stdio.js", () => realStdio);
  expect(stdioModule.startStdinReader).toBe(realStdio.startStdinReader);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("runtime-serve busy exit (m2)", () => {
  test("a destination with a LIVE door exits with the named busy code, not a throw", async () => {
    const dataDir = tempDir("subshell-busy-live-");
    const holder = await startCallbackDoors(dataDir, () => {});
    written.length = 0;
    diags = [];
    captures = [];
    try {
      const code = await runRuntimeServe({
        session: crypto.randomUUID(),
        tmuxSocket: "subshell-serve-busy-test",
        dataDir,
      });
      expect(code).toBe(SSH_RUNTIME_SERVE_IN_USE_EXIT);
      expect(written, "no hello: the serve died before the transport opened").toEqual([]);
      expect(captures.length, "no stdin reader: bootstrap refused first").toBe(0);
      expect(
        diags.some((l) => /live|session/i.test(l)),
        "the diag line names what refused",
      ).toBe(true);
    } finally {
      await holder.stop();
    }
  });

  test("a fresh destination serves and exits 0 on transport close (busy is for the bind refusal only)", async () => {
    const dataDir = tempDir("subshell-busy-fresh-");
    written.length = 0;
    captures = [];
    const serve = runRuntimeServe({
      session: crypto.randomUUID(),
      tmuxSocket: "subshell-serve-busy-test",
      dataDir,
    });
    await pollUntil("the reader never captured the serve loop", () => captures.length > 0);
    expect(written.some((f) => (f as { type?: string }).type === "hello")).toBe(true);
    (captures[0] as Captured).onDone("eof");
    expect(await serve).toBe(0);
  });

  test("a STALE socket file from a dead serve still binds and exits 0 (never reads busy)", async () => {
    const dataDir = tempDir("subshell-busy-stale-");
    mkdirSync(join(dataDir, "subshells"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "callback.sock"), "an inode nobody listens on");
    written.length = 0;
    captures = [];
    const serve = runRuntimeServe({
      session: crypto.randomUUID(),
      tmuxSocket: "subshell-serve-busy-test",
      dataDir,
    });
    await pollUntil("the stale-file serve never reached its reader", () => captures.length > 0);
    expect(written.some((f) => (f as { type?: string }).type === "hello")).toBe(true);
    (captures[0] as Captured).onDone("eof");
    expect(await serve).toBe(0);
  });
});
