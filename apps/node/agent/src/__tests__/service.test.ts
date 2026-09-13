import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  controlService,
  DEFAULT_DEPS,
  DONE,
  execLine,
  installService,
  isServiceVerb,
  queryService,
  SERVICE_VERBS,
  type ServiceRunState,
  serviceStateLines,
  uninstallService,
} from "../service.js";
import {
  darwinServiceStub,
  LOG,
  linuxServiceStub,
  PLIST,
  showOut,
  serviceStub as stub,
  TARGET,
  UNIT,
} from "./helpers/service-stub.js";

/**
 * Everything here runs against stub deps — no systemd, no launchd, no real fs
 * (`helpers/service-stub.ts`, shared with the CLI suite). `home` is a fake
 * path; the stubs record writes + argv so we can assert the unit/plist
 * templates and the exact service-manager command sequences.
 */

const msgLine = (err: string) => err.split("\n")[0] ?? "";

describe("execLine", () => {
  test("compiled binary (basename starts with subshell) runs itself + run", () => {
    expect(execLine({ execPath: "/opt/bin/subshell", argv1: "/ignored/main.ts" })).toEqual([
      "/opt/bin/subshell",
      "run",
    ]);
  });

  test("interpreter launch passes the resolved script path before run", () => {
    expect(execLine({ execPath: "/usr/local/bin/bun", argv1: "apps/node/agent/src/main.ts" })).toEqual([
      "/usr/local/bin/bun",
      resolve("apps/node/agent/src/main.ts"),
      "run",
    ]);
  });

  test("an absolute argv1 resolves to itself", () => {
    expect(execLine({ execPath: "/usr/local/bin/bun", argv1: "/repo/apps/node/agent/src/main.ts" })).toEqual([
      "/usr/local/bin/bun",
      "/repo/apps/node/agent/src/main.ts",
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
    // Panes are stateful daemons — a stop/restart must kill only the daemon,
    // never the tmux servers in its cgroup (spec: keep-panes, 2026-09-03).
    expect(unit).toInclude("KillMode=process");

    expect(s.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "subshell.service"],
    ]);
    expect(res.out).toInclude("loginctl enable-linger");
  });

  test("dev-form execLine: interpreter + resolved script path in ExecStart", async () => {
    const s = stub({ execPath: "/usr/local/bin/bun", argv1: "/repo/apps/node/agent/src/main.ts" });
    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    expect(s.files.get(UNIT)).toInclude("ExecStart=/usr/local/bin/bun /repo/apps/node/agent/src/main.ts run");
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
    expect(plist).toInclude("<string>dev.subshell.client</string>");
    // The Login-Items attribution: without it System Settings labels this job
    // with the SIGNING ORGANIZATION ("Disaresta, LLC") instead of Subshell
    // Client, and the value must equal the app's bundle identifier — both are
    // the one DESKTOP_CLIENT_BUNDLE_ID constant this label is also built from.
    expect(plist).toInclude("<key>AssociatedBundleIdentifiers</key>");
    expect(plist).toInclude("<key>KeepAlive</key>");
    expect(plist).toInclude("<key>RunAtLoad</key>");
    // launchd's twin of KillMode=process: a stopped agent must not take its
    // tmux children (the live panes) with it.
    expect(plist).toInclude("<key>AbandonProcessGroup</key>");
    expect(plist).toInclude("<string>/usr/local/bin/subshell</string>");
    expect(plist).toInclude("<string>run</string>");
    expect(plist.split(LOG).length - 1).toBe(2); // StandardOutPath AND StandardErrorPath
    expect(plist).toInclude("<key>StandardOutPath</key>");
    expect(plist).toInclude("<key>StandardErrorPath</key>");

    // A bootout precedes EVERY bootstrap, including this one where no plist
    // was on disk: the file is only a proxy for "is this label loaded", and it
    // lies after a reset, which deletes the plist while the job is still in
    // the domain.
    expect(s.calls).toEqual([
      ["launchctl", "bootout", "gui/1000/dev.subshell.client"],
      ["launchctl", "bootstrap", "gui/1000", PLIST],
    ]);
  });

  /**
   * The server CLI hit this for real on 2026-09-12 — reset, set up again,
   * "Bootstrap failed: 5: Input/output error" while nothing was wrong with the
   * plist. `bootout` returns before the job has left the domain.
   */
  test("a busy domain is waited out, not reported as a failure", async () => {
    let bootstraps = 0;
    const slept: number[] = [];
    const s = stub({
      platform: "darwin",
      sleep: (ms: number) => {
        slept.push(ms);
      },
      respond: (cmd) => {
        if (cmd[1] !== "bootstrap") return { code: 0, out: "", err: "" };
        bootstraps += 1;
        return bootstraps <= 2
          ? { code: 5, out: "", err: "Bootstrap failed: 5: Input/output error" }
          : { code: 0, out: "", err: "" };
      },
    });
    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    expect(bootstraps).toBe(3);
    expect(slept.length).toBe(2);
  });

  /** The budget is a decision, so it is asserted rather than left as a constant. */
  test("gives up after the whole budget, in launchd's own words", async () => {
    let bootstraps = 0;
    const slept: number[] = [];
    const s = stub({
      platform: "darwin",
      sleep: (ms: number) => {
        slept.push(ms);
      },
      respond: (cmd) => {
        if (cmd[1] !== "bootstrap") return { code: 0, out: "", err: "" };
        bootstraps += 1;
        return { code: 5, out: "", err: "Bootstrap failed: 5: Input/output error" };
      },
    });
    const res = await installService(s.deps);
    expect(res.code).not.toBe(0);
    expect(bootstraps).toBe(60);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(29_500);
    expect(res.err).toInclude("Input/output error");
  });

  test("a real bootstrap failure is reported at once", async () => {
    let bootstraps = 0;
    const s = stub({
      platform: "darwin",
      respond: (cmd) => {
        if (cmd[1] !== "bootstrap") return { code: 0, out: "", err: "" };
        bootstraps += 1;
        return { code: 112, out: "", err: "Could not find specified service" };
      },
    });
    const res = await installService(s.deps);
    expect(res.code).not.toBe(0);
    expect(bootstraps).toBe(1);
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
      ["launchctl", "bootout", "gui/1000/dev.subshell.client"],
      ["launchctl", "bootstrap", "gui/1000", PLIST],
    ]);
  });

  test("a failing bootstrap exits 1 with launchctl's stderr", async () => {
    const s = stub({
      platform: "darwin",
      // EIO is a BUSY answer, so this goes through the whole retry budget —
      // thirty seconds of real waiting for a case that is about the message.
      sleep: () => {},
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
    expect(res.err).toInclude("no config found: run subshell enroll first");
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
    expect(s.calls).toEqual([["launchctl", "bootout", "gui/1000/dev.subshell.client"]]);
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
    expect(res.out).toInclude("(no agent config found, nothing else to clean up)");
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
    const s = stub({
      execPath: "/usr/local/bin/bun",
      argv1: "/home/john smith/repos/subshell/apps/node/agent/src/main.ts",
    });
    const res = await installService(s.deps);
    expect(res.code).toBe(0);
    const unit = s.files.get(UNIT) ?? "";
    expect(unit).toInclude(
      `ExecStart=/usr/local/bin/bun "${resolve("/home/john smith/repos/subshell/apps/node/agent/src/main.ts")}" run`,
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

/**
 * `queryService` reads; `controlService` drives. Both run against the same
 * stub disk/argv recorder as the install suite above, and the most valuable
 * cases are where the WRITER and the READER meet: the definition
 * `installService` writes must satisfy the pane check `controlService` gates
 * on, or the guard fires on our own unit.
 *
 * Two platform facts these pin, both measured on real tools rather than
 * assumed: systemd's EFFECTIVE `KillMode` comes from `systemctl show` (a unit
 * file grep cannot see drop-ins under `subshell.service.d/`), and launchd
 * state comes from `launchctl print gui/<uid>/…` (legacy `launchctl list`
 * resolves an IMPLICIT domain and reports a running gui job as absent over
 * SSH).
 */

describe("SERVICE_VERBS", () => {
  test("the runtime list and the narrowing predicate agree", () => {
    expect([...SERVICE_VERBS]).toEqual(["start", "stop", "restart"]);
    for (const verb of SERVICE_VERBS) expect(isServiceVerb(verb)).toBe(true);
    for (const word of ["install", "uninstall", "status", "", "Start"]) expect(isServiceVerb(word)).toBe(false);
  });
});

describe("queryService", () => {
  test("no definition on disk is not-installed — and no manager command runs", async () => {
    const s = stub();
    const state = await queryService(s.deps);
    expect(state).toMatchObject({ installed: false, state: "not-installed", definitionPath: UNIT, paneSafety: null });
    expect(s.calls).toEqual([]);
  });

  test("a platform with no per-user manager reports not-installed with a reason", async () => {
    const s = stub({ platform: "win32" as NodeJS.Platform });
    const state = await queryService(s.deps);
    expect(state.definitionPath).toBeNull();
    expect(state.detail).toContain("win32");
    expect(s.calls).toEqual([]);
  });

  test("linux: ONE systemctl show carries every property, KillMode included", async () => {
    const s = linuxServiceStub();
    const state = await queryService(s.deps);
    expect(s.calls).toEqual([
      [
        "systemctl",
        "--user",
        "show",
        "subshell.service",
        "--property=ActiveState,SubState,UnitFileState,MainPID,KillMode",
      ],
    ]);
    expect(state).toMatchObject({ installed: true, state: "running", pid: 4242, enabled: true, paneSafety: "keeps" });
  });

  // The whole reason KillMode is asked of systemd rather than grepped: a
  // drop-in under <unit>.d/ overrides the file, and the file cannot see it.
  test("linux: the EFFECTIVE KillMode wins over the unit file's text", async () => {
    const s = linuxServiceStub({ KillMode: "control-group" });
    // The file on disk still says process — a grep would answer "keeps".
    expect(s.files.get(UNIT)).toContain("KillMode=process");
    expect((await queryService(s.deps)).paneSafety).toBe("kills");
  });

  test("linux: KillMode=none also spares the panes", async () => {
    expect((await queryService(linuxServiceStub({ KillMode: "none" }).deps)).paneSafety).toBe("keeps");
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
  test.each(ACTIVE_STATES)("linux: ActiveState=%s maps to %s", async (active, expected) => {
    expect((await queryService(linuxServiceStub({ ActiveState: active }).deps)).state).toBe(expected);
  });

  test("linux: MainPID=0 is no pid", async () => {
    expect((await queryService(linuxServiceStub({ ActiveState: "inactive", MainPID: "0" }).deps)).pid).toBeNull();
  });

  test("linux: enabled-runtime still starts at login; disabled does not", async () => {
    expect((await queryService(linuxServiceStub({ UnitFileState: "enabled-runtime" }).deps)).enabled).toBe(true);
    expect((await queryService(linuxServiceStub({ UnitFileState: "disabled" }).deps)).enabled).toBe(false);
  });

  // A masked unit refuses every control verb — say it once rather than letting
  // the operator discover it one command at a time.
  test("linux: a masked unit is called out in detail", async () => {
    expect((await queryService(linuxServiceStub({ UnitFileState: "masked" }).deps)).detail).toContain("masked");
  });

  test("linux: a failed unit quotes its SubState", async () => {
    const state = await queryService(linuxServiceStub({ ActiveState: "failed", SubState: "exit-code" }).deps);
    expect(state.state).toBe("stopped");
    expect(state.detail).toContain("exit-code");
  });

  // A manager that cannot answer must not read as "stopped" — that would put a
  // Start button in front of a daemon that may well be running.
  test("linux: a failing show is unknown, and falls back to the file for the pane answer", async () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "Failed to connect to bus\n" }) });
    s.files.set(UNIT, "[Service]\nKillMode=process\n");
    const state = await queryService(s.deps);
    expect(state.state).toBe("unknown");
    expect(state.detail).toContain("Failed to connect to bus");
    expect(state.paneSafety).toBe("keeps");
  });

  test("linux: show failed AND the file unreadable is an honest unknown", async () => {
    const s = stub({
      respond: () => ({ code: 1, out: "", err: "no bus\n" }),
      readFile: async () => null,
      fileExists: async () => true,
    });
    expect((await queryService(s.deps)).paneSafety).toBe("unknown");
  });

  // systemd's own rule is last-wins, so the fallback grep must agree with it.
  test("linux fallback: the LAST KillMode assignment wins", async () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "no bus\n" }) });
    s.files.set(UNIT, "[Service]\nKillMode=process\nKillMode=control-group\n");
    expect((await queryService(s.deps)).paneSafety).toBe("kills");
  });

  test("linux fallback: a commented-out directive does not count", async () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "no bus\n" }) });
    s.files.set(UNIT, "[Service]\n#KillMode=process\n");
    expect((await queryService(s.deps)).paneSafety).toBe("kills");
  });

  test("linux: the unit installService ACTUALLY writes reports KillMode=process to systemd", async () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("show") ? { code: 1, out: "", err: "forced fallback" } : { code: 0, out: "", err: "" },
    });
    expect((await installService(s.deps)).code).toBe(0);
    // Read back through the FALLBACK grep, which is what parses the real text.
    expect((await queryService(s.deps)).paneSafety).toBe("keeps");
  });

  // `launchctl list` resolves an implicit domain; every write here targets
  // gui/<uid> explicitly, so the read must too or they disagree over SSH.
  test("darwin: state comes from `launchctl print` in the EXPLICIT gui domain", async () => {
    const s = darwinServiceStub();
    const state = await queryService(s.deps);
    expect(s.calls.some((c) => c[0] === "launchctl" && c[1] === "print" && c[2] === TARGET)).toBe(true);
    expect(s.calls.some((c) => c[1] === "list")).toBe(false);
    expect(state).toMatchObject({ installed: true, state: "running", pid: 5150, enabled: true, paneSafety: "keeps" });
  });

  // The pairing that made `RunAtLoad` alone the wrong thing to read. Measured
  // on macOS 26.6.2 (for the server's own agent, same launchd): a
  // `KeepAlive=true` + `RunAtLoad=false` job reported `runs = 1` two seconds
  // after `bootstrap`, while a control without `KeepAlive` reported `runs = 0`.
  test("darwin: KeepAlive starts it at login even with RunAtLoad false", async () => {
    const s = darwinServiceStub();
    s.files.set(PLIST, "<key>RunAtLoad</key><false/><key>KeepAlive</key><true/>");
    // Reporting "does not start at login" about a job that does is the failure
    // worth avoiding; there is no verb on this side that turns it off.
    expect((await queryService(s.deps)).enabled).toBe(true);
  });

  test("darwin: neither key means it really does not come back on its own", async () => {
    const s = darwinServiceStub();
    s.files.set(PLIST, "<key>AbandonProcessGroup</key><true/>");
    expect((await queryService(s.deps)).enabled).toBe(false);
  });

  // `launchctl print` nests `state = active` lines under endpoints; only the
  // single-tab top-level one describes the job.
  test("darwin: nested endpoint `state` lines do not confuse the parse", async () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[0] === "plutil"
          ? { code: 0, out: "true\n", err: "" }
          : { code: 0, out: "\tstate = running\n\tpid = 77\n\tendpoints = {\n\t\tstate = active\n\t}\n", err: "" },
    });
    s.files.set(PLIST, "<key>AbandonProcessGroup</key><true/>");
    expect(await queryService(s.deps)).toMatchObject({ state: "running", pid: 77 });
  });

  test("darwin: a plist on disk with the label unloaded is installed-but-stopped", async () => {
    expect(await queryService(darwinServiceStub({ loaded: false }).deps)).toMatchObject({
      installed: true,
      state: "stopped",
      pid: null,
    });
  });

  // Loadedness is carried APART from the run state, because a job can be
  // bootstrapped and idle at once — `print` answers (exit 0) with no pid. That
  // job is stopped AND loaded, and only the second fact says whether a
  // `bootout` is still owed.
  test("darwin: `loaded` is whether print answered, not whether a pid came back", async () => {
    expect(await queryService(darwinServiceStub().deps)).toMatchObject({ state: "running", loaded: true });
    expect(await queryService(darwinServiceStub({ running: false }).deps)).toMatchObject({
      state: "stopped",
      pid: null,
      loaded: true,
    });
    expect(await queryService(darwinServiceStub({ loaded: false }).deps)).toMatchObject({
      state: "stopped",
      loaded: false,
    });
  });

  // Exit 113 ("Could not find service") legitimately means not-loaded; ANY
  // other non-zero print means the manager REFUSED TO ANSWER, and "stopped"
  // from that is a guess. A crash-looping job previously read as a confident,
  // undiagnosable stop (the server CLI's 2026-09-07 incident, same shape).
  test("darwin: a print failure that is not 'not loaded' is unknown, with the output kept", async () => {
    const notFound = await queryService(darwinServiceStub({ loaded: false }).deps);
    expect(notFound).toMatchObject({ state: "stopped", detail: "" });

    const s = darwinServiceStub({ printError: { code: 5, err: "Could not read domain: Input/output error" } });
    const unknown = await queryService(s.deps);
    expect(unknown.state).toBe("unknown");
    expect(unknown.detail).toInclude("exit 5");
    expect(unknown.detail).toInclude("Input/output error");
  });

  // launchd states are MULTI-WORD — "spawn scheduled" is the crash-throttle
  // wait, and a \S+ capture would report just "spawn". The verbatim line is
  // the difference between "stopped" and "stopped AND KEEPING CRASHING".
  test("darwin: the raw state line rides into detail verbatim", async () => {
    const state = await queryService(darwinServiceStub({ running: false, stateLine: "spawn scheduled" }).deps);
    expect(state).toMatchObject({ state: "stopped", detail: "launchd: spawn scheduled" });
    // A running job answers its own question; no editorializing.
    expect((await queryService(darwinServiceStub().deps)).detail).toBe("");
  });

  // logPath is the reveal answer: the file the PLIST names on macOS, an
  // honest null on Linux where the unit redirects nothing (journal). Set even
  // when nothing is installed — "is there a log to open" is asked in exactly
  // the states where the service is not running.
  test("logPath is the CLI's own platform answer on every state", async () => {
    expect((await queryService(darwinServiceStub().deps)).logPath).toBe(LOG);
    expect((await queryService(linuxServiceStub().deps)).logPath).toBeNull();
    const fresh = stub({ platform: "darwin" });
    expect((await queryService(fresh.deps)).logPath).toBe(LOG);
  });

  // plutil, not a regex: a binary1 plist that sets the key would read as
  // "kills" under any text-shaped predicate.
  test("darwin: the pane answer comes from plutil", async () => {
    expect((await queryService(darwinServiceStub({ abandon: true }).deps)).paneSafety).toBe("keeps");
    expect((await queryService(darwinServiceStub({ abandon: false }).deps)).paneSafety).toBe("kills");
  });

  test("darwin: no plutil at all falls back to the text form", async () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[0] === "plutil" ? { code: 127, out: "", err: "spawn failed" } : { code: 113, out: "", err: "" },
    });
    s.files.set(PLIST, "<key>AbandonProcessGroup</key>\n<true></true>");
    expect((await queryService(s.deps)).paneSafety).toBe("keeps");
  });

  test("darwin: the plist installService ACTUALLY writes satisfies the text fallback", async () => {
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
    expect((await installService(s.deps)).code).toBe(0);
    expect((await queryService(s.deps)).paneSafety).toBe("keeps");
  });
});

