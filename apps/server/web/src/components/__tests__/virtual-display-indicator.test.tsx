import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtualDisplayIndicator } from "../virtual-display-indicator";

afterEach(cleanup);
it("marks a subshell with a display and removes the indicator when it loses it", () => {
  const view = render(<VirtualDisplayIndicator display=":91" compact />);
  expect(screen.getByRole("img", { name: "Virtual display :91" })).toBeTruthy();
  view.rerender(<VirtualDisplayIndicator display={null} compact />);
  expect(screen.queryByRole("img") === null).toBe(true);
});
it("opens the display from an icon-only header shortcut", () => {
  let opened = 0;
  render(
    <VirtualDisplayIndicator
      display=":91"
      onOpen={() => {
        opened += 1;
      }}
    />,
  );
  expect(screen.queryByText("Virtual display") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  expect(opened).toBe(1);
});

it("keeps the header picker available for subshells without a virtual display", () => {
  let opened = 0;
  render(
    <VirtualDisplayIndicator
      onOpen={() => {
        opened += 1;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  expect(opened).toBe(1);
  expect(screen.queryByRole("img")).toBeNull();
});
