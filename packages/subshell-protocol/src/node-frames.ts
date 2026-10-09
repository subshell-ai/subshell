import { BASE64_RE, isBool, isInt, isNum, isRecord, isStr, isStrArray, isStringMap } from "./guards.js";
import type { JsonValue } from "./json.js";
import { parseSshNodeCommandBody, type SshNodeCommandBody } from "./ssh-frames.js";
import { SSH_CONFIG_FILE_MAX_BYTES, SSH_PATH_MAX_CHARS, SSH_RELAY_FRAME_MAX_BYTES } from "./ssh-limits.js";

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
 *
 * **6 → 7 is the preset rename (spec 2026-09-13).** The `launch` frame's
 * `profile` field becomes `preset` (`ProfileDefinitionWire` →
 * `PresetDefinitionWire`), and the plugin-report settings field becomes
 * `presetSettings`. Wire-shaped, not semantic: the same JSON under new names,
 * breaking because the gate is exact-match and the pair ships together.
 *
 * **7 → 8 is node maintenance (spec 2026-09-14).** One flag saying "this
 * machine takes no new subshells", settable from the plane OR from the
 * machine's own `subshell maintenance` verb — which is what puts three frames
 * on the wire rather than one: `ready.maintenance` states the node's mirror at
 * connect, the `maintenance` event reports a flip the machine made, and
 * `set_maintenance` carries the plane's. The event exists because a CLI
 * process cannot talk to the running daemon: it writes a file, and the daemon
 * is what tells the plane. Additive, and breaking anyway — the gate is
 * exact-match.
 *
 * **8 → 9 is `service.linger`.** One Linux fact the report never carried:
 * whether the agent's OS user lingers. A `systemd --user` unit that starts at
 * login dies at LOGOUT unless it does, which on a headless node — a machine
 * nobody logs in to — is the difference between an agent that is there and one
 * that is not. The plane could only ever advise about it in the abstract; now
 * it says which of the two this machine is. Additive, and breaking anyway,
 * because the gate is exact-match.
 *
 * **9 → 10 is the `update` command (spec 2026-09-15 §5.1).** The plane can now
 * hand an agent a version, a URL and a digest and have it replace its own
 * binary, instead of closing 4406 and leaving somebody to walk to the machine.
 * Additive, and breaking anyway, because the gate is exact-match — but see the
 * FROZEN-SHAPE note on the command itself: `update` is the ONE command the
 * plane sends across a protocol boundary, so its field names and meanings may
 * never be changed by a later bump.
 *
 * **10 → 12 is the signed `update` (spec 2026-09-17 §6).** The command gains
 * the release's manifest bytes and their publisher signature, and an agent
 * refuses an update whose manifest it cannot verify. Additive in shape, and
 * breaking for the ONE field it does not add: an agent that ignores
 * `manifest`/`manifestSig` silently reopens the hole this closes — a
 * compromised plane could order a payload-only update again — so the plane
 * treats any protocol below 12 as update-incapable
 * ({@link NODE_SIGNED_UPDATES_PROTOCOL_VERSION}) rather than sending a command
 * whose new fields would go unread. The number skips 11 deliberately: the
 * concurrent zero-touch work bumps 10→11 for its `ready` fields, and taking
 * 12 here keeps this bump valid in either merge order — while no build ever
 * spoke 11 on main, so nothing deployed is skipped over.
 *
 * **12 → 13 is `pane_cursor`.** The attach replay must end with the client's
 * cursor ON the pane's cursor — a capture otherwise leaves it after the last
 * row it wrote, and a fresh terminal's cursor sits near the TOP of the grid,
 * so every later live byte (every echo) painted at the wrong row: the
 * 2026-09-23 "prompt-at-top, typing-off-screen" browser report. Additive in
 * shape, and breaking anyway, because the gate is exact-match; a below-13
 * agent never gets asked (its plane cannot exist — server and node ship
 * together), and a null or failing answer just means the replay ships
 * without the restore, which is precisely the pre-13 behavior.
 *
 * **13 → 14 is the encrypted link (spec 2026-09-24).** The link is encrypted
 * end-to-end: kx handshake, secretstream frames, the register self-heal,
 * closes 4410/4411. Hard cutover: protocol-14 nodes never write plaintext frames,
 * and legacy rows are held-updatable until they register. Not additive in
 * anything — this one changes the transport itself.
 *
 * **14 → 15 is the archive-transfer surface (spec 2026-10-01 §2).** Five
 * commands let the plane relay a tree between two enrolled machines without a
 * foreign binary on either: `archive_create`, `file_read`, `transfer_write`,
 * `archive_extract` and `tree_manifest`, plus the window/entry constants that
 * keep the two ends from drifting. Additive, and breaking anyway, because the
 * gate is exact-match. Note what it does NOT do: nothing here changes the
 * transport, the link policy, or any existing verb — `log_read` stays
 * log-confined beside the generalized `file_read`, and `write_file`'s upload
 * roots stay exactly as narrow as they are while `transfer_write` arrives as
 * its own policy-gated sibling.
 *
 * **15 → 16 is the node SSH capability gate (spec 2026-10-07 §4.3).** One
 * owner-controlled flag per machine saying "this machine may take part in
 * Subshell SSH at all", off by default and fail-closed: `set_ssh_enabled`
 * carries the plane's value to the node's mirror file, `ready.sshEnabled`
 * states that mirror at connect, and the `ssh_enabled` event reports a mirror
 * that moved underneath the connection. Unlike maintenance there is no
 * node-side writer — the plane is the sole author and every reconcile pushes
 * the row, never the other way. Additive, and breaking anyway, because the
 * gate is exact-match — and breaking is the POINT here rather than a formality
 * to shrug through: a pre-16 agent never sees `set_ssh_enabled` and reports no
 * `sshEnabled`, which on the wire is indistinguishable from a 16 agent whose
 * mirror simply says no. A capability gate cannot live with that ambiguity
 * (spec §4.3), so the number is what refuses the old agent, not the frame.
 *
 * **16 -> 17:** the ssh launch block and the two discovery/resolve commands.
 * A lagging agent is HELD (update-only) until crossed, per the
 * capability-gate doctrine in docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md
 * §4.3; the desktop update path is the crossing. The ambiguity the bump
 * refuses: a tier-1 agent that ignores the launch frame's `ssh` member would
 * spawn a bare `ssh` pane with no `-F` config (§4.3's gate doctrine refuses to
 * live with that).
 *
 * **17 -> 18 (this tier):** the sealed agent relay
 * (docs/superpowers/specs/2026-10-08-ssh-agent-relay-design.md §5.1). The
 * `relay` link frame - a NEW frame kind on the established link, carrying one
 * sealed envelope keyed by the opaque routing ref, with no per-message
 * command signing - plus the `ssh_relay_open` / `ssh_relay_close` signed
 * commands that broker a session. This one cannot ride a silent tier: a
 * tier-17 agent understands no `relay` frame at all, and the exact-match
 * gate is what refuses pairing BEFORE any relay command is sent (§5.1's own
 * bump argument, §11's never-half-relay rule). Server first, as always.
 */
export const NODE_PROTOCOL_VERSION = 18;

/**
 * The FIRST protocol whose agents verify the publisher signature on an
 * `update` command (spec 2026-09-17 §6). Below this, an agent accepts
 * payload-only updates — which is exactly the silent-downgrade the bump
 * exists to make impossible — so the plane refuses to send `update` at all
 * and says so with `reason: "agent predates signed updates"` in the held/
 * below-floor grammar the Updates page already renders.
 *
 * A frozen fact about history, not a moving target: bump
 * {@link NODE_PROTOCOL_VERSION} freely; this stays 12.
 */
export const NODE_SIGNED_UPDATES_PROTOCOL_VERSION = 12;

/**
 * Frame ceiling both directions (spec §3.1). Bun's `maxPayloadLength` is
 * GLOBAL to the server, so each handler enforces this by byte length on
 * inbound messages rather than relying on server config (spec §7).
 */
export const NODE_MAX_FRAME_BYTES = 1_048_576;

/* ------------------------------------------------------------------ */
/* archive transfer (spec 2026-10-01 §2)                                */
/* ------------------------------------------------------------------ */

/**
 * Largest raw byte window one `file_read` may answer (and one `transfer_write`
 * chunk may carry). The number is DERIVED, not chosen: 512 KiB raw becomes
 * about 699 KB of base64 plus the envelope, which fits under
 * {@link NODE_MAX_FRAME_BYTES} both directions enforce. The uploads path made
 * this mistake once already with a 768 KiB chunk; do not enlarge windows.
 */
export const MAX_TRANSFER_WINDOW_BYTES = 512 * 1024;

/**
 * Largest UNCOMPRESSED tar an `archive_create` may emit (its entry bodies
 * plus headers). The gzip stage can only shrink what this bounds, and the
 * relay's time budget is what picks the number: at RTT-bound streaming
 * throughput (~5 MiB/s at 80 ms round trip, the link being serialized per
 * node) a transfer of this size finishes inside a sane synchronous
 * tool-call window. Bigger trees are a future job-queue conversation, not a
 * constant to raise.
 */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;

/** Largest single file that may enter an archive; also the extractor's per-entry cap. */
export const MAX_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Largest number of entries (files + directories) one archive may carry. */
export const MAX_ARCHIVE_ENTRIES = 100_000;

/**
 * Longest `files` list an `archive_create` may name. The list rides ONE
 * command frame, so the cap is a backstop beside the plane's own rule: when
 * the serialized list would approach the frame cap, the plane drops the list
 * and ships a whole-tree create instead (spec 2026-10-01 §2).
 */
export const MAX_TRANSFER_LIST_FILES = 5_000;

/** Largest number of rows one `tree_manifest` page may answer. */
export const MAX_MANIFEST_PAGE_ENTRIES = 500;

/** Largest `maxBytes` budget a `tree_manifest` page may be asked for. */
export const MAX_MANIFEST_PAGE_BYTES = 256 * 1024;

/**
 * The `.part` temp name the chunked writer creates BESIDE a final path
 * (dot-prefixed basename, rename-last discipline, spec 2026-10-01 §4). The
 * agent's writer, the plane's abort cleanup, and the node's orphan sweep all
 * derive it HERE: three sites naming the same file by hand is how a rename
 * silently loses cleanup, and this package exists so they cannot drift.
 * Pure string math (Metro-safe); POSIX separators only - every endpoint of
 * this seam is a tmux host.
 */
export function partPathOf(finalPath: string): string {
  const cut = finalPath.lastIndexOf("/");
  return `${finalPath.slice(0, cut + 1)}.${finalPath.slice(cut + 1)}.part`;
}

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
 * Close: the link refused to speak without the encryption handshake
 * (spec 2026-09-24 §6). Not terminal for the agent: the reason is relayed
 * to its own log and the existing backoff loop reconnects — the register
 * self-heal (§5) rides the next dial.
 *
 * Generic by design: a wrong-kind frame at the wrong phase, a pin mismatch,
 * an undecryptable stream, the 10-second handshake deadline. A pre-
 * establishment 4410 is NOT a re-pair signal (ruling R12b) — the agent stays
 * fully provisioned and redials, and a healthy handshake under a transient
 * stall heals on that redial. The re-pair signal is {@link
 * NODE_CLOSE_REPAIR_REQUIRED}.
 */
export const NODE_CLOSE_HANDSHAKE_REQUIRED = 4410;

/**
 * Close: the row holds no pin the claim matches — present a `register` to
 * re-pair (ruling R12b, spec 2026-09-24 §5's rotation arc). This is the
 * ONLY close code on which the agent drops its stale control pin (before
 * establishment, handshake mode, never self-refused): key rotation cleared
 * the row's pin, the handshake-mode `kx` claim is refused here by name, and
 * the redial re-registers the node's SAME static. {@link
 * NODE_CLOSE_HANDSHAKE_REQUIRED} deliberately does not trigger the drop —
 * the plane closes pre-establishment sockets with that code for ordinary
 * transient reasons (the handshake deadline foremost), and dropping the pin
 * there would turn a network blip into a permanently refused register
 * against a still-pinned row.
 */
export const NODE_CLOSE_REPAIR_REQUIRED = 4411;

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
 * `result.error` from a `launch` the agent refused because that machine is in
 * maintenance (spec 2026-09-14).
 *
 * The BARE string, never a prefixed one: the plane matches
 * `NodeRpcError.detail` by equality to map this onto its own 409, and a detail
 * it cannot match becomes a 500 naming nothing the operator can act on. That is
 * why this differs in shape from the agent's `DIR_REFUSED_MESSAGE`, which
 * appends the offending path for a human to read.
 */
export const NODE_RESULT_MAINTENANCE = "in maintenance";

/**
 * `result.error` from an `update` the agent refused because it is not a
 * compiled binary: `selfInvokePrefix()` answered WITH arguments, which means an
 * interpreter is running an entry script. There is no single file to swap, so
 * the remedy is updating that checkout, not downloading anything.
 *
 * Bare, like every constant here — the plane matches `NodeRpcError.detail` by
 * equality, and a helpful suffix reads there as an ordinary failure.
 */
export const NODE_RESULT_NOT_COMPILED = "not a compiled agent";

/**
 * `result.error` from an `update` whose bytes never arrived: the URL answered
 * a non-200, the connection died, or the transfer exceeded the agent's cap.
 *
 * The commonest real cause is a single-use download token the plane forgot
 * across its own restart, which the agent sees as a 401. That is why this is a
 * refusal the route reports rather than something to retry silently — the
 * operator presses Update again and gets a fresh token.
 */
export const NODE_RESULT_DOWNLOAD_FAILED = "download failed";

/**
 * `result.error` from an `update` whose downloaded bytes did not hash to the
 * `sha256` the command carried.
 *
 * Nothing was installed and the partial file is gone: the check happens before
 * the first `chmod +x`, which is what makes streaming the download sound.
 */
export const NODE_RESULT_DIGEST_MISMATCH = "digest mismatch";

/**
 * `result.error` from an `update` whose downloaded binary RAN but reported a
 * version other than the one the command named. A binary that cannot say what
 * it is does not get installed.
 */
export const NODE_RESULT_VERSION_MISMATCH = "installed binary reports a different version";

/**
 * `result.error` from an `update` whose release manifest the agent could not
 * tie to the publisher: the command carried no `manifest`/`manifestSig` (a
 * plane that predates protocol 12 must not be sending updates at all, but a
 * replayed old-shape command is exactly what this catches), or the signature
 * failed to verify against the compiled-in pubkey (spec 2026-09-17 §4: the
 * node checks the PUBLISHER even though the plane ordered the update).
 *
 * Bare, like every constant here — the plane matches `NodeRpcError.detail` by
 * equality; the sentence lives in the agent's own log.
 */
export const NODE_RESULT_MANIFEST_UNVERIFIED = "release manifest signature failed verification";

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
    /**
     * Linux only: whether this agent's OS user LINGERS
     * (`loginctl enable-linger`).
     *
     * An enabled `--user` unit comes back at LOGIN and dies at LOGOUT unless
     * the user lingers, in which case it comes back at BOOT with nobody
     * logged in. That is the whole question on a headless node, and it is a
     * different fact from {@link enabled} rather than a refinement of it.
     *
     * `null` on macOS (launchd has no such knob), when nothing is installed,
     * and when logind did not answer.
     */
    linger: boolean | null;
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
  /**
   * The machine's SSH trust block (spec 2026-10-08 §4.6): this machine's own
   * signing and encryption key fingerprints, and the pinned half of every
   * relay peer, as the canonical `SHA256:` form of `fingerprintJwk`.
   *
   * Fingerprints are the DISPLAY form of the trust the node enforces as raw
   * byte equality (`machine-pin-store.ts`): this block carries no key
   * material, only public identifiers, and exists so an operator can compare
   * what one machine STORED about a peer against what the peer COMPUTES from
   * its own keys. Absent from agents that predate M2, and dropped rather than
   * fatal when malformed, like `logging`.
   */
  sshFingerprint?: NodeSshFingerprintReport;
}

