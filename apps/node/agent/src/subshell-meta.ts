import { unlinkSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enforceMode } from "@internal/pane-runtime";
import { isNodeSubshellId } from "@internal/subshell-protocol";
import { log } from "./log.js";

/**
 * Per-subshell state the agent records when a launch command starts a harness
 * (spec 2026-08-31 §7). One JSON file per subshell under `<dataDir>/subshells/`;
 * the executors read it to resolve the subshell's path-policy root and the
 * pane/mcp paths echoed back by the launch command.
 */
export interface SubshellMeta {
  /** Subshell id as minted by the control plane (uuid). */
  subshellId: string;
  /** Absolute launch working directory — the subshell's root for the path policy. */
  cwd: string;
  /** Absolute path of the control socket the harness talks to. */
  socket: string;
  /** Harness plugin id chosen for this subshell (e.g. `claude-code`). */
  harnessId: string;
  /** Human-facing subshell name at launch time. */
  name: string;
  /** ISO 8601 timestamp of when the launch was accepted. */
  startedAt: string;
}

/** Suffix identifying meta files in the subshells dir (pane logs live alongside them). */
const META_SUFFIX = ".meta.json";

/**
 * Agent-side name for the protocol package's ONE subshell-id guard
 * (`isNodeSubshellId` in `@internal/subshell-protocol` — ids interpolated into
 * node-side paths; the agent half of the policy that guard documents, and
 * today the enforced half — see the backend-adoption note on
 * `isNodeSubshellId`). The alias keeps every call site below reading as
 * the agent's own boundary check. The boundary matters: ids arrive over a
 * control-plane wire we do not fully trust, and this store interpolates them
 * directly into paths — a hostile `../../../../x` would let the pipe-pane
 * capture child (the `pane-log` verb writing to `<logPath>`) write anywhere,
 * bypassing the path policy entirely because tmux/shell, not us, opens the
 * file.
 */
export const isSubshellId = isNodeSubshellId;

/** Throws when `id` could not have come from our control plane; callers surface this as a command failure. */
function assertSubshellId(id: string): void {
  if (!isSubshellId(id)) throw new Error("invalid subshell id");
}

/** Every SubshellMeta field must be present as a string for a file to load. */
const META_FIELDS = ["subshellId", "cwd", "socket", "harnessId", "name", "startedAt"] as const;

/**
 * Parses one meta file's contents; on junk, emits exactly one log line and
 * returns null (callers turn that into `undefined` / a skipped list entry —
 * a broken file never throws at the executor that tripped over it).
 */
function parseMeta(raw: string, file: string): SubshellMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`subshell meta unreadable (not JSON): ${file}`);
    return null;
  }
  const obj = parsed as Record<string, unknown> | null;
  if (typeof obj !== "object" || obj === null) {
    log(`subshell meta malformed (missing string fields): ${file}`);
    return null;
  }
  // Pre-rename meta (rollout 2026-09-02 step 4 `mv`s the files but not their
  // bytes): a record whose JSON still says `sessionId` IS this subshell's
  // meta — migrate the key on read. The store's own write path (`record`)
  // always serializes the typed object, so the next write lands the new key.
  if (obj.subshellId === undefined && typeof obj.sessionId === "string") {
    obj.subshellId = obj.sessionId;
    delete obj.sessionId;
  }
  if (META_FIELDS.some((f) => typeof obj[f] !== "string")) {
    log(`subshell meta malformed (missing string fields): ${file}`);
    return null;
  }
  const m = obj as Record<(typeof META_FIELDS)[number], string>;
  return {
    subshellId: m.subshellId,
    cwd: m.cwd,
    socket: m.socket,
    harnessId: m.harnessId,
    name: m.name,
    startedAt: m.startedAt,
  };
}

/**
 * File-backed store over `<dataDir>/subshells/<id>.meta.json` (0600 file,
 * 0700 dir — same re-tightening discipline as config.ts). Deliberately dumb:
 * no watcher, and the ONE memory it keeps is the record mirror behind `get`
 * (the record — socket first of all, see `resolveSocket`'s per-keystroke
 * lookups — never changes while it lives, so the mirror is populated on
 * `record` and by `get`'s file-read fallback, evicted on `forget`, and
 * replaced on re-record). Within one agent process the files only change
 * under these methods — and the per-id generation counter below is what makes
 * "cannot go stale" TRUE across the awaits: a fallback read that resolves
 * after a `record`/`forget` touched the id is never cached. The daemon is the
 * only writer.
 */
export class SubshellMetaStore {
  /** Root the store reads/writes under; the subshells dir is created lazily on first record. */
  private readonly dataDir: string;

  /** In-memory mirror of readable records (keyed by subshellId); see the class doc. */
  private readonly mem = new Map<string, SubshellMeta>();

  /**
   * Per-id mutation counter, bumped SYNCHRONOUSLY by `record` (around the
   * write) and `forget` (before the eviction). `get`'s file-read fallback
   * captures it before the read and refuses to refill the mirror when it has
   * moved — the guard that keeps a read racing a `forget` from caching a
   * deleted record forever (the flake that timed out the watcher tests'
   * post-exit meta waits).
   */
  private readonly gen = new Map<string, number>();

