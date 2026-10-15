import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { buildAgentSocketPath, machineSshKeyBridge } from "@internal/pane-runtime";
import {
  isSshLocalKeyHostPin,
  parseSshKeyBridgeResult,
  SSH_LOCAL_KEY_TTL_MS,
  type SshConnectionSnapshotWire,
  type SshKeyBridgeCommand,
} from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { sshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { sshHostKey } from "@/services/nodes/ssh-rpc.js";
import { captureHostPin, hostKeyFingerprints, hostPinFor } from "@/services/ssh-host-pins.service.js";
import { relaySnapshotRefusal, sshResolveDestination } from "@/services/ssh-launch.service.js";
import { gateSshNode } from "@/services/ssh-policy.service.js";

interface LocalKeySession {
  viewerId: string;
  sessionId: string;
  nodeId: string;
  snapshot: SshConnectionSnapshotWire;
  hostPin: string;
  expires: number;
  paneId?: string;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, LocalKeySession>();
const defaults = {
  gate: gateSshNode,
  resolve: sshResolveDestination,
  hostKey: sshHostKey,
  pin: hostPinFor,
  capture: captureHostPin,
  now: Date.now,
  rpc,
};
let deps = defaults;

function fail(message = "This temporary SSH key request has ended. Choose your key again."): never {
  throwApiError({ code: BackendErrorCodes.SSH_RELAY_OPEN_FAILED, message, doNotLog: true });
}
async function rpc(nodeId: string, command: SshKeyBridgeCommand) {
  const answer =
    nodeId === "local"
      ? await machineSshKeyBridge(SUBSHELL_SERVER_DATA_DIR, command)
      : await sendCommand(nodeId, command);
  const parsed = parseSshKeyBridgeResult(answer);
  if (!parsed) fail("The connecting node returned an invalid signing response. Update it and try again.");
  return parsed;
}
function get(id: string, viewerId: string, sessionId: string) {
  const entry = sessions.get(id);
  if (!entry || entry.viewerId !== viewerId || entry.sessionId !== sessionId || entry.expires <= deps.now()) fail();
  return entry;
}
async function gate(entry: LocalKeySession) {
  const result = await deps.gate(entry.viewerId, entry.nodeId);
  if (!result.ok) fail("SSH access to the connecting node is no longer available. Check its settings and try again.");
}

/** Resolve and capture public destination identity before the native approval and file picker. */
export async function prepareLocalSshKey(viewerId: string, sessionId: string, nodeId: string, destination: string) {
  if (sessions.size >= 256 || [...sessions.values()].filter((entry) => entry.viewerId === viewerId).length >= 3)
    fail("Too many key selections are waiting. Close one or wait for it to expire.");
  const answer = await deps.resolve(viewerId, nodeId, destination);
  if (!answer.ok || !answer.value.accepted)
    fail("The destination could not be resolved. Check the connecting node and SSH destination.");
  const snapshot = answer.value.snapshot;
  if (relaySnapshotRefusal(snapshot) || !snapshot.user)
    fail("A key from your machine needs a destination with an explicit username and no jump hosts or host-key alias.");
  const canonical = sshCanonicalDestination(snapshot);
  const saved = await deps.pin({ ownerUserId: viewerId, destination: canonical });
  const lines = saved
    ? [saved.hostKey]
    : (await deps.hostKey(nodeId, { host: snapshot.host, port: snapshot.port, user: snapshot.user, scan: true })).lines;
  const hostPin =
    lines.find((line) => isSshLocalKeyHostPin(line) && line.split(/\s+/)[1] === "ssh-ed25519") ??
    lines.find((line) => isSshLocalKeyHostPin(line) && hostKeyFingerprints(line).length === 1);
  if (!hostPin || hostPin.startsWith("@"))
    fail("The destination did not provide a supported host key. Ask its administrator to check SSH.");
  const hostKey = hostPin.split(/\s+/)[2];
  if (!hostKey) fail();
  // Recheck the bounded census after network awaits, before retaining anything.
  if (sessions.size >= 256 || [...sessions.values()].filter((entry) => entry.viewerId === viewerId).length >= 3) fail();
  const id = crypto.randomUUID();
  const timer = setTimeout(() => void closeLocalSshKey(id), 5 * 60_000);
  timer.unref();
  sessions.set(id, {
    viewerId,
    sessionId,
    nodeId,
    snapshot,
    hostPin,
    expires: deps.now() + 5 * 60_000,
    busy: false,
    timer,
  });
  return { id, host: snapshot.host, port: snapshot.port, user: snapshot.user, hostKey };
}

/** Consume an approved preparation once, binding it to exactly this pane and resolved destination. */
export async function openLocalSshKey(args: {
  id: string;
  viewerId: string;
  sessionId: string;
  nodeId: string;
  snapshot: SshConnectionSnapshotWire;
  paneId: string;
  dataDir: string;
}) {
  const entry = get(args.id, args.viewerId, args.sessionId);
  if (
    entry.paneId ||
    entry.busy ||
    entry.nodeId !== args.nodeId ||
    JSON.stringify(entry.snapshot) !== JSON.stringify(args.snapshot)
  )
    fail();
  entry.busy = true;
  entry.paneId = args.paneId;
  clearTimeout(entry.timer);
  entry.expires = deps.now() + SSH_LOCAL_KEY_TTL_MS;
  entry.timer = setTimeout(() => void closeLocalSshKey(args.id), SSH_LOCAL_KEY_TTL_MS);
  entry.timer.unref();
  try {
    await gate(entry);
    await deps.capture({
      ownerUserId: args.viewerId,
      aNodeId: null,
      destination: sshCanonicalDestination(entry.snapshot),
      hostKeyLine: entry.hostPin,
    });
    await deps.rpc(entry.nodeId, { type: "ssh_key_bridge", op: "open", id: args.paneId, hostPin: entry.hostPin });
    if (sessions.get(args.id) !== entry) {
      await deps.rpc(entry.nodeId, { type: "ssh_key_bridge", op: "close", id: args.paneId });
      fail();
    }
    await gate(entry);
    return { socketPath: buildAgentSocketPath(args.dataDir, args.paneId) };
  } catch (error) {
    await closeLocalSshKey(args.id);
    throw error;
  } finally {
    entry.busy = false;
  }
}

/** Session-cookie ownership and current launch access are checked on every public agent exchange. */
export async function exchangeLocalSshKey(
  id: string,
  viewerId: string,
  sessionId: string,
  reply?: { seq: number; payload: string },
) {
  const entry = get(id, viewerId, sessionId);
  if (!entry.paneId || entry.busy) fail();
  entry.busy = true;
  try {
    await gate(entry);
    const result = await deps.rpc(entry.nodeId, {
      type: "ssh_key_bridge",
      op: "exchange",
      id: entry.paneId,
      ...(reply ? { reply } : {}),
    });
    if (sessions.get(id) !== entry) fail();
    if (result.done) await closeLocalSshKey(id);
    return result;
  } catch (error) {
    await closeLocalSshKey(id);
    throw error;
  } finally {
    entry.busy = false;
  }
}

/** Forget routing state first, then best-effort teardown. No credential is retained here. */
export async function closeLocalSshKey(id: string, owner?: { viewerId: string; sessionId: string }): Promise<void> {
  const entry = sessions.get(id);
  if (!entry || (owner && (entry.viewerId !== owner.viewerId || entry.sessionId !== owner.sessionId))) return;
  sessions.delete(id);
  clearTimeout(entry.timer);
  if (entry.paneId)
    await deps.rpc(entry.nodeId, { type: "ssh_key_bridge", op: "close", id: entry.paneId }).catch(() => {});
}

/** Test isolation for policy and transport failures without touching a live node. */
export function setLocalSshKeyDepsForTests(overrides: Partial<typeof defaults> | null): void {
  for (const entry of sessions.values()) clearTimeout(entry.timer);
  sessions.clear();
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}
