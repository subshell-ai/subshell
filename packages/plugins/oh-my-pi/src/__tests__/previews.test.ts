import { expect, test } from "bun:test";
import { PREVIEW_BRIDGE } from "../previews.js";

type Report = { ports: { port: number; title?: string }[] };

/** The bridge as a function body with its ambient globals replaced. */
function installBridge(
  env: Record<string, string> = {
    SUBSHELL_BASE_URL: "http://fixture",
    SUBSHELL_API_KEY: "fixture",
    SUBSHELL_ID: "pane",
  },
  send?: (url: string, init: { body: string }) => Promise<Response>,
) {
  const handlers = new Map<string, (event: unknown) => void>();
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
    PREVIEW_BRIDGE.replace("export default", "return"),
  )(
    { env },
    send ??
      (async (_url: string, init: { body: string }) => {
        reports.push(JSON.parse(init.body));
        return Response.json({ ok: true });
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
    on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler);
    },
    logger: { debug: () => {} },
  });
  return {
    handlers,
    reports,
    beats,
    /** Run every queued coalescing timer in order. */
    flush: () => {
      while (timers.length > 0) timers.shift()?.();
    },
  };
}

const toolResult = (text: string, isError = false) => ({
  type: "tool_result",
  toolCallId: "t1",
  toolName: "bash",
  input: {},
  isError,
  content: [{ type: "text", text }],
});

test("reports loopback ports printed by a tool result", async () => {
  const bridge = installBridge();
  bridge.handlers.get("tool_result")?.(toolResult("  VITE v6 ready\n  Local:   http://localhost:5173/"));
  bridge.flush();
  await Promise.resolve();
  expect(bridge.reports).toEqual([{ ports: [{ port: 5173, title: "Local:   http://localhost:5173/" }] }]);
});

test("accepts every loopback spelling and ignores remote hosts and errors", async () => {
  const bridge = installBridge();
  bridge.handlers.get("tool_result")?.(
    toolResult(
      [
        "http://127.0.0.1:3000",
        "http://0.0.0.0:8080",
        "http://[::1]:4000",
        "https://example.com:9000",
        "http://localhost:8080",
      ].join("\n"),
    ),
  );
  bridge.handlers.get("tool_result")?.(toolResult("http://localhost:9999", true));
  bridge.flush();
  await Promise.resolve();
  expect(bridge.reports[0].ports.map((row) => row.port).sort()).toEqual([3000, 4000, 8080]);
});

test("coalesces a burst into one report and re-reports on the heartbeat", async () => {
  const bridge = installBridge();
  bridge.handlers.get("tool_result")?.(toolResult("http://localhost:3000"));
  bridge.handlers.get("tool_result")?.(toolResult("http://localhost:4000"));
  expect(bridge.reports).toHaveLength(0);
  bridge.flush();
  await Promise.resolve();
  expect(bridge.reports).toHaveLength(1);
  expect(bridge.reports[0].ports.map((row) => row.port).sort()).toEqual([3000, 4000]);
  bridge.beats[0]?.();
  await Promise.resolve();
  expect(bridge.reports).toHaveLength(2);
});

test("posts to the pane's own report route and stays quiet without pane identity", async () => {
  let url = "";
  const bridge = installBridge(undefined, async (target) => {
    url = target;
    return Response.json({ ok: true }, { status: 200 });
  });
  bridge.handlers.get("tool_result")?.(toolResult("Local: http://localhost:8080"));
  bridge.flush();
  await Promise.resolve();
  expect(url).toBe("http://fixture/api/subshells/pane/views/report");

  let called = false;
  const blind = installBridge({ SUBSHELL_BASE_URL: "", SUBSHELL_API_KEY: "", SUBSHELL_ID: "" }, async () => {
    called = true;
    return Response.json({});
  });
  blind.handlers.get("tool_result")?.(toolResult("http://localhost:8080"));
  blind.flush();
  await Promise.resolve();
  expect(called).toBe(false);
});
