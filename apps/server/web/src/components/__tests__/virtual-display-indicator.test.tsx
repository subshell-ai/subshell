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
  fireEvent.click(screen.getByRole("button", { name: "Open web preview or screen" }));
  expect(opened).toBe(1);
});

it("says on the icon how much there is to open or save", () => {
  render(<VirtualDisplayIndicator display=":91" unsavedCount={3} onOpen={() => {}} />);
  expect(screen.getByRole("button", { name: "Open web preview or screen; 3 to open or save" })).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  cleanup();
  render(<VirtualDisplayIndicator display=":91" unsavedCount={12} onOpen={() => {}} />);
  expect(screen.getByText("9+")).toBeTruthy();
  cleanup();
  render(<VirtualDisplayIndicator display=":91" onOpen={() => {}} />);
  expect(screen.getByRole("button", { name: "Open web preview or screen" })).toBeTruthy();
  expect(screen.queryByText("0") === null).toBe(true);
});

it("promises a viewer only what they can actually do", () => {
  // The counted item for a `view` grantee is the browser watch, which is theirs
  // to open; writing a Saved services row is an `edit` act. A tooltip that
  // offered "or save" pointed the reader at a control the picker refuses them,
  // which is the same mismatch the badge count was fixed to avoid.
  render(<VirtualDisplayIndicator display=":91" unsavedCount={1} canSave={false} onOpen={() => {}} />);
  expect(screen.getByRole("button", { name: "Open web preview or screen; 1 to open" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /or save/ }) === null).toBe(true);
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
  fireEvent.click(screen.getByRole("button", { name: "Open web preview or screen" }));
  expect(opened).toBe(1);
  expect(screen.queryByRole("img")).toBeNull();
});