/**
 * One machine's two public relay halves as `SHA256:` fingerprints (spec
 * 2026-10-08 §4.5): the ES256 signing key and the ECDH-ES encryption key.
 */
export interface NodeSshFingerprintPair {
  /** Fingerprint of the ES256 machine-signing public key. */
  signing: string;
  /** Fingerprint of the ECDH-ES encryption public key. */
  encryption: string;
}

/** One pinned peer, named by id, with both of its fingerprints. */
export interface NodeSshPeerFingerprint extends NodeSshFingerprintPair {
  /** The pinned peer's node id. */
  nodeId: string;
}

/**
 * The §4.6 trust block: what this machine pins for itself and every peer,
 * computed from its OWN key files, never from the plane's copy of them. The
 * plane mirrors it onto `nodes.ssh_fingerprint` (the trust card's stale half).
 */
export interface NodeSshFingerprintReport {
  /** This machine's own both halves. */
  own: NodeSshFingerprintPair;
  /** Every pinned peer; the empty array is the honest "no peers yet". */
  peers: NodeSshPeerFingerprint[];
}

/**
 * The canonical fingerprint spelling of `fingerprintJwk`: the `SHA256:`
 * prefix and exactly the 43 unpadded base64url characters of a 32-byte
 * SHA-256 digest. Nothing else is admitted: the plane mirrors and renders
 * bytes it cannot re-derive, so a looser grammar would let another scheme's
 * digests into the same out-of-band comparison the block exists to enable.
 */
