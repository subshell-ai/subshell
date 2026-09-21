/**
 * The recovery screen, as component tests. Every variant's title and action
 * are driven through the pure `recoveryTitle`/`recoveryAction` over a probe
 * table, so the screen cannot render a diagnosis the model did not name; the
 * links stack, the tmux warning and the gated primary action are pinned
 * beside them.
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
  title?: string;
  onAction?: (kind: string) => void;
  onOpenReset?: () => void;
  onGo?: (to: string) => void;
  onInstallTmux?: () => void;
}) {
  return render(
    <StatusScreen
      strings={{ title: over.title ?? "", subtitle: "", problem: over.problem ?? "" }}
      probe={over.probe ?? makeProbe()}
      busy={over.busy ?? false}
      running={false}
      failure={null}
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
      onDetailsToggle={() => {}}
      lastResult={null}
      lastTail={null}
      about={null}
      onAction={(kind) => over.onAction?.(kind)}
      onInstallTmux={over.onInstallTmux ?? (() => {})}
      onGo={(to) => over.onGo?.(to)}
      onOpenReset={over.onOpenReset ?? (() => {})}
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
      expect(screen.getByRole("button", { name: action!.label })).toBeDefined();
    });
  }

  it("gates init and install-service while tmux is missing, names the reason, and offers the fix", () => {
    for (const next of ["init", "install-service"] as const) {
      const probe = makeProbe({ next, tmux: null });
      const view = renderStatus({ probe });
      expect((screen.getByRole("button", { name: recoveryAction(next)!.label }) as HTMLButtonElement).disabled).toBe(
        true,
      );
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
      expect((screen.getByRole("button", { name: recoveryAction(next)!.label }) as HTMLButtonElement).disabled).toBe(
        false,
      );
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

describe("the doors", () => {
  it("offers the four doors, and the server-update door only when an upgrade is known", () => {
    const onGo = vi.fn();
    const view = renderStatus({
      probe: makeProbe({ next: "start", serverChoice: "upgrade-available", bundledVersion: "0.12.2" }),
      onGo,
    });
    for (const door of ["Update Server to 0.12.2…", "Change how it runs…", "Check for updates…", "Server Addresses…"]) {
      screen.getByRole("button", { name: door }).click();
    }
    expect(onGo).toHaveBeenNthCalledWith(1, "update");
    expect(onGo).toHaveBeenNthCalledWith(2, "supervision");
    expect(onGo).toHaveBeenNthCalledWith(3, "update");
    expect(onGo).toHaveBeenNthCalledWith(4, "settings");
    view.unmount();

    renderStatus({ probe: makeProbe({ next: "start", serverChoice: "up-to-date" }) });
    // The server-update door is conditional, and the up-to-date machine has none.
    expect(screen.queryByRole("button", { name: /Update Server to/ })).toBeNull();
  });

  it("deep-links reset from the bar, through the screen-set the old openReset made", () => {
    const onOpenReset = vi.fn();
    renderStatus({ onOpenReset });
    screen.getByRole("button", { name: "Reset this server…" }).click();
    expect(onOpenReset).toHaveBeenCalledTimes(1);
  });
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
