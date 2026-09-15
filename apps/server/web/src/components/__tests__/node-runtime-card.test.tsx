import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NodeRuntimeCard, supervisionLine } from "@/components/nodes/node-runtime-card";
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
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  held: null,
};

/** A supervised systemd agent on a lingering machine, with the fields each test varies. */
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
      linger: true,
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

/** The service block, varied per persistence case without restating the rest. */
function service(over: Partial<NodeRuntime["service"]> = {}): NodeRuntime["service"] {
  return { ...runtime().service, ...over };
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
          linger: null,
          paneSafety: "unknown",
        },
        tmuxPath: "/usr/bin/tmux",
      }),
    });
    expect(screen.getByText(/Not supervised/)).toBeTruthy();
  });

  // The supervision line used to end "· starts at login", which hinted at the
  // question "Comes back" now answers outright — and hinted the half that is
  // wrong on a systemd machine whose user does not linger.
  it("leaves the login question to 'Comes back' rather than trailing the supervision line", () => {
    expect(supervisionLine(runtime())).toBe("systemd (pid 511)");
    expect(supervisionLine(runtime({ service: service({ enabled: false }) }))).toBe("systemd (pid 511)");
    renderCard({ ...base, runtime: runtime() });
    expect(screen.queryByText(/starts at login/)).toBeNull();
  });
});

/**
 * The one question a headless node's owner actually has, and the only surface
 * that answers it for them. It used to be a static caveat printed under every
 * enabled systemd node explaining BOTH outcomes; the agent reports `linger`
 * now, so the card says which one this machine is.
 */
describe("NodeRuntimeCard — Comes back", () => {
  it("states the lingering machine as settled, and offers no command", () => {
    renderCard({ ...base, runtime: runtime() });
    expect(screen.getByText("Comes back")).toBeTruthy();
    expect(screen.getByText("Comes back after a reboot, without anyone logging in.")).toBeTruthy();
    // Nothing to fix, so nothing to run: the advice that used to print here
    // unconditionally is exactly what the measurement replaces.
    expect(document.body.textContent).not.toContain("loginctl");
  });

  it("names the logout on a machine logind says does not linger, with the command", () => {
    renderCard({ ...base, runtime: runtime({ service: service({ linger: false }) }) });
    expect(screen.getByText("Comes back when you log in, and stops when you log out.")).toBeTruthy();
    expect(screen.getByText(/To keep it running after you log out:/)).toBeTruthy();
    expect(screen.getByText("loginctl enable-linger $USER")).toBeTruthy();
  });

  it("asks rather than accuses when logind never answered", () => {
    renderCard({ ...base, runtime: runtime({ service: service({ linger: null }) }) });
    // The node's own name, because the reader is not sitting at this machine.
    expect(screen.getByText(/If nobody logs in to devbox, it needs lingering to stay up\./)).toBeTruthy();
    expect(screen.getByText(/If it needs to stay up with nobody logged in:/)).toBeTruthy();
    expect(screen.getByText("loginctl enable-linger $USER")).toBeTruthy();
  });

  it("answers launchd with the login session, and no knob", () => {
    // A LaunchAgent's lifetime IS the login session by design; there is no
    // linger equivalent and none is missing.
    renderCard({ ...base, runtime: runtime({ service: service({ manager: "launchd", linger: null }) }) });
    expect(screen.getByText("Comes back when you log in to devbox.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("loginctl");
  });

  it("points an unarmed definition at the Service card, which is where the act lives", () => {
    renderCard({ ...base, runtime: runtime({ service: service({ enabled: false, linger: null }) }) });
    expect(screen.getByText("Will not come back after a reboot.")).toBeTruthy();
    expect(screen.getByText(/Install service below writes a definition and enables it\./)).toBeTruthy();
    // There is no node route for arming one, so the card must not imply it.
    expect(document.body.textContent).not.toContain("loginctl");
  });

  it("points a machine with no definition at the same button", () => {
    renderCard({
      ...base,
      runtime: runtime({
        supervised: false,
        service: service({ manager: null, installed: false, definitionPath: null, enabled: null, linger: null }),
      }),
    });
    expect(screen.getByText("Started by hand. Nothing brings it back when it stops.")).toBeTruthy();
    expect(screen.getByText(/Install service below writes a definition and enables it\./)).toBeTruthy();
  });
});
