import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DESKTOP_SERVER_BUNDLE_ID } from "@internal/subshell-protocol";
import { type TmuxOffer, tmuxPreflight } from "@/commands/configure.js";

/**
 * `subshell-server service install|uninstall` — background the control plane
 * with the platform's per-user service manager: a systemd **user** unit on
 * Linux, a launchd agent plist on macOS. The direct mirror of
 * `apps/node/agent/src/service.ts` (same deps-injection discipline, same
 * "tests pin the exact unit/plist text + command sequences" property) with
 * one deliberate structural difference: EVERYTHING here is SYNCHRONOUS.
 * That is not style — the CLI entry (cli.ts invariant 1) forbids a handled
 * command from suspending before `process.exit`, so where the client awaits
 * `Bun.spawn` and `fs/promises`, this module uses `Bun.spawnSync` and the
 * sync fs API and returns {@link CliResult} values directly.
 *
 * One further divergence, added 2026-09-05 and deliberately SERVER-ONLY for
 * now: {@link queryService}/{@link controlService} (the manager-state read and
 * the start/stop/restart drivers, with the live-pane guard). `apps/node/agent`'s
 * unit carries the same tmux-child hazard and should grow the same surface,
 * but the node daemon has no UI asking for it yet and the agent's async
 * shape means the port is not a copy-paste.
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
   * Read a file's text, or `null` when it is absent/unreadable. Added for
   * {@link queryService}, which must inspect the INSTALLED definition (not the
   * one this process would write) to answer whether a restart keeps panes.
   */
  readFile(path: string): string | null;
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
   * Pause between bootstrap attempts, in milliseconds (production:
   * `Bun.sleepSync`). Injected so the retry below costs a test nothing.
   */
  sleep?: (ms: number) => void;
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
/**
 * launchd label (plist: `~/Library/LaunchAgents/<label>.plist`) — the SAME
 * string as the Subshell Server app's bundle identifier and the plist's
 * `AssociatedBundleIdentifiers` entry, pinned together by the shared protocol
 * constant: if the label drifted from the app identity the Login-Items
 * attribution would detach silently and nothing would error.
 */
export const LAUNCHD_LABEL = DESKTOP_SERVER_BUNDLE_ID;

const unitPath = (home: string) => join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
/**
 * The plist for a service that must NOT start at login — the same document,
 * kept where launchd does not look (spec 2026-09-12 server-supervision § 3.2).
 *
 * **On macOS "starts at login" is the file's LOCATION, not a key inside it**,
 * and the two flag-shaped alternatives are both wrong for this job:
 *
 * - `RunAtLoad=false` does not stop it. The plist also carries
 *   `KeepAlive=true`, which starts a job when it is loaded regardless.
 *   MEASURED on macOS 26.6.2 (2026-09-12): a throwaway agent with
 *   `RunAtLoad=false` + `KeepAlive=true` reported `state = running, runs = 1`
 *   two seconds after `bootstrap`, while the same agent without `KeepAlive`
 *   reported `runs = 0`. Switching `KeepAlive` to its dictionary form to
 *   dodge that would break restart-by-exit, which `performRestart` relies on.
 * - `launchctl disable gui/<uid>/<label>` does not work either: a disabled
 *   service refuses `bootstrap`, so "running now but not at login" cannot be
 *   expressed at all — and the disabled mark lives in launchd's per-uid
 *   override database, survives `service uninstall`, and makes the next fresh
 *   install fail with the generic EIO that `bootstrapDarwin` already has to
 *   apologise for.
 *
 * What launchd does document is that it auto-loads exactly the plists in
 * `~/Library/LaunchAgents` at login. So a definition kept anywhere else runs
 * only when something bootstraps it explicitly, which is precisely the
 * behaviour wanted — and it is one `writeFile`/`removeFile` pair to move
 * between the two states, with a running job entirely unaffected (launchd
 * holds the loaded job, not the file).
 */
const sessionPlistPath = (configDir: string) => join(configDir, `${LAUNCHD_LABEL}.plist`);
/** NOTE: deliberately distinct from the agent's `~/Library/Logs/subshell.log`. */
const serverLogPath = (home: string) => join(home, "Library", "Logs", "subshell-server.log");

/**
 * The darwin plist path that EXISTS, and what its location means.
 *
 * Exactly one of the two should ever be present; when both are (a bug, or a
 * hand-edit), the login path wins and the caller is expected to tidy — which
 * is what {@link installService} and {@link uninstallService} do.
 */
function darwinDefinition(deps: Pick<ServiceDeps, "home" | "configDir" | "fileExists">): {
  path: string;
  installed: boolean;
  /** `true` = in `~/LaunchAgents` (starts at login); `false` = the session path; `null` = neither exists. */
  enabled: boolean | null;
} {
  const login = plistPath(deps.home);
  if (deps.fileExists(login)) return { path: login, installed: true, enabled: true };
  const session = sessionPlistPath(deps.configDir);
  if (deps.fileExists(session)) return { path: session, installed: true, enabled: false };
  // Nothing installed: name where it WOULD live, which is the login path,
  // because that is where a plain `service install` puts it.
  return { path: login, installed: false, enabled: null };
}

