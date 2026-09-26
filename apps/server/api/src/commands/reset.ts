import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { syncPortListening } from "@/commands/status.js";
import { resolveConfig } from "@/config-env.js";
import { SERVER_PORT } from "@/constants.js";
import { controlService, queryService, type ServiceDeps, uninstallService } from "@/service.js";
import { resolveInstalledBinary } from "@/services/installed-binary.js";
import { deleteGuardOk, pathRulesOk } from "@/services/reset-guards.js";
import { serverPaths } from "@/services/server-paths.js";

/**
 * `subshell-server reset` and `subshell-server uninstall` — the CLI doors the
 * assistant's reset chain always had a twin of (issue #232).
 *
 * Both are DESTRUCTIVE and neither is reachable over any route (the standing
 * rule: stop/start/install/uninstall/reset have no HTTP surface because each
 * would leave the server unreachable mid-call). Consent is the machine's NAME,
 * typed — `--yes` cannot buy it, exactly as `subshell unenroll` refuses to let
 * `--yes` waive a live daemon. The scripted spelling is `--confirm <name>`:
 * the same fact, just not typed at a keyboard, so a headless run still has to
 * name the machine it is wiping.
 *
 * The two verbs share one chain:
 *
 * - **reset** stops the service, waits for its port to go quiet, closes the
 *   pane tmux servers, removes the service definition, and deletes
 *   exactly the paths `status` publishes (config.env last). The installed
 *   binary stays, so the next `init` is a first run with the tool still in
 *   hand. This is the assistant's chain mirrored with its guards: the plan's
 *   shape rules and the binary-containment rule come from the desktop's
 *   pinned twin (`services/reset-guards.ts`), and a port that still answers
 *   after the stop (a daemon started by hand, which no unit can reach) ends
 *   the chain before any byte is deleted — the Rust chain's
 *   `wait_for_port_closed` fact, not the manager's claim.
 * - **uninstall** is that chain PLUS the binary the ladder named (resolved
 *   BEFORE the definition goes, since the definition is where the ladder looks
 *   first) and its `.previous` sibling. It answers "remove this program from
 *   this machine" with one command.
 *
 * What neither reaches stays what the security rules say: enrolled REMOTE
 * nodes and a same-machine `subshell` agent have their own homes; the plane's
 * own data and binary are all this deletes.
 */

/** The all-or-nothing delete plan: the five data paths plus the config file. */
export interface ResetPlan {
  /** config.env's absolute path; DELETED LAST, and kept when walking `dataDir`. */
  configEnv: string;
  dataDir: string;
  database: string;
  logsDir: string;
  nodeArtifacts: string;
  /** The installed binary an uninstall may remove; `null` when nothing names one. */
  binary: string | null;
  /**
   * The port `status` would report listening on. Carried in the plan because
   * the chain refuses while it answers: a stopped SERVICE goes dark, but a
   * hand-started daemon has no unit to stop and no manager to ask, and the
   * port answering IS that fact (the desktop's chain waits on exactly this).
   */
  listenPort: number;
}

