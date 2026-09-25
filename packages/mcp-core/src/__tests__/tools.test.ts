import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, SubshellApi } from "../api-client.js";
import { postChannel, readChannel } from "../channel-tools.js";
import { generateKeypair, open, seal } from "../crypto.js";
import { reloadPinSettingsForTests } from "../pin-store.js";
import {
  createSubshell,
  getSubshell,
  listNodes,
  listPresets,
  listSubshells,
  readSubshellLog,
  restartSubshell,
  sendToSubshell,
} from "../subshell-tools.js";
import { describeToolError, type ToolApi, type ToolDeps } from "../tools.js";

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
      if (req.path === "/api/plugins") return { plugins: [] };
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

describe("mcp tools: the 2026-09-25 agent surface", () => {
  const depsFor = async (
    handler: (req: { path: string; method: string; body?: Record<string, unknown> }) => unknown,
  ) => {
    const own = await generateKeypair();
    const { api, calls } = fakeApi(handler);
    return { deps: { api, own: { principalId: "sess:me", ...own } } as ToolDeps, calls };
  };

  /** One node row as GET /api/nodes sends it, extras included (the projection must drop them). */
  function nodeWireRow(over: Record<string, unknown> = {}) {
    return {
      id: "n-1",
      name: "Build Box",
      kind: "agent",
      os: "linux",
      arch: "x64",
      hostname: "buildbox",
      status: "online",
      lastSeenAt: "t",
      agentVersion: "1.2.3",
      protocolVersion: 14,
      access: "owner",
      canManage: true,
      canLaunch: true,
      capabilities: ["pane-pipe"],
      allowedDirs: ["/srv/secret"],
      harnesses: [{ harnessId: "claude-code", name: "Claude Code", installed: true, version: "2.0.1" }],
      inventoryStale: true,
      maintenance: false,
      maintenanceAt: null,
      maintenanceSource: null,
      held: null,
      ...over,
    };
  }

  /** One subshell row as GET /api/subshells sends it, every wire field present. */
  function subshellWireRow(over: Record<string, unknown> = {}) {
    return {
      id: "s-1",
      presetId: "pre-1",
      harnessId: "claude-code",
      nodeId: "n-1",
      name: "worker",
      workingDir: "/srv/app",
      status: "running",
      createdAt: "t0",
      endedAt: null,
      lastOutputAt: "t1",
      activity: "active",
      preview: ["hi"],
      alive: true,
      exitCode: null,
      startedAt: "t0",
      backoffCount: 0,
      restartOnExit: false,
      nextRestartAt: null,
      nameLocked: false,
      notify: true,
      waitingSince: null,
      unseenPush: false,
      access: "owner",
      nodeOffline: false,
      shareCount: 3,
      sharedWithEveryone: true,
      ...over,
    };
  }

  const SUBSHELL_VIEW_KEYS = [
    "access",
    "activity",
    "alive",
    "exitCode",
    "harnessId",
    "id",
    "lastOutputAt",
    "name",
    "nodeId",
    "nodeOffline",
    "preview",
    "status",
    "waitingSince",
    "workingDir",
  ];

  it("list_nodes projects to the launch-relevant fields and drops the rest", async () => {
    const { deps } = await depsFor(() => [nodeWireRow()]);
    const [row] = await listNodes(deps);
    expect(Object.keys(row).sort()).toEqual([
      "access",
      "canLaunch",
      "harnesses",
      "id",
      "inventoryStale",
      "kind",
      "maintenance",
      "name",
      "status",
    ]);
    // `maintenance` is on NodeViewSchema (checked there), so it is required,
    // not optional, in the projection.
    expect(row.maintenance).toBe(false);
    expect(row.inventoryStale).toBe(true);
    // Harness entries keep identity + the refusal reason, drop the version.
    expect(row.harnesses).toEqual([{ harnessId: "claude-code", name: "Claude Code", installed: true }]);
    const withReason = await listNodes(
      (
        await depsFor(() => [
          nodeWireRow({
            harnesses: [{ harnessId: "codex", name: "Codex", installed: false, reason: "not-on-path" }],
          }),
        ])
      ).deps,
    );
    expect(withReason[0].harnesses).toEqual([
      { harnessId: "codex", name: "Codex", installed: false, reason: "not-on-path" },
    ]);
    // Machine noise never rides along: hostname, paths, versions, held state.
    expect(JSON.stringify(row)).not.toContain("buildbox");
    expect(JSON.stringify(row)).not.toContain("/srv/secret");
    expect(JSON.stringify(row)).not.toContain("1.2.3");
    expect(JSON.stringify(row)).not.toContain("2.0.1");
  });

  it("create_subshell resolves node by exact id, then exact name, then insensitive name", async () => {
    const nodes = [
      nodeWireRow(),
      nodeWireRow({ id: "n-2", name: "Laptop", hostname: "lap" }),
      // A node whose NAME reads exactly like ANOTHER node's id: the
      // name-lookup path would resolve "n-2" to THIS row (exact spelling),
      // so the case below only passes if the id really is consulted first.
      nodeWireRow({ id: "odd-1", name: "n-2", hostname: "odd" }),
    ];
    for (const [want, expected] of [
      // exact id beats another node's exactly-matching NAME: ids survive
      // renames, a name-hijacked launch would land on the wrong machine
      ["n-2", "n-2"],
      ["Build Box", "n-1"], // exact name
      ["laptop", "n-2"], // case-insensitive name
      // the id read is EXACT, so a case difference falls through to the
      // name lookup: "N-2" matches no id, and wins on the third row's name
      ["N-2", "odd-1"],
    ] as const) {
      const { deps, calls } = await depsFor((req) => {
        if (req.path === "/api/nodes") return nodes;
        if (req.path === "/api/subshells") return { id: "s-new", tmuxSocket: "sk", promptDelivered: false };
        throw new Error(`unexpected ${req.method} ${req.path}`);
      });
      const res = await createSubshell(deps, { harness: "terminal", workingDir: "/srv/app", node: want });
      expect(res).toEqual({ id: "s-new", promptDelivered: false });
      const create = calls.find((c) => c.path === "/api/subshells");
      expect(create?.body?.nodeId).toBe(expected);
    }
  });

  it("create_subshell refuses a node-name tie listing the spellings, and zero matches listing the names", async () => {
    const tied = [nodeWireRow({ name: "Mac" }), nodeWireRow({ id: "n-2", name: "MAC" })];
    const { deps, calls } = await depsFor((req) => (req.path === "/api/nodes" ? tied : []));
    await expect(createSubshell(deps, { harness: "terminal", workingDir: "/tmp", node: "mac" })).rejects.toThrow(
      /more than one node matches 'mac' \('Mac', 'MAC'\)/,
    );
    // Refused at resolution; no launch was attempted.
    expect(calls.filter((c) => c.path === "/api/subshells")).toHaveLength(0);

    const { deps: alone } = await depsFor((req) =>
      req.path === "/api/nodes" ? [nodeWireRow(), nodeWireRow({ id: "n-2", name: "Laptop" })] : [],
    );
    await expect(createSubshell(alone, { harness: "terminal", workingDir: "/tmp", node: "nope" })).rejects.toThrow(
      /no node 'nope'; available: Build Box, Laptop/,
    );
  });

  it("create_subshell on a named node with ZERO nodes says no machines are enrolled", async () => {
    // The other half of the refusal: an empty list has no names to enumerate,
    // and "available: " with nothing after it is not a sentence an agent can
    // act on. The empty list is a real wire shape, not a hypothetical: the
    // owner-only bearer read (spec 2026-09-25) answers [] for a pane whose
    // owner owns no node rows, which is every human pane until someone
    // enrolls a machine (the seeded `local` belongs to the system user).
    const { deps, calls } = await depsFor((req) => (req.path === "/api/nodes" ? [] : []));
    await expect(createSubshell(deps, { harness: "terminal", workingDir: "/tmp", node: "any" })).rejects.toThrow(
      /no node 'any'; no machines are enrolled; call list_nodes/,
    );
    expect(calls.filter((c) => c.path === "/api/subshells")).toHaveLength(0);
  });

  it("create_subshell without a node never reads /api/nodes and sends no nodeId", async () => {
    const { deps, calls } = await depsFor(() => ({ id: "s", tmuxSocket: "sk", promptDelivered: false }));
    await createSubshell(deps, { harness: "terminal", workingDir: "/tmp" });
    expect(calls.map((c) => c.path)).toEqual(["/api/subshells"]);
    expect(calls[0]?.body?.nodeId).toBeUndefined();
  });

  it("list_subshells and get_subshell project to the honest SubshellView key set", async () => {
    const { deps } = await depsFor((req) => {
      if (req.path === "/api/subshells") return [subshellWireRow()];
      if (req.path.startsWith("/api/subshells/")) return subshellWireRow();
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const [row] = await listSubshells(deps);
    expect(Object.keys(row).sort()).toEqual(SUBSHELL_VIEW_KEYS);
    const one = await getSubshell(deps, { id: "s-1" });
    expect(Object.keys(one).sort()).toEqual(SUBSHELL_VIEW_KEYS);
    expect(one).toMatchObject({ id: "s-1", nodeId: "n-1", nodeOffline: false, preview: ["hi"] });
    // UI noise an agent has no surface for never rides along.
    const wire = JSON.stringify(await listSubshells(deps));
    for (const dropped of ["shareCount", "sharedWithEveryone", "unseenPush", "backoffCount", "notify", "presetId"]) {
      expect(wire).not.toContain(dropped);
    }
  });

  it("get_subshell resolves a name through the list with the shared grammar", async () => {
    const rows = [subshellWireRow({ id: "s-1", name: "Deploy" }), subshellWireRow({ id: "s-2", name: "Scout" })];
    const { deps } = await depsFor(() => rows);
    expect((await getSubshell(deps, { name: "Scout" })).id).toBe("s-2");
    expect((await getSubshell(deps, { name: "scout" })).id).toBe("s-2");
    await expect(getSubshell(deps, { name: "ghost" })).rejects.toThrow(
      /no subshell named 'ghost'; find ids with list_subshells/,
    );
    const tied = await depsFor(() => [subshellWireRow({ name: "Mac" }), subshellWireRow({ id: "s-9", name: "MAC" })]);
    await expect(getSubshell(tied.deps, { name: "mac" })).rejects.toThrow(
      /more than one subshell named 'mac' \('Mac', 'MAC'\)/,
    );
    await expect(getSubshell(deps, {})).rejects.toThrow(/needs an id or a name/);
  });

  it("read_subshell_log passes the tail through untouched", async () => {
    const { deps, calls } = await depsFor(() => ({ lines: ["a", "b"], truncated: true }));
    expect(await readSubshellLog(deps, "s 1")).toEqual({ lines: ["a", "b"], truncated: true });
    expect(calls[0]?.path).toBe("/api/subshells/s%201/log");
  });

  it("send_to_subshell posts text with submit defaulting to true", async () => {
    const { deps, calls } = await depsFor(() => ({ ok: true }));
    expect(await sendToSubshell(deps, { id: "s-1", text: "make it go" })).toEqual({ ok: true });
    expect(calls[0]?.path).toBe("/api/subshells/s-1/input");
    expect(calls[0]?.body).toEqual({ text: "make it go", submit: true });
    await sendToSubshell(deps, { id: "s-1", text: "draft", submit: false });
    expect(calls[1]?.body).toEqual({ text: "draft", submit: false });
  });

  it("restart_subshell carries an optional prompt and returns {id, promptDelivered}", async () => {
    const { deps, calls } = await depsFor(() => ({ id: "s-1", tmuxSocket: "sk", promptDelivered: true }));
    // No prompt: the body-less POST it has always been (no content-type on the wire).
    expect(await restartSubshell(deps, { id: "s-1" })).toEqual({ id: "s-1", promptDelivered: true });
    expect(calls[0]?.body).toBeUndefined();
    await restartSubshell(deps, { id: "s-1", prompt: "continue the task" });
    expect(calls[1]?.path).toBe("/api/subshells/s-1/restart");
    expect(calls[1]?.body).toEqual({ prompt: "continue the task" });
  });

  it("create_subshell returns {id, promptDelivered}, dropping tmuxSocket", async () => {
    const { deps } = await depsFor(() => ({ id: "s-1", tmuxSocket: "sock-9", promptDelivered: true }));
    const res = await createSubshell(deps, { harness: "terminal", workingDir: "/tmp" });
    expect(res).toEqual({ id: "s-1", promptDelivered: true });
    expect(JSON.stringify(res)).not.toContain("sock-9");
  });

  it("list_presets answers with the harness catalog too, filtering it honestly", async () => {
    const plugins = [
      { id: "claude-code", name: "Claude Code", type: "agent-harness", installed: true, enabled: true },
      { id: "terminal", name: "Terminal", type: "terminal", installed: true, enabled: true },
      { id: "tailscale", name: "Tailscale", type: "network", installed: true, enabled: true },
      { id: "opencode", name: "OpenCode", type: "agent-harness", installed: false, enabled: true },
      { id: "codex", name: "Codex", type: "agent-harness", installed: true, enabled: false },
    ];
    // Zero presets: exactly when the catalog is the only answer (spec 2026-09-13).
    const { deps } = await depsFor((req) => {
      if (req.path === "/api/presets") return [];
      if (req.path === "/api/plugins") return { plugins };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    expect(await listPresets(deps)).toEqual([
      { id: "claude-code", name: "Claude Code", harnessId: "claude-code", catalogOnly: true },
      { id: "terminal", name: "Terminal", harnessId: "terminal", catalogOnly: true },
    ]);
    // With presets: rows first, unflagged; catalog entries after, flagged.
    const merged = await depsFor((req) => {
      if (req.path === "/api/presets") return [{ id: "pre-1", name: "Dev", harnessId: "claude-code", userId: "u" }];
      if (req.path === "/api/plugins") return { plugins };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const rows = await listPresets(merged.deps);
    expect(rows[0]).toEqual({ id: "pre-1", name: "Dev", harnessId: "claude-code" });
    expect("catalogOnly" in (rows[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(rows[1]?.catalogOnly).toBe(true);
  });

  it("describeToolError maps the codes the server rides by name to their next call", () => {
    expect(
      describeToolError(new ApiError(400, "Multiple online nodes; pick one (2 are online)", "NODE_REQUIRED")).message,
    ).toMatch(/list_nodes.*node/);
    expect(describeToolError(new ApiError(409, "That node has no live connection", "NODE_OFFLINE")).message).toMatch(
      /offline/i,
    );
    expect(describeToolError(new ApiError(409, "Row is not running", "SUBSHELL_NOT_RUNNING")).message).toContain(
      "restart_subshell",
    );
    expect(describeToolError(new ApiError(409, "workbox is in maintenance", "NODE_IN_MAINTENANCE")).message).toContain(
      "maintenance",
    );
    expect(describeToolError(new ApiError(404, "Node not found", "NOT_FOUND_ERROR")).message).toContain(
      "list_subshells",
    );
  });

  it("describeToolError's 409 branch answers the genericized harness refusal (it never rides as harness_disabled)", () => {
    // The server's SubshellCreateError carries only .status, so the error
    // handler genericizes its code: the create-path refusal for a disabled
    // harness arrives as EXISTS_ERROR (409) naming the condition in MESSAGE.
    // The mapping must therefore live in the 409 branch, not on a code that
    // cannot reach the wire.
    const err = new ApiError(409, "That harness is disabled or not installed on that node", "EXISTS_ERROR");
    const message = describeToolError(err).message;
    expect(message).toContain("disabled or not installed");
    expect(message).toContain("list_nodes");
  });
});
