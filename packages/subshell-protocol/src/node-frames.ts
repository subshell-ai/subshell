import { BASE64_RE, isBool, isInt, isNum, isRecord, isStr } from "./guards.js";
import type { JsonValue } from "./json.js";

/**
 * Node ↔ control-plane wire contract (spec 2026-08-31 §3).
 *
 * The transport is a websocket dialed OUT by the agent (`GET /ws/node`,
 * bearer-authed at upgrade). Commands travel control-plane → agent inside a
 * signed JWS envelope (see node-signing.ts); events travel agent → control
 * unsigned — the socket itself is authenticated by the node key, so events
 * inherit exactly the node key's trust (spec §3.3, §12.6).
 */

/**
 * Bumped on any frame-shape change; the control plane accepts the window
 * {@link NODE_PROTOCOL_MIN_VERSION} .. this value and closes everything else
 * with UPDATE_REQUIRED (4406).
 * v2 (2026-09-02): the sessions→subshells rename changed frozen frame keys
 * (`sessionId`→`subshellId`, `sessions_report`→`subshells_report`, …), so a
 * pre-rename agent must be refused — the backend answers `ready` with close
 * UPDATE_REQUIRED (4406) and the Nodes page shows the "agent too old" chip.
 * v3 (2026-09-03): additive `fs_ls` command (remote folder picker). No frozen
 * frame changed, so v2 agents are NOT refused — they keep full service and
 * only folder browsing is gated (server-side feature check against
 * {@link FS_LS_MIN_PROTOCOL_VERSION}).
 */
export const NODE_PROTOCOL_VERSION = 3;

/**
 * Oldest agent protocol the control plane still speaks. Bump ONLY when a
 * change breaks frames already frozen at an older version (the v2 rename is
 * what put the floor at 2); additive commands raise
 * {@link FS_LS_MIN_PROTOCOL_VERSION}-style constants instead, so an in-window
 * agent degrades per-feature rather than losing its socket.
 */
export const NODE_PROTOCOL_MIN_VERSION = 2;

/**
 * First protocol version whose agent answers `fs_ls`. The control plane
 * feature-gates folder browsing on the node's reported version (below this ⇒
 * a clear "node too old" 409, never a doomed command).
 */
export const FS_LS_MIN_PROTOCOL_VERSION = 3;

/**
 * Frame ceiling both directions (spec §3.1). Bun's `maxPayloadLength` is
 * GLOBAL to the server, so each handler enforces this by byte length on
 * inbound messages rather than relying on server config (spec §7).
 */
export const NODE_MAX_FRAME_BYTES = 1_048_576;

/* ------------------------------------------------------------------ */
/* shared close codes (phase-2 hoist)                                   */
/* ------------------------------------------------------------------ */

/**
 * Close: the agent speaks a node protocol the control plane refuses — the
 * agent binary must be updated (spec §5.3). Emitted by the backend's
 * `/ws/node` handler (aliased there as `NODE_CLOSE_PROTOCOL`); terminal for
 * the agent, which imports this constant by name.
 */
export const NODE_CLOSE_UPDATE_REQUIRED = 4406;

/**
 * Close: newest-wins replace — a second agent dialed with this node's
 * identity, so the older socket is kicked (spec §5.3). Emitted by the backend
 * registry (aliased there as `REPLACE_CLOSE_CODE`); terminal for the
 * superseded agent.
 *
 * The other two node close codes — 4401 (no verified identity) and 1009
 * (message too big) — stay handler-local in `node-ws-handler.ts` because only
 * the backend ever emits them.
 */
export const NODE_CLOSE_SUPERSEDED = 4409;

/* ------------------------------------------------------------------ */
/* subshell-id policy                                                    */
/* ------------------------------------------------------------------ */

/**
 * The uuid-ish subshell-id guard: ids interpolated into node-side paths;
 * wire contract shared by backend RemoteLauncher gates and the agent path
 * policy (the agent's `isSubshellId` is an alias of this; the backend's
 * `SUBSHELL_ID_RE` mirrors it until its wave adopts the import). Subshell ids
 * are minted as uuids, so hex + hyphen (≤ 64 chars) is all a legitimate id
 * ever contains — a hostile `../../../../x` must never reach path
 * interpolation on either side of the link.
 */
export function isNodeSubshellId(id: string): boolean {
  return /^[0-9a-fA-F-]{1,64}$/.test(id);
}

/**
 * Structural JSON mirror of `@internal/harnesses`' `ProfileDefinition`.
 *
 * Deliberately a copy: subshell-protocol is bundled by the frontend and must
 * not pull harnesses (which imports node:fs) at runtime (spec §3.2). The
 * agent decodes the blob against the real `ProfileDefinition` at launch.
 */
