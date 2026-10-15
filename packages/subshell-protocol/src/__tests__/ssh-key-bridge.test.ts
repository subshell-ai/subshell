import { expect, it } from "bun:test";
import { parseNodeCommandBody } from "../node-frames.js";
import {
  isSshKeyBridgePayload,
  isSshLocalKeyHostPin,
  parseSshKeyBridgeResult,
  SSH_LOCAL_KEY_MAX_BYTES,
} from "../ssh-key-bridge.js";

it("bounds and canonicalizes native signing traffic", () => {
  expect(isSshKeyBridgePayload("BQ==")).toBe(true);
  for (const value of ["BR==", "BQ", "", "!!!=", Buffer.alloc(SSH_LOCAL_KEY_MAX_BYTES + 1).toString("base64")])
    expect(isSshKeyBridgePayload(value)).toBe(false);
  expect(parseSshKeyBridgeResult({ done: false, request: { seq: 0, payload: "Cw==" }, privateKey: "discard" })).toEqual(
    { done: false, request: { seq: 0, payload: "Cw==" } },
  );
  expect(parseSshKeyBridgeResult({ done: true, request: { seq: 0, payload: "Cw==" } })).toBeNull();
  expect(parseSshKeyBridgeResult({ done: false, request: { seq: -1, payload: "Cw==" } })).toBeNull();
});
it("pins the hostPin line grammar the bridge will write verbatim", () => {
  const key = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  // Accepted: the shapes honest capture composes, including keyscan's
  // port-qualified bracket form, IPv6, and the canonical hashed spelling
  // (salt/hash carry +, / and = padding; the operator's file may use it).
  for (const line of [
    `git.example.test ssh-ed25519 ${key}`,
    `Git.Example.TEST ssh-ed25519 ${key}`,
    `[git.example.test]:2222 ssh-ed25519 ${key}`,
    `[2001:db8::1] ssh-ed25519 ${key}`,
    `[::1]:22 ssh-ed25519 ${key}`,
    `|1|c2FsdCsK/88=|aGFzaC8K+Q== ssh-ed25519 ${key}`,
    `git.example.test ssh-ed25519 ${key} # operator comment`,
  ])
    expect(isSshLocalKeyHostPin(line), line).toBe(true);
  // Refused: the line-hygiene spellings the relay sibling also refuses
  // (trim, control chars, comment lead), plus every host-token and
  // key-grammar widening this bridge adds on top of it. The sibling is
  // shape-only and lets the glob, algorithm and junk-field rows through;
  // here they are the whole point.
  for (const line of [
    `*.example.test ssh-ed25519 ${key}`,
    `git?.example ssh-ed25519 ${key}`,
    `port=22,*.example.test ssh-ed25519 ${key}`,
    `@cert-authority git.example.test ssh-ed25519 ${key}`,
    `!git.example.test ssh-ed25519 ${key}`,
    `#git.example.test ssh-ed25519 ${key}`,
    `git.example.test\tssh-ed25519 ${key}`, // tab-separated
    ` git.example.test ssh-ed25519 ${key}`, // leading space
    `git.example.test ssh-ed25519 ${key} junkfield`,
    `git.example.test ssh-ed25519 ${key}\u001b[0m`, // ESC smuggle
    `git.example|test ssh-ed25519 ${key}`,
    `|1|c2FsdA==bad|aGFzaA== ssh-ed25519 ${key}`, // padding mid-token is not a hashed host
    `git.example.test ssh-dss ${key}`,
  ])
    expect(isSshLocalKeyHostPin(line), line).toBe(false);
});
it("validates the command independently of sender authentication", () => {
  const id = crypto.randomUUID();
  expect(parseNodeCommandBody({ type: "ssh_key_bridge", op: "close", id })).toEqual({
    type: "ssh_key_bridge",
    op: "close",
    id,
  });
  for (const command of [
    { op: "open", id, hostPin: "not-a-pin" },
    { op: "close", id: "../../escape" },
    { op: "exchange", id, reply: { seq: 0, payload: "BR==" } },
  ])
    expect(parseNodeCommandBody({ type: "ssh_key_bridge", ...command })).toBeNull();
});
