/**
 * SSH session-runtime wire frames (design 2026-10-05 §2/§3): the node-link
 * command family that brokers a session (`ssh_session_open/send/close`, the
 * new `session_frame` event arm in `node-frames.ts`) and the RUNTIME-LINK
 * frames that ride the SSH child's stdio inside it (hello, the plane's
 * command frames, the runtime's event frames, the callback request/response
 * pair).
 *
 * Two grammars, one file, because they are one feature viewed from its two
 * halves: the node link speaks signed plain objects (like the SSH family
 * before them, these are TRANSPORT-AGNOSTIC - the socket/jti/signature belong
 * to the transport and live outside the body), and the runtime link speaks
 * length-prefixed JSON frames (`ssh-session-codec.ts`) whose own version
 * namespace is `runtimeProtocol`, deliberately separate from
 * {@link NODE_PROTOCOL_VERSION} so a runtime rebuild never forces a node-link
 * bump. The node link IS bumped by the new commands (17), the runtime link
 * is not versioned by it.
 *
 * Hand-rolled in the `ssh-frames.ts` style; imports no `node:` builtin;
 * lives in the Metro-safe barrel. Result ENVELOPE validation for the open
 * command lives in `node-results.ts` beside every other result validator
 * (the four-site rule the integration maps name).
 */

import { BASE64_RE, isBool, isInt, isRecord, isStr, isStrArray } from "./guards.js";
// TYPE-ONLY import: no runtime cycle with `node-frames.ts`, which value-imports
// this file's arm parser. The launch body is the node link's OWN command shape
// so a runtime pane and a node-link pane are launched by one grammar (the
// design's "mirror the node command bodies, minus crypto").
import type { NodeCommandBody } from "./node-frames.js";
import {
  SSH_NAME_MAX_CHARS,
  SSH_PATH_MAX_CHARS,
  SSH_SESSION_INBOUND_QUEUE_FRAMES,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSIONS_PER_NODE,
} from "./ssh-limits.js";

// Re-exported for consumers that read the session surface from this file; the
// NUMBERS live in ssh-limits.ts beside every other row of the limits table.
export { SSH_SESSION_INBOUND_QUEUE_FRAMES, SSH_SESSION_OPEN_DEADLINE_MS, SSH_SESSIONS_PER_NODE };

/** The node link's `launch` body, reused verbatim as the runtime launch frame's payload. */
export type SshRuntimeLaunchBody = Extract<NodeCommandBody, { type: "launch" }>;

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * The runtime link's version namespace (design §2). MAINTENANCE-COMPATIBLE
 * ONLY within one major: the plane refuses a major mismatch by name and says
 * what it saw. Bump the SECOND number for additive frames a runtime may
 * ignore; bump the FIRST when a runtime must understand something new.
 */
export const SSH_RUNTIME_PROTOCOL = 1;

/**
 * The runtime-probe refusal, answered as the BARE code in `result{error}`
 * like every equality-mapped refusal. The design names it
 * `SSH_RUNTIME_MISSING`; it joins the lowercase `SSH_ERROR_CODES` family
 * because the set is code-shaped data (`config_missing`), and the name that
 * ships IS the code that answers. The remedy it names is the binary install
 * ONLY - never enrollment, never `subshell setup` (design §7).
 */
export const SSH_SESSION_RUNTIME_MISSING = "runtime_missing";

/** A brokered session the node has no live child for (send/close on an unknown or dead ref). */
export const SSH_SESSION_UNKNOWN = "session_unknown";

/* ------------------------------------------------------------------ */
/* node-link command family (plane -> connecting node)                 */
/* ------------------------------------------------------------------ */

/**
 * One brokered session's destination, as the OPEN command names it. Deliberately
 * narrower than the full approved snapshot: the session flow reviews the
 * concrete `host:port user` at the plane, and the broker renders ssh argv from
 * exactly these facts under the mandatory policy (design §3). Identity file is
 * a PATH REF on the connecting node, never key material; null means ssh's own
 * default identity set for the connecting account.
 *
 * A `type` alias, not an interface: these ride inside JSON command fields.
 */