  private bumpGen(id: string): void {
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1);
  }

  /**
   * @param dataDir - the node's data dir (from the agent config); no fs I/O happens here.
   */
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Absolute path of the dir holding meta files (and pane logs). */
  private subshellsDir(): string {
    return join(this.dataDir, "subshells");
  }

  /**
   * Absolute path of one subshell's meta file.
   * @param id - must pass `isSubshellId`; throws otherwise (a bad wire id is a
   * command failure, not a silent miss — the path interpolation is the attack surface).
   */
  private metaPath(id: string): string {
    assertSubshellId(id);
    return join(this.subshellsDir(), `${id}${META_SUFFIX}`);
  }

  /**
   * Persists (or overwrites) one subshell's meta, creating the subshells dir
   * with 0700 and re-tightening both dir and 0600 file modes after the write.
   * @param meta - the full record to store under `meta.subshellId`; a malformed
   * id throws before any fs side effect.
   */
  async record(meta: SubshellMeta): Promise<void> {
    const file = this.metaPath(meta.subshellId);
    const dir = this.subshellsDir();
    this.bumpGen(meta.subshellId); // invalidate fallback reads across the write...
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(file, `${JSON.stringify({ ...meta })}\n`, { mode: 0o600 });
    await enforceMode(file, 0o600);
    // ...and reads that began before the authoritative mirror set. The bump
    // and the set are ONE synchronous step: no in-flight read can cache
    // pre-overwrite bytes after the new record is installed.
    this.bumpGen(meta.subshellId);
    this.mem.set(meta.subshellId, { ...meta }); // only after the write landed; re-record replaces
  }

  /**
   * Reads one subshell's meta, served from the record mirror once this
   * instance has seen it — the file-read fallback covers records that
   * predate the cache (the agent-restart case).
   * @param id - subshell id; throws on a malformed id (see `metaPath`).
   * @returns the record, or undefined when the file is missing or junk
   * (junk gets exactly one log line; missing is silent; neither is mirrored).
   */
  async get(id: string): Promise<SubshellMeta | undefined> {
    const hit = this.mem.get(id);
    if (hit !== undefined) return hit;
    const file = this.metaPath(id);
    const gen = this.gen.get(id) ?? 0; // captured BEFORE the read is dispatched
    try {
      const meta = parseMeta(await readFile(file, "utf8"), file);
      // Refill ONLY if no record/forget touched this id while the read was
      // in flight: a read that started before a forget's eviction resolves
      // with the deleted record's bytes, and caching those after the eviction
      // would serve a dead record forever (the file is gone — nothing ever
      // re-reads to heal the mirror).
      if (meta && (this.gen.get(id) ?? 0) === gen) this.mem.set(id, meta);
      return meta ?? undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`subshell meta unreadable: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }

  /**
   * Lists every readable subshell record, sorted by id.
   * @returns metas for all `*.meta.json` files; a missing subshells dir yields
   * `[]`, non-meta files are ignored, junk files are skipped (one log line each).
   */
  async list(): Promise<SubshellMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.subshellsDir());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        log(`subshell meta scan failed: ${this.subshellsDir()}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [];
    }
    const out: SubshellMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue; // pane logs (*.log) and strays live in the same dir
      const id = name.slice(0, -META_SUFFIX.length);
      if (!isSubshellId(id)) continue; // junk file names are skipped, never thrown (unlike the id-taking methods)
      const file = join(this.subshellsDir(), name);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue; // vanished mid-scan (concurrent forget) — one fewer subshell is correct
      }
      const meta = parseMeta(raw, file);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => a.subshellId.localeCompare(b.subshellId));
    return out;
  }

  /**
   * Deletes one subshell's meta file.
   * @param id - subshell id; forgetting a missing id is not an error, but a
   * malformed id throws (see `metaPath`).
   */
  async forget(id: string): Promise<void> {
    const file = this.metaPath(id); // validates first: a malformed id throws with no side effect
    // Eviction and unlink are ONE synchronous step: an async unlink left a
    // window (under fs contention, seconds wide) where a fallback read could
    // start after the eviction, see the still-present file, and cache the
    // record the forget is deleting. Reads already in flight are caught by
    // the gen bump. (This is the race that flaked the watcher tests'
    // post-exit "meta forgotten" waits.)
    this.bumpGen(id);
    this.mem.delete(id); // evict on intent: even if the unlink fails, the next lookup re-reads the file
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`subshell meta delete failed: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Pane log path — the agent-side twin of the backend's `subshellLogPath`;
   * pinned equal by the launch command echoing it back (Task 4/8).
   * @param id - subshell id; throws on a malformed id — this path is fed to
   * `tmux pipe-pane`/`cat >>` outside the path policy's reach.
   */
  logPath(id: string): string {
    assertSubshellId(id);
    return join(this.subshellsDir(), `${id}.log`);
  }

  /**
   * MCP config path — the agent-side twin of the backend's
   * `subshellMcpConfigPath`; pinned equal by the launch command echoing it back.
   * @param id - subshell id; throws on a malformed id (as `logPath`).
   */
  mcpPath(id: string): string {
    assertSubshellId(id);
    return join(this.dataDir, "mcp", `${id}.json`);
  }

  /**
   * The subshell's launch cwd — the per-subshell root for the path policy.
   * @param id - subshell id; throws on a malformed id (via `get`).
   * @returns the recorded cwd, or undefined for unknown/junk records.
   */
  async cwdOf(id: string): Promise<string | undefined> {
    return (await this.get(id))?.cwd;
  }
}
