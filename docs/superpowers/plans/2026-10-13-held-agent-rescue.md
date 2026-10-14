# Held-agent rescue (binding-arm hold) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a pinned node agent completes the encrypted handshake and only its protocol number disagrees, the plane establishes the link and HOLDS the socket (spec 2026-09-15 §5.3 posture) instead of closing it 4410, so the frozen `update` rescue command can reach it sealed.

**Architecture:** Server-only change in `apps/server/api`. The pure link machine (`link-session.ts`) gains a hold PROPOSAL on its established outcome variant (it decides, never writes); `node-ws-handler.ts` applies the proposal: wires the send-sealing session, reads the row, and parks the connection in `node-registry.ts`'s held map through a helper extracted from the existing `holdRefusedNode`. The update route, `sendCommand`'s held lookup and sealing, the held gate's drop-everything-but-`result` rule, and the SPA's `held` rendering are already written for this and are NOT touched. No schema changes anywhere, so the curated-migration-list trap (`apps/server/api/AGENTS.md`) does not apply.

**Tech Stack:** TypeScript, Bun (`bun:test`), Elysia, Kysely/sqlite. The spec: `docs/superpowers/specs/2026-10-13-held-agent-rescue-design.md`.

## Global Constraints

- The design spec is the authority; every claim it makes about existing behavior was quote-verified in review. Where the plan's code and the spec disagree, stop and re-read the spec (`docs/superpowers/specs/2026-10-13-held-agent-rescue-design.md`).
- Test commands run from `apps/server/api` (workspace resolution fails from the repo root for bare script paths). A single focused file may run under a bare `bun test <file>`; SUITE runs go through the package scripts (the `--parallel` flag lives in the scripts).
- Automation shells here may export `SHELLOPTS=onecmd:posix`, which silently no-ops bash: run every script-invoking test command as `env -u SHELLOPTS -u BASHOPTS <cmd> > /tmp/out.txt 2>&1; grep "(fail)" /tmp/out.txt || echo "no failures"` — never a second run just to find failures.
- No dynamic imports anywhere (`.claude/rules/code-style.md`). Comments and docs follow the repository writing voice (`AGENTS.md`); this file family's comments use em dashes freely and the prose linter governs docs/UI copy — run `bun run lint:prose` at the boundary and let it adjudicate.
- Vocabulary: **server** = the control plane, **node** = the machine's daemon, never overloaded. UI copy adds no new strings in this plan.
- The changeset at the end is for `@internal/server` ONLY (`@internal/server-web` is ignored by changesets and must not appear).
- Never touch `git checkout`/`stash`/anything that moves HEAD outside of the commit steps below; the tree is shared with sibling sessions.

---

### Task 1: The link machine PROPOSES the hold (and moves the phase)

**Files:**
- Modify: `apps/server/api/src/services/nodes/link-session.ts` (`LinkOutcome` union at ~143-149; `completeBinding` protocol arm at ~340-344; its docstring at ~317-323)
- Test: `apps/server/api/src/services/nodes/__tests__/link-session.test.ts` (extend the existing describe; harness helpers `makeHarness`, `handshakeData`, `kxText`, `bindingBytes`, `drive`, `CLOSE_4410` are already file-local)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `LinkOutcome`'s established variant becomes
  `{ consumed: true; established: LinkSession; sendBytes: Uint8Array; hold?: { protocolVersion: number } }`.
  A mismatched-protocol binding that passes identity now returns this variant WITH `data.linkPhase` set to `"established"`. Task 3 reads `outcome.hold`.

- [ ] **Step 1: Write the failing tests**

Append inside the file's main `describe` block (after the existing "kx is consumed with NO reply at all (R6)..." test). The helpers already exist: `makeHarness()` (real crypto, fake I/O), `handshakeData(pin)`, `kxText(h)`, `bindingBytes(h, over?)` (`over` accepts `{ nodeId, nodeKey, protocolVersion }`), `drive(h)`, and `CLOSE_4410` pinned by number.

