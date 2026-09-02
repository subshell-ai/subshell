# Node ↔ Profile Pairing at Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`[ ]`) syntax for tracking.

**Goal:** Make the new-session form pair Node and Profile bidirectionally (searchable pickers, incompatible options greyed with a reason, pin-as-suggestion), and move local harness toggling from the global Settings card to the `/nodes/local` detail page.

**Architecture:** Client-side compatibility matrix — `GET /api/nodes` already ships per-node harness states, so a pure frontend module computes profile×node fit; the backend only gains an additive `?node=any` on `GET /api/profiles` and honest `os`/`arch` for the `local` node view. The server's strict launch gate (409 `harness_disabled`) stays authoritative and unchanged.

**Tech Stack:** Elysia + TypeBox (backend), React 19 + Base UI 1.7.0 (`@base-ui/react`, ships `combobox`), TanStack Query/Router, `bun test` (backend + frontend, happy-dom), Playwright e2e (root `e2e/`).

**Spec:** `docs/superpowers/specs/2026-09-02-node-profile-pairing-design.md`

## Global Constraints

- Bun only (`bun install` / `bun run` / `bunx`); never npm/pnpm/npx.
- No dynamic imports anywhere (`await import(...)` breaks `bun build --compile`).
- All Elysia `t` schema properties carry a `description`.
- Public functions/exports carry JSDoc; match the file's existing comment density and voice (these files document *why*, with spec refs).
- e2e-pinned element ids must survive: `#picker-profile`, `#picker-node`, `#picker-working-dir`, `#picker-session-name` (dialog) and `#profile`, `#node`, `#working-dir`, `#name` (`/new`). Profile option label format `"{name} ({harnessId})"` is asserted by e2e — keep it byte-exact.
- Verification trio (run in Task 9 after every task's targeted tests): `bun run verify-types`, `bun run lint:check`, `bun run test` from the repo root; `bunx turbo build` is required because a backend route/schema changed.
- No new dependencies. No migrations.

---

### Task 1: Backend — `GET /api/profiles?node=any`

**Files:**
- Modify: `apps/backend/src/api/profiles.route.ts` (GET `/` handler, ~line 120-157)
- Test: `apps/backend/src/api/__tests__/profiles-route.test.ts` (append a new top-level `describe`)

**Interfaces:**
- Consumes: nothing new (`usableHarnessIds()` from `@/api/harness-utils.js` already imported).
- Produces: `GET /api/profiles?node=any` → the owner's profiles **without** local harness-usability filtering. Absent param = today's behavior byte-for-byte (mobile, profiles admin page, `list_profiles` MCP tool depend on it).

- [ ] **Step 1: Write the failing test** — append to `profiles-route.test.ts`:

```ts
/**
 * `?node=any` (spec 2026-09-02 node-profile-pairing §4a): the new-session
 * form pairs profiles against EVERY node client-side, so it must see profiles
 * whose harness is off here. The default listing keeps its local gate —
 * mobile and the profiles page rely on the hiding.
 */
describe("GET /api/profiles — node=any", () => {
  let userId: string;
  let cookie: string;
  let profileId: string;
  const email = `profany-${crypto.randomUUID()}@subshell.local`;
  const password = "profany-pass-1234";
  const profiles = new ProfilesRepository(db);
  const plugins = new HarnessPluginsRepository(db);

  beforeAll(async () => {
    // claude-code must read as INSTALLED so the row's absence under the
    // default listing can only come from the disabled state (same technique
    // as the file's first describe).
    process.env.CLAUDE_PATH = "/bin/true";
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
    profileId = (
      await profiles.create({
        id: crypto.randomUUID(),
        userId,
        harnessId: "claude-code",
        name: `any-${crypto.randomUUID()}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      })
    ).id;
    await plugins.setEnabled("claude-code", false);
  });

  afterAll(async () => {
    // Restore the lazy-default state so sibling suites see the plugin's own
    // enabledByDefault again.
    await plugins.setEnabled("claude-code", true);
    await deleteUserByEmailOrId(email);
  });

  it("hides the disabled-harness profile without the param", async () => {
    const res = await app.fetch(authedRequest("/api/profiles", cookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).not.toContain(profileId);
  });

  it("returns it when node=any is passed", async () => {
    const res = await app.fetch(authedRequest("/api/profiles?node=any", cookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(profileId);
  });
});
```

Also add to the file's import block: `import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";` and `afterAll` to the `bun:test` import (check whether it is already imported; it is used nowhere else in this file — the first describe uses `beforeAll` only).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && bun test src/api/__tests__/profiles-route.test.ts`
Expected: FAIL — "hides the disabled-harness profile without the param" passes incidentally (claude-code disabled hides it today), while **"returns it when node=any is passed" fails** (param ignored → row absent).

- [ ] **Step 3: Implement** — in `profiles.route.ts`, replace the GET `/` handler's filtering block:

```ts
      const rows = await repo.listByUser(user.id, query.harnessId);
      // A disabled or not-installed harness makes its profiles unavailable:
      // they are not listed anywhere (cards, new-session pickers), and
      // re-enabling/installing the harness brings them back — nothing here
      // is ever deleted.
      // The gate is LOCAL by nature (usableHarnessIds() probes this machine).
      // `?node=any` skips it entirely (spec 2026-09-02 node-profile-pairing
      // §4a): the launch picker pairs profiles against every node from the
      // per-node states on the node views, so it must see rows this host
      // would hide. Per-NODE server filtering is deliberately not offered —
      // the matrix needs the full list anyway.
      let visible = rows;
      if (query.node !== "any") {
        const usable = await usableHarnessIds();
        visible = rows.filter((p) => usable.has(p.harnessId));
      }
```

and extend the route's `query` schema (all properties carry `description`):

```ts
      query: t.Object({
        harnessId: t.Optional(t.String({ description: "Filter by harness id" })),
        node: t.Optional(
          t.String({
            description: 'Pass "any" to skip the local harness-usability filter (the launch picker pairs profiles per node client-side)',
          }),
        ),
      }),
```

Update the route `detail.description` to mention the `node` param.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/backend && bun test src/api/__tests__/profiles-route.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/api/profiles.route.ts apps/backend/src/api/__tests__/profiles-route.test.ts
git commit -m "feat(backend): GET /api/profiles?node=any — unfiltered listing for the pairing-aware launch picker"
```

---

### Task 2: Backend — `local` node view reports real os/arch

**Files:**
- Modify: `apps/backend/src/api/nodes/node-view.ts` (`nodeViewBase`, ~line 150-169)
- Test: `apps/backend/src/api/nodes/__tests__/nodes-crud-route.test.ts` (append an `it` to the describe that lists nodes; if none fetches `GET /api/nodes` with a cookie, append a new `describe` reusing that file's existing cookie fixture and `authedRequest` import)

**Interfaces:**
- Consumes: `NodeTable` rows (seeded `local` has `os = null`, `arch = null` — it never sends `ready`).
- Produces: `NodeView.os` / `NodeView.arch` for `kind === "local"` are the server's own `process.platform` / `process.arch` (canonical `linux`/`darwin` × `x64`/`arm64`, the spellings the agent uses). The frontend's platform label (Task 3) reads these; no DB change.

- [ ] **Step 1: Write the failing test** — append (adapt the describe/fixture names to what the file already defines):

```ts
  /**
   * The `local` row is seeded with null os/arch (it never sends `ready`), but
   * the control-plane host IS this process — the launch picker's platform
   * suffix (spec 2026-09-02 §4b) would otherwise read "Local · null/null".
   * The DB row stays null; the VIEW is honest.
   */
  it("renders local's os/arch from the server's own platform", async () => {
    await ensureLocalNode();
    const res = await app.fetch(authedRequest("/api/nodes", cookie));
    expect(res.status).toBe(200);
    const { nodes } = (await res.json()) as { nodes: { id: string; os: string | null; arch: string | null }[] };
    const local = nodes.find((n) => n.id === "local");
    expect(local?.os).toBe(process.platform);
    expect(local?.arch).toBe(process.arch);
  });
```

Imports to add if missing in that file: `ensureLocalNode` from `@/services/nodes/seed-local.js`, `authedRequest` from `"../../__tests__/helpers/auth-tables.js"`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && bun test src/api/nodes/__tests__/nodes-crud-route.test.ts`
Expected: FAIL — `local.os` is `null`.

- [ ] **Step 3: Implement** — in `node-view.ts`, change `nodeViewBase`'s two fields (keep the existing JSDoc on the function; extend it):

```ts
    // `local` never sends `ready`, so its row keeps null os/arch — but the
    // control-plane host IS this process; report it from the view (spec
    // 2026-09-02 §4b) so launch-picker labels never read "null/null".
    os: row.kind === "local" ? (row.os ?? process.platform) : row.os,
    arch: row.kind === "local" ? (row.arch ?? process.arch) : row.arch,
```

- [ ] **Step 4: Run to verify pass** — same command as Step 2, expect all green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/api/nodes/node-view.ts apps/backend/src/api/nodes/__tests__/nodes-crud-route.test.ts
git commit -m "feat(backend): local node view reports the server's own os/arch"
```

---

### Task 3: Frontend — platform suffix in `nodeOptionLabel`

**Files:**
- Modify: `apps/frontend/src/lib/node-label.ts`
- Test: Create `apps/frontend/src/lib/__tests__/node-label.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `nodeOptionLabel(node: Pick<Node, "kind" | "status" | "name" | "os" | "arch">, localLabel: string): string` — the ONLY change is the widened `Pick` (all current callers — `new-session-form.tsx`, `profile-fields.tsx` — already pass full `Node` rows) and the platform segment. Format: `{label} · {os}/{arch}`, with ` — offline` kept as the LAST segment for offline agents; platform omitted when `os` or `arch` is null (young agent).

- [ ] **Step 1: Write the failing test** — create `apps/frontend/src/lib/__tests__/node-label.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { nodeOptionLabel } from "@/lib/node-label";
import type { Node } from "@/types/node";

type Row = Pick<Node, "kind" | "status" | "name" | "os" | "arch">;

describe("nodeOptionLabel", () => {
  it("appends the platform for local under the caller's friendly name", () => {
    const local: Row = { kind: "local", status: "online", name: "host", os: "linux", arch: "x64" };
    expect(nodeOptionLabel(local, "Local")).toBe("Local · linux/x64");
    expect(nodeOptionLabel(local, "Local (this host)")).toBe("Local (this host) · linux/x64");
  });

  it("appends the platform for an online agent under its own name", () => {
    const n: Row = { kind: "agent", status: "online", name: "mac-mini", os: "darwin", arch: "arm64" };
    expect(nodeOptionLabel(n, "Local")).toBe("mac-mini · darwin/arm64");
  });

  it("keeps ' — offline' as the last segment, after the platform", () => {
    const n: Row = { kind: "agent", status: "offline", name: "old", os: "linux", arch: "x64" };
    expect(nodeOptionLabel(n, "Local")).toBe("old · linux/x64 — offline");
  });

  it("omits the platform when a young agent has not reported os/arch", () => {
    const online: Row = { kind: "agent", status: "online", name: "new", os: null, arch: null };
    const offline: Row = { kind: "agent", status: "offline", name: "new", os: null, arch: null };
    expect(nodeOptionLabel(online, "Local")).toBe("new");
    expect(nodeOptionLabel(offline, "Local")).toBe("new — offline");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test src/lib/__tests__/node-label.test.ts`
Expected: FAIL (suffixes missing — current impl ignores os/arch).

- [ ] **Step 3: Implement** — replace the body + signature in `node-label.ts`, keeping the doc comment current (add the platform wording to it):

```ts
export function nodeOptionLabel(
  node: Pick<Node, "kind" | "status" | "name" | "os" | "arch">,
  localLabel: string,
): string {
  const base = node.kind === "local" ? localLabel : node.name;
  // "mac-mini · darwin/arm64" — only when the node actually reported both
  // (a young agent's ready may still be in flight).
  const platform = node.os !== null && node.arch !== null ? ` · ${node.os}/${node.arch}` : "";
  const offline = node.kind === "agent" && node.status === "offline" ? " — offline" : "";
  return `${base}${platform}${offline}`;
}
```

- [ ] **Step 4: Run to verify pass** — same command; then `cd apps/frontend && bun test src/components/__tests__/new-session-form.test.tsx` to see what downstream text assertions now expect the suffix (fixes land in Task 7 — do NOT touch that file here; only this task's test must pass, and the form test may fail ONLY on the offline-label string in the pinned-anchor tests if a fixture carries os/arch; the current fixtures use null os/arch, so it should stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/node-label.ts apps/frontend/src/lib/__tests__/node-label.test.ts
git commit -m "feat(frontend): node picker labels carry the platform (os/arch)"
```

---

### Task 4: Frontend — pure compatibility module `session-compat.ts`

**Files:**
- Create: `apps/frontend/src/lib/session-compat.ts`
- Test: Create `apps/frontend/src/lib/__tests__/session-compat.test.ts`

**Interfaces:**
- Consumes: `Node`/`NodeHarness` (`@/types/node`), `ProfileRow` (`@/types/profile`), `nodeOptionLabel` (Task 3), and the `ComboboxOption` type — **Task 5 defines it in `@/components/ui/combobox`**; if you run Task 4 first, the import will not resolve yet, so **Task 5 must be done before Task 4 compiles**. (Order of implementation: Task 5 then Task 4; the numbers keep dependency sense only for review.)
- Produces (exact names, used by Task 7):

```ts
export type LaunchProfile = Pick<ProfileRow, "id" | "name" | "harnessId" | "nodeId">;
export type IncompatReason = "offline" | "not-installed" | "disabled";
export function harnessFitsNode(node: Node, harnessId: string): IncompatReason | null;
export function buildProfileOptions(profiles: readonly LaunchProfile[], node: Node | null): ComboboxOption[];
export function buildNodeOptions(
  nodes: readonly Node[],
  profile: LaunchProfile | null,
  suggestionId: string | null,
): ComboboxOption[];
```

- [ ] **Step 1: Write the failing test** — create `session-compat.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildNodeOptions, buildProfileOptions, harnessFitsNode } from "@/lib/session-compat";
import type { Node } from "@/types/node";

function node(overrides: Partial<Node>): Node {
  return {
    id: "n", name: "node", kind: "agent", os: null, arch: null, hostname: null,
    status: "online", lastSeenAt: null, agentVersion: null, protocolVersion: null,
    access: "owner", canManage: true, capabilities: [], harnesses: [], inventoryStale: false,
    ...overrides,
  };
}
const PI = { harnessId: "pi", enabled: true, installed: true };
const CLAUDE_ON = { harnessId: "claude-code", enabled: true, installed: true };
const CLAUDE_OFF = { harnessId: "claude-code", enabled: false, installed: true };
const PROF = { id: "p1", name: "Default", harnessId: "claude-code", nodeId: null };

describe("harnessFitsNode", () => {
  it("fits when the entry is enabled and installed", () => {
    expect(harnessFitsNode(node({ harnesses: [CLAUDE_ON] }), "claude-code")).toBeNull();
  });
  it("an absent entry is 'not-installed' — the lazy default never grants a launch", () => {
    expect(harnessFitsNode(node({ harnesses: [] }), "claude-code")).toBe("not-installed");
  });
  it("an installed-but-disabled entry is 'disabled'", () => {
    expect(harnessFitsNode(node({ harnesses: [CLAUDE_OFF] }), "claude-code")).toBe("disabled");
  });
  it("an offline agent is 'offline' regardless of the entry", () => {
    const n = node({ status: "offline", harnesses: [CLAUDE_ON] });
    expect(harnessFitsNode(n, "claude-code")).toBe("offline");
  });
  it("local is never 'offline' (status is a projection it does not gate on)", () => {
    const n = node({ id: "local", kind: "local", status: "offline", harnesses: [CLAUDE_ON] });
    expect(harnessFitsNode(n, "claude-code")).toBeNull();
  });
});

describe("buildProfileOptions", () => {
  it("without a node, everything is selectable and labels keep the e2e-pinned format", () => {
    const [opt] = buildProfileOptions([PROF], null);
    expect(opt).toEqual({ value: "p1", label: "Default (claude-code)", disabled: false });
  });
  it("greys an incompatible profile with the node-appropriate reason", () => {
    const n = node({ id: "mac", name: "mac", harnesses: [CLAUDE_OFF] });
    expect(buildProfileOptions([PROF], n)[0]).toEqual({
      value: "p1", label: "Default (claude-code)", disabled: true, reason: "disabled on this node",
    });
  });
  it("a stale inventory makes 'not installed' honest as last-known", () => {
    const n = node({ harnesses: [], inventoryStale: true });
    expect(buildProfileOptions([PROF], n)[0]?.reason).toBe("not installed here (inventory may be outdated)");
  });
  it("an offline node reasons 'node offline'", () => {
    const n = node({ status: "offline", harnesses: [CLAUDE_ON] });
    expect(buildProfileOptions([PROF], n)[0]?.reason).toBe("node offline");
  });
});

describe("buildNodeOptions", () => {
  const LOCAL = node({ id: "local", name: "host", kind: "local", access: "view", harnesses: [CLAUDE_ON], os: "linux", arch: "x64" });
  const AGENT = node({ id: "a1", name: "mac-mini", harnesses: [] });
  it("without a profile, only offline agents are disabled and labels carry the platform", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], null, null);
    expect(opts[0]).toEqual({ value: "local", label: "Local · linux/x64", disabled: false });
    expect(opts[1]).toEqual({ value: "a1", label: "mac-mini", disabled: false });
  });
  it("a selected profile greys nodes lacking its harness", () => {
    const [localOpt, agentOpt] = buildNodeOptions([LOCAL, AGENT], PROF, null);
    expect(localOpt?.disabled).toBe(false);
    expect(agentOpt).toEqual({ value: "a1", label: "mac-mini", disabled: true, reason: "no claude-code here" });
  });
  it("the suggested (pinned) node is suffixed — and only while a profile is in play", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], PROF, "local");
    expect(opts[0]?.label).toBe("Local · linux/x64 · default for this profile");
  });
  it("an offline agent stays disabled with the offline label and no reason text", () => {
    const opts = buildNodeOptions([node({ id: "a2", name: "old", status: "offline", harnesses: [CLAUDE_ON] })], PROF, null);
    expect(opts[0]).toEqual({ value: "a2", label: "old — offline", disabled: true });
  });
});
```

Note: `ComboboxOption.reason` must be absent (not `undefined`-present) on enabled options for the `toEqual` shapes above — build it conditionally.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test src/lib/__tests__/session-compat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `apps/frontend/src/lib/session-compat.ts`:

```ts
import type { ComboboxOption } from "@/components/ui/combobox";
import { nodeOptionLabel } from "@/lib/node-label";
import type { Node } from "@/types/node";
import type { ProfileRow } from "@/types/profile";