export type SshSessionTargetWire = {
  /** The config token the human chose (display + review context; routing uses host). */
  alias: string;
  /** Destination hostname or IP literal. Never option-like (the parser refuses a leading `-`). */
  host: string;
  /** Destination port, 1..65535 (no implicit-22 magic: the reviewer saw the number). */
  port: number;
  /** Destination account; null = the connecting account's own default. */
  user: string | null;
  /** Absolute identity-file ref on the connecting node, or null for the account's defaults. */
  identityFile: string | null;
};

/** New brokered-session command: probe the runtime, then spawn the SSH child and pump its stdio (design §3). */
export interface SshSessionOpenCommand {
  type: "ssh_session_open";
  /** Plane-minted session ref (the routing key on every frame and event; see {@link isSshSessionRef}). */
  ref: string;
  /** The reviewed destination. */
  target: SshSessionTargetWire;
  /**
   * Plane-supplied override of the remote program, default `"subshell"`. NOT a
   * user-facing field: the slice's tests pass an absolute wrapper path. The
   * node owner can already run any command on that host through their own
   * SSH, so composing the remote command from this token is not a widening -
   * the per-token quoting through the login-shell boundary is what keeps it
   * one program invocation rather than shell soup.
   */
  runtimeCommand?: string;
}

/** Feed plane->runtime bytes into the child's stdin (the runtime frames themselves are the body; the broker never parses them). */
export interface SshSessionSendCommand {
  type: "ssh_session_send";
  /** The session ref. */
  ref: string;
  /** Base64 of the raw bytes to write (may be a partial frame; the ends' codecs reassemble). */
  data_b64: string;
}

/** Close one session: kill the child's group, answer once. Unknown refs answer the bare {@link SSH_SESSION_UNKNOWN}. */
export interface SshSessionCloseCommand {
  type: "ssh_session_close";
  /** The session ref. */
  ref: string;
}

/** Every session command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshSessionNodeCommandBody = SshSessionOpenCommand | SshSessionSendCommand | SshSessionCloseCommand;

/** Every session command `type`, for census tests and dispatch tables. */
export const SSH_SESSION_COMMAND_TYPES = ["ssh_session_open", "ssh_session_send", "ssh_session_close"] as const;

/* ------------------------------------------------------------------ */
/* hello + open result (runtime facts the broker returns after parsing the first frame) */
/* ------------------------------------------------------------------ */

/**
 * The runtime's first frame (design §2, verbatim shape):
 * `{ type: "hello", runtimeProtocol, agentVersion, os, arch, capabilities,
 * homeDir, dataDir, tmuxSocket, paneCount }`.
 *
 * `os` is NOT constrained to the node link's three values: a runtime answers
 * with `process.platform`-class text its own plane copy may not have seen,
 * and refusing a new OS over a display field is how a fleet gets stranded.
 * The grammar wants a non-empty name.
 */
export type SshRuntimeHelloWire = {
  type: "hello";
  /** The runtime link's protocol; the plane refuses a major mismatch by name. */
  runtimeProtocol: number;
  /** The runtime binary's version string (also the session's `runtimeVersion`). */
  agentVersion: string;
  /** OS name as the destination reports it. */
  os: string;
  /** Architecture as the destination reports it. */
  arch: string;
  /** Capability labels this runtime build advertises (opaque to the grammar). */
  capabilities: string[];
  /** The destination account's home directory. */
  homeDir: string;
  /** The runtime's data dir (a `runtime/` namespace, isolated from any enrolled daemon's). */
  dataDir: string;
  /** The deterministic per-destination tmux socket the runtime serves. */
  tmuxSocket: string;
  /** Panes already living on that socket at hello time (the reconcile count; 0 for a fresh destination). */
  paneCount: number;
};

