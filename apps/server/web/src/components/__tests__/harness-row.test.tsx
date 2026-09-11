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
  envOverride: "PI_PATH",
  description: "minimal coding agent from pi.dev",
  installed: true,
  installedHere: true,
  install: { command: "npm i -g @mariozechner/pi", docsUrl: "https://pi.dev" },
};

const noop = () => {};

describe("HarnessRow", () => {
  afterEach(cleanup);

  it("renders name, status text and the labeled switch for a plugin that is ready", () => {
    render(<HarnessRow harness={base} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.getByText("ready", { exact: true })).toBeDefined();
    expect(screen.getByRole("switch", { name: "pi added to this host" })).toBeDefined();
  });

  // The setup wizard's e2e locates this row by role=group/name and filters on
  // the description text — both are load-bearing anchors, so pin them here
  // rather than letting a refactor break only the browser suite.
  it("is a named group carrying the description (e2e anchors)", () => {
    render(<HarnessRow harness={base} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.getByRole("group", { name: "pi" })).toBeDefined();
    expect(screen.getByText("minimal coding agent from pi.dev")).toBeDefined();
  });

  it("a harness whose program is missing still offers the switch, plus install help", () => {
    const calls: [string, boolean][] = [];
    render(
      <HarnessRow
        harness={{ ...base, installed: false }}
        pending={false}
        onToggle={(id, enabled) => calls.push([id, enabled])}
        onRecheck={noop}
      />,
    );
    // The switch is present even though the program is missing: adding the
    // plugin and having its CLI are independent facts now, so the row lets
    // you add it and then tells you to install the program.
    expect(screen.getByText("program not found", { exact: true })).toBeDefined();
    const toggle = screen.getByRole("switch", { name: "pi added to this host" });
    fireEvent.click(toggle);
    // Already added in the fixture, so clicking removes it.
    expect(calls).toEqual([["pi", false]]);
  });

  it("a plugin this host has not added explains the consequence", () => {
    render(<HarnessRow harness={{ ...base, installedHere: false }} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.getByText(/Its profiles are hidden/)).toBeDefined();
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

  it("names the env override instead of offering an install command", () => {
    // The fixture is the `pi` harness, whose override is PI_PATH — now carried
    // on HarnessInfo, not derived from the binary name.
    render(
      <HarnessRow
        harness={{ ...base, installed: false, reason: "override-invalid" }}
        pending={false}
        onToggle={noop}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText(/PI_PATH/)).toBeDefined();
    // An install command here would be wrong advice: the binary may be present.
    expect(screen.queryByText(/@mariozechner\/pi/)).toBeNull();
  });

  it("still offers the install command when the binary is simply absent", () => {
    render(
      <HarnessRow
        harness={{ ...base, installed: false, reason: "not-on-path" }}
        pending={false}
        onToggle={noop}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText(/@mariozechner\/pi/)).toBeDefined();
  });

  it("shows when detection last ran", () => {
    render(
      <HarnessRow
        harness={{ ...base, checkedAt: new Date().toISOString() }}
        pending={false}
        onToggle={noop}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText(/^checked /)).toBeDefined();
  });

  it("says nothing about checking when the node reported no stamp", () => {
    // Absence is no probe having produced a stamp, not "checked never".
    render(<HarnessRow harness={base} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.queryByText(/^checked /)).toBeNull();
  });
});
