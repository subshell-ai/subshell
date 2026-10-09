import { open, seal } from "@internal/mcp-core";
import {
  openARelaySession as openA,
  openBRelaySession as openB,
  type ARelaySessionArgs as SharedAArgs,
  type BRelaySessionArgs as SharedBArgs,
} from "@internal/pane-runtime";
import { loadOrCreateIdentity } from "../identity.js";
import { log } from "../log.js";

export { RELAY_CLOSE_TOMBSTONE_MS, type RelaySessionHandler, RelaySessions } from "@internal/pane-runtime";
export type ARelaySessionArgs = Omit<SharedAArgs, "identity" | "seal" | "open">;
export type BRelaySessionArgs = Omit<SharedBArgs, "identity" | "seal" | "open">;
/** Node adapter: preserve this daemon's identity location and log. */
export function openARelaySession(args: ARelaySessionArgs): Promise<{ relayId: string }> {
  return openA({ ...args, identity: () => loadOrCreateIdentity(args.dataDir), seal, open, log: args.log ?? log });
}
/** Node adapter for the connecting side. */
export function openBRelaySession(args: BRelaySessionArgs): Promise<{ socketPath: string }> {
  return openB({ ...args, identity: () => loadOrCreateIdentity(args.dataDir), seal, open, log: args.log ?? log });
}
