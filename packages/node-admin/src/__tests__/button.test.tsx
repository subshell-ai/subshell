import { afterEach, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "../ui/button";

afterEach(cleanup);

it("explains a disabled action on focus without allowing activation", async () => {
  const click = mock(() => {});
  const ancestorClick = mock(() => {});
  const submit = mock((event: React.FormEvent) => event.preventDefault());
  const { rerender } = render(
    <form onSubmit={submit}>
      <Button type="submit" disabled disabledReason="Only the node owner can share this node." onClick={click}>
        Share
      </Button>
    </form>,
  );
  const button = screen.getByRole("button", { name: "Share" });
  button.parentElement?.addEventListener("click", ancestorClick);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  act(() => button.focus());
  await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("Only the node owner can share this node."));
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyUp(button, { key: "Enter" });
  fireEvent.keyDown(button, { key: " " });
  fireEvent.keyUp(button, { key: " " });
  expect(click).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(ancestorClick).not.toHaveBeenCalled();
  rerender(
    <Button disabledReason="Only the node owner can share this node." onClick={click}>
      Share
    </Button>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  expect(click).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});
