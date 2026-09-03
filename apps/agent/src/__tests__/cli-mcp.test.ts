import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseArgs, run } from "../cli.js";

/**
 * The `subshell mcp` CLI surface (Task 13). ONLY the reject paths are run
 * through `run()`: a complete SUBSHELL_* env would attach the real stdio transport
 * to this test runner's own stdin (run() then resolves with `keepAlive` once
 * attached — post-T18-fix, see `cli-mcp-entry.test.ts` for the spawned-child
 * happy path: liveness + the initialize handshake). Isolation:
 * every SUBSHELL_* variable is stripped per test — the reject assertions must
 * describe OUR env handling, never whatever the developer's shell exports.
 */
const MCP_ENV_KEYS = [
  "SUBSHELL_API_KEY",
  "SUBSHELL_BASE_URL",
  "SUBSHELL_ID",
  "SUBSHELL_NAME",
  "SUBSHELL_DATA_DIR",
  "SUBSHELL_CHANNEL_PIN",
] as const;

describe("subshell mcp (CLI wiring)", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of MCP_ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  /** The `subshell: …` line only — exit 2 always appends the full usage block. */
  const msgLine = (err: string) => err.split("\n")[0] ?? "";

  test("parseArgs accepts a bare `mcp` and rejects every flag (env is the only config)", () => {
    expect(parseArgs(["mcp"])).toEqual({ command: "mcp", flags: {} });
    expect(() => parseArgs(["mcp", "--json"])).toThrow(/not valid for 'mcp'/);
    expect(() => parseArgs(["mcp", "--data-dir", "/tmp/x"])).toThrow(/not valid for 'mcp'/);
  });

  test("missing SUBSHELL_API_KEY → exit 2 with the actionable line, stdout untouched", async () => {
    const res = await run(["mcp"]);
    expect(res.code).toBe(2);
    expect(msgLine(res.err)).toInclude("SUBSHELL_API_KEY is not set");
    expect(res.out).toBe("");
  });

  test("SUBSHELL_API_KEY without SUBSHELL_ID → exit 2 naming SUBSHELL_ID", async () => {
    process.env.SUBSHELL_API_KEY = "subshell_test_key";
    const res = await run(["mcp"]);
    expect(res.code).toBe(2);
    expect(msgLine(res.err)).toInclude("SUBSHELL_ID is not set");
    expect(res.err).not.toInclude("SUBSHELL_API_KEY is not set");
  });

  test("usage lists `subshell mcp`", async () => {
    const res = await run(["nope"]);
    expect(res.code).toBe(2);
    expect(res.err).toInclude("subshell mcp");
  });
});
