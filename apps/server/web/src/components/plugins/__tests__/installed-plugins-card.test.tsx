import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InstalledPluginsCard } from "@/components/plugins/installed-plugins-card";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import type { PluginUpdateRow } from "@/hooks/use-plugin-updates";

/**
 * Keep management controls accessible to managers and absent for readers.
 * Grid alignment belongs in browser review; Happy DOM cannot measure it.
 */

interface Call {
  method: string;
  pathname: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * The fetch spy from `use-instance-plugins.test.tsx`: one table of answers
 * keyed by `METHOD /path`, and every request recorded — the update loop is
 * asserted on the wire, not on a hook call.
 */
function mockFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, pathname: url.pathname });
    const custom = overrides[`${method} ${url.pathname}`];
    return Promise.resolve(custom ? custom() : json({}));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function row(over: Partial<InstancePluginRow> & { id: string; name: string }): InstancePluginRow {
  return {
    description: "",
    installed: true,
    enabled: true,
    builtIn: false,
    ...over,
  };
}

function renderCard(
  plugins: InstancePluginRow[],
  canManage = true,
  updates: PluginUpdateRow[] = [],
  extra: { checkErrors?: string[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InstalledPluginsCard
        plugins={plugins}
        canManage={canManage}
        onUninstall={() => {}}
        updates={updates}
        onCheck={() => {}}
        checking={false}
        checkErrors={extra.checkErrors ?? []}
      />
    </QueryClientProvider>,
  );
}

const offer = (id: string, name: string, from: string, to: string): PluginUpdateRow => ({ id, name, from, to });

afterEach(cleanup);

describe("InstalledPluginsCard", () => {
  it("both controls stay reachable by their accessible names", () => {
    renderCard([row({ id: "pi", name: "Pi" })]);
    expect(screen.getByRole("switch", { name: "Pi enabled" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Uninstall Pi" })).toBeDefined();
  });

  it("a reader who manages nothing gets the state as a badge, and no controls", () => {
    renderCard([row({ id: "pi", name: "Pi", enabled: false })], false);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
    expect(screen.getByText("disabled")).toBeDefined();
  });

  it("shows the version pair and the update action on an npm row", () => {
    renderCard([row({ id: "third", name: "Third", source: "npm", version: "1.0.0" })], true, [
      offer("third", "Third", "1.0.0", "1.1.0"),
    ]);
    expect(screen.getByText("v1.0.0 → v1.1.0")).toBeDefined();
    expect(screen.getByRole("button", { name: "Update to 1.1.0" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDefined();
  });

  it("confirms before installing, then POSTs the update", async () => {
    const m = mockFetch({ "POST /api/plugins/third/update": () => json({}) });
    try {
      renderCard([row({ id: "third", name: "Third", source: "npm", version: "1.0.0" })], true, [
        offer("third", "Third", "1.0.0", "1.1.0"),
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Update to 1.1.0" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Update this plugin?")).toBeDefined();
      expect(within(dialog).getByText("Third")).toBeDefined();
      expect(within(dialog).getByText("v1.0.0 → v1.1.0")).toBeDefined();
      expect(within(dialog).getByText(/replaces the plugin's code on this server/i)).toBeDefined();
      // The question comes first: nothing leaves the browser unanswered.
      expect(m.calls.some((c) => c.method === "POST")).toBe(false);
      fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
      await waitFor(() =>
        expect(m.calls.filter((c) => c.method === "POST").map((c) => c.pathname)).toEqual([
          "/api/plugins/third/update",
        ]),
      );
    } finally {
      m.restore();
    }
  });

  it("updates all offers one at a time and keeps a failure on its row", async () => {
    // The first install answers only when this test says so: a loop that
    // fired both at once would show the second POST before the first reply.
    const firstAnswered = Promise.withResolvers<void>();
    const m = mockFetch({
      "POST /api/plugins/third/update": async () => {
        await firstAnswered.promise;
        return new Response(JSON.stringify({ message: "Third is no longer in the registry." }), { status: 409 });
      },
      "POST /api/plugins/fourth/update": () => json({}),
    });
    const posts = () => m.calls.filter((c) => c.method === "POST").map((c) => c.pathname);
    try {
      renderCard(
        [
          row({ id: "third", name: "Third", source: "npm", version: "1.0.0" }),
          row({ id: "fourth", name: "Fourth", source: "npm", version: "2.0.0" }),
        ],
        true,
        [offer("third", "Third", "1.0.0", "1.1.0"), offer("fourth", "Fourth", "2.0.0", "2.1.0")],
      );
      fireEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Update 2 plugins?")).toBeDefined();
      fireEvent.click(within(dialog).getByRole("button", { name: "Update all" }));
      await waitFor(() => expect(posts()).toEqual(["/api/plugins/third/update"]));
      // One at a time: the second row's turn has not started while the first
      // is still unanswered.
      expect(posts()).toEqual(["/api/plugins/third/update"]);
      firstAnswered.resolve();
      await waitFor(() => expect(posts()).toHaveLength(2));
      expect(posts()).toEqual(["/api/plugins/third/update", "/api/plugins/fourth/update"]);
      // The failing row says why; its neighbour's success is not held back.
      expect(await screen.findByText(/no longer in the registry/)).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("renders check errors and the shadowed copy as detail lines", () => {
    renderCard(
      [
        row({
          id: "third",
          name: "Third",
          source: "build",
          version: "2.0.0",
          shadowed: { version: "1.0.0", source: "npm" },
        }),
        row({
          id: "fifth",
          name: "Fifth",
          source: "build",
          version: "3.0.0",
          shadowed: { version: "2.0.0", source: "build", error: "missing entry file" },
        }),
      ],
      true,
      [],
      { checkErrors: ["Could not check Fourth: registry answered 503"] },
    );
    expect(screen.getByText("Could not check Fourth: registry answered 503")).toBeDefined();
    expect(screen.getByText("Installed copy v1.0.0 (npm) is not in use; the bundled copy is newer.")).toBeDefined();
    // A shadowed copy that failed to load says why instead of blaming the bundle.
    expect(screen.getByText("Installed copy v2.0.0 (this build) is not in use: missing entry file.")).toBeDefined();
  });

  it("names where each copy came from, and falls back to the built-in rule on an older server", () => {
    renderCard([
      row({ id: "npm-one", name: "Npm one", source: "npm" }),
      row({ id: "disk-one", name: "Disk one", source: "unrecorded" }),
      row({ id: "build-one", name: "Build one", source: "build" }),
      row({ id: "old-npm", name: "Old npm", builtIn: false }),
      row({ id: "old-build", name: "Old build", builtIn: true }),
    ]);
    expect(screen.getAllByText("npm")).toHaveLength(2);
    expect(screen.getByText("no record")).toBeDefined();
    expect(screen.getAllByText("this build")).toHaveLength(2);
  });

  it("a reader gets no update controls", () => {
    renderCard([row({ id: "third", name: "Third", source: "npm", version: "1.0.0" })], false, [
      offer("third", "Third", "1.0.0", "1.1.0"),
    ]);
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });
});
