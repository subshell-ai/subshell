import { describe, expect, it } from "bun:test";
import type { PresetRow, SshPreset } from "@/types/preset";
import { parsePresetFile, presetFileFromRow, presetFileName, presetImportPayload } from "../preset-file";

const agent: PresetRow = {
  id: "private-id",
  userId: "owner",
  access: "edit",
  ownerName: "Owner",
  name: "Review setup",
  harnessId: "terminal",
  description: "Review code",
  envJson: '{"TOKEN":"secret","EMPTY":""}',
  flagsJson: '["--model","two words"]',
  settingsJson: '{"nested":{"enabled":true}}',
  configIsolation: 1,
  restartOnExit: 0,
  enabled: 1,
  crossCommEnabled: 1,
  crossCommNotes: "Use for reviews.",
  nodeId: "node-one",
  workingDir: "/work",
  promptBlocks: '[{"kind":"custom","description":"Task","body":"Review this"}]',
  createdAt: "now",
  updatedAt: "now",
};
const ssh: SshPreset = {
  kind: "ssh",
  id: "ssh-id",
  userId: "owner",
  name: "Connection",
  description: null,
  nodeId: "node-one",
  destination: "user@host:22",
  alias: "work",
  resolutionAlias: "work",
  authentication: "remote",
  keyHome: "node-two",
  fingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  forwards: [{ kind: "local", listenPort: 8080, bindHost: null, targetHost: "localhost", targetPort: 80 }],
  enabled: 1,
  createdAt: "now",
  updatedAt: "now",
};
describe("preset files v1", () => {
  it("accepts 8,000 characters of notes and rejects 8,001 on import", () => {
    const file = (length: number) =>
      JSON.stringify(presetFileFromRow({ ...agent, crossCommNotes: "x".repeat(length) }));
    expect(parsePresetFile(file(8_000)).preset).toHaveProperty("crossCommNotes", "x".repeat(8_000));
    expect(() => parsePresetFile(file(8_001))).toThrow("crossCommNotes");
  });
  it("round-trips every agent setting without ownership or grants", () => {
    const file = presetFileFromRow(agent);
    expect(file.version).toBe(1);
    expect(file.format).toBe("subshell-preset");
    const preset = parsePresetFile(JSON.stringify(file)).preset;
    expect(preset).toMatchObject({
      kind: "agent",
      env: { TOKEN: "secret", EMPTY: "" },
      flags: ["--model", "two words"],
      settings: { nested: { enabled: true } },
      configIsolation: true,
      restartOnExit: false,
      crossCommEnabled: true,
      crossCommNotes: "Use for reviews.",
    });
    for (const field of ["id", "userId", "access", "ownerName", "createdAt", "updatedAt", "shares"])
      expect(field in preset).toBe(false);
    expect(presetImportPayload(preset)).toMatchObject({
      harnessId: "terminal",
      nodeId: "node-one",
      workingDir: "/work",
      promptBlocks: [{ kind: "custom", description: "Task", body: "Review this" }],
    });
  });
  it("round-trips SSH choices and pins import resolution to the exported destination", () => {
    const preset = parsePresetFile(JSON.stringify(presetFileFromRow(ssh))).preset;
    expect(preset).toMatchObject({
      kind: "ssh",
      forwards: ssh.forwards,
      keyHome: "node-two",
      fingerprints: ssh.fingerprints,
      resolutionAlias: "work",
    });
    expect(presetImportPayload(preset)).toMatchObject({ expectedDestination: "user@host:22" });
  });
  it("rejects malformed, unsupported, oversized, and incomplete files", () => {
    const good = presetFileFromRow(agent);
    expect(() => parsePresetFile("{")).toThrow("valid JSON");
    expect(() => parsePresetFile(JSON.stringify({ ...good, version: 2 }))).toThrow("unsupported version");
    expect(() => parsePresetFile(JSON.stringify({ ...good, format: "other" }))).toThrow("invalid");
    expect(() => parsePresetFile(JSON.stringify({ version: 1 }))).toThrow("invalid");
    expect(() => parsePresetFile(" ".repeat(1024 * 1024 + 1))).toThrow("1 MiB");
  });
  it("rejects hidden ownership, SSH credentials, invalid env names, and invalid forwarding", () => {
    const a = presetFileFromRow(agent);
    const s = presetFileFromRow(ssh);
    expect(() => parsePresetFile(JSON.stringify({ ...a, preset: { ...a.preset, userId: "victim" } }))).toThrow(
      "invalid",
    );
    expect(() => parsePresetFile(JSON.stringify({ ...s, preset: { ...s.preset, privateKey: "secret" } }))).toThrow(
      "invalid",
    );
    expect(() => parsePresetFile(JSON.stringify({ ...a, preset: { ...a.preset, env: { "BAD;NAME": "x" } } }))).toThrow(
      "invalid",
    );
    expect(() =>
      parsePresetFile(
        JSON.stringify({ ...s, preset: { ...s.preset, forwards: [{ ...ssh.forwards[0], listenPort: 70000 }] } }),
      ),
    ).toThrow("invalid");
  });
  it("rejects contradictory key settings and prompts exceeding the joined limit", () => {
    const a = presetFileFromRow(agent),
      s = presetFileFromRow(ssh);
    expect(() =>
      parsePresetFile(JSON.stringify({ ...s, preset: { ...s.preset, authentication: "password" } })),
    ).toThrow("Only remote");
    expect(() =>
      parsePresetFile(
        JSON.stringify({
          ...a,
          preset: {
            ...a.preset,
            promptBlocks: [
              { kind: "custom", description: "", body: "a".repeat(10000) },
              { kind: "custom", description: "", body: "b".repeat(10000) },
            ],
          },
        }),
      ),
    ).toThrow("20,000");
  });
  it("uses the preset name with a .preset suffix and sanitizes path characters", () => {
    expect(presetFileName("Review setup")).toBe("Review setup.preset");
    expect(presetFileName("../review: setup")).toBe(".._review_ setup.preset");
  });
});

it("exports retained presets after node deletion, but requires remapping before import", () => {
  const a = presetFileFromRow({ ...agent, nodeId: null }).preset;
  expect(() => presetImportPayload(a)).toThrow("Choose a launch node");
  expect(presetImportPayload({ ...a, nodeId: "replacement" }).nodeId).toBe("replacement");
  const s = presetFileFromRow({ ...ssh, keyHome: null }).preset;
  expect(() => presetImportPayload(s)).toThrow("supply the SSH keys");
  if (s.kind !== "ssh") throw new Error("Expected SSH");
  expect(presetImportPayload({ ...s, keyHome: "replacement" })).toMatchObject({ keyHome: "replacement" });
});
