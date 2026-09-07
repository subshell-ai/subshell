import { join } from "node:path";
import type { ServiceDeps } from "../../service.js";

/**
 * The stub {@link ServiceDeps} every service test runs against — no systemd,
 * no launchd, no real filesystem. `home` is a fake path; the stub records
 * writes and argv so suites pin the exact unit/plist text and the exact
 * service-manager command sequences.
 *
 * Shared by `service.test.ts` (the module's own behaviour) and `cli.test.ts`
 * (the `subshell service …` wiring), so the two can never disagree about what
 * a stubbed manager looks like.
 */

/** Fake home the unit/plist paths hang off — no test ever touches the real one. */
export const HOME = "/home/tester";
/** systemd user unit under {@link HOME}. */
export const UNIT = join(HOME, ".config", "systemd", "user", "subshell.service");
/** launchd plist under {@link HOME}. */
export const PLIST = join(HOME, "Library", "LaunchAgents", "dev.subshell.client.plist");
/** The agent log the plist points both stdout and stderr at. */
export const LOG = join(HOME, "Library", "Logs", "subshell.log");
/** The explicit launchd domain target every darwin command names (uid 1000). */
export const TARGET = "gui/1000/dev.subshell.client";

/** What a stubbed runCmd answers per invocation (default: success, silent). */
export type Responder = (cmd: string[]) => { code: number; out: string; err: string };

/** A built stub: the deps to inject, plus the recorders the assertions read. */
export interface Stub {
  /** The injectable seams. */
  deps: ServiceDeps;
  /** argv of every runCmd call, in order. */
  calls: string[][];
  /** path → last written text (in-memory "disk"). */
  files: Map<string, string>;
  /** paths passed to removeFile, in order. */
  removed: string[];
}

/**
 * Builds a stub whose defaults describe a healthy linux box with an enrolled
 * config and nothing installed; `over` replaces any seam, and `respond`
 * scripts the service manager.
 */
export function serviceStub(over: Partial<ServiceDeps> & { respond?: Responder } = {}): Stub {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const { respond, ...depsOver } = over;
  const deps: ServiceDeps = {
    platform: "linux",
    home: HOME,
    uid: 1000,
    execPath: "/usr/local/bin/subshell",
    argv1: "/repo/apps/client/agent/src/main.ts",
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
    readFile: async (path) => files.get(path) ?? null,
    ...depsOver,
  };
  return { deps, calls, files, removed };
}

/** A `systemctl show` responder body: `over` merged onto a healthy, pane-safe unit. */
export function showOut(over: Record<string, string> = {}): string {
  return Object.entries({
    ActiveState: "active",
    SubState: "running",
    UnitFileState: "enabled",
    MainPID: "4242",
    KillMode: "process",
    ...over,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** A linux stub whose `systemctl show` answers with `over` merged in, and whose unit file exists. */
export function linuxServiceStub(over: Record<string, string> = {}): Stub {
  const s = serviceStub({
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
export function darwinServiceStub({ abandon = true, loaded = true, running = true, pid = 5150 } = {}): Stub {
  const s = serviceStub({
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
