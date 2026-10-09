/**
 * The SSH resource limits. The NUMBERS were frozen at the Gate A
 * implementation and carried verbatim from the reference lineage (design
 * 2026-10-05 §7); the governing design for this product line is
 * docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md, which sets the
 * policy for these budgets without restating the numerals.
 *
 * Everything here is PURE data: named frozen values plus the derived bounds
 * the wire parsers enforce, so neither end of the link can drift. They are
 * law, not local convenience - changing one is a coordinated edit - which is
 * why they live here rather than in the packages that act on them.
 *
 * The destination execution product's limits (run deadlines, active-run and
 * terminal quotas, output retention and aggregate storage, the read window
 * and long-poll caps) deleted with it (design 2026-10-05 §7). Of what
 * remains: the grammar bounds are enforced by this tier's parsers and the
 * probe deadline by its engines, while the cancel grace and the
 * session-runtime table describe the brokered-session subsystem this product
 * line deliberately does not carry (spec section 15) - they ride along
 * because the set is frozen as a whole, and nothing on this branch enforces
 * them.
 *
 * Imports no `node:` builtin; this module is in the Metro-safe barrel.
 */

/* ------------------------------------------------------------------ */
/* frozen at the Gate A implementation (design 2026-10-05 lineage); governing policy:
   docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md - one export each */
/* ------------------------------------------------------------------ */

/**
 * Connection/setup probe: a 30-second OVERALL deadline, and no automatic
 * execution retry ever (a value frozen at the Gate A implementation and
 * carried verbatim; the no-retry rule is the durable-dispatch contract, not a
 * tuning knob).
 */
export const SSH_PROBE_DEADLINE_MS = 30 * 1000;

/* ------------------------------------------------------------------ */
/* derived contract bounds (chosen at the Gate A freeze, parser-enforced) */
/* ------------------------------------------------------------------ */

/**
 * Bounded ProxyJump chain (docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md, section 4.1).
 * FOUR is a freeze decision, not a spec value: beyond four hops a normalized
 * hop table stops being humanly reviewable, which is the whole point of
 * reviewing the route before saving it. Resolution refuses longer chains by
 * name (`proxy_chain_too_long`); the hop count a snapshot may carry is
 * validated at every command that embeds one.
 */
export const SSH_MAX_PROXY_HOPS = 4;

/** Identity-file references one approved snapshot may name. Absolute paths, never contents. */
export const SSH_MAX_IDENTITY_REFS = 8;

/** Certificate-file references one approved snapshot may name (OpenSSH allows several `CertificateFile` lines). */
export const SSH_MAX_CERT_REFS = 8;

/** Known-hosts files one approved snapshot may name (the trust refs the design preserves: docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md, section 9). */
export const SSH_MAX_KNOWN_HOSTS_FILES = 8;

/** Aliases one `ssh_discover_aliases` answer may carry; past it the answer sets `truncated`. */
export const SSH_MAX_DISCOVERED_ALIASES = 500;

/** Longest config alias / hostname / username the wire carries (253 is DNS's practical ceiling; the SSH token cannot legitimately exceed it). */
export const SSH_NAME_MAX_CHARS = 253;

/** Longest absolute POSIX path the wire carries (Linux's PATH_MAX is 4096; a path needing more is not ours to route). */
export const SSH_PATH_MAX_CHARS = 4094;

/** Largest ssh_config the wire carries in one `launch.ssh.fileContent` member (a rendered snapshot config is hundreds of bytes; this bounds a hostile plane). */
export const SSH_CONFIG_FILE_MAX_BYTES = 65_536;

/**
 * Grace period a SIGTERM gets before the group is SIGKILLed. Born with the
 * structured runs, kept because the session supervisor kills the brokered
 * child's GROUP with exactly this grace (design §3). Remote descendants are
 * NEVER confirmed dead by any grace period - that honesty survived the run
 * family.
 */
export const SSH_CANCEL_GRACE_MS = 5_000;

/* ------------------------------------------------------------------ */
/* session-runtime limits (design 2026-10-05 §2/§3)                    */
/* ------------------------------------------------------------------ */

/**
 * Inbound runtime-frame queue bound per session (design §2: 128 frames).
 * Overflow CLOSES the session fail-closed - a plane that cannot drain its own
 * session must stop the flow at the source rather than buffer without bound.
 */
export const SSH_SESSION_INBOUND_QUEUE_FRAMES = 128;

