import { describe, expect, it } from "bun:test";
import { xvfbDisplayReadiness } from "./xvfb-display-provider.js";

describe("virtual display preflight", () => {
  it("reports every missing binary without starting a display", () => {
    expect(xvfbDisplayReadiness((name) => (name === "xauth" ? "/usr/bin/xauth" : null), "linux")).toEqual({
      supported: true,
      missing: ["Xvfb", "x11vnc"],
    });
    expect(xvfbDisplayReadiness((name) => `/usr/bin/${name}`, "linux")).toEqual({ supported: true, missing: [] });
  });
  it("doesn't probe Linux programs on unsupported platforms", () => {
    expect(
      xvfbDisplayReadiness(() => {
        throw new Error("unexpected probe");
      }, "darwin"),
    ).toEqual({ supported: false, missing: [] });
  });
});
