import { access, chmod, readFile as fsReadFile, writeFile as fsWriteFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DESKTOP_CLIENT_BUNDLE_ID, lingerFromProbe, lingerProbeArgv, lingerVerdict } from "@internal/subshell-protocol";
import {
  assertManagerCommandUnderTest,
  assertServiceWriteUnderTest,
} from "@internal/subshell-protocol/service-test-safety";
import type { CliResult } from "./cli.js";
import { clientHome } from "./config.js";
import { selfInvocation } from "./self-invoke.js";

/**
 * `subshell service install|uninstall` — background the daemon with the
 * platform's per-user service manager: a systemd **user** unit on Linux, a
 * launchd agent plist on macOS. Nothing here shells out at import time; every
 * effect flows through {@link ServiceDeps} so the unit tests stub the manager
 * and the filesystem entirely (RULING: config existence is a `hasConfig()`
 * dependency — this module never imports `loadConfig`).
 */
export interface ServiceDeps {
  /** Runtime platform — only `linux` and `darwin` have a service manager here. */
  platform: NodeJS.Platform;
  /** User home the unit/plist paths hang off (NOT `SUBSHELL_CONFIG_HOME`). */
  home: string;
  /**
   * The agent's config home (`clientHome()` — `~/.config/subshell` or
   * `SUBSHELL_CONFIG_HOME`).
   *
   * REQUIRED, and that is the point: on darwin it is where a NOT-at-login
   * definition lives (see {@link sessionPlistPath}), so a caller that omitted
   * it would report an installed-but-disarmed service as absent — a wrong
   * answer that reads as "your service vanished" and that no type check would
   * have caught. It is only ever a path here; this module still imports
   * nothing that READS the config (the `hasConfig()` ruling above).
   */
  configDir: string;
  /** Numeric uid — builds the launchd `gui/<uid>` domain target. */
  uid: number;
  /** The running executable (`bun` in dev, the compiled binary otherwise). */
  execPath: string;
  /** `process.argv[1]` — the script path in dev, ignored for the compiled binary. */
  argv1: string;
  /** Whether an enrolled config exists; the CLI wires this to `loadConfig()` resolving. */
  hasConfig(): Promise<boolean>;
  /** Run one service-manager command, capturing stdout/stderr as text. */
  runCmd(cmd: string[]): Promise<{ code: number; out: string; err: string }>;
  /** Write a file (real impl creates parent dirs). */
  writeFile(path: string, text: string): Promise<void>;
  /** Delete a file. */
  removeFile(path: string): Promise<void>;
  /** Existence check for the unit/plist path (drives reinstall bootout + uninstall no-op). */
  fileExists(path: string): Promise<boolean>;
  /**
   * Read a file's text, or `null` when it is absent/unreadable. Added for
   * {@link queryService}, which must inspect the INSTALLED definition (not the
   * one this process would write) to answer whether a teardown keeps panes.
   */
  readFile(path: string): Promise<string | null>;
  /**
   * PATH to bake into the service (systemd `Environment=PATH=` / launchd
   * `EnvironmentVariables`). Service managers start units with a stock PATH,
   * so without this a tmux that made the enroll preflight pass (Homebrew/Nix)
   * is "not found" once the manager runs the daemon. The CLI wires
   * `process.env.PATH`; tests omit it to keep the historical unit byte-exact.
   */
  servicePath?: string;
  /**
   * Pause between bootstrap attempts, in milliseconds (production:
   * `Bun.sleep`). Injected so the retry costs a test nothing.
   */
  sleep?: (ms: number) => Promise<void> | void;
  /**
   * Set a file's mode. Used by {@link tightenServiceLogMode} alone, to repair
   * the 0644 launchd creates the daemon's log file with.
   *
   * OPTIONAL, and that is a safety property rather than convenience: a deps
   * object assembled by hand in a test carries no seam, so the repair reports
   * `no-seam` and touches nothing. The production implementation carries the
   * same under-test refusal as `writeFile`.
   */
  chmodFile?(path: string, mode: number): Promise<void>;
}

/** systemd user-unit name (lives under `~/.config/systemd/user/`). */
export const SYSTEMD_UNIT_NAME = "subshell.service";

/**
 * How to read the daemon's log where the unit redirects nothing (Linux): the
 * output is in the journal, so there is no path to report. The desktop app
 * used to hold this string; the agent reports it now, in `ready.runtime`.
 */
export const AGENT_LOG_HINT = `journalctl --user -u ${SYSTEMD_UNIT_NAME} -f`;
/**
 * launchd label (plist: `~/Library/LaunchAgents/<label>.plist`) — the SAME
 * string as Subshell Client's bundle identifier, which is also what the plist
 * names in `AssociatedBundleIdentifiers`: the agent's service belongs to the
 * app that installs it, and Login Items should say so rather than naming the
 * signing organization. The server CLI's twin constant and both apps' pin
 * tests hold the two spellings together.
 */
export const LAUNCHD_LABEL = DESKTOP_CLIENT_BUNDLE_ID;

const unitPath = (home: string) => join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
/**
 * The plist for an agent that must NOT start at login — the same document,
 * kept where launchd does not look. Ported from the server CLI's twin (spec
 * 2026-09-12 server-supervision §3.2), which measured the alternatives.
 *
 * **On macOS "starts at login" is the file's LOCATION, not a key inside it**,
 * and the two flag-shaped alternatives are both wrong for this job:
 *
 * - `RunAtLoad=false` does not stop it. The plist also carries
 *   `KeepAlive=true`, which starts a job when it is loaded regardless.
 *   MEASURED on macOS 26.6.2 (2026-09-12) for the server's own agent, same
 *   launchd: a throwaway agent with `RunAtLoad=false` + `KeepAlive=true`
 *   reported `state = running, runs = 1` two seconds after `bootstrap`, while
 *   the same agent without `KeepAlive` reported `runs = 0`. Dropping
 *   `KeepAlive` here is not on the table either — it is what brings the daemon
 *   back when it dies, and `controlService`'s restart relies on it.
 * - `launchctl disable gui/<uid>/<label>` does not work either: a disabled
 *   service refuses `bootstrap`, so "running now but not at login" cannot be
 *   expressed at all — and the disabled mark lives in launchd's per-uid
 *   override database, survives `service uninstall`, and makes the next fresh
 *   install fail with the generic EIO {@link bootstrapWithRetry} already has
 *   to apologise for.
 *
 * What launchd does document is that it auto-loads exactly the plists in
 * `~/Library/LaunchAgents` at login. So a definition kept anywhere else runs
 * only when something bootstraps it explicitly, which is precisely the
 * behaviour wanted — and it is one write/remove pair to move between the two
 * states, with a running job entirely unaffected (launchd holds the loaded
 * job, not the file).
 */
const sessionPlistPath = (configDir: string) => join(configDir, `${LAUNCHD_LABEL}.plist`);

/**
 * Where launchd redirects the daemon's stdout and stderr (the plist's
 * `StandardOutPath`).
 *
 * Exported because `log-hygiene.ts` repairs that file's mode at daemon start
 * and must name the same file this module tells launchd to write — a second
 * spelling of it elsewhere is how the repair comes to chmod nothing.
 */
