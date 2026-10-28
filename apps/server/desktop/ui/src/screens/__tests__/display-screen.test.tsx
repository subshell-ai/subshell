/**
 * **Virtual Displays**, as component tests: the leave button's one condition,
 * the single press that asks Rust for the helper's panel, and the steps whose
 * order and naming a reader follows inside System Settings.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installFakeIpc, makeProbe } from "../../__tests__/harness";
import { DisplayScreen } from "../display-screen";

afterEach(cleanup);

const STRINGS = {
  title: "Virtual Displays",
  subtitle: "A virtual display gives a subshell a screen for graphical apps without needing another physical monitor.",
  problem: "",
};

function renderDisplay(over: { rail?: Parameters<typeof DisplayScreen>[0]["rail"]; openFails?: boolean } = {}) {
  const fake = installFakeIpc({
    probe: makeProbe({ next: "start", platform: "darwin" }),
    handlers: {
      desktop_open_display_helper: over.openFails
        ? () => Promise.reject(new Error("the helper is not installed"))
        : () => undefined,
    },
  });
  render(
    <DisplayScreen
      strings={STRINGS}
      probe={makeProbe({ next: "start", onboarded: true, platform: "darwin" })}
      onClose={() => {}}
      rail={over.rail}
    />,
  );
  return fake;
}

describe("the leave button", () => {
  it("renders only where the rail is not", () => {
    // Rail-less: the leave is the only way out, same ruling as every standing
    // screen — a rail select discards exactly what the leave does.
    renderDisplay();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeNull();
    cleanup();
    renderDisplay({ rail: <div /> });
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

describe("the press", () => {
  it("asks Rust for the helper's panel, once", () => {
    const fake = renderDisplay({ rail: <div /> });
    fireEvent.click(screen.getByRole("button", { name: "Open Display Helper settings" }));
    // One ask per press: the helper's panel is a window in another program, and
    // a second open is that window fighting itself.
    expect(fake.callsTo("desktop_open_display_helper")).toHaveLength(1);
    fake.restore();
  });

  it("keeps the instructions on screen when the open is refused", () => {
    // The refusal is Rust's to say, in its own dialog. Nothing here may wipe
    // the steps, because a reader still has to know what to do next.
    const fake = renderDisplay({ rail: <div />, openFails: true });
    fireEvent.click(screen.getByRole("button", { name: "Open Display Helper settings" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fake.restore();
  });
});

describe("the guide link", () => {
  it("names the display guide, so the system browser opens the enablement page", () => {
    // `wire-names.test.ts` holds the TS union and Rust's enum equal; only this
    // press carries the fact that THIS screen sends that member, and a drifted
    // string is a runtime refusal no type check sees.
    const fake = renderDisplay({ rail: <div /> });
    fireEvent.click(screen.getByRole("button", { name: "How to enable the display helper" }));
    expect(fake.callsTo("desktop_open_web")).toEqual([{ target: "display-guide" }]);
    fake.restore();
  });
});

describe("the steps", () => {
  it("put Enable first and name the helper the way System Settings lists it", () => {
    // A reader follows this list into another program's windows and into
    // System Settings' permission table. A step out of order sends them to a
    // toggle that is not there yet, and a wrong name sends them to the wrong
    // row: the grant goes to the helper, never to Subshell Server.
    renderDisplay({ rail: <div /> });
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(steps[0]).toContain("Enable helper");
    expect(steps[1]).toContain("Subshell Display Helper");
    expect(steps[2]).toContain("restart");
  });
});
