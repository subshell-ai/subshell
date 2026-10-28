import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