```ts
  it("a wrong protocol on a passing identity establishes, acks, and PROPOSES the hold (spec 2026-10-13)", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(
      h.deps,
      { data },
      bindingBytes(h, { protocolVersion: NODE_PROTOCOL_VERSION - 5 }),
    );
    // Established, not refused: the ack is the same sealed {t:"ok"} the match
    // arm sends, and the CLIENT's session opens it.
    if (!("established" in outcome) || !("sendBytes" in outcome)) {
      throw new Error(`expected established+hold, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.hold).toEqual({ protocolVersion: NODE_PROTOCOL_VERSION - 5 });
    const ackText = h.client.session.openFrame(outcome.sendBytes);
    expect(ackText).not.toBeNull();
    expect(JSON.parse(ackText ?? "")).toEqual({ t: "ok" });
    // The phase moves, and this line is load-bearing: WITHOUT it the agent's
    // NEXT sealed frame — its `ready`, which shipping agents send the instant
    // the ack opens — re-enters completeBinding and is refused as "binding
    // malformed": the redial loop one gate deeper.
    expect(data.linkPhase).toBe("established");
    const next = await handleLinkFrame(
      h.deps,
      { data },
      { bytes: h.client.session.sealFrame(JSON.stringify({ type: "ready" })) },
    );
    expect("forwarded" in next).toBe(true);
  });

  it("identity refusals still close with 4410 and NEVER carry `established`, whatever the protocol says", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    // Dead node key AND a wrong protocol: identity decides first, and the
    // hold proposal must not leak into a refusal outcome.
    const dead = await handleLinkFrame(
      h.deps,
      { data },
      bindingBytes(h, { nodeKey: "no-such-key", protocolVersion: NODE_PROTOCOL_VERSION - 5 }),
    );
    if (!("close" in dead)) throw new Error(`expected a refusal, got ${JSON.stringify(dead)}`);
    expect(dead.close.code).toBe(CLOSE_4410);
    expect(dead.close.reason).toContain("nodeKey");
    expect("established" in dead).toBe(false);
    expect("hold" in dead).toBe(false);
    expect(data.linkPhase).toBe("awaiting-binding");
  });

  it("the matching arm stays exactly as it was: established, acked, and NO hold field", async () => {
    const h = await makeHarness();
    const { binding, data } = await drive(h);
    expect("established" in binding && "sendBytes" in binding).toBe(true);
    expect("hold" in binding).toBe(false);
    expect(data.linkPhase).toBe("established");
  });
```

Note: the file imports `NODE_PROTOCOL_VERSION` already (line 2). `LinkFrame` accepts `{ bytes: Uint8Array }` — that is how `bindingBytes` returns frames (check its body if the shape drifted).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/link-session.test.ts`
Expected: the new tests FAIL — today's mismatch arm returns `{ close }`, so the first throws "expected established+hold", the third passes, the second may already pass (that is fine — it pins the boundary).

- [ ] **Step 3: Implement**

In `link-session.ts`, widen the established union arm (it is a single named variant — do NOT add a second union arm; an optional property keeps existing consumers compiling):

```ts
export type LinkOutcome =
  | { consumed: true }
  | {
      consumed: true;
      established: LinkSession;
      sendBytes: Uint8Array;
      /**
       * Present when every identity check passed and ONLY the protocol number
       * disagreed (spec 2026-10-13): the machine establishes and acks, then
       * PROPOSES §5.3's hold — the handler owns the socket, the row, and the
       * held map. Identity refusals never carry this.
       */
      hold?: { protocolVersion: number };
    }
  | { forwarded: string | object }
  | { holdEncryptionRequired: true }
  | { close: { code: number; reason: string } }
  | { sendText: string; thenClose: true };
```

Replace the mismatch arm in `completeBinding` (the current `refuse("handshake refused: protocol mismatch ...")`):

```ts
  if (binding.protocolVersion !== NODE_PROTOCOL_VERSION) {
    // The §5.3 rescue, from the binding (spec 2026-10-13). Everything above
    // PASSED — the binding decrypted under the pinned session, its nodeId
    // names this row, its nodeKey re-proved the live credential — and only
    // the protocol number disagrees. Closing 4410 here stranded the one
    // agent this machine can still talk to past its own rescue: `update` is
    // FROZEN precisely because a held agent must parse it forever, and the
    // session that seals it exists the moment we ack. So: ack, MOVE THE
    // PHASE (without it the agent's sealed `ready` — sent the instant the
    // ack opens — re-enters completeBinding and is refused as "binding
    // malformed", the redial loop one gate deeper), and propose the hold.
    // The machine still writes and holds nothing; the decision it owns is
    // this line's.
    data.linkPhase = "established";
    return {
      consumed: true,
      established: session,
      sendBytes: session.sealFrame(JSON.stringify({ t: "ok" })),
      hold: { protocolVersion: binding.protocolVersion },
    };
  }
```

