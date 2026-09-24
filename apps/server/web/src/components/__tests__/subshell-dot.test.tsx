import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { SubshellDot } from "@/components/subshell-dot";
import type { SubshellView } from "@/types/subshell";

// `access: "owner"` is the default because the bell is owner-only: the
// unseen-push cases below were written before that (final review) and the
// grantee case overrides it. A missing access would read as "not owner" and
// silently dim every bell case to no-bell.
const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    access: "owner",
    ...overrides,
  }) as SubshellView;

describe("SubshellDot", () => {
  it("maps each indicator to its fill and tooltip word", () => {
    const cases: Array<[Partial<SubshellView>, string, string]> = [
      // GREEN is the alive family since 2026-09-24: printing is full green,
      // quiet-but-running is dim green. Gray now means NOT running.
      [{ activity: "active" }, "bg-success", "working"],
      [{ activity: "idle" }, "bg-success/50", "idle"],
      [{ waitingSince: "2026-09-03T00:00:00.000Z" }, "bg-warning", "waiting for you"],
      [{ alive: false }, "bg-muted-foreground/50", "exited"],
      [{ status: "terminated", alive: false, activity: "terminated" }, "border-muted-foreground", "ended"],
      // Unreachable is RED, not amber, since 2026-09-24 — the palette's own
      // error role, deliberately the loudest fill on the dot.
      [{ nodeOffline: true }, "bg-destructive", "node unreachable"],
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

describe("SubshellDot — the working blink (2026-09-24)", () => {
  afterEach(cleanup);

  const classOfDot = () => document.querySelector('[aria-hidden="true"]')?.getAttribute("class") ?? "";

  it("the ACTIVE dot carries the blink", () => {
    render(<SubshellDot subshell={probe({ activity: "active" })} />);
    expect(classOfDot()).toContain("subshell-dot-blink");
  });

  it("nothing else blinks — the motion is the difference between working and quiet", () => {
    // Dim green already says "alive, quiet"; the blink says "printing NOW".
    // If idle blinked too, the pair would differ only by brightness again.
    for (const overrides of [
      { activity: "idle" },
      { waitingSince: "2026-09-24T00:00:00.000Z" },
      { alive: false },
      { nodeOffline: true },
      { unseenPush: true, activity: "active" }, // the bell stays still
    ] satisfies Partial<SubshellView>[]) {
      const { unmount } = render(<SubshellDot subshell={probe(overrides)} />);
      expect(classOfDot()).not.toContain("subshell-dot-blink");
      expect(document.querySelector("svg")?.getAttribute("class") ?? "").not.toContain("subshell-dot-blink");
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

describe("SubshellDot — the unseen-notification bell (spec 2026-09-23)", () => {
  afterEach(cleanup);

  it("swaps the dot for a bell while a push goes unseen, raw pair intact", () => {
    render(<SubshellDot subshell={probe({ unseenPush: true, waitingSince: "2026-09-23T00:00:00.000Z" })} accessible />);
    const el = document.querySelector('[role="img"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    expect(el?.getAttribute("aria-label")).toBe("unseen notification (waiting for you)");
    expect(el?.getAttribute("data-status")).toBe("running");
    expect(el?.getAttribute("data-alive")).toBe("true");
  });

  it("keeps the indicator's tone on the bell", () => {
    render(<SubshellDot subshell={probe({ unseenPush: true })} />);
    expect(document.querySelector("svg")?.getAttribute("class") ?? "").toContain("text-success");
  });

  it("no bell, no glyph — the dot stays when nothing is unseen", () => {
    render(<SubshellDot subshell={probe()} />);
    expect(document.querySelector("svg")).toBeNull();
  });

  it("the bell is owner-only — a grantee sees the dot, never an unclearable mark", () => {
    // Every server-side clear (pane open, log tail, attach) requires the
    // OWNER's cookie, so `unseenPush` on a shared row is owner notification
    // state; rendered as a bell it would mark a pane this viewer can never
    // clear (final review, spec 2026-09-23). The dot — the shared state —
    // stays.
    render(<SubshellDot subshell={probe({ unseenPush: true, access: "view" })} />);
    expect(document.querySelector("svg")).toBeNull();
    const dot = document.querySelector('[aria-hidden="true"]');
    expect(dot?.getAttribute("class") ?? "").toContain("bg-success");
  });

  it("`edit` is a grantee too — same dot, same silence", () => {
    render(<SubshellDot subshell={probe({ unseenPush: true, access: "edit" })} />);
    expect(document.querySelector("svg")).toBeNull();
  });
});
