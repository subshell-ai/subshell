import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { McpSetupSection } from "@/components/mcp-setup-section";

/**
 * The preset-form block for a MANUAL harness — the one that answers "how does
 * THIS harness get cross-subshell comms" with steps to run. Auto harnesses
 * render no block at all (2026-09-30: their "wires itself" line duplicated the
 * new Cross-subshell comms switch and asked for no act), so the component's
 * prop type is manual-only and this suite is its whole contract: steps render
 * VERBATIM — the copy is a command pasted onto the node that runs the harness
 * (portable PATH form since issue #57), and this component has no way to know
 * how to rewrite it.
 */
describe("McpSetupSection", () => {
  afterEach(cleanup);

  it("manual harness: renders every step label + command with a copy button", () => {
    render(
      <McpSetupSection
        mcp={{
          mode: "manual",
          steps: [
            { label: "Register subshell once:", command: "hermes mcp add subshell --command 'bun'" },
            { label: "Remove later with:", command: "hermes mcp remove subshell" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/no per-subshell config/)).toBeDefined();
    expect(screen.getByText("Register subshell once:")).toBeDefined();
    expect(screen.getByText("hermes mcp add subshell --command 'bun'")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBe(2);
  });
});
