/**
 * The SSH resource limits, frozen (SSH-SUPPORT.md §3's limits table).
 *
 * Everything here is PURE data: the rows of the spec table, each named, plus
 * the derived bounds the wire parsers enforce so neither end of the link can
 * drift. The rows are law after Gate A: the node runtime enforces them at the
 * connecting machine, the plane refuses dispatch past them before a command
 * is ever signed, and the SPA/MCP render the same numbers the enforcement
 * uses. Changing a row is a coordinated edit across all three, not a local
 * convenience - which is why they live here rather than in the two packages
 * that act on them.
 *
 * Imports no `node:` builtin; this module is in the Metro-safe barrel.
 */

/* ------------------------------------------------------------------ */
/* the spec table (SSH-SUPPORT.md §3), one export per row               */
/* ------------------------------------------------------------------ */

/** Execution deadline default: five minutes of supervised runtime per run. */
export const SSH_RUN_DEADLINE_DEFAULT_MS = 5 * 60 * 1000;

/** Execution deadline ceiling: the caller may select up to one hour, never past it. */
export const SSH_RUN_DEADLINE_MAX_MS = 60 * 60 * 1000;

/** Active structured runs per OWNER per connecting node. Quota counts `accepted` + `running`. */
export const SSH_ACTIVE_RUNS_PER_OWNER_PER_NODE = 4;

/** Active structured runs per connecting node TOTAL, across all owners. */
export const SSH_ACTIVE_RUNS_PER_NODE = 16;

/** Managed SSH terminals per OWNER per connecting node. */
export const SSH_TERMINALS_PER_OWNER_PER_NODE = 4;

/**
 * Retained output per structured run: 10 MiB COMBINED stdout+stderr. The cap
 * bounds the run's files on the connecting node; draining continues past it
 * and the read answers report `truncated` rather than lying about the totals.
 */
export const SSH_RUN_OUTPUT_RETENTION_BYTES = 10 * 1024 * 1024;

/**
 * Aggregate SSH output storage per connecting node, INCLUDING managed SSH
 * terminal logs. Under pressure the runtime evicts completed-run output
 * first; if still full it refuses new work (`storage_full`), never silently
 * overwrites.
 */
export const SSH_AGGREGATE_OUTPUT_STORAGE_BYTES = 1024 * 1024 * 1024;

/** Completed-run retention in whole days (sweep-eligible age). */
export const SSH_COMPLETED_RUN_RETENTION_DAYS = 7;

/** {@link SSH_COMPLETED_RUN_RETENTION_DAYS} in milliseconds, the form sweeps compare against. */
export const SSH_COMPLETED_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Output response window: one `ssh_run_read` answer carries at most this many
 * RAW bytes across stdout and stderr together. Chosen, like the transfer
 * window, against {@link NODE_MAX_FRAME_BYTES}: 256 KiB raw base64s to about
 * 350 KiB plus envelope, comfortably inside the frame both directions
 * enforce. The parser caps `maxBytes` at this number.
 */
export const SSH_OUTPUT_WINDOW_MAX_BYTES = 256 * 1024;

/** Read long-poll ceiling: `ssh_run_read`'s `waitMs` holds the answer open at most this long. */
export const SSH_READ_LONG_POLL_MAX_MS = 30 * 1000;

/**
 * Connection/setup probe: a 30-second OVERALL deadline, and no automatic
 * execution retry ever (SSH-SUPPORT.md §3's table row; the no-retry rule is
 * the durable-dispatch contract, not a tuning knob).
 */
export const SSH_PROBE_DEADLINE_MS = 30 * 1000;

/* ------------------------------------------------------------------ */
/* derived contract bounds (chosen at the Gate A freeze, parser-enforced) */
/* ------------------------------------------------------------------ */

/**
 * Longest run command the wire carries. DERIVED from the pane `exec` route's
 * existing 20 000-char cap so the two command-input surfaces refuse at the
 * same line, not because the spec table names it.
 */
export const SSH_COMMAND_MAX_CHARS = 20_000;

/**
 * Bounded ProxyJump chain (SSH-SUPPORT.md §2: "a bounded `ProxyJump` chain").
 * FOUR is a freeze decision, not a spec row: beyond four hops a normalized
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

/** Known-hosts files one approved snapshot may name (the trust refs §2's "preserve referenced trust files" sentence). */
export const SSH_MAX_KNOWN_HOSTS_FILES = 8;

/** Aliases one `ssh_discover_aliases` answer may carry; past it the answer sets `truncated`. */
export const SSH_MAX_DISCOVERED_ALIASES = 500;

/** Longest config alias / hostname / username the wire carries (253 is DNS's practical ceiling; the SSH token cannot legitimately exceed it). */
export const SSH_NAME_MAX_CHARS = 253;

/** Longest absolute POSIX path the wire carries (Linux's PATH_MAX is 4096; a path needing more is not ours to route). */
export const SSH_PATH_MAX_CHARS = 4094;

/**
 * Grace period a cancellation gives the supervised local ssh (and its helper
 * children) before the run answers `cancelLocalConfirmed: false`. Remote
 * descendants are NEVER confirmed by any grace period - the spec's
 * "Terminating SSH never guarantees remote descendants died" is why the field
 * is named LOCAL.
 */
export const SSH_CANCEL_GRACE_MS = 5_000;
