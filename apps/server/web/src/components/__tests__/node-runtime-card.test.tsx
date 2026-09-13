import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { lingerNote, NodeRuntimeCard } from "@/components/nodes/node-runtime-card";
import type { NodeDetail, NodeRuntime } from "@/types/node";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** An online agent node the viewer owns — the only case the card renders for. */
const base: NodeDetail = {
  id: "n1",
  name: "devbox",
  kind: "agent",
  os: "linux",
  arch: "x64",
  hostname: "devbox.local",
  status: "online",
  lastSeenAt: "2026-09-12T10:00:00.000Z",
  agentVersion: "0.2.0",
  protocolVersion: 4,
  access: "owner",
  canManage: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
};

/** A supervised systemd agent, with the fields each test varies. */
function runtime(over: Partial<NodeRuntime> = {}): NodeRuntime {
  return {
    startedAt: "2026-09-12T10:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/u/.config/systemd/user/subshell.service",
      state: "running",
      pid: 511,
      enabled: true,
      paneSafety: "keeps",
    },
    configPath: "/u/.config/subshell/config.json",
    agentLogPath: "/u/.config/subshell/logs/agent.log",
    logging: { debug: false, source: "default" },
    logPath: null,
    logHint: "journalctl --user -u subshell.service -f",
    tmuxPath: null,
    binaryPath: "/u/.local/bin/subshell",
    ...over,
  };
}

function renderCard(node: NodeDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeRuntimeCard node={node} />
    </QueryClientProvider>,
  );
}

describe("NodeRuntimeCard", () => {
  it("renders nothing without a runtime report", () => {
    // Absent for an offline node, for a `view` grantee, and for `local` — in
    // every one of those the card would be asserting facts it does not have.
    renderCard(base);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("shows supervision, paths and the journal hint", () => {
    renderCard({ ...base, runtime: runtime() });
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText(/systemd \(pid 511\)/)).toBeTruthy();
    expect(screen.getByText("journalctl --user -u subshell.service -f")).toBeTruthy();
    expect(screen.getByText("/u/.config/subshell/config.json")).toBeTruthy();
    // A node without tmux accepts no launches, which is invisible until
    // someone tries — so it is said here rather than discovered there.
    expect(screen.getByText(/not found: this node accepts no launches/)).toBeTruthy();
  });

  // Facts only since the node Service surface landed: the verbs moved to
  // `NodeServiceCard`, and two cards each offering Restart on one page would
  // raise the question of whether they differ.
  it("offers no controls — the verbs live in the Service card", () => {
    renderCard({ ...base, runtime: runtime() });
    expect(screen.queryAllByRole("button", { name: /restart/i })).toEqual([]);
  });

  it("says so when the agent is not supervised", () => {
    renderCard({
      ...base,
      runtime: runtime({
        supervised: false,
        service: {
          manager: null,
          installed: false,
          definitionPath: null,
          state: "unknown",
          pid: null,
          enabled: null,
          paneSafety: "unknown",
        },
        tmuxPath: "/usr/bin/tmux",
      }),
    });
    expect(screen.getByText(/Not supervised/)).toBeTruthy();
  });
});

/** A service definition that takes the panes down with the process. */
function _killing(): NodeRuntime["service"] {
  return {
    manager: "systemd",
    installed: true,
    definitionPath: "/u/.config/systemd/user/subshell.service",
    state: "running",
    pid: 511,
    enabled: true,
    paneSafety: "kills",
  };
}

describe("lingerNote", () => {
  it("says that starting at login is not staying up after logout, on systemd", () => {
    // The two axes, one layer down from the server's own card: a `--user` unit
    // runs inside its owner's login session, so it comes up at login and goes
    // down at LOGOUT. On a headless box nobody logs into, that is the
    // difference between the agent being there and not. The agent's installer
    // already says so — to a terminal, on a machine with no terminal open.
    expect(lingerNote(runtime())).toContain("enable-linger");
  });

  it("says nothing where the caveat does not apply", () => {
    // launchd has no equivalent knob: a LaunchAgent's lifetime IS the GUI
    // session by design, and a machine with nobody logged in runs neither.
    expect(lingerNote(runtime({ service: { ...runtime().service, manager: "launchd" } }))).toBe(null);
    // Nothing arms it, so there is nothing to qualify.
    expect(lingerNote(runtime({ service: { ...runtime().service, enabled: false } }))).toBe(null);
    expect(lingerNote(runtime({ supervised: false }))).toBe(null);
  });
});
