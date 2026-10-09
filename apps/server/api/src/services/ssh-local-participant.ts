import { open, seal } from "@internal/mcp-core";
import {
  decodePeerEncryptionJwk,
  MachinePinStore,
  openARelaySession,
  openBRelaySession,
  type RelayMachineIdentity,
  RelaySessions,
} from "@internal/pane-runtime";
import {
  bytesOfJwk,
  fingerprintJwk,
  type NodeCommandBody,
  type NodeSshFingerprintReport,
  parseRelayFrame,
  type RelayFrame,
} from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalRelayIdentity, localRelayIdentityDir } from "@/services/ssh-local-identity.js";
import { logger } from "@/utils/logger.js";

/** Server adapter over the same sealed participant used by nodes. The broker supplies its authenticated-origin pump. */
export function createLocalRelayParticipant(args: {
  dataDir: string;
  identityDir: string;
  identity(): Promise<RelayMachineIdentity>;
  sendRelayFrame(frame: RelayFrame): void;
  resolveAgentSocket?: () => string | null;
  log(line: string): void;
}) {
  const sessions = new RelaySessions(args.log);
  let stopped = false;
  return {
    sessions,
    async command(cmd: NodeCommandBody): Promise<unknown> {
      if (cmd.type === "ssh_relay_close") return { ref: cmd.ref, closed: sessions.close(cmd.ref, cmd.reason) };
      if (stopped) throw new Error("server relay participant is shutting down");
      if (cmd.type !== "ssh_relay_open") throw new Error("unsupported local relay command");
      const common = {
        dataDir: args.dataDir,
        pinDataDir: args.identityDir,
        identity: args.identity,
        seal,
        open,
        relay: sessions,
        selfNodeId: LOCAL_NODE_ID,
        sendRelayFrame: args.sendRelayFrame,
        log: args.log,
        cmd,
      };
      // In-process calls have no serial WebSocket command chain. Await A's probe so B cannot lose its first request.
      const result =
        cmd.role === "A"
          ? await openARelaySession({ ...common, resolveAgentSocket: args.resolveAgentSocket })
          : await openBRelaySession({ ...common, paneId: cmd.paneId });
      if (stopped) {
        sessions.close(cmd.ref, "child-exit");
        throw new Error("server relay participant stopped during open");
      }
      return { role: cmd.role, relayId: cmd.relayId, ...result };
    },
    inbound(frame: RelayFrame): void {
      if (stopped || !parseRelayFrame(frame)) throw new Error("local relay frame unavailable or malformed");
      sessions.onInboundRelayFrame(frame);
    },
    closeAll(): void {
      stopped = true;
      sessions.closeAll("child-exit");
    },
  };
}

/** Lazily composed production participant; no broker import and no import-time I/O. */
export function productionLocalRelayParticipant(sendRelayFrame: (frame: RelayFrame) => void) {
  return createLocalRelayParticipant({
    dataDir: SUBSHELL_SERVER_DATA_DIR,
    identityDir: localRelayIdentityDir(),
    identity: ensureLocalRelayIdentity,
    sendRelayFrame,
    log: (line) => logger.debug(line),
  });
}

/** Live public trust report for the server's managed node detail. */
export async function localSshTrustReport(): Promise<NodeSshFingerprintReport> {
  const identity = await ensureLocalRelayIdentity();
  return {
    own: {
      signing: await fingerprintJwk(identity.signingPublicJwk),
      encryption: await fingerprintJwk(identity.publicJwk),
    },
    peers: await Promise.all(
      new MachinePinStore(localRelayIdentityDir()).entries().map(async ({ nodeId, pin }) => ({
        nodeId,
        signing: await fingerprintJwk(pin.signing),
        encryption: await fingerprintJwk(pin.encryption),
      })),
    ),
  };
}

/** The admin-authorized repair changes only the named peer, with both public halves revalidated. */
export function repairLocalMachinePin(cmd: {
  peerNodeId: string;
  peerSigningPublicKey: string;
  peerEncryptPublicKey: string;
}) {
  if (cmd.peerNodeId === LOCAL_NODE_ID) throw new Error("a machine is never its own relay peer");
  bytesOfJwk(cmd.peerSigningPublicKey);
  const encryption = decodePeerEncryptionJwk(cmd.peerEncryptPublicKey);
  new MachinePinStore(localRelayIdentityDir()).repair(cmd.peerNodeId, {
    signing: cmd.peerSigningPublicKey,
    encryption,
  });
  return { repaired: true as const, peerNodeId: cmd.peerNodeId };
}
