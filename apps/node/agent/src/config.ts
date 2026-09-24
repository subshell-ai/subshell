import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { enforceMode } from "@internal/pane-runtime";

/**
 * Everything subshell needs to live: where the control plane is, who this
 * node is, its bearer secret, and the pinned control key. Written by
 * `subshell enroll`, read by `run` (T13).
 */
export interface NodeConfig {
  /** Control-plane base URL as passed to `--server` at enroll time. */
  serverUrl: string;
  /** Server-assigned node id (uuid). */
  nodeId: string;
  /** Node bearer key — plaintext, shown once by the enroll response; this 0600 file is its ONLY home. */
  nodeKey: string;
  /** JSON-serialized control-plane signing public JWK, pinned so commands can be verified. */
  controlPublicKey: string;
  /**
   * This node's static X25519 keypair for the encrypted /ws/node link, base64
   * (spec 2026-09-24 §3): generated at enroll, the public half pinned on the
   * server's node row, and THIS 0600 file is the private half's ONLY home —
   * the same doctrine as {@link nodeKey}. Absent on a legacy config: the new
   * binary registers on its first connect and writes it back (§5's self-heal),
   * which is why `REQUIRED_FIELDS` deliberately does NOT list it. A junk shape
   * loads as absent (never a corruption verdict), and a half-keyed object is
   * junk — a partial identity could only stall the handshake.
   */
  encryptKeyPair?: { publicKey: string; privateKey: string };
  /**
   * The control plane's static encryption public key (base64), pinned into
   * this file exactly as {@link controlPublicKey} is (spec 2026-09-24 §3) —
   * the enroll answer or §5's `register-ok`. Absent means unprovisioned; a
   * blank string is hand-edit junk and loads as absent like a blank
   * `nodeWsUrl`.
   */
  controlEncryptPublicKey?: string;
  /** Directory holding the identity keypair and runtime state. */
  dataDir: string;
  /**
   * Node display name — a LOCAL ECHO of the name this machine gave at enroll
   * (asked by `setup`, required from `enroll`, normalized by `normalizeNodeName`),
   * not a value this file decides. The control plane owns the row afterwards
   * (`PATCH /api/nodes/:id`), which is why `configure` takes no `--name`.
   */
  name: string;
  /**
   * The WS endpoint the SERVER reported at enroll (ledger 17c). Persisted so
   * the daemon dials exactly the URL the control plane named, not a locally
   * re-derived guess (behind a divergent proxy the derivation targets the
   * alias). Optional: configs written before 17c lack it and the daemon
   * falls back to `wsUrlFor(serverUrl)`; an empty/blank value is treated as
   * absent at load — only a hand-edit could carry one, and enroll never
   * persists an empty answer.
   */
  nodeWsUrl?: string;
  /**
   * Whether debug-level lines reach the agent's own log file.
   *
   * Absent means off, which is also what an older config means. Persisted
   * rather than per-process because the sessions worth debugging end in a
   * restart; `SUBSHELL_DEBUG_LOGGING` still overrides it and makes it
   * read-only (`debug-logging.ts`).
   */
  debugLogging?: boolean;
  /**
   * Pane-log retention, in days (with `logRetentionHours` completing the
   * window): a NON-running subshell's `<id>.log` is unlinked once its mtime
   * is older than `days * 24h + hours`. Resolved per field —
   * `SUBSHELL_LOG_RETENTION_DAYS` / `SUBSHELL_LOG_RETENTION_HOURS` win over
   * these fields, the fields over the default of 1 day / 0 hours, and
   * `0 + 0` together is the documented keep-forever pair
   * (`pane-log-retention.ts`). A running pane's log is never swept.
   *
   * The daemon re-reads these two on every scheduled pass, so a write (the
   * loopback dashboard's retention card, `retention-settings.ts`, or a
   * hand-edit) lands without a restart; the boot read is what decides whether
   * a pass is scheduled at all.
   *
   * Absent means the default, which is also what an older config means;
   * junk (non-integer, negative) is dropped at load like a junk
   * `nodeWsUrl`, never a corruption verdict.
   */
  logRetentionDays?: number;
  /** The hours half of {@link logRetentionDays}; see that field for every rule. */
  logRetentionHours?: number;
}

