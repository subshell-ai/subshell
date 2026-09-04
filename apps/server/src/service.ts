import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type TmuxOffer, tmuxPreflight } from "@/commands/configure.js";

/**
 * `subshell-server service install|uninstall` — background the control plane
 * with the platform's per-user service manager: a systemd **user** unit on
 * Linux, a launchd agent plist on macOS. The direct mirror of
 * `apps/client/src/service.ts` (same deps-injection discipline, same
 * "tests pin the exact unit/plist text + command sequences" property) with
 * one deliberate structural difference: EVERYTHING here is SYNCHRONOUS.
 * That is not style — the CLI entry (cli.ts invariant 1) forbids a handled
 * command from suspending before `process.exit`, so where the client awaits
 * `Bun.spawn` and `fs/promises`, this module uses `Bun.spawnSync` and the
 * sync fs API and returns {@link CliResult} values directly.
 *
 * Nothing here shells out at import time; every effect flows through
 * {@link ServiceDeps}. Like the client (RULING there: config existence is a
 * `hasConfig()` dependency) this module imports no config loader: the CLI
 * wires existence to `existsSync(<configDir>/config.env)`.
 */

/** The client-`cli.ts`-shaped result value; the server entry writes out/err and exits with `code`. */
export interface CliResult {
  /** Process exit code. */
  code: number;
  /** stdout text (empty when nothing to report). */
  out: string;
  /** stderr text (empty on success). */
  err: string;
}

/** Fully injected seams — the module reads NOTHING from `process.*` directly. */
export interface ServiceDeps {
  /** Runtime platform — only `linux` and `darwin` have a service manager here. */
  platform: NodeJS.Platform;
  /** User home the unit/plist paths hang off (NOT the config dir). */
  home: string;
  /** Numeric uid — builds the launchd `gui/<uid>` domain target. */
  uid: number;
  /**
   * The executable the service runs: the CURRENT executable —
   * `process.execPath` when running as the compiled `subshell-server`
   * binary (tests inject a fake path). An interpreter path (dev launch under
   * `bun`) is paired with {@link ServiceDeps.argv1} (see {@link execLine}).
   */
  servicePath: string;
  /** `process.argv[1]` — the script path in dev, ignored for the compiled binary. */
  argv1: string;
  /**
   * The server config home (`serverConfigDir()` in production) — becomes the
   * unit's `WorkingDirectory=` and the directory of its `EnvironmentFile=`.
   */
  configDir: string;
  /** Env source: XDG_RUNTIME_DIR probe (systemd reachability) + tmux escape hatch. */
  env: Record<string, string | undefined>;
  /** Executable lookup for the tmux preflight (production: `Bun.which`). */
  which: (name: string) => string | null;
  /** Whether config.env exists; the CLI wires this to `existsSync`. */
  hasConfig(): boolean;
  /** Run one service-manager command SYNCHRONOUSLY, capturing stdout/stderr as text. */
  runCmd(cmd: string[]): { code: number; out: string; err: string };
  /** Write a file (real impl creates parent dirs). */
  writeFile(path: string, text: string): void;
  /** Delete a file. */
  removeFile(path: string): void;
  /** Existence check for the unit/plist path (drives reinstall bootout + uninstall no-op). */
  fileExists(path: string): boolean;
  /**
   * PATH to bake into the service (systemd `Environment=PATH=` / launchd
   * `EnvironmentVariables`). Named `pathEnv` to stay clear of
   * {@link ServiceDeps.servicePath}, which means the executable here (the
   * client uses `servicePath` for this field — the server unit's ExecStart
   * naming took the name first). Same rationale: service managers start
   * units with a stock PATH, so a tmux that made the install-time preflight
   * pass (Homebrew/Nix) would be "not found" once the manager starts the
   * server. The CLI wires `process.env.PATH`; tests inject it to pin the line.
   */
  pathEnv?: string;
  /**
   * tmux offer bundle (spec 2026-09-03): the CLI wires it with
   * `interactive = TTY` (service install takes no flags). Absent ⇒ the
   * preflight is its pre-offer self — refuse with the hint. NOTE: unlike
   * every other output of {@link installService}, the offer's question and
   * progress lines go STRAIGHT to the injected `log` (stdout) — a live
   * prompt cannot be buffered into the returned CliResult.
   */
  tmuxOffer?: TmuxOffer;
}