/**
 * The launch picker's compatibility matrix (spec 2026-09-02 §2), pure so the
 * grey-with-reason grid is testable without opening a Base UI dropdown.
 * This is the INFORMATIONAL mirror of the server's `harnessUsable` — the
 * launch gate stays authoritative server-side (409 harness_disabled covers
 * every race, including a stale agent inventory).
 */

/** The profile fields the launch pickers read. */
export type LaunchProfile = Pick<ProfileRow, "id" | "name" | "harnessId" | "nodeId">;

/** Why a harness cannot launch on a node right now. */
export type IncompatReason = "offline" | "not-installed" | "disabled";

/**
 * Whether `harnessId` could launch on `node`, informational-grade:
 * offline agent beats entry state; absent entry counts as not-installed
 * (the lazy `enabledByDefault` rule never grants a launch the inventory
 * has not confirmed).
 * @returns null when usable, else the reason code
 */
export function harnessFitsNode(node: Node, harnessId: string): IncompatReason | null {
  if (node.kind === "agent" && node.status === "offline") return "offline";
  const entry = node.harnesses.find((h) => h.harnessId === harnessId);
  if (!entry || !entry.installed) return "not-installed";
  if (!entry.enabled) return "disabled";
  return null;
}

/** The muted reason text on a greyed profile row (node must be non-null). */
function profileReasonText(node: Node, reason: IncompatReason): string {
  if (reason === "offline") return "node offline";
  if (reason === "disabled") return "disabled on this node";
  return node.inventoryStale
    ? "not installed here (inventory may be outdated)"
    : "not installed on this node";
}

