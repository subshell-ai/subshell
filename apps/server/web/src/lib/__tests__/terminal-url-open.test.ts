import { describe, expect, it } from "bun:test";
import { safeOpenTerminalUri } from "@/lib/terminal-url-open";

/** Swap window.open for a recorder; bun's/happy-dom's real one is a no-op at
 * best and a console warning at worst, and what matters is the CALL. */
function recordingOpen(): { calls: [string, string, string | undefined][]; restore: () => void } {
  const original = window.open;
  const calls: [string, string, string | undefined][] = [];
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    calls.push([String(url), target ?? "", features]);
    return null;
  }) as typeof window.open;
  return {
    calls,
    restore: () => {
      window.open = original;
    },
  };
}

describe("safeOpenTerminalUri (the scheme gate for terminal-surfaced URLs)", () => {
  it("opens http and https in a blank noopener window", () => {
    const { calls, restore } = recordingOpen();
    try {
      expect(safeOpenTerminalUri("http://example.com/a?b=1")).toBe(true);
      expect(safeOpenTerminalUri("https://example.com")).toBe(true);
      expect(calls).toEqual([
        ["http://example.com/a?b=1", "_blank", "noopener"],
        ["https://example.com", "_blank", "noopener"],
      ]);
    } finally {
      restore();
    }
  });

  it("opens nothing for a non-http scheme, whatever the shape of it", () => {
    const { calls, restore } = recordingOpen();
    try {
      for (const uri of [
        "javascript:alert(1)",
        "JavaScript:alert(1)", // the scheme is case-insensitive, so the test is
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "ftp://example.com",
        "mailto:someone@example.com",
        "/relative/path",
        "example.com/no-scheme",
        "",
      ]) {
        expect(safeOpenTerminalUri(uri)).toBe(false);
      }
      expect(calls).toEqual([]);
    } finally {
      restore();
    }
  });

  it("returns false without touching window.open when the scheme fails", () => {
    // The distinction the caller depends on: refused !== opened.
    const { calls, restore } = recordingOpen();
    try {
      expect(safeOpenTerminalUri("https://x.dev")).toBe(true);
      expect(safeOpenTerminalUri("shttps://x.dev")).toBe(false); // anchored: a scheme is a prefix, never a substring
      expect(calls.length).toBe(1);
    } finally {
      restore();
    }
  });
});
