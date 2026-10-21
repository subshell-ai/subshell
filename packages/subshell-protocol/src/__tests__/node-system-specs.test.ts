import { expect, it } from "bun:test";
import { parseNodeEvent } from "../node-frames.js";
import { parseNodeSystemSpecs } from "../node-system-specs.js";

const specs = {
  osRelease: "6.12",
  cpuModel: "Example CPU",
  logicalCpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  reportedAt: "2026-10-21T00:00:00.000Z",
};
const ready = {
  type: "ready",
  agentVersion: "1.0.0",
  protocolVersion: 14,
  os: "linux",
  arch: "x64",
  hostname: "node",
  dataDir: "/data",
  capabilities: [],
};
it("keeps bounded reports and drops malformed reports without losing the ready frame", () => {
  expect(parseNodeSystemSpecs(specs)).toEqual(specs);
  expect(parseNodeEvent({ ...ready, systemSpecs: specs })).toMatchObject({ systemSpecs: specs });
  for (const invalid of [
    null,
    { ...specs, logicalCpuCount: -1 },
    { ...specs, totalMemoryBytes: Infinity },
    { ...specs, cpuModel: "x".repeat(513) },
    { ...specs, reportedAt: "bad" },
  ]) {
    expect(parseNodeSystemSpecs(invalid)).toBeNull();
    expect(parseNodeEvent({ ...ready, systemSpecs: invalid })).not.toHaveProperty("systemSpecs");
  }
  expect(parseNodeEvent(ready)).not.toHaveProperty("systemSpecs");
});
