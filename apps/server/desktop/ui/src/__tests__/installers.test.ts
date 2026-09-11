import { describe, expect, it } from "bun:test";
import { agentInstallPlan, tmuxInstallPlan } from "../lib/installers";

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

describe("agentInstallPlan", () => {
  it("offers Claude Code as the default agent", () => {
    expect(agentInstallPlan("claude-code")).toMatchObject({
      command: ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    });
  });

  it("refuses an id it does not ship, rather than running a string it was handed", () => {
    // Only built-ins may be auto-run. A third-party plugin's install command
    // stays copy-to-clipboard: the console runs in the user's desktop session
    // rather than the plugin host, and a second execution path with different
    // trust properties is not worth it for a case nobody has asked for.
    // (The ENFORCEMENT copy is `AGENT_INSTALLS` in control.rs; the Rust test
    // `the_console_install_table_and_the_rust_one_agree` holds this map to contain
    // that one, so half-revocation fails CI.)
    expect(agentInstallPlan("acme-harness")).toBeNull();
    // And the inherited-object ids are no loophole.
    expect(agentInstallPlan("constructor")).toBeNull();
    expect(agentInstallPlan("toString")).toBeNull();
  });
});
