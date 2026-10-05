import type { SshControlMode } from "@internal/subshell-protocol";
import type { Kysely } from "kysely";
import type { GuardActor } from "@/api/auth-guard.js";
import { IS_TEST } from "@/constants.js";
import type { Database } from "@/db/types/index.js";
import type { SshActorSide } from "@/db/types/ssh-actor-side.js";
import type { SshCaller, SshDecision, SshPolicy } from "@/services/ssh/ssh-policy.js";

/**
 * The SSH branch of the GENERIC pane surfaces (SSH-SUPPORT.md §2, task-C
 * brief deliverable 3): the one seam every pane surface consults before it
 * reads or writes a MANAGED SSH pane, plus the plane's own facts about such
 * panes (the `ssh_panes` read the branch keys on) and the execution seam the
 * takeover act drives.
 *
 * **The census rule.** A surface calls {@link gatePaneSurfaceFor} (or
 * {@link gateSharingFor}) and obeys the decision; it never re-implements a
 * check the policy names (token identity, grant, revision, control state,
 * node eligibility) - the spec lists a local copy of these as the top bypass
 * risk. The one fact THIS module reads directly is the `ssh_panes` row: not a
 * decision, the question "is the SSH policy in play at all". A pane with no
 * row follows every existing path untouched (byte-identical hot path), which
 * is also the Wave-1 posture: no route can create a managed pane until D's
 * `/api/ssh/terminals` lands, so deny comes from "no ssh_panes row + the
 * policy refusing by default", never from a stub that says yes.
 *
 * **Deny by default at every seam here.** The policy is D's; until it is
 * registered, {@link DENY_EVERYTHING_SSH_POLICY} answers the refuse arm for
 * EVERY decision and tests replace it with a scripted policy. The pane
 * hooks are the EFFECTS only the SSH backend can perform (node dispatch of
 * the input/control commands, SSH re-launch on restart); while unregistered,
 * every managed-pane act refuses rather than falling back to a local shell.
 */

/* ------------------------------------------------------------------ */
/* the managed-pane facts (the branch's question, not its decision)    */
/* ------------------------------------------------------------------ */

/** The `ssh_panes` row, reduced to what the generic surfaces need to route. */
export interface SshManagedPaneFacts {
  /** The pane. */
  subshellId: string;
  /** Connection it connects. */
  connectionId: string;
  /** Revision pinned at open (display/reconciliation fact; the policy re-asks liveness facts itself). */
  connectionRevision: number;
  /** Who opened it (human-opened panes start human-controlled). */
  initiatedBy: SshActorSide;
  /** Who holds input now; `human` blocks agent reads AND writes everywhere. */
  controlOwner: SshActorSide;
  /** The plane's authoritative input-generation counter (raised on takeover/revocation). */
  controlGeneration: number;
  /** Log rotation namespace for the cursor-expired treatment. */
  logGeneration: number;
}

/**
 * One primary-key read on `ssh_panes` - "does the SSH policy apply to this
 * pane?" - the gate's hot path (migration 0048's note: keyed BY the subshell
 * id for exactly this read). Returns null for every ordinary pane.
 */
export async function readManagedPane(db: Kysely<Database>, subshellId: string): Promise<SshManagedPaneFacts | null> {
  const row = await db
    .selectFrom("sshPanes")
    .select([
      "subshellId",
      "connectionId",
      "connectionRevision",
      "initiatedBy",
      "controlOwner",
      "controlGeneration",
      "logGeneration",
    ])
    .where("subshellId", "=", subshellId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    subshellId: row.subshellId,
    connectionId: row.connectionId,
    connectionRevision: row.connectionRevision,
    initiatedBy: row.initiatedBy as SshActorSide,
    controlOwner: row.controlOwner as SshActorSide,
    controlGeneration: row.controlGeneration,
    logGeneration: row.logGeneration,
  };
}

/**
 * The batch form of {@link readManagedPane} for the list/preview/live filter:
 * one `IN` read over the visible ids, returning the managed subset. An empty
 * input is the ordinary-list hot path and reads nothing at all.
 */
