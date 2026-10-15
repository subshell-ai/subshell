import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSshKeyBridges, machineSshKeyBridge } from "../key-bridge.js";
import { buildAgentSocketPath } from "../ssh-render.js";

const roots: string[] = [];
const sockets: Socket[] = [];
const pin = "example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  closeSshKeyBridges();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keybridge-")));
  roots.push(root);
  const id = crypto.randomUUID();
  await machineSshKeyBridge(root, { type: "ssh_key_bridge", op: "open", id, hostPin: pin });
  const path = buildAgentSocketPath(root, id);
  const socket = connect(path);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const exchange = (reply?: { seq: number; payload: string }) =>
    machineSshKeyBridge(root, { type: "ssh_key_bridge", op: "exchange", id, ...(reply ? { reply } : {}) });
  return { root, id, socket, path, exchange };
}
function frame(bytes: number[]) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, Buffer.from(bytes)]);
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

it("routes a fragmented agent request once and closes after delivering the signature", async () => {
  const { socket, exchange, path } = await fixture();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const request = frame([13, 1, 2, 3]);
  socket.write(request.subarray(0, 2));
  await tick();
  expect((await exchange()).request).toBeNull();
  socket.write(request.subarray(2));
  await tick();
  const pending = (await exchange()).request!;
  expect(pending.payload).toBe(Buffer.from([13, 1, 2, 3]).toString("base64"));
  expect((await exchange()).request).toEqual(pending);
  const received = new Promise<Buffer>((resolve) => socket.once("data", resolve));
  expect((await exchange({ seq: pending.seq, payload: Buffer.from([14, 8, 9]).toString("base64") })).done).toBe(true);
  expect(await received).toEqual(frame([14, 8, 9]));
  expect((await exchange()).done).toBe(true);
});
it("rejects mismatched sequence without sending a response", async () => {
  const { socket, exchange } = await fixture();
  socket.write(frame([11]));
  await tick();
  await expect(exchange({ seq: 99, payload: "Bg==" })).rejects.toThrow("out of sequence");
  expect((await exchange()).done).toBe(true);
});
it("passes host-binding extensions and only then permits the next request", async () => {
  const { socket, exchange } = await fixture();
  socket.write(frame([27, 1]));
  await tick();
  const pending = (await exchange()).request!;
  const response = new Promise<Buffer>((resolve) => socket.once("data", resolve));
  await exchange({ seq: pending.seq, payload: "Bg==" });
  expect(await response).toEqual(frame([6]));
  socket.write(frame([11]));
  await tick();
  expect((await exchange()).request?.seq).toBe(1);
});
it("closes on pipelining, oversized framing, and disallowed key-mutation methods", async () => {
  for (const payload of [Buffer.concat([frame([11]), frame([11])]), Buffer.from([0, 2, 0, 0]), frame([17])]) {
    const { socket, exchange } = await fixture();
    socket.write(payload);
    await tick();
    expect((await exchange()).done).toBe(true);
  }
});
it("rejects path traversal and invalid host pins before writing", async () => {
  const { root } = await fixture();
  await expect(
    machineSshKeyBridge(root, { type: "ssh_key_bridge", op: "open", id: "../outside", hostPin: pin }),
  ).rejects.toThrow();
  await expect(
    machineSshKeyBridge(root, { type: "ssh_key_bridge", op: "open", id: crypto.randomUUID(), hostPin: "bad\nHost *" }),
  ).rejects.toThrow();
});