/**
 * The `ssh_session_open` result data: the parsed hello plus the concrete
 * destination the child really dialed, plus the connecting account's name
 * (a display fact, like the old resolve outcome's `connectingAccount`).
 * Identity files, config contents and key material never enter this shape -
 * the broker answers facts, and every field here is facts.
 */
export type SshSessionOpenResultWire = {
  hello: SshRuntimeHelloWire;
  host: string;
  port: number;
  /** The destination account, or null when the connecting account's default was used. */
  user: string | null;
  /** The connecting node's OS account name (display fact of the machine that dialed). */
  connectingAccount?: string;
};

/* ------------------------------------------------------------------ */
/* runtime-link frames (plane <-> runtime, inside the pumped stdio)    */
/* ------------------------------------------------------------------ */

/**
 * A plane->runtime command frame. Bodies mirror the node command shapes the
 * runtime needs, MINUS crypto and minus the plane-machine indirection the
 * node link carries (no preset blob, no resolve rule, no signed jti): the
 * runtime IS on the destination, so `cwd` and paths are already destination
 * paths. `ref` correlates the runtime's `result{ref}` answer; the plane mints
 * it per command.
 */
export type SshRuntimeCommandFrame =
  /**
   * Start a pane. The body is the node link's `launch` command VERBATIM
   * (`SshRuntimeLaunchBody`), so a runtime pane is launched by the identical
   * grammar and the runtime answers it with the identical executor: plane
   * builds argv from the plugin it holds, the runtime late-binds the
   * destination's binary exactly as a node would. The RUNTIME re-validates
   * `cmd` through `parseNodeCommandBody` before dispatch (the deep check
   * lives in the node grammar, not twice here); the slice's plane side sends
   * terminal launches only, and every other harness would ride the same body.
   */
  | { type: "launch"; ref: string; cmd: SshRuntimeLaunchBody }
  | { type: "input"; ref: string; subshellId: string; data: string }
  | { type: "terminate"; ref: string; subshellId: string }
  | { type: "kill"; ref: string; subshellId: string }
  | { type: "capture"; ref: string; subshellId: string; lines?: number }
  | { type: "resize"; ref: string; subshellId: string; cols: number; rows: number }
  | { type: "pane_size"; ref: string; subshellId: string }
  | { type: "pane_cursor"; ref: string; subshellId: string }
  | { type: "probe"; ref: string; subshellIds: string[] }
  | { type: "log_read"; ref: string; subshellId: string; fromByte: number; maxBytes: number }
  | { type: "tail_start"; ref: string; subshellId: string; subId: string; fromByte: number }
  | { type: "tail_stop"; ref: string; subId: string }
  /** Directory listing for the remote picker (the design's `list_dirs`; the runtime answers it with the same executor the node link's `fs_ls` uses). */
  | { type: "list_dirs"; ref: string; path: string }
  | { type: "stat_dir"; ref: string; path: string }
  | { type: "remove_paths"; ref: string; paths: string[] }
  /** Ask for a fresh alive/dead census of every pane the runtime tracks (the reconcile ride; design §6). */
  | { type: "subshells_report"; ref: string }
  /** Deliver the callback answer for one `rest_request` (the plane's side of the §5 round trip). */
  | {
      type: "rest_response";
      reqId: string;
      /** HTTP status the plane chose for the pane; the runtime relays it verbatim on the socket. */
      status: number;
      /** Response body text (JSON from the route, or a refusal sentence); may be empty. */
      body?: string;
    }
  /** Graceful end: the runtime forwards its final report, closes the socket, exits 0. tmux and panes stay up (design §6). */
  | { type: "close"; ref: string };

