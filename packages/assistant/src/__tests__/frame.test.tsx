import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Frame } from "../frame";

// Same registration rail.test.tsx carries, for the same reason: one document
// per process, so an un-unmounted render leaks into the next test's queries.
// RTL's AUTO-cleanup registers its afterEach when the module is first
// evaluated, which — with the module graph shared across test files — can bind
// to whichever file imported it first rather than to this one's tests. When
// that happens, every `document.querySelectorAll`/`querySelector` here reads
// the PREVIOUS test's tree (the two failures CI showed: a stale `<p>` where 0
// were expected, and a stale frame's DIV where the rail's NAV belongs). The
// explicit hook makes this file self-sufficient whatever the runner did with
// the auto-registered one.
afterEach(cleanup);

describe("Frame", () => {
  it("renders the title as the heading", () => {
    render(
      <Frame strings={{ title: "Welcome to Subshell", subtitle: "", problem: "" }}>
        <p>content</p>
      </Frame>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome to Subshell");
    expect(screen.getByText("content")).toBeDefined();
  });

  it("renders a non-empty subtitle and the problem as a status line", () => {
    render(
      <Frame
        strings={{
          title: "Your Server Is Stopped",
          subtitle: "The service is installed but not running.",
          problem: "launchctl: 5: Operation not permitted",
        }}
      />,
    );
    expect(screen.getByText("The service is installed but not running.")).toBeDefined();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("launchctl: 5: Operation not permitted");
  });
});
