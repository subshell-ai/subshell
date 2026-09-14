import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("offers no install help to expand — the row already says what it runs", () => {
    // The "How to install" disclosure held a copy of the same command the
    // row now states outright, which made a button and its own explanation
    // read as two alternatives. What it carried that the line does not —
    // the docs link — moved onto the line.
    render(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} />
      </ul>,
    );
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /How to install/ })).toBeNull();
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain(base.install.command);
  });

  it("still points at the docs, which the command line cannot replace", () => {
    render(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} />
      </ul>,
    );
    const docs = screen.getByRole("link", { name: /Install docs/ });
    expect(docs.getAttribute("href")).toBe(base.install.docsUrl);
  });

  it("says something useful for an agent with no install command at all", () => {
    // No button and no command, so this line is the only guidance there is.
    render(
      <ul>
        <AgentRow harness={{ ...base, install: { ...base.install, command: "" } }} onInstall={() => {}} />
      </ul>,
    );
    expect(screen.getByRole("listitem", { name: "Claude Code" }).textContent).toContain("No install command");
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

  it("shows a failed install ON the row that failed, with what the installer printed", () => {
    // It used to render under the whole LIST — a bare line plus a collapsed
    // "Installer output" — so a failure on the fourth of five agents appeared
    // at the bottom of the screen naming none of them.
    render(
      <ul>
        <AgentRow
          harness={base}
          onInstall={() => {}}
          failure={{ message: "The installer exited with code 1.", output: "curl: (6) Could not resolve host" }}
        />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("The installer exited with code 1.");
    // The output is there, behind a disclosure rather than in the reader's
    // face — but the SENTENCE saying it failed is not behind anything.
    expect(row.textContent).toContain("curl: (6) Could not resolve host");
    expect(screen.getByText("What the installer printed")).toBeTruthy();
  });

  it("omits the disclosure when the installer printed nothing", () => {
    // A network failure has a message and no output; an empty `<details>`
    // labelled "What the installer printed" would promise something it does
    // not have.
    render(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} failure={{ message: "Couldn't run the installer." }} />
      </ul>,
    );
    expect(screen.getByText("Couldn't run the installer.")).toBeTruthy();
    expect(screen.queryByText("What the installer printed")).toBeNull();
  });

  it("spins while installing, so a slow installer does not look wedged", () => {
    const { container } = render(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} installing />
      </ul>,
    );
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("says what Install will run, without a click", () => {
    // The button sat next to a disclosure containing a command to COPY, which
    // read as two alternatives rather than a button and its explanation — for
    // an act that runs a vendor's script as the server's own user.
    render(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain(base.install.command);
  });

  it("shows the installer's own line while it runs, and drops the standing notice", () => {
    const { rerender } = render(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} installing progress="==> Downloading claude" />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("==> Downloading claude");
    // Before the first line lands there is still something to read.
    rerender(
      <ul>
        <AgentRow harness={base} onInstall={() => {}} installing />
      </ul>,
    );
    expect(screen.getByRole("listitem", { name: "Claude Code" }).textContent).toContain("Starting the installer…");
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
