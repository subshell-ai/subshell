import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallbackRequest, paneCallbackSockPath, startCallbackDoors } from "../callback-sock.js";

/**
 * The callback door's 504 (design 2026-10-05 §5): a request whose
 * `rest_response` never arrives from the plane is answered `504
 * runtime_callback_timeout` when {@link CALLBACK_TIMEOUT} elapses - "the
 * plane stopped answering, which is exactly what a lost session looks like
 * from the pane side".
 *
 * The timeout constant is module-private and not injectable, so the test
 * captures the scheduled callback through a narrow `globalThis.setTimeout`
 * shim (only a `setTimeout(fn, 30000)` is taken; every other timer passes
 * through to the real one), and fires it by hand. The real timer is restored
 * when the capture scope unwinds - the `finally` after the test body, NOT
 * before the response await inside it; the response delivery is I/O, so no
 * timer stands between the fired callback and the 504. No source seam, no
 * 30-second wall-clock wait. The captured ms value doubles as the pin that
 * the door's budget is still 30 s.
 */

/** The door's own timeout budget, asserted on the captured schedule (module doc's contract). */
const CALLBACK_TIMEOUT = 30_000;

const dirs: string[] = [];
function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-cb504-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const realSetTimeout = globalThis.setTimeout;

/** One door request over the real unix socket, the same client the pane's MCP child uses. */
function ask(sockPath: string, path: string): Promise<Response> {
  return fetch(`http://runtime${path}`, { unix: sockPath } as unknown as RequestInit & { unix: string });
}

async function waitSeen(seen: CallbackRequest[]): Promise<void> {
  const t0 = Date.now();
  while (seen.length < 1) {
    if (Date.now() - t0 > 2000) throw new Error("the request never reached the door");
    await new Promise((r) => realSetTimeout(r, 10));
  }
}

interface CapturedTimer {
  ms: number | undefined;
  fire(): void;
}

/** Install the capture shim for one test body; the real timer is restored after. */
async function withCapturedTimeout(run: (captured: CapturedTimer[]) => Promise<void>): Promise<void> {
  const captured: CapturedTimer[] = [];
  globalThis.setTimeout = ((cb: unknown, ms?: number | string, ...rest: unknown[]) => {
    if (typeof cb === "function" && ms === CALLBACK_TIMEOUT) {
      let cleared = false;
      captured.push({
        ms,
        fire: () => {
          if (!cleared) {
            cleared = true;
            (cb as () => void)();
          }
        },
      });
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }
    return (realSetTimeout as (cb: unknown, ms: unknown, ...r: unknown[]) => unknown)(cb, ms, ...rest) as ReturnType<
      typeof setTimeout
    >;
  }) as typeof setTimeout;
  try {
    await run(captured);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

describe("callback door timeout", () => {
  test("an unanswered request answers 504 at the 30 s budget, and a late plane answer is dropped", async () => {
    const dataDir = freshDataDir();
    const seen: CallbackRequest[] = [];
    const doors = await startCallbackDoors(dataDir, (req) => seen.push(req));
    try {
      await withCapturedTimeout(async (captured) => {
        const inflight = ask(doors.sharedPath, "/api/subshells/x");
        await waitSeen(seen);
        expect(captured.length, "the door scheduled exactly one timeout for the request").toBe(1);
        expect(captured[0]?.ms).toBe(CALLBACK_TIMEOUT);
        captured[0]?.fire();
        const res = await inflight; // the shim is still installed (restore is the scope's finally); delivery is I/O, not a timer
        expect(res.status).toBe(504);
        expect(await res.json()).toEqual({ error: "runtime_callback_timeout" });
        // The pending entry was evicted with the 504; the plane's late answer
        // for that reqId finds nothing and must not throw or double-answer.
        doors.resolve((seen[0] as CallbackRequest).reqId, 200, "{}");
      });
    } finally {
      await doors.stop();
    }
  });

  test("the timeout races the plane's answer once: whoever settles first wins, the other is dropped", async () => {
    const dataDir = freshDataDir();
    const pane = "11111111-1111-4111-8111-111111111111";
    const seen: CallbackRequest[] = [];
    const doors = await startCallbackDoors(dataDir, (req) => seen.push(req));
    try {
      await doors.ensurePane(pane);
      await withCapturedTimeout(async (captured) => {
        // Answer first; the still-pending timeout then fires against an
        // evicted entry (the guarded `settle`): the pane keeps the 200.
        const inflight = ask(paneCallbackSockPath(dataDir, pane), `/api/subshells/${pane}/attention`);
        await waitSeen(seen);
        expect(captured.length).toBe(1);
        doors.resolve((seen[0] as CallbackRequest).reqId, 200, JSON.stringify({ ok: true }));
        captured[0]?.fire();
        const res = await inflight;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      });
    } finally {
      await doors.stop();
    }
  });
});
