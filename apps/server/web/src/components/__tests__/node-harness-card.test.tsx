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
function renderCard(view: Node, canManage = true, isLocal = false): ReactElement {
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
      <NodeHarnessCard nodeId={NODE_ID} canManage={canManage} isLocal={isLocal} />
    </QueryClientProvider>
  );
  render(ui);
  return ui;
}

describe("NodeHarnessCard", () => {
  afterEach(cleanup);

  it("lists what the node declared, by name", () => {
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: true, version: "2.1.0" }]));
    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.getByText("2.1.0")).toBeDefined();
  });

  it("renders a plugin this build has never heard of, by its id", () => {
    // The rows are the node's answer, not this control plane's catalog.
    renderCard(node([{ harnessId: "some-third-party", enabled: true, installed: true }]));
    expect(screen.getByText("some-third-party")).toBeDefined();
  });

  it("separates having the plugin from having its program", () => {
    // A node can have the claude-code plugin and no `claude` on its PATH, and
    // the row has to say which of those is missing.
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: false }]));
    expect(screen.getByText("program not found")).toBeDefined();
  });

  it("says nothing was reported rather than showing an empty offer", () => {
    // A pre-v6 agent reports nothing; that is not the same as offering nothing.
    renderCard(node([]));
    expect(screen.getByText(/hasn't reported any plugins/)).toBeDefined();
  });

  it("offers Remove and Install to a manager", () => {
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: true }]));
    expect(screen.getByRole("button", { name: "Remove" })).toBeDefined();
    // codex is in the catalog and not installed, so it is offered.
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
  });

  it("offers neither to someone who cannot manage the node", () => {
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: true }]), false);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("explains a bad env override instead of implying the plugin is missing", () => {
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: false, reason: "override-invalid" }]));
    expect(screen.getByText(/environment variable overrides/)).toBeDefined();
  });

  it("says a plugin needing no program needs none", () => {
    renderCard(node([{ harnessId: "some-terminal", enabled: true, installed: false, reason: "no-binary" }]));
    expect(screen.getByText(/needs no separate program/)).toBeDefined();
  });

  it("shows a broken plugin's reason rather than a healthy-looking row", () => {
    // The whole reason a broken plugin keeps a row is so the page can say why.
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: true, broken: "boom at import" }]));
    expect(screen.getByText(/could not load the plugin: boom at import/)).toBeDefined();
    expect(screen.getByText("not usable")).toBeDefined();
  });

  it("says the version on screen is not the code running yet", () => {
    // A module cannot be swapped inside a live process, so an upgrade shows
    // the new number beside the old behaviour until the agent restarts. The
    // number alone would be a lie.
    renderCard(
      node([{ harnessId: "claude-code", enabled: true, installed: true, version: "2.1.0", restartRequired: true }]),
    );
    expect(screen.getByText(/Version 2.1.0 is installed/)).toBeDefined();
    expect(screen.getByText(/Restart the agent/)).toBeDefined();
  });

  it("does not repeat the restart notice on a plugin that will not load at all", () => {
    // "Restart to finish the upgrade" beside "could not load the plugin"
    // points at the wrong remedy.
    renderCard(
      node([
        {
          harnessId: "claude-code",
          enabled: true,
          installed: true,
          version: "2.1.0",
          restartRequired: true,
          broken: "boom",
        },
      ]),
    );
    expect(screen.queryByText(/Restart the agent/)).toBeNull();
  });

  it("does not badge a no-binary plugin as missing its program", () => {
    // The badge and the explanation underneath used to contradict each other.
    renderCard(node([{ harnessId: "some-terminal", enabled: true, installed: false, reason: "no-binary" }]));
    expect(screen.getByText("ready")).toBeDefined();
    expect(screen.queryByText("program not found")).toBeNull();
  });

  it("offers no actions on the control-plane host, whose plugins this route cannot reach", () => {
    // Every action there would 400; a control that cannot work is worse than
    // none at all.
    renderCard(node([{ harnessId: "claude-code", enabled: true, installed: true }]), true, true);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});
