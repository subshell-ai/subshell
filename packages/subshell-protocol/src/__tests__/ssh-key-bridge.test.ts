import { expect, it } from "bun:test";
import { parseNodeCommandBody } from "../node-frames.js";
import { isSshKeyBridgePayload, parseSshKeyBridgeResult, SSH_LOCAL_KEY_MAX_BYTES } from "../ssh-key-bridge.js";

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
