import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCallbackSockPath } from "../callback-sock.js";
import * as dispatchModule from "../dispatch.js";
import { runRuntimeServe } from "../serve.js";
import * as stdioModule from "../stdio.js";

/**
 * M-1 (review wave 2026-10-05): the serve loop opens the launched pane's
 * callback door BEFORE dispatch, and BOTH failure arms must roll it back.
 * The `ok:false` arm always did; a throwing executor escaped through the
 * chain's `.catch`, which answered `runtime-command-failed` but left the door
 * standing over a pane that never spawned. This suite drives the real serve
 * loop with the two seams the loop needs mocked: the stdio pair (the test
 * process's stdin/stdout are not the session) and the dispatcher (the forced
 * throw). The door facts are observed on the real filesystem, and the
 * dispatch mock records whether the door existed at the moment the executor
 * ran - the positive control that the door really opened first.
 *
 * The mock restores follow the I-1 pattern (snapshot the real namespaces at
 * module-eval, restore TO the snapshot, identity-pin in afterAll) - this
 * directory's sibling files import the same modules.
 */

const realStdio = { ...stdioModule };
const realDispatch = { ...dispatchModule };

const SESSION = crypto.randomUUID(); // isSshSessionRef: hex+hyphen, <= 64
const PANE = crypto.randomUUID(); // isSubshellId: the door's id gate
const dataDir = mkdtempSync(join(tmpdir(), "subshell-serve-throw-"));
const paneSock = paneCallbackSockPath(dataDir, PANE);

interface Captured {
  onFrame(raw: unknown): void;
  onDone(reason: string): void;
}
let reader: Captured | undefined;
const written: unknown[] = [];
let doorAtDispatch: boolean | undefined;

class RecordingWriter {
  get bufferedAmount(): number {
    return 0;
  }
  writeFrame(frame: unknown): void {
    written.push(frame);
  }
}

async function pollUntil(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pollUntil timed out: ${what}`);
}

function connectDoor(): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const sock = createConnection({ path: paneSock });
    sock.setTimeout(2000);
    sock.once("connect", () => {
      sock.destroy();
      resolve("open");
    });
    sock.once("error", () => {
      sock.destroy();
      resolve("refused");
    });
  });
}

beforeAll(() => {
  mock.module("../stdio.js", () => ({
    ...realStdio,
    RuntimeWriter: RecordingWriter,
    startStdinReader: (onFrame: (raw: unknown) => void, onDone: (reason: string) => void) => {
      reader = { onFrame, onDone };
    },
  }));
  mock.module("../dispatch.js", () => ({
    ...realDispatch,
    runRuntimeCommand: async (
      ctx: unknown,
      socket: string,
      frame: { type?: string; cmd?: { subshellId?: string } },
    ) => {
      if (frame?.type === "launch") {
        // Runs AFTER serve opened the door (the dispatch-order fact M-1 is
        // about); record, then force the throw the fix must roll back.
        doorAtDispatch = existsSync(paneCallbackSockPath(dataDir, String(frame.cmd?.subshellId)));
        throw new Error("forced executor throw");
      }
      const real = realDispatch.runRuntimeCommand as unknown as (c: unknown, s: string, f: unknown) => Promise<unknown>;
      return real(ctx, socket, frame);
    },
  }));
});

afterAll(async () => {
  mock.module("../stdio.js", () => realStdio);
  mock.module("../dispatch.js", () => realDispatch);
  expect(stdioModule.startStdinReader).toBe(realStdio.startStdinReader);
  expect(dispatchModule.runRuntimeCommand).toBe(realDispatch.runRuntimeCommand);
  rmSync(dataDir, { recursive: true, force: true });
});

test("a launch whose executor THREW drops the pane door (M-1 rollback on the catch arm)", async () => {
  const serve = runRuntimeServe({ session: SESSION, tmuxSocket: "subshell-serve-throw-test", dataDir });
  await pollUntil("the mocked reader never captured the serve loop's callbacks", () => reader !== undefined);
  expect(
    written.some((f) => (f as { type?: string }).type === "hello"),
    "hello goes out first",
  ).toBe(true);

  reader?.onFrame({
    type: "launch",
    ref: crypto.randomUUID(),
    // Shallow session-frame grammar; the deep body never reaches an executor
    // here - the dispatch mock throws before one is consulted.
    cmd: { type: "launch", subshellId: PANE },
  });

  await pollUntil("the serve loop never answered the throwing launch", () =>
    written.some(
      (f) =>
        (f as { type?: string; ok?: boolean; error?: string }).type === "result" &&
        (f as { error?: string }).error === "runtime-command-failed",
    ),
  );
  // The door opened BEFORE dispatch ran (the order the fix preserves), and
  // the throw path took it down with the failed launch (the order it adds).
  expect(doorAtDispatch, "the pane door must be open when the executor starts").toBe(true);
  expect(existsSync(paneSock), "the door file must not outlive the throw").toBe(false);
  expect(await connectDoor(), "the door must answer connection-refused after the throw").toBe("refused");

  reader?.onDone("eof");
  expect(await serve, "the serve loop exits 0 on transport close").toBe(0);
});
