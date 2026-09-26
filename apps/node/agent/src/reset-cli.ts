import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CliResult } from "./cli.js";
import { clientHome, configPath } from "./config.js";
import { isPidAlive, lockPath, readLock } from "./lock.js";
import { agentLogPath } from "./log-file.js";
import { deleteGuardOk, pathRulesOk } from "./reset-guards.js";
import { controlService, queryService, type ServiceDeps, uninstallService } from "./service.js";
import { resolveNodeBinaryPath, UpdateRefused } from "./update.js";

/**
 * `subshell reset` and `subshell uninstall` — the node role's doors, twin to
 * `subshell-server reset|uninstall` (issue #232). The Client app's Reset chain
 * (`apps/client/desktop/src-tauri/src/reset.rs`) is the reference for WHAT
 * goes: this machine's pane servers, the service definition, the data
 * directory, the daemon lock, and `config.json` last — the node key's only
 * home, so its deletion IS the deregistration, and harder: the link keypair
 * and the node identity inside the data dir go too, which `unenroll` leaves
 * behind. The CLI chain follows the control-plane verb's ruled shape: the
 * machine's NAME as consent, and CLEAR-EVERYTHING after consent — a step that
 * cannot run is reported and remembered for the exit code, and the rest still
 * goes ("a reset means to clear out everything", operator ruling 2026-09-26).
 *
 * Consent is the MACHINE'S NAME (hostname), the same fact every reset door in
 * this product asks: the server CLI, the Server assistant, and the Client
 * app's Reset dialog all compare the hostname on the machine itself. The node
 * NAME in `config.json` is a plane-side label a person can rename; consent
 * names the metal, not the label.
 *
 * - **reset** stops the daemon, closes this machine's `subshell-*` pane
 *   servers, removes the service definition, and deletes the data directory
 *   (identity and pane logs included), the lock, and `config.json` last. The
 *   installed binary stays, so `subshell setup` can enroll again.
 * - **uninstall** is that chain PLUS the binary the ladder named (the service
 *   definition first, then this process — `update`'s `resolveNodeBinaryPath`)
 *   and its `.previous`. Removing the program and wiping the machine are two
 *   decisions: uninstall ASKS whether the data goes too, default NO, and the
 *   question says what a reset does; `--reset-data` is the scripted yes and a
 *   headless run without it keeps the bytes.
 *
 * What neither reaches: the PLANE's row for this node (containment is the
 * owner's act in the browser; `unenroll`'s doc paragraph says so, unchanged),
 * enrolled panes on OTHER machines, the agent's own capped log (deliberately
 * left: it is the record of this act and holds no credential, `status`'s
 * paths block spells the same rule), and anything belonging to the control
 * plane role if this machine also runs one.
 */

/** Everything one verb deletes, read from the same places `status --json` reads. */
export interface NodeResetPlan {
  /** config.json — the node key's only home. DELETED LAST. */
  configJson: string;
  /** The daemon lock. Deleted unconditionally: unlike `unenroll`'s narrow
   * act, clear-everything takes even a foreign-node lock in this home. */
  lockFile: string;
  /** The enrolled data dir (identity.json, subshells/, mcp/, markers), or the default when unenrolled. */
  dataDir: string;
  /** The installed binary an uninstall may remove; `null` when nothing names one (dev checkout). */
  binary: string | null;
  /** Why `binary` is null; the sentence the uninstall prints instead of deleting. */
  binaryReason: string | null;
  /** The agent's own log: named in the success output as the thing that STAYS. */
  agentLog: string;
}

/** The service-manager facts the chain drives; tests replace all three. */
export interface NodeResetService {
  installed(): boolean | Promise<boolean>;
  stop(): SeamResult | Promise<SeamResult>;
  remove(): SeamResult | Promise<SeamResult>;
}

/** One manager answer. `out` rides along because `service.ts` puts the
 * tolerated "nothing installed" fact THERE (code 0), never in `err`. */
export interface SeamResult {
  code: number;
  err: string;
  out?: string;
}

