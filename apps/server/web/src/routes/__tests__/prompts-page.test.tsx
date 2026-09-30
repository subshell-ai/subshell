import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { OwnStackRow, StackItemRow, StacksView } from "@/lib/prompt-stacks";
import type { OwnPromptRow, PromptsView, SharedPromptRow } from "@/lib/prompts";
import { Route } from "@/routes/prompts";

/**
 * The /prompts page (spec 2026-09-28, stacks 2026-09-29): the All|Single|
 * Stacked union (loading/error/empty answer over what the view SHOWS), the
 * "In N stacks" chip that opens its disclosure and jumps (focus is consumed
 * on arrival), and the All|Empty stack filter, which is a Stacked/own
 * affordance and may not silently trim the overview.
 */

const T = "2026-09-29T00:00:00.000Z";

function ownPrompt(p: { id: string; description: string; body?: string; shared?: boolean }): OwnPromptRow {
  return {
    id: p.id,
    description: p.description,
    body: p.body ?? `${p.description} body`,
    shared: p.shared ?? false,
    createdAt: T,
    updatedAt: T,
  };
}

function sharedPrompt(p: { id: string; description: string; ownerName: string }): SharedPromptRow {
  return {
    id: p.id,
    description: p.description,
    body: `${p.description} body`,
    ownerName: p.ownerName,
    createdAt: T,
    updatedAt: T,
  };
}

function ownStack(s: { id: string; label: string; items: StackItemRow[]; shared?: boolean }): OwnStackRow {
  return { id: s.id, label: s.label, items: s.items, shared: s.shared ?? false, createdAt: T, updatedAt: T };
}

const DEFAULT_PROMPTS: PromptsView = {
  own: [ownPrompt({ id: "pr1", description: "Kickoff", body: "kick off the day" })],
  shared: [sharedPrompt({ id: "pr9", description: "Review", ownerName: "Ada" })],
};
// st1 references pr1 (the chip's "In 1 stack"); st2 is the empty stack the
// All|Empty filter exists to find.
const DEFAULT_STACKS: StacksView = {
  own: [
    ownStack({
      id: "st1",
      label: "Morning set",
      items: [{ id: "i1", promptId: "pr1", description: "Kickoff", body: "kick off the day" }],
    }),
    ownStack({ id: "st2", label: "Empty set", items: [] }),
  ],
  shared: [],
};