Update `completeBinding`'s docstring: the three checks remain ("the claimed nodeId against the bearer's row, the nodeKey re-proved through the upgrade's OWN verification chain, and the protocol exact-match"); change only the last clause to say the protocol arm now ESTABLISHES AND PROPOSES THE HOLD (spec 2026-10-13) instead of refusing, because identity is proven and the frozen `update` is the point — and keep "Each refusal names which check failed, per the two-gates doctrine".

- [ ] **Step 4: Run the file; all green, including the pre-existing tests**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/link-session.test.ts`
Expected: PASS, 0 fail. Also run `bunx tsc --noEmit` scoped via `bunx turbo verify-types --filter=@internal/server` — the widened variant must not break the handler's existing `"established" in outcome` narrowing.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/services/nodes/link-session.ts apps/server/api/src/services/nodes/__tests__/link-session.test.ts
git commit -m "feat(nodes): the binding protocol arm establishes and proposes the hold

Identity proven, protocol wrong: closing 4410 here left an encrypted-link
agent below the floor redialing forever, past the §5.3 hold that exists to
rescue it. The machine now acks, moves its phase, and proposes the hold —
deciding without writing, exactly as the registry docstrings want it.
"
```

---

### Task 2: Extract `holdSocket` (behavior-preserving refactor)

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-ws-handler.ts` (`holdRefusedNode`, ~585-627)
- Test: existing suites only — `__tests__/held-connections.test.ts`, `__tests__/node-ws-handler.test.ts`, `__tests__/node-ws-integration.test.ts`, `__tests__/link-handshake.integration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: module-private `holdSocket(deps: NodeWsDeps, conn: NodeConnection, nodeId: string, facts: { agentVersion: string; protocolVersion: number; os: string; arch: string }, reason: HeldReason, message: string): Promise<void>` — `holdConnection` + the 4406 idle close + `setStatus("offline")` + `announceNodePresence` + the warn log. `holdRefusedNode` becomes a thin `ready`-facts adapter over it. Task 3 calls `holdSocket` directly.

- [ ] **Step 1: Make the extraction**

Move `holdRefusedNode`'s body (from `holdConnection(...)` through the warn log) into the new helper; `holdRefusedNode` keeps its "no connection record to hold" guard (it needs the `ws`), resolves the conn as it already does, and delegates with the `ready`'s facts:

```ts
/**
 * Park a refused connection in the held map and project the row offline —
 * the shared machinery behind both hold sites (spec 2026-09-15 §5.3;
 * the binding arm joined it in spec 2026-10-13).
 *
 * (the long docstring currently on `holdRefusedNode` moves HERE: offline-for-
 * every-purpose-but-update, nothing-is-sent-by-this-function, and the idle
 * close carrying the reason the agent would have got immediately — plus the
 * "THE ROW GOES BACK TO OFFLINE" paragraph verbatim, with one added sentence:
 * the binding site never ran `applyReady`, so its projection is a re-assert
 * of the offline the row was left at, not a reversal.)
 */
async function holdSocket(
  deps: NodeWsDeps,
  conn: NodeConnection,
  nodeId: string,
  facts: { agentVersion: string; protocolVersion: number; os: string; arch: string },
  reason: HeldReason,
  message: string,
): Promise<void> {
  holdConnection(nodeId, conn, {
    reason,
    agentVersion: facts.agentVersion,
    protocolVersion: facts.protocolVersion,
    os: facts.os,
    arch: facts.arch,
    onIdle: () => {
      try {
        conn.ws.close(NODE_CLOSE_UPDATE_REQUIRED, message);
      } catch {
        // already gone — the registry entry is what mattered and it is dropped
      }
    },
  });
  await deps.nodes.setStatus(nodeId, "offline" satisfies NodeStatus);
  announceNodePresence(nodeId);
  logger
    .withMetadata({ nodeId, agentVersion: facts.agentVersion, protocolVersion: facts.protocolVersion })
    .warn(`node ws: holding ${nodeId} for update — ${message}`);
}
```

