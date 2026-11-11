import { expect, test } from "bun:test";
import { SUBAGENT_BRIDGE } from "../subagents.js";

type Report = {
  agents: { id: string; name: string; status: string; activity?: string }[];
  selectedId: string | null;
  canSelect: boolean;
  acknowledged?: string;
  unavailableReason?: string;
};

/** The bridge as a function body with its ambient globals replaced. */
function installBridge(
  env: Record<string, string> = {
    SUBSHELL_BASE_URL: "http://fixture",
    SUBSHELL_API_KEY: "fixture",
    SUBSHELL_ID: "pane",
  },
  send?: (url: string, init: { body: string }) => Promise<Response>,
  sdk: Record<string, unknown> = {},
) {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void> | void>();
  const listeners = new Map<string, (data: unknown) => void>();
  const reports: Report[] = [];
  const timers: (() => void)[] = [];
  const beats: (() => void)[] = [];
  const install = new Function(
    "process",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    SUBAGENT_BRIDGE.replace("export default", "return"),
  )(
    { env },
    send ??
      (async (_url: string, init: { body: string }) => {
        reports.push(JSON.parse(init.body));
        return Response.json({});
      }),
    (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    () => {},
    (callback: () => void) => {
      beats.push(callback);
      return beats.length;
    },
    () => {},
  );
  install({
    on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<void> | void) => {
      handlers.set(name, handler);
    },
    events: {
      on: (name: string, listener: (data: unknown) => void) => {
        listeners.set(name, listener);
      },
    },
    pi: sdk,
  });
  return {
    handlers,
    listeners,
    reports,
    beats,
    /** Run queued coalescing timers in order. */
    flush: () => {
      while (timers.length > 0) timers.shift()?.();
    },
    /** A child session rebinds the extension factory with its own (empty) roster. */
    child: () => {
      const childHandlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void> | void>();
      const childListeners = new Map<string, (data: unknown) => void>();
      const childReports: Report[] = [];
      const childInstall = new Function(
        "process",
        "fetch",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        SUBAGENT_BRIDGE.replace("export default", "return"),
      )(
        { env: { SUBSHELL_BASE_URL: "http://fixture", SUBSHELL_API_KEY: "fixture", SUBSHELL_ID: "pane" } },
        async (_url: string, init: { body: string }) => {
          childReports.push(JSON.parse(init.body));
          return Response.json({});
        },
        (callback: () => void) => {
          timers.push(callback);
          return timers.length;
        },
        () => {},
        () => 0,
        () => {},
      );
      childInstall({
        on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<void> | void) => {
          childHandlers.set(name, handler);
        },
        events: {
          on: (name: string, listener: (data: unknown) => void) => {
            childListeners.set(name, listener);
          },
        },
        pi: sdk,
      });
      return {
        handlers: childHandlers,
        listeners: childListeners,
        reports: childReports,
        flush: () => {
          while (timers.length > 0) timers.shift()?.();
        },
      };
    },
  };
}

/** Flush the coalescing timer and let every queued report finish. */
async function settle(bridge: { flush: () => void }) {
  for (let index = 0; index < 10; index += 1) {
    bridge.flush();
    await Promise.resolve();
  }
}

/** The host class the bridge captures; the live instance stands in for omp's TUI. */
function fakeInteractiveMode() {
  class InteractiveMode {
    static focusCalls = 0;
    static unfocusCalls = 0;
    focusedAgentId: string | undefined;
    collabGuest: unknown;
    get viewSession() {
      return this;
    }
    async focusAgentSession(id: string) {
      InteractiveMode.focusCalls += 1;
      this.focusedAgentId = id;
    }
    async unfocusSession() {
      InteractiveMode.unfocusCalls += 1;
      this.focusedAgentId = undefined;
    }
  }
  return { InteractiveMode };
}

const MAIN = { agent: { kind: "main" } };
const SUB = { agent: { kind: "sub" } };
const STARTED = {
  id: "MCPNodeReview",
  agent: "reviewer",
  status: "started",
  description: "Review the node authority change",
  index: 0,
};
const PROGRESS = {
  index: 0,
  agent: "reviewer",
  task: "Review the diff",
  progress: {
    index: 0,
    id: "MCPNodeReview",
    agent: "reviewer",
    status: "running",
    task: "Review the diff",
    lastIntent: "Reading create-subshell docs",
  },
};

