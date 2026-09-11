import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetupAssistant } from "@/components/setup/setup-assistant";

afterEach(cleanup);
const dots = { total: 3, done: 0, current: 0 };

describe("SetupAssistant", () => {
  it("renders title, subtitle, and the primary with its label", () => {
    render(
      <SetupAssistant
        illustration={<span />}
        title="Create Your Account"
        subtitle="Admin."
        dots={dots}
        primary={{ label: "Create Account", onClick: () => {} }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Create Your Account" })).toBeTruthy();
    expect(screen.getByText("Admin.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
  it("shows Back and Skip when given, and a pending label while pending", () => {
    render(
      <SetupAssistant
        illustration={<span />}
        title="T"
        dots={dots}
        back={{ onClick: () => {} }}
        skip={{ label: "Skip", onClick: () => {} }}
        primary={{ label: "Start", onClick: () => {}, pending: true, pendingLabel: "Starting…" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });
  it("Enter activates an enabled primary, not a disabled one", () => {
    const onClick = mock(() => {});
    const { rerender } = render(
      <SetupAssistant illustration={<span />} title="T" dots={dots} primary={{ label: "Continue", onClick }} />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <SetupAssistant
        illustration={<span />}
        title="T"
        dots={dots}
        primary={{ label: "Continue", onClick, disabled: true }}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("shows the reason beside a disabled primary", () => {
    render(
      <SetupAssistant
        illustration={<span />}
        title="T"
        dots={dots}
        reason="Waiting for tmux"
        primary={{ label: "Set Up", onClick: () => {}, disabled: true }}
      />,
    );
    expect(screen.getByText("Waiting for tmux")).toBeTruthy();
  });
});
