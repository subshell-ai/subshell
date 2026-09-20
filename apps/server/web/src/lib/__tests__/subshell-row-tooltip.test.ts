import { describe, expect, it } from "bun:test";
import { subshellRowTooltip } from "@/lib/subshell-row-tooltip";
import type { SubshellView } from "@/types/subshell";

const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    name: "auth-refactor",
    workingDir: "/Users/theo/projects/auth",
    status: "running",
    alive: true,
    activity: "active",
    lastOutputAt: null,
    nodeOffline: false,
    waitingSince: null,
    ...overrides,
  }) as SubshellView;

describe("subshellRowTooltip", () => {
  it("names everything the rail cannot fit, one per line", () => {
    expect(subshellRowTooltip(probe(), "mac-mini", "Claude Code")).toBe(
      "Name: auth-refactor\nNode: mac-mini\nAgent: Claude Code\nStatus: working\nDirectory: /Users/theo/projects/auth",
    );
  });

  it("reveals the two truncated strings — name and directory are the row's own, shown in full", () => {
    // The row renders both with `block truncate`; the pre-grouping title was
    // exactly `name: workingDir` for this reason, and grouping must not
    // silently un-ship it.
    const text = subshellRowTooltip(
      probe({
        name: "a-very-long-auto-generated-pane-title",
        workingDir: "/Users/theo/projects/some/deep/nested/checkout",
      }),
      "mac-mini",
      "Claude Code",
    );
    expect(text).toContain("Name: a-very-long-auto-generated-pane-title");
    expect(text).toContain("Directory: /Users/theo/projects/some/deep/nested/checkout");
  });

  it("answers before it recites: the path sits LAST, below the three asked-for lines", () => {
    const text = subshellRowTooltip(probe(), "mac-mini", "Claude Code");
    expect(text.indexOf("Status:")).toBeLessThan(text.indexOf("Directory:"));
  });

  it("uses the SHARED indicator word, so it agrees with the dot beside it", () => {
    expect(subshellRowTooltip(probe({ waitingSince: "2026-09-20T00:00:00.000Z" }), "Server", "Codex")).toContain(
      "Status: waiting for you",
    );
    expect(subshellRowTooltip(probe({ nodeOffline: true }), "Server", "Codex")).toContain("Status: node unreachable");
    expect(subshellRowTooltip(probe({ alive: false }), "Server", "Codex")).toContain("Status: exited");
  });

  it("labels an unresolved node with the SAME fallback the header wears", () => {
    // The caller passes the group's label straight through, so the tooltip
    // never guesses a second answer to "which machine?".
    expect(subshellRowTooltip(probe(), "unknown node", "Claude Code")).toContain("Node: unknown node");
  });

  it("omits the directory line when the row has none to reveal", () => {
    expect(subshellRowTooltip(probe({ workingDir: "" }), "Server", "Claude Code")).not.toContain("Directory:");
  });
});
