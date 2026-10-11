# Node credential hot-reload + Nodes status dot and filters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make on-disk credential changes land in a running node daemon without a restart (fixing silent re-register no-ops), and make the Nodes page legible: a status dot replacing the invisible chip, plus search/status/shared filters.

**Architecture:** Part A adds two pure helpers to the agent's `config.ts` (identity comparison + in-place field swap) and a single `refreshConnectionConfig()` seam in `daemon.ts` called from the heartbeat beat (healthy connections) and the reconnect loop (stuck daemons — the incident shape). Part B adds a pure `node-filter.ts` lib, a `NodeStatusDot` component wired into both Nodes views, and a filter toolbar in `routes/nodes.tsx`.

**Tech stack:** Bun + TypeScript; `bun:test` everywhere (both apps); React + Tailwind tokens on the web side.

**Spec:** `docs/superpowers/specs/2026-10-10-node-credential-hot-reload-and-node-filters-design.md`

## Global Constraints

- Work happens ONLY in the worktree `/home/theo/subshell-worktrees/node-onboarding-and-filters` (branch `fix/node-reregister-and-filters`).
- Tests: `bun test` (NOT vitest). Agent app: `cd apps/node/agent && bun test src/__tests__/<file>.ts`. Web app: `cd apps/server/web && bun test src/<path>/<file>.test.tsx`.
- Log lines must NEVER print `nodeKey` or any config secret; the change log names the **nodeId** only.
- Nothing in this plan may stop/restart the daemon process or kill panes (the repo's pane doctrine; `service restart` stays `--force`-gated).
- Copy rule: no em dashes in user-facing strings (use `·` middots, matching existing badge/dot copy).
- Reload criterion is **field equality** on parsed values, never file-byte equality.
- Commit after every green task; lefthook runs biome automatically — stage explicit paths only.

---

### Task A1: connection-identity helpers in `config.ts`

**Files:**
- Modify: `apps/node/agent/src/config.ts`
- Create: `apps/node/agent/src/__tests__/config-connection.test.ts`

**Interfaces:**
- Consumes: existing `NodeConfig` (fields `serverUrl`, `nodeWsUrl?`, `nodeId`, `nodeKey`, `controlPublicKey`, `controlEncryptPublicKey?`, `encryptKeyPair?: {publicKey; privateKey}`).
- Produces: `connectionIdentity(c: NodeConfig): string`, `applyConnectionFields(target: NodeConfig, source: NodeConfig): void` — used by Task A2.

- [ ] **Step 1: Write the failing tests**

Create `apps/node/agent/src/__tests__/config-connection.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type NodeConfig, applyConnectionFields, connectionIdentity } from "../config.js";

const BASE: NodeConfig = {
  serverUrl: "https://plane.example",
  nodeWsUrl: "wss://plane.example/ws/node",
  nodeId: "node-a",
  nodeKey: "subshell_key_a",
  controlPublicKey: '{"kty":"EC"}',
  controlEncryptPublicKey: "AAAA",
  encryptKeyPair: { publicKey: "PUB", privateKey: "PRIV" },
  dataDir: "/tmp/ignored-by-identity",
  name: "box",
} as NodeConfig;

describe("connectionIdentity", () => {
  test("stable for a byte-identical or reordered-but-equal config", () => {
    expect(connectionIdentity(BASE)).toBe(connectionIdentity({ ...BASE }));
    // Key order inside the keypair must not read as a change.
    expect(connectionIdentity({ ...BASE, encryptKeyPair: { privateKey: "PRIV", publicKey: "PUB" } })).toBe(
      connectionIdentity(BASE),
    );
  });
  test("changes when any connection field changes", () => {
    for (const patch of [
      { nodeId: "node-b" },
      { nodeKey: "subshell_key_b" },
      { serverUrl: "https://other.example" },
      { nodeWsUrl: undefined },
      { controlEncryptPublicKey: "BBBB" },
      { encryptKeyPair: { publicKey: "PUB", privateKey: "OTHER" } },
    ]) {
      expect(connectionIdentity({ ...BASE, ...(patch as Partial<NodeConfig>) })).not.toBe(connectionIdentity(BASE));
    }
  });
  test("ignores non-connection fields", () => {
    expect(connectionIdentity({ ...BASE, name: "renamed", dataDir: "/elsewhere" })).toBe(connectionIdentity(BASE));
  });
});

describe("applyConnectionFields", () => {
  test("copies connection fields in place and leaves others alone", () => {
    const live = { ...BASE };
    applyConnectionFields(live, { ...BASE, nodeId: "node-b", nodeKey: "subshell_key_b", name: "different" });
    expect(live.nodeId).toBe("node-b");
    expect(live.nodeKey).toBe("subshell_key_b");
    expect(live.name).toBe("box"); // NON-connection fields are never touched
  });
  test("removes optional fields the disk no longer carries", () => {
    const live = { ...BASE };
    applyConnectionFields(live, { ...BASE, nodeWsUrl: undefined, encryptKeyPair: undefined });
    expect(live.nodeWsUrl).toBeUndefined();
    expect(live.encryptKeyPair).toBeUndefined();
    expect(live.nodeId).toBe("node-a"); // unchanged fields survive
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/node/agent && bun test src/__tests__/config-connection.test.ts`
Expected: FAIL — `applyConnectionFields` / `connectionIdentity` are not exported.

- [ ] **Step 3: Implement**

Append to `apps/node/agent/src/config.ts` (after the `NodeConfig` interface / near `loadConfig`):

```ts
/**
 * The fields whose on-disk change means the LIVE connection identity of a
 * running daemon is stale (design 2026-10-10 §A): everything needed to dial,
 * authenticate, and seal a link. Non-connection fields (name, dataDir, …) are
 * deliberately excluded — they must never cost a redial.
 */
export function connectionIdentity(c: NodeConfig): string {
  return JSON.stringify([
    c.serverUrl,
    c.nodeWsUrl ?? null,
    c.nodeId,
    c.nodeKey,
    c.controlPublicKey,
    c.controlEncryptPublicKey ?? null,
    // Explicit tuple, not object order: a key-order-only reformat is not a change.
    c.encryptKeyPair ? [c.encryptKeyPair.publicKey, c.encryptKeyPair.privateKey] : null,
  ]);
}

/**
 * In-place swap of exactly the connection fields from `source` onto `target`.
 * In-place because every consumer of the daemon's config holds THIS object
 * (`persistLink` in daemon.ts established the discipline); replacing the
 * reference would strand half the closures on the old bundle. Fields the disk
 * no longer carries are deleted, never left stale.
 */
export function applyConnectionFields(target: NodeConfig, source: NodeConfig): void {
  const t = target as unknown as Record<string, unknown>;
  const s = source as unknown as Record<string, unknown>;
  for (const key of ["serverUrl", "nodeWsUrl", "nodeId", "nodeKey", "controlPublicKey", "controlEncryptPublicKey", "encryptKeyPair"] as const) {
    const value = s[key];
    if (value === undefined) delete t[key];
    else t[key] = value;
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `cd apps/node/agent && bun test src/__tests__/config-connection.test.ts`
Expected: all pass. Also re-run the existing config suite to catch regressions: `bun test src/__tests__/ -t config` — if that selects nothing, run `bun test src/__tests__/config.test.ts` only if the file exists; otherwise skip (the new file is the coverage).

- [ ] **Step 5: Commit**

```bash
git add apps/node/agent/src/config.ts apps/node/agent/src/__tests__/config-connection.test.ts
git commit -m "feat(node): connection-identity compare and in-place field swap for config hot-reload"
```

---

### Task A2: daemon `refreshConnectionConfig()` at both seams

**Files:**
- Modify: `apps/node/agent/src/daemon.ts` (dial URL per-connection ~:411/:890/:981; pinned-key const :423/:810; new refresh after `writeLiveness` ~:600; heartbeat call ~:1043; loop seam ~:1133)
- Modify: `apps/node/agent/src/__tests__/daemon.test.ts` (four new tests)

**Interfaces:**
- Consumes: `connectionIdentity`, `applyConnectionFields` (Task A1), existing `loadConfig`, `resolveWsUrl`, `parsePinnedKey`, `setDaemonState`, `log`.
- Produces: behavior only — no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `apps/node/agent/src/__tests__/daemon.test.ts` (module-level, beside the other `test(...)` blocks — `startDaemon`, `waitUntil`, `sleep`, `closeAllSockets`, `readFileSync`, `lockPath`, `saveConfig`, `configPath`, `captureLogs`, `NODE_KEY` are all in scope in that file):

```ts
test("config flip on disk reconnects within a beat without a process restart", async () => {
  const logs = captureLogs();
  const h = await startDaemon({ heartbeatMs: 30 });
  const openedBefore = h.plane.opens;
  saveConfig({ ...h.config, nodeId: "flipped-node-id" });
  await waitUntil(() => h.plane.opens > openedBefore, "redial after config flip");
  expect(logs.lines.some((l) => l.includes("config changed; reconnecting as node flipped-node-id"))).toBe(true);
  expect(logs.lines.some((l) => l.includes(NODE_KEY))).toBe(false); // the bearer never reaches the log
  const lock = JSON.parse(readFileSync(lockPath(), "utf8")) as { nodeId: string };
  expect(lock.nodeId).toBe("flipped-node-id"); // daemon.lock followed the swap
  logs.restore();
});

test("a stuck-between-dials daemon picks up a rewritten config on its next dial (re-register incident)", async () => {
  const logs = captureLogs();
  const h = await startDaemon({ heartbeatMs: 10_000 }); // no beat: exercise the LOOP seam only
  const openedBefore = h.plane.opens;
  saveConfig({ ...h.config, nodeId: "loop-flipped" });
  closeAllSockets(h.plane, 1012, "force a redial"); // the incident shape: no live socket, backoff dials
  await waitUntil(() => logs.lines.some((l) => l.includes("config changed; reconnecting as node loop-flipped")) &&
    h.plane.opens > openedBefore, "loop-seam reload");
  logs.restore();
});

test("unparsable config on disk is one warn line and keeps the live connection", async () => {
  const logs = captureLogs();
  const h = await startDaemon({ heartbeatMs: 30 });
  writeFileSync(configPath(), "{ this is not json", { mode: 0o600 });
  await sleep(120); // several beats against the broken file
  expect(h.plane.opens).toBe(1); // no controlled close, no chaos
  const warns = logs.lines.filter((l) => l.includes("config reload failed"));
  expect(warns.length).toBe(1); // deduped: one line, not one per beat
  expect(logs.lines.some((l) => l.includes("keeping the running identity"))).toBe(true);
  saveConfig({ ...h.config, nodeId: "after-good-write" }); // a good write after the bad one lands
  await waitUntil(() => logs.lines.some((l) => l.includes("reconnecting as node after-good-write")), "recover");
  logs.restore();
});

test("a formatting-only config rewrite (same fields, reordered keys) costs no redial", async () => {
  const h = await startDaemon({ heartbeatMs: 30 });
  const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(raw).reverse()) reordered[key] = raw[key];
  writeFileSync(configPath(), JSON.stringify(reordered, null, 7), { mode: 0o600 });
  await sleep(150); // several beats against a byte-different, field-identical file
  expect(h.plane.opens).toBe(1);
});
```

(`writeFileSync`, `readFileSync` are already imported at the top of the file; `saveConfig`/`configPath` too.)

**Non-vacuous before flip:** every test that rewrites the config while a socket is live must FIRST wait for the connection to be established (the file's established-socket idiom — e.g. `await waitFor<NodeEvent>(h, (e) => e.type === "heartbeat")`, or mirror how adjacent tests wait for `ready`). A beat can only fire on an established socket; a test that flips the file before the daemon ever connected asserts nothing.

- [ ] **Step 2: Run to verify the first three fail**

Run: `cd apps/node/agent && bun test src/__tests__/daemon.test.ts`
Expected: the four new tests fail (no reconnect happens / no warn lines); all pre-existing tests still pass.

- [ ] **Step 3: Implement the daemon changes**

All edits in `apps/node/agent/src/daemon.ts`:

a) Import line :24 — extend the config import:

```ts
import { applyConnectionFields, connectionIdentity, loadConfig, type NodeConfig, updateConfig } from "./config.js";
```

b) Delete the boot-time `wsUrl` constant (:411) — the `runConnection` dial computes it fresh (this is what makes a `serverUrl`/`nodeWsUrl` swap land):

```ts
// REMOVED: const wsUrl = resolveWsUrl(config); // persisted-at-enroll URL wins (ledger 17c)
// (dial resolves per-connection now — see runConnection)
```

Inside `runConnection` (the `new WebSocketImpl(wsUrl, ...)` at ~:890), replace the three `wsUrl` uses:

```ts
      const dialUrl = resolveWsUrl(config); // per-DIAL: a hot-swapped serverUrl must land here
      try {
        ws = new WebSocketImpl(dialUrl, { headers: { Authorization: `Bearer ${config.nodeKey}` } });
      } catch (err) {
        reject(new Error(`cannot open ${dialUrl}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
```

and the open-listener log (~:981): `log(`connected ${dialUrl} as node ${config.nodeId}`);`

c) The pinned control key becomes re-assignable (:423 and its use at :810):

```ts
  let pinnedControlKey = parsePinnedKey(config.controlPublicKey); // re-parsed on a hot swap
```

and at the `verifyCommand` call (:810) pass `pinnedControlKey` instead of `controlPublicKey`.

d) Add the refresh seam immediately AFTER the `writeLiveness` definition + initial call (~:606):

```ts
  // Hot-reload of the connection identity (design 2026-10-10 §A). config.json is
  // the live home of the node's credentials, and three writers rewrite it while
  // this process runs: `subshell setup` (re-registration), `set-server-url`, and
  // §5's register self-heal. Each beat and each between-dials moment compares the
  // connection-affecting fields (parsed-value equality, never file bytes); on a
  // real change the fields are swapped IN PLACE — every consumer holds this same
  // object, the discipline `persistLink` already follows — and the caller hands
  // the reconnect loop a fresh dial. A config the loader rejects costs ONE warn
  // line (deduped by message) and the running identity, never a dropped socket:
  // a bad write can only ever preserve the status quo. The log names the nodeId
  // only — the bearer key must never reach a log line.
  let liveIdentity = connectionIdentity(config);
  let lastBadConfig = "";
  const refreshConnectionConfig = (): boolean => {
    let fresh: NodeConfig;
    try {
      fresh = loadConfig();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail !== lastBadConfig) {
        lastBadConfig = detail;
        log(`config reload failed: ${detail}; keeping the running identity`);
      }
      return false;
    }
    const next = connectionIdentity(fresh);
    if (next === liveIdentity) return false;
    let pinned: typeof pinnedControlKey;
    try {
      pinned = parsePinnedKey(fresh.controlPublicKey);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail !== lastBadConfig) {
        lastBadConfig = detail;
        log(`config reload failed: control key unparsable (${detail}); keeping the running identity`);
      }
      return false; // whole-bundle rule: a swap half-applied is worse than none
    }
    lastBadConfig = "";
    liveIdentity = next;
    applyConnectionFields(config, fresh);
    pinnedControlKey = pinned;
    setDaemonState({ serverUrl: config.serverUrl, nodeId: config.nodeId });
    log(`config changed; reconnecting as node ${config.nodeId}`);
    return true;
  };
```

(`lastBadConfig` resets exactly once — the line in the snippet after both parses succeeded; recovery is then silent.)

e) Heartbeat beat (:1043-1053 block): after `writeLiveness();` and `maybeReportMaintenance(ctx);`, add:

```ts
          // A healthy connection checks too: the beat that just refreshed the
          // lock is the beat that notices the plane handed us new credentials.
          // The close is the ordinary non-terminal kind — finish() clears this
          // very timer, so one change is applied once and redialed once.
          if (refreshConnectionConfig()) {
            try {
              ws.close(1000, "config changed");
            } catch {
              /* already closing — the loop redials on the new identity anyway */
            }
          }
```

f) Reconnect loop seam (~:1133), between the provisioning gate and the dial:

```ts
      await provisioning; // §5: R7's provisioning close must not redial past its own key write
      // The incident belt: a daemon stuck between dials (refused bearer, dead
      // plane) has NO heartbeat beat to check on — re-check before every dial.
      refreshConnectionConfig();
      const close = await runConnection();
```

g) Update the `runDaemon` docblock: after "refreshed on every heartbeat tick" add one sentence — "The connection identity hot-reloads from `config.json` on the beat and before every dial (design 2026-10-10 §A); a re-registration lands within one beat without a restart."

- [ ] **Step 4: Run the daemon suite green**

Run: `cd apps/node/agent && bun test src/__tests__/daemon.test.ts src/__tests__/config-connection.test.ts`
Expected: new tests pass; every pre-existing test still passes (especially the heartbeat, daemon.lock, wrong-bearer, and SIGINT tests — none should need edits).

