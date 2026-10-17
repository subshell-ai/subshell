import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PromptFormDialog } from "@/components/prompts/prompt-form-dialog";

/**
 * The saved-prompt editor (spec 2026-09-28), gated by the substrate sweep
 * (spec 2026-09-29): Create/Save is DISABLED until the one promptDraftSchema
 * is satisfied, and the field sentences replace the old press-to-learn flow.
 */

function mockFetch() {
  const realFetch = globalThis.fetch;
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/prompts" && method === "POST") {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(JSON.stringify({ id: "pr1" })));
    }
    return realFetch(input as never, init as never);
  }) as typeof fetch;
  return { posts, restore: () => (globalThis.fetch = realFetch) };
}

function renderDialog(
  props: {
    onSaved?: () => void;
    onClose?: () => void;
    editingId?: string;
    initial?: { description: string; body: string; shared: boolean };
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromptFormDialog
        open
        onOpenChange={() => props.onClose?.()}
        onSaved={props.onSaved}
        editingId={props.editingId}
        initial={props.initial}
      />
    </QueryClientProvider>,
  );
}

const createButton = () => screen.getByRole("button", { name: "Create prompt" }) as HTMLButtonElement;
const descriptionField = () => screen.getByLabelText("Description") as HTMLInputElement;
const bodyField = () => screen.getByLabelText("Prompt") as HTMLTextAreaElement;

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  sessionStorage.clear();
  cleanup();
});

describe("PromptFormDialog gating", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("is DISABLED until BOTH description and body are filled", () => {
    restore = mockFetch().restore;
    renderDialog();
    // Pristine: no fields filled, no red sentences.
    expect(createButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    // Description alone is not enough — the body is still required.
    fireEvent.change(descriptionField(), { target: { value: "Kickoff" } });
    fireEvent.blur(descriptionField());
    expect(createButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
    // Both filled: the gate opens.
    fireEvent.change(bodyField(), { target: { value: "start the task" } });
    expect(createButton().matches(":disabled, [aria-disabled=true]")).toBe(false);
  });

  it("the empty-description sentence shows on blur, before any press", () => {
    restore = mockFetch().restore;
    renderDialog();
    fireEvent.change(descriptionField(), { target: { value: "  " } });
    fireEvent.blur(descriptionField());
    expect(screen.getByRole("alert").textContent).toContain("A short description is required");
  });

  it("submits once the gate opens (the guard still runs behind it)", async () => {
    const m = mockFetch();
    restore = m.restore;
    let saved = false;
    renderDialog({ onSaved: () => (saved = true) });
    fireEvent.change(descriptionField(), { target: { value: "Kickoff" } });
    fireEvent.change(bodyField(), { target: { value: "  " } }); // trimmed-empty: gate closed
    expect(createButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
    fireEvent.change(bodyField(), { target: { value: "start the task" } });
    expect(createButton().matches(":disabled, [aria-disabled=true]")).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(m.posts.length).toBe(1));
    expect(m.posts[0]).toEqual({ description: "Kickoff", body: "start the task", shared: false });
    await waitFor(() => expect(saved).toBe(true));
  });
});

describe("PromptFormDialog edit mode", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("starts dead, opens on a real edit, and re-deadens when the edit is reverted", () => {
    // The unchanged-draft rule on the prompt editor. Create mode cannot see
    // this path at all (its fields start empty), so edit mode is pinned here:
    // a dialog that opens already valid used to offer Save for a draft that
    // differed from the stored row by nothing.
    const realFetch = globalThis.fetch;
    const puts: Record<string, unknown>[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prompts/pr1" && (init?.method ?? "GET") === "PUT") {
        puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = realFetch;
    };
    renderDialog({ editingId: "pr1", initial: { description: "Kickoff", body: "start the task", shared: false } });
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(save().getAttribute("aria-description")).toBe("No changes to save.");
    fireEvent.change(descriptionField(), { target: { value: "Kickoff v2" } });
    expect(save().matches(":disabled, [aria-disabled=true]")).toBe(false);
    fireEvent.change(descriptionField(), { target: { value: "Kickoff" } });
    expect(save().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("sends the edited draft as a PUT and reports done", async () => {
    // The other half of the edit-mode loop: a REAL change lights Save, and the
    // press rides the wire once with the full replacement draft (PUT is a
    // complete replacement of the fields, so the body must carry all three).
    const realFetch = globalThis.fetch;
    const puts: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/prompts/pr1" && (init?.method ?? "GET") === "PUT") {
        puts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    let saved = false;
    try {
      renderDialog({
        editingId: "pr1",
        initial: { description: "Kickoff", body: "start the task", shared: false },
        onSaved: () => {
          saved = true;
        },
      });
      fireEvent.change(bodyField(), { target: { value: "start the task now" } });
      const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save().matches(":disabled, [aria-disabled=true]")).toBe(false);
      fireEvent.click(save());
      await waitFor(() => {
        expect(puts).toHaveLength(1);
        expect(puts[0]?.body).toEqual({ description: "Kickoff", body: "start the task now", shared: false });
        expect(saved).toBe(true);
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
