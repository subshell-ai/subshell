import { describe, expect, it } from "bun:test";
import type { IdentityKeyPair } from "../crypto.js";
import { execInTerminal } from "../terminal-tools.js";
import type { ToolApi } from "../tools.js";

/**
 * The exec verb's MCP handler is a thin POST; the state machine lives on the
 * server (spec 2026-10-02). So these pin the wire: path encoding, the
 * snake_case-args / camelCase-body split, and the untouched pass-through.
 */

/** Records each call and answers with the server's canned exec result. */
function api(calls: { path: string; method: string; body?: unknown }[]): ToolApi {
  return {
    async req<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      return { status: "completed", exitCode: 0, output: "ok", truncated: false, nextByte: 42 } as T;
    },
  };
}

// The stub shape server.test.ts uses: execInTerminal touches no crypto, so
// an inert keypair suffices.
const own: IdentityKeyPair = { principalId: "sess:test", publicJwk: "{}", privateJwk: "{}" };

describe("execInTerminal (MCP thin POST)", () => {
  it("POSTs the camelCase body and passes the answer through untouched", async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const out = await execInTerminal(
      { api: api(calls), own },
      {
        subshell_id: "s/1",
        command: "echo hi",
        timeout_ms: 5000,
      },
    );
    expect(calls[0]).toEqual({
      path: "/api/subshells/s%2F1/exec",
      method: "POST",
      body: { command: "echo hi", timeoutMs: 5000 },
    });
    expect(out).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("omits timeoutMs when the caller named none", async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    await execInTerminal({ api: api(calls), own }, { subshell_id: "s1", command: "ls" });
    expect(calls[0]).toEqual({
      path: "/api/subshells/s1/exec",
      method: "POST",
      body: { command: "ls" },
    });
    // Absent on the wire, not `undefined`: the server's own default is the
    // point (the `in`-check idiom the create_subshell body pins use).
    expect("timeoutMs" in ((calls[0]?.body ?? {}) as Record<string, unknown>)).toBe(false);
  });
});