const SSH_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9_-]{43}$/;

/** Whether `value` is a canonical `SHA256:` fingerprint string. */
function isSshFingerprint(value: unknown): value is string {
  return typeof value === "string" && SSH_FINGERPRINT_RE.test(value);
}

/**
 * Node ids as the plane mints them: uuid text (hex and hyphens). `isNodeSubshellId`'s
 * shape, reused because a peer id reaching the block is the same registry id.
 */
function isPeerNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F-]{1,64}$/.test(value);
}

/** The `{ signing, encryption }` pair, or null when either half is off. */
function parseFingerprintPair(value: unknown): NodeSshFingerprintPair | null {
  if (!isRecord(value)) return null;
  if (!isSshFingerprint(value.signing) || !isSshFingerprint(value.encryption)) return null;
  return { signing: value.signing, encryption: value.encryption };
}

/**
 * Shape-check a `NodeSshFingerprintReport` (the runtime report's §4.6 block).
 * STRICT inside, like every required field of the runtime report it rides:
 * a half-refused block would print a trust card whose compare is meaningless,
 * so one bad entry refuses the whole block (the block itself is dropped from
 * the runtime report leniently, the `logging` way: the card is lost, not the
 * connection).
 * @param value - the candidate, typically `ready.runtime.sshFingerprint`
 * @returns the narrowed report, or null when malformed
 */
