import { afterEach, expect, test } from "bun:test";
import { registerViewer, resetLiveViewersForTests, type WsData } from "@/api/ws/viewers.js";
import { performRestart } from "@/modules/server/server-restart.js";
import { createApp } from "@/server.js";

afterEach(resetLiveViewersForTests);

test("application composition closes browser terminals before restart exits", async () => {
  createApp();
  const calls: string[] = [];
  registerViewer(
    {
      data: { viewerId: "restart-viewer" } as WsData,
      send() {},
      close(code, reason) {
        calls.push(`browser:${code}:${reason}`);
      },
    },
    "restart-pane",
  );
  let scheduled: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    performRestart({
      setTimer: ((callback: () => void) => {
        scheduled = callback;
        return 0;
      }) as never,
      closeNodes: () => 0,
      stopProcesses: async () => {},
      exit: (code) => {
        calls.push(`exit:${code}`);
        resolve();
      },
    });
  });
  expect(calls).toEqual([]);
  expect(scheduled).toBeDefined();
  scheduled?.();
  await exited;
  expect(calls).toEqual(["browser:1012:server restart", "exit:0"]);
});
