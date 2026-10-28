import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import { PREVIEW_LANE_BUFFER_MAX_BYTES } from "@internal/subshell-protocol";
import { storeCookiesInJar } from "@/api/previews/http.js";
import { LaneDuplex, type LaneEvent } from "@/modules/previews/lane-duplex.js";
import { sendLaneRequest } from "@/modules/previews/lane-http.js";
import { readLaneHead } from "@/modules/previews/lane-wire.js";
import { openLaneWebSocket } from "@/modules/previews/lane-ws-client.js";

function wire() {
  let sent = "";
  const duplex = new Duplex({
    read() {},
    write(bytes, _encoding, done) {
      sent += bytes.toString();
      done();
    },
  });
  return { duplex, request: () => sent };
}
async function response(transfer = "transfer-encoding: chunked") {
  const { duplex } = wire();
  let closed = 0;
  const answer = sendLaneRequest(duplex, { method: "GET", path: "/", headers: [], body: null }, false, () => {
    closed++;
    duplex.destroy();
  });
  duplex.push(Buffer.from(`HTTP/1.1 200 OK\r\n${transfer}\r\n\r\n`));
  const result = await answer;
  if (!result.body) throw new Error("Missing body");
  return { duplex, body: result.body, closed: () => closed };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("preview response memory and framing", () => {
  it("keeps packets arriving between the head and body readers", async () => {
    const { duplex } = wire();
    const answer = sendLaneRequest(duplex, { method: "GET", path: "/", headers: [], body: null }, false, () =>
      duplex.destroy(),
    );
    duplex.push(Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\na"));
    duplex.push(Buffer.from("bc"));
    duplex.push(Buffer.from("def"));
    duplex.push(null);
    const result = await answer;
    expect(await new Response(result.body).text()).toBe("abcdef");
  });

  it("counts only headers toward the head limit and handles coalesced informational responses", async () => {
    const { duplex } = wire();
    const answer = readLaneHead(duplex);
    const body = Buffer.alloc(128 * 1024, 120);
    duplex.push(
      Buffer.concat([
        Buffer.from("HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 131072\r\n\r\n"),
        body,
      ]),
    );
    const head = await answer;
    expect(head.statusLine).toBe("HTTP/1.1 200 OK");
    expect(head.tail.equals(body)).toBe(true);
    duplex.destroy();
  });

  it("streams a large declared chunk before the whole chunk arrives", async () => {
    const r = await response();
    const reader = r.body.getReader();
    r.duplex.push(Buffer.from("10000000\r\nfirst bytes"));
    const part = await reader.read();
    expect(Buffer.from(part.value ?? []).toString()).toBe("first bytes");
    await reader.cancel();
    expect(r.closed()).toBe(1);
  });
  for (const fragment of ["-1\r\n", "10junk\r\n", "f".repeat(8193), "2\r\nokNO"]) {
    it(`refuses malformed chunk framing ${fragment.slice(0, 20)}`, async () => {
      const r = await response();
      const outcome = new Response(r.body).text().then(
        () => "accepted",
        () => "rejected",
      );
      r.duplex.push(Buffer.from(fragment));
      expect(await outcome).toBe("rejected");
      expect(r.closed()).toBe(1);
    });
  }
  it("closes a slow HTTP reader at the byte budget", async () => {
    const r = await response("content-length: 9999999");
    for (let i = 0; i < 5; i++) r.duplex.push(Buffer.alloc(PREVIEW_LANE_BUFFER_MAX_BYTES / 4));
    await tick();
    expect(r.closed()).toBe(1);
    await expect(new Response(r.body).arrayBuffer()).rejects.toThrow("buffer limit");
  });
  it("rejects a truncated length-delimited response", async () => {
    const r = await response("content-length: 100");
    const outcome = new Response(r.body).text().then(
      () => "accepted",
      () => "rejected",
    );
    r.duplex.push(Buffer.from("short"));
    r.duplex.destroy();
    expect(await outcome).toBe("rejected");
  });
  it("caps unread lane bytes before a consumer starts", async () => {
    let deliver: (event: LaneEvent) => void = () => {};
    let unsubscribed = false;
    const duplex = new LaneDuplex({
      writeOut() {},
      onLane(cb) {
        deliver = cb;
        return () => {
          unsubscribed = true;
        };
      },
    });
    for (let i = 0; i < 5; i++) deliver({ bytes: Buffer.alloc(PREVIEW_LANE_BUFFER_MAX_BYTES / 4) });
    expect(duplex.destroyed).toBe(true);
    expect(duplex.closedReason).toBe("slow-link");
    expect(unsubscribed).toBe(true);
  });
  it("bounds target-controlled cookie count and bytes across many responses", () => {
    const jar = new Map<string, string>();
    for (let i = 0; i < 300; i++) storeCookiesInJar(jar, [`cookie${i}=${"x".repeat(2000)}`]);
    expect(jar.size).toBeLessThanOrEqual(128);
    expect([...jar.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0)).toBeLessThanOrEqual(64 * 1024);
    expect(jar.has("cookie299")).toBe(true);
    expect(jar.has("cookie0")).toBe(false);
  });
  it("rejects a WebSocket message exceeding the limit across fragments", async () => {
    const { duplex, request } = wire();
    let deaths = 0;
    const opening = openLaneWebSocket(duplex, {
      port: 3000,
      path: "/socket",
      headers: [],
      onOpen() {},
      onMessage() {
        throw new Error("oversized message delivered");
      },
      onCookies() {},
      onDeath() {
        deaths++;
        duplex.destroy();
      },
    });
    const key = /sec-websocket-key: ([^\r]+)/.exec(request())?.[1];
    if (!key) throw new Error("Missing WS key");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    duplex.push(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nsec-websocket-accept: ${accept}\r\n\r\n`));
    await opening;
    const size = PREVIEW_LANE_BUFFER_MAX_BYTES / 2;
    for (let i = 0; i < 3; i++) {
      const header = Buffer.alloc(10);
      header[0] = i === 0 ? 2 : 0; // non-final binary, then continuation frames
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(size), 2);
      duplex.push(header);
      if (i < 2) duplex.push(Buffer.alloc(size));
    }
    await tick();
    expect(deaths).toBeGreaterThan(0);
  });
});