/** systemd user-unit name (lives under `~/.config/systemd/user/`). */
export const SYSTEMD_UNIT_NAME = "subshell-server.service";
/** launchd label (plist: `~/Library/LaunchAgents/<label>.plist`). */
export const LAUNCHD_LABEL = "dev.subshell.server";

const unitPath = (home: string) => join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
/** NOTE: deliberately distinct from the client's `~/Library/Logs/subshell.log`. */
const serverLogPath = (home: string) => join(home, "Library", "Logs", "subshell-server.log");

/**
 * Where THIS platform's per-user service definition lives (or would live).
 * `null` on platforms without a service manager. Exported for the `status`
 * command's cheap existsSync line — existence is a definition-on-disk check,
 * not a running check (the port probe covers liveness).
 */
export function serviceArtifactPath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === "linux") return unitPath(home);
  if (platform === "darwin") return plistPath(home);
  return null;
}

/**
 * The argv the service manager should run. Compiled binary (basename starts
 * with `subshell`): the binary ALONE — the server boots from a bare
 * `subshell-server` invocation (the svc.sh/systemd no-subcommand contract),
 * so unlike the client there is no trailing `run`. Dev/interpreter launch
 * (`bun src/index.ts`): interpreter + the resolved script path — a bare
 * relative `argv1` would break the moment the manager starts us from another
 * cwd, so it is resolved at install time.
 */
export function execLine(deps: Pick<ServiceDeps, "servicePath" | "argv1">): string[] {
  if (basename(deps.servicePath).startsWith("subshell")) return [deps.servicePath];
  return [deps.servicePath, resolve(deps.argv1)];
}

/**
 * Quote one argv/path token for a systemd unit line. systemd word-splits the
 * line itself (it is NOT run through a shell), so a path containing
 * whitespace — a macOS "Application Support" home, a spaced
 * `SUBSHELL_SERVER_CONFIG_DIR` — must be double-quoted or the unit
 * 203/EXECs (ExecStart) or silently mis-resolves (WorkingDirectory/
 * EnvironmentFile). Backslash and `"` are the only in-quote escapes systemd
 * honours here; a clean token is emitted verbatim so the common path stays
 * byte-identical to the tests' pinned text.
 */
