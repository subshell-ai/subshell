import { describe, expect, it } from "bun:test";
import { applyDebugLogging, debugLoggingState } from "@/services/logging-preference.js";

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
