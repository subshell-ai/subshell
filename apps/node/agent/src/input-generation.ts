import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { isSubshellId } from "./subshell-meta.js";

/**
 * The node's mirror of each pane's INPUT GENERATION.
 *
 * The plane owns the counter and raises it on every takeover/revocation
 * transition; this mirror is what makes the fence a MACHINE fact rather than
 * a plane promise: an input/prompt write that carries the additive
 * `inputGeneration` field is checked here, and a write below the mirror's
 * current value is refused, after any queueing, after a reconnect, and after
 * an agent restart (the mirror is persisted beside the pane meta for exactly
 * that reason - an agent that forgot its generations on restart would
 * un-fence everything a takeover just fenced).
 *
 * The destination product's managed panes retired with it (design
 * 2026-10-05 §7): the `ssh_input_control` and `ssh_terminal_launch` commands
 * that wrote this store are gone, so nothing records a generation today, and
 * the deny-by-construction rule below makes every pane an ordinary pane. The
 * fence stays - the wire field, the frozen refusal, and the monotonic mirror
 * are the seam the NEXT control-transition feature adopts instead of
 * reinventing.
 *
 * **Deny by construction:** a pane with NO record is an ordinary pane and the
 * policy does not apply to it (every existing input path is untouched). A pane
 * WITH a record is managed, and a managed write carrying no generation, or one
 * below the record, is refused with the frozen
 * `NODE_RESULT_SSH_GENERATION_STALE` spelling. A generation ABOVE the record
 * is accepted: the contract ("every managed input write carries at least this
 * value") reads the plane's ordered link as the guarantor that the transition
 * lands before or with the input it fences, and accepting equal-or-higher
 * cannot un-fence anything - the only values that LOSE the fence are below,
 * and they are refused.
 *
 * Deliberately dumb about WHO set the value: the command signature already
 * proved the control plane sent it. What the plane must not be able to do is
 * LOWER a mirror - the transition handlers refuse a lowering; this module's
 * `record` is the monotonic setter they share.
 */

/** On-disk file name inside the agent data dir (beside the pane metas). */
const FILE = "ssh-input-generations.json";

/** Temp-name counter: two records inside one process never write the same temp. */
let persistSeq = 0;

/** On-disk shape. Versioned so a future format change is detectable, not misread. */
interface GenerationsFile {
  version: 1;
  generations: Record<string, number>;
}

export class InputGenerationStore {
  private readonly file: string;
  private readonly dataDir: string;
  /** Live counters by subshell id. Loaded once from disk; every change rewrites the file synchronously. */
  private readonly gens = new Map<string, number>();
  private loaded = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = join(dataDir, FILE);
  }

  /** Read the persisted mirror on first use. A corrupt file is treated as EMPTY and rewritten on the next record. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const record = (parsed as Partial<GenerationsFile>)?.generations;
      if (typeof record !== "object" || record === null) throw new SyntaxError("missing generations map");
      for (const [id, value] of Object.entries(record)) {
        // A persisted id that no longer passes the id gate is dropped rather
        // than trusted: the same guard the live record() path enforces.
        if (!isSubshellId(id)) continue;
        if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
          this.gens.set(id, value);
        }
      }
    } catch (err) {
      log(`ssh input generations: ${this.file} unreadable; starting with no managed panes`);
      void err;
    }
  }

  /**
   * The pane's current generation, or null when this pane has NO record (the
   * policy does not apply - an ordinary pane).
   */
  current(subshellId: string): number | null {
    this.ensureLoaded();
    return this.gens.get(subshellId) ?? null;
  }

  /**
   * Establish or RAISE a pane's generation (the seam a control-transition
   * feature writes through). Monotonic: a lower value is refused by
   * returning the still-current one, so a replayed old transition cannot
   * un-fence input (the plane's counter is authoritative; the mirror only ever
   * moves forward).
   * @returns the generation in force after the call
   * @throws when `subshellId` is not a valid id (the store-throwing-id rule)
   */
  record(subshellId: string, generation: number): number {
    if (!isSubshellId(subshellId)) throw new Error("invalid subshell id");
    if (!Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
    this.ensureLoaded();
    const had = this.gens.get(subshellId) ?? 0;
    if (generation > had) {
      this.gens.set(subshellId, generation);
      this.persist();
    }
    return Math.max(had, generation);
  }

  /**
   * Drop a pane's record. Idempotent; the file rewrite is skipped when
   * nothing was there. The handlers this was written for (managed-pane delete
   * and log cleanup) retired with the destination product, so like `record()`
   * it is currently unwired: both stand ready as the seam the next
   * control-transition feature writes through.
   */
  forget(subshellId: string): void {
    if (!isSubshellId(subshellId)) return; // id gate first; a junk id never had a record
    this.ensureLoaded();
    if (this.gens.delete(subshellId)) this.persist();
  }

  /**
   * The fence verdict for one input/prompt write: `"ok"` (ordinary pane, or a
   * generation at/above the mirror), `"stale"` (managed pane, missing or lower
   * generation - refuse with the frozen wire spelling). A missing id-shaped
   * check is the CALLER's (`resolveSocket` owns the bad-id answer); a lookup
   * for any string is total.
   */
  check(subshellId: string, inputGeneration: number | undefined): "ok" | "stale" {
    const current = this.current(subshellId);
    if (current === null) return "ok"; // ordinary pane: no generation policy
    if (inputGeneration === undefined || inputGeneration < current) return "stale";
    return "ok";
  }

  /** temp + rename at 0600, the `allowed-dirs.ts` discipline verbatim. */
  private persist(): void {
    const body: GenerationsFile = { version: 1, generations: Object.fromEntries(this.gens) };
    const tmp = `${this.file}.${process.pid}.${++persistSeq}.tmp`;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** Process-wide stores by data dir - one daemon, one file; tests pass temp dirs and never collide. */
const stores = new Map<string, InputGenerationStore>();

/**
 * The agent's ONE generation mirror for this data dir (module-singleton
 * precedent: `getAuth()` - constructed lazily on first use, never at import).
 */
export function getInputGenerationStore(dataDir: string): InputGenerationStore {
  let store = stores.get(dataDir);
  if (!store) {
    store = new InputGenerationStore(dataDir);
    stores.set(dataDir, store);
  }
  return store;
}

/**
 * @internal Test isolation: forgets the memoized store for a data dir so a
 * fresh instance re-reads the file.
 */
export function resetInputGenerationStoresForTests(): void {
  stores.clear();
}
