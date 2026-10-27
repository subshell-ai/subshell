import { afterEach, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { LaunchErrorLine } from "../launch-error-line";

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