/** Injected seams; every default is the real thing, and the tests replace them. */
export interface ResetDeps {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Whether stdin is a TTY — consent needs a terminal unless `--confirm` names the machine. */
  isTTY: boolean;
  /** This machine's name, the consent target (default: `os.hostname()`). */
  machineName?: () => string;
  /** Ask for text (default: the clack prompt wired by `cli.ts`); `null` = cancelled. */
  ask?: (question: string) => Promise<string | null>;
  /** The delete plan (default: the `status`-authority assembly). */
  plan?: () => ResetPlan;
  /** The manager seams (default: `service.ts` over the real platform). */
  manager?: {
    installed: () => boolean;
    stop: () => { code: number; err: string };
    uninstall: () => { code: number; err: string };
  };
  /** Close the pane tmux servers; a failure ends the chain (default: the real sweep). */
  sweepPanes?: () => { ok: boolean; detail?: string };
  /** The service deps the default manager seams run against (tests point them at a temp home). */
  service?: ServiceDeps;
  /**
   * Synchronous port-liveness probe, asked after the stop and before the
   * pane sweep and any delete (default: the `status` kernel-table reader;
   * host-insensitive). `null` means the platform offered no answer, which
   * does NOT block the chain — a hint is not an oracle.
   */
  probePort?: (host: string, port: number) => boolean | null;
  /** How long to wait for the port to go quiet after the stop (default: 10 s, the desktop's bound). */
  portWaitMs?: number;
  /** Sleep seam for the port wait (default: `Bun.sleep`); the tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/** The plan the delete runs against: `status`'s five paths plus config.env. */
export function buildResetPlan(): ResetPlan {
  const paths = serverPaths();
  const cfg = resolveConfig();
  const installed = resolveInstalledBinary({
    platform: process.platform,
    home: homedir(),
    configDir: dirname(cfg.path),
  });
  const port = Number.parseInt(cfg.get("SERVER_PORT") ?? String(SERVER_PORT), 10);
  return {
    configEnv: cfg.path,
    dataDir: paths.dataDir,
    database: paths.database,
    logsDir: paths.logsDir,
    nodeArtifacts: paths.nodeArtifacts,
    binary: installed.kind === "compiled" ? installed.path : null,
    // A malformed SERVER_PORT is nobody's listener: 0 keeps the chain's
    // probe honest (`status` shows the same value as invalid, portValid false).
    listenPort: Number.isInteger(port) && port > 0 && port < 65_536 ? port : 0,
  };
}

/**
 * The tmux sweep, mirroring the assistant's: every pane lives on a
 * `subshell-*` socket under tmux's own `(TMUX_TMPDIR ?? /tmp)/tmux-<uid>`
 * directory (NOT TMPDIR — macOS puts that somewhere with no sockets, the
 * measured reason carried in the desktop's `close_subshell_tmux`). A kill
 * answered by "error connecting" is an already-dead server: the stale socket
 * goes and the chain continues. Any other failure ENDS the chain — a surviving
 * pane makes the wipe a lie, which is the same R1 rule the desktop follows.
 * The `spawn` seam exists for the throw path: tmux missing from a machine
 * whose sockets dir is not is a SURVIVING-PANE suspicion, never a silent skip.
 */
export function sweepPaneSockets(
  log: (line: string) => void = () => {},
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): { ok: boolean; detail?: string } {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return { ok: false, detail: "could not read the uid to locate tmux sockets" };
  }
  const baseRaw = process.env.TMUX_TMPDIR || "/tmp";
  let base: string;
  try {
    base = realpathSync(baseRaw);
  } catch {
    base = baseRaw;
  }
  const dir = join(base, `tmux-${uid}`);
  let names: string[];
  try {
    names = readdirSync(dir)
      .map((n) => n.toString())
      .filter((n) => n.startsWith("subshell-"));
  } catch {
    // No directory means tmux has served no socket HERE. The directory is
    // named in the log so a wrong-TMUX_TMPDIR skip and a true-empty one are
    // distinguishable afterward — the desktop's measured reason (a silent
    // zero-kill would let a reset succeed with every pane still running).
    log(`no pane servers to close in ${dir}`);
    return { ok: true };
  }
  for (const name of names) {
    let res: ReturnType<typeof Bun.spawnSync>;
    try {
      res = spawn({
        cmd: ["tmux", "-L", name, "kill-server"],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
    } catch (failure) {
      // tmux not on PATH: the sockets on disk mean panes ran HERE, so a
      // missing binary is "a pane may have survived", never a silent skip.
      return {
        ok: false,
        detail: `tmux is not runnable to close ${name}: ${failure instanceof Error ? failure.message : String(failure)}`,
      };
    }
    const stderr = res.stderr?.toString() ?? "";
    if (res.exitCode !== 0 && !stderr.includes("error connecting")) {
      return { ok: false, detail: `tmux -L ${name} kill-server failed: ${stderr.trim() || `exit ${res.exitCode}`}` };
    }
    if (res.exitCode !== 0) {
      // "error connecting" against a socket on disk: stale, and the file is the litter.
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* it may already be gone; that is the outcome we wanted */
      }
    }
  }
  return { ok: true };
}

/** `realpathSync` or null: the spelling a live filesystem agrees on, if any. */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Delete `dir` recursively, EXCEPT the file at `keep`, whose ENTIRE parent
 * chain survives the walk. `keep` is matched by resolved spelling and by
 * segments, not by string equality on one level: a config home nested deeper
 * than one level inside the data dir (`<dataDir>/config/config.env`, the
 * shape a redirected `SUBSHELL_SERVER_CONFIG_DIR` makes) must not have its
 * parent subtree `rm -rf`'d mid-walk — config.env is the chain's LAST act,
 * and a mid-chain failure has to leave the machine still self-describing.
 */
function removeTreeBut(dir: string, keep: string): void {
  if (!existsSync(dir)) return;
  const root = tryRealpath(dir) ?? resolve(dir);
  const keepAbs = tryRealpath(keep) ?? resolve(keep);
  const rel = relative(root, keepAbs);
  const keepSegments = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep) : null;
  const walk = (current: string, depth: number): void => {
    for (const entry of readdirSync(current)) {
      const name = entry.toString();
      if (keepSegments !== null && depth < keepSegments.length && name === keepSegments[depth]) {
        // On the kept file's path: recurse through ancestors, skip the file
        // itself — its deletion is the caller's last consented act.
        if (depth + 1 < keepSegments.length) walk(join(current, name), depth + 1);
        continue;
      }
      rmSync(join(current, name), { recursive: true, force: true });
    }
    // An ancestor of the kept file never prunes here: it still holds the
    // keep chain, and the caller's remove-if-empty tidy takes it afterwards.
    if (keepSegments !== null && depth < keepSegments.length) return;
    if (readdirSync(current).length > 0) return;
    rmdirSync(current); // by name: `rm` without `recursive` refuses directories (EISDIR)
  };
  walk(root, 0);
}