test("lifecycle start and progress frames become a roster snapshot", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toEqual([
    {
      id: "MCPNodeReview",
      name: "MCPNodeReview",
      status: "running",
      activity: "Review the node authority change",
    },
  ]);

  bridge.listeners.get("task:subagent:progress")?.(PROGRESS);
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toEqual([
    {
      id: "MCPNodeReview",
      name: "MCPNodeReview",
      status: "running",
      activity: "Reading create-subshell docs",
    },
  ]);
});

test("queued and pending children are waiting; settled children leave the roster", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:progress")?.({
    ...PROGRESS,
    progress: { ...PROGRESS.progress, status: "pending" },
  });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents[0]?.status).toBe("waiting");

  bridge.listeners.get("task:subagent:progress")?.(PROGRESS);
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents[0]?.status).toBe("running");

  bridge.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, status: "completed" });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
});

test("failed and aborted children leave the roster too", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  bridge.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, status: "failed" });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  bridge.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, id: "MCPNodeReview", status: "aborted" });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
});

test("a child session never reports its own grandchildren as the pane's children", async () => {
  const bridge = installBridge();
  const child = bridge.child();
  await child.handlers.get("session_start")?.({ type: "session_start" }, SUB);
  child.listeners.get("task:subagent:lifecycle")?.(STARTED);
  // A child binding must not clear the pane's roster when one of ITS children
  // settles, either: the terminal frames arrive on the child's own bus.
  child.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, status: "completed" });
  child.listeners.get("task:subagent:progress")?.(PROGRESS);
  child.listeners.get("task:subagent:progress")?.({
    ...PROGRESS,
    progress: { ...PROGRESS.progress, status: "completed" },
  });
  await Promise.resolve();
  expect(child.reports).toEqual([]);
});

test("session_start resets the roster and invalid frames are dropped", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "", status: "started" });
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "x".repeat(257), status: "started" });
  bridge.listeners.get("task:subagent:lifecycle")?.(null);
  await Promise.resolve();
  expect(bridge.reports).toEqual([]);

  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "agent-1", status: "started" });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toHaveLength(1);
  await bridge.handlers.get("session_start")?.({ type: "session_start" }, MAIN);
  expect(bridge.reports.at(-1)?.agents).toEqual([]);

  // Switching sessions replaces the conversation the roster belonged to.
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "agent-2", status: "started" });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toHaveLength(1);
  await bridge.handlers.get("session_switch")?.({ type: "session_switch" }, MAIN);
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
});

test("ids keep their 256 cap while the reported name stops at 160", async () => {
  const bridge = installBridge();
  const id = "n".repeat(200);
  bridge.listeners.get("task:subagent:lifecycle")?.({ id, agent: "scout", status: "started" });
  await settle(bridge);
  // A 200-character id is legal; a 200-character `name` is not, and one
  // invalid entry would fail the whole snapshot at the route schema.
  expect(bridge.reports.at(-1)?.agents).toEqual([{ id, name: id.slice(0, 160), status: "running", activity: "scout" }]);
});

test("a child with no generated label shows its agent type instead", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "typed", agent: "reviewer", status: "started" });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents).toEqual([
    { id: "typed", name: "typed", status: "running", activity: "reviewer" },
  ]);

  // A progress frame with neither a generated label nor an intent keeps the
  // type the lifecycle frame supplied; it must not overwrite it with nothing.
  bridge.listeners.get("task:subagent:progress")?.({
    ...PROGRESS,
    agent: "reviewer",
    progress: { ...PROGRESS.progress, id: "typed", description: undefined, lastIntent: undefined },
  });
  await settle(bridge);
  expect(bridge.reports.at(-1)?.agents[0]?.activity).toBe("reviewer");
});