/**
 * Where THIS platform's per-user service definition lives (or would live).
 * `null` on platforms without a service manager. Exported for the `status`
 * command's cheap existsSync line — existence is a definition-on-disk check,
 * not a running check (the port probe covers liveness).
 *
 * `configDir` is REQUIRED, and that is the point: on darwin it is where a
 * not-at-login definition lives (see {@link sessionPlistPath}), so a caller
 * that omitted it would report an installed-but-disabled service as absent —
 * a wrong answer that reads as "your service vanished" and that no type check
 * would have caught. Both callers have one in hand.
 */
export function serviceArtifactPath(
  platform: NodeJS.Platform,
  home: string,
  configDir: string,
  fileExists: (path: string) => boolean = (p) => existsSync(p),
): string | null {
  if (platform === "linux") return unitPath(home);
  if (platform !== "darwin") return null;
  return darwinDefinition({ home, configDir, fileExists }).path;
}

/**
 * The argv the service manager should run. Compiled binary (basename starts
 * with `subshell`): the binary ALONE — the server boots from a bare
 * `subshell-server` invocation (the systemd no-subcommand boot contract),
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
 * `~/Library/Logs/subshell-server.log` (its own file — the agent's is
 * `subshell.log`). No SUBSHELL_* exports belong here — config.env is loaded
 * by the binary itself — but two placement keys do:
 *
 * - `WorkingDirectory=<config home>` — launchd starts agents with cwd `/`,
 *   so a relative `DATABASE_PATH` (or Bun's cwd-based `.env` lookup) resolves
 *   against the root filesystem. Measured 2026-09-07: `./data/subshell.db`
 *   became `/data/subshell.db`, and the agent crash-looped on launchd's
 *   respawn throttle. The systemd unit sets its own `WorkingDirectory=` for
 *   the same reason; the plist now mirrors it.
 * - `AssociatedBundleIdentifiers=<app bundle id>` — without it System
 *   Settings attributes this legacy LaunchAgent to the SIGNING ORGANIZATION
 *   (launchd.plist(5); Apple's ServiceManagement migration notes), so a GUI
 *   user sees "Disaresta, LLC" with a generic icon where they look for
 *   "Subshell Server". Inert where the app is not installed.
 */
function launchdPlist(args: string[], logPath: string, configDir: string, pathEnv?: string): string {
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
\t<key>AssociatedBundleIdentifiers</key>
\t<array>
\t\t<string>${xmlEscape(DESKTOP_SERVER_BUNDLE_ID)}</string>
\t</array>
\t<key>ProgramArguments</key>
\t<array>
${argLines}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(configDir)}</string>
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
const NO_CONFIG = "no config.env: run subshell-server init first";

const unsupported = (action: string, platform: string): string =>
  `service ${action} is not supported on '${platform}': no per-user service manager here; ` +
  "run `subshell-server` in a terminal (e.g. inside tmux/screen), or background it with: " +
  "nohup subshell-server >subshell-server.log 2>&1 &";

/** Linux install guards that run BEFORE any write or manager command. */
function systemdGuards(deps: ServiceDeps): CliResult | null {
  // The user instance is where this unit lives — no XDG_RUNTIME_DIR means no
  // D-Bus to talk to.
  if (!deps.env.XDG_RUNTIME_DIR) {
    return errLine(
      "no XDG_RUNTIME_DIR: no systemd user session here; run `subshell-server` in a terminal " +
        "(e.g. inside tmux/screen) instead",
    );
  }
  // Reachability probe: the
  // classic "Failed to connect to bus" answers HERE, as a refusal with
  // nothing written — unlike the client (which learns it from a failing
  // daemon-reload AFTER the unit landed on disk).
  const probe = deps.runCmd(["systemctl", "--user", "is-system-running"]);
  if (probe.code !== 0) {
    return errLine(
      `the systemd user instance is not reachable (systemctl --user is-system-running exited ${probe.code}: ` +
        `${cmdDetail(probe)}); this usually means no systemd user session (container, or SSH without a login)`,
    );
  }
  return null;
}

/**
 * Whether launchd is refusing because the label is still in the domain.
 *
 * `bootout` is not synchronous: it returns while the job is still being torn
 * down, and a `bootstrap` of the same label in that window answers EIO —
 * rendered as "Bootstrap failed: 5: Input/output error", which names a disk
 * problem and is nothing of the kind. Matched on the CODE, with the text as a
 * second signal, because the wording is Apple's to change.
 */
function domainBusy(run: { code: number; err: string; out: string }): boolean {
  return run.code === 5 || /Input\/output error/i.test(`${run.err}${run.out}`);
}