Leave `holdRefusedNode`'s existing docstring pointing at the machinery it now delegates to (one short paragraph is enough — the doctrine moved to `holdSocket`). Every existing import (`holdConnection`, `getLive`, `HeldReason`, `NodeStatus`, `NODE_CLOSE_UPDATE_REQUIRED`, `announceNodePresence`) is already in this file; add `NodeConnection` to the type import from `./node-registry.js` if not already there (it is — `getLive`'s return is used).

- [ ] **Step 2: Run the four pinning suites; they must pass UNCHANGED**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/held-connections.test.ts src/services/nodes/__tests__/node-ws-handler.test.ts src/services/nodes/__tests__/node-ws-integration.test.ts src/services/nodes/__tests__/link-handshake.integration.test.ts`
Expected: PASS, 0 fail. This task changes no behavior; a failure here is the extraction breaking a pinned path, not the pins being stale.

- [ ] **Step 3: Commit**

```bash
git add apps/server/api/src/services/nodes/node-ws-handler.ts
git commit -m "refactor(nodes): extract holdSocket from holdRefusedNode

The binding-arm rescue needs the same parking: held map, idle 4406, row
projection, presence announce, and the one warn line. No behavior moved.
"
```

---

### Task 3: The handler APPLIES the proposal (the rescue, end to end)

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-ws-handler.ts` (the `consumed`/`established` arm in `handleNodeMessage`, ~705-715)
- Test: `apps/server/api/src/services/nodes/__tests__/link-handshake.integration.test.ts` (extend `FakeAgent` cfg + new describe at file end)

**Interfaces:**
- Consumes: Task 1's `outcome.hold`; Task 2's `holdSocket(deps, conn, nodeId, facts, reason, message)`; `deps.nodes.findById` (already in `NodeWsNodesRepo`); row columns `agentVersion/os/arch: string | null` (`src/db/types/nodes.db-types.ts`).
- Produces: behavior — a wrong-protocol pinned agent ends up in `getHeld(nodeId)` with reason `"protocol-mismatch"`, the row at `offline`, and `sendCommand`'s existing held fallback reaches it sealed. No new exported symbols.

- [ ] **Step 1: Teach `FakeAgent` to speak an old protocol**

In the `FakeAgent` constructor's `cfg` type add:

```ts
      /** The protocol the binding CLAIMS — old on purpose in the rescue tests. */
      protocolVersion?: number;
```

and in `dial()`, the sealed binding's `protocolVersion` becomes `this.cfg.protocolVersion ?? NODE_PROTOCOL_VERSION`. (`establish()` passes nothing, so every existing test keeps the current number.)

- [ ] **Step 2: Write the failing integration test**

Append a new `describe` at the end of `link-handshake.integration.test.ts`. All helpers are file-local and already imported there: `fixtureNode`, `waitFor`, `FakeAgent`, `JtiLru`, `getHeld`, `getLive`, `sendCommand`, `nodes`, `serverStatic`, `unique`.

