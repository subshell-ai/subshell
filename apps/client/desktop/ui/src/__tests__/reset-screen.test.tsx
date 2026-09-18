/**
 * The one irreversible screen in this app.
 *
 * Every case here is a property the reset is safe because of, and each is
 * cheap to lose in a refactor: that the page supplies a hostname and never a
 * path, that a machine with nothing to reset says so instead of offering a
 * button, and that the typed name gates the press.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, renderApp } from "./harness";

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

/**
 * Boot the app and walk to the reset screen from the status screen.
 *
 * The route changed with the first run (spec 2026-09-18): the connected and
 * service screens are gone, every configured client lands on `status`, and the
 * link there is named for what it does to the MACHINE rather than for the flow
 * behind it — "Unregister this machine…", since reset is what unregisters. The
 * screen it opens, and every property below, are unchanged.
 */
async function openReset(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Unregister this machine…" }));
  await screen.findByRole("heading", { name: "Reset this client" });
  return ipc as FakeIpc;
}

describe("the reset screen", () => {
  it("arms on arrival and names exactly what it will delete", async () => {
    const fake = await openReset({ handlers: { node_arm_reset: () => true } });
    await waitFor(() => expect(fake.callsTo("node_arm_reset").length).toBe(1));
    // The paths come from the probe, which quotes the CLI's own `paths` block.
    // `getAll`, because Show Details lists the config file as a fact too — the
    // screen names it twice on purpose, once as a fact and once as a casualty.
    expect(screen.getAllByText("/home/u/.config/subshell/data").length).toBeGreaterThan(0);
    expect(screen.getAllByText("/home/u/.config/subshell/config.json").length).toBeGreaterThan(0);
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
  it("shows the hostname it asks to be typed, and gates the press on it", async () => {
    const fake = await openReset({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => ({ ok: true, stdout: "deleted", stderr: "" }),
      },
    });
    expect(screen.getByText("devbox")).toBeTruthy();
    const press = () => screen.getByRole("button", { name: "Reset Everything" }) as HTMLButtonElement;
    // Empty box: nothing to consent with.
    expect(press().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "devbox" } });
    await waitFor(() => expect(press().disabled).toBe(false));
    fireEvent.click(press());
    // A hostname crossed the boundary, and NOTHING else — no path, ever.
    await waitFor(() => expect(fake.callsTo("node_reset")).toEqual([{ typed: "devbox" }]));
  });

  // The CLI's refusal is the answer; the page does not pre-empt it with its
  // own comparison, because the Rust side holds the memo that decides.
  it("sends whatever was typed and lets the refusal come back", async () => {
    const fake = await openReset({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => {
          throw "the hostname did not match this machine";
        },
      },
    });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "not-devbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset Everything" }));
    await waitFor(() => expect(screen.getByText("the hostname did not match this machine")).toBeTruthy());
    expect(fake.callsTo("node_reset")).toEqual([{ typed: "not-devbox" }]);
  });

  // Nothing staged means nothing to run, so there is no button to press —
  // the CLI omits its `paths` block entirely when no config loaded.
  it("offers no reset at all on a machine that is not enrolled", async () => {
    await openReset({ handlers: { node_arm_reset: () => false } });
    await screen.findByText(/not registered with a control plane/);
    expect(screen.queryByRole("button", { name: "Reset Everything" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  // A refused arm is an un-armed screen: either way nothing is staged.
  it("treats a refused arming as nothing to reset", async () => {
    await openReset({
      handlers: {
        node_arm_reset: () => {
          throw "the app is not allowed to call node_arm_reset";
        },
      },
    });
    await screen.findByText(/not registered with a control plane/);
    expect(screen.queryByRole("button", { name: "Reset Everything" })).toBeNull();
  });

  it("goes back to the machine's own screen on Cancel", async () => {
    await openReset({ handlers: { node_arm_reset: () => true } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The landing a configured client returns to, whatever its agent is doing.
    // It used to be the connected screen's "This Machine Is a Node"; that
    // screen is gone, and `status` is the one this app comes back to.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Subshell Client" })).toBeTruthy());
  });

  // Was "reachable from the service screen too". That screen is gone — a
  // stopped node lands on `status` like every other configured client — so
  // what this pins now is that the SAME landing carries the link whether or
  // not the agent is running. The property is the one that mattered: a broken
  // node, which is where a reset is needed most, is never a dead end.
  it("is reachable on a node whose agent is not running, where it is needed most", async () => {
    ipc = installFakeIpc({
      probe: makeProbe({ step: "stopped" }),
      handlers: { node_arm_reset: () => true },
    });
    renderApp(<App />);
    await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Unregister this machine…" }));
    await screen.findByRole("heading", { name: "Reset this client" });
  });
});
