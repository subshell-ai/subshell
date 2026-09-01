import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeSessionId } from "@internal/session-protocol";
import { enforceMode } from "./fs-mode.js";
import { log } from "./log.js";

/**
 * Per-session state the agent records when a launch command starts a harness
 * (spec 2026-08-31 §7). One JSON file per session under `<dataDir>/sessions/`;
 * the executors read it to resolve the session's path-policy root and the
 * pane/mcp paths echoed back by the launch command.
 */
export interface SessionMeta {
  /** Session id as minted by the control plane (uuid). */
  sessionId: string;
  /** Absolute launch working directory — the session's root for the path policy. */
  cwd: string;
  /** Absolute path of the control socket the harness talks to. */
  socket: string;
  /** Harness plugin id chosen for this session (e.g. `claude-code`). */
  harnessId: string;
  /** Human-facing session name at launch time. */
  name: string;
  /** ISO 8601 timestamp of when the launch was accepted. */
  startedAt: string;
}

/** Suffix identifying meta files in the sessions dir (pane logs live alongside them). */
const META_SUFFIX = ".meta.json";

/**
 * Agent-side name for the protocol package's ONE session-id guard
 * (`isNodeSessionId` in `@internal/session-protocol` — ids interpolated into
 * node-side paths; wire contract shared by backend RemoteLauncher gates and
 * the agent path policy). The alias keeps every call site below reading as
 * the agent's own boundary check. The boundary matters: ids arrive over a
 * control-plane wire we do not fully trust, and this store interpolates them
 * directly into paths — a hostile `../../../../x` would let Task 4's
 * pipe-pane (`cat >> <logPath>`) write anywhere, bypassing the path policy
 * entirely because tmux/shell, not us, opens the file.
 */
export const isSessionId = isNodeSessionId;

/** Throws when `id` could not have come from our control plane; callers surface this as a command failure. */
function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error("invalid session id");
}

/** Every SessionMeta field must be present as a string for a file to load. */
const META_FIELDS = ["sessionId", "cwd", "socket", "harnessId", "name", "startedAt"] as const;

/**
 * Parses one meta file's contents; on junk, emits exactly one log line and
 * returns null (callers turn that into `undefined` / a skipped list entry —
 * a broken file never throws at the executor that tripped over it).
 */
function parseMeta(raw: string, file: string): SessionMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`session meta unreadable (not JSON): ${file}`);
    return null;
  }
  const obj = parsed as Record<(typeof META_FIELDS)[number], unknown> | null;
  if (typeof obj !== "object" || obj === null || META_FIELDS.some((f) => typeof obj[f] !== "string")) {
    log(`session meta malformed (missing string fields): ${file}`);
    return null;
  }
  const m = obj as Record<(typeof META_FIELDS)[number], string>;
  return {
    sessionId: m.sessionId,
    cwd: m.cwd,
    socket: m.socket,
    harnessId: m.harnessId,
    name: m.name,
    startedAt: m.startedAt,
  };
}

/**
 * File-backed store over `<dataDir>/sessions/<id>.meta.json` (0600 file,
 * 0700 dir — same re-tightening discipline as config.ts). Deliberately dumb:
 * no watcher, and the ONE memory it keeps is the record mirror behind `get`
 * (the record — socket first of all, see `resolveSocket`'s per-keystroke
 * lookups — never changes while it lives, so the mirror is populated on
 * `record` and by `get`'s file-read fallback, evicted on `forget`, and
 * replaced on re-record). Within one agent process the files only change
 * under these methods, so the mirror cannot go stale. The daemon is the only
 * writer.
 */
export class SessionMetaStore {
  /** Root the store reads/writes under; the sessions dir is created lazily on first record. */
  private readonly dataDir: string;

  /** In-memory mirror of readable records (keyed by sessionId); see the class doc. */
  private readonly mem = new Map<string, SessionMeta>();

  /**
   * @param dataDir - the node's data dir (from the agent config); no fs I/O happens here.
   */
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Absolute path of the dir holding meta files (and pane logs). */
  private sessionsDir(): string {
    return join(this.dataDir, "sessions");
  }

