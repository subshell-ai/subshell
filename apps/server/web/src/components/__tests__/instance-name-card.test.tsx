import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstanceNameCard } from "@/components/instance-name-card";

/** Records what the card PATCHes, and answers as the server would. */
function stubFetch(resolved: (sent: string) => string): { sent: string[] } {
  const sent: string[] = [];
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { instanceName?: string };
    sent.push(body.instanceName ?? "");
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/api/settings")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify({ instanceName: resolved(body.instanceName ?? "") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { sent };
}

const restore: (() => void)[] = [];

/** The card seeds from the shared public-settings cache, so no fetch on mount. */
function renderCard(instanceName: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["settings-public"], {
    allowRegistrations: false,
    emergencyLoginActive: false,
    instanceName,
    appBaseUrl: "http://localhost:3080",
    viewerIsAdmin: true,
    serverVersion: "0.0.0",
  });
  render(
    <QueryClientProvider client={qc}>
      <InstanceNameCard />
    </QueryClientProvider>,
  );
  return qc;
}

describe("InstanceNameCard", () => {
  afterEach(() => {
    cleanup();
    for (const undo of restore.splice(0)) undo();
  });

  it("seeds the field from the instance's current name", () => {
    renderCard("Prod plane");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Prod plane");
  });

  it("saves a new name", async () => {
    const { sent } = stubFetch((s) => s);
    renderCard("theo-desktop");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Prod plane" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toContain("Prod plane"));
    await waitFor(() => expect(screen.queryByText("saved")).not.toBeNull());
  });

  it("saves on Enter as well as the button", async () => {
    const { sent } = stubFetch((s) => s);
    renderCard("theo-desktop");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Homelab" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    await waitFor(() => expect(sent).toContain("Homelab"));
  });

  it("re-seeds from the SERVER's answer, so a cleared field shows the resolved default", async () => {
    // Blank means "back to the default", and only the server knows what that
    // resolved to — the field must never be left showing the empty string.
    stubFetch((s) => s || "theo-desktop");
    renderCard("Prod plane");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("theo-desktop"),
    );
  });

  it("reports a failed save instead of implying it worked", async () => {
    const original = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof globalThis.fetch;
    renderCard("theo-desktop");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Prod plane" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't save/)).not.toBeNull());
    expect(screen.queryByText("saved")).toBeNull();
  });
});