/**
 * Open deadline: spawn the child AND receive its parsed hello within this
 * window, or the open fails - never a half-open session, never a retry (the
 * no-automatic-execution-replay rule reads the probe's failure as final here
 * too).
 */
export const SSH_SESSION_OPEN_DEADLINE_MS = 30_000;

/** Active brokered sessions one connecting node may hold, across all owners. */
export const SSH_SESSIONS_PER_NODE = 8;

/**
 * Longest callback correlation id (`rest_request`/`rest_response` `reqId`)
 * the wire carries, printable characters only. The bound is load-bearing
 * beyond tidiness: the plane echoes the id back inside a size-capped
 * `rest_response` frame, and its answer-truncation budget is measured with
 * the ACTUAL id, so the frame-cap arithmetic needs it finite and its escape
 * cost knowable BEFORE the answer is sized. The runtime mints uuids (36
 * chars); 64 matches the session-ref ceiling, so no honest id is refused.
 */
export const SSH_REQ_ID_MAX_CHARS = 64;

/**
 * The ONE runtime-safe transfer window, in RAW bytes, for anything whose answer
 * rides the session link as base64: a `log_read` window and a live-tail
 * `output` chunk alike cap at this. The node link's own windows
 * (`LOG_TAIL_BYTES` 256 KiB, `TAIL_CHUNK_BYTES` 192 KiB) are sized for the
 * 1 MiB node frame and BREAK the session codec: base64 inflates 4/3, so 256
 * KiB raw is ~349,528 chars and even 192 KiB raw lands at 262,144 chars -
 * exactly {@link SSH_SESSION_FRAME_MAX_BYTES} before the JSON envelope is
 * glued on - and `encodeSshSessionFrame` throws past the cap. 128 KiB raw
 * base64s to ~174,764 chars; the worst `result`/`output` envelope around it
 * (uuid refs, numeric offsets, key quotes) costs well under 200 bytes, so a
 * full window encodes at about 175 KiB against the 262,144-byte cap. The
 * plane clamps its `log_read` asks to this and the runtime chunks its tail
 * pump to this (`ctx.outputChunkCeilingBytes`); neither end splits a frame
 * after composition, and the sizes that overflow are pinned refused by test.
 */
export const SSH_SESSION_LOG_WINDOW_BYTES = 128 * 1024;

/* ------------------------------------------------------------------ */
/* sealed agent relay (spec 2026-10-08 §5.1/§5.3/§5.4/§5.6)            */
/* ------------------------------------------------------------------ */

/**
 * Largest RAW payload one sealed relay frame may carry (spec 2026-10-08
 * §5.1). 128 KiB is the channel-envelope scale the spec names the cap
 * bounded to: base64 inflates 4/3, so a full blob spells about 174,764
 * characters inside the frame, well under the node link's own
 * NODE_MAX_FRAME_BYTES ceiling - the same arithmetic that sized
 * {@link SSH_SESSION_LOG_WINDOW_BYTES}. An over-cap frame is refused and
 * the session closed with a named reason; the cap is law, not a hint.
 */
export const SSH_RELAY_FRAME_MAX_BYTES = 131_072;

/**
 * Concurrent relay sessions one node may hold on the plane's broker
 * (spec §5.3). Exceeding the cap is a LOUD refusal, never a queue.
 */
export const SSH_RELAY_MAX_PER_NODE = 8;

/**
 * Hard ceiling on a relay session's life (spec §5.6). Modeled on
 * {@link SSH_SESSION_OPEN_DEADLINE_MS}: the relay exists only for the
 * handshake window, and the lifetime is the last-resort cut beneath the
 * earlier ones (grace elapsed, child exit, A drop, access revocation).
 */
export const SSH_RELAY_LIFETIME_MS = 30_000;

/**
 * How long B's proxy keeps the relay open after the `ssh` child is alive
 * with no agent error before tearing it down (spec §5.6: B cannot see
 * ssh's handshake to D, so a quiet grace stands in for the signal, and
 * child exit cuts immediately). Same 5 s family as {@link SSH_CANCEL_GRACE_MS}.
 */
export const SSH_RELAY_TEARDOWN_GRACE_MS = 5_000;

/**
 * Key fingerprints one connection may select (spec §5.4). Deliberately
 * DISTINCT from {@link SSH_MAX_IDENTITY_REFS}, which bounds snapshot
 * identity PATHS, not connection selections; selecting more is a
 * hard refusal, never a silent truncation. Public data end to end:
 * `SHA256:` base64 fingerprints, never key material.
 */
