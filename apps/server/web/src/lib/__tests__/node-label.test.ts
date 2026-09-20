import { describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { nodeOptionLabel } from "@/lib/node-label";

type Row = Pick<Node, "kind" | "status" | "name" | "os" | "arch" | "maintenance">;

describe("nodeOptionLabel", () => {
  it("labels the control-plane host by its OWN name, so a rename reaches every picker", () => {
    const local: Row = {
      kind: "local",
      status: "online",
      name: "Server",
      os: "linux",
      arch: "x64",
      maintenance: false,
    };
    expect(nodeOptionLabel(local)).toBe("Server · linux/x64");
    expect(nodeOptionLabel({ ...local, name: "Prod host" })).toBe("Prod host · linux/x64");
  });

  it("never renders the node id, which is not a label", () => {
    const local: Row = { kind: "local", status: "online", name: "Server", os: null, arch: null, maintenance: false };
    expect(nodeOptionLabel(local)).not.toContain("local");
  });

  it("appends the platform for an online agent under its own name", () => {
    const n: Row = {
      kind: "agent",
      status: "online",
      name: "mac-mini",
      os: "darwin",
      arch: "arm64",
      maintenance: false,
    };
    expect(nodeOptionLabel(n)).toBe("mac-mini · darwin/arm64");
  });

  it("keeps ' (offline)' as the last segment, after the platform", () => {
    const n: Row = { kind: "agent", status: "offline", name: "old", os: "linux", arch: "x64", maintenance: false };
    expect(nodeOptionLabel(n)).toBe("old · linux/x64 (offline)");
  });

  it("omits the platform when a young agent has not reported os/arch", () => {
    const online: Row = { kind: "agent", status: "online", name: "new", os: null, arch: null, maintenance: false };
    const offline: Row = { kind: "agent", status: "offline", name: "new", os: null, arch: null, maintenance: false };
    expect(nodeOptionLabel(online)).toBe("new");
    expect(nodeOptionLabel(offline)).toBe("new (offline)");
  });

  it("appends ' (maintenance)' after the offline segment, so a greyed row still explains itself", () => {
    // A node in maintenance stays VISIBLE in the picker rather than vanishing
    // (spec 2026-09-14 §6), which only works if the label says why it cannot
    // be picked.
    const n: Row = {
      kind: "agent",
      status: "online",
      name: "mac-mini",
      os: "darwin",
      arch: "arm64",
      maintenance: true,
    };
    expect(nodeOptionLabel(n)).toBe("mac-mini · darwin/arm64 (maintenance)");
  });

  it("prints BOTH words when a machine is down AND under maintenance", () => {
    // Ending maintenance would not make this one launchable, so hiding either
    // half would send someone to fix the wrong thing.
    const n: Row = { kind: "agent", status: "offline", name: "old", os: null, arch: null, maintenance: true };
    expect(nodeOptionLabel(n)).toBe("old (offline) (maintenance)");
  });

  it("reads a payload from a server older than the flag as not in maintenance", () => {
    // `maintenance` is absent on the wire from such a server; the label must
    // not sprout a word for a state nothing reported.
    const n = { kind: "agent", status: "online", name: "mac-mini", os: null, arch: null } as unknown as Row;
    expect(nodeOptionLabel(n)).toBe("mac-mini");
  });
});
