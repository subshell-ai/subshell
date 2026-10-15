import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  parseSshNodeCommandBody,
  SSH_LOCAL_KEY_MAX_BYTES,
  SSH_LOCAL_KEY_TTL_MS,
  type SshKeyBridgeCommand,
  type SshKeyBridgeResult,
} from "@internal/subshell-protocol";
import { pathAllowed, realpathRoots } from "./relay/path-policy.js";
import { buildAgentSocketPath, buildSshKnownHostsPath } from "./ssh-render.js";

interface Bridge {
  key: string;
  server: Server;
  socket?: Socket;
  buffer: Buffer;
  request: SshKeyBridgeResult["request"];
  seq: number;
  done: boolean;
  timer: ReturnType<typeof setTimeout>;
  socketPath: string;
}
const bridges = new Map<string, Bridge>();
const opening = new Set<string>();
const keyFor = (dataDir: string, id: string) => `${dataDir}\0${id}`;

function end(bridge: Bridge, graceful = false): void {
  if (bridge.done) return;
  bridge.done = true;
  bridges.delete(bridge.key);
  bridge.request = null;
  bridge.buffer = Buffer.alloc(0);
  clearTimeout(bridge.timer);
  if (graceful) bridge.socket?.end();
  else bridge.socket?.destroy();
  bridge.server.close();
  void rm(bridge.socketPath, { force: true }).catch(() => {});
}

/** A bounded, single-connection agent socket. The native signer alone authorizes signatures. */
export async function machineSshKeyBridge(dataDir: string, input: SshKeyBridgeCommand): Promise<SshKeyBridgeResult> {
  const cmd = parseSshNodeCommandBody(input);
  if (cmd?.type !== "ssh_key_bridge") throw new Error("Invalid SSH signing request.");
  const key = keyFor(dataDir, cmd.id);
  const existing = bridges.get(key);
  if (cmd.op === "close") {
    if (existing) end(existing);
    bridges.delete(key);
    return { done: true, request: null };
  }
  if (cmd.op === "exchange") {
    if (!existing || existing.done) return { done: true, request: null };
    if (cmd.reply) {
      if (!existing.request || existing.request.seq !== cmd.reply.seq) {
        end(existing);
        throw new Error("SSH signing reply is out of sequence.");
      }
      const reply = Buffer.from(cmd.reply.payload, "base64");
      const requestType = Buffer.from(existing.request.payload, "base64")[0];
      existing.request = null;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(reply.length);
      existing.socket?.write(Buffer.concat([length, reply]));
      // A signature is useful only for its bound SSH exchange. Close access
      // after delivering it; never leave the signer available to the shell.
      if (requestType === 13 || reply[0] === 5) end(existing, true);
    }
    return { done: existing.done, request: existing.request };
  }
  if (existing || opening.has(key)) throw new Error("SSH signing bridge already exists.");
  if (bridges.size + opening.size >= 64) throw new Error("Too many SSH signing requests are active.");
  opening.add(key);
  const socketPath = buildAgentSocketPath(dataDir, cmd.id);
  const dir = dirname(socketPath);
  let bridge: Bridge | undefined;
  try {
    if (!(await pathAllowed(dir, await realpathRoots([dataDir])))) throw new Error("SSH signing directory refused.");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const pinPath = buildSshKnownHostsPath(dataDir, cmd.id);
    await writeFile(pinPath, cmd.hostPin, { mode: 0o600, flag: "wx" });
    const server = createServer((socket) => {
      if (!bridge || bridge.done || bridge.socket) {
        socket.destroy();
        return;
      }
      const state = bridge;
      state.socket = socket;
      socket.on("error", () => end(state));
      socket.on("close", () => end(state));
      socket.on("data", (chunk: Buffer) => {
        if (state.done) return;
        if (state.request || state.buffer.length + chunk.length > SSH_LOCAL_KEY_MAX_BYTES + 4) {
          end(state);
          return;
        }
        state.buffer = Buffer.concat([state.buffer, chunk]);
        if (state.buffer.length < 4) return;
        const length = state.buffer.readUInt32BE(0);
        if (!length || length > SSH_LOCAL_KEY_MAX_BYTES || state.buffer.length > length + 4) {
          end(state);
          return;
        }
        if (state.buffer.length < length + 4) return;
        const payload = state.buffer.subarray(4);
        if (![11, 13, 27].includes(payload[0]) || state.seq >= 8) {
          end(state);
          return;
        }
        state.request = { seq: state.seq++, payload: payload.toString("base64") };
        state.buffer = Buffer.alloc(0);
      });
    });
    bridge = {
      key,
      server,
      buffer: Buffer.alloc(0),
      request: null,
      seq: 0,
      done: false,
      socketPath,
      timer: setTimeout(() => {
        if (bridge) end(bridge);
        bridges.delete(key);
      }, SSH_LOCAL_KEY_TTL_MS),
    };
    bridge.timer.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    bridges.set(key, bridge);
    return { done: false, request: null };
  } catch (error) {
    if (bridge) end(bridge);
    throw error;
  } finally {
    opening.delete(key);
  }
}

/** Close every ephemeral bridge owned by this runtime during teardown. */
export function closeSshKeyBridges(dataDir?: string): void {
  for (const [key, bridge] of bridges) {
    if (dataDir !== undefined && !key.startsWith(`${dataDir}\0`)) continue;
    end(bridge);
    bridges.delete(key);
  }
}
