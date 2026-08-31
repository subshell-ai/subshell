import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@/mcp/api-client.js";
import { generateKeypair, open, seal } from "@/mcp/crypto.js";
import { reloadPinSettingsForTests } from "@/mcp/pin-store.js";
import {
  createSession,
  describeToolError,
  listProfiles,
  postChannel,
  readChannel,
  type ToolApi,
  type ToolDeps,
} from "@/mcp/tools.js";

/** In-memory fake: tools talk to this, never to a server. */
interface Recorded {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

function fakeApi(handler: (req: { path: string; method: string; body?: Record<string, unknown> }) => unknown) {
  const calls: Recorded[] = [];
  const api: ToolApi = {
    async req<T>(
      path: string,
      init?: { method?: string; body?: unknown; query?: Record<string, unknown> },
    ): Promise<T> {
      const rec = {
        path,
        method: init?.method ?? "GET",
        body: init?.body as Record<string, unknown>,
        query: init?.query,
      };
      calls.push(rec);
      return handler(rec) as T;
    },
  };
  return { api, calls };
}

/** Gives each post_channel test its own empty pin set (tmp MOTE_DATA_DIR). */
const tmpDirs: string[] = [];
function freshPinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mote-tools-pins-"));
  tmpDirs.push(dir);
  reloadPinSettingsForTests({ MOTE_DATA_DIR: dir });
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  reloadPinSettingsForTests({});
});