/** Root the config + default data dir live under (`SUBSHELL_CONFIG_HOME` for tests). */
export function clientHome(): string {
  return process.env.SUBSHELL_CONFIG_HOME ?? join(homedir(), ".config", "subshell");
}

/** Absolute path of the config file. */
export function configPath(): string {
  return join(clientHome(), "config.json");
}

const REQUIRED_FIELDS = ["serverUrl", "nodeId", "nodeKey", "controlPublicKey", "dataDir", "name"] as const;

/** Persists the config with 0700 dir / 0600 file, then verifies the modes. */
export async function saveConfig(cfg: NodeConfig): Promise<void> {
  const file = configPath();
  const dir = dirname(file);
  // mkdir's mode applies only to the created leaf AND is masked by umask, so
  // both dir and file get a stat + chmod re-tightening pass after writing.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await enforceMode(dir, 0o700);
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await enforceMode(file, 0o600);
}

/**
 * Read fresh, apply the NAMED keys of `patch`, save — the merge discipline
 * every live writer of `config.json` goes through.
 *
 * The file holds the node key (its only home) beside settings that can change
 * at the same moment from different hands: the loopback dashboard's retention
 * card and debug-logging switch, and `subshell configure` at the keyboard. The
 * shape they had — `saveConfig({ ...cfg, field })` over whatever snapshot the
 * caller happened to hold — let a concurrent pair silently revert each other's
 * fields: A reads, B saves, A saves, and B's field is gone even though A never
 * touched it. Re-reading at save time and applying ONLY the keys the caller
 * names makes the worst remaining interleaving last-writer-wins FOR ONE KEY:
 * two overlapping writers can lose only the key they both wrote, never a field
 * either one ignored. (The window from this read to the rename inside
 * `saveConfig` is not zero — taking a lock over a 0600 JSON file would cost
 * more than a microseconds-stale merge of a field nobody else is editing. The
 * per-key bound is the honest statement, and it is what the writers rely on.)
 *
 * A patch key explicitly set to `undefined` CLEARS the field (`JSON.stringify`
 * drops it) — that is how `configure` says "the enroll-time ws URL no longer
 * applies". Keys the patch does not name are round-tripped verbatim, which is
 * why `loadConfig` models every field worth keeping (`debugLogging` joins for
 * exactly this reason).
 *
 * @returns the config as written — the same value `saveConfig` persisted.
 */
export async function updateConfig(patch: Partial<NodeConfig>): Promise<NodeConfig> {
  const fresh = await loadConfig();
  const next: NodeConfig = { ...fresh };
  for (const key of Object.keys(patch) as (keyof NodeConfig)[]) {
    (next as unknown as Record<string, unknown>)[key] = patch[key];
  }
  await saveConfig(next);
  return next;
}

/**
 * Reads and validates the config.
 * @throws actionable error when missing (points at `enroll`) or corrupt
 * (never silently re-enrolled — the message says what is wrong).
 */
