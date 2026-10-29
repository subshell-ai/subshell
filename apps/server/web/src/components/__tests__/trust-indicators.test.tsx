import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrustIndicators } from "../trust-indicators";

afterEach(cleanup);
it("opens the node ownership explanation on a tap without requiring hover", async () => {
  render(
    <TrustIndicators
      notices={[
        {
          kind: "foreign-node",
          label: "Node owned by someone else",
          tooltip: "This node belongs to Alex.",
          dismissKey: "foreign",
          banner: "This node belongs to Alex.",
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Node owned by someone else" }));
  expect(await screen.findByRole("dialog", { name: "Subshell access" })).toBeTruthy();
  expect(screen.getByText("This node belongs to Alex.")).toBeTruthy();
});

it("stops explaining a disclosure that no longer applies while its dialog is open", async () => {
  // The dialog is opened by a click that captured one notice, but the notices
  // come from current access: when a share is revoked (or the node's owner
  // changes) mid-read, the row must not keep asserting the exposure the server
  // has just stopped reporting.
  const foreign = {
    kind: "foreign-node",
    label: "Node owned by someone else",
    tooltip: "This node belongs to Alex.",
    dismissKey: "foreign",
    banner: "This node belongs to Alex.",
  } as const;
  const shared = {
    kind: "shared",
    label: "Shared with others",
    tooltip: "Two people can watch this subshell.",
    dismissKey: "shared",
    banner: "Two people can watch this subshell.",
  } as const;
  const view = render(<TrustIndicators notices={[foreign, shared]} />);
  fireEvent.click(screen.getByRole("button", { name: "Shared with others" }));
  expect(await screen.findByRole("dialog", { name: "Subshell access" })).toBeTruthy();
  expect(screen.getByText("Two people can watch this subshell.")).toBeTruthy();
  view.rerender(<TrustIndicators notices={[foreign]} />);
  // What the person must never see: an explanation of an exposure the server has
  // just stopped reporting. (Queried by its sentence rather than by the dialog
  // element, which Base UI leaves mounted while it animates out.)
  await waitFor(() => expect(screen.queryByText("Two people can watch this subshell.") === null).toBe(true));
});
