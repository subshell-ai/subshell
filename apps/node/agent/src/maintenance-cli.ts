import { TmuxRunner } from "@internal/pane-runtime";
import type { CliResult } from "./cli.js";
import { maintenancePath, readMaintenance, writeMaintenance } from "./maintenance.js";
import { type SubshellMeta, SubshellMetaStore } from "./subshell-meta.js";

/**
 * `subshell maintenance on|off|status` (spec 2026-09-14 §4.5) — declaring from
 * the machine itself that it takes no new subshells.
 *
 * It writes the same mirror the plane's `set_maintenance` writes, and the
 * running daemon (if there is one) notices within a heartbeat and reports it.
 * That is the whole reason this is a file rather than an IPC call: there may
 * be no daemon at all, and the operator at the keyboard still has to be able
 * to say it.
 *
 * **`on` is destructive and this CLI has no prompts.** `run()` is pure — it
 * returns text and an exit code and writes no stdio — so there is nothing to
 * read an answer from. The shape is `service restart --force`'s: list what
 * would be destroyed, refuse, and name the flag that means yes.
 *
 * The seams exist for the same reason `ServiceDeps` does: pinning what this
 * verb kills, in what order, without a tmux server on the test host.
 */

/** The subtokens this verb accepts. */
export type MaintenanceSub = "on" | "off" | "status";

/** Runtime list of {@link MaintenanceSub} — the CLI's parser table reads it, so the two cannot drift. */
export const MAINTENANCE_SUBS: readonly MaintenanceSub[] = ["on", "off", "status"];

/** Whether a parsed subtoken is one this module handles. */
export function isMaintenanceSub(value: string): value is MaintenanceSub {
  return (MAINTENANCE_SUBS as readonly string[]).includes(value);
}

/** Injectable effects for {@link runMaintenance}; production builds them from the enrolled data dir. */
export interface MaintenanceDeps {
  /** Pane liveness + the kill — the only two tmux calls this verb makes. */
  tmux: Pick<TmuxRunner, "hasSubshell" | "killSubshell">;
  /** The per-subshell launch records; `list()` × `hasSubshell` IS "what is alive here". */
  meta: Pick<SubshellMetaStore, "list">;
  /** Epoch-ms clock — stamps `changedAt`, which is the whole reconciliation protocol. */
  now(): number;
}

/** The production seams over one enrolled data dir. */
export function defaultMaintenanceDeps(dataDir: string): MaintenanceDeps {
  return { tmux: new TmuxRunner(), meta: new SubshellMetaStore(dataDir), now: () => Date.now() };
}

/**
 * How long the plane takes to notice, said the same way every time.
 *
 * Both halves matter to the person reading it: a running daemon reports on its
 * next heartbeat, and a machine with no daemon reports at its next connect —
 * which may be never, and is still the correct thing to have written down.
 */
const LEARNS_LINE =
  "the control plane learns of this within about 15 seconds while the agent runs, or when it next connects\n";

/**
 * Runs one `maintenance` invocation.
 *
 * @param dataDir - the enrolled node's data dir (the mirror's home)
 * @param sub - `on`, `off` or `status`
 * @param opts - `yes` overrides the live-pane refusal; `json` switches the view
 * @param deps - tmux/meta/clock seams
 */
export async function runMaintenance(
  dataDir: string,
  sub: MaintenanceSub,
  opts: { yes: boolean; json: boolean },
  deps: MaintenanceDeps,
): Promise<CliResult> {
  if (sub === "status") return status(dataDir, opts.json);

  if (sub === "off") {
    const state = writeMaintenance(dataDir, { on: false, changedAt: new Date(deps.now()).toISOString() });
    if (opts.json) return { code: 0, out: `${JSON.stringify({ ...state, stopped: [] }, null, 2)}\n`, err: "" };
    return { code: 0, out: `maintenance off\n${LEARNS_LINE}`, err: "" };
  }

  // `on`: the census FIRST, because the refusal depends on it. A tmux that
  // will not answer propagates (exit 1 with its reason) rather than being read
  // as "nothing is running" — entering maintenance on that answer would report
  // stopping nothing while panes kept running.
  const alive: SubshellMeta[] = [];
  for (const m of await deps.meta.list()) {
    if (await deps.tmux.hasSubshell(m.socket, m.subshellId)) alive.push(m);
  }
  if (alive.length > 0 && !opts.yes) {
    // TOTAL refusal: nothing stopped and no flag written. A flag written with
    // the panes still up is the worst of the three outcomes — the machine
    // would launch nothing while still running everything.
    //
    // Text, not JSON, even under `--json`: the exit code is the contract for a
    // refusal, and a caller that got code 1 must not be parsing stdout.
    const lines = alive.map((m) => `  ${m.name} · ${m.subshellId} · ${m.cwd}\n`).join("");
    return {
      code: 1,
      out: "",
      err:
        `subshell: refusing: ${alive.length} running ${alive.length === 1 ? "subshell" : "subshells"} ` +
        `on this node would be stopped; pass --yes\n${lines}`,
    };
  }

  // The flag BEFORE the kills: a pane dying while the mirror still said "off"
  // is a death the plane has no reason for, and it may auto-restart the row
  // onto this machine before the flip reaches it.
  const state = writeMaintenance(dataDir, { on: true, changedAt: new Date(deps.now()).toISOString() });
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const m of alive) {
    try {
      // The META RECORD STAYS. With no daemon running it is the only thing
      // the reconnect census can report — forgetting it here would leave the
      // plane holding a `running` row with nothing left on this machine able
      // to contradict it. Cleaning dead records is a running agent's job.
      deps.tmux.killSubshell(m.socket, m.subshellId);
      stopped.push(m.subshellId);
    } catch (err) {
      // One pane that will not die must not abandon the rest — and must not
      // be reported as stopped either.
      failed.push(`  ${m.subshellId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const err = failed.length > 0 ? `subshell: could not stop ${failed.length}:\n${failed.join("\n")}\n` : "";
  if (opts.json) return { code: 0, out: `${JSON.stringify({ ...state, stopped }, null, 2)}\n`, err };
  return {
    code: 0,
    out: `maintenance on — stopped ${stopped.length} ${stopped.length === 1 ? "subshell" : "subshells"}\n${LEARNS_LINE}`,
    err,
  };
}

/**
 * The read-only view. Always exits 0 (the `service status` rule): it reports
 * a state, and "the file is unreadable" is one of the states rather than a
 * failure of the command.
 */
function status(dataDir: string, json: boolean): CliResult {
  const read = readMaintenance(dataDir);
  if (json) {
    // `file` is what separates the two shapes that both read as off/on but
    // travel differently: absent has no stamp to reconcile, unreadable has no
    // stamp AND refuses launches.
    const body =
      read.kind === "state"
        ? { on: read.state.on, changedAt: read.state.changedAt, file: "present" }
        : read.kind === "absent"
          ? { on: false, changedAt: null, file: "absent" }
          : { on: true, changedAt: null, file: "unreadable" };
    return { code: 0, out: `${JSON.stringify(body, null, 2)}\n`, err: "" };
  }
  if (read.kind === "absent") return { code: 0, out: "maintenance: off (no maintenance file)\n", err: "" };
  if (read.kind === "unreadable") {
    return {
      code: 0,
      out: `maintenance: on (${maintenancePath(dataDir)} is unreadable — treated as on)\n`,
      err: "",
    };
  }
  return {
    code: 0,
    out: `maintenance: ${read.state.on ? "on" : "off"} (since ${read.state.changedAt})\n`,
    err: "",
  };
}