- [ ] **Step 5: Commit**

```bash
git add apps/node/agent/src/daemon.ts apps/node/agent/src/__tests__/daemon.test.ts
git commit -m "fix(node): hot-reload connection credentials on the beat and before every dial"
```

---

### Task B1: pure `node-filter.ts` lib

**Files:**
- Create: `apps/server/web/src/lib/node-filter.ts`
- Create: `apps/server/web/src/lib/__tests__/node-filter.test.ts`

**Interfaces:**
- Consumes: `Node` from `@internal/node-admin` (fields `name`, `hostname: string | null`, `id`, `status: "online" | "offline"`, `access`).
- Produces: `NodeFilters`, `NODE_FILTERS_OFF`, `filterNodes(nodes, f): Node[]` — used by Task B3.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/web/src/lib/__tests__/node-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Node } from "@internal/node-admin";
import { NODE_FILTERS_OFF, filterNodes, type NodeFilters } from "../node-filter";

function node(over: Partial<Node>): Node {
  return { name: "box", hostname: "box.local", status: "online", access: "owner", ...over } as Node;
}
const NODES: Node[] = [
  node({ name: "AI PC", hostname: "theo-linux-ai", status: "offline" }),
  node({ name: "Server", hostname: "mac-builder", access: "edit" }),
  node({ name: "Laptop", hostname: null, id: "deadbeef-1", status: "offline", access: "read" }),
];
const AT: Partial<NodeFilters> = {}; // spread-merge over the OFF baseline

