import { expect, test } from "bun:test";
import { SUBAGENT_BRIDGE } from "../subagents.js";

test("native selection changes the current TUI and reports only active descendants", async () => {
  const reports: Record<string, unknown>[] = [];
  let tick: () => Promise<void> = async () => {};
  let command: { id: string; agentId: string | null } | undefined;
  const route = { name: "session", params: { sessionID: "root" } };
  const api = {
    route: {
      get current() {
        return route;
      },
      navigate(name: string, params: { sessionID: string }) {
        route.name = name;
        route.params = params;
      },
    },
    lifecycle: { signal: new AbortController().signal, onDispose: () => {} },
    state: { session: { permission: () => [], question: () => [] } },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: { id: sessionID, ...(sessionID === "root" ? {} : { parentID: "root" }) },
        }),
        status: async () => ({ data: { child: { type: "busy" }, done: { type: "idle" } } }),
        children: async ({ sessionID }: { sessionID: string }) => ({
          data:
            sessionID === "root"
              ? [
                  { id: "child", parentID: "root", title: "Review" },
                  { id: "done", parentID: "root", title: "Finished" },
                ]
              : [],
        }),
      },
    },
  };
  const plugin = new Function(
    "process",
    "fetch",
    "setInterval",
    "clearInterval",
    SUBAGENT_BRIDGE.replace("export default", "return"),
  )(
    { env: { SUBSHELL_BASE_URL: "http://fixture", SUBSHELL_API_KEY: "fixture", SUBSHELL_ID: "pane" } },
    async (_url: string, init: { body: string }) => {
      reports.push(JSON.parse(init.body));
      return Response.json({ command });
    },
    (callback: () => Promise<void>) => {
      tick = callback;
      return 1;
    },
    () => {},
  );
  await plugin.tui(api);
  expect(reports[0]?.agents).toEqual([{ id: "child", parentId: "root", name: "Review", status: "running" }]);
  command = { id: "pick", agentId: "child" };
  await tick();
  expect(route.params.sessionID).toBe("child");
  command = undefined;
  await tick();
  expect(reports.at(-1)?.selectedId).toBe("child");
  // Native keyboard navigation is observed too, without a sidebar command.
  route.params.sessionID = "root";
  await tick();
  expect(reports.at(-1)?.selectedId).toBeNull();
  command = { id: "foreign", agentId: "other-workspace" };
  await tick();
  expect(route.params.sessionID).toBe("root");
});
