import { describe, expect, it } from "bun:test";
import { tmuxInstallHint } from "@/lib/tmux-install";

describe("tmuxInstallHint", () => {
  it("offers Homebrew on macOS, with no privilege needed", () => {
    // The one platform where the server can run the installer itself: brew
    // takes no password, so the wizard's Install button exists here and
    // nowhere else.
    const hint = tmuxInstallHint("darwin");
    expect(hint?.command).toBe("brew install tmux");
    expect(hint?.label).toBe("Homebrew");
    expect(hint?.needsPrivilege).toBe(false);
    expect(hint?.alternatives).toEqual([]);
  });

  it("names apt-get first on Linux and dnf as the alternative, both privileged", () => {
    // Which package manager a Linux box has is not knowable from the browser,
    // so both are stated. The order mirrors `chooseTmuxInstaller`'s own
    // apt-get-then-dnf probe, so what the server would pick leads.
    const hint = tmuxInstallHint("linux");
    expect(hint?.command).toBe("sudo apt-get install -y tmux");
    expect(hint?.label).toBe("apt-get");
    expect(hint?.alternatives).toEqual(["sudo dnf install -y tmux"]);
  });

  it("marks every Linux command as needing a privilege the server cannot supply", () => {
    // This is the field the Install button is gated on, and it has to agree
    // with the route's own `sudo` refusal: offering a button for a command the
    // server answers 409 to would ship a control that always fails.
    const hint = tmuxInstallHint("linux");
    expect(hint?.needsPrivilege).toBe(true);
    for (const command of [hint?.command, ...(hint?.alternatives ?? [])]) {
      expect(command?.startsWith("sudo ")).toBe(true);
    }
  });

  it("answers null for a platform with no known package manager", () => {
    // An unknown host is a hint, not a guess — the same rule the CLI's table
    // follows. The row falls back to "install it yourself and re-check".
    expect(tmuxInstallHint("win32")).toBeNull();
    expect(tmuxInstallHint("")).toBeNull();
  });
});
