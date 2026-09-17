import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TmuxStep } from "@/components/setup/tmux-step";

afterEach(cleanup);

/** The step body, unwrapped — it is not an `<li>` anymore, and that is the point. */
function renderStep(props: Parameters<typeof TmuxStep>[0]) {
  render(<TmuxStep {...props} />);
  return screen.getByRole("group", { name: "tmux" });
}

describe("TmuxStep", () => {
  it("says it is checking until detection has answered — and never says absent", () => {
    // The status read is in flight for a moment after the account is created.
    // Rendering "Not found" during it would accuse a correct host of a
    // defect, and then take the accusation back. As a row this case rendered
    // nothing; as a whole screen, nothing reads as a broken page, so it says
    // what it is doing — no labelled group yet, because there is no verdict
    // to group.
    render(<TmuxStep tmuxPath={undefined} os="darwin" />);
    expect(screen.getByText("Checking this machine…")).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
    expect(screen.queryByRole("group", { name: "tmux" })).toBeNull();
  });

  it("is a settled fact when tmux is found — the path, a tick, nothing to press", () => {
    renderStep({ tmuxPath: "/opt/homebrew/bin/tmux", os: "darwin", onInstall: () => {} });
    const step = screen.getByRole("group", { name: "tmux" });
    expect(step.textContent).toContain("Found at");
    expect(step.textContent).toContain("/opt/homebrew/bin/tmux");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(step.textContent).not.toContain("brew install tmux");
  });

  it("says what a missing tmux costs, and offers Install on macOS", () => {
    // brew needs no password, so this is the one platform where the server can
    // run the installer itself.
    let installs = 0;
    const step = renderStep({ tmuxPath: null, os: "darwin", onInstall: () => (installs += 1) });
    expect(step.textContent).toContain("Not found");
    expect(step.textContent).toContain("Subshells cannot launch on this machine");
    expect(step.textContent).toContain("brew install tmux");
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(installs).toBe(1);
  });

  it("shows the Linux command but NEVER an Install button", () => {
    // The load-bearing half of spec 2026-09-15 § 6 on this side: the Linux
    // installers are `sudo`-prefixed and the route refuses them, because the
    // server has no terminal to answer a password prompt. A button here would
    // be a control that always 409s.
    const step = renderStep({ tmuxPath: null, os: "linux", onInstall: () => {} });
    expect(step.textContent).toContain("sudo apt-get install -y tmux");
    expect(step.textContent).toContain("sudo dnf install -y tmux");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("falls back to plain guidance on a platform with no known package manager", () => {
    const step = renderStep({ tmuxPath: null, os: "sunos", onInstall: () => {} });
    expect(step.textContent).toContain("Subshells cannot launch on this machine");
    expect(step.textContent).toContain("Install tmux on this machine");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows the installer's own last line while it runs", () => {
    renderStep({ tmuxPath: null, os: "darwin", onInstall: () => {}, installing: true, progress: "==> Pouring tmux" });
    expect(screen.getByText("==> Pouring tmux")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Installing/ }).hasAttribute("disabled")).toBe(true);
  });

  it("renders a failed run on the screen that failed, with what the installer printed", () => {
    const step = renderStep({
      tmuxPath: null,
      os: "darwin",
      onInstall: () => {},
      failure: { message: "The installer exited with code 1.", output: "Error: no such formula" },
    });
    expect(step.textContent).toContain("The installer exited with code 1.");
    expect(step.textContent).toContain("Error: no such formula");
  });
});
