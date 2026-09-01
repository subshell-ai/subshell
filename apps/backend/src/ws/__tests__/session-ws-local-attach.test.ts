import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { defaultLocalLauncher } from "@/services/nodes/local-launcher.js";
import { sessionLogPath } from "@/services/nodes/session-paths.js";
import { cleanupSessionWs, handleSessionWs, type WsSocket } from "@/ws/session-ws.js";
import { issueWsToken } from "@/ws/ws-token.js";

/**
 * Local-attach cleanup leak (pre-Task-11, surfaced while reviewing §6.5).
 *
 * `handleSessionWs` copied the attach state onto `ws.data` with
 * `Object.assign` BEFORE `startLogTail`/`startPanePoll` assigned
 * `data.cleanup` onto the local object — so `ws.data.cleanup` stayed
 * undefined, `cleanupSessionWs(ws)` released nothing on disconnect, and
 * every local terminal attach leaked a live fs.watcher plus its
 * backstop/poll timer for the process lifetime.
 *
 * These tests drive the REAL handler through the REAL seams (issued WS
 * token, DB row via the shared test context, real fs.watch on the session
 * log file) and pin the behavior the leak broke: after `cleanupSessionWs`
 * the stream is dead — no post-disconnect output frames, no pane captures
 * — and `ws.data.cleanup`, the contract `cleanupSessionWs` consumes, is a
 * wired function. The remote relay was always correct (it installs
 * `cleanup` into `data` before its `Object.assign`); the local twin was not.
 */

// The handler resolves the local launcher via `launcherFor(LOCAL_NODE_ID)` —
// the module-level `defaultLocalLauncher`. Its tmux-touching methods are
// stubbed as OWN properties (the tmux CLI is not a `bun test` dependency)
// and restored per test; every other seam (fs.watch, the tail pump, the
// poll timer, the WS-token flow, the DB) runs for real.
const launcherOriginals = {
  hasSession: defaultLocalLauncher.hasSession,
  capture: defaultLocalLauncher.capture,
};
/** Counts `capture` calls — the pane-poll branch's observable heartbeat. */
let captureCalls = 0;

function stubLauncher(): void {
  defaultLocalLauncher.hasSession = async (_socket: string, _id: string) => true;
  defaultLocalLauncher.capture = async (_socket: string, _id: string) => {
    captureCalls += 1;
    return "SCREEN";
  };
}

afterEach(() => {
  defaultLocalLauncher.hasSession = launcherOriginals.hasSession;
  defaultLocalLauncher.capture = launcherOriginals.capture;
  captureCalls = 0;
});

let rowSeq = 0;

/** Seeds a live local session row (owner = a fresh synthetic user). */
async function seedLocalRow() {
  const { repos } = getRequestlessContext();
  rowSeq += 1;
  return repos.sessions.create({
    id: crypto.randomUUID(),
    userId: `u-ws-leak-${rowSeq}`,
    profileId: "p-test",
    harnessId: "shell",
    name: "ws-leak-regression",
    workingDir: "/tmp",
    tmuxSocket: "mote-ws-leak-test",
  });
}

interface FakeBrowser {
  ws: WsSocket;
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

/** A fake browser socket with `ws.data` as a SEPARATE object (as Elysia's is). */
function fakeBrowser(): FakeBrowser {
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
  } as unknown as WsSocket;
  return { ws, sent, closed };
}

/** Runs the real handler with a real single-use WS token. */
async function attach(userId: string, sessionId: string): Promise<FakeBrowser> {
  const url = new URL(`ws://localhost/ws/session?session=${sessionId}&token=${issueWsToken(userId)}`);
  const fake = fakeBrowser();
  await handleSessionWs(fake.ws, url);
  return fake;
}

beforeAll(async () => {
  await runMigrations(); // the row insert + persistOutput's update hit the shared temp DB
});

describe("local attach cleanup — the ws.data wiring (pre-existing leak)", () => {
  it("the tail disposer is reachable on ws.data after attach — the contract cleanupSessionWs consumes", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(sessionLogPath(row.id), "old\n"); // log exists ⇒ startLogTail branch

    const { ws, sent, closed } = await attach(row.userId, row.id);
    try {
      expect(closed).toEqual([]); // the attach ran to completion (not a refusal)
      expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
      // RED today: Object.assign ran before startLogTail set `data.cleanup` on
      // the local object, so ws.data never received the disposer and a
      // disconnect releases the watcher/timer by accident of nothing running.
      expect(typeof (ws.data as { cleanup?: unknown }).cleanup).toBe("function");
    } finally {
      cleanupSessionWs(ws); // if wired (GREEN), releases the watcher+timer; if leaked, test 2 catches it
    }
  });

  it("a disconnect stops the stream: bytes appended after cleanup never ship", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = sessionLogPath(row.id);
    await Bun.write(logFile, "old\n");

    const { ws, sent } = await attach(row.userId, row.id);
    await Bun.sleep(60); // let the initial catch-up pump's frames land
    cleanupSessionWs(ws); // browser disconnects
    const framesAtDisconnect = sent.length;

    appendFileSync(logFile, "after disconnect\n");
    await Bun.sleep(1300); // the fs.watch fires ~instantly; the 1000ms backstop covers twice
    // RED today: the watcher and its timer outlived the disconnect and stream
    // the appended bytes on the dead socket.
    expect(sent.slice(framesAtDisconnect)).toEqual([]);
  });

  it("the pane-poll branch: cleanup clears the poll interval — no captures after disconnect", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    // No log file at sessionLogPath(row.id) ⇒ the handler takes startPanePoll.

    const { ws } = await attach(row.userId, row.id);
    try {
      expect(typeof (ws.data as { cleanup?: unknown }).cleanup).toBe("function");
      await Bun.sleep(700); // ≥ 2 ticks of the 300ms poller
      expect(captureCalls).toBeGreaterThan(1); // replay capture + poll ticks ran
      cleanupSessionWs(ws);
      const capturesAtDisconnect = captureCalls;
      await Bun.sleep(700);
      // RED today: the interval never cleared — the poller captures the pane
      // forever after the browser left.
      expect(captureCalls).toBe(capturesAtDisconnect);
    } finally {
      cleanupSessionWs(ws);
    }
  });
});
