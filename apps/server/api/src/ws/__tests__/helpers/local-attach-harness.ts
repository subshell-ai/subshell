import { afterEach, beforeAll } from "bun:test";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { getDefaultLocalLauncher } from "@/services/nodes/local-launcher.js";
import { cleanupSubshellWs, handleSubshellWs } from "@/ws/subshell-ws.js";
import { resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";
import { issueWsToken } from "@/ws/ws-token.js";

/**
 * Shared harness for the split of `subshell-ws-local-attach.test.ts`
 * (issue #261 round 2: the 26 s single file was the api suite's parallel floor).
 *
 * Local-attach cleanup leak (pre-Task-11, surfaced while reviewing §6.5):
 * `handleSubshellWs` copied the attach state onto `ws.data` with
 * `Object.assign` BEFORE `startLogTail`/`startPanePoll` assigned
 * `data.cleanup` onto the local object - so `ws.data.cleanup` stayed
 * undefined, `cleanupSubshellWs(ws)` released nothing on disconnect, and
 * every local terminal attach leaked a live fs.watcher plus its
 * backstop/poll timer for the process lifetime. The suites drive the REAL
 * handler through the REAL seams (issued WS token, DB row via the shared
 * test context, real fs.watch on the subshell log file); the remote relay
 * was always correct, the local twin was not.
 *
 * The handler resolves the local launcher via `launcherFor(LOCAL_NODE_ID)` -
 * the module-level `defaultLocalLauncher`. Its tmux-touching methods are
 * stubbed as OWN properties (the tmux CLI is not a `bun test` dependency)
 * and restored per test; every other seam (fs.watch, the tail pump, the
 * poll timer, the WS-token flow, the DB) runs for real.
 *
 * The recorders below are `export let` on purpose: ESM live bindings let a
 * suite read them while `afterEach` reassigns them. Under `--parallel` each
 * file gets this module fresh, so the recorders are per-file - the spill the
 * `attached` note describes used to be cross-FILE inside the serial process.
 */

const defaultLocalLauncher = getDefaultLocalLauncher();

const launcherOriginals = {
  hasSubshell: defaultLocalLauncher.hasSubshell,
  capture: defaultLocalLauncher.capture,
  resize: defaultLocalLauncher.resize,
  paneSize: defaultLocalLauncher.paneSize,
  paneCursor: defaultLocalLauncher.paneCursor,
  signalPaneWinch: defaultLocalLauncher.signalPaneWinch,
};

/** Counts `capture` calls - the pane-poll branch's observable heartbeat. */
export let captureCalls = 0;

/** Tests that install their own capture stub count through this: ESM import
 * bindings are read-only at the call site, so `captureCalls += 1` is legal
 * only inside this module. */
export function bumpCaptureCalls(): void {
  captureCalls += 1;
}
/** What `capture` was last asked for (scrollback line budget). */
export let captureLinesArg: number | undefined;
/** Every `resize` the attach issued, in call order, with its grid. */
export let resizeCalls: Array<{ cols: number; rows: number }> = [];
/** Shared per-test ordered log - proves resize lands BEFORE the capture. */
export let order: string[] = [];

/** The memoized local launcher the handler resolves - the object whose
 * tmux-touching methods {@link stubLauncher} swaps. */
export { defaultLocalLauncher };

/** Swaps the launcher's tmux-touching methods for in-memory fakes that feed
 * the recorders above; `afterEach` restores them from `launcherOriginals`. */
export function stubLauncher(): void {
  defaultLocalLauncher.hasSubshell = async (_socket: string, _id: string) => true;
  defaultLocalLauncher.capture = async (_socket: string, _id: string, lines?: number) => {
    captureCalls += 1;
    captureLinesArg = lines;
    order.push("capture");
    return "SCREEN";
  };
  defaultLocalLauncher.resize = async (_socket: string, _id: string, cols: number, rows: number) => {
    resizeCalls.push({ cols, rows });
    order.push("resize");
  };
  // Default: the machine cannot deliver a bare SIGWINCH (as for a remote
  // node today), so the nudge path under test is the ±1 resize. Its
  // no-reflow-first behavior gets its own cases in the replay file.
  // Unreadable BY DEFAULT, and deliberately so: the real `paneSize` shells out
  // to tmux against a socket that does not exist, which happened to answer
  // null and left every case on the no-geometry path by accident - with the
  // attach's `geometry` frame silently never firing under test, and the old
  // file's own "the tmux CLI is not a bun test dependency" claim quietly
  // broken. Cases that want the frame override this.
  defaultLocalLauncher.paneSize = async () => null;
  defaultLocalLauncher.paneCursor = async () => null;
  defaultLocalLauncher.signalPaneWinch = async () => {
    order.push("winch");
    return false;
  };
}

/**
 * Every browser this file attaches, so `afterEach` can release it.
 *
 * An attach arms a stream that OUTLIVES the test: the log-tail branch leaves
 * an fs watcher plus a 1s backstop interval, and the pane-poll branch a 300ms
 * capture loop. Both keep calling the STUBBED launcher, and the stubs push
 * into the recorders above, whose reassignment a leaked poller could
 * otherwise spill into - the shape that made these cases pass alone and fail
 * in a full run.
 */
export interface FakeBrowser {
  /** The socket handed to `handleSubshellWs`; `data` is its own object. */
  ws: WsSocket;
  /** Every frame the server sent, in order, as raw JSON strings. */
  sent: string[];
  /** Every `close` the server performed, code and reason included. */
  closed: { code?: number; reason?: string }[];
}

/** Every browser attached since the last `afterEach`, so cleanup runs even
 * for a test that failed before its own disconnect. */
export const attached: FakeBrowser[] = [];

/** A fake browser socket with `ws.data` as a SEPARATE object (as Elysia's is). */
export function fakeBrowser(): FakeBrowser {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws = {
    data: {},
    send: (d: string) => {
      sent.push(d);
      return 0;
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    raw: {},
    // Typed loosely the way `subshell-ws.test.ts`'s socket fake does: the
    // cast owns the seam, not the interface. The local path never calls
    // `ws.subscribe` (the pump subscribes on the `paneStreams` registry and
    // delivers through the closure), so the fake carries no pubsub members -
    // a future handler call would surface instead of being swallowed.
  } as unknown as WsSocket;
  return { ws, sent, closed };
}

/** Runs the real handler with a real single-use WS token (+ optional query, e.g. `&cols=132&rows=43`). */
export async function attach(userId: string, subshellId: string, extraQuery = ""): Promise<FakeBrowser> {
  const url = new URL(`ws://localhost/ws/subshell?subshell=${subshellId}&token=${issueWsToken(userId)}${extraQuery}`);
  const fake = fakeBrowser();
  await handleSubshellWs(fake.ws, url);
  attached.push(fake);
  return fake;
}

let rowSeq = 0;

/** Seeds a live local subshell row (owner = a fresh synthetic user). */
export async function seedLocalRow() {
  const { repos } = getRequestlessContext();
  rowSeq += 1;
  return repos.subshells.create({
    id: crypto.randomUUID(),
    userId: `u-ws-leak-${rowSeq}`,
    presetId: "p-test",
    harnessId: "shell",
    name: "ws-leak-regression",
    workingDir: "/tmp",
    tmuxSocket: "subshell-ws-leak-test",
  });
}

beforeAll(async () => {
  await runMigrations(); // the row insert + persistOutput's update hit the shared temp DB
});

afterEach(() => {
  // Before the stubs are restored: a live poller must not survive into the
  // next test, and cleanupSubshellWs is idempotent, so cases that already
  // release their own socket are unaffected.
  for (const fake of attached.splice(0)) cleanupSubshellWs(fake.ws);
  defaultLocalLauncher.hasSubshell = launcherOriginals.hasSubshell;
  defaultLocalLauncher.capture = launcherOriginals.capture;
  defaultLocalLauncher.resize = launcherOriginals.resize;
  defaultLocalLauncher.paneSize = launcherOriginals.paneSize;
  defaultLocalLauncher.paneCursor = launcherOriginals.paneCursor;
  defaultLocalLauncher.signalPaneWinch = launcherOriginals.signalPaneWinch;
  captureCalls = 0;
  captureLinesArg = undefined;
  resizeCalls = [];
  order = [];
  resetLiveViewersForTests();
});