test("no filters is the identity", () => {
  expect(filterNodes(NODES, NODE_FILTERS_OFF)).toEqual(NODES);
});
test("query matches name case-insensitively", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, ...AT, query: "ai p" }).map((n) => n.name)).toEqual(["AI PC"]);
});
test("query matches hostname, and falls back to id when hostname is null", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, query: "MAC-BUILDER" }).map((n) => n.name)).toEqual(["Server"]);
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, query: "deadbeef" }).map((n) => n.name)).toEqual(["Laptop"]);
});
test("status filter", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, status: "offline" }).map((n) => n.name)).toEqual(["AI PC", "Laptop"]);
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, status: "online" }).map((n) => n.name)).toEqual(["Server"]);
});
test("access filter: yours is owner-only, shared is everything else", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, access: "yours" }).map((n) => n.name)).toEqual(["AI PC"]);
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, access: "shared" }).map((n) => n.name)).toEqual(["Server", "Laptop"]);
});
test("axes AND-combine", () => {
  expect(filterNodes(NODES, { status: "offline", access: "shared", query: "" }).map((n) => n.name)).toEqual(["Laptop"]);
});
test("whitespace-only query is no query; input array is not mutated", () => {
  const snapshot = [...NODES];
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, query: "   " })).toEqual(NODES);
  filterNodes(NODES, { ...NODE_FILTERS_OFF, status: "online" });
  expect(NODES).toEqual(snapshot);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/server/web && bun test src/lib/__tests__/node-filter.test.ts`
Expected: module-not-found for `../node-filter`.

- [ ] **Step 3: Implement**

Create `apps/server/web/src/lib/node-filter.ts`:

```ts
import type { Node } from "@internal/node-admin";

