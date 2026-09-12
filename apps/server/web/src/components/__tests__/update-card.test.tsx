import { describe, expect, it } from "bun:test";
import { updateAvailable } from "@/components/service/update-card";

describe("updateAvailable", () => {
  it("names the bundled version only when it is newer than the running server", () => {
    expect(updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1, bundledServer: "0.3.0" }, "0.2.0")).toBe(
      "0.3.0",
    );
    expect(
      updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1, bundledServer: "0.2.0" }, "0.2.0"),
    ).toBeNull();
    // An older shell sends no `b=` at all, and a browser sends no marker.
    expect(updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1 }, "0.2.0")).toBeNull();
    expect(updateAvailable(null, "0.2.0")).toBeNull();
  });

  it("says nothing while the server version is still unknown", () => {
    // A cached PWA can outlive the field; offering an update against an
    // unknown current version would be a guess presented as a fact.
    expect(
      updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1, bundledServer: "0.3.0" }, undefined),
    ).toBeNull();
  });

  it("never offers a DOWNGRADE when the shell is older than the server", () => {
    expect(
      updateAvailable({ version: "0.2.0", platform: "linux", protocol: 1, bundledServer: "0.1.0" }, "0.4.0"),
    ).toBeNull();
  });
});
