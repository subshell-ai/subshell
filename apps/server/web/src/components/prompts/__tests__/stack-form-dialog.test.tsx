import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StackFormDialog } from "@/components/prompts/stack-form-dialog";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The stack editor (spec 2026-09-29) at the wiring level: the POST vs PUT
 * choice, the body the server actually receives (refs and inline rows out of
 * the block list), the empty-stack EDIT lifecycle (removing the last member
 * is a real answer, a fresh create's is not), and the server's refusal shown
 * on the dialog that failed.
 */

const labelField = () => screen.getByLabelText("Label") as HTMLInputElement;
const saveButton = (edit: boolean) =>
  screen.getByRole("button", { name: edit ? "Save" : "Create stack" }) as HTMLButtonElement;

const block = (over: Partial<PromptBlock> = {}): PromptBlock => ({
  localId: over.localId ?? "l1",
  kind: over.kind ?? "saved",
  ...(over.promptId ? { promptId: over.promptId } : {}),
  description: over.description ?? "D",
  body: over.body ?? "b",
});

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function mockFetch(opts: { failWith?: string } = {}) {
  const realFetch = globalThis.fetch;
  const calls: Recorded[] = [];
  const fail = opts.failWith !== undefined;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/prompts/stacks" && method === "POST") {
      calls.push({ url, method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return fail
        ? Promise.resolve(new Response(JSON.stringify({ message: opts.failWith }), { status: 400 }))
        : Promise.resolve(new Response(JSON.stringify({ id: "st1" })));
    }
    if (url === "/api/prompts/stacks/st1" && method === "PUT") {
      calls.push({ url, method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return fail
        ? Promise.resolve(new Response(JSON.stringify({ message: opts.failWith }), { status: 400 }))
        : Promise.resolve(new Response(JSON.stringify({ id: "st1" })));
    }
    // The embedded picker's singles list (allowStacks=false: it never asks
    // for /api/prompts/stacks, which is itself part of what this suite proves).
    if (url === "/api/prompts") {
      return Promise.resolve(new Response(JSON.stringify({ own: [], shared: [] })));
    }
    // Any other URL: a TEST FAILURE in progress (a stack request from the
    // editor's picker would be the nesting bug); record and answer empty.
    calls.push({ url, method, body: {} });
    return Promise.resolve(new Response(JSON.stringify({ own: [], shared: [] })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

function renderDialog(
  props: { editingId?: string; initial?: { label: string; blocks: PromptBlock[]; shared: boolean } } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StackFormDialog open onOpenChange={() => {}} editingId={props.editingId} initial={props.initial} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("StackFormDialog", () => {
  it("create gates on label AND one member, then posts the full ordered body", async () => {
    const m = mockFetch();
    try {
      renderDialog();
      expect(saveButton(false).disabled).toBe(true); // label and member both required
      fireEvent.change(labelField(), { target: { value: "Morning set" } });
      expect(saveButton(false).disabled).toBe(true); // still no member
      // Open the embedded picker, take the custom step, land one inline member.
      fireEvent.click(screen.getByRole("button", { name: "Add prompt" })); // the opener
      fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
      fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
        target: { value: "inline note" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add prompt" })); // the step's submit
      await waitFor(() => expect(saveButton(false).disabled).toBe(false));
      fireEvent.click(saveButton(false));
      await waitFor(() => expect(m.calls.length).toBe(1));
      expect(m.calls[0]).toMatchObject({ url: "/api/prompts/stacks", method: "POST" });
      expect(m.calls[0]?.body).toEqual({ label: "Morning set", items: [{ body: "inline note" }], shared: false });
    } finally {
      m.restore();
    }
  });

  it("an EDIT may save an empty stack (the empty-stack lifecycle is a real answer)", async () => {
    const m = mockFetch();
    try {
      renderDialog({
        editingId: "st1",
        initial: { label: "Emptied", blocks: [block({ promptId: "p1" })], shared: true },
      });
      fireEvent.click(screen.getByLabelText("Remove prompt")); // last member goes
      expect(saveButton(true).disabled).toBe(false); // minItems 0 on edit
      fireEvent.click(saveButton(true));
      await waitFor(() => expect(m.calls.length).toBe(1));
      expect(m.calls[0]).toMatchObject({ url: "/api/prompts/stacks/st1", method: "PUT" });
      expect(m.calls[0]?.body).toEqual({ label: "Emptied", items: [], shared: true });
    } finally {
      m.restore();
    }
  });

  it("a seeded ref and inline block save as {promptId} and {body} members", async () => {
    const m = mockFetch();
    try {
      renderDialog({
        editingId: "st1",
        initial: {
          label: "Mixed",
          blocks: [
            block({ localId: "l1", promptId: "p1", description: "P1", body: "live" }),
            block({ localId: "l2", kind: "custom", description: "", body: "mine" }),
          ],
          shared: false,
        },
      });
      fireEvent.click(saveButton(true));
      await waitFor(() => expect(m.calls.length).toBe(1));
      // The unlabeled inline row rides UNLABELED (the placeholder is display).
      expect(m.calls[0]?.body).toEqual({
        label: "Mixed",
        items: [{ promptId: "p1" }, { body: "mine" }],
        shared: false,
      });
    } finally {
      m.restore();
    }
  });

  it("the server's own refusal renders on the dialog that failed", async () => {
    const m = mockFetch({ failWith: "The stack's text joined is 30000 characters" });
    try {
      renderDialog({ editingId: "st1", initial: { label: "Big", blocks: [block({ body: "x" })], shared: false } });
      fireEvent.click(saveButton(true));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("30000 characters");
    } finally {
      m.restore();
    }
  });

  it("the embedded picker never asks for stacks (a stack does not nest)", async () => {
    const m = mockFetch();
    try {
      renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Add prompt" })); // opens the inline picker
      // The picker's list step is up (its heading names the question it asks).
      await waitFor(() => expect(screen.getByText("Add a prompt")).toBeTruthy());
      expect(m.calls.filter((c) => c.url.includes("/stacks")).length).toBe(0); // L3: disabled query
    } finally {
      m.restore();
    }
  });
});
