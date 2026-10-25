import { expect, it } from "bun:test";
import { sshDraftFromPreset, sshPresetPayload } from "@/lib/ssh-preset";
import type { SshPreset } from "@/types/preset";

const preset: SshPreset = {
  kind: "ssh",
  id: "p",
  name: "Build",
  description: null,
  nodeId: "desk",
  destination: "user@host:22",
  alias: "build",
  authentication: "remote",
  keyHome: "keys",
  fingerprints: ["SHA256:one"],
  forwards: [],
  enabled: 1,
  createdAt: "t",
  updatedAt: "t",
};
it("restores only the selected remote node's fingerprints into a fresh draft", () => {
  const draft = sshDraftFromPreset(preset);
  expect(draft).toMatchObject({
    nodeId: "desk",
    authentication: "remote",
    keyHome: "keys",
    selections: { keys: ["SHA256:one"] },
  });
  expect(draft.saveAsPreset).toBeUndefined();
  draft.selections.keys.push("other");
  expect(preset.fingerprints).toEqual(["SHA256:one"]);
});
it("projects the local-key preference without key, credential, or stale remote state", () => {
  const draft = {
    ...sshDraftFromPreset(preset),
    authentication: "local-key" as const,
    localKeyId: "secret",
    filename: "id_ed25519",
    passphrase: "secret",
  };
  expect(sshPresetPayload(draft, " Local ")).toEqual({
    kind: "ssh",
    name: "Local",
    description: null,
    nodeId: "desk",
    destination: "user@host:22",
    expectedDestination: "user@host:22",
    alias: null,
    authentication: "local-key",
    keyHome: null,
    fingerprints: [],
    forwards: [],
  });
});
it.each(["connecting", "remote", "local-key", "password"] as const)(
  "round trips %s authentication",
  (authentication) => {
    const payload = sshPresetPayload(sshDraftFromPreset({ ...preset, authentication }), "Build");
    expect(payload.authentication).toBe(authentication);
    expect(payload.fingerprints).toEqual(authentication === "remote" ? preset.fingerprints : []);
  },
);
it("retains a missing node as a choice the user must complete", () => {
  expect(sshDraftFromPreset({ ...preset, nodeId: null }).nodeId).toBe("");
});

it("reuses the resolution alias with a canonical guard when applying and cloning", () => {
  const draft = sshDraftFromPreset({ ...preset, resolutionAlias: "private-build" });
  expect(draft.destination.typed).toBe(preset.destination);
  expect(sshPresetPayload(draft, "Clone")).toMatchObject({
    destination: preset.destination,
    resolutionAlias: "private-build",
    expectedDestination: preset.destination,
  });
});
