import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  controlService,
  DONE,
  execLine,
  installService,
  queryService,
  SERVICE_VERBS,
  type ServiceDeps,
  type ServiceRunState,
  uninstallService,
} from "../service.js";

/**
 * Everything here runs against stub deps — no systemd, no launchd, no real
 * fs (the client `service.test.ts` discipline, mirrored). `home`/`configDir`
 * are fake paths; the stubs record writes + argv so we pin the exact
 * unit/plist templates and the service-manager command sequences. The only
 * deliberate difference from the client suite: every seam is SYNCHRONOUS
 * (cli.ts invariant 1 — a handled command may never suspend).
 */
const HOME = "/home/tester";
const CONFIG = join(HOME, ".config", "subshell-server");
const UNIT = join(HOME, ".config", "systemd", "user", "subshell-server.service");
const PLIST = join(HOME, "Library", "LaunchAgents", "dev.subshell.server.plist");
/** Distinct from the agent's `~/Library/Logs/subshell.log` — pinned below. */
const LOG = join(HOME, "Library", "Logs", "subshell-server.log");

/** What a stubbed runCmd answers per invocation (default: success, silent). */
type Responder = (cmd: string[]) => { code: number; out: string; err: string };

interface Stub {
  deps: ServiceDeps;
  /** argv of every runCmd call, in order. */
  calls: string[][];
  /** path → last written text (in-memory "disk"). */
  files: Map<string, string>;
  /** paths passed to removeFile, in order. */
  removed: string[];
}

function stub(over: Partial<ServiceDeps> & { respond?: Responder } = {}): Stub {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const { respond, ...depsOver } = over;
  const deps: ServiceDeps = {
    platform: "linux",
    home: HOME,
    uid: 1000,
    servicePath: "/usr/local/bin/subshell-server",
    argv1: "/repo/apps/server/api/src/index.ts",
    configDir: CONFIG,
    // A real login session's shape: XDG present, tmux present, config.env
    // present — individual tests flip the ONE thing they refuse on.
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    which: () => "/usr/bin/tmux",
    hasConfig: () => true,
    runCmd: (cmd) => {
      calls.push(cmd);
      return respond?.(cmd) ?? { code: 0, out: "", err: "" };
    },
    writeFile: (path, text) => {
      files.set(path, text);
    },
    removeFile: (path) => {
      removed.push(path);
      files.delete(path);
    },
    fileExists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? null,
    ...depsOver,
  };
  return { deps, calls, files, removed };
}

const msgLine = (err: string) => err.split("\n")[0] ?? "";

describe("execLine", () => {
  test("compiled binary runs ITSELF with NO subcommand (bare invocation = boot path)", () => {
    expect(execLine({ servicePath: "/opt/bin/subshell-server", argv1: "/ignored/index.ts" })).toEqual([
      "/opt/bin/subshell-server",
    ]);
  });

  test("a release-named artifact (subshell-server-cli-linux-x64) is recognised too", () => {
    expect(execLine({ servicePath: "/x/subshell-server-cli-linux-x64", argv1: "/ignored/index.ts" })).toEqual([
      "/x/subshell-server-cli-linux-x64",
    ]);
  });

  test("interpreter launch passes the resolved script path (no subcommand)", () => {
    expect(execLine({ servicePath: "/usr/local/bin/bun", argv1: "apps/server/api/src/index.ts" })).toEqual([
      "/usr/local/bin/bun",
      resolve("apps/server/api/src/index.ts"),
    ]);
  });

  test("an absolute argv1 resolves to itself", () => {
    expect(execLine({ servicePath: "/usr/local/bin/bun", argv1: "/repo/apps/server/api/src/index.ts" })).toEqual([
      "/usr/local/bin/bun",
      "/repo/apps/server/api/src/index.ts",
    ]);
  });
});