/**
 * How long to keep trying, and how often.
 *
 * 30 seconds at half-second intervals, not the 2.5s this started as. The one
 * measurement available is a report that the same command worked "ninety
 * seconds later", which is an upper bound rather than a duration — so a
 * budget picked to look tidy would have left the fix inert on the very case
 * that produced it, with the identical exit-5 message. A teardown is
 * whatever a server with live panes takes; waiting is cheap, and a person
 * watching an install would rather it take twenty seconds than fail.
 *
 * The ceiling is still a ceiling: a genuinely bad plist answers EIO too, so
 * it costs this long before reporting launchd's own words.
 */
const BOOTSTRAP_ATTEMPTS = 60;
const BOOTSTRAP_RETRY_MS = 500;

/**
 * Bootstrap the plist, waiting out a domain that is still busy.
 *
 * Reported on 2026-09-12: a reset (which stops the server, boots the job out
 * and deletes the plist) followed by a fresh setup answered "launchctl
 * bootstrap failed (exit 5): Input/output error", and the same command run by
 * hand ninety seconds later succeeded. Nothing was wrong with the plist, the
 * binary or the paths — the previous job was simply still leaving, and a
 * server with live panes takes its time about it.
 *
 * Only a BUSY answer is retried, and "busy" is launchd's EIO — which it also
 * returns for some malformed plists, so those pay the full budget before
 * reporting. They still report launchd's own words; they are no longer
 * immediate, and the changeset says so rather than claiming otherwise.
 */
function bootstrapWithRetry(deps: ServiceDeps, path: string): { code: number; out: string; err: string } {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  let run = deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS && run.code !== 0 && domainBusy(run); attempt++) {
    sleep(BOOTSTRAP_RETRY_MS);
    run = deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  }
  return run;
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
export function installService(deps: ServiceDeps, opts: { autostart?: boolean } = {}): CliResult {
  const autostart = opts.autostart !== false;
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
          `${cmdDetail(reload)}; the unit file was left at ${path}; ` +
          "this usually means no systemd user subshell is running (container/SSH without loginctl)",
      );
    }
    // `enable --now` when it starts at login; plain `start` when it does not.
    //
    // The `disable` first is NOT redundant, and leaving it out was a real
    // defect: `enable` writes a symlink into `default.target.wants`, and
    // re-installing over an already-enabled unit leaves that symlink in
    // place — so `UnitFileState` stays `enabled`, the server DOES come back
    // at login, and the success line below claims the opposite. Darwin has
    // the symmetric rule (it removes the other plist); this is Linux's.
    // Tolerated on failure: an already-disabled unit exits 0 anyway, and a
    // unit that cannot be disabled is one `start` will report on.
    if (!autostart) deps.runCmd(["systemctl", "--user", "disable", SYSTEMD_UNIT_NAME]);
    const argv = autostart
      ? ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]
      : ["systemctl", "--user", "start", SYSTEMD_UNIT_NAME];
    const enable = deps.runCmd(argv);
    if (enable.code !== 0) {
      return errLine(
        `${argv.slice(0, -1).join(" ")} ${SYSTEMD_UNIT_NAME} failed (exit ${enable.code}): ` + `${cmdDetail(enable)}`,
      );
    }
    // The hint used to print unconditionally, which told operators who had
    // ALREADY run `enable-linger` to go and run it. Ask logind instead, now
    // that the unit is in place, and say it only when the answer is not yes —
    // `null` (no loginctl, no bus) still prints, since advice nobody needs is
    // cheaper than a reboot that loses the server.
    const linger = queryLinger(deps);
    return {
      code: 0,
      out:
        `Installed ${path}; subshell-server is ${autostart ? "enabled and running" : "running (not enabled at login)"}.\n` +
        (linger === true ? "" : "To keep it alive across logout, enable lingering: loginctl enable-linger $USER\n"),
      err: "",
    };
  }

  // darwin: the plist's LOCATION is what decides login behaviour (see
  // `sessionPlistPath`). Write the one this install asked for, and remove the
  // other so exactly one definition exists — a leftover in the login
  // directory would quietly re-arm autostart on the next reboot.
  const path = autostart ? plistPath(deps.home) : sessionPlistPath(deps.configDir);
  const other = autostart ? sessionPlistPath(deps.configDir) : plistPath(deps.home);
  deps.writeFile(path, launchdPlist(execLine(deps), serverLogPath(deps.home), deps.configDir, deps.pathEnv));
  if (deps.fileExists(other)) deps.removeFile(other);
  // ALWAYS, not only when the plist was already there. The authority on
  // "is this label loaded" is launchd, and the file is only a proxy for it —
  // a proxy that lies after a reset, which deletes the plist while the job is
  // still in the domain. Tolerated either way: bootout on a not-loaded
  // service errors, and the bootstrap below is what carries the definition.
  deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
  const boot = bootstrapWithRetry(deps, path);
  if (boot.code !== 0) {
    return errLine(
      `launchctl bootstrap failed (exit ${boot.code}): ${cmdDetail(boot)}; ` + `the plist was left at ${path}`,
    );
  }
  return {
    code: 0,
    out:
      `Installed ${path}; subshell-server is registered with launchd and running` +
      `${autostart ? "" : " (not at login)"}.\n`,
    err: "",
  };
}

