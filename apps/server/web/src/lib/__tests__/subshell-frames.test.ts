import { describe, expect, it } from "bun:test";
import { encodeFrame } from "@internal/subshell-protocol/wire";
import { markCborSocket, sendInput, sendResize } from "@/lib/subshell-frames";

/**
 * The page's one client-frame send boundary, in both wire modes (spec
 * 2026-09-21 Wave B). The mark is PER SOCKET: negotiation is a property of
 * the connection, so a socket that never negotiated keeps the exact JSON
 * string it always sent: the fallback an older server answers.
 */

class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  readonly sent: Array<string | Uint8Array> = [];
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
}

describe("subshell-frames send encoding", () => {
  it("an unmarked socket sends the exact JSON string it always did", () => {
    const ws = new FakeSocket();
    sendInput(ws as unknown as WebSocket, "ls\r");
    expect(ws.sent).toEqual([JSON.stringify({ type: "input", data: "ls\r" })]);
  });

  it("a marked socket sends CBOR bytes that decode to the frame", () => {
    const ws = new FakeSocket();
    markCborSocket(ws as unknown as WebSocket);
    sendInput(ws as unknown as WebSocket, "ls\r", 4);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    expect(ws.sent[0]).toEqual(encodeFrame({ type: "input", data: "ls\r", id: 4 }));
  });

  it("the mark does not leak between sockets", () => {
    const marked = new FakeSocket();
    const plain = new FakeSocket();
    markCborSocket(marked as unknown as WebSocket);
    sendResize(plain as unknown as WebSocket, 80, 24);
    expect(plain.sent).toEqual([JSON.stringify({ type: "resize", cols: 80, rows: 24 })]);
  });

  it("a closed socket sends nothing, in either mode", () => {
    const ws = new FakeSocket();
    ws.readyState = 3;
    sendInput(ws as unknown as WebSocket, "x");
    markCborSocket(ws as unknown as WebSocket);
    sendInput(ws as unknown as WebSocket, "x");
    expect(ws.sent).toEqual([]);
  });
});
