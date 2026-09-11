import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentRow } from "@/components/setup/agent-row";
import type { HarnessInfo } from "@/types/harness";

afterEach(cleanup);
const base: HarnessInfo = {
  id: "claude-code",
  type: "agent-harness",
  name: "Claude Code",
  binary: "claude",
  envOverride: "CLAUDE_PATH",
  description: "Anthropic's coding agent",
  icon: "🤖",
  installed: false,
  reason: "not-on-path",
  installedHere: true,
  install: {
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://code.claude.com/docs/en/setup",
  },
};

describe("AgentRow", () => {
  it("is a list item named by the agent, with Detected and the version when found", () => {
    render(
      <ul>
        <AgentRow harness={{ ...base, installed: true, version: "1.2.3", reason: undefined }} />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("Detected");
    expect(row.textContent).toContain("v1.2.3");
    expect(row.querySelector("[role=switch], input[type=checkbox]")).toBeNull();
  });

  it("collapses install help until asked for", () => {
    render(
      <ul>
        <AgentRow harness={base} />
      </ul>,
    );
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.queryByText(base.install.command)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /How to install/ }));
    expect(screen.getByText(base.install.command)).toBeTruthy();
  });

  it("names the override variable when it is the problem", () => {
    render(
      <ul>
        <AgentRow harness={{ ...base, reason: "override-invalid" }} />
      </ul>,
    );
    expect(screen.getByText("Check CLAUDE_PATH")).toBeTruthy();
  });

  it("offers Install only with a handler, and says Installing while it runs", () => {
    const { rerender } = render(
      <ul>
        <AgentRow harness={base} />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    rerender(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} installing />
      </ul>,
    );
    expect((screen.getByRole("button", { name: "Installing…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never offers Install for a harness with nothing to install, even with a handler", () => {
    // Mirrors HarnessInstallHelp's predicate: the server 400s an id whose
    // install.command is empty. Latent today (every built-in agent harness
    // ships a command), but this is what keeps a future command-less one
    // from shipping a button that always fails.
    render(
      <ul>
        <AgentRow harness={{ ...base, install: { ...base.install, command: "" } }} onInstall={() => {}} />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});
