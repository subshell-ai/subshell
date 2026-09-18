/**
 * The Welcome screen's whole contract is that it does nothing.
 *
 * It is the front door of the first run (spec 2026-09-18 § 4), and the defect
 * it replaced was a front door whose one button persisted an address and
 * opened a window. So the cases here are: the press reports itself and nothing
 * else, the screen offers no second control that could touch this machine, and
 * both halves of the app are named before the next screen asks which one you
 * came for.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { WelcomeScreen } from "@/components/assistant/welcome-screen";
import { renderApp } from "./harness";

afterEach(cleanup);

/** The host owns the title; the screen owns its sentence and its button. */
const shell = { title: "Welcome to Subshell Client" };

describe("the Welcome screen", () => {
  it("advances on Continue, and that is the only control it has", () => {
    let advanced = 0;
    renderApp(<WelcomeScreen shell={shell} onContinue={() => advanced++} busy={false} />);

    expect(screen.getByRole("heading", { name: "Welcome to Subshell Client" })).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Continue"]);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(advanced).toBe(1);
  });

  /**
   * This app is a client that can also make its machine a node, and the very
   * next screen asks which of the two you want. A welcome naming one half
   * would have taught the wrong shape a screen before the question.
   */
  it("names both halves of the app in one sentence", () => {
    renderApp(<WelcomeScreen shell={shell} onContinue={() => {}} busy={false} />);
    const sentence = screen.getByText(/connects you to a Subshell server/);
    expect(sentence.textContent).toMatch(/run subshells on this machine/);
  });

  it("disables Continue while an action is in flight", () => {
    let advanced = 0;
    renderApp(<WelcomeScreen shell={shell} onContinue={() => advanced++} busy={true} />);
    const button = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(advanced).toBe(0);
  });
});
