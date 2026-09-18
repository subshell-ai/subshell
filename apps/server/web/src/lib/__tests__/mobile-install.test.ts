import { describe, expect, it } from "bun:test";
import { installPlatformFor } from "@/lib/mobile-install";

describe("installPlatformFor", () => {
  it("picks the tab that matches the device reading it", () => {
    expect(installPlatformFor("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe(
      "apple",
    );
    expect(installPlatformFor("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("apple");
    expect(installPlatformFor("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36")).toBe("android");
    expect(installPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141")).toBe(
      "browser",
    );
    expect(installPlatformFor("")).toBe("browser");
  });

  it("reads an iPad that lies about being a Mac", () => {
    // iPadOS 13+ Safari sends a desktop Macintosh UA by default. The tell is
    // touch: no Mac reports touch points, and an iPad shown the desktop steps
    // is shown steps its browser does not have.
    expect(installPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5)).toBe("apple");
    expect(installPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0)).toBe(
      "browser",
    );
  });
});
