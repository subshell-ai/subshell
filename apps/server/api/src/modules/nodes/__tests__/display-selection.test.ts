import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { VirtualDisplayRequest } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { resolveNodeDisplayRequest } from "@/modules/nodes/display-selection.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/testing/api/auth-tables.js";

/**
 * The plane's own display gate, which runs before a row, a token, or an RPC
 * exists. Two things are pinned here, and both have been wrong in the field.
 *
 * The first is WHAT it refuses. A provider the catalog says drives another
 * operating system used to pass this door and die at the agent, after the
 * subshell row and its MCP token had been written and rolled back: the node is
 * the authority on what it can run, but a fact this side already holds (the
 * stored `os`, and the catalog's platform for each bundled provider) should cost
 * a 400 rather than a launch.
 *
 * The second is HOW it says so. Every refusal here ends with the node's own word
 * in parentheses, because that ending is what decides where the dashboard puts
 * the sentence: `isDisplayLaunchRefusal` matches it and keeps the message beside
 * the **Virtual display** checkbox whose setting caused the failure. A plane
 * refusal without the word lands at the bottom of the form instead, so the same
 * problem read differently depending on which side noticed it.
 */

const nodes = new NodesRepository(db);
const nodeIds: string[] = [];
const emails: string[] = [];
let ownerId: string;

const SCREEN = { width: 1280, height: 800 };

