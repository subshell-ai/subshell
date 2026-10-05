import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { RuntimeSessionLauncher } from "@/services/ssh-runtime/runtime-session-launcher.js";
import { liveSessionForRuntimeNode } from "@/services/ssh-runtime/session-registry.js";
import { getDefaultLocalLauncher } from "./local-launcher.js";
import type { NodeLauncher } from "./node-launcher.js";
import { RemoteLauncher } from "./remote-launcher.js";

/**
 * `nodeId → NodeLauncher` resolution (spec 2026-08-31 §6.3) — the seam the
 * subshell manager and the WS attach handler call instead of holding one
 * launcher. `local` (the seeded control-plane host row) gets the shared
 * {@link LocalLauncher}; every agent node gets a module-cached
 * {@link RemoteLauncher} per id: the class is stateless besides its nodeId
 * (all live state — facts, pendings, seq — rides the connection record), so
 * one instance per node is correct across reconnects.
 */

const remoteLaunchers = new Map<string, RemoteLauncher>();
/** Per-node cached runtime launchers, keyed with their session so a re-opened session (same runtime node id is impossible - new uuid - but a stale entry can never outlive its session by construction). */
const runtimeLaunchers = new Map<
  string,
  { session: import("@/services/ssh-runtime/session.js").SshRuntimeSession; launcher: RuntimeSessionLauncher }
>();

/**
 * The launcher for one node id. Never throws — an unknown/offline agent id
 * still resolves to a `RemoteLauncher` whose commands reject
 * `NodeRpcError("offline")`, which is how callers are meant to learn the
 * node is unreachable.
 * @param nodeId - `nodes.id` (the literal `local` for the control-plane host)
 */
export function launcherFor(nodeId: string): NodeLauncher {
  if (nodeId === LOCAL_NODE_ID) return getDefaultLocalLauncher();
  // The runtime branch (design 2026-10-05 §4): a `runtime`-kind node id whose
  // session is live RIGHT NOW resolves to a `RuntimeSessionLauncher` bound to
  // that session. No live session means fall through to the `RemoteLauncher`
  // path, whose commands reject `offline` - the honest reading of a pane whose
  // destination session died (the registry is liveness authority; the DB row
  // is history). Cached per session id so the per-subshell pump contracts
  // hold across callers.
  const session = liveSessionForRuntimeNode(nodeId);
  if (session) {
    let rl = runtimeLaunchers.get(nodeId);
    if (!rl || rl.session !== session) {
      rl = { session, launcher: new RuntimeSessionLauncher(session) };
      runtimeLaunchers.set(nodeId, rl);
    }
    return rl.launcher;
  }
  let launcher = remoteLaunchers.get(nodeId);
  if (!launcher) {
    launcher = new RemoteLauncher(nodeId);
    remoteLaunchers.set(nodeId, launcher);
  }
  return launcher;
}

/**
 * Drops the cached `RemoteLauncher` instances. Test seam only — production
 * callers must not call this; @internal.
 */
export function resetLauncherRegistryForTests(): void {
  remoteLaunchers.clear();
  runtimeLaunchers.clear();
}