/**
 * Profile options paired against the chosen node (null = no pick yet:
 * nothing greys). Labels keep the e2e-pinned `name (harnessId)` format.
 */
export function buildProfileOptions(profiles: readonly LaunchProfile[], node: Node | null): ComboboxOption[] {
  return profiles.map((p) => {
    const fit = node === null ? null : harnessFitsNode(node, p.harnessId);
    const opt: ComboboxOption = { value: p.id, label: `${p.name} (${p.harnessId})`, disabled: fit !== null };
    if (fit !== null && node !== null) opt.reason = profileReasonText(node, fit);
    return opt;
  });
}

/**
 * Node options paired against the chosen profile (null = no pick yet:
 * only offline agents grey). `suggestionId` — the pinned node AFTER the
 * caller has validated the suggestion (selectable + compatible, §1) — gets
 * the " · default for this profile" suffix.
 */
export function buildNodeOptions(
  nodes: readonly Node[],
  profile: LaunchProfile | null,
  suggestionId: string | null,
): ComboboxOption[] {
  return nodes.map((n) => {
    const offline = n.kind === "agent" && n.status === "offline";
    const fit = !offline && profile !== null ? harnessFitsNode(n, profile.harnessId) : null;
    const label =
      nodeOptionLabel(n, "Local") + (n.id === suggestionId ? " · default for this profile" : "");
    const opt: ComboboxOption = { value: n.id, label, disabled: offline || fit !== null };
    if (fit !== null && profile !== null) opt.reason = `no ${profile.harnessId} here`;
    return opt;
  });
}
```

- [ ] **Step 4: Run to verify pass** — same command as Step 2.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/session-compat.ts apps/frontend/src/lib/__tests__/session-compat.test.ts
git commit -m "feat(frontend): session-compat — pure profile×node matrix for the launch pickers"
```

---

### Task 5: Frontend — `SearchableSelect` combobox primitive

**Files:**
- Create: `apps/frontend/src/components/ui/combobox.tsx`
- Test: Create `apps/frontend/src/components/__tests__/combobox.test.tsx`