export interface ProfileDefinitionWire {
  /** Human-friendly profile name */
  name: string;
  /** Optional longer description */
  description?: string | null;
  /** Extra environment variables to set on the subshell (validated key names) */
  env: Record<string, string>;
  /** Extra CLI flags to pass to the harness binary */
  flags: string[];
  /** Settings blob passed to the harness (opaque JSON) */
  settings: Record<string, unknown> | null;
  /** If true, only this profile's config sources apply (isolation) */
  configIsolation: boolean;
  /** If true, new subshells from this profile auto-restart on exit */
  restartOnExit?: boolean;
}

/** Resume pin carried on `launch` (mirrors BuildCommandInput.harnessSession). */
export interface HarnessSessionWire {
  /** Harness-side conversation id */
  id: string;
  /** "start" mints a new id; "resume" continues the given one */
  mode: "start" | "resume";
}

/** Control-plane → agent command payloads — the JWS `cmd` claim (spec §3.2). */
export type NodeCommandBody =
  | {
      /** Start a harness pane: cwd + env + argv inputs, MCP file, output log path */
      type: "launch";
      /** subshell id */
      subshellId: string;
      /** tmux socket name (tmuxSocketFor(subshellId)) */
      socket: string;
      /** Absolute working dir ON THE NODE (already stat-verified via stat_dir) */
      cwd: string;
      /** Harness plugin id */
      harnessId: string;
      /** Launch config (mirror of harnesses ProfileDefinition) */
      profile: ProfileDefinitionWire;
      /** SUBSHELL_* credential env, supplied by the control plane */
      subshellEnv: Record<string, string>;
      /** MCP registration file the agent writes (0600) before spawning */
      mcp?: { path: string; fileContent: string };
      /** Resume pin for harnesses that support it */
      harnessSession?: HarnessSessionWire;
      /** tmux subshell name (the subshell id) */
      subshellName: string;
      /** Initial terminal geometry */
      cols?: number;
      /** Initial terminal geometry */
      rows?: number;
      /**
       * Revive parity (phase-2): when true the agent downgrades a log-attach
       * failure (subshells-dir mkdir + pipe-pane) to a logged note and still
       * answers `{ ok: true }` — the pane is live. Wire twin of
       * `LaunchPlan.bestEffortLog`; absent ⇒ a log failure fails the launch
       * (today's behavior).
       */
      bestEffortLog?: boolean;
    }
  | { type: "terminate"; subshellId: string }
  | { type: "kill"; subshellId: string }
  | { type: "input"; subshellId: string; data: string }
  | { type: "resize"; subshellId: string; cols: number; rows: number }
  | {
      /** Agent-side prompt settle loop: capture-poll until the pane is quiet, type + Enter */
      type: "prompt_deliver";
      subshellId: string;
      text: string;
      settleTimeoutMs: number;
      pollMs: number;
    }
  | {
      /** Pane snapshot; optional `lines` prepends that many reflowed history rows (attach replay). */
      type: "capture";
      subshellId: string;
      /** Optional scrollback budget for the capture. Absent from (and stripped by) pre-replay agents. */
      lines?: number;
    }
  | { type: "probe"; subshellIds: string[] }
  | { type: "probe_resume"; harnessId: string; harnessSessionId: string; cwd: string }
  | { type: "stat_dir"; path: string }
  | {
      /**
       * One-level directory listing for the folder picker (protocol v3,
       * additive). Empty `path` = the AGENT's home directory (the control
       * plane cannot expand `~` against a filesystem it cannot see);
       * anything else is absolute by contract and enforced agent-side. The
       * answer is the `NodeFsLsResult` shape (`node-results.ts`) — directories
       * only, dotfiles hidden, capped.
       */
      type: "fs_ls";
      path: string;
    }
  | { type: "log_read"; subshellId: string; fromByte: number; maxBytes: number }
  | { type: "tail_start"; subshellId: string; subId: string; fromByte: number }
  | { type: "tail_stop"; subId: string }
  | { type: "remove_paths"; paths: string[] }
  | { type: "inventory" }
  | {
      /** Chunked file write (terminal uploads relay, spec §3.4) */
      type: "write_file";
      path: string;
      chunk_b64: string;
      chunk: number;
      eof: boolean;
    }
  | { type: "ping" };

