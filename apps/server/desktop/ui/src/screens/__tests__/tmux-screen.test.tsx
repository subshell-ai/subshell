/**
 * The tmux screen, as component tests: the run plan's button and its try
 * again, the install progress, the three-layer failure card with its manual
 * command, and the manual routes showing their instructions by default.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { ActionResult } from "../../lib/ipc";
import { TmuxScreen } from "../tmux-screen";

afterEach(cleanup);

const STRINGS = {
  title: "Install tmux",
  subtitle: "Every subshell runs in a tmux pane, so the server needs it before it can start.",
  problem: "",
};

/** A Mac whose login PATH has no tmux, and a brew to install it with. */
const BREW_LESS_TMUX = makeProbe({ next: "init", onboarded: false, tmux: null, platform: "darwin", hasBrew: true });

const FAIL_RESULT: ActionResult = {
  ok: false,
  stdout: "",
  stderr: "Error: Failure while executing; brew install tmux",
};

function renderTmux(over: {
  probe?: typeof BREW_LESS_TMUX;
  busy?: boolean;
  running?: boolean;
  tmuxResult?: ActionResult | null;
  installLine?: string;
  installStartedAt?: number;
  problem?: string;
  onInstall?: () => void;
}) {
  return render(
    <TmuxScreen
      strings={STRINGS}
      probe={over.probe ?? BREW_LESS_TMUX}
      busy={over.busy ?? false}
      running={over.running ?? false}
      tmuxResult={over.tmuxResult ?? null}
      outputOpen={false}
      onOutputOpenChange={() => {}}
      outputScroll={0}
      onOutputScroll={() => {}}
      installLine={over.installLine ?? ""}
      installStartedAt={over.installStartedAt ?? 0}
      problem={over.problem ?? ""}
      onInstall={over.onInstall ?? (() => {})}
      onFail={() => {}}
    />,
  );
}

describe("the run plan", () => {
  it("offers the install, with the password hint under it", () => {
    renderTmux({});
    const button = screen.getByRole("button", { name: "Install tmux" });
    expect(button.className).toContain("primary");
    expect(screen.getByText("Your package manager may ask for your password.")).toBeDefined();
    // No failure has run here, so no failure card and no manual line: the
    // command prints only once the button has been shown not to work.
    expect(screen.queryByText("Or run this in a terminal:")).toBeNull();
  });

  it("labels the retry try again, and shows the manual command only then", () => {
    renderTmux({ tmuxResult: FAIL_RESULT });
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.getByText("The tmux install didn't finish.")).toBeDefined();
    // The manager's last word under the headline.
    expect(screen.getAllByText("Error: Failure while executing; brew install tmux").length).toBeGreaterThan(0);
    expect(screen.getByText("Or run this in a terminal:")).toBeDefined();
    expect(screen.getByText("brew install tmux")).toBeDefined();
  });

  it("reports a finished install that still left no tmux as its own sentence", () => {
    renderTmux({ tmuxResult: { ok: true, stdout: "Pouring tmux…", stderr: "" } });
    expect(screen.getByText("The installer finished, but tmux still isn't on this machine's PATH.")).toBeDefined();
  });

  it("shows the install progress while the action is in flight", () => {
    renderTmux({ busy: true, installStartedAt: 1_000, installLine: "==> Fetching tmux" });
    expect(screen.getByText("Installing tmux…")).toBeDefined();
    expect(screen.getByText("==> Fetching tmux")).toBeDefined();
    // No button while the install runs.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("fires the install on the button press", () => {
    const onInstall = vi.fn();
    renderTmux({ onInstall });
    screen.getByRole("button", { name: "Install tmux" }).click();
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("clears the problem line when it IS this failure, and keeps a machine error", () => {
    // The card is the failure said properly; the line said it once, badly.
    renderTmux({ tmuxResult: FAIL_RESULT, problem: "Error: Failure while executing; brew install tmux" });
    expect(document.querySelector("p[role='status']")?.textContent ?? "").toBe("");
    // A machine that cannot be read at all is not the card's to hide.
    renderTmux({ tmuxResult: FAIL_RESULT, problem: "status --json failed" });
    expect(document.querySelector("p[role='status']")?.textContent).toBe("status --json failed");
  });
});

describe("the manual plan", () => {
  it("shows the checking line, both managers, and the first manager's instructions by default", () => {
    const noBrew = makeProbe({ next: "init", onboarded: false, tmux: null, platform: "darwin", hasBrew: false });
    renderTmux({ probe: noBrew });
    expect(screen.getByText("Checking for tmux…")).toBeDefined();
    expect(screen.getByText("Installing tmux through Homebrew or MacPorts is recommended.")).toBeDefined();
    const homebrew = screen.getByRole("button", { name: "Homebrew" });
    const macports = screen.getByRole("button", { name: "MacPorts" });
    // The instructions no longer hide until asked for (operator's call,
    // 2026-09-25): the first route's are on screen the moment the screen is.
    expect(homebrew.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Install it from its site, then come back\./)).toBeDefined();
    expect(screen.getByText(/Once you have Homebrew, run:/)).toBeDefined();
    expect(screen.getByText("brew install tmux")).toBeDefined();
    // Pressing the other manager SWITCHES which instructions show.
    fireEvent.click(macports);
    expect(macports.getAttribute("aria-pressed")).toBe("true");
    expect(homebrew.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/Once you have MacPorts, run:/)).toBeDefined();
    expect(screen.queryByText(/Once you have Homebrew, run:/)).toBeNull();
    // And pressing the selected one again cannot hide them: a press that
    // empties the pane is the hidden state, one click later.
    fireEvent.click(macports);
    expect(screen.getByText(/Once you have MacPorts, run:/)).toBeDefined();
  });
});
