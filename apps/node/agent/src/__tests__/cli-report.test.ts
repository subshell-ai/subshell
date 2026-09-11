import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseArgs, run } from "../cli.js";

/**
 * `subshell report <verb>` — the out-of-band reporting a harness hook runs on
 * THIS machine. It is the node twin of the server binary's identical
 * subcommand, and the reason both exist is that a pane's machine is only
 * guaranteed to have whichever of the two launched it.
 *
 * The cases that matter are all about silence: a hook's exit code and output
 * land in the user's own session, so an unreachable plane, a missing env, or a
 * typo'd verb must all be quiet zeroes.
 */
const PANE_ENV_KEYS = ["SUBSHELL_API_KEY", "SUBSHELL_BASE_URL", "SUBSHELL_ID"] as const;

describe("subshell report (CLI wiring)", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of PANE_ENV_KEYS) {
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

  test("parseArgs takes a verb and, for attention, its kind", () => {
    expect(parseArgs(["report", "attention", "turn_complete"])).toEqual({
      command: "report",
      sub: "attention",
      arg: "turn_complete",
      flags: {},
    });
    expect(parseArgs(["report", "attention", "needs_attention"])).toEqual({
      command: "report",
      sub: "attention",
      arg: "needs_attention",
      flags: {},
    });
    expect(parseArgs(["report", "session"])).toEqual({ command: "report", sub: "session", flags: {} });
  });

  test("rejects an unknown verb, an unknown kind, and a kind after a verb that takes none", () => {
    expect(() => parseArgs(["report", "nonsense"])).toThrow(/unknown report subcommand/);
    expect(() => parseArgs(["report", "attention", "made_up"])).toThrow(/unknown report attention argument/);
    // `session` takes no second word, so one is an error rather than ignored —
    // silently dropping it is how a typo'd report reports the wrong thing.
    expect(() => parseArgs(["report", "session", "extra"])).toThrow(/takes no argument/);
  });

  test("a verb that requires an argument refuses to be given none", () => {
    expect(() => parseArgs(["report", "attention"])).toThrow(/requires/);
  });

  test("takes no flags — a hook's command line is built, never typed", () => {
    expect(() => parseArgs(["report", "session", "--json"])).toThrow(/not valid for 'report'/);
  });

  test("an incomplete pane env is still a silent exit 0, not a usage error", async () => {
    // Unlike `mcp`, which exits 2 naming the missing variable: that one is a
    // server a human may have misconfigured, this one is a hook nobody typed.
    const res = await run(["report", "attention", "turn_complete"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe("");
    expect(res.err).toBe("");
  });
});
