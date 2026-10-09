import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServerIdentityRecovery } from "@/components/ssh/server-identity-recovery";

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});
async function mount(admin = true, inspectionFails = false) {
  const state = {
    failRepair: true,
    inspectionFails,
    matches: false,
    own: { signing: "SHA256:disk-sign", encryption: "SHA256:disk-encrypt" },
  };
  const posts: unknown[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body =
      path === "/api/settings/public"
        ? { viewerIsAdmin: admin }
        : path.endsWith("/repair")
          ? { repaired: true }
          : {
              own: state.own,
              registered: { signing: "SHA256:old-sign", encryption: "SHA256:old-encrypt" },
              matches: state.matches,
            };
    if (method === "POST") {
      posts.push(JSON.parse(String(init?.body)));
      if (state.failRepair)
        return new Response(JSON.stringify({ message: "Another identity repair is already in progress." }), {
          status: 409,
        });
      state.matches = true;
    }
    if (path.endsWith("/ssh-identity") && state.inspectionFails)
      return new Response(JSON.stringify({ message: "Corrupt identity file" }), { status: 503 });
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ServerIdentityRecovery />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return { state, posts, client };
}
it("requires verified current disk fingerprints, permits retry409, and never repairs peer pins", async () => {
  const { state, posts } = await mount();
  const button = screen.getByRole("button", { name: "Repair server identity registration" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText("SHA256:disk-sign")).toBeTruthy();
  expect(screen.getByText("SHA256:old-sign")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "I verified both disk fingerprints through a trusted channel" }),
  );
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByText(/Another identity repair is already in progress/);
  expect(posts).toEqual([{ signing: "SHA256:disk-sign", encryption: "SHA256:disk-encrypt" }]);
  state.failRepair = false;
  fireEvent.click(button);
  await screen.findByText("Server identity registration repaired. Peer pins were not changed.");
  expect(posts).toHaveLength(2);
});
it("does not inspect or expose recovery to members", async () => {
  const { posts } = await mount(false);
  expect(screen.queryByText("Server SSH identity recovery")).toBeNull();
  expect(posts).toEqual([]);
});
it("failed inspection offers retry and names valid-backup recovery instead of blessing corrupt files", async () => {
  const { state } = await mount(true, true);
  expect(screen.getByText(/A corrupt identity must be restored from a valid backup/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Repair server identity registration" })).toBeNull();
  state.inspectionFails = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry identity inspection" }));
  await screen.findByRole("button", { name: "Repair server identity registration" });
});

for (const changed of ["signing", "encryption"] as const) {
  it(`requires fresh verification when the disk ${changed} fingerprint changes`, async () => {
    const { state, posts } = await mount();
    const checkbox = screen.getByRole("checkbox", {
      name: "I verified both disk fingerprints through a trusted channel",
    });
    const button = screen.getByRole("button", { name: "Repair server identity registration" }) as HTMLButtonElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(button.disabled).toBe(false));
    state.own = { ...state.own, [changed]: "SHA256:replacement" };
    fireEvent.click(screen.getByRole("button", { name: "Retry identity inspection" }));
    await screen.findByText("SHA256:replacement");
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(button);
    expect(posts).toEqual([]);
    fireEvent.click(checkbox);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Another identity repair is already in progress/);
    expect(posts).toEqual([state.own]);
  });
}

it("refuses stale consent when query data changes before the reset effect can run", async () => {
  const { client, posts } = await mount();
  const button = screen.getByRole("button", { name: "Repair server identity registration" }) as HTMLButtonElement;
  fireEvent.click(
    screen.getByRole("checkbox", { name: "I verified both disk fingerprints through a trusted channel" }),
  );
  await waitFor(() => expect(button.disabled).toBe(false));
  await act(async () => {
    client.setQueryData(["server-ssh-identity"], {
      own: { signing: "SHA256:new-sign", encryption: "SHA256:new-encrypt" },
      registered: null,
      matches: false,
    });
    fireEvent.click(button);
  });
  expect(posts).toEqual([]);
  await waitFor(() => expect(button.disabled).toBe(true));
});
