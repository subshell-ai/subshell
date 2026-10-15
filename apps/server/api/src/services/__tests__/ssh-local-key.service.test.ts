import { afterEach, beforeEach, expect, it } from "bun:test";
import { ApiError, BackendErrorCodes } from "@internal/backend-errors";
import type {
  NodeSshResolveOutcomeWire,
  SshConnectionSnapshotWire,
  SshKeyBridgeCommand,
} from "@internal/subshell-protocol";
import type { NodeGate } from "@/api/nodes/node-gate.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import type { SshAnswer } from "../ssh-launch.service.js";
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
const fakeDeps = {
  now: () => now,
  resolve: async (): Promise<SshAnswer<NodeSshResolveOutcomeWire>> => ({
    ok: true,
    value: { accepted: true, snapshot } as NodeSshResolveOutcomeWire,
  }),
  gate: async (): Promise<SshAnswer<NodeGate>> =>
    allowed
      ? { ok: true, value: {} as NodeGate }
      : { ok: false, refusal: { status: 403, code: BackendErrorCodes.SSH_GATE_OFF, message: "denied" } },
  pin: async () => null,
  hostKey: async () => ({ lines: [pin] }),
  capture: async (args: { ownerUserId: string; destination: string }) => {
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
  rpc: async (_node: string, command: SshKeyBridgeCommand) => {
    sent.push(command);
    return { done: command.op === "close", request: null };
  },
};
beforeEach(() => {
  now = 1000;
  allowed = true;
  sent = [];
  captures = 0;
  setLocalSshKeyDepsForTests(fakeDeps);
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
it("maps a dropped node to the ssh family's offline refusal instead of a bare 500", async () => {
  let offlineOnOpen = false;
  setLocalSshKeyDepsForTests({
    ...fakeDeps,
    rpc: async (_node: string, command: SshKeyBridgeCommand) => {
      sent.push(command);
      if (command.op === "open" && offlineOnOpen) throw new NodeRpcError("offline", 'node "n1" is offline', "n1");
      return { done: command.op === "close", request: null };
    },
  });
  const prepared = await prepare();
  offlineOnOpen = true;
  let thrown: unknown;
  try {
    await open(prepared.id);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).code).toBe(BackendErrorCodes.NODE_OFFLINE);
  // The refusal is also a teardown: the preparation is gone, so a retry of the
  // SAME id hears the ended-request code, not a path back to the offline node.
  let retry: unknown;
  try {
    await open(prepared.id);
  } catch (error) {
    retry = error;
  }
  expect((retry as ApiError).code).toBe(BackendErrorCodes.SSH_RELAY_OPEN_FAILED);
});
it("maps a stale-sequence bridge refusal to the ended-request code, not a 500", async () => {
  let stale = false;
  setLocalSshKeyDepsForTests({
    ...fakeDeps,
    rpc: async (_node: string, command: SshKeyBridgeCommand) => {
      sent.push(command);
      if (command.op === "exchange" && stale) throw new Error("SSH signing reply is out of sequence.");
      return { done: command.op === "close", request: null };
    },
  });
  const prepared = await prepare();
  await open(prepared.id);
  stale = true;
  let thrown: unknown;
  try {
    await exchangeLocalSshKey(prepared.id, "u1", "s1");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).code).toBe(BackendErrorCodes.SSH_RELAY_OPEN_FAILED);
});

it.each([{ host: "changed.test" }, { user: "root" }, { port: 2222 }])(
  "blocks preset redirection before host discovery or retaining a preparation: %j",
  async (change) => {
    let discoveries = 0;
    setLocalSshKeyDepsForTests({
      ...fakeDeps,
      resolve: async () => ({ ok: true, value: { accepted: true, snapshot: { ...snapshot, ...change } } }),
      hostKey: async () => {
        discoveries++;
        return { lines: [pin] };
      },
    });
    await expect(prepareLocalSshKey("u1", "s1", "n1", "host", "alice@host.example:22")).rejects.toThrow(
      "different destination",
    );
    expect(discoveries).toBe(0);
    expect(captures).toBe(0);
    expect(sent).toHaveLength(0);
  },
);
