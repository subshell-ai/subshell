import { afterEach, expect, it } from "bun:test";
import {
  INPUT_FRAME_MAX_BYTES,
  INPUT_GLOBAL_MAX_BYTES,
  INPUT_GLOBAL_MAX_FRAMES,
  INPUT_NODE_MAX_BYTES,
  INPUT_NODE_MAX_FRAMES,
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
import { closeViewersForSubshell, registerViewer, type WsSocket } from "@/api/ws/viewers.js";

function socket(sendInput: () => Promise<void> = async () => {}) {
  const closed: number[] = [];
  const ws = {
    data: {
      launcher: { sendInput },
      socket: "sock",
      subshellId: crypto.randomUUID(),
      nodeId: crypto.randomUUID(),
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

it("one offline node cannot consume the fleet's input budget across sockets", async () => {
  for (const bytes of [1, INPUT_FRAME_MAX_BYTES]) {
    const releases: (() => void)[] = [];
    const payload = "x".repeat(bytes);
    const count = Math.min(INPUT_NODE_MAX_FRAMES, INPUT_NODE_MAX_BYTES / bytes);
    const perSocket = Math.min(INPUT_SOCKET_MAX_FRAMES, INPUT_SOCKET_MAX_BYTES / bytes);
    const nodeId = crypto.randomUUID();
    let current = socket();
    try {
      for (let i = 0; i < count; i++) {
        if (i % perSocket === 0) current = socket();
        current.ws.data.nodeId = nodeId;
        const release = takeInputBudget(current.ws, payload);
        if (!release) throw new Error("node budget refused input early");
        releases.push(release);
      }
      const excess = socket();
      excess.ws.data.nodeId = nodeId;
      expect(takeInputBudget(excess.ws, payload)).toBeNull();
      expect(excess.closed).toEqual([1013]);
      const healthy = socket();
      const release = takeInputBudget(healthy.ws, payload);
      expect(release).not.toBeNull();
      expect(healthy.closed).toEqual([]);
      release?.();
    } finally {
      for (const release of releases) release();
    }
    const recovered = socket();
    recovered.ws.data.nodeId = nodeId;
    const release = takeInputBudget(recovered.ws, payload);
    expect(release).not.toBeNull();
    release?.();
  }
});

it("forced disconnect drops held input synchronously when close never fires", async () => {
  let dispatched = 0;
  let acknowledged = 0;
  const { ws, closed } = socket(async () => {
    dispatched++;
    throw new Error("node offline");
  });
  // Exercise the negotiated session id rather than the viewer-id fallback.
  Object.assign(ws.data, { query: { sid: "forced-session" } });
  registerViewer(ws, ws.data.subshellId);
  const held = { nodeId: ws.data.nodeId, subshellId: ws.data.subshellId, sessionId: "forced-session" };
  holdFailedInput({ ...held, id: 1, payload: "held", ws, sendAck: () => acknowledged++ });
  await settle();
  expect(hasHeldInput(held.nodeId, held.subshellId, held.sessionId)).toBe(true);
  expect(closeViewersForSubshell(ws.data.subshellId, 1012, "stream recovery")).toBe(1);
  expect(ws.data.inputClosed).toBe(true);
  expect(hasHeldInput(held.nodeId, held.subshellId, held.sessionId)).toBe(false);
  refireInputHoldsForNode(held.nodeId);
  handleSubshellMessage(ws, { type: "input", data: "late", id: 2 });
  await settle();
  expect(dispatched).toBe(1);
  expect(acknowledged).toBe(0);
  expect(closed).toEqual([1012]);
});

/** Fill the fleet queue from sockets that each stay inside their own caps. */
function saturateFleet(): (() => void)[] {
  const charges: (() => void)[] = [];
  for (let s = 0; s < INPUT_GLOBAL_MAX_FRAMES / INPUT_SOCKET_MAX_FRAMES; s++) {
    const filler = socket();
    for (let f = 0; f < INPUT_SOCKET_MAX_FRAMES; f++) {
      const release = takeInputBudget(filler.ws, "x");
      if (!release) throw new Error("the fleet queue filled earlier than expected");
      charges.push(release);
    }
  }
  return charges;
}

it("reclaims a stuck retry instead of closing a viewer whose own pane is alive", () => {
  const charges = saturateFleet();
  try {
    // With no capacity to take back, an arrival still pays for a queue it did
    // not fill. That is the honest last resort, not the first answer.
    const refused = socket();
    expect(takeInputBudget(refused.ws, "x")).toBeNull();
    expect(refused.closed).toEqual([1013]);

    // With one stuck retry to give up, the next viewer is admitted instead.
    let reclaimed = 0;
    const viewer = socket();
    const release = takeInputBudget(viewer.ws, "x", () => {
      charges.pop()?.();
      reclaimed++;
      return true;
    });
    expect(release).not.toBeNull();
    expect(viewer.closed).toEqual([]);
    expect(reclaimed).toBe(1);
    release?.();
  } finally {
    for (const charge of charges) charge();
  }
});

it("still ends the arrival when the shared queue cannot be relieved", () => {
  const charges = saturateFleet();
  try {
    let asked = 0;
    const viewer = socket();
    expect(takeInputBudget(viewer.ws, "x", () => (asked++, false))).toBeNull();
    expect(viewer.closed).toEqual([1013]);
    expect(asked).toBe(1);
  } finally {
    for (const charge of charges) charge();
  }
});

it("caps a node by bytes across its sockets, not only by frames", () => {
  // The node and socket byte ceilings are the same number, so one socket
  // filling the node would trip both and prove neither. Spread the load so the
  // only bound left standing is the node's own.
  const framesToFillNode = INPUT_NODE_MAX_BYTES / INPUT_FRAME_MAX_BYTES;
  expect(framesToFillNode).toBe(256);
  const socketsNeeded = 4;
  const perSocket = framesToFillNode / socketsNeeded;
  expect(perSocket).toBeLessThan(INPUT_SOCKET_MAX_FRAMES);
  const payload = "x".repeat(INPUT_FRAME_MAX_BYTES);
  const nodeId = crypto.randomUUID();
  const charges: (() => void)[] = [];
  try {
    for (let s = 0; s < socketsNeeded; s++) {
      const filler = socket();
      filler.ws.data.nodeId = nodeId;
      for (let f = 0; f < perSocket; f++) {
        const release = takeInputBudget(filler.ws, payload);
        if (!release) throw new Error("a per-socket bound tripped before the node's did");
        charges.push(release);
      }
    }
    const excess = socket();
    excess.ws.data.nodeId = nodeId;
    expect(takeInputBudget(excess.ws, payload)).toBeNull();
    expect(excess.closed).toEqual([1013]);
  } finally {
    for (const charge of charges) charge();
  }
});

it("forced disconnect drops held input for a shared viewer with no negotiated session id", async () => {
  let dispatched = 0;
  const { ws } = socket(async () => {
    dispatched++;
    throw new Error("node offline");
  });
  // Deliberately no `query`: the arrival keys its hold by the viewer-id
  // fallback, so recovery has to find the backlog there rather than only in the
  // negotiated-sid case the other test covers.
  registerViewer(ws, ws.data.subshellId);
  const held = { nodeId: ws.data.nodeId, subshellId: ws.data.subshellId, sessionId: ws.data.viewerId };
  holdFailedInput({ ...held, id: 1, payload: "held", ws, sendAck: () => {} });
  await settle();
  expect(hasHeldInput(held.nodeId, held.subshellId, held.sessionId)).toBe(true);
  expect(closeViewersForSubshell(ws.data.subshellId, 1012, "stream recovery")).toBe(1);
  expect(hasHeldInput(held.nodeId, held.subshellId, held.sessionId)).toBe(false);
  refireInputHoldsForNode(held.nodeId);
  await settle();
  expect(dispatched).toBe(0);
});
