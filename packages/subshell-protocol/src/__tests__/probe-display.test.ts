import { expect, it } from "bun:test";
import { parseNodeProbeEntries } from "../node-results.js";

it("accepts current display metadata and legacy probes, refusing malformed display handles", () => {
  const row = { subshellId: "pane", alive: true, exitCode: null };
  expect(parseNodeProbeEntries([row])).toEqual([row]);
  const display = { ...row, previewScreen: { display: ":91", viewer: { protocol: "vnc" as const, port: 5911 } } };
  expect(parseNodeProbeEntries([display])).toEqual([display]);
  expect(parseNodeProbeEntries([{ ...row, previewScreen: null }])).not.toBeNull();
  expect(parseNodeProbeEntries([{ ...row, previewScreen: { display: ":91" } }])).toBeNull();
});