```ts
describe("the binding-arm hold — a pinned agent on a wrong protocol (spec 2026-10-13)", () => {
  /** Dial an agent whose binding claims an old protocol, and wait for its hold. */
  async function dialStaleAgent(nodeId: string, key: string, nodeStatic: LinkKeyPair, behind: number) {
    const agent = new FakeAgent(
      {
        nodeId,
        key,
        nodeStatic,
        controlStaticPub: serverStatic.publicKey,
        mode: "handshake",
        protocolVersion: NODE_PROTOCOL_VERSION - behind,
      },
      new JtiLru(),
    );
    await agent.dial();
    await waitFor(() => agent.established, "sealed ok ack opened to a wrong-protocol agent");
    await waitFor(() => getHeld(nodeId) !== undefined, "binding-arm hold lands");
    return agent;
  }

  it("establishes, holds update-only with the row's last honest facts, and a sealed update reaches it", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    // The machine's honest history: it readied BEFORE the plane bumped its
    // protocol, and the plane's boot then projected the row offline.
    await nodes.applyReady(nodeId, {
      agentVersion: "1.5.5",
      protocolVersion: NODE_PROTOCOL_VERSION - 5,
      os: "linux",
      arch: "x64",
      hostname: "pre-bump-box",
      capabilities: [],
    });
    await nodes.setStatus(nodeId, "offline");

    const agent = await dialStaleAgent(nodeId, key, nodeStatic, 5);

    const entry = getHeld(nodeId);
    if (!entry) throw new Error("no held entry");
    expect(getLive(nodeId)).toBeUndefined();
    expect(entry.reason).toBe("protocol-mismatch");
    expect(entry.agentVersion).toBe("1.5.5");
    expect(entry.os).toBe("linux");
    expect(entry.protocolVersion).toBe(NODE_PROTOCOL_VERSION - 5);
    expect((await nodes.findById(nodeId))?.status).toBe("offline");

    // The agent believes it connected and arms: its `ready` and heartbeats
    // arrive SEALED. They are forwarded (the machine's phase moved — this is
    // NOT the "binding malformed" 4410 the rescue replaced) and dropped by
    // the held gate: no row write, no new facts, and the idle deadline is
    // untouched (it is armed once, at hold time).
    agent.sealAndSend({
      type: "ready",
      agentVersion: "9.9.9",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      hostname: "would-overwrite",
      dataDir: "/tmp/agent",
      capabilities: [],
    });
    agent.sealAndSend({ type: "heartbeat", ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 120));
    expect((await nodes.findById(nodeId))?.hostname).toBe("pre-bump-box");
    expect(getHeld(nodeId)).toBeDefined();

    // THE RESCUE: the frozen `update` command — real `sendCommand`, held
    // fallback, control-key signing, sealed over the session the handshake
    // derived — and the agent's own `result` settles the correlation.
    const answer = await sendCommand(nodeId, {
      type: "update",
      version: "2.0.1",
      url: `https://plane.example/api/downloads/node/linux-x64?update_token=nut_${unique("t")}`,
      sha256: "a".repeat(64),
    });
    expect(answer).toEqual({ ack: "update" });
    expect(agent.cmds.some((c) => c.cmd.type === "update" && c.cmd.version === "2.0.1")).toBe(true);
    // Binary both directions from the kx on: the rescue never spoke plaintext
    // to a handshake socket, and every envelope verified against the real
    // control key.
    expect(agent.wireIn.every((kind) => kind === "binary")).toBe(true);
    expect(agent.unexpectedText).toEqual([]);
    agent.close();
  });

  it("a redial while held supersedes the previous held socket with 4409", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    const first = await dialStaleAgent(nodeId, key, nodeStatic, 5);
    const second = await dialStaleAgent(nodeId, key, nodeStatic, 5);
    const gone = await first.waitClosed();
    expect(gone.code).toBe(4409);
    // The NEW socket is the held one; the row still reads offline.
    expect(getHeld(nodeId)?.conn).toBeDefined();
    expect(getLive(nodeId)).toBeUndefined();
    expect((await nodes.findById(nodeId))?.status).toBe("offline");
    second.close();
  });

  it("a row that never readied holds with the blank/unknown fallbacks", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic }); // no applyReady: os/arch/version null
    const agent = await dialStaleAgent(nodeId, key, nodeStatic, 3);
    const entry = getHeld(nodeId);
    if (!entry) throw new Error("no held entry");
    expect(entry.agentVersion).toBe("");
    expect(entry.os).toBe("unknown");
    expect(entry.arch).toBe("unknown");
    agent.close();
  });
});
```

If the file's `afterAll`/sibling tests assume registry emptiness, note `resetNodeRegistryForTests()` already runs there; the `unique()` ids keep rows apart.

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/link-handshake.integration.test.ts`
Expected: the new tests FAIL — today the server closes 4410, so `waitFor("sealed ok ack opened...")` times out (5 s budget). The describe's first test also proves Task 1 landed (a refused 4410 before the ack opens is the OLD behavior).

- [ ] **Step 4: Implement the handler arm**

In `handleNodeMessage`, the `if ("consumed" in outcome)` block already sends `sendBytes` and then sets `linkConn.link` + clears `ws.data.handshakeTimer` under `if ("established" in outcome)`. Append INSIDE that established block, after the timer clear:

```ts
        // The binding-arm hold (spec 2026-10-13): the machine proposed it —
        // identity proven, protocol refused. Wire FIRST (above), hold second:
        // `sendCommand` seals through the link this block just set, so the
        // frozen rescue leaves sealed, which is the ONLY form a handshake
        // agent's negotiator opens. Frame handling on this socket is
        // serialized (`handleNodeMessageQueued`), so the agent's synchronously
        // sent `ready` is processed only after this lands: by then the held
        // gate matches `ws.data.nodeConn === heldEntry.conn` and drops it.
        if (outcome.hold) {
          const row = await deps.nodes.findById(nodeId);
          const message = `protocol v${NODE_PROTOCOL_VERSION} required (this node speaks v${outcome.hold.protocolVersion})`;
          if (linkConn) {
            await holdSocket(
              deps,
              linkConn,
              nodeId,
              {
                // The row's last honest `ready`'s facts — this path never
                // runs `applyReady`, and a build we cannot talk to writes no
                // machine facts. "" is the "unversioned" spelling the route
                // already renders; "unknown" is the ready grammar's own
                // spelling, so the route's triple refusal reads honestly.
                agentVersion: row?.agentVersion ?? "",
                protocolVersion: outcome.hold.protocolVersion,
                os: row?.os ?? "unknown",
                arch: row?.arch ?? "unknown",
              },
              "protocol-mismatch",
              message,
            );
          } else {
            // No connection record (a socket that never went through `open`)
            // — refuse it the old way, exactly as `holdRefusedNode`'s guard
            // does: nothing can reach it to rescue it.
            ws.close(NODE_CLOSE_UPDATE_REQUIRED, message);
          }
        }
```

`NODE_PROTOCOL_VERSION` is already imported (line 6 area). Also amend `handleNodeOpen`'s docstring sentence "(a handshake row's plaintext `ready` never survives to the gates that hold it), so the frozen `update` rescue keeps its plaintext verbatim" → legacy rows' holds reach us plaintext and keep that form verbatim; a HANDSHAKE row's wrong-protocol agent is held from the binding (spec 2026-10-13) with its link set, and reaches the same frozen rescue **sealed**.

- [ ] **Step 5: Run the integration file plus the regression four**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/link-handshake.integration.test.ts src/services/nodes/__tests__/node-ws-handler.test.ts src/services/nodes/__tests__/node-ws-integration.test.ts src/services/nodes/__tests__/held-connections.test.ts src/services/nodes/__tests__/link-session.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/server/api/src/services/nodes/node-ws-handler.ts apps/server/api/src/services/nodes/__tests__/link-handshake.integration.test.ts
git commit -m "feat(nodes): hold wrong-protocol agents from the handshake binding

An encrypted-link agent one protocol behind now finishes its handshake,
lands in the held map (offline for every purpose but update, row
projection included, held facts from its last honest ready), and receives
the frozen update command sealed over the session it just derived. This is
the §5.3 rescue, reachable at last from protocol 14 up; pre-encryption
agents keep their plaintext path.
"
```

---

### Task 4: Pin the route's held reading (test-only)

**Files:**
- Test: `apps/server/api/src/api/nodes/__tests__/update-node.route.test.ts`

**Interfaces:**
- Consumes: nothing; the route is unchanged. This task's job is proving the spec's claim that `POST /api/nodes/:id/update` already does the right thing on a binding-held node — held protocol gate (`held?.protocolVersion ?? row.protocolVersion` vs `NODE_SIGNED_UPDATES_PROTOCOL_VERSION` = 12), version/triple reading held-then-row, `nut_` token minting.
- Produces: the `goHeld` fixture gains optional facts/reason; one new test.

Existing coverage already pins most of it (line ~357 `goHeld`, ~478 offline 409, ~521 held-protocol gate, ~747 held dispatch through `updateWithAnswer(..., "held")`). What is missing is the never-ready fallback the handler now produces: `os/arch = "unknown"`, `agentVersion = ""`.

- [ ] **Step 1: Extend the fixture and add the test**

`goHeld` (near line 330) currently hardcodes `reason: "below-floor"`, `agentVersion: "0.8.0"`, `os: "linux"`, `arch: "x64"`. Widen it WITHOUT touching call sites' behavior:

```ts
function goHeld(
    nodeId: string,
    protocolVersion: number = NODE_PROTOCOL_VERSION,
    entry: Partial<{ agentVersion: string; os: string; arch: string; reason: "below-floor" | "protocol-mismatch" | "encryption-required" }> = {},
): ReturnType<typeof fakeSocket> {
    const sock = fakeSocket();
    const conn = attachConnection(nodeId, sock);
    holdConnection(nodeId, conn, {
      reason: entry.reason ?? "below-floor",
      agentVersion: entry.agentVersion ?? "0.8.0",
      protocolVersion,
      os: entry.os ?? "linux",
      arch: entry.arch ?? "x64",
      onIdle: () => undefined,
    });
    return sock;
}
```

New test in the describe that owns the held cases (beside the "reads the number off the HELD socket" test):

```ts
  it("a binding-held never-ready node gets the named platform refusal, not a mispick (spec 2026-10-13)", async () => {
    useFakeRelease();
    const id = await mkNode(); // created offline; NO applyReady → row's os/arch are null
    // Exactly the held entry the binding path produces for a row that never
    // readied: signed-capable protocol (gate passes), unknown platform, blank
    // version. The route must refuse on the platform, by name.
    goHeld(id, NODE_SIGNED_UPDATES_PROTOCOL_VERSION, { agentVersion: "", os: "unknown", arch: "unknown", reason: "protocol-mismatch" });
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.message).toContain("No subshell binary is published for unknown/unknown");
  });
