import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type NodeConfig, saveConfig } from "../config.js";
import {
  applyDebugLogging,
  currentDebugLogging,
  debugLoggingState,
  loadAndApplyDebugLogging,
  resetDebugLoggingForTests,
  setDebugLogging,
} from "../debug-logging.js";
import { CappedFileTransport } from "../log-file.js";
import { newHome } from "../test-preload.js";

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

/**
 * The PERSISTENCE half: `config.json` is shared with the retention card (and
 * is the node key's only home), so the writer goes through `updateConfig`'s
 * fresh re-read — round-3 review, finding 3, the node's twin of the fixed C7.
 */
describe("setDebugLogging persistence", () => {
  const base: NodeConfig = {
    serverUrl: "http://plane.invalid",
    nodeId: "node-abc",
    nodeKey: "nk_test",
    controlPublicKey: "{}",
    dataDir: "/tmp/unused-by-this-module",
    name: "testbed",
  };
  const stored = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(process.env.SUBSHELL_CONFIG_HOME as string, "config.json"), "utf8"));

  beforeEach(() => {
    newHome();
    resetDebugLoggingForTests();
  });
  afterEach(() => {
    resetDebugLoggingForTests();
  });

  it("writes the flag and cannot revert a retention field it does not name", async () => {
    await saveConfig({ ...base, logRetentionDays: 7, logRetentionHours: 3 });
    const state = await setDebugLogging(true);
    expect(state).toEqual({ debug: true, source: "setting" });
    expect(stored().debugLogging).toBe(true);
    expect(stored().logRetentionDays).toBe(7); // the dashboard's retention write survives this one
    expect(stored().logRetentionHours).toBe(3);
  });

  it("boot restores a persisted flag — and the environment still wins", async () => {
    await saveConfig({ ...base, debugLogging: true });
    await loadAndApplyDebugLogging();
    expect(currentDebugLogging({})).toEqual({ debug: true, source: "setting" });

    await saveConfig({ ...base, debugLogging: false });
    await loadAndApplyDebugLogging();
    expect(currentDebugLogging({}).debug).toBe(false);

    // No config at all (a fresh home) is nothing stored, not a failed boot.
    newHome();
    await loadAndApplyDebugLogging();
    expect(currentDebugLogging({})).toEqual({ debug: false, source: "default" });
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
