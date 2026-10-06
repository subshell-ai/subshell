/**
 * SSH session-runtime wire types (design 2026-10-05 §2/§3): the node-link
 * command family that brokers a session (`ssh_session_open/send/close`, the
 * new `session_frame` event arm in `node-frames.ts`) and the RUNTIME-LINK
 * frames that ride the SSH child's stdio inside it (hello, the plane's
 * command frames, the runtime's event frames, the callback request/response
 * pair).
 *
 * Two grammars, one type file, because they are one feature viewed from its
 * two halves: the node link speaks signed plain objects (like the SSH family
 * before them, these are TRANSPORT-AGNOSTIC - the socket/jti/signature belong
 * to the transport and live outside the body), and the runtime link speaks
 * length-prefixed JSON frames (`ssh-session-codec.ts`) whose own version
 * namespace is `runtimeProtocol`, deliberately separate from
 * {@link NODE_PROTOCOL_VERSION} so a runtime rebuild never forces a node-link
 * bump. The node link IS bumped by the new commands (17), the runtime link
 * is not versioned by it.
 *
 * This file is the WIRE TYPES and constants; the validators that narrow
 * unknown JSON into these shapes live in `ssh-session-frame-parsers.ts`
 * (the `ssh-frames.ts` / `ssh-results.ts` split - one concern per file).
 * Hand-rolled in the `ssh-frames.ts` style; imports no `node:` builtin;
 * lives in the Metro-safe barrel. Result ENVELOPE validation for the open
 * command lives in `node-results.ts` beside every other result validator
 * (the four-site rule the integration maps name).
 */

// TYPE-ONLY import: no runtime cycle with `node-frames.ts`, which value-imports
// the arm parser from the parsers module. The launch body is the node link's
// OWN command shape so a runtime pane and a node-link pane are launched by one
// grammar (the design's "mirror the node command bodies, minus crypto").
import type { DetectSpecWire, NodeCommandBody } from "./node-frames.js";
import {
  SSH_REQ_ID_MAX_CHARS,
  SSH_SESSION_INBOUND_QUEUE_FRAMES,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSIONS_PER_NODE,
} from "./ssh-limits.js";

// Re-exported for consumers that read the session surface from this file; the
// NUMBERS live in ssh-limits.ts beside every other row of the limits table.
export { SSH_REQ_ID_MAX_CHARS, SSH_SESSION_INBOUND_QUEUE_FRAMES, SSH_SESSION_OPEN_DEADLINE_MS, SSH_SESSIONS_PER_NODE };

/** The node link's `launch` body, reused verbatim as the runtime launch frame's payload. */
export type SshRuntimeLaunchBody = Extract<NodeCommandBody, { type: "launch" }>;

/** The node link's `detect` specs, reused verbatim as the runtime detect frame's payload (same rule, same answer). */
export type SshRuntimeDetectSpecs = DetectSpecWire[];

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * The runtime link's version (design §2): ONE integer, matched by equality on
 * the plane (`sshRuntimeProtocolSupported`). Bump it whenever the two ends
 * must understand something new; additive frames that BOTH an old runtime and
 * an old plane can ignore are gated by the hello's `capabilities` list, not
 * by a number the grammar could not even speak. A mismatch refuses the open
 * by name, saying both numbers.
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
  /** Plane-minted session ref (the routing key on every frame and event; see the parsers' `isSshSessionRef`). */
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

/**
 * Close one session: kill the child's group, answer once. Unknown refs answer
 * the bare {@link SSH_SESSION_UNKNOWN}. The plane sends this on every user
 * close (and the protocol-mismatch unroll) so the broker's group-kill is not
 * left to the runtime's own exit; the node records `closed` either way.
 */
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
  /** The runtime link's protocol; the plane refuses a mismatch by name. */
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
  /**
   * How the runtime re-enters its OWN binary (the `ready` frame's `selfInvoke`
   * fact, same shape, prefix WITHOUT a subcommand). The plane appends `mcp` to
   * compose a pane's MCP registration and `report` to compose its hooks: the
   * agent's exact pattern; the runtime simply reports it over the session
   * channel instead of the node link. Absent = a runtime that predates the
   * field, and the plane falls back to the binary's name on PATH (`subshell`),
   * which is how the agent's own `ready`-without-selfInvoke fallback reads.
   */
  selfInvoke?: { command: string; args: string[] };
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
 * One pane's census row: alive/dead as the runtime's tmux sees it, with the
 * exit code when dead. The SAME row shape answers the `subshells_report`
 * EVENT frame and the `close` command's RESULT data (design §6's final
 * report - one fact, one shape, leaving one process).
 */
export type SshRuntimeReportRow = {
  /** The pane's id (a plane-minted subshell uuid). */
  subshellId: string;
  /** Whether the destination tmux still reports the pane alive. */
  alive: boolean;
  /** The pane's exit code when dead (null: alive, or tmux could not say - unknown reads alive upstream). */
  exitCode: number | null;
};

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
  /**
   * Probe binaries and answer named env values (task 25, the node link's
   * `detect` body minus the link): the PLANE asks, the runtime answers exactly
   * what was asked, never a scan. `specs`/`envNames` are the SAME shapes the
   * node link's detect carries (`DetectSpecWire[]`, printable env NAMES); the
   * envelope check is shallow like `launch`'s, and the runtime re-runs
   * `parseNodeCommandBody`'s deep detect arm before the executor sees it.
   * Gated by the hello's `"detect"` capability on the plane side.
   */
  | { type: "detect"; ref: string; specs: SshRuntimeDetectSpecs; envNames: string[] }
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
  /**
   * Graceful end: the runtime answers this command's `result{ref}` WITH its
   * final census as `data`, closes the socket, exits 0. tmux and panes stay
   * up (design §6). The plane reads the census from the result and settles
   * regardless of whether one arrives (design §6's Close).
   */
  | { type: "close"; ref: string };

/** A runtime->plane event frame (design §2: mirror `NodeEvent`, minus the link-management arms that belong to the broker). */
export type SshRuntimeEventFrame =
  | SshRuntimeHelloWire
  | { type: "result"; ref: string; ok: true; data?: unknown }
  | { type: "result"; ref: string; ok: false; error: string }
  | { type: "output"; subshellId: string; subId: string; fromByte: number; toByte: number; data_b64: string }
  | { type: "exit"; subshellId: string; exitCode: number | null; at: string }
  | { type: "subshells_report"; subshells: SshRuntimeReportRow[] }
  /**
   * A pane's callback over `callback.sock`, forwarded bounded (design §5).
   * The plane answers with a `rest_response` carrying the same `reqId`; the
   * parsers bound it ({@link SSH_REQ_ID_MAX_CHARS}, printable) on both
   * directions, so the answer frame's size is finite before the body is cut.
   *
   * `paneId` is the per-connection ATTRIBUTION (task 25): set when the runtime
   * accepted the connection on that pane's OWN callback door
   * (`<dataDir>/callbacks/<paneId>.sock`, named in the pane's
   * `SUBSHELL_RUNTIME_CALLBACK_SOCK` at launch), and the plane executes the
   * request as exactly that pane's token; no credential ever crossed the
   * wire to make the identification. Absent = the shared door
   * (`<dataDir>/callback.sock`, the slice's manual-curl surface), where the
   * plane's rule is the slice's: resolvable only for a one-pane session.
   */
  | { type: "rest_request"; reqId: string; method: string; path: string; body?: string; paneId?: string };