export async function readManagedPanes(
  db: Kysely<Database>,
  subshellIds: readonly string[],
): Promise<Map<string, SshManagedPaneFacts>> {
  if (subshellIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("sshPanes")
    .select([
      "subshellId",
      "connectionId",
      "connectionRevision",
      "initiatedBy",
      "controlOwner",
      "controlGeneration",
      "logGeneration",
    ])
    .where("subshellId", "in", [...subshellIds])
    .execute();
  return new Map(
    rows.map((row) => [
      row.subshellId,
      {
        subshellId: row.subshellId,
        connectionId: row.connectionId,
        connectionRevision: row.connectionRevision,
        initiatedBy: row.initiatedBy as SshActorSide,
        controlOwner: row.controlOwner as SshActorSide,
        controlGeneration: row.controlGeneration,
        logGeneration: row.logGeneration,
      },
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* policy injection (D implements; deny is the default until it does)  */
/* ------------------------------------------------------------------ */

/**
 * The Wave-1 placeholder. EVERY arm refuses with the named code that fits it
 * - the interface's own law: "Refusals are the default until the full policy
 * is installed" and "Do not merge a placeholder authorization helper that
 * returns success." `pane_surface` decisions refuse as `not_found` because
 * the surface convention for an unauthorizable managed pane is invisibility
 * (404 / absent from a list / 4005 attach close), which is also the
 * non-enumerating answer.
 *
 * @internal Exported ONLY so the map in tests and the integration review can
 * read it; nothing outside this module calls it once D registers the real one.
 */
export const DENY_EVERYTHING_SSH_POLICY: SshPolicy = {
  gateHumanConfig: async () => ({ allow: false, code: "cookie_required" }),
  gateGrantedUse: async () => ({ allow: false, code: "not_found" }),
  // The pane-surface and control arms refuse as `not_found`: the surface
  // convention for an unauthorizable managed pane is INVISIBILITY (404 /
  // absent from a list / a uniform attach refusal), which is also the
  // non-enumerating answer.
  gatePaneSurface: async () => ({ allow: false, code: "not_found" }),
  gateControl: async () => ({ allow: false, code: "not_found" }),
  gateSharing: async () => ({ allow: false, code: "sharing_unsupported" }),
};

let policy: SshPolicy = DENY_EVERYTHING_SSH_POLICY;

/**
 * Register the real SSH policy (workstream D's implementation, called once at
 * boot from the composition root - integration point; see the task-C report).
 * Until then every managed-pane decision answers refuse.
 */
export function registerSshPolicy(p: SshPolicy): void {
  policy = p;
}

/** The policy every surface consults. Never null; before registration, deny. */
export function getSshPolicy(): SshPolicy {
  return policy;
}

/**
 * @internal Test seam: install a scripted policy for one suite, restore the
 * deny-everything placeholder on teardown. Hard-refused outside the test mode.
 */
export function setSshPolicyForTests(p: SshPolicy | null): void {
  if (!IS_TEST) throw new Error("setSshPolicyForTests is a test-only seam");
  policy = p ?? DENY_EVERYTHING_SSH_POLICY;
}

/* ------------------------------------------------------------------ */
/* caller construction                                                  */
/* ------------------------------------------------------------------ */

/** The guard facts a surface already holds when it considers the SSH branch. */
export interface SshCallerSeed {
  actor: GuardActor;
  userId: string;
  principal: string;
  apiKeyId: string | null;
}

/**
 * Build a seed from the pieces `authGuard` injects into a route handler
 * (`user`, `actor`, `principal`, `apiKeyId`). The seed is free - no reads, no
 * policy call - and every per-subshell route builds one per request; the SSH
 * branch only turns it into a full {@link SshCaller} (one PK read for the
 * admin flag) when the pane it acts on is actually managed.
 */
export function sshCallerSeed(guard: {
  user: { id: string };
  actor: GuardActor;
  principal: string;
  apiKeyId: string | null;
}): SshCallerSeed {
  return { actor: guard.actor, userId: guard.user.id, principal: guard.principal, apiKeyId: guard.apiKeyId };
}

/**
 * Complete a guard-resolved identity into the policy's {@link SshCaller}.
 * Called ONLY on the managed-pane branch (never builds extra reads for
 * ordinary panes); the admin flag rides for the interface's shape, never as
 * an override (spec §2: admin status does not bypass the SSH rules).
 */
export async function completeSshCaller(db: Kysely<Database>, seed: SshCallerSeed): Promise<SshCaller> {
  const meta = await db.selectFrom("userMeta").select("role").where("userId", "=", seed.userId).executeTakeFirst();
  return {
    actor: seed.actor,
    userId: seed.userId,
    principal: seed.principal,
    apiKeyId: seed.apiKeyId,
    subshellId: seed.principal.startsWith("sess:") ? seed.principal.slice("sess:".length) : null,
    isAdmin: meta?.role === "admin",
  };
}

/* ------------------------------------------------------------------ */
/* the effects only the SSH backend can perform                        */
/* ------------------------------------------------------------------ */

/**
 * The execution seam for managed-panes-only acts (the brief's "provide the
 * seam D can call", turned around: these are the acts the generic paths must
 * NOT fake locally, so they call here and refuse while nothing is registered).
 *
 * Every method dispatches over the node link (B's arms) with the facts the
 * PLANE owns: the pane's current input generation rides every input/prompt
 * write (the frozen additive `inputGeneration` field), and a control
 * transition carries the raised counter so the machine's mirror moves with
 * the plane's, never behind it.
 */
export interface SshPaneHooks {
  /** Type into a managed pane through the SSH input path, stamped with the pane's current generation. */
  sendManagedInput(req: {
    subshellId: string;
    text: string;
    submit: boolean;
    /** The pane's CURRENT control generation (the fence value at write time). */
    inputGeneration: number;
  }): Promise<void>;
  /** Relay the takeover/return transition + raised generation to the node (`ssh_input_control`). */
  applyControlTransition(req: { subshellId: string; mode: SshControlMode; generation: number }): Promise<void>;
  /** Re-launch the pane's SSH session (the restart path: fresh authorization was ALREADY rechecked by the policy gate). */
  restartManagedPane(req: { subshellId: string }): Promise<{ tmuxSocket: string }>;
}

let hooks: SshPaneHooks | null = null;

/** Register the SSH backend's pane hooks at boot (D's implementation; integration point). */
export function registerSshPaneHooks(h: SshPaneHooks): void {
  hooks = h;
}

/** The registered hooks or null (managed-pane acts refuse while null). */
export function getSshPaneHooks(): SshPaneHooks | null {
  return hooks;
}

/** @internal Test seam for the hooks half of the seam. */
export function setSshPaneHooksForTests(h: SshPaneHooks | null): void {
  if (!IS_TEST) throw new Error("setSshPaneHooksForTests is a test-only seam");
  hooks = h;
}

/* ------------------------------------------------------------------ */
/* control transitions (human takeover / return)                        */
/* ------------------------------------------------------------------ */

/**
 * Move a managed pane's input control: the SERVER raises the generation
 * (never the caller's to choose), the NODE is told FIRST (a refusal there
 * leaves the plane untouched), then `ssh_panes` follows. Returns the new
 * state. Throws `SshGateFailure` when the transition cannot be honored:
 * `backend_unavailable` while no hooks are registered (deny by default - a
 * takeover that fenced only the plane would leave the machine accepting the
 * stale input the spec says it fences), or `gone` when the pane stopped being
 * managed under the caller's feet.
 */
export async function transitionPaneControl(
  db: Kysely<Database>,
  subshellId: string,
  mode: SshActorSide,
): Promise<{ controlOwner: SshActorSide; controlGeneration: number }> {
  const current = await readManagedPane(db, subshellId);
  if (!current) throw new SshGateFailure("gone", "Subshell not found");
  const h = getSshPaneHooks();
  if (!h) {
    throw new SshGateFailure("backend_unavailable", "The SSH backend needed for this pane action is not available");
  }
  const generation = current.controlGeneration + 1;
  // Node first: the machine mirror must never trail the plane's claim.
  await h.applyControlTransition({ subshellId, mode, generation });
  const updated = await db
    .updateTable("sshPanes")
    .set({ controlOwner: mode, controlGeneration: generation })
    .where("subshellId", "=", subshellId)
    .executeTakeFirst();
  if (updated.numUpdatedRows === 0n) throw new SshGateFailure("gone", "Subshell not found");
  return { controlOwner: mode, controlGeneration: generation };
}

/** A control/gate failure with a stable name the service maps onto HTTP. */
export class SshGateFailure extends Error {
  constructor(
    readonly reason: "not_found" | "forbidden" | "backend_unavailable" | "gone",
    message: string,
    /** The policy's named refusal, when this came from a decision (rides the response metadata). */
    readonly policyCode?: string,
  ) {
    super(message);
  }
}

/** Map one policy decision onto the throw the surface owes it. */
function failureFromDecision(decision: SshDecision): SshGateFailure {
  if (decision.allow) throw new Error("failureFromDecision called with an allow");
  // `not_found` is the 404 convention; everything else is the visible-but-
  // insufficient 403. The named code rides so MCP/SPA map by equality, never
  // by parsing a sentence (ssh-api-types' convention).
  return new SshGateFailure(
    decision.code === "not_found" ? "not_found" : "forbidden",
    decision.code === "not_found" ? "Subshell not found" : `The SSH policy refuses this action: ${decision.code}`,
    decision.code,
  );
}

/**
 * THE pane-surface gate: consult the policy for one managed-pane surface and
 * return the pane's facts when (and only when) the act is authorized.
 *
 * - Ordinary pane (no `ssh_panes` row): returns null - the caller continues on
 *   its untouched existing path.
 * - Managed pane + allow: returns the facts (the caller may read them from
 *   this row afterward, never smuggle them through a decision).
 * - Managed pane + refuse: throws {@link SshGateFailure}; the service maps
 *   `not_found` to its own 404 and everything else to 403 + metadata.
 *
 * The recheck happens HERE, at every call: the interface's rule is that the
 * policy re-asks live facts at decision time, so no surface may cache this
 * across an act boundary.
 */
export async function gatePaneSurfaceFor(
  db: Kysely<Database>,
  seed: SshCallerSeed,
  subshellId: string,
  surface: Parameters<SshPolicy["gatePaneSurface"]>[0]["surface"],
): Promise<SshManagedPaneFacts | null> {
  const facts = await readManagedPane(db, subshellId);
  if (!facts) return null;
  const caller = await completeSshCaller(db, seed);
  const decision = await getSshPolicy().gatePaneSurface({ caller, subshellId, surface });
  if (!decision.allow) throw failureFromDecision(decision);
  return facts;
}

/**
 * The sharing gate (spec §2: sharing SSH panes is refused in v1, to anyone,
 * always - the OWNER included). Returns false for an ordinary pane (ordinary
 * sharing rules continue); true means "this is a managed pane and the policy
 * allowed sharing", which the v1 answer never is - the caller refuses.
 */
export async function gateSharingFor(
  db: Kysely<Database>,
  seed: SshCallerSeed,
  subshellId: string,
): Promise<SshManagedPaneFacts | null> {
  const facts = await readManagedPane(db, subshellId);
  if (!facts) return null;
  const caller = await completeSshCaller(db, seed);
  const decision = await getSshPolicy().gateSharing({ caller, subshellId });
  if (!decision.allow) throw failureFromDecision(decision);
  return facts;
}

/**
 * The human-config arm (takeover/return and the SSH acts a human performs).
 * A refusal throws like the pane gate; an allow proceeds. Used by the
 * ssh-control route before it performs the transition.
 */
export async function gateHumanActFor(
  db: Kysely<Database>,
  seed: SshCallerSeed,
  action: Parameters<SshPolicy["gateHumanConfig"]>[0]["action"],
  connectionId?: string,
): Promise<void> {
  const caller = await completeSshCaller(db, seed);
  const decision = await getSshPolicy().gateHumanConfig({
    caller,
    action,
    ...(connectionId !== undefined ? { connectionId } : {}),
  });
  if (!decision.allow) throw failureFromDecision(decision);
}
