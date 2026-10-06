import { expect, test } from "bun:test";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/**
 * The I-1 test-isolation regression (review wave 2026-10-05): the sibling
 * `services/ssh-runtime` suites install a capture `sendCommand` via
 * `mock.module` and restore it in `afterAll`. bun's `mock.module` mutates the
 * LIVE module namespace, so restoring with `() => ({ ...nodeRpc })` re-spied
 * the already-mocked namespace and the capture leaked into every file that
 * ran after it in the shared serial process - this directory's scripted-node
 * routes suite then read NODE_UNREACHABLE "malformed payload" for commands
 * its own scripted handlers answer (reproduced in either file order).
 *
 * This file is order-independent by construction: run BEFORE any mock (the
 * module is real) or AFTER the fixed restores (the module is real again), the
 * unmocked `sendCommand` rejects a never-connected node with `NodeRpcError`
 * code `offline`. The capture mock resolves ANY command with `{ok:true}`, so
 * the day the restore regresses, this test fails no matter which file order
 * bun picks.
 */

test("node-rpc answers the REAL module in this process (no leaked mock)", async () => {
  const err = await sendCommand(crypto.randomUUID(), { type: "probe", subshellIds: [] }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "a capture mock resolves any command; the real module cannot").toBeInstanceOf(NodeRpcError);
  expect((err as NodeRpcError).code).toBe("offline");
});
