import { BASE64_RE, isBool, isInt, isNum, isRecord, isStr, isStrArray, isStringMap } from "./guards.js";
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
 * The agent protocol the control plane speaks. An agent reporting anything
 * else is refused with UPDATE_REQUIRED (4406).
 *
 * EXACT match, not a window. There is no compatibility range and no
 * per-feature gating, because the server and the agent are released together
 * and there is no fleet of older agents to carry: every enrolled node runs
 * the binary that shipped with the server. A version window bought the
 * ability to add a command without a node rollout, and paid for it in
 * branches that could not be exercised — an "is this node new enough" check
 * per feature, a fallback path per check, and a second meaning for every
 * null. Refusing the mismatch outright is one comparison and no dead ends.
 *
 * Bump this whenever a frame changes, additive or not, and release both
 * sides. SERVER FIRST: an agent that leads the server is refused and its node
 * goes offline, while an agent that lags is refused just as clearly — the
 * Nodes page names it either way.
 *
 * **The numbering restarted at 1 on 2026-09-09 and 1 → 2 was the first real
 * bump (phase 3, the registry).** The protocol had reached 6 under a
 * numbering that predated any deployment; since no instance was ever run on
 * those versions (and their GitHub releases are removed), the history was
 * reset rather than carried, and nothing here should annotate frames with the
 * retired numbers.
 *
 * **2 → 3 was the inversion (spec 2026-09-10 §7): plugins left the wire.**
 * `plugin_install` and `plugin_uninstall` are gone, the inventory event no
 * longer carries a plugin set, and `launch` requires the server-built `argv`
 * plus its `resolve` rule — the node holds no plugin concept, so a frame
 * without either names a spawn nothing on that machine can perform. The
 * first BREAKING bump of the restarted numbering: a v2 agent is refused by
 * the exact-match gate, which is the point — the pair ships together.
 *
 * **4 → 5 is the node Service surface (spec 2026-09-12, node half).**
 * `restart` left the wire, folded into `service` as one of five verbs: two
 * commands driving one service manager would be two refusal paths, two audit
 * actions and two chances to disagree about pane safety. `agent_log_read` and
 * `set_server_url` arrived beside it, so a headless node can be supervised,
 * read and repointed from a browser — the only place those questions can be
 * asked at all on a machine nobody opens a window on.
 *
 * **5 → 6 is `set_log_level`.** The agent's own log file gained the level gate
 * the server's has had (`CappedFileTransport`'s `level`), and this is the
 * command that flips it. Breaking, like every bump here, because the version
 * gate is exact-match — which is the point: the pair ships together. Note what
 * it does NOT do today: the agent has no `logger.debug` call sites, so turning
 * it on reveals nothing. The mechanism is deliberately in place ahead of the
 * lines (operator's call), so that the first debug line anyone writes is
 * already controllable from the browser that is the only way to read a
 * headless node's log.
 */
export const NODE_PROTOCOL_VERSION = 6;

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

/**
 * `result.error` from a `service` verb the agent refused because its service
 * manager did not start it (exiting would not be a restart).
 */
export const NODE_RESULT_NOT_SUPERVISED = "not supervised";

/**
 * `result.error` from a `service` verb the agent refused because the installed
 * definition would take live panes down (send `force: true`).
 *
 * Not restart's alone: `stop` and `uninstall` end the same panes, so all three
 * destructive verbs answer with this and `start`/`install` never can.
 */
export const NODE_RESULT_KILLS_PANES = "kills panes";

/**
 * `result.error` from a `service` verb that needs a definition where none is
 * installed — `start` and `stop` on a machine whose agent was launched by
 * hand. NOT `uninstall`: removing what is already gone is a no-op the CLI
 * answers 0, and an idempotent teardown is what a caller wants.
 */
export const NODE_RESULT_NO_SERVICE = "no service definition";

/**
 * The verbs a `service` command may carry, as a runtime list.
 *
 * Exported beside the type because three places iterate it: the frame parser,
 * the agent's executor and the API route's schema.
 */
export const NODE_SERVICE_VERBS = ["start", "stop", "restart", "install", "uninstall"] as const;

/** One verb of the `service` command. */
export type NodeServiceVerb = (typeof NODE_SERVICE_VERBS)[number];

/**
 * The verbs that can take live panes down, and therefore the ones that answer
 * {@link NODE_RESULT_KILLS_PANES} rather than acting.
 *
 * `install` writes a definition and `start` brings a stopped agent up; neither
 * can end a pane, so offering `force` on them would teach a person that the
 * flag is noise.
 */
export const NODE_SERVICE_DESTRUCTIVE: readonly NodeServiceVerb[] = ["stop", "restart", "uninstall"];

/** Whether `verb` is one this protocol knows. */
export function isNodeServiceVerb(verb: unknown): verb is NodeServiceVerb {
  return typeof verb === "string" && (NODE_SERVICE_VERBS as readonly string[]).includes(verb);
}

/* ------------------------------------------------------------------ */
/* how an agent process runs                                            */
/* ------------------------------------------------------------------ */

/**
 * How an agent process is running, reported once per connect in `ready`
 * (spec 2026-09-12 § 6.1). Facts about a PROCESS, so the plane keeps them on
 * the live connection and never in the nodes table — when the node is
 * offline they are stale by definition.
 */
export interface NodeRuntimeReport {
  /** ISO 8601 start time of this agent process. */
  startedAt: string;
  /** `service.state === "running" && service.pid === process.pid`: exiting is a restart. */
  supervised: boolean;
  /** The service manager's view of the unit, as `subshell service status --json` reports it. */
  service: {
    /** The platform's service manager, or null where there is none. */
    manager: "launchd" | "systemd" | null;
    /** Whether a service definition for the agent is installed. */
    installed: boolean;
    /** Absolute path of the unit/plist, or null when none is installed. */
    definitionPath: string | null;
    /** The manager's own word for the unit's state ("running", "stopped", …). */
    state: string;
    /** The pid the manager believes it started, or null. */
    pid: number | null;
    /** Whether the definition starts at login, or null when unknown. */
    enabled: boolean | null;
    /** Whether restarting through the definition keeps live panes alive. */
    paneSafety: "keeps" | "kills" | "unknown";
  };
  /** `~/.config/subshell/config.json`, resolved. */
  configPath: string;
  /** The launchd log file; null under systemd. */
  logPath: string | null;
  /** The journal command when `logPath` is null. */
  logHint: string | null;
  /**
   * The agent's OWN log file — the one `agent_log_read` serves.
   *
   * Distinct from `logPath`, which is wherever the service manager redirected
   * stdout (a file under launchd, nothing under systemd). This one is written
   * by the agent itself and exists identically on every platform, which is what
   * makes reading a node's log in a browser a single behaviour rather than two.
   */
  agentLogPath: string;
  /**
   * The agent's debug-logging switch, as the plane's UI renders it.
   *
   * `source: "process env"` means `SUBSHELL_DEBUG_LOGGING` forces it on that
   * machine and the switch is read-only — the same shape, and the same
   * read-only rule, as the server's own `logging` block.
   */
  logging: {
    /** Whether debug-level lines reach the agent's log file. */
    debug: boolean;
    /** Which layer decided: the environment, the stored flag, or the default. */
    source: "process env" | "setting" | "default";
  };
  /** tmux on the daemon's PATH, or null. */
  tmuxPath: string | null;
  /** The agent binary this process re-enters (`selfInvoke.command`). */
  binaryPath: string;
}

/** The agent's debug state, or the default when it did not say it properly. */
function parseLogging(value: unknown): NodeRuntimeReport["logging"] {
  if (!isRecord(value) || !isBool(value.debug)) return { debug: false, source: "default" };
  const source =
    value.source === "process env" || value.source === "setting" || value.source === "default"
      ? value.source
      : "default";
  return { debug: value.debug, source };
}

/**
 * Shape-check a `NodeRuntimeReport`.
 * @param value - the candidate, typically `ready.runtime`
 * @returns the narrowed report, or null when malformed (the `ready` itself is
 * still accepted without it — the field is additive, so an agent that gets it
 * wrong loses the card, not the connection).
 */
export function parseNodeRuntimeReport(value: unknown): NodeRuntimeReport | null {
  if (!isRecord(value) || !isRecord(value.service)) return null;
  const s = value.service;
  const manager = s.manager === "launchd" || s.manager === "systemd" || s.manager === null ? s.manager : undefined;
  const paneSafety =
    s.paneSafety === "keeps" || s.paneSafety === "kills" || s.paneSafety === "unknown" ? s.paneSafety : undefined;
  if (
    !isStr(value.startedAt) ||
    !isBool(value.supervised) ||
    manager === undefined ||
    !isBool(s.installed) ||
    !(s.definitionPath === null || isStr(s.definitionPath)) ||
    !isStr(s.state) ||
    !(s.pid === null || isInt(s.pid)) ||
    !(s.enabled === null || isBool(s.enabled)) ||
    paneSafety === undefined ||
    !isStr(value.configPath) ||
    !isStr(value.agentLogPath) ||
    !(value.logPath === null || isStr(value.logPath)) ||
    !(value.logHint === null || isStr(value.logHint)) ||
    !(value.tmuxPath === null || isStr(value.tmuxPath)) ||
    !isStr(value.binaryPath)
  ) {
    return null;
  }
  return {
    startedAt: value.startedAt,
    supervised: value.supervised,
    // **Lenient, where every field above is strict**, and deliberately so.
    // This one is cosmetic — the current position of a switch — while the
    // rest of the report is what the card is FOR: supervision, service state,
    // paths, the verbs. Losing all of that because a sub-object was malformed
    // is the wrong trade, so a bad or absent `logging` reads as "off, by
    // default" rather than rejecting the report.
    logging: parseLogging(value.logging),
    service: {
      manager,
      installed: s.installed,
      definitionPath: s.definitionPath,
      state: s.state,
      pid: s.pid,
      enabled: s.enabled,
      paneSafety,
    },
    configPath: value.configPath,
    agentLogPath: value.agentLogPath,
    logPath: value.logPath,
    logHint: value.logHint,
    tmuxPath: value.tmuxPath,
    binaryPath: value.binaryPath,
  };
}

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
 * Structural JSON mirror of `@internal/pane-runtime`' `ProfileDefinition`.
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

/**
 * Stands in for the harness binary inside a server-built `argv`.
 *
 * The control plane builds the argv but cannot know where the binary is on the
 * target machine at the moment of launch: an inventory can be minutes old and
 * predate an upgrade. So the plane emits this token and the NODE substitutes
 * its own freshly resolved path. Late binding of one node-owned fact, rather
 * than shipping plugin code to resolve it.
 */
export const HARNESS_BINARY_PLACEHOLDER = "@@HARNESS_BINARY@@";

/**
 * The rule for finding the harness binary on the node at the moment of
 * `launch` (inversion spec §5) — the wire mirror of a plugin manifest's
 * `subshell.detect` block. The node runs its own lookup against it (the same
 * ladder `detectBinary` implements) and substitutes the result for
 * {@link HARNESS_BINARY_PLACEHOLDER}; the control plane only ships the rule.
 */
export interface LaunchResolveWire {
  /** Binary name the node searches PATH for */
  binaryName: string;
  /** Name of an env var holding an explicit path that overrides the search (e.g. CLAUDE_PATH) */
  envOverride?: string;
  /** Home-relative install locations tried after PATH (the manifest's knownPaths) */
  knownPaths?: string[];
}

/**
 * One harness's detection rule as the `detect` command ships it (inversion
 * spec §4): the plugin id plus its manifest's `subshell.detect` block, all
 * three lookup fields required because a PARSED manifest always fills them
 * (mirrors plugin-api's `DetectSpec`). The empty-`binaryName` spec is the
 * no-binary marker a plugin without a `detect` block travels under; the node
 * then answers `no-binary` without searching, exactly as `detectFor` reads a
 * manifest with no detect block.
 *
 * A `type` alias, not an interface: like `SettingsFieldWire` these travel
 * inside JSON values, and an interface has no implicit index signature.
 */
export type DetectSpecWire = {
  /** Harness plugin id this rule belongs to (echoed back on the result row) */
  id: string;
  /** Binary name the node searches PATH for ("" = this plugin declares no binary) */
  binaryName: string;
  /** Name of an env var holding an explicit override path ("" = none) */
  envOverride: string;
  /** Home-relative install locations tried after PATH (the manifest's knownPaths) */
  knownPaths: string[];
};

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
      /**
       * MCP registration file the agent writes (0600) before spawning.
       * `args`/`env` (inversion spec §5) are the harness dialect the control
       * plane computed from the plugin — the flags that load the file and the
       * pane env that makes the harness find it — so the node no longer
       * recomputes either. Only the node's own `subshell mcp` path stays
       * node-supplied: it is self-knowledge, not plugin knowledge.
       */
      mcp?: { path: string; fileContent: string; args?: string[]; env?: Record<string, string> };
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
      /**
       * Server-built argv (inversion spec §5): the complete command line the
       * node should spawn, with {@link HARNESS_BINARY_PLACEHOLDER} wherever
       * the binary belongs. REQUIRED since protocol 3 — the node holds no
       * plugin and builds nothing itself, so a frame without this carries no
       * command line at all.
       */
      argv: string[];
      /**
       * The rule for resolving the placeholder binary on THIS node. REQUIRED
       * since protocol 3, and paired with `argv` by the parser: an argv that
       * names the binary slot needs the rule that fills it. A plugin with no
       * detect block never reaches the wire — the launcher refuses it locally.
       */
      resolve: LaunchResolveWire;
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
      /** Optional scrollback budget for the capture; absent means the visible grid only. */
      lines?: number;
    }
  | {
      /**
       * The pane's REAL grid, as tmux reports it — the remote twin of the
       * control plane's own readback. Answering null (pane gone) is a legal
       * result, distinct from an error.
       */
      type: "pane_size";
      subshellId: string;
    }
  | { type: "probe"; subshellIds: string[] }
  | {
      /**
       * Does this path exist on the node? The path arrives COMPUTED: the
       * control plane builds it with plugin code (`resumePath`) against the
       * node's reported environment, and the node is the stat endpoint
       * (spec 2026-09-10 §5). This is the generalised `probe_resume` — once
       * it carries a path rather than a resume question it is one capability
       * with one caller, not a resume-specific command, and the general name
       * is what stops the next person adding a second near-identical probe.
       * Not allowlist-gated: a probe is not a launch, same posture as
       * `stat_dir` and `fs_ls`.
       */
      type: "path_exists";
      path: string;
    }
  | { type: "stat_dir"; path: string }
  | {
      /**
       * One-level directory listing for the folder picker. Empty `path` = the AGENT's home directory (the control
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
      /**
       * Probe binaries on this node for the named detection rules and answer
       * with RAW version text (inversion spec §4). Pure data in, data out:
       * the node loads no plugin code to answer, because `parseVersion` is
       * plugin code and runs on the control plane — the plane maps the raw
       * text through the plugin's parser and caches the result through its
       * ordinary inventory path. Detection runs ONLY when asked (page load,
       * Re-check): there is no sweep to inherit from the `inventory` command.
       */
      type: "detect";
      /** One rule per harness to probe; an empty array is a legal no-op */
      specs: DetectSpecWire[];
      /**
       * Environment variable NAMES the plane asks this node to report values
       * for (spec 2026-09-10 §5 as amended by the final review): the union of
       * `subshell.hostEnv` across the plane's ENABLED harness manifests —
       * the node has held no manifests since §6, so the plane names what it
       * may ask. May be empty; the result's `env` then answers `{}`. The node
       * answers ONLY these names, never a scan of its environment.
       */
      envNames: string[];
    }
  | {
      /** Chunked file write (terminal uploads relay, spec §3.4) */
      type: "write_file";
      path: string;
      chunk_b64: string;
      chunk: number;
      eof: boolean;
    }
  | {
      /**
       * Replace the node's directory allowlist.
       *
       * The node PERSISTS this and checks every launch against its own copy.
       * That is the whole point: command signing proves WHO sent a launch,
       * never WHETHER the directory is permitted, so an allowlist carried
       * inside the `launch` command would be worth nothing against a
       * compromised control plane.
       *
       * An EMPTY array means unrestricted — the same meaning as never having
       * had a list, so clearing the rules and never setting any are one state.
       * Pushed on every owner edit and again after each `ready`, which is what
       * heals an edit made while the node was offline.
       */
      type: "set_allowed_dirs";
      dirs: string[];
    }
  | { type: "ping" }
  | {
      /**
       * Drive this machine's service manager (spec 2026-09-12, node half).
       *
       * One command for all five verbs, because they are one manager and one
       * set of refusals. `restart` is the verb that used to be its own
       * command: it exits 0 so the manager respawns the agent, and is refused
       * when this process is not the one the manager started.
       *
       * The agent decides, always. Signing proves WHO asked; whether the
       * machine can answer is the machine's own business, which is why every
       * refusal below is the agent's word and not the plane's guess.
       */
      type: "service";
      verb: NodeServiceVerb;
      /**
       * Act even though the definition's `paneSafety` is not `keeps`.
       *
       * Meaningful only for {@link NODE_SERVICE_DESTRUCTIVE}; the agent
       * ignores it on `start` and `install`, which cannot end a pane.
       */
      force?: boolean;
    }
  | {
      /**
       * Read a slice of the agent's OWN log file.
       *
       * `agent_log_read`, never `log_read`: that one is a SUBSHELL's pane log,
       * which holds what an operator typed. These two must never be reachable
       * through one name.
       */
      type: "agent_log_read";
      /** Byte offset to read from; 0 is the start of the file. */
      fromByte: number;
      /** Cap on the bytes returned, so one read cannot pull an entire file into a frame. */
      maxBytes: number;
    }
  | {
      /**
       * Rewrite `serverUrl` in the agent's own `config.json`, keeping
       * `nodeId`, the node key and the pinned `controlPublicKey`.
       *
       * The same edit `subshell configure --server` performs, through the same
       * function — a second writer of that file would be a second set of rules
       * for it. What differs is who is asking: doing this remotely points a
       * machine at a host of someone else's choosing, so the plane gates it on
       * OWNERSHIP rather than on the `edit` grant every other verb here uses.
       */
      type: "set_server_url";
      /** Absolute http(s) origin of the control plane this node should dial. */
      url: string;
    }
  | {
      /**
       * Turn debug-level lines in the agent's OWN log file on or off, live.
       *
       * Flips that file transport's level and persists the answer in the
       * agent's `config.json`; the console transport is never touched, so what
       * journald or launchd collects stays at `info` either way. Refused while
       * `SUBSHELL_DEBUG_LOGGING` forces it in that machine's environment —
       * writing a value the next read would mask is a success report for a
       * change that never happens.
       *
       * Gated on the `edit` grant like the rest of the service surface, not on
       * ownership: it changes what a machine writes to its own disk, not who
       * owns it.
       */
      type: "set_log_level";
      /** True = debug-level lines reach the file; false = `info` and above. */
      debug: boolean;
    };