export function parseNodeSshFingerprintReport(value: unknown): NodeSshFingerprintReport | null {
  if (!isRecord(value) || !Array.isArray(value.peers)) return null;
  const own = parseFingerprintPair(value.own);
  if (own === null) return null;
  const peers: NodeSshPeerFingerprint[] = [];
  for (const entry of value.peers) {
    if (!isRecord(entry) || !isPeerNodeId(entry.nodeId)) return null;
    const pair = parseFingerprintPair(entry);
    if (pair === null) return null;
    peers.push({ nodeId: entry.nodeId, signing: pair.signing, encryption: pair.encryption });
  }
  return { own, peers };
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
    !(s.linger === null || isBool(s.linger)) ||
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
  // Lenient like `logging`, strict inside: a present-but-malformed block
  // drops the BLOCK (no trust card), never the runtime report beside it
  // (paths, supervision, the verbs). A valid one passes through narrowed.
  const sshFingerprint =
    value.sshFingerprint === undefined ? null : parseNodeSshFingerprintReport(value.sshFingerprint);
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
      linger: s.linger,
      paneSafety,
    },
    configPath: value.configPath,
    agentLogPath: value.agentLogPath,
    logPath: value.logPath,
    logHint: value.logHint,
    tmuxPath: value.tmuxPath,
    binaryPath: value.binaryPath,
    ...(sshFingerprint ? { sshFingerprint } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* subshell-id policy                                                    */
/* ------------------------------------------------------------------ */

/**
 * The uuid-ish subshell-id guard: ids interpolated into node-side paths.
 * The agent enforces it (its `isSubshellId` is an alias of this), and the
 * backend gates the ids it interpolates via the same guard since 2026-09-23
 * (`assertNodePathId` in `services/nodes/node-path-id.ts`, called at every
 * `RemoteLauncher`/`planRemoteSubshellMcp` path-composition site) — so
 * "a hostile `../../../../x` never reaches path interpolation" holds on BOTH
 * sides of the link, and the old promise of a server-side mirror is now
 * actually kept. Subshell ids are minted as uuids, so hex + hyphen (≤ 64
 * chars) is all a legitimate id ever contains.
 */
export function isNodeSubshellId(id: string): boolean {
  return /^[0-9a-fA-F-]{1,64}$/.test(id);
}

/**
 * Structural JSON mirror of `@internal/pane-runtime`' `PresetDefinition`.
 *
 * Deliberately a copy: subshell-protocol is bundled by the frontend and must
 * not pull harnesses (which imports node:fs) at runtime (spec §3.2). The
 * agent decodes the blob against the real `PresetDefinition` at launch.
 */
export interface PresetDefinitionWire {
  /** Human-friendly preset name */
  name: string;
  /** Optional longer description */
  description?: string | null;
  /** Extra environment variables to set on the subshell (validated key names) */
  env: Record<string, string>;
  /** Extra CLI flags to pass to the harness binary */
  flags: string[];
  /** Settings blob passed to the harness (opaque JSON) */
  settings: Record<string, unknown> | null;
  /** If true, only this preset's config sources apply (isolation) */
  configIsolation: boolean;
  /** If true, new subshells from this preset auto-restart on exit */
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
      /** Launch config (mirror of harnesses PresetDefinition) */
      preset: PresetDefinitionWire;
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
      /**
       * The ssh pane's rendered config: the content the plane composed from
       * the approved snapshot, plus the absolute node-side path the agent
       * writes it to. The file-placement contract is the `mcp` block's: 0600
       * in a 0700 dir, derived from the node's own `dataDir`, written before
       * spawn, and the exit watch deletes the derived path beside the pane's
       * other artifacts. The pane's argv names `-F` at this path; present
       * only for ssh launches, absent for every harness pane.
       */
      ssh?: { configPath: string; fileContent: string };
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
  | {
      /**
       * The pane's cursor, in viewport coordinates (0-based, as tmux reports
       * it) — the remote twin of `pane_size` for the same reason: the attach
       * replay must END on the row the pane's cursor is on, or every later
       * live byte paints at a row the pane and the client disagree about
       * (the 2026-09-23 "prompt-at-top, typing-off-screen" browser report).
       * Null (pane gone) is a legal result; the caller then ships the replay
       * without a cursor restore, exactly as it did before this command.
       */
      type: "pane_cursor";
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
    }
  | {
      /**
       * Write this node's maintenance mirror file (spec 2026-09-14).
       *
       * The plane's half of a two-way flag. It writes the file and nothing
       * else — in particular it kills no panes, because a plane-side flip has
       * already terminated every row it knew about through the ordinary
       * per-subshell path, which does the bookkeeping (token revocation, audit,
       * the owner's notification) that a blind kill on the machine would not.
       *
       * Carries the plane's own `changedAt` rather than letting the node stamp
       * its own: both copies must end byte-identical, or the next reconnect
       * reconciles two values that differ only because they were written at
       * different instants.
       */
      type: "set_maintenance";
      /** True = the node accepts no new subshells. */
      on: boolean;
      /** The plane's stamp for this value; stored verbatim. */
      changedAt: string;
    }
  | {
      /**
       * Write this node's SSH-capability mirror file (spec 2026-10-07 §4.3).
       *
       * The plane's ONLY writing copy of the flag — unlike maintenance there
       * is no keyboard verb to race, so this is the only frame that ever
       * changes the file apart from a repair of a corrupt one. It writes the
       * file and nothing else: turning SSH off kills no panes (SSH acts are
       * short-lived per-command work, and turning it ON widens nothing this
       * machine was already refusing mid-flight).
       *
       * Carries the plane's own `changedAt` rather than letting the node stamp
       * its own: both copies must end byte-identical, so a later `ready`
       * report reads as agreement rather than a disagreement this process
       * invented.
       */
      type: "set_ssh_enabled";
      /** True = this machine may be used for Subshell SSH. */
      on: boolean;
      /** The plane's stamp for this value; stored verbatim. */
      changedAt: string;
    }
  | {
      /**
       * Replace this agent's own binary and restart into it (spec 2026-09-15 §5.2).
       *
       * **THIS SHAPE IS FROZEN ACROSS FUTURE PROTOCOL BUMPS.** Every other
       * command travels between two ends that agreed on
       * {@link NODE_PROTOCOL_VERSION} — the gate is exact-match, so a rename
       * costs nothing but a version number. This one is different: it is the
       * command the plane sends to an agent whose protocol it does NOT share
       * (§5.3 — such an agent is HELD rather than dropped, precisely so this
       * can reach it). So the agent parsing it may be any older build, and the
       * plane encoding it may be any newer one. Renaming a field, or changing
       * what one means, breaks the only path by which a stranded machine can
       * be rescued from a browser. Add nothing here that an old agent must
       * understand; anything new must be optional and ignorable.
       *
       * The agent decides, as it does for `service`: it applies the same two
       * refusals (not supervised, and a definition that would take live panes
       * down without `force`), verifies the digest before the first `chmod`,
       * and answers `{ ok: true }` BEFORE exiting so the plane reads a success
       * rather than a timeout.
       */
      type: "update";
      /** The version the downloaded binary must report from `<binary> version`. */
      version: string;
      /** Absolute http(s) URL the bytes come from; the plane bakes a single-use token into it. */
      url: string;
      /** Lowercase-hex sha256 the downloaded bytes must hash to, from the same release. */
      sha256: string;
      /** Act even though the service definition's `paneSafety` is not `keeps`. */
      force?: boolean;
      /**
       * Base64 of the release's EXACT `release-manifest.json` bytes (spec
       * 2026-09-17 §6). Protocol 12 agents verify this against the
       * compiled-in publisher pubkey and require the downloaded bytes to hash
       * to the digest the SIGNED map names for this platform's artifact; a
       * plane below 12 is refused the update command entirely, so an
       * agent-built-from-HEAD never sees this absent. It is OPTIONAL in the
       * parser because the shape is frozen: the parser must stay the one an
       * old agent would have written, and old agents ignore the field —
       * enforcement lives in the executor and in the plane's refusal to send
       * unsigned commands, not in the grammar.
       */
      manifest?: string;
      /** The manifest's minisign armor (`release-manifest.json.sig` text). */
      manifestSig?: string;
    }
  | {
      /**
       * Build the transfer's source archive node-side (spec 2026-10-01 §2/§4):
       * walk `root` (whole tree, or exactly the listed `files`), stream it as
       * a gzip tar into `stagingPath`, answer `{ size, sha256 }` over the
       * COMPRESSED staging file — the digest the destination re-verifies
       * before extracting anything.
       *
       * `stagingPath` is plane-minted (a unique name under the node's data
       * dir) precisely so a timed-out retry cannot double-write into the
       * first attempt's file. The allowlist check against `root` is the
       * agent's; the parser carries shape.
       */
      type: "archive_create";
      /** Absolute directory on this node the archive is built from. */
      root: string;
      /**
       * Transfer-relative paths (clean, no `..`, no leading slash) selecting
       * the subset to archive; ABSENT means the whole tree under `root`.
       */
      files?: string[];
      /** Absolute path under this node's data dir where the .tar.gz lands. */
      stagingPath: string;
    }
  | {
      /**
       * Read a byte window of an arbitrary file (spec 2026-10-01 §2). This is
       * the generalized `log_read` — same shape, its OWN policy: `log_read`
       * stays confined to `<dataDir>/subshells/<id>.log` and the two
       * never share a code path or a name (the pane logs hold what operators
       * typed; this one answers transfer payloads). `maxBytes` is parser-capped
       * at {@link MAX_TRANSFER_WINDOW_BYTES}: the window is what must fit the
       * frame, and a parser that allowed more would advertise a lie.
       */
      type: "file_read";
      /** Absolute path on this node to read. */
      path: string;
      /** Byte offset to read from; 0 is the start of the file. */
      fromByte: number;
      /** Cap on bytes returned; {@link MAX_TRANSFER_WINDOW_BYTES} at most. */
      maxBytes: number;
    }
  | {
      /**
       * Chunked write of a transfer payload (spec 2026-10-01 §4). NOT
       * `write_file`, and not its sibling by accident: `write_file` serves
       * terminal uploads and is gated to the data dir plus tracked working
       * dirs — twice, pinned by tests — and widening IT would weaken a
       * load-bearing policy. This verb carries the operator-allowlist policy
       * instead, and the word-order difference (`transfer_write` vs
       * `write_file`) is what stops the next reviewer merging them.
       *
       * Discipline is `write_file`'s verbatim: `.part` beside the final path,
       * mode 0600, strict chunk sequencing, the policy re-checked at `eof`,
       * one rename to land. Answers the `NodeWriteFileResult` shape on every
       * chunk.
       */
      type: "transfer_write";
      /** Absolute destination path on this node (the final name, not the .part). */
      path: string;
      /** Base64 of this chunk's bytes; the decoded length is window-capped agent-side. */
      chunkB64: string;
      /** Zero-based chunk index; chunks must arrive in order. */
      chunk: number;
      /** Last chunk: re-check policy, fsync-equivalent, rename, answer. */
      eof: boolean;
    }
  | {
      /**
       * Extract a transfer archive node-side (spec 2026-10-01 §3/§4) into
       * `destRoot`, ADDITIVE: matching paths are overwritten, everything
       * else at the destination is left alone, nothing is ever deleted.
       * Guards run after pax substitution; links and devices are refused
       * outright. The digest is named HERE and the agent re-hashes the
       * landed file before its first entry lands (spec §3's promise kept
       * on the disk that stores it, not only on the wire that carried it:
       * rename-to-corruption between relay and extract is this check's
       * case); the plane's own incremental verify is why extraction can
       * EVER run, this is why it runs on intact bytes.
       */
      type: "archive_extract";
      /** Absolute path of the archive on this node (lands via `transfer_write`). */
      archivePath: string;
      /** `archive_create`'s digest over the compressed file, re-checked before extraction. */
      expectedSha256: string;
      /** Absolute directory to extract into; allowlist-gated agent-side. */
      destRoot: string;
    }
  | {
      /**
       * Walk a tree deterministically and answer per-file facts, paged
       * (spec 2026-10-01 §2/§4): the plane diffs two manifests on SHA-256 to
       * compute a sync's changed set. `relPath` is transfer-relative (no
       * `..`), entries sorted, the cursor resumes strictly after the last
       * returned `relPath`. Trees that mutate mid-walk can dup or skip
       * across pages; sync is eventual-convergent and re-running is the
       * remedy.
       */
      type: "tree_manifest";
      /** Absolute directory to walk; allowlist-gated agent-side (its policy). */
      root: string;
      /**
       * Opaque resume cursor: the previous page's `nextCursor`. Absent means
       * from the beginning; the agent treats it as a `relPath` to resume
       * after, never as a path to touch.
       */
      cursor?: string;
      /**
       * Byte budget for the answer's JSON, at most
       * {@link MAX_MANIFEST_PAGE_BYTES}. Required, unlike `cursor`: a page
       * with no budget is an agent paging by its own guess, and the caller
       * sizing round trips is the caller that knows the frame cap.
       */
      maxBytes: number;
    }
  // The SSH commands: three members folded in as one union member so the SSH
  // grammar lives in `ssh-frames.ts` beside the commands it narrows; their
  // answers are validated by the ssh result parsers in `node-results.ts`.
  | SshNodeCommandBody;

/**
 * One node's maintenance state, as it travels in either direction.
 *
 * `changedAt` is the whole reconciliation protocol: the two sides hold
 * independent copies, either may be written while the other is unreachable,
 * and on reconnect the NEWER stamp wins (ties to the plane, which is the
 * record). It is therefore a fact about the write, not a display string —
 * never re-stamp a value you are merely relaying, or the relay outranks the
 * decision it was carrying.
 */
export interface NodeMaintenanceWire {
  /** True = this node accepts no new subshells. */
  on: boolean;
  /** ISO 8601 stamp of the write that produced this value. */
  changedAt: string;
}

/** A {@link NodeMaintenanceWire}, or null when the value is not one. */
export function parseNodeMaintenance(value: unknown): NodeMaintenanceWire | null {
  if (!isRecord(value) || !isBool(value.on) || !isStr(value.changedAt)) return null;
  return { on: value.on, changedAt: value.changedAt };
}

/**
 * One node's SSH capability, as it travels in either direction (spec
 * 2026-10-07 §4.3) — the same `{ on, changedAt }` shape as maintenance, with
 * the default and the reconcile direction inverted: `on` means this machine
 * MAY take part in Subshell SSH, and only the plane writes it.
 *
 * `changedAt` is the stamp of the write that produced `on`, carried verbatim
 * in both directions so the two copies stay byte-identical and neither side
 * can mistake a relay for a new decision. Nothing here compares stamps: the
 * plane is authoritative and every disagreement ends with the plane's value
 * pushed down.
 */
export interface NodeSshEnabledWire {
  /** True = this machine may be used for Subshell SSH. */
  on: boolean;
  /** ISO 8601 stamp of the write that produced this value. */
  changedAt: string;
}

/** A {@link NodeSshEnabledWire}, or null when the value is not one. */
export function parseNodeSshEnabled(value: unknown): NodeSshEnabledWire | null {
  if (!isRecord(value) || !isBool(value.on) || !isStr(value.changedAt)) return null;
  return { on: value.on, changedAt: value.changedAt };
}

/** Agent → control events, unsigned (socket-authed; spec §3.3). */
/**
 * One field of a plugin's preset-editor schema, as it travels.
 *
 * A `type` alias rather than an `interface`, and the same for the two below:
 * an interface has no implicit index signature, so it is not assignable to
 * `JsonValue`, and these ride inside a command RESULT which is typed as one.
 */
export type SettingsFieldWire = {
  /** Key into the preset's settings object */
  key: string;
  /** Property label */
  label: string;
  /** Short description for the editor */
  description?: string;
  /**
   * Editor control kind.
   *
   * Mirrors `SettingsField["type"]` in `@subshell-ai/plugin-api`, which is why
   * `secret` is in the union: the two must agree or a plugin's own schema will
   * not assign to the wire's. It cannot actually appear HERE — `secret` is
   * network-only and a node is sent harness preset fields — and a node that
   * received one would render a password box for a value it must never hold.
   */
  type: "string" | "boolean" | "number" | "select" | "secret";
  /** Choices when type is "select" */
  choices?: string[];
  /** True when the field must be set before the plugin can act */
  required?: boolean;
  /** Placeholder / example for the editor. Never a real credential. */
  placeholder?: string;
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
 * to list it, render its preset editor, label its exit codes and explain its
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
  /** Settings rendered in the preset editor */
  presetSettings?: SettingsFieldWire[];
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

/* ------------------------------------------------------------------ */
/* sealed agent relay link frame (spec 2026-10-08 §5.1)                */
/* ------------------------------------------------------------------ */

/**
 * The relay directions as a runtime list beside the type: one definition, and
 * everything that iterates or validates reads these (code-style rule).
 */
export const RELAY_DIRECTIONS = ["B2A", "A2B"] as const;

/** Which way one relay envelope travels inside its session (spec §5.1). */
export type RelayDirection = (typeof RELAY_DIRECTIONS)[number];

/** Whether `value` is one of the two relay directions (narrows to the type). */
export function isRelayDirection(value: unknown): value is RelayDirection {
  return (RELAY_DIRECTIONS as readonly unknown[]).includes(value);
}

/**
 * The `relay` link frame: ONE sealed envelope per frame, on the established
 * (protocol-18) link, keyed by the opaque routing ref (§5.1). It is NOT a
 * command and NOT signed per message: the link already authenticates the
 * machine, and origin rides the inner ES256 signature the endpoints exchange
 * (§5.6), which the plane never sees. The plane's only roles are open,
 * route, close - so `blob` is opaque BY CONTRACT: this grammar validates the
 * SHAPE and the size and decodes nothing in between. `seq` is the frame's
 * transport slot (the anti-replay `seq` lives SIGNED inside the envelope,
 * §5.6); here it only needs to be a non-negative integer both ends can log.
 *
 * The frame travels BOTH directions of the link. On the plane's inbound path
 * it arrives like every other agent frame (it joins {@link NodeEvent} for
 * that); the plane-to-node leg serializes the same object down the
 * established link and the node parses it with {@link parseRelayFrame}
 * directly. The routing ref pairs the two legs; the broker (Task 8) owns
 * that pairing, never this grammar.
 */
export interface RelayFrame {
  type: "relay";
  /** The opaque routing ref the relay-open command established. */
  ref: string;
  /** Per-frame counter on THIS leg; monotonic, non-negative. */
  seq: number;
  /** The envelope's logical direction inside the session, both spellings. */
  direction: RelayDirection;
  /** The sealed envelope, strict base64, raw payload at most SSH_RELAY_FRAME_MAX_BYTES. */
  blob: string;
}

/**
 * Exact raw length a strict-base64 string carries: 3 bytes per whole group
 * minus the pad. BASE64_RE already forces the length to a multiple of 4, so
 * the trailing-`=` count alone closes the last group. Measuring the cap on
 * the RAW payload (not the inflated string) is what makes the bound honest:
 * a char-length cap would let a padded group carry one byte past
 * {@link SSH_RELAY_FRAME_MAX_BYTES} while reading exactly as long.
 */
function base64RawLength(b64: string): number {
  let pad = 0;
  for (let i = b64.length - 1; i >= 0 && b64[i] === "="; i -= 1) pad += 1;
  return (b64.length / 4) * 3 - pad;
}

/**
 * Validates and narrows a relay link frame (raw JSON text or the
 * already-parsed object, same intake as {@link parseNodeEvent}). A present-
 * but-undecodable blob is malformed, not deferred; an over-cap blob is
 * REFUSED here because the cap is law (§5.1: over-cap frame refused, session
 * closed with a named reason - the close is the broker's, the refusal is
 * this function's). The blob's CONTENTS are never inspected: blindness is
 * the point (§5.5).
 *
 * @param raw - candidate frame as received
 * @returns the narrowed frame, or null when malformed / not a relay frame
 */
export function parseRelayFrame(raw: string | object): RelayFrame | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || value.type !== "relay") return null;
  if (!isStr(value.ref) || value.ref.length === 0) return null;
  if (!isInt(value.seq) || (value.seq as number) < 0) return null;
  if (!isRelayDirection(value.direction)) return null;
  if (!isStr(value.blob) || value.blob.length === 0 || !BASE64_RE.test(value.blob)) return null;
  if (base64RawLength(value.blob) > SSH_RELAY_FRAME_MAX_BYTES) return null;
  return { type: "relay", ref: value.ref, seq: value.seq as number, direction: value.direction, blob: value.blob };
}

/**
 * The routing ref of a WELL-FORMED `relay` candidate (the same shape checks
 * {@link parseRelayFrame} runs, in the same order) whose decoded blob
 * EXCEEDS SSH_RELAY_FRAME_MAX_BYTES - i.e. exactly the one refusal reason
 * `parseRelayFrame` answers with a plain null, which §5.1 says must end the
 * session with a NAMED reason instead. The strict parse stays strict (the
 * `NodeEvent` union must not carry an over-cap frame); this probe exists so
 * the caller that just got a null back can tell "junk, drop quietly" from
 * "over-cap, name the refusal". Only shape + the raw length of the blob are
 * examined; the bytes themselves are never decoded or copied (§5.5's
 * blindness). Junk of any kind answers null, never an error.
 *
 * @param value - candidate frame, raw JSON text or the already-parsed object
 * @returns the routing ref when the candidate is relay-shaped AND over-cap,
 *   null for anything else (junk, malformed relay, under-cap)
 */
export function relayFrameRefIfOverCap(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed.type !== "relay") return null;
  if (!isStr(parsed.ref) || parsed.ref.length === 0) return null;
  if (!isInt(parsed.seq) || (parsed.seq as number) < 0) return null;
  if (!isRelayDirection(parsed.direction)) return null;
  if (!isStr(parsed.blob) || parsed.blob.length === 0 || !BASE64_RE.test(parsed.blob)) return null;
  return base64RawLength(parsed.blob) > SSH_RELAY_FRAME_MAX_BYTES ? parsed.ref : null;
}