describe("controlService", () => {
  test("refuses every verb when nothing is installed — and runs no manager command", async () => {
    for (const verb of SERVICE_VERBS) {
      const s = stub();
      const r = await controlService(s.deps, verb);
      expect(r.code).toBe(1);
      expect(msgLine(r.err)).toContain("nothing installed");
      expect(msgLine(r.err)).toContain("subshell service install");
      expect(s.calls).toEqual([]);
    }
  });

  test("unsupported platform refuses before touching anything", async () => {
    const s = stub({ platform: "win32" as NodeJS.Platform });
    const r = await controlService(s.deps, "start");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("win32");
    expect(s.calls).toEqual([]);
  });

  test("linux: each verb maps to the plain systemctl verb, and says which it did", async () => {
    for (const verb of SERVICE_VERBS) {
      const s = linuxServiceStub(verb === "start" ? { ActiveState: "inactive", MainPID: "0" } : {});
      const r = await controlService(s.deps, verb);
      expect(r.code).toBe(0);
      // The success line is the ONLY feedback the manager gives; pin it.
      expect(r.out.trim()).toBe(DONE[verb]);
      expect(s.calls[1]).toEqual(["systemctl", "--user", verb, "subshell.service"]);
      expect(s.calls).toHaveLength(2);
    }
  });

  // `disable --now` is uninstall's job: an operator who stops the daemon still
  // expects it back after a reboot.
  test("linux: stop does NOT disable the unit", async () => {
    const s = linuxServiceStub();
    await controlService(s.deps, "stop");
    expect(s.calls.flat()).not.toContain("disable");
  });

  test("linux: a failing systemctl verb is quoted and exits 1", async () => {
    const s = stub({
      respond: (cmd) =>
        cmd.includes("show") ? { code: 0, out: showOut(), err: "" } : { code: 5, out: "", err: "Job failed\n" },
    });
    s.files.set(UNIT, "[Service]\nKillMode=process\n");
    const r = await controlService(s.deps, "restart");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("Job failed");
  });

  test("restart REFUSES on a definition that would kill live panes", async () => {
    const s = linuxServiceStub({ KillMode: "control-group" });
    const r = await controlService(s.deps, "restart");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("KillMode=process");
    expect(msgLine(r.err)).toContain("--force");
    // The refusal must land BEFORE the manager is asked to do anything.
    expect(s.calls.flat()).not.toContain("restart");
  });

  // An unreadable definition is not evidence of safety.
  test("restart REFUSES on an unknown pane answer, not just a known-bad one", async () => {
    const s = stub({
      respond: () => ({ code: 1, out: "", err: "no bus\n" }),
      readFile: async () => null,
      fileExists: async () => true,
    });
    const r = await controlService(s.deps, "restart");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("could not determine");
  });

  test("--force overrides the refusal", async () => {
    const s = linuxServiceStub({ KillMode: "control-group" });
    const r = await controlService(s.deps, "restart", { force: true });
    expect(r.code).toBe(0);
    expect(s.calls[1]).toEqual(["systemctl", "--user", "restart", "subshell.service"]);
  });

  // stop is as lethal as restart, but refusing it would only push the operator
  // to `systemctl`, which warns about nothing. So it warns and proceeds.
  test("stop WARNS on a lethal definition but still stops (exit 0)", async () => {
    const s = linuxServiceStub({ KillMode: "control-group" });
    const r = await controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning");
    expect(r.err).toContain("kills every running subshell");
    expect(s.calls[1]).toEqual(["systemctl", "--user", "stop", "subshell.service"]);
  });

  test("stop is silent when the definition is pane-safe", async () => {
    expect((await controlService(linuxServiceStub().deps, "stop")).err).toBe("");
  });

  test("start is never gated on the pane answer", async () => {
    const s = linuxServiceStub({ ActiveState: "inactive", MainPID: "0", KillMode: "control-group" });
    const r = await controlService(s.deps, "start");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  test("darwin: stop unloads the job (KeepAlive undoes a mere kill)", async () => {
    const s = darwinServiceStub();
    const r = await controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.stop);
    expect(s.calls.at(-1)).toEqual(["launchctl", "bootout", TARGET]);
  });

  // bootout on an unloaded job exits non-zero; a second stop must not look
  // like a failure when the systemd verb is idempotent.
  test("darwin: stop is idempotent — an already-stopped job is exit 0, no command", async () => {
    const s = darwinServiceStub({ loaded: false });
    const r = await controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already stopped");
    expect(s.calls.some((c) => c[1] === "bootout")).toBe(false);
  });

  // The job launchd disagrees about: `print` answers, no pid, and the job is
  // STILL bootstrapped — KeepAlive/RunAtLoad can start it again and a later
  // `bootstrap` fails with "service already loaded". Short-circuiting on the
  // run state reported "already stopped" and booted out nothing.
  test("darwin: a LOADED but idle job is still booted out, never called already-stopped", async () => {
    const s = darwinServiceStub({ running: false });
    const r = await controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.stop);
    expect(r.out).not.toContain("already stopped");
    expect(s.calls.at(-1)).toEqual(["launchctl", "bootout", TARGET]);
  });

  test("darwin: restart of a running job is kickstart -k", async () => {
    const s = darwinServiceStub();
    const r = await controlService(s.deps, "restart");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.restart);
    expect(s.calls.at(-1)).toEqual(["launchctl", "kickstart", "-k", TARGET]);
  });

  test("darwin: restart of a STOPPED job bootstraps it — kickstart needs a loaded job", async () => {
    const s = darwinServiceStub({ loaded: false });
    const r = await controlService(s.deps, "restart");
    expect(r.code).toBe(0);
    expect(s.calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/1000", PLIST]);
  });

  // The fail-open hole `state: unknown` could have dug: `loaded` is false
  // there only because nothing ANSWERED, and a no-op keyed on that alone
  // would answer "already stopped" for a daemon running behind a flaky
  // manager. Stop attempts the bootout and lets the manager's real answer
  // speak — this verb ends live panes when it guesses. (Port of the server
  // CLI's same fix, review 2026-09-08.)
  test("darwin: stop on an UNANSWERABLE manager attempts the bootout, never 'already stopped'", async () => {
    const s = darwinServiceStub({ printError: { code: 5, err: "Could not read domain: Input/output error" } });
    const r = await controlService(s.deps, "stop");
    expect(r.out).not.toContain("already stopped");
    expect(s.calls.some((c) => c[1] === "bootout")).toBe(true);
    expect(r.code).toBe(0); // the stub's bootout answers 0 — the success is ITS, not a shortcut's
  });

  test("darwin: start on an already-running job is a no-op success", async () => {
    const s = darwinServiceStub();
    const before = s.calls.length;
    const r = await controlService(s.deps, "start");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already running");
    // Only the query's own calls (plutil + print) — nothing was driven.
    expect(s.calls.slice(before).some((c) => c[1] === "bootstrap" || c[1] === "kickstart")).toBe(false);
  });

  // A bare `kickstart` on a RUNNING job exits 0 and changes nothing (measured
  // on macOS 26.6.2), so the fallback must carry -k or a restart can report
  // success having restarted nothing.
  test("darwin: the bootstrap fallback uses kickstart -k, never a bare kickstart", async () => {
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
    const r = await controlService(s.deps, "start");
    expect(r.code).toBe(0);
    expect(s.calls.at(-1)).toEqual(["launchctl", "kickstart", "-k", TARGET]);
  });

  // Exit 5 is launchd's generic EIO — already-bootstrapped, disabled and an
  // unreadable plist all land there, so the message names the candidates.
  test("darwin: bootstrap AND kickstart failing is one error quoting both, plus the likely causes", async () => {
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
    const r = await controlService(s.deps, "start");
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("bootstrap broke");
    expect(msgLine(r.err)).toContain("kickstart broke");
    expect(msgLine(r.err)).toContain("launchctl enable");
  });
});

