import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED, semverLt } from "@internal/subshell-protocol";
import { log } from "../log.js";
import { applyUpdate, type UpdateManifestSource, UpdateRefused } from "../update.js";
import { NODE_VERSION } from "../version.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `update`: replace this agent's binary with the one the plane names, then
 * restart into it (spec 2026-09-15 §5.2).
 *
 * **An update is a restart with a file swap in front of it, so it inherits
 * both of `service restart`'s refusals** — verbatim, from
 * `commands/service.ts`, and in the same order:
 *
 * - **Not supervised** comes first, because it is the most specific truth:
 *   exiting is a restart only when the manager started THIS pid, and on a
 *   foreground `subshell run` exiting is a stop. Swapping the binary and then
 *   discovering that would leave a machine holding a new file it never runs.
 *   A null `runtime` answers it only with a caller's {@link SupervisionProof}
 *   — which is the loopback dashboard's boot-window half, where the frozen
 *   report has not landed (or failed) but the manager is asking right now.
 * - **Pane safety** fails CLOSED on `unknown` AND on no report at all — with
 *   the same null-answer rule: absent `runtime`, it reads the proof's
 *   `paneSafety`, and an absent one of those keeps the refusal. A missing
 *   report is less evidence of safety than an unreadable definition, not more
 *   — the same correction `execService` carries.
 * - **The version floor** refuses a command ordering a version that is not
 *   newer, so the downgrade refusal does not live only on the plane. `force`
 *   answers it (the node's own dashboard offers an explicit downgrade); an
 *   equal version is refused even under force.
 *
 * All three are checked BEFORE anything is downloaded. A refusal that arrives after
 * 70 MB has crossed the wire is a worse refusal for having been late, and the
 * plane's own 409 mapping reads the same constants either way.
 *
 * **The `result` frame goes out first, the exit follows.** `applyUpdate` is
 * called with `restart: false` and the executor answers `{ ok: true }`, then
 * asks the daemon to exit — the daemon is the only sender of `result`, so an
 * executor that restarted itself would reach the plane as a TIMEOUT for an
 * update that in fact worked. Exactly the shape `service restart` uses.
 *
 * What happens next is not this function's business and is the point of the
 * whole design: the manager respawns the agent, it dials the plane, and either
 * the connection is accepted (the daemon deletes `.previous` and the marker)
 * or it is closed 4406 (the daemon swaps `.previous` back and exits 1, so the
 * manager brings the PREVIOUS version up on a machine nobody had to visit).
 */
/**
 * What a CALLER who holds no frozen runtime report proved to `execUpdate`,
 * from its own live manager query (round-3 review, finding 5).
 *
 * The node's loopback dashboard has no socket and no `ready` — and during the
 * daemon's boot window (and on a host whose boot-time service read failed)
 * the frozen report is null even though the manager absolutely did start this
 * pid. The route already re-proves that fact to answer its early 409; without
 * this seam the same request then reached `execUpdate`, which read the same
 * null and 409'd the supervised node the route had just proved supervised —
 * two sources, mismatched null semantics, one act. With it the route's proof
 * IS the answer, and there is one implementation of both refusals again.
 *
 * `paneSafety` is what the same query said about the definition; a caller who
 * proved supervision and nothing else leaves it absent, and pane safety keeps
 * the fail-closed refusal a missing report has always gotten.
 */
export interface SupervisionProof {
  /** The service manager started THIS pid, per the caller's live query. */
  supervised: boolean;
  /** The same query's pane-safety answer; absent = the caller asked nothing about panes. */
  paneSafety?: "keeps" | "kills" | "unknown";
}

/**
 * What `execUpdate` reads; see {@link ServiceExecContext} for why it is narrowed.
 * `supervisedProof` is the dashboard's seam above; the daemon's own
 * `CommandContext` never carries one, which is what keeps the plane-commanded
 * path refusing on a null runtime exactly as it always did.
 */
export type UpdateExecContext = Pick<CommandContext, "runtime" | "config" | "binaryDeps" | "requestRestart"> & {
  supervisedProof?: SupervisionProof;
};

export async function execUpdate(ctx: UpdateExecContext, cmd: Cmd<"update">): Promise<CommandResult> {
  const runtime = ctx.runtime;
  const proof = runtime ? undefined : ctx.supervisedProof;

  // The frozen report OUTRANKS a proof whenever both exist: it names this
  // process's own boot, and nothing about supervision changes while the pid
  // does not — a caller's fresher-looking query cannot un-say it. The proof
  // fills the gap a null report leaves, for the caller who earned it by
  // asking the manager, and for no one else.
  if (!(runtime?.supervised ?? proof?.supervised === true)) {
    return { ok: false, error: NODE_RESULT_NOT_SUPERVISED };
  }
  const paneSafety = runtime?.service.paneSafety ?? proof?.paneSafety;
  if (cmd.force !== true && paneSafety !== "keeps") {
    return { ok: false, error: NODE_RESULT_KILLS_PANES };
  }

  // **The node-local version floor** (round-3 sweep C13, defense-in-depth).
  // The refusal normally lives plane-side — `update-node.route.ts` refuses
  // up-to-date and downgrade offers before the command is ever signed — and a
  // refusal that exists on only one side depends on the other side being
  // correct. So this side re-checks: a compromised or simply confused control
  // plane cannot walk this agent backwards by accident. The same `force` that
  // answers the pane-safety refusal answers this one, and that is deliberate
  // rather than a widening: the node's own loopback dashboard passes it for
  // its explicit "allow a downgrade" install (see `dashboard/routes.ts`),
  // which is the keyboard-equivalent act, while a well-behaved plane never
  // pairs force with a non-newer version. An EQUAL version is refused even
  // with force — re-swapping ~70 MB for a byte-identical binary is not what
  // force has ever meant here.
  //
  // This is deliberately NOT a `NODE_RESULT_*` constant: the wire constants
  // are protocol (`frames.ts`) and the plane maps them to fixed sentences —
  // a refusal this machine has never heard of mapping to an update the plane
  // has never offered would be a new wire meaning per occurrence. It falls
  // through the plane's generic node-update-failure mapping with the sentence
  // intact, which is exactly right for the only caller that can produce it.
  if (!semverLt(NODE_VERSION, cmd.version)) {
    const same = !semverLt(cmd.version, NODE_VERSION);
    if (same || cmd.force !== true) {
      return {
        ok: false,
        error: same
          ? `already at subshell ${NODE_VERSION}`
          : `${cmd.version} is older than the running ${NODE_VERSION}`,
      };
    }
  }

  // The signed manifest rides with the order (spec 2026-09-17 §6). BOTH parts
  // or neither: a command that carried a manifest without its signature (or
  // the reverse) cannot be verified, and "half a signature arrived" is the
  // same refusal as none — `applyUpdate` answers it before a byte of trust
  // lands anywhere. (Protocol <12 agents are never sent this command; the
  // plane refuses them with "agent predates signed updates".)
  const manifest: UpdateManifestSource | null =
    cmd.manifest !== undefined && cmd.manifestSig !== undefined
      ? { bytes: Buffer.from(cmd.manifest, "base64"), sig: cmd.manifestSig }
      : null;
  try {
    await applyUpdate({
      source: { kind: "url", url: cmd.url, sha256: cmd.sha256, manifest },
      version: cmd.version,
      force: cmd.force === true,
      // The daemon restarts; see the header. Passing `true` here would have
      // the agent ask its own service manager to restart the unit from inside
      // it, which is the exact mistake `service restart` exists not to make.
      restart: false,
      origin: "plane",
      dataDir: ctx.config.dataDir,
      binaryDeps: ctx.binaryDeps,
    });
  } catch (err) {
    // The wire constant, never the sentence: the plane maps
    // `NodeRpcError.detail` by equality, so a helpful message here becomes a
    // 409 naming nothing.
    //
    // Which means the SENTENCE has nowhere else to go, and it is the only
    // thing that says WHY. `download-failed` reaches the admin as "that node
    // could not download the new binary"; whether that was a 401 from a token
    // the plane had already forgotten, a 404, or a connection refused is
    // knowable only here. So it is logged on the machine it happened on,
    // where the node's owner can read it (`GET /api/nodes/:id/logs`). The
    // sentence is safe to log because `applyUpdate` builds it from
    // `redactUrl` — the query string it would otherwise carry is the
    // single-use `nut_…` token, which must not outlive the ten minutes that
    // bound it by sitting in a log file.
    if (err instanceof UpdateRefused) {
      log(`update refused (${err.detail}): ${err.message}`);
      return { ok: false, error: err.detail };
    }
    throw err;
  }

  ctx.requestRestart();
  return { ok: true };
}