/** A runtime->plane event frame (design §2: mirror `NodeEvent`, minus the link-management arms that belong to the broker). */
export type SshRuntimeEventFrame =
  | SshRuntimeHelloWire
  | { type: "result"; ref: string; ok: true; data?: unknown }
  | { type: "result"; ref: string; ok: false; error: string }
  | { type: "output"; subshellId: string; subId: string; fromByte: number; toByte: number; data_b64: string }
  | { type: "exit"; subshellId: string; exitCode: number | null; at: string }
  | { type: "subshells_report"; subshells: { subshellId: string; alive: boolean; exitCode: number | null }[] }
  /**
   * A pane's callback over `callback.sock`, forwarded bounded (design §5).
   * The plane answers with a `rest_response` carrying the same `reqId`.
   */
  | { type: "rest_request"; reqId: string; method: string; path: string; body?: string };

/* ------------------------------------------------------------------ */
/* arm validators                                                      */
/* ------------------------------------------------------------------ */

/**
 * The session ref grammar: hex+hyphen, <= 64, the same shape
 * `isNodeSubshellId` pins for anything interpolated into a node-side path
 * (the run family's `isSshRunId` is this exact local twin, for the same
 * cycle-avoidance reason: `node-frames.ts` imports this file, so this file
 * may not import the guard from it).
 */
export function isSshSessionRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F-]{1,64}$/.test(value);
}

/** Same hygiene the SSH family applies to names. */
function isAliasName(value: unknown): value is string {
  return (
    isStr(value) &&
    value.length > 0 &&
    value.length <= SSH_NAME_MAX_CHARS &&
    !value.startsWith("-") &&
    !/\s|\p{Cc}/u.test(value)
  );
}

/** Destination host: the snapshot grammar's shape (DNS-ish labels or bracketed IPv6), refused option-like at the lead. */
function isSessionHost(value: unknown): value is string {
  if (!isStr(value) || value.length === 0 || value.length > SSH_NAME_MAX_CHARS) return false;
  return /^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/.test(value);
}

/** Destination account: the characters ssh's `user@host` split and PAM actually meet. */
function isSessionUser(value: unknown): value is string {
  return isStr(value) && /^[A-Za-z0-9._-]+$/.test(value) && value.length <= SSH_NAME_MAX_CHARS;
}

/** An absolute POSIX path ref (shape only; existence and ownership are the node's). */
function isAbsRef(value: unknown): value is string {
  return isStr(value) && value.startsWith("/") && value.length <= SSH_PATH_MAX_CHARS && !/\p{Cc}/u.test(value);
}

/**
 * Validates and narrows one session target. A non-null return is safe to
 * render: the broker still re-runs it (defense in depth, the snapshot rule),
 * and the mandatory policy is what makes the render itself deny-by-default.
 */
export function parseSshSessionTarget(value: unknown): SshSessionTargetWire | null {
  if (!isRecord(value)) return null;
  if (!isAliasName(value.alias) || !isSessionHost(value.host)) return null;
  if (!isInt(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) return null;
  if (!("user" in value) || !(value.user === null || isSessionUser(value.user))) return null;
  if ("identityFile" in value && !(value.identityFile === null || isAbsRef(value.identityFile))) return null;
  return {
    alias: value.alias,
    host: value.host,
    port: value.port as number,
    user: (value.user ?? null) as string | null,
    identityFile: (value.identityFile ?? null) as string | null,
  };
}

/**
 * Validates and narrows any `ssh_session_*` command body. `parseNodeCommandBody`
 * routes its three arms here, so the session grammar lives in ONE file beside
 * the commands it narrows (the `ssh-frames.ts` precedent).
 *
 * @param value - candidate payload whose `type` starts with `ssh_session_`
 * @returns the narrowed command, or null when malformed
 */
export function parseSshSessionNodeCommandBody(value: unknown): SshSessionNodeCommandBody | null {
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "ssh_session_open": {
      if (!isSshSessionRef(value.ref)) return null;
      const target = parseSshSessionTarget(value.target);
      if (target === null) return null;
      if ("runtimeCommand" in value) {
        // A program name or absolute path - never shell syntax, never option-like
        // (a leading `-` would ride into the composed remote command as a flag).
        if (!isStr(value.runtimeCommand) || value.runtimeCommand.length === 0) return null;
        if (value.runtimeCommand.length > SSH_PATH_MAX_CHARS || /\s|\p{Cc}/u.test(value.runtimeCommand)) return null;
        if (value.runtimeCommand.startsWith("-")) return null;
        if (!value.runtimeCommand.startsWith("/") && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.runtimeCommand))
          return null;
        return {
          type: "ssh_session_open",
          ref: value.ref,
          target,
          runtimeCommand: value.runtimeCommand,
        };
      }
      return { type: "ssh_session_open", ref: value.ref, target };
    }
    case "ssh_session_send":
      return isSshSessionRef(value.ref) && isStr(value.data_b64) && BASE64_RE.test(value.data_b64)
        ? { type: "ssh_session_send", ref: value.ref, data_b64: value.data_b64 }
        : null;
    case "ssh_session_close":
      return isSshSessionRef(value.ref) ? { type: "ssh_session_close", ref: value.ref } : null;
    default:
      return null;
  }
}