/**
 * The one suite that does NOT run against the stub. `DEFAULT_DEPS` is where
 * the real `Bun.spawn` lives, and an injected `runCmd` — what every case above
 * uses — can never exercise it, so the spawn guard has to be driven directly
 * with a command name that cannot exist on any machine.
 */
describe("DEFAULT_DEPS.runCmd", () => {
  const deps = DEFAULT_DEPS(async () => true);

  // Bun.spawn THROWS on ENOENT ("Executable not found in $PATH"). Unguarded,
  // that escapes through queryService and turns `service status` — documented
  // to always exit 0 with a state — into a stack-shaped exit 1 on any box
  // without systemctl/launchctl.
  test("a manager binary that is not on PATH is a failed command, not a throw", async () => {
    const res = await deps.runCmd(["subshell-no-such-service-manager-9f3a", "--version"]);
    expect(res.code).toBe(127);
    expect(res.out).toBe("");
    expect(res.err).toContain("spawn failed");
  });

  test("a real command still reports its own exit code and both streams", async () => {
    const res = await deps.runCmd(["/bin/sh", "-c", "printf hello; printf oops 1>&2; exit 3"]);
    expect(res).toEqual({ code: 3, out: "hello", err: "oops" });
  });
});

describe("serviceStateLines", () => {
  test("nothing installed points at the install command", async () => {
    const lines = serviceStateLines(await queryService(stub().deps));
    expect(lines[0]).toContain(`not installed (${UNIT})`);
    expect(lines.join("\n")).toContain("subshell service install");
  });

  test("a platform with no manager says n/a rather than 'not installed'", async () => {
    const lines = serviceStateLines(await queryService(stub({ platform: "win32" as NodeJS.Platform }).deps));
    expect(lines).toEqual(["service              = n/a (no per-user service manager on this platform)"]);
  });

  test("an installed unit reports state, pid, login and the pane answer", async () => {
    const lines = serviceStateLines(await queryService(linuxServiceStub().deps)).join("\n");
    expect(lines).toContain(`definition installed (${UNIT})`);
    expect(lines).toContain("state                = running (pid 4242)");
    expect(lines).toContain("starts at login      = yes");
    expect(lines).toContain("teardown keeps panes = yes");
  });

  // The line an operator cannot get out of systemctl, and the one that decides
  // whether a restart costs them every pane on this node.
  test("a lethal definition says so in the pane line", async () => {
    const lines = serviceStateLines(await queryService(linuxServiceStub({ KillMode: "control-group" }).deps));
    expect(lines.join("\n")).toContain("teardown keeps panes = NO");
  });

  test("darwin: a loaded agent reports its launchd pid", async () => {
    const lines = serviceStateLines(await queryService(darwinServiceStub().deps)).join("\n");
    expect(lines).toContain(`definition installed (${PLIST})`);
    expect(lines).toContain("state                = running (pid 5150)");
  });

  test("the LOG path stays the agent's own (never the server's)", async () => {
    const s = stub({ platform: "darwin" });
    await installService(s.deps);
    expect(s.files.get(PLIST) ?? "").toContain(LOG);
  });
});
