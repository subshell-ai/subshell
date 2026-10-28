import { afterEach, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { LaunchErrorLine, LaunchRefusal } from "../launch-error-line";

/**
 * The announcement is the behavior. This is the half of a refusal that used to exist
 * as three copies of the same `<p>`: the field-side half was announced, the form-side
 * half was not, so switching the Virtual display box off moved the very sentence about
 * that box from announced to silent. Deleting the role from the component is what this
 * test catches, which no arrangement of three call sites could do.
 */
afterEach(cleanup);

it("announces the refusal it shows", () => {
  render(<LaunchErrorLine message="This node is offline. Pick another machine. (preview-node-off)" />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("This node is offline. Pick another machine. (preview-node-off)");
});

it("says nothing when there is no refusal, rather than announcing an empty line", () => {
  // A component that always rendered its `<p>` would keep the first test green and
  // have a screen reader announce blank space on every dialog open.
  render(<LaunchErrorLine message={null} />);
  expect(screen.queryByRole("alert") === null).toBe(true);
});

/**
 * The other half: a launch dialog renders its form THROUGH this wrapper, so the
 * refusal cannot be dropped without dropping the form. Three dialogs each wrote the
 * line themselves, and deleting it from any two of the three changed nothing any test
 * could see; one of them also unmounts the Virtual display checkbox on the SSH tab
 * while the error stays set, which is why the line travels with the content instead
 * of living inside it.
 */
it("shows the refusal alongside the content it belongs to", () => {
  render(
    <LaunchRefusal error="This node is offline. Pick another machine. (preview-node-off)">
      <button type="button">Start subshell</button>
    </LaunchRefusal>,
  );
  // Both at once: a wrapper that answered a refusal by replacing the form would hide
  // the very control the person needs to change, and read green on the test above.
  expect(screen.getByRole("button", { name: "Start subshell" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toBe("This node is offline. Pick another machine. (preview-node-off)");
});

it("keeps the content on screen when there is no refusal", () => {
  render(
    <LaunchRefusal error={null}>
      <button type="button">Start subshell</button>
    </LaunchRefusal>,
  );
  expect(screen.getByRole("button", { name: "Start subshell" })).toBeDefined();
  expect(screen.queryByRole("alert") === null).toBe(true);
});

it("adds no element, so a dialog's sticky footer keeps its place", () => {
  // The wrapper's whole layout claim is that it is a fragment: each dialog's line sits
  // where it sat before, next to a footer Base UI styles by position. A well-meant
  // <div> here would break that while every text assertion above still passed.
  // Both must hang off the render container itself. Asserting they share a PARENT is
  // not enough: a wrapper element would keep them siblings under it and read green.
  const { container } = render(
    <LaunchRefusal error="No display on that node.">
      <span data-testid="content" />
    </LaunchRefusal>,
  );
  // Compared as booleans: a failed element assertion makes Bun serialize the whole DOM
  // graph (measured: 273 ms for this test alone, and the package's AGENTS.md names it).
  expect(screen.getByTestId("content").parentElement === container).toBe(true);
  expect(screen.getByRole("alert").parentElement === container).toBe(true);
});
