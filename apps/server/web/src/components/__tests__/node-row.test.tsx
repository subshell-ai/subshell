import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeRow, osLabel } from "@/components/nodes/node-row";
import type { Node } from "@/types/node";

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
  capabilities: [],
  harnesses: [
    { harnessId: "claude", enabled: true, installed: true },
    { harnessId: "opencode", enabled: true, installed: false },
    { harnessId: "hermes", enabled: false, installed: true },
  ],
  inventoryStale: false,
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
  it("shows the OS/arch chip, status, and only installed∧enabled harness chips", () => {
    render(<NodeRow node={BASE} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} />);
    expect(screen.getByText("mac mini")).toBeDefined();
    expect(screen.getByText(/Apple · arm64/)).toBeDefined();
    expect(screen.getByText("online")).toBeDefined();
    expect(screen.getByText("claude")).toBeDefined();
    expect(screen.queryByText("opencode")).toBeNull();
    expect(screen.queryByText("hermes")).toBeNull();
    expect(screen.getByText("yours")).toBeDefined();
  });

  it("reads offline as a muted badge and shared access as a badge", () => {
    render(
      <NodeRow
        node={{ ...BASE, status: "offline", access: "edit", canManage: false }}
        onOpenConfig={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
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
      />,
    );
    await openMenu("mac mini");
    expect(screen.getByRole("menuitem", { name: "Share" }).getAttribute("aria-disabled")).not.toBe("true");
    // `local` stays undeletable server-side, so its Delete is disabled even for a manager.
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers owners enabled Delete/Share", async () => {
    render(<NodeRow node={BASE} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} />);
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
      />,
    );
    await openMenu("mac mini");
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Share" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Open config" })).toBeDefined();
  });
});
