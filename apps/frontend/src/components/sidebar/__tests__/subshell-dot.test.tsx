import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { SubshellDot } from "@/components/sidebar/SubshellDot";
import type { SubshellView } from "@/types/subshell";

const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    ...overrides,
  }) as SubshellView;

describe("SubshellDot", () => {
  it("maps each indicator to its fill and tooltip word", () => {
    const cases: Array<[Partial<SubshellView>, string, string]> = [
      [{ activity: "active" }, "bg-success", "working"],
      [{ activity: "idle" }, "bg-muted-foreground", "idle"],
      [{ waitingSince: "2026-09-03T00:00:00.000Z" }, "bg-warning", "waiting for you"],
      [{ alive: false }, "bg-muted-foreground/50", "exited"],
      [{ status: "terminated", alive: false, activity: "terminated" }, "border-muted-foreground", "ended"],
      [{ nodeOffline: true }, "bg-orange-500", "node unreachable"],
    ];
    for (const [overrides, fill, label] of cases) {
      const { unmount } = render(<SubshellDot subshell={probe(overrides)} />);
      const dot = document.querySelector('[aria-hidden="true"]');
      expect(dot?.getAttribute("class") ?? "").toContain(fill);
      expect(dot?.getAttribute("title")).toBe(label);
      unmount();
    }
  });
});
