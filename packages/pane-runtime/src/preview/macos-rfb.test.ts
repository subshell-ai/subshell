import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperStatus } from "./macos-helper.js";
import { MacOSRfb, tightFrame } from "./macos-rfb.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
async function fakeHelper() {
  const directory = mkdtempSync(join(tmpdir(), "sh-helper-"));
  const path = join(directory, "control.sock");
  const requests: Record<string, unknown>[] = [];
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        requests.push(request);
        if (request.op === "status")
          socket.write(
            `${JSON.stringify({
              type: "status",
              protocol: 1,
              enabled: false,
              screenRecording: false,
              accessibility: false,
              betterDisplayExecutable: null,
            })}\n`,
          );
        if (request.op === "start") socket.write(`${JSON.stringify({ type: "started", width: 1280, height: 800 })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => {
    for (const client of clients) client.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, clients, requests };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

test("status probes never send enable or permission requests", async () => {
  const f = await fakeHelper();
  expect((await helperStatus(f.path))?.enabled).toBe(false);
  expect(f.requests).toEqual([{ op: "status" }]);
});
test("Tight JPEG lengths and dimensions are bounded", () => {
  const jpeg = Buffer.alloc(20000);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  const frame = tightFrame(jpeg, 1280, 800);
  expect(frame.readUInt16BE(2)).toBe(1);
  expect(frame.readInt32BE(12)).toBe(7);
  expect(frame[16]).toBe(0x90);
  expect((frame[17] & 127) | ((frame[18] & 127) << 7) | (frame[19] << 14)).toBe(jpeg.length);
  expect(() => tightFrame(jpeg, 5000, 800)).toThrow();
  expect(() => tightFrame(Buffer.alloc(4), 1280, 800)).toThrow();
});
test("RFB forwards bounded input and helper loss closes viewers", async () => {
  const f = await fakeHelper();
  const bridge = new MacOSRfb(1280, 800, { uuid: "test", name: "test" }, f.path);
  cleanup.push(() => bridge.stop());
  await bridge.start();
  const viewer = connect(bridge.port, "127.0.0.1");
  cleanup.push(() => viewer.destroy());
  let bytes = Buffer.alloc(0);
  viewer.on("data", (data: Buffer) => {
    bytes = Buffer.concat([bytes, data]);
  });
  await waitFor(() => bytes.length >= 12);
  expect(bytes.toString()).toBe("RFB 003.008\n");
  bytes = Buffer.alloc(0);
  viewer.write("RFB 003.008\n");
  await waitFor(() => bytes.length >= 2);
  bytes = Buffer.alloc(0);
  viewer.write(Buffer.from([1]));
  await waitFor(() => bytes.length >= 4);
  bytes = Buffer.alloc(0);
  viewer.write(Buffer.from([1]));
  await waitFor(() => bytes.length >= 24);
  expect(bytes.readUInt16BE(0)).toBe(1280);
  bytes = Buffer.alloc(0);
  viewer.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 7]));
  viewer.write(Buffer.from([5, 1, 0, 10, 0, 20]));
  await waitFor(() => f.requests.some((r) => r.op === "pointer"));
  expect(f.requests.find((r) => r.op === "pointer")).toEqual({ op: "pointer", mask: 1, x: 10, y: 20 });
  for (const client of f.clients) client.destroy();
  await waitFor(() => viewer.destroyed);
});

async function readyViewer(bridge: MacOSRfb) {
  const socket = connect(bridge.port, "127.0.0.1");
  cleanup.push(() => socket.destroy());
  socket.on("error", () => {});
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
  });
  await waitFor(() => bytes.length >= 12);
  // Coalesced handshake messages exercise the stream parser, not packet boundaries.
  socket.write(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]));
  await waitFor(() => bytes.length >= 12 + 2 + 4 + 24);
  return socket;
}

for (const [name, packet] of [
  ["unknown message type", Buffer.from([255])],
  ["too many encodings", Buffer.from([2, 0, 1, 1])],
  ["unsupported encoding", Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])],
  ["oversized clipboard", Buffer.from([6, 0, 0, 0, 0, 1, 0, 1])],
  ["invalid key state", Buffer.from([4, 2, 0, 0, 0, 0, 0, 97])],
  ["out-of-bounds pointer", Buffer.from([5, 1, 5, 0, 0, 20])],
  ["invalid pointer mask", Buffer.from([5, 128, 0, 10, 0, 20])],
] as const) {
  test(`RFB refuses ${name} without forwarding input or dropping other viewers`, async () => {
    const f = await fakeHelper();
    const bridge = new MacOSRfb(1280, 800, { uuid: "test", name: "test" }, f.path);
    cleanup.push(() => bridge.stop());
    await bridge.start();
    const passive = await readyViewer(bridge);
    const invalid = await readyViewer(bridge);
    invalid.write(packet);
    await waitFor(() => invalid.destroyed);
    expect(passive.destroyed).toBe(false);
    expect(f.requests.map((request) => request.op)).toEqual(["start"]);
  });
}

test("RFB rejects pre-handshake input and excess viewers", async () => {
  const f = await fakeHelper();
  const bridge = new MacOSRfb(1280, 800, { uuid: "test", name: "test" }, f.path);
  cleanup.push(() => bridge.stop());
  await bridge.start();
  const bad = connect(bridge.port, "127.0.0.1");
  cleanup.push(() => bad.destroy());
  bad.on("error", () => {});
  bad.resume();
  bad.write(Buffer.alloc(12, 5));
  await waitFor(() => bad.destroyed);
  for (let i = 0; i < 8; i++) await readyViewer(bridge);
  const excess = connect(bridge.port, "127.0.0.1");
  cleanup.push(() => excess.destroy());
  excess.on("error", () => {});
  excess.resume();
  await waitFor(() => excess.destroyed);
  expect(f.requests.map((request) => request.op)).toEqual(["start"]);
});

test("only the controlling viewer releases held input on disconnect", async () => {
  const f = await fakeHelper();
  const bridge = new MacOSRfb(1280, 800, { uuid: "test", name: "test" }, f.path);
  cleanup.push(() => bridge.stop());
  await bridge.start();
  const controller = await readyViewer(bridge);
  const passive = await readyViewer(bridge);
  controller.write(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]));
  await waitFor(() => f.requests.some((request) => request.op === "key"));
  const releases = () => f.requests.filter((request) => request.op === "release").length;
  expect(releases()).toBe(1);
  passive.destroy();
  // A second input establishes that the bridge has processed the passive EOF.
  controller.write(Buffer.from([4, 0, 0, 0, 0, 0, 0, 97]));
  await waitFor(() => f.requests.filter((request) => request.op === "key").length === 2);
  expect(releases()).toBe(1);
  controller.destroy();
  await waitFor(() => releases() === 2);
});

test("accepts noVNC's pixel format and rejects unsupported reduced-depth formats", async () => {
  const f = await fakeHelper();
  const bridge = new MacOSRfb(1280, 800, { uuid: "test", name: "test" }, f.path);
  cleanup.push(() => bridge.stop());
  await bridge.start();
  const viewer = await readyViewer(bridge);
  const format = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
  viewer.write(Buffer.concat([format, Buffer.from([4, 1, 0, 0, 0, 0, 0, 97])]));
  await waitFor(() => f.requests.some((r) => r.op === "key"));
  expect(viewer.destroyed).toBe(false);
  format[4] = 16;
  format[5] = 16;
  viewer.write(format);
  await waitFor(() => viewer.destroyed);
});
