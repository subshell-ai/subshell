import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PromptPickerDialog } from "@/components/prompts/prompt-picker-dialog";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The shared prompt picker (spec 2026-09-28), pinned at the level the
 * operator's browser broke at: clicking a list row must COMMIT the pick and
 * close the dialog. The list is in-flow inside the dialog (the portal
 * popup never committed clicks inside a dialog-on-a-dialog, live report
 * 2026-09-29), so a plain click is the real interaction under test here.
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

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

afterEach(() => cleanup());

describe("PromptPickerDialog", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("clicking a row picks it AND closes the dialog (the decisive action)", async () => {
    restore = mockFetch().restore;
    const picked: PromptBlock[] = [];
    const changes: boolean[] = [];
    renderPicker({ onPick: (b) => picked.push(b), onOpenChange: (n) => changes.push(n) });
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    expect(picked.map((b) => [b.kind, b.promptId, b.description])).toEqual([["saved", "pr1", "Kickoff"]]);
    expect(changes).toEqual([false]);
  });

  it("search matches the body, not just the label", async () => {
    restore = mockFetch().restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.change(screen.getByPlaceholderText("Search prompts"), { target: { value: "check the diff" } });
    await settle();
    expect(screen.queryByText("Kickoff")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search prompts"), { target: { value: "task" } });
    await settle();
    expect(screen.getByText("Kickoff")).toBeDefined();
  });

  it("the shared tab lists shared rows, and an empty tab without a query reads honestly", async () => {
    restore = mockFetch([ownRow], []).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    await settle();
    expect(screen.queryByText("Kickoff")).toBeNull();
    expect(screen.getByText("No shared prompts yet")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("Search prompts"), { target: { value: "zzz" } });
    await settle();
    expect(screen.getByText(/No prompts match/)).toBeDefined();
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
});
