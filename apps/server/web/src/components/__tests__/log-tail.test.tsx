import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { LogTail } from "@/components/log-tail";

describe("LogTail", () => {
  afterEach(cleanup);

  it("shows the tail lines joined by newlines", () => {
    render(<LogTail lines={["first", "boom"]} />);
    // getByText's normalizer collapses whitespace, so match the raw pre.
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe("first\nboom");
  });

  it("appends the labeled exit code to the headline", () => {
    render(<LogTail lines={["x"]} exitCode={1} />);
    expect(screen.getByText(/Subshell exited \(code 1 — error doing work\)/)).toBeDefined();
  });

  it("renders the no-output line with a bare code when the log is empty", () => {
    render(<LogTail lines={[]} exitCode={7} />);
    expect(screen.getByText("Exited before producing any output (code 7).")).toBeDefined();
  });

  it("notes truncation above the tail", () => {
    render(<LogTail lines={["a", "b", "c"]} truncated />);
    expect(screen.getByText("earlier output omitted — showing the last 3 lines")).toBeDefined();
  });

  it("renders caller actions beside the headline", () => {
    render(
      <LogTail lines={[]}>
        <button type="button">Restart</button>
      </LogTail>,
    );
    expect(screen.getByRole("button", { name: "Restart" })).toBeDefined();
  });
});
