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
  setAutostart,
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

/**
 * How logind answers `loginctl show-user <uid> --property=Linger`.
 *
 * Five answers rather than three, because two of the failures mean opposite
 * things: `notLoggedIn` is logind stating there is no record of this user
 * (so: no session, no linger — a real `false`), while `noBus` is the question
 * never reaching logind at all (`null`).
 */
type LingerAnswer = "yes" | "no" | "absent" | "notLoggedIn" | "noBus";

const LINGER_REPLIES: Record<LingerAnswer, { code: number; out: string; err: string }> = {
  yes: { code: 0, out: "Linger=yes\n", err: "" },
  no: { code: 0, out: "Linger=no\n", err: "" },
  // `show-user` on a systemd too old to know the property: exit 0, no line.
  absent: { code: 0, out: "", err: "" },
  notLoggedIn: { code: 1, out: "", err: "Failed to get user: User ID 1000 is not logged in or lingering\n" },
  noBus: { code: 1, out: "", err: "Failed to connect to bus: No such file or directory\n" },
};

interface Stub {
  deps: ServiceDeps;
  /** argv of every runCmd call, in order. */
  calls: string[][];
  /** path → last written text (in-memory "disk"). */
  files: Map<string, string>;
  /** paths passed to removeFile, in order. */
  removed: string[];
}