/** Agent → control events, unsigned (socket-authed; spec §3.3). */
/**
 * One field of a plugin's profile-editor schema, as it travels.
 *
 * A `type` alias rather than an `interface`, and the same for the two below:
 * an interface has no implicit index signature, so it is not assignable to
 * `JsonValue`, and these ride inside a command RESULT which is typed as one.
 */
export type SettingsFieldWire = {
  /** Key into the profile's settings object */
  key: string;
  /** Property label */
  label: string;
  /** Short description for the editor */
  description?: string;
  /** Editor control kind */
  type: "string" | "boolean" | "number" | "select";
  /** Choices when type is "select" */
  choices?: string[];
  /** Default value when unset */
  default?: string | boolean | number;
};

/** One copy-paste step in a plugin's manual MCP setup. */
export type McpSetupStepWire = {
  /** What the user should do, and where the text goes */
  label: string;
  /** Copyable command or snippet */
  command: string;
};

/**
 * How a plugin obtains the subshell MCP tools.
 *
 * Discriminated, matching the contract: auto explains itself in one line and
 * manual carries steps, and a plugin cannot mix the two.
 */
export type McpSetupWire = { mode: "auto"; summary: string } | { mode: "manual"; steps: McpSetupStepWire[] };

/**
 * One installed plugin, as the node describes it.
 *
 * Everything the control plane needs about a plugin it cannot import: enough
 * to list it, render its profile editor, label its exit codes and explain its
 * MCP setup. A plugin that failed to load still appears, carrying `broken`,
 * so a node page can say why rather than dropping the row.
 */
