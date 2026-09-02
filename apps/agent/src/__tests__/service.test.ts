import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { execLine, installService, type ServiceDeps, uninstallService } from "../service.js";

/**
 * Everything here runs against stub deps — no systemd, no launchd, no real fs.
 * `home` is a fake path; the stubs record writes + argv so we can assert the
 * unit/plist templates and the exact service-manager command sequences.
 */
const HOME = "/home/tester";
const UNIT = join(HOME, ".config", "systemd", "user", "subshell.service");
const PLIST = join(HOME, "Library", "LaunchAgents", "dev.subshell.agent.plist");
const LOG = join(HOME, "Library", "Logs", "subshell.log");

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
    execPath: "/usr/local/bin/subshell",
    argv1: "/repo/apps/agent/src/main.ts",
    hasConfig: async () => true,
    runCmd: async (cmd) => {
      calls.push(cmd);
      return respond?.(cmd) ?? { code: 0, out: "", err: "" };
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    removeFile: async (path) => {
      removed.push(path);
      files.delete(path);
    },
    fileExists: async (path) => files.has(path),
    ...depsOver,
  };
  return { deps, calls, files, removed };
}

const msgLine = (err: string) => err.split("\n")[0] ?? "";

describe("execLine", () => {
  test("compiled binary (basename starts with subshell) runs itself + run", () => {
    expect(execLine({ execPath: "/opt/bin/subshell", argv1: "/ignored/main.ts" })).toEqual([
      "/opt/bin/subshell",
      "run",
    ]);
  });

  test("interpreter launch passes the resolved script path before run", () => {
    expect(execLine({ execPath: "/usr/local/bin/bun", argv1: "apps/agent/src/main.ts" })).toEqual([
      "/usr/local/bin/bun",
      resolve("apps/agent/src/main.ts"),
      "run",
    ]);
  });

  test("an absolute argv1 resolves to itself", () => {
    expect(execLine({ execPath: "/usr/local/bin/bun", argv1: "/repo/apps/agent/src/main.ts" })).toEqual([
      "/usr/local/bin/bun",
      "/repo/apps/agent/src/main.ts",
      "run",
    ]);
  });
});

describe("installService — linux (systemd user unit)", () => {
  test("writes the unit, reloads, enables+starts, and hints at linger", async () => {
    const s = stub();
    const res = await installService(s.deps);

    expect(res.code).toBe(0);
    const unit = s.files.get(UNIT);
    expect(unit).toBeDefined();
    expect(unit).toInclude("Description=subshell (subshell node daemon)");
    expect(unit).toInclude("ExecStart=/usr/local/bin/subshell run");
    expect(unit).toInclude("Restart=always");
    expect(unit).toInclude("RestartSec=5");

    expect(s.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "subshell.service"],
    ]);
    expect(res.out).toInclude("loginctl enable-linger");
  });

  test("dev-form execLine: interpreter + resolved script path in ExecStart", async () => {
    const s = stub({ execPath: "/usr/local/bin/bun", argv1: "/repo/apps/agent/src/main.ts" });
    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    expect(s.files.get(UNIT)).toInclude("ExecStart=/usr/local/bin/bun /repo/apps/agent/src/main.ts run");
  });

  test("dbus guard: a failing daemon-reload exits 1 with systemctl's stderr, unit stays on disk", async () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("daemon-reload")
          ? { code: 1, out: "", err: "Failed to connect to bus: No such file or directory" }
          : { code: 0, out: "", err: "" },
    });
    const res = await installService(s.deps);

    expect(res.code).toBe(1);
    expect(res.err).toInclude("Failed to connect to bus: No such file or directory");
    expect(s.files.has(UNIT)).toBe(true); // written before the reload — left in place
    expect(s.calls.length).toBe(1); // enable never attempted after a failed reload
  });
});

