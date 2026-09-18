/**
 * The Choice screen asks the one question the first run used to assume the
 * answer to (spec 2026-09-18 § 1).
 *
 * Each case here is a property the branch is honest because of: that both use
 * cases are offered, that one press is the whole gesture, that the press
 * reports WHICH — a swapped argument routes a person who came to watch into
 * the path that installs an agent and spends a setup key — and that the
 * option which touches nothing says so.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ChoiceScreen, type FirstRunChoice } from "@/components/assistant/choice-screen";
import { renderApp } from "./harness";

afterEach(cleanup);

const shell = { title: "What Would You Like to Do?" };

/** Render, collecting every choice the screen reports. */
function renderChoice(busy = false) {
  const chosen: FirstRunChoice[] = [];
  renderApp(<ChoiceScreen shell={shell} onChoose={(c) => chosen.push(c)} busy={busy} />);
  return chosen;
}

describe("the Choice screen", () => {
  it("offers exactly the two use cases, and nothing in the bar to press after", () => {
    renderChoice();
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(2);
    expect(screen.getByRole("button", { name: /Run subshells on this machine/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect to a server/ })).toBeTruthy();
  });

  it("reports 'node' for the machine option", () => {
    const chosen = renderChoice();
    fireEvent.click(screen.getByRole("button", { name: /Run subshells on this machine/ }));
    expect(chosen).toEqual(["node"]);
  });

  it("reports 'watch' for the server option", () => {
    const chosen = renderChoice();
    fireEvent.click(screen.getByRole("button", { name: /Connect to a server/ }));
    expect(chosen).toEqual(["watch"]);
  });

  /**
   * The consequence, not the mechanism: the whole reason to ask is that one
   * of these two registers this machine and the other does not.
   */
  it("says what each option does to this machine", () => {
    renderChoice();
    expect(screen.getByText(/Registers this machine as a node/)).toBeTruthy();
    expect(screen.getByText(/Nothing is installed or registered/)).toBeTruthy();
  });

  it("disables both options while an action is in flight", () => {
    const chosen = renderChoice(true);
    for (const button of screen.getAllByRole("button") as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(chosen).toEqual([]);
  });
});
