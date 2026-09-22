/**
 * Re-enroll… IS repointing (operator ruling 2026-09-22, final addendum): the
 * Control Plane section shows ONE address, and the button presses it through
 * `node_configure`.
 *
 * The gap this closes was the old pair of addresses: `serverUrl` used to be
 * written only by `enroll`, and the way to change it was to enroll again —
 * which overwrites `config.json`, mints a SECOND node row, spends a
 * single-use setup key and discards the node key whose only home was that
 * file. "The server moved" is an ordinary event (it is what fixing a loopback
 * address IS), and `configure` answers it non-destructively: identity kept,
 * no key spent. It also rewrites this app's own stored `planeUrl`, which is
 * what makes ONE address honest.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

// Unmount after each test. Testing Library appends every `render` to
// `document.body`, and there is ONE document per bun test process — so a file
// that renders without unmounting leaves its DOM for whatever file bun shards
// into that process next, and a test asking a GLOBAL question
// (`getAllByRole("button")`) reads the leftovers as its own.
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
  return ipc;
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const ok = () => ({ ok: true, stdout: "node repointed", stderr: "" });

/**
 * The app pointed at one plane while this machine's node reports to another
 * — the only state that now shows a Re-enroll… door. Control Plane is the
 * landing, so a `boot` alone reaches the section; the wait is the settle
 * marker: the button rides the probe, which can land a beat after the screen.
 */
const diverged = { settings: makeSettings({ planeUrl: "https://elsewhere.example" }) };

async function openPlaneSection() {
  fireEvent.click(button("Control Plane"));
  await screen.findByRole("heading", { name: "Control Plane" });
}

describe("re-enroll, which is repointing", () => {
  it("sends the card's address to node_configure", async () => {
    const fake = await boot({ ...diverged, handlers: { node_configure: ok } });
    await waitFor(() => expect(button(/re-enroll…/i)).toBeTruthy());
    fireEvent.click(button("Re-enroll…"));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]).toMatchObject({ server: "https://elsewhere.example" });
  });

  /**
   * `enroll` is the destructive one and it is what this must not be mistaken
   * for. No setup key is asked for, and none is sent.
   */
  it("never asks for or sends a setup key", async () => {
    const fake = await boot({ ...diverged, handlers: { node_configure: ok } });
    await waitFor(() => expect(button(/re-enroll…/i)).toBeTruthy());
    expect(screen.queryByLabelText(/setup key/i)).toBeNull();
    fireEvent.click(button("Re-enroll…"));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]?.key).toBeUndefined();
    expect(fake.callsTo("node_enroll")).toEqual([]);
  });

  /**
   * The daemon reads its config at start, so the file alone changes nothing
   * about where subshells report until it restarts. And a repoint keeps the
   * node id and node key, so it works only when the two addresses are ONE
   * plane under two names (`/ws/node` 401s a foreign plane's key and the node
   * just goes offline). Both facts sit in the card's help, because both are
   * the difference between "done" and "done, and still wrong until you act".
   */
  it("says a restart applies it, that no setup key is spent, and that a different plane refuses", async () => {
    await boot({ ...diverged, handlers: { node_configure: ok } });
    await waitFor(() => expect(button(/re-enroll…/i)).toBeTruthy());
    const help = screen.getByText(/re-enroll points the node/i);
    expect(help.textContent).toMatch(/restarts?/i);
    expect(help.textContent).toMatch(/no setup key/i);
    expect(help.textContent).toMatch(/different control plane/i);
    expect(help.textContent).toMatch(/enrolls? there/i);
  });

  it("shows the CLI's own refusal verbatim, and the door survives it", async () => {
    const fake = await boot({
      ...diverged,
      handlers: {
        node_configure: () => ({ ok: false, stdout: "", stderr: "subshell: --server must be http(s), got 'x'" }),
      },
    });
    await waitFor(() => expect(button(/re-enroll…/i)).toBeTruthy());
    fireEvent.click(button("Re-enroll…"));
    expect(await screen.findByText(/--server must be http\(s\)/)).toBeTruthy();
    // Nothing was spent, so the press is repeatable: the stored address is
    // untouched and the door is still there after the runner settles.
    await waitFor(() => expect(button("Re-enroll…").disabled).toBe(false));
    expect(fake.callsTo("node_configure").length).toBe(1);
  });

  /**
   * The enroll-time loopback trap, at rest. A node pointed at `localhost`
   * dials a control plane on ITS OWN machine — right when the plane runs
   * here, wrong whenever the address was copied from a browser somewhere
   * else, and invisible either way.
   */
  it("flags a loopback address without calling it an error", async () => {
    await boot({
      ...diverged,
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    const notice = await screen.findByRole("status", { name: /loopback/i });
    expect(notice.textContent).toMatch(/this machine/i);
    // Still re-pointable — a warning, not a refusal.
    expect(button(/re-enroll…/i)).toBeTruthy();
  });

  it("says nothing about loopback for a real address", async () => {
    await boot();
    expect(screen.queryByRole("status", { name: /loopback/i })).toBeNull();
  });

  it("is not offered on a machine that is not a node — there is nothing to repoint", async () => {
    await boot({
      ...diverged,
      probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }),
    });
    expect(screen.queryByRole("button", { name: /re-enroll…/i })).toBeNull();
  });

  /**
   * The collapse's other half: agreement renders ONE quiet card. A button
   * that offered to rewrite the file with the address already in it, over a
   * machine that has nothing to fix, is exactly the complication the ruling
   * removed.
   */
  it("shows one address and no door when the two agree", async () => {
    await boot({ probe: makeProbe(), settings: makeSettings({ planeUrl: "https://subshell.example.com" }) });
    await openPlaneSection();
    expect(screen.queryByRole("button", { name: /re-enroll/i })).toBeNull();
    expect(screen.queryByText(/reports to/i)).toBeNull();
  });

  /**
   * A CLI-enrolled client has no stored `planeUrl` until it opens one. That
   * is an ordinary state, not a divergence: the card shows the node's own
   * address and repointing it AT itself would be theatre.
   */
  it("shows the node's address alone when the app has stored none", async () => {
    await boot({ probe: makeProbe(), settings: makeSettings({ planeUrl: null }) });
    await openPlaneSection();
    expect(screen.getAllByText("https://subshell.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /re-enroll/i })).toBeNull();
    expect(screen.queryByText(/reports to/i)).toBeNull();
  });

  /**
   * Changing this app's address is NOT moving the node; the two acts stay
   * separate even though they now share one card. The form saves
   * (`node_set_plane`); only Re-enroll… writes the node's config.
   */
  it("keeps a saved address change from touching the node", async () => {
    const fake = await boot({ handlers: { node_configure: ok } });
    await openPlaneSection();
    fireEvent.click(button("Change server…"));
    const field = await screen.findByLabelText("Control plane URL");
    fireEvent.change(field, { target: { value: "https://elsewhere.example" } });
    fireEvent.click(button("Change"));
    await waitFor(() => expect(fake.callsTo("node_set_plane").length).toBe(1));
    expect(fake.callsTo("node_configure")).toEqual([]);
  });
});
