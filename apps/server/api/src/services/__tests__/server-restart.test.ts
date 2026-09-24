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
    // The node half is AWAITED now — each eviction projects its row offline
    // before the sequence moves on — so `stop` lands a few microtasks behind
    // the closes, not beside them. Asserting only the closes here is what
    // would catch a node closer that never runs at all.
    expect(calls).toEqual([
      `viewers:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      `nodes:${WS_CLOSE_SERVICE_RESTART}:server restart`,
    ]);
    await Bun.sleep(5);
    // And the exit still WAITS on the stop rather than racing it: the ORDER
    // is the assertion, so a change that exits while a tunnel is still up
    // lands `exit:0` before `stop` and fails here.
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

  it("a node closer that THROWS mid-await still stops children and exits", async () => {
    // The timer callback is async and nobody observes its promise. When the
    // node half grew its awaited offline-projection, a rejecting seam became
    // an unhandled rejection that skipped everything after it — the process
    // sat alive forever after the 202 had flushed, a restart wearing a hang's
    // name. The file's own rule ("a failure to stop one is not a reason to
    // stay up") must hold across the await, not just inside the stop chain.
    const calls: string[] = [];
    let scheduled: (() => void) | undefined;
    performRestart({
      delayMs: 10,
      setTimer: ((fn: () => void) => {
        scheduled = fn;
        return 0 as never;
      }) as never,
      closeViewers: () => {
        calls.push("viewers");
        return 1;
      },
      closeNodes: async () => {
        calls.push("nodes-throw");
        throw new Error("registry blew up mid-projection");
      },
      stopProcesses: async () => {
        calls.push("stop");
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });
    scheduled?.();
    await Bun.sleep(5);
    expect(calls).toEqual(["viewers", "nodes-throw", "stop", "exit:0"]);
  });

  it("a synchronous throw before the await still reaches the stop and the exit", async () => {
    // Same rule, other half of the try block: the viewer closer throwing on
    // the first line must not strand the shutdown any more than a rejection
    // on the awaited one does.
    const calls: string[] = [];
    let scheduled: (() => void) | undefined;
    performRestart({
      delayMs: 10,
      setTimer: ((fn: () => void) => {
        scheduled = fn;
        return 0 as never;
      }) as never,
      closeViewers: () => {
        throw new Error("no viewers to close");
      },
      stopProcesses: async () => {
        calls.push("stop");
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });
    scheduled?.();
    await Bun.sleep(5);
    expect(calls).toEqual(["stop", "exit:0"]);
  });
});
