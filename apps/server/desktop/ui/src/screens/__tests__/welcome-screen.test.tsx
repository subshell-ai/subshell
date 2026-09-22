import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { WelcomeScreen } from "../welcome-screen";

afterEach(cleanup);

const STRINGS = {
  title: "Welcome to Subshell",
  subtitle:
    "Subshell runs agent sessions in terminal panes you can watch from any device. Let's set up the server on this machine.",
  problem: "",
};

describe("WelcomeScreen", () => {
  it("renders the greeting and the wordmark, with Continue as the only control", () => {
    render(<WelcomeScreen strings={STRINGS} disabled={false} onContinue={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome to Subshell");
    expect(screen.getByText(/Let's set up the server on this machine\./)).toBeDefined();
    // Continue is the ONLY control, and it carries weight: nothing has touched
    // the machine while the intro is up.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(document.querySelector("img")).toBeDefined();
  });

  it("steps to the act behind the greeting on Continue", () => {
    const onContinue = vi.fn();
    render(<WelcomeScreen strings={STRINGS} disabled={false} onContinue={onContinue} />);
    screen.getByRole("button", { name: "Continue" }).click();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("disables Continue while an action is in flight", () => {
    render(<WelcomeScreen strings={STRINGS} disabled onContinue={() => {}} />);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
