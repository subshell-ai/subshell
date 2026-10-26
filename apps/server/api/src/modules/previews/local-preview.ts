import {
  type BridgeDeps,
  bridgeCount,
  type LaneDeps,
  type PanePortsScan,
  PreviewDisplays,
  PreviewForward,
  type PreviewLaneEvent,
  scanPanePorts,
  startBridge,
  stopBridge,
  TmuxRunner,
  type VirtualDisplayProvider,
} from "@internal/pane-runtime";
import {
  type NodeCommandBody,
  PREVIEW_FORWARD_SESSIONS_PER_PANE,
  PREVIEW_SESSIONS_PER_NODE,
  PREVIEW_WATCH_FPS_DEFAULT,
} from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import {
  getAnyPreviewEnabled,
  getEnabledDisplayProviders,
  getVirtualDisplayEnabled,
  getVirtualDisplayProvider,
  getWebPreviewsEnabled,
} from "@/modules/nodes/preview-enabled.js";
import { getLogger } from "@/shared/logger.js";

export interface LocalPreviewDeps {
  dataDir: string;
  enabled: () => Promise<boolean>;
  webPreviewsEnabled?: () => Promise<boolean>;
  displayEnabled?: () => Promise<boolean>;
  pane: (id: string) => Promise<SubshellTable | undefined>;
  panePid: (socket: string, id: string) => Promise<number | null>;
  scan?: typeof scanPanePorts;
  forward?: LaneDeps;
  bridge?: BridgeDeps;
  displayProvider?: VirtualDisplayProvider;
  getDisplayProviderId?: () => string | Promise<string>;
  getEnabledProviderIds?: () => string[] | Promise<string[]>;
  log?: (line: string) => void;
}

/** Uses the same machine-local primitives as an enrolled node, with the DB as its gate. */
export class LocalPreviewRuntime {
  readonly forward: PreviewForward;
  readonly displays: PreviewDisplays;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: LocalPreviewDeps) {
    this.forward = new PreviewForward(deps.forward);
    this.displays = new PreviewDisplays(deps.dataDir, {
      provider: deps.displayProvider,
      getProviderId: deps.getDisplayProviderId,
      getEnabledProviderIds: deps.getEnabledProviderIds,
      isEnabled: deps.displayEnabled ?? deps.enabled,
      log: deps.log,
    });
  }

  /** Serializes admission like the node's command chain, including in-flight CDP handshakes. */
  execute(cmd: NodeCommandBody, emit: (event: PreviewLaneEvent) => void): Promise<unknown> {
    const result = this.chain.then(() => this.run(cmd, emit));
    this.chain = result.catch(() => {});
    return result;
  }

  private refuse(detail: string): never {
    throw new NodeRpcError("failed", detail, LOCAL_NODE_ID, detail);
  }

  private async run(cmd: NodeCommandBody, emit: (event: PreviewLaneEvent) => void): Promise<unknown> {
    // Closing remains available after the switch goes off or the subshell ends.
    if (cmd.type === "preview_close") {
      const { closed } = this.forward.closeLane(cmd.ref, cmd.reason);
      return { ref: cmd.ref, closed: closed || stopBridge(cmd.ref, cmd.reason) };
    }
    if (cmd.type !== "preview_open" && cmd.type !== "preview_ports_get") this.refuse("unsupported");
    if (!(await this.deps.enabled())) this.refuse("preview-node-off: turn on Preview for this node");
    const pane = await this.deps.pane(cmd.paneId);
    if (!pane || pane.nodeId !== LOCAL_NODE_ID || pane.status !== "running" || pane.alive !== 1 || !pane.tmuxSocket)
      this.refuse("preview-pane-gone");
    const panePid = await this.deps.panePid(pane.tmuxSocket, pane.id);
    if (panePid === null) this.refuse("preview-pane-gone");
    if (cmd.type === "preview_ports_get") {
      try {
        const screen = this.displays.getFor(pane.id);
        const answer: PanePortsScan = await (this.deps.scan ?? scanPanePorts)({ panePid, screen });
        const screenLost = screen === null ? this.displays.lostFor(pane.id) : null;
        return { ...answer, ...(screenLost ? { screenLost } : {}) };
      } catch (err) {
        this.refuse(err instanceof Error ? err.message : String(err));
      }
    }
    const isScreen = cmd.kind === "forward" && !cmd.service && this.displays.getFor(pane.id)?.viewer.port === cmd.port;
    if (
      !(await (isScreen
        ? (this.deps.displayEnabled ?? this.deps.enabled)
        : (this.deps.webPreviewsEnabled ?? this.deps.enabled))())
    ) {
      this.refuse(isScreen ? "virtual-display-disabled" : "preview-node-off");
    }
    if (this.forward.laneCount() + bridgeCount() >= PREVIEW_SESSIONS_PER_NODE)
      this.refuse(cmd.kind === "forward" ? "preview-lane-over-node-cap" : "preview-watch-over-node-cap");
    if (cmd.kind === "forward") {
      if (this.forward.laneCount(cmd.paneId) >= PREVIEW_FORWARD_SESSIONS_PER_PANE)
        this.refuse("preview-lane-over-pane-cap");
      this.forward.openLane({
        ref: cmd.ref,
        port: cmd.port,
        service: cmd.service,
        paneId: cmd.paneId,
        lifetimeMs: cmd.lifetimeMs,
        hooks: { emit, log: this.deps.log },
      });
      return { ref: cmd.ref, pending: true };
    }
    try {
      await startBridge({
        ref: cmd.ref,
        cdpPort: cmd.port,
        fps: cmd.fps ?? PREVIEW_WATCH_FPS_DEFAULT,
        lifetimeMs: cmd.lifetimeMs,
        emitStream: (event) => {
          emit(event);
        },
        emitClosed: emit,
        deps: this.deps.bridge,
        log: this.deps.log,
      });
      return { ref: cmd.ref, subscribers: 1 };
    } catch {
      this.refuse("not-cdp");
    }
  }
}

