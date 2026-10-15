import { afterEach, beforeEach, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import type { SshConnectionSnapshotWire, SshKeyBridgeCommand } from "@internal/subshell-protocol";
import type { NodeGate } from "@/api/nodes/node-gate.js";
import {
  closeLocalSshKey,
  exchangeLocalSshKey,
  openLocalSshKey,
  prepareLocalSshKey,
  setLocalSshKeyDepsForTests,
} from "../ssh-local-key.service.js";

const snapshot: SshConnectionSnapshotWire = {
  alias: "host",
  host: "host.example",
  user: "alice",
  port: 22,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: [],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
};
const pin = "host.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let now: number;
let allowed: boolean;
let sent: SshKeyBridgeCommand[];
let captures: number;
beforeEach(() => {
  now = 1000;
  allowed = true;
  sent = [];
  captures = 0;
  setLocalSshKeyDepsForTests({
    now: () => now,
    resolve: async () => ({ ok: true, value: { accepted: true, snapshot } }),
    gate: async () =>
      allowed
        ? { ok: true, value: {} as NodeGate }
        : { ok: false, refusal: { status: 403, code: BackendErrorCodes.SSH_GATE_OFF, message: "denied" } },
    pin: async () => null,
    hostKey: async () => ({ lines: [pin] }),
    capture: async (args) => {
      captures++;
      return {
        id: "pin",
        ownerUserId: args.ownerUserId,
        destination: args.destination,
        hostKey: pin,
        createdAt: "",
        updatedAt: "",
      };
    },
    rpc: async (_node, command) => {
      sent.push(command);
      return { done: command.op === "close", request: null };
    },
  });
});
afterEach(() => setLocalSshKeyDepsForTests(null));
async function prepare() {
  return prepareLocalSshKey("u1", "s1", "n1", "host");
}
async function open(id: string, overrides = {}) {
  return openLocalSshKey({
    id,
    viewerId: "u1",
    sessionId: "s1",
    nodeId: "n1",
    snapshot,
    paneId: crypto.randomUUID(),
    dataDir: "/tmp/node",
    ...overrides,
  });
}
it("binds one preparation to user, cookie session, node and exact resolved destination", async () => {
  const prepared = await prepare();
  expect(prepared.user).toBe("alice");
  expect(captures).toBe(0);
  for (const overrides of [
    { viewerId: "u2" },
    { sessionId: "s2" },
    { nodeId: "n2" },
    { snapshot: { ...snapshot, user: "root" } },
  ])
    await expect(open(prepared.id, overrides)).rejects.toThrow();
  expect(sent).toHaveLength(0);
  await open(prepared.id);
  expect(captures).toBe(1);
  expect(sent[0]?.op).toBe("open");
  await expect(open(prepared.id)).rejects.toThrow();
});
it("rechecks authorization before each exchange and tears down on revocation", async () => {
  const { id } = await prepare();
  await open(id);
  await expect(exchangeLocalSshKey(id, "u1", "s2")).rejects.toThrow();
  await exchangeLocalSshKey(id, "u1", "s1");
  expect(sent.at(-1)?.op).toBe("exchange");
  allowed = false;
  await expect(exchangeLocalSshKey(id, "u1", "s1")).rejects.toThrow();
  expect(sent.at(-1)?.op).toBe("close");
});
it("expires preparation and never lets another session close it", async () => {
  const { id } = await prepare();
  await closeLocalSshKey(id, { viewerId: "u1", sessionId: "s2" });
  now += 300001;
  await expect(open(id)).rejects.toThrow();
  expect(sent).toHaveLength(0);
});
it("limits pending preparations without retaining secrets", async () => {
  await prepare();
  await prepare();
  await prepare();
  await expect(prepare()).rejects.toThrow("Too many");
  expect(captures).toBe(0);
});
it("refuses concurrent opens before a second bridge can exist", async () => {
  const { id } = await prepare();
  const first = open(id);
  await expect(open(id)).rejects.toThrow();
  await first;
  expect(sent.filter((cmd) => cmd.op === "open")).toHaveLength(1);
});
