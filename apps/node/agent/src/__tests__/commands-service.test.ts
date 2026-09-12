import { describe, expect, it } from "bun:test";
import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NO_SERVICE,
  NODE_RESULT_NOT_SUPERVISED,
  type NodeRuntimeReport,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { ServiceDeps } from "../service.js";

function ctxWith(runtime: NodeRuntimeReport | null, onRestart: () => void, serviceDeps?: ServiceDeps): CommandContext {
  return {
    config: {
      serverUrl: "http://localhost:1",
      nodeId: "n",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir: "/tmp/x",
      name: "t",
    },
    tmux: {} as CommandContext["tmux"],
    meta: {} as CommandContext["meta"],
    nowMs: () => 0,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime,
    requestRestart: onRestart,
    ...(serviceDeps ? { serviceDeps } : {}),
  };
}

/**
 * A service manager that records what it was asked to run.
 *
 * Every seam `service.ts` declares is injected here, so these cases pin the
 * exact argv a verb produces without a systemd or a launchd anywhere near
 * them — the same shape `service.test.ts` uses for the CLI.
 */
function fakeService(over: Partial<ServiceDeps> = {}): ServiceDeps & { ran: string[][] } {
  const ran: string[][] = [];
  return {
    platform: "linux",
    home: "/home/t",
    uid: 501,
    execPath: "/usr/bin/subshell",
    argv1: "/usr/bin/subshell",
    hasConfig: async () => true,
    runCmd: async (cmd) => {
      ran.push(cmd);
      return { code: 0, out: "", err: "" };
    },
    writeFile: async () => {},
    removeFile: async () => {},
    fileExists: async () => true,
    readFile: async () => "[Service]\nKillMode=process\n",
    ran,
    ...over,
  };
}

const supervised: NodeRuntimeReport = {
  startedAt: "2026-09-12T00:00:00.000Z",
  supervised: true,
  service: {
    manager: "systemd",
    installed: true,
    definitionPath: "/x",
    state: "running",
    pid: 1,
    enabled: true,
    paneSafety: "keeps",
  },
  configPath: "/c",
  agentLogPath: "/c/logs/agent.log",
  logPath: null,
  logHint: "j",
  tmuxPath: null,
  binaryPath: "/b",
};

describe("service: restart", () => {
  it("refuses when not supervised and asks for no exit", async () => {
    let asked = 0;
    const res = await dispatchCommand(
      ctxWith({ ...supervised, supervised: false }, () => asked++),
      { type: "service", verb: "restart" },
    );
    expect(res).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(asked).toBe(0);
  });

  it("refuses a pane-killing definition without force, accepts with force", async () => {
    let asked = 0;
    const kills = { ...supervised, service: { ...supervised.service, paneSafety: "kills" as const } };
    expect(
      await dispatchCommand(
        ctxWith(kills, () => asked++),
        { type: "service", verb: "restart" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_KILLS_PANES,
    });
    expect(
      await dispatchCommand(
        ctxWith(kills, () => asked++),
        { type: "service", verb: "restart", force: true },
      ),
    ).toEqual({
      ok: true,
    });
    expect(asked).toBe(1);
  });

  it("refuses an unknown paneSafety without force — the same fail-closed rule the CLI uses", async () => {
    const unknown = { ...supervised, service: { ...supervised.service, paneSafety: "unknown" as const } };
    expect(
      await dispatchCommand(
        ctxWith(unknown, () => {}),
        { type: "service", verb: "restart" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_KILLS_PANES,
    });
  });

  it("accepts when supervised and pane-safe, and asks the daemon to exit", async () => {
    let asked = 0;
    expect(
      await dispatchCommand(
        ctxWith(supervised, () => asked++),
        { type: "service", verb: "restart" },
      ),
    ).toEqual({ ok: true });
    expect(asked).toBe(1);
  });

  it("refuses when no runtime was collected", async () => {
    expect(
      await dispatchCommand(
        ctxWith(null, () => {}),
        { type: "service", verb: "restart" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_NOT_SUPERVISED,
    });
  });
});

describe("service: the manager verbs", () => {
  it("starts and stops through the platform's manager", async () => {
    const deps = fakeService();
    const started = await dispatchCommand(
      ctxWith(supervised, () => {}, deps),
      { type: "service", verb: "start" },
    );
    expect(started.ok).toBe(true);
    expect(deps.ran.at(-1)).toEqual(["systemctl", "--user", "start", "subshell.service"]);

    // `stop` is destructive, so it needs force on a definition that is not
    // known to keep panes. This one keeps them, so it goes straight through.
    const stopped = await dispatchCommand(
      ctxWith(supervised, () => {}, deps),
      { type: "service", verb: "stop" },
    );
    expect(stopped.ok).toBe(true);
    expect(deps.ran.at(-1)).toEqual(["systemctl", "--user", "stop", "subshell.service"]);
  });

  // The whole reason `stop` and `uninstall` carry `force` at all: they end the
  // same panes a restart would, and the CLI refuses them the same way.
  it("refuses a destructive verb on a pane-killing definition without force", async () => {
    const kills = { ...supervised, service: { ...supervised.service, paneSafety: "kills" as const } };
    for (const verb of ["stop", "uninstall"] as const) {
      const deps = fakeService();
      expect(
        await dispatchCommand(
          ctxWith(kills, () => {}, deps),
          { type: "service", verb },
        ),
      ).toEqual({
        ok: false,
        error: NODE_RESULT_KILLS_PANES,
      });
      expect(deps.ran).toEqual([]);
    }
  });

  // `start` and `install` cannot end a pane, so they must never be gated on
  // pane safety — a flag that fires when nothing is at risk is one people
  // learn to pass without reading.
  it("never gates start on pane safety", async () => {
    const kills = { ...supervised, service: { ...supervised.service, paneSafety: "kills" as const } };
    const deps = fakeService();
    expect(
      (
        await dispatchCommand(
          ctxWith(kills, () => {}, deps),
          { type: "service", verb: "start" },
        )
      ).ok,
    ).toBe(true);
  });

  // A machine whose agent was started by hand has no definition to drive. The
  // plane turns this one constant into a sentence naming the remedy, so it has
  // to arrive as the constant rather than as the CLI's prose.
  it("answers the no-definition constant when nothing is installed", async () => {
    const deps = fakeService({ fileExists: async () => false });
    expect(
      await dispatchCommand(
        ctxWith(supervised, () => {}, deps),
        { type: "service", verb: "start" },
      ),
    ).toEqual({
      ok: false,
      error: NODE_RESULT_NO_SERVICE,
    });
  });

  it("passes a manager failure back in the manager's own words", async () => {
    const deps = fakeService({
      runCmd: async () => ({ code: 1, out: "", err: "Job for subshell.service failed" }),
    });
    const res = await dispatchCommand(
      ctxWith(supervised, () => {}, deps),
      { type: "service", verb: "start" },
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("systemctl --user start subshell.service failed");
  });

  it("installs and uninstalls a definition", async () => {
    const install = fakeService({ fileExists: async () => false });
    expect(
      (
        await dispatchCommand(
          ctxWith(supervised, () => {}, install),
          { type: "service", verb: "install" },
        )
      ).ok,
    ).toBe(true);
    const uninstall = fakeService();
    const safe = { ...supervised, service: { ...supervised.service, paneSafety: "keeps" as const } };
    expect(
      (
        await dispatchCommand(
          ctxWith(safe, () => {}, uninstall),
          { type: "service", verb: "uninstall" },
        )
      ).ok,
    ).toBe(true);
  });
});