let runtime: LocalPreviewRuntime | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let sweptAt = 0;
let sweep: Promise<unknown> | undefined;

/** Lazy: importing the CLI graph must not create directories or start child processes. */
export function getLocalPreviewRuntime(): LocalPreviewRuntime {
  if (!runtime) {
    const panes = new SubshellsRepository(db);
    const tmux = new TmuxRunner();
    sweepTimer ??= setInterval(() => {
      void sweepLocalPreviewDisplays().catch((err: unknown) =>
        getLogger().warn(`Local display sweep failed: ${String(err)}`),
      );
    }, 60_000);
    sweepTimer.unref();
    runtime = new LocalPreviewRuntime({
      dataDir: SUBSHELL_SERVER_DATA_DIR,
      getDisplayProviderId: () => getVirtualDisplayProvider(LOCAL_NODE_ID),
      getEnabledProviderIds: () => getEnabledDisplayProviders(LOCAL_NODE_ID),
      enabled: () => getAnyPreviewEnabled(LOCAL_NODE_ID),
      webPreviewsEnabled: () => getWebPreviewsEnabled(LOCAL_NODE_ID),
      displayEnabled: () => getVirtualDisplayEnabled(LOCAL_NODE_ID),
      pane: (id) => panes.findById(id),
      panePid: (socket, id) => tmux.panePid(socket, id),
      log: (line) => getLogger().debug(line),
    });
  }
  return runtime;
}

/** Rehydrate surviving screens after a server restart and reap orphaned display children. */
export async function sweepLocalPreviewDisplays(): Promise<void> {
  if (sweep) {
    await sweep;
    return;
  }
  if (Date.now() - sweptAt < 60_000) return;
  sweptAt = Date.now();
  sweep = (async () => {
    const panes = await new SubshellsRepository(db).listRunning();
    await getLocalPreviewRuntime().displays.sweepOrphans(
      panes.filter((pane) => pane.nodeId === LOCAL_NODE_ID && pane.alive === 1).map((pane) => pane.id),
    );
  })();
  try {
    await sweep;
  } finally {
    sweep = undefined;
  }
}
