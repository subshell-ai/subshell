import { expect, test } from "bun:test";
import { SUBAGENT_BRIDGE } from "../subagents.js";

type Report = {
  agents: { id: string; name: string; status: string; activity?: string }[];
  selectedId: string | null;
  canSelect: boolean;
};

/** The bridge as a function body with its ambient globals replaced. */
function installBridge() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void> | void>();
  const listeners = new Map<string, (data: unknown) => void>();
  const reports: Report[] = [];
  const timers: (() => void)[] = [];
  const install = new Function(
    "process",
    "fetch",
    "setTimeout",
    "clearTimeout",
    SUBAGENT_BRIDGE.replace("export default", "return"),
  )(
    { env: { SUBSHELL_BASE_URL: "http://fixture", SUBSHELL_API_KEY: "fixture", SUBSHELL_ID: "pane" } },
    async (_url: string, init: { body: string }) => {
      reports.push(JSON.parse(init.body));
      return Response.json({});
    },
    (callback: () => void) => {
      timers.push(callback);
      return timers.length;
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
      return { handlers: childHandlers, listeners: childListeners, reports: childReports, flush: () => {} };
    },
  };
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
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents).toEqual([
    {
      id: "MCPNodeReview",
      name: "MCPNodeReview",
      status: "running",
      activity: "Review the node authority change",
    },
  ]);

  bridge.listeners.get("task:subagent:progress")?.(PROGRESS);
  bridge.flush();
  await Promise.resolve();
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
  bridge.flush();
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents[0]?.status).toBe("waiting");

  bridge.listeners.get("task:subagent:progress")?.(PROGRESS);
  bridge.flush();
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents[0]?.status).toBe("running");

  bridge.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, status: "completed" });
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
});

test("failed and aborted children leave the roster too", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  bridge.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, status: "failed" });
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
  bridge.listeners.get("task:subagent:lifecycle")?.(STARTED);
  bridge.listeners.get("task:subagent:lifecycle")?.({ ...STARTED, id: "MCPNodeReview", status: "aborted" });
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
});

test("a child session never reports its own grandchildren as the pane's children", async () => {
  const bridge = installBridge();
  const child = bridge.child();
  await child.handlers.get("session_start")?.({ type: "session_start" }, SUB);
  child.listeners.get("task:subagent:lifecycle")?.(STARTED);
  child.listeners.get("task:subagent:progress")?.(PROGRESS);
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
  expect(bridge.reports.at(-1)?.agents).toHaveLength(1);
  await bridge.handlers.get("session_start")?.({ type: "session_start" }, MAIN);
  expect(bridge.reports.at(-1)?.agents).toEqual([]);
});

test("names and activity are bounded and blank names fall back", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.({
    id: "spawned",
    name: "   ",
    status: "started",
    description: "y".repeat(400),
  });
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents).toEqual([
    { id: "spawned", name: "spawned", status: "running", activity: "y".repeat(160) },
  ]);
});

test("a child with no generated label shows its agent type instead", async () => {
  const bridge = installBridge();
  bridge.listeners.get("task:subagent:lifecycle")?.({ id: "typed", agent: "reviewer", status: "started" });
  await Promise.resolve();
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
  bridge.flush();
  await Promise.resolve();
  expect(bridge.reports.at(-1)?.agents[0]?.activity).toBe("reviewer");
});
