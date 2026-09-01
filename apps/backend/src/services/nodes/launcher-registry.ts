import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { defaultLocalLauncher } from "./local-launcher.js";
import type { NodeLauncher } from "./node-launcher.js";
import { RemoteLauncher } from "./remote-launcher.js";

/**
 * `nodeId → NodeLauncher` resolution (spec 2026-08-31 §6.3) — the seam the
 * session manager and the WS attach handler call instead of holding one
 * launcher. `local` (the seeded control-plane host row) gets the shared
 * {@link LocalLauncher}; every agent node gets a module-cached
 * {@link RemoteLauncher} per id: the class is stateless besides its nodeId
 * (all live state — facts, pendings, seq — rides the connection record), so
 * one instance per node is correct across reconnects.
 */

const remoteLaunchers = new Map<string, RemoteLauncher>();

/**
 * The launcher for one node id. Never throws — an unknown/offline agent id
 * still resolves to a `RemoteLauncher` whose commands reject
 * `NodeRpcError("offline")`, which is how callers are meant to learn the
 * node is unreachable.
 * @param nodeId - `nodes.id` (the literal `local` for the control-plane host)
 */
export function launcherFor(nodeId: string): NodeLauncher {
  if (nodeId === LOCAL_NODE_ID) return defaultLocalLauncher;
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
}