export const launchLogPath = (home: string) => join(home, "Library", "Logs", "subshell.log");

/**
 * The darwin plist path that EXISTS, and what its location means.
 *
 * Exactly one of the two should ever be present; when both are (a hand-copy,
 * or a crash between the write and the remove), the login path wins and the
 * caller is expected to tidy — which is what {@link installService} and
 * {@link uninstallService} do.
 */
async function darwinDefinition(deps: Pick<ServiceDeps, "home" | "configDir" | "fileExists">): Promise<{
  path: string;
  installed: boolean;
  /** `true` = in `~/LaunchAgents` (starts at login); `false` = the session path; `null` = neither exists. */
  enabled: boolean | null;
}> {
  const login = plistPath(deps.home);
  if (await deps.fileExists(login)) return { path: login, installed: true, enabled: true };
  const session = sessionPlistPath(deps.configDir);
  if (await deps.fileExists(session)) return { path: session, installed: true, enabled: false };
  // Nothing installed: name where it WOULD live, which is the login path,
  // because that is where a plain `service install` puts it.
  return { path: login, installed: false, enabled: null };
}

/**
 * The argv the service manager should run: `<self> run`.
 *
 * The compiled-versus-interpreted decision lives in {@link selfInvocation},
 * shared with the MCP registration in `commands/launch.ts` — the two used to
 * decide it separately and disagreed, which is how a source-run agent came to
 * register `bun mcp` for its panes.
 */
export function execLine(deps: Pick<ServiceDeps, "execPath" | "argv1">): string[] {
  const { command, args } = selfInvocation("run", deps);
  return [command, ...args];
}

/**
 * Quote one argv token for a systemd `ExecStart=` line. systemd word-splits
 * the line itself (it is NOT run through a shell), so a path containing
 * whitespace — a macOS "Application Support" home, a dev-form `bun …/my
 * dir/main.ts`, a spaced `SUBSHELL_DATA_DIR` — must be double-quoted or the unit
 * 203/EXECs at start. Backslash and `"` are the only in-quote escapes systemd
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
 * systemd user-unit body — the exact lines the tests pin. Carries
 * `KillMode=process`: the daemon spawns each pane's tmux server as a child
 * inside this unit's cgroup, so systemd's default control-group kill would
 * SIGKILL every live subshell on any stop/restart (same failure observed
 * 2026-09-01/03 on the server unit). The panes are stateful daemons by
 * design — the connect-time `subshells_report` re-adopts them after a daemon
 * restart — so only the main process is a kill target.
 */
