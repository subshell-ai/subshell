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

  test("admits an unknown VERB as version skew, silently", () => {
    // Same doctrine as the kind slot below: a plane NEWER than this binary
    // can emit a verb compiled after it, and `report` is invoked by hooks
    // whose exit 2 BLOCKS the pane. Presence stays required (`report` alone
    // is still a usage error); `runReport` answers the unknown word with a
    // silent nothing.
    expect(parseArgs(["report", "nonsense"])).toEqual({ command: "report", sub: "nonsense", flags: {} });
    // A skew verb's argument rules are unknowable here — the word is taken,
    // not judged.
    expect(parseArgs(["report", "nonsense", "whatever"])).toEqual({
      command: "report",
      sub: "nonsense",
      arg: "whatever",
      flags: {},
    });
    expect(() => parseArgs(["report"])).toThrow(/requires/);
  });

  test("a KNOWN verb keeps its shape: session takes no second word", () => {
    // The skew tolerance is for verbs too NEW to know, not a licence to
    // ignore arguments: `session` is documented to take none, and silently
    // dropping one is how a typo'd report says the wrong thing.
    expect(() => parseArgs(["report", "session", "extra"])).toThrow(/takes no argument/);
  });

  test("does NOT reject an unknown attention kind — exit 2 would block the tool", () => {
    // A plane NEWER than this binary legitimately emits kinds compiled after
    // it (`resumed` arrived exactly this way, 2026-09-24). PreToolUse and
    // UserPromptSubmit treat exit 2 as a BLOCKING error, so a parse-time
    // refusal turns version skew into a pane that cannot run tools. The kind
    // is the reporter's business: `runReport` answers any unknown kind with
    // a silent nothing (pinned in mcp-core's report tests).
    expect(parseArgs(["report", "attention", "made_up"])).toEqual({
      command: "report",
      sub: "attention",
      arg: "made_up",
      flags: {},
    });
  });

  test("a verb that requires an argument refuses to be given none", () => {
    expect(() => parseArgs(["report", "attention"])).toThrow(/requires/);
  });

  test("takes no flags — a hook's command line is built, never typed", () => {
    expect(() => parseArgs(["report", "session", "--json"])).toThrow(/not valid for 'report'/);
  });

  test("an unknown verb runs as a silent 0 even with a complete pane env", async () => {
    // Parse admits it (skew must not block the pane); the reporter's own
    // filter is what says "nothing to send". Full env so the filter — not
    // the env — is the reason for the silence.
    process.env.SUBSHELL_API_KEY = "subshell_key123";
    process.env.SUBSHELL_BASE_URL = "http://127.0.0.1:1"; // deliberately undialable
    process.env.SUBSHELL_ID = "sub_report_test";
    const res = await run(["report", "nonsense"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe("");
    expect(res.err).toBe("");
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

describe("report exit — the pane's own death hook (spec 2026-09-19 §4.3)", () => {
  // Bun runs a package's test files in ONE process, and the last case below
  // fills in a complete pane env — without this restore it would leak to
  // every later file, and any future pane-env-sensitive suite created
  // alphabetically after this one would inherit a "complete" env and its
  // silence guarantees would stop proving anything.
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of PANE_ENV_KEYS) saved.set(k, process.env[k]);
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  test("accepts any status, because tmux gives a number rather than a word", () => {
    expect(parseArgs(["report", "exit", "7"])).toEqual({ command: "report", sub: "exit", arg: "7", flags: {} });
    expect(parseArgs(["report", "exit", "0"])).toEqual({ command: "report", sub: "exit", arg: "0", flags: {} });
    expect(parseArgs(["report", "exit", "137"])).toEqual({ command: "report", sub: "exit", arg: "137", flags: {} });
  });

  /**
   * tmux interpolates `#{pane_dead_status}` as the EMPTY string when it has
   * none to give, and the hook quotes it so the word still arrives. Accepting
   * it here is what lets the reporter say "unknown" instead of "exited 0".
   */
  test("accepts the empty status tmux produces when it knows none", () => {
    expect(parseArgs(["report", "exit", ""])).toEqual({ command: "report", sub: "exit", arg: "", flags: {} });
  });

  test("still requires the word, since a hook that lost it is a bug on our side", () => {
    expect(() => parseArgs(["report", "exit"])).toThrow(/requires a value/);
  });

  test("an unknown kind runs as a silent 0 even with a complete pane env", async () => {
    // The parse accepts it (skew must not block the pane); the reporter's own
    // filter is what decides "nothing to send". The full env matters here:
    // with an incomplete one the env filter would be the reason for silence,
    // and this test would pass without proving the kind path.
    process.env.SUBSHELL_API_KEY = "subshell_key123";
    process.env.SUBSHELL_BASE_URL = "http://127.0.0.1:1"; // deliberately undialable
    process.env.SUBSHELL_ID = "sub_report_test";
    const res = await run(["report", "attention", "made_up"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe("");
    expect(res.err).toBe("");
  });
});
