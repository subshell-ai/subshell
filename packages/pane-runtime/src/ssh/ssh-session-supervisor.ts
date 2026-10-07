import {
  isSshSessionRef,
  SSH_CANCEL_GRACE_MS,
  SSH_SESSION_UNKNOWN,
  SSH_SESSIONS_PER_NODE,
} from "@internal/subshell-protocol";
import { killGroup } from "./kill-group.js";
import {
  type LiveSession,
  runSessionOpen,
  type SshSessionHooks,
  type SshSessionOpenOutcome,
  type SshSessionOpenRequest,
} from "./ssh-session-open.js";
import { digestSessionRequest, type SshSessionRecord, SshSessionRecordStore } from "./ssh-session-store.js";

const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const INPUT_FLUSH_TIMEOUT_MS = 10_000;
interface PendingInput {
  bytes: number;
  cancel: Set<() => void>;
}

/**
 * The brokered-session engine's SURFACE (design 2026-10-05 §3): one SSH child
 * per session under the SAME mandatory policy the structured runs use, and
 * the door the agent's `ssh_session_*` executors call. The child-spawning
 * sequence itself - durable acceptance, runtime probe, spawn, hello gate,
 * pumps - lives in `ssh-session-open.ts` and registers its children into the
 * live map this class owns; the DISK half is `ssh-session-store.ts` (records,
 * boot reconcile scan) and the per-destination facts are
 * `ssh-session-invocation.ts` (socket naming, snapshot, hello scan) - the run
 * family's store/supervisor split, mirrored.
 *
 * What stays HERE is the decision surface and the durable promises around it:
 *
 * - **Grammar, dedup, quota before anything is accepted**: a bad ref answers
 *   `run_unknown`, a replayed identical request re-answers the live result
 *   (no second child), a different payload under one ref answers
 *   `run_conflict`, and the per-node quota is decided with the acceptance,
 *   not after it (the run supervisor's reasoning, kept verbatim by the chain
 *   that serializes opens).
 * - **One serialized chain**: concurrent opens cannot both pass the quota
 *   check and both spawn.
 * - **Kill the GROUP** on close (SIGTERM, {@link SSH_CANCEL_GRACE_MS},
 *   SIGKILL) FIRST, and record `closed` best-effort after: the `stopping`
 *   latch (not the record) keeps the death on the way down from reporting
 *   itself as `lost`, and no disk fault in the record may spare the kill
 *   (round-4 review MINOR2 - an orphan holds a quota slot and the
 *   destination's door). The destination's tmux server and its panes stay
 *   up; killing them is terminate, never a close side effect.
 * - **Boot reconcile**: a state file claiming `accepted`/`open` with no live
 *   child under this process reads back `lost`, never a restart. The tmux
 *   server the last session spoke to SURVIVED on the destination (design §6);
 *   this record only tells the truth about the child that did not.
 * - **Send is write-only truth**: a ref this process has no live child for
 *   answers the bare {@link SSH_SESSION_UNKNOWN}, never a retry cue.
 *
 * Why the node owner running this is NOT a widening: the node's OS user can
 * already run any command on the destination through their own SSH - that is
 * what owning an account on the connecting node means. The open flow composes
 * exactly one such command (the runtime's own entry point, per-token quoted),
 * under the un-weakened runtime policy, and pipes its stdio.
 *
 * Refusals the plane maps by EQUALITY ride the bare codes: `run_unknown`,
 * `run_conflict`, `session_quota`, and whatever the open flow names
 * (`runtime_missing`, `session_in_use`, `session_protocol`,
 * `connection_failed`, the classified transport codes);
 * {@link SSH_SESSION_UNKNOWN} answers send/close on a ref this process has no
 * live child for.
 */

/** Everything the supervisor needs from its host. */
export interface SshSessionSupervisorDeps {
  /** Node data dir; session records live under `<dataDir>/ssh/sessions/`. */
  dataDir: string;
  /** The connecting account's home (the ssh child's HOME, the default trust refs). */
  homeDir: string;
  /** Absolute ssh binary (the ladder resolved it; nothing here re-searches). */
  sshBin: string;
  /** Epoch-ms clock (injectable). */
  nowMs(): number;
}