test("a burst of progress frames reports once", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "burst", agent: "scout", status: "started" });
  await settle(bridge);
  const before = bridge.reports.length;
  for (let index = 0; index < 4; index += 1) {
    bridge.listeners.get("task:subagent:progress")?.({
      ...PROGRESS,
      progress: { ...PROGRESS.progress, id: "burst" },
    });
  }
  await settle(bridge);
  expect(bridge.reports.length).toBe(before + 1);
  expect(bridge.reports.at(-1)?.agents[0]?.id).toBe("burst");
});

test("a pane without its endpoint identity sends nothing", async () => {
  const bridge = installBridge({});
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "orphan", status: "started" });
  bridge.flush();
  await Promise.resolve();
  await Promise.resolve();
  expect(bridge.reports).toEqual([]);
});

test("a frame during an in-flight report sends one trailing snapshot", async () => {
  const sent: Report[] = [];
  const gate = Promise.withResolvers<void>();
  const bridge = installBridge(undefined, async (_url, init) => {
    sent.push(JSON.parse(init.body));
    await gate.promise;
    return Response.json({});
  });
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "trailing", agent: "scout", status: "started" });
  await settle(bridge);
  expect(sent).toHaveLength(1);

  // The second change lands while the first POST is still open: it must fold
  // into one trailing snapshot carrying the latest row, not be lost.
  bridge.listeners.get("task:subagent:progress")?.({
    ...PROGRESS,
    progress: { ...PROGRESS.progress, id: "trailing" },
  });
  bridge.flush();
  gate.resolve();
  await settle(bridge);
  expect(sent).toHaveLength(2);
  expect(sent.at(-1)?.agents[0]?.activity).toBe("Reading create-subshell docs");
});

test("a live roster is repeated, so a restarted control plane recovers it", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "persist", agent: "scout", status: "started" });
  await settle(bridge);
  const before = bridge.reports.length;
  bridge.beats[0]?.();
  await settle(bridge);
  expect(bridge.reports.length).toBeGreaterThan(before);
  expect(bridge.reports.at(-1)?.agents[0]?.id).toBe("persist");

  // An empty roster stops the heartbeat; there is nothing to keep repeating.
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "persist", status: "completed" });
  await settle(bridge);
  const afterSettle = bridge.reports.length;
  bridge.beats[0]?.();
  await Promise.resolve();
  expect(bridge.reports.length).toBe(afterSettle);
});

test("reports canSelect only after the live TUI is captured", async () => {
  const sdk = fakeInteractiveMode();
  const bridge = installBridge(undefined, undefined, sdk);
  await bridge.handlers.get("session_start")?.({ type: "session_start" }, MAIN);
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);
  expect(bridge.reports.at(-1)?.canSelect).toBe(false);

  const live = new sdk.InteractiveMode();
  // The getter omp reads while rendering is also where the bridge captures
  // the live class instance it later calls to move the view.
  void live.viewSession;
  bridge.beats[0]?.();
  await settle(bridge);
  expect(bridge.reports.at(-1)?.canSelect).toBe(true);
  expect(bridge.reports.at(-1)?.selectedId).toBe(null);
});

test("a queued command focuses the child and acknowledges the view", async () => {
  const sdk = fakeInteractiveMode();
  const sent: Report[] = [];
  let command: { id: string; agentId: string | null } | undefined;
  const bridge = installBridge(
    undefined,
    async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json(command ? { command } : {});
    },
    sdk,
  );
  await bridge.handlers.get("session_start")?.({}, MAIN);
  const live = new sdk.InteractiveMode();
  void live.viewSession;
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);
  expect(sent.at(-1)?.canSelect).toBe(true);

  command = { id: "switch-1", agentId: "MCPNodeReview" };
  bridge.beats[0]?.();
  await settle(bridge);
  expect(live.focusedAgentId).toBe("MCPNodeReview");
  expect(sdk.InteractiveMode.focusCalls).toBe(1);
  expect(sent.at(-1)).toMatchObject({
    selectedId: "MCPNodeReview",
    canSelect: true,
    acknowledged: "switch-1",
  });
});

