import { access, rm } from "node:fs/promises";
import { TmuxRunner } from "@internal/pane-runtime";
import type { CliResult } from "./cli.js";
import type { NodeConfig } from "./config.js";
import { configPath } from "./config.js";
import { type DaemonLock, isPidAlive, lockPath, readLock } from "./lock.js";
import { type SubshellMeta, SubshellMetaStore } from "./subshell-meta.js";

/**
 * `subshell unenroll [--yes] [--json]` — stop being a node, from the node side.
 *
 * The registration is one 0600 file: `config.json` holds the node key whose
 * only home is that file, so deleting it IS the deregistration — the fact the
 * service module has always stated in its `uninstall` comment ("deleting the
 * config is the de-facto unenroll") and never offered as a verb. Until now
 * the only deletion path was the Subshell Client's reset chain, which also
 * wipes the data directory, closes every pane and deletes the binary. This is
 * the narrow act beside that broad one: the machine leaves the plane, and its
 * work, its data and its installation stay.
 *
 * Three facts the output must say plainly, because each one surprises someone:
 *
 * - **Live panes survive.** Subshells outliving their node is this product's
 *   design (a restarting agent never kills a running pane), so unenrolling
 *   does not touch them. What changes is that nothing reports them anymore:
 *   the control plane holds its `running` rows until its owner deletes the
 *   node there, and whoever owns those panes keeps terminals the plane can
 *   no longer reach.
 * - **A kept service definition respawns.** `service uninstall` removes only
 *   the definition and never the config, by the same comment's rule; the
 *   mirror is true — a definition left over a deleted config starts a daemon
 *   on the next login with nothing to load. The sentence names the remedy.
 * - **The plane's row stays.** A machine cannot delete itself from a server
 *   it is refusing to talk to; containment is the owner's act in the browser
 *   (docs/security.md: deleting the node is what actually contains one).
 *
 * The refusal protocol is `maintenance on`'s, for its reason: `run()` is pure,
 * there is nothing to prompt, so the shape is "list what is live, refuse,
 * name the flag that means yes" — text even under `--json`, because the exit
 * code is the contract and a caller holding code 1 must not be parsing
 * stdout. What `--yes` accepts here is ORPHANING, not killing: nothing in
 * this verb sends a signal to anything.
 *
 * The seams are `MaintenanceDeps`' shape on purpose, so the tests that pin
 * the deletion order need neither a daemon nor a tmux server on the host.
 */

/** Injectable effects for {@link runUnenroll}. */
export interface UnenrollDeps {
  /** Liveness census only — this verb never kills, so it needs no `killSubshell`. */
  tmux: Pick<TmuxRunner, "hasSubshell">;
  /** The per-subshell launch records; `list()` × `hasSubshell` IS "what is alive here". */
  meta: Pick<SubshellMetaStore, "list">;
  /** The daemon lock read (production: {@link readLock}) — "is a daemon running HERE". */
  readLock(): DaemonLock | null;
  /** PID liveness (production: {@link isPidAlive}). */
  isPidAlive(pid: number): boolean;
  fileExists(path: string): Promise<boolean>;
  removeFile(path: string): Promise<void>;
}

/** The production seams over one enrolled data dir. */
export function defaultUnenrollDeps(dataDir: string): UnenrollDeps {
  return {
    tmux: new TmuxRunner(),
    meta: new SubshellMetaStore(dataDir),
    readLock,
    isPidAlive,
    fileExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    removeFile: (path) => rm(path, { force: true }),
  };
}

/**
 * Run `subshell unenroll` for an already-loaded config.
 *
 * "never enrolled" is the CALLER's refusal (cli.ts: `loadConfig()`'s own
 * sentence points at `enroll`), the same config-first rule `maintenance`
 * runs on — this function is what an enrolled machine does to itself.
 *
 * @param cfg - the loaded {@link NodeConfig} (the deletion subject, and the
 *   source of the ids the success text names)
 * @param opts - `yes` overrides both refusals; `json` switches the view
 * @param deps - the injectable effects
 */
export async function runUnenroll(
  cfg: NodeConfig,
  opts: { yes: boolean; json: boolean },
  deps: UnenrollDeps,
): Promise<CliResult> {
  // A live daemon holds the plane connection and the config in memory; it
  // keeps announcing itself until it exits, so deleting the file under it is
  // an unenroll the running process has not agreed to. The refusal names the
  // act that stops it — the CLI verb, never a signal from here.
  const lock = deps.readLock();
  if (lock !== null && deps.isPidAlive(lock.pid) && !opts.yes) {
    return {
      code: 1,
      out: "",
      err:
        `subshell: refusing: the node's daemon is running (pid ${lock.pid}); ` +
        "stop it first with `subshell service stop`, or pass --yes\n",
    };
  }

  // The census, with `maintenance`'s fail-closed rule: a tmux that will not
  // answer PROPAGATES rather than reading as "nothing running". Reporting an
  // unenroll as complete while panes the probe could not see keep running is
  // the exact half-truth this protocol exists to refuse.
  const alive: SubshellMeta[] = [];
  for (const m of await deps.meta.list()) {
    if (await deps.tmux.hasSubshell(m.socket, m.subshellId)) alive.push(m);
  }
  if (alive.length > 0 && !opts.yes) {
    const lines = alive.map((m) => `  ${m.name} · ${m.subshellId} · ${m.cwd}\n`).join("");
    return {
      code: 1,
      out: "",
      err:
        `subshell: refusing: ${alive.length} running ${alive.length === 1 ? "subshell" : "subshells"} ` +
        "would keep running with this machine no longer a node; pass --yes\n" +
        lines,
    };
  }

  // Lock FIRST, config LAST — the reset chain's resumability property scaled
  // down to two files: an interruption between the two leaves a machine that
  // still has its identity (recoverable by re-enrolling nothing; it is already
  // gone), while a config deleted with a stale lock behind would leave a pid
  // file pointing at a daemon whose home is gone.
  const lockFile = lockPath();
  const configFile = configPath();
  const hadLock = await deps.fileExists(lockFile);
  if (hadLock) await deps.removeFile(lockFile);
  await deps.removeFile(configFile);

  if (opts.json) {
    // `configFile` is "removed" unconditionally because loadConfig read it
    // this run: it cannot be absent here. The lock can, and says so.
    return {
      code: 0,
      out: `${JSON.stringify(
        {
          ok: true,
          nodeId: cfg.nodeId,
          name: cfg.name,
          configFile: "removed",
          lockFile: hadLock ? "removed" : "absent",
          dataDir: cfg.dataDir,
        },
        null,
        2,
      )}\n`,
      err: "",
    };
  }
  return {
    code: 0,
    out:
      `unenrolled node ${cfg.nodeId} "${cfg.name}": ${configFile} removed${hadLock ? ` and ${lockFile} removed` : ""}\n` +
      `the data directory is kept at ${cfg.dataDir}, and the installed binary is untouched.\n` +
      "if the node service is installed, remove it with `subshell service uninstall`: its daemon would\n" +
      "  start on the next login with no config to load.\n" +
      "the control plane keeps listing this node until its owner deletes the row there.\n",
    err: "",
  };
}