**Interfaces:**
- Consumes: `@base-ui/react/combobox` (v1.7.0 — parts: Root/Input/Portal/Positioner/Popup/List/Item/Empty; Root filters `items` internally, `List` takes a children function `(item, index)`, `{value,label}` item objects stringify automatically).
- Produces (Task 4 imports `ComboboxOption`; Task 7 renders `SearchableSelect`):

```ts
export interface ComboboxOption {
  /** Stable option id — the picker's value */
  value: string;
  /** Text shown in the list and, when selected, in the input */
  label: string;
  /** Unselectable row (incompatible pair) — `reason` explains why */
  disabled?: boolean;
  /** Muted trailing copy on a disabled row */
  reason?: string;
}
export interface SearchableSelectProps { id, value, onValueChange, placeholder, options, emptyText?, className? }
export function SearchableSelect(props: SearchableSelectProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test** — create `combobox.test.tsx` (closed-state only; the popup interaction is e2e's job — Base UI popups are not exercised under happy-dom anywhere in this suite):

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SearchableSelect, type ComboboxOption } from "@/components/ui/combobox";

const OPTIONS: ComboboxOption[] = [
  { value: "a", label: "Alpha · linux/x64" },
  { value: "b", label: "Beta · darwin/arm64", disabled: true, reason: "no pi here" },
];

afterEach(cleanup);

describe("SearchableSelect", () => {
  it("renders a searchable combobox carrying the caller's id and placeholder", () => {
    render(
      <SearchableSelect id="picker-node" value="" onValueChange={() => {}} placeholder="Choose a node" options={OPTIONS} />,
    );
    const input = screen.getByPlaceholderText("Choose a node");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("id")).toBe("picker-node");
  });

  it("shows the selected option's label as the input value", () => {
    render(
      <SearchableSelect id="x" value="a" onValueChange={() => {}} placeholder="p" options={OPTIONS} />,
    );
    expect((screen.getByPlaceholderText("p") as HTMLInputElement).value).toBe("Alpha · linux/x64");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/combobox.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `apps/frontend/src/components/ui/combobox.tsx`, styled from `select.tsx` (same trigger/popup/item classes; the Input plays both trigger and filter field):

```tsx
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * Searchable single-select on Base UI Combobox — the launch pickers'
 * primitive (spec 2026-09-02 §1). Unlike `select.tsx` the closed state is a
 * real <input> (type-to-filter), so callers pass their e2e-pinned id there.
 * Options are `{ value, label, disabled?, reason? }`; the Root filters by
 * label (case-insensitive contains), disabled rows stay listed with their
 * muted reason — greying out explains rather than hides.
 */
export interface ComboboxOption {
  /** Stable option id — the picker's value */
  value: string;
  /** Text shown in the list and, when selected, in the input */
  label: string;
  /** Unselectable row (incompatible pair) — `reason` explains why */
  disabled?: boolean;
  /** Muted trailing copy on a disabled row */
  reason?: string;
}

export interface SearchableSelectProps {
  /** Id of the rendered input — labels (htmlFor) and e2e anchor on it */
  id: string;
  /** Selected option id; "" renders the placeholder */
  value: string;
  /** Fired with the new option id ("" never — disabled rows are inert) */
  onValueChange: (value: string) => void;
  /** Input placeholder, also the unselected closed state */
  placeholder: string;
  options: readonly ComboboxOption[];
  /** Shown when the typed query matches nothing */
  emptyText?: string;
  /** Extra classes on the input (the visible control) */
  className?: string;
}