/**
 * Turn "starts at login" on or off for an ALREADY-INSTALLED service, WITHOUT
 * touching the running process (spec 2026-09-12 server-supervision § 3).
 *
 * That last clause is the contract, and it is why this is not two lines
 * inside `controlService`: an operator toggling a preference about the next
 * login must not discover that their server went down. So Linux gets
 * `enable`/`disable` with no `--now`, and darwin MOVES the plist between the
 * login directory and the session one — the loaded job does not care where
 * its definition came from, so nothing restarts.
 *
 * Refuses when nothing is installed, in the same words `controlService` uses:
 * there is no definition to arm, and writing one here would make this a way
 * to install a service whose config was never checked.
 */
export function setAutostart(deps: ServiceDeps, enabled: boolean): CliResult {
  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    return errLine(unsupported(enabled ? "enable" : "disable", deps.platform));
  }
  const state = queryService(deps);
  if (!state.installed) {
    return errLine(
      `nothing installed: no service definition at ${state.definitionPath} ` +
        "(run `subshell-server service install` first)",
    );
  }
  const done = (): CliResult => ({
    code: 0,
    out: `subshell-server ${enabled ? "will start at login" : "will no longer start at login"}.\n`,
    err: "",
  });

  if (deps.platform === "linux") {
    // No `--now`: `enable --now` would START a stopped server and
    // `disable --now` would STOP a running one, and neither is what was
    // asked for. `uninstall` is where `disable --now` belongs.
    const verb = enabled ? "enable" : "disable";
    const res = deps.runCmd(["systemctl", "--user", verb, SYSTEMD_UNIT_NAME]);
    if (res.code !== 0) {
      return errLine(`systemctl --user ${verb} ${SYSTEMD_UNIT_NAME} failed (exit ${res.code}): ${cmdDetail(res)}`);
    }
    return done();
  }

  // darwin: move the definition. WRITE FIRST, then remove — a failed write
  // must leave the service exactly as it was rather than unregistered from
  // both places, which is a machine with no definition at all.
  const from = darwinDefinition(deps);
  if (from.enabled === enabled) return done(); // already there; moving it would be a no-op with a risk
  const to = enabled ? plistPath(deps.home) : sessionPlistPath(deps.configDir);
  const text = deps.readFile(from.path);
  if (text === null) return errLine(`could not read the service definition at ${from.path}`);
  // This module's contract everywhere else is "answer a CliResult, never
  // throw" — `queryService`'s own doc says so — and the fs seams DO throw
  // (mkdir + write; rm on EPERM). Without this an EACCES reaches the HTTP
  // route as a generic 500 rather than as the words the admin needs.
  try {
    deps.writeFile(to, text);
    deps.removeFile(from.path);
  } catch (err) {
    return errLine(
      `could not move the service definition to ${to}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return done();
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
  const noConfigNote = deps.hasConfig() ? "" : "(no config.env found, nothing else to clean up)\n";

  if (deps.platform === "linux") {
    const path = unitPath(deps.home);
    if (!deps.fileExists(path)) {
      return { code: 0, out: `nothing installed: no systemd user unit at ${path}\n${noConfigNote}`, err: "" };
    }
    const disable = deps.runCmd(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
    const reload = deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    deps.removeFile(path);
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
      out: `Removed ${path}; subshell-server is stopped and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    const found = darwinDefinition(deps);
    if (!found.installed) {
      return { code: 0, out: `nothing installed: no launchd plist at ${found.path}\n${noConfigNote}`, err: "" };
    }
    const path = found.path;
    const unload = deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    deps.removeFile(path);
    // BOTH, always. `darwinDefinition` reports only the winner, and a machine
    // carrying two definitions (a hand-copy, or a crash between this file's
    // write and remove) must not come out of uninstall with the loser still
    // sitting in the login directory, ready to start a server the operator
    // believes they removed.
    const loser = path === plistPath(deps.home) ? sessionPlistPath(deps.configDir) : plistPath(deps.home);
    if (deps.fileExists(loser)) deps.removeFile(loser);
    // Exit 3 / "No such process" is the documented answer for a job that was
    // NOT LOADED, and that is uninstall's goal already met, not a failure:
    // the job is gone and the plist has just been removed. Reporting it as an
    // error made `uninstall` fail for every STOPPED service - which is the
    // ordinary case, and a guaranteed one for the desktop app's reset, whose
    // own chain stops the service two steps earlier. The reset could
    // therefore never complete on macOS.
    //
    // Narrow on purpose, in the shape `queryService` uses for the same class
    // of question: any OTHER non-zero exit may mean the job is still loaded
    // with its plist now gone, which is a real half-state worth reporting.
    // `stop` has guarded this since it was written; this verb had not.
    const notLoaded = unload.code === 3 || /no such process/i.test(cmdDetail(unload));
    if (unload.code !== 0 && !notLoaded) {
      return errLine(
        `launchctl bootout reported (exit ${unload.code}): ${cmdDetail(unload)}; the plist was removed anyway`,
      );
    }
    return {
      code: 0,
      out: `Removed ${path}; subshell-server is unloaded and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  return errLine(unsupported("uninstall", deps.platform));
}

/** Manager verbs `service` accepts beyond install/uninstall. */
/**
 * Gone ⇔ print answers the documented not-loaded way: exit 113 or "could not
 * find service" — the SAME discrimination {@link queryService} makes for the
 * installed-but-stopped state, so stop and status can never disagree about
 * what "absent" means. Any other answer — including exit-0-with-a-pid and a
 * manager that will not answer at all — is not-proof, and the poll keeps
 * spending its budget rather than guessing.
 */
function jobGoneFromDomain(deps: ServiceDeps, target: string): boolean {
  const res = deps.runCmd(["launchctl", "print", target]);
  if (res.code === 0) return false;
  return res.code === 113 || /could not find service/i.test(`${res.err}${res.out}`);
}

/** The stop's own budget: 30 s of half-second polls, the install side's shape. */
const STOP_WAIT_ATTEMPTS = 60;
const STOP_WAIT_MS = 500;

function waitForJobGone(deps: ServiceDeps, target: string): boolean {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  for (let attempt = 0; attempt < STOP_WAIT_ATTEMPTS; attempt++) {
    if (jobGoneFromDomain(deps, target)) return true;
    sleep(STOP_WAIT_MS);
  }
  return jobGoneFromDomain(deps, target);
}

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
 * Whether taking the service DOWN — stop, restart, or uninstall — leaves live
 * panes running.
 *
 * `unknown` is not a shrug: the definition exists but could not be read or the
 * manager could not be asked, so the destructive verbs fail CLOSED on it. Only
 * a positive `keeps` clears them.
 */
export type PaneSafety = "keeps" | "kills" | "unknown";

/**
 * What {@link queryService} could learn about the installed service WITHOUT
 * booting anything. Every field is either a fact read off disk or a fact the
 * platform's manager reported — nothing here is inferred from the port probe,
 * which lives in `commands/status.ts` and answers a different question
 * ("is something on this port", which may not be us).
 */
export interface ServiceState {
  /** Whether a unit/plist exists on disk. The DEFINITION question. */
  installed: boolean;
  /** Where that definition lives (or would), `null` on a platform with no per-user manager. */
  definitionPath: string | null;
  /** The manager's view of the process. */
  state: ServiceRunState;
  /** Main PID when the manager reports one, else `null`. */
  pid: number | null;
  /**
   * Whether it starts at login. `null` when unknown, or when nothing is installed.
   *
   * systemd reads `UnitFileState`; launchd reads the definition's LOCATION —
   * `~/Library/LaunchAgents` is what it scans at login, and `RunAtLoad` says
   * nothing useful beside `KeepAlive=true` (see {@link sessionPlistPath}).
   */
  enabled: boolean | null;
  /**
   * Linux only: whether this machine's OS user LINGERS
   * (`loginctl enable-linger`).
   *
   * An enabled `--user` unit comes back at LOGIN and dies at LOGOUT unless the
   * user lingers, in which case it comes back at BOOT. That is a different
   * question from {@link enabled} rather than a refinement of it, and on a
   * headless server it is the one that decides whether a reboot brings the
   * server back.
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
   * Each local subshell's tmux server is a CHILD of the service, so the answer
   * is one directive and it differs per platform: systemd `KillMode=process`
   * (or `none`) and launchd `AbandonProcessGroup=true`. Without it the default
   * kill takes every pane with it (measured 2026-09-01 and 2026-09-03) — on
   * STOP as much as on restart, since a restart is a stop followed by a start.
   *
   * On Linux this is the EFFECTIVE value systemd reports, not a grep of the
   * unit file: drop-ins under `<unit>.d/` and un-reloaded edits both make the
   * file disagree with what `systemctl restart` will actually do.
   */
  paneSafety: PaneSafety | null;
  /** Manager output worth quoting when something answered oddly; empty when it did not. */
  detail: string;
  /**
   * Where the service's own log lives, so no UI has to re-derive platform
   * paths: macOS is the plist's `StandardOutPath` (`~/Library/Logs/…`);
   * Linux is `null` — per-user systemd logs to journald, and the answer is
   * `journalctl --user -u ${SYSTEMD_UNIT_NAME}`. Set on EVERY return,
   * including not-installed: logs written by a since-uninstalled service
   * are still sitting there, and "is there a log to open" is exactly the
   * question asked in the states where nothing is running.
   */
  logPath?: string | null;
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
function abandonProcessGroup(deps: ServiceDeps, path: string, text: string | null): PaneSafety {
  const res = deps.runCmd(["plutil", "-extract", "AbandonProcessGroup", "raw", "-o", "-", path]);
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
 * reason in {@link ServiceState.detail}, because every caller (the `status`
 * view, the desktop app's poll) wants a picture rather than an exception.
 */
export function queryService(deps: ServiceDeps): ServiceState {
  const definitionPath = serviceArtifactPath(deps.platform, deps.home, deps.configDir, deps.fileExists);
  if (definitionPath === null) {
    return {
      installed: false,
      definitionPath: null,
      state: "not-installed",
      pid: null,
      enabled: null,
      linger: null,
      paneSafety: null,
      detail: `no per-user service manager on '${deps.platform}'`,
    };
  }
  if (!deps.fileExists(definitionPath)) {
    return {
      installed: false,
      definitionPath,
      state: "not-installed",
      pid: null,
      enabled: null,
      linger: null,
      paneSafety: null,
      // The log location is where logs would live once installed — and where
      // an uninstalled-but-once-installed service's logs STILL are. The UI
      // reveals this without platform knowledge, so it is spelled here even
      // for not-installed (journald has no file to reveal → null).
      logPath: deps.platform === "darwin" ? serverLogPath(deps.home) : null,
      detail: "",
    };
  }

  return deps.platform === "linux" ? querySystemd(deps, definitionPath) : queryLaunchd(deps, definitionPath);
}

/**
 * Does this machine's OS user linger? (`loginctl show-user <uid> --property=Linger`)
 *
 * Asked by UID rather than by name: {@link ServiceDeps} already carries one for
 * the launchd domain target, and `os.userInfo()` THROWS for a uid with no
 * passwd entry, which is the ordinary state of a container.
 *
 * Three answers, and the middle one is the interesting one:
 * - `Linger=yes|no` on a clean exit is logind's own word.
 * - A non-zero exit whose output says the user is "not logged in or lingering"
 *   is ALSO logind answering: no record of this user means no session and no
 *   linger, which is the normal state of a service user on a box nobody logs
 *   into. `false`, not "unknown".
 * - Anything else — no `loginctl` on PATH (127), no bus to connect to — is a
 *   question that was never asked, so `null`.
 *
 * Never throws: the caller is a read-only state query.
 */
function queryLinger(deps: ServiceDeps): boolean | null {
  const res = deps.runCmd(["loginctl", "show-user", String(deps.uid), "--property=Linger"]);
  if (res.code !== 0) {
    return /not logged in or lingering/i.test(`${res.out}${res.err}`) ? false : null;
  }
  const value = parseShowProperties(res.out).Linger;
  return value === "yes" ? true : value === "no" ? false : null;
}

function querySystemd(deps: ServiceDeps, definitionPath: string): ServiceState {
  // ONE call for every property: separate round trips to systemctl would be
  // separate chances to disagree with each other about the same instant.
  // KillMode rides along because the EFFECTIVE value is the only one that
  // predicts what `systemctl stop` will do to the panes.
  const res = deps.runCmd([
    "systemctl",
    "--user",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=ActiveState,SubState,UnitFileState,MainPID,KillMode",
  ]);
  if (res.code !== 0) {
    const text = deps.readFile(definitionPath);
    return {
      installed: true,
      definitionPath,
      state: "unknown",
      pid: null,
      enabled: null,
      // `systemctl show` failed, so this branch asks logind nothing either:
      // the linger question belongs to a host whose manager answered.
      linger: null,
      // Degraded but better than nothing: the file cannot see drop-ins, so a
      // `keeps` here is weaker evidence than a `keeps` from `show`.
      paneSafety: text === null ? "unknown" : killModeFromUnitText(text),
      logPath: null, // journald owns the log on systemd; see ServiceState.logPath
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
  return {
    installed: true,
    definitionPath,
    state,
    pid: Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null,
    // `enabled-runtime` starts at login too, for this boot.
    enabled: unitFileState === "" ? null : unitFileState.startsWith("enabled"),
    // Asked regardless of `enabled`: a unit that is not enabled at all still
    // has a lingering-or-not user behind it, and the two facts compose rather
    // than one qualifying the other.
    linger: queryLinger(deps),
    paneSafety: killMode === "" ? "unknown" : PANE_SPARING_KILL_MODES.has(killMode) ? "keeps" : "kills",
    logPath: null, // journald owns the log on systemd; see ServiceState.logPath
    detail: notes(
      active === "failed" ? `unit is failed (SubState=${props.SubState ?? "?"})` : null,
      // A masked unit refuses every control verb; say it once here rather than
      // letting the operator discover it one command at a time.
      unitFileState.startsWith("masked") ? `unit is ${unitFileState}: systemctl will refuse start/stop/restart` : null,
    ),
  };
}

function queryLaunchd(deps: ServiceDeps, definitionPath: string): ServiceState {
  const text = deps.readFile(definitionPath);
  const paneSafety = abandonProcessGroup(deps, definitionPath, text);
  // WHERE the plist is, not what is in it. `RunAtLoad` was the old answer and
  // it would now be a lie: every definition this file writes carries
  // `RunAtLoad=true`, and with `KeepAlive=true` beside it the key decides
  // nothing anyway (measured — see `sessionPlistPath`). The login directory
  // is the thing launchd actually scans at login, so the path is the fact.
  const enabled = definitionPath === plistPath(deps.home);
  // `launchctl print gui/<uid>/<label>`, NOT the legacy `launchctl list`:
  // `list` resolves an IMPLICIT domain, so over SSH (where the session is
  // "Background", not "Aqua") it reports a running gui/<uid> job as absent —
  // and every write here targets gui/<uid> explicitly. Asking the same domain
  // we write to is the only way the two can agree.
  const logPath = serverLogPath(deps.home);
  const res = deps.runCmd(["launchctl", "print", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
  if (res.code !== 0) {
    const why = oneLine(res.err) || oneLine(res.out);
    // Exit 113 / "Could not find service" is the documented not-loaded answer,
    // and with a plist ON DISK that is exactly "installed but stopped" — the
    // state `bootout` leaves behind. ANY other non-zero exit means the
    // manager did not answer, and "stopped" from that is a guess: report
    // unknown and KEEP the output (a launchctl hiccup previously collapsed
    // into a confident, undiagnosable "stopped").
    const notLoaded = res.code === 113 || /could not find service/i.test(why);
    if (!notLoaded) {
      return {
        installed: true,
        definitionPath,
        state: "unknown",
        pid: null,
        enabled,
        linger: null,
        loaded: false,
        paneSafety,
        logPath,
        detail: `launchctl print failed (exit ${res.code}): ${why || "no output"}`,
      };
    }
    return {
      installed: true,
      definitionPath,
      state: "stopped",
      pid: null,
      enabled,
      linger: null,
      loaded: false,
      paneSafety,
      logPath,
      detail: "",
    };
  }
  const { running, pid } = parseLaunchctlPrint(res.out);
  // `print` answered, so the job IS bootstrapped — even when it reports no
  // pid. That is the loaded-but-idle case, which is stopped and loaded at
  // once. The raw launchd state rides along in `detail` verbatim — states
  // are multi-word ("spawn scheduled" is a crash-throttled restart, not a
  // plain stop), which is why this captures the line, not a \\S+ token; it
  // is the difference between "stopped" and "stopped AND KEEPING CRASHING".
  const rawState = res.out.match(/^\tstate = (.+)$/m)?.[1]?.trim();
  return {
    installed: true,
    definitionPath,
    state: running ? "running" : "stopped",
    pid,
    enabled,
    // launchd has no lingering concept: a LaunchAgent's lifetime IS the login
    // session by design, so there is nothing here to be yes or no about.
    linger: null,
    loaded: true,
    paneSafety,
    logPath,
    detail: running || rawState === undefined ? "" : `launchd: ${rawState}`,
  };
}

/** The remedy for a definition that would take live panes down with it. */
const STALE_DEFINITION = "run `subshell-server service install` to rewrite the definition, or pass --force";

/** The directive whose absence makes a teardown lethal, per platform. */
const PANE_DIRECTIVE: Record<string, string> = { linux: "KillMode=process", darwin: "AbandonProcessGroup=true" };

/** One sentence naming what a teardown will do to live panes on this host. */
function paneWarning(deps: ServiceDeps, state: ServiceState, verb: ServiceVerb): string {
  const directive = PANE_DIRECTIVE[deps.platform] ?? "the pane-sparing directive";
  return state.paneSafety === "unknown"
    ? `could not determine whether ${verb} keeps live panes: ${state.definitionPath} is unreadable`
    : `${state.definitionPath} predates ${directive}, so ${verb} kills every running subshell's tmux server`;
}

/**
 * Drive the platform's service manager for an ALREADY-INSTALLED service.
 *
 * Deliberately narrower than install/uninstall: it refuses when no definition
 * exists rather than writing one, because "start" must never become a way to
 * install a service whose config was never checked.
 *
 * The pane guard is the reason this exists rather than callers shelling out.
 * A teardown on a definition without the pane-sparing directive SIGKILLs every
 * running subshell, and neither `systemctl` nor `launchctl` says so. The two
 * destructive verbs are treated differently on purpose:
 *
 * - `restart` REFUSES without `--force`. Its whole promise is that the service
 *   comes back, so silently losing every pane violates what was asked for.
 * - `stop` WARNS and proceeds. The operator asked for it down; refusing would
 *   only push them to `systemctl` — which warns about nothing — and it would
 *   contradict `uninstall`, which deliberately gates on nothing so a stranded
 *   unit can always come down.
 *
 * Both fail CLOSED on `unknown`: an unreadable definition is not evidence of
 * safety.
 */
export function controlService(deps: ServiceDeps, verb: ServiceVerb, opts: { force?: boolean } = {}): CliResult {
  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    return errLine(unsupported(verb, deps.platform));
  }
  const state = queryService(deps);
  if (!state.installed) {
    return errLine(
      `nothing installed: no service definition at ${state.definitionPath} ` +
        "(run `subshell-server service install` first)",
    );
  }
  const lethal = state.paneSafety !== "keeps";
  if (verb === "restart" && lethal && opts.force !== true) {
    return errLine(`refusing to restart: ${paneWarning(deps, state, "restart")}; ${STALE_DEFINITION}`);
  }
  // Rides along on the SUCCESS result: `stop` is not refused, but it must
  // never be silent about what it took down.
  const warning = verb === "stop" && lethal ? `subshell-server: warning: ${paneWarning(deps, state, "stop")}\n` : "";
  const done = (line: string): CliResult => ({ code: 0, out: `${line}\n`, err: warning });

  if (deps.platform === "linux") {
    // `stop`, never `disable --now`: un-enabling is what uninstall does, and
    // an operator who stops a service still expects it back after a reboot.
    const res = deps.runCmd(["systemctl", "--user", verb, SYSTEMD_UNIT_NAME]);
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
      return { code: 0, out: "subshell-server is already stopped.\n", err: "" };
    }
    // `bootout`, not a kill: KeepAlive is true, so launchd restarts anything
    // that merely dies. Unloading the job is the only thing that stays stopped.
    const res = deps.runCmd(["launchctl", "bootout", target]);
    if (res.code !== 0) return errLine(`launchctl bootout failed (exit ${res.code}): ${cmdDetail(res)}`);
    // Exit 0 means the request was ACCEPTED, not the job gone — `domainBusy`
    // has documented bootout's asynchrony since 2026-09-12, and until now only
    // the install path acted on it. Measured cost on 2026-09-13: a desktop
    // reset's `service stop` said "subshell-server stopped." while the process
    // ran for 90 more seconds, and the chain deleted the database out from
    // under it. DONE is only owed to a domain that answered "no such job".
    if (!waitForJobGone(deps, target)) {
      return errLine(
        `launchctl bootout was accepted, but the job is still in launchd's domain after ` +
          `${STOP_WAIT_ATTEMPTS * STOP_WAIT_MS}ms — a teardown that slow is usually the server ` +
          `finishing something (or a manager that will not answer), and either way the service ` +
          `was NOT confirmed stopped. Re-check with \`subshell-server service status\` before ` +
          `treating anything it owns as gone.`,
      );
    }
    return done(DONE.stop);
  }
  if (verb === "restart") {
    // `kickstart -k` is the documented restart (the README's own line); it
    // needs the job LOADED, so a stopped service is bootstrapped instead.
    if (state.state === "stopped")
      return bootstrapDarwin(deps, target, DONE.restart, warning, state.definitionPath ?? plistPath(deps.home));
    const res = deps.runCmd(["launchctl", "kickstart", "-k", target]);
    if (res.code !== 0) return errLine(`launchctl kickstart -k failed (exit ${res.code}): ${cmdDetail(res)}`);
    return done(DONE.restart);
  }
  // start
  if (state.state === "running") return { code: 0, out: "subshell-server is already running.\n", err: "" };
  return bootstrapDarwin(deps, target, DONE.start, warning, state.definitionPath ?? plistPath(deps.home));
}

/**
 * Load a launchd job, falling back to `kickstart -k` when it turns out to be
 * loaded already. `-k` is deliberate: a bare `kickstart` on a job that IS
 * running exits 0 and changes nothing (measured on macOS 26.6.2 — same pid
 * before and after), so a restart would report success having restarted
 * nothing. On a loaded-but-idle job `-k` simply starts it.
 */
function bootstrapDarwin(deps: ServiceDeps, target: string, done: string, warning: string, path: string): CliResult {
  // The path is PASSED, never re-derived: a service installed with
  // `--no-autostart` lives at the session path, and bootstrapping the login
  // path would answer "no such file" for a service that is installed and
  // merely disabled at login.
  const boot = deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
  if (boot.code === 0) return { code: 0, out: `${done}\n`, err: warning };
  const kick = deps.runCmd(["launchctl", "kickstart", "-k", target]);
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

/** Success lines, one per verb — the manager is silent on success, so this is the only feedback. */
export const DONE: Record<ServiceVerb, string> = {
  start: "subshell-server started.",
  stop: "subshell-server stopped.",
  restart: "subshell-server restarted.",
};

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
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}
