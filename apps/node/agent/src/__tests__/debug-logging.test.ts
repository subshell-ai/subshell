import { afterEach, describe, expect, it } from "bun:test";
import { applyDebugLogging, debugLoggingState } from "../debug-logging.js";
import { CappedFileTransport } from "../log-file.js";

afterEach(() => {
  delete process.env.SUBSHELL_DEBUG_LOGGING;
});

describe("debugLoggingState", () => {
  it("lets the environment force it on, and say so", () => {
    for (const spelling of ["1", "true"]) {
      expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: spelling }, false)).toEqual({
        debug: true,
        source: "process env",
      });
    }
  });

  it("treats a falsy spelling as a variable left behind, not as the environment saying off", () => {
    // Making it read-only-OFF would take the switch away with nothing to show
    // for it. The server's rule, to the letter.
    expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: "0" }, true)).toEqual({ debug: true, source: "setting" });
    expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: "" }, null)).toEqual({ debug: false, source: "default" });
  });

  it("falls back to the stored flag, then to off", () => {
    expect(debugLoggingState({}, true)).toEqual({ debug: true, source: "setting" });
    expect(debugLoggingState({}, false)).toEqual({ debug: false, source: "setting" });
    // An absent field — an older config, or one never touched.
    expect(debugLoggingState({}, null)).toEqual({ debug: false, source: "default" });
  });
});

describe("applyDebugLogging", () => {
  it("moves the FILE transport's level and nothing else", () => {
    // The level gate was missing from this transport entirely: with none
    // passed, LoggerlessTransport reads an absent level as `trace`, so it
    // wrote whatever it was handed. `info` is now the floor.
    const file = new CappedFileTransport("/tmp/unused-subshell-test.log", 1024);
    expect(file.level).toBe("info");
    applyDebugLogging(true, file);
    expect(file.level).toBe("debug");
    applyDebugLogging(false, file);
    expect(file.level).toBe("info");
  });
});