/** Agent → control events, unsigned (socket-authed; spec §3.3). */
export type NodeEvent =
  | {
      type: "ready";
      agentVersion: string;
      protocolVersion: number;
      os: "linux" | "darwin" | "unknown";
      arch: string;
      hostname: string;
      dataDir: string;
      capabilities: string[];
      /**
       * Absolute path of the running subshell binary on the node; the
       * control plane composes the MCP launch spec against it. Absent from
       * pre-phase-2 agents.
       */
      executablePath?: string;
    }
  | {
      type: "inventory";
      harnesses: { harnessId: string; installed: boolean; version?: string; binaryPath?: string }[];
      ts: string;
    }
  | { type: "heartbeat"; ts: string }
  | { type: "result"; ref: string; ok: true; data?: JsonValue }
  | { type: "result"; ref: string; ok: false; error: string }
  | { type: "output"; subshellId: string; subId: string; fromByte: number; toByte: number; data_b64: string }
  | { type: "exit"; subshellId: string; exitCode: number | null; at: string }
  | { type: "subshells_report"; subshells: { subshellId: string; alive: boolean; exitCode: number | null }[] }
  | { type: "error"; code: string; message: string };

/* ------------------------------------------------------------------ */
/* validators (hand-rolled, parseClientFrame style — spec §3)          */
/* ------------------------------------------------------------------ */

function isStrArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isStr);
}
function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isStr);
}
/** Cheap recursive structural check that a value is a JSON value (no undefined/functions/NaN). */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : isRecord(value) && Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

function validProfileWire(p: unknown): p is ProfileDefinitionWire {
  if (!isRecord(p) || !isStr(p.name)) return false;
  if (!isStringMap(p.env)) return false;
  if (!isStrArray(p.flags)) return false;
  if (!("settings" in p) || !(p.settings === null || isRecord(p.settings))) return false;
  if (!isBool(p.configIsolation)) return false;
  if ("description" in p && p.description !== undefined && p.description !== null && !isStr(p.description))
    return false;
  if ("restartOnExit" in p && p.restartOnExit !== undefined && !isBool(p.restartOnExit)) return false;
  return true;
}

/**
 * Validates and narrows an arbitrary value (JWS `cmd` payload, parsed JSON,
 * or a pre-parsed object) to a known command. Unknown fields are dropped by
 * the returned copy on well-understood commands only where cheap; the
 * contract is that a NON-null return is safe to switch on by `type`.
 * @param value - candidate payload (typically JWT `cmd` claim)
 * @returns the narrowed command, or null when malformed/unknown
 */
export function parseNodeCommandBody(value: unknown): NodeCommandBody | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "launch": {
      if (!isStr(value.subshellId) || !isStr(value.socket) || !isStr(value.cwd) || !isStr(value.harnessId)) return null;
      if (!validProfileWire(value.profile) || !isStringMap(value.subshellEnv)) return null;
      if (!isStr(value.subshellName)) return null;
      if ("mcp" in value) {
        const m = value.mcp;
        if (!isRecord(m) || !isStr(m.path) || !isStr(m.fileContent)) return null;
      }
      if ("harnessSession" in value) {
        const h = value.harnessSession;
        if (!isRecord(h) || !isStr(h.id) || (h.mode !== "start" && h.mode !== "resume")) return null;
      }
      if ("cols" in value && !(isInt(value.cols) && (value.cols as number) > 0)) return null;
      if ("rows" in value && !(isInt(value.rows) && (value.rows as number) > 0)) return null;
      if ("bestEffortLog" in value && !isBool(value.bestEffortLog)) return null;
      return value as unknown as NodeCommandBody;
    }
    case "terminate":
    case "kill":
      return isStr(value.subshellId) ? ({ type: value.type, subshellId: value.subshellId } as NodeCommandBody) : null;
    case "capture": {
      if (!isStr(value.subshellId)) return null;
      // Additive optional field (protocol v1 unchanged): a positive int or
      // absent. An agent predating the field strips this key here and answers
      // with the visible grid only — the old replay, no refusal.
      if ("lines" in value) {
        if (!isInt(value.lines) || (value.lines as number) <= 0) return null;
        return { type: "capture", subshellId: value.subshellId, lines: value.lines as number };
      }
      return { type: "capture", subshellId: value.subshellId };
    }
    case "input":
      return isStr(value.subshellId) && isStr(value.data) ? (value as unknown as NodeCommandBody) : null;
    case "resize":
      return isStr(value.subshellId) &&
        isInt(value.cols) &&
        isInt(value.rows) &&
        (value.cols as number) > 0 &&
        (value.rows as number) > 0
        ? (value as unknown as NodeCommandBody)
        : null;
    case "prompt_deliver":
      return isStr(value.subshellId) &&
        isStr(value.text) &&
        isNum(value.settleTimeoutMs) &&
        (value.settleTimeoutMs as number) > 0 &&
        isNum(value.pollMs) &&
        (value.pollMs as number) > 0
        ? (value as unknown as NodeCommandBody)
        : null;
    case "probe":
      return isStrArray(value.subshellIds) ? { type: "probe", subshellIds: value.subshellIds } : null;
    case "probe_resume":
      return isStr(value.harnessId) && isStr(value.harnessSessionId) && isStr(value.cwd)
        ? { type: "probe_resume", harnessId: value.harnessId, harnessSessionId: value.harnessSessionId, cwd: value.cwd }
        : null;
    case "stat_dir":
      return isStr(value.path) ? { type: "stat_dir", path: value.path } : null;
    case "fs_ls":
      // Same shape of gate as stat_dir: a string path; emptiness is legal
      // (agent-side "my home"), absoluteness is the agent's to enforce.
      return isStr(value.path) ? { type: "fs_ls", path: value.path } : null;
    case "log_read":
      return isStr(value.subshellId) &&
        isInt(value.fromByte) &&
        isInt(value.maxBytes) &&
        (value.fromByte as number) >= 0 &&
        (value.maxBytes as number) > 0
        ? (value as unknown as NodeCommandBody)
        : null;
    case "tail_start":
      return isStr(value.subshellId) && isStr(value.subId) && isInt(value.fromByte) && (value.fromByte as number) >= 0
        ? { type: "tail_start", subshellId: value.subshellId, subId: value.subId, fromByte: value.fromByte }
        : null;
    case "tail_stop":
      return isStr(value.subId) ? { type: "tail_stop", subId: value.subId } : null;
    case "remove_paths":
      return isStrArray(value.paths) ? { type: "remove_paths", paths: value.paths } : null;
    case "inventory":
      return { type: "inventory" };
    case "write_file":
      return isStr(value.path) &&
        isStr(value.chunk_b64) &&
        BASE64_RE.test(value.chunk_b64) &&
        isInt(value.chunk) &&
        (value.chunk as number) >= 0 &&
        isBool(value.eof)
        ? { type: "write_file", path: value.path, chunk_b64: value.chunk_b64, chunk: value.chunk, eof: value.eof }
        : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