/**
 * The Nodes page's three filter axes, page state (the home page's machine
 * filter precedent: filters narrow BOTH views and do not go in the URL; the
 * view tabs do). Pure — all page logic lives here so the component stays glue.
 */
export interface NodeFilters {
  /** Substring of name or hostname (id when hostname is null), case-insensitive. */
  query: string;
  status: "all" | "online" | "offline";
  access: "all" | "yours" | "shared";
}

export const NODE_FILTERS_OFF: NodeFilters = { query: "", status: "all", access: "all" };

export function filterNodes(nodes: readonly Node[], f: NodeFilters): Node[] {
  const q = f.query.trim().toLowerCase();
  return nodes.filter(
    (n) =>
      (f.status === "all" || n.status === f.status) &&
      (f.access === "all" || (f.access === "yours" ? n.access === "owner" : n.access !== "owner")) &&
      (q === "" || n.name.toLowerCase().includes(q) || (n.hostname ?? n.id).toLowerCase().includes(q)),
  );
}
```

- [ ] **Step 4: Run to verify green**

Run: `cd apps/server/web && bun test src/lib/__tests__/node-filter.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/lib/node-filter.ts apps/server/web/src/lib/__tests__/node-filter.test.ts
git commit -m "feat(web): pure node-filter lib for the Nodes page"
```

---

### Task B2: `NodeStatusDot` wired into both Nodes views

**Files:**
- Create: `apps/server/web/src/components/nodes/node-status-dot.tsx`
- Modify: `apps/server/web/src/components/nodes/node-row.tsx` (remove the status Badge at ~:127, dot before the name ~:97)
- Modify: `apps/server/web/src/components/nodes/node-table.tsx` (status cell ~:53-57)
- Create: `apps/server/web/src/components/nodes/__tests__/node-status-dot.test.tsx`

**Interfaces:**
- Consumes: `Node`, `relativeElapsed`, `cn` from `@internal/node-admin`; color tokens `bg-success`/`bg-destructive` (same as `subshell-dot.tsx`'s `DOT_CLASS`).
- Produces: `<NodeStatusDot node={node} />` (renders a `role="img"` span whose aria-label/title reads `online` or `offline · seen …` / `offline · never seen`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/web/src/components/nodes/__tests__/node-status-dot.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { Node } from "@internal/node-admin";
import { NodeStatusDot } from "../node-status-dot";

const base = { name: "n", hostname: "h", access: "owner" } as Node;

test("online: green, announced 'online'", () => {
  render(<NodeStatusDot node={{ ...base, status: "online", lastSeenAt: "2026-10-10T00:00:00Z" }} />);
  const dot = screen.getByRole("img", { name: "online" });
  expect(dot.className).toContain("bg-success");
  expect(dot.className).not.toContain("bg-destructive");
});
test("offline with a last-seen: red, label carries the seen time", () => {
  render(<NodeStatusDot node={{ ...base, status: "offline", lastSeenAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }} />);
  const dot = screen.getByRole("img", { name: /^offline · seen / });
  expect(dot.className).toContain("bg-destructive");
});
test("never-seen offline announces 'offline · never seen'", () => {
  render(<NodeStatusDot node={{ ...base, status: "offline", lastSeenAt: null }} />);
  screen.getByRole("img", { name: "offline · never seen" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server/web && bun test src/components/nodes/__tests__/node-status-dot.test.tsx`