function systemdUnit(exec: string, pathEnv?: string): string {
  // systemd user units get a stock PATH (`/usr/bin:/bin:…`), NOT the
  // installer's shell PATH — so a tmux from Homebrew/Nix that made the enroll
  // preflight pass would be "not found" when the service starts the daemon.
  // Baking the installing shell's PATH (when supplied) keeps preflight and
  // runtime agreeing. Omitted when absent → the historical byte-exact unit.
  const environment = pathEnv ? `Environment=PATH=${systemdQuote(pathEnv)}\n` : "";
  return `[Unit]
Description=subshell (subshell node daemon)
After=network-online.target
Wants=network-online.target

[Service]
${environment}ExecStart=${exec}
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
 * launchd plist body: keep-alive agent logging to ~/Library/Logs/subshell.log.
 *
 * `AssociatedBundleIdentifiers=<client bundle id>` is what makes System
 * Settings → Login Items label this job "Subshell Client" with the app's icon
 * instead of the SIGNING ORGANIZATION (launchd.plist(5)); inert-but-correct
 * where the app is not installed.
 */
function launchdPlist(args: string[], logPath: string, pathEnv?: string): string {
  const argLines = args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
  // launchd also starts agents with a stock PATH, so a Homebrew tmux
  // (`/opt/homebrew/bin`, Apple Silicon) that passed the enroll preflight is
  // "not found" when the agent runs. Bake the installing shell's PATH.
  // Omitted when absent → the historical byte-exact plist.
  const envBlock = pathEnv
    ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>${xmlEscape(pathEnv)}</string>\n\t</dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>AssociatedBundleIdentifiers</key>
\t<array>
\t\t<string>${DESKTOP_CLIENT_BUNDLE_ID}</string>
\t</array>
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

const errLine = (msg: string): CliResult => ({ code: 1, out: "", err: `subshell: ${msg}\n` });

/** Collapse command stderr into one quotable line (trailing newline, no blank runs). */
const oneLine = (s: string): string => s.trim().replace(/\s*\n\s*/g, " ");

/** The operator-facing one-liner from a failed service-manager command (stderr first — that is where systemctl/launchctl explain themselves). */
const cmdDetail = (r: { out: string; err: string }): string => oneLine(r.err) || oneLine(r.out) || "no output";

/** Install refuses to touch the machine before the node is enrolled; uninstall deliberately does NOT (see {@link uninstallService}). */
const NO_CONFIG = "no config found: run subshell enroll first";

const unsupported = (action: string, platform: string): string =>
  `service ${action} is not supported on '${platform}': no per-user service manager here; ` +
  "run `subshell run` in a terminal (e.g. inside tmux/screen) to keep the daemon up for now";

/**
 * Whether launchd is refusing because the label is still in the domain.
 *
 * `bootout` is not synchronous: it returns while the job is still being torn
 * down, and a `bootstrap` of the same label in that window answers EIO —
 * rendered as "Bootstrap failed: 5: Input/output error", which names a disk
 * problem and is nothing of the kind.
 */
function domainBusy(run: { code: number; err: string; out: string }): boolean {
  return run.code === 5 || /Input\/output error/i.test(`${run.err}${run.out}`);
}

/**
 * How long to keep trying, and how often — 30 seconds at half-second
 * intervals. The server CLI's twin carries the reasoning: the only
 * measurement is "ninety seconds later", an upper bound rather than a
 * duration, so a tidy-looking budget risks leaving the fix inert on the case
 * that produced it.
 */
const BOOTSTRAP_ATTEMPTS = 60;
const BOOTSTRAP_RETRY_MS = 500;

/**
 * Bootstrap the plist, waiting out a domain that is still busy.
 *
 * The server CLI carries the same helper for the same reason, measured there
 * on 2026-09-12: a reset followed by a fresh setup died on exit 5 while
 * nothing was wrong with the plist, and the same command by hand ninety
 * seconds later worked. Only a BUSY answer is retried; launchd also answers
 * EIO for some malformed plists, so those pay the budget before reporting its
 * own words.
 */
async function bootstrapWithRetry(
  deps: ServiceDeps,
  path: string,
): Promise<{ code: number; out: string; err: string }> {
  let run = await deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS && run.code !== 0 && domainBusy(run); attempt++) {
    await (deps.sleep ?? ((ms: number) => Bun.sleep(ms)))(BOOTSTRAP_RETRY_MS);
    run = await deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  }
  return run;
}

/**
 * Install the per-user service and start it. Linux: write the unit, then
 * `daemon-reload` + `enable --now` — a failed reload (typically the classic
 * "Failed to connect to bus" without a systemd user subshell) aborts with the
 * systemctl stderr quoted; the unit file is deliberately left on disk.
 * macOS: write the plist, `bootout` the previous load when reinstalling
 * (failure tolerated — it usually means "not loaded"), then `bootstrap`.
 *
 * `opts.autostart` (default TRUE — what every caller before it got) decides
 * only what happens at the NEXT login: the service is started now either way.
 * Ported from the server CLI, which solved the same question first; the two
 * platforms express it differently, and the darwin half is why
 * {@link sessionPlistPath} exists.
 */
export async function installService(deps: ServiceDeps, opts: { autostart?: boolean } = {}): Promise<CliResult> {
  const autostart = opts.autostart !== false;
  if (!(await deps.hasConfig())) return errLine(NO_CONFIG);

  if (deps.platform === "linux") {
    const path = unitPath(deps.home);
    await deps.writeFile(path, systemdUnit(systemdExecStart(execLine(deps)), deps.servicePath));
    const reload = await deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    if (reload.code !== 0) {
      return errLine(
        `systemctl --user daemon-reload failed (exit ${reload.code}): ` +
          `${cmdDetail(reload)}; the unit file was left at ${path}; ` +
          "this usually means no systemd user subshell is running (container/SSH without loginctl)",
      );
    }
    // `enable --now` when it starts at login; plain `start` when it does not.
    //
    // The `disable` first is NOT redundant on a REINSTALL: `enable` writes a
    // symlink into `default.target.wants`, and re-installing over an
    // already-enabled unit leaves that symlink in place — so `UnitFileState`
    // stays `enabled`, the agent DOES come back at login, and the success line
    // below claims the opposite. Darwin has the symmetric rule (it removes the
    // other plist); this is Linux's. Tolerated on failure: an already-disabled
    // unit exits 0 anyway, and a unit that cannot be disabled is one the
    // `start` below will report on.
    if (!autostart) await deps.runCmd(["systemctl", "--user", "disable", SYSTEMD_UNIT_NAME]);
    const argv = autostart
      ? ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]
      : ["systemctl", "--user", "start", SYSTEMD_UNIT_NAME];
    const enable = await deps.runCmd(argv);
    if (enable.code !== 0) {
      return errLine(
        `${argv.slice(0, -1).join(" ")} ${SYSTEMD_UNIT_NAME} failed (exit ${enable.code}): ` + `${cmdDetail(enable)}`,
      );
    }
    // The unit is enabled, so it comes back at LOGIN — which on a machine
    // nobody logs in to is never. Ask logind whether this user already lingers
    // rather than printing the remedy at someone who has applied it. `null`
    // (no loginctl, no bus) still prints: the advice costs nothing when the
    // answer is unknown and is the whole point when it is `false`.
    const linger = await queryLinger(deps);
    return {
      code: 0,
      out:
        `Installed ${path}; subshell is ${autostart ? "enabled and running" : "running (not enabled at login)"}.\n` +
        // The linger hint qualifies LOGIN start, so it is pointless beside a
        // unit that was deliberately not armed for it.
        (linger === true || !autostart
          ? ""
          : "To keep it alive across logout, enable lingering: loginctl enable-linger $USER\n"),
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    // The plist's LOCATION is what decides login behaviour (see
    // `sessionPlistPath`). Write the one this install asked for, and remove
    // the other so exactly one definition exists — a leftover in the login
    // directory would quietly re-arm autostart on the next reboot.
    const path = autostart ? plistPath(deps.home) : sessionPlistPath(deps.configDir);
    const other = autostart ? sessionPlistPath(deps.configDir) : plistPath(deps.home);
    await deps.writeFile(path, launchdPlist(execLine(deps), launchLogPath(deps.home), deps.servicePath));
    if (await deps.fileExists(other)) await deps.removeFile(other);
    // ALWAYS, not only when the plist was already there. The authority on
    // "is this label loaded" is launchd, and the file is only a proxy for it —
    // a proxy that lies after a reset, which deletes the plist while the job
    // is still in the domain. Tolerated either way: bootout on a not-loaded
    // service errors, and the bootstrap below carries the definition.
    await deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    const boot = await bootstrapWithRetry(deps, path);
    if (boot.code !== 0) {
      return errLine(
        `launchctl bootstrap failed (exit ${boot.code}): ${cmdDetail(boot)}; ` + `the plist was left at ${path}`,
      );
    }
    return {
      code: 0,
      out:
        `Installed ${path}; subshell is registered with launchd and running` +
        `${autostart ? "" : " (not at login)"}.\n`,
      err: "",
    };
  }

  return errLine(unsupported("install", deps.platform));
}

/**
 * Turn "starts at login" on or off for an ALREADY-INSTALLED service, WITHOUT
 * touching the running process (the node's day-2 toggle for the same fact the
 * first run's start-up screen asks once — a port of the server CLI's
 * {@link setAutostart} twin, spec 2026-09-22 rails addendum).
 *
 * That last clause is the contract, and it is why this is not another arm of
 * `controlService`: an operator toggling a preference about the NEXT login
 * must not discover that their node went down. So Linux gets
 * `enable`/`disable` with no `--now` — and with `--no-reload`, which the
 * server's twin does not pass: the unit's CONTENTS are not changing here,
 * only its wants symlink, so the daemon's copy has nothing to reread, and a
 * reload is a conversation this act has no business starting. On darwin the
 * plist MOVES between the login directory and the session one — the loaded
 * job does not care where its definition came from, so nothing restarts.
 *
 * Refuses when nothing is installed, in the same words `controlService`
 * uses: there is no definition to arm, and writing one here would make this
 * a way to install a service whose enrolled config was never checked.
 *
 * @param deps - the service seams (the same {@link ServiceDeps} every other
 *   verb runs through)
 * @param enabled - `true` arms login start, `false` disarms it
 */
export async function setAutostart(deps: ServiceDeps, enabled: boolean): Promise<CliResult> {
  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    return errLine(unsupported(enabled ? "enable" : "disable", deps.platform));
  }
  const state = await queryService(deps);
  if (!state.installed) {
    return errLine(
      `nothing installed: no service definition at ${state.definitionPath} (run \`subshell service install\` first)`,
    );
  }
  const done = (): CliResult => ({
    code: 0,
    out: `subshell ${enabled ? "will start at login" : "will no longer start at login"}.\n`,
    err: "",
  });

  if (deps.platform === "linux") {
    // No `--now`: `enable --now` would START a stopped node and `disable
    // --now` would STOP a running one, and neither is what was asked for.
    // `uninstall` is where `disable --now` belongs.
    const verb = enabled ? "enable" : "disable";
    const res = await deps.runCmd(["systemctl", "--user", verb, "--no-reload", SYSTEMD_UNIT_NAME]);
    if (res.code !== 0) {
      return errLine(`systemctl --user ${verb} ${SYSTEMD_UNIT_NAME} failed (exit ${res.code}): ${cmdDetail(res)}`);
    }
    return done();
  }

  // darwin: move the definition. WRITE FIRST, then remove — a failed write
  // must leave the service exactly as it was rather than unregistered from
  // both places, which is a machine with no definition at all. (The server
  // twin's measured ordering, kept verbatim.)
  const from = await darwinDefinition(deps);
  if (from.enabled === enabled) return done(); // already there; moving it would be a no-op with a risk
  const to = enabled ? plistPath(deps.home) : sessionPlistPath(deps.configDir);
  const text = await deps.readFile(from.path);
  if (text === null) return errLine(`could not read the service definition at ${from.path}`);
  try {
    await deps.writeFile(to, text);
    await deps.removeFile(from.path);
  } catch (err) {
    return errLine(
      `could not move the service definition to ${to}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return done();
}

/**
 * Remove the per-user service. Unlike install, this NEVER gates on
 * {@link ServiceDeps.hasConfig}: deleting the config is the de-facto unenroll,
 * and a guard here would strand an enabled unit (Restart=always) with no way
 * to take it down. With no config we still run the full disable/remove
 * sequence and note in stdout that there is nothing else to clean up. Missing
 * unit/plist is not an error: exit 0, "nothing installed", and not a single
 * command runs. Command failures on teardown are reported (exit 1) but the
 * file is still removed — a stuck `disable --now` (unit loaded but broken)
 * should not leave the definition behind to haunt the next install.
 */
export async function uninstallService(deps: ServiceDeps): Promise<CliResult> {
  // The note rides every success line when the config is gone; error paths
  // keep their message about the actual failure.
  const noConfigNote = (await deps.hasConfig()) ? "" : "(no agent config found, nothing else to clean up)\n";

  if (deps.platform === "linux") {
    const path = unitPath(deps.home);
    if (!(await deps.fileExists(path))) {
      return { code: 0, out: `nothing installed: no systemd user unit at ${path}\n${noConfigNote}`, err: "" };
    }
    const disable = await deps.runCmd(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
    const reload = await deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    await deps.removeFile(path);
    if (disable.code !== 0 || reload.code !== 0) {
      const failed = disable.code !== 0 ? disable : reload;
      const label = disable.code !== 0 ? "disable --now" : "daemon-reload";
      return errLine(
        `systemctl --user ${label} failed (exit ${failed.code}): ` +
          `${cmdDetail(failed)}; the unit file was removed anyway`,
      );
    }
    return {
      code: 0,
      out: `Removed ${path}; subshell is stopped and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    const found = await darwinDefinition(deps);
    if (!found.installed) {
      return { code: 0, out: `nothing installed: no launchd plist at ${found.path}\n${noConfigNote}`, err: "" };
    }
    const path = found.path;
    const unload = await deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    await deps.removeFile(path);
    // BOTH, always. `darwinDefinition` reports only the winner, and a machine
    // carrying two definitions (a hand-copy, or a crash between the install's
    // write and remove) must not come out of uninstall with the loser still
    // sitting in the login directory, ready to start an agent the operator
    // believes they removed.
    const loser = path === plistPath(deps.home) ? sessionPlistPath(deps.configDir) : plistPath(deps.home);
    if (await deps.fileExists(loser)) await deps.removeFile(loser);
    if (unload.code !== 0) {
      return errLine(
        `launchctl bootout reported (exit ${unload.code}): ${cmdDetail(unload)}; the plist was removed anyway`,
      );
    }
    return {
      code: 0,
      out: `Removed ${path}; subshell is unloaded and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  return errLine(unsupported("uninstall", deps.platform));
}

/**
 * Build the real-{@link ServiceDeps} wiring: the live environment for identity
 * fields, `Bun.spawn` for `runCmd`, `node:fs/promises` for the file effects.
 * `hasConfig` is a PARAMETER, not imported here: the config check is wired by
 * the CLI (`loadConfig()` resolves), keeping this module free of config imports
 * so unit tests stay fs-stub-pure.
 */

export function DEFAULT_DEPS(hasConfig: () => Promise<boolean>): ServiceDeps {
  return {
    platform: process.platform,
    home: homedir(),
    // A PATH from `config.ts`, never a read of the config itself — the
    // hasConfig() ruling above is about loading, and this module still loads
    // nothing.
    configDir: clientHome(),
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    argv1: process.argv[1] ?? "",
    hasConfig,
    async runCmd(cmd) {
      // OUTSIDE the try: the catch below would turn this refusal into a
      // `spawn failed` 127 and hide it as a missing manager binary.
      assertManagerCommandUnderTest(cmd);
      try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        // Typed `number`, but a signal-killed/never-started child can still
        // surface null — treat it as failure(ish) so callers quote whatever
        // output came back, rather than letting it read as a clean exit 0.
        const exited: number | null = await proc.exited;
        return { code: exited === null ? 1 : exited, out, err };
      } catch (err) {
        // A missing manager binary (no systemctl/launchctl on PATH) surfaces
        // as a spawn THROW, not an exit code — report it as a failed command
        // so `queryService` degrades to `unknown` and `service status`, which
        // must always exit 0, still answers with a state instead of a stack.
        return { code: 127, out: "", err: `spawn failed: ${(err as Error).message}` };
      }
    },
    // The unit/plist directories (~/.config/systemd/user, ~/Library/LaunchAgents)
    // are ours to create; mkdir-recursive first so a fresh box installs cleanly.
    async writeFile(path, text) {
      assertServiceWriteUnderTest(path);
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, text, "utf8");
    },
    async removeFile(path) {
      assertServiceWriteUnderTest(path);
      await rm(path, { force: true });
    },
    // Same guard as the two above: a chmod of a real `~/Library/Logs` file
    // while a suite runs is the same class of incident as writing a real
    // plist, and the daemon's own start path reaches this seam.
    async chmodFile(path, mode) {
      assertServiceWriteUnderTest(path);
      await chmod(path, mode);
    },
    async fileExists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(path) {
      try {
        return await fsReadFile(path, "utf8");
      } catch {
        return null;
      }
    },
    // The installing shell's PATH, baked into the unit/plist so the daemon
    // finds the same tmux the enroll preflight found (see ServiceDeps).
    servicePath: process.env.PATH,
  };
}

/**
 * Manager verbs `service` accepts beyond install/uninstall. Ported from
 * `apps/server/api/src/service.ts` (2026-09-05) — same guard, same vocabulary,
 * async here because this module's seams are async by design.
 */
export type ServiceVerb = "start" | "stop" | "restart";

/** The runtime list beside the type — cli.ts validates argv against THIS, so the two cannot drift. */
export const SERVICE_VERBS: readonly ServiceVerb[] = ["start", "stop", "restart"];

/** Narrow an arbitrary argv word to a {@link ServiceVerb}. */
export function isServiceVerb(word: string): word is ServiceVerb {
  return (SERVICE_VERBS as readonly string[]).includes(word);
}

/** The service manager's view of the unit. `unknown` means the manager answered in a shape we do not parse. */
export type ServiceRunState = "running" | "stopping" | "stopped" | "not-installed" | "unknown";

/**
 * Whether taking the daemon DOWN — stop, restart, or uninstall — leaves live
 * panes running.
 *
 * `unknown` is not a shrug: the definition exists but could not be read or the
 * manager could not be asked, so the destructive verbs fail CLOSED on it. Only
 * a positive `keeps` clears them.
 */
export type PaneSafety = "keeps" | "kills" | "unknown";

/**
 * What {@link queryService} could learn about the installed service WITHOUT
 * starting anything. Every field is either a fact read off disk or a fact the
 * platform's manager reported — nothing here is inferred from `daemon.lock`,
 * which `subshell status` reads and which answers a different question ("is a
 * daemon process alive", which may be a foreground `subshell run`).
 */
export interface ServiceState {
  /** Whether a unit/plist exists on disk. The DEFINITION question. */
  installed: boolean;
  /** Where that definition lives (or would), `null` on a platform with no per-user manager. */
  definitionPath: string | null;
  /**
   * The daemon's own log FILE where the platform has one (the launchd plist
   * names it), `null` on Linux, where the systemd user unit redirects nothing
   * and the output is in the journal. A consumer (the desktop app) reveals
   * this rather than re-deriving a platform path it does not own.
   */
  logPath?: string | null;
  /** The manager's view of the process. */
  state: ServiceRunState;
  /** Main PID when the manager reports one, else `null`. */
  pid: number | null;
  /** Whether it starts at login (systemd `UnitFileState`; launchd `RunAtLoad` OR `KeepAlive`). `null` when unknown. */
  enabled: boolean | null;
  /**
   * The same "starts at login" fact, spelled for the consumer that ARMS and
   * DISARMS it: {@link setAutostart} on this CLI, and Subshell Client's
   * run-at-login switch on the probe (spec 2026-09-22 rails addendum — the
   * day-2 toggle the server's `setAutostart` always had and this side did not).
   *
   * Today it is one derivation with {@link enabled} on both platforms (the
   * systemd `UnitFileState`, the plist's directory), and it is deliberately
   * not collapsed into it: `enabled` is a manager reading, this is the name of
   * the act, and a control deciding which way to point a switch should read
   * the word that says what pressing it does. `null` exactly where
   * {@link enabled} is: nothing installed, or the manager would not answer.
   */
  autostart: boolean | null;
  /**
   * Linux only: whether this machine's OS user LINGERS
   * (`loginctl enable-linger`).
   *
   * An enabled `--user` unit comes back at LOGIN and dies at LOGOUT unless the
   * user lingers, in which case it comes back at BOOT. That is a different
   * question from {@link enabled} rather than a refinement of it, and on a
   * headless node it is the one that decides whether the agent is there.
   *
   * `null` on macOS (launchd has no equivalent knob — a LaunchAgent's lifetime
   * IS the login session by design), when nothing is installed, and when
   * logind did not answer.
   */
  linger: boolean | null;
  /**
   * launchd only: whether the job is BOOTSTRAPPED in `gui/<uid>` — the fact
   * `launchctl print` states by exiting 0 at all. It is NOT the run state: a
   * job can be loaded and idle (no pid), and while it stays loaded
   * `KeepAlive`/`RunAtLoad` can start it again and a later `bootstrap` fails
   * with "service already loaded". `stop` therefore gates its no-op on THIS,
   * never on {@link ServiceState.state}. Absent on systemd, whose own `stop`
   * is idempotent.
   */
  loaded?: boolean;
  /**
   * Whether a teardown keeps live panes — `null` only when nothing is installed.
   *
   * Each subshell launched on THIS node runs its tmux server as a CHILD of the
   * daemon, so the answer is one directive and it differs per platform:
   * systemd `KillMode=process` (or `none`) and launchd
   * `AbandonProcessGroup=true`. Without it the default kill takes every pane on
   * this machine with it — on STOP as much as on restart, since a restart is a
   * stop followed by a start.
   *
   * On Linux this is the EFFECTIVE value systemd reports, not a grep of the
   * unit file: drop-ins under `<unit>.d/` and un-reloaded edits both make the
   * file disagree with what `systemctl restart` will actually do.
   */
  paneSafety: PaneSafety | null;
  /** Manager output worth quoting when something answered oddly; empty when it did not. */
  detail: string;
}

/**
 * Where THIS platform's per-user service definition lives (or would live).
 * `null` on platforms without a service manager.
 *
 * Asks the disk on darwin, because there are two legal locations there and
 * only one of them is "starts at login" ({@link sessionPlistPath}) — a reader
 * that named the login path by convention would report a `--no-autostart`
 * install as "nothing installed" while the agent it wrote is running.
 */
async function serviceArtifactPath(
  deps: Pick<ServiceDeps, "platform" | "home" | "configDir" | "fileExists">,
): Promise<string | null> {
  if (deps.platform === "linux") return unitPath(deps.home);
  if (deps.platform !== "darwin") return null;
  return (await darwinDefinition(deps)).path;
}

/**
 * Parse a systemd `ExecStart=` value into argv — the inverse of
 * {@link systemdQuote}, and it must stay its inverse.
 *
 * systemd word-splits the line ITSELF (it is not run through a shell), so a
 * token containing whitespace is double-quoted on the way out and has to be
 * unquoted on the way back. A spaced path is not exotic here: a macOS
 * "Application Support" home, a dev-form `bun …/my dir/main.ts`, a spaced
 * `SUBSHELL_DATA_DIR` all produce one, and a reader that split on spaces would
 * hand the updater a truncated path that does not exist.
 *
 * This is deliberately a SECOND copy of the server's `parseSystemdExec`
 * (`apps/server/api/src/services/installed-binary.ts`) rather than a shared
 * helper: `apps/server/**` is AGPL and this file is Apache-2.0, so an import
 * would entangle the two licences (AGENTS.md, "The licence boundary IS this
 * directory line"). The quoter it inverts is already duplicated for the same
 * reason, and an inverse belongs beside the function it inverts.
 */
export function parseSystemdExec(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let escaped = false;
  let started = false;
  for (const ch of line) {
    if (escaped) {
      cur += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (/\s/.test(ch) && !inQuotes) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * What {@link serviceExecArgv} needs — the read-only corner of
 * {@link ServiceDeps}. `configDir` + `fileExists` ride along because on darwin
 * WHICH file is the definition is a question about the disk, not a constant.
 */
export type ServiceExecDeps = Pick<
  ServiceDeps,
  "platform" | "home" | "configDir" | "fileExists" | "readFile" | "runCmd"
>;

/**
 * The argv this machine's INSTALLED service definition names, or `null` when
 * no definition is installed.
 *
 * This is what `update` has to ask before it replaces anything: the manager
 * executes the file named HERE, so any other answer is a file nobody runs.
 *
 * systemd: the LAST `ExecStart=`, which is systemd's own last-wins rule.
 * launchd: `ProgramArguments` through `plutil`, because a plist may legally be
 * binary1 and a text predicate answers confidently and wrongly there — the XML
 * regex survives only as the no-plutil fallback, the same arrangement
 * {@link abandonProcessGroup} uses.
 */
export async function serviceExecArgv(deps: ServiceExecDeps): Promise<string[] | null> {
  const path = await serviceArtifactPath(deps);
  if (path === null) return null;

  if (deps.platform === "linux") {
    const text = await deps.readFile(path);
    if (text === null) return null;
    const last = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("ExecStart="))
      .at(-1);
    if (last === undefined) return null;
    const argv = parseSystemdExec(last.slice("ExecStart=".length));
    return argv.length > 0 ? argv : null;
  }

  if (deps.platform !== "darwin") return null;
  const res = await deps.runCmd(["/usr/bin/plutil", "-extract", "ProgramArguments", "json", "-o", "-", path]);
  if (res.code === 0) {
    try {
      const parsed: unknown = JSON.parse(res.out.trim());
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((a) => typeof a === "string")) {
        return parsed as string[];
      }
    } catch {
      // Unparseable output is no answer; fall through to the text reader.
    }
  }
  const text = await deps.readFile(path);
  if (text === null) return null;
  const block = text.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (block === null) return null;
  const argv = [...(block[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
  return argv.length > 0 ? argv : null;
}

/** systemd `show` emits `KEY=value` lines; absent properties come back empty, so "" and "missing" are one case. */
function parseShowProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The systemd kill modes that spare the unit's children.
 * `process` kills only the main process; `none` kills nothing at all.
 */
const PANE_SPARING_KILL_MODES = new Set(["process", "none"]);

/**
 * Fallback pane check for when the manager cannot be asked: grep the unit file.
 *
 * Inferior to `systemctl show` on purpose — it cannot see drop-ins, and a unit
 * edited but not `daemon-reload`ed reads as its file rather than as what would
 * run. Used only when `show` itself failed, where the alternative is `unknown`.
 * Takes the LAST assignment, because systemd's own rule is last-wins.
 */
function killModeFromUnitText(text: string): PaneSafety {
  const matches = [...text.matchAll(/^[ \t]*KillMode[ \t]*=[ \t]*([A-Za-z-]+)/gm)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return "kills"; // absent ⇒ systemd's default control-group
  return PANE_SPARING_KILL_MODES.has(last.toLowerCase()) ? "keeps" : "kills";
}

/**
 * Read `AbandonProcessGroup` out of a launchd plist.
 *
 * Uses `plutil` rather than a regex because the plist may legally be XML
 * (self-closing `<true/>` or long-form `<true></true>`) or binary1 — a
 * text-shaped predicate silently answers "kills" for a binary plist that
 * actually sets the key. The regex survives only as the no-plutil fallback.
 */
async function abandonProcessGroup(deps: ServiceDeps, path: string, text: string | null): Promise<PaneSafety> {
  const res = await deps.runCmd(["plutil", "-extract", "AbandonProcessGroup", "raw", "-o", "-", path]);
  if (res.code === 0) return res.out.trim() === "true" ? "keeps" : "kills";
  // plutil exits non-zero both for "key absent" (a real answer: kills) and for
  // "no plutil"/unreadable (no answer). Only the text tells them apart.
  if (/No value at that key path|invalid key path/i.test(res.err)) return "kills";
  if (text === null) return "unknown";
  return /<key>\s*AbandonProcessGroup\s*<\/key>\s*(<true\s*\/>|<true>\s*<\/true>)/.test(text) ? "keeps" : "kills";
}

/** `launchctl print`'s top-level `state`/`pid` lines sit at ONE tab; nested endpoint blocks repeat `state` deeper. */
function parseLaunchctlPrint(text: string): { running: boolean; pid: number | null } {
  const state = text.match(/^\tstate = (\S+)/m)?.[1];
  const pidRaw = text.match(/^\tpid = (\d+)/m)?.[1];
  const pid = pidRaw === undefined ? null : Number.parseInt(pidRaw, 10);
  return { running: state === "running" || pid !== null, pid: Number.isInteger(pid) && (pid ?? 0) > 0 ? pid : null };
}

/** Assemble the `detail` string from whatever notes a query accumulated. */
const notes = (...parts: (string | null)[]): string => parts.filter((p) => p !== null && p !== "").join("; ");

/**
 * Read-only service state. Never writes, never starts anything, and never
 * throws: an unreachable or missing manager degrades to `unknown` with the
 * reason in {@link ServiceState.detail}, because every caller (`service
 * status`, the desktop app's poll) wants a picture rather than an exception.
 */
export async function queryService(deps: ServiceDeps): Promise<ServiceState> {
  // Set on EVERY return below, including the early ones: a consumer deciding
  // "is there a log file to reveal" needs the answer even when nothing is
  // running, and the platform branch belongs to the CLI, not to the desktop.
  const logPath = deps.platform === "darwin" ? launchLogPath(deps.home) : null;
  const definitionPath = await serviceArtifactPath(deps);
  if (definitionPath === null) {
    return {
      installed: false,
      definitionPath: null,
      logPath,
      state: "not-installed",
      pid: null,
      enabled: null,
      autostart: null,
      linger: null,
      paneSafety: null,
      detail: `no per-user service manager on '${deps.platform}'`,
    };
  }
  if (!(await deps.fileExists(definitionPath))) {
    return {
      installed: false,
      definitionPath,
      logPath,
      state: "not-installed",
      pid: null,
      enabled: null,
      autostart: null,
      linger: null,
      paneSafety: null,
      detail: "",
    };
  }

  return deps.platform === "linux" ? querySystemd(deps, definitionPath) : queryLaunchd(deps, definitionPath);
}

/**
 * Whether the agent's OS user lingers, asked of logind.
 *
 * The argv and the three-way reading of the result come from
 * `@internal/subshell-protocol`, SHARED with the server's twin of this module
 * rather than ported into it like everything else here. The reason is narrow:
 * that reading includes a regex over `loginctl`'s own error wording, and the
 * day it needs correcting, correcting one copy would leave the other quietly
 * answering wrong on exactly the headless machine this fact exists for. WHEN
 * to ask, and what to do with the answer, stay here.
 *
 * @param deps - the service seams (`uid` and `runCmd` are what this uses)
 * @returns the linger fact, or `null` when logind did not answer
 */
async function queryLinger(deps: ServiceDeps): Promise<boolean | null> {
  return lingerFromProbe(await deps.runCmd(lingerProbeArgv(deps.uid)));
}

async function querySystemd(deps: ServiceDeps, definitionPath: string): Promise<ServiceState> {
  // ONE call for every property: separate round trips to systemctl would be
  // separate chances to disagree with each other about the same instant.
  // KillMode rides along because the EFFECTIVE value is the only one that
  // predicts what `systemctl stop` will do to the panes.
  const res = await deps.runCmd([
    "systemctl",
    "--user",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=ActiveState,SubState,UnitFileState,MainPID,KillMode",
  ]);
  if (res.code !== 0) {
    const text = await deps.readFile(definitionPath);
    return {
      installed: true,
      definitionPath,
      logPath: deps.platform === "darwin" ? launchLogPath(deps.home) : null,
      state: "unknown",
      pid: null,
      enabled: null,
      autostart: null,
      // `systemctl show` itself did not answer, so nothing here is worth a
      // second spawn: logind is asked only on the branch where systemd talked.
      linger: null,
      // Degraded but better than nothing: the file cannot see drop-ins, so a
      // `keeps` here is weaker evidence than a `keeps` from `show`.
      paneSafety: text === null ? "unknown" : killModeFromUnitText(text),
      detail: `systemctl --user show failed (exit ${res.code}): ${cmdDetail(res)}`,
    };
  }
  const props = parseShowProperties(res.out);
  const active = props.ActiveState ?? "";
  const unitFileState = props.UnitFileState ?? "";
  const mainPid = Number.parseInt(props.MainPID ?? "0", 10);
  // `activating`/`reloading`/`refreshing` are all documented as ACTIVE: a unit
  // mid-start is not stopped, and reporting it so makes a Start button appear
  // in the middle of a restart. `deactivating` gets its own value rather than
  // collapsing to stopped, which would print the contradiction "stopped (pid N)".
  const state: ServiceRunState =
    active === "active" || active === "activating" || active === "reloading" || active === "refreshing"
      ? "running"
      : active === "deactivating"
        ? "stopping"
        : active === "inactive" || active === "failed" || active === "maintenance"
          ? "stopped"
          : "unknown";
  const killMode = (props.KillMode ?? "").toLowerCase();
  // `enabled-runtime` starts at login too, for this boot. One reading, two
  // names — `enabled` for the manager's view, `autostart` for the arm/disarm
  // act — see `ServiceState.autostart`.
  const enabled = unitFileState === "" ? null : unitFileState.startsWith("enabled");
  // Asked whether or not the unit is enabled: linger is a property of the USER,
  // not of this unit, so it is as true of a machine mid-install as of a running
  // one — and an operator enabling the unit next wants the answer already.
  const linger = await queryLinger(deps);
  return {
    installed: true,
    definitionPath,
    logPath: deps.platform === "darwin" ? launchLogPath(deps.home) : null,
    state,
    pid: Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null,
    enabled,
    autostart: enabled,
    linger,
    paneSafety: killMode === "" ? "unknown" : PANE_SPARING_KILL_MODES.has(killMode) ? "keeps" : "kills",
    detail: notes(
      active === "failed" ? `unit is failed (SubState=${props.SubState ?? "?"})` : null,
      // A masked unit refuses every control verb; say it once here rather than
      // letting the operator discover it one command at a time.
      unitFileState.startsWith("masked") ? `unit is ${unitFileState}: systemctl will refuse start/stop/restart` : null,
    ),
  };
}

async function queryLaunchd(deps: ServiceDeps, definitionPath: string): Promise<ServiceState> {
  const text = await deps.readFile(definitionPath);
  const paneSafety = await abandonProcessGroup(deps, definitionPath, text);
  // WHERE the plist is, not what is in it. Reading `RunAtLoad`/`KeepAlive` was
  // the old answer and `--no-autostart` makes it a lie: every definition this
  // file writes carries both keys, so the key-read would say "starts at login"
  // about the install that deliberately does not. The keys are not decisive on
  // their own either (measured — see `sessionPlistPath`), and the login
  // directory is what launchd actually scans at login — so the path is
  // NECESSARY. It is not, strictly, SUFFICIENT: a hand-written plist sitting in
  // `~/Library/LaunchAgents` with neither key is loaded at login and never
  // started, and this reports it enabled. No definition either app writes looks
  // like that, and `apps/server/api`'s `queryLaunchd` makes the same trade at
  // its own `const enabled` — so the two agree by decision rather than by
  // accident. Tightening it is one `&&` across both files, and belongs in a
  // change about service state rather than one about a first run.
  const enabled = definitionPath === plistPath(deps.home);
  // `launchctl print gui/<uid>/<label>`, NOT the legacy `launchctl list`:
  // `list` resolves an IMPLICIT domain, so over SSH (where the session is
  // "Background", not "Aqua") it reports a running gui/<uid> job as absent —
  // and every write here targets gui/<uid> explicitly. Asking the same domain
  // we write to is the only way the two can agree.
  const logPath = deps.platform === "darwin" ? launchLogPath(deps.home) : null;
  const res = await deps.runCmd(["launchctl", "print", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
  if (res.code !== 0) {
    const why = oneLine(res.err) || oneLine(res.out);
    // Exit 113 / "Could not find service" is the documented not-loaded answer,
    // and with a plist ON DISK that is exactly "installed but stopped" — the
    // state `bootout` leaves behind. ANY other non-zero exit means the
    // manager did not answer, and "stopped" from that is a guess: report
    // unknown and KEEP the output — a manager that would not answer is not
    // the same fact as a daemon that is stopped.
    const notLoaded = res.code === 113 || /could not find service/i.test(why);
    if (!notLoaded) {
      return {
        installed: true,
        definitionPath,
        logPath,
        state: "unknown",
        pid: null,
        enabled,
        autostart: enabled,
        // launchd has no linger equivalent: a LaunchAgent's lifetime IS the
        // login session by design, so there is no fact here to report.
        linger: null,
        loaded: false,
        paneSafety,
        detail: `launchctl print failed (exit ${res.code}): ${why || "no output"}`,
      };
    }
    return {
      installed: true,
      definitionPath,
      logPath,
      state: "stopped",
      pid: null,
      enabled,
      autostart: enabled,
      linger: null,
      loaded: false,
      paneSafety,
      detail: "",
    };
  }
  const { running, pid } = parseLaunchctlPrint(res.out);
  // `print` answered, so the job IS bootstrapped — even when it reports no pid.
  // That is the loaded-but-idle case, which is stopped and loaded at once.
  // The raw launchd state rides along in `detail` verbatim — states are
  // multi-word ("spawn scheduled" is a crash-throttled restart, not a plain
  // stop), which is why this captures the LINE, not a \S+ token.
  const rawState = res.out.match(/^\tstate = (.+)$/m)?.[1]?.trim();
  return {
    installed: true,
    definitionPath,
    logPath,
    state: running ? "running" : "stopped",
    pid,
    enabled,
    autostart: enabled,
    linger: null,
    loaded: true,
    paneSafety,
    detail: running || rawState === undefined ? "" : `launchd: ${rawState}`,
  };
}

/** The remedy for a definition that would take live panes down with it. */
const STALE_DEFINITION = "run `subshell service install` to rewrite the definition, or pass --force";

/** The directive whose absence makes a teardown lethal, per platform. */
const PANE_DIRECTIVE: Record<string, string> = { linux: "KillMode=process", darwin: "AbandonProcessGroup=true" };

/** One sentence naming what a teardown will do to live panes on this host. */
function paneWarning(deps: ServiceDeps, state: ServiceState, verb: ServiceVerb): string {
  const directive = PANE_DIRECTIVE[deps.platform] ?? "the pane-sparing directive";
  return state.paneSafety === "unknown"
    ? `could not determine whether ${verb} keeps live panes: ${state.definitionPath} is unreadable`
    : `${state.definitionPath} predates ${directive}, so ${verb} kills every running subshell's tmux server`;
}

/** Success lines, one per verb — the manager is silent on success, so this is the only feedback. */
export const DONE: Record<ServiceVerb, string> = {
  start: "subshell started.",
  stop: "subshell stopped.",
  restart: "subshell restarted.",
};

/**
 * Drive the platform's service manager for an ALREADY-INSTALLED service.
 *
 * Deliberately narrower than install/uninstall: it refuses when no definition
 * exists rather than writing one, because "start" must never become a way to
 * install a service whose enrolled config was never checked.
 *
 * The pane guard is the reason this exists rather than callers shelling out.
 * This node's subshells run their tmux servers as CHILDREN of the daemon, so a
 * teardown on a definition without the pane-sparing directive SIGKILLs every
 * pane on this machine, and neither `systemctl` nor `launchctl` says so. The
 * two destructive verbs are treated differently on purpose:
 *
 * - `restart` REFUSES without `--force`. Its whole promise is that the daemon
 *   comes back, so silently losing every pane violates what was asked for.
 * - `stop` WARNS and proceeds. The operator asked for it down; refusing would
 *   only push them to `systemctl` — which warns about nothing — and it would
 *   contradict `uninstall`, which deliberately gates on nothing so a stranded
 *   unit can always come down.
 *
 * Both fail CLOSED on `unknown`: an unreadable definition is not evidence of
 * safety.
 */
export async function controlService(
  deps: ServiceDeps,
  verb: ServiceVerb,
  opts: { force?: boolean } = {},
): Promise<CliResult> {
  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    return errLine(unsupported(verb, deps.platform));
  }
  const state = await queryService(deps);
  if (!state.installed) {
    return errLine(
      `nothing installed: no service definition at ${state.definitionPath} (run \`subshell service install\` first)`,
    );
  }
  const lethal = state.paneSafety !== "keeps";
  if (verb === "restart" && lethal && opts.force !== true) {
    return errLine(`refusing to restart: ${paneWarning(deps, state, "restart")}; ${STALE_DEFINITION}`);
  }
  // Rides along on the SUCCESS result: `stop` is not refused, but it must
  // never be silent about what it took down.
  const warning = verb === "stop" && lethal ? `subshell: warning: ${paneWarning(deps, state, "stop")}\n` : "";
  const done = (line: string): CliResult => ({ code: 0, out: `${line}\n`, err: warning });

  if (deps.platform === "linux") {
    // `stop`, never `disable --now`: un-enabling is what uninstall does, and
    // an operator who stops the daemon still expects it back after a reboot.
    const res = await deps.runCmd(["systemctl", "--user", verb, SYSTEMD_UNIT_NAME]);
    if (res.code !== 0) {
      return errLine(`systemctl --user ${verb} ${SYSTEMD_UNIT_NAME} failed (exit ${res.code}): ${cmdDetail(res)}`);
    }
    return done(DONE[verb]);
  }

  // darwin
  const target = `gui/${deps.uid}/${LAUNCHD_LABEL}`;
  if (verb === "stop") {
    // Idempotent like the systemd verb: `bootout` on an unloaded job exits
    // non-zero, which would make a second stop look like a failure. The fact
    // that licenses the no-op is NOT-LOADED, never "not running": a launchd
    // job can be loaded and idle (`print` answers, no pid), and in that state
    // it is still bootstrapped — `KeepAlive`/`RunAtLoad` can start it again
    // and a later `bootstrap` fails with "service already loaded". Gating on
    // the run state reported success on exactly that job and booted out
    // nothing.
    // AND `state === "stopped"`: an UNKNOWN state also carries loaded=false
    // (print never answered, so loadedness is unknown too), and licensing the
    // no-op off that would answer "already stopped" for a daemon running
    // behind a flaky manager — the exact collapse this file just stopped
    // making. On unknown, fall through and let bootout answer.
    if (state.state === "stopped" && state.loaded === false) {
      return { code: 0, out: "subshell is already stopped.\n", err: "" };
    }
    // `bootout`, not a kill: KeepAlive is true, so launchd restarts anything
    // that merely dies. Unloading the job is the only thing that stays stopped.
    const res = await deps.runCmd(["launchctl", "bootout", target]);
    if (res.code !== 0) return errLine(`launchctl bootout failed (exit ${res.code}): ${cmdDetail(res)}`);
    return done(DONE.stop);
  }
  if (verb === "restart") {
    // `kickstart -k` is the documented restart; it needs the job LOADED, so a
    // stopped service is bootstrapped instead.
    if (state.state === "stopped")
      return bootstrapDarwin(deps, target, DONE.restart, warning, state.definitionPath ?? plistPath(deps.home));
    const res = await deps.runCmd(["launchctl", "kickstart", "-k", target]);
    if (res.code !== 0) return errLine(`launchctl kickstart -k failed (exit ${res.code}): ${cmdDetail(res)}`);
    return done(DONE.restart);
  }
  // start
  if (state.state === "running") return { code: 0, out: "subshell is already running.\n", err: "" };
  return bootstrapDarwin(deps, target, DONE.start, warning, state.definitionPath ?? plistPath(deps.home));
}

/**
 * Load a launchd job, falling back to `kickstart -k` when it turns out to be
 * loaded already. `-k` is deliberate: a bare `kickstart` on a job that IS
 * running exits 0 and changes nothing (measured on macOS 26.6.2 — same pid
 * before and after), so a restart would report success having restarted
 * nothing. On a loaded-but-idle job `-k` simply starts it.
 */
async function bootstrapDarwin(
  deps: ServiceDeps,
  target: string,
  done: string,
  warning: string,
  path: string,
): Promise<CliResult> {
  const boot = await deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  if (boot.code === 0) return { code: 0, out: `${done}\n`, err: warning };
  const kick = await deps.runCmd(["launchctl", "kickstart", "-k", target]);
  if (kick.code !== 0) {
    // Exit 5 is launchd's generic EIO: already-bootstrapped, a disabled
    // service and an unreadable plist all land here, so name the candidates
    // rather than asserting one.
    return errLine(
      `launchctl bootstrap failed (exit ${boot.code}): ${cmdDetail(boot)}; ` +
        `kickstart also failed (exit ${kick.code}): ${cmdDetail(kick)}: the plist may be invalid, ` +
        `or the service disabled (launchctl enable ${target})`,
    );
  }
  return { code: 0, out: `${done}\n`, err: warning };
}

/**
 * The human-readable `service status` view — the same facts as the `--json`
 * body, in the aligned key = value shape `subshell status` already uses.
 * Returns lines WITHOUT trailing newlines; the caller joins them.
 */
export function serviceStateLines(state: ServiceState): string[] {
  if (state.definitionPath === null) {
    return ["service              = n/a (no per-user service manager on this platform)"];
  }
  if (!state.installed) {
    return [
      `service              = not installed (${state.definitionPath})`,
      "run `subshell service install` to background the daemon",
    ];
  }
  const lines = [
    `service              = definition installed (${state.definitionPath})`,
    `state                = ${state.state}${state.pid !== null ? ` (pid ${state.pid})` : ""}`,
    `starts at login      = ${state.enabled === null ? "unknown" : state.enabled ? "yes" : "no"}`,
  ];
  // Systemd only, and decided from the definition rather than from the
  // platform: launchd has no linger concept, so a line about it on a mac would
  // be a question the manager cannot be asked.
  if (state.definitionPath.endsWith(SYSTEMD_UNIT_NAME)) {
    // Shared with the server's own `service status`, which answers the same
    // question about the same mechanism: two spellings of it is the kind of
    // drift nobody notices and everybody reconciles later.
    lines.push(`survives logout      = ${lingerVerdict(state.linger)}`);
  }
  // The one line an operator cannot get out of systemctl/launchctl, and the
  // one that decides whether stopping or restarting here costs them every live
  // pane on this node.
  const pane =
    state.paneSafety === "keeps"
      ? "yes"
      : state.paneSafety === "kills"
        ? "NO: this definition predates the fix; reinstall it before stopping or restarting"
        : "unknown: the definition could not be read";
  lines.push(`teardown keeps panes = ${pane}`);
  if (state.detail !== "") lines.push(`detail               = ${state.detail}`);
  return lines;
}