export async function loadConfig(): Promise<NodeConfig> {
  const file = configPath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no config at ${file}. Enroll this node first: subshell enroll --server <url> --key <nsk_…>`);
    }
    throw new Error(`cannot read config '${file}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config corrupt: '${file}' is not valid JSON. Re-run subshell enroll to recreate it`);
  }
  const obj = parsed as Record<string, unknown> | null;
  if (typeof obj !== "object" || obj === null || REQUIRED_FIELDS.some((f) => typeof obj[f] !== "string")) {
    throw new Error(`config corrupt: '${file}' is missing required string fields. Re-run subshell enroll`);
  }
  const cfg = obj as Record<(typeof REQUIRED_FIELDS)[number], string>;
  return {
    serverUrl: cfg.serverUrl,
    nodeId: cfg.nodeId,
    nodeKey: cfg.nodeKey,
    controlPublicKey: cfg.controlPublicKey,
    dataDir: cfg.dataDir,
    name: cfg.name,
    // Optional + tolerant (ledger 17c): absent ⇒ a pre-17c config, and the
    // daemon dials the derived URL. Junk is treated the same as absent —
    // never a corruption verdict, since nothing else in the file changed.
    // An empty/blank string is junk too: enroll only persists a non-empty
    // server answer, so "" can only be a hand-edit, and `??` in resolveWsUrl
    // would otherwise pin an empty dial target.
    nodeWsUrl: typeof obj.nodeWsUrl === "string" && obj.nodeWsUrl.trim() !== "" ? obj.nodeWsUrl : undefined,
    // The debug flag round-trips like every other modelled field: `updateConfig`
    // re-reads through THIS loader before saving, so a field dropped here would
    // be silently cleared by any unrelated config write (a retention save
    // erasing the debug flag), and `loadAndApplyDebugLogging` — which reads the
    // persisted flag at boot through this function — could only ever see
    // absent. A non-boolean is junk, treated as absent like the fields below.
    debugLogging: typeof obj.debugLogging === "boolean" ? obj.debugLogging : undefined,
    // Retention fields (see NodeConfig): a non-negative integer or absent.
    // Junk loads as absent — the one-day default, i.e. the SAFE side of the
    // pair, because a mistyped privacy window must not quietly become
    // keep-forever. `0` is a real value here (it is half of that pair), so
    // the guard is `>= 0`, not `> 0`.
    logRetentionDays: retentionField(obj.logRetentionDays),
    logRetentionHours: retentionField(obj.logRetentionHours),
    // Link-encryption fields (spec 2026-09-24 §3), modelled for exactly the
    // reason `debugLogging` above is: `updateConfig` re-reads through THIS
    // loader before saving, so a field dropped here would be silently cleared
    // by an unrelated write — a retention save erasing the node's static
    // private half, which nothing short of re-enrolling could recover. Absent
    // is a real state here (a legacy config awaiting §5's self-heal), never a
    // corruption verdict.
    encryptKeyPair: encryptKeyPairField(obj.encryptKeyPair),
    controlEncryptPublicKey: nonBlankString(obj.controlEncryptPublicKey),
    // loadConfig rebuilds field by field, so a field NOT listed here is
    // dropped on its way to the daemon. That is how an older config's
    // `registryUrl` (the phase-3 npm mirror, dead with the node's plugin
    // concept per inversion spec §6) disappears: an extra key in a 0600 file
    // no code reads is inert residue, and rewriting users' configs to scrub a
    // key they never wrote is not this loader's job.
  };
}

/**
 * One retention field: a non-negative integer, or `undefined` for
 * absent/junk. `0` must survive (it is half of the keep-forever pair), and
 * nothing here is ever fatal — a hand-edit that mistypes a number lands on
 * the default, which is the sweeping side (see `NodeConfig.logRetentionDays`).
 */
function retentionField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * One link keypair (spec 2026-09-24 §3): an object whose `publicKey` AND
 * `privateKey` halves are non-blank strings, or `undefined` for absent/junk.
 * A half-keyed object can only come from a hand-edit or a torn write, and it
 * cannot complete a handshake — so it loads as absent and the §5 registration
 * re-provisions the whole pair, rather than the daemon carrying a partial
 * identity into every connect. Halves are returned verbatim (a base64 payload
 * is not trimmable material); only the blankness GATE reads trimmed.
 */
function encryptKeyPairField(value: unknown): { publicKey: string; privateKey: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const pair = value as Record<string, unknown>;
  const publicKey = nonBlankString(pair.publicKey);
  const privateKey = nonBlankString(pair.privateKey);
  if (publicKey === undefined || privateKey === undefined) return undefined;
  return { publicKey, privateKey };
}

/** A non-empty-after-trim string, or `undefined` (the blank-`nodeWsUrl` rule). */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