/** Remove a directory only while it is empty — the post-delete tidy. Never throws. */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir); // ENOTEMPTY here is the "only while empty" rule, enforced by the OS.
  } catch {
    /* not empty (or not ours); no consent covered this */
  }
}

/**
 * Prune every EMPTY ancestor of the kept file's home that lies inside the
 * walked data home, innermost outward, stopping at the first dir that still
 * holds something. The tree walk never prunes the keep chain's ancestors
 * (until the last act they hold it); a single `removeIfEmpty` of the config
 * home's own directory could not reach the ones above it when the config
 * home was nested deeper than one level.
 */
function pruneEmptyChainInside(startDir: string, boundary: string): void {
  const stop = tryRealpath(boundary) ?? resolve(boundary);
  let current = tryRealpath(startDir) ?? resolve(startDir);
  for (;;) {
    const rel = relative(stop, current);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    try {
      rmdirSync(current);
    } catch {
      return; // not empty, gone, or not ours: the tidy stops where the consent does
    }
    current = dirname(current);
  }
}

/**
 * Run the verb. `opts.uninstall` adds the binary; `opts.confirm` is the
 * scripted spelling of the typed machine name. Returns the process exit code.
 */
export async function runReset(opts: { uninstall: boolean; confirm?: string }, deps: ResetDeps): Promise<number> {
  const verb = opts.uninstall ? "uninstall" : "reset";
  const machine = (deps.machineName ?? hostname)().trim();

  // 0. The plan and its shape guards, BEFORE consent: the desktop refuses at
  // ARM time, so nobody types a machine's name at a plan that was unsafe to
  // build. A mistyped `SUBSHELL_SERVER_DATA_DIR` must not become an `rm -rf`
  // behind a nice message, and a `reset` that would swallow the binary it
  // promises to keep is refused the way the Rust `delete_guard_ok` refuses it.
  const plan = (deps.plan ?? buildResetPlan)();
  for (const path of [plan.configEnv, plan.database, plan.logsDir, plan.nodeArtifacts, plan.dataDir]) {
    if (!pathRulesOk(path)) {
      deps.error(`subshell-server ${verb}: the delete plan names an unsafe path (${path}); refusing to run`);
      return 1;
    }
  }
  if (!opts.uninstall && plan.binary !== null) {
    // The Rust twin's caller rule: `delete_guard_ok` demands canonicalized
    // arguments, because the walk deletes through the RESOLVED directory and
    // a lexical `relative` misses a symlinked data home (`/home/u/.local` →
    // `/mnt/x`: the raw spellings say disjoint, the inodes are one). Present
    // but unresolvable is a refusal, exactly as Rust's N3 half; ABSENT keeps
    // its raw spelling, because the guard must still refuse containment of
    // the location the path names once it exists.
    const canonical = (path: string): string | null => {
      if (!existsSync(path)) return path;
      return tryRealpath(path);
    };
    const binaryReal = canonical(plan.binary);
    const dirs = [plan.dataDir, plan.logsDir, plan.nodeArtifacts];
    if (binaryReal === null) {
      deps.error(
        `subshell-server ${verb}: the installed binary (${plan.binary}) exists but cannot be resolved; refusing to run`,
      );
      return 1;
    }
    for (const dir of dirs) {
      const dirReal = canonical(dir);
      if (dirReal === null) {
        deps.error(`subshell-server ${verb}: the plan's ${dir} exists but cannot be resolved; refusing to run`);
        return 1;
      }
      if (!deleteGuardOk(dirReal, binaryReal)) {
        deps.error(
          `subshell-server ${verb}: the plan's ${dir} contains the installed binary (${plan.binary}) a reset promises to keep; refusing to run`,
        );
        return 1;
      }
    }
  }

  // 1. Consent, BEFORE anything touches a manager or a file: a wrong hostname
  // must be as cheap as it is on the assistant. `--yes` was already refused
  // at dispatch; what remains is typed or named, not assumed.
  let typed: string;
  if (opts.confirm !== undefined) {
    typed = opts.confirm.trim();
  } else if (!deps.isTTY) {
    deps.error(
      `subshell-server ${verb}: not interactive: the machine's name must be typed, or passed as --confirm <machine-name>; nothing was changed`,
    );
    return 1;
  } else {
    const answer = await (deps.ask ?? (() => Promise.resolve(null)))(
      `This ${verb === "reset" ? "deletes this server's data and settings" : "removes Subshell Server from this machine entirely"}. Type ${machine || "(unknown host)"} to confirm:`,
    );
    if (answer === null) {
      deps.error(`subshell-server ${verb}: cancelled; nothing was changed`);
      return 1;
    }
    typed = answer.trim();
  }
  if (!machine || typed !== machine) {
    deps.error(`subshell-server ${verb}: the machine name did not match; nothing was changed`);
    return 1;
  }

  const manager =
    deps.manager ??
    (() => {
      const service = deps.service;
      if (service === undefined) {
        // The real seams need real ServiceDeps; cli.ts passes them, and a
        // caller that got here without them is an impossible state, so this
        // throws rather than deleting files with the service still running.
        throw new Error("runReset: no manager seams and no service deps");
      }
      return {
        installed: () => queryService(service).installed,
        stop: () => {
          const r = controlService(service, "stop");
          return { code: r.code, err: r.err };
        },
        uninstall: () => {
          const r = uninstallService(service);
          return { code: r.code, err: r.err };
        },
      };
    })();

  // 2. Stop the running service. "Nothing installed" is the tolerated absence
  // (the desktop walks past the CLI's measured refusal for it); any other
  // stop failure ENDS the chain — deleting the data of a still-booting server
  // is the half-run the desktop's chain also refuses.
  let wasInstalled = false;
  if (manager.installed()) {
    wasInstalled = true;
    const stop = manager.stop();
    if (stop.code !== 0 && !stop.err.includes("nothing installed")) {
      deps.error(`subshell-server ${verb}: the service did not stop; nothing was deleted\n${stop.err}`);
      return 1;
    }
    deps.log("stopped the service");
  } else {
    deps.log("no service definition; nothing to stop");
  }

  // 2.5 The port must go quiet before ANYTHING ELSE GOES: not just the first
  // byte, but before the pane sweep and the definition removal too (the
  // Rust chain's order: stop, `wait_for_port_closed`, then panes, then the
  // unit). The manager's stop is a claim, not a fact, and a daemon started
  // BY HAND has no unit this verb can reach: sweeping or unlinking around a
  // live server would kill its panes and remove its definition under a
  // message that promises "nothing was deleted", and the survivor would
  // still write WAL sidecars under a chain that reported success. Bound and
  // shape from the desktop's `wait_for_port_closed`; a platform that answers
  // `null` is a missing hint, not a refusal.
  const probePort = deps.probePort ?? ((host: string, port: number) => syncPortListening(host, port));
  if (plan.listenPort > 0) {
    const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    const deadline = Date.now() + (deps.portWaitMs ?? 10_000);
    for (;;) {
      if (probePort("127.0.0.1", plan.listenPort) !== true) break;
      if (Date.now() >= deadline) {
        deps.error(
          `subshell-server ${verb}: port ${plan.listenPort} is still answering: a server is running that this verb cannot stop (started by hand?); stop it and run again; nothing was deleted`,
        );
        return 1;
      }
      await sleep(250);
    }
  }

  // 3. Close the pane servers the stopped service owned.
  const sweep = (deps.sweepPanes ?? (() => sweepPaneSockets(deps.log)))();
  if (!sweep.ok) {
    deps.error(`subshell-server ${verb}: a pane server survived; nothing was deleted\n${sweep.detail ?? ""}`);
    return 1;
  }

  // 4. Remove the service definition, so nothing can start the server again.
  if (wasInstalled) {
    const gone = manager.uninstall();
    if (gone.code !== 0 && !gone.err.includes("nothing installed")) {
      deps.error(
        `subshell-server ${verb}: the service definition could not be removed; nothing was deleted\n${gone.err}`,
      );
      return 1;
    }
    deps.log("removed the service definition");
  }

  // 5. Delete, in the assistant's order, absence = done, config.env LAST.
  // Every failure ends the chain with what survived named: the machine name
  // was typed against the promise that THESE bytes are gone.
  try {
    rmSync(plan.database, { force: true });
    rmSync(plan.logsDir, { recursive: true, force: true });
    rmSync(plan.nodeArtifacts, { recursive: true, force: true });
    removeTreeBut(plan.dataDir, plan.configEnv);
    rmSync(plan.configEnv, { force: true });
  } catch (failure) {
    deps.error(
      `subshell-server ${verb}: a delete failed and the chain stopped; some files may remain: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return 1;
  }
  // Remove-if-empty tidies, after the last consented byte is gone: the keep
  // chain's now-empty ancestors inside the data home, the config home itself
  // (its own directory when it lives OUTSIDE dataDir), and the data home.
  // The default layout nests server logs and backups under dataDir, so those
  // went with it.
  pruneEmptyChainInside(dirname(plan.configEnv), plan.dataDir);
  removeIfEmpty(dirname(plan.configEnv));
  removeIfEmpty(plan.dataDir);
  deps.log("deleted the data directory, the database, the logs, the artifacts, and config.env");

  // 6. The uninstall half only: the binary the LADDER named (resolved at step
  // 1's plan, before the definition went) and the `.previous` an update left.
  // A null binary is the dev/source case: this command never deletes a
  // checkout it was not installed from.
  if (opts.uninstall) {
    if (plan.binary !== null) {
      // Decided BEFORE the unlink: the sentence about the `.previous` cannot
      // read the file's existence after its own deletion.
      const hadPrevious = existsSync(`${plan.binary}.previous`);
      if (!existsSync(plan.binary)) {
        // Legitimate only when the binary lives INSIDE the consented data
        // home: the tree walk already took it, and the containment guard
        // stands down for uninstall precisely because of this shape.
        deps.log("the installed binary went with the data directory");
      } else
        try {
          unlinkSync(plan.binary);
          if (hadPrevious) unlinkSync(`${plan.binary}.previous`);
          deps.log(`removed ${plan.binary}${hadPrevious ? " and its .previous" : ""}`);
        } catch (failure) {
          deps.error(
            `subshell-server ${verb}: the installed binary could not be removed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
          return 1;
        }
    } else {
      deps.log("no installed binary: this instance runs from a checkout, which is left alone");
    }
    deps.log(
      "Subshell Server is uninstalled. Enrolled nodes were not reached; they will stop connecting to a plane that is gone.",
    );
  } else {
    deps.log(
      "Subshell Server was reset to a fresh machine. The installed binary is still here for `subshell-server init`.",
    );
  }
  return 0;
}
