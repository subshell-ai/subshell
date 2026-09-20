import { afterEach, describe, expect, it } from "bun:test";
import { Button, confirmAction } from "@internal/node-admin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

/** Renders a provider with a trigger that asks and records the answer. */
function renderAsking(results: (boolean | null)[]) {
  render(
    <ConfirmProvider>
      <Button
        onClick={() =>
          void confirmAction({ title: "Delete web?", confirmLabel: "Delete" }).then((ok) => results.push(ok))
        }
      >
        ask
      </Button>
    </ConfirmProvider>,
  );
}

describe("ConfirmProvider", () => {
  afterEach(cleanup);

  it("shows the prompt wording and resolves true on the confirm button", async () => {
    const results: (boolean | null)[] = [];
    renderAsking(results);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    expect(await screen.findByText("Delete web?")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(results).toEqual([true]));
  });

  it("resolves false on cancel", async () => {
    const results: (boolean | null)[] = [];
    renderAsking(results);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    await screen.findByText("Delete web?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("resolves false when dismissed like a dialog being closed", async () => {
    const results: (boolean | null)[] = [];
    renderAsking(results);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    await screen.findByText("Delete web?");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("cancels an orphaned prompt if a second ask overtakes it", async () => {
    const results: boolean[] = [];
    render(
      <ConfirmProvider>
        <Button
          onClick={() => {
            void confirmAction({ title: "first?" }).then((ok) => results.push(ok));
            void confirmAction({ title: "second?" }).then((ok) => results.push(ok));
          }}
        >
          ask twice
        </Button>
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "ask twice" }));
    // The second ask wins the screen; the first is released as cancelled
    // rather than left awaiting a prompt no one can answer.
    expect(await screen.findByText("second?")).toBeDefined();
    await waitFor(() => expect(results).toEqual([false]));
    // The surviving prompt still resolves normally for its own caller.
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(results).toEqual([false, true]));
  });
});
