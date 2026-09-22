/**
 * Re-enroll… IS repointing, and it lives on Service now (operator ruling
 * 2026-09-22: the Control Plane section connects to planes, the Service
 * section IS a node). The card states the address this machine's node
 * reports to; the button opens a free-form field and the press goes through
 * `node_configure`.
 *
 * The gap this closes was the destructive one: `serverUrl` used to be
 * written only by `enroll`, and the way to change it was to enroll again —
 * which overwrites `config.json`, mints a SECOND node row, spends a
 * single-use setup key and discards the node key whose only home was that
 * file. "The server moved" is an ordinary event (it is what fixing a
 * loopback address IS), and `configure` answers it non-destructively:
 * identity kept, no key spent.
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

/** Reach the Service section and open the re-enroll field. */
async function openRepointForm() {
  fireEvent.click(button("Service"));
  await screen.findByRole("heading", { name: "Service" });
  await waitFor(() => expect(buttonOrNull("Re-enroll…")).not.toBeNull());
  fireEvent.click(button("Re-enroll…"));
  await screen.findByLabelText("Control plane this node reports to");
}

const buttonOrNull = (name: string | RegExp) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;

describe("re-enroll, which is repointing", () => {
  it("sends the typed address to node_configure", async () => {
    const fake = await boot({ handlers: { node_configure: ok } });
    await openRepointForm();
    const field = screen.getByLabelText("Control plane this node reports to") as HTMLInputElement;
    // Seeded: a re-enroll is usually one character from the address there.
    expect(field.value).toBe("https://subshell.example.com");
    fireEvent.change(field, { target: { value: "https://new.example" } });
    fireEvent.click(button("Re-enroll"));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]).toMatchObject({ server: "https://new.example" });
    // A submit closes, success or not: the card is the feedback.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * `enroll` is the destructive one and it is what this must not be mistaken
   * for. No setup key is asked for, and none is sent.
   */
  it("never asks for or sends a setup key", async () => {
    const fake = await boot({ handlers: { node_configure: ok } });
    await openRepointForm();
    expect(screen.queryByLabelText(/setup key/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Control plane this node reports to"), {
      target: { value: "https://new.example" },
    });
    fireEvent.click(button("Re-enroll"));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));
    expect(fake.callsTo("node_configure")[0]?.key).toBeUndefined();
    expect(fake.callsTo("node_enroll")).toEqual([]);
  });

  /**
   * The daemon reads its config at start, so the file alone changes nothing
   * until it restarts. And a repoint keeps the node id and node key, so it
   * works when the addresses are one plane under two names; a genuinely
   * different plane 401s the socket and the node goes offline. Both facts
   * sit in the form's help, because both are the difference between "done"
   * and "done, and still wrong until you act".
   */
  it("says a restart applies it and no setup key is spent", async () => {
    await boot({ handlers: { node_configure: ok } });
    await openRepointForm();
    const help = screen.getByText(/re-enrolling points the node/i);
    expect(help.textContent).toMatch(/identity is kept and no setup key is spent/i);
    expect(help.textContent).toMatch(/when it restarts/i);
  });

  it("closes on submit and shows the CLI's own refusal verbatim on the card", async () => {
    await boot({
      handlers: {
        node_configure: () => ({ ok: false, stdout: "", stderr: "subshell: --server must be http(s), got 'nope'" }),
      },
    });
    await openRepointForm();
    fireEvent.change(screen.getByLabelText("Control plane this node reports to"), { target: { value: "nope" } });
    fireEvent.click(button("Re-enroll"));
    expect(await screen.findByText(/--server must be http\(s\)/)).toBeTruthy();
    // The live-window ruling on the dialog's first cut: a modal that stays
    // open after submit is zero feedback whatever the answer was. Submit
    // closes it; the refusal is this section's output block, in the CLI's
    // words; the retry opens the field seeded with the address that DID
    // work — the bad string is quoted back by the refusal itself.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button("Re-enroll…"));
    expect((screen.getByLabelText("Control plane this node reports to") as HTMLInputElement).value).toBe(
      "https://subshell.example.com",
    );
  });

  /**
   * The enroll-time loopback trap, at rest. A node pointed at `localhost`
   * dials a control plane on ITS OWN machine — right when the plane runs
   * here, wrong whenever the address was copied from a browser somewhere
   * else, and invisible either way. It moved here with the address.
   */
  it("flags a loopback address without refusing anything", async () => {
    await boot({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    await openRepointForm();
    const notice = screen.getByRole("status", { name: /loopback/i });
    expect(notice.textContent).toMatch(/this machine/i);
    // A warning, not a refusal: the seeded loopback address is still a
    // submittable value.
    expect(button("Re-enroll").disabled).toBe(false);
  });

  it("says nothing about loopback for a real address", async () => {
    await boot();
    await openRepointForm();
    expect(screen.queryByRole("status", { name: /loopback/i })).toBeNull();
  });

  it("is not offered on a machine that is not a node — there is nothing to repoint", async () => {
    await boot({
      probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }),
    });
    fireEvent.click(button("Service"));
    await screen.findByRole("heading", { name: "Service" });
    expect(screen.queryByText(/enrolled to control plane/i)).toBeNull();
    expect(buttonOrNull("Re-enroll…")).toBeNull();
  });

  /**
   * The ruling's split, asserted from this side: changing the app's CONNECT
   * list is not moving the node. The plane section adds a row
   * (`node_plane_add`); only this card's press writes the node's config.
   */
  it("keeps saving a plane address from touching the node", async () => {
    const fake = await boot({
      settings: makeSettings({ planes: [] }),
      handlers: { node_plane_add: () => ["https://elsewhere.example"] },
    });
    fireEvent.click(button("Control Plane"));
    await screen.findByRole("heading", { name: "Control Plane" });
    fireEvent.click(button("Add a control plane…"));
    fireEvent.change(screen.getByLabelText("Control plane URL"), { target: { value: "https://elsewhere.example" } });
    fireEvent.click(button("Add"));
    await waitFor(() => expect(fake.callsTo("node_plane_add").length).toBe(1));
    expect(fake.callsTo("node_configure")).toEqual([]);
  });
});
