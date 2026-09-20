import { describe, expect, it } from "bun:test";
import { subshellRowTooltip } from "@/lib/subshell-row-tooltip";
import type { SubshellView } from "@/types/subshell";

const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    status: "running",
    alive: true,
    activity: "active",
    lastOutputAt: null,
    nodeOffline: false,
    waitingSince: null,
    ...overrides,
  }) as SubshellView;

describe("subshellRowTooltip", () => {
  it("names the node, the agent and the state, one per line", () => {
    expect(subshellRowTooltip(probe(), "mac-mini", "Claude Code")).toBe(
      "Node: mac-mini\nAgent: Claude Code\nStatus: working",
    );
  });

  it("uses the SHARED indicator word, so it agrees with the dot beside it", () => {
    expect(subshellRowTooltip(probe({ waitingSince: "2026-09-20T00:00:00.000Z" }), "Server", "Codex")).toContain(
      "Status: waiting for you",
    );
    expect(subshellRowTooltip(probe({ nodeOffline: true }), "Server", "Codex")).toContain("Status: node unreachable");
    expect(subshellRowTooltip(probe({ alive: false }), "Server", "Codex")).toContain("Status: exited");
  });

  it("omits the node line rather than guessing when the label is unresolved", () => {
    const text = subshellRowTooltip(probe(), undefined, "Claude Code");
    expect(text).toBe("Agent: Claude Code\nStatus: working");
  });

  it("leaves the working directory out — the row already renders it", () => {
    expect(subshellRowTooltip(probe({ workingDir: "/Users/theo" }), "Server", "Claude Code")).not.toContain(
      "/Users/theo",
    );
  });
});