describe("installService — linux (systemd user unit)", () => {
  test("guards pass → probes, writes the EXACT unit, reloads, enables+starts, hints at linger", () => {
    const s = stub();
    const res = installService(s.deps);

    expect(res.code).toBe(0);
    // The whole unit, byte for byte — the plan's "tests pin unit text".
    expect(s.files.get(UNIT)).toBe(`[Unit]
Description=subshell-server (the Subshell control plane)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
WorkingDirectory=${CONFIG}
EnvironmentFile=${CONFIG}/config.env
ExecStart=/usr/local/bin/subshell-server
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
`);
    expect(s.calls).toEqual([
      ["systemctl", "--user", "is-system-running"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "subshell-server.service"],
    ]);
    expect(res.out).toInclude("loginctl enable-linger");
  });

  test("dev-form execLine: interpreter + resolved script path in ExecStart", () => {
    const s = stub({ servicePath: "/usr/local/bin/bun", argv1: "/repo/apps/server/api/src/index.ts" });
    const res = installService(s.deps);
    expect(res.code).toBe(0);
    expect(s.files.get(UNIT)).toInclude("ExecStart=/usr/local/bin/bun /repo/apps/server/api/src/index.ts");
  });

  test("pathEnv bakes Environment=PATH= before WorkingDirectory; absent → no line", () => {
    const withPath = stub({ pathEnv: "/usr/bin:/opt/homebrew/bin" });
    installService(withPath.deps);
    const unit = withPath.files.get(UNIT) ?? "";
    expect(unit).toInclude("Environment=PATH=/usr/bin:/opt/homebrew/bin\nWorkingDirectory=");

    const without = stub();
    installService(without.deps);
    expect(without.files.get(UNIT) ?? "").not.toInclude("Environment=");
  });

  test("a spaced pathEnv is quoted; a spaced script path is quoted (no word-split 203/EXEC)", () => {
    const s = stub({
      pathEnv: "/usr/bin:/opt/my tools/bin",
      servicePath: "/usr/local/bin/bun",
      argv1: "/home/john smith/repos/subshell/apps/server/api/src/index.ts",
    });
    const res = installService(s.deps);
    expect(res.code).toBe(0);
    const unit = s.files.get(UNIT) ?? "";
    expect(unit).toInclude('Environment=PATH="/usr/bin:/opt/my tools/bin"');
    expect(unit).toInclude(
      `ExecStart=/usr/local/bin/bun "${resolve("/home/john smith/repos/subshell/apps/server/api/src/index.ts")}"`,
    );
    expect(unit).not.toInclude("ExecStart=/usr/local/bin/bun /home/john smith"); // the unquoted split-form is the bug
  });

  test("dbus guard: a failing is-system-running refuses BEFORE any write", () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("is-system-running")
          ? { code: 1, out: "", err: "Failed to connect to bus: No such file or directory" }
          : { code: 0, out: "", err: "" },
    });
    const res = installService(s.deps);

    expect(res.code).toBe(1);
    expect(res.err).toInclude("Failed to connect to bus: No such file or directory");
    expect(s.files.size).toBe(0); // the probe runs BEFORE the write — nothing landed
    expect(s.calls).toEqual([["systemctl", "--user", "is-system-running"]]);
  });

  test("no XDG_RUNTIME_DIR → refusal, no writes, not even a probe command", () => {
    const s = stub({ env: {} });
    const res = installService(s.deps);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("XDG_RUNTIME_DIR");
    expect(s.files.size).toBe(0);
    expect(s.calls.length).toBe(0);
  });

  test("a failing daemon-reload exits 1 with systemctl's stderr, unit stays on disk", () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("daemon-reload")
          ? { code: 1, out: "", err: "Failed to connect to bus: No such file or directory" }
          : { code: 0, out: "", err: "" },
    });
    const res = installService(s.deps);

    expect(res.code).toBe(1);
    expect(res.err).toInclude("Failed to connect to bus: No such file or directory");
    expect(s.files.has(UNIT)).toBe(true); // written before the reload — left in place
    expect(s.calls.length).toBe(2); // probe + reload; enable never attempted
  });
});