function systemdQuote(arg: string): string {
  if (!/[\s"\\]/.test(arg)) return arg;
  return `"${arg.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** Join an exec line into a systemd-safe `ExecStart=` value. */
const systemdExecStart = (line: string[]): string => line.map(systemdQuote).join(" ");

/**
 * systemd user-unit body — the exact lines the tests pin. Shape follows the
 * client unit (Description / network-online / Restart=always / RestartSec=5
 * / WantedBy=default.target / PATH bake) plus the two server keys:
 *
 * - `WorkingDirectory=<configDir>` — relative db paths resolve predictably
 *   and Bun's `.env` preload (which reads the CWD before any user code) finds
 *   the config home, not whatever directory the manager happens to start in.
 * - `EnvironmentFile=<configDir>/config.env` — systemd exports the very file
 *   the binary's own loader reads (setdefault precedence), so the two can
 *   never disagree; the loader stays for non-systemd runs.
 * - `StartLimitIntervalSec=0` — Restart=always must mean ALWAYS. A second
 *   instance on the port (a stray `subshell-server` in a terminal) crash-
 *   loops with EADDRINUSE; the default start-limit would park the unit in
 *   `failed` until a manual reset. The client unit has no such loop-prone
 *   boot failure, which is why it does not carry this line.
 * - `KillMode=process` — the server spawns each LOCAL subshell's tmux server
 *   as a child, so those servers inherit this unit's cgroup; systemd's
 *   default control-group kill SIGKILLs every live pane on stop/restart
 *   (observed twice: 2026-09-01, and again 2026-09-03 when a renamed unit
 *   shipped without the manual drop-in). The panes are stateful daemons by
 *   design — the boot reconciler re-adopts them — so only the main process
 *   is a restart/stop target.
 */
function systemdUnit(exec: string, configDir: string, pathEnv?: string): string {
  // systemd user units get a stock PATH (`/usr/bin:/bin:…`), NOT the
  // installer's shell PATH — so a tmux from Homebrew/Nix that made the
  // install preflight pass would be "not found" when the service starts the
  // server. Baking the installing shell's PATH keeps preflight and runtime
  // agreeing. Omitted when absent → the byte-exact minimal unit.
  const environment = pathEnv ? `Environment=PATH=${systemdQuote(pathEnv)}\n` : "";
  return `[Unit]
Description=subshell-server (the Subshell control plane)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
${environment}WorkingDirectory=${systemdQuote(configDir)}
EnvironmentFile=${systemdQuote(join(configDir, "config.env"))}
ExecStart=${exec}
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
`;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * launchd plist body: keep-alive agent logging to
 * `~/Library/Logs/subshell-server.log` (its own file — the client's is
 * `subshell.log`). Only PATH is baked: config.env is loaded by the binary
 * itself (and by nothing the plist would need to see), so no
 * SUBSHELL_* exports belong here.
 */
function launchdPlist(args: string[], logPath: string, pathEnv?: string): string {
  const argLines = args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
  // launchd also starts agents with a stock PATH, so a Homebrew tmux
  // (`/opt/homebrew/bin`, Apple Silicon) that passed the preflight would be
  // "not found" when the agent runs. Bake the installing shell's PATH.
  // Omitted when absent → the byte-exact minimal plist.
  const envBlock = pathEnv
    ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>${xmlEscape(pathEnv)}</string>\n\t</dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${argLines}
\t</array>
${envBlock}\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>AbandonProcessGroup</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

const errLine = (msg: string): CliResult => ({ code: 1, out: "", err: `subshell-server: ${msg}\n` });

/** Collapse command stderr into one quotable line (trailing newline, no blank runs). */
const oneLine = (s: string): string => s.trim().replace(/\s*\n\s*/g, " ");

/** The operator-facing one-liner from a failed service-manager command (stderr first — that is where systemctl/launchctl explain themselves). */
const cmdDetail = (r: { out: string; err: string }): string => oneLine(r.err) || oneLine(r.out) || "no output";

/** Install refuses to touch the machine before the server is configured; uninstall deliberately does NOT (see {@link uninstallService}). */
const NO_CONFIG = "no config.env — run subshell-server init first";

const unsupported = (action: string, platform: string): string =>
  `service ${action} is not supported on '${platform}' — no per-user service manager here; ` +
  "run `subshell-server` in a terminal (e.g. inside tmux/screen), or background it with: " +
  "nohup subshell-server >subshell-server.log 2>&1 &";

/** Linux install guards that run BEFORE any write or manager command. */
function systemdGuards(deps: ServiceDeps): CliResult | null {
  // The user instance is where this unit lives — no XDG_RUNTIME_DIR means no
  // D-Bus to talk to (svc.sh checks the same, with the same message shape).
  if (!deps.env.XDG_RUNTIME_DIR) {
    return errLine(
      "no XDG_RUNTIME_DIR — no systemd user session here; run `subshell-server` in a terminal " +
        "(e.g. inside tmux/screen) instead",
    );
  }
  // Reachability probe (svc.sh's `systemctl --user is-system-running`): the
  // classic "Failed to connect to bus" answers HERE, as a refusal with
  // nothing written — unlike the client (which learns it from a failing
  // daemon-reload AFTER the unit landed on disk).
  const probe = deps.runCmd(["systemctl", "--user", "is-system-running"]);
  if (probe.code !== 0) {
    return errLine(
      `the systemd user instance is not reachable (systemctl --user is-system-running exited ${probe.code}: ` +
        `${cmdDetail(probe)}) — this usually means no systemd user session (container, or SSH without a login)`,
    );
  }
  return null;
}

/**
 * Install the per-user service and start it. Guards first (platform →
 * config.env → tmux preflight → systemd reachability), ALL before any write.
 * Linux: write the unit, then `daemon-reload` + `enable --now` — a failed
 * reload aborts with the systemctl stderr quoted; the unit file is
 * deliberately left on disk. macOS: write the plist, `bootout` the previous
 * load when reinstalling (failure tolerated — it usually means "not loaded"),
 * then `bootstrap` (same order as the client; the label is new so no legacy
 * bootout is needed).
 */
export function installService(deps: ServiceDeps): CliResult {
  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    return errLine(unsupported("install", deps.platform));
  }
  if (!deps.hasConfig()) return errLine(NO_CONFIG);

  const preflightErr: string[] = [];
  if (
    !tmuxPreflight({
      env: deps.env,
      which: deps.which,
      error: (line) => preflightErr.push(line),
      platform: deps.platform,
      offer: deps.tmuxOffer,
    })
  ) {
    return { code: 1, out: "", err: `${preflightErr.join("\n")}\n` };
  }

  if (deps.platform === "linux") {
    const guard = systemdGuards(deps);
    if (guard) return guard;
    const path = unitPath(deps.home);
    deps.writeFile(path, systemdUnit(systemdExecStart(execLine(deps)), deps.configDir, deps.pathEnv));
    const reload = deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    if (reload.code !== 0) {
      return errLine(
        `systemctl --user daemon-reload failed (exit ${reload.code}): ` +
          `${cmdDetail(reload)} — the unit file was left at ${path}; ` +
          "this usually means no systemd user subshell is running (container/SSH without loginctl)",
      );
    }
    const enable = deps.runCmd(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
    if (enable.code !== 0) {
      return errLine(
        `systemctl --user enable --now ${SYSTEMD_UNIT_NAME} failed (exit ${enable.code}): ` + `${cmdDetail(enable)}`,
      );
    }
    return {
      code: 0,
      out:
        `Installed ${path} — subshell-server is enabled and running.\n` +
        "To keep it alive across logout, enable lingering: loginctl enable-linger $USER\n",
      err: "",
    };
  }

  // darwin
  const path = plistPath(deps.home);
  const reinstall = deps.fileExists(path); // must be sampled BEFORE the overwrite
  deps.writeFile(path, launchdPlist(execLine(deps), serverLogPath(deps.home), deps.pathEnv));
  if (reinstall) {
    // Tolerated: bootout on a not-loaded service errors, and the fresh
    // bootstrap below is what actually carries the new definition.
    deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
  }
  const boot = deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  if (boot.code !== 0) {
    return errLine(
      `launchctl bootstrap failed (exit ${boot.code}): ${cmdDetail(boot)} — ` + `the plist was left at ${path}`,
    );
  }
  return { code: 0, out: `Installed ${path} — subshell-server is registered with launchd and running.\n`, err: "" };
}

/**
 * Remove the per-user service. Unlike install, this NEVER gates on
 * {@link ServiceDeps.hasConfig} or tmux: deleting the config is the de-facto
 * unconfigure, and a guard here would strand an enabled unit
 * (Restart=always) with no way to take it down. With no config we still run
 * the full disable/remove sequence and note in stdout that there is nothing
 * else to clean up. Missing unit/plist is not an error: exit 0, "nothing
 * installed", and not a single command runs. Command failures on teardown are
 * reported (exit 1) but the file is still removed — a stuck `disable --now`
 * (unit loaded but broken) should not leave the definition behind to haunt
 * the next install.
 */
export function uninstallService(deps: ServiceDeps): CliResult {
  // The note rides every success line when the config is gone; error paths
  // keep their message about the actual failure.
  const noConfigNote = deps.hasConfig() ? "" : "(no config.env found — nothing else to clean up)\n";

  if (deps.platform === "linux") {
    const path = unitPath(deps.home);
    if (!deps.fileExists(path)) {
      return { code: 0, out: `nothing installed — no systemd user unit at ${path}\n${noConfigNote}`, err: "" };
    }
    const disable = deps.runCmd(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
    const reload = deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    deps.removeFile(path);
    if (disable.code !== 0 || reload.code !== 0) {
      const failed = disable.code !== 0 ? disable : reload;
      const label = disable.code !== 0 ? "disable --now" : "daemon-reload";
      return errLine(
        `systemctl --user ${label} failed (exit ${failed.code}): ` +
          `${cmdDetail(failed)} — the unit file was removed anyway`,
      );
    }
    return {
      code: 0,
      out: `Removed ${path} — subshell-server is stopped and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    const path = plistPath(deps.home);
    if (!deps.fileExists(path)) {
      return { code: 0, out: `nothing installed — no launchd plist at ${path}\n${noConfigNote}`, err: "" };
    }
    const unload = deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    deps.removeFile(path);
    if (unload.code !== 0) {
      return errLine(
        `launchctl bootout reported (exit ${unload.code}): ${cmdDetail(unload)} — the plist was removed anyway`,
      );
    }
    return {
      code: 0,
      out: `Removed ${path} — subshell-server is unloaded and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  return errLine(unsupported("uninstall", deps.platform));
}

/** Identity/env fields the CALLER resolves (the CLI passes its injected seams or the process defaults). */
export interface ServiceSeed {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  servicePath: string;
  argv1: string;
  configDir: string;
  env: Record<string, string | undefined>;
  which: (name: string) => string | null;
  pathEnv?: string;
  /** See {@link ServiceDeps.tmuxOffer}. */
  tmuxOffer?: TmuxOffer;
}

/**
 * Build the real-{@link ServiceDeps} wiring: the live environment arrives via
 * `seed` (so the CLI's injectable seams stay honoured end to end) and the
 * EFFECTS are the real ones — `Bun.spawnSync` for `runCmd` (sync by cli.ts
 * invariant 1), sync `node:fs` for the file effects. `hasConfig` is derived
 * from the seeded configDir here — the one place allowed to spell the file
 * name, mirroring the client ruling that service.ts imports no config loader.
 */
export function DEFAULT_DEPS(seed: ServiceSeed): ServiceDeps {
  return {
    ...seed,
    hasConfig: () => existsSync(join(seed.configDir, "config.env")),
    runCmd(cmd) {
      try {
        const res = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
        // A signal-killed/never-started child has exitCode null — treat it as
        // failure(ish) so callers quote whatever output came back.
        if (res.exitCode === null) return { code: 1, out: res.stdout.toString(), err: res.stderr.toString() };
        return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
      } catch (err) {
        // Missing manager binary (no systemctl) surfaces as a spawn throw —
        // report it as a failed command, not a crash, so the reachability
        // refusal quotes it.
        return { code: 127, out: "", err: `spawn failed: ${(err as Error).message}` };
      }
    },
    // The unit/plist directories (~/.config/systemd/user, ~/Library/LaunchAgents)
    // are ours to create; mkdir-recursive first so a fresh box installs cleanly.
    writeFile(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
    removeFile(path) {
      rmSync(path, { force: true });
    },
    fileExists: (path) => existsSync(path),
  };
}
