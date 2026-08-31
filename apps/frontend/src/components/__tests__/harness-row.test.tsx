import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HarnessRow } from "@/components/harness-row";
import type { HarnessInfo } from "@/types/harness";

/**
 * The one harness management row, shared by the settings page and the setup
 * wizard's Harness step. What the tests pin are the pieces e2e depends on (the
 * status text, the labeled switch for an installed harness, the Enable escape
 * hatch + install help for a not-installed one) plus the shared error line.
 */
const base: HarnessInfo = {
  id: "pi",
  name: "pi",
  binary: "pi",
  description: "minimal coding agent from pi.dev",
  installed: true,
  enabled: true,
  install: { command: "npm i -g @mariozechner/pi", docsUrl: "https://pi.dev" },
};

const noop = () => {};

describe("HarnessRow", () => {
  afterEach(cleanup);

  it("renders name, status text and the labeled switch for an installed harness", () => {
    render(<HarnessRow harness={base} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.getByText("enabled", { exact: true })).toBeDefined();
    expect(screen.getByRole("switch", { name: "pi enabled" })).toBeDefined();
  });

  // The setup wizard's e2e locates this row by role=group/name and filters on
  // the description text — both are load-bearing anchors, so pin them here
  // rather than letting a refactor break only the browser suite.
  it("is a named group carrying the description (e2e anchors)", () => {
    render(<HarnessRow harness={base} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.getByRole("group", { name: "pi" })).toBeDefined();
    expect(screen.getByText("minimal coding agent from pi.dev")).toBeDefined();
  });

  it("a not-installed harness offers Enable + install help instead of a switch", () => {
    const calls: [string, boolean][] = [];
    render(
      <HarnessRow
        harness={{ ...base, installed: false }}
        pending={false}
        onToggle={(id, enabled) => calls.push([id, enabled])}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText("not installed", { exact: true })).toBeDefined();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(calls).toEqual([["pi", true]]);
  });

  it("a disabled installed harness explains the consequence", () => {
    render(<HarnessRow harness={{ ...base, enabled: false }} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.getByText(/its profiles are hidden/)).toBeDefined();
  });

  it("shows the row's toggle error, if any", () => {
    render(
      <HarnessRow
        harness={base}
        pending={false}
        error="Could not change the harness state."
        onToggle={noop}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText("Could not change the harness state.")).toBeDefined();
  });
});
