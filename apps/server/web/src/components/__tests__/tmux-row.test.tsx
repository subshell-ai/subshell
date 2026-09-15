import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TmuxRow } from "@/components/setup/tmux-row";

afterEach(cleanup);

describe("TmuxRow", () => {
  it("renders nothing until detection has answered", () => {
    // The status read is in flight for a moment after the account is created.
    // Rendering "tmux is missing" during it would accuse a correct host of a
    // defect, and then take the accusation back.
    const { container } = render(
      <ul>
        <TmuxRow tmuxPath={undefined} os="darwin" />
      </ul>,
    );
    expect(container.querySelector("li")).toBeNull();
  });

  it("is a settled fact when tmux is found — no command, no button", () => {
    render(
      <ul>
        <TmuxRow tmuxPath="/opt/homebrew/bin/tmux" os="darwin" onInstall={() => {}} />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("Detected");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(row.textContent).not.toContain("brew install tmux");
  });

  it("says what a missing tmux costs, and offers Install on macOS", () => {
    // brew needs no password, so this is the one platform where the server can
    // run the installer itself.
    let installs = 0;
    render(
      <ul>
        <TmuxRow tmuxPath={null} os="darwin" onInstall={() => (installs += 1)} />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("Not found");
    expect(row.textContent).toContain("Subshells cannot launch on this machine");
    expect(row.textContent).toContain("brew install tmux");
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(installs).toBe(1);
  });

  it("shows the Linux command but NEVER an Install button", () => {
    // The load-bearing half of spec 2026-09-15 § 6 on this side: the Linux
    // installers are `sudo`-prefixed and the route refuses them, because the
    // server has no terminal to answer a password prompt. A button here would
    // be a control that always 409s.
    render(
      <ul>
        <TmuxRow tmuxPath={null} os="linux" onInstall={() => {}} />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("sudo apt-get install -y tmux");
    expect(row.textContent).toContain("sudo dnf install -y tmux");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("falls back to plain guidance on a platform with no known package manager", () => {
    render(
      <ul>
        <TmuxRow tmuxPath={null} os="sunos" onInstall={() => {}} />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("Subshells cannot launch on this machine");
    expect(row.textContent).toContain("Install tmux on this machine");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows the installer's own last line while it runs", () => {
    render(
      <ul>
        <TmuxRow tmuxPath={null} os="darwin" onInstall={() => {}} installing progress="==> Pouring tmux" />
      </ul>,
    );
    expect(screen.getByText("==> Pouring tmux")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Installing/ }).hasAttribute("disabled")).toBe(true);
  });

  it("renders a failed run on the row that failed, with what the installer printed", () => {
    render(
      <ul>
        <TmuxRow
          tmuxPath={null}
          os="darwin"
          onInstall={() => {}}
          failure={{ message: "The installer exited with code 1.", output: "Error: no such formula" }}
        />
      </ul>,
    );
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("The installer exited with code 1.");
    expect(row.textContent).toContain("Error: no such formula");
  });
});