export class SshSessionSupervisor {
  readonly #homeDir: string;
  readonly #sshBin: string;
  readonly #store: SshSessionRecordStore;
  readonly #nowMs: () => number;
  readonly #live = new Map<string, LiveSession>();
  readonly #pendingInput = new WeakMap<LiveSession, PendingInput>();
  /** One pending-open chain: quota + acceptance decided together (the run supervisor's reasoning). */
  #openChain: Promise<unknown> = Promise.resolve();

  constructor(deps: SshSessionSupervisorDeps) {
    this.#homeDir = deps.homeDir;
    this.#sshBin = deps.sshBin;
    this.#store = new SshSessionRecordStore({ dataDir: deps.dataDir, nowMs: deps.nowMs });
    this.#nowMs = deps.nowMs;
    // Boot reconcile at BUILD time: the first open in this process is what
    // reads last daemon's stale `accepted`/`open` records back to `lost`
    // (never a restart, never a claim about the destination's tmux). Records
    // from a node that never brokers stay untouched, which is fine: they are
    // read only through this map.
    this.reconcileAtBoot();
  }

  /** Live session refs this process supervises right now (the boot reconcile's "mine" set). */
  liveRefs(): string[] {
    return [...this.#live.keys()];
  }

  /** Every `accepted`/`open` state with no live child under this process becomes `lost` (never a restart, never a claim about the destination's tmux). */
  reconcileAtBoot(): SshSessionRecord[] {
    return this.#store.reconcileAll(new Set(this.#live.keys()));
  }

  /**
   * Open one session. Order is the contract: ref grammar -> dedup/quota ->
   * the open flow (`ssh-session-open.ts`: durable acceptance, probe, spawn,
   * hello, pumps). Every refusal happens before a long-lived child exists;
   * every acceptance before any spawn, so a crash between the two reads back
   * `lost` at the next boot.
   */
  async open(req: SshSessionOpenRequest, hooks: SshSessionHooks): Promise<SshSessionOpenOutcome> {
    const run = async (): Promise<SshSessionOpenOutcome> => {
      if (!isSshSessionRef(req.ref)) return { kind: "refused", code: "run_unknown" };
      const digest = this.#digest(req);
      const existing = this.#live.get(req.ref);
      if (existing) {
        if (existing.requestDigest === digest) return { kind: "open", result: existing.result };
        return { kind: "refused", code: "run_conflict" };
      }
      if (this.#live.size >= SSH_SESSIONS_PER_NODE) return { kind: "refused", code: "session_quota" };
      return runSessionOpen(
        {
          homeDir: this.#homeDir,
          sshBin: this.#sshBin,
          store: this.#store,
          nowMs: this.#nowMs,
          live: this.#live,
          requestDigest: digest,
        },
        req,
        hooks,
      );
    };
    const chained = this.#openChain.then(run, run);
    this.#openChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return await chained;
  }

  /**
   * Feed plane->runtime bytes into the child's stdin. Unknown refs answer the
   * bare {@link SSH_SESSION_UNKNOWN}: the plane already learned the loss from
   * the close report; a write to a dead child must never read as a retry cue.
   */
  send(ref: string, bytes: Uint8Array): "ok" | typeof SSH_SESSION_UNKNOWN {
    if (!isSshSessionRef(ref)) return SSH_SESSION_UNKNOWN;
    const live = this.#live.get(ref);
    if (!live) return SSH_SESSION_UNKNOWN;
    try {
      live.stdin.write(bytes);
      void Promise.resolve(live.stdin.flushAsync?.()).catch(() => {});
      return "ok";
    } catch {
      return SSH_SESSION_UNKNOWN;
    }
  }

  /** Acknowledge only flushed bytes, with a per-child memory and time bound.
   * A stalled sink loses its session rather than accepting more input forever.
   * Keep the legacy synchronous send surface for its existing callers.
   */
  async sendAsync(ref: string, bytes: Uint8Array): Promise<"ok" | typeof SSH_SESSION_UNKNOWN> {
    if (!isSshSessionRef(ref)) return SSH_SESSION_UNKNOWN;
    const live = this.#live.get(ref);
    if (!live || live.stopping) return SSH_SESSION_UNKNOWN;
    if (bytes.byteLength === 0) return "ok";
    let pending = this.#pendingInput.get(live);
    if (!pending) {
      pending = { bytes: 0, cancel: new Set() };
      this.#pendingInput.set(live, pending);
    }
    if (pending.bytes + bytes.byteLength > MAX_PENDING_INPUT_BYTES || pending.cancel.size >= 32) {
      this.close(ref);
      return SSH_SESSION_UNKNOWN;
    }
    pending.bytes += bytes.byteLength;
    let cancel!: () => void;
    const cancelled = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
      pending.cancel.add(cancel);
    });
    const timer = setTimeout(() => {
      if (this.#live.get(ref) === live) this.close(ref);
      else cancel();
    }, INPUT_FLUSH_TIMEOUT_MS);
    try {
      // Bun's FileSink exposes flush(), which becomes a promise when its
      // pipe fills. flushAsync is retained only for existing injected sinks.
      const flush = live.stdin.flush?.bind(live.stdin) ?? live.stdin.flushAsync?.bind(live.stdin);
      if (!flush) throw new Error("SSH input cannot flush");
      live.stdin.write(bytes);
      const flushed = await Promise.race([Promise.resolve(flush()).then(() => true), cancelled]);
      return flushed && this.#live.get(ref) === live && !live.stopping ? "ok" : SSH_SESSION_UNKNOWN;
    } catch {
      if (this.#live.get(ref) === live && !live.stopping) this.close(ref);
      return SSH_SESSION_UNKNOWN;
    } finally {
      clearTimeout(timer);
      pending.bytes -= bytes.byteLength;
      pending.cancel.delete(cancel);
    }
  }

  /**
   * Close one session as a USER act (design §6's Close): SIGTERM the group,
   * SIGKILL after the grace, THEN record `closed` best-effort. The kill
   * leads because the record write is bare sync fs (ENOSPC/EROFS/EACCES are
   * ordinary) and a disk fault must never spare it: an orphan holds a quota
   * slot and the destination's door (round-4 review MINOR2). The `stopping`
   * latch, not the record, keeps the death on the way down from reporting
   * itself as `lost`; a missing `closed` costs only history, which the exit
   * pump or the boot reconcile settles. The group-kill is NOT delegated to
   * the runtime's own good behavior: the plane sends this command on every
   * user close (and the protocol-mismatch unroll), and a runtime that
   * ignored the `close` frame is exactly why it exists.
   */
  close(ref: string): "ok" | typeof SSH_SESSION_UNKNOWN {
    const live = this.#live.get(ref);
    if (!live) return SSH_SESSION_UNKNOWN;
    if (live.stopping) return "ok";
    // The latch FIRST: it is what quiets the death handler (ssh-session-open
    // reads it when the exit lands), so every act below is free to fail.
    live.stopping = true;
    for (const cancel of this.#pendingInput.get(live)?.cancel ?? []) cancel();
    killGroup(live.pid, "SIGTERM");
    live.killEscalate = setTimeout(() => {
      killGroup(live.pid, "SIGKILL");
    }, SSH_CANCEL_GRACE_MS);
    live.killEscalate.unref?.();
    try {
      const rec = this.#store.read(this.#store.path(ref));
      if (rec) this.#store.write({ ...rec, lifecycle: "closed", lostAtMs: this.#nowMs() });
    } catch {
      // A failed record is a reconcile detail: the child is dead (the kill
      // went first), the live map is authority, and the exit pump (or the
      // next boot reconcile) settles the disk to `lost` for the dead pid.
    }
    return "ok";
  }

  #digest(req: SshSessionOpenRequest): string {
    return digestSessionRequest(req.target, req.runtimeCommand);
  }
}

/** Process-level registry: one supervisor per data dir (the run supervisor's singleton posture). */
const supervisors = new Map<string, SshSessionSupervisor>();

/** The supervisor for one data dir, built lazily from caller-supplied facts (never at import). */
export function getSshSessionSupervisor(deps: {
  dataDir: string;
  homeDir: string;
  sshBin: string;
  nowMs?: () => number;
}): SshSessionSupervisor {
  let instance = supervisors.get(deps.dataDir);
  if (!instance) {
    instance = new SshSessionSupervisor({ ...deps, nowMs: deps.nowMs ?? Date.now });
    supervisors.set(deps.dataDir, instance);
  }
  return instance;
}

/** The live supervisor for a data dir, if one was ever built (reconcile/sweeps reach through this; NEVER builds one). */
export function peekSshSessionSupervisor(dataDir: string): SshSessionSupervisor | undefined {
  return supervisors.get(dataDir);
}

/** Drop the registry (test isolation). @internal */
export function resetSshSessionSupervisorsForTests(): void {
  supervisors.clear();
}