function mockFetch(
  opts: { prompts?: PromptsView; stacks?: StacksView; failPrompts?: boolean; failStacks?: boolean } = {},
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/prompts/stacks") {
      if (opts.failStacks) return Promise.resolve(new Response("{}", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(opts.stacks ?? DEFAULT_STACKS)));
    }
    if (url.pathname === "/api/prompts") {
      if (opts.failPrompts) return Promise.resolve(new Response("{}", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(opts.prompts ?? DEFAULT_PROMPTS)));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

function renderPage(path = "/prompts") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <ConfirmProvider>
        <Outlet />
      </ConfirmProvider>
    ),
  });
  const promptsRoute = Route.update({ id: "/prompts", path: "/prompts", getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([promptsRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cleanup();
});

describe("/prompts views", () => {
  it("All is the combined overview: stacks and singles share the screen", async () => {
    const { restore } = mockFetch();
    try {
      renderPage();
      expect(await screen.findByText("Kickoff")).toBeDefined();
      expect(screen.getByText("Morning set")).toBeDefined();
      expect(screen.getByPlaceholderText("Search prompts and stacks")).toBeDefined();
      // The tab counts answer the union too: one prompt + two stacks, one Yours.
      expect(screen.getByRole("button", { name: "Yours (3)" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("Single hides the stack rows; Stacked hides the prompt rows", async () => {
    const { restore } = mockFetch();
    try {
      const router = renderPage("/prompts?view=single");
      expect(await screen.findByText("Kickoff")).toBeDefined();
      expect(screen.queryByText("Morning set")).toBeNull();
      expect(screen.getByPlaceholderText("Search prompts")).toBeDefined();
      // The URL names the narrow views only; All is the absence. (The test
      // route tree is `as never`-built, so the SEARCH generics have nothing
      // to check against; the page's validateSearch is the real gate.)
      router.navigate({ search: { view: "stacked" } } as never);
      await waitFor(() => expect(router.state.location.searchStr).toContain("view=stacked"));
      await settle();
      expect(screen.getByText("Morning set")).toBeDefined();
      expect(screen.getByText("Empty set")).toBeDefined();
      // The singles are gone from this view; the chip (and the search) speak
      // stacks only.
      expect(screen.queryByPlaceholderText("Search prompts")).toBeNull();
      expect(screen.getByPlaceholderText("Search stacks")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("an empty library says so once, naming both kinds", async () => {
    const { restore } = mockFetch({ prompts: { own: [], shared: [] }, stacks: { own: [], shared: [] } });
    try {
      renderPage();
      expect(await screen.findByText("No prompts or stacks yet")).toBeDefined();
    } finally {
      restore();
    }
  });
});

describe("/prompts error unions", () => {
  it("Stacked fails on the list it shows and names the prompt-list degradation", async () => {
    const { restore } = mockFetch({ failStacks: true });
    try {
      renderPage("/prompts?view=stacked");
      expect(await screen.findByText("Couldn't load stacks.")).toBeDefined();
    } finally {
      restore();
    }
    cleanup();
    const { restore: restore2 } = mockFetch({ failPrompts: true });
    try {
      renderPage("/prompts?view=stacked");
      // Stacks loaded, prompts did not: no banner (the view shows stacks), but
      // the member-edit degradation is stated, not hidden.
      expect(await screen.findByText(/editing a stack member that points at one is unavailable/)).toBeDefined();
    } finally {
      restore2();
    }
  });

  it("All names the feed that failed (stacks down is not 'prompts')", async () => {
    // The round-2 defect was an All-view banner reading "Couldn't load
    // prompts." while prompts had loaded and only stacks had failed. The
    // view-keyed ternary could never say the true thing on this screen.
    const { restore } = mockFetch({ failStacks: true });
    try {
      renderPage();
      expect(await screen.findByText("Couldn't load stacks.")).toBeDefined();
      expect(screen.queryByText("Couldn't load prompts.")).toBeNull();
    } finally {
      restore();
    }
    const { restore: restore2 } = mockFetch({ failPrompts: true });
    try {
      renderPage();
      expect(await screen.findByText("Couldn't load prompts.")).toBeDefined();
    } finally {
      restore2();
    }
  });

  it("Stacked/shared: no shown reference, no sentence; a shown reference, the sentence", async () => {
    // Round-6: canEditMember offers Edit on ANY tab for a reference pointing
    // at one of MY prompts, so the gate is "a reference member is on screen",
    // not the tab. With no shared stacks at all, nothing was taken, and the
    // sentence stays off (the round-5 over-correction stayed quiet even where
    // the failure HAD taken an offered Edit).
    const { restore } = mockFetch({ failPrompts: true });
    try {
      renderPage("/prompts?view=stacked&tab=shared");
      expect(await screen.findByRole("button", { name: "Shared with you (0)" })).toBeDefined();
      expect(screen.queryByText(/editing a stack member/)).toBeNull();
    } finally {
      restore();
    }
    // Ada's shared stack shows a reference member: the reader cannot tell
    // whether it is THEIRS (the case Edit would have offered) without the
    // feed, so the honest line rides.
    const { restore: restore2 } = mockFetch({
      failPrompts: true,
      stacks: {
        own: [],
        shared: [
          {
            id: "st-sh",
            label: "Ada's set",
            ownerName: "Ada",
            createdAt: T,
            updatedAt: T,
            items: [{ id: "i9", promptId: "pr1", description: "Mine too", body: "b" }],
          },
        ],
      },
    });
    try {
      renderPage("/prompts?view=stacked&tab=shared");
      expect(await screen.findByText("Ada's set")).toBeDefined();
      expect(screen.getByText(/editing a stack member that points at one is unavailable/)).toBeDefined();
    } finally {
      restore2();
    }
  });

  it("Single states the failed stacks feed instead of silently dropping the counts", async () => {
    const { restore } = mockFetch({ failStacks: true });
    try {
      renderPage("/prompts?view=single");
      expect(await screen.findByText("Kickoff")).toBeDefined();
      expect(screen.getByText(/membership counts are hidden/)).toBeDefined();
      // And no "In N stacks" chip was earned by the missing list.
      expect(screen.queryByRole("button", { name: /^In \d+ stacks?$/ })).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('/prompts "In N stacks"', () => {
  it("the chip opens its panel (aria-controls paired), jumps, and consumes the focus", async () => {
    const { restore } = mockFetch();
    try {
      const router = renderPage("/prompts?view=single");
      const chip = await screen.findByRole("button", { name: "In 1 stack" });
      expect(chip.getAttribute("aria-controls")).toBe("prompt-stacks-pr1");
      expect(chip.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(chip);
      // The chip's aria-controls names THIS panel, and it holds the stack row.
      const panel = await waitFor(() => {
        const el = document.getElementById("prompt-stacks-pr1");
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      expect(chip.getAttribute("aria-expanded")).toBe("true");
      // Jump from INSIDE the panel: the typed search is cleared on arrival,
      // the row rings, and the param is consumed (a re-jump must re-ring).
      fireEvent.change(screen.getByPlaceholderText("Search prompts"), { target: { value: "kick" } });
      await settle();
      fireEvent.click(within(panel).getByRole("button", { name: "Morning set" }));
      // The jump lands Stacked first, THEN the arrival consumes the param.
      await waitFor(() => expect(router.state.location.searchStr).toContain("view=stacked"));
      await waitFor(() => expect(router.state.location.searchStr).not.toContain("focus"));
      expect((screen.getByPlaceholderText("Search stacks") as HTMLInputElement).value).toBe("");
      const row = document.querySelector('[data-stack-id="st1"]');
      expect(row?.className ?? "").toContain("ring");
      // The ring is ONE-SHOT: the ref'd timer clears it (2.5 s) even though
      // the focus param is already gone.
      await waitFor(
        () => expect(document.querySelector('[data-stack-id="st1"]')?.className ?? "").not.toContain("ring"),
        { timeout: 3500 },
      );
    } finally {
      restore();
    }
  });

  it("?focus rings the arrival row and is consumed; a non-stacked link drops it", async () => {
    const { restore } = mockFetch();
    try {
      const router = renderPage("/prompts?view=stacked&focus=st2");
      expect(await screen.findByText("Empty set")).toBeDefined();
      expect(document.querySelector('[data-stack-id="st2"]')?.className ?? "").toContain("ring");
      await waitFor(() => expect(router.state.location.searchStr).not.toContain("focus"));
    } finally {
      restore();
    }
    // The second render rides the SAME body: tear the first down first, or
    // the "no stack row, no ring" assertions would read the old screen.
    cleanup();
    const { restore: restore2 } = mockFetch();
    try {
      // validateSearch drops focus outside Stacked: the gate means the page
      // never holds a param its arrival can never consume.
      renderPage("/prompts?view=single&focus=st1");
      expect(await screen.findByText("Kickoff")).toBeDefined();
      expect(document.querySelector('[data-stack-id="st1"]')).toBeNull();
      // nothing to ring in Single anyway - no stack row is rendered, and no
      // chip was clicked: assert no ring class is present at all.
      expect(document.querySelector(".ring-primary")).toBeNull();
    } finally {
      restore2();
    }
  });

  it("a cold arrival rings even when the payload lands after the old budget", async () => {
    // The round-7 fix: the clear timer ARMS when the row is on screen, not
    // at the URL arrival. The old code spent its entire 2.5 s while a slow
    // stacks fetch was still in flight, so a cold arrival over a tunnel or
    // phone link landed on a list where nothing identified the target.
    const original = globalThis.fetch;
    let releaseStacks: (r: Response) => void = () => {};
    globalThis.fetch = ((input: unknown) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/prompts/stacks") {
        return new Promise<Response>((res) => {
          releaseStacks = res;
        });
      }
      if (url.pathname === "/api/prompts") {
        return Promise.resolve(new Response(JSON.stringify(DEFAULT_PROMPTS)));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }) as typeof fetch;
    try {
      renderPage("/prompts?view=stacked&focus=st2");
      // Past the OLD budget while the payload is still HELD (the promise is
      // ours, so this is not a timing race): nothing was on screen to ring,
      // and the new code has spent nothing.
      await new Promise((r) => setTimeout(r, 2800));
      expect(screen.queryByText("Empty set")).toBeNull();
      await act(async () => {
        releaseStacks(new Response(JSON.stringify(DEFAULT_STACKS)));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(await screen.findByText("Empty set")).toBeDefined();
      expect(document.querySelector('[data-stack-id="st2"]')?.className ?? "").toContain("ring");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("/prompts stack filter", () => {
  it("Empty filters Stacked/own only; the overview is never silently trimmed", async () => {
    const { restore } = mockFetch();
    try {
      const router = renderPage("/prompts?view=stacked");
      expect(await screen.findByText("Morning set")).toBeDefined();
      expect(screen.getByText("Empty set")).toBeDefined();
      const filter = screen.getByRole("group", { name: "Stack filter" });
      fireEvent.click(within(filter).getByRole("button", { name: "Empty" }));
      await waitFor(() => expect(screen.queryByText("Morning set")).toBeNull());
      expect(screen.getByText("Empty set")).toBeDefined();
      // Back to All with the filter still set: every stack the search matches
      // shows again, because the filter is a Stacked-only affordance.
      const views = screen.getByRole("group", { name: "Prompts or stacks" });
      fireEvent.click(within(views).getByRole("button", { name: "All" }));
      await waitFor(() => expect(router.state.location.searchStr).not.toContain("view"));
      await settle();
      expect(screen.getByText("Morning set")).toBeDefined();
      expect(screen.getByText("Empty set")).toBeDefined();
    } finally {
      restore();
    }
  });
});
