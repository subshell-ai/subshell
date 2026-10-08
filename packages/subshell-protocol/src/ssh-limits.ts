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
