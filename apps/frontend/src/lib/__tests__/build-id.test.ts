import { describe, expect, it } from "bun:test";
import { buildIdFrom } from "@/lib/build-id";

/**
 * The attach line's `build=` field only means something if a rebuild changes
 * it and a source path never fakes one — that is the whole point of reporting
 * it (see lib/build-id.ts).
 */
describe("buildIdFrom", () => {
  it("takes the content hash off a built chunk URL", () => {
    expect(buildIdFrom("https://subshell.example/assets/index-DGQT8EKK.js")).toBe("DGQT8EKK");
  });

  it("handles chunk names that themselves contain dashes", () => {
    expect(buildIdFrom("https://x/assets/use-subshell-log-B5IhOdMk.js")).toBe("B5IhOdMk");
  });

  it("ignores a query string", () => {
    expect(buildIdFrom("https://x/assets/index-DGQT8EKK.js?t=1")).toBe("DGQT8EKK");
  });

  it("reports dev rather than inventing an id for unbuilt sources", () => {
    // The dev server serves real source paths; `build-id` is dashed but its
    // last segment is not a hash, so it must not masquerade as a build.
    expect(buildIdFrom("http://localhost:5174/src/lib/build-id.ts")).toBe("dev");
    expect(buildIdFrom("http://localhost:5174/src/lib/api.ts")).toBe("dev");
    expect(buildIdFrom("")).toBe("dev");
  });

  it("a different build reports a different id — what makes a reload visible", () => {
    expect(buildIdFrom("https://x/assets/index-AAAAAAAA.js")).not.toBe(
      buildIdFrom("https://x/assets/index-BBBBBBBB.js"),
    );
  });
});
