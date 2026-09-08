/**
 * Repointing an enrolled node at a different control plane.
 *
 * The gap this closes: `serverUrl` was written once, by `enroll`, and the only
 * way to change it was to enroll again — which overwrites `config.json`, mints
 * a SECOND node row on the plane, spends a single-use setup key and discards
 * the node key whose only home was that file. "The server moved" is an
 * ordinary event (it is what fixing a loopback address IS), and it had no
 * non-destructive answer.
 *
 * The second half is coherence. This app holds two addresses — its own
 * `planeUrl` and the node's `serverUrl` — and every surface showed one of
 * them, so a drift was invisible.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

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
  return ipc;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const ok = () => ({ ok: true, stdout: "node repointed", stderr: "" });

/** Open the repoint field and submit `url`. */
async function repointTo(url: string) {
  fireEvent.click(button("Repoint this node…"));
  const field = await screen.findByLabelText(/control plane this node reports to/i);
  fireEvent.change(field, { target: { value: url } });
  fireEvent.click(button("Repoint"));
}

describe("repointing a node", () => {
  it("sends the typed address to node_configure", async () => {
    const fake = await boot({ handlers: { node_configure: ok } });
    await repointTo("https://new.example");
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]).toMatchObject({ server: "https://new.example" });
  });

  /**
   * `enroll` is the destructive one and it is what this must not be mistaken
   * for. No setup key is asked for, and none is sent.
   */
  it("never asks for or sends a setup key", async () => {
    const fake = await boot({ handlers: { node_configure: ok } });
    fireEvent.click(button("Repoint this node…"));
    expect(screen.queryByLabelText(/setup key/i)).toBeNull();
    const field = await screen.findByLabelText(/control plane this node reports to/i);
    fireEvent.change(field, { target: { value: "https://new.example" } });
    fireEvent.click(button("Repoint"));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]?.key).toBeUndefined();
    expect(fake.callsTo("node_enroll")).toEqual([]);
  });

  /**
   * The daemon reads its config at start, so the file alone changes nothing
   * about where subshells report until it restarts. Saying so is the whole
   * difference between "done" and "done, and still wrong until you act".
   */
  it("says a restart is what applies it, and that no setup key is spent", async () => {
    await boot({ handlers: { node_configure: ok } });
    fireEvent.click(button("Repoint this node…"));
    // Scoped to the form: "Restart" is also a service button on this page.
    const form = (await screen.findByLabelText(/control plane this node reports to/i)).closest("form");
    expect(form?.textContent).toMatch(/restart it afterwards/i);
    expect(form?.textContent).toMatch(/no setup key is spent/i);
  });

  /**
   * A repoint also rewrites this app's own stored plane address, so the plane
   * window moves too. That is a visible consequence of pressing this button
   * and the card is where the user is standing — saying it only in
   * `permissions/desktop.toml` tells the ACL and not the operator.
   */
  it("says that the app's own control-plane address moves with it", async () => {
    await boot({ handlers: { node_configure: ok } });
    fireEvent.click(button("Repoint this node…"));
    const form = (await screen.findByLabelText(/control plane this node reports to/i)).closest("form");
    expect(form?.textContent).toMatch(/this app|window/i);
  });

  it("shows the CLI's own refusal verbatim and does not clear the field", async () => {
    await boot({
      handlers: {
        node_configure: () => ({ ok: false, stdout: "", stderr: "subshell: --server must be http(s), got 'nope'" }),
      },
    });
    await repointTo("nope");
    expect(await screen.findByText(/--server must be http\(s\)/)).toBeTruthy();
  });

  it("seeds the field with the address the node currently reports to", async () => {
    await boot({ handlers: { node_configure: ok } });
    fireEvent.click(button("Repoint this node…"));
    const field = (await screen.findByLabelText(/control plane this node reports to/i)) as HTMLInputElement;
    expect(field.value).toBe("https://subshell.example.com");
  });

  /**
   * The enroll-time loopback trap, at rest. A node pointed at `localhost`
   * dials a control plane on ITS OWN machine — right when the plane runs here,
   * wrong whenever the address was copied from a browser somewhere else, and
   * invisible either way. It moved here with the address it describes.
   */
  it("flags a loopback address without calling it an error", async () => {
    await boot({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    const notice = await screen.findByRole("status", { name: /loopback/i });
    expect(notice.textContent).toMatch(/this machine/i);
    // Still repointable — a warning, not a refusal.
    expect(button("Repoint this node…")).toBeTruthy();
  });

  it("says nothing about loopback for a real address", async () => {
    await boot();
    expect(screen.queryByRole("status", { name: /loopback/i })).toBeNull();
  });

  it("is not offered on a machine that is not a node — there is nothing to repoint", async () => {
    await boot({
      probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }),
    });
    expect(screen.queryByRole("button", { name: "Repoint this node…" })).toBeNull();
  });
});