  /**
   * Absolute path of one session's meta file.
   * @param id - must pass `isSessionId`; throws otherwise (a bad wire id is a
   * command failure, not a silent miss — the path interpolation is the attack surface).
   */
  private metaPath(id: string): string {
    assertSessionId(id);
    return join(this.sessionsDir(), `${id}${META_SUFFIX}`);
  }

  /**
   * Persists (or overwrites) one session's meta, creating the sessions dir
   * with 0700 and re-tightening both dir and 0600 file modes after the write.
   * @param meta - the full record to store under `meta.sessionId`; a malformed
   * id throws before any fs side effect.
   */
  async record(meta: SessionMeta): Promise<void> {
    const file = this.metaPath(meta.sessionId);
    const dir = this.sessionsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(file, `${JSON.stringify({ ...meta })}\n`, { mode: 0o600 });
    await enforceMode(file, 0o600);
    this.mem.set(meta.sessionId, { ...meta }); // only after the write landed; re-record replaces
  }

  /**
   * Reads one session's meta, served from the record mirror once this
   * instance has seen it — the file-read fallback covers records that
   * predate the cache (the agent-restart case).
   * @param id - session id; throws on a malformed id (see `metaPath`).
   * @returns the record, or undefined when the file is missing or junk
   * (junk gets exactly one log line; missing is silent; neither is mirrored).
   */
  async get(id: string): Promise<SessionMeta | undefined> {
    const hit = this.mem.get(id);
    if (hit !== undefined) return hit;
    const file = this.metaPath(id);
    try {
      const meta = parseMeta(await readFile(file, "utf8"), file);
      if (meta) this.mem.set(id, meta);
      return meta ?? undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`session meta unreadable: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }

  /**
   * Lists every readable session record, sorted by id.
   * @returns metas for all `*.meta.json` files; a missing sessions dir yields
   * `[]`, non-meta files are ignored, junk files are skipped (one log line each).
   */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionsDir());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        log(`session meta scan failed: ${this.sessionsDir()}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [];
    }
    const out: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue; // pane logs (*.log) and strays live in the same dir
      const id = name.slice(0, -META_SUFFIX.length);
      if (!isSessionId(id)) continue; // junk file names are skipped, never thrown (unlike the id-taking methods)
      const file = join(this.sessionsDir(), name);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue; // vanished mid-scan (concurrent forget) — one fewer session is correct
      }
      const meta = parseMeta(raw, file);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return out;
  }

  /**
   * Deletes one session's meta file.
   * @param id - session id; forgetting a missing id is not an error, but a
   * malformed id throws (see `metaPath`).
   */
  async forget(id: string): Promise<void> {
    const file = this.metaPath(id); // validates first: a malformed id throws with no side effect
    this.mem.delete(id); // evict on intent: even if the unlink below fails, the next lookup re-reads the file
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`session meta delete failed: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Pane log path — the agent-side twin of the backend's `sessionLogPath`;
   * pinned equal by the launch command echoing it back (Task 4/8).
   * @param id - session id; throws on a malformed id — this path is fed to
   * `tmux pipe-pane`/`cat >>` outside the path policy's reach.
   */
  logPath(id: string): string {
    assertSessionId(id);
    return join(this.sessionsDir(), `${id}.log`);
  }

  /**
   * MCP config path — the agent-side twin of the backend's
   * `sessionMcpConfigPath`; pinned equal by the launch command echoing it back.
   * @param id - session id; throws on a malformed id (as `logPath`).
   */
  mcpPath(id: string): string {
    assertSessionId(id);
    return join(this.dataDir, "mcp", `${id}.json`);
  }

  /**
   * The session's launch cwd — the per-session root for the path policy.
   * @param id - session id; throws on a malformed id (via `get`).
   * @returns the recorded cwd, or undefined for unknown/junk records.
   */
  async cwdOf(id: string): Promise<string | undefined> {
    return (await this.get(id))?.cwd;
  }
}