describe("mcp tools (handler-level, real crypto)", () => {
  it("post_channel seals to every keyed member including self, auto-joining first", async () => {
    freshPinDir();
    const own = await generateKeypair();
    const other = await generateKeypair();
    let joined = false;
    const { api, calls } = fakeApi((req) => {
      if (req.path.endsWith("/members") && req.method === "GET") {
        return {
          members: joined
            ? [
                { principalId: "sess:me", publicKey: own.publicJwk, addedAt: "t" },
                { principalId: "sess:other", publicKey: other.publicJwk, addedAt: "t" },
              ]
            : [{ principalId: "sess:other", publicKey: other.publicJwk, addedAt: "t" }],
        };
      }
      if (req.path.endsWith("/members") && req.method === "POST") {
        joined = true;
        return { joined: true };
      }
      if (req.path.endsWith("/posts")) return { id: "p1", seq: 7 };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const res = await postChannel(deps, { name: "build", text: "pipeline is green" });
    expect(res.seq).toBe(7);
    expect(joined).toBe(true);
    const post = calls.find((c) => c.path.endsWith("/posts"));
    const body = post?.body as { envelope: string; recipientIds: string[] };
    expect(body.recipientIds.sort()).toEqual(["sess:me", "sess:other"]);
    // The other member can actually open what we posted.
    expect(await open(body.envelope, { principalId: "sess:other", ...other })).toBe("pipeline is green");
  });

  it("post_channel refuses to seal when the roster swaps a pinned peer's key", async () => {
    const dir = freshPinDir();
    const own = await generateKeypair();
    const peer = await generateKeypair();
    const relay = await generateKeypair();
    let peerKey = peer.publicJwk;
    const { api, calls } = fakeApi((req) => {
      if (req.path.endsWith("/members") && req.method === "GET") {
        return {
          members: [
            { principalId: "sess:me", publicKey: own.publicJwk, addedAt: "t" },
            { principalId: "sess:peer", publicKey: peerKey, addedAt: "t" },
          ],
        };
      }
      if (req.path.endsWith("/posts")) return { id: "p1", seq: 1 };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    // First post pins both roster keys (TOFU) and goes through.
    await postChannel(deps, { name: "build", text: "first" });
    // The relay now substitutes its own keypair for the peer's…
    peerKey = relay.publicJwk;
    let message = "";
    try {
      await postChannel(deps, { name: "build", text: "second" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("pinned key for sess:peer changed");
    expect(message).toContain(join(dir, "peers.json")); // names the file to edit
    // …and nothing sealed to the attacker's key ever reaches the relay.
    expect(calls.filter((c) => c.path.endsWith("/posts"))).toHaveLength(1);
  });

  it("read_channel decrypts and reports undecryptable envelopes without failing", async () => {
    const own = await generateKeypair();
    const { envelope } = await seal("for me", [{ principalId: "sess:me", publicJwk: own.publicJwk }]);
    const junk = JSON.stringify({
      protected: "p",
      iv: "i",
      tag: "t",
      ciphertext: "c",
      recipients: [{ header: { kid: "sess:me" }, encrypted_key: "zz" }],
    });
    const { api, calls } = fakeApi(() => ({
      posts: [
        { id: "1", seq: 1, author: "sess:them", envelope, createdAt: "t1" },
        { id: "2", seq: 2, author: "sess:them", envelope: junk, createdAt: "t2" },
      ],
      nextSince: 2,
    }));
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const out = await readChannel(deps, { name: "build" });
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0].text).toBe("for me");
    expect(out.undecryptable).toBe(1);
    expect(out.nextSince).toBe(2);
    // no explicit since → the server resolves the stored cursor; sending 0
    // would re-page the oldest history forever once the channel outgrows limit
    expect(calls[0].query).not.toHaveProperty("since");
    expect(calls[0].query).toMatchObject({ mark: 1 });
    await readChannel(deps, { name: "build", since: 7 });
    expect(calls[1].query).toMatchObject({ since: 7 });
  });

  it("create_session resolves the profile by name and reports prompt delivery", async () => {
    const own = await generateKeypair();
    const { api, calls } = fakeApi((req) => {
      if (req.path === "/api/profiles") return [{ id: "prof-1", name: "Dev", harnessId: "claude-code" }];
      if (req.path === "/api/sessions") return { id: "s1", promptDelivered: true };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const res = await createSession(deps, { profile: "dev", workingDir: "/tmp", prompt: "do it" });
    expect(res).toEqual({ id: "s1", promptDelivered: true });
    const create = calls.find((c) => c.path === "/api/sessions");
    expect(create?.body?.profileId).toBe("prof-1");
    expect(create?.body?.prompt).toBe("do it");
  });

  it("create_session with an unknown profile name gives guidance, not a stack trace", async () => {
    const own = await generateKeypair();
    const { api } = fakeApi(() => [{ id: "prof-1", name: "Dev", harnessId: "claude-code" }]);
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    await expect(createSession(deps, { profile: "nope", workingDir: "/tmp" })).rejects.toThrow(
      /no profile named 'nope'.*mote_list_profiles/,
    );
  });

  it("list_profiles projects rows down to {id, name, harnessId} — no field passthrough", async () => {
    // M-6a (final review): GET /api/profiles redaction for bearers relies on
    // THIS client-side projection — if it ever passed rows through, envJson
    // (profile env, may hold provider tokens) and flags would resurface to
    // every session key. Pinned here so a "simplification" trips first.
    const own = await generateKeypair();
    const { api } = fakeApi((req) => {
      if (req.path === "/api/profiles") {
        return [
          {
            id: "prof-1",
            name: "Dev",
            harnessId: "claude-code",
            envJson: '{"ANTHROPIC_API_KEY":"sk-secret"}',
            flags: ["--dangerously-skip-permissions"],
          },
        ];
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const rows = await listProfiles(deps);
    expect(rows).toEqual([{ id: "prof-1", name: "Dev", harnessId: "claude-code" }]);
    expect(JSON.stringify(rows)).not.toContain("sk-secret");
    expect(JSON.stringify(rows)).not.toContain("flags");
  });

  it("describeToolError turns a 401 into restart guidance", () => {
    expect(describeToolError(new ApiError(401, "no")).message).toContain("restart this session");
    expect(describeToolError(new ApiError(403, "Recipient")).message).toContain("permission denied");
  });
});
