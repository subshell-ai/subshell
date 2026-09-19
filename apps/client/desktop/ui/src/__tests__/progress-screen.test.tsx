/**
 * The Setting Up… checklist (spec 2026-09-18 § 5.6).
 *
 * Every case here is a property the screen exists BECAUSE of, and each is
 * cheap to lose in a refactor: that three acts are named rather than hidden
 * behind one "Registering…", that the act in flight is distinguishable from
 * the ones around it, that a failure shows the CLI's own words on the row that
 * failed, and that a finished chain WAITS for a press instead of navigating
 * away from the answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ProgressScreen } from "@/components/assistant/progress-screen";
import type { RegisterRow } from "@/lib/client-flow";
import { renderApp } from "./harness";

afterEach(cleanup);

const shell = { title: "Setting Up This Machine", subtitle: "This takes a moment." };

/** The three acts one Register press runs, in order. */
function rows(states: RegisterRow["state"][]): RegisterRow[] {
  const labels: [RegisterRow["id"], string][] = [
    ["install", "Install the node"],
    ["enroll", "Enroll this machine"],
    ["start", "Start the node service"],
  ];
  return labels.map(([id, label], i) => ({ id, label, state: states[i] }));
}

function show(props: Partial<Parameters<typeof ProgressScreen>[0]> = {}) {
  const calls = { continued: 0, retried: 0 };
  const view = renderApp(
    <ProgressScreen
      shell={shell}
      rows={rows(["done", "active", "pending"])}
      failureOutput=""
      done={false}
      onContinue={() => {
        calls.continued += 1;
      }}
      onRetry={() => {
        calls.retried += 1;
      }}
      busy={false}
      {...props}
    />,
  );
  const states = () =>
    Array.from(view.container.querySelectorAll<HTMLElement>("li[data-state]")).map((li) => li.dataset.state);
  return { ...view, calls, states };
}

describe("the Setting Up checklist", () => {
  // One press runs three acts; naming them is what makes a hang tell itself
  // apart from work, and what answers "what did that just do" afterwards.
  it("names every act the chain performs", () => {
    show();
    expect(screen.getByText("Install the node")).toBeTruthy();
    expect(screen.getByText("Enroll this machine")).toBeTruthy();
    expect(screen.getByText("Start the node service")).toBeTruthy();
  });

  // The whole point of the screen: which one is happening NOW.
  it("marks the act in flight distinctly from the ones before and after it", () => {
    const view = show();
    expect(view.states()).toEqual(["done", "active", "pending"]);
    // Not by colour alone, and not only for people who can see the glyph: the
    // list is a live region, so the state has to be a word somewhere.
    expect(screen.getByText(/In progress/)).toBeTruthy();
    expect(screen.getByText(/Done/)).toBeTruthy();
    expect(screen.getByText(/Not started/)).toBeTruthy();
  });

  // The CLI owns every operator-facing message; this screen prints it and
  // nothing else — and prints it on the row that failed, so the rows above it
  // still say how far the chain got.
  it("prints the failed act's own words, verbatim, under its row", () => {
    const output = "error: a node named devbox already exists on that server\nmint a new setup key and try again";
    const view = show({
      rows: rows(["done", "failed", "pending"]),
      failureOutput: output,
    });
    expect(view.states()).toEqual(["done", "failed", "pending"]);
    // Queried through the FAILED row: the words belong to the act that failed,
    // not to the bottom of the screen. (`getByText` normalizes whitespace,
    // which is the one thing a verbatim assertion must not do.)
    const block = view.container.querySelector("li[data-state='failed'] pre");
    expect(block).toBeTruthy();
    // Not re-worded, not truncated, not prefixed — and the newline survives.
    expect(block?.textContent).toBe(output);
    // Nothing prints it a second time somewhere else on the screen.
    expect(view.container.querySelectorAll("pre").length).toBe(1);
  });

  // The completed list IS the answer, so it holds until the person has read it.
  it("offers Continue only when every row is done, and never fires it itself", () => {
    const view = show({ rows: rows(["done", "done", "done"]), done: true });
    expect(view.calls.continued).toBe(0);
    const button = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(button);
    expect(view.calls.continued).toBe(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Still on screen with every row ticked — the handoff does not clear it.
    expect(view.states()).toEqual(["done", "done", "done"]);
    expect(screen.getByText("Install the node")).toBeTruthy();
  });

  it("offers Retry when an act failed", () => {
    const view = show({ rows: rows(["done", "failed", "pending"]), failureOutput: "boom" });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(view.calls.retried).toBe(1);
  });

  // A button during a run is either a lie or a second way to start what is
  // already started.
  it("offers no primary action while the chain is running", () => {
    show();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // `busy` is the runner's word for "an act is in flight"; a press that would
  // be dropped is a press that should not be offered.
  it("disables the press while an act is in flight", () => {
    show({ rows: rows(["done", "failed", "pending"]), failureOutput: "boom", busy: true });
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