export function SearchableSelect({
  id,
  value,
  onValueChange,
  placeholder,
  options,
  emptyText = "No matches",
  className,
}: SearchableSelectProps): JSX.Element {
  // Item values are the option objects; the external contract stays the
  // plain id string. Object identity would break under rebuilt arrays, so
  // equality compares ids.
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <ComboboxPrimitive.Root
      items={options}
      value={selected}
      isItemEqualToValue={(a: ComboboxOption, b: ComboboxOption) => a.value === b.value}
      onValueChange={(opt: ComboboxOption | null) => onValueChange(opt?.value ?? "")}
      filter={(item: ComboboxOption, query: string) => item.label.toLowerCase().includes(query.toLowerCase())}
    >
      <ComboboxPrimitive.Input
        id={id}
        placeholder={placeholder}
        className={cn(
          "flex h-9 w-full items-center whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      />
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner align="start" sideOffset={4} className="isolate z-50">
          <ComboboxPrimitive.Popup
        data-slot="combobox-content"
            className="min-w-[var(--anchor-width)] max-h-96 overflow-hidden rounded-md border bg-popover text-popover-foreground opacity-100 shadow-md transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <ComboboxPrimitive.List className="p-1">
              {(option: ComboboxOption) => (
                <ComboboxPrimitive.Item
                  key={option.value}
                  value={option}
                  disabled={option.disabled ?? false}
                  className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-2 pl-2 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="truncate">{option.label}</span>
                  {option.reason ? (
                    <span className="text-muted-foreground ml-auto max-w-[45%] truncate pl-3 text-xs">{option.reason}</span>
                  ) : null}
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
            <ComboboxPrimitive.Empty className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</ComboboxPrimitive.Empty>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
```

If `verify-types` rejects an explicit callback-parameter annotation against Base UI's generics, drop the annotation and let inference type it — do not cast.

- [ ] **Step 4: Run to verify pass** — same command as Step 2; then `cd apps/frontend && bun run verify-types` (the d.ts contracts are the real gate here).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/ui/combobox.tsx apps/frontend/src/components/__tests__/combobox.test.tsx
git commit -m "feat(frontend): SearchableSelect — Base UI combobox primitive with disabled-reason rows"
```

---

### Task 6: Frontend — hook + wire changes

**Files:**
- Modify: `apps/frontend/src/hooks/use-profiles.ts`
- Modify: `apps/frontend/src/hooks/use-create-session.ts` (`toSessionCreateBody` + its JSDoc)
- Test: `apps/frontend/src/lib/__tests__/create-session.test.ts`

**Interfaces:**
- Consumes: `GET /api/profiles?node=any` (Task 1).
- Produces: `useProfiles(opts?: { node?: "any" })` (default arg keeps every existing call site compiling; the `["profiles"]` prefix invalidation still refreshes the `node=any` cache — TanStack matches by prefix); `toSessionCreateBody` now ALWAYS sends `nodeId` when one is set, including `"local"`.

- [ ] **Step 1: Update the failing wire test** — in `create-session.test.ts`, replace the last two `it`s ("omits nodeId for 'local'…" and adjust "omits nodeId entirely…" to keep it) with:

```ts
  it("sends 'local' explicitly — the visible pick is the launch target (spec 2026-09-02 §3)", () => {
    const body = toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "n", nodeId: "local" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      profileId: "p1",
      workingDir: "/tmp/x",
      name: "n",
      nodeId: "local",
    });
  });

  it("omits nodeId only for an absent/unmade pick", () => {
    // An unmade selection blocks submit upstream (canSubmit), never leaks "".
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "" }).nodeId).toBeUndefined();
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" }).nodeId).toBeUndefined();
  });
```

(Delete the old "omits nodeId for 'local' and for an absent/unmade pick" test; the legacy-body test above it still passes untouched.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test src/lib/__tests__/create-session.test.ts`
Expected: FAIL on the `'local'`-explicit test.

- [ ] **Step 3: Implement both hooks**

`use-create-session.ts` — the body builder becomes:

```ts
    nodeId: nodeId && nodeId !== "" ? nodeId : undefined,
```

and its JSDoc paragraph about omission-as-the-resolve-path is replaced with:

```
 * Remote launch is real (spec 2026-08-31 §6.6): the picked node id is posted
 * as-is — INCLUDING "local" (spec 2026-09-02 §3: the visible pick always
 * wins over a profile pin; the server precedence puts body nodeId first).
 * An absent/"" pick still sends no nodeId — legacy and mobile callers keep
 * the server's resolve ladder (pin → local → lone-online auto-pick).
```

`use-profiles.ts`:

```ts
/**
 * Shared query for the authenticated user's profiles. Every page that lists
 * profiles reads through this hook so a single `PROFILES_QUERY_KEY`
 * invalidation refreshes them all (prefix match covers the `node=any`
 * variant's key too).
 * @param opts.node - `"any"` lists profiles regardless of LOCAL harness
 *   state (the launch picker pairs them against every node from the node
 *   views; spec 2026-09-02 §4a). Default: the local filter.
 */
export function useProfiles(opts: { node?: "any" } = {}) {
  return useQuery({
    queryKey: opts.node === undefined ? PROFILES_QUERY_KEY : ([...PROFILES_QUERY_KEY, "node", opts.node] as const),
    queryFn: () => apiFetch<ProfileRow[]>(opts.node === undefined ? "/api/profiles" : `/api/profiles?node=${opts.node}`),
  });
}
```

- [ ] **Step 4: Run to verify pass** — `cd apps/frontend && bun test src/lib/__tests__/create-session.test.ts && bun run verify-types`.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/hooks/use-profiles.ts apps/frontend/src/hooks/use-create-session.ts apps/frontend/src/lib/__tests__/create-session.test.ts
git commit -m "feat(frontend): always-forward nodeId; useProfiles({node:'any'}) for pairing"
```

---

### Task 7: Frontend — rebuild `NewSessionForm` (order, pairing, suggestion, hints)

**Files:**
- Modify: `apps/frontend/src/components/session-picker/new-session-form.tsx` (full rewrite below)
- Test: `apps/frontend/src/components/__tests__/new-session-form.test.tsx` (full rewrite below)

**Interfaces:**
- Consumes: `SearchableSelect`/`ComboboxOption` (Task 5), `harnessFitsNode`/`buildNodeOptions`/`buildProfileOptions`/`LaunchProfile` (Task 4), `useProfiles({ node: "any" })` (Task 6), `nodeOptionLabel` with platform (Task 3).
- Produces: same exports as before MINUS `anchorDecision`, PLUS `suggestDecision` (same shape/semantics as `anchorDecision` — the gating moved to the caller: `suggestion` is only non-null when earned). `NewSessionFormValue`/`NewSessionFormIds`/`emptyNewSessionForm`/`canSubmit`/`pickNodeDefault`/`DIALOG_IDS` unchanged in name and shape. `new.tsx` and `add-session-dialog.tsx` need NO changes (same props/ids).

- [ ] **Step 1: Replace the test file** — full contents of `new-session-form.test.tsx` (assertions moved off popup text nodes onto form state and placeholder/hint DOM, because the closed state is now an `<input>`; pairing detail is pinned in Task 4's matrix tests; the picker itself is e2e-pinned in Task 9):

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  canSubmit,
  emptyNewSessionForm,
  NewSessionForm,
  type NewSessionFormValue,
  pickNodeDefault,
  suggestDecision,
} from "@/components/session-picker/new-session-form";
import { toSessionCreateBody } from "@/hooks/use-create-session";
import type { Node } from "@/types/node";

/**
 * The paired node×profile launch form (spec 2026-09-02 §1): searchable
 * pickers, incompatible options greyed with a reason (the grey grid itself
 * is pinned in lib/__tests__/session-compat.test.ts), pin-as-suggestion,
 * and the honest empty-state hints. Assertions run on form state and the
 * DOM around the inputs — the closed state is now an <input> whose value is
 * not a text node; the picker's real behavior is e2e-pinned (12-nodes).
 */
function node(overrides: Partial<Node>): Node {
  return {
    id: "n", name: "node", kind: "agent", os: null, arch: null, hostname: null,
    status: "online", lastSeenAt: null, agentVersion: null, protocolVersion: null,
    access: "owner", canManage: true, capabilities: [], harnesses: [], inventoryStale: false,
    ...overrides,
  };
}

const CLAUDE = { harnessId: "claude-code", enabled: true, installed: true };
const LOCAL = node({ id: "local", name: "this host", kind: "local", access: "view", harnesses: [CLAUDE] });
const AGENT_ONLINE = node({ id: "a1", name: "mac mini", status: "online", harnesses: [CLAUDE] });
const AGENT_INCOMPAT = node({ id: "a3", name: "studio", harnesses: [] });
const AGENT_OFFLINE = node({ id: "a2", name: "old laptop", status: "offline", harnesses: [CLAUDE] });

/** One profile row; only the fields the form reads. */
function profile(p: { nodeId?: string | null; name?: string; id?: string }) {
  return {
    id: p.id ?? "p1", harnessId: "claude-code", name: p.name ?? "prof",
    description: null, envJson: null, flagsJson: null, settingsJson: null,
    configIsolation: 0, restartOnExit: 0, isDefault: 0, nodeId: p.nodeId ?? null,
  };
}

function mockFetch(nodes: Node[], profiles: unknown[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/profiles") return Promise.resolve(new Response(JSON.stringify(profiles)));
    if (path === "/api/files/recent") return Promise.resolve(new Response(JSON.stringify({ paths: [] })));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** The form is fully caller-controlled; this harness owns the state it would. */
function renderForm(initial: NewSessionFormValue = emptyNewSessionForm()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: NewSessionFormValue = initial;
  function Harness() {
    const [value, setValue] = useState<NewSessionFormValue>(initial);
    latest = value;
    return <NewSessionForm value={value} onChange={setValue} />;
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { latest: () => latest };
}

afterEach(cleanup);

describe("pickNodeDefault", () => {
  it("keeps a valid pick and the local default while local is present", () => {
    const nodes = [LOCAL, AGENT_ONLINE, AGENT_OFFLINE];
    expect(pickNodeDefault(nodes, "local")).toBe("local");
    expect(pickNodeDefault(nodes, "a1")).toBe("a1");
  });
  it("falls to the sole selectable option when local vanished", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_OFFLINE], "local")).toBe("a1");
  });
  it("forces an explicit choice when local vanished and several nodes remain", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_INCOMPAT], "local")).toBe("");
  });
});

/**
 * Pin-as-suggestion (spec 2026-09-02 §1): the caller only hands in an EARNED
 * suggestion (row visible, selectable, compatible) — the decision function
 * keeps the old anchor's bookkeeping: explicit picks outrank, release falls
 * back only while the suggestion still owns the pick.
 */
describe("suggestDecision", () => {
  it("holds the suggested node while the user stays silent", () => {
    expect(suggestDecision({ suggestion: AGENT_ONLINE, explicit: false, current: "local", anchoredTo: null })).toEqual({
      nodeId: "a1", anchoredTo: "a1",
    });
  });
  it("an explicit pick — the suggested node included — outranks the suggestion", () => {
    const d = suggestDecision({ suggestion: AGENT_ONLINE, explicit: true, current: "local", anchoredTo: "a1" });
    expect(d.nodeId).toBe("local");
  });
  it("releases an unearned suggestion back to local (only while it still owns the pick)", () => {
    expect(suggestDecision({ suggestion: null, explicit: false, current: "a1", anchoredTo: "a1" }).nodeId).toBe("local");
    expect(suggestDecision({ suggestion: null, explicit: true, current: "a1", anchoredTo: "a1" }).nodeId).toBe("a1");
    expect(suggestDecision({ suggestion: null, explicit: false, current: "local", anchoredTo: "a1" }).nodeId).toBe("local");
  });
});

describe("NewSessionForm pairing + defaults", () => {
  it("defaults to Local, is submittable, and the Node field comes first", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE, AGENT_OFFLINE], [profile({})]);
    try {
      const { latest } = renderForm();
      expect(screen.getByPlaceholderText("Choose a node")).toBeDefined();
      await waitFor(() => expect(latest().nodeId).toBe("local"));
      const labels = Array.from(document.querySelectorAll("label"), (l) => l.textContent);
      expect(labels.indexOf("Node")).toBeLessThan(labels.indexOf("Profile"));
      expect(canSubmit({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" })).toBe(true);
    } finally { restore(); }
  });

  it("drops to an empty pick (no submit) when local is gone and a choice is due", async () => {
    const restore = mockFetch([AGENT_ONLINE, AGENT_INCOMPAT], [profile({})]);
    try {
      const { latest } = renderForm();
      await waitFor(() => expect(latest().nodeId).toBe("a1")); // sole SELECTABLE node auto-picks (unchanged rule)
      expect(canSubmit({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" })).toBe(false);
    } finally { restore(); }
  });

  it("a pinned profile suggests its node and forwards it on the wire", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE], [profile({ nodeId: "a1" })]);
    try {
      const { latest } = renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      expect(toSessionCreateBody(latest()).nodeId).toBe("a1");
    } finally { restore(); }
  });

  it("a suggestion is never earned by an offline node — Local stands", async () => {
    const restore = mockFetch([LOCAL, AGENT_OFFLINE], [profile({ nodeId: "a2" })]);
    try {
      const { latest } = renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      await new Promise((r) => setTimeout(r, 50));
      expect(latest().nodeId).toBe("local");
      expect(toSessionCreateBody(latest()).nodeId).toBe("local");
    } finally { restore(); }
  });

  it("a suggestion is never earned by an incompatible node — Local stands", async () => {
    const restore = mockFetch([LOCAL, AGENT_INCOMPAT], [profile({ nodeId: "a3" })]);
    try {
      const { latest } = renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      await new Promise((r) => setTimeout(r, 50));
      expect(latest().nodeId).toBe("local");
    } finally { restore(); }
  });

  it("no compatible profile on the picked node → the honest hint, with a link", async () => {
    const restore = mockFetch([node({ id: "a1", name: "bare", harnesses: [] })], [profile({})]);
    try {
      renderForm({ profileId: "", workingDir: "/tmp/x", name: "", nodeId: "a1" });
      const hint = await screen.findByText(/No profiles run on bare/);
      expect(hint.querySelector("a[href*='/nodes/']")).not.toBeNull();
    } finally { restore(); }
  });

  it("profile usable on no visible node → the mirror hint", async () => {
    const restore = mockFetch([AGENT_INCOMPAT], [profile({ id: "p1", name: "orphan" })]);
    try {
      renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "a3" });
      expect(await screen.findByText(/No available node runs claude-code/)).toBeDefined();
    } finally { restore(); }
  });
});

