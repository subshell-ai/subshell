import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseArgs, run } from "../cli.js";

/**
 * The `mote-agent mcp` CLI surface (Task 13). ONLY the reject paths are run
 * through `run()`: a complete MOTE_* env would boot the real stdio server on
 * the test process's stdin and never return, so the happy path is pinned by
 * the compiled-binary smoke check (task report, Step 3) instead. Isolation:
 * every MOTE_* variable is stripped per test — the reject assertions must
 * describe OUR env handling, never whatever the developer's shell exports.
 */
const MCP_ENV_KEYS = [
  "MOTE_API_KEY",
  "MOTE_BASE_URL",
  "MOTE_SESSION_ID",
  "MOTE_SESSION_NAME",
  "MOTE_DATA_DIR",
  "MOTE_CHANNEL_PIN",
] as const;

describe("mote-agent mcp (CLI wiring)", () => {
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

  /** The `mote-agent: …` line only — exit 2 always appends the full usage block. */
  const msgLine = (err: string) => err.split("\n")[0] ?? "";

  test("parseArgs accepts a bare `mcp` and rejects every flag (env is the only config)", () => {
    expect(parseArgs(["mcp"])).toEqual({ command: "mcp", flags: {} });
    expect(() => parseArgs(["mcp", "--json"])).toThrow(/not valid for 'mcp'/);
    expect(() => parseArgs(["mcp", "--data-dir", "/tmp/x"])).toThrow(/not valid for 'mcp'/);
  });

  test("missing MOTE_API_KEY → exit 2 with the actionable line, stdout untouched", async () => {
    const res = await run(["mcp"]);
    expect(res.code).toBe(2);
    expect(msgLine(res.err)).toInclude("MOTE_API_KEY is not set");
    expect(res.out).toBe("");
  });

  test("MOTE_API_KEY without MOTE_SESSION_ID → exit 2 naming MOTE_SESSION_ID", async () => {
    process.env.MOTE_API_KEY = "mote_test_key";
    const res = await run(["mcp"]);
    expect(res.code).toBe(2);
    expect(msgLine(res.err)).toInclude("MOTE_SESSION_ID is not set");
    expect(res.err).not.toInclude("MOTE_API_KEY is not set");
  });

  test("usage lists `mote-agent mcp`", async () => {
    const res = await run(["nope"]);
    expect(res.code).toBe(2);
    expect(res.err).toInclude("mote-agent mcp");
  });
});
