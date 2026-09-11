import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { HarnessInstallHelp } from "@/components/harness-install-help";

/**
 * The "how do I get this" block, on its own (the row's own tests live beside
 * it). What is pinned here is the override message, because its variable name
 * used to be DERIVED from the binary (`<BINARY>_PATH`), which was right only
 * while every plugin happened to follow that shape.
 */
describe("HarnessInstallHelp", () => {
  afterEach(cleanup);

  it("names the variable the plugin actually honours, not one derived from the binary", () => {
    render(
      <HarnessInstallHelp
        harness={{
          id: "terminal",
          name: "Terminal",
          binary: "bash",
          envOverride: "SHELL",
          description: "A plain shell in a subshell pane.",
          installed: false,
          reason: "override-invalid",
          installedHere: true,
          install: { command: "", docsUrl: "" },
        }}
        onRecheck={() => {}}
      />,
    );

    expect(screen.getByText(/SHELL/)).toBeTruthy();
    expect(screen.queryByText(/BASH_PATH/)).toBeNull();
  });

  it("names the COMMAND that wasn't found and offers no dead install affordances", () => {
    render(
      <HarnessInstallHelp
        harness={{
          id: "terminal",
          name: "Terminal",
          binary: "bash",
          envOverride: "SHELL",
          description: "A plain shell in a subshell pane.",
          installed: false,
          reason: "not-on-path",
          installedHere: true,
          install: { command: "", docsUrl: "" },
        }}
        onRecheck={() => {}}
      />,
    );

    // `bash`, the command, not `terminal`, the plugin id.
    expect(screen.getByText(/bash/)).toBeTruthy();
    expect(screen.queryByText(/terminal command/)).toBeNull();
    // No install block: an empty copy box and a docs link to the current page
    // are affordances that lead nowhere.
    expect(screen.queryByText("Copy")).toBeNull();
    expect(screen.queryByText(/Install docs/)).toBeNull();
    // The re-check, which is the one action that can actually help, stays.
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
  });
});
