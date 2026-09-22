/**
 * Re-enroll IS the enrollment wizard (operator ruling 2026-09-22, superseding
 * an earlier same-day shape that made it a bespoke repoint dialog). Pressing
 * it on an enrolled machine enters the same walk the Register card enters —
 * details, start-up question, the chain — with the Server URL SEEDED from the
 * address this node reports to.
 *
 * The wizard's own machinery is what makes a re-enroll over a live
 * `config.json` honest: Rust refuses to spend a setup key on top of an
 * existing enrollment until the named confirmation is accepted, because the
 * act overwrites the file, discards the node key whose only home it is, and
 * mints a fresh node row. The card keeps the address and its loopback
 * warning — facts about where the node dials — and renders no form at all.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, renderApp } from "./harness";

// One document per bun test process: unmount, or a later file's global
// queries read this one's leftovers (the 2026-09-18 CI case).
afterEach(cleanup);

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

async function boot(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  await fireEvent.click(screen.getByRole("button", { name: "Service" }));
  await screen.findByRole("heading", { name: "Service" });
  return ipc;
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("re-enroll, which is the wizard", () => {
  it("enters the enrollment walk with the node's own address seeded", async () => {
    await boot();
    fireEvent.click(button("Re-enroll…"));
    await screen.findByRole("heading", { name: "Register This Machine" });
    // The seed is the whole courtesy of the door: a re-enroll is usually one
    // character or one name away from the address already there.
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
    // And the press drove NO command: the walk's screens carry the act.
    expect(
      ipc?.calls.filter(
        (c) =>
          c.cmd !== "node_probe" &&
          c.cmd !== "node_settings" &&
          c.cmd !== "node_pending_screen" &&
          !c.cmd.startsWith("plugin:event"),
      ),
    ).toEqual([]);
  });

  it("Back returns to Service, the section the door stood on", async () => {
    // Operator ruling 2026-09-22, from the running window: "the back button
    // in register this machine coming from re-enroll goes back to the
    // control plane instead of the service".
    await boot();
    fireEvent.click(button("Re-enroll…"));
    await screen.findByRole("heading", { name: "Register This Machine" });
    fireEvent.click(button("Back"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Service" })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Control Plane" })).toBeNull();
    expect(buttonOrNull("Re-enroll…")).not.toBeNull();
  });

  it("the card renders no form surface at all", async () => {
    await boot();
    expect(screen.queryByText("Control plane this node reports to")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still states the address and its loopback warning", async () => {
    await boot({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    expect(screen.getByText("http://localhost:3080")).toBeTruthy();
    const notice = screen.getByRole("status", { name: /loopback/i });
    expect(notice.textContent).toMatch(/this machine/i);
  });

  it("is not offered on a machine that is not a node — there the door is Register", async () => {
    await boot({
      probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }),
    });
    expect(screen.queryByText("Enrolled to Control Plane")).toBeNull();
    expect(buttonOrNull("Re-enroll…")).toBeNull();
    expect(buttonOrNull("Register this machine")).not.toBeNull();
  });
});

const buttonOrNull = (name: string | RegExp) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;
