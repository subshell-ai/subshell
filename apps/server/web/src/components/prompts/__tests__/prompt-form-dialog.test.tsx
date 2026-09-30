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

function renderDialog(props: { onSaved?: () => void; onClose?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromptFormDialog open onOpenChange={() => props.onClose?.()} onSaved={props.onSaved} />
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
    expect(createButton().disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    // Description alone is not enough — the body is still required.
    fireEvent.change(descriptionField(), { target: { value: "Kickoff" } });
    fireEvent.blur(descriptionField());
    expect(createButton().disabled).toBe(true);
    // Both filled: the gate opens.
    fireEvent.change(bodyField(), { target: { value: "start the task" } });
    expect(createButton().disabled).toBe(false);
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
    expect(createButton().disabled).toBe(true);
    fireEvent.change(bodyField(), { target: { value: "start the task" } });
    expect(createButton().disabled).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(m.posts.length).toBe(1));
    expect(m.posts[0]).toEqual({ description: "Kickoff", body: "start the task", shared: false });
    await waitFor(() => expect(saved).toBe(true));
  });
});
