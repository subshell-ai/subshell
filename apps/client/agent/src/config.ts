import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { enforceMode } from "./fs-mode.js";

/**
 * Everything subshell needs to live: where the control plane is, who this
 * node is, its bearer secret, and the pinned control key. Written by
 * `subshell enroll`, read by `run` (T13).
 */
export interface AgentConfig {
  /** Control-plane base URL as passed to `--server` at enroll time. */
  serverUrl: string;
  /** Server-assigned node id (uuid). */
  nodeId: string;
  /** Node bearer key — plaintext, shown once by the enroll response; this 0600 file is its ONLY home. */
  nodeKey: string;
  /** JSON-serialized control-plane signing public JWK, pinned so commands can be verified. */
  controlPublicKey: string;
  /** Directory holding the identity keypair and runtime state. */
  dataDir: string;
  /** Node display name (defaults to the hostname). */
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
export async function saveConfig(cfg: AgentConfig): Promise<void> {
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
 * Reads and validates the config.
 * @throws actionable error when missing (points at `enroll`) or corrupt
 * (never silently re-enrolled — the message says what is wrong).
 */
export async function loadConfig(): Promise<AgentConfig> {
  const file = configPath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no config at ${file} — enroll this node first: subshell enroll --server <url> --key <nsk_…>`);
    }
    throw new Error(`cannot read config '${file}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config corrupt: '${file}' is not valid JSON — re-run subshell enroll to recreate it`);
  }
  const obj = parsed as Record<string, unknown> | null;
  if (typeof obj !== "object" || obj === null || REQUIRED_FIELDS.some((f) => typeof obj[f] !== "string")) {
    throw new Error(`config corrupt: '${file}' is missing required string fields — re-run subshell enroll`);
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
  };
}
