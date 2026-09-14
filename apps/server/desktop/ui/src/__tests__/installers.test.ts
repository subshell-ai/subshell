import { describe, expect, it } from "bun:test";
import { manualTmuxRoutes, tmuxInstallPlan } from "../lib/installers";

describe("tmuxInstallPlan", () => {
  it("uses Homebrew on macOS when it is there", () => {
    expect(tmuxInstallPlan("darwin", true)).toMatchObject({ kind: "run", command: ["brew", "install", "tmux"] });
  });

  it("does not offer a button it cannot honour on a Mac without Homebrew", () => {
    // The user who downloads a GUI app is exactly the user with no Homebrew,
    // so this branch is the common one, not the edge case. A disabled button
    // teaches people to ignore buttons; a real alternative does not.
    const plan = tmuxInstallPlan("darwin", false);
    expect(plan.kind).toBe("manual");
    expect(plan.command).toEqual(["sudo", "port", "install", "tmux"]);
    expect(plan.docsUrl).toBe("https://formulae.brew.sh/formula/tmux");
  });

  it("elevates through pkexec on Linux, so the desktop prompts for a password", () => {
    expect(tmuxInstallPlan("linux", false)).toMatchObject({ kind: "run" });
    expect(tmuxInstallPlan("linux", false).command[0]).toBe("pkexec");
  });

  it("shows nothing installable on a platform with nothing installable", () => {
    // Reachable from `dev:app` on an unsupported OS. Putting the missing
    // binary on the line AS the fix ("tmux") invites someone to install a
    // program by running it; an empty command means the warning shows only
    // the reading link.
    const plan = tmuxInstallPlan("win32", false);
    expect(plan.kind).toBe("manual");
    expect(plan.command).toEqual([]);
    expect(plan.docsUrl).toBeTruthy();
  });
});

describe("manualTmuxRoutes", () => {
  it("offers Homebrew first, then MacPorts, on a Mac with no package manager", () => {
    expect(manualTmuxRoutes("darwin").map((r) => r.name)).toEqual(["Homebrew", "MacPorts"]);
  });

  // The tmux line is shown only once a manager's button is pressed. The line
  // that installs the MANAGER is never carried here at all — that is the
  // `curl … | bash` nobody should take from a window's say-so.
  it("carries the one line that installs tmux, and never one that installs a manager", () => {
    for (const route of manualTmuxRoutes("darwin")) {
      expect(Object.keys(route).sort()).toEqual(["command", "name", "target"]);
      expect(route.command).toContain("tmux");
      expect(route.command).not.toContain("curl");
    }
  });

  it("names each manager's own install line", () => {
    expect(manualTmuxRoutes("darwin").map((r) => r.command)).toEqual(["brew install tmux", "sudo port install tmux"]);
  });

  it("names members of the app's closed URL set, never URLs", () => {
    expect(manualTmuxRoutes("darwin").map((r) => r.target)).toEqual(["homebrew", "macports"]);
  });

  it("invents nothing for platforms this app does not ship to", () => {
    expect(manualTmuxRoutes("linux")).toEqual([]);
    expect(manualTmuxRoutes("freebsd")).toEqual([]);
  });
});