describe("installService — macOS (launchd agent)", () => {
  test("fresh install: valid plist at LaunchAgents, bootstrap only", async () => {
    const s = stub({ platform: "darwin" });
    const res = await installService(s.deps);

    expect(res.code).toBe(0);
    const plist = s.files.get(PLIST) ?? ""; // "" on a miss ⇒ the first toInclude below fails loudly
    expect(plist).toInclude("<string>dev.subshell.agent</string>");
    expect(plist).toInclude("<key>KeepAlive</key>");
    expect(plist).toInclude("<key>RunAtLoad</key>");
    expect(plist).toInclude("<string>/usr/local/bin/subshell</string>");
    expect(plist).toInclude("<string>run</string>");
    expect(plist.split(LOG).length - 1).toBe(2); // StandardOutPath AND StandardErrorPath
    expect(plist).toInclude("<key>StandardOutPath</key>");
    expect(plist).toInclude("<key>StandardErrorPath</key>");

    expect(s.calls).toEqual([["launchctl", "bootstrap", "gui/1000", PLIST]]);
  });

  test("reinstall: bootout (tolerated) before bootstrap; a bootout failure does not sink the install", async () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "bootout" ? { code: 3, out: "", err: "Could not find service" } : { code: 0, out: "", err: "" },
    });
    s.files.set(PLIST, "<plist>old</plist>"); // pre-existing unit ⇒ reinstall

    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([
      ["launchctl", "bootout", "gui/1000/dev.subshell.agent"],
      ["launchctl", "bootstrap", "gui/1000", PLIST],
    ]);
  });

  test("a failing bootstrap exits 1 with launchctl's stderr", async () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "bootstrap"
          ? { code: 5, out: "", err: "Bootstrap failed: 5: Input/output error" }
          : { code: 0, out: "", err: "" },
    });
    const res = await installService(s.deps);
    expect(res.code).toBe(1);
    expect(res.err).toInclude("Bootstrap failed: 5: Input/output error");
  });
});

describe("installService — guards", () => {
  test("unsupported platform: exit 1 with an actionable message, no writes, no commands", async () => {
    const s = stub({ platform: "win32" as NodeJS.Platform });
    const res = await installService(s.deps);

    expect(res.code).toBe(1);
    expect(msgLine(res.err)).toInclude("win32");
    expect(msgLine(res.err)).toInclude("subshell run");
    expect(s.files.size).toBe(0);
    expect(s.calls.length).toBe(0);
  });

  test("missing config: exit 1 pointing at enroll, no writes, no commands", async () => {
    const s = stub({ hasConfig: async () => false });
    const res = await installService(s.deps);

    expect(res.code).toBe(1);
    expect(res.err).toInclude("no config found — run subshell enroll first");
    expect(s.files.size).toBe(0);
    expect(s.calls.length).toBe(0);
  });
});

describe("uninstallService — linux", () => {
  test("stops+disables, reloads, and removes the unit", async () => {
    const s = stub();
    s.files.set(UNIT, "[Unit]\n"); // something installed

    const res = await uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "subshell.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(s.removed).toEqual([UNIT]);
    expect(s.files.has(UNIT)).toBe(false);
  });

  test("no unit on disk: exit 0 saying nothing is installed, no commands run", async () => {
    const s = stub();
    const res = await uninstallService(s.deps);

    expect(res.code).toBe(0);
    expect(res.out).toInclude("nothing installed");
    expect(s.calls.length).toBe(0);
    expect(s.removed.length).toBe(0);
  });
});

describe("uninstallService — macOS (launchd agent)", () => {
  test("stops via bootout, then removes the plist", async () => {
    const s = stub({ platform: "darwin" });
    s.files.set(PLIST, "<plist>old</plist>"); // something installed

    const res = await uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([["launchctl", "bootout", "gui/1000/dev.subshell.agent"]]);
    expect(s.removed).toEqual([PLIST]);
    expect(s.files.has(PLIST)).toBe(false);
    expect(res.out).toInclude("Removed");
  });

  test("no plist on disk: exit 0 saying nothing is installed, no commands run", async () => {
    const s = stub({ platform: "darwin" });
    const res = await uninstallService(s.deps);

    expect(res.code).toBe(0);
    expect(res.out).toInclude("nothing installed");
    expect(s.calls.length).toBe(0);
    expect(s.removed.length).toBe(0);
  });
});

