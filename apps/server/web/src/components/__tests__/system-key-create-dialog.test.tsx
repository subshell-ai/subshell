import { afterEach, describe, expect, it } from "bun:test";
import { API_KEY_PERMISSION_GROUPS, API_KEY_PERMISSIONS } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { SystemKeyCreateDialog } from "@/components/system-key-create-dialog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <SystemKeyCreateDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe("system key permissions", () => {
  it("starts unchecked, submits the explicit opt-in, and resets after closing", async () => {
    const requests: unknown[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "key-id", key: "subshell_test" }));
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    const submit = screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement;
    expect(screen.getAllByRole("checkbox").every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "fleet" } });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    const checkbox = screen.getByRole("checkbox", { name: "Enroll nodes" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "fleet" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(screen.getByText("Key created")).toBeDefined());
    expect(requests).toEqual([{ name: "fleet", permissions: ["nodes:enroll"] }]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Select all permissions" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "ordinary" } });
    expect(screen.getByRole("button", { name: "Create key" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all in node provisioning" }));
    for (const permission of API_KEY_PERMISSION_GROUPS[0].permissions) {
      expect(screen.getByRole("checkbox", { name: permission.label }).getAttribute("aria-checked")).toBe("true");
    }
    const all = screen.getByRole("checkbox", { name: "Select all permissions" });
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(all);
    expect(screen.getByRole("alert")).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enroll nodes" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(all);
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect((requests[1] as { permissions: string[] }).permissions.toSorted()).toEqual([...API_KEY_PERMISSIONS].sort());
    client.clear();
  });
});

it("keeps the one-time secret visible when closing is attempted during creation", async () => {
  let finish: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return response;
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "fleet" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enroll nodes" }));
  fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  await waitFor(() => expect(requests).toBe(1));
  expect(screen.getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog") !== null).toBe(true);
  await act(async () => {
    finish(Response.json({ id: "pending-key", key: "subshell_pending_secret" }));
  });
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Key created" })).toBeDefined());
  expect(screen.getByText("subshell_pending_secret")).toBeDefined();
  expect(requests).toBe(1);
  client.clear();
});

it("explains clipboard failure without losing the displayed key", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("Permission denied");
      },
    },
  });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  globalThis.fetch = (async () =>
    Response.json({ id: "copy-key", key: "subshell_copy_secret" })) as unknown as typeof fetch;
  try {
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "fleet" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enroll nodes" }));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy API key" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Select and copy the text above"));
    expect(screen.getByText("subshell_copy_secret")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeDefined();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    client.clear();
  }
});
