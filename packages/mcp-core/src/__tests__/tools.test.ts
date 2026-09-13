import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, SubshellApi } from "../api-client.js";
import { generateKeypair, open, seal } from "../crypto.js";
import { reloadPinSettingsForTests } from "../pin-store.js";
import {
  createSubshell,
  describeToolError,
  listPresets,
  postChannel,
  readChannel,
  type ToolApi,
  type ToolDeps,
} from "../tools.js";

/** In-memory fake: tools talk to this, never to a server. */
interface Recorded {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

function fakeApi(
  handler: (req: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
  }) => unknown,
) {
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

/** Gives each post_channel test its own empty pin set (tmp SUBSHELL_DATA_DIR). */
const tmpDirs: string[] = [];
function freshPinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-tools-pins-"));
  tmpDirs.push(dir);
  reloadPinSettingsForTests({ SUBSHELL_DATA_DIR: dir });
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

  it("create_subshell resolves the preset by name within its harness and reports prompt delivery", async () => {
    const own = await generateKeypair();
    const { api, calls } = fakeApi((req) => {
      if (req.path === "/api/presets") return [{ id: "pre-1", name: "Dev", harnessId: "claude-code" }];
      if (req.path === "/api/subshells") return { id: "s1", promptDelivered: true };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const res = await createSubshell(deps, {
      harness: "claude-code",
      preset: "dev",
      workingDir: "/tmp",
      prompt: "do it",
    });
    expect(res).toEqual({ id: "s1", promptDelivered: true });
    // Name lookup is scoped to the harness — preset names are only unique per harness.
    const list = calls.find((c) => c.path === "/api/presets");
    expect(list?.query).toEqual({ harnessId: "claude-code" });
    const create = calls.find((c) => c.path === "/api/subshells");
    expect(create?.body?.harnessId).toBe("claude-code");
    expect(create?.body?.presetId).toBe("pre-1");
    expect(create?.body?.prompt).toBe("do it");
  });

  it("create_subshell without a preset launches on the harness alone — no lookup, no presetId", async () => {
    const own = await generateKeypair();
    const { api, calls } = fakeApi((req) => {
      if (req.path === "/api/subshells") return { id: "s2", promptDelivered: false };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const res = await createSubshell(deps, { harness: "terminal", workingDir: "/tmp" });
    expect(res).toEqual({ id: "s2", promptDelivered: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.harnessId).toBe("terminal");
    expect(calls[0]?.body?.presetId).toBeUndefined();
  });

  it("create_subshell over the REAL SubshellApi with fetch stubbed makes the expected REST calls", async () => {
    // Folded in from the agent's port-parity suite (which this package replaced):
    // no fakeApi — a stubbed global fetch (api-client.test pattern), so the full
    // client path (SubshellApi.req → fetch) is proven: GET /api/presets scoped
    // by harnessId (bearer), then POST /api/subshells with the NAME-resolved
    // presetId and the prompt.
    const savedFetch = globalThis.fetch;
    const seen: Request[] = [];
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const req = new Request(String(input), init);
      seen.push(req);
      if (req.url === "http://h:3080/api/presets?harnessId=claude-code") {
        return new Response(JSON.stringify([{ id: "pre-1", name: "Dev", harnessId: "claude-code" }]));
      }
      return new Response(JSON.stringify({ id: "s1", promptDelivered: true }));
    }) as never;
    try {
      const own = await generateKeypair();
      const deps: ToolDeps = {
        api: new SubshellApi({ apiKey: "subshell_key123", baseUrl: "http://h:3080" }),
        own: { principalId: "sess:me", ...own },
      };
      const res = await createSubshell(deps, {
        harness: "claude-code",
        preset: "dev",
        workingDir: "/tmp",
        prompt: "do it",
      });
      expect(res).toEqual({ id: "s1", promptDelivered: true });
      expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET http://h:3080/api/presets?harnessId=claude-code",
        "POST http://h:3080/api/subshells",
      ]);
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer subshell_key123");
      const body = (await seen[1]?.json()) as Record<string, unknown>;
      expect(body.harnessId).toBe("claude-code");
      expect(body.presetId).toBe("pre-1");
      expect(body.prompt).toBe("do it");
      expect(body.workingDir).toBe("/tmp");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("create_subshell refuses an AMBIGUOUS preset name instead of picking a winner", async () => {
    // Preset names are not unique per user+harness — no index constrains them
    // and create does not check — so with the name as the agent's addressing
    // key, a tie must never be won by whichever row sorts first: a
    // wrong-preset launch writes the wrong credential layer.
    const own = await generateKeypair();
    const { api, calls } = fakeApi((req) => {
      if (req.path === "/api/presets")
        return [
          { id: "pre-1", name: "Dev", harnessId: "claude-code" },
          { id: "pre-2", name: "DEV", harnessId: "claude-code" }, // distinct spellings, ONE lowercase key
        ];
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    // 'dev' matches NEITHER spelling exactly, so the case-insensitive set of
    // two stands and the tie is real.
    await expect(createSubshell(deps, { harness: "claude-code", preset: "dev", workingDir: "/tmp" })).rejects.toThrow(
      /more than one preset named 'dev' for harness 'claude-code'/,
    );
    // The spellings are NAMED: with a case-only collision they are the whole
    // actionable content of "rename one".
    await expect(createSubshell(deps, { harness: "claude-code", preset: "dev", workingDir: "/tmp" })).rejects.toThrow(
      /'Dev', 'DEV'/,
    );
    // Refused at resolution — no launch was ever attempted.
    expect(calls).toHaveLength(2);
  });

  it("create_subshell takes an EXACT spelling over a case-insensitive tie", async () => {
    // `Dev` and `DEV` collide only case-insensitively. Asking for `Dev` names
    // exactly one row, so refusing it would be a refusal invented by the
    // lookup rather than found in the data.
    const own = await generateKeypair();
    const { api, calls } = fakeApi((req) => {
      if (req.path === "/api/presets")
        return [
          { id: "pre-1", name: "Dev", harnessId: "claude-code" },
          { id: "pre-2", name: "DEV", harnessId: "claude-code" },
        ];
      if (req.path === "/api/subshells") return { id: "sub-1" };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    const res = await createSubshell(deps, { harness: "claude-code", preset: "Dev", workingDir: "/tmp" });
    expect(res.id).toBe("sub-1");
    // The launch carried the EXACTLY spelled row, not the other one.
    const launch = calls.find((c) => c.path === "/api/subshells");
    expect((launch?.body as { presetId?: string } | undefined)?.presetId).toBe("pre-1");
  });

  it("create_subshell with an unknown preset name gives guidance, not a stack trace", async () => {
    const own = await generateKeypair();
    const { api } = fakeApi(() => [{ id: "pre-1", name: "Dev", harnessId: "claude-code" }]);
    const deps: ToolDeps = { api, own: { principalId: "sess:me", ...own } };
    await expect(createSubshell(deps, { harness: "codex", preset: "nope", workingDir: "/tmp" })).rejects.toThrow(
      /no preset named 'nope' for harness 'codex'; call list_presets/,
    );
  });

  it("list_presets projects rows down to {id, name, harnessId} — no field passthrough", async () => {
    // M-6a (final review): GET /api/presets redaction for bearers relies on
    // THIS client-side projection — if it ever passed rows through, envJson
    // (preset env, may hold provider tokens) and flags would resurface to
    // every subshell key. Pinned here so a "simplification" trips first.
    const own = await generateKeypair();
    const { api } = fakeApi((req) => {
      if (req.path === "/api/presets") {
        return [
          {
            id: "pre-1",
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
    const rows = await listPresets(deps);
    expect(rows).toEqual([{ id: "pre-1", name: "Dev", harnessId: "claude-code" }]);
    expect(JSON.stringify(rows)).not.toContain("sk-secret");
    expect(JSON.stringify(rows)).not.toContain("flags");
  });

  it("describeToolError turns a 401 into restart guidance", () => {
    expect(describeToolError(new ApiError(401, "no")).message).toContain("restart this subshell");
    expect(describeToolError(new ApiError(403, "Recipient")).message).toContain("permission denied");
  });
});
