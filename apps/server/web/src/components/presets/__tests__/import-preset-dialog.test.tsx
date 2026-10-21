import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImportPresetDialog } from "../import-preset-dialog";

const fileData = {
  format: "subshell-preset",
  version: 1,
  preset: {
    kind: "agent",
    name: "Imported",
    description: null,
    harnessId: "terminal",
    env: { VALUE: "kept" },
    flags: [],
    settings: {},
    configIsolation: false,
    restartOnExit: false,
    crossCommEnabled: false,
    nodeId: null,
    workingDir: null,
    promptBlocks: null,
  },
};
const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});
function mount(refuse = false) {
  const posts: unknown[] = [];
  const completed: string[] = [];
  const closed: boolean[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/api/nodes")) return Response.json({ nodes: [] });
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return refuse
        ? Response.json(
            {
              message: 'You already have a terminal preset named "Imported"',
              code: "EXISTS_ERROR",
              metadata: { reason: "duplicate_preset_name", field: "name" },
            },
            { status: 409 },
          )
        : Response.json({ id: "new" });
    }
    return Response.json([]);
  }) as typeof fetch;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <ImportPresetDialog onClose={() => closed.push(true)} onImported={(kind) => completed.push(kind)} />
    </QueryClientProvider>,
  );
  return { posts, completed, closed };
}
function choose(text: string) {
  fireEvent.change(screen.getByLabelText("Preset file"), {
    target: { files: [new File([text], "test.preset", { type: "application/json" })] },
  });
}
describe("Import preset dialog", () => {
  it("uses a native file input and rejects bad files without a write", async () => {
    const { posts } = mount();
    expect(screen.getByLabelText("Preset file").getAttribute("type")).toBe("file");
    expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
    choose("{");
    await screen.findByText(/isn't valid JSON/);
    expect(posts).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
    choose(JSON.stringify({ ...fileData, version: 99 }));
    await screen.findByText(/unsupported version/);
    expect(posts).toHaveLength(0);
  });
  it("validates then explicitly imports a private copy with the reviewed name", async () => {
    const { posts, completed } = mount();
    choose(JSON.stringify(fileData));
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Renamed import" } });
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Import preset" }));
    await waitFor(() => expect(completed).toEqual(["agent"]));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ name: "Renamed import", harnessId: "terminal", env: { VALUE: "kept" } });
    expect(Object.keys(posts[0] as object)).not.toContain("shares");
    expect(Object.keys(posts[0] as object)).not.toContain("userId");
  });
  it("keeps a refused import open so its name or node can be corrected", async () => {
    const { completed } = mount(true);
    choose(JSON.stringify(fileData));
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Import preset" }));
    await screen.findByText("You already have a preset with this name. Choose a different name to import a copy.");
    const name = screen.getByLabelText("Name");
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText(/API 409/) === null).toBe(true);
    fireEvent.change(name, { target: { value: "Another name" } });
    expect(name.getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(completed).toHaveLength(0);
    expect(screen.getByLabelText("Name")).toBeDefined();
  });
  it("discards a previously valid draft when the next file fails validation", async () => {
    const { posts } = mount();
    choose(JSON.stringify(fileData));
    await screen.findByLabelText("Name");
    choose("{}");
    await screen.findByText(/This preset file is invalid/);
    expect(screen.queryByLabelText("Name") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(posts).toHaveLength(0);
  });
});

it("keeps an import draft on Escape and closes only on explicit cancellation", async () => {
  const { closed } = mount();
  choose(JSON.stringify(fileData));
  const name = await screen.findByLabelText("Name");
  fireEvent.change(name, { target: { value: "Keep my changes" } });
  fireEvent.keyDown(name, { key: "Escape", code: "Escape" });
  expect(closed).toHaveLength(0);
  expect((name as HTMLInputElement).value).toBe("Keep my changes");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(closed).toHaveLength(1);
});

it("lets an imported cross-agent preset opt out and import without a machine", async () => {
  const { posts, completed } = mount();
  choose(
    JSON.stringify({
      ...fileData,
      preset: { ...fileData.preset, crossCommEnabled: true, workingDir: "/tmp", crossCommNotes: "Original notes" },
    }),
  );
  const toggle = await screen.findByRole("switch", { name: "Enable agents to create subshells with this preset" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(
    screen.getByText("Choose a launch machine above, or turn off cross-agent communication to import this preset."),
  ).toBeTruthy();
  const notes = screen.getByLabelText("Notes for calling agents") as HTMLTextAreaElement;
  expect(notes.value).toBe("Original notes");
  expect(notes.maxLength).toBe(8000);
  fireEvent.change(notes, { target: { value: "Review branch changes" } });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import preset" }));
  await waitFor(() => expect(completed).toEqual(["agent"]));
  expect(posts[0]).toMatchObject({ nodeId: null, crossCommEnabled: false, crossCommNotes: "Review branch changes" });
});

it("lets cross-agent import requirements be completed after enabling the option", async () => {
  const { posts, completed } = mount();
  choose(JSON.stringify({ ...fileData, preset: { ...fileData.preset, nodeId: "local" } }));
  const toggle = await screen.findByRole("switch", { name: "Enable agents to create subshells with this preset" });
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(
    screen.getByText("Choose a working directory above, or turn off cross-agent communication to import this preset."),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: "/work/review" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Import preset" }).matches(":disabled, [aria-disabled=true]")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import preset" }));
  await waitFor(() => expect(completed).toEqual(["agent"]));
  expect(posts[0]).toMatchObject({ nodeId: "local", crossCommEnabled: true, workingDir: "/work/review" });
});