test("a null command returns the parent view to its main agent", async () => {
  const sdk = fakeInteractiveMode();
  const sent: Report[] = [];
  let command: { id: string; agentId: string | null } | undefined;
  const bridge = installBridge(
    undefined,
    async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json(command ? { command } : {});
    },
    sdk,
  );
  await bridge.handlers.get("session_start")?.({}, MAIN);
  const live = new sdk.InteractiveMode();
  live.focusedAgentId = "MCPNodeReview";
  void live.viewSession;
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);
  expect(sent.at(-1)?.selectedId).toBe("MCPNodeReview");

  command = { id: "back-1", agentId: null };
  bridge.beats[0]?.();
  await settle(bridge);
  expect(live.focusedAgentId).toBeUndefined();
  expect(sdk.InteractiveMode.unfocusCalls).toBe(1);
  expect(sent.at(-1)).toMatchObject({ selectedId: null, acknowledged: "back-1" });
});

test("a collab guest reports why it cannot switch views", async () => {
  const sdk = fakeInteractiveMode();
  const bridge = installBridge(undefined, undefined, sdk);
  await bridge.handlers.get("session_start")?.({}, MAIN);
  const live = new sdk.InteractiveMode();
  live.collabGuest = {};
  void live.viewSession;
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);
  expect(bridge.reports.at(-1)?.canSelect).toBe(false);
  expect(bridge.reports.at(-1)?.unavailableReason).toContain("collab");
});

test("a command is ignored while the harness cannot select", async () => {
  const sdk = fakeInteractiveMode();
  const sent: Report[] = [];
  const command = { id: "switch-ignored", agentId: "MCPNodeReview" };
  const bridge = installBridge(
    undefined,
    async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ command });
    },
    sdk,
  );
  await bridge.handlers.get("session_start")?.({}, MAIN);
  const live = new sdk.InteractiveMode();
  live.collabGuest = {};
  void live.viewSession;
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);
  expect(sent.at(-1)?.canSelect).toBe(false);

  bridge.beats[0]?.();
  await settle(bridge);
  expect(sdk.InteractiveMode.focusCalls).toBe(0);
  expect(sent.some((report) => report.acknowledged)).toBe(false);
});

test("a rejected focus is declined instead of retried every heartbeat", async () => {
  const sdk = fakeInteractiveMode();
  const sent: Report[] = [];
  let command: { id: string; agentId: string | null } = { id: "switch-fail", agentId: "MCPNodeReview" };
  let attempts = 0;
  sdk.InteractiveMode.prototype.focusAgentSession = async function (id: string) {
    attempts += 1;
    if (attempts === 1) throw new Error("busy");
    this.focusedAgentId = id;
  };
  const bridge = installBridge(
    undefined,
    async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ command });
    },
    sdk,
  );
  await bridge.handlers.get("session_start")?.({}, MAIN);
  const live = new sdk.InteractiveMode();
  void live.viewSession;
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);

  bridge.beats[0]?.();
  await settle(bridge);
  expect(attempts).toBe(1);
  expect(sent.at(-1)?.acknowledged).toBeUndefined();
  // The same command comes back on the next heartbeat; the declined id keeps
  // it from trying the host again.
  bridge.beats[0]?.();
  await settle(bridge);
  expect(attempts).toBe(1);

  command = { id: "switch-next", agentId: "MCPNodeReview" };
  bridge.beats[0]?.();
  await settle(bridge);
  expect(attempts).toBe(2);
  expect(live.focusedAgentId).toBe("MCPNodeReview");
  expect(sent.at(-1)?.acknowledged).toBe("switch-next");
});

test("a command for a child this binding dropped is declined", async () => {
  const sdk = fakeInteractiveMode();
  const sent: Report[] = [];
  const command = { id: "switch-stale", agentId: "finished-child" };
  const bridge = installBridge(
    undefined,
    async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ command });
    },
    sdk,
  );
  await bridge.handlers.get("session_start")?.({}, MAIN);
  const live = new sdk.InteractiveMode();
  void live.viewSession;
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  await settle(bridge);

  bridge.beats[0]?.();
  await settle(bridge);
  expect(sdk.InteractiveMode.focusCalls).toBe(0);
  expect(sent.some((report) => report.acknowledged)).toBe(false);
});
