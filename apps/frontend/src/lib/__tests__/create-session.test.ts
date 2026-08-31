import { describe, expect, it } from "bun:test";
import { toSessionCreateBody } from "@/hooks/use-create-session";

describe("toSessionCreateBody", () => {
  it("sends the trimmed name when there is one", () => {
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "  deck  " })).toEqual({
      profileId: "p1",
      workingDir: "/tmp/x",
      name: "deck",
    });
  });

  it("omits the name when blank, so the backend's date/time default applies", () => {
    const body = toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "   " });
    expect(body.name).toBeUndefined();
    expect("name" in body).toBe(true); // the key exists with undefined — JSON.stringify drops it
    expect(JSON.parse(JSON.stringify(body))).toEqual({ profileId: "p1", workingDir: "/tmp/x" });
  });
});
