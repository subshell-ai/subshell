/**
 * Reset everything, as the DIALOG (operator ruling 2026-09-22: "reset
 * everything should be a dialog too with the confirmation"). The properties
 * the screen carried survive verbatim — the page supplies a hostname and
 * never a path, a machine with nothing to staged says so instead of offering
 * a button, the typed name gates the press — and the room's rule arrives
 * upgraded: a modal IS "no navigation beside the chain", and while the chain
 * runs the dismissal is inert.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/app";
import { deferred, type FakeIpc, installFakeIpc, makeProbe, renderApp } from "./harness";

// One document per bun test process: unmount, or the next file's global
// queries read this one's leftovers (the 2026-09-18 CI case).
afterEach(cleanup);

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

/** Boot the app and open the reset dialog through the rail's danger door. */
async function openReset(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  const dialog = await screen.findByRole("dialog", { name: "Reset everything?" });
  return { fake: ipc as FakeIpc, dialog };
}

const press = () => screen.getByRole("button", { name: "Reset Everything" }) as HTMLButtonElement;

describe("the reset dialog", () => {
  it("arms on open and names exactly what it will delete", async () => {
    const { fake } = await openReset({ handlers: { node_arm_reset: () => true } });
    await waitFor(() => expect(fake.callsTo("node_arm_reset").length).toBe(1));
    // The paths come from the probe, which quotes the CLI's own `paths` block.
    expect(within(document.body).getAllByText("/home/u/.config/subshell/data").length).toBeGreaterThan(0);
    expect(within(document.body).getAllByText("/home/u/.config/subshell/config.json").length).toBeGreaterThan(0);
  });

  // Each names something a person would reasonably assume a reset handled.
  it("says what it does not reach", async () => {
    await openReset({ handlers: { node_arm_reset: () => true } });
    expect(screen.getByText(/permanently offline/)).toBeTruthy();
    expect(screen.getByText(/pane logs/)).toBeTruthy();
    expect(screen.getByText(/Subshell Server on this same machine is not touched/)).toBeTruthy();
    expect(screen.getByText(/installed subshell binary stays/)).toBeTruthy();
    expect(screen.getAllByText(/permanent/).length).toBeGreaterThan(0);
  });

  // The gate is deliberate consent, not a memory test: the name is on screen.
  it("shows the hostname it asks to be typed, gates the press on it, and closes on completion", async () => {
    const { fake } = await openReset({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => ({ ok: true, stdout: "reset complete", stderr: "" }),
      },
    });
    expect(screen.getByText("devbox")).toBeTruthy();
    // Empty box: nothing to consent with.
    expect(press().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "devbox" } });
    await waitFor(() => expect(press().disabled).toBe(false));
    fireEvent.click(press());
    // A hostname crossed the boundary, and NOTHING else — no path, ever.
    await waitFor(() => expect(fake.callsTo("node_reset")).toEqual([{ typed: "devbox" }]));
    // The chain's end closes the dialog, and the words land on the screen
    // the press happened on. (Flush the promise continuation under act: a
    // `waitFor` whose first check fails escapes happy-dom's retry on Linux.)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Ruling 2026-09-22 on the COMPLETED reset ("the app didn't restart to
    // the FTE", "Reset should mean EVERYTHING resets"): a success sends the
    // app to the beginning of the walk — the walk IS the receipt — so the
    // section the dialog sat over is replaced, not annotated, and the chain's
    // stdout renders nowhere (a success leaves no receipt line, and Welcome
    // says more than "reset complete" would). A refusal still lands its
    // words on the section: see the case below and app.test's ownership pair.
    expect(screen.getByRole("heading", { name: "Welcome to Subshell Client" })).toBeTruthy();
    expect(screen.queryByText("reset complete")).toBeNull();
  });

  // The CLI's refusal is the answer; the page does not pre-empt it with its
  // own comparison, because the Rust side holds the memo that decides.
  it("sends whatever was typed and lets the refusal come back on the section", async () => {
    const { fake } = await openReset({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => {
          throw "the hostname did not match this machine";
        },
      },
    });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "not-devbox" } });
    fireEvent.click(press());
    await waitFor(() => expect(screen.getByText("the hostname did not match this machine")).toBeTruthy());
    expect(fake.callsTo("node_reset")).toEqual([{ typed: "not-devbox" }]);
  });

  // The room's rule, upgraded by the modal: nothing ends a running reset
  // but its own end — Escape is inert, Cancel is disabled, and the press
  // relabels instead of vanishing (a chain whose button disappears reads as
  // a hung window).
  it("cannot be dismissed while the chain runs, and labels itself running", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const { fake } = await openReset({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => gate.promise,
      },
    });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "devbox" } });
    fireEvent.click(press());
    const running = (await screen.findByRole("button", { name: "Resetting…" })) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Reset everything?" })).toBeTruthy();

    await act(async () => {
      gate.resolve({ ok: true, stdout: "reset complete", stderr: "" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.callsTo("node_reset")).toEqual([{ typed: "devbox" }]);
  });

  // Nothing staged means nothing to run, so there is no button to press —
  // the CLI omits its `paths` block entirely when no config loaded.
  it("offers no reset at all on a machine that is not enrolled", async () => {
    await openReset({ handlers: { node_arm_reset: () => false } });
    await screen.findByText(/not registered with a control plane/);
    expect(screen.queryByText("Reset Everything")).toBeNull();
    // The modal's way out is its own: a Close button, and Escape works when
    // nothing is running.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // A refused arm is an un-armed dialog: either way nothing is staged.
  it("treats a refused arming as nothing to reset", async () => {
    await openReset({
      handlers: {
        node_arm_reset: () => {
          throw "the app is not allowed to call node_arm_reset";
        },
      },
    });
    await screen.findByText(/not registered with a control plane/);
    expect(screen.queryByText("Reset Everything")).toBeNull();
  });

  // Cancel is the dialog's own refusal, and the section underneath is
  // exactly where it was.
  it("cancels back to the standing section", async () => {
    await openReset({ handlers: { node_arm_reset: () => true } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy();
  });

  // A broken node, which is where a reset is needed most, is never a dead end.
  it("opens on a node whose agent is not running", async () => {
    await openReset({ probe: makeProbe({ step: "stopped" }), handlers: { node_arm_reset: () => true } });
    expect(screen.getByRole("dialog", { name: "Reset everything?" })).toBeTruthy();
  });
});