function stub(over: Partial<ServiceDeps> & { respond?: Responder; linger?: LingerAnswer } = {}): Stub {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const { respond, linger = "yes", ...depsOver } = over;
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
      // Scripted BEFORE `respond`, so the many tests whose responder answers
      // every command the same way (a dead bus, a 113) still get a coherent
      // logind — the linger question is a different manager's.
      if (cmd[0] === "loginctl") return LINGER_REPLIES[linger];
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
  test("guards pass → probes, writes the EXACT unit, reloads, enables+starts, asks logind", () => {
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
      // LAST, and only after the unit is up: the hint below is decided from
      // the answer, so asking earlier would report on a machine mid-install.
      ["loginctl", "show-user", "1000", "--property=Linger"],
    ]);
    // The default stub lingers already, so the advice is withheld.
    expect(res.out).not.toInclude("loginctl enable-linger");
  });

  // The hint used to print on every install, which told an operator who had
  // already run `enable-linger` to go and run it.
  test("the linger hint prints exactly when logind does not say yes", () => {
    for (const answer of ["no", "absent", "notLoggedIn", "noBus"] as const) {
      const res = installService(stub({ linger: answer }).deps);
      expect(res.out).toInclude("loginctl enable-linger");
    }
    expect(installService(stub({ linger: "yes" }).deps).out).not.toInclude("loginctl enable-linger");
  });

  test("--no-autostart installs still ask, and still hint", () => {
    const res = installService(stub({ linger: "no" }).deps, { autostart: false });
    expect(res.out).toInclude("not enabled at login");
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

  test("a MacPorts PATH survives the same rail: /opt/local/bin baked into unit and plist (2026-09-26)", () => {
    // The offer may install tmux via `port`, which lands it at
    // /opt/local/bin/tmux; the manager's stock PATH does not carry that
    // directory, so the SAME bake-the-installing-shell's-PATH mechanism the
    // Homebrew case relies on must carry it (addendum follow-through: a
    // port-installed tmux that passed preflight is found by the service).
    const unitRun = stub({ platform: "linux", pathEnv: "/usr/bin:/opt/local/bin" });
    installService(unitRun.deps);
    expect(unitRun.files.get(UNIT) ?? "").toInclude("Environment=PATH=/usr/bin:/opt/local/bin\nWorkingDirectory=");

    const plistRun = stub({ platform: "darwin", pathEnv: "/usr/bin:/opt/local/bin" });
    installService(plistRun.deps);
    expect(plistRun.files.get(PLIST) ?? "").toInclude("<string>/usr/bin:/opt/local/bin</string>");
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
    // Login-Items attribution: without this key System Settings shows the
    // SIGNING ORGANIZATION ("Disaresta, LLC") where the user looks for the
    // app (launchd.plist(5)). Same shared constant the desktop app's own
    // bundle identifier is pinned to — drift is silent association failure.
    expect(plist).toInclude("<key>AssociatedBundleIdentifiers</key>");
    // launchd starts agents with cwd `/` — a relative DATABASE_PATH then
    // resolves against the root filesystem (measured crash-loop, 2026-09-07).
    // The plist pins the config home as the working directory, mirroring the
    // systemd unit's WorkingDirectory=.
    expect(plist).toInclude("<key>WorkingDirectory</key>");
    expect(plist).toInclude(`<string>${CONFIG}</string>`);
    // The log is the SERVER's own file — never the agent's subshell.log.
    expect(plist.split(LOG).length - 1).toBe(2); // StandardOutPath AND StandardErrorPath
    expect(plist).not.toInclude(join(HOME, "Library", "Logs", "subshell.log"));

    // A bootout precedes EVERY bootstrap, including this one where no plist
    // was on disk. The file is only a proxy for "is this label loaded", and it
    // lies after a reset — which deletes the plist while the job is still in
    // the domain (measured 2026-09-12).
    expect(s.calls).toEqual([
      ["launchctl", "bootout", "gui/1000/dev.subshell.server"],
      ["launchctl", "bootstrap", "gui/1000", PLIST],
    ]);
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

  /**
   * Reported on 2026-09-12: reset, then set up again, and setup died on
   * "launchctl bootstrap failed (exit 5): Input/output error" — while the
   * plist, the binary and every path it names were fine. `bootout` is not
   * synchronous; the previous job was still leaving the domain, and a server
   * with live panes takes its time about it. The same command by hand ninety
   * seconds later worked.
   */
  test("a busy domain is waited out, not reported as a failure", () => {
    let bootstraps = 0;
    const slept: number[] = [];
    const s = stub({
      platform: "darwin",
      sleep: (ms: number) => slept.push(ms),
      respond: (cmd) => {
        if (cmd[1] !== "bootstrap") return { code: 0, out: "", err: "" };
        bootstraps += 1;
        // Busy for the first two tries, then in.
        return bootstraps <= 2
          ? { code: 5, out: "", err: "Bootstrap failed: 5: Input/output error" }
          : { code: 0, out: "", err: "" };
      },
    });
    const res = installService(s.deps);
    expect(res.code).toBe(0);
    expect(bootstraps).toBe(3);
    expect(slept.length).toBe(2);
  });

  /**
   * Only a BUSY answer is retried. A malformed plist or a missing program
   * fails the way it always did — immediately, in launchd's own words —
   * because retrying those would just make a person wait to read them.
   */
  /**
   * The budget is a DECISION, so it is asserted. Without this the ceiling is
   * a number nobody is watching, and the difference between "waits long
   * enough" and "gives up early with the same message the user reported" is
   * invisible.
   */
  test("gives up after the whole budget, in launchd's own words", () => {
    let bootstraps = 0;
    const slept: number[] = [];
    const s = stub({
      platform: "darwin",
      sleep: (ms: number) => slept.push(ms),
      respond: (cmd) => {
        if (cmd[1] !== "bootstrap") return { code: 0, out: "", err: "" };
        bootstraps += 1;
        return { code: 5, out: "", err: "Bootstrap failed: 5: Input/output error" };
      },
    });
    const res = installService(s.deps);
    expect(res.code).not.toBe(0);
    expect(bootstraps).toBe(60);
    expect(slept.length).toBe(59);
    // Thirty seconds of waiting, and then the truth rather than a summary.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(29_500);
    expect(res.err).toInclude("Input/output error");
  });

  test("a real bootstrap failure is reported at once", () => {
    let bootstraps = 0;
    const s = stub({
      platform: "darwin",
      respond: (cmd) => {
        if (cmd[1] !== "bootstrap") return { code: 0, out: "", err: "" };
        bootstraps += 1;
        return { code: 112, out: "", err: "Could not find specified service" };
      },
    });
    const res = installService(s.deps);
    expect(res.code).not.toBe(0);
    expect(bootstraps).toBe(1);
    expect(res.err).toInclude("Could not find specified service");
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
      // EIO is a BUSY answer, so this now goes through the whole retry budget.
      // Without the seam that is thirty seconds of real sleeping for a case
      // that is about the message, not the waiting.
      sleep: () => {},
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
    expect(res.err).toInclude("no config.env: run subshell-server init first");
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

  // A STOPPED service is the ordinary thing to uninstall, and a guaranteed
  // one for the desktop app's reset, whose chain stops the service two steps
  // before it uninstalls. `bootout` answers a not-loaded job with exit 3 "No
  // such process" (measured, launchctl on macOS 15), which used to be
  // reported as a failed uninstall even though the plist had just been
  // removed - so the reset could never complete on macOS.
  test("a service that was already stopped uninstalls cleanly: bootout's exit 3 is the goal, not a failure", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "bootout"
          ? { code: 3, out: "", err: "Boot-out failed: 3: No such process" }
          : { code: 0, out: "", err: "" },
    });
    s.files.set(PLIST, "<plist>old</plist>");

    const res = uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(res.out).toInclude("Removed");
    expect(s.files.has(PLIST)).toBe(false);
  });

  // Any OTHER non-zero bootout may mean the job is still loaded with its
  // plist now gone, which is a real half-state and must still be reported.
  test("a bootout that failed for any other reason is still an error", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "bootout"
          ? { code: 1, out: "", err: "Boot-out failed: 5: Input/output error" }
          : { code: 0, out: "", err: "" },
    });
    s.files.set(PLIST, "<plist>old</plist>");

    const res = uninstallService(s.deps);
    expect(res.code).not.toBe(0);
    expect(res.err).toInclude("the plist was removed anyway");
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
    expect(res.out).toInclude("(no config.env found, nothing else to clean up)");
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
function linuxStub(over: Record<string, string> = {}, linger: LingerAnswer = "yes") {
  const s = stub({
    linger,
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
function darwinStub({
  abandon = true,
  loaded = true,
  running = true,
  pid = 5150,
  printError = null as { code: number; err: string } | null,
  stateLine = "not running",
  // What `print` answers AFTER a bootout has been issued — because bootout is
  // not synchronous (`domainBusy`'s own note), a stub that answers the same
  // before and after cannot express the wait. "gone": the job leaves at once.
  // A number: it survives N post-bootout polls, then leaves. "stays": it
  // never leaves (the 2026-09-13 case, taken to its limit).
  afterBootout = "gone" as "gone" | "stays" | number,
} = {}) {
  let bootedOut = false;
  let postBootoutPrints = 0;
  const s = stub({
    platform: "darwin",
    respond: (cmd) => {
      if (cmd[1] === "bootout") {
        bootedOut = true;
        return { code: 0, out: "", err: "" };
      }
      if (cmd[0] === "plutil")
        return abandon ? { code: 0, out: "true\n", err: "" } : { code: 1, out: "", err: "No value at that key path" };
      if (cmd[1] === "print") {
        if (bootedOut && afterBootout !== "stays") {
          postBootoutPrints++;
          if (afterBootout === "gone" || postBootoutPrints > afterBootout) return { code: 113, out: "", err: "" };
        }
        if (printError) return { code: printError.code, out: "", err: printError.err };
        if (!loaded) return { code: 113, out: "", err: "" };
        return running
          ? { code: 0, out: `\tstate = running\n\tpid = ${pid}\n`, err: "" }
          : { code: 0, out: `\tstate = ${stateLine}\n`, err: "" };
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
      // A second manager, asked second: logind owns linger, systemd does not.
      ["loginctl", "show-user", "1000", "--property=Linger"],
    ]);
    expect(state).toMatchObject({
      installed: true,
      state: "running",
      pid: 4242,
      enabled: true,
      linger: true,
      paneSafety: "keeps",
    });
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

  // The 2026-09-07 crash-loop was reported as a flat "stopped" with the
  // reason thrown away. "spawn scheduled" (launchd throttling a repeatedly
  // dying job) must be visible — "stopped" and "stopped AND KEEPING CRASHING"
  // are different operator problems.
  test("darwin: a non-running job carries launchd's raw state in detail", () => {
    const state = queryService(darwinStub({ running: false, stateLine: "spawn scheduled" }).deps);
    expect(state).toMatchObject({ state: "stopped", loaded: true, detail: "launchd: spawn scheduled" });
  });

  // Exit 113 ("Could not find service") is the documented unloaded answer;
  // ANY other failure means the manager did not answer at all, and calling
  // that "stopped" is a guess that discards the only diagnostic there is.
  test("darwin: an unexpected launchctl print failure is 'unknown', output kept", () => {
    const state = queryService(
      darwinStub({ printError: { code: 1, err: "Bootstrap failed: 5: Input/output error" } }).deps,
    );
    expect(state.state).toBe("unknown");
    expect(state.detail).toInclude("launchctl print failed (exit 1)");
    expect(state.detail).toInclude("Input/output error");
    // 113 keeps the classic stopped mapping.
    expect(queryService(darwinStub({ loaded: false }).deps).detail).toBe("");
  });

  // The desktop console reveals the log; it must not re-derive platform
  // paths. macOS: the plist's StandardOutPath. Linux: journald answers, so
  // the JSON says null rather than inventing a file.
  test("darwin reports the service log path; systemd reports null (journald)", () => {
    expect(queryService(darwinStub().deps).logPath).toBe(LOG);
    expect(queryService(stub().deps).logPath).toBeNull();
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

/**
 * `survives logout` — the fact none of the manager commands above carries.
 *
 * An enabled `--user` unit comes back at LOGIN and dies at LOGOUT; with the
 * user lingering it comes back at BOOT. On a headless box that is the
 * difference between a server that survives a reboot and one that does not,
 * and it is a question for logind, never for systemd.
 */
describe("queryService — linger (Linux, logind)", () => {
  test("Linger=yes is true and Linger=no is false", () => {
    expect(queryService(linuxStub({}, "yes").deps).linger).toBe(true);
    expect(queryService(linuxStub({}, "no").deps).linger).toBe(false);
  });

  // "not logged in or lingering" IS the answer: no session record means no
  // linger, which is the ordinary state of a service user on a headless box.
  test("a `not logged in or lingering` refusal is a real no, not an unknown", () => {
    expect(queryService(linuxStub({}, "notLoggedIn").deps).linger).toBe(false);
  });

  test("a bus that cannot be reached is unknown, never false", () => {
    expect(queryService(linuxStub({}, "noBus").deps).linger).toBeNull();
  });

  test("a `show-user` with no Linger line at all is unknown", () => {
    expect(queryService(linuxStub({}, "absent").deps).linger).toBeNull();
  });

  // Two independent facts: a unit nobody enabled still sits behind a user who
  // may or may not linger, so the read does not hang off `enabled`.
  test("asked even when the unit is disabled", () => {
    const s = linuxStub({ UnitFileState: "disabled" }, "yes");
    const state = queryService(s.deps);
    expect(state.enabled).toBe(false);
    expect(state.linger).toBe(true);
    expect(s.calls.some((c) => c[0] === "loginctl")).toBe(true);
  });

  test("a failing `systemctl show` answers null and asks logind NOTHING", () => {
    const s = stub({ respond: () => ({ code: 1, out: "", err: "Failed to connect to bus\n" }) });
    s.files.set(UNIT, "[Service]\nKillMode=process\n");
    expect(queryService(s.deps).linger).toBeNull();
    expect(s.calls.some((c) => c[0] === "loginctl")).toBe(false);
  });

  test("nothing installed is null with no command at all", () => {
    const s = stub();
    const state = queryService(s.deps);
    expect(state.installed).toBe(false);
    expect(state.linger).toBeNull();
    expect(s.calls).toEqual([]);
  });

  test("a platform with no per-user manager is null", () => {
    expect(queryService(stub({ platform: "win32" }).deps).linger).toBeNull();
  });

  // launchd has no equivalent knob — a LaunchAgent's lifetime IS the login
  // session by design — so darwin answers null and never asks.
  test("darwin never asks logind, in any state", () => {
    const loaded = darwinStub();
    expect(queryService(loaded.deps).linger).toBeNull();
    expect(loaded.calls.some((c) => c[0] === "loginctl")).toBe(false);

    const notLoaded = darwinStub({ loaded: false });
    expect(queryService(notLoaded.deps).linger).toBeNull();

    const brokenManager = darwinStub({ printError: { code: 5, err: "launchctl exploded" } });
    expect(queryService(brokenManager.deps).linger).toBeNull();

    const nothingInstalled = stub({ platform: "darwin" });
    expect(queryService(nothingInstalled.deps).linger).toBeNull();
    expect(nothingInstalled.calls).toEqual([]);
  });

  test("darwin install never hints at lingering", () => {
    const res = installService(stub({ platform: "darwin", linger: "no" }).deps);
    expect(res.code).toBe(0);
    expect(res.out).not.toInclude("loginctl");
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
      // The state read runs first (show, then logind's linger), and the verb
      // is the LAST thing this does — index it from the end, so a future
      // read does not renumber the assertion.
      expect(s.calls.at(-1)).toEqual(["systemctl", "--user", verb, "subshell-server.service"]);
      expect(s.calls).toHaveLength(3);
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
    expect(s.calls.at(-1)).toEqual(["systemctl", "--user", "restart", "subshell-server.service"]);
  });

  // stop is as lethal as restart, but refusing it would only push the operator
  // to `systemctl`, which warns about nothing. So it warns and proceeds.
  test("stop WARNS on a lethal definition but still stops (exit 0)", () => {
    const s = linuxStub({ KillMode: "control-group" });
    const r = controlService(s.deps, "stop");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning");
    expect(r.err).toContain("kills every running subshell");
    expect(s.calls.at(-1)).toEqual(["systemctl", "--user", "stop", "subshell-server.service"]);
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
    expect(s.calls.some((c) => c[1] === "bootout")).toBe(true);
    // And bootout is NOT the last command any more: the job's absence is
    // re-read from the domain before DONE is said (2026-09-13 — the old
    // `at(-1) === bootout` pin WAS the async lie, tested into permanence).
    expect(s.calls.at(-1)?.[1]).toBe("print");
  });

  // `domainBusy` has documented since 2026-09-12 that bootout returns while
  // the job is still leaving; only the install path ever acted on it. The
  // measured cost was a desktop RESET: stop said "stopped." at bootout's
  // exit-0 while the process kept running for 90 more seconds, and the
  // chain deleted the database out from under it (`SQLITE_IOERR_VNODE` in
  // the server's own log). DONE now means PROVEN gone, and this pins the
  // polling that earns the word.
  test("darwin: stop POLLS the domain until the job actually leaves, then says stopped", () => {
    const s = darwinStub({ afterBootout: 3 });
    const sleeps: number[] = [];
    const r = controlService({ ...s.deps, sleep: (ms) => sleeps.push(ms) }, "stop");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(DONE.stop);
    // Initial query, then three "still here" answers and the one that proves
    // it left — and the sleep only happens between not-gone answers.
    const prints = s.calls.filter((c) => c[1] === "print").length;
    expect(prints).toBe(5);
    expect(sleeps).toHaveLength(3);
  });

  test("darwin: a job that never leaves the domain is a FAILED stop, never DONE.stop", () => {
    const s = darwinStub({ afterBootout: "stays" });
    let sleeps = 0;
    const r = controlService({ ...s.deps, sleep: () => sleeps++ }, "stop");
    expect(r.code).toBe(1);
    // It says what it saw, what it therefore cannot claim, and what to do.
    expect(msgLine(r.err)).toContain("still in launchd's domain");
    expect(r.err).toContain("NOT confirmed stopped");
    expect(r.err).toContain("service status");
    expect(r.out).not.toContain("stopped.");
    // The budget is real: it spent every poll.
    expect(sleeps).toBeGreaterThanOrEqual(30);
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
    expect(s.calls.some((c) => c[1] === "bootout")).toBe(true);
    expect(s.calls.at(-1)?.[1]).toBe("print");
  });

  // The fail-open hole `state: unknown` could have dug: `loaded` is false
  // there only because nothing ANSWERED, and a no-op keyed on that alone
  // would answer "already stopped" for a daemon running behind a flaky
  // manager. Stop attempts the bootout and lets the manager's real answer
  // speak — this verb ends live panes when it guesses.
  test("darwin: stop on an UNANSWERABLE manager attempts the bootout, never 'already stopped'", () => {
    // afterBootout "stays" keeps the print failing forever — a manager that
    // cannot answer at any point in the wait, which is what licenses the
    // refusal below.
    const s = darwinStub({
      printError: { code: 5, err: "Could not read domain: Input/output error" },
      afterBootout: "stays",
    });
    const r = controlService({ ...s.deps, sleep: () => {} }, "stop");
    expect(r.out).not.toContain("already stopped");
    expect(s.calls.some((c) => c[1] === "bootout")).toBe(true);
    // The bootout was ACCEPTED (exit 0), but a manager that cannot answer
    // whether the job left cannot license "stopped." either — the honest
    // answer is the failure naming the unanswered question. (This is a
    // tightening the old test had no way to express: bootout's exit-0 WAS
    // the whole check, and that is precisely the claim 2026-09-13 proved
    // insufficient.)
    expect(r.code).toBe(1);
    expect(msgLine(r.err)).toContain("still in launchd's domain");
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

/**
 * "Starts at login" as a thing you can CHANGE (spec 2026-09-12
 * server-supervision § 3).
 *
 * The contract every case here defends is the same one sentence: **toggling
 * autostart must not touch the running process.** An operator saying "don't
 * bring this back at login" has not asked for their server to go down now,
 * and a surface that took it down would be worse than no surface.
 */
const SESSION_PLIST = join(CONFIG, "dev.subshell.server.plist");

describe("service install --no-autostart", () => {
  test("linux starts the unit WITHOUT enabling it", () => {
    const s = stub();
    const res = installService(s.deps, { autostart: false });
    expect(res.code).toBe(0);
    // `start`, never `enable --now`: the unit must be left disabled so
    // UnitFileState reads `disabled` with nothing to undo later.
    const manager = s.calls.filter((c) => c[0] === "systemctl").map((c) => c.slice(0, 3).join(" "));
    expect(manager).toContain("systemctl --user start");
    expect(manager).not.toContain("systemctl --user enable");
    expect(res.out).toContain("not enabled at login");
    expect(s.files.has(UNIT)).toBe(true);
  });

  test("linux default is unchanged: enable --now, and the old success line", () => {
    const s = stub();
    const res = installService(s.deps);
    expect(s.calls.some((c) => c.join(" ") === "systemctl --user enable --now subshell-server.service")).toBe(true);
    expect(res.out).toContain("enabled and running");
  });

  test("darwin writes the SESSION plist and leaves LaunchAgents empty", () => {
    const s = stub({ platform: "darwin" });
    const res = installService(s.deps, { autostart: false });
    expect(res.code).toBe(0);
    // The location IS the setting: launchd scans ~/Library/LaunchAgents at
    // login and nothing else, so a definition kept elsewhere runs only when
    // something bootstraps it.
    expect(s.files.has(SESSION_PLIST)).toBe(true);
    expect(s.files.has(PLIST)).toBe(false);
    // ...and it is bootstrapped from where it actually is.
    expect(s.calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap" && c[3] === SESSION_PLIST)).toBe(true);
  });

  test("darwin autostart writes the LaunchAgents plist and clears a stale session one", () => {
    const s = stub({ platform: "darwin" });
    s.files.set(SESSION_PLIST, "<plist>stale</plist>");
    installService(s.deps);
    expect(s.files.has(PLIST)).toBe(true);
    // Exactly one definition after any install: a leftover in the login
    // directory would re-arm autostart at the next reboot, silently.
    expect(s.removed).toContain(SESSION_PLIST);
    expect(s.files.has(SESSION_PLIST)).toBe(false);
  });
});

describe("queryService reports autostart from where the definition lives", () => {
  test("darwin: LaunchAgents = enabled, session dir = not enabled", () => {
    const enabled = stub({
      platform: "darwin",
      respond: () => ({ code: 113, out: "", err: "Could not find service" }),
    });
    installService(enabled.deps);
    expect(queryService(enabled.deps).enabled).toBe(true);
    expect(queryService(enabled.deps).definitionPath).toBe(PLIST);

    const disabled = stub({
      platform: "darwin",
      respond: () => ({ code: 113, out: "", err: "Could not find service" }),
    });
    installService(disabled.deps, { autostart: false });
    const state = queryService(disabled.deps);
    expect(state.enabled).toBe(false);
    expect(state.installed).toBe(true);
    expect(state.definitionPath).toBe(SESSION_PLIST);
  });

  test("darwin: nothing installed names the login path and answers enabled: null", () => {
    const s = stub({ platform: "darwin" });
    const state = queryService(s.deps);
    expect(state.installed).toBe(false);
    expect(state.enabled).toBe(null);
    expect(state.definitionPath).toBe(PLIST);
  });
});

describe("setAutostart", () => {
  test("linux enables and disables WITHOUT --now", () => {
    const s = stub();
    installService(s.deps);
    s.calls.length = 0;
    expect(setAutostart(s.deps, false).code).toBe(0);
    expect(s.calls).toEqual([
      [
        "systemctl",
        "--user",
        "show",
        "subshell-server.service",
        "--property=ActiveState,SubState,UnitFileState,MainPID,KillMode",
      ],
      // queryService's own linger read rides along — `show` first, logind second.
      ["loginctl", "show-user", "1000", "--property=Linger"],
      ["systemctl", "--user", "disable", "subshell-server.service"],
    ]);
    // The absence of `--now` is the whole point: with it, this would have
    // stopped a running server that nobody asked to stop.
    expect(s.calls.some((c) => c.includes("--now"))).toBe(false);
  });

  test("linux says what happened, in the manager's absence of words", () => {
    const s = stub();
    installService(s.deps);
    expect(setAutostart(s.deps, true).out).toContain("will start at login");
    expect(setAutostart(s.deps, false).out).toContain("will no longer start at login");
  });

  test("darwin MOVES the plist and runs no manager command at all", () => {
    const s = stub({ platform: "darwin", respond: () => ({ code: 113, out: "", err: "Could not find service" }) });
    installService(s.deps);
    const text = s.files.get(PLIST);
    s.calls.length = 0;

    expect(setAutostart(s.deps, false).code).toBe(0);
    expect(s.files.get(SESSION_PLIST)).toBe(text); // same document, new home
    expect(s.files.has(PLIST)).toBe(false);
    // launchd holds the LOADED job, not the file, so moving it restarts
    // nothing — and this asserts we never asked launchctl to. `print` is
    // allowed through because it is `queryService`'s read of the current
    // state; what must never appear is a verb that ACTS on the job.
    const acted = s.calls.filter((c) => c[0] === "launchctl" && c[1] !== "print").map((c) => c[1]);
    expect(acted).toEqual([]);

    expect(setAutostart(s.deps, true).code).toBe(0);
    expect(s.files.get(PLIST)).toBe(text);
    expect(s.files.has(SESSION_PLIST)).toBe(false);
  });

  test("darwin writes the destination BEFORE removing the source", () => {
    const order: string[] = [];
    const s = stub({ platform: "darwin", respond: () => ({ code: 113, out: "", err: "Could not find service" }) });
    installService(s.deps);
    const realWrite = s.deps.writeFile;
    const realRemove = s.deps.removeFile;
    s.deps.writeFile = (p, t) => {
      order.push(`write:${p}`);
      realWrite(p, t);
    };
    s.deps.removeFile = (p) => {
      order.push(`remove:${p}`);
      realRemove(p);
    };
    setAutostart(s.deps, false);
    // A failed write must leave the service as it was, never unregistered
    // from both places — which is a machine with no definition at all.
    expect(order).toEqual([`write:${SESSION_PLIST}`, `remove:${PLIST}`]);
  });

  test("refuses when nothing is installed, in controlService's own words", () => {
    const s = stub();
    const res = setAutostart(s.deps, true);
    expect(res.code).toBe(1);
    expect(res.err).toContain("nothing installed");
    expect(res.err).toContain("service install");
    // Nothing was written: this is not a back door to installing a service
    // whose config was never checked.
    expect(s.files.size).toBe(0);
  });

  test("a no-op is a success that changes nothing on disk", () => {
    const s = stub({ platform: "darwin", respond: () => ({ code: 113, out: "", err: "Could not find service" }) });
    installService(s.deps);
    s.removed.length = 0;
    expect(setAutostart(s.deps, true).code).toBe(0);
    expect(s.removed).toEqual([]);
    expect(s.files.has(PLIST)).toBe(true);
  });

  test("refuses on a platform with no service manager", () => {
    const s = stub({ platform: "win32" });
    expect(setAutostart(s.deps, true).code).toBe(1);
  });
});

describe("uninstall removes every definition", () => {
  test("darwin removes the session plist as well as the login one", () => {
    const s = stub({ platform: "darwin" });
    s.files.set(PLIST, "<plist>login</plist>");
    s.files.set(SESSION_PLIST, "<plist>session</plist>");
    const res = uninstallService(s.deps);
    expect(res.code).toBe(0);
    // Both, always: a machine must never come out of uninstall with a
    // definition still able to start a server the operator believes is gone.
    expect(s.files.has(PLIST)).toBe(false);
    expect(s.files.has(SESSION_PLIST)).toBe(false);
  });

  test("darwin uninstalls a --no-autostart install", () => {
    const s = stub({ platform: "darwin" });
    installService(s.deps, { autostart: false });
    const res = uninstallService(s.deps);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Removed");
    expect(s.files.has(SESSION_PLIST)).toBe(false);
  });
});

describe("control verbs follow the definition's location", () => {
  test("darwin start bootstraps the SESSION plist for a disabled install", () => {
    const s = stub({
      platform: "darwin",
      respond: (cmd) =>
        cmd[1] === "print" ? { code: 113, out: "", err: "Could not find service" } : { code: 0, out: "", err: "" },
    });
    installService(s.deps, { autostart: false });
    s.calls.length = 0;
    const res = controlService(s.deps, "start");
    expect(res.code).toBe(0);
    // Re-deriving the login path here would answer "no such file" for a
    // service that is installed and merely not armed for login.
    const boot = s.calls.find((c) => c[1] === "bootstrap");
    expect(boot?.[3]).toBe(SESSION_PLIST);
  });
});
