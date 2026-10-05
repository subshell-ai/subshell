import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SshPaneChrome } from "@/components/ssh/ssh-pane-chrome";
import type { SshTerminalFacts } from "@/lib/ssh-terminal-facts";

/**
 * The managed SSH pane's chrome: the trusted destination line (assembled
 * from the open-time facts, never from pane output), the honest
 * input-control state, the takeover/return button that flips toward the
 * other side, and the node-offline copy that stays DISTINCT from
 * destination/auth wording (spec §3: "Show connecting-node unavailability
 * separately from destination/authentication errors").
 */

const FACTS: SshTerminalFacts = {
  subshellId: "p-ssh",
  connectionId: "c1",
  displayName: "Staging",
  destination: "deploy@app-02.example.net",
  nodeId: "n1",
  nodeLabel: "Laptop",
  controlOwner: "agent",
  controlGeneration: 3,
};

afterEach(cleanup);

describe("SshPaneChrome", () => {
  it("shows the trusted route and offers Take over while the agent holds input", () => {
    const seen: string[] = [];
    render(<SshPaneChrome facts={FACTS} nodeOffline={false} busy={false} onControl={(m) => seen.push(m)} />);
    expect(screen.getByText(/deploy@app-02\.example\.net/)).toBeDefined();
    expect(screen.getByText(/via Laptop/)).toBeDefined();
    expect(screen.getByText("Agent has input")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(seen).toEqual(["human"]);
  });

  it("offers Return to agent when the human holds input, and names the honesty clause", () => {
    const seen: string[] = [];
    render(
      <SshPaneChrome
        facts={{ ...FACTS, controlOwner: "human" }}
        nodeOffline={false}
        busy={false}
        onControl={(m) => seen.push(m)}
      />,
    );
    expect(screen.getByText("You have input")).toBeDefined();
    const back = screen.getByRole("button", { name: "Return to agent" });
    expect(back.getAttribute("title")).toContain("stays visible");
    fireEvent.click(back);
    expect(seen).toEqual(["agent"]);
  });

  it("says the connecting node is offline instead of anything about auth", () => {
    render(<SshPaneChrome facts={FACTS} nodeOffline busy={false} onControl={() => {}} />);
    expect(screen.getByText(/connecting node is offline/)).toBeDefined();
    // No input-state line: the state is unactionable while the node is away.
    expect(screen.queryByText("Agent has input")).toBeNull();
    expect(screen.queryByText("You have input")).toBeNull();
  });
});