Expected: module-not-found.

- [ ] **Step 3: Implement the dot + swap it into the row and table**

Create `apps/server/web/src/components/nodes/node-status-dot.tsx`:

```tsx
import { type Node, cn, relativeElapsed } from "@internal/node-admin";

/**
 * The Nodes page's status mark: the 6px dot from the subshell state language
 * (`subshell-dot.tsx`) filling the node's two-state world — solid green online,
 * palette red offline (the 2026-09-24 operator ruling the subshell cards
 * already honor: unreachable is an error state, not a caution). It REPLACED
 * the text chip: a gray chip beside the gray OS chip was invisible, and an
 * operator watched a dead node that had stopped accepting credentials while a
 * re-registration sat offline for hours.
 *
 * Unlike the rail's dot (aria-hidden: the row text carries the state), this dot
 * IS the state carrier on this page — the word it once read is now only here,
 * so it announces itself and shows a title. No blink: a node is not "working".
 */
export function NodeStatusDot({ node }: { node: Node }) {
  const online = node.status === "online";
  const label = online
    ? "online"
    : node.lastSeenAt
      ? `offline · seen ${relativeElapsed(node.lastSeenAt)}`
      : "offline · never seen";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-destructive")}
    />
  );
}
```

In `node-row.tsx`: delete the status `Badge` line (`<Badge variant={node.status === "online" ? "success" : "muted"}>{node.status}</Badge>`) and its import of nothing else changes; in the identity column wrap the name line so the dot leads:

```tsx
        <div className="flex items-center gap-2">
          <NodeStatusDot node={node} />
          <p className="truncate font-strong">{node.name}</p>
        </div>
```

(add `import { NodeStatusDot } from "@/components/nodes/node-status-dot";` and update the component docblock: "name + status dot" replacing "status badge" in the chip inventory.)

In `node-table.tsx`: replace the status cell's Badge with the dot, keeping the maintenance chip:

```tsx
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2">
          <NodeStatusDot node={node} />
          {node.maintenance && <Badge variant="warning">maintenance</Badge>}
        </div>
      </td>
```

- [ ] **Step 4: Run the web node components tests green**

Run: `cd apps/server/web && bun test src/components/nodes/__tests__ src/lib/__tests__/node-filter.test.ts`
Expected: new tests pass; any pre-existing component test that asserted the `online`/`offline` chip text needs its expectation updated to the dot's aria-label (search first: `grep -rn '"online"\|"offline"\|getByText' src/components/nodes/__tests__ src/routes/__tests__ | grep -i node`) — update assertions, never the component, unless the assertion is genuinely about the chip's existence (it isn't anymore).

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/components/nodes apps/server/web/src/routes/__tests__
git commit -m "feat(web): status dot replaces the invisible Nodes status chip"
```

---

### Task B3: Nodes toolbar — search + status + shared, zero-match state

**Files:**
- Modify: `apps/server/web/src/routes/nodes.tsx`
- Create: `apps/server/web/src/routes/__tests__/nodes-page-filters.test.tsx`

**Interfaces:**
- Consumes: `NODE_FILTERS_OFF`, `filterNodes` (B1), `NodeStatusDot`-bearing rows (B2), `EmptyState`, `Select*` from `@/components/ui/select`, `Input` from `@internal/node-admin` (the `subshell-search.tsx` idiom), `useNodes` fetch stubbing via `setFetchRouter` (see `nodes-page-gate.test.tsx`).
- Produces: filtered rendering in both views; page state only, no exports.

- [ ] **Step 1: Write the failing test**

Create `apps/server/web/src/routes/__tests__/nodes-page-filters.test.tsx` — copy the ROUTER/FIXTURE scaffolding VERBATIM in shape from `nodes-page-gate.test.tsx` (its QueryClient + memory router + `setFetchRouter` stub of `GET /api/nodes`), with two nodes in the stub list instead of zero/one: `{ id: "n1", name: "AI PC", hostname: "theo-linux-ai", status: "offline", access: "owner", ... }` and `{ id: "n2", name: "Server", hostname: "mac-builder", status: "online", access: "edit", ... }` (all fields the existing gate-test fixture already supplies). Then:

```tsx
test("search narrows both the tiles and the list; status and access select", async () => {
  // render at /nodes (tiles default)
  expect(await screen.findByText("AI PC")).toBeInTheDocument();
  await user.type(screen.getByRole("searchbox", { name: "Search nodes" }), "server");
  expect(await screen.findByText("Server")).toBeInTheDocument();
  expect(screen.queryByText("AI PC")).not.toBeInTheDocument();
  await user.clear(screen.getByRole("searchbox", { name: "Search nodes" }));
  // status select (combobox per the ui/select component's role):
  await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
  await user.click(await screen.findByRole("option", { name: "Offline" }));
  expect(await screen.findByText("AI PC")).toBeInTheDocument();
  expect(screen.queryByText("Server")).not.toBeInTheDocument();
});

test("zero matches offers Clear filters, distinct from the enrollment empty state", async () => {
  await user.type(screen.getByRole("searchbox", { name: "Search nodes" }), "zzzzz");
  expect(await screen.findByText("No nodes match")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(await screen.findByText("AI PC")).toBeInTheDocument();
});
```

(`user` is `userEvent` as set up in the gate test — mirror its exact import; if `toBeInTheDocument` isn't available in this repo's bun:test env, assert on `.textContent` / truthiness exactly as the gate test does.)

- [ ] **Step 2: Run to verify it fails** (no searchbox/combobox roles exist).

Run: `cd apps/server/web && bun test src/routes/__tests__/nodes-page-filters.test.tsx`

- [ ] **Step 3: Implement the toolbar in `nodes.tsx`**

Add imports (`Input` from `@internal/node-admin`; `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` from `@/components/ui/select`; `NODE_FILTERS_OFF, type NodeFilters, filterNodes` from `@/lib/node-filter`). In `NodesPage`:

```tsx
  // Page state, not URL — the home page's machine-filter precedent: filters
  // narrow BOTH list views and a back button is expected to leave them alone
  // (the view tab keeps the URL). (design 2026-10-10 §B)
  const [filters, setFilters] = useState<NodeFilters>(NODE_FILTERS_OFF);
  const visible = filterNodes(nodes, filters);
```

Render the toolbar between the `Segmented` and the keys/list branch, shown ONLY when the current view has data to narrow:

```tsx
          {active !== "keys" && nodes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filters.query}
              onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              placeholder="Search by name or hostname…"
              aria-label="Search nodes"
              className="max-w-sm"
            />
            <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v as NodeFilters["status"] }))}>
              <SelectTrigger aria-label="Filter by status" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="online">Online</SelectItem>
                <SelectItem value="offline">Offline</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.access} onValueChange={(v) => setFilters((f) => ({ ...f, access: v as NodeFilters["access"] }))}>
              <SelectTrigger aria-label="Filter by access" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All access</SelectItem>
                <SelectItem value="yours">Yours</SelectItem>
                <SelectItem value="shared">Shared</SelectItem>
              </SelectContent>
            </Select>
          </div>