```

- [ ] **Step 2: Run the file**

Run: `cd apps/server/api && bun test src/api/nodes/__tests__/update-node.route.test.ts`
Expected: PASS including the new test. If the new test fails, that is a ROUTE defect the spec claimed away — stop, re-read `update-node.route.ts:298-311`, and fix the route, not the assertion. If any pre-existing assertion breaks on the fixture signature, the call sites are positional — the added third parameter must not shift them (it is optional and last).

- [ ] **Step 3: Commit**

```bash
git add apps/server/api/src/api/nodes/__tests__/update-node.route.test.ts
git commit -m "test(nodes): pin the update route on a binding-held never-ready node

The rescue's held entries carry the grammar's own unknown/blank spellings;
this pins that the route refuses on the platform by name rather than
mis-picking an artifact or writing a blank into the audit trail.
"
```

---

### Task 5: The doc and comment sweep, and the changeset

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-registry.ts` (`link` doc ~164-171, `plaintextAllowed` doc ~173-183, `HELD_IDLE_MS` doc ~268-278)
- Modify: `apps/server/api/src/services/nodes/node-rpc.ts` (I-2 comment ~175-185; seal-site comment ~221-225)
- Modify: `apps/server/api/docs/node-gates.md` (ordering lines 1-6, 30-33, 40-43)
- Modify: `apps/server/api/AGENTS.md` (the "A node is refused by TWO gates" paragraph)
- Modify: `docs/security.md` (§11.12's held account, and §6's link paragraph — search for the §5.3 hold text)
- Modify: `.claude/rules/security-context.md` (the Nodes bullet "Refused agents are HELD, not closed (§11.12)")
- Create: `.changeset/hold-the-wrong-protocol-node.md`

**Interfaces:**
- Consumes: Tasks 1-4 as landed.
- Produces: documentation that matches the shipped behavior; the changeset that ships it.

- [ ] **Step 1: The four stale plaintext-held comments**

