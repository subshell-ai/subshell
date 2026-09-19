import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeRow, osLabel } from "@/components/nodes/node-row";

const BASE: Node = {
  id: "n1",
  name: "mac mini",
  kind: "agent",
  os: "darwin",
  arch: "arm64",
  hostname: "mac-mini",
  status: "online",
  lastSeenAt: new Date().toISOString(),
  agentVersion: null,
  protocolVersion: null,
  access: "owner",
  canManage: true,
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [
    { harnessId: "claude", name: "Claude", installed: true },
    { harnessId: "opencode", name: "OpenCode", installed: false },
    { harnessId: "hermes", name: "Hermes", installed: true },
  ],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  held: null,
};

/** Six detected harnesses — more than the row shows inline. */
const MANY_HARNESSES: Node = {
  ...BASE,
  harnesses: ["claude", "opencode", "codex", "hermes", "pi", "terminal"].map((harnessId) => ({
    harnessId,
    name: harnessId,
    installed: true,
  })),
};

/** Opens the row's ActionsMenu the keyboard way (same trick as actions-menu.test). */
async function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

afterEach(cleanup);

describe("osLabel", () => {
  it("brands darwin and linux, renders unknown values raw", () => {
    expect(osLabel("darwin")).toBe("Apple");
    expect(osLabel("linux")).toBe("Linux");
    expect(osLabel("freebsd")).toBe("freebsd");
    expect(osLabel(null)).toBe("unknown");
  });
});

