import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NO_SERVICE,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_SERVICE_DESTRUCTIVE,
  type NodeServiceVerb,
} from "@internal/subshell-protocol";
import { controlService, DEFAULT_DEPS, installService, isServiceVerb, uninstallService } from "../service.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * The verbs that need a service definition to exist.
 *
 * `uninstall` is deliberately absent: removing what is already gone is a
 * no-op, and the CLI answers it 0 — an idempotent teardown is what a caller
 * wants, and the agent's own `service uninstall` keeps that property so a
 * stranded unit can always come down.
 */
const NEEDS_DEFINITION: readonly NodeServiceVerb[] = ["start", "stop"];

/**
 * `service`: drive this machine's service manager (spec 2026-09-12, node half).
 *
 * One executor for all five verbs because they are one manager and one set of
 * refusals. Through protocol 4 `restart` was its own command; folding it in
 * removed a second refusal path and a second chance to disagree about pane
 * safety.
 *
 * **`restart` is not `systemctl restart`.** The agent restarts by EXITING 0 and
 * letting its manager respawn it — asking systemd to restart the unit from
 * inside that unit kills the process mid-command, so the result frame never
 * goes out and the plane sees a dropped socket instead of an answer. Every
 * other verb is a real call to the manager.
 *
 * **Two of these are one-way from the plane, and the agent cannot soften
 * that.** A command arrives over the agent's own socket, so `stop` and
 * `uninstall` end the connection that would have carried the verb undoing
 * them; nothing here can start an agent that is not running. The plane gates
 * both on OWNERSHIP and says so in the confirmation (spec § 5.1); this side
 * simply performs them.
 */
/**
 * What `execService` actually reads. A `CommandContext` satisfies it, and so
 * does the local dashboard's own object — the route serving
 * `POST /api/nodes/:id/service` holds no signed command frame and no socket,
 * and a second implementation of these refusals for its benefit is exactly the
 * drift this file's one-executor rule argues against.
 */
export type ServiceExecContext = Pick<CommandContext, "runtime" | "requestRestart" | "serviceDeps">;

export async function execService(ctx: ServiceExecContext, cmd: Cmd<"service">): Promise<CommandResult> {
  const runtime = ctx.runtime;

  // SUPERVISION first, and only for `restart`, because it is the most
  // specific truth available about that verb: exiting is a restart only when
  // the manager started THIS pid, and on a foreground `subshell run` exiting
  // is a STOP. Answering a pane warning there would diagnose the smaller
  // problem — and with no report at all, "not supervised" is exactly what
  // this agent cannot disprove.
  if (cmd.verb === "restart" && !runtime?.supervised) {
    return { ok: false, error: NODE_RESULT_NOT_SUPERVISED };
  }

  // NOTHING INSTALLED is its own answer, and it has to come first.
  //
  // A machine with no definition reports `paneSafety: "unknown"` (there is no
  // definition to read), so the pane-safety branch below used to fire on it and
  // answer "the definition could not be read" — about a machine that has none.
  // On the hand-run agent this constant was written for, Stop therefore gave
  // two wrong diagnoses in a row: a pane warning, and then, only after being
  // forced, the truth.
  //
  // `install` is excluded because it is the remedy, and `restart` because it
  // does not drive the manager at all — it exits, and the `supervised` check
  // below is the honest refusal there.
  if (runtime?.service.installed === false && NEEDS_DEFINITION.includes(cmd.verb)) {
    return { ok: false, error: NODE_RESULT_NO_SERVICE };
  }

  // Pane safety, for every verb that can end a pane. The CLI's own destructive
  // verbs fail CLOSED on `unknown` — the definition exists but could not be
  // read — and so does this: telling someone their panes are safe when nobody
  // could tell is the kind of certainty that gets ignored.
  //
  // NO REPORT AT ALL fails closed too, and that is the half this used to get
  // backwards: `runtime &&` skipped the whole check when `collectRuntime`
  // failed, so `stop` and `uninstall` went through unforced on exactly the
  // machine that could say least about itself. `restart` was rescued by the
  // `supervised` check below; the other two had nothing. A missing report is
  // LESS evidence of safety than an unreadable definition, not more.
  if (NODE_SERVICE_DESTRUCTIVE.includes(cmd.verb) && cmd.force !== true) {
    if (runtime?.service.paneSafety !== "keeps") {
      return { ok: false, error: NODE_RESULT_KILLS_PANES };
    }
  }

  if (cmd.verb === "restart") {
    // Supervision was checked above, before the pane gate. `{ ok: true }`
    // FIRST: the daemon sends the result frame and only then takes the socket
    // down, so the plane learns the restart was accepted rather than inferring
    // it from a disconnect.
    ctx.requestRestart();
    return { ok: true };
  }

  // `async () => true` for the config probe: this executor only runs inside a
  // daemon that loaded its config to connect at all, so the question the CLI
  // has to ask ("is this machine enrolled?") is already answered. `runtime.ts`
  // reads the same state the same way.
  const deps = ctx.serviceDeps ?? DEFAULT_DEPS(async () => true);
  if (cmd.verb === "install") {
    const res = await installService(deps);
    return res.code === 0 ? { ok: true, data: res.out } : { ok: false, error: failure(res.err, res.out) };
  }
  if (cmd.verb === "uninstall") {
    const res = await uninstallService(deps);
    return res.code === 0 ? { ok: true, data: res.out } : { ok: false, error: failure(res.err, res.out) };
  }

  // start | stop — narrowed by exclusion, and re-checked rather than cast: a
  // verb added to the protocol and not to `ServiceVerb` must answer a refusal
  // here, not reach the manager as an unchecked string.
  if (!isServiceVerb(cmd.verb)) return { ok: false, error: `unknown service verb '${cmd.verb as string}'` };
  const res = await controlService(deps, cmd.verb, { force: cmd.force === true });
  if (res.code === 0) return { ok: true, data: res.out };
  // The manager's own words, except for the one refusal the plane maps to a
  // sentence of its own: a machine with no definition cannot start or stop.
  return { ok: false, error: noDefinition(res.err) ? NODE_RESULT_NO_SERVICE : failure(res.err, res.out) };
}

/**
 * Whether the CLI refused because nothing is installed.
 *
 * A substring, because `errLine` prefixes the binary's name — and a marker
 * rather than the whole sentence, because that sentence names the definition
 * path and is the CLI's to reword. What must not move is the plane's ability
 * to tell this refusal from a manager that failed, which is why it is turned
 * into a protocol constant here instead of being matched on the far side.
 */
function noDefinition(err: string): boolean {
  return err.includes("nothing installed:");
}

/** The agent's own words for a failure, trimmed to one line for a result frame. */
function failure(err: string, out: string): string {
  const text = (err.trim() || out.trim() || "the service manager refused").split("\n")[0] ?? "";
  return text.slice(0, 400);
}

/** Re-exported for the dispatch table's type narrowing. */
export type { NodeServiceVerb };