/** Injected seams; every default is the real thing, and the tests replace them. */
export interface NodeResetDeps {
  /** Can anything answer a question? (Same seam the setup service question runs on.) */
  interactive: boolean;
  /** This machine's name, the consent target (default: `os.hostname()`). */
  machineName?: () => string;
  /** Ask for text (default: the clack prompt wired by cli.ts); `null` = cancelled. */
  ask?: (question: string, def: string) => string | null | Promise<string | null>;
  /** Ask yes/no (the uninstall data question); `null` = cancelled. */
  askConfirm?: (question: string, def: boolean) => boolean | null | Promise<boolean | null>;
  /** The delete plan (default: {@link buildNodeResetPlan}). */
  plan?: () => Promise<NodeResetPlan> | NodeResetPlan;
  /** The service facts (default: `service.ts` over the real platform). */
  service?: NodeResetService;
  /** A live daemon's pid from the lock file (default: readLock + isPidAlive).
   * REQUIRED, unlike the prompt seams: a missing one would silently report a
   * clean reset over a running daemon, the exact fact this chain keeps true. */
  liveDaemon(): { pid: number } | null;
  /** Close the pane tmux servers; survivors are reported and the clear continues. */
  sweepPanes?: (note: (line: string) => void) => { ok: boolean; detail?: string };
  /** How long to wait for a stopped daemon's lock to die (default: 10 s). */
  daemonWaitMs?: number;
  /** Sleep seam for the settle wait (default: `Bun.sleep`); the tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/** The plan the delete runs against, read the way `status --json` reads it. */
export async function buildNodeResetPlan(): Promise<NodeResetPlan> {
  const cfgJson = configPath();
  let dataDir = join(clientHome(), "data");
  try {
    const parsed = JSON.parse(await readFile(cfgJson, "utf8")) as { dataDir?: string };
    if (typeof parsed.dataDir === "string" && parsed.dataDir !== "") dataDir = parsed.dataDir;
  } catch {
    /* unenrolled (or unreadable): the default data home is still this role's litter */
  }
  let binary: string | null = null;
  let binaryReason: string | null = null;
  try {
    binary = (await resolveNodeBinaryPath({ home: homedir(), configDir: clientHome() })).binary;
  } catch (failure) {
    binaryReason =
      failure instanceof UpdateRefused
        ? failure.message
        : `the binary ladder did not answer: ${failure instanceof Error ? failure.message : String(failure)}`;
  }
  return {
    // Resolved the way the delete and the guards both need: as typed is
    // ambiguous to a plan (the server CLI's rule, same words there).
    configJson: resolve(cfgJson),
    lockFile: resolve(lockPath()),
    dataDir: resolve(dataDir),
    binary,
    binaryReason,
    agentLog: agentLogPath(),
  };
}

/**
 * The tmux sweep, the third copy of the measured rule (the Server app's and
 * the Server CLI's chains read the same three dead-server spellings against
 * tmux 3.7c, unlink the litter, and keep going; a real failure is COLLECTED
 * and named, never an early abandonment of the remaining sockets). Sockets
 * named `subshell-*` are the product's own (`pane-runtime`'s rule, pinned in
 * the Rust twin); a machine running both roles sees both roles' panes go, and
 * says which it could not close.
 */
export function sweepNodePaneSockets(
  note: (line: string) => void = () => {},
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
    note(`no pane servers to close in ${dir}`);
    return { ok: true };
  }
  const survivors: string[] = [];
  for (const name of names) {
    let res: ReturnType<typeof Bun.spawnSync>;
    try {
      res = spawn({ cmd: ["tmux", "-L", name, "kill-server"], stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    } catch (failure) {
      survivors.push(
        `tmux is not runnable to close ${name}: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      continue;
    }
    if (res.exitCode === 0) continue;
    const combined = `${res.stdout?.toString() ?? ""}${res.stderr?.toString() ?? ""}`;
    if (combined.includes("error connecting") || combined.includes("no server running on")) {
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
 * chain survives the walk (the Server CLI's walker, same words there and in
 * the Rust original; change one, change the others). config.json's deletion
 * is the chain's LAST act, and the walk may never take the file that act is
 * named for — which matters here because a custom `dataDir` CAN be the config
 * home itself.
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
        if (depth + 1 < keepSegments.length) walk(join(current, name), depth + 1);
        continue;
      }
      rmSync(join(current, name), { recursive: true, force: true });
    }
    if (keepSegments !== null && depth < keepSegments.length) return;
    if (readdirSync(current).length > 0) return;
    rmdirSync(current); // by name: `rm` without `recursive` refuses directories (EISDIR)
  };
  walk(root, 0);
}

/** Remove a directory only while it is empty — the post-delete tidy. Never throws. */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* not empty (or not ours); no consent covered this */
  }
}

/**
 * Run the verb. `opts.uninstall` adds the binary; `opts.confirm` is the
 * scripted machine name; `opts.resetData` is the scripted yes for the data
 * question. Returns the CLI result (code 1 when any step failed OR consent
 * was refused — the words always say which).
 */
export async function runNodeReset(
  opts: { uninstall: boolean; confirm?: string; resetData?: boolean },
  deps: NodeResetDeps,
): Promise<CliResult> {
  const verb = opts.uninstall ? "uninstall" : "reset";
  const machine = (deps.machineName ?? hostname)().trim();
  const out: string[] = [];
  const err: string[] = [];
  const failures: string[] = [];

  const plan = await (deps.plan ?? buildNodeResetPlan)();

  // The data question (uninstall only), BEFORE the guards and consent: a run
  // that keeps the bytes deletes none of them, so it is neither guarded nor
  // gated as though it did. Default NO; `--reset-data` is the scripted yes;
  // a non-interactive run without it keeps and says the flag's name.
  let wipeData = true;
  if (opts.uninstall) {
    if (opts.resetData !== undefined) {
      wipeData = opts.resetData;
    } else if (!deps.interactive) {
      wipeData = false;
      out.push("not interactive: the data and settings stay; pass --reset-data to delete them");
    } else {
      const answer = await (deps.askConfirm ?? (() => Promise.resolve(false)))(
        "Delete this node's data too: the data directory (identity, pane logs), the daemon lock, and the node config with its key, the way `reset` does? A reset leaves no copy behind. [y/N]",
        false,
      );
      if (answer === null) return res(1, out, ["subshell: cancelled; nothing was changed"]);
      wipeData = answer;
    }
  }

  // The shape guards, BEFORE consent (the third pinned copy of the rules):
  // only for the paths this run actually deletes, and each one by its
  // RESOLVED spelling when it exists. The data walk deletes through the
  // realpath (removeTreeBut resolves before it recurses), so a symlinked
  // data home whose SPELLING passes the rules while its TARGET is the home
  // dir would otherwise delete through the guard's back door; a present but
  // unresolvable path is refused for the same reason the containment guard
  // refuses it, and an absent one is guarded by its own spelling, the only
  // truth there is about what would be deleted.
  if (wipeData) {
    for (const [what, raw] of [
      ["node config", plan.configJson],
      ["daemon lock", plan.lockFile],
      ["data directory", plan.dataDir],
    ] as const) {
      const real = existsSync(raw) ? tryRealpath(raw) : raw;
      if (real === null) {
        return res(1, out, [`subshell: the plan's ${what} (${raw}) exists but cannot be resolved; refusing to run`]);
      }
      if (!pathRulesOk(real)) {
        const named = real === raw ? raw : `${raw} -> ${real}`;
        return res(1, out, [`subshell: the delete plan names an unsafe path (${named}); refusing to run`]);
      }
    }
    if (!opts.uninstall && plan.binary !== null) {
      // The Rust twin's caller rule: compare canonical spellings, because the
      // walk deletes through the RESOLVED directory. Present-but-unresolvable
      // is a refusal; absent keeps its raw spelling.
      const canonical = (path: string): string | null => (existsSync(path) ? tryRealpath(path) : path);
      const binaryReal = canonical(plan.binary);
      if (binaryReal === null) {
        return res(1, out, [
          `subshell: the installed binary (${plan.binary}) exists but cannot be resolved; refusing to run`,
        ]);
      }
      const dirReal = canonical(plan.dataDir);
      if (dirReal === null) {
        return res(1, out, [`subshell: the plan's ${plan.dataDir} exists but cannot be resolved; refusing to run`]);
      }
      if (!deleteGuardOk(dirReal, binaryReal)) {
        return res(1, out, [
          `subshell: the plan's ${plan.dataDir} contains the installed binary (${plan.binary}) a reset promises to keep; refusing to run`,
        ]);
      }
    }
  }

  // Consent: the machine's NAME, typed or named, never assumed. `--yes` was
  // already refused at dispatch.
  let typed: string;
  if (opts.confirm !== undefined) {
    typed = opts.confirm.trim();
  } else if (!deps.interactive) {
    return res(1, out, [
      `subshell: not interactive: the machine's name must be typed, or passed as --confirm <machine-name>; nothing was changed`,
    ]);
  } else {
    const scope =
      verb === "reset"
        ? "deletes this node's data, key and settings from this machine"
        : wipeData
          ? "removes the node service and the installed binary, AND deletes this node's data, key and settings"
          : "removes the node service and the installed binary; the data and settings stay";
    // The plan is named INSIDE the prompt: an operator on a custom dataDir
    // consents to paths they have actually seen, the way the app's dialog
    // lists them before the typed name.
    const planLines = wipeData
      ? `Will delete: ${plan.dataDir} (and everything under it), ${plan.lockFile}, ${plan.configJson}.\n`
      : "";
    const answer = await (deps.ask ?? (() => Promise.resolve(null)))(
      `${planLines}This ${scope}. Type ${machine || "(unknown host)"} to confirm:`,
      "",
    );
    if (answer === null) return res(1, out, ["subshell: cancelled; nothing was changed"]);
    typed = answer.trim();
  }
  if (!machine || typed !== machine) {
    return res(1, out, ["subshell: the machine name did not match; nothing was changed"]);
  }

  // From here the chain CLEARS: every step that cannot run is reported and
  // remembered for the exit code, and the rest goes on (the Server CLI's
  // ruled shape, same ruling, same date).
  const service =
    deps.service ??
    (() => {
      throw new Error(
        "runNodeReset: no service seams (the CLI wires them; a caller without them is an impossible state)",
      );
    })();

  // Stop the running daemon, if the definition says there is one.
  const wasInstalled = await Promise.resolve(service.installed());
  const liveOf = deps.liveDaemon;
  if (wasInstalled) {
    const stop = await Promise.resolve(service.stop());
    // `stop` rides its pane-safety warning in `err` WITH code 0 (service.ts):
    // never silent about what it took down.
    if (stop.code === 0 && stop.err.trim() !== "") err.push(stop.err.trim());
    if (stop.code !== 0) {
      err.push(`the node service did not stop; continuing to clear anyway\n${stop.err.trim()}`);
      failures.push("the node service did not stop");
      // Nothing was commanded down, so there is no promise to wait to become
      // true: the lock is read once and a survivor is named beside the
      // failed stop.
      const live = liveOf();
      if (live !== null) {
        err.push(`the node's daemon is still running (pid ${live.pid}); it keeps its memory, but its files go`);
        failures.push("the daemon was still running");
      }
    } else {
      // The manager's "stopped" is a claim; the lock is the fact, and it gets
      // a bounded settle to become true. macOS `bootout` returns while the job
      // is still being torn down (service.ts's own words), and the daemon
      // clears the lock only on its one exit path (daemon.ts) — reading the
      // lock once here would name a perfectly-successful stop's daemon "still
      // running" on every macOS run, and the survivor's 15 s heartbeat could
      // re-create the lock under the deletes that follow. The server twin
      // waits on its port for exactly this reason; the node waits on its lock.
      const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
      const deadline = Date.now() + (deps.daemonWaitMs ?? 10_000);
      for (;;) {
        const live = liveOf();
        if (live === null) {
          // "subshell is already stopped." is code 0 for a NOT-LOADED job
          // (service.ts's idempotent stop): converging on it proves nothing
          // was stopped NOW, and the line must not claim it was.
          out.push(
            (stop.out ?? "").includes("already stopped")
              ? "the node service was already stopped"
              : "stopped the node service",
          );
          break;
        }
        if (Date.now() >= deadline) {
          err.push(`the node's daemon is still running (pid ${live.pid}); it keeps its memory, but its files go`);
          failures.push("the daemon was still running");
          break;
        }
        await sleep(250);
      }
    }
  } else {
    out.push("no service definition; nothing to stop");
    // A daemon started BY HAND has no unit this verb can reach at all: there
    // is nothing to converge, so the lock is read once and named. Not obeyed.
    const live = liveOf();
    if (live !== null) {
      err.push(
        `the node's daemon is running (pid ${live.pid}) with no service definition to stop; it keeps its memory, but its files go`,
      );
      failures.push("the daemon was still running");
    }
  }

  // Close this machine's pane servers.
  const sweep = (deps.sweepPanes ?? ((note) => sweepNodePaneSockets(note)))((line) => out.push(line));
  if (!sweep.ok) {
    err.push(`the pane sweep reported problems, below; the rest is cleared anyway\n${sweep.detail ?? ""}`);
    failures.push("the pane sweep reported problems");
  }

  // Remove the service definition, so nothing starts again at login. Both
  // verbs: a daemon respawning over deleted files is the half-run. The
  // tolerated absence is code 0 with "nothing installed" in OUT
  // (service.ts's shape) — a definition that vanished between the probe and
  // this call is reported as gone, never as removed.
  if (wasInstalled) {
    const gone = await Promise.resolve(service.remove());
    if (gone.code !== 0) {
      err.push(`the service definition could not be removed; the rest is cleared anyway\n${gone.err.trim()}`);
      failures.push("the service definition could not be removed");
    } else if ((gone.out ?? "").includes("nothing installed")) {
      out.push("the service definition was already gone");
    } else {
      out.push("removed the service definition");
    }
  }

  // Whether a log exists is a fact to read BEFORE the deletes: after them,
  // "absent" conflates "never existed" with "the walk took it".
  const logWasHere = existsSync(plan.agentLog);

  // The deletes, the reference chain's order, absence = done, config LAST.
  const attempt = (what: string, run: () => void): void => {
    try {
      run();
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      err.push(`could not delete ${what}: ${detail}`);
      failures.push(`could not delete ${what}`);
    }
  };
  if (wipeData) {
    attempt(plan.dataDir, () => removeTreeBut(plan.dataDir, plan.configJson));
    attempt(plan.lockFile, () => rmSync(plan.lockFile, { force: true }));
    attempt(plan.configJson, () => rmSync(plan.configJson, { force: true }));
    removeIfEmpty(dirname(plan.configJson));
    if (failures.includes("the daemon was still running")) {
      // The survivor's heartbeat re-creates the lock it owns: the deletes
      // happened, but "gone" would not stay true, so the line says so.
      out.push("deleted what a running daemon allows: a daemon that keeps running can write some of it back");
    } else if (!failures.some((f) => f.startsWith("could not delete"))) {
      out.push(
        "deleted the data directory (identity and pane logs), the daemon lock, and the node config with its key",
      );
    }
    // The claim may only cover what actually stayed: a custom dataDir CAN be
    // the config home itself, and then the walk legitimately took the log's
    // directory with it; a node that never wrote a log has none to report on.
    if (existsSync(plan.agentLog)) {
      out.push(`left the agent's own log at ${plan.agentLog}: the record of this act, and no credential in it`);
    } else if (logWasHere) {
      out.push("the agent's own log went with the data directory it lived in");
    }
  } else {
    out.push("left the data, key and settings in place; `subshell reset` deletes them");
  }

  // The uninstall's own half: the binary the LADDER named, and its `.previous`.
  if (opts.uninstall) {
    if (plan.binary !== null) {
      const hadPrevious = existsSync(`${plan.binary}.previous`);
      try {
        rmSync(plan.binary, { force: true });
        out.push(`removed ${plan.binary}`);
      } catch (failure) {
        err.push(
          `the installed binary could not be removed: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
        failures.push("the installed binary could not be removed");
      }
      if (hadPrevious) {
        try {
          rmSync(`${plan.binary}.previous`, { force: true });
          out.push(`removed ${plan.binary}.previous`);
        } catch (failure) {
          err.push(
            `the .previous sibling could not be removed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
          failures.push("the .previous sibling could not be removed");
        }
      }
    } else {
      out.push(plan.binaryReason ?? "no installed binary: this agent runs from a source checkout, which is left alone");
    }
  }

  if (failures.length > 0) {
    return res(1, out, [...err, `finished with failures: ${failures.join("; ")}`]);
  }
  out.push(
    opts.uninstall
      ? wipeData
        ? "the node is uninstalled and its data is gone. The control plane keeps listing it until its owner deletes the row there."
        : "the node is uninstalled; its data and settings are still on disk. The control plane keeps listing it until its owner deletes the row there."
      : "the node was reset. The installed binary is still here for `subshell setup`. The control plane keeps listing this node until its owner deletes the row there.",
  );
  // `err` rides the success path too: a stop's pane-safety warning is code 0
  // and must not be swallowed just because the run finished clean.
  return res(0, out, err);
}

/** Assemble the CliResult: out and err joined with the CLI's trailing-newline rule. */
function res(code: number, out: string[], errs: string[]): CliResult {
  return {
    code,
    out: out.length > 0 ? `${out.join("\n")}\n` : "",
    err: errs.length > 0 ? `${errs.join("\n")}\n` : "",
  };
}

/** The production seams: real service manager, real lock file, real tmux sweep. */
export function defaultNodeResetDeps(sdeps: ServiceDeps): NodeResetDeps {
  return {
    interactive: process.stdin.isTTY === true,
    plan: buildNodeResetPlan,
    service: {
      installed: async () => (await queryService(sdeps)).installed,
      stop: async () => {
        const r = await controlService(sdeps, "stop");
        return { code: r.code, err: r.err, out: r.out };
      },
      remove: async () => {
        const r = await uninstallService(sdeps);
        return { code: r.code, err: r.err, out: r.out };
      },
    },
    liveDaemon: () => {
      const lock = readLock();
      return lock !== null && isPidAlive(lock.pid) ? { pid: lock.pid } : null;
    },
    sweepPanes: (note) => sweepNodePaneSockets(note),
  };
}
