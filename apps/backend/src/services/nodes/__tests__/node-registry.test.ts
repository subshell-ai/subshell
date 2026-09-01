import { beforeEach, describe, expect, it } from "bun:test";
import {
  attachConnection,
  detachConnection,
  getLive,
  listOnline,
  type NodeSocket,
  REPLACE_CLOSE_CODE,
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

    expect(old.closed).toEqual([{ code: REPLACE_CLOSE_CODE, reason: expect.any(String) }]);
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

  it("REPLACE_CLOSE_CODE is 4409 (spec §5.3)", () => {
    expect(REPLACE_CLOSE_CODE).toBe(4409);
  });
});
