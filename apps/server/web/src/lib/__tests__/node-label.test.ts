import { describe, expect, it } from "bun:test";
import { nodeOptionLabel } from "@/lib/node-label";
import type { Node } from "@/types/node";

type Row = Pick<Node, "kind" | "status" | "name" | "os" | "arch">;

describe("nodeOptionLabel", () => {
  it("labels the control-plane host by its OWN name, so a rename reaches every picker", () => {
    const local: Row = { kind: "local", status: "online", name: "Server", os: "linux", arch: "x64" };
    expect(nodeOptionLabel(local)).toBe("Server · linux/x64");
    expect(nodeOptionLabel({ ...local, name: "Prod host" })).toBe("Prod host · linux/x64");
  });

  it("never renders the node id, which is not a label", () => {
    const local: Row = { kind: "local", status: "online", name: "Server", os: null, arch: null };
    expect(nodeOptionLabel(local)).not.toContain("local");
  });

  it("appends the platform for an online agent under its own name", () => {
    const n: Row = { kind: "agent", status: "online", name: "mac-mini", os: "darwin", arch: "arm64" };
    expect(nodeOptionLabel(n)).toBe("mac-mini · darwin/arm64");
  });

  it("keeps ' — offline' as the last segment, after the platform", () => {
    const n: Row = { kind: "agent", status: "offline", name: "old", os: "linux", arch: "x64" };
    expect(nodeOptionLabel(n)).toBe("old · linux/x64 — offline");
  });

  it("omits the platform when a young agent has not reported os/arch", () => {
    const online: Row = { kind: "agent", status: "online", name: "new", os: null, arch: null };
    const offline: Row = { kind: "agent", status: "offline", name: "new", os: null, arch: null };
    expect(nodeOptionLabel(online)).toBe("new");
    expect(nodeOptionLabel(offline)).toBe("new — offline");
  });
});
