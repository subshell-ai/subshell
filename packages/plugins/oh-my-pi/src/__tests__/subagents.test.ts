import { expect, test } from "bun:test";
import { SUBAGENT_BRIDGE } from "../subagents.js";

type Report = {
  agents: { id: string; name: string; status: string; activity?: string }[];
  selectedId: string | null;
  canSelect: boolean;
};

/** The bridge as a function body with its ambient globals replaced. */
function installBridge(
  env: Record<string, string> = {
    SUBSHELL_BASE_URL: "http://fixture",
    SUBSHELL_API_KEY: "fixture",
    SUBSHELL_ID: "pane",
  },
  send?: (url: string, init: { body: string }) => Promise<Response>,
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

/** Flush the coalescing timer, then let the queued report settle. */
async function settle(bridge: { flush: () => void }) {
  bridge.flush();
  await Promise.resolve();
  await Promise.resolve();
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