describe("installService — macOS (launchd agent)", () => {
  test("fresh install: valid plist at LaunchAgents, bootstrap only", () => {
    const s = stub({ platform: "darwin" });
    const res = installService(s.deps);

    expect(res.code).toBe(0);
    const plist = s.files.get(PLIST) ?? ""; // "" on a miss ⇒ the first toInclude below fails loudly
    expect(plist).toInclude("<string>dev.subshell.server</string>");
    expect(plist).toInclude("<key>KeepAlive</key>");
    expect(plist).toInclude("<key>RunAtLoad</key>");
    // launchd's twin of KillMode=process: a stopped agent must not take its
    // tmux children (the live panes) with it.
    expect(plist).toInclude("<key>AbandonProcessGroup</key>");
    expect(plist).toInclude("<string>/usr/local/bin/subshell-server</string>");
    // The log is the SERVER's own file — never the agent's subshell.log.
    expect(plist.split(LOG).length - 1).toBe(2); // StandardOutPath AND StandardErrorPath
    expect(plist).not.toInclude(join(HOME, "Library", "Logs", "subshell.log"));

    expect(s.calls).toEqual([["launchctl", "bootstrap", "gui/1000", PLIST]]);
  });

  test("pathEnv bakes an EnvironmentVariables/PATH dict; absent → minimal plist", () => {
    const s = stub({ platform: "darwin", pathEnv: "/usr/bin:/opt/homebrew/bin" });
    installService(s.deps);
    const plist = s.files.get(PLIST) ?? "";
    expect(plist).toInclude("<key>EnvironmentVariables</key>");
    expect(plist).toInclude("<key>PATH</key>");
    expect(plist).toInclude("<string>/usr/bin:/opt/homebrew/bin</string>");
    // PATH sits between ProgramArguments and RunAtLoad (valid plist order).
    expect(plist.indexOf("EnvironmentVariables")).toBeGreaterThan(plist.indexOf("</array>"));
    expect(plist.indexOf("EnvironmentVariables")).toBeLessThan(plist.indexOf("RunAtLoad"));

    const without = stub({ platform: "darwin" });
    installService(without.deps);
    expect(without.files.get(PLIST) ?? "").not.toInclude("EnvironmentVariables");
  });

  test("reinstall: bootout (tolerated) before bootstrap; a bootout failure does not sink the install", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "bootout" ? { code: 3, out: "", err: "Could not find service" } : { code: 0, out: "", err: "" },
    });
    s.files.set(PLIST, "<plist>old</plist>"); // pre-existing unit ⇒ reinstall

    const res = installService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([
      ["launchctl", "bootout", "gui/1000/dev.subshell.server"],
      ["launchctl", "bootstrap", "gui/1000", PLIST],
    ]);
  });

  test("a failing bootstrap exits 1 with launchctl's stderr, plist stays", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "bootstrap"
          ? { code: 5, out: "", err: "Bootstrap failed: 5: Input/output error" }
          : { code: 0, out: "", err: "" },
    });
    const res = installService(s.deps);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("Bootstrap failed: 5: Input/output error");
    expect(s.files.has(PLIST)).toBe(true);
  });
});

describe("installService — guards", () => {
  test("unsupported platform: exit 1 with foreground + nohup guidance, no writes, no commands", () => {
    const s = stub({ platform: "win32" as NodeJS.Platform });
    const res = installService(s.deps);

    expect(res.code).toBe(1);
    expect(msgLine(res.err)).toInclude("win32");
    expect(res.err).toInclude("nohup subshell-server");
    expect(s.files.size).toBe(0);
    expect(s.calls.length).toBe(0);
  });

  test("missing config.env: exit 1 pointing at init, no writes, no commands", () => {
    const s = stub({ hasConfig: () => false });
    const res = installService(s.deps);

    expect(res.code).toBe(1);
    expect(res.err).toInclude("no config.env — run subshell-server init first");
    expect(s.files.size).toBe(0);
    expect(s.calls.length).toBe(0);
  });

  test("tmux missing refuses BEFORE any write or command; SKIP env is the escape hatch", () => {
    const blocked = stub({ which: () => null });
    const res = installService(blocked.deps);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("tmux not found");
    expect(res.err).toInclude("SUBSHELL_SERVER_SKIP_TMUX_CHECK=1");
    expect(blocked.files.size).toBe(0);
    expect(blocked.calls.length).toBe(0);

    const skipped = stub({
      which: () => null,
      env: { XDG_RUNTIME_DIR: "/run/user/1000", SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" },
    });
    expect(installService(skipped.deps).code).toBe(0);
  });

  test("interactive tmux offer (spec 2026-09-03): yes + install success → install CONTINUES", () => {
    let installed = false;
    const offerLog: string[] = [];
    const s = stub({
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : n === "tmux" && installed ? "/usr/bin/tmux" : null),
      tmuxOffer: {
        interactive: true,
        log: (line) => void offerLog.push(line),
        prompt: () => "y",
        spawn: () => {
          installed = true;
          return 0;
        },
      },
    });
    const res = installService(s.deps);
    expect(res.code).toBe(0);
    expect(offerLog.join("\n")).toMatch(/tmux installed/i);
    // Continued into the real work: the unit landed and systemctl ran.
    expect(s.files.size).toBe(1);
    expect(s.calls.length).toBeGreaterThan(0);
  });

  test("non-interactive offer bundle (TTY=false) never asks: refusal is byte-identical", () => {
    let asked = 0;
    const s = stub({
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : null),
      tmuxOffer: {
        interactive: false,
        log: () => {},
        prompt: () => {
          asked++;
          return "y";
        },
        spawn: () => 0,
      },
    });
    const res = installService(s.deps);
    expect(res.code).toBe(1);
    expect(asked).toBe(0);
    expect(res.err).toInclude("tmux not found");
    expect(s.files.size).toBe(0);
  });
});

