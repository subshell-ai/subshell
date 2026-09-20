import { describe, expect, test } from "bun:test";
import { exitHookFor } from "../exit-hook.js";

/** A complete pane credential set — anything less registers no hook at all. */
const ENV = {
  SUBSHELL_API_KEY: "subshell_k1",
  SUBSHELL_BASE_URL: "http://127.0.0.1:3080",
  SUBSHELL_ID: "s1",
};

/**
 * The `pane-died` hook command (spec 2026-09-19 §4.3). Every case here is
 * about SILENCE: the hook's output goes nowhere anyone reads, so a command
 * that is wrong does not fail, it simply never reports — and the death falls
 * back to the sweep seconds or minutes later, looking like the feature never
 * worked rather than like a bug.
 */
describe("exitHookFor", () => {
  test("registers nothing when no reporter could be resolved", () => {
    // A command that cannot run is worse than no hook: the sweep is a correct
    // backstop, a broken hook is a silent one.
    expect(exitHookFor(undefined, ENV)).toBeUndefined();
  });

  test("registers nothing when the credentials are incomplete", () => {
    const reporter = { command: "/usr/local/bin/subshell", args: ["report"] };
    for (const missing of Object.keys(ENV)) {
      const partial = { ...ENV };
      delete (partial as Record<string, string>)[missing];
      expect(exitHookFor(reporter, partial)).toBeUndefined();
    }
  });

  test("quotes a reporter path containing a space", () => {
    // The real case, not a hypothetical: `process.execPath` inside a macOS
    // bundle is `…/Subshell Server.app/Contents/MacOS/…`. Unquoted it splits
    // into two words and the hook produces no output whatsoever — measured
    // against a live tmux server during review.
    const hook = exitHookFor(
      { command: "/Applications/Subshell Server.app/Contents/MacOS/subshell-server", args: ["report"] },
      ENV,
    );
    expect(hook).toContain("'/Applications/Subshell Server.app/Contents/MacOS/subshell-server'");
  });

  test("leaves the status format BARE, so tmux interpolates it", () => {
    // Those single quotes are literal text for tmux, not shell quoting we
    // added: quoting them would escape the quotes and hand the reporter the
    // format string itself. And they must be there — an empty status has to
    // survive as an argv word, or "no status" reads as "exited 0".
    const hook = exitHookFor({ command: "/bin/subshell", args: ["report"] }, ENV);
    expect(hook?.endsWith(" 'exit' '#{pane_dead_status}'")).toBe(true);
    expect(hook).not.toContain("\\#");
  });

  test("says the `report` word exactly once", () => {
    // `ReporterSpec.args` already ends with it — the spec is a prefix ready
    // for a plugin's own verb words. Appending it again produced
    // `report report exit`, a usage error the hook swallowed silently.
    const hook = exitHookFor({ command: "/bin/subshell", args: ["report"] }, ENV);
    expect(hook?.match(/'report'/g)?.length).toBe(1);
    // Asserting the tail alone would not catch it: `'report' 'exit'` is a
    // substring of `'report' 'report' 'exit'`.
    expect(hook).not.toContain("'report' 'report'");
  });

  test("quotes an ordinary credential value containing a space", () => {
    const hook = exitHookFor({ command: "/bin/subshell", args: ["report"] }, { ...ENV, SUBSHELL_ID: "a b" });
    expect(hook).toContain("SUBSHELL_ID='a b'");
  });

  test.each([
    ["a quote", "ab'cd"],
    ["a backslash", "a\\b"],
    ["a double quote", 'a"b'],
    ["a tmux format", "#{session_name}"],
  ])("registers NO hook when a credential carries %s", (_what, value) => {
    // MEASURED end to end, one real pane death per value: a quote makes the
    // hook silently never fire, a backslash makes it fire with a corrupted
    // credential (a 401 the reporter swallows — worse than silence, because it
    // looks like it worked), and `#` is EXPANDED by tmux, which makes this a
    // format context rather than an inert string. `"` closes the `run-shell
    // "…"` these are spliced into.
    //
    // So the value is refused rather than carried: the sweep is a correct
    // backstop and a corrupted credential is not. Reachable rather than
    // hypothetical — a preset may legitimately override `SUBSHELL_BASE_URL`.
    const reporter = { command: "/bin/subshell", args: ["report"] };
    expect(exitHookFor(reporter, { ...ENV, SUBSHELL_BASE_URL: value })).toBeUndefined();
    expect(exitHookFor(reporter, { ...ENV, SUBSHELL_API_KEY: value })).toBeUndefined();
    expect(exitHookFor(reporter, { ...ENV, SUBSHELL_ID: value })).toBeUndefined();
  });

  test("still builds for the values these credentials actually take", () => {
    // A uuid, a `subshell_` key and an http(s) URL — none of which can carry
    // any of the four, so the refusal above costs nothing in practice.
    const hook = exitHookFor(
      { command: "/bin/subshell", args: ["report"] },
      {
        SUBSHELL_ID: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        SUBSHELL_API_KEY: "subshell_Ab3-_xYz09",
        SUBSHELL_BASE_URL: "https://plane.example.com:3080/",
      },
    );
    expect(hook).toBeDefined();
  });

  test("carries the credentials itself, because the tmux server has none", () => {
    // A pane is launched through `env -i`, so its SUBSHELL_* reach that
    // process alone; a `run-shell` hook inherits the SERVER's environment.
    const hook = exitHookFor({ command: "/bin/subshell", args: ["report"] }, ENV);
    expect(hook?.startsWith("env ")).toBe(true);
    for (const key of Object.keys(ENV)) expect(hook).toContain(`${key}=`);
  });
});
