import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { SshScreen } from "@/components/assistant/ssh-screen";
import { type FakeIpc, installFakeIpc, renderApp } from "./harness";

let ipc: FakeIpc | undefined;
afterEach(() => {
  cleanup();
  ipc?.restore();
});
it("requires explicit server trust and clears the one-use pairing code after connecting", async () => {
  ipc = installFakeIpc({
    handlers: { node_ssh_connections: () => [], node_ssh_connect: () => ({ id: "desktop:one" }) },
  });
  renderApp(<SshScreen shell={{ title: "SSH Connections" }} onBack={() => {}} initialServer="https://plane.test" />);
  fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "dsp_secret" } });
  expect((screen.getByRole("button", { name: "Connect this computer" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Connect this computer" }));
  await waitFor(() =>
    expect(ipc?.callsTo("node_ssh_connect")).toEqual([
      { server: "https://plane.test", pairingToken: "dsp_secret", brokerId: null, confirm: true },
    ]),
  );
  await waitFor(() => expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe(""));
  expect(ipc.callsTo("node_enroll")).toEqual([]);
});
it("reconnects a saved origin without asking for another pairing code", async () => {
  ipc = installFakeIpc({
    handlers: {
      node_ssh_connections: () => [
        { id: "desktop:one", server: "https://plane.test", name: "Laptop", connected: false },
      ],
      node_ssh_connect: () => ({ id: "desktop:one" }),
    },
  });
  renderApp(<SshScreen shell={{ title: "SSH Connections" }} onBack={() => {}} initialServer="" />);
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  await waitFor(() =>
    expect(ipc?.callsTo("node_ssh_connect")).toEqual([
      { server: "https://plane.test", pairingToken: null, brokerId: "desktop:one", confirm: true },
    ]),
  );
});
