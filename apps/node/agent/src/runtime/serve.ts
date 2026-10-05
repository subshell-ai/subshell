import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TmuxRunner } from "@internal/pane-runtime";
import {
  isSshSessionRef,
  type NodeEvent,
  parseSshRuntimeCommandFrame,
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeEventFrame,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import type { NodeConfig } from "../config.js";
import { clientHome } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { NODE_VERSION } from "../version.js";
import { startCallbackSocket } from "./callback-sock.js";
import { type RuntimeReportRow, runRuntimeCommand } from "./dispatch.js";
import { diag, RuntimeWriter, redirectConsoleToStderr, startStdinReader } from "./stdio.js";

/**
 * `subshell runtime-serve` (design 2026-10-05 §1/§6): the session-scoped mode
 * of the node binary. It behaves like a node whose link is the SSH child's
 * stdio: it drives tmux on the destination, owns pane logs, answers the
 * command/event semantics, and ENLISTS NOTHING - no enrollment config, no
 * node key, no service, no network listener (the callback socket is the one
 * permitted listener, and it is unix-only).
 *
 * Its lifetime is the child's: the SSH child dies, this process dies with the
 * transport; the tmux server and its panes SURVIVE on the destination (tmux
 * outlives its clients) and the next session reconciles them (the hello's
 * `paneCount` is that reconciliation's first word). A `close` frame exits 0
 * AFTER forwarding the final census report (design §6); killing panes is
 * always an explicit terminate, never a close side effect.
 *
 * Isolation (design §6 coexistence): everything this process touches lives
 * under `<default dataDir>/runtime/` (or `SUBSHELL_RUNTIME_DATA_DIR`), the
 * tmux socket is the destination-deterministic name the broker passes, and no
 * enrolled daemon's directory, socket, or record is ever read or written from
 * here. The runtime is a guest with its own room.
 */

export interface RuntimeServeInput {
  /** The plane-minted session ref (`--session`), echoed for correlation only. */
  session: string;
  /** The deterministic per-destination tmux socket the broker computed (`--tmux-socket`). */
  tmuxSocket: string;
  /** Test seam: relocate the runtime namespace (production: `SUBSHELL_RUNTIME_DATA_DIR` or the default). */
  dataDir?: string;
}

/** The runtime's default namespace: `<clientHome>/data/runtime` - the `runtime/` subdirectory beside (never inside) an enrolled daemon's data dir. */
export function runtimeDataDir(override?: string): string {
  const env = process.env.SUBSHELL_RUNTIME_DATA_DIR;
  if (override !== undefined && override !== "") return override;
  if (env !== undefined && env.trim() !== "") return env.trim();
  return join(clientHome(), "data", "runtime");
}

/**
 * Run the serve loop until the session ends. Resolves with the process exit
 * code once the transport closes or a `close` frame lands; the caller (the
 * CLI verb) exits with it.
 */
export async function runRuntimeServe(input: RuntimeServeInput): Promise<number> {
  redirectConsoleToStderr(); // stdout is protocol-only; the logger's console transport moves to stderr
  // The predicate narrows `string` to `never` on the false arm, so the
  // refusal line names the flag, not the value: the broker's log already
  // carries what it sent, and echoing a malformed token here is a second
  // sink for it.
  if (!isSshSessionRef(input.session)) {
    diag("runtime-serve: refused --session (not a session ref)");
    return 2;
  }
  if (input.tmuxSocket === "" || !/^[A-Za-z0-9._-]+$/.test(input.tmuxSocket)) {
    diag(`runtime-serve: refused --tmux-socket: ${input.tmuxSocket.slice(0, 80)}`);
    return 2;
  }
  const dataDir = runtimeDataDir(input.dataDir);
  // 0700 root + the subshells dir the meta store and pane logs share with the
  // socket; `mkdir` mode is umask-masked, and the meta store re-tightens its
  // own writes exactly as the enrolled daemon's does.
  await mkdir(join(dataDir, "subshells"), { recursive: true, mode: 0o700 });

  const writer = new RuntimeWriter();
  // A runtime never enrolls: the NodeConfig fields beyond dataDir exist for
  // the daemon's link and service surface, neither of which a session mode
  // reaches, and every reused executor reads ONLY dataDir (meta store root,
  // allowlist file, maintenance file, input-generation store) - all of which
  // live under the runtime namespace. The empty link fields are never dialed.
  const config = {
    serverUrl: "",
    nodeId: `runtime:${input.session}`,
    nodeKey: "",
    controlPublicKey: "",
    dataDir,
    name: "runtime-serve",
  } satisfies NodeConfig;

  const ctx: CommandContext = {
    config,
    tmux: new TmuxRunner(),
    meta: new SubshellMetaStore(dataDir),
    nowMs: Date.now,
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => diag("runtime: restart requested; a session runtime exits instead"),
    ws: {
      send: (ev) => {
        // The node-link event vocabulary the reused executors emit maps onto
        // the runtime's own event frames; anything unmapped (maintenance flips
        // a runtime cannot have) is a diagnostic line, never a frame.
        const mapped = mapNodeEventToRuntimeFrame(ev);
        if (mapped === null) {
          diag(`runtime: dropped unmapped event ${ev.type}`);
          return;
        }
        writer.writeFrame(mapped);
      },
      get bufferedAmount() {
        return writer.bufferedAmount;
      },
    },
  };

  const callback = await startCallbackSocket(dataDir, (req) => {
    writer.writeFrame({
      type: "rest_request",
      reqId: req.reqId,
      method: req.method,
      path: req.path,
      ...(req.body !== undefined ? { body: req.body } : {}),
    } satisfies SshRuntimeEventFrame);
  });

  // The hello (design §2: first frame or the open fails). `paneCount` is the
  // census of the destination socket as it stands: a SECOND session on the
  // same machine reports the first session's panes here, which is the
  // reconciliation the plane then idempotently restores (design §6).
  writer.writeFrame({
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: NODE_VERSION,
    os: process.platform,
    arch: process.arch,
    capabilities: ["ssh-runtime", "callback-sock"],
    homeDir: process.env.HOME || homedir(),
    dataDir,
    tmuxSocket: input.tmuxSocket,
    paneCount: countSocketPanes(ctx.tmux, input.tmuxSocket),
  } satisfies SshRuntimeEventFrame);

  // Serial dispatch, the daemon's ordering contract ported: one in-flight
  // command at a time, because tmux ordering IS the pane's input order and a
  // reordered `terminate` after a `launch` is a lost kill, not a late one.
  let chain: Promise<void> = Promise.resolve();
  let closing = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = () => resolve(shutdown(callback, ctx));
  });

  const finish = (reason: string): void => {
    diag(`runtime-serve: session ${input.session} ending (${reason})`);
    resolveDone();
  };

  startStdinReader(
    (raw) => {
      const refForError = extractRef(raw);
      chain = chain
        .then(async () => {
          const frame = parseSshRuntimeCommandFrame(raw);
          if (frame === null) {
            // Fail-closed on an ungrammatical frame: plane and runtime agreed
            // on this grammar; a violation means one end is lying, and the
            // honest response is to stop, not to guess.
            diag("runtime: refusing malformed command frame; closing");
            if (!closing) {
              closing = true;
              finish("protocol-violation");
            }
            return;
          }
          if (closing) return; // already committed to the exit path
          if (frame.type === "rest_response") {
            callback.resolve(frame.reqId, frame.status, frame.body ?? "");
            return;
          }
          if (frame.type === "close") {
            closing = true;
            const census = await finalReport(ctx, input.tmuxSocket);
            writer.writeFrame({ type: "result", ref: frame.ref, ok: true, data: census });
            finish("close");
            return;
          }
          const result = await runRuntimeCommand(ctx, input.tmuxSocket, frame);
          if (result.ok) {
            writer.writeFrame({
              type: "result",
              ref: frame.ref,
              ok: true,
              ...(result.data !== undefined ? { data: result.data } : {}),
            } satisfies SshRuntimeEventFrame);
          } else {
            writer.writeFrame({ type: "result", ref: frame.ref, ok: false, error: result.error });
          }
        })
        .catch((err: unknown) => {
          // One executor throwing must not silently stall the chain; answer
          // and keep going, exactly like dispatchCommand's TOTAL wrapper.
          diag(`runtime: command threw: ${err instanceof Error ? err.message : String(err)}`);
          if (refForError !== null)
            writer.writeFrame({ type: "result", ref: refForError, ok: false, error: "runtime-command-failed" });
        });
    },
    (reason) => {
      if (!closing) {
        closing = true;
        finish(reason);
      }
    },
  );

  return await done;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The census forwarded on close (design §6: "exits after forwarding its final
 * report"), returned as the `close` command's result - the plane correlates
 * panes to rows from there. A tmux that cannot answer reports panes ALIVE,
 * never dead: the run family's honesty rule, a blip must not read as a death.
 */
async function finalReport(ctx: CommandContext, socket: string): Promise<RuntimeReportRow[]> {
  const metas = await ctx.meta.list();
  const rows: RuntimeReportRow[] = [];
  for (const meta of metas) {
    const s = meta.socket || socket;
    let alive = true;
    try {
      alive = await ctx.tmux.hasSubshell(s, meta.subshellId);
    } catch {
      // tmux unreachable: unknown-not-dead reads as alive here; the plane's
      // next live session reconciles the same rows through the same census.
    }
    rows.push({
      subshellId: meta.subshellId,
      alive,
      exitCode: alive ? null : await ctx.tmux.paneExitCode(s, meta.subshellId).catch(() => null),
    });
  }
  return rows;
}

/** Panes already living on the destination socket at hello time (the reconcile count; tmux silence reads as 0, never a failed hello). */
function countSocketPanes(tmux: TmuxRunner, socket: string): number {
  try {
    return tmux.listSubshellNames(socket).length;
  } catch {
    return 0;
  }
}

/** Map the node-link event vocabulary onto runtime event frames (design §2: the runtime event set is `NodeEvent` minus the link-management arms; those arms never originate here, and the default branch is the belt). */
function mapNodeEventToRuntimeFrame(ev: NodeEvent): SshRuntimeEventFrame | null {
  switch (ev.type) {
    case "output":
      return {
        type: "output",
        subshellId: ev.subshellId,
        subId: ev.subId,
        fromByte: ev.fromByte,
        toByte: ev.toByte,
        data_b64: ev.data_b64,
      };
    case "exit":
      return { type: "exit", subshellId: ev.subshellId, exitCode: ev.exitCode, at: ev.at };
    case "subshells_report":
      return { type: "subshells_report", subshells: ev.subshells };
    case "result":
      return ev.ok
        ? { type: "result", ref: ev.ref, ok: true, ...(ev.data !== undefined ? { data: ev.data } : {}) }
        : { type: "result", ref: ev.ref, ok: false, error: ev.error };
    default:
      return null;
  }
}

/**
 * Stop this process's OWN resources: the tail pumps (they write stdout) and
 * the callback socket. The destination's tmux server and every pane on it are
 * deliberately untouched (design §6: tmux and panes keep running under the
 * destination user); stdout bytes already in the pipe drain when the process
 * exits, which is the last write this function orders.
 */
function shutdown(callback: Awaited<ReturnType<typeof startCallbackSocket>>, ctx: CommandContext): number {
  for (const [, handle] of [...ctx.tails]) {
    try {
      handle.stop();
    } catch {
      /* idempotent by contract */
    }
  }
  ctx.tails.clear();
  if (ctx.watchTick !== undefined) clearInterval(ctx.watchTick);
  void callback.stop().catch(() => {});
  return 0;
}

/** The frame's `ref` for the throw-path error, read from the raw object without trusting its grammar. */
function extractRef(raw: unknown): string | null {
  if (raw !== null && typeof raw === "object" && "ref" in raw && typeof (raw as { ref: unknown }).ref === "string") {
    return (raw as { ref: string }).ref;
  }
  return null;
}
