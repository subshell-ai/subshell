import { expect, test } from "bun:test";
import { SUBAGENT_BRIDGE } from "../subagents.js";

test("the example's provisional zero exit code does not hide running children", async () => {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const reports: { agents: { id: string }[] }[] = [];
  const install = new Function(
    "process",
    "fetch",
    "setInterval",
    "clearInterval",
    SUBAGENT_BRIDGE.replace("export default", "return"),
  )(
    { env: { SUBSHELL_BASE_URL: "http://fixture", SUBSHELL_API_KEY: "fixture", SUBSHELL_ID: "pane" } },
    async (_url: string, init: { body: string }) => {
      reports.push(JSON.parse(init.body));
      return Response.json({});
    },
    () => ({ unref: () => {} }),
    () => {},
  );
  install({
    on: (name: string, handler: (event: unknown) => Promise<void>) => handlers.set(name, handler),
    events: { on: () => {} },
  });
  await handlers.get("tool_execution_update")?.({
    toolName: "subagent",
    toolCallId: "call",
    partialResult: { details: { results: [{ agent: "review", exitCode: 0 }] } },
  });
  expect(reports.at(-1)?.agents).toHaveLength(1);
  await handlers.get("tool_execution_update")?.({
    toolName: "subagent",
    toolCallId: "call",
    partialResult: { details: { results: [{ agent: "review", exitCode: 0, stopReason: "stop" }] } },
  });
  expect(reports.at(-1)?.agents).toHaveLength(0);
  await handlers.get("tool_execution_start")?.({
    toolName: "subagent",
    toolCallId: "next",
    args: { agent: "explore" },
  });
  expect(reports.at(-1)?.agents).toHaveLength(1);
  await handlers.get("tool_execution_end")?.({ toolCallId: "next" });
  expect(reports.at(-1)?.agents).toHaveLength(0);
});

test("extension metadata skips invalid entries and normalizes empty names", async () => {
  let publish: (value: unknown) => void = () => {};
  const reports: { agents: { id: string; name: string; status: string; activity?: string }[] }[] = [];
  const install = new Function(
    "process",
    "fetch",
    "setInterval",
    "clearInterval",
    SUBAGENT_BRIDGE.replace("export default", "return"),
  )(
    { env: { SUBSHELL_BASE_URL: "http://fixture", SUBSHELL_API_KEY: "fixture", SUBSHELL_ID: "pane" } },
    async (_url: string, init: { body: string }) => {
      reports.push(JSON.parse(init.body));
      return Response.json({});
    },
    () => ({ unref: () => {} }),
    () => {},
  );
  install({
    on: () => {},
    events: {
      on: (_name: string, handler: typeof publish) => {
        publish = handler;
      },
    },
  });
  publish({
    agents: [
      null,
      { id: "", name: "invalid" },
      { id: "x".repeat(257), name: "invalid" },
      { id: "valid", name: " " },
      // The hover-card label is the shipped reason this channel exists; a
      // non-string one is noise and an over-long one lands bounded.
      { id: "labelled", name: "worker", activity: "Review the migration plan" },
      { id: "flooded", name: "other", activity: `${"y".repeat(200)}` },
      { id: "noise", name: "third", activity: 7 },
    ],
  });
  await Promise.resolve();
  expect(reports.at(-1)?.agents).toEqual([
    { id: "valid", name: "Subagent", status: "running" },
    { id: "labelled", name: "worker", status: "running", activity: "Review the migration plan" },
    { id: "flooded", name: "other", status: "running", activity: "y".repeat(160) },
    { id: "noise", name: "third", status: "running" },
  ]);
});

test("session_start resets the roster and session_shutdown stops the timer", async () => {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const reports: { agents: { id: string }[] }[] = [];
  let cleared = 0;
  const install = new Function(
    "process",
    "fetch",
    "setInterval",
    "clearInterval",
    SUBAGENT_BRIDGE.replace("export default", "return"),
  )(
    { env: { SUBSHELL_BASE_URL: "http://fixture", SUBSHELL_API_KEY: "fixture", SUBSHELL_ID: "pane" } },
    async (_url: string, init: { body: string }) => {
      reports.push(JSON.parse(init.body));
      return Response.json({});
    },
    () => ({ unref: () => {} }),
    () => {
      cleared += 1;
    },
  );
  install({
    on: (name: string, handler: (event: unknown) => Promise<void>) => handlers.set(name, handler),
    events: { on: () => {} },
  });
  await handlers.get("tool_execution_start")?.({ toolName: "subagent", toolCallId: "call", args: { agent: "review" } });
  expect(reports.at(-1)?.agents).toHaveLength(1);
  // pi has no SessionStart hook: session_start IS this harness's roster reset,
  // the same decision the hook integrations make on /clear.
  await handlers.get("session_start")?.(undefined);
  expect(reports.at(-1)?.agents).toHaveLength(0);
  await handlers.get("tool_execution_start")?.({ toolName: "subagent", toolCallId: "c2", args: { agent: "build" } });
  expect(reports.at(-1)?.agents).toHaveLength(1);
  // Shutdown is the only in-bridge cleanup of the shared timer; an agent left
  // reporting every 2 s against a dead session is exactly what it prevents.
  await handlers.get("session_shutdown")?.(undefined);
  expect(cleared).toBe(1);
  expect(reports.at(-1)?.agents).toHaveLength(0);
});