/**
 * Validates and narrows an inbound agent frame (raw JSON text or the
 * already-parsed object — Elysia's ws middleware pre-parses JSON).
 * @param raw - frame as received
 * @returns the narrowed event, or null when malformed/unknown
 */
export function parseNodeEvent(raw: string | object): NodeEvent | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "ready":
      return isStr(value.agentVersion) &&
        isInt(value.protocolVersion) &&
        (value.os === "linux" || value.os === "darwin" || value.os === "unknown") &&
        isStr(value.arch) &&
        isStr(value.hostname) &&
        isStr(value.dataDir) &&
        isStrArray(value.capabilities) &&
        (!("executablePath" in value) || isStr(value.executablePath))
        ? (value as unknown as NodeEvent)
        : null;
    case "inventory": {
      if (!isStr(value.ts) || !Array.isArray(value.harnesses)) return null;
      for (const h of value.harnesses) {
        if (!isRecord(h) || !isStr(h.harnessId) || !isBool(h.installed)) return null;
        if ("version" in h && !isStr(h.version)) return null;
        if ("binaryPath" in h && !isStr(h.binaryPath)) return null;
      }
      return value as unknown as NodeEvent;
    }
    case "heartbeat":
      return isStr(value.ts) ? { type: "heartbeat", ts: value.ts } : null;
    case "result":
      if (!isStr(value.ref) || !isBool(value.ok)) return null;
      if (value.ok) {
        // Only include `data` when the key is present, and then only if it is a real JSON value.
        if (!("data" in value)) return { type: "result", ref: value.ref, ok: true };
        return isJsonValue(value.data) ? { type: "result", ref: value.ref, ok: true, data: value.data } : null;
      }
      return isStr(value.error) ? { type: "result", ref: value.ref, ok: false, error: value.error } : null;
    case "output":
      return isStr(value.subshellId) &&
        isStr(value.subId) &&
        isInt(value.fromByte) &&
        isInt(value.toByte) &&
        (value.fromByte as number) >= 0 &&
        (value.toByte as number) >= (value.fromByte as number) &&
        isStr(value.data_b64) &&
        BASE64_RE.test(value.data_b64)
        ? (value as unknown as NodeEvent)
        : null;
    case "exit":
      return isStr(value.subshellId) && isStr(value.at) && (value.exitCode === null || isInt(value.exitCode))
        ? (value as unknown as NodeEvent)
        : null;
    case "subshells_report": {
      if (!Array.isArray(value.subshells)) return null;
      for (const s of value.subshells) {
        if (!isRecord(s) || !isStr(s.subshellId) || !isBool(s.alive)) return null;
        if (!(s.exitCode === null || isInt(s.exitCode))) return null;
      }
      return value as unknown as NodeEvent;
    }
    case "error":
      return isStr(value.code) && isStr(value.message)
        ? { type: "error", code: value.code, message: value.message }
        : null;
    default:
      return null;
  }
}
