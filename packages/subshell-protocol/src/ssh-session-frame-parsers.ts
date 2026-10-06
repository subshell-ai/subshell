/**
 * Parsers for the session-runtime wire family (design 2026-10-05 §2/§3): the
 * validators that narrow unknown JSON down to {@link SshSessionTargetWire},
 * {@link SshSessionNodeCommandBody}, {@link SshRuntimeHelloWire},
 * {@link SshSessionOpenResultWire}, and the two runtime-link frame unions.
 *
 * The WIRE TYPES and constants live in `ssh-session-frames.ts`; the GRAMMAR
 * lives here (the `ssh-frames.ts` / `ssh-run-facts.ts` split, one concern per
 * file). Both ends import through the package barrel; `node-frames.ts` routes
 * its three `ssh_session_*` arms here, the runtime and the plane parse every
 * stdio frame through the same functions, so the two ends cannot drift.
 *
 * Every parse is total: unknown in, narrowed value or null out, never a
 * throw. Null IS the refusal (fail-closed, the codec's own posture).
 */

import { BASE64_RE, isBool, isInt, isRecord, isStr, isStrArray } from "./guards.js";
import { SSH_NAME_MAX_CHARS, SSH_PATH_MAX_CHARS } from "./ssh-limits.js";
import {
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeCommandFrame,
  type SshRuntimeEventFrame,
  type SshRuntimeHelloWire,
  type SshRuntimeLaunchBody,
  type SshRuntimeReportRow,
  type SshSessionNodeCommandBody,
  type SshSessionOpenResultWire,
  type SshSessionTargetWire,
} from "./ssh-session-frames.js";

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
 * routes its three arms here, so the session grammar lives in one place beside
 * the types it narrows (the `ssh-frames.ts` precedent, split into
 * types/parsers like its run-family sibling).
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

/**
 * Validates the pane census rows the runtime reports twice over: as the
 * `subshells_report` EVENT frame, and as the `close` command's RESULT data
 * (design §6's final report). One grammar for both, because it is one fact
 * (alive/dead per pane) leaving one process.
 *
 * @returns the narrowed rows (an empty array is a valid empty census), or
 *          null when the payload fits no census shape at all
 */
export function parseSshRuntimeReportRows(value: unknown): SshRuntimeReportRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: SshRuntimeReportRow[] = [];
  for (const s of value) {
    if (!isRecord(s) || !isStr(s.subshellId) || !isBool(s.alive)) return null;
    if (!(s.exitCode === null || isInt(s.exitCode))) return null;
    rows.push({ subshellId: s.subshellId, alive: s.alive, exitCode: s.exitCode as number | null });
  }
  return rows;
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
      const rows = parseSshRuntimeReportRows(value.subshells);
      return rows === null ? null : { type: "subshells_report", subshells: rows };
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

/**
 * Whether a parsed runtime hello speaks the protocol this plane understands
 * (design §2's named refusal). The grammar pins the number to an integer, so
 * a match is plain equality: there is no minor a parser could miss, and a
 * future protocol bump is a number change the plane refuses BY NAME.
 */
export function sshRuntimeProtocolSupported(hello: SshRuntimeHelloWire): boolean {
  return hello.runtimeProtocol === SSH_RUNTIME_PROTOCOL;
}
