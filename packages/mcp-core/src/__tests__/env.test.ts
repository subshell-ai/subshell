import { describe, expect, it } from "bun:test";
import { readMcpEnv, resolveMcpDataDir } from "../env.js";

/**
 * The pane-env contract, including the runtime-pane half (task 25,
 * design 2026-10-05 §5): with a callback door the pane carries NO key by
 * design (the plane executes callbacks as the pane from the door's
 * attribution); without one, the key is as required as it has ever been.
 */
describe("readMcpEnv", () => {
  it("requires the key exactly as before when no door is set", () => {
    expect(() => readMcpEnv({ SUBSHELL_ID: "s1" } as NodeJS.ProcessEnv)).toThrow("SUBSHELL_API_KEY");
    const full = readMcpEnv({ SUBSHELL_ID: "s1", SUBSHELL_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(full.callbackSock).toBeNull();
    expect(full.apiKey).toBe("k");
    expect(full.baseUrl).toBe("http://127.0.0.1:3080");
  });

  it("accepts a keyless pane when the runtime callback door is named", () => {
    const pane = readMcpEnv({
      SUBSHELL_ID: "s1",
      SUBSHELL_RUNTIME_CALLBACK_SOCK: "/srv/runtime/callbacks/s1.sock",
      SUBSHELL_BASE_URL: "http://subshell-callback.invalid",
    } as NodeJS.ProcessEnv);
    expect(pane.callbackSock).toBe("/srv/runtime/callbacks/s1.sock");
    expect(pane.apiKey).toBe(""); // empty, not undefined: the caller branches on the door
    expect(pane.baseUrl).toBe("http://subshell-callback.invalid");
  });

  it("a whitespace-only door is no door (the key requirement stands)", () => {
    expect(() => readMcpEnv({ SUBSHELL_ID: "s1", SUBSHELL_RUNTIME_CALLBACK_SOCK: "  " } as NodeJS.ProcessEnv)).toThrow(
      "SUBSHELL_API_KEY",
    );
  });

  it("a RELATIVE door is refused-as-unset, loudly, not resolved against the cwd (N-3)", () => {
    const notes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      notes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Keyless: the door cannot stand in for a key it never was.
      expect(() =>
        readMcpEnv({ SUBSHELL_ID: "s1", SUBSHELL_RUNTIME_CALLBACK_SOCK: "callbacks/s1.sock" } as NodeJS.ProcessEnv),
      ).toThrow("SUBSHELL_API_KEY");
      // With a key: the ordinary key-mode read, the door absent, and the
      // stderr note names why the door was dropped.
      const pane = readMcpEnv({
        SUBSHELL_ID: "s1",
        SUBSHELL_API_KEY: "k",
        SUBSHELL_RUNTIME_CALLBACK_SOCK: "callbacks/s1.sock",
      } as NodeJS.ProcessEnv);
      expect(pane.callbackSock).toBeNull();
      expect(pane.apiKey).toBe("k");
      expect(notes.join("")).toContain("not an absolute path");
    } finally {
      process.stderr.write = orig;
    }
    // The absolute spelling still doors (the pair the review asked to pin).
    const ok = readMcpEnv({
      SUBSHELL_ID: "s1",
      SUBSHELL_RUNTIME_CALLBACK_SOCK: "/srv/cb/s1.sock",
    } as NodeJS.ProcessEnv);
    expect(ok.callbackSock).toBe("/srv/cb/s1.sock");
  });

  it("still requires the id in either mode", () => {
    expect(() =>
      readMcpEnv({ SUBSHELL_RUNTIME_CALLBACK_SOCK: "/s", SUBSHELL_API_KEY: "k" } as NodeJS.ProcessEnv),
    ).toThrow("SUBSHELL_ID");
  });
});

describe("resolveMcpDataDir", () => {
  it("prefers SUBSHELL_DATA_DIR, falls back to the server dir, then tmp", () => {
    expect(resolveMcpDataDir({ SUBSHELL_DATA_DIR: "/a" } as NodeJS.ProcessEnv)).toBe("/a");
    expect(resolveMcpDataDir({ SUBSHELL_SERVER_DATA_DIR: "/b" } as NodeJS.ProcessEnv)).toBe("/b");
    expect(resolveMcpDataDir({} as NodeJS.ProcessEnv)).toContain("subshell-mcp");
  });
});