export const SSH_MAX_SELECTED_FINGERPRINTS = 8;

/**
 * Longest single OpenSSH `known_hosts` line the wire may carry, in EITHER
 * direction: the `ssh_host_key` answer's entries and the `ssh_relay_open`
 * pin's line alike (spec 2026-10-08 §9, Task 12). A real line is a pattern
 * list, a key type, and base64 key material - an RSA-8192 entry with a long
 * pattern runs well past a kilobyte, and the grammar's bound must not refuse
 * the honest file while leaving a hostile plane an unbounded text field.
 */
export const SSH_MAX_HOST_PIN_LINE_CHARS = 4096;

/**
 * Host-key lines one `ssh_host_key` answer may carry (Task 12). A destination
 * with more recorded entries than this is not the operator's `known_hosts`
 * the capture expects; the answer is malformed, refused at the grammar rather
 * than truncated.
 */
export const SSH_MAX_HOST_KEY_LINES = 32;

/**
 * Identities one live agent may report in one `ssh_agent_identities` roster
 * read (spec 2026-10-08 §5.4; PR #338 review round 2). A generous
 * display/selection bound: the roster feeds the key picker and the
 * connection’s ≤ {@link SSH_MAX_SELECTED_FINGERPRINTS}-key selection, and no honest
 * agent holds this many keys. An agent reporting MORE is refused by name at
 * the node and refused as malformed at the validator, never truncated down
 * to this number: a roster the code quietly cut would read to the operator
 * as the whole truth (the no-silent-truncation law).
 */
export const SSH_ROSTER_MAX_IDENTITIES = 64;

/**
 * Largest raw stdout slice one brokered `session_frame` event may carry
 * (design §3's pump, restated as a number: the node-frames `session_frame`
 * doc always claimed "in ≤ 192 KiB pieces", and the broker's read can return
 * more in one chunk). 192 KiB raw base64s to 262,144 chars, comfortably under
 * the node link's own 1 MiB frame cap; the session's codec reassembles frames
 * across pushes, so a chunk boundary is a chunk boundary and splitting costs
 * the stream nothing but an event.
 */
export const SSH_SESSION_PUMP_CHUNK_BYTES = 192 * 1024;

/* ------------------------------------------------------------------ */
/* the non-interactive setup exec (spec 2026-10-08 §7, Task 14)        */
/* ------------------------------------------------------------------ */

/**
 * Largest `ssh_exec` preset-flag token list. The compose emits `-F`,
 * `BatchMode`, the port, `--`, and the destination: far short of this, and
 * the bound is the grammar's, so a hostile plane cannot grow the argv the
 * node spawns.
 */
export const SSH_EXEC_MAX_PRESET_FLAGS = 64;

/**
 * The remote one-liner an `ssh_exec` runs on the destination (the rendered
 * `install.sh` one-liner with a minted setup key). One printable line - the
 * grammar refuses control characters, so a smuggled second command is not
 * representable. The cap bounds the text the destination's login shell
 * parses; the real installer line is a few hundred characters.
 */
export const SSH_EXEC_COMMAND_MAX_CHARS = 8192;

/**
 * Upper bound on the node-side deadline of ONE non-interactive `ssh_exec`
 * run. The act streams a node-binary download to the destination over the
 * pane's own connection; ten minutes bounds the worst honest install, and a
 * longer one is a refusal to the plane (which raises a fresh act), never an
 * unbounded child.
 */
export const SSH_EXEC_TIMEOUT_MAX_MS = 600_000;

/**
 * Bytes of one captured stream the node RETAINS after the `nsk_` redaction
 * (tail-first: the status verbs that end the installer's output are the
 * lines the plane parses). Redaction runs BEFORE truncation, so no cut can
 * leave a key's tail bytes behind.
 */
export const SSH_EXEC_RETAIN_BYTES = 8192;

/**
 * Longest captured stream one `ssh_exec_status` answer may carry (each of
 * stdout and stderr, in characters). Comfortably above the node's own
 * {@link SSH_EXEC_RETAIN_BYTES} tail; past it the answer is malformed, and
 * the plane never sees a machine that simply did not cap itself.
 */
export const SSH_EXEC_RESULT_MAX_CHARS = 32_768;
