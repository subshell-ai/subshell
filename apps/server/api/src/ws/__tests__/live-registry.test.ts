import { beforeEach, describe, expect, it } from "bun:test";
import {
  dropLiveSocketsFor,
  registerLiveSocket,
  resetLiveRegistryForTests,
  unregisterLiveSocket,
} from "@/ws/live-registry.js";
import type { LiveWsSocket } from "@/ws/live-ws.js";

function socket(userId?: string) {
  const closed: { code?: number; reason?: string }[] = [];
  const ws: LiveWsSocket = {
    data: { liveViewerId: userId },
    send: () => 1,
    close: (code, reason) => closed.push({ code, reason }),
  };
  return { ws, closed };
}

beforeEach(() => resetLiveRegistryForTests());

describe("live socket registry", () => {
  /**
   * The Critical this exists for: `topicsForViewer` is evaluated ONCE at
   * connect, so an admin's socket is subscribed to the instance-wide topic for
   * its whole life. Demote them with a tab open and they keep receiving every
   * subshell on the instance — a role change reaches no WebSocket, because a
   * socket authenticates at connect and is never re-checked.
   */
  it("closes every socket a demoted user holds", () => {
    const a = socket("u1");
    const b = socket("u1");
    const other = socket("u2");
    registerLiveSocket("u1", a.ws);
    registerLiveSocket("u1", b.ws);
    registerLiveSocket("u2", other.ws);

    expect(dropLiveSocketsFor("u1")).toBe(2);
    expect(a.closed.length).toBe(1);
    expect(b.closed.length).toBe(1);
    expect(other.closed).toEqual([]); // an unrelated viewer is untouched
  });

  it("closes BELOW 4000, so the client reconnects instead of reporting a refusal", () => {
    const { ws, closed } = socket("u1");
    registerLiveSocket("u1", ws);
    dropLiveSocketsFor("u1");
    expect(closed[0]?.code).toBeLessThan(4000);
  });

  it("forgets a socket that closed on its own, so a later drop does not touch it", () => {
    const { ws, closed } = socket("u1");
    registerLiveSocket("u1", ws);
    unregisterLiveSocket("u1", ws);
    expect(dropLiveSocketsFor("u1")).toBe(0);
    expect(closed).toEqual([]);
  });

  it("is harmless for a user with no sockets, and for a throwing close", () => {
    expect(dropLiveSocketsFor("nobody")).toBe(0);
    const ws: LiveWsSocket = {
      data: { liveViewerId: "u1" },
      send: () => 1,
      close: () => {
        throw new Error("already gone");
      },
    };
    registerLiveSocket("u1", ws);
    expect(() => dropLiveSocketsFor("u1")).not.toThrow();
  });

  it("drops the user's entry, so a second drop is a no-op", () => {
    const { ws } = socket("u1");
    registerLiveSocket("u1", ws);
    expect(dropLiveSocketsFor("u1")).toBe(1);
    expect(dropLiveSocketsFor("u1")).toBe(0);
  });
});