/** Whether `value` is a well-formed `relay` candidate carrying an over-cap blob. */
export function relayFrameOverCap(value: unknown): boolean {
  return relayFrameRefIfOverCap(value) !== null;
}

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
      /**
       * This machine's maintenance mirror, as its file reads at connect (spec
       * 2026-09-14). Absent means the node has no file, which reads as off.
       *
       * Dropped rather than fatal when malformed, like `runtime`: the rest of
       * this frame is what brings the node online, and a node whose mirror is
       * unreadable must still connect — the plane then reconciles it from its
       * own record, which is the only way that file gets repaired.
       */
      maintenance?: NodeMaintenanceWire;
      /**
       * This machine's SSH-capability mirror, as its file reads at connect
       * (spec 2026-10-07 §4.3). Absent means the node has no file — which for
       * SSH reads as REFUSED (fail-closed), not as agreeing with the row.
       *
       * Dropped rather than fatal when malformed, exactly like `maintenance`:
       * the refusal is the safe direction, and the plane reconciles the
       * disagreement from its own row on the very same `ready`.
       */
      sshEnabled?: NodeSshEnabledWire;
    }
  | {
      /**
       * The machine flipped its own maintenance state (spec 2026-09-14).
       *
       * Sent when the file on disk differs from what this connection last
       * reported: after `subshell maintenance on|off` at the keyboard, and
       * immediately before the deaths that flip causes, so the plane knows WHY
       * the panes are about to disappear rather than reporting them as crashes.
       */
      type: "maintenance";
      /** True = this node accepts no new subshells. */
      on: boolean;
      /** ISO 8601 stamp of the write on the machine. */
      changedAt: string;
    }
  | {
      /**
       * This machine's SSH mirror moved underneath the connection (spec
       * 2026-10-07 §4.3) — the heartbeat belt's carrier.
       *
       * With no node-side writer there is no keyboard flip to report (that is
       * what `set_maintenance`'s sibling event exists for); what this carries
       * is a file that changed by some other means — chiefly CORRUPTION, which
       * flips a machine from "allowed" to "refused" silently and would
       * otherwise stay a secret until the next reconnect. The plane's answer
       * to any disagreement is a push of its row, which is also the repair.
       */
      type: "ssh_enabled";
      /** The refusal/allowance this machine is acting on, as its mirror reads. */
      on: boolean;
      /** ISO 8601 stamp from the file (its own mtime when the file is unreadable). */
      changedAt: string;
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
  | { type: "error"; code: string; message: string }
  /**
   * The sealed agent-relay leg (spec 2026-10-08 §5.1). Folded in for the
   * PLANE's inbound path: every relay frame the plane reads arrives on an
   * agent socket, where `parseNodeEvent` is the one kind dispatcher and the
   * held-gate/supersede-probe that follow are exactly the guards a shuttle
   * frame should pass through. On the plane-to-node leg the node parses the
   * same shape with {@link parseRelayFrame} directly; "event" here names the
   * inbound-to-plane position, not a claim that the node volunteered it.
   */
  | RelayFrame;

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

function validPresetWire(p: unknown): p is PresetDefinitionWire {
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
      if (!validPresetWire(value.preset) || !isStringMap(value.subshellEnv)) return null;
      if (!isStr(value.subshellName)) return null;
      if ("mcp" in value) {
        const m = value.mcp;
        if (!isRecord(m) || !isStr(m.path) || !isStr(m.fileContent)) return null;
        if ("args" in m && !isStrArray(m.args)) return null;
        if ("env" in m && !isStringMap(m.env)) return null;
      }
      if ("ssh" in value) {
        const ssh = value.ssh as unknown;
        if (
          typeof ssh !== "object" ||
          ssh === null ||
          typeof (ssh as { configPath?: unknown }).configPath !== "string" ||
          !(ssh as { configPath: string }).configPath.startsWith("/") ||
          (ssh as { configPath: string }).configPath.length > SSH_PATH_MAX_CHARS ||
          typeof (ssh as { fileContent?: unknown }).fileContent !== "string" ||
          (ssh as { fileContent: string }).fileContent.length > SSH_CONFIG_FILE_MAX_BYTES
        ) {
          return null;
        }
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
    case "pane_cursor": {
      if (typeof value.subshellId !== "string") return null;
      return { type: "pane_cursor", subshellId: value.subshellId };
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
    case "set_maintenance": {
      const state = parseNodeMaintenance(value);
      return state ? { type: "set_maintenance", ...state } : null;
    }
    case "set_ssh_enabled": {
      const state = parseNodeSshEnabled(value);
      return state ? { type: "set_ssh_enabled", ...state } : null;
    }
    case "update": {
      // Shape only, like `set_server_url` above: WHICH url is acceptable is
      // the plane's to decide, and the digest is checked against the bytes
      // rather than against a regex. What this arm does enforce is that all
      // three required fields are non-empty strings — the FROZEN shape (see
      // the command's own note) is what an older agent will parse forever,
      // so it is spelled out field by field rather than cast wholesale.
      if (!isStr(value.version) || value.version.length === 0) return null;
      if (!isStr(value.url) || value.url.length === 0) return null;
      if (!isStr(value.sha256) || value.sha256.length === 0) return null;
      const base = { type: "update", version: value.version, url: value.url, sha256: value.sha256 } as const;
      // Protocol 12 additions (spec 2026-09-17 §6): optional, and OPTIONAL AT
      // THE PARSER BY DECREE — the frozen-shape rule says an old agent parses
      // this command forever, so these fields may only ever be ignored here
      // and enforced in the executor. A present-but-empty or non-string one
      // is malformed rather than absent: a plane that meant to sign and
      // didn't gets a refused frame, not an unsigned-looking command.
      const withManifest = { ...base } as {
        type: "update";
        version: string;
        url: string;
        sha256: string;
        manifest?: string;
        manifestSig?: string;
      };
      if ("manifest" in value) {
        if (!isStr(value.manifest) || value.manifest.length === 0 || !BASE64_RE.test(value.manifest)) return null;
        withManifest.manifest = value.manifest;
      }
      if ("manifestSig" in value) {
        if (!isStr(value.manifestSig) || value.manifestSig.length === 0) return null;
        withManifest.manifestSig = value.manifestSig;
      }
      if (!("force" in value)) return withManifest;
      return isBool(value.force) ? { ...withManifest, force: value.force } : null;
    }
    case "archive_create": {
      // Shape and the list cap only: absoluteness of root/stagingPath and the
      // operator-allowlist verdict are the agent's (same division as
      // stat_dir/fs_ls), and the entries inside `files` are checked by the
      // archive writer's own path guard when each one is emitted.
      if (!isStr(value.root) || !isStr(value.stagingPath)) return null;
      if ("files" in value) {
        if (!isStrArray(value.files) || value.files.length > MAX_TRANSFER_LIST_FILES) return null;
        return { type: "archive_create", root: value.root, files: value.files, stagingPath: value.stagingPath };
      }
      return { type: "archive_create", root: value.root, stagingPath: value.stagingPath };
    }
    case "file_read":
      return isStr(value.path) &&
        isInt(value.fromByte) &&
        (value.fromByte as number) >= 0 &&
        isInt(value.maxBytes) &&
        (value.maxBytes as number) > 0 &&
        (value.maxBytes as number) <= MAX_TRANSFER_WINDOW_BYTES
        ? { type: "file_read", path: value.path, fromByte: value.fromByte, maxBytes: value.maxBytes }
        : null;
    case "transfer_write":
      // Same grammar as write_file (a present-but-undecodable chunk is
      // malformed, not "arrives later"); the executor adds sequencing.
      return isStr(value.path) &&
        isStr(value.chunkB64) &&
        BASE64_RE.test(value.chunkB64) &&
        isInt(value.chunk) &&
        (value.chunk as number) >= 0 &&
        isBool(value.eof)
        ? { type: "transfer_write", path: value.path, chunkB64: value.chunkB64, chunk: value.chunk, eof: value.eof }
        : null;
    case "archive_extract":
      // The digest is part of the contract, not a hint: a frame that names
      // an archive without the hash the destination must re-check is a
      // caller that never intended to verify, and the grammar refuses it.
      return isStr(value.archivePath) &&
        isStr(value.destRoot) &&
        isStr(value.expectedSha256) &&
        /^[0-9a-f]{64}$/.test(value.expectedSha256)
        ? {
            type: "archive_extract",
            archivePath: value.archivePath,
            expectedSha256: value.expectedSha256,
            destRoot: value.destRoot,
          }
        : null;
    case "tree_manifest":
      // maxBytes REQUIRED and window-capped (see the arm's field note); the
      // cursor is an opaque string when present — what it means belongs to
      // the walker, not the grammar.
      if (!isStr(value.root)) return null;
      if ("cursor" in value && !isStr(value.cursor)) return null;
      if (
        !isInt(value.maxBytes) ||
        (value.maxBytes as number) <= 0 ||
        (value.maxBytes as number) > MAX_MANIFEST_PAGE_BYTES
      )
        return null;
      return "cursor" in value
        ? { type: "tree_manifest", root: value.root, cursor: value.cursor as string, maxBytes: value.maxBytes }
        : { type: "tree_manifest", root: value.root, maxBytes: value.maxBytes as number };
    case "ssh_discover_aliases":
    case "ssh_resolve_config":
    case "ssh_register_identity":
    case "ssh_agent_identities":
    case "ssh_host_key":
    case "ssh_relay_open":
    case "ssh_relay_close":
      // Delegation, not a second parser: the SSH grammar (all arms, one
      // file) lives in ssh-frames.ts beside the commands it narrows.
      return parseSshNodeCommandBody(value);
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
      // `runtime`, `maintenance` and `sshEnabled` are additive: a malformed
      // one is dropped so the connection still comes up without it, rather
      // than refused. For `sshEnabled` the drop is also SAFE in a way the
      // others are not quite: the plane answers silence with its row (a row
      // that says on pushes down), so a malformed field cannot strand a
      // machine on the wrong side of the gate.
      const {
        runtime: rawRuntime,
        maintenance: rawMaintenance,
        sshEnabled: rawSshEnabled,
        ...rest
      } = value as Record<string, unknown> & { runtime?: unknown; maintenance?: unknown; sshEnabled?: unknown };
      const runtime = rawRuntime === undefined ? null : parseNodeRuntimeReport(rawRuntime);
      const maintenance = rawMaintenance === undefined ? null : parseNodeMaintenance(rawMaintenance);
      const sshEnabled = rawSshEnabled === undefined ? null : parseNodeSshEnabled(rawSshEnabled);
      return {
        ...(rest as unknown as Extract<NodeEvent, { type: "ready" }>),
        ...(runtime ? { runtime } : {}),
        ...(maintenance ? { maintenance } : {}),
        ...(sshEnabled ? { sshEnabled } : {}),
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
    case "maintenance": {
      // Strict, unlike the `ready` field above: this frame IS the change, so a
      // malformed one dropped quietly would leave the plane believing the
      // opposite of what the machine is doing.
      const state = parseNodeMaintenance(value);
      return state ? { type: "maintenance", ...state } : null;
    }
    case "ssh_enabled": {
      // Strict for the same reason: this frame is the machine reporting what
      // it is acting on; half of it is not an answer.
      const state = parseNodeSshEnabled(value);
      return state ? { type: "ssh_enabled", ...state } : null;
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
    case "relay":
      // Delegation, like the SSH commands: the relay frame's whole contract
      // (ref, seq, direction, capped opaque blob) lives in parseRelayFrame
      // beside the type it narrows.
      return parseRelayFrame(value);
    default:
      return null;
  }
}
