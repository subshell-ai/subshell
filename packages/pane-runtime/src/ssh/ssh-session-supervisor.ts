import {
  isSshSessionRef,
  SSH_CANCEL_GRACE_MS,
  SSH_SESSION_UNKNOWN,
  SSH_SESSIONS_PER_NODE,
} from "@internal/subshell-protocol";
import { killGroup } from "./ssh-run-child.js";
import {
  type LiveSession,
  runSessionOpen,
  type SshSessionHooks,
  type SshSessionOpenOutcome,
  type SshSessionOpenRequest,
} from "./ssh-session-open.js";
import { digestSessionRequest, type SshSessionRecord, SshSessionRecordStore } from "./ssh-session-store.js";

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
 *   SIGKILL), and `closed` is recorded FIRST so the death on the way down is
 *   not additionally reported as `lost`. The destination's tmux server and
 *   its panes stay up; killing them is terminate, never a close side effect.
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
 * (`runtime_missing`, `session_protocol`, `connection_failed`, the classified
 * transport codes); {@link SSH_SESSION_UNKNOWN} answers send/close on a ref
 * this process has no live child for.
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

  /**
   * Close one session as a USER act (design §6's Close): record `closed`
   * first (the death on the way down is then never additionally reported as
   * `lost`), SIGTERM the group, SIGKILL after the grace. The group-kill is
   * NOT delegated to the runtime's own good behavior: the plane sends this
   * command on every user close (and the protocol-mismatch unroll), and a
   * runtime that ignored the `close` frame is exactly why it exists.
   */
  close(ref: string): "ok" | typeof SSH_SESSION_UNKNOWN {
    const live = this.#live.get(ref);
    if (!live) return SSH_SESSION_UNKNOWN;
    live.stopping = true;
    const rec = this.#store.read(this.#store.path(ref));
    if (rec) this.#store.write({ ...rec, lifecycle: "closed", lostAtMs: this.#nowMs() });
    killGroup(live.pid, "SIGTERM");
    live.killEscalate = setTimeout(() => {
      killGroup(live.pid, "SIGKILL");
    }, SSH_CANCEL_GRACE_MS);
    live.killEscalate.unref?.();
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
