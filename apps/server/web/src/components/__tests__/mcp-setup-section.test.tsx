import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { McpSetupSection } from "@/components/mcp-setup-section";

/**
 * The preset-form block that answers "how does THIS harness get cross-subshell
 * comms" — the question the UI used to leave unanswered. Auto harnesses get a
 * plain statement; manual harnesses must show their steps VERBATIM — the copy
 * is a command pasted onto the node that runs the harness (portable PATH form
 * since issue #57), and this component has no way to know how to rewrite it.
 */
describe("McpSetupSection", () => {
  afterEach(cleanup);

  it("auto harness: one quiet line, no steps", () => {
    render(<McpSetupSection mcp={{ mode: "auto", summary: "Wired in automatically (via --mcp-config)." }} />);
    expect(screen.getByText("Cross-subshell comms")).toBeDefined();
    expect(screen.getByText(/Wired in automatically/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

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