describe("plane/node address coherence", () => {
  /** Enrolled against one plane, with the app pointed at another. */
  const diverged = {
    probe: makeProbe(),
    settings: makeSettings({ planeUrl: "https://elsewhere.example" }),
  };

  it("names BOTH addresses when they disagree", async () => {
    await boot(diverged);
    const notice = await screen.findByRole("status", { name: /mismatch/i });
    expect(notice.textContent).toContain("https://elsewhere.example");
    expect(notice.textContent).toContain("https://subshell.example.com");
  });

  /**
   * The quick fix rewrites `config.json`, and `probe.status.serverUrl` is read
   * from that file — so the mismatch banner vanishes on the next probe while
   * the RUNNING daemon is still attached to the old plane. Subshells started
   * meanwhile keep appearing there with nothing on screen explaining why. The
   * edit form says a restart is needed; this button has to as well.
   */
  it("says a restart is needed, since the banner clears before the daemon moves", async () => {
    await boot({ ...diverged, handlers: { node_configure: ok } });
    const notice = await screen.findByRole("status", { name: /mismatch/i });
    expect(notice.textContent).toMatch(/restart/i);
  });

  it("offers to repoint the node at the address this app is showing", async () => {
    const fake = await boot({ ...diverged, handlers: { node_configure: ok } });
    const notice = await screen.findByRole("status", { name: /mismatch/i });
    fireEvent.click(within(notice).getByRole("button", { name: /use https:\/\/elsewhere\.example/i }));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]).toMatchObject({ server: "https://elsewhere.example" });
  });

  /**
   * A repoint keeps `nodeId` and the node key, so it only works when the two
   * addresses are ONE control plane under two names — which is the common case
   * (loopback vs a LAN name) and the whole reason this feature exists. Against
   * a genuinely DIFFERENT plane, `/ws/node` refuses the socket 401 ("Invalid,
   * disabled, or expired node key" — `node-ws-handler.ts`) and the node just
   * goes offline, with the reason only in the agent's log. The notice cannot
   * tell the two cases apart, so it must not imply the button is always safe.
   */
  it("warns that repointing only works if both names are one plane", async () => {
    await boot(diverged);
    const notice = await screen.findByRole("status", { name: /mismatch/i });
    expect(notice.textContent).toMatch(/same control plane|one control plane/i);
    expect(notice.textContent).toMatch(/offline|refuse/i);
    expect(notice.textContent).toMatch(/enrol/i);
  });

  it("says nothing when the two agree", async () => {
    await boot({ probe: makeProbe(), settings: makeSettings({ planeUrl: "https://subshell.example.com" }) });
    expect(screen.queryByRole("status", { name: /mismatch/i })).toBeNull();
  });

  /**
   * An un-enrolled client has no `serverUrl`, and a CLI-enrolled machine has no
   * stored `planeUrl` until it opens one. Both are ordinary; a notice on either
   * would fire on a fresh install.
   */
  it("says nothing when only one address is known", async () => {
    await boot({ probe: makeProbe(), settings: makeSettings({ planeUrl: null }) });
    expect(screen.queryByRole("status", { name: /mismatch/i })).toBeNull();
  });

  /**
   * Both notices at once — a node still pointed at loopback while the app has
   * been aimed at a LAN address, which is the exact state someone is in
   * halfway through fixing this. They are two independent facts and both have
   * to be readable, so the queries here are deliberately label-specific:
   * `/control plane/i` matches BOTH aria-labels, which would make a
   * `findByRole` throw "found multiple elements" rather than fail an
   * assertion.
   */
  it("shows the loopback and mismatch notices together, each addressable on its own", async () => {
    await boot({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
      settings: makeSettings({ planeUrl: "http://box.local:3080" }),
    });
    const loopback = await screen.findByRole("status", { name: /loopback/i });
    const mismatch = await screen.findByRole("status", { name: /mismatch/i });
    expect(loopback).not.toBe(mismatch);
    expect(loopback.textContent).toMatch(/this machine/i);
    expect(mismatch.textContent).toContain("http://box.local:3080");
    expect(mismatch.textContent).toContain("http://localhost:3080");
  });
});