export type PluginReportWire = {
  /** Plugin id */
  id: string;
  /** Display name */
  name: string;
  /** What kind of thing it provides */
  type: string;
  /** Package version installed on the node */
  version: string;
  /** Optional emoji/glyph */
  icon?: string;
  /** One-line description */
  description: string;
  /** Which optional members it implements */
  capabilities: string[];
  /** Settings rendered in the profile editor */
  profileSettings?: SettingsFieldWire[];
  /** Known env var suggestions */
  suggestedEnv?: { key: string; description: string }[];
  /** Known CLI flag suggestions */
  suggestedFlags?: { flag: string; description: string }[];
  /** How this harness obtains the subshell MCP tools */
  mcpSetup?: McpSetupWire;
  /** Exit code to human label, for the codes the plugin names */
  exitStatuses?: Record<string, string>;
  /** Why it cannot be used, when it cannot */
  broken?: string;
  /**
   * The node installed a newer copy than the code it is running.
   *
   * A module cannot be swapped inside a live process (see `IMPORTED` in
   * `@internal/pane-runtime`), so `version` here is what is on disk while the
   * behaviour is the previous build's. Reported rather than hidden, because
   * the pair is what makes the remedy obvious: restart the agent.
   */
  restartRequired?: boolean;
};

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
       * How to re-enter this agent's binary — the `{ command, args }` PREFIX
       * a subcommand is appended to, whatever "this machine's subshell" turns
       * out to be: a compiled binary answers `{ command: <self>, args: [] }`,
       * a bun-interpreted run answers `{ command: <bun>, args: [<entry>] }`
       * (the agent's `selfInvokePrefix` makes that call, and the entry is
       * ABSOLUTE because both consumers spawn in the subshell's cwd). The
       * control plane cannot derive this from any single path, because
       * `process.execPath` is `bun` under an interpreter run and `bun mcp` is
       * not a command.
       *
       * It is subcommand-LESS because the plane re-enters the agent for two
       * unrelated things — `mcp` for a pane's MCP registration and `report`
       * for its harness hooks — and one reported fact serving both is what
       * keeps them from drifting. Absent means the plane falls back to
       * `subshell` on PATH.
       */
      selfInvoke?: { command: string; args: string[] };
      /**
       * The node's home directory (spec 2026-09-10 §5). Plugin resume paths
       * fall back to `<homeDir>/.claude` style defaults, and the control
       * plane cannot expand `~` against a machine it cannot see — the same
       * reason `fs_ls` answers the agent's home for an empty path. Absent
       * means the node reported none; the computed path then degrades to a
       * relative default that will simply not exist, i.e. a fresh
       * conversation rather than a failure.
       */
      homeDir?: string;
      /**
       * How the agent process runs (spec 2026-09-12 § 6.1). Absent from
       * agents that predate it, and dropped rather than fatal when
       * malformed — `parseNodeEvent` keeps the `ready` either way.
       */
      runtime?: NodeRuntimeReport;
    }
  | {
      type: "inventory";
      harnesses: {
        harnessId: string;
        installed: boolean;
        version?: string;
        binaryPath?: string;
        /**
         * Why the binary was not found (2026-09-09 §7). Optional on the wire
         * and absent when the probe itself failed rather than having looked,
         * so a reader treats absence as unknown rather than as a verdict.
         *
         * (An earlier note here justified the optionality as compatibility
         * with agents predating the field. Gate 2 refuses any protocol
         * mismatch in either direction, so no such agent can send a frame at
         * all; the optionality is about what a probe can answer, not about
         * who is on the other end.)
         */
        reason?: "not-on-path" | "override-invalid" | "no-binary";
        /** ISO 8601 stamp of when this entry was probed. Also optional, also additive. */
        checkedAt?: string;
      }[];
      // The `plugins` field this event carried is GONE (protocol 3, inversion
      // spec §7): the node holds no plugin concept, so it declares nothing —
      // its honest facts travel as `detect` answers. `PluginReportWire`
      // itself stays exported: the control plane's own plugin store still
      // speaks it, and it retires with that store's per-node mirror.
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
        if ("args" in m && !isStrArray(m.args)) return null;
        if ("env" in m && !isStringMap(m.env)) return null;
      }
      if ("harnessSession" in value) {
        const h = value.harnessSession;
        if (!isRecord(h) || !isStr(h.id) || (h.mode !== "start" && h.mode !== "resume")) return null;
      }
      if ("cols" in value && !(isInt(value.cols) && (value.cols as number) > 0)) return null;
      if ("rows" in value && !(isInt(value.rows) && (value.rows as number) > 0)) return null;
      if ("bestEffortLog" in value && !isBool(value.bestEffortLog)) return null;
      // Server-built argv and its resolve rule (inversion spec §5): REQUIRED
      // since protocol 3. The node holds no plugin and builds nothing itself,
      // so a frame without either half is not an older spelling to tolerate —
      // it names a spawn that machine cannot perform. Refuse at the parse,
      // before dispatch, exactly like every other malformed frame.
      if (!isStrArray(value.argv)) return null;
      const resolve = value.resolve;
      if (!isRecord(resolve) || !isStr(resolve.binaryName)) return null;
      if ("envOverride" in resolve && !isStr(resolve.envOverride)) return null;
      if ("knownPaths" in resolve && !isStrArray(resolve.knownPaths)) return null;
      return value as unknown as NodeCommandBody;
    }
    case "terminate":
    case "kill":
      return isStr(value.subshellId) ? ({ type: value.type, subshellId: value.subshellId } as NodeCommandBody) : null;
    case "pane_size": {
      if (typeof value.subshellId !== "string") return null;
      return { type: "pane_size", subshellId: value.subshellId };
    }
    case "capture": {
      if (!isStr(value.subshellId)) return null;
      // Optional positive int or absent; an agent that is given none answers
      // with the visible grid only.
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
    case "path_exists":
      // Shape only: the path's correctness (does it name the real transcript?)
      // belongs to the plugin that computed it, and its existence is what the
      // command EXISTS to ask. Absolute-vs-relative is NOT enforced — the
      // honest degradation for a node that reported no home is a relative
      // default that stats absent.
      return isStr(value.path) ? { type: "path_exists", path: value.path } : null;
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
    case "set_allowed_dirs":
      // Normalization is NOT applied here — the parser's job is shape, and
      // the executor re-normalizes anyway. A malformed entry inside a
      // well-formed array is dropped there, never here, so one bad rule
      // cannot reject the whole push.
      return isStrArray(value.dirs) ? { type: "set_allowed_dirs", dirs: value.dirs } : null;
    case "inventory":
      return { type: "inventory" };
    case "detect": {
      if (!Array.isArray(value.specs)) return null;
      const specs: DetectSpecWire[] = [];
      for (const s0 of value.specs) {
        // All three lookup fields are REQUIRED (the manifest makes them so);
        // a no-detect plugin travels as the empty spec, not as absent keys.
        if (!isRecord(s0)) return null;
        const { id, binaryName, envOverride, knownPaths } = s0;
        if (!isStr(id) || !isStr(binaryName) || !isStr(envOverride) || !isStrArray(knownPaths)) return null;
        specs.push({ id, binaryName, envOverride, knownPaths: [...knownPaths] });
      }
      // REQUIRED since the env-on-detect amendment: an absent list is not
      // "ask for nothing", it is a plane that forgot the field — refuse it
      // like every other malformed frame rather than guess the intent.
      if (!isStrArray(value.envNames)) return null;
      return { type: "detect", specs, envNames: [...value.envNames] };
    }
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
    case "service": {
      if (!isNodeServiceVerb(value.verb)) return null;
      if (!("force" in value)) return { type: "service", verb: value.verb };
      return isBool(value.force) ? { type: "service", verb: value.verb, force: value.force } : null;
    }
    case "agent_log_read":
      return isInt(value.fromByte) &&
        (value.fromByte as number) >= 0 &&
        isInt(value.maxBytes) &&
        (value.maxBytes as number) > 0
        ? { type: "agent_log_read", fromByte: value.fromByte, maxBytes: value.maxBytes }
        : null;
    case "set_server_url":
      // Shape only. WHICH urls are acceptable is the plane's validator and the
      // agent's own re-check — a parser that also judged the host would be a
      // third place to keep that rule.
      return isStr(value.url) && value.url.length > 0 ? { type: "set_server_url", url: value.url } : null;
    case "set_log_level":
      return isBool(value.debug) ? { type: "set_log_level", debug: value.debug } : null;
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
    case "ready": {
      if (
        !(
          isStr(value.agentVersion) &&
          isInt(value.protocolVersion) &&
          (value.os === "linux" || value.os === "darwin" || value.os === "unknown") &&
          isStr(value.arch) &&
          isStr(value.hostname) &&
          isStr(value.dataDir) &&
          isStrArray(value.capabilities) &&
          (!("selfInvoke" in value) ||
            (isRecord(value.selfInvoke) && isStr(value.selfInvoke.command) && isStrArray(value.selfInvoke.args))) &&
          (!("homeDir" in value) || isStr(value.homeDir))
        )
      ) {
        return null;
      }
      // `runtime` is additive: a malformed one is dropped so the connection
      // still comes up without the card, rather than refused.
      const { runtime: rawRuntime, ...rest } = value as Record<string, unknown> & { runtime?: unknown };
      const runtime = rawRuntime === undefined ? null : parseNodeRuntimeReport(rawRuntime);
      return {
        ...(rest as unknown as Extract<NodeEvent, { type: "ready" }>),
        ...(runtime ? { runtime } : {}),
      };
    }
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
