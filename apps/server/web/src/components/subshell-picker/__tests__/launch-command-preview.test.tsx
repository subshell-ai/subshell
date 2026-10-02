import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PresetRow } from "@/types/preset";
import { LaunchCommandPreview } from "../launch-command-preview";

afterEach(cleanup);
const preset: PresetRow = {
  id: "p1",
  harnessId: "claude-code",
  name: "Claude Sonnet",
  description: null,
  envJson: '{"ANTHROPIC_MODEL":"sonnet","ANTHROPIC_API_KEY":"secret"}',
  flagsJson: '["--model","sonnet"]',
  settingsJson: '{"permissionMode":"plan"}',
  configIsolation: 0,
  restartOnExit: 1,
  crossCommEnabled: 0,
  nodeId: null,
  workingDir: null,
  promptBlocks: null,
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};

it("identifies the source while keeping command and secrets collapsed", () => {
  render(<LaunchCommandPreview preset={preset} binary="claude" />);
  expect(screen.getByText("Claude Sonnet")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Agent command and settings" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.queryByText(/ANTHROPIC_API_KEY=/)).toBeNull();
  expect(screen.queryByText(/permissionMode/)).toBeNull();
});

it("reveals the model, arguments, agent settings and restart policy on request", () => {
  render(<LaunchCommandPreview preset={preset} binary="claude" />);
  const toggle = screen.getByRole("button", { name: "Agent command and settings" });
  fireEvent.click(toggle);
  expect(screen.getByText("ANTHROPIC_MODEL=sonnet ANTHROPIC_API_KEY=secret claude --model sonnet")).toBeTruthy();
  expect(screen.getByText('{"permissionMode":"plan"}')).toBeTruthy();
  expect(screen.getByText("Restart on exit is enabled.")).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByText(/ANTHROPIC_API_KEY=/)).toBeNull();
});

it("updates the shown command when configuration changes", () => {
  const view = render(<LaunchCommandPreview preset={preset} binary="claude" />);
  fireEvent.click(screen.getByRole("button", { name: "Agent command and settings" }));
  view.rerender(<LaunchCommandPreview binary="pi" />);
  expect(screen.getByText("pi")).toBeTruthy();
  expect(screen.queryByText("Claude Sonnet")).toBeNull();
  expect(screen.queryByText(/ANTHROPIC_MODEL/)).toBeNull();
});

it("does not invent an executable when it is not known", () => {
  render(<LaunchCommandPreview />);
  fireEvent.click(screen.getByRole("button", { name: "Agent command and settings" }));
  expect(screen.getByText("The command name will be resolved on the selected node.")).toBeTruthy();
});
