/**
 * The start-up question.
 *
 * v1 asks exactly one thing — whether the background service is armed at
 * login — and the cases below pin both halves of that: that the answer the
 * register chain will pass to `service install` is the one on screen, and that
 * the screen does not offer the run-with-the-app mode, which is deferred (a
 * node's panes are tmux servers parented to the daemon, and this app has no
 * supervisor). A screen naming a mode that does not exist is worse than one
 * that asks less.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { StartupScreen } from "@/components/assistant/startup-screen";
import { IS_MACOS } from "@/lib/copy";
import { renderApp } from "./harness";

const shell = { title: "How This Node Runs" };

function renderStartup(overrides: Partial<Parameters<typeof StartupScreen>[0]> = {}) {
  const changes: boolean[] = [];
  const continues: number[] = [];
  renderApp(
    <StartupScreen
      shell={shell}
      startAtLogin
      onChange={(next) => changes.push(next)}
      onContinue={() => continues.push(1)}
      busy={false}
      {...overrides}
    />,
  );
  return { changes, continues };
}

afterEach(cleanup);

describe("the start-up screen", () => {
  it("shows the login choice as it stands, on by default", () => {
    renderStartup();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("reflects a choice that was turned off", () => {
    renderStartup({ startAtLogin: false });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  // The host owns the boolean; this screen only reports the flip.
  it("reports the flipped value rather than toggling a copy of its own", () => {
    const { changes } = renderStartup();
    fireEvent.click(screen.getByRole("switch"));
    expect(changes).toEqual([false]);
  });

  it("continues on the one primary", () => {
    const { continues } = renderStartup();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(continues).toEqual([1]);
  });

  // The primary is still the only thing that ACTS, with a Back beside it.
  it("keeps Back and the primary apart", () => {
    const { continues } = renderStartup({ onBack: () => {} });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(continues).toEqual([1]);
  });

  it("says what start at login buys, and what its absence costs", () => {
    renderStartup();
    expect(screen.getByText(/Starts the node again the next time you log in/)).toBeTruthy();
    expect(screen.getByText(/nothing brings it back after you log out or restart/)).toBeTruthy();
  });

  /**
   * An enabled `--user` unit comes back at LOGIN and dies at LOGOUT unless the
   * user lingers — a different question from "is it enabled", and on a
   * headless node the one that decides whether the agent is there at all.
   * launchd has no equivalent knob, so the line is Linux-only.
   */
  it("carries the lingering caveat on Linux and nowhere else", () => {
    renderStartup();
    const linger = screen.queryByText("loginctl enable-linger $USER");
    if (IS_MACOS) expect(linger).toBeNull();
    else expect(linger).not.toBeNull();
  });

  // One question, one control: the run-with-the-app alternative is deferred,
  // so there is no mode picker here and nothing claiming the app can run it.
  it("asks one question and names no deferred mode", () => {
    renderStartup({ onBack: () => {} });
    expect(screen.getAllByRole("switch").length).toBe(1);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryAllByRole("radio").length).toBe(0);
    // "Register", not "Continue": this is the press that ACTS — it installs the
    // agent, spends the setup key and writes the service with the answer
    // above. The details screen before it collects and spends nothing, so
    // that one says Continue (operator, 2026-09-18).
    //
    // Rendered with the Back `app.tsx` always gives it, so this is the set a
    // person sees rather than a configuration the app never uses.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Back", "Register"]);
  });

  /**
   * The way OUT, which this screen had none of.
   *
   * It is the last screen before the chain spends a single-use key, and it
   * used to be a one-way door: `barLeft` lived only on the progress screen, so
   * a person who got here and wanted to change the address they had typed had
   * no way to reach the fields again.
   */
  it("offers a way back to the details, and spends nothing to take it", () => {
    const backs: number[] = [];
    const { continues } = renderStartup({ onBack: () => backs.push(1) });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backs).toEqual([1]);
    // Leaving is not the press that acts, and must never be mistaken for it.
    expect(continues).toEqual([]);
  });

  it("draws no Back where none was given", () => {
    // Optional by design: a caller with nowhere to send a person shows no door.
    renderStartup();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("cannot be left while an action is in flight", () => {
    const backs: number[] = [];
    renderStartup({ busy: true, onBack: () => backs.push(1) });
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.click(back);
    expect(backs).toEqual([]);
  });

  it("changes nothing while an action is in flight", () => {
    const { changes, continues } = renderStartup({ busy: true });
    const button = screen.getByRole("button", { name: "Register" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("switch"));
    expect(continues).toEqual([]);
    expect(changes).toEqual([]);
  });
});
