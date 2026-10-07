import { homedir } from "node:os";
import { findBinary, getSshSessionSupervisor, peekSshSessionSupervisor } from "@internal/pane-runtime";
import type { SshSessionTargetWire } from "@internal/subshell-protocol";
import {
  SSH_CANCEL_GRACE_MS,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSION_PUMP_CHUNK_BYTES,
} from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";

let stopping = false;
let opening: Promise<unknown> | null = null;
/** Shutdown must outlast one bounded open so an SSH child cannot be orphaned before its hello. */
export const LOCAL_SSH_SHUTDOWN_MS = SSH_SESSION_OPEN_DEADLINE_MS + SSH_CANCEL_GRACE_MS + 5000;

/** The server account uses the same bounded SSH supervisor as enrolled nodes. */
export async function openLocalBroker(
  ref: string,
  target: SshSessionTargetWire,
  runtimeCommand: string | undefined,
  hooks: {
    emitBytes: (bytes: Uint8Array) => Promise<void>;
    onLost: () => void;
  },
) {
  if (stopping || opening)
    throw new NodeRpcError(
      "failed",
      "The server is stopping or already connecting to an SSH host. Try again shortly.",
      "local",
      "connection_failed",
    );
  const work = performOpen(ref, target, runtimeCommand, hooks);
  opening = work;
  try {
    return await work;
  } finally {
    opening = null;
  }
}

async function performOpen(
  ref: string,
  target: SshSessionTargetWire,
  runtimeCommand: string | undefined,
  hooks: { emitBytes: (bytes: Uint8Array) => Promise<void>; onLost: () => void },
) {
  const sshBin = await findBinary("ssh", "SUBSHELL_SSH_PATH", [
    "/usr/bin/ssh",
    "/bin/ssh",
    "/usr/local/bin/ssh",
    "/opt/homebrew/bin/ssh",
  ]);
  if (!sshBin) throw new Error("SSH is not installed on the server machine.");
  const supervisor = getSshSessionSupervisor({
    dataDir: SUBSHELL_SERVER_DATA_DIR,
    homeDir: process.env.HOME || homedir(),
    sshBin,
    nowMs: Date.now,
  });
  const outcome = await supervisor.open(
    { ref, target, runtimeCommand: runtimeCommand || "subshell" },
    {
      emitBytes: async (bytes) => {
        for (let offset = 0; offset < bytes.byteLength; offset += SSH_SESSION_PUMP_CHUNK_BYTES) {
          await hooks.emitBytes(bytes.subarray(offset, offset + SSH_SESSION_PUMP_CHUNK_BYTES));
        }
      },
      // SSH diagnostics can contain account data; errors use the supervisor's bounded classifications.
      emitDiag: () => {},
      onLost: hooks.onLost,
    },
  );
  if (outcome.kind === "refused") throw new NodeRpcError("failed", outcome.code, "local", outcome.code);
  if (stopping) {
    supervisor.close(ref);
    throw new Error("The server is stopping.");
  }
  return outcome.result;
}

/** Writes preserve the session's serialization and the supervisor's input bound. */
export async function sendLocalBroker(ref: string, bytes: Uint8Array): Promise<void> {
  if (peekSshSessionSupervisor(SUBSHELL_SERVER_DATA_DIR)?.send(ref, bytes) !== "ok")
    throw new Error("SSH connection is no longer active.");
}

/** Disconnect only the SSH runtime; destination panes retain their existing lifecycle. */
export function closeLocalBroker(ref: string): void {
  peekSshSessionSupervisor(SUBSHELL_SERVER_DATA_DIR)?.close(ref);
}

/** Drain only children owned by this process, and allow the supervisor's kill deadline to run. */
export async function stopLocalSshBroker(): Promise<void> {
  stopping = true;
  const wasOpening = opening !== null;
  await opening?.catch(() => {});
  const supervisor = peekSshSessionSupervisor(SUBSHELL_SERVER_DATA_DIR);
  const refs = supervisor?.liveRefs() ?? [];
  for (const ref of refs) supervisor?.close(ref);
  if (refs.length || wasOpening) await Bun.sleep(SSH_CANCEL_GRACE_MS + 50);
}
