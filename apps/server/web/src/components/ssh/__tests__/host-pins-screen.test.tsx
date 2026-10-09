import { afterEach, describe, expect, it } from "bun:test";
import { type ConfirmOptions, setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HostPinsScreen } from "@/components/ssh/host-pins-screen";

/**
 * Destination trust (spec 2026-10-08 §9): the caller's host-key pins as
 * destination + `SHA256:` fingerprint (the key line itself never reaches the
 * screen), the delete that forces a fresh-grant TOFU re-capture, and the
 * explicit-pin door the F2 HostKeyAlias gap runs out of. The add dialog's
 * title is static; the destination the person types rides its body.
 */

const FP_HOST = `SHA256:${"C".repeat(43)}`;
const DEST = "theo@build.example.com:22";
const HOST_KEY = "build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinkeypinkeypinkeypinkeypin";

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function stubFetch(
  restore: (undo: () => void) => void,
  opts: { addStatus?: number; addMessage?: string } = {},
): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  restore(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/ssh/host-pins" && method === "GET") {
      return new Response(
        JSON.stringify({
          pins: [
            {
              id: "p1",
              destination: DEST,
              fingerprint: FP_HOST,
              createdAt: "2026-10-01T10:00:00Z",
              updatedAt: "2026-10-07T09:00:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/ssh/host-pins" && method === "POST") {
      if (opts.addStatus) {
        return new Response(JSON.stringify({ message: opts.addMessage ?? "refused" }), {
          status: opts.addStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ pin: {} }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return sent;
}

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restores.splice(0)) undo();
});

function mockConfirm(answer: boolean) {
  const seen: ConfirmOptions[] = [];
  const previous = setConfirmHandler((options) => {
    seen.push(options);
    return Promise.resolve(answer);
  });
  return { seen, restore: () => setConfirmHandler(previous) };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HostPinsScreen />
    </QueryClientProvider>,
  );
}

describe("HostPinsScreen", () => {
  it("displays each pinned destination with its SHA256 fingerprint", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    expect(await screen.findByText(DEST)).toBeDefined();
    expect(screen.getByText(FP_HOST)).toBeDefined();
  });

  it("deletes through a static-titled confirm, keyed by the destination", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    const confirm = mockConfirm(true);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: `Remove pin for ${DEST}` }));
    await waitFor(() => expect(confirm.seen.length).toBe(1));
    expect(confirm.seen[0]?.title).toBe("Remove this pin?");
    expect(confirm.seen[0]?.description).toContain(DEST);
    await waitFor(() =>
      expect(sent.some((s) => s.method === "DELETE" && s.path === `/api/ssh/host-pins/${encodeURIComponent(DEST)}`)),
    );
  });

  it("opens a static-titled add dialog whose body carries the typed data", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Add destination pin" }));
    // Static dialog title (ruling 2026-09-30): nothing typed moves the heading.
    expect(await screen.findByRole("heading", { name: "Add destination pin" })).toBeDefined();
    fireEvent.change(screen.getByLabelText(/Destination/), { target: { value: DEST } });
    fireEvent.change(screen.getByLabelText(/Host key/), { target: { value: HOST_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Add pin" }));
    await waitFor(() => expect(sent.some((s) => s.method === "POST" && s.path === "/api/ssh/host-pins")).toBe(true));
    expect(sent.find((s) => s.method === "POST" && s.path === "/api/ssh/host-pins")?.body).toEqual({
      destination: DEST,
      hostKey: HOST_KEY,
    });
  });

  it("renders the server's refusal of an add as a red line", async () => {
    stubFetch(
      (undo) => {
        restores.push(undo);
      },
      {
        addStatus: 409,
        addMessage: "That destination is pinned to a different key",
      },
    );
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Add destination pin" }));
    fireEvent.change(await screen.findByLabelText(/Destination/), { target: { value: DEST } });
    fireEvent.change(screen.getByLabelText(/Host key/), { target: { value: HOST_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Add pin" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("pinned to a different key");
    expect(alert.className).toContain("text-destructive");
  });

  it("says what removing a pin does", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    expect(await screen.findByText(/Verify a replacement key/)).toBeDefined();
  });
});
