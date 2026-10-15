import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { buildAgentSocketPath, machineSshKeyBridge, SSH_KEY_BRIDGE_REFUSALS } from "@internal/pane-runtime";
import {
  isSshLocalKeyHostPin,
  parseSshKeyBridgeResult,
  SSH_LOCAL_KEY_TTL_MS,
  type SshConnectionSnapshotWire,
  type SshKeyBridgeCommand,
} from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { mapRpcError, SshRpcError, sshHostKey } from "@/services/nodes/ssh-rpc.js";
import { sshCanonicalDestination, sshExpectedDestinationProblem } from "@/services/ssh-destination.js";
import {
  captureHostPin,
  hostKeyFingerprints,
  hostPinFor,
  hostPinRefusal,
  SshHostPinError,
} from "@/services/ssh-host-pins.service.js";
import { relaySnapshotRefusal, rpcRefusal, sshResolveDestination } from "@/services/ssh-launch.service.js";
import { gateSshNode } from "@/services/ssh-policy.service.js";

/** How long a preparation may wait for its native approval and launch (the pre-open half). */
const PREPARE_TTL_MS = 5 * 60_000;
/** Ceiling on retained preparations instance-wide, and per viewer (each holds a host pin and a timer). */
const MAX_PENDING_SESSIONS = 256;
const MAX_SESSIONS_PER_VIEWER = 3;

interface LocalKeySession {
  /** The person who prepared it; every exchange re-matches this browser session's owner. */
  viewerId: string;
  /** The exact login session that prepared it — another session of the same person cannot consume it. */
  sessionId: string;
  /** The connecting node the bridge will live on; open/exchange re-match it. */
  nodeId: string;
  /** The resolved destination snapshot; open re-matches it, so the pane's ssh asks what was approved. */
  snapshot: SshConnectionSnapshotWire;
  /** The one known_hosts line written to the node; captured here, never re-read later. */
  hostPin: string;
  /** Absolute deadline (ms): the pre-open half is PREPARE_TTL_MS, the open half SSH_LOCAL_KEY_TTL_MS. */
  expires: number;
  /** Set once by openLocalSshKey and never cleared: its presence IS the one-use marker. */
  paneId?: string;
  /** Concurrency lock across prepare/open/exchange/close; an in-flight operation refuses to interleave. */
  busy: boolean;
  /** Unref'd deadline timer that closes this session; replaced when open shortens the lifetime. */
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

/**
 * Turn any failure that reaches this surface into the ssh family's coded
 * refusal, reusing the launcher's one-sentence-per-cause wording
 * (`rpcRefusal`) rather than inventing a fifth 500-shaped copy of it.
 */
function refuse(error: unknown): never {
  if (error instanceof NodeRpcError) return refuseRpc(mapRpcError(error.nodeId, error));
  if (error instanceof SshRpcError) return refuseRpc(error);
  if (error instanceof SshHostPinError) {
    const refusal = hostPinRefusal(error);
    throwApiError({ code: refusal.code, message: refusal.message, doNotLog: true });
  }
  // The in-process bridge's own terminal refusals (stale sequence, second
  // open, over-cap census, refused path): the request is over, and a browser
  // retry cannot salvage it. Anything NOT in the published set stays a 500 —
  // a real fault here is not something to log as a client refusal.
  if (error instanceof Error && SSH_KEY_BRIDGE_REFUSALS.has(error.message)) fail();
  throw error;
}

function refuseRpc(error: SshRpcError): never {
  const answer = rpcRefusal(error);
  if (!answer.ok && "code" in answer.refusal)
    throwApiError({ code: answer.refusal.code, message: answer.refusal.message, doNotLog: true });
  throw error;
}

async function rpc(nodeId: string, command: SshKeyBridgeCommand) {
  let answer: unknown;
  try {
    answer =
      nodeId === "local"
        ? await machineSshKeyBridge(SUBSHELL_SERVER_DATA_DIR, command)
        : await sendCommand(nodeId, command);
  } catch (error) {
    throw refuse(error);
  }
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
export async function prepareLocalSshKey(
  viewerId: string,
  sessionId: string,
  nodeId: string,
  destination: string,
  expectedDestination?: string,
) {
  if (
    sessions.size >= MAX_PENDING_SESSIONS ||
    [...sessions.values()].filter((entry) => entry.viewerId === viewerId).length >= MAX_SESSIONS_PER_VIEWER
  )
    fail("Too many key selections are waiting. Close one or wait for it to expire.");
  const answer = await deps.resolve(viewerId, nodeId, destination, expectedDestination);
  if (!answer.ok) {
    if ("code" in answer.refusal && answer.refusal.code === BackendErrorCodes.CONFIG_INVALID)
      throwApiError({ code: answer.refusal.code, message: answer.refusal.message, doNotLog: true });
    fail("The destination could not be resolved. Check the connecting node and SSH destination.");
  }
  if (!answer.value.accepted)
    fail("The destination could not be resolved. Check the connecting node and SSH destination.");
  const snapshot = answer.value.snapshot;
  const problem = sshExpectedDestinationProblem(snapshot, expectedDestination);
  if (problem) throwApiError({ code: BackendErrorCodes.CONFIG_INVALID, message: problem, doNotLog: true });
  if (relaySnapshotRefusal(snapshot) || !snapshot.user)
    fail("A key from your machine needs a destination with an explicit username and no jump hosts or host-key alias.");
  const canonical = sshCanonicalDestination(snapshot);
  const saved = await deps.pin({ ownerUserId: viewerId, destination: canonical });
  const lines = saved
    ? [saved.hostKey]
    : (
        await deps
          .hostKey(nodeId, { host: snapshot.host, port: snapshot.port, user: snapshot.user, scan: true })
          .catch((error: unknown) => refuse(error))
      ).lines;
  const hostPin =
    lines.find((line) => isSshLocalKeyHostPin(line) && line.split(/\s+/)[1] === "ssh-ed25519") ??
    lines.find((line) => isSshLocalKeyHostPin(line) && hostKeyFingerprints(line).length === 1);
  if (!hostPin || hostPin.startsWith("@"))
    fail("The destination did not provide a supported host key. Ask its administrator to check SSH.");
  const hostKey = hostPin.split(/\s+/)[2];
  if (!hostKey) fail();
  // Recheck the bounded census after network awaits, before retaining anything.
  if (
    sessions.size >= MAX_PENDING_SESSIONS ||
    [...sessions.values()].filter((entry) => entry.viewerId === viewerId).length >= MAX_SESSIONS_PER_VIEWER
  )
    fail();
  const id = crypto.randomUUID();
  const timer = setTimeout(() => void closeLocalSshKey(id), PREPARE_TTL_MS);
  timer.unref();
  sessions.set(id, {
    viewerId,
    sessionId,
    nodeId,
    snapshot,
    hostPin,
    expires: deps.now() + PREPARE_TTL_MS,
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
    throw refuse(error);
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
    throw refuse(error);
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