describe("optional session name input", () => {
  it("caps the draft at the backend's 120-char rule", () => {
    const restore = mockFetch([LOCAL]);
    try {
      renderForm();
      const input = screen.getByLabelText("Session name (optional)") as HTMLInputElement;
      expect(input.maxLength).toBe(120);
    } finally { restore(); }
  });
});
```

Notes for the implementer: the second test asserts the UNCHANGED `pickNodeDefault` sole-selectable auto-pick (studio is online, so it IS selectable — the old "several remain → ''" case is covered purely in the `pickNodeDefault` describe). The hint tests rely on TanStack Router's `Link` rendering a plain `<a href>` under happy-dom (as everywhere else in these tests).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/new-session-form.test.tsx`
Expected: FAIL (no `suggestDecision` export, no hints, old order).

- [ ] **Step 3: Rewrite the component** — full contents of `new-session-form.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { SearchableSelect } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkingDirField } from "@/components/working-dir-field";
import { useNodes } from "@/hooks/use-nodes";
import { useProfiles } from "@/hooks/use-profiles";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { buildNodeOptions, buildProfileOptions, harnessFitsNode, type LaunchProfile } from "@/lib/session-compat";
import type { Node } from "@/types/node";

/** The fields needed to launch a new session. */
export interface NewSessionFormValue {
  profileId: string;
  workingDir: string;
  name: string;
  /**
   * Launch node — defaults to "local" (the control-plane host). "" means no
   * valid choice is made yet (local vanished from the list with several other
   * nodes around), which blocks submit until the user picks one. A pinned
   * profile SUGGESTS its node (see `suggestDecision`) — a suggestion the
   * user can always override, and whose id now rides the wire when held.
   */
  nodeId: string;
  /**
   * True once the user picks a node through the picker; cleared on every
   * profile change. Distinguishes a user's own pick from a suggestion.
   */
  nodeExplicit?: boolean;
}

export function emptyNewSessionForm(): NewSessionFormValue {
  return { profileId: "", workingDir: "", name: "", nodeId: "local" };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSessionFormValue): boolean {
  return Boolean(value.profileId) && Boolean(value.workingDir.trim()) && Boolean(value.nodeId);
}

/**
 * Whether a node is pickable right now: an OFFLINE agent is shown disabled —
 * launching there 409s `NODE_OFFLINE`, and offering a target we know is down
 * would only invite a confusing failure. (The pick list can always be stale;
 * the 409 path covers the race.) Harness compatibility greys separately, via
 * `buildNodeOptions`. Mirrored in mobile `src/lib/node-anchor.ts`.
 */
function isSelectable(n: Node): boolean {
  return n.kind === "local" || n.status === "online";
}

/**
 * The node the picker should hold once the list has loaded: keep the current
 * pick while it stays selectable; else fall to "local" only if exactly one
 * option remains (auto-pick — not a decision worth forcing); else "" — an
 * explicit choice is due (submit stays blocked until it happens).
 * Pure so the fallback matrix is testable without opening a dropdown.
 * Mirrored in mobile `src/lib/node-anchor.ts`.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Pin-as-suggestion (spec 2026-09-02 §1, replacing the anchor-with-override
 * semantics): while the user has NOT picked a node since the last profile
 * change, an EARNED suggestion owns the pick. The caller earns it — the row
 * is visible, selectable, and actually compatible — so a suggestion never
 * parks the form on an offline or incompatible node (the old anchor kept an
 * offline pin selected; the override era ended with the hint that carried
 * it). An unearned suggestion releases back to "local" only while it still
 * owns the pick; anything the user touched stays touched. Pure, like
 * `pickNodeDefault`. Mirrored in mobile `src/lib/node-anchor.ts` (minus the
 * earned-gating — mobile has no pairing).
 */
export function suggestDecision(p: {
  /** The earned suggestion row (pinned node, visible, selectable, compatible); null otherwise */
  suggestion: Node | null;
  /** The user picked a node through the picker since the last profile change */
  explicit: boolean;
  /** The pick currently held by the form */
  current: string;
  /** What the suggestion auto-selected last, if it still owns the pick */
  anchoredTo: string | null;
}): { nodeId: string; anchoredTo: string | null } {
  if (p.suggestion && !p.explicit) return { nodeId: p.suggestion.id, anchoredTo: p.suggestion.id };
  if (!p.suggestion && !p.explicit && p.anchoredTo !== null && p.current === p.anchoredTo) {
    return { nodeId: "local", anchoredTo: null };
  }
  return { nodeId: p.current, anchoredTo: p.anchoredTo };
}

/**
 * Element ids of the form fields, for `htmlFor`/`id` association. The ids
 * now anchor the searchable inputs; both sets are e2e-pinned (tests/05 for
 * the dialog's, tests/06 for the page's).
 */
export interface NewSessionFormIds {
  /** Profile combobox input */
  profile: string;
  /** Working-directory input */
  workingDir: string;
  /** Name input */
  name: string;
  /** Node combobox input */
  node: string;
}

const DIALOG_IDS: NewSessionFormIds = {
  profile: "picker-profile",
  workingDir: "picker-working-dir",
  name: "picker-session-name",
  node: "picker-node",
};

/**
 * Node + profile + working directory + optional name — the form both launch
 * paths render: `/new` and the workspace dialog. State lives in the caller
 * (so each can gate and reset its own submit), this file owns the layout and
 * the pairing. Node sits first — the original ask (spec 2026-09-02) — but
 * either picker may be touched first: each selection re-filters the other
 * list LIVE (incompatible options grey out with a reason, never vanish —
 * `lib/session-compat`), and the server's 409 `harness_disabled` stays the
 * authoritative backstop for anything the cached views got wrong. A pinned
 * profile only SUGGESTS its node (earned: visible, online, compatible) and
 * the visible pick always rides the wire (`toSessionCreateBody`).
 */
export function NewSessionForm({
  value,
  onChange,
  ids = DIALOG_IDS,
}: {
  value: NewSessionFormValue;
  onChange: (value: NewSessionFormValue) => void;
  /** Field element ids; defaults to the dialog's (e2e-pinned) set. */
  ids?: NewSessionFormIds;
}): JSX.Element {
  // `node=any`: profiles that only run on OTHER nodes must be listable here.
  const { data: profiles } = useProfiles({ node: "any" });

  // Working-dir pre-fill (most recent path for the selected node) — applied
  // once per mount and only while the field is empty, so it never fights the
  // caller's state or deliberate typing. A mid-mount node switch refreshes
  // the list without yanking typed/committed input.
  const { data: recent } = useRecentPaths(value.nodeId);
  const prefillDoneRef = useRef(false);

  const { data: nodeData } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else
  // (an error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  const selectedProfile: LaunchProfile | undefined = (profiles ?? []).find((p) => p.id === value.profileId);
  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === value.nodeId) ?? null;

  // The pinned node's row — earned as a SUGGESTION only when it is also
  // selectable and compatible. A pin to `local` is the default anyway —
  // treated as no pin everywhere.
  const pinnedId = selectedProfile?.nodeId ?? null;
  const pinnedRow = pinnedId && pinnedId !== "local" ? ((nodes ?? []).find((n) => n.id === pinnedId) ?? null) : null;
  const suggestion: Node | null =
    pinnedRow !== null &&
    selectedProfile !== undefined &&
    isSelectable(pinnedRow) &&
    harnessFitsNode(pinnedRow, selectedProfile.harnessId) === null
      ? pinnedRow
      : null;

  // What the suggestion auto-selected last; owned by the component, cleared
  // by `suggestDecision` when the suggestion stops being earned.
  const anchoredRef = useRef<string | null>(null);

  // ONE effect for all automatic corrections (pre-fill + suggestion + vanish
  // re-home): composing the final value once makes the old cross-effect
  // clobbering impossible. Runs only after the node list actually loads;
  // while it loads the default "local" stands (the server accepts it).
  useEffect(() => {
    let next = value;
    if (!prefillDoneRef.current) {
      const first = recent?.paths[0]?.path;
      if (first) {
        prefillDoneRef.current = true;
        if (next.workingDir === "") next = { ...next, workingDir: first };
      }
    }
    if (nodes) {
      const d = suggestDecision({
        suggestion,
        explicit: Boolean(value.nodeExplicit),
        current: next.nodeId,
        anchoredTo: anchoredRef.current,
      });
      anchoredRef.current = d.anchoredTo;
      if (d.nodeId !== next.nodeId) next = { ...next, nodeId: d.nodeId };
      // Re-home the pick when what it pointed at vanished (e.g. an admin
      // turned off local launching). Suppressed while a suggestion owns it.
      if (!(suggestion !== null && !value.nodeExplicit)) {
        const pick = pickNodeDefault(nodes, next.nodeId);
        if (pick !== next.nodeId) next = { ...next, nodeId: pick };
      }
    }
    if (next !== value) onChange(next);
  }, [recent, nodes, suggestion, value, onChange]);

  const nodeOptions = buildNodeOptions(nodes ?? [], selectedProfile ?? null, suggestion?.id ?? null);
  const profileOptions = buildProfileOptions(profiles ?? [], value.nodeId === "" ? null : selectedNode);

  // Honest dead-ends (spec §1): the pick stands, the pair cannot — say what
  // to fix and link there. Only after BOTH lists actually loaded, and never
  // while a side is unchosen.
  const noProfilesHere =
    nodes !== null &&
    selectedNode !== null &&
    (profiles ?? []).length > 0 &&
    profileOptions.every((o) => o.disabled);
  const noNodeHere =
    nodes !== null &&
    nodes.length > 0 &&
    selectedProfile !== undefined &&
    nodeOptions.every((o) => o.disabled);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={ids.node}>Node</Label>
        <SearchableSelect
          id={ids.node}
          value={value.nodeId}
          placeholder="Choose a node"
          options={nodeOptions}
          // A pick through this control is the user's own — it outranks the
          // profile pin's suggestion until the next profile change.
          onValueChange={(nodeId) => nodeId !== "" && onChange({ ...value, nodeId, nodeExplicit: true })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.profile}>Profile</Label>
        <SearchableSelect
          id={ids.profile}
          value={value.profileId}
          placeholder="Choose a profile"
          options={profileOptions}
          // A profile change re-opens the suggestion window (§ suggestDecision).
          onValueChange={(profileId) => profileId !== "" && onChange({ ...value, profileId, nodeExplicit: false })}
        />
        {noProfilesHere && selectedNode ? (
          <p className="text-muted-foreground text-xs">
            {"No profiles run on "}
            <Link to="/nodes/$id" params={{ id: selectedNode.id }} className="underline">
              {selectedNode.name}
            </Link>
            {" — enable a harness there or create a profile."}
          </p>
        ) : null}
        {noNodeHere && selectedProfile ? (
          <p className="text-muted-foreground text-xs">
            {`No available node runs ${selectedProfile.harnessId} — `}
            <Link to="/nodes" className="underline">
              check your nodes
            </Link>
            .
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.workingDir}>Working directory</Label>
        <WorkingDirField
          id={ids.workingDir}
          value={value.workingDir}
          onChange={(workingDir) => onChange({ ...value, workingDir })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.name}>Session name (optional)</Label>
        <Input
          id={ids.name}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          maxLength={NAME_MAX_DEFAULT}
          placeholder="Defaults to date/time"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/frontend && bun test src/components/__tests__/new-session-form.test.tsx src/lib/__tests__/session-compat.test.ts && bun run verify-types`
