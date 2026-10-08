import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSH_RELAY_FRAME_MAX_BYTES } from "@internal/subshell-protocol";
import { liveAgentSocketPath, requestLiveAgent } from "../relay-agent-socket.js";

/**
 * The one-shot agent socket round trip the responder and the numbering probe
 * share: connect, write ONE framed message, read ONE framed answer, close.
 * These fixtures answer raw bytes, so the framing contract is pinned against
 * the real socket layer, not a mock.
 */

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function framed(payload: Buffer): Buffer {
  return Buffer.concat([be32(payload.length), payload]);
}

interface EchoServer {
  path: string;
  received: Buffer[];
  close(): Promise<void>;
}

/** A Unix socket that answers every complete framed request with `answerBytes`. */
async function startEchoAgent(onRequest: (request: Buffer, conn: Socket) => void): Promise<EchoServer> {
  const dir = mkdtempSync(join(tmpdir(), "subshell-agent-socket-"));
  const path = join(dir, "agent.sock");
  const received: Buffer[] = [];
  const server: Server = createServer((conn: Socket) => {
    let buffer = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) return;
      const request = Buffer.from(buffer.subarray(4, 4 + len));
      buffer = buffer.subarray(4 + len);
      received.push(request);
      onRequest(request, conn);
    });
    conn.on("error", () => {
      /* the client closes per request; never throw out of the socket layer */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(path);
  });
  return { path, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/* ---------------- liveAgentSocketPath (the ssh-resolve rule) ---------------- */

test("liveAgentSocketPath honors only an absolute SSH_AUTH_SOCK (the ssh-resolve rule)", () => {
  expect(liveAgentSocketPath({ SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock" })).toBe("/run/user/1000/ssh-agent.sock");
  expect(liveAgentSocketPath({})).toBeNull();
  expect(liveAgentSocketPath({ SSH_AUTH_SOCK: "" })).toBeNull();
  expect(liveAgentSocketPath({ SSH_AUTH_SOCK: "relative/path.sock" })).toBeNull();
});

/* ---------------- requestLiveAgent (the round trip) ---------------- */

test("requestLiveAgent writes exactly one framed request and resolves the framed answer", async () => {
  const server = await startEchoAgent((_request, conn) => {
    conn.write(framed(Buffer.from([12, 0, 0, 0, 0])));
  });
  try {
    const request = Buffer.from([11]);
    const answer = await requestLiveAgent(server.path, request);
    expect([...answer]).toEqual([12, 0, 0, 0, 0]);
    expect(server.received.length).toBe(1);
    expect(server.received[0]).toEqual(request); // one message, no framing residue, byte-exact
  } finally {
    await server.close();
  }
});

test("requestLiveAgent rejects an answer whose length header is empty or over the relay cap", async () => {
  const overCap = await startEchoAgent((_request, conn) => {
    conn.write(Buffer.concat([be32(SSH_RELAY_FRAME_MAX_BYTES + 1), Buffer.from([0])]));
  });
  const zeroLen = await startEchoAgent((_request, conn) => {
    conn.write(be32(0));
  });
  try {
    await expect(requestLiveAgent(overCap.path, Buffer.from([11]))).rejects.toThrow(/cap/);
    await expect(requestLiveAgent(zeroLen.path, Buffer.from([11]))).rejects.toThrow(/cap/);
  } finally {
    await overCap.close();
    await zeroLen.close();
  }
});

test("requestLiveAgent rejects when the agent closes before a complete answer", async () => {
  const server = await startEchoAgent((_request, conn) => {
    conn.write(Buffer.from([0, 0, 0, 5, 12])); // a header promising more than follows
    conn.end();
  });
  try {
    await expect(requestLiveAgent(server.path, Buffer.from([11]))).rejects.toThrow(/closed before/);
  } finally {
    await server.close();
  }
});

test("requestLiveAgent rejects on its local timeout when the agent never answers", async () => {
  const server = await startEchoAgent(() => {
    /* swallow: the agent thinks about it forever */
  });
  try {
    await expect(requestLiveAgent(server.path, Buffer.from([11]), 80)).rejects.toThrow(/timed out/);
  } finally {
    await server.close();
  }
});

test("requestLiveAgent rejects when nothing listens on the socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subshell-agent-socket-"));
  await expect(requestLiveAgent(join(dir, "nobody-home.sock"), Buffer.from([11]))).rejects.toThrow();
});