/** Validates and narrows the runtime's hello frame; null is a refused open (fail-closed, never a partial trust). */
export function parseSshRuntimeHello(value: unknown): SshRuntimeHelloWire | null {
  if (!isRecord(value) || value.type !== "hello") return null;
  if (!isInt(value.runtimeProtocol) || (value.runtimeProtocol as number) < 1) return null;
  if (!isStr(value.agentVersion) || value.agentVersion.length === 0) return null;
  if (!isStr(value.os) || value.os.length === 0 || !isStr(value.arch) || value.arch.length === 0) return null;
  if (!isStrArray(value.capabilities)) return null;
  if (!isAbsRef(value.homeDir) || !isAbsRef(value.dataDir)) return null;
  if (!isStr(value.tmuxSocket) || value.tmuxSocket.length === 0 || !/^[A-Za-z0-9._-]+$/.test(value.tmuxSocket))
    return null;
  if (!isInt(value.paneCount) || (value.paneCount as number) < 0) return null;
  return {
    type: "hello",
    runtimeProtocol: value.runtimeProtocol as number,
    agentVersion: value.agentVersion,
    os: value.os,
    arch: value.arch,
    capabilities: [...value.capabilities],
    homeDir: value.homeDir,
    dataDir: value.dataDir,
    tmuxSocket: value.tmuxSocket,
    paneCount: value.paneCount as number,
  };
}

