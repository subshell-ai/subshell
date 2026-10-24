import { describe, expect, it } from "bun:test";
import type { RelayFrame } from "@internal/subshell-protocol";
import { NODE_MAX_FRAME_BYTES } from "@internal/subshell-protocol";
import { createDaemonRelaySend, type RelaySendState } from "../relay-send.js";

/**
 * The daemon's per-socket relay pump (Task 8 acceptance (c), the node-side
 * half of the deliver-or-throw contract): the frame that leaves this function
 * either hit the CURRENT socket through the ESTABLISHED link or the call
 * THREW. The proxy and the responder both act on the throw (fail the request,
 * consume no seq) - a silent return is what parked phantom replies in the
 * T6 review, so every drop branch here is a named raise.
 */

const frame: RelayFrame = { type: "relay", ref: "r-1", seq: 0, direction: "B2A", blob: "QUJD" };

/** A negotiator-shaped fake link; `up: false` mirrors the not-yet-established window. */
function fakeLink(up = true): RelaySendState["link"] {
  return {
    established: () => up,
    session: () => (up ? { sealFrame: (text: string) => new TextEncoder().encode(`SEALED:${text}`) } : undefined),
  };
}

describe("createDaemonRelaySend", () => {
  it("refuses preview bytes before sealing when the transport queue is full", () => {
    let sealed = 0;
    let sent = 0;
    const send = createDaemonRelaySend(() => ({
      ws: {
        bufferedAmount: 1_048_576,
        readyState: 1,
        send: () => {
          sent++;
        },
      },
      link: {
        established: () => true,
        session: () => ({
          sealFrame: () => {
            sealed++;
            return new Uint8Array();
          },
        }),
      },
    }));
    expect(() => send({ type: "preview_data", ref: "a".repeat(32), dir: "out", blob: "QUJD" })).toThrow(
      /buffer budget/,
    );
    expect(sealed).toBe(0);
    expect(sent).toBe(0);
  });
  it("seals the JSON frame and writes a Buffer onto the live link", () => {
    const sealed: (string | Buffer)[] = [];
    const relaySend = createDaemonRelaySend(() => ({
      ws: { send: (d: string | Buffer) => sealed.push(d) },
      link: fakeLink(),
    }));
    relaySend(frame);
    expect(sealed).toHaveLength(1);
    const payload = sealed[0];
    expect(Buffer.isBuffer(payload)).toBe(true); // never a bare Uint8Array (the Bun framing fact)
    expect((payload as Buffer).toString("utf8")).toBe(`SEALED:${JSON.stringify(frame)}`);
  });

  it("THROWS when there is no socket (between connections), when the link is down, and when the write fails", () => {
    // Between connections: the plane re-pumps on the fresh socket, but THIS
    // caller must know its frame did not leave.
    const noWs = createDaemonRelaySend(() => ({ ws: undefined, link: undefined }));
    expect(() => noWs(frame)).toThrow(/no live socket/);
    // The open→established window (or after the close): a protocol-18 socket
    // has no plaintext path, so a relay frame simply cannot leave.
    const noLink = createDaemonRelaySend(() => ({ ws: { send: () => {} }, link: fakeLink(false) }));
    expect(() => noLink(frame)).toThrow(/link/);
    const noLinkAtAll = createDaemonRelaySend(() => ({ ws: { send: () => {} }, link: undefined }));
    expect(() => noLinkAtAll(frame)).toThrow(/link/);
    // A throwing write propagates as the named refusal, never silence.
    const thrower = createDaemonRelaySend(() => ({
      ws: {
        send: () => {
          throw new Error("socket write failed");
        },
      },
      link: fakeLink(),
    }));
    expect(() => thrower(frame)).toThrow(/socket write failed/);
  });

  it("refuses an oversize frame before touching the socket (the cap is law both directions)", () => {
    const sealed: (string | Buffer)[] = [];
    const giant = createDaemonRelaySend(() => ({
      ws: { send: (d: string | Buffer) => sealed.push(d) },
      link: {
        established: () => true,
        session: () => ({ sealFrame: (t: string) => new TextEncoder().encode(t) }),
      },
    }));
    expect(() => giant({ ...frame, blob: "A".repeat(NODE_MAX_FRAME_BYTES) })).toThrow(/exceeds/);
    expect(sealed).toHaveLength(0); // no seal, no ratchet step spent on a doomed frame
  });
});

it("closes the preview transport when writing a sealed frame throws", () => {
  let closed = false;
  const send = createDaemonRelaySend(() => ({
    ws: {
      send: () => {
        throw new Error("write failed");
      },
      close: () => {
        closed = true;
      },
    },
    link: { established: () => true, session: () => ({ sealFrame: () => new Uint8Array([1]) }) },
  }));
  expect(() => send({ type: "preview_closed", ref: "a".repeat(32), reason: "idle" })).toThrow("write failed");
  expect(closed).toBe(true);
});
