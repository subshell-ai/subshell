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
import { deferred, type FakeIpc, installFakeIpc, makeProbe, renderApp } from "./harness";

// Unmount after each test. Testing Library appends every `render` to
// `document.body`, and there is ONE document per bun test process — so a file
// that renders without unmounting leaves its DOM for whatever file bun shards
// into that process next, and a test asking a GLOBAL question
// (`getAllByRole("button")`) reads the leftovers as its own. That is exactly
// how the Welcome screen's "Continue is the only control" case passed on a Mac
// and failed on CI, counting four About-screen buttons as its own (2026-09-18).
afterEach(cleanup);

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

/**
 * Boot the app and walk to the reset screen through the rail.
 *
 * The door moved twice: the status screen's "Unregister this machine…" link
 * was the rail's Reset section's stand-in, and since wave 3's follow-ups
 * (operator ruling 2026-09-22) the sidebar's destructive item IS the door —
 * the select is the paired screen-set-and-open. Since the LAYOUT ruling the
 * same day (final word), the CONFIRMATION rides the rail (reset active);
 * the frame-replacing room is the RUNNING chain, pinned below off the
 * runner's busy. The screen's own properties are unchanged.
 */
async function openReset(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
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

  // The two-state layout pin (operator ruling 2026-09-22, final word):
  // the confirmation rides the rail; the RUNNING chain is the room.
  it("hides the rail while the chain runs, and gives it back when it ends", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await openReset({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => gate.promise,
      },
    });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Reset" }).getAttribute("aria-current")).toBe("true");
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "devbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset Everything" }));
    // The room: no navigation beside a chain that is deleting this node.
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    gate.resolve({ ok: true, stdout: "reset complete", stderr: "" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy());
    expect(fake.callsTo("node_reset")).toEqual([{ typed: "devbox" }]);
  });

  // Nothing staged means nothing to run, so there is no button to press —
  // the CLI omits its `paths` block entirely when no config loaded.
  it("offers no reset at all on a machine that is not enrolled, and no Cancel beside the rail", async () => {
    await openReset({ handlers: { node_arm_reset: () => false } });
    await screen.findByText(/not registered with a control plane/);
    expect(screen.queryByRole("button", { name: "Reset Everything" })).toBeNull();
    // NO CANCEL where the rail is present (operator ruling 2026-09-22,
    // screenshot 59): the rail is the way out of the confirmation.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  // The output block travels with the screen that owns the action (operator
  // ruling 2026-09-22): an action pressed on ANOTHER screen leaves its words
  // there, and the reset screen renders only its own chain's.
  it("renders no other action's output", async () => {
    ipc = installFakeIpc({
      probe: makeProbe({
        step: "stopped",
        status: {
          nodeId: "11111111-2222-3333-4444-555555555555",
          serverUrl: "https://subshell.example.com",
          online: false,
          agentVersion: "1.9.0",
        },
        service: {
          installed: true,
          definitionPath: "/home/u/.config/systemd/user/subshell.service",
          state: "stopped",
          pid: null,
          enabled: true,
          paneSafety: "keeps",
          detail: "",
        },
      }),
      handlers: { node_service: () => ({ ok: true, stdout: "subshell started.", stderr: "" }) },
    });
    renderApp(<App />);
    await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Service" }));
    await screen.findByRole("heading", { name: "Service" });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    // Start settles (the daemon takes its lock a beat after the manager
    // returns), so the answer lands after the settle budget.
    await waitFor(() => expect(screen.getByText("subshell started.")).toBeTruthy(), { timeout: 8_000 });
    // The words belong to Service; walking to Reset leaves them there.
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await screen.findByRole("heading", { name: "Reset this client" });
    expect(screen.queryByText("subshell started.")).toBeNull();
    expect(ipc?.callsTo("node_reset")).toEqual([]);
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

  it("leaves by the rail, since Cancel is not offered beside it", async () => {
    // Operator ruling 2026-09-22, screenshot 59: the rail is the way out of
    // the confirmation, so the exit this test used to take (Cancel) is gone
    // and a select is what leaves.
    await openReset({ handlers: { node_arm_reset: () => true } });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Control Plane" }));
    // The landing a configured client returns to, whatever its agent is doing.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy());
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
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await screen.findByRole("heading", { name: "Reset this client" });
  });
});
