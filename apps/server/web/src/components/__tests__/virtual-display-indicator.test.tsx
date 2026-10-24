import { afterEach, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { VirtualDisplayIndicator } from "../virtual-display-indicator";

afterEach(cleanup);
it("marks a subshell with a display and removes the indicator when it loses it", () => {
  const view = render(<VirtualDisplayIndicator display=":91" compact />);
  expect(screen.getByRole("img", { name: "Virtual display :91" })).toBeTruthy();
  view.rerender(<VirtualDisplayIndicator display={null} compact />);
  expect(screen.queryByRole("img") === null).toBe(true);
});
it("names the feature visibly in the header", () => {
  render(<VirtualDisplayIndicator display=":91" />);
  expect(screen.getByText("Virtual display")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Virtual display :91" })).toBeTruthy();
});
