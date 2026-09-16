import { describe, expect, it } from "bun:test";
import { performRestart, WS_CLOSE_SERVICE_RESTART } from "@/services/server-restart.js";

describe("performRestart", () => {
  it("after the delay closes viewers and nodes with 1012, stops network children, then exits 0, in that order", async () => {
    const calls: string[] = [];
    let scheduled: (() => void) | undefined;
    performRestart({
      delayMs: 250,
      setTimer: ((fn: () => void, ms: number) => {
        expect(ms).toBe(250);
        scheduled = fn;
        return 0 as never;
      }) as never,
      closeViewers: (code, reason) => {
        calls.push(`viewers:${code}:${reason}`);
        return 2;
      },
      closeNodes: (code, reason) => {
        calls.push(`nodes:${code}:${reason}`);
        return 1;
      },
      // Supervised network children are ours to reap: a tunnel outliving the
      // server it points at stays resolvable and refuses every connection.
      stopProcesses: async () => {
        calls.push("stop");
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });
    expect(calls).toEqual([]); // nothing before the timer fires — the 202 must flush first
    scheduled?.();
    // The exit WAITS on the stop rather than racing it, so it lands a
    // microtask later. Asserting its absence here is what would catch a change
    // that exits while a tunnel is still up.
    expect(calls).toEqual([
      `viewers:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      `nodes:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      "stop",
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      `viewers:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      `nodes:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      "stop",
      "exit:0",
    ]);
  });

  it("uses a close code below 4000, so the SPA's socket retries instead of giving up", () => {
    expect(WS_CLOSE_SERVICE_RESTART).toBe(1012);
  });
});
