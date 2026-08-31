import { describe, expect, it } from "bun:test";
import { type InstanceRecord, removeInstance, upsertInstance } from "@/lib/instances";

const rec = (id: string, over: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id,
  label: id,
  email: null,
  wsBlocked: false,
  plainHttp: false,
  ...over,
});

describe("upsertInstance", () => {
  it("keeps one entry per origin, newest first", () => {
    let list: InstanceRecord[] = [];
    list = upsertInstance(list, rec("https://a"));
    list = upsertInstance(list, rec("https://b"));
    expect(list.map((r) => r.id)).toEqual(["https://b", "https://a"]);
  });

  it("refreshes a known origin in place without duplicating", () => {
    let list = [rec("https://a"), rec("https://b")];
    list = upsertInstance(list, rec("https://a", { email: "x@y.z" }));
    expect(list.map((r) => r.id)).toEqual(["https://a", "https://b"]);
    expect(list[0]?.email).toBe("x@y.z");
    expect(list).toHaveLength(2);
  });

  it("caps the registry at 10", () => {
    let list: InstanceRecord[] = [];
    for (let i = 0; i < 12; i++) list = upsertInstance(list, rec(`https://h${i}`));
    expect(list).toHaveLength(10);
    expect(list[0]?.id).toBe("https://h11");
  });

  it("is pure — returns a new array", () => {
    const base = [rec("https://a")];
    const next = upsertInstance(base, rec("https://b"));
    expect(base).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});

describe("removeInstance", () => {
  it("drops one entry, leaves the rest", () => {
    const list = removeInstance([rec("https://a"), rec("https://b")], "https://a");
    expect(list.map((r) => r.id)).toEqual(["https://b"]);
  });

  it("is a no-op for unknown ids", () => {
    expect(removeInstance([rec("https://a")], "https://zz")).toHaveLength(1);
  });
});
