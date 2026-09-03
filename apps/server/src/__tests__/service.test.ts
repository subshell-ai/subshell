import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { execLine, installService, type ServiceDeps, uninstallService } from "../service.js";

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
/** Distinct from the client's `~/Library/Logs/subshell.log` — pinned below. */
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
    argv1: "/repo/apps/server/src/index.ts",
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

  test("a release-named artifact (subshell-server-linux-x64) is recognised too", () => {
    expect(execLine({ servicePath: "/x/subshell-server-linux-x64", argv1: "/ignored/index.ts" })).toEqual([
      "/x/subshell-server-linux-x64",
    ]);
  });

  test("interpreter launch passes the resolved script path (no subcommand)", () => {
    expect(execLine({ servicePath: "/usr/local/bin/bun", argv1: "apps/server/src/index.ts" })).toEqual([
      "/usr/local/bin/bun",
      resolve("apps/server/src/index.ts"),
    ]);
  });

  test("an absolute argv1 resolves to itself", () => {
    expect(execLine({ servicePath: "/usr/local/bin/bun", argv1: "/repo/apps/server/src/index.ts" })).toEqual([
      "/usr/local/bin/bun",
      "/repo/apps/server/src/index.ts",
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
    const s = stub({ servicePath: "/usr/local/bin/bun", argv1: "/repo/apps/server/src/index.ts" });
    const res = installService(s.deps);
    expect(res.code).toBe(0);
    expect(s.files.get(UNIT)).toInclude("ExecStart=/usr/local/bin/bun /repo/apps/server/src/index.ts");
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
      argv1: "/home/john smith/repos/subshell/apps/server/src/index.ts",
    });
    const res = installService(s.deps);
    expect(res.code).toBe(0);
    const unit = s.files.get(UNIT) ?? "";
    expect(unit).toInclude('Environment=PATH="/usr/bin:/opt/my tools/bin"');
    expect(unit).toInclude(
      `ExecStart=/usr/local/bin/bun "${resolve("/home/john smith/repos/subshell/apps/server/src/index.ts")}"`,
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
    expect(plist).toInclude("<string>/usr/local/bin/subshell-server</string>");
    // The log is the SERVER's own file — never the client's subshell.log.
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