describe("NodeRow", () => {
  it("shows the OS/arch chip, status, and a chip per harness whose program was found", () => {
    render(
      <NodeRow node={BASE} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} onMaintenance={() => {}} />,
    );
    expect(screen.getByText("mac mini")).toBeDefined();
    expect(screen.getByText(/Apple · arm64/)).toBeDefined();
    expect(screen.getByText("online")).toBeDefined();
    expect(screen.getByText("claude")).toBeDefined();
    expect(screen.getByText("hermes")).toBeDefined();
    // The one filter left. `opencode` is a plugin this node has whose program
    // was not detected; the enable flag that used to be the other filter is
    // gone (spec 2026-09-09 §12).
    expect(screen.queryByText("opencode")).toBeNull();
    expect(screen.getByText("yours")).toBeDefined();
  });

  it("truncates only the HARNESS chips, and the control names how many are held back", () => {
    // Six detected harnesses is what crushed this row: the badges never
    // shrink, so the name block collapsed to about one character.
    render(
      <NodeRow
        node={MANY_HARNESSES}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    for (const id of ["claude", "opencode", "codex"]) expect(screen.getByText(id)).toBeDefined();
    for (const id of ["hermes", "pi", "terminal"]) expect(screen.queryByText(id)).toBeNull();
    expect(screen.getByRole("button", { name: "+3 more" })).toBeDefined();
  });

  it("reveals the rest on click, and collapses again", () => {
    render(
      <NodeRow
        node={MANY_HARNESSES}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+3 more" }));
    for (const id of ["hermes", "pi", "terminal"]) expect(screen.getByText(id)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByText("terminal")).toBeNull();
    expect(screen.getByRole("button", { name: "+3 more" })).toBeDefined();
  });

  it("never hides the OS, status, stale or access badges behind the more control", () => {
    // Each of these is ONE chip of fixed shape, so none of them is what makes
    // the row too long — and `inventory stale` is a warning, which must never
    // need a click to be seen.
    render(
      <NodeRow
        node={{ ...MANY_HARNESSES, inventoryStale: true, access: "view", canManage: false }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    expect(screen.getByText(/Apple · arm64/)).toBeDefined();
    expect(screen.getByText("online")).toBeDefined();
    expect(screen.getByText("inventory stale")).toBeDefined();
    expect(screen.getByText("shared · view")).toBeDefined();
  });

  it("renders the node's whole name beside a full set of chips", () => {
    // The regression this closes: the name block had a zero flex-basis and no
    // minimum, so a row with this many badges rendered one letter per line.
    render(
      <NodeRow
        node={{ ...MANY_HARNESSES, name: "workshop-mac-studio" }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    expect(screen.getByText("workshop-mac-studio")).toBeDefined();
  });

  it("reads offline as a muted badge and shared access as a badge", () => {
    render(
      <NodeRow
        node={{ ...BASE, status: "offline", access: "edit", canManage: false }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    expect(screen.getByText("offline")).toBeDefined();
    expect(screen.getByText("shared · edit")).toBeDefined();
  });

  it("names the control-plane host's machine rather than calling it the reader's", () => {
    // "this machine" is false for every user who is not sitting at the server,
    // and this is the row most likely to be misread as one's own laptop.
    render(
      <NodeRow
        node={{ ...BASE, id: "local", kind: "local", name: "Server", hostname: "theo-desktop" }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    expect(screen.getByText(/theo-desktop/)).toBeTruthy();
    expect(screen.queryByText(/this machine/i)).toBeNull();
  });

  it("enables Share for a non-owner manager (admin on local — server-derived canManage)", async () => {
    render(
      <NodeRow
        node={{ ...BASE, id: "local", kind: "local", access: "edit", canManage: true }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    await openMenu("mac mini");
    expect(screen.getByRole("menuitem", { name: "Share" }).getAttribute("aria-disabled")).not.toBe("true");
    // `local` stays undeletable server-side, so its Delete is disabled even for a manager.
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers owners enabled Delete/Share", async () => {
    render(
      <NodeRow node={BASE} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} onMaintenance={() => {}} />,
    );
    await openMenu("mac mini");
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByRole("menuitem", { name: "Share" }).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("shows Delete and Share DISABLED (not hidden) for a non-owner", async () => {
    render(
      <NodeRow
        node={{ ...BASE, access: "view", canManage: false }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    await openMenu("mac mini");
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Share" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Open config" })).toBeDefined();
  });

  it("shows the maintenance badge only while the flag is set", () => {
    const { rerender } = render(
      <NodeRow node={BASE} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} onMaintenance={() => {}} />,
    );
    expect(screen.queryByText("maintenance")).toBeNull();
    rerender(
      <NodeRow
        node={{ ...BASE, maintenance: true }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    expect(screen.getByText("maintenance")).toBeDefined();
  });

  it("keeps the maintenance badge out of the '+N more' overflow", async () => {
    // It is a warning, and the rule this row follows is that a warning never
    // needs a click to be seen — the same reason `inventory stale` rides
    // beside the status badge instead of among the harness chips.
    render(
      <NodeRow
        node={{ ...MANY_HARNESSES, maintenance: true }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    expect(screen.getByText("maintenance")).toBeDefined();
    expect(screen.getByRole("button", { name: "+3 more" })).toBeDefined();
  });

  it("flips the menu item between starting and ending, and only the start asks", async () => {
    render(
      <NodeRow node={BASE} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} onMaintenance={() => {}} />,
    );
    await openMenu("mac mini");
    // The ellipsis is the promise that a confirmation follows; ending
    // maintenance only widens what the machine accepts, so it carries none.
    expect(screen.getByRole("menuitem", { name: "Start maintenance…" })).toBeDefined();
    cleanup();

    render(
      <NodeRow
        node={{ ...BASE, maintenance: true }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    await openMenu("mac mini");
    expect(screen.getByRole("menuitem", { name: "End maintenance" })).toBeDefined();
  });

  it("calls back when the item is picked, leaving the confirm and the PUT to the caller", async () => {
    let picked = 0;
    render(
      <NodeRow
        node={BASE}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {
          picked += 1;
        }}
      />,
    );
    await openMenu("mac mini");
    fireEvent.click(screen.getByRole("menuitem", { name: "Start maintenance…" }));
    await waitFor(() => expect(picked).toBe(1));
  });

  it("shows maintenance DISABLED for a viewer who cannot manage the node", async () => {
    // Shown rather than hidden, like Delete and Share: the row reads the same
    // to everyone, and the server is the gate.
    render(
      <NodeRow
        node={{ ...BASE, access: "edit", canManage: false }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onMaintenance={() => {}}
      />,
    );
    await openMenu("mac mini");
    expect(screen.getByRole("menuitem", { name: "Start maintenance…" }).getAttribute("aria-disabled")).toBe("true");
  });
});
