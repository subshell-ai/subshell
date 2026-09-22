/**
 * The update screen, as component tests. Every judgment is in
 * `lib/update-act.ts` (pure, and tested there); what these pin is the screen's
 * rendering of that judgment — the phases, the table, the refusals, the Force
 * box's gate, and the automatic resume's once-per-visit latch.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { AppUpdateCheck } from "../../lib/ipc";
import { NO_SELECTION, UPDATE_TITLE } from "../../lib/update-act";
import { UpdateScreen } from "../update-screen";

afterEach(cleanup);

const CHECK: AppUpdateCheck = { current: "0.12.1", latest: "0.13.0", notes: null, reason: null };
const UP_TO_DATE: AppUpdateCheck = { current: "0.12.1", latest: null, notes: null, reason: null };

function renderUpdate(over: {
  probe?: ReturnType<typeof makeProbe>;
  appUpdate?: AppUpdateCheck | null;
  state?: "idle" | "checking" | "downloading" | "installing";
  finished?: Parameters<typeof UpdateScreen>[0]["finished"];
  busy?: boolean;
  updateProgress?: string;
  resumeFired?: boolean;
  onResume?: (forced: boolean) => void;
  onCheck?: (force: boolean) => void;
  onClose?: () => void;
}) {
  return render(
    <UpdateScreen
      strings={{ title: UPDATE_TITLE, subtitle: "", problem: "" }}
      probe={over.probe ?? makeProbe()}
      appUpdate={over.appUpdate === undefined ? CHECK : over.appUpdate}
      state={over.state ?? "idle"}
      finished={over.finished ?? null}
      selection={NO_SELECTION}
      busy={over.busy ?? false}
      updateProgress={over.updateProgress ?? ""}
      resumeFired={over.resumeFired ?? false}
      onResume={over.onResume ?? (() => {})}
      onCheck={over.onCheck ?? (() => {})}
      onRowToggle={() => {}}
      onForceToggle={() => {}}
      onPress={() => {}}
      onClose={over.onClose ?? (() => {})}
    />,
  );
}

describe("the phases", () => {
  it("renders the offer: both rows ticked by default, one press for both", () => {
    renderUpdate({});
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(UPDATE_TITLE);
    expect(screen.getByText("Subshell Server App")).toBeDefined();
    expect(screen.getByText("Subshell Server CLI")).toBeDefined();
    // The § 13 default: everything actionable, ticked.
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    // Both halves behind, one press does both.
    expect(screen.getByRole("button", { name: "Download and Install 0.13.0" })).toBeDefined();
  });

  it("renders the checking phase with its own words, and nothing to tick", () => {
    renderUpdate({ state: "checking", appUpdate: null });
    expect(screen.getByText("Checking for a newer version of Subshell Server…")).toBeDefined();
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("renders the downloading phase and holds the leave shut", () => {
    renderUpdate({ state: "downloading", updateProgress: "Starting the download…" });
    expect(screen.getByText(/This app restarts when it is installed\./)).toBeDefined();
    expect(screen.getByText("Starting the download…")).toBeDefined();
  });

  it("holds the leave shut while the download runs", () => {
    const onClose = vi.fn();
    const view = renderUpdate({ state: "downloading", updateProgress: "Starting the download…", onClose });
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    // A disabled button's press is a no-op, but the test pins that the HANDLER
    // is behind the gate: the gate is in the disabled state, not in the
    // callback.
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
  });

  it("kicks the release check on mount when no marker is pending", () => {
    const onCheck = vi.fn();
    renderUpdate({ onCheck });
    expect(onCheck).toHaveBeenCalledWith(false);
  });

  it("does not kick the release check while a marker is pending", () => {
    const onCheck = vi.fn();
    // A ready machine with phase 2's marker still waiting: the check is about
    // installing the server the app it just installed ships, and asking a
    // third party whether a newer app exists is irrelevant here.
    renderUpdate({
      probe: makeProbe({ pendingInstall: { fromAppVersion: "0.11.0", forced: false, halted: false } }),
      onCheck,
    });
    expect(onCheck).not.toHaveBeenCalled();
  });
});

describe("the § 6 sentences", () => {
  it("renders the refusal long form for a server this app did not install", () => {
    renderUpdate({
      probe: makeProbe({
        next: "ready",
        server: { argv: ["/usr/local/bin/subshell-server"], source: "path", version: "0.12.0" },
        managed: false,
      }),
    });
    expect(
      screen.getByText(/runs from \/usr\/local\/bin\/subshell-server, which this app did not install/),
    ).toBeDefined();
    // The row states the short form in the cell, with no checkbox beside it.
    expect(screen.getByText("not this app's")).toBeDefined();
  });

  it("renders the downgrade sentence for a server newer than the bundle", () => {
    renderUpdate({
      probe: makeProbe({ next: "ready", serverChoice: "adopt-installed", bundledVersion: "0.12.0" }),
    });
    expect(screen.getByText("you run a newer one")).toBeDefined();
    // The long form says what the adoption means and names the supported way back.
    expect(screen.getByText(/An older server cannot boot on a database a newer one has migrated/)).toBeDefined();
    expect(screen.getByText(/nothing here will replace it/)).toBeDefined();
  });

  it("renders the could-not-check note as the row's own cell", () => {
    renderUpdate({
      appUpdate: { current: "0.12.1", latest: null, notes: null, reason: "The release source did not answer." },
    });
    expect(screen.getByText("could not check")).toBeDefined();
    expect(screen.getByText("The release source did not answer.")).toBeDefined();
  });
});

describe("the Force box", () => {
  it("renders only where the act restarts a pane-killing definition, fail-closed", () => {
    // A definition that kills panes: the box exists to permit the restart.
    renderUpdate({
      probe: makeProbe({
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: true,
          paneSafety: "kills",
          detail: "",
        },
      }),
      appUpdate: UP_TO_DATE,
    });
    expect(screen.getByText(/this restart closes every subshell running here\./)).toBeDefined();
    expect(screen.getByText("Restart anyway, closing every subshell running on this machine")).toBeDefined();
  });

  it("renders none where the definition spares panes — an unreadable one keeps the box", () => {
    const first = renderUpdate({
      probe: makeProbe({
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: true,
          paneSafety: "keeps",
          detail: "",
        },
      }),
      appUpdate: UP_TO_DATE,
    });
    expect(screen.queryByText(/closes every subshell/)).toBeNull();
    first.unmount();
    // paneSafety "unknown" on an installed definition: the risk model counts
    // it, so the box is there to answer it.
    renderUpdate({
      probe: makeProbe({
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: true,
          paneSafety: "unknown",
          detail: "",
        },
      }),
      appUpdate: UP_TO_DATE,
    });
    expect(screen.getByText(/closes every subshell running here\./)).toBeDefined();
  });
});

describe("the automatic resume", () => {
  it("fires once per visit, carrying the marker's consent", () => {
    const onResume = vi.fn();
    const probe = makeProbe({ pendingInstall: { fromAppVersion: "0.11.0", forced: true, halted: false } });
    const view = renderUpdate({ probe, onResume });
    // The second half of a press already made — nobody is here to answer, so
    // the marker's own `forced` is what runs.
    expect(onResume).toHaveBeenCalledWith(true);
    // A fresh probe identity (the poll's next answer) must not re-fire.
    view.rerender(
      <UpdateScreen
        strings={{ title: UPDATE_TITLE, subtitle: "", problem: "" }}
        probe={makeProbe({ pendingInstall: { fromAppVersion: "0.11.0", forced: true, halted: false } })}
        appUpdate={null}
        state="idle"
        finished={null}
        selection={NO_SELECTION}
        busy={false}
        updateProgress=""
        resumeFired
        onResume={onResume}
        onCheck={() => {}}
        onRowToggle={() => {}}
        onForceToggle={() => {}}
        onPress={() => {}}
        onClose={() => {}}
      />,
    );
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("renders the halted phase's words and the run's own output", () => {
    renderUpdate({
      probe: makeProbe({ pendingInstall: { fromAppVersion: "0.11.0", forced: false, halted: true } }),
      finished: { ok: false, stdout: "", stderr: "service restart refused" },
      resumeFired: true,
    });
    // The halted screen's own sentence: the automatic attempts are spent.
    expect(screen.getByText(/the server it ships could not be installed\./)).toBeDefined();
    expect(screen.getByText(/Nothing will try again on its own until you press/)).toBeDefined();
    expect(screen.getByText("service restart refused")).toBeDefined();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeDefined();
  });
});
