import { describe, expect, test } from "bun:test";
import { applyConnectionFields, connectionIdentity, type NodeConfig } from "../config.js";

const BASE: NodeConfig = {
  serverUrl: "https://plane.example",
  nodeWsUrl: "wss://plane.example/ws/node",
  nodeId: "node-a",
  nodeKey: "subshell_key_a",
  controlPublicKey: '{"kty":"EC"}',
  controlEncryptPublicKey: "AAAA",
  encryptKeyPair: { publicKey: "PUB", privateKey: "PRIV" },
  dataDir: "/tmp/ignored-by-identity",
  name: "box",
} as NodeConfig;

describe("connectionIdentity", () => {
  test("stable for a byte-identical or reordered-but-equal config", () => {
    expect(connectionIdentity(BASE)).toBe(connectionIdentity({ ...BASE }));
    // Key order inside the keypair must not read as a change.
    expect(connectionIdentity({ ...BASE, encryptKeyPair: { privateKey: "PRIV", publicKey: "PUB" } })).toBe(
      connectionIdentity(BASE),
    );
  });
  test("changes when any connection field changes", () => {
    for (const patch of [
      { nodeId: "node-b" },
      { nodeKey: "subshell_key_b" },
      { serverUrl: "https://other.example" },
      { nodeWsUrl: undefined },
      { controlPublicKey: '{"kty":"RSA"}' },
      { controlEncryptPublicKey: "BBBB" },
      { encryptKeyPair: { publicKey: "PUB", privateKey: "OTHER" } },
    ]) {
      expect(connectionIdentity({ ...BASE, ...(patch as Partial<NodeConfig>) })).not.toBe(connectionIdentity(BASE));
    }
  });
  test("ignores non-connection fields", () => {
    expect(connectionIdentity({ ...BASE, name: "renamed", dataDir: "/elsewhere" })).toBe(connectionIdentity(BASE));
  });
});

describe("applyConnectionFields", () => {
  test("copies connection fields in place and leaves others alone", () => {
    const live = { ...BASE };
    applyConnectionFields(live, { ...BASE, nodeId: "node-b", nodeKey: "subshell_key_b", name: "different" });
    expect(live.nodeId).toBe("node-b");
    expect(live.nodeKey).toBe("subshell_key_b");
    expect(live.name).toBe("box"); // NON-connection fields are never touched
  });
  test("removes optional fields the disk no longer carries", () => {
    const live = { ...BASE };
    applyConnectionFields(live, { ...BASE, nodeWsUrl: undefined, encryptKeyPair: undefined });
    expect(live.nodeWsUrl).toBeUndefined();
    expect(live.encryptKeyPair).toBeUndefined();
    expect(live.nodeId).toBe("node-a"); // unchanged fields survive
  });
});
