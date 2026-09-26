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
 *   hand. This is the assistant's chain with its guards: the plan's shape
 *   rules and the binary-containment rule come from the desktop's pinned
 *   twin (`services/reset-guards.ts`), and the port is checked with the
 *   Rust chain's `wait_for_port_closed` fact, not the manager's claim.
 *   ONE deliberate divergence (operator ruling 2026-09-26, after the strict
 *   shape killed a live plane's panes and then refused to delete anything):
 *   once consent is given the chain CLEARS and never refuses mid-run. A
 *   service that will not stop, a port that keeps answering, a pane server
 *   that survives, or a file that resists deletion are each reported and
 *   remembered for the exit code, and the rest still goes. "A reset means to
 *   clear out everything."
 * - **uninstall** stops the service, sweeps, removes the definition, and
 *   removes the binary the ladder named (resolved BEFORE the definition
 *   goes, since the definition is where the ladder looks first) plus its
 *   `.previous` sibling. The DATA is a separate decision (operator ruling
 *   2026-09-26): uninstall ASKS whether the reset's deletions should run
 *   too, default NO, and the question says what a reset does. A headless
 *   run keeps the bytes unless `--reset-data` says otherwise.
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
   * the chain ASKS it after the stop: a stopped SERVICE goes dark, but a
   * hand-started daemon has no unit to stop and no manager to ask, and the
   * port answering IS that fact. The answer is reported and remembered for
   * the exit code; it does not spare the files.
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
  /** Ask yes/no (the uninstall data question); `null` = cancelled. */
  askConfirm?: (question: string) => Promise<boolean | null>;
  /** The delete plan (default: the `status`-authority assembly). */
  plan?: () => ResetPlan;
  /** The manager seams (default: `service.ts` over the real platform). */
  manager?: {
    installed: () => boolean;
    stop: () => { code: number; err: string };
    uninstall: () => { code: number; err: string };
  };
  /** Close the pane tmux servers; anything it cannot settle is reported and the clear continues (default: the real sweep). */
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
    // Every path is resolved the way the live instance opens it: the config
    // layer passes values through as typed (`DATABASE_PATH` is handed to
    // SQLite relative-to-CWD by design), and a relative path is ambiguous to
    // a delete plan — the guards must see, and the deletes must perform, what
    // the filesystem would actually dereference from this CWD. An operator
    // who set a relative path in a different CWD has a plan pointing
    // elsewhere; that is what the printed plan is for.
    configEnv: resolve(cfg.path),
    dataDir: resolve(paths.dataDir),
    database: resolve(paths.database),
    logsDir: resolve(paths.logsDir),
    nodeArtifacts: resolve(paths.nodeArtifacts),
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
 * answered by a DEAD-SERVER spelling is litter, not a pane: the stale socket
 * goes and the sweep continues. tmux has three spellings for that and the
 * reference chain (the Server app's `close_subshell_tmux`, reset.rs) measures
 * all three against tmux 3.7c:
 *
 *   error connecting to <path> (No such file or directory)      — no socket file
 *   error connecting to <path> (Socket operation on non-socket) — not a socket
 *   no server running on <path>                                — a real socket, dead server
 *
 * The third is what a crashed or killed tmux leaves behind, which is the
 * common case on any box that has run this product's tests; reading it as a
 * failure stopped a real operator's reset on its first such file. Anything
 * else that failed is a pane that survived: it is COLLECTED, named, and the
 * sweep continues to the next socket — the CLI chain deletes everything and
 * reports the survivors (operator ruling 2026-09-26: "a reset means to clear
 * out everything"), and the exit code carries the failure. Every kill is
 * attempted; one never abandons the rest. The `spawn` seam exists for the
 * throw path: tmux missing from a machine whose sockets dir is not is a
 * SURVIVING-PANE suspicion, never a silent skip.
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
  const survivors: string[] = [];
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
      survivors.push(
        `tmux is not runnable to close ${name}: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      continue;
    }
    if (res.exitCode === 0) continue;
    // The Rust reference reads BOTH streams for the dead-server verdict.
    const combined = `${res.stdout?.toString() ?? ""}${res.stderr?.toString() ?? ""}`;
    if (combined.includes("error connecting") || combined.includes("no server running on")) {
      // A dead server's socket file is the litter; the file is what remains.
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* it may already be gone; that is the outcome we wanted */
      }
      continue;
    }
    survivors.push(`tmux -L ${name} kill-server failed: ${combined.trim() || `exit ${res.exitCode}`}`);
  }
  return survivors.length === 0 ? { ok: true } : { ok: false, detail: survivors.join("\n") };
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
 * parent subtree `rm -rf`'d mid-walk. config.env's own deletion is the
 * chain's LAST act — the walk may never take the file that act is named for,
 * whatever else on the way succeeded or failed.
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
 * Run the verb. `opts.uninstall` removes the service and the installed
 * binary; `opts.confirm` is the scripted spelling of the typed machine name;
 * `opts.resetData` is the scripted yes for the data question (see below).
 * Returns the process exit code.
 */
export async function runReset(
  opts: { uninstall: boolean; confirm?: string; resetData?: boolean },
  deps: ResetDeps,
): Promise<number> {
  const verb = opts.uninstall ? "uninstall" : "reset";
  const machine = (deps.machineName ?? hostname)().trim();

  const plan = (deps.plan ?? buildResetPlan)();

  // 0a. The data question, UNINSTALL ONLY: removing the program and wiping
  // the machine are two decisions, and uninstall used to assume the second
  // (operator ruling 2026-09-26: uninstall must ASK whether to reset,
  // default no, describing what reset does). `reset` needs no question:
  // clearing the data IS reset. The scripted spelling of the answer is
  // `--reset-data`; a headless run with neither keeps the bytes. The answer
  // is taken BEFORE the plan guards, which exist only to protect bytes a
  // wipe deletes — an uninstall that keeps the data is not blocked by a
  // strange `SUBSHELL_SERVER_DATA_DIR` it will never touch.
  let wipeData = true;
  if (opts.uninstall) {
    if (opts.resetData !== undefined) {
      wipeData = opts.resetData;
    } else if (!deps.isTTY) {
      wipeData = false;
      deps.log("not interactive: the data and settings stay; pass --reset-data to delete them");
    } else {
      const answer = await (deps.askConfirm ?? (() => Promise.resolve(false)))(
        "Delete this server's data and settings too: the database, pane logs, node artifacts, the data directory, and config.env, the way `reset` does? A reset leaves no copy behind: backups inside the data directory go with it. [y/N]",
      );
      if (answer === null) {
        deps.error(`subshell-server ${verb}: cancelled; nothing was changed`);
        return 1;
      }
      wipeData = answer;
    }
  }

  // 0b. The plan's shape guards, BEFORE consent: the desktop refuses at
  // ARM time, so nobody types a machine's name at a plan that was unsafe to
  // build. A mistyped `SUBSHELL_SERVER_DATA_DIR` must not become an `rm -rf`
  // behind a nice message, and a `reset` that would swallow the binary it
  // promises to keep is refused the way the Rust `delete_guard_ok` refuses it.
  if (wipeData) {
    // Each target by its RESOLVED spelling when it exists: the data walk
    // deletes through the realpath (removeTreeBut resolves before it
    // recurses), so a symlinked target whose SPELLING passes the rules while
    // its TARGET is the home dir would delete through the guard's back door.
    // Present-but-unresolvable is a refusal, the containment guard's own N3
    // rule; absent is guarded by its spelling, the only truth there is.
    for (const [what, raw] of [
      ["config.env", plan.configEnv],
      ["database", plan.database],
      ["logs dir", plan.logsDir],
      ["node artifacts", plan.nodeArtifacts],
      ["data directory", plan.dataDir],
    ] as const) {
      const real = existsSync(raw) ? tryRealpath(raw) : raw;
      if (real === null) {
        deps.error(
          `subshell-server ${verb}: the plan's ${what} (${raw}) exists but cannot be resolved; refusing to run`,
        );
        return 1;
      }
      if (!pathRulesOk(real)) {
        const named = real === raw ? raw : `${raw} -> ${real}`;
        deps.error(`subshell-server ${verb}: the delete plan names an unsafe path (${named}); refusing to run`);
        return 1;
      }
    }
  }
  if (wipeData && !opts.uninstall && plan.binary !== null) {
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
    const scope =
      verb === "reset"
        ? "deletes this server's data and settings"
        : wipeData
          ? "removes the service and the installed binary, AND deletes this server's data and settings"
          : "removes the service and the installed binary; the data and settings stay";
    // The plan is named INSIDE the prompt: an operator on a custom data dir
    // consents to paths they have actually seen.
    const planLines = wipeData
      ? `Will delete: ${plan.dataDir} (and everything under it), ${plan.database}, ${plan.logsDir}, ${plan.nodeArtifacts}, ${plan.configEnv}.\n`
      : "";
    const answer = await (deps.ask ?? (() => Promise.resolve(null)))(
      `${planLines}This ${scope}. Type ${machine || "(unknown host)"} to confirm:`,
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

  // From here the chain is CLEAR-EVERYTHING (operator ruling 2026-09-26,
  // measured on a real box the first shape failed): consent was given, so a
  // step that cannot run never spares the bytes — a service that will not
  // stop, a pane server that survives, a definition that resists removal, a
  // binary that cannot be unlinked, and a missing file alike are reported,
  // remembered for the exit code, and the chain continues. The refusal to
  // delete anything after ALREADY killing pane servers was the half-run the
  // strict shape produced: disturbed machine, intact data, "nothing was
  // deleted". Only the shape guards and consent (steps 0-1) still refuse
  // outright, because they run before any byte or process is touched.
  const failures: string[] = [];

  // 2. Stop the running service. "Nothing installed" is the tolerated absence
  // (the desktop walks past the CLI's measured refusal for it); any other
  // stop failure is reported and the chain continues.
  let wasInstalled = false;
  if (manager.installed()) {
    wasInstalled = true;
    const stop = manager.stop();
    if (stop.code !== 0) {
      deps.error(`subshell-server ${verb}: the service did not stop; continuing to clear anyway\n${stop.err}`);
      failures.push("the service did not stop");
    } else {
      deps.log("stopped the service");
    }
  } else {
    deps.log("no service definition; nothing to stop");
  }

  // 2.5 The port is the FACT about the manager's claim: the stop says the
  // service went, and the port answers whether it did, before the sweep reads
  // "no panes" off a server that is merely still booting. A daemon started
  // BY HAND has no unit this verb can reach; after the wait it is reported
  // (it will lose its files anyway, and the line names it), not obeyed. The
  // wait's bound and shape are the desktop's `wait_for_port_closed`; a
  // platform that answers `null` is a missing hint, not a fact.
  const probePort = deps.probePort ?? ((host: string, port: number) => syncPortListening(host, port));
  if (plan.listenPort > 0) {
    const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    const deadline = Date.now() + (deps.portWaitMs ?? 10_000);
    for (;;) {
      if (probePort("127.0.0.1", plan.listenPort) !== true) break;
      if (Date.now() >= deadline) {
        deps.error(
          `subshell-server ${verb}: port ${plan.listenPort} is still answering: a server is running that this verb cannot stop (started by hand?); it keeps running, but its files go`,
        );
        failures.push(`port ${plan.listenPort} was still answering`);
        break;
      }
      await sleep(250);
    }
  }

  // 3. Close the pane servers. Whatever the sweep could not settle — live
  // survivors, or a sweep that could not even enumerate them (no uid to name
  // the socket directory) — is reported by the sweep's own words, remembered,
  // and the rest of the clear goes on without them.
  const sweep = (deps.sweepPanes ?? (() => sweepPaneSockets(deps.log)))();
  if (!sweep.ok) {
    deps.error(
      `subshell-server ${verb}: the pane sweep reported problems, below; the rest is cleared anyway\n${sweep.detail ?? ""}`,
    );
    failures.push("the pane sweep reported problems");
  }

  // 4. Remove the service definition, so nothing can start the server again.
  if (wasInstalled) {
    const gone = manager.uninstall();
    if (gone.code !== 0) {
      deps.error(
        `subshell-server ${verb}: the service definition could not be removed; the rest is cleared anyway\n${gone.err}`,
      );
      failures.push("the service definition could not be removed");
    } else {
      deps.log("removed the service definition");
    }
  }

  // 5. Delete, in the assistant's order, absence = done, config.env LAST.
  // One failed unlink names itself and the next byte is still attempted: the
  // machine name was typed against the promise that this clears everything.
  const attempt = (what: string, run: () => void): void => {
    try {
      run();
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      deps.error(`subshell-server ${verb}: could not delete ${what}: ${detail}`);
      failures.push(`could not delete ${what}`);
    }
  };
  if (wipeData) {
    attempt(plan.database, () => rmSync(plan.database, { force: true }));
    attempt(plan.logsDir, () => rmSync(plan.logsDir, { recursive: true, force: true }));
    attempt(plan.nodeArtifacts, () => rmSync(plan.nodeArtifacts, { recursive: true, force: true }));
    attempt(plan.dataDir, () => removeTreeBut(plan.dataDir, plan.configEnv));
    attempt(plan.configEnv, () => rmSync(plan.configEnv, { force: true }));
    // Remove-if-empty tidies, after the last consented byte's turn: the keep
    // chain's now-empty ancestors inside the data home, the config home
    // itself (its own directory when it lives OUTSIDE dataDir), and the data
    // home. The default layout nests server logs and backups under dataDir,
    // so those went with it.
    pruneEmptyChainInside(dirname(plan.configEnv), plan.dataDir);
    removeIfEmpty(dirname(plan.configEnv));
    removeIfEmpty(plan.dataDir);
    // The sentence may only claim what actually went: a failed delete is
    // already named by `attempt`, and this line must not contradict it.
    const survivor = failures.find((f) => f.endsWith("was still answering"));
    if (survivor !== undefined) {
      // The still-running server reopens its WAL and rewrites under the
      // deletes: the bytes went, but "gone" would not stay true.
      deps.log("deleted what the running server allows: a server that keeps answering can write some of it back");
    } else if (!failures.some((f) => f.startsWith("could not delete"))) {
      deps.log("deleted the data directory, the database, the logs, the artifacts, and config.env");
    }
  } else {
    deps.log("left the data, settings, and config.env in place; `subshell-server reset` deletes them");
  }

  // 6. The uninstall half only: the binary the LADDER named (resolved at step
  // 1's plan, before the definition went) and the `.previous` an update left.
  // A null binary is the dev/source case: this command never deletes a
  // checkout it was not installed from, and a binary that resists unlinking
  // is reported, not obeyed.
  if (opts.uninstall) {
    if (plan.binary !== null) {
      // Decided BEFORE the unlink: the sentence about the `.previous` cannot
      // read the file's existence after its own deletion.
      const hadPrevious = existsSync(`${plan.binary}.previous`);
      if (!existsSync(plan.binary)) {
        // With the wipe chosen, the honest reading is that the tree walk
        // already took a binary living INSIDE the consented data home (the
        // containment guard stands down for uninstall precisely because of
        // that shape). With the data kept, nothing walked: the ladder simply
        // named a path that is not there.
        deps.log(
          wipeData
            ? "the installed binary went with the data directory"
            : "the installed binary was not on the ladder's path",
        );
      } else {
        // Two separate unlinks, two separate reports: a `.previous` that
        // resists after the binary went must not blame the binary.
        try {
          rmSync(plan.binary, { force: true }); // absence = done, as in step 5
          deps.log(`removed ${plan.binary}`);
        } catch (failure) {
          deps.error(
            `subshell-server ${verb}: the installed binary could not be removed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
          failures.push("the installed binary could not be removed");
        }
        if (hadPrevious) {
          try {
            rmSync(`${plan.binary}.previous`, { force: true });
            deps.log(`removed ${plan.binary}.previous`);
          } catch (failure) {
            deps.error(
              `subshell-server ${verb}: the .previous sibling could not be removed: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
            failures.push("the .previous sibling could not be removed");
          }
        }
      }
    } else {
      deps.log("no installed binary: this instance runs from a checkout, which is left alone");
    }
  }

  if (failures.length > 0) {
    deps.error(`subshell-server ${verb}: finished with failures: ${failures.join("; ")}`);
    return 1;
  }
  deps.log(
    opts.uninstall
      ? wipeData
        ? "Subshell Server is uninstalled and its data is gone. Enrolled nodes were not reached; they will stop connecting to a plane that is gone."
        : "Subshell Server is uninstalled; the data and settings are still on disk. Enrolled nodes were not reached; they will stop connecting to a plane that is gone."
      : "Subshell Server was reset to a fresh machine. The installed binary is still here for `subshell-server init`.",
  );
  return 0;
}
