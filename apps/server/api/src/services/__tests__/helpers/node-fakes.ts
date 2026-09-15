import { join } from "node:path";
import type { LaunchPlan, NodeLauncher } from "@/services/nodes/node-launcher.js";
import {
  attachConnection,
  detachConnection,
  type NodeAgentFacts,
  type NodeSocket,
} from "@/services/nodes/node-registry.js";

/**
 * Shared fakes for the node/launcher seam, used by the subshell-manager suites
 * (remote create/restart, reconciler partition, exit/report application).
 * Both pieces are deliberately loud recorders: every suite asserts on what
 * the fake SAW, which is how the tests pin "agent rows never touch the local
 * probe path" (spec §6.3) and "the offline kill was swallowed at exactly the
 * kill step" (spec §5.6).
 */

/** Temp dir the fake composes its log paths under (caller-provided at construction). */
export class FakeNodeLauncher implements NodeLauncher {
  readonly plans: LaunchPlan[] = [];
  readonly kills: string[] = [];
  /** Paths arrays handed to `removeArtifacts`, one entry per call. */
  readonly removedPaths: string[][] = [];
  hasSubshellCalls = 0;
  /** Ids `hasSubshell` was called with — the local-probe path's fingerprint. */
  readonly probedIds: string[] = [];
  captureCalls = 0;
  /** Answer for `hasSubshell` / `paneTitle` — false stands in for "pane absent". */
  alive = true;
  /** When set, `killSubshell` throws it instead of recording (terminate-path tests). */
  killError: Error | undefined;
  /**
   * When set, `launch` throws it instead of recording the plan — the node
   * REFUSING a launch, as against failing to reach it. Refusals carry a
   * verbatim `NodeRpcError.detail` the service boundary maps by equality, so
   * a test needs a seam that throws the real error class rather than one that
   * merely fails.
   */
  launchError: Error | undefined;
  revokes = 0;

  constructor(readonly testDir: string) {}

  async validateWorkingDir(raw: string): Promise<string> {
    return raw;
  }
  async resolveBinary(): Promise<string | null> {
    return "/bin/stub";
  }
  async launch(plan: LaunchPlan): Promise<void> {
    if (this.launchError) throw this.launchError;
    this.plans.push(plan);
  }
  async terminate(): Promise<void> {}
  async killSubshell(_socket: string, id: string): Promise<void> {
    if (this.killError) throw this.killError;
    this.kills.push(id);
  }
  async hasSubshell(_socket: string, id: string): Promise<boolean> {
    this.hasSubshellCalls++;
    this.probedIds.push(id);
    return this.alive;
  }
  async paneExitCode(): Promise<number | null> {
    return null;
  }
  async paneTitle(): Promise<{ title: string; command: string } | null> {
    return null;
  }
  async capture(): Promise<string> {
    this.captureCalls++;
    return "";
  }
  async resize(): Promise<void> {}
  /**
   * Null: the fake "cannot read a pane's grid", matching `RemoteLauncher` and
   * keeping every existing attach assertion on the no-geometry path — the
   * behavior clients had before the readback existed.
   */
  async paneSize(): Promise<{ cols: number; rows: number } | null> {
    return null;
  }
  /**
   * False: the fake "cannot deliver a bare SIGWINCH", so the attach path's
   * repaint repair exercises the ±1 resize fallback exactly as before the
   * winch-first step existed (no redraw wait, no fake pane to signal).
   */
  async signalPaneWinch(): Promise<boolean> {
    return false;
  }
  async sendInput(): Promise<void> {}
  async deliverPrompt(): Promise<boolean> {
    return false;
  }
  logPath(id: string): string {
    return join(this.testDir, `${id}.log`);
  }
  /** Present on RemoteLauncher only; the fake mirrors it so delete-path tests can assert it. */
  metaArtifactPath(id: string): string {
    return "/node-data/subshells/".concat(id, ".meta.json");
  }
  /**
   * Mirrors {@link RemoteLauncher.subshellArtifacts}: the delete-time triple,
   * with the MCP path composed under `nodeOnline()`'s default `/node-data`
   * dataDir (the same source the manager's inline delete reads).
   */
  subshellArtifacts(id: string): string[] {
    return [this.logPath(id), `/node-data/mcp/${id}.json`, this.metaArtifactPath(id)];
  }
  async readLogTail(): Promise<{ lines: string[]; truncated: boolean }> {
    return { lines: [], truncated: false };
  }
  async readLog(): Promise<{ bytes: Uint8Array; next: number }> {
    return { bytes: new Uint8Array(0), next: 0 };
  }
  async tailStart(): Promise<() => void> {
    return () => {};
  }
  async canResume(): Promise<boolean> {
    return false;
  }
  async removeArtifacts(paths: string[]): Promise<void> {
    this.removedPaths.push(paths);
  }
}

/**
 * Put a node "online" with `ready` facts in the process-global registry.
 * @param nodeId - the id to attach under
 * @param capabilities - advertised capability strings (default: none)
 * @param over - fact overrides (dataDir etc.)
 * @returns the detach closure — call it in `finally` so the registry never leaks across tests
 */
export function nodeOnline(
  nodeId: string,
  capabilities: string[] = [],
  over: Partial<NodeAgentFacts> = {},
): () => void {
  const ws: NodeSocket = { send: () => {}, close: () => {} };
  const conn = attachConnection(nodeId, ws);
  conn.agent = {
    dataDir: "/node-data",
    capabilities,
    hostname: "rmgr",
    agentVersion: "1.0.0",
    selfInvoke: { command: "/usr/bin/subshell", args: [] },
    ...over,
  };
  return () => detachConnection(nodeId, ws);
}
