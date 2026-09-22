import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Frame } from "../frame";

describe("Frame", () => {
  it("renders the title as the heading", () => {
    render(
      <Frame strings={{ title: "Welcome to Subshell", subtitle: "", problem: "" }}>
        <p>content</p>
      </Frame>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome to Subshell");
    expect(screen.getByText("content")).toBeDefined();
  });

  it("hides the subtitle and problem when they are empty", () => {
    render(<Frame strings={{ title: "Set Up Subshell Server", subtitle: "", problem: "" }} />);
    expect(screen.queryByText("Set Up Subshell Server")).toBeDefined();
    // Only the heading carries the strings that were given; the two hidden
    // lines would otherwise render as empty paragraphs.
    expect(document.querySelectorAll("p")).toHaveLength(0);
  });

  it("renders a non-empty subtitle and the problem as a status line", () => {
    render(
      <Frame
        strings={{
          title: "Your Server Is Stopped",
          subtitle: "The service is installed but not running.",
          problem: "launchctl: 5: Operation not permitted",
        }}
      />,
    );
    expect(screen.getByText("The service is installed but not running.")).toBeDefined();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("launchctl: 5: Operation not permitted");
  });
});
