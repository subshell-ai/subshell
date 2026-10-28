import { afterEach, expect, it } from "bun:test";
import {
  INPUT_FRAME_MAX_BYTES,
  INPUT_GLOBAL_MAX_BYTES,
  INPUT_GLOBAL_MAX_FRAMES,
  INPUT_SOCKET_MAX_BYTES,
  INPUT_SOCKET_MAX_FRAMES,
  takeInputBudget,
} from "@/api/ws/input-budget.js";
import {
  hasHeldInput,
  holdFailedInput,
  refireInputHoldsForNode,
  resetInputHoldsForTests,
} from "@/api/ws/input-hold.js";
import { cleanupSubshellWs, handleSubshellMessage } from "@/api/ws/subshell-ws.js";
import type { WsSocket } from "@/api/ws/viewers.js";

function socket(sendInput: () => Promise<void> = async () => {}) {
  const closed: number[] = [];
  const ws = {
    data: {
      launcher: { sendInput },
      socket: "sock",
      subshellId: crypto.randomUUID(),
      nodeId: "budget-node",
      viewerId: crypto.randomUUID(),
      canInput: true,
    },
    send: () => 1,
    close: (code: number) => {
      closed.push(code);
    },
  } as unknown as WsSocket;
  return { ws, closed };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => resetInputHoldsForTests());

it("bounds unacknowledged dispatches, including input without retry ids", async () => {
  const done = Promise.withResolvers<void>();
  let dispatched = 0;
  const { ws, closed } = socket(() => {
    dispatched++;
    return done.promise;
  });
  try {
    for (let i = 0; i < INPUT_SOCKET_MAX_FRAMES + 2; i++) {
      handleSubshellMessage(ws, { type: "input", data: "x" });
    }
    expect(dispatched).toBe(INPUT_SOCKET_MAX_FRAMES);
    expect(closed).toEqual([1013]);
  } finally {
    cleanupSubshellWs(ws);
    done.resolve();
    await settle();
  }
});

it("counts UTF-8 bytes per frame and per socket rather than trusting character counts", () => {
  const oversized = socket();
  handleSubshellMessage(oversized.ws, { type: "input", data: "😀".repeat(INPUT_FRAME_MAX_BYTES / 4 + 1) });
  expect(oversized.closed).toEqual([1009]);
  const peer = socket();
  const releases: (() => void)[] = [];
  try {
    const payload = "x".repeat(INPUT_FRAME_MAX_BYTES);
    for (let i = 0; i < INPUT_SOCKET_MAX_BYTES / INPUT_FRAME_MAX_BYTES; i++) {
      const release = takeInputBudget(peer.ws, payload);
      if (!release) throw new Error("input refused before its byte limit");
      releases.push(release);
    }
    expect(takeInputBudget(peer.ws, "x")).toBeNull();
    expect(peer.closed).toEqual([1013]);
  } finally {
    for (const release of releases) {
      release();
      release();
    }
  }
});

it("enforces process-wide frame and byte budgets across connections and releases settled work", () => {
  for (const bytes of [1, INPUT_FRAME_MAX_BYTES]) {
    const payload = "x".repeat(bytes);
    const perSocket = Math.min(INPUT_SOCKET_MAX_FRAMES, INPUT_SOCKET_MAX_BYTES / bytes);
    const count = Math.min(INPUT_GLOBAL_MAX_FRAMES, INPUT_GLOBAL_MAX_BYTES / bytes);
    const releases: (() => void)[] = [];
    let current = socket();
    try {
      for (let i = 0; i < count; i++) {
        if (i % perSocket === 0) current = socket();
        const release = takeInputBudget(current.ws, payload);
        if (!release) throw new Error("input refused before its global limit");
        releases.push(release);
      }
      const excess = socket();
      expect(takeInputBudget(excess.ws, payload)).toBeNull();
      expect(excess.closed).toEqual([1013]);
    } finally {
      for (const release of releases) release();
    }
    const next = takeInputBudget(socket().ws, payload);
    expect(next).not.toBeNull();
    next?.();
  }
});

it("caps retained retries and discards them on overflow without waiting for a close event", async () => {
  const failed = Promise.withResolvers<void>();
  let dispatched = 0;
  const { ws, closed } = socket(() => {
    dispatched++;
    return failed.promise;
  });
  const { nodeId, subshellId, viewerId: sessionId } = ws.data;
  try {
    for (let id = 0; id <= INPUT_SOCKET_MAX_FRAMES; id++) {
      holdFailedInput({ nodeId, subshellId, sessionId, id, payload: "x", ws, sendAck: () => {} });
    }
    expect(closed).toEqual([1013]);
    expect(hasHeldInput(nodeId, subshellId, sessionId)).toBe(false);
    refireInputHoldsForNode(nodeId);
    expect(dispatched).toBe(1);
  } finally {
    failed.reject(new Error("node disconnected"));
    await settle();
  }
});

it("a write failing after disconnect cannot resurrect input or replay into the pane", async () => {
  const failed = Promise.withResolvers<void>();
  let dispatched = 0;
  const { ws } = socket(() => {
    dispatched++;
    return failed.promise;
  });
  handleSubshellMessage(ws, { type: "input", data: "late", id: 1 });
  cleanupSubshellWs(ws);
  failed.reject(new Error("late node failure"));
  await settle();
  expect(hasHeldInput(ws.data.nodeId, ws.data.subshellId, ws.data.viewerId)).toBe(false);
  refireInputHoldsForNode(ws.data.nodeId);
  handleSubshellMessage(ws, { type: "input", data: "closed", id: 2 });
  expect(dispatched).toBe(1);
});

it("disconnecting a retrying socket doesn't release work still running on the node", async () => {
  const releases: (() => void)[] = [];
  const done = Promise.withResolvers<void>();
  const retry = socket(() => done.promise);
  let filler = socket();
  try {
    for (let i = 0; i < INPUT_GLOBAL_MAX_FRAMES - 1; i++) {
      if (i % INPUT_SOCKET_MAX_FRAMES === 0) filler = socket();
      const release = takeInputBudget(filler.ws, "x");
      if (!release) throw new Error("input refused before global limit");
      releases.push(release);
    }
    holdFailedInput({
      nodeId: retry.ws.data.nodeId,
      subshellId: retry.ws.data.subshellId,
      sessionId: retry.ws.data.viewerId,
      id: 1,
      payload: "x",
      ws: retry.ws,
      sendAck: () => {},
    });
    cleanupSubshellWs(retry.ws);
    const excess = socket();
    expect(takeInputBudget(excess.ws, "x")).toBeNull();
    expect(excess.closed).toEqual([1013]);
    done.resolve();
    await settle();
    const recovered = takeInputBudget(socket().ws, "x");
    expect(recovered).not.toBeNull();
    recovered?.();
  } finally {
    done.resolve();
    await settle();
    for (const release of releases) release();
  }
});
