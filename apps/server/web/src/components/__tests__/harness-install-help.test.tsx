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
});
