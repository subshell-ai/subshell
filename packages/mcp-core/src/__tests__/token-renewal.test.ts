import { describe, expect, it } from "bun:test";

import { startTokenRenewal } from "../server.js";
import type { ToolApi } from "../tools.js";

/**
 * Issue #331: the MCP child is spawned per harness session and routinely dies
 * before the old 12h heartbeat tick, so its pane's 7-day token silently
 * expired and could not be renewed from inside (the extend route 401s on a
 * dead token). The fix is that the extend fires AT STARTUP; these tests pin
 * that the boot call happens, on the right door, with the cadence behind it,
 * and that failure stays non-fatal (the tools must still serve, and their
 * 401 mapping is the human-restart remedy).
 */

interface Call {
  path: string;
  method?: string;
}

function recordingApi(fail = false): { api: ToolApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: ToolApi = {
    async req<T>(path: string, init?: { method?: string }): Promise<T> {
      calls.push({ path, method: init?.method });
      if (fail) throw new Error("401 unauthorized");
      return {} as T;
    },
  };
  return { api, calls };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => (process.stderr.write = original) };
}

describe("startTokenRenewal (issue #331 startup extend)", () => {
  it("extends immediately at startup, on the pane's own extend door", async () => {
    const { api, calls } = recordingApi();
    const timer = startTokenRenewal(api, "sess-1", 60_000);
    try {
      // The boot call is synchronous fire-and-forget: the request is issued
      // before the function returns, not on the first tick.
      expect(calls).toEqual([{ path: "/api/subshells/sess-1/extend-token", method: "POST" }]);
    } finally {
      clearInterval(timer);
    }
  });

  it("keeps extending on the interval while the child lives", async () => {
    const { api, calls } = recordingApi();
    const timer = startTokenRenewal(api, "sess-1", 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls.every((c) => c.path === "/api/subshells/sess-1/extend-token")).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("a refused extend is logged to stderr and never thrown", async () => {
    const { api, calls } = recordingApi(true);
    const err = captureStderr();
    try {
      const timer = startTokenRenewal(api, "sess-1", 60_000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(calls.length).toBe(1);
        expect(err.lines.some((l) => l.includes("subshell mcp: token extend failed:"))).toBe(true);
      } finally {
        clearInterval(timer);
      }
    } finally {
      err.restore();
    }
  });

  it("the renewal timer never holds the process open", () => {
    const { api } = recordingApi();
    const timer = startTokenRenewal(api, "sess-1", 60_000);
    try {
      // unref'd: the stdio connection, not this timer, keeps `subshell mcp` alive.
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