describe("uninstallService — linux", () => {
  test("stops+disables, reloads, and removes the unit", () => {
    const s = stub();
    s.files.set(UNIT, "[Unit]\n"); // something installed

    const res = uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "subshell-server.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(s.removed).toEqual([UNIT]);
    expect(s.files.has(UNIT)).toBe(false);
  });

  test("no unit on disk: exit 0 saying nothing is installed, no commands run", () => {
    const s = stub();
    const res = uninstallService(s.deps);

    expect(res.code).toBe(0);
    expect(res.out).toInclude("nothing installed");
    expect(s.calls.length).toBe(0);
    expect(s.removed.length).toBe(0);
  });

  test("a failing disable --now still removes the file and reports exit 1", () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("disable")
          ? { code: 1, out: "", err: "Transaction is destructive." }
          : { code: 0, out: "", err: "" },
    });
    s.files.set(UNIT, "[Unit]\n");

    const res = uninstallService(s.deps);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("Transaction is destructive.");
    expect(res.err).toInclude("removed anyway");
    expect(s.removed).toEqual([UNIT]);
  });
});

describe("uninstallService — macOS (launchd agent)", () => {
  test("stops via bootout, then removes the plist", () => {
    const s = stub({ platform: "darwin" });
    s.files.set(PLIST, "<plist>old</plist>"); // something installed

    const res = uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([["launchctl", "bootout", "gui/1000/dev.subshell.server"]]);
    expect(s.removed).toEqual([PLIST]);
    expect(s.files.has(PLIST)).toBe(false);
    expect(res.out).toInclude("Removed");
  });

  test("no plist on disk: exit 0 saying nothing is installed, no commands run", () => {
    const s = stub({ platform: "darwin" });
    const res = uninstallService(s.deps);

    expect(res.code).toBe(0);
    expect(res.out).toInclude("nothing installed");
    expect(s.calls.length).toBe(0);
    expect(s.removed.length).toBe(0);
  });
});

describe("uninstallService — guards", () => {
  test("deleted config does NOT gate uninstall: full disable/reload/remove still runs, exit 0, notes the missing config", () => {
    const s = stub({ hasConfig: () => false });
    s.files.set(UNIT, "[Unit]\n"); // the unit is installed; the config is gone

    const res = uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "subshell-server.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(s.removed).toEqual([UNIT]);
    expect(res.out).toInclude("(no config.env found — nothing else to clean up)");
  });

  test("unsupported platform: exit 1, no removals", () => {
    const s = stub({ platform: "win32" as NodeJS.Platform });
    const res = uninstallService(s.deps);

    expect(res.code).toBe(1);
    expect(s.removed.length).toBe(0);
  });
});

/**
 * `queryService` reads; `controlService` drives. Both run against the same
 * stub disk/argv recorder as the install suite above, and the most valuable
 * cases are where the WRITER and the READER meet: the definition
 * `installService` writes must satisfy the pane check `controlService` gates
 * on, or the guard fires on our own unit.
 *
 * Two platform facts these pin, both measured on real tools rather than
 * assumed: systemd's EFFECTIVE `KillMode` comes from `systemctl show` (a unit
 * file grep cannot see drop-ins), and launchd state comes from
 * `launchctl print gui/<uid>/…` (legacy `launchctl list` resolves an IMPLICIT
 * domain and reports a running gui job as absent over SSH).
 */

