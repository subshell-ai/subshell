import { type JsonValue, type NodeCommandBody, parseNodeCommandBody } from "@internal/subshell-protocol";
import {
  attachConnection,
  detachConnection,
  type NodeAgentFacts,
  type NodeConnection,
  type NodeSocket,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";

/**
 * A scripted agent on the REAL live-connection registry (Task 14 — the
 * cross-stack integration suites' node stand-in). `attachScriptedNode` maps a
 * {@link NodeSocket} into the registry whose `send` does exactly what the
 * `/ws/node` handler does with an inbound command frame, minus the signature
 * verify: decode the JWS payload (base64url split — tests trust themselves;
 * the crypto is pinned by `node-rpc.test.ts` / `node-signing`), gate it
 * through the REAL `parseNodeCommandBody` (so the suite proves the control
 * plane emits frames the real agent would accept), answer from the handler
 * record via {@link resolveResult}, and capture the parsed command for wire
 * assertions.
 *
 * No RPC-layer mocks: every command reaching the scripted node travelled the
 * real `sendCommand` chain — seq, sendChain mutex, signing, jti correlation.
 *
 * This is the first real resident of `src/test-helpers/` (the dir is for
 * cross-suite fixtures; before Task 14 these patterns lived inline in single
 * suites — see the node-fakes in `services/__tests__/helpers/`).
 */

/**
 * What a handler answers with: any JSON-able value becomes the `result{data}`
 * (undefined ⇒ a bare `{ ok: true }` — the no-data commands); a thrown or
 * returned {@link Error} answers `ok:false` with its message (the
 * `NodeRpcError("failed")` class on the caller's side). A handler may also
 * return a promise — the pending's resolve adopts it (the scripted agent
 * "thinking" before answering).
 */
export type ScriptedHandler = (cmd: NodeCommandBody) => unknown | Error;

/** Per-command-type answer table; unknown types answer a loud `ok:false`. */
export type ScriptedHandlers = Partial<Record<NodeCommandBody["type"], ScriptedHandler>>;

/** One decoded wire frame: the claims' ordering/correlation fields + the parsed cmd. */
export interface ScriptedWireFrame {
  /** Per-connection monotonic seq (wire order — must strictly increase) */
  seq: number;
  /** Command correlation id (the `result.ref` this node answers) */
  jti: string;
  /** The command, post-`parseNodeCommandBody` — exactly what a real agent switches on */
  cmd: NodeCommandBody;
}

/** The scripted node's handle: captured wire + registry record + teardown. */
export interface ScriptedNode {
  /** The registry connection record (facts live on it). */
  readonly conn: NodeConnection;
  /** Every accepted (parsed) frame, in wire order. */
  readonly wire: readonly ScriptedWireFrame[];
  /** Command types in wire order — for exact-sequence assertions. */
  cmdTypes(): NodeCommandBody["type"][];
  /** All commands of one type, in wire order, narrowed to that variant. */
  cmdsOf<T extends NodeCommandBody["type"]>(type: T): Extract<NodeCommandBody, { type: T }>[];
  /** How many frames of `type` arrived. */
  countOf(type: NodeCommandBody["type"]): number;
  /** The seq numbers seen, in wire order. */
  seqs(): number[];
  /** Evict the connection from the registry (idempotent — identity-guarded). */
  detach(): void;
}

/** The scripted agent's self-reported dataDir — every composed path hangs off it. */
export const SCRIPTED_DATA_DIR = "/home/scripted/.subshell";

/** Defaults for the `ready`-stashed facts; override per test via `over`. */
const DEFAULT_FACTS: NodeAgentFacts = {
  dataDir: SCRIPTED_DATA_DIR,
  // The exact set the shipped agent advertises post-Task-13.
  capabilities: ["uploads", "mcp"],
  hostname: "scripted",
  agentVersion: "0.2.0",
  executablePath: "/usr/bin/subshell",
  // Spec 2026-09-10 §5. `env` is deliberately absent here: a scripted node
  // with no reported env is a permanent regression pin for the "node
  // reported no env" branch of resume-path computation.
  homeDir: "/home/scripted",
};

/** The always-ok answer for no-data commands (launch, kill, remove_paths, …). */
export const ok: ScriptedHandler = () => undefined;

/** `stat_dir` → echo the path back as a directory (the agent's success answer). */
export const statDirEcho: ScriptedHandler = (cmd) =>
  cmd.type === "stat_dir" ? { path: cmd.path, isDirectory: true } : new Error(`statDirEcho: wrong cmd ${cmd.type}`);

/** `probe` → every requested id alive, no exit code (the healthy-agent answer). */
export const probeAllAlive: ScriptedHandler = (cmd) =>
  cmd.type === "probe"
    ? cmd.subshellIds.map((subshellId) => ({ subshellId, alive: true, exitCode: null }))
    : new Error(`probeAllAlive: wrong cmd ${cmd.type}`);

/**
 * Attach a scripted agent for `nodeId`.
 * @param nodeId - the node id to install under (a `nodes` row must exist for
 *   subshell FKs, but no node API key: this stands in for the dialing agent at
 *   the registry seam — the dial/auth path is `node-ws-integration.test.ts`)
 * @param handlers - per-type answers; a command with no handler answers a
 *   loud `ok:false` so unscripted traffic fails the test that sent it
 * @param over - fact overrides (dataDir, capabilities, …)
 */
export function attachScriptedNode(
  nodeId: string,
  handlers: ScriptedHandlers,
  over: Partial<NodeAgentFacts> = {},
): ScriptedNode {
  const wire: ScriptedWireFrame[] = [];
  let conn: NodeConnection;

  const ws: NodeSocket = {
    send(data) {
      const frame = JSON.parse(String(data)) as { jws?: string };
      if (typeof frame.jws !== "string") throw new Error("scripted node: envelope is not { jws }");
      const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        jti: string;
        seq: number;
        cmd: unknown;
      };
      const cmd = parseNodeCommandBody(claims.cmd);
      if (!cmd) {
        resolveResult(conn, { type: "result", ref: claims.jti, ok: false, error: "scripted node: malformed cmd" });
        return 0;
      }
      wire.push({ seq: claims.seq, jti: claims.jti, cmd });
      const answer = (): unknown | Error => {
        const handler = handlers[cmd.type];
        if (!handler) return new Error(`scripted node: no handler for "${cmd.type}"`);
        try {
          return handler(cmd);
        } catch (err) {
          return err instanceof Error ? err : new Error(String(err));
        }
      };
      const settled = answer();
      if (settled instanceof Error) {
        resolveResult(conn, { type: "result", ref: claims.jti, ok: false, error: settled.message });
        return 0;
      }
      resolveResult(
        conn,
        settled === undefined
          ? { type: "result", ref: claims.jti, ok: true }
          : // A promise here is legal at runtime (the pending's resolve adopts
            // it); the wire type only names the settled shape.
            { type: "result", ref: claims.jti, ok: true, data: settled as JsonValue },
      );
      return 0;
    },
    close: () => {},
  };

  conn = attachConnection(nodeId, ws);
  conn.agent = { ...DEFAULT_FACTS, ...over };

  return {
    conn,
    wire,
    cmdTypes: () => wire.map((w) => w.cmd.type),
    cmdsOf: (type) => wire.filter((w) => w.cmd.type === type).map((w) => w.cmd) as never,
    countOf: (type) => wire.filter((w) => w.cmd.type === type).length,
    seqs: () => wire.map((w) => w.seq),
    detach: () => {
      detachConnection(nodeId, ws);
    },
  };
}
