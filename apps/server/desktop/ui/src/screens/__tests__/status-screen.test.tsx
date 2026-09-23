/**
 * The recovery screen, as component tests. Every variant's title and action
 * are driven through the pure `recoveryTitle`/`recoveryAction` over a probe
 * table, so the screen cannot render a diagnosis the model did not name; the
 * tmux warning and the gated primary action are pinned beside them. The four
 * linkish doors are GONE (wave 2): the rail's Update / Service /
 * Addresses sections are what those links were the stand-in for, and the
 * select-routing pins in host.test.tsx are the stacked-doors test now. The
 * Reset door stays — reset is full-window, never a section.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { ActionResult } from "../../lib/ipc";
import { DEFAULT_SUPERVISION, recoveryAction, recoveryTitle } from "../../lib/wizard-state";
import { StatusScreen } from "../status-screen";

afterEach(cleanup);

function renderStatus(over: {
  probe?: ReturnType<typeof makeProbe>;
  tmuxResult?: ActionResult | null;
  problem?: string;
  busy?: boolean;
  running?: boolean;
  failure?: ActionResult | null;
  title?: string;
  onAction?: (kind: string) => void;
  onInstallTmux?: () => void;
  onOpenDashboard?: () => void;
}) {
  return render(
    <StatusScreen
      strings={{ title: over.title ?? "", subtitle: "", problem: over.problem ?? "" }}
      probe={over.probe ?? makeProbe()}
      busy={over.busy ?? false}
      running={over.running ?? false}
      failure={over.failure ?? null}
      form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
      supervision={DEFAULT_SUPERVISION}
      tmuxResult={over.tmuxResult ?? null}
      outputOpen={false}
      onOutputOpenChange={() => {}}
      outputScroll={0}
      onOutputScroll={() => {}}
      problem={over.problem ?? ""}
      detailsOpen={false}
      onDetailsOpenChange={() => {}}
      lastResult={null}
      lastTail={null}
      about={null}
      onAction={(kind) => over.onAction?.(kind)}
      onInstallTmux={over.onInstallTmux ?? (() => {})}
      onOpenDashboard={over.onOpenDashboard ?? (() => {})}
      onReveal={() => {}}
      onFail={() => {}}
    />,
  );
}

describe("every recovery variant's diagnosis and action", () => {
  const CASES = [
    { next: "no-server", tmux: "/usr/bin/tmux" },
    { next: "unreachable", tmux: "/usr/bin/tmux" },
    { next: "init", tmux: "/usr/bin/tmux" },
    { next: "install-service", tmux: "/usr/bin/tmux" },
    { next: "start", tmux: "/usr/bin/tmux" },
  ] as const;

  for (const c of CASES) {
    it(`renders ${c.next}'s title and its one primary action`, () => {
      const probe = makeProbe({ next: c.next, tmux: c.tmux });
      // The title IS the diagnosis — the pure model's answer, not the
      // screen's; the strings arrive from the host's shell, which calls the
      // same function.
      renderStatus({ probe, title: recoveryTitle(c.next) });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(recoveryTitle(c.next));
      const action = recoveryAction(c.next);
      expect(action).not.toBeNull();
      const label = action?.label;
      expect(label).toBeDefined();
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    });
  }

  it("gates init and install-service while tmux is missing, names the reason, and offers the fix", () => {
    for (const next of ["init", "install-service"] as const) {
      const probe = makeProbe({ next, tmux: null });
      const view = renderStatus({ probe });
      const label = recoveryAction(next)?.label;
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
      // The warning names the WHOLE gate, and offers the run-the-installer fix.
      expect(screen.getByText(/tmux was not found on the login PATH\./)).toBeDefined();
      expect(screen.getByRole("button", { name: "Install tmux" })).toBeDefined();
      view.unmount();
    }
  });

  it("does not gate retry or choose-binary — neither runs a pane", () => {
    for (const next of ["no-server", "unreachable"] as const) {
      const probe = makeProbe({ next, tmux: null });
      const view = renderStatus({ probe });
      const label = recoveryAction(next)?.label;
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
      view.unmount();
    }
  });

  it("fires the action's kind and the warning's install through their callbacks", () => {
    const onAction = vi.fn();
    const onInstallTmux = vi.fn();
    const view = renderStatus({ probe: makeProbe({ next: "start" }), onAction });
    screen.getByRole("button", { name: "Start" }).click();
    expect(onAction).toHaveBeenCalledWith("start");
    view.unmount();
    // The warning's install is on the tmux-missing variant only.
    renderStatus({ probe: makeProbe({ next: "start", tmux: null }), onInstallTmux });
    screen.getByRole("button", { name: "Install tmux" }).click();
    expect(onInstallTmux).toHaveBeenCalledTimes(1);
  });
});

describe("the primary action's disabled states", () => {
  it("disables while busy, like every other control the old button() helper built", () => {
    renderStatus({ probe: makeProbe({ next: "start", tmux: "/usr/bin/tmux" }), busy: true });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the problem line when a stale tmux verdict sits beside a tmux that appeared", () => {
    // The suppression belongs to the CARD, and the card only renders while
    // tmux is missing: with tmux present, no card renders, so the line —
    // whatever wrote it — stays.
    const FAIL: ActionResult = { ok: false, stdout: "", stderr: "Error: Failure while executing; brew install tmux" };
    renderStatus({
      probe: makeProbe({ next: "start", tmux: "/usr/bin/tmux" }),
      tmuxResult: FAIL,
      problem: "Error: Failure while executing; brew install tmux",
    });
    expect(screen.getByText("Error: Failure while executing; brew install tmux")).toBeDefined();
    expect(screen.queryByText("The tmux install didn't finish.")).toBeNull();
  });
});

describe("the doors", () => {
  // The Reset DOOR moved into the rail (operator ruling 2026-09-22): the
  // bar's ghost is gone, and the select-renders-the-room pin lives in
  // host.test.tsx, where the whole page — the rail, the paired open, the
  // frame-replacing room — is under test. The deep-link test is DELETED, not
  // weakened.
});

describe("the tmux install's own verdict", () => {
  it("reports a failed install on this screen too, and drops the duplicated problem line", () => {
    const FAIL: ActionResult = { ok: false, stdout: "", stderr: "Error: Failure while executing; brew install tmux" };
    // tmux still missing after the run: the card is the verdict, and the
    // problem line that said the same thing once, badly, is cleared.
    renderStatus({
      probe: makeProbe({ next: "start", tmux: null }),
      tmuxResult: FAIL,
      problem: "Error: Failure while executing; brew install tmux",
    });
    expect(screen.getByText("The tmux install didn't finish.")).toBeDefined();
    expect(document.querySelector("p[role='status']")?.textContent ?? "").toBe("");
    // A machine error that is not the install's is not the card's to hide.
    const { unmount } = renderStatus({
      probe: makeProbe({ next: "start", tmux: null }),
      tmuxResult: FAIL,
      problem: "status --json failed",
    });
    expect(document.querySelector("p[role='status']")?.textContent).toBe("status --json failed");
    unmount();
  });

  it("shows nothing about an install when no install has run here", () => {
    renderStatus({ probe: makeProbe({ next: "start", tmux: null }) });
    expect(screen.queryByText("The tmux install didn't finish.")).toBeNull();
  });
});

/**
 * The RUNNING machine's status screen (operator ruling 2026-09-23): what the
 * section shows when a person selects Status on a machine that is answering,
 * instead of resolving onto the handoff and bouncing through the setup pane.
 * The route pins (`route()` returning `status` for a standing select, and
 * `handoff` for an arrival) live in route.test.ts and host.test.tsx; this is
 * the screen's own half.
 */
