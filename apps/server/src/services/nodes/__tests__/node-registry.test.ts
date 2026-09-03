import { beforeEach, describe, expect, it } from "bun:test";
import { NODE_CLOSE_SUPERSEDED } from "@internal/subshell-protocol";
import {
  attachConnection,
  detachConnection,
  disconnectNode,
  getLive,
  listOnline,
  type NodeSocket,
  REVOKED_CLOSE_CODE,
  resetNodeRegistryForTests,
} from "../node-registry.js";

/** Minimal fake socket recording frames and close calls. */
interface FakeSocket extends NodeSocket {
  /** Payloads passed to `send` in call order */
  sent: string[];
  /** Close calls in call order */
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

describe("node registry (spec 2026-08-31 §5.3)", () => {
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("tracks attach → getLive → listOnline → detach", () => {
    const a = fakeSocket();
    const conn = attachConnection("n1", a);
    expect(getLive("n1")).toBe(conn);
    expect(conn.nodeId).toBe("n1");
    expect(conn.seq).toBe(0);
    expect(conn.pending.size).toBe(0);
    expect(listOnline()).toEqual(["n1"]);

    expect(detachConnection("n1", a)).toBe(true);
    expect(getLive("n1")).toBeUndefined();
    expect(listOnline()).toEqual([]);
  });

  it("getLive/detach on unknown ids and foreign sockets are no-ops", () => {
    expect(getLive("ghost")).toBeUndefined();
    expect(detachConnection("ghost", fakeSocket())).toBe(false);

    const a = fakeSocket();
    attachConnection("n1", a);
    expect(detachConnection("n1", fakeSocket())).toBe(false); // wrong socket — identity guard
    expect(getLive("n1")?.ws).toBe(a); // still there
  });

  it("newest-wins: replaces the old socket with a 4409 close and a fresh seq", () => {
    const old = fakeSocket();
    const first = attachConnection("n1", old);
    first.seq = 7; // simulate a lived-in connection

    const fresh = fakeSocket();
    const second = attachConnection("n1", fresh);

    expect(old.closed).toEqual([{ code: NODE_CLOSE_SUPERSEDED, reason: expect.any(String) }]);
    expect(first.closing).toBe(true); // so the old close handler skips registry teardown
    expect(getLive("n1")).toBe(second);
    expect(second.ws).toBe(fresh);
    expect(second.seq).toBe(0); // per-connection counter restarts (spec §4 tracker reset)
    expect(listOnline()).toEqual(["n1"]);
  });

  it("old socket's late close after a replace must NOT evict the new entry", () => {
    const old = fakeSocket();
    attachConnection("n1", old);
    const fresh = fakeSocket();
    attachConnection("n1", fresh);

    // The classic race: the OLD socket's close event fires after the new attach.
    expect(detachConnection("n1", old)).toBe(false);
    expect(getLive("n1")?.ws).toBe(fresh);
    expect(listOnline()).toEqual(["n1"]);
  });

  it("a throwing close on the stale socket never blocks the swap", () => {
    const bad: NodeSocket = {
      send: () => 0,
      close: () => {
        throw new Error("already dead");
      },
    };
    attachConnection("n1", bad);
    const fresh = fakeSocket();
    attachConnection("n1", fresh);
    expect(getLive("n1")?.ws).toBe(fresh);
  });

  it("re-attaching the SAME socket returns the existing record untouched", () => {
    const a = fakeSocket();
    const first = attachConnection("n1", a);
    first.seq = 9; // lived-in connection: the guard must not reset it

    const again = attachConnection("n1", a);

    expect(again).toBe(first); // identity, not a fresh record
    expect(again.seq).toBe(9);
    expect(a.closed).toHaveLength(0); // nothing was superseded/closed
    expect(getLive("n1")).toBe(first);
  });

  it("NODE_CLOSE_SUPERSEDED is 4409 (spec §5.3)", () => {
    expect(NODE_CLOSE_SUPERSEDED).toBe(4409);
  });

  // rotate-key / delete-node revoke the credential out from under a LIVE
  // socket (T8 carry): the registry side of that teardown.
  describe("disconnectNode", () => {
    it("unknown node → false, nothing to close", () => {
      expect(disconnectNode("ghost")).toBe(false);
    });

    it("closes with 4401 by default and evicts the entry (identity-guarded)", () => {
      const sock = fakeSocket();
      attachConnection("n1", sock);

      expect(disconnectNode("n1")).toBe(true);
      expect(sock.closed).toEqual([{ code: REVOKED_CLOSE_CODE, reason: expect.any(String) }]);
      expect(sock.closed[0]?.code).toBe(4401);
      expect(getLive("n1")).toBeUndefined();
      expect(listOnline()).toEqual([]);
    });

    it("honours a custom code/reason and flags the record closing (late close must not evict a re-attach)", () => {
      const sock = fakeSocket();
      const conn = attachConnection("n1", sock);

      disconnectNode("n1", 4410, "key rotated");
      expect(sock.closed).toEqual([{ code: 4410, reason: "key rotated" }]);
      expect(conn.closing).toBe(true);

      // The socket's (simulated) late close event now finds no entry — and a
      // re-attach followed by that stale detach is refused by the guard.
      const fresh = fakeSocket();
      attachConnection("n1", fresh);
      expect(detachConnection("n1", sock)).toBe(false);
      expect(getLive("n1")?.ws).toBe(fresh);
    });

    it("swallows a throwing close() and still evicts", () => {
      const bad: NodeSocket = {
        send: () => 0,
        close: () => {
          throw new Error("already dead");
        },
      };
      attachConnection("n1", bad);
      expect(disconnectNode("n1")).toBe(true);
      expect(getLive("n1")).toBeUndefined();
    });
  });
});