```

(The `Select` controlled-prop API is whatever `components/ui/select.tsx` actually exposes — mirror how `routes/index.tsx` wires its machine filter; adjust `onValueChange` to the component's real prop name before committing.)

Swap the render branch from `nodes` to `visible`, and add the zero-match state (distinct from `No nodes yet`):

```tsx
          {nodes.length > 0 && visible.length === 0 && (
            <EmptyState
              icon={Server}
              title="No nodes match"
              description="No node matches the current search and filters."
              actionLabel="Clear filters"
              onAction={() => setFilters(NODE_FILTERS_OFF)}
            />
          )}
          {visible.length > 0 &&
            (active === "list" ? <NodeTable nodes={visible} …same props… /> : <div className="space-y-3">{visible.map(…)}</div>)}
```

The existing `nodes.length === 0` enrollment EmptyState stays exactly as is — the two states answer different questions.

- [ ] **Step 4: Run the route tests green**

Run: `cd apps/server/web && bun test src/routes/__tests__/nodes-page-filters.test.tsx src/routes/__tests__/nodes-page-gate.test.tsx`
Expected: both files pass (the gate test proves the enrollment states survived).

- [ ] **Step 5: Full-web regression + commit**

```bash
cd apps/server/web && bun test src/components/nodes src/lib/__tests__ src/routes/__tests__
git add apps/server/web/src/routes/nodes.tsx apps/server/web/src/routes/__tests__/nodes-page-filters.test.tsx
git commit -m "feat(web): Nodes search + status/access filters with a zero-match state"
```

---

## Final gate (both parts)

```bash
cd apps/node/agent && bun test src/__tests__/daemon.test.ts src/__tests__/config-connection.test.ts
cd apps/server/web && bun test src
```

Expected: green. Then push the branch and open ONE PR covering the spec's two parts (independent commits make review separable): `git push -u origin fix/node-reregister-and-filters`.
