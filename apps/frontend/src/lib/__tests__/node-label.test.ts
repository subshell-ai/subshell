import { describe, expect, it } from "bun:test";
import { nodeOptionLabel } from "@/lib/node-label";
import type { Node } from "@/types/node";

type Row = Pick<Node, "kind" | "status" | "name" | "os" | "arch">;

describe("nodeOptionLabel", () => {
  it("appends the platform for local under the caller's friendly name", () => {
    const local: Row = { kind: "local", status: "online", name: "host", os: "linux", arch: "x64" };
    expect(nodeOptionLabel(local, "Local")).toBe("Local · linux/x64");
    expect(nodeOptionLabel(local, "Local (this host)")).toBe("Local (this host) · linux/x64");
  });

  it("appends the platform for an online agent under its own name", () => {
    const n: Row = { kind: "agent", status: "online", name: "mac-mini", os: "darwin", arch: "arm64" };
    expect(nodeOptionLabel(n, "Local")).toBe("mac-mini · darwin/arm64");
  });

  it("keeps ' — offline' as the last segment, after the platform", () => {
    const n: Row = { kind: "agent", status: "offline", name: "old", os: "linux", arch: "x64" };
    expect(nodeOptionLabel(n, "Local")).toBe("old · linux/x64 — offline");
  });

  it("omits the platform when a young agent has not reported os/arch", () => {
    const online: Row = { kind: "agent", status: "online", name: "new", os: null, arch: null };
    const offline: Row = { kind: "agent", status: "offline", name: "new", os: null, arch: null };
    expect(nodeOptionLabel(online, "Local")).toBe("new");
    expect(nodeOptionLabel(offline, "Local")).toBe("new — offline");
  });
});
