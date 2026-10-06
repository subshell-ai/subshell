import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The durable record half of the brokered-session supervisor (design
 * 2026-10-05 §3): what `<dataDir>/ssh/sessions/<ref>.json` says about a
 * session, how it is read/written atomically-enough (0600, same write
 * discipline as the run store), and the boot reconcile that reads a dead
 * daemon's `accepted`/`open` records back as `lost`.
 *
 * The file is split from the supervisor the way `ssh-run-store.ts` is split
 * from `ssh-run-supervisor.ts`: this half knows the DISK, the supervisor half
 * knows the CHILD. The lifecycle is history, never authority - the live map
 * in the supervisor decides what is open; a record only tells the truth about
 * a child that is not there.
 */

/** The lifecycle the node-side record keeps (history, never authority: the live map decides). */
export type SshSessionLifecycle = "accepted" | "open" | "lost" | "closed";
const LIFECYCLES: readonly string[] = ["accepted", "open", "lost", "closed"];

export interface SshSessionRecord {
  /** The plane-minted session ref. */
  ref: string;
  /** {@link SshSessionLifecycle}; `accepted` lands before the spawn, `open` after the hello. */
  lifecycle: SshSessionLifecycle;
  /** Reviewed destination host (the target is parsed by the time an acceptance lands). */
  host: string;
  /** Reviewed destination port. */
  port: number;
  /** Destination account or null (the connecting account's default). */
  user: string | null;
  /** Epoch ms of the acceptance write (durable-before-spawn, the crash-between witness). */
  openedAtMs: number;
  /** Epoch ms of the terminal transition (lost or closed). */
  lostAtMs?: number;
}

/** Where one session's records live and how time is told (injectable clock). */
export interface SshSessionStoreDeps {
  /** Node data dir; records land under `<dataDir>/ssh/sessions/`. */
  dataDir: string;
  /** Epoch-ms clock. */
  nowMs(): number;
}

export class SshSessionRecordStore {
  readonly #dataDir: string;
  readonly #nowMs: () => number;

  constructor(deps: SshSessionStoreDeps) {
    this.#dataDir = deps.dataDir;
    this.#nowMs = deps.nowMs;
  }

  /**
   * Every `accepted`/`open` record with no live child under `liveRefs` becomes
   * `lost` on disk (never a restart, never a claim about the destination's
   * tmux - that server SURVIVED; only the child did not). Returns the swept
   * records (the supervisor logs them; nobody else reads them).
   */
  reconcileAll(liveRefs: ReadonlySet<string>): SshSessionRecord[] {
    const out: SshSessionRecord[] = [];
    const dir = this.dir();
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const rec = this.read(join(dir, name));
      if (rec && (rec.lifecycle === "accepted" || rec.lifecycle === "open") && !liveRefs.has(rec.ref)) {
        const lost: SshSessionRecord = { ...rec, lifecycle: "lost", lostAtMs: this.#nowMs() };
        this.write(lost);
        out.push(lost);
      }
    }
    return out;
  }

  /** The session dir (NOT created; a read scan may run against a node that never brokers). */
  dir(): string {
    return join(this.#dataDir, "ssh", "sessions");
  }

  /** The session dir, created 0700 (the accept path calls this before its first write). */
  ensureDir(): string {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // the dir is inside the agent's own 0700 data dir; a failed tighten is not a leak
    }
    return dir;
  }

  path(ref: string): string {
    return join(this.dir(), `${ref}.json`);
  }

  /** Read one record BY PATH (`path(ref)` composes it); null for absent, unreadable, or schema-refusing (a corrupt record is not a lifecycle). */
  read(path: string): SshSessionRecord | null {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (typeof raw.ref !== "string" || typeof raw.lifecycle !== "string") return null;
      if (!LIFECYCLES.includes(raw.lifecycle)) return null;
      if (typeof raw.host !== "string" || typeof raw.port !== "number" || typeof raw.openedAtMs !== "number")
        return null;
      if (!("user" in raw) || !(raw.user === null || typeof raw.user === "string")) return null;
      return {
        ref: raw.ref,
        lifecycle: raw.lifecycle as SshSessionLifecycle,
        host: raw.host,
        port: raw.port,
        user: raw.user as string | null,
        openedAtMs: raw.openedAtMs,
        ...(typeof raw.lostAtMs === "number" ? { lostAtMs: raw.lostAtMs } : {}),
      };
    } catch {
      return null;
    }
  }

  write(rec: SshSessionRecord): void {
    const dir = this.ensureDir();
    const path = join(dir, `${rec.ref}.json`);
    writeFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  /** Forget one record entirely (the never-spawned unroll; nothing to reconcile afterwards). */
  drop(ref: string): void {
    try {
      unlinkSync(this.path(ref));
    } catch {
      // nothing recorded means nothing to undo
    }
  }
}

/** The digest that makes a duplicate open answer the live result instead of spawning twice. */
export function digestSessionRequest(target: unknown, runtimeCommand: string): string {
  return createHash("sha256")
    .update(JSON.stringify([target, runtimeCommand]))
    .digest("hex");
}
