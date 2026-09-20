import { afterEach, describe, expect, test } from "bun:test";
import { confirmAction } from "@internal/node-admin";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmProvider } from "../confirm-dialog";

/**
 * The dashboard's `ConfirmProvider` is the one thing every destructive card
 * (Service verbs, Repoint, maintenance) blocks on — `confirmAction` resolves
 * only through the handler this provider installs. So the test is not about the
 * markup: it is the proof that a press resolves the exact promise a card is
 * awaiting, and that a cancel (or an errant scrim click) resolves `false` rather
 * than leaving a mutation hanging.
 */
describe("ConfirmProvider", () => {
  afterEach(cleanup);

  test("the confirm button resolves the awaiting promise true", async () => {
    render(
      <ConfirmProvider>
        <p>host</p>
      </ConfirmProvider>,
    );
    // `unknown`, not `boolean | null`: control-flow analysis cannot see that
    // the promise's `.then` ran during `act`, so it would narrow a
    // `boolean | null` back to its `null` literal at the assertion below.
    let resolved: unknown = null;
    // confirmAction sets the provider's prompt state, so the trigger itself is
    // a state update and belongs inside act.
    await act(async () => {
      void confirmAction({ title: "Stop the node?", danger: true, confirmLabel: "Stop" }).then((v) => {
        resolved = v;
      });
    });

    // The prompt appears with the card's own wording.
    expect(await screen.findByText("Stop the node?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Stop"));
    });
    expect(resolved).toBe(true);
  });

  test("cancel resolves the awaiting promise false — nothing destructive runs", async () => {
    render(
      <ConfirmProvider>
        <p>host</p>
      </ConfirmProvider>,
    );
    let resolved: unknown = null;
    await act(async () => {
      void confirmAction({ title: "Repoint this node?" }).then((v) => {
        resolved = v;
      });
    });
    expect(await screen.findByText("Repoint this node?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(resolved).toBe(false);
  });
});