`node-registry.ts`, `link` docstring: `"...every held socket, every agent that predates the handshake..."` → the held map holds TWO kinds now: a legacy hold sits with no link (plaintext rescue, unchanged); a binding-arm hold (spec 2026-10-13) has its link set and takes the sealed arm. Keep the sentence's warning about pre-`kx` conns.
`node-registry.ts`, `plaintextAllowed` docstring: `"...and every held socket is one)"` → true for LEGACY holds; a binding-arm hold is HANDSHAKE-classified with `false` and a `link`, so its rescue rides the sealed arm — `sendCommand`'s I-2 guard cannot fire because this path sets the link before the hold.
`node-rpc.ts`, seal-site comment: `"the plaintext branch is the legacy/held path"` → "the legacy path and its holds"; note the binding-held socket has a link and seals (spec 2026-10-13). Keep "byte-for-byte what it always sent" about the plaintext branch itself.
`node-registry.ts`, `HELD_IDLE_MS` docstring: after "the agent's backoff loop reconnects and is held again" add that from the protocol-15 agents on the 4406 is TERMINAL — the agent reverts any refused update transaction and exits, and the SERVICE MANAGER brings it back to redial (verified against `cli-node-v1.5.5` `daemon.ts`'s close arm). Same budget either way.

- [ ] **Step 2: The ordering doctrine**

`docs/node-gates.md`: after the "TWO gates, in this order" opening and the "the floor refusal... is the one it hears" paragraph, add the spec 2026-10-13 ruling (short, matching the file's voice): a PINNED agent meets neither gate at `node-ws-handler` first — its refusal is decided by the handshake binding in `link-session.ts`, which sees only `{nodeId, nodeKey, protocolVersion}` and therefore cannot run the floor first. A pinned node meeting both conditions hears the PROTOCOL sentence; floor-first survives on the legacy plaintext path and for floor-only raises. The idle-reconnect and identity-persisted lines get their same carve-outs (facts on a binding-held never-ready row are `""`/"unknown" fallbacks, not a fresh claim). Mirror ONE compressed sentence in `apps/server/api/AGENTS.md`'s two-gates paragraph and route the depth to `node-gates.md`.
`docs/security.md` and `.claude/rules/security-context.md`: where the held rescue is accounted, add the half-sentence: a pinned wrong-protocol agent is now held FROM THE BINDING (link established, `update` sealed) instead of refused 4410 — same posture, reachable from protocol 14 up. Keep both files' word counts in check: these are summaries; `node-gates.md` and the spec carry the account.

- [ ] **Step 3: The changeset**

Create `.changeset/hold-the-wrong-protocol-node.md`:

```markdown
---
"@internal/server": patch
---

Hold nodes the protocol gate refused mid-handshake, so Update can reach them. An encrypted-link agent one protocol behind a upgraded server used to be closed with "protocol mismatch" and redial forever, showing only as offline with an Update button that refused. It now finishes its handshake, is held offline-for-everything-but-update, and the Updates page's Update button rescues it in one click.
```

(`@internal/server` only — `@internal/server-web` and every other workspace stays out of this file.)

- [ ] **Step 4: Lint the prose you touched**

Run: `bun run lint:prose` and `bunx biome check apps/server/api/docs/node-gates.md` (read-only)
Expected: clean. Then commit:

```bash
git add apps/server/api/src/services/nodes/node-registry.ts apps/server/api/src/services/nodes/node-rpc.ts apps/server/api/docs/node-gates.md apps/server/api/AGENTS.md docs/security.md .claude/rules/security-context.md .changeset/hold-the-wrong-protocol-node.md
git commit -m "docs(nodes): the two gates now have a binding ahead of them

Comments that claimed every held socket speaks plaintext, and the ordering
doctrine that said the floor always runs first, both stop being true for a
pinned agent: its protocol is decided by the handshake. Recorded the
ruling, the plaintext/sealed arms, and the terminal-4406 restart path.
"
```

---

### Task 6: Boundary verification

- [ ] **Step 1: Full type + lint + test set (repo root)**

```bash
bun run verify-types
bun run lint:check
bun run lint:prose
env -u SHELLOPTS -u BASHOPTS bun run test > /tmp/test-out.txt 2>&1; echo exit=$?; grep "(fail)" /tmp/test-out.txt || echo "no failures"; tail -4 /tmp/test-out.txt
```

Expected: all exit 0, "no failures". (`bun run test` is the sanctioned suite regime; `test` keeps its `dependsOn: ["^build"]` — do not narrow or skip it.) No `packages/` file changed, so `turbo build` is not required by the build rule; run it anyway if any step touched `packages/` (it should not have).

- [ ] **Step 2: Review until clean**

Per `.claude/rules/code-review.md`: run the `code-reviewer` agent over the branch range (`main..HEAD`), address every MAJOR/MINOR, re-review, repeat until a full pass returns zero.

- [ ] **Step 3: If anything failed, fix and return to Step 1.**

---

## Self-review notes (plan vs spec)

- Spec §1 (machine + phase) → Task 1. Spec §2 (handler, facts fallbacks `""`/`"unknown"`, ordering, announce) → Tasks 2+3. Spec §3 (untouched surfaces) → Tasks 3-4 assert them untouched while proving reachability. Spec §4 (boundaries incl. terminal 4406) → Task 5 Step 1. Spec tests 1-7 → Task 1 (three unit), Task 3 (integration: ack/hold/drop/sealed-update/supersede/fallbacks), Task 4 (route unknown refusal). Test 5's idle-timer semantics are registry-level and already pinned in `held-connections.test.ts:153`; the binding path shares that helper verbatim and Task 3 asserts heartbeats do not extend it within the test window.
- No schema change anywhere: the curated-migration-list trap does not apply (said so in Architecture).
- `holdSocket` signature is identical in Tasks 2 and 3. `outcome.hold` shape identical in Tasks 1 and 3.
