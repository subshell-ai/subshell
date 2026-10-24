import { describe, expect, it } from "bun:test";
import { previewDisplayReadiness } from "./display-readiness.js";

describe("virtual display preflight", () => {
  it("reports every missing binary without starting a display", () => {
    expect(previewDisplayReadiness((name) => (name === "xauth" ? "/usr/bin/xauth" : null), "linux")).toEqual({
      supported: true,
      missing: ["Xvfb", "x11vnc"],
    });
    expect(previewDisplayReadiness((name) => `/usr/bin/${name}`, "linux")).toEqual({ supported: true, missing: [] });
  });
  it("doesn't probe Linux programs on unsupported platforms", () => {
    expect(
      previewDisplayReadiness(() => {
        throw new Error("unexpected probe");
      }, "darwin"),
    ).toEqual({ supported: false, missing: [] });
  });
});