Expected: all green. (`profile-fields.tsx` still imports `nodeOptionLabel` — full `Node` rows flow unchanged.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/session-picker/new-session-form.tsx apps/frontend/src/components/__tests__/new-session-form.test.tsx
git commit -m "feat(frontend): paired searchable node/profile pickers, pin-as-suggestion, honest hints at launch"
```

---

### Task 8: Frontend — remove the global "Harness plugins" card from Settings

**Files:**
- Modify: `apps/frontend/src/routes/settings.tsx` (delete card ~L170-207, hooks ~L89-91, imports L5, L18, L19)
- Modify: `apps/frontend/src/hooks/use-harness-toggles.ts` (doc comment only)
- Modify: `apps/frontend/src/components/harness-row.tsx` (doc comment only)
- Modify: `apps/frontend/src/routes/setup.tsx` (comment at ~L40)

**Interfaces:**
- Consumes: `/nodes/local` already renders `NodeHarnessCard` (`routes/nodes_.$id.tsx:239`, `canConfigure = access owner|edit` — via the seeded Everyone/`edit` share that is the same audience the card had, narrowing to admins only when local launching is disabled).
- Produces: no code interface; the settings page no longer imports `HarnessRow`/`useHarnessToggles`/`useHarnesses`/`useRecheckHarnesses`. Those modules stay (setup wizard is the remaining consumer).

- [ ] **Step 1: Delete the card + dead wiring** in `settings.tsx`:
  - Remove the `<Card>…<CardTitle>Harness plugins</CardTitle>…</Card>` block (the whole `<Card>` element between `<PasskeysCard />` and the "Change password" card).
  - Remove lines using `useHarnesses`/`useRecheckHarnesses`/`useHarnessToggles` (`harnesses`, `harnessesLoading`, `harnessesError`, `recheck`, `toggleHarness`, `harnessErrors`, `togglePending`) and their now-unused imports (`HarnessRow`, `useHarnessToggles`, `useHarnesses`, `useRecheckHarnesses`). `ErrorBanner`, `Button`, `Card*`, `Label`, `Input`, `Switch` stay (other cards use them) — let `lint:check`/`tsc` prove nothing else was harness-only.

- [ ] **Step 2: Fix the now-stale prose** (each was true of the settings page):
  - `use-harness-toggles.ts` header: "shared by the settings page and the setup wizard" → "the setup wizard's (the settings page's global harness card is gone — harness state is edited per node, `/nodes/:id`)".
  - `harness-row.tsx`: "the row the settings page manages and the wizard…" → wizard-only wording.
  - `setup.tsx:40` comment "(the SAME HarnessRow settings uses)" → drop the settings reference.

- [ ] **Step 3: Verify**

Run: `cd apps/frontend && bun run verify-types && bunx biome check src/routes/settings.tsx src/hooks/use-harness-toggles.ts src/components/harness-row.tsx src/routes/setup.tsx`
Expected: clean (this also catches an orphaned import).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/routes/settings.tsx apps/frontend/src/hooks/use-harness-toggles.ts apps/frontend/src/components/harness-row.tsx apps/frontend/src/routes/setup.tsx
git commit -m "feat(frontend)!: drop the global Harness plugins card — local harness state lives on /nodes/local"
```

---

### Task 9: e2e updates + full verification

**Files:**
- Modify: `e2e/tests/06-session-lifecycle.spec.ts`, `e2e/tests/09-mobile-terminal.spec.ts`, `e2e/tests/10-attach-geometry-paste.spec.ts` (placeholder-text click)
- Modify: `e2e/tests/12-nodes.spec.ts` (non-exact node option label + greyed-out assertion)

**Interfaces:**
- Consumes: the finished form (Task 7) — closed state is an `<input placeholder>` (role `combobox`), option rows keep `role=option`; node option labels now carry ` · {os}/{arch}`.
- Produces: nothing downstream.

- [ ] **Step 1: Placeholder clicks** — the combobox placeholder is an ATTRIBUTE now, so `getByText("Choose a profile")` no longer matches. In 06 (line ~31), 09 (line ~19), 10 (line ~73) replace:

```ts
await page.getByText("Choose a profile").click();
```

with:

```ts
await page.getByPlaceholderText("Choose a profile").click();
```

Keep the follow-up `getByRole("option", { name: "Default (pi)" })` clicks as-is. Update 06's comment ("role=combobox carries NO accessible name…") to: the searchable input is found by its placeholder attribute.

- [ ] **Step 2: 12-nodes — label suffix + the greyed-out assertion.** In section 6 (the `/new` flow, ~L249):

```ts
    // The pairing gate (spec 2026-09-02 §1): with pi DISABLED on the node,
    // the node picker must grey it with the reason instead of hiding it —
    // then re-enable and launch for real.
    const { nodes: regNodes } = (await (await page.request.get("/api/nodes")).json()) as {
      nodes: { id: string; name: string }[];
    };
    const nodeId = regNodes.find((n) => n.name === nodeName)?.id;
    expect(nodeId).toBeDefined();
    await page.request.patch(`/api/nodes/${nodeId}/harnesses/pi`, { data: { enabled: false } });

    const nodeOption = page.getByRole("option", { name: nodeName });
    await page.goto("/new");
    await page.getByPlaceholderText("Choose a profile").click();
    await page.getByRole("option", { name: "Default (pi)", exact: true }).click();
    await page.getByPlaceholderText("Choose a node").click();
    await expect(nodeOption).toHaveCount(1); // greyed ≠ gone
    await expect(nodeOption).toBeDisabled();
    await expect(nodeOption.getByText("disabled on this node")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.request.patch(`/api/nodes/${nodeId}/harnesses/pi`, { data: { enabled: true } });
```

replacing the existing four lines `await page.goto("/new")` → profile click → `page.locator("#node").click()` → node option click, then KEEP the `#working-dir`/`#name` fills and everything after (the node option locator `nodeOption` from above is re-opened and clicked by the continuation — replace the old two node lines with):

```ts
    await page.getByPlaceholderText("Choose a node").click();
    await nodeOption.click(); // substring locator survives the " · linux/x64" suffix
```

Note: `#node`-by-id still works too (the id lives on the input); placeholder is used here to prove the e2e contract of the new control.

- [ ] **Step 3: Run the touched e2e specs** (needs tmux + one-time `bunx playwright install chromium`; e2e boots its own backend on :3199):

```bash
cd /home/theo/projects/mote && bunx playwright test --config e2e 06-session-lifecycle 12-nodes 05-workspaces
```

Expected: PASS. If the environment cannot run e2e (no chromium, no tmux), record that VERBATIM in the commit message footer — do not claim it passed.

- [ ] **Step 4: Full verification + build** (repo root):

```bash
bun run verify-types
bun run lint:check
bun run test
bunx turbo build
```

Expected: all four clean. A backend route/schema changed (Task 1/2), so the `turbo build` is what makes `@internal/backend-client`'s treaty types see it.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/06-session-lifecycle.spec.ts e2e/tests/09-mobile-terminal.spec.ts e2e/tests/10-attach-geometry-paste.spec.ts e2e/tests/12-nodes.spec.ts
git commit -m "test(e2e): searchable pickers — placeholder locators, platform-suffix survival, greyed-out pairing assertion"
```

---

## Self-review notes (author, post-writing)

- **Spec coverage:** §1 (order, pairing, grey-with-reason, search, pin=suggestion, hints) → Tasks 3-7; §2 (matrix, staleness note, server authoritative) → Task 4; §3 (wire) → Task 6; §4a → Task 1; §4b → Task 2; §5 (settings removal + shared-hook retention) → Task 8; §7 tests → each task + Task 9; §8 → Task 9 step 4. Mobile/profile-authoring are explicit spec non-goals — no task, correct.
- **Ordering constraint called out inside Task 4** (its import of `ComboboxOption` needs Task 5's file first).
- **Type consistency:** `ComboboxOption` (Task 5) is the shape Task 4's builders return and Task 7 renders; `suggestDecision`'s param object matches its test; `useProfiles({node:"any"})` matches Task 1's literal `"any"`.
