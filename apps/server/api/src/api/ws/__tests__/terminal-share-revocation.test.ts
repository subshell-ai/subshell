import { expect, it } from "bun:test";
import { holdFailedInput, refireInputHoldsForNode } from "@/api/ws/input-hold.js";
import { handleSubshellMessage, handleSubshellWs } from "@/api/ws/subshell-ws.js";
import { paneStreams, sendFrame } from "@/api/ws/viewers.js";
import { issueWsToken } from "@/api/ws/ws-token.js";
import { getRequestlessContext } from "@/app/context.js";
import { subshellLogPath } from "@/modules/subshells/paths.js";
import {
  attach,
  attached,
  defaultLocalLauncher,
  fakeBrowser,
  seedLocalRow,
  stubLauncher,
  useLocalAttachHarness,
} from "./helpers/local-attach-harness.js";

useLocalAttachHarness();

it("a share downgrade cuts old input and output without relying on the socket close event", async () => {
  stubLauncher();
  const row = await seedLocalRow();
  await Bun.write(subshellLogPath(row.id), "old\n");
  const { repos, services } = getRequestlessContext();
  await repos.subshellShares.replaceForSubshell(row.id, [{ granteeUserId: null, permission: "edit" }], row.userId);
  const owner = await attach(row.userId, row.id);
  const guest = await attach("guest", row.id);
  expect(guest.ws.data.canInput).toBe(true);
  let inputCalls = 0;
  guest.ws.data.launcher = {
    ...guest.ws.data.launcher,
    sendInput: async () => {
      inputCalls++;
    },
  };

  await services.subshells.setShares(row.userId, row.id, [{ granteeUserId: null, permission: "view" }], "cookie");
  expect(guest.closed).toEqual([{ code: 1012, reason: "subshell sharing changed" }]);
  expect(owner.closed).toEqual([]);
  const before = guest.sent.length;
  handleSubshellMessage(guest.ws, { type: "input", data: "unauthorized\n", id: 1 });
  sendFrame(guest.ws, { type: "output", data: "private output" });
  // A failure from a write issued before revocation must not recreate a hold.
  holdFailedInput({
    nodeId: row.nodeId,
    subshellId: row.id,
    sessionId: "late",
    id: 2,
    payload: "late",
    ws: guest.ws,
    sendAck: () => {},
  });
  refireInputHoldsForNode(row.nodeId);
  expect(inputCalls).toBe(0);
  expect(guest.sent.length).toBe(before);

  const viewer = await attach("guest", row.id);
  expect(viewer.closed).toEqual([]);
  expect(viewer.ws.data.canInput).toBe(false);
  await services.subshells.setShares(row.userId, row.id, [], "cookie");
  expect(viewer.closed.length).toBe(1);
  const refused = await attach("guest", row.id);
  expect(refused.closed).toEqual([{ code: 4005, reason: "subshell not found" }]);
  expect(owner.closed).toEqual([]);
});

it("revocation during an awaited attach probe cannot resurrect the old grant", async () => {
  stubLauncher();
  const row = await seedLocalRow();
  await Bun.write(subshellLogPath(row.id), "old\n");
  const { repos, services } = getRequestlessContext();
  await repos.subshellShares.replaceForSubshell(row.id, [{ granteeUserId: null, permission: "edit" }], row.userId);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<boolean>();
  defaultLocalLauncher.hasSubshell = () => {
    entered.resolve();
    return resume.promise;
  };
  const guest = fakeBrowser();
  attached.push(guest);
  const attaching = handleSubshellWs(
    guest.ws,
    new URL(`ws://localhost/ws?subshell=${row.id}&token=${issueWsToken("guest")}`),
  );
  await entered.promise;
  await services.subshells.setShares(row.userId, row.id, [], "cookie");
  resume.resolve(true);
  await attaching;
  expect(guest.closed).toEqual([{ code: 1012, reason: "subshell sharing changed" }]);
  expect(guest.sent).toEqual([]);
  expect(paneStreams.viewerCount(row.id)).toBe(0);
  handleSubshellMessage(guest.ws, { type: "input", data: "denied" });
});
