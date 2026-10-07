import { describe, expect, it } from "bun:test";
import { sshLocationProblems } from "@/lib/ssh-location-form";

describe("saved remote folder readiness", () => {
  it("requires an absolute path, preserving spaces and destination spelling", () => {
    expect(sshLocationProblems({ path: "" }).path).toContain("absolute");
    expect(sshLocationProblems({ path: "project" }).path).toContain("absolute");
    expect(sshLocationProblems({ path: "/home/user/My project" })).toEqual({});
    expect(sshLocationProblems({ path: "/" })).toEqual({});
  });
  it("rejects forbidden path material and request-size overflow", () => {
    expect(sshLocationProblems({ path: "/bad\0path" }).path).toBeDefined();
    expect(sshLocationProblems({ path: `/${"x".repeat(4096)}` }).path).toBeDefined();
  });
});
