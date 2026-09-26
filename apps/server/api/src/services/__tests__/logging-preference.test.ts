import { describe, expect, it } from "bun:test";
import { applyDebugLogging, debugLoggingState } from "@/services/logging-preference.js";
import { serverLogFile } from "@/utils/log-file.js";
import { consoleVerbose, setConsoleVerbose } from "@/utils/logger.js";

describe("debugLoggingState", () => {
  it("the environment forces on and is read-only; otherwise the stored setting; otherwise off", () => {
    expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: "1" }, false)).toEqual({ debug: true, source: "process env" });
    expect(debugLoggingState({}, true)).toEqual({ debug: true, source: "setting" });
    expect(debugLoggingState({}, false)).toEqual({ debug: false, source: "setting" });
    expect(debugLoggingState({}, null)).toEqual({ debug: false, source: "default" });
    expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: "0" }, null)).toEqual({ debug: false, source: "default" });
  });
});

describe("applyDebugLogging", () => {
  it("flips only the file transport's level", () => {
    const t = { level: "info" } as { level: string };
    applyDebugLogging(true, t as never);
    expect(t.level).toBe("debug");
    applyDebugLogging(false, t as never);
    expect(t.level).toBe("info");
  });
});

/**
 * `--verbose` (2026-09-26): the console flip is the file flip's MIRROR, and
 * the boundary is pinned in the strongest form available without a real
 * process: after the console gate goes to debug, the FILE gate is still
 * `info`, and the env-forced read-only state never engaged (no env value,
 * no settings row). No timers, no emissions: `IS_TEST` disables logging,
 * and the level gates themselves are the subject.
 */
describe("setConsoleVerbose (--verbose, 2026-09-26)", () => {
  it("raises only the console gate: the file stays at info and the debug switch is untouched", () => {
    setConsoleVerbose(true);
    try {
      expect(consoleVerbose()).toBe(true);
      expect(serverLogFile.level ?? "trace").toBe("info");
      expect(debugLoggingState({}, null)).toEqual({ debug: false, source: "default" });
    } finally {
      setConsoleVerbose(false);
    }
    expect(consoleVerbose()).toBe(false);
  });
});