async function mkUser(): Promise<string> {
  const email = `display-gate-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("display-gate-pass-1"),
    role: "user",
  });
}

interface NodeDisplayRow {
  /** What the agent reported about its platform: "linux", "darwin", "unknown", or never. */
  os: string | null;
  enabled: 0 | 1;
  provider?: string;
  /** The owner's enabled list; absent means the column was never written. */
  providers?: string[];
}

async function mkNode(row: NodeDisplayRow): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId: ownerId, name: `gate-${id.slice(0, 8)}`, kind: "agent", status: "online" });
  await db
    .updateTable("nodes")
    .set({
      os: row.os,
      virtualDisplayEnabled: row.enabled,
      ...(row.provider === undefined ? {} : { virtualDisplayProvider: row.provider }),
      ...(row.providers === undefined ? {} : { virtualDisplayProviders: JSON.stringify(row.providers) }),
    })
    .where("id", "=", id)
    .execute();
  return id;
}

/** The refusal's text and status, or a failure that says the launch was accepted. */
async function refused(
  nodeId: string,
  provider?: string,
  status = 400,
  request: VirtualDisplayRequest = SCREEN,
): Promise<{ message: string; status: unknown }> {
  try {
    const resolved = await resolveNodeDisplayRequest(nodeId, { ...request, provider }, status);
    throw new Error(`expected a refusal, got provider ${resolved.provider}`);
  } catch (error) {
    const http = error as { message: string; status?: unknown };
    if (http.status === undefined) throw error;
    return { message: http.message, status: http.status };
  }
}

/** The routing contract the dashboard depends on: the word is the last thing in the line. */
function expectTail(message: string, word: string): void {
  expect(message.endsWith(` (${word})`)).toBe(true);
}

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await mkUser();
});

afterAll(async () => {
  for (const id of nodeIds) await nodes.deleteById(id);
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

describe("resolveNodeDisplayRequest", () => {
  it("accepts what this machine runs and this node has enabled", async () => {
    const id = await mkNode({ os: "darwin", enabled: 1, provider: "betterdisplay", providers: ["betterdisplay"] });
    expect(await resolveNodeDisplayRequest(id, SCREEN)).toEqual({ ...SCREEN, provider: "betterdisplay" });
    // No provider named: the node's own default answers, and it is returned
    // resolved so the caller stores one shape.
    expect(await resolveNodeDisplayRequest(id, { ...SCREEN, provider: undefined })).toEqual({
      ...SCREEN,
      provider: "betterdisplay",
    });
  });

  it("refuses a provider the catalog says this machine cannot run, before the launch", async () => {
    // Xvfb is Linux's display server. Asking the agent costs a row, a minted
    // token, a signed command, and a rollback; the plane holds both facts
    // already (the stored os, and the provider's platform).
    const id = await mkNode({ os: "darwin", enabled: 1, providers: ["xvfb-x11vnc", "betterdisplay"] });
    const { message, status } = await refused(id, "xvfb-x11vnc");
    expect(status).toBe(400);
    expect(message).toContain("does not run on this node's operating system");
    expectTail(message, "preview-display-unsupported");
    // The same provider on the machine it drives is fine, so this is the pair
    // being refused, not the provider.
    const linux = await mkNode({ os: "linux", enabled: 1, providers: ["xvfb-x11vnc"] });
    expect((await resolveNodeDisplayRequest(linux, SCREEN)).provider).toBe("xvfb-x11vnc");
  });

  for (const unanswered of [null, "unknown"]) {
    it(`refuses nothing on an os that has not answered (${String(unanswered)})`, async () => {
      // "unknown" is a node saying it could not classify itself, which is not a
      // claim about what runs there, so the plane does not refuse on it. The node
      // still answers for its own machine, and refuses Xvfb on any non-Linux
      // platform by name (`xvfbDisplayReadiness`), so this is not a promise that
      // the launch will succeed: it is a refusal to guess. Reading it as a verdict
      // would empty the provider card of a node that never came ready.
      const id = await mkNode({ os: unanswered, enabled: 1, providers: ["xvfb-x11vnc"] });
      expect((await resolveNodeDisplayRequest(id, SCREEN)).provider).toBe("xvfb-x11vnc");
    });
  }

  it("refuses a provider this node's owner has not enabled, naming the door that fixes it", async () => {
    const id = await mkNode({ os: "darwin", enabled: 1, providers: ["xvfb-x11vnc"] });
    const { message } = await refused(id, "betterdisplay");
    expect(message).toContain("disabled on the node");
    expect(message).toContain("node settings");
    expectTail(message, "preview-display-provider-disabled");
  });

  it("refuses a provider no catalog row carries", async () => {
    // Not on the wire vocabulary (a stored list may hold a node-owned id, but a
    // launch cannot ask for one), and the node would answer `unsupported` for
    // it, so the plane says the same word rather than inventing a second one.
    const id = await mkNode({ os: "linux", enabled: 1, providers: ["xvfb-x11vnc", "acme-screen"] });
    const { message } = await refused(id, "acme-screen");
    expect(message).toContain("unavailable");
    expectTail(message, "preview-display-unsupported");
  });

  it("refuses a display on a node whose switch is off", async () => {
    // At 409, the restart door, which is where this sentence is normally heard.
    // Create checks the same flag earlier (`subshells.service.ts`'s preflight, at
    // 400, with its own words), so asserting that pair here would mostly pin the
    // preflight's text; the resolver's own line does remain reachable at 400 if
    // the owner flips the switch between the two reads.
    const id = await mkNode({ os: "linux", enabled: 0, providers: ["xvfb-x11vnc"] });
    const { message } = await refused(id, "xvfb-x11vnc", 409);
    expect(message).toContain("Allow virtual displays");
    expectTail(message, "preview-node-off");
  });

  it("keeps the node's word on the restart path's 409", async () => {
    // A restart re-resolves the pinned provider (the row already exists), so the
    // same refusal must arrive with the status the restart UI maps and the same
    // tail the checkbox matcher reads.
    const id = await mkNode({ os: "darwin", enabled: 1, providers: ["xvfb-x11vnc"] });
    const { message, status } = await refused(id, "betterdisplay", 409);
    expect(status).toBe(409);
    expectTail(message, "preview-display-provider-disabled");
  });

  it("refuses a malformed request before reading the node", async () => {
    // The size bounds are the node's wire rule, applied on this side so a
    // hand-made body never reaches a machine. The shape check also answers first
    // for an id that exists nowhere, which is what keeps a bad body from being
    // reported as a missing node.
    const tooBig = await refused("no-such-node", undefined, 400, { ...SCREEN, width: 9999 });
    expect(tooBig.message).toContain("invalid");
    expect(tooBig.status).toBe(400);
  });

  it("refuses a node that is not there, rather than resolving against nothing", async () => {
    // An absent row must not fall through to the catalog's Linux default: the
    // switch check reads `row?.virtualDisplayEnabled`, so the missing node is
    // refused as the switched-off machine it is.
    // Same door as the switch case: an absent row is the restart's problem,
    // because create answers for a missing node before this resolver runs.
    const gone = await refused("no-such-node", "xvfb-x11vnc", 409);
    expectTail(gone.message, "preview-node-off");
  });
});
