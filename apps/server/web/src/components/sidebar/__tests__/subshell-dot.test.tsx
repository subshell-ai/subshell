import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
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

describe("SubshellDot — the header's variant (2026-09-20)", () => {
  // Each case queries the document, so a leftover render would answer for it.
  afterEach(cleanup);

  it("is aria-hidden by default: in the rail the row's link text says which subshell it is", () => {
    render(<SubshellDot subshell={probe()} />);
    expect(document.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(document.querySelector('[role="img"]')).toBeNull();
  });

  it("announces the state when `accessible` — the header has nothing else carrying it", () => {
    // It replaced a badge that spelled the word out, so dropping the word
    // entirely would have removed the state from a screen reader.
    render(<SubshellDot subshell={probe({ waitingSince: "2026-09-20T00:00:00.000Z" })} accessible />);
    const dot = document.querySelector('[role="img"]');
    expect(dot?.getAttribute("aria-label")).toBe("waiting for you");
    expect(dot?.getAttribute("aria-hidden")).toBeNull();
  });

  it("carries the RAW status/alive PAIR beside the rendered indicator", () => {
    // Two different questions: the indicator is what a person should see, the
    // raw pair is what the server recorded. The e2e suite asserts liveness on
    // the PAIR — `applyDeath` stamps `alive: false` while leaving
    // `status: "running"`, so the status alone passes on a dead-on-arrival
    // pane. Neither field swings with the activity clock, which the visible
    // word does.
    render(<SubshellDot subshell={probe({ activity: "idle" })} accessible />);
    const dot = document.querySelector('[role="img"]');
    expect(dot?.getAttribute("data-status")).toBe("running");
    expect(dot?.getAttribute("data-alive")).toBe("true");
  });

  it("flips only data-alive on a dead-on-arrival row — the pair the e2e asserts on", () => {
    render(<SubshellDot subshell={probe({ alive: false })} accessible />);
    const dot = document.querySelector('[role="img"]');
    expect(dot?.getAttribute("data-status")).toBe("running");
    expect(dot?.getAttribute("data-alive")).toBe("false");
  });
});