describe("uninstallService — guards", () => {
  test("deleted config does NOT gate uninstall: full disable/reload/remove still runs, exit 0, notes the missing config", async () => {
    const s = stub({ hasConfig: async () => false });
    s.files.set(UNIT, "[Unit]\n"); // the unit is installed; the config is gone

    const res = await uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(s.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "subshell.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(s.removed).toEqual([UNIT]);
    expect(res.out).toInclude("(no agent config found — nothing else to clean up)");
  });

  test("unsupported platform: exit 1, no removals", async () => {
    const s = stub({ platform: "win32" as NodeJS.Platform });
    const res = await uninstallService(s.deps);

    expect(res.code).toBe(1);
    expect(s.removed.length).toBe(0);
  });
});

describe("unit/plist environment hardening (final-review minors)", () => {
  test("systemd ExecStart QUOTES tokens containing spaces (no word-split 203/EXEC)", async () => {
    const s = stub({ execPath: "/usr/local/bin/bun", argv1: "/home/john smith/repos/subshell/apps/agent/src/main.ts" });
    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    const unit = s.files.get(UNIT) ?? "";
    expect(unit).toInclude(
      `ExecStart=/usr/local/bin/bun "${resolve("/home/john smith/repos/subshell/apps/agent/src/main.ts")}" run`,
    );
    expect(unit).not.toInclude("ExecStart=/usr/local/bin/bun /home/john smith"); // unquoted split-form is the bug
  });

  test("clean paths stay byte-identical (no gratuitous quoting)", async () => {
    const s = stub();
    await installService(s.deps);
    expect(s.files.get(UNIT) ?? "").toInclude("ExecStart=/usr/local/bin/subshell run");
  });

  test("servicePath bakes Environment=PATH= before ExecStart; absent → no line (historical byte-exact)", async () => {
    const withPath = stub({ servicePath: "/usr/bin:/opt/homebrew/bin" });
    await installService(withPath.deps);
    const unit = withPath.files.get(UNIT) ?? "";
    expect(unit).toInclude("Environment=PATH=/usr/bin:/opt/homebrew/bin\nExecStart=");

    const without = stub();
    await installService(without.deps);
    expect(without.files.get(UNIT) ?? "").not.toInclude("Environment=");
  });

  test("a spaced servicePath is quoted too", async () => {
    const s = stub({ servicePath: "/usr/bin:/opt/my tools/bin" });
    await installService(s.deps);
    expect(s.files.get(UNIT) ?? "").toInclude('Environment=PATH="/usr/bin:/opt/my tools/bin"');
  });

  test("launchd: servicePath adds an EnvironmentVariables/PATH dict; absent → byte-exact plist", async () => {
    const s = stub({ platform: "darwin", servicePath: "/usr/bin:/opt/homebrew/bin" });
    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    const plist = s.files.get(PLIST) ?? "";
    expect(plist).toInclude("<key>EnvironmentVariables</key>");
    expect(plist).toInclude("<key>PATH</key>");
    expect(plist).toInclude("<string>/usr/bin:/opt/homebrew/bin</string>");
    // PATH sits between ProgramArguments and RunAtLoad (valid plist order).
    expect(plist.indexOf("EnvironmentVariables")).toBeGreaterThan(plist.indexOf("</array>"));
    expect(plist.indexOf("EnvironmentVariables")).toBeLessThan(plist.indexOf("RunAtLoad"));

    const without = stub({ platform: "darwin" });
    await installService(without.deps);
    expect(without.files.get(PLIST) ?? "").not.toInclude("EnvironmentVariables");
  });
});
