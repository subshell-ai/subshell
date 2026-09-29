import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PromptPickerDialog } from "@/components/prompts/prompt-picker-dialog";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The shared prompt picker (spec 2026-09-28). The list is the searchable
 * combobox, whose Base UI popup opens on a real POINTER gesture, not a bare
 * click (happy-dom quirk pinned below in openSearch) so the tests lead with
 * pointer/mouse events the way the operator's mouse does. The pick must
 * COMMIT and close (decisive-action redesign, live report 2026-09-29), and
 * the custom draft must survive a reload until submitted (operator ruling
 * 2026-09-29).
 */

const ownRow = {
  id: "pr1",
  description: "Kickoff",
  body: "start the task now",
  shared: false,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};
const sharedRow = {
  id: "pr2",
  description: "Review",
  body: "check the diff",
  shared: true,
  ownerName: "Ada",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};

function mockFetch(own: unknown[] = [ownRow], shared: unknown[] = [sharedRow]) {
  const realFetch = globalThis.fetch;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/prompts" && method !== "POST") {
      return Promise.resolve(new Response(JSON.stringify({ own, shared })));
    }
    if (url === "/api/prompts" && method === "POST") {
      posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Promise.resolve(new Response(JSON.stringify(ownRow)));
    }
    return realFetch(input as never, init as never);
  }) as typeof fetch;
  return { posts, restore: () => (globalThis.fetch = realFetch) };
}

function renderPicker(props: {
  onPick: (block: PromptBlock) => void;
  onOpenChange?: (next: boolean) => void;
  mode?: "multi" | "single";
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromptPickerDialog
        open
        mode={props.mode ?? "multi"}
        onOpenChange={props.onOpenChange ?? (() => {})}
        onPick={props.onPick}
      />
    </QueryClientProvider>,
  );
}

/** The combobox popup opens on a real pointer gesture; a bare click does
 *  not reach Base UI's trigger in happy-dom. */
function openSearch(): void {
  const input = document.getElementById("prompt-picker-search");
  if (!input) return;
  // Inside act(): Base UI updates on the pointer events, and the bare
  // dispatch floods "not wrapped in act" noise (the ffe50bc rule).
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      input.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
    for (const type of ["mousedown", "mouseup", "click"]) {
      input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  });
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  sessionStorage.clear();
  cleanup();
});

describe("PromptPickerDialog", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("picking a row commits AND closes the dialog (the decisive action)", async () => {
    restore = mockFetch().restore;
    const picked: PromptBlock[] = [];
    const changes: boolean[] = [];
    renderPicker({ onPick: (b) => picked.push(b), onOpenChange: (n) => changes.push(n) });
    await settle();
    openSearch();
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    expect(picked.map((b) => [b.kind, b.promptId, b.description])).toEqual([["saved", "pr1", "Kickoff"]]);
    expect(changes).toEqual([false]);
  });

  it("search matches the body, not just the label", async () => {
    // Two OWN rows, and only the second's BODY carries "verify": the label
    // filter alone could not find it, which is the whole point.
    restore = mockFetch([ownRow, { ...ownRow, id: "pr9", description: "Notes", body: "please verify notes" }]).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    const input = document.getElementById("prompt-picker-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "verify" } });
    await settle();
    expect(screen.queryByText("Kickoff")).toBeNull();
    expect(screen.getByText("Notes")).toBeDefined();
    fireEvent.change(input, { target: { value: "task" } });
    await settle();
    expect(screen.getByText("Kickoff")).toBeDefined();
  });

  it("the shared tab answers its own question when empty", async () => {
    restore = mockFetch([ownRow], []).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    await settle();
    openSearch();
    await settle();
    expect(screen.queryByText("Kickoff")).toBeNull();
    // Regex, not exact: Base UI's Empty node carries a word-joiner
    // (U+2060) that defeats the exact string matcher.
    expect(screen.getByText(/No shared prompts yet/)).toBeDefined();
  });

  it("Write your own saves only with the switch on, and needs a description then", async () => {
    const m = mockFetch([], []);
    restore = m.restore;
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "do the thing" },
    });
    // No switch: a one-off, nothing hits the library.
    fireEvent.click(screen.getByRole("button", { name: "Add to stack" }));
    expect(picked.map((b) => b.kind)).toEqual(["custom"]);
    expect(m.posts.length).toBe(0);
  });

  it("with the save switch on a description is required, then the POST rides", async () => {
    const m = mockFetch([], []);
    restore = m.restore;
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "do the thing" },
    });
    // getByLabelText misses the Base UI switch under happy-dom; the role is
    // unique here.
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Add to stack" }));
    expect(screen.getByRole("alert").textContent).toContain("short description");
    expect(picked.length).toBe(0);
    fireEvent.change(screen.getByLabelText("Prompt description"), { target: { value: "The thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to stack" }));
    await waitFor(() => expect(m.posts.length).toBe(1));
    expect(m.posts[0].body).toEqual({ description: "The thing", body: "do the thing", shared: false });
    await waitFor(() => expect(picked.length).toBe(1));
    expect(picked[0].description).toBe("The thing");
  });

  it("the custom draft SURVIVES a reload and is spent on submit", async () => {
    const m = mockFetch([], []);
    restore = m.restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "half an idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    await settle();
    cleanup();

    // The page came back: the picker reopens AT the draft, text intact.
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    expect(screen.getByPlaceholderText("The text to type into the pane")).toBeDefined();
    expect((screen.getByPlaceholderText("The text to type into the pane") as HTMLTextAreaElement).value).toBe(
      "half an idea",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to stack" }));
    expect(picked.length).toBe(1);

    // Submitted: spent. The next open starts at the list, not the draft.
    cleanup();
    renderPicker({ onPick: () => {} });
    await settle();
    expect(screen.getByRole("button", { name: /Write your own/ })).toBeDefined();
  });
});
