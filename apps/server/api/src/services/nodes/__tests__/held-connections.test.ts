import { beforeEach, describe, expect, it } from "bun:test";
import { NODE_CLOSE_SUPERSEDED } from "@internal/subshell-protocol";
import {
  attachConnection,
  disconnectNode,
  getHeld,
  getLive,
  HELD_IDLE_MS,
  holdConnection,
  isNodeOffline,
  listHeld,
  listOnline,
  type NodeSocket,
  REVOKED_CLOSE_CODE,
  releaseHeld,
  resetNodeRegistryForTests,
} from "../node-registry.js";

/**
 * The held map (spec 2026-09-15 §5.3): sockets the plane refuses for
 * everything except `update`.
 *
 * The property every case here is really about is that HOLDING CHANGES
 * NOTHING ABOUT LIVENESS. `isNodeOffline` is the blessed predicate every "can
 * this row be reached" decision goes through, and a held node must answer it
 * exactly as a disconnected one does — otherwise launches, tails and probes
 * start travelling to a machine that speaks a protocol this server does not.
 */

interface FakeSocket extends NodeSocket {
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

function fakeSocket(): FakeSocket {
  return {
    sent: [],
    closed: [],
    send(data: string) {
      this.sent.push(data);
      return data.length;
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
    },
  };
}

const holdInput = (over: Partial<Parameters<typeof holdConnection>[2]> = {}) => ({
  reason: "below-floor" as const,
  agentVersion: "0.8.0",
  protocolVersion: 9,
  os: "linux",
  arch: "x64",
  onIdle: () => undefined,
  ...over,
});

describe("held connections", () => {
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("moves the socket OUT of the live registry, so the node stays offline for everything else", () => {
    const ws = fakeSocket();
    const conn = attachConnection("n1", ws);
    expect(isNodeOffline("n1")).toBe(false);

    holdConnection("n1", conn, holdInput());

    expect(getLive("n1")).toBeUndefined();
    expect(listOnline()).not.toContain("n1");
    // The whole design in one assertion: held is offline.
    expect(isNodeOffline("n1")).toBe(true);
    expect(getHeld("n1")?.conn).toBe(conn);
  });

  it("does NOT close the socket — that is the difference from what it replaced", () => {
    const ws = fakeSocket();
    holdConnection("n1", attachConnection("n1", ws), holdInput());
    expect(ws.closed).toHaveLength(0);
    // And sends nothing: an agent that has been held is waiting for a command
    // or a close, and a courtesy frame it might not parse is worse than silence.
    expect(ws.sent).toHaveLength(0);
  });

  it("listHeld reports what a page needs to say why, and nothing about the socket", () => {
    holdConnection("n1", attachConnection("n1", fakeSocket()), holdInput());
    holdConnection(
      "n2",
      attachConnection("n2", fakeSocket()),
      holdInput({
        reason: "protocol-mismatch",
        agentVersion: "1.2.3",
        protocolVersion: 3,
        os: "darwin",
        arch: "arm64",
      }),
    );
    const rows = listHeld().sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      nodeId: "n1",
      reason: "below-floor",
      agentVersion: "0.8.0",
      protocolVersion: 9,
      os: "linux",
      arch: "x64",
      since: expect.any(String),
    });
    expect(rows[1]).toMatchObject({ nodeId: "n2", reason: "protocol-mismatch", os: "darwin", arch: "arm64" });
    // Plain data: the only legitimate use for the socket is `sendCommand`,
    // which finds it itself.
    expect(rows[0]).not.toHaveProperty("conn");
  });

  it("a new socket supersedes a held one with 4409, whichever map it was in", () => {
    const first = fakeSocket();
    holdConnection("n1", attachConnection("n1", first), holdInput());

    const second = fakeSocket();
    attachConnection("n1", second);

    expect(first.closed[0]?.code).toBe(NODE_CLOSE_SUPERSEDED);
    expect(getHeld("n1")).toBeUndefined();
    expect(getLive("n1")?.ws).toBe(second);
  });

  it("a second HOLD for the same node supersedes the first", () => {
    const first = fakeSocket();
    holdConnection("n1", attachConnection("n1", first), holdInput());
    const second = fakeSocket();
    holdConnection("n1", attachConnection("n1", second), holdInput({ agentVersion: "0.8.1" }));
    expect(getHeld("n1")?.agentVersion).toBe("0.8.1");
    expect(listHeld()).toHaveLength(1);
  });

  it("releaseHeld applies the same identity guard detachConnection does", () => {
    const wsA = fakeSocket();
    const connA = attachConnection("n1", wsA);
    holdConnection("n1", connA, holdInput());
    const connB = attachConnection("n2", fakeSocket());

    // A superseded socket's LATE close must not evict its replacement.
    expect(releaseHeld("n1", connB)).toBe(false);
    expect(getHeld("n1")).toBeDefined();
    expect(releaseHeld("n1", connA)).toBe(true);
    expect(getHeld("n1")).toBeUndefined();
  });

  it("arms an idle close that names the reason, and disarms it on release", async () => {
    // The budget is ten minutes in production; the timer's EXISTENCE is what
    // this pins, since a suite cannot wait that long. What it rules out is the
    // regression that matters: a held socket with nothing scheduled to close
    // it, so the plane accumulates sockets it will never use.
    let fired = 0;
    const ws = fakeSocket();
    const conn = attachConnection("n1", ws);
    const entry = holdConnection("n1", conn, holdInput({ onIdle: () => fired++ }));
    expect(entry.timer).toBeDefined();
    expect(HELD_IDLE_MS).toBe(10 * 60 * 1000);

    releaseHeld("n1", conn);
    // Cleared, so nothing fires minutes later against a socket already gone.
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toBe(0);
  });

  it("disconnectNode evicts a HELD socket too — a revoked key must not keep one open", () => {
    // `update` is the one thing a held socket could still carry, and that is
    // precisely what a rotated or deleted key must no longer be able to do.
    const ws = fakeSocket();
    holdConnection("n1", attachConnection("n1", ws), holdInput());
    expect(disconnectNode("n1")).toBe(true);
    expect(ws.closed[0]?.code).toBe(REVOKED_CLOSE_CODE);
    expect(getHeld("n1")).toBeUndefined();
  });
});