describe("the running machine's status screen", () => {
  it("offers one Open dashboard button over the facts, and no recovery action", () => {
    const onOpenDashboard = vi.fn();
    renderStatus({ probe: makeProbe({ next: "ready", onboarded: true }), onOpenDashboard });
    // One button, pressed by the human. `recoveryAction("ready")` answers
    // null, so there was never a diagnosis button here either — but the
    // tmux warning must not appear on a running machine either.
    screen.getByRole("button", { name: "Open control plane" }).click();
    expect(onOpenDashboard).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/tmux was not found on the login PATH\./)).toBeNull();
  });

  it("renders the section's facts and the log tail inline", () => {
    renderStatus({ probe: makeProbe({ next: "ready", onboarded: true }) });
    // The same StatusDetails the diagnosis renders: facts grid, Server log,
    // and the app's version line when the host read it.
    expect(screen.getByText("Server log")).toBeDefined();
    expect(document.querySelector("dl.facts")).not.toBeNull();
  });

  it("keeps the progress view ahead of the running view", () => {
    // A chain that just finished on a ready probe still owns the screen (the
    // press rule the handoff shares with the setup screen): it does not become
    // a status screen. The failure case has its own test below.
    const view = renderStatus({ probe: makeProbe({ next: "ready", onboarded: true }) });
    expect(screen.getByRole("button", { name: "Open control plane" })).toBeDefined();
    view.unmount();
    // `running` reaches the screen through the ProgressView branch: render a
    // ready probe with running true and the checklist answers instead.
    render(
      <StatusScreen
        strings={{ title: "Setting Up Subshell…", subtitle: "This takes a moment.", problem: "" }}
        probe={makeProbe({ next: "ready", onboarded: true })}
        busy={false}
        running
        failure={null}
        form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
        supervision={DEFAULT_SUPERVISION}
        tmuxResult={null}
        outputOpen={false}
        onOutputOpenChange={() => {}}
        outputScroll={0}
        onOutputScroll={() => {}}
        problem=""
        detailsOpen={false}
        onDetailsOpenChange={() => {}}
        lastResult={null}
        lastTail={null}
        about={null}
        onAction={() => {}}
        onInstallTmux={() => {}}
        onOpenDashboard={() => {}}
        onReveal={() => {}}
        onFail={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open control plane" })).toBeNull();
  });

  it("keeps a failed recovery action ahead of the running view", () => {
    // The `!failure` guard in status-screen.tsx: a recovery action that failed
    // on an otherwise-ready machine must stay on screen rather than vanish
    // under the facts view, or the reader loses the very error to act on.
    renderStatus({
      probe: makeProbe({ next: "ready", onboarded: true }),
      failure: { ok: false, stdout: "", stderr: "start refused" },
    });
    expect(screen.queryByRole("button", { name: "Open control plane" })).toBeNull();
  });
});
