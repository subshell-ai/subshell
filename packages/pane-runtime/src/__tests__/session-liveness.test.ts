import { describe, expect, test } from "bun:test";
import { parseSessionLiveness, SESSION_LIVENESS_FORMAT } from "../tmux-runner.js";

/**
 * The half of `listSubshellsChecked` that can be checked on ANY tmux.
 *
 * The defect this exists for was a difference BETWEEN tmux versions — 3.4
 * renders a tab in `-F` output as `_`, 3.7 does not — which no test running
 * against one tmux can see. So the format is asserted as a value, and the
 * parse is driven with output captured from both.
 */
describe("session liveness parsing", () => {
  test("the separator is a colon, which a session name cannot contain", () => {
    // Pinned as a VALUE because the failure it prevents is silent: a tab
    // parses as one field on tmux 3.4, so every name comes back mangled and
    // every deadness flag missing — the node's watcher then reports every
    // running subshell dead and never reports a real death. tmux's own
    // `session_check_name` replaces `:` in a name with `_`, which is what
    // makes a colon unambiguous rather than merely untried.
    expect(SESSION_LIVENESS_FORMAT).toBe("#{session_name}:#{pane_dead}");
  });

  test("reads real tmux 3.4 output", () => {
    // Captured in ubuntu:24.04, one live session and one finished one.
    expect(parseSessionLiveness("gone1:1\nlive1:0\n")).toEqual(["live1"]);
  });

  test("reads real tmux 3.7 output", () => {
    expect(parseSessionLiveness("live1:0\ngone1:1\n")).toEqual(["live1"]);
  });

  test("keeps a name containing underscores and digits intact", () => {
    // The shape the tab bug produced (`live1_0`) is a legal session name, so
    // nothing downstream could have told the mangled form from a real one.
    expect(parseSessionLiveness("live1_0:0\nck_a_1:0\n")).toEqual(["live1_0", "ck_a_1"]);
  });

  test("reads an absent deadness flag as ALIVE, never as dead", () => {
    // A tmux that does not resolve `#{pane_dead}` must not retire a running
    // subshell: this list drives death reports, so the fail-safe direction is
    // to keep the name.
    expect(parseSessionLiveness("solo\n")).toEqual(["solo"]);
    expect(parseSessionLiveness("solo:\n")).toEqual(["solo"]);
  });

  test("ignores blank lines, including the trailing one tmux always writes", () => {
    expect(parseSessionLiveness("")).toEqual([]);
    expect(parseSessionLiveness("\n\n")).toEqual([]);
    expect(parseSessionLiveness("a:0\n\nb:0\n")).toEqual(["a", "b"]);
  });

  test("splits from the RIGHT, so a colon in a name costs no characters", () => {
    // tmux should never produce one; taking the last field rather than the
    // first means that if it ever does, the name survives whole.
    expect(parseSessionLiveness("odd:name:1\n")).toEqual([]);
    expect(parseSessionLiveness("odd:name:0\n")).toEqual(["odd:name"]);
  });

  test("treats anything but `1` as alive", () => {
    expect(parseSessionLiveness("a:0\nb:1\nc:x\n")).toEqual(["a", "c"]);
  });
});
