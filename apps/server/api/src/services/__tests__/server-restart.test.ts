import { describe, expect, it } from "bun:test";
import { performRestart, WS_CLOSE_SERVICE_RESTART } from "@/services/server-restart.js";

describe("performRestart", () => {
  it("after the delay closes viewers and nodes with 1012 and exits 0, in that order", () => {
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
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });
    expect(calls).toEqual([]); // nothing before the timer fires — the 202 must flush first
    scheduled?.();
    expect(calls).toEqual([
      `viewers:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      `nodes:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      "exit:0",
    ]);
  });

  it("uses a close code below 4000, so the SPA's socket retries instead of giving up", () => {
    expect(WS_CLOSE_SERVICE_RESTART).toBe(1012);
  });
});
