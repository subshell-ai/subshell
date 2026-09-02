import { access, writeFile as fsWriteFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CliResult } from "./cli.js";

/**
 * `mote-agent service install|uninstall` — background the daemon with the
 * platform's per-user service manager: a systemd **user** unit on Linux, a
 * launchd agent plist on macOS. Nothing here shells out at import time; every
 * effect flows through {@link ServiceDeps} so the unit tests stub the manager
 * and the filesystem entirely (RULING: config existence is a `hasConfig()`
 * dependency — this module never imports `loadConfig`).
 */
export interface ServiceDeps {
  /** Runtime platform — only `linux` and `darwin` have a service manager here. */
  platform: NodeJS.Platform;
  /** User home the unit/plist paths hang off (NOT `MOTE_AGENT_HOME`). */
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
  runCmd(cmd: string[], opts?: { env?: Record<string, string> }): Promise<{ code: number; out: string; err: string }>;
  /** Write a file (real impl creates parent dirs). */
  writeFile(path: string, text: string): Promise<void>;
  /** Delete a file. */
  removeFile(path: string): Promise<void>;
  /** Existence check for the unit/plist path (drives reinstall bootout + uninstall no-op). */
  fileExists(path: string): Promise<boolean>;
}

/** systemd user-unit name (lives under `~/.config/systemd/user/`). */
export const SYSTEMD_UNIT_NAME = "mote-agent.service";
/** launchd label (plist: `~/Library/LaunchAgents/<label>.plist`). */
export const LAUNCHD_LABEL = "dev.mote.agent";

const unitPath = (home: string) => join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const launchLogPath = (home: string) => join(home, "Library", "Logs", "mote-agent.log");

/**
 * The argv the service manager should run. Compiled binary (basename starts
 * with `mote-agent`): the binary itself plus `run`. Dev/interpreter launch
 * (`bun src/main.ts`): interpreter + the resolved script path + `run` — a bare
 * relative `argv1` would break the moment the manager starts us from another
 * cwd, so it is resolved at install time.
 */
export function execLine(deps: Pick<ServiceDeps, "execPath" | "argv1">): string[] {
  if (basename(deps.execPath).startsWith("mote-agent")) return [deps.execPath, "run"];
  return [deps.execPath, resolve(deps.argv1), "run"];
}

/** systemd user-unit body — the exact lines the tests pin. */
function systemdUnit(exec: string): string {
  return `[Unit]
Description=mote-agent (mote node daemon)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** launchd plist body: keep-alive agent logging to ~/Library/Logs/mote-agent.log. */
function launchdPlist(args: string[], logPath: string): string {
  const argLines = args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
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
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

const errLine = (msg: string): CliResult => ({ code: 1, out: "", err: `mote-agent: ${msg}\n` });

/** Collapse command stderr into one quotable line (trailing newline, no blank runs). */
const oneLine = (s: string): string => s.trim().replace(/\s*\n\s*/g, " ");

/** Install refuses to touch the machine before the node is enrolled; uninstall deliberately does NOT (see {@link uninstallService}). */
const NO_CONFIG = "no config found — run mote-agent enroll first";

const unsupported = (action: string, platform: string): string =>
  `service ${action} is not supported on '${platform}' — no per-user service manager here; ` +
  "run `mote-agent run` in a terminal (e.g. inside tmux/screen) to keep the daemon up for now";

/**
 * Install the per-user service and start it. Linux: write the unit, then
 * `daemon-reload` + `enable --now` — a failed reload (typically the classic
 * "Failed to connect to bus" without a systemd user session) aborts with the
 * systemctl stderr quoted; the unit file is deliberately left on disk.
 * macOS: write the plist, `bootout` the previous load when reinstalling
 * (failure tolerated — it usually means "not loaded"), then `bootstrap`.
 */
export async function installService(deps: ServiceDeps): Promise<CliResult> {
  if (!(await deps.hasConfig())) return errLine(NO_CONFIG);

  if (deps.platform === "linux") {
    const path = unitPath(deps.home);
    await deps.writeFile(path, systemdUnit(execLine(deps).join(" ")));
    const reload = await deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    if (reload.code !== 0) {
      return errLine(
        `systemctl --user daemon-reload failed (exit ${reload.code}): ` +
          `${oneLine(reload.err) || oneLine(reload.out) || "no output"} — the unit file was left at ${path}; ` +
          "this usually means no systemd user session is running (container/SSH without loginctl)",
      );
    }
    const enable = await deps.runCmd(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
    if (enable.code !== 0) {
      return errLine(
        `systemctl --user enable --now ${SYSTEMD_UNIT_NAME} failed (exit ${enable.code}): ` +
          `${oneLine(enable.err) || oneLine(enable.out) || "no output"}`,
      );
    }
    return {
      code: 0,
      out:
        `Installed ${path} — mote-agent is enabled and running.\n` +
        "To keep it alive across logout, enable lingering: loginctl enable-linger $USER\n",
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    const path = plistPath(deps.home);
    const reinstall = await deps.fileExists(path); // must be sampled BEFORE the overwrite
    await deps.writeFile(path, launchdPlist(execLine(deps), launchLogPath(deps.home)));
    if (reinstall) {
      // Tolerated: bootout on a not-loaded service errors, and the fresh
      // bootstrap below is what actually carries the new definition.
      await deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    }
    const boot = await deps.runCmd(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
    if (boot.code !== 0) {
      return errLine(
        `launchctl bootstrap failed (exit ${boot.code}): ${oneLine(boot.err) || oneLine(boot.out) || "no output"} — ` +
          `the plist was left at ${path}`,
      );
    }
    return { code: 0, out: `Installed ${path} — mote-agent is registered with launchd and running.\n`, err: "" };
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
  const noConfigNote = (await deps.hasConfig()) ? "" : "(no agent config found — nothing else to clean up)\n";

  if (deps.platform === "linux") {
    const path = unitPath(deps.home);
    if (!(await deps.fileExists(path))) {
      return { code: 0, out: `nothing installed — no systemd user unit at ${path}\n${noConfigNote}`, err: "" };
    }
    const disable = await deps.runCmd(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
    const reload = await deps.runCmd(["systemctl", "--user", "daemon-reload"]);
    await deps.removeFile(path);
    if (disable.code !== 0 || reload.code !== 0) {
      const failed = disable.code !== 0 ? disable : reload;
      const label = disable.code !== 0 ? "disable --now" : "daemon-reload";
      return errLine(
        `systemctl --user ${label} failed (exit ${failed.code}): ` +
          `${oneLine(failed.err) || oneLine(failed.out) || "no output"} — the unit file was removed anyway`,
      );
    }
    return {
      code: 0,
      out: `Removed ${path} — mote-agent is stopped and no longer starts on login.\n${noConfigNote}`,
      err: "",
    };
  }

  if (deps.platform === "darwin") {
    const path = plistPath(deps.home);
    if (!(await deps.fileExists(path))) {
      return { code: 0, out: `nothing installed — no launchd plist at ${path}\n${noConfigNote}`, err: "" };
    }
    const unload = await deps.runCmd(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
    await deps.removeFile(path);
    if (unload.code !== 0) {
      return errLine(
        `launchctl bootout reported (exit ${unload.code}): ${oneLine(unload.err) || oneLine(unload.out) || "no output"} — ` +
          "the plist was removed anyway",
      );
    }
    return {
      code: 0,
      out: `Removed ${path} — mote-agent is unloaded and no longer starts on login.\n${noConfigNote}`,
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
    async runCmd(cmd, opts) {
      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out, err };
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
  };
}
