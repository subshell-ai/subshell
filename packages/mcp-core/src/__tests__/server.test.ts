import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/server";
import { runSubshellMcp } from "../server.js";

/**
 * The CONNECTION-LIFETIME contract of `runSubshellMcp` — the bug class the
 * client's T18 parity fix named: `server.connect()` resolves on ATTACH, so a
 * promise that resolves there is a caller's permission to exit, and exiting
 * kills a live transport milliseconds after `ready` (the server's Task-5
 * cross-subshell e2e caught exactly this shape in `subshell-server mcp`).
 * The returned promise must stay pending until the connection ENDS.
 */

/** Minimal in-process Transport; `close()` fires the (Protocol-wrapped)
 * `onclose` the runner armed pre-connect — the same path the EOF wiring on
 * the real stdio transport takes. */
class FakeTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }
  async send(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe("runSubshellMcp — connection lifetime", () => {
  test("does NOT resolve on attach; resolves when the transport closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-mcp-server-test-"));
    // Stub control plane: `POST /api/identities` is the only pre-connect call.
    const stub = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    const saved: Record<string, string | undefined> = {};
    const paneEnv: Record<string, string> = {
      SUBSHELL_API_KEY: "subshell_lifetime_test",
      SUBSHELL_ID: "lifetime-test-1",
      SUBSHELL_BASE_URL: `http://127.0.0.1:${stub.port}`,
      SUBSHELL_NAME: "lifetime-test",
      SUBSHELL_DATA_DIR: dir,
    };
    for (const [k, v] of Object.entries(paneEnv)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const transport = new FakeTransport();
      let ended = false;
      const run = runSubshellMcp(transport).then(() => {
        ended = true;
      });
      // Generous settle for identity write + registration fetch, then pin:
      // attached, still pending (an attach-time resolve is the T18 bug).
      await Bun.sleep(200);
      expect(transport.started).toBe(true);
      expect(ended).toBe(false);
      transport.close();
      await run;
      expect(ended).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
