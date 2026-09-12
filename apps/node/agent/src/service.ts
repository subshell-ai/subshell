import { access, readFile as fsReadFile, writeFile as fsWriteFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DESKTOP_CLIENT_BUNDLE_ID } from "@internal/subshell-protocol";
import type { CliResult } from "./cli.js";
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
const launchLogPath = (home: string) => join(home, "Library", "Logs", "subshell.log");

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
 * Install the per-user service and start it. Linux: write the unit, then
 * `daemon-reload` + `enable --now` — a failed reload (typically the classic
 * "Failed to connect to bus" without a systemd user subshell) aborts with the
 * systemctl stderr quoted; the unit file is deliberately left on disk.
 * macOS: write the plist, `bootout` the previous load when reinstalling
 * (failure tolerated — it usually means "not loaded"), then `bootstrap`.
 */
export async function installService(deps: ServiceDeps): Promise<CliResult> {
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
    const enable = await deps.runCmd(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
    if (enable.code !== 0) {
      return errLine(
        `systemctl --user enable --now ${SYSTEMD_UNIT_NAME} failed (exit ${enable.code}): ` + `${cmdDetail(enable)}`,
      );
    }
    return {
      code: 0,
      out:
        `Installed ${path}; subshell is enabled and running.\n` +
        "To keep it alive across logout, enable lingering: loginctl enable-linger $USER\n",
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    const path = plistPath(deps.home);
    const reinstall = await deps.fileExists(path); // must be sampled BEFORE the overwrite
    await deps.writeFile(path, launchdPlist(execLine(deps), launchLogPath(deps.home), deps.servicePath));
    if (reinstall) {
      // Tolerated: bootout on a not-loaded service errors, and the fresh
      // bootstrap below is what actually carries the new definition.
      await deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    }
    const boot = await deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
    if (boot.code !== 0) {
      return errLine(
        `launchctl bootstrap failed (exit ${boot.code}): ${cmdDetail(boot)}; ` + `the plist was left at ${path}`,
      );
    }
    return { code: 0, out: `Installed ${path}; subshell is registered with launchd and running.\n`, err: "" };
  }

  return errLine(unsupported("install", deps.platform));
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
    const path = plistPath(deps.home);
    if (!(await deps.fileExists(path))) {
      return { code: 0, out: `nothing installed: no launchd plist at ${path}\n${noConfigNote}`, err: "" };
    }
    const unload = await deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    await deps.removeFile(path);
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
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    argv1: process.argv[1] ?? "",
    hasConfig,
    async runCmd(cmd) {
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
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, text, "utf8");
    },
    async removeFile(path) {
      await rm(path, { force: true });
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
  /** Whether it starts at login (systemd `UnitFileState`; launchd `RunAtLoad`). `null` when unknown. */
  enabled: boolean | null;
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
 */
function serviceArtifactPath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === "linux") return unitPath(home);
  if (platform === "darwin") return plistPath(home);
  return null;
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
  const definitionPath = serviceArtifactPath(deps.platform, deps.home);
  if (definitionPath === null) {
    return {
      installed: false,
      definitionPath: null,
      logPath,
      state: "not-installed",
      pid: null,
      enabled: null,
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
      paneSafety: null,
      detail: "",
    };
  }

  return deps.platform === "linux" ? querySystemd(deps, definitionPath) : queryLaunchd(deps, definitionPath);
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
  return {
    installed: true,
    definitionPath,
    logPath: deps.platform === "darwin" ? launchLogPath(deps.home) : null,
    state,
    pid: Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null,
    // `enabled-runtime` starts at login too, for this boot.
    enabled: unitFileState === "" ? null : unitFileState.startsWith("enabled"),
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
  const enabled = text === null ? null : /<key>\s*RunAtLoad\s*<\/key>\s*(<true\s*\/>|<true>\s*<\/true>)/.test(text);
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
    if (state.state === "stopped") return bootstrapDarwin(deps, target, DONE.restart, warning);
    const res = await deps.runCmd(["launchctl", "kickstart", "-k", target]);
    if (res.code !== 0) return errLine(`launchctl kickstart -k failed (exit ${res.code}): ${cmdDetail(res)}`);
    return done(DONE.restart);
  }
  // start
  if (state.state === "running") return { code: 0, out: "subshell is already running.\n", err: "" };
  return bootstrapDarwin(deps, target, DONE.start, warning);
}

/**
 * Load a launchd job, falling back to `kickstart -k` when it turns out to be
 * loaded already. `-k` is deliberate: a bare `kickstart` on a job that IS
 * running exits 0 and changes nothing (measured on macOS 26.6.2 — same pid
 * before and after), so a restart would report success having restarted
 * nothing. On a loaded-but-idle job `-k` simply starts it.
 */
async function bootstrapDarwin(deps: ServiceDeps, target: string, done: string, warning: string): Promise<CliResult> {
  const path = plistPath(deps.home);
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
