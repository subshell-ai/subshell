import { afterEach, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SshMachineStep } from "../ssh-machine-step";

afterEach(cleanup);
it("does not call a saved machine unavailable until the machine read succeeds", () => {
  const props = { machines: [], value: "saved", label: "Connect from", onChange: () => {} };
  const view = render(<SshMachineStep {...props} loaded={false} />);
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<SshMachineStep {...props} loaded />);
  expect(screen.getByRole("alert").textContent).toContain("no longer available");
});