/** A `show` responder: merge overrides onto a healthy, pane-safe unit. */
const showOut = (over: Record<string, string> = {}): string =>
  Object.entries({
    ActiveState: "active",
    SubState: "running",
    UnitFileState: "enabled",
    MainPID: "4242",
    KillMode: "process",
    ...over,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

/** A linux stub whose `show` answers with `over` merged in, and whose unit file exists. */
function linuxStub(over: Record<string, string> = {}) {
  const s = stub({
    respond: (cmd) => (cmd.includes("show") ? { code: 0, out: showOut(over), err: "" } : { code: 0, out: "", err: "" }),
  });
  s.files.set(UNIT, "[Service]\nKillMode=process\n");
  return s;
}

/**
 * A darwin stub: `plutil` answers `abandon`, `launchctl print` answers
 * loaded/not — and, when loaded, running or idle.
 *
 * `loaded` and `running` are two facts, not one. A launchd job that is
 * bootstrapped but has no process makes `print` exit 0 with no `pid` line:
 * still loaded (so `KeepAlive`/`RunAtLoad` can start it and a fresh
 * `bootstrap` refuses), yet not running. `loaded: false` is the only shape
 * where `print` itself fails.
 */
function darwinStub({ abandon = true, loaded = true, running = true, pid = 5150 } = {}) {
  const s = stub({
    platform: "darwin",
    respond: (cmd) => {
      if (cmd[0] === "plutil")
        return abandon ? { code: 0, out: "true\n", err: "" } : { code: 1, out: "", err: "No value at that key path" };
      if (cmd[1] === "print") {
        if (!loaded) return { code: 113, out: "", err: "" };
        return running
          ? { code: 0, out: `\tstate = running\n\tpid = ${pid}\n`, err: "" }
          : { code: 0, out: "\tstate = not running\n", err: "" };
      }
      return { code: 0, out: "", err: "" };
    },
  });
  s.files.set(PLIST, "<key>AbandonProcessGroup</key><true/><key>RunAtLoad</key><true/>");
  return s;
}

describe("queryService", () => {
  test("no definition on disk is not-installed — and no manager command runs", () => {
    const s = stub();
    const state = queryService(s.deps);
    expect(state).toMatchObject({ installed: false, state: "not-installed", definitionPath: UNIT, paneSafety: null });
    expect(s.calls).toEqual([]);
  });

  test("a platform with no per-user manager reports not-installed with a reason", () => {
    const s = stub({ platform: "win32" });
    const state = queryService(s.deps);
    expect(state.definitionPath).toBeNull();
    expect(state.detail).toContain("win32");
    expect(s.calls).toEqual([]);
  });

  test("linux: ONE systemctl show carries every property, KillMode included", () => {
    const s = linuxStub();
    const state = queryService(s.deps);
    expect(s.calls).toEqual([
      [
        "systemctl",
        "--user",
        "show",
        "subshell-server.service",
        "--property=ActiveState,SubState,UnitFileState,MainPID,KillMode",
      ],
    ]);
    expect(state).toMatchObject({ installed: true, state: "running", pid: 4242, enabled: true, paneSafety: "keeps" });
  });

  // The whole reason KillMode is asked of systemd rather than grepped: a
  // drop-in under <unit>.d/ overrides the file, and the file cannot see it.
  test("linux: the EFFECTIVE KillMode wins over the unit file's text", () => {
    const s = linuxStub({ KillMode: "control-group" });
    // The file on disk still says process — a grep would answer "keeps".
    expect(s.files.get(UNIT)).toContain("KillMode=process");
    expect(queryService(s.deps).paneSafety).toBe("kills");
  });

  test("linux: KillMode=none also spares the panes", () => {
    expect(queryService(linuxStub({ KillMode: "none" }).deps).paneSafety).toBe("keeps");
  });

  const ACTIVE_STATES: [string, ServiceRunState][] = [
    ["active", "running"],
    ["activating", "running"],
    ["reloading", "running"],
    ["refreshing", "running"],
    ["deactivating", "stopping"],
    ["inactive", "stopped"],
    ["failed", "stopped"],
    ["maintenance", "stopped"],
    ["banana", "unknown"],
  ];
  test.each(ACTIVE_STATES)("linux: ActiveState=%s maps to %s", (active, expected) => {
    expect(queryService(linuxStub({ ActiveState: active }).deps).state).toBe(expected);
  });

  test("linux: MainPID=0 is no pid", () => {
    expect(queryService(linuxStub({ ActiveState: "inactive", MainPID: "0" }).deps).pid).toBeNull();
  });

  test("linux: enabled-runtime still starts at login; disabled does not", () => {
    expect(queryService(linuxStub({ UnitFileState: "enabled-runtime" }).deps).enabled).toBe(true);
    expect(queryService(linuxStub({ UnitFileState: "disabled" }).deps).enabled).toBe(false);
  });

  // A masked unit refuses every control verb — say it once rather than letting
  // the operator discover it one command at a time.
  test("linux: a masked unit is called out in detail", () => {
    expect(queryService(linuxStub({ UnitFileState: "masked" }).deps).detail).toContain("masked");
  });

  test("linux: a failed unit quotes its SubState", () => {
    const state = queryService(linuxStub({ ActiveState: "failed", SubState: "exit-code" }).deps);
    expect(state.state).toBe("stopped");
    expect(state.detail).toContain("exit-code");
  });

  // A manager that cannot answer must not read as "stopped" — that would put a
  // Start button in front of a service that may well be running.
  test("linux: a failing show is unknown, and falls back to the file for the pane answer", () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "Failed to connect to bus\n" }) });
    s.files.set(UNIT, "[Service]\nKillMode=process\n");
    const state = queryService(s.deps);
    expect(state.state).toBe("unknown");
    expect(state.detail).toContain("Failed to connect to bus");
    expect(state.paneSafety).toBe("keeps");
  });

  test("linux: show failed AND the file unreadable is an honest unknown", () => {
    const s = stub({
      respond: () => ({ code: 1, out: "", err: "no bus\n" }),
      readFile: () => null,
      fileExists: () => true,
    });
    expect(queryService(s.deps).paneSafety).toBe("unknown");
  });

  // systemd's own rule is last-wins, so the fallback grep must agree with it.
  test("linux fallback: the LAST KillMode assignment wins", () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "no bus\n" }) });
    s.files.set(UNIT, "[Service]\nKillMode=process\nKillMode=control-group\n");
    expect(queryService(s.deps).paneSafety).toBe("kills");
  });

  test("linux fallback: a commented-out directive does not count", () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "no bus\n" }) });
    s.files.set(UNIT, "[Service]\n#KillMode=process\n");
    expect(queryService(s.deps).paneSafety).toBe("kills");
  });

  test("linux: the unit installService ACTUALLY writes reports KillMode=process to systemd", () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("show") ? { code: 1, out: "", err: "forced fallback" } : { code: 0, out: "", err: "" },
    });
    expect(installService(s.deps).code).toBe(0);
    // Read back through the FALLBACK grep, which is what parses the real text.
    expect(queryService(s.deps).paneSafety).toBe("keeps");
  });

  // `launchctl list` resolves an implicit domain; every write here targets
  // gui/<uid> explicitly, so the read must too or they disagree over SSH.
  test("darwin: state comes from `launchctl print` in the EXPLICIT gui domain", () => {
    const s = darwinStub();
    const state = queryService(s.deps);
    expect(
      s.calls.some((c) => c[0] === "launchctl" && c[1] === "print" && c[2] === "gui/1000/dev.subshell.server"),
    ).toBe(true);
    expect(s.calls.some((c) => c[1] === "list")).toBe(false);
    expect(state).toMatchObject({ installed: true, state: "running", pid: 5150, enabled: true, paneSafety: "keeps" });
  });

  // `launchctl print` nests `state = active` lines under endpoints; only the
  // single-tab top-level one describes the job.
  test("darwin: nested endpoint `state` lines do not confuse the parse", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[0] === "plutil"
          ? { code: 0, out: "true\n", err: "" }
          : { code: 0, out: "\tstate = running\n\tpid = 77\n\tendpoints = {\n\t\tstate = active\n\t}\n", err: "" },
    });
    s.files.set(PLIST, "<key>AbandonProcessGroup</key><true/>");
    expect(queryService(s.deps)).toMatchObject({ state: "running", pid: 77 });
  });

  test("darwin: a plist on disk with the label unloaded is installed-but-stopped", () => {
    expect(queryService(darwinStub({ loaded: false }).deps)).toMatchObject({
      installed: true,
      state: "stopped",
      pid: null,
    });
  });

  // Loadedness is carried APART from the run state, because a job can be
  // bootstrapped and idle at once — `print` answers (exit 0) with no pid. That
  // job is stopped AND loaded, and only the second fact says whether a
  // `bootout` is still owed.
  test("darwin: `loaded` is whether print answered, not whether a pid came back", () => {
    expect(queryService(darwinStub().deps)).toMatchObject({ state: "running", loaded: true });
    expect(queryService(darwinStub({ running: false }).deps)).toMatchObject({
      state: "stopped",
      pid: null,
      loaded: true,
    });
    expect(queryService(darwinStub({ loaded: false }).deps)).toMatchObject({ state: "stopped", loaded: false });
  });

  // plutil, not a regex: a binary1 plist that sets the key would read as
  // "kills" under any text-shaped predicate.
  test("darwin: the pane answer comes from plutil", () => {
    expect(queryService(darwinStub({ abandon: true }).deps).paneSafety).toBe("keeps");
    expect(queryService(darwinStub({ abandon: false }).deps).paneSafety).toBe("kills");
  });

  test("darwin: no plutil at all falls back to the text form", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[0] === "plutil" ? { code: 127, out: "", err: "spawn failed" } : { code: 113, out: "", err: "" },
    });
    s.files.set(PLIST, "<key>AbandonProcessGroup</key>\n<true></true>");
    expect(queryService(s.deps).paneSafety).toBe("keeps");
  });

  test("darwin: the plist installService ACTUALLY writes satisfies the text fallback", () => {
    const s = stub({
      platform: "darwin",
      // No plutil, and the job is not loaded — but the INSTALL's own
      // bootstrap must still succeed or this proves nothing.
      respond: (cmd) =>
        cmd[0] === "plutil"
          ? { code: 127, out: "", err: "spawn failed" }
          : cmd[1] === "print"
            ? { code: 113, out: "", err: "" }
            : { code: 0, out: "", err: "" },
    });
    expect(installService(s.deps).code).toBe(0);
    expect(queryService(s.deps).paneSafety).toBe("keeps");
  });
});