/** Validates and narrows the `ssh_session_open` result data (the broker's answer after eating the hello). */
export function parseSshSessionOpenResult(value: unknown): SshSessionOpenResultWire | null {
  if (!isRecord(value)) return null;
  const hello = parseSshRuntimeHello(value.hello);
  if (hello === null) return null;
  if (!isSessionHost(value.host)) return null;
  if (!isInt(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) return null;
  if (!("user" in value) || !(value.user === null || isSessionUser(value.user))) return null;
  if ("connectingAccount" in value && value.connectingAccount !== undefined && !isStr(value.connectingAccount))
    return null;
  return {
    hello,
    host: value.host,
    port: value.port as number,
    user: value.user as string | null,
    ...(typeof value.connectingAccount === "string" ? { connectingAccount: value.connectingAccount } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* runtime-link frame parsers                                          */
/* ------------------------------------------------------------------ */

/** One non-empty bounded string (paths and text bodies on the runtime link; the grammar refuses nonsense, callers enforce policy). */
function _isNonEmptyStr(value: unknown): value is string {
  return isStr(value) && value.length > 0 && value.length <= SSH_PATH_MAX_CHARS;
}

/** The shared shape of the pane-keyed command arms; null when `value` fits no pane arm. */
function parsePaneCommand(value: Record<string, unknown>): SshRuntimeCommandFrame | null {
  if (!isSshSessionRef(value.ref)) return null;
  // `subshellId` is per-arm: `probe` names a BATCH of ids and has no single
  // pane, so the guard belongs to the arms that address one.
  if (value.type === "probe") {
    return isStrArray(value.subshellIds) ? { type: "probe", ref: value.ref, subshellIds: value.subshellIds } : null;
  }
  if (!isStr(value.subshellId)) return null;
  const subshellId = value.subshellId;
  switch (value.type) {
    case "input":
      return isStr(value.data) ? { type: "input", ref: value.ref, subshellId, data: value.data } : null;
    case "terminate":
      return { type: "terminate", ref: value.ref, subshellId };
    case "kill":
      return { type: "kill", ref: value.ref, subshellId };
    case "capture":
      if ("lines" in value && !(isInt(value.lines) && (value.lines as number) > 0)) return null;
      return "lines" in value
        ? { type: "capture", ref: value.ref, subshellId, lines: value.lines as number }
        : { type: "capture", ref: value.ref, subshellId };
    case "resize":
      return isInt(value.cols) && isInt(value.rows) && (value.cols as number) > 0 && (value.rows as number) > 0
        ? { type: "resize", ref: value.ref, subshellId, cols: value.cols, rows: value.rows }
        : null;
    case "pane_size":
      return { type: "pane_size", ref: value.ref, subshellId };
    case "pane_cursor":
      return { type: "pane_cursor", ref: value.ref, subshellId };
    case "log_read":
      return isInt(value.fromByte) &&
        (value.fromByte as number) >= 0 &&
        isInt(value.maxBytes) &&
        (value.maxBytes as number) > 0
        ? {
            type: "log_read",
            ref: value.ref,
            subshellId,
            fromByte: value.fromByte,
            maxBytes: value.maxBytes,
          }
        : null;
    case "tail_start":
      return isStr(value.subId) && isInt(value.fromByte) && (value.fromByte as number) >= 0
        ? { type: "tail_start", ref: value.ref, subshellId, subId: value.subId, fromByte: value.fromByte }
        : null;
    default:
      return null;
  }
}

/**
 * Validates and narrows one plane->runtime command frame (the runtime parses
 * EVERY inbound frame through this; a null answer is a protocol violation and
 * closes the session, never a partial trust). `tail_stop` and the id-less
 * arms share the ref grammar, so the split by shape lives here rather than in
 * two functions.
 */
export function parseSshRuntimeCommandFrame(value: unknown): SshRuntimeCommandFrame | null {
  if (!isRecord(value) || !isStr(value.type)) return null;
  // The non-pane-keyed arms share only the ref requirement; anything else
  // dispatches on the pane id inside `parsePaneCommand`. Routing is by the
  // presence of `subshellId` in each arm's shape, not by a negative list.
  switch (value.type) {
    case "launch": {
      // Shallow on the envelope, and that is the whole design: the body's
      // deep grammar is `parseNodeCommandBody`'s launch arm, which the
      // runtime re-runs before dispatch (one grammar, checked where it is
      // executed). A plane-composed body that fails it answers
      // `unsupported`/`malformed`, never a half-parsed spawn.
      if (!isSshSessionRef(value.ref) || !isRecord(value.cmd) || value.cmd.type !== "launch") return null;
      if (!isStr(value.cmd.subshellId)) return null;
      return { type: "launch", ref: value.ref, cmd: value.cmd as unknown as SshRuntimeLaunchBody };
    }
    case "tail_stop":
      return isSshSessionRef(value.ref) && isStr(value.subId)
        ? { type: "tail_stop", ref: value.ref, subId: value.subId }
        : null;
    case "subshells_report":
      return isSshSessionRef(value.ref) ? { type: "subshells_report", ref: value.ref } : null;
    case "list_dirs":
      return isSshSessionRef(value.ref) && isStr(value.path)
        ? { type: "list_dirs", ref: value.ref, path: value.path }
        : null;
    case "stat_dir":
      return isSshSessionRef(value.ref) && isAbsRef(value.path)
        ? { type: "stat_dir", ref: value.ref, path: value.path }
        : null;
    case "remove_paths":
      return isSshSessionRef(value.ref) && Array.isArray(value.paths) && value.paths.every(isAbsRef)
        ? { type: "remove_paths", ref: value.ref, paths: [...(value.paths as string[])] }
        : null;
    case "rest_response": {
      if (!isStr(value.reqId) || value.reqId.length === 0) return null;
      if (!isInt(value.status) || (value.status as number) < 100 || (value.status as number) > 599) return null;
      if ("body" in value && value.body !== undefined && !isStr(value.body)) return null;
      return {
        type: "rest_response",
        reqId: value.reqId,
        status: value.status as number,
        ...("body" in value && typeof value.body === "string" ? { body: value.body } : {}),
      };
    }
    case "close":
      return isSshSessionRef(value.ref) ? { type: "close", ref: value.ref } : null;
    default:
      return parsePaneCommand(value);
  }
}

/**
 * Validates and narrows one runtime->plane event frame (the PLANE parses
 * every frame the pumped bytes produce, through this same function, so both
 * ends check and the shared file cannot drift).
 */
export function parseSshRuntimeEventFrame(value: unknown): SshRuntimeEventFrame | null {
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "hello":
      return parseSshRuntimeHello(value);
    case "result": {
      if (!isSshSessionRef(value.ref) || !isBool(value.ok)) return null;
      if (value.ok)
        return "data" in value
          ? { type: "result", ref: value.ref, ok: true, data: value.data }
          : { type: "result", ref: value.ref, ok: true };
      return isStr(value.error) ? { type: "result", ref: value.ref, ok: false, error: value.error } : null;
    }
    case "output":
      return isStr(value.subshellId) &&
        isStr(value.subId) &&
        isInt(value.fromByte) &&
        isInt(value.toByte) &&
        (value.fromByte as number) >= 0 &&
        (value.toByte as number) >= (value.fromByte as number) &&
        isStr(value.data_b64) &&
        BASE64_RE.test(value.data_b64)
        ? {
            type: "output",
            subshellId: value.subshellId,
            subId: value.subId,
            fromByte: value.fromByte,
            toByte: value.toByte,
            data_b64: value.data_b64,
          }
        : null;
    case "exit":
      return isStr(value.subshellId) && isStr(value.at) && (value.exitCode === null || isInt(value.exitCode))
        ? { type: "exit", subshellId: value.subshellId, exitCode: value.exitCode as number | null, at: value.at }
        : null;
    case "subshells_report": {
      if (!Array.isArray(value.subshells)) return null;
      const rows: { subshellId: string; alive: boolean; exitCode: number | null }[] = [];
      for (const s of value.subshells) {
        if (!isRecord(s) || !isStr(s.subshellId) || !isBool(s.alive)) return null;
        if (!(s.exitCode === null || isInt(s.exitCode))) return null;
        rows.push({ subshellId: s.subshellId, alive: s.alive, exitCode: s.exitCode as number | null });
      }
      return { type: "subshells_report", subshells: rows };
    }
    case "rest_request": {
      if (!isStr(value.reqId) || value.reqId.length === 0) return null;
      if (!isStr(value.method) || !/^[A-Za-z]+$/.test(value.method)) return null;
      if (!isStr(value.path) || !value.path.startsWith("/") || value.path.length > SSH_PATH_MAX_CHARS) return null;
      if ("body" in value && value.body !== undefined && !isStr(value.body)) return null;
      return {
        type: "rest_request",
        reqId: value.reqId,
        method: value.method.toUpperCase(),
        path: value.path,
        ...("body" in value && typeof value.body === "string" ? { body: value.body } : {}),
      };
    }
    default:
      return null;
  }
}

/** Whether a parsed runtime hello speaks a protocol major this plane understands (design §2's named refusal). */
export function sshRuntimeProtocolSupported(hello: SshRuntimeHelloWire): boolean {
  return Math.floor(hello.runtimeProtocol) === SSH_RUNTIME_PROTOCOL;
}
