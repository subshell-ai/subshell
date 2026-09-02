import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TitleDialog } from "@/components/ui/title-dialog";

/** Records mutation requests; answers every call with `{ ok: true }`. */
function mockFetch() {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ method: init?.method ?? "GET", url: url.pathname, body: init?.body as string | undefined });
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog(overrides: Partial<{ currentName: string; onOpenChange: (o: boolean) => void }> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TitleDialog
        sessionId="id-1"
        currentName={overrides.currentName ?? "Old title"}
        open
        onOpenChange={overrides.onOpenChange ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole("button", { name: "Save title" }) as HTMLButtonElement;

describe("TitleDialog", () => {
  afterEach(cleanup);

  it("saves a trimmed rename via PATCH and closes", async () => {
    let closed = false;
    const { calls, restore } = mockFetch();
    try {
      renderDialog({ onOpenChange: (o) => (closed = !o) });
      fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), {
        target: { value: "  New title  " },
      });
      fireEvent.click(saveButton());
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "PATCH",
          url: "/api/sessions/id-1/name",
          body: JSON.stringify({ name: "New title" }),
        }),
      );
      await waitFor(() => expect(closed).toBe(true));
    } finally {
      restore();
    }
  });

  it("Save is disabled while the draft is blank or unchanged", () => {
    const { restore } = mockFetch();
    try {
      renderDialog();
      expect(saveButton().disabled).toBe(true); // unchanged (prefilled)
      fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), { target: { value: "   " } });
      expect(saveButton().disabled).toBe(true); // blank
      fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), { target: { value: "Other" } });
      expect(saveButton().disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it("a >max draft is blocked with an inline message (input caps at 120)", () => {
    const { restore } = mockFetch();
    try {
      renderDialog();
      const input = screen.getByRole("textbox", { name: "New session title" }) as HTMLInputElement;
      expect(input.maxLength).toBe(120);
      // fireEvent bypasses the DOM maxlength, exercising the component guard:
      fireEvent.change(input, { target: { value: "x".repeat(121) } });
      expect(screen.getByText("Keep it under 120 characters")).toBeDefined();
      expect(saveButton().disabled).toBe(true);
    } finally {
      restore();
    }
  });
});
