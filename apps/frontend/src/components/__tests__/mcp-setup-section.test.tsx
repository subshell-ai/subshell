import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { McpSetupSection } from "@/components/mcp-setup-section";

/**
 * The profile-form block that answers "how does THIS harness get cross-session
 * comms" — the question the UI used to leave unanswered. Auto harnesses get a
 * plain statement; manual harnesses must show their steps VERBATIM so the
 * operator can copy the exact command the backend resolved.
 */
describe("McpSetupSection", () => {
  afterEach(cleanup);

  it("auto harness: one quiet line, no steps", () => {
    render(<McpSetupSection mcp={{ mode: "auto", summary: "Wired in automatically (via --mcp-config)." }} />);
    expect(screen.getByText("Cross-session comms")).toBeDefined();
    expect(screen.getByText(/Wired in automatically/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("manual harness: renders every step label + command with a copy button", () => {
    render(
      <McpSetupSection
        mcp={{
          mode: "manual",
          steps: [
            { label: "Register mote once:", command: "hermes mcp add mote --command 'bun'" },
            { label: "Remove later with:", command: "hermes mcp remove mote" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/no per-session config/)).toBeDefined();
    expect(screen.getByText("Register mote once:")).toBeDefined();
    expect(screen.getByText("hermes mcp add mote --command 'bun'")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBe(2);
  });
});
