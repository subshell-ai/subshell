import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type LaunchPick, LaunchStep } from "@/components/connect/launch-step";
import type { SshRuntimeHarnessEntry, SshRuntimeSessionView } from "@/lib/ssh-runtime";
import type { PresetRow } from "@/types/preset";

/**
 * The launch seam (design 2026-10-05 §7, wave-2 review M2). What the step
 * exists to prove: the terminal row is never held hostage by the detect round
 * trip (a failed check still leaves the shell), the harness and preset rows
 * come ONLY from the detected mirror, and each row's pick carries the right
 * arguments upstream.
 */

const SESSION: SshRuntimeSessionView = {
  id: "s1",
  connectingNodeId: "n1",
  runtimeNodeId: "r1",
  alias: "staging",
  host: "app-02",
  port: 22,
  user: "deploy",
  status: "active",
  hello: null,
  createdAt: new Date().toISOString(),
  lastSeenAt: null,
  closedAt: null,
};

function harness(over: Partial<SshRuntimeHarnessEntry> & { harnessId: string }): SshRuntimeHarnessEntry {
  return {
    harnessName: over.harnessId,
    installed: true,
    binaryPath: null,
    rawVersion: null,
    reason: null,
    checkedAt: null,
    ...over,
  };
}

function preset(over: Partial<PresetRow> & { id: string; harnessId: string; name: string }): PresetRow {
  return {
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    crossCommEnabled: 0,
    nodeId: null,
    workingDir: null,
    promptBlocks: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function renderStep(over: Partial<Parameters<typeof LaunchStep>[0]> = {}, onPick?: (picks: LaunchPick[]) => void) {
  const picks: LaunchPick[] = [];
  render(
    <LaunchStep
      session={SESSION}
      cwd="/srv/app"
      busy={false}
      harnesses={[]}
      presets={[]}
      detecting={false}
      detectError={false}
      onDetect={() => {}}
      onPick={(p) => {
        picks.push(p);
        onPick?.(picks);
      }}
      {...over}
    />,
  );
  return picks;
}

// Cleanup must be registered BY THIS FILE: bun test caches modules across
// files in serial mode, so RTL's auto-cleanup lands only on the first file
// that imports it, and a later file's renders would pile up in the shared
// happy-dom document (measured: /Terminal/ matched 3 rows).
afterEach(cleanup);

describe("LaunchStep", () => {
  it("a failed detect says so, keeps the terminal row, and offers the retry", () => {
    renderStep({ detectError: true });
    expect(screen.getByText(/The destination could not say which agents it has installed\./)).toBeTruthy();
    // The sentence that follows is the honesty half: the shell still works.
    expect(screen.getByText(/The terminal still opens/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Terminal/ })).toBeTruthy();
    expect(screen.queryByText("Claude")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check installed agents" }));
    // (no throw, and the button exists: re-ask is wired)
  });

  it("a quiet mirror shows no detect sentence", () => {
    renderStep();
    expect(screen.queryByText(/could not say which agents/)).toBeNull();
  });

  it("only installed non-terminal harnesses become rows, and picks name the harness", () => {
    const picks = renderStep({
      harnesses: [
        harness({ harnessId: "claude", harnessName: "Claude", rawVersion: "2.1.0" }),
        harness({ harnessId: "terminal", harnessName: "Terminal" }),
        harness({ harnessId: "opencode", harnessName: "OpenCode", installed: false }),
      ],
    });
    expect(screen.getByRole("button", { name: /Claude/ })).toBeTruthy();
    // The terminal harness rides its own row above, never a second one below.
    expect(screen.getAllByRole("button", { name: /Terminal/ }).length).toBe(1);
    // Not installed on the destination: no row that would only fail.
    expect(screen.queryByRole("button", { name: /OpenCode/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    expect(picks.at(-1)).toEqual({ kind: "harness", harnessId: "claude" });
    expect(screen.getByText("2.1.0 on this destination.")).toBeTruthy();
  });

  it("a preset becomes a row only when its harness detected installed here", () => {
    const picks = renderStep({
      harnesses: [harness({ harnessId: "claude", harnessName: "Claude" })],
      presets: [
        preset({ id: "p1", harnessId: "claude", name: "Work" }),
        preset({ id: "p2", harnessId: "opencode", name: "Absence" }),
      ],
    });
    expect(screen.getByRole("button", { name: /Work/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Absence/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Work/ }));
    expect(picks.at(-1)).toEqual({ kind: "preset", harnessId: "claude", presetId: "p1" });
  });
});
