import { afterEach, expect, it } from "bun:test";
import { DEFAULT_PREVIEW_CONFIGURATION } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewConfigurationForm, UNSANDBOXED_WARNING } from "../preview-configuration-form";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function mount(props: Partial<Parameters<typeof PreviewConfigurationForm>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
  return render(
    <QueryClientProvider client={client}>
      <PreviewConfigurationForm subshellId="pane" port={8006} onBack={() => {}} onOpen={() => {}} {...props} />
    </QueryClientProvider>,
  );
}
it("opens a discovered item with explicit configuration without saving it", async () => {
  let opened: unknown;
  mount({
    onOpen: (view) => {
      opened = view;
    },
  });
  const sandbox = screen.getByRole("checkbox", { name: "Run outside the sandbox" });
  expect(sandbox.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(sandbox);
  expect(screen.getByText(UNSANDBOXED_WARNING).classList.contains("text-warning")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  await waitFor(() =>
    expect(opened).toEqual({
      kind: "app",
      port: 8006,
      configuration: { ...DEFAULT_PREVIEW_CONFIGURATION, sandbox: false },
    }),
  );
});
it("saves the name and all chosen options before opening", async () => {
  let body: Record<string, unknown> | undefined;
  let opened: unknown;
  mount({
    onOpen: (view) => {
      opened = view;
    },
  });
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") {
      body = JSON.parse(String(init.body));
      return Response.json({ ...body, id: "service" });
    }
    return Response.json([]);
  }) as unknown as typeof fetch;
  fireEvent.click(screen.getByRole("checkbox", { name: "Save this configuration" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name (optional)" }), { target: { value: "Proxmox" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Rewrite app URLs" }));
  fireEvent.click(screen.getByRole("button", { name: "Save and open" }));
  await waitFor(() => expect(body?.name).toBe("Proxmox"));
  expect(body?.configuration).toEqual({ ...DEFAULT_PREVIEW_CONFIGURATION, rewriteUrls: false });
  await waitFor(() => expect(opened).toMatchObject({ kind: "service", serviceId: "service" }));
});
it("edits a saved service in place and does not open on cancel", async () => {
  let method = "";
  let body: Record<string, unknown> | undefined;
  let saved = false;
  mount({
    mode: "edit",
    service: { id: "svc", name: "Old", host: "localhost", protocol: "http", port: 3000 },
    onSaved: () => {
      saved = true;
    },
  });
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      method = init.method;
      body = JSON.parse(String(init.body));
      return Response.json({ ...body, id: "svc" });
    }
    return Response.json([]);
  }) as unknown as typeof fetch;
  fireEvent.change(screen.getByRole("textbox", { name: "Name (optional)" }), { target: { value: "New" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saved).toBe(true));
  expect(method).toBe("PUT");
  expect(body?.name).toBe("New");
});

it("opens a changed saved destination as a one-off preview", async () => {
  let opened: unknown;
  mount({
    service: { id: "svc", name: "Saved", host: "localhost", port: 3000, protocol: "http", revision: 4 },
    onOpen: (view) => {
      opened = view;
    },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "3001" } });
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  await waitFor(() => expect(opened).toMatchObject({ kind: "app", port: 3001 }));
});
it("awaits opening and displays asynchronous failures", async () => {
  let rejectOpen: (error: Error) => void = () => {};
  const busy: boolean[] = [];
  mount({
    onBusyChange: (value) => {
      busy.push(value);
    },
    onOpen: () =>
      new Promise<void>((_resolve, reject) => {
        rejectOpen = reject;
      }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  await waitFor(() => expect(busy).toEqual([true]));
  expect(screen.getByRole("button", { name: "Back" }).getAttribute("aria-disabled")).toBe("true");
  rejectOpen(new Error("Could not connect"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not connect"));
  expect(busy).toEqual([true, false]);
});
