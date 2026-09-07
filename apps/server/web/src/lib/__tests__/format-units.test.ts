import { describe, expect, it } from "bun:test";
import { formatBytes, formatDuration } from "@/lib/format-units";

describe("formatBytes", () => {
  it("uses BINARY units, because these are memory and file sizes", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(11_370_496)).toBe("10.8 MiB");
  });

  it("leaves whole bytes without a decimal point", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders an em-dash for anything unknowable, never NaN or 'undefined'", () => {
    // The database size is null when the file cannot be stat'd; a status page
    // printing "NaN undefined" would read as a bug in the server.
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });

  it("stops at TiB rather than running off the unit table", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TiB");
  });
});

describe("formatDuration", () => {
  it("shows the two largest non-zero units", () => {
    expect(formatDuration(3 * 86_400 + 4 * 3_600)).toBe("3d 4h");
    expect(formatDuration(750)).toBe("12m 30s");
    expect(formatDuration(3_600)).toBe("1h 0m");
  });

  it("keeps a zero MIDDLE unit rather than skipping to a smaller one", () => {
    // 1d 0h must not render as "1d 5m" — the second slot is the next unit
    // down, not the next non-zero one, or the magnitude reads wrong.
    expect(formatDuration(86_400 + 300)).toBe("1d 0h");
  });

  it("says something honest below one second", () => {
    expect(formatDuration(0)).toBe("just started");
    expect(formatDuration(0.4)).toBe("just started");
  });

  it("renders seconds alone under a minute", () => {
    expect(formatDuration(42)).toBe("42s");
  });
});
