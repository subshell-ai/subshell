import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { NodeHarnessCard } from "@/components/nodes/node-harness-card";
import { NODE_QUERY_KEY } from "@/lib/query-keys";
import type { Node, NodeHarness } from "@/types/node";

/**
 * The card shows the NODE's declaration, and offers install/remove rather than
 * an enable switch, because a plugin being installed there IS it being offered.
 */
const NODE_ID = "n1";

function node(harnesses: NodeHarness[], over: Partial<Node> = {}): Node {
  return {
    id: NODE_ID,
    name: "Mac Mini",
    kind: "agent",
    status: "online",
    access: "owner",
    canManage: true,
    harnesses,
    inventoryStale: false,
    ...over,
  } as unknown as Node;
}

/** Renders with the node view already in the cache, so no fetch is needed. */
function renderCard(view: Node, canManage = true): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData([...NODE_QUERY_KEY, NODE_ID], view);
  qc.setQueryData(
    ["harnesses"],
    [
      { id: "claude-code", name: "Claude Code" },
      { id: "codex", name: "Codex" },
    ],
  );
  const ui = (
    <QueryClientProvider client={qc}>
      <NodeHarnessCard nodeId={NODE_ID} canManage={canManage} />
    </QueryClientProvider>
  );
  render(ui);
  return ui;
}

describe("NodeHarnessCard", () => {
  afterEach(cleanup);

  it("lists what the node declared, by name", () => {
    renderCard(node([{ harnessId: "claude-code", installed: true, version: "2.1.0" }]));
    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.getByText("2.1.0")).toBeDefined();
  });

  it("renders a plugin this build has never heard of, by its id", () => {
    // The rows are the node's answer, not this control plane's catalog.
    renderCard(node([{ harnessId: "some-third-party", installed: true }]));
    expect(screen.getByText("some-third-party")).toBeDefined();
  });

  it("separates having the plugin from having its program", () => {
    // A node can have the claude-code plugin and no `claude` on its PATH, and
    // the row has to say which of those is missing.
    renderCard(node([{ harnessId: "claude-code", installed: false }]));
    expect(screen.getByText("program not found")).toBeDefined();
  });

  it("says nothing was reported rather than showing an empty offer", () => {
    // A pre-v6 agent reports nothing; that is not the same as offering nothing.
    renderCard(node([]));
    expect(screen.getByText(/hasn't reported any plugins/)).toBeDefined();
  });

  it("offers Remove and Install to a manager", () => {
    renderCard(node([{ harnessId: "claude-code", installed: true }]));
    expect(screen.getByRole("button", { name: "Remove" })).toBeDefined();
    // codex is in the catalog and not installed, so it is offered.
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
  });

  it("offers neither to someone who cannot manage the node", () => {
    renderCard(node([{ harnessId: "claude-code", installed: true }]), false);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("explains a bad env override instead of implying the plugin is missing", () => {
    renderCard(node([{ harnessId: "claude-code", installed: false, reason: "override-invalid" }]));
    expect(screen.getByText(/environment variable overrides/)).toBeDefined();
  });

  it("says a plugin needing no program needs none", () => {
    // "This plugin needs no separate program INSTALLED" contradicted the row's
    // own "installed" fact on the node page (review of 2b, P2), so the copy
    // avoids the word entirely now.
    renderCard(node([{ harnessId: "some-terminal", installed: false, reason: "no-binary" }]));
    expect(screen.getByText(/No separate program is needed here/)).toBeDefined();
  });

  it("shows a broken plugin's reason rather than a healthy-looking row", () => {
    // The whole reason a broken plugin keeps a row is so the page can say why.
    renderCard(node([{ harnessId: "claude-code", installed: true, broken: "boom at import" }]));
    expect(screen.getByText(/could not load the plugin: boom at import/)).toBeDefined();
    expect(screen.getByText("not usable")).toBeDefined();
  });

  it("names no version in the restart notice, because the one on the row is the program's", () => {
    // `version` here is `claude --version`, which an upgrade of the PLUGIN
    // does not change. Naming it pointed at the wrong number, and rendered
    // "Version  is installed" whenever the program was absent.
    renderCard(node([{ harnessId: "claude-code", installed: true, version: "1.0.88", restartRequired: true }]));
    expect(screen.getByText(/A newer copy is installed than the one this node is running/)).toBeDefined();
    expect(screen.queryByText(/Version 1.0.88 is installed/)).toBeNull();
  });

  it("reads sensibly when the plugin declares no program at all", () => {
    // No version to print, and this used to render "Version  is installed"
    // with a hole in it.
    renderCard(node([{ harnessId: "some-terminal", installed: false, reason: "no-binary", restartRequired: true }]));
    expect(screen.queryByText(/Version\s+is installed/)).toBeNull();
    expect(screen.getByText(/Restart the agent/)).toBeDefined();
  });

  it("shows the restart notice on a BROKEN plugin, which is what it is most for", () => {
    // A plugin that threw on load keeps throwing the cached error until the
    // agent restarts, so this row would otherwise show a failure that the
    // copy already on disk fixes.
    renderCard(node([{ harnessId: "claude-code", installed: true, restartRequired: true, broken: "BOOM v1" }]));
    expect(screen.getByText(/could not load the plugin: BOOM v1/)).toBeDefined();
    expect(screen.getByText(/may already fix this/)).toBeDefined();
  });

  it("does not badge a no-binary plugin as missing its program", () => {
    // The badge and the explanation underneath used to contradict each other.
    renderCard(node([{ harnessId: "some-terminal", installed: false, reason: "no-binary" }]));
    expect(screen.getByText("ready")).toBeDefined();
    expect(screen.queryByText("program not found")).toBeNull();
  });

  it("offers the same actions on the control-plane host as on any node", () => {
    // It used to suppress both, because the route refused `local` with a 400.
    // It has its own plugins directory now and the route installs to it, so
    // hiding the controls left the host's own page saying "install one below"
    // with nothing below it.
    renderCard(node([{ harnessId: "claude-code", installed: true }]), true);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDefined();
  });
});