describe("controlService", () => {
  test("refuses every verb when nothing is installed — and runs no manager command", () => {
    for (const verb of SERVICE_VERBS) {
      const s = stub();
      const r = controlService(s.deps, verb);
      expect(r.code).toBe(1);
      expect(msgLine(r.err)).toContain("nothing installed");
      expect(s.calls).toEqual([]);
    }
  });

  test("unsupported platform refuses before touching anything", () => {
    const r = controlService(stub({ platform: "win32" }).deps, "start");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("win32");
  });

  test("linux: each verb maps to the plain systemctl verb, and says which it did", () => {
    for (const verb of SERVICE_VERBS) {
      const s = linuxStub(verb === "start" ? { ActiveState: "inactive", MainPID: "0" } : {});
      const r = controlService(s.deps, verb);
      expect(r.code).toBe(0);
      // The success line is the ONLY feedback the manager gives; pin it.
      expect(r.out.trim()).toBe(DONE[verb]);
      expect(s.calls[1]).toEqual(["systemctl", "--user", verb, "subshell-server.service"]);
      expect(s.calls).toHaveLength(2);
    }
  });

  // `disable --now` is uninstall's job: an operator who stops a service still
  // expects it back after a reboot.
  test("linux: stop does NOT disable the unit", () => {
    const s = linuxStub();
    controlService(s.deps, "stop");
    expect(s.calls.flat()).not.toContain("disable");
  });

  test("linux: a failing systemctl verb is quoted and exits 1", () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("show") ? { code: 0, out: showOut(), err: "" } : { code: 5, out: "", err: "Job failed\n" },
    });
    s.files.set(UNIT, "[Service]\nKillMode=process\n");
    const r = controlService(s.deps, "restart");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("Job failed");
  });

  test("restart REFUSES on a definition that would kill live panes", () => {
    const s = linuxStub({ KillMode: "control-group" });
    const r = controlService(s.deps, "restart");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("KillMode=process");
    expect(msgLine(r.err)).toContain("--force");
    // The refusal must land BEFORE the manager is asked to do anything.
    expect(s.calls.flat()).not.toContain("restart");
  });

  // An unreadable definition is not evidence of safety.
  test("restart REFUSES on an unknown pane answer, not just a known-bad one", () => {
    const s = stub({
      respond: () => ({ code: 1, out: "", err: "no bus\n" }),
      readFile: () => null,
      fileExists: () => true,
    });
    const r = controlService(s.deps, "restart");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("could not determine");
  });

  test("--force overrides the refusal", () => {
    const s = linuxStub({ KillMode: "control-group" });
    const r = controlService(s.deps, "restart", { force: true });
    expect(r.code).toBe(0);
    expect(s.calls[1]).toEqual(["systemctl", "--user", "restart", "subshell-server.service"]);
  });

  // stop is as lethal as restart, but refusing it would only push the operator
  // to `systemctl`, which warns about nothing. So it warns and proceeds.
  test("stop WARNS on a lethal definition but still stops (exit 0)", () => {
    const s = linuxStub({ KillMode: "control-group" });
    const r = controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning");
    expect(r.err).toContain("kills every running subshell");
    expect(s.calls[1]).toEqual(["systemctl", "--user", "stop", "subshell-server.service"]);
  });

  test("stop is silent when the definition is pane-safe", () => {
    expect(controlService(linuxStub().deps, "stop").err).toBe("");
  });

  test("start is never gated on the pane answer", () => {
    const s = linuxStub({ ActiveState: "inactive", MainPID: "0", KillMode: "control-group" });
    const r = controlService(s.deps, "start");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  test("darwin: stop unloads the job (KeepAlive undoes a mere kill)", () => {
    const s = darwinStub();
    const r = controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.stop);
    expect(s.calls.at(-1)).toEqual(["launchctl", "bootout", "gui/1000/dev.subshell.server"]);
  });

  // bootout on an unloaded job exits non-zero; a second stop must not look
  // like a failure when the systemd verb is idempotent.
  test("darwin: stop is idempotent — an already-stopped job is exit 0, no command", () => {
    const s = darwinStub({ loaded: false });
    const r = controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already stopped");
    expect(s.calls.some((c) => c[1] === "bootout")).toBe(false);
  });

  // The job launchd disagrees about: `print` answers, no pid, and the job is
  // STILL bootstrapped — KeepAlive/RunAtLoad can start it again and a later
  // `bootstrap` fails with "service already loaded". Short-circuiting on the
  // run state reported "already stopped" and booted out nothing.
  test("darwin: a LOADED but idle job is still booted out, never called already-stopped", () => {
    const s = darwinStub({ running: false });
    const r = controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.stop);
    expect(r.out).not.toContain("already stopped");
    expect(s.calls.at(-1)).toEqual(["launchctl", "bootout", "gui/1000/dev.subshell.server"]);
  });

  test("darwin: restart of a running job is kickstart -k (the README's own line)", () => {
    const s = darwinStub();
    const r = controlService(s.deps, "restart");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.restart);
    expect(s.calls.at(-1)).toEqual(["launchctl", "kickstart", "-k", "gui/1000/dev.subshell.server"]);
  });

  test("darwin: restart of a STOPPED job bootstraps it — kickstart needs a loaded job", () => {
    const s = darwinStub({ loaded: false });
    const r = controlService(s.deps, "restart");
    expect(r.code).toBe(0);
    expect(s.calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/1000", PLIST]);
  });

  test("darwin: start on an already-running job is a no-op success", () => {
    const s = darwinStub();
    const before = s.calls.length;
    const r = controlService(s.deps, "start");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already running");
    // Only the query's own calls (plutil + print) — nothing was driven.
    expect(s.calls.slice(before).some((c) => c[1] === "bootstrap" || c[1] === "kickstart")).toBe(false);
  });

  // A bare `kickstart` on a RUNNING job exits 0 and changes nothing (measured
  // on macOS 26.6.2), so the fallback must carry -k or a restart can report
  // success having restarted nothing.
  test("darwin: the bootstrap fallback uses kickstart -k, never a bare kickstart", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[0] === "plutil"
          ? { code: 0, out: "true\n", err: "" }
          : cmd[1] === "print"
            ? { code: 113, out: "", err: "" }
            : cmd[1] === "bootstrap"
              ? { code: 5, out: "", err: "service already bootstrapped\n" }
              : { code: 0, out: "", err: "" },
    });
    s.files.set(PLIST, "<key>AbandonProcessGroup</key><true/>");
    const r = controlService(s.deps, "start");
    expect(r.code).toBe(0);
    expect(s.calls.at(-1)).toEqual(["launchctl", "kickstart", "-k", "gui/1000/dev.subshell.server"]);
  });

  // Exit 5 is launchd's generic EIO — already-bootstrapped, disabled and an
  // unreadable plist all land there, so the message names the candidates.
  test("darwin: bootstrap AND kickstart failing is one error quoting both, plus the likely causes", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[0] === "plutil"
          ? { code: 0, out: "true\n", err: "" }
          : cmd[1] === "print"
            ? { code: 113, out: "", err: "" }
            : { code: 5, out: "", err: `${cmd[1]} broke\n` },
    });
    s.files.set(PLIST, "<key>AbandonProcessGroup</key><true/>");
    const r = controlService(s.deps, "start");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("bootstrap broke");
    expect(msgLine(r.err)).toContain("kickstart broke");
    expect(msgLine(r.err)).toContain("launchctl enable");
  });
});
