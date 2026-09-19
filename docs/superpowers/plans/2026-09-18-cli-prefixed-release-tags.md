# CLI-Prefixed Release Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the two CLI release components from `server`/`node` to `cli-server`/`cli-node`, so all four release tag prefixes read `<form>-<role>-v`.

**Architecture:** The release-component id and the git tag prefix are one string, defined once in `packages/subshell-protocol/src/releases.ts`. Changing the `ReleaseComponent` union there makes the TypeScript compiler the worklist for every consumer. The two desktop components are untouched. No compatibility fallback for the old prefixes is added — this is a hard cutover (see **Cutover** below).

**Tech Stack:** Bun + TypeScript monorepo (Turborepo), Rust (Tauri desktop apps), GitHub Actions, POSIX shell.

**Spec:** No separate spec doc — this plan carries its own design in **Design** below. The authoritative context is `AGENTS.md` ("GitHub Releases" and "The vocabulary") and `docs/superpowers/specs/2026-09-07-app-vocabulary-design.md`.

## Design

Four release components today, published as `server-v*`, `node-v*`, `desktop-server-v*`, `desktop-client-v*`. The two CLI prefixes carry no form marker while the two desktop ones do, so the set does not read as one scheme.

| component id (before) | after | tag prefix (after) | directory (unchanged) |
|---|---|---|---|
| `server` | `cli-server` | `cli-server-v` | `apps/server/api` |
| `node` | `cli-node` | `cli-node-v` | `apps/node/agent` |
| `desktop-server` | `desktop-server` | `desktop-server-v` | `apps/server/desktop` |
| `desktop-client` | `desktop-client` | `desktop-client-v` | `apps/client/desktop` |

**Why `cli-node` and not `cli-client`.** `AGENTS.md`'s vocabulary table reserves `client` for "a human interface to a control plane" and states that `client` as a release-component id is **retired** precisely because it used to publish the node agent. `cli-client-v` would recreate that overload and sit beside `desktop-client-v`, which really is the client GUI.

**A wart this removes.** `desktop-server-v` currently has `server-v` as a *suffix*, which both `packages/subshell-protocol/src/releases.ts` and `crates/desktop-core/src/release_feed.rs` carry explanatory comments about. With `cli-server-v` no prefix is a prefix *or* a suffix of another.

**Non-goals — do not change these:**

- **Artifact file names.** `subshell-server-cli-<triple>` and `subshell-node-cli-<triple>` already carry `cli` and are pinned by a uniqueness test. Leave them.
- **HTTP API field names.** `GET /api/admin/updates` returns `node`, `desktopServer`, `desktopClient`; `server-update.ts` returns a `server` block. These name *what*, not a tag prefix. Leave them.
- **Directory names, package names, crate names, sidecar stems, `productName`, bundle identifiers.**
- **The `docs-v*` tag and the npm `<pkg>@<version>` tags.**
- **Historical citations of real published releases.** `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts` ("the two autostart verbs shipped in **server-v0.9.0** … Frozen fact") and `crates/desktop-core/src/cli_update.rs:305,308` ("Transcribed from `server-v0.6.0`'s own cli.ts") name releases that really exist under the old tags. Renaming them would make them false.
- **Dated specs and plans under `docs/superpowers/specs/` and `docs/superpowers/plans/`** (other than this file). They are records of what was decided on a date.

## Global Constraints

- Package manager and runtime are **Bun** only — `bun`, `bunx`, `bun run`. Never npm/pnpm/yarn/npx.
- No `await import()` anywhere outside the one sanctioned exception (`packages/pane-runtime/src/plugin-runtime.ts`).
- Package versions stay **pinned** (no `^`/`~`). No `package.json` dependency edits are needed by this plan.
- Every Elysia `t` schema property keeps a `description`.
- The two retired ids `"server"` and `"node"` must appear **nowhere** as a live component id after this plan. They may remain only in the historical citations listed under **Non-goals**.
- Verification after every task: `bun run verify-types`, `bun run lint:check`, `bun run test`. Rust tasks additionally need `bun run rust:check`. Changes under `packages/` need `bunx turbo build --force` first, and the dist must be confirmed to exist before anything is pushed.
- Never test against the live instance on `:3080`.

## Cutover (read before starting; it is not a task)

The tag prefix is compiled into every shipped binary, so this is a one-way switch with no fallback:

- An installed `subshell-server` 0.11.1 looks for `server-v*` forever. After the rename it will report "up to date" and never see `cli-server-v*`. Same for an installed node agent. **The remedy is reinstalling from the new `install-server.sh`, not waiting for self-update.**
- A running old server's lazy agent-binary fetch reads `node-v*`, so it keeps serving old agents until it is itself replaced.
- The signed `release-manifest.json` carries `component`, so new binaries will not verify old releases' manifests and old binaries will not verify new ones. That is the intended payload binding.
- `<data dir>/node-artifacts/.fetched.json` records tags. `supersede()` in `apps/server/api/src/services/releases.ts:560` compares `entry.tag === tag` by string, so the first `cli-node-v*` fetch treats every old `node-v*` entry as superseded, deletes those files and re-fetches. No migration needed; this is correct behaviour, not a bug.
- Existing `server-v*` and `node-v*` GitHub Releases stay published as history. Do not delete them.
- **Do not dispatch a release cut while this plan is partly landed.** Land every task, then cut `app=all` once.

---

### Task 1: Rename the component ids across the protocol package and every TypeScript consumer

The `ReleaseComponent` union change breaks typecheck repo-wide at once, so the whole TypeScript surface plus `install-server.sh` (whose test runs under `bun test`) is one commit. This is the smallest unit that leaves the repo green.

**Files:**
- Modify: `packages/subshell-protocol/src/releases.ts:42-59`, `:104-115`
- Modify: `packages/subshell-protocol/src/versions.ts:89`
- Modify: `apps/server/api/src/services/releases.ts:410-412`, `:470`, `:634`, `:731`, `:32`, `:556`
- Modify: `apps/server/api/src/services/server-update.ts:186`, `:302`, `:348`
- Modify: `apps/server/api/src/commands/update.ts:156`, `:230`
- Modify: `apps/server/api/src/api/admin-server/update.route.ts:55`
- Modify: `apps/server/api/src/api/admin-server/schemas.ts:116`
- Modify: `apps/server/api/src/api/install-script.ts:234`, `:237-238`
- Modify: `apps/server/api/src/api/nodes/update-node.route.ts:272`
- Modify: `apps/server/api/src/api/downloads.route.ts:197`
- Modify: `apps/server/api/src/constants.ts:180`, `:182`
- Modify: `apps/server/api/src/lib/node-artifacts.ts:41`
- Modify: `apps/server/api/src/commands/status.ts:182`
- Modify: `apps/server/api/src/scripts/release.ts:389`
- Modify: `apps/node/agent/src/update.ts:507`, `:516`, `:872-875`, `:878`, `:919`
- Modify: `apps/node/agent/src/cli.ts:689`
- Modify: `apps/node/agent/src/scripts/release.ts:246`, `:255`
- Modify: `packages/subshell-protocol/src/paths.ts:86`
- Modify: `packages/subshell-protocol/src/release-signature.ts:319`
- Modify: `scripts/merge-release-manifest.ts:11`, `:125-126`
- Modify: `apps/server/web/src/types/updates.ts:15`
- Modify: `apps/server/web/src/components/nodes/node-key-setup.tsx:159`
- Modify: `install-server.sh:7`, `:62-63`, `:89-90`, `:95`, `:99`
- Modify: `package.json:47`, `:49`
- Test: `packages/subshell-protocol/src/__tests__/releases.test.ts`
- Test: `apps/server/api/src/services/__tests__/releases.test.ts`
- Test: `apps/server/api/src/services/__tests__/server-update.test.ts`
- Test: `apps/server/api/src/api/admin-server/__tests__/update.route.test.ts`
- Test: `apps/server/api/src/api/__tests__/downloads-route.test.ts`
- Test: `apps/server/api/src/api/nodes/__tests__/update-node.route.test.ts`
- Test: `apps/node/agent/src/__tests__/update.test.ts`
- Test: `apps/node/agent/src/__tests__/cli.test.ts`
- Test: `apps/server/web/src/components/__tests__/helpers/updates-view.ts`
- Test: `apps/server/web/src/components/__tests__/updates-server-row.test.tsx`
- Test: `apps/server/web/src/components/__tests__/server-version-row.test.tsx`
- Test: `scripts/__tests__/install-server-script.test.ts`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `type ReleaseComponent = "cli-server" | "cli-node" | "desktop-server" | "desktop-client"`
  - `const RELEASE_COMPONENTS: readonly ReleaseComponent[]`
  - `const RELEASE_TAG_PREFIX: Record<ReleaseComponent, string>` — `cli-server-v`, `cli-node-v`, `desktop-server-v`, `desktop-client-v`
  - `parseReleaseTag(component: ReleaseComponent, tag: string): string | null` — signature unchanged
  - `newestRelease(component: ReleaseComponent, tags: readonly string[]): ReleaseCandidate | null` — signature unchanged
  - `releaseAssetNames(component: "cli-server" | "cli-node", target: NodeTarget | ServerTarget): { binary: string; sidecar: string }`
  - `installableCliRelease(component: "cli-server" | "cli-node"): Promise<CliReleaseCheck>` in `apps/server/api/src/services/releases.ts`
  - Root scripts `release:cli-server` and `release:cli-node` (replacing `release:server` / `release:node`)

- [ ] **Step 1: Write the failing test — the new prefixes and the retired ids**

Edit `packages/subshell-protocol/src/__tests__/releases.test.ts`. Replace the `parseReleaseTag` and `newestRelease` describe blocks' literals, and add the two new assertions. The full replacement for the first describe block:

```typescript
describe("parseReleaseTag", () => {
  it("takes the version out of each component's own tag", () => {
    expect(parseReleaseTag("cli-node", "cli-node-v0.2.0")).toBe("0.2.0");
    expect(parseReleaseTag("cli-server", "cli-server-v10.20.30")).toBe("10.20.30");
    expect(parseReleaseTag("desktop-server", "desktop-server-v0.6.0")).toBe("0.6.0");
    expect(parseReleaseTag("desktop-client", "desktop-client-v0.4.0")).toBe("0.4.0");
  });

  it("ignores every other component's tags", () => {
    // The four apps share one Releases page, and so do the seven npm
    // packages. A prefix test that also matched `desktop-client-v…` would
    // hand a node a desktop bundle.
    const foreign: Record<ReleaseComponent, string[]> = {
      "cli-node": ["cli-server-v0.2.0", "desktop-server-v0.2.0", "desktop-client-v0.1.3", "v0.2.0", "cli-node-v"],
      "cli-server": [
        "cli-node-v0.2.0",
        "desktop-server-v0.2.0",
        "desktop-client-v0.1.3",
        "@subshell-ai/plugin-api@1.0.0",
      ],
      "desktop-server": ["cli-server-v0.2.0", "desktop-client-v0.2.0", "cli-node-v0.2.0"],
      "desktop-client": ["cli-server-v0.2.0", "desktop-server-v0.2.0", "cli-node-v0.2.0"],
    };
    for (const component of RELEASE_COMPONENTS) {
      for (const tag of foreign[component]) expect(parseReleaseTag(component, tag), `${component}/${tag}`).toBeNull();
    }
  });

  it("no longer answers to the retired `server-v`/`node-v` prefixes", () => {
    // The hard cutover of 2026-09-18: every release published before it stays
    // on the Releases page, and no current build may treat one as its own.
    expect(parseReleaseTag("cli-server", "server-v1.2.3")).toBeNull();
    expect(parseReleaseTag("cli-node", "node-v1.2.3")).toBeNull();
  });

  it("refuses a prerelease or build-metadata suffix", () => {
    // An updater would otherwise hand a machine a build the release pipeline
    // does not smoke the same way.
    expect(parseReleaseTag("cli-node", "cli-node-v1.0.0-rc.1")).toBeNull();
    expect(parseReleaseTag("cli-server", "cli-server-v1.0.0+build7")).toBeNull();
    expect(parseReleaseTag("cli-server", "cli-server-v1.0")).toBeNull();
  });

  it("every component has its own prefix, and no prefix is another's prefix or suffix", () => {
    // Prefix: `parseReleaseTag` is a plain `startsWith`, and the release
    // workflow's publish job globs `<id>-*`. Suffix: not load-bearing, but
    // true since every prefix reads `<form>-<role>-v`, and asserting it is
    // what keeps the comment on RELEASE_TAG_PREFIX honest.
    const prefixes = RELEASE_COMPONENTS.map((c) => RELEASE_TAG_PREFIX[c]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(b.startsWith(a), `${b} starts with ${a}`).toBe(false);
        expect(b.endsWith(a), `${b} ends with ${a}`).toBe(false);
      }
    }
  });
});
```

Then in the `newestRelease` describe block replace every `node-v` with `cli-node-v`, every `server-v` with `cli-server-v`, and every `"node"`/`"server"` component argument with `"cli-node"`/`"cli-server"`:

```typescript
describe("newestRelease", () => {
  it("picks by semver, not by the order given", () => {
    const tags = ["cli-node-v0.2.0", "cli-node-v0.10.0", "cli-node-v0.9.0"];
    expect(newestRelease("cli-node", tags)).toEqual({ tag: "cli-node-v0.10.0", version: "0.10.0" });
    expect(newestRelease("cli-node", [...tags].reverse())).toEqual({ tag: "cli-node-v0.10.0", version: "0.10.0" });
  });

  it("is not fooled by a re-cut publishing after a newer version", () => {
    // GitHub returns releases newest-FIRST by date. A date-ordered pick would
    // hand every machine a downgrade the day an old version is re-cut.
    expect(newestRelease("cli-node", ["cli-node-v0.1.9", "cli-node-v0.3.0"])?.version).toBe("0.3.0");
  });

  it("ignores another component's tag even when it parses as newer", () => {
    // The whole point of taking a component rather than inferring one.
    const mixed = ["cli-server-v0.6.0", "desktop-server-v9.9.9", "cli-node-v0.8.0", "desktop-client-v0.4.0"];
    expect(newestRelease("cli-server", mixed)).toEqual({ tag: "cli-server-v0.6.0", version: "0.6.0" });
    expect(newestRelease("cli-node", mixed)).toEqual({ tag: "cli-node-v0.8.0", version: "0.8.0" });
    expect(newestRelease("desktop-server", mixed)).toEqual({ tag: "desktop-server-v9.9.9", version: "9.9.9" });
  });

  it("answers null when the repository has no release of that component", () => {
    expect(newestRelease("cli-node", [])).toBeNull();
    expect(newestRelease("cli-node", ["cli-server-v1.0.0", "desktop-client-v1.0.0"])).toBeNull();
  });
});
```

In the `releaseAssetNames` describe block, change the two component arguments only — the asset names themselves do NOT change:

```typescript
describe("releaseAssetNames", () => {
  it("names exactly what each CLI release publishes", () => {
    // The artifact names are unchanged by the 2026-09-18 tag rename: they
    // already carried `cli`, just in the trailing position.
    expect(releaseAssetNames("cli-node", "darwin-arm64")).toEqual({
      binary: "subshell-node-cli-darwin-arm64",
      sidecar: "subshell-node-cli-darwin-arm64.sha256",
    });
    expect(releaseAssetNames("cli-server", "linux-x64")).toEqual({
      binary: "subshell-server-cli-linux-x64",
      sidecar: "subshell-server-cli-linux-x64.sha256",
    });
  });
});
```

In the `parseReleaseManifest` describe block, change `good.component` to `"cli-node"` and add the retired-id assertions inside the existing "answers null rather than throwing on anything unexpected" test, next to the existing `spoiled({ component: "agent" })` line:

```typescript
    expect(parseReleaseManifest(spoiled({ component: "agent" }))).toBeNull();
    // The retired ids (2026-09-18). A manifest from a pre-rename release must
    // read as unknown, exactly as a manifest from some future pipeline does.
    expect(parseReleaseManifest(spoiled({ component: "server" }))).toBeNull();
    expect(parseReleaseManifest(spoiled({ component: "node" }))).toBeNull();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/subshell-protocol/src/__tests__/releases.test.ts`
Expected: FAIL — TypeScript rejects `"cli-node"` as a `ReleaseComponent`, and the `foreign` record is missing the `node`/`server` keys.

- [ ] **Step 3: Rename the ids in the protocol package**

In `packages/subshell-protocol/src/releases.ts`, replace lines 38-59 (the `ReleaseComponent` type through the end of `RELEASE_TAG_PREFIX`) with:

```typescript
/**
 * The four things this repository cuts releases of — the release-component
 * IDS (`release.yml`'s `matrix.app`), never the directory names.
 *
 * Every id reads `<form>-<role>`: which shape a user installs, then which of
 * the product's three words it is. The CLI pair carried no form marker until
 * 2026-09-18 (`server`, `node`); `client` as an id stays RETIRED, because it
 * once published the node agent — the exact overload the vocabulary removes.
 */
export type ReleaseComponent = "cli-server" | "cli-node" | "desktop-server" | "desktop-client";

/** Every component, for iteration and validation. */
export const RELEASE_COMPONENTS: readonly ReleaseComponent[] = [
  "cli-server",
  "cli-node",
  "desktop-server",
  "desktop-client",
];

/**
 * The git tag prefix each component publishes under.
 *
 * No prefix is a prefix OR a suffix of another, which is what lets
 * {@link parseReleaseTag} be a plain `startsWith`. (Before 2026-09-18 the
 * suffix half was false — `desktop-server-v` ended with `server-v` — and this
 * comment existed to say so.) {@link newestRelease} is still given a
 * component rather than inferring one, because a tag names its component only
 * by convention and an updater must not guess.
 */
export const RELEASE_TAG_PREFIX: Record<ReleaseComponent, string> = {
  "cli-server": "cli-server-v",
  "cli-node": "cli-node-v",
  "desktop-server": "desktop-server-v",
  "desktop-client": "desktop-client-v",
};
```

Then update `releaseAssetNames` (lines 104-115):

```typescript
/**
 * The two asset names a CLI release carries for one platform.
 *
 * Only `cli-server` and `cli-node` have bare-binary assets; the two desktop
 * components publish bundles whose names carry a version and are built by
 * `desktopArtifactFileName`, so they are not nameable from a target alone.
 *
 * The asset names themselves are unchanged by the tag rename — they already
 * carried `cli`, in the trailing position.
 */
export function releaseAssetNames(
  component: "cli-server" | "cli-node",
  target: NodeTarget | ServerTarget,
): { binary: string; sidecar: string } {
  const binary = component === "cli-node" ? nodeArtifactFileName(target) : serverArtifactFileName(target);
  return { binary, sidecar: `${binary}.sha256` };
}
```

Also update the `DEFAULT_RELEASE_API` doc comment's measured example (line ~28) from ``(measured 2026-09-15: `server-v0.6.0` beat `node-v0.8.0` by seconds)`` to ``(measured 2026-09-15: `server-v0.6.0` beat `node-v0.8.0` by seconds — those are the pre-2026-09-18 spellings of what are now `cli-server-v`/`cli-node-v`)``.

- [ ] **Step 4: Run the protocol test to verify it passes**

Run: `bun test packages/subshell-protocol/src/__tests__/releases.test.ts`
Expected: PASS

- [ ] **Step 5: Rebuild the protocol package**

Run: `bunx turbo build --force --filter=@internal/subshell-protocol`
Then confirm the dist actually exists: `ls -la packages/subshell-protocol/dist/index.d.ts`
Expected: the file is present. A turbo cache hit can restore a dist into the wrong worktree, so this check is not optional.

- [ ] **Step 6: Update the server API consumers**

In `apps/server/api/src/services/releases.ts`:
- line 410: `const release = index.byComponent.node;` → `const release = index.byComponent["cli-node"];`
- line 412: `"the release source publishes no node-v* release"` → `"the release source publishes no cli-node-v* release"`
- line 470: `export async function installableCliRelease(component: "server" | "node"): Promise<CliReleaseCheck> {` → `export async function installableCliRelease(component: "cli-server" | "cli-node"): Promise<CliReleaseCheck> {`
- line 634: `releaseAssetNames("node", target)` → `releaseAssetNames("cli-node", target)`
- line 731: `releaseAssetNames("node", target)` → `releaseAssetNames("cli-node", target)`
- lines 32 and 556: the two `release:node` comment mentions → `release:cli-node`

In `apps/server/api/src/services/server-update.ts`:
- line 186: `releaseAssetNames("server", hostTarget)` → `releaseAssetNames("cli-server", hostTarget)`
- line 302: the doc comment ``(`server-v0.7.0`)`` → ``(`cli-server-v0.7.0`)``
- line 348: `installableCliRelease("server")` → `installableCliRelease("cli-server")`

In `apps/server/api/src/commands/update.ts`:
- line 156: `installableCliRelease("server")` → `installableCliRelease("cli-server")`
- line 230: `releaseAssetNames("server", hostTarget)` → `releaseAssetNames("cli-server", hostTarget)`

In `apps/server/api/src/api/admin-server/update.route.ts` line 55: `return installableCliRelease("server");` → `return installableCliRelease("cli-server");`

In `apps/server/api/src/api/admin-server/schemas.ts` line 116, the Elysia description (it must keep a `description`):

```typescript
  tag: t.String({ description: "The git tag the release carries (cli-server-v0.7.0)" }),
```

In `apps/server/api/src/scripts/release.ts` line 389: `component: "server",` → `component: "cli-server",`

In `apps/server/api/src/api/install-script.ts`, lines 234 and 237-238 (user-visible stderr prose):

```typescript
    echo "    project's own cli-node-vX.Y.Z release on first use — so this usually means the server" >&2
```

```typescript
    echo "    'bun run release:cli-node' from a checkout on the server host, or copy the" >&2
    echo "    'subshell-node-cli-$TARGET' asset from a cli-node-vX.Y.Z GitHub Release into that dir." >&2
```

In `apps/server/api/src/api/nodes/update-node.route.ts` line 272: `` `bun run release:node` `` → `` `bun run release:cli-node` ``

In `apps/server/api/src/api/downloads.route.ts` line 197, `apps/server/api/src/constants.ts` lines 180 and 182, `apps/server/api/src/lib/node-artifacts.ts` line 41, and `apps/server/api/src/commands/status.ts` line 182: change each `release:node` comment mention to `release:cli-node`, and `constants.ts:182`'s `` `node-v*` release`` to `` `cli-node-v*` release``.

- [ ] **Step 7: Update the node agent consumers**

In `apps/node/agent/src/update.ts`:
- lines 507 and 919: `component: "node",` → `component: "cli-node",`
- lines 516 and 878: `releaseAssetNames("node", target)` → `releaseAssetNames("cli-node", target)`
- lines 872-873:

```typescript
    ? (tags.map((tag) => ({ tag, version: parseReleaseTag("cli-node", tag) })).find((c) => c.version === want) ?? null)
    : newestRelease("cli-node", tags);
```

- line 875:

```typescript
    throw new Error(want ? `${api} publishes no node release ${want}` : `${api} publishes no cli-node-v* release`);
```

In `apps/node/agent/src/scripts/release.ts`:
- line 246: `component: "node",` → `component: "cli-node",`
- line 255: the `release:node` comment mention → `release:cli-node`

In `apps/node/agent/src/cli.ts` line 689: the `` `node-v*` cut`` comment → `` `cli-node-v*` cut``

- [ ] **Step 8: Update the shared scripts and the remaining protocol comments**

In `scripts/merge-release-manifest.ts`:
- line 11: the `release:node` comment mention → `release:cli-node`
- lines 125-126:

```typescript
  if (manifest.component === "cli-node") return NODE_TARGETS.map((t) => releaseAssetNames("cli-node", t).binary);
  if (manifest.component === "cli-server") return SERVER_TARGETS.map((t) => releaseAssetNames("cli-server", t).binary);
```

In `packages/subshell-protocol/src/versions.ts` line 89: `` `node-v*` cut`` → `` `cli-node-v*` cut``
In `packages/subshell-protocol/src/paths.ts` line 86 and `packages/subshell-protocol/src/release-signature.ts` line 319: each `release:node` comment mention → `release:cli-node`

- [ ] **Step 9: Update the SPA**

In `apps/server/web/src/types/updates.ts` line 15: ``(`server-v0.7.0`)`` → ``(`cli-server-v0.7.0`)``

In `apps/server/web/src/components/nodes/node-key-setup.tsx` line 159 (user-visible copy — two changes on one line):

```tsx
      <code className="font-mono">bun run release:cli-node</code> from a checkout, or copy them from a cli-node-vX.Y.Z GitHub
```

- [ ] **Step 10: Rename the root release scripts**

In `package.json`, lines 47 and 49 — rename the keys, keeping them in the file's existing alphabetical position (`release:cli-node` and `release:cli-server` sort before `release:desktop-client`):

```json
    "release:cli-node": "bun run --cwd apps/node/agent compile:release",
    "release:cli-server": "bun run --cwd apps/server/api compile:release",
```

- [ ] **Step 11: Update `install-server.sh`**

Change line 7's comment (`` `server-vX.Y.Z` GitHub Release`` → `` `cli-server-vX.Y.Z` GitHub Release``), lines 62-63's comment (`node-v*` → `cli-node-v*`, and "Tags are filtered to `server-v`" → "`cli-server-v`"), then the three functional lines:

```sh
      grep -o '"tag_name"[[:space:]]*:[[:space:]]*"cli-server-v[0-9][0-9.]*"' |
      sed -e 's/.*"cli-server-v//' -e 's/"$//' |
```

```sh
    fail "no cli-server-vX.Y.Z release is published yet." \
```

```sh
TAG="cli-server-v$VERSION"
```

- [ ] **Step 12: Update the affected test fixtures**

These are synthetic tags describing the live scheme, so they all rename. Do **not** touch `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts`, whose `server-v0.9.0` references are a frozen historical fact.

In `scripts/__tests__/install-server-script.test.ts`, the tag fixture list (lines 54-58) and every assertion (lines 10, 22, 61, 285, 287, 289, 296, 304):

```typescript
  "cli-node-v9.99.0",
  "cli-server-v1.9.0",
  "cli-server-v1.10.0",
  "desktop-server-v3.1.0",
  "cli-server-v0.4.2",
```

```typescript
    expect(r.stdout).toContain(`installing cli-server-v${NEWEST_SERVER_VERSION}`);
```

```typescript
    expect(r.stdout).toContain("installing cli-server-v0.4.2");
```

```typescript
    expect(r.stderr).toContain(`cli-server-v${NEWEST_SERVER_VERSION}`);
```

In `apps/server/api/src/services/__tests__/releases.test.ts`, rename every synthetic `node-v`/`server-v` tag (lines 133, 178-181, 208-209, 226, 231, 280-281, 288, 300, 356, 375, 389) and the `byComponent` key at line 209:

```typescript
    expect((await resolveReleases()).byComponent["cli-node"]?.tag).toBe("cli-node-v9.9.9");
```

```typescript
    expect((await compatibleNodeRelease()).reason).toMatch(/no cli-node-v\* release/);
```

In `apps/node/agent/src/__tests__/update.test.ts`, lines 774, 802, 846, 881: `node-v0.8.0` → `cli-node-v0.8.0`, `node-v0.9.1` → `cli-node-v0.9.1`.

In `apps/server/web/src/components/__tests__/helpers/updates-view.ts` lines 18 and 34: `server-v0.7.0` → `cli-server-v0.7.0`, `node-v0.9.0` → `cli-node-v0.9.0`.

In `apps/server/web/src/components/__tests__/updates-server-row.test.tsx` line 50: `server-v0.6.0` → `cli-server-v0.6.0`.

In `apps/server/web/src/components/__tests__/server-version-row.test.tsx` line 38: `` tag: `server-v${to}` `` → `` tag: `cli-server-v${to}` ``.

Also sweep `apps/server/api/src/services/__tests__/server-update.test.ts`, `apps/server/api/src/api/admin-server/__tests__/update.route.test.ts`, `apps/server/api/src/api/__tests__/downloads-route.test.ts`, `apps/server/api/src/api/nodes/__tests__/update-node.route.test.ts` and `apps/node/agent/src/__tests__/cli.test.ts` for their one `server-v`/`node-v`/`release:node` occurrence each and rename it the same way.

- [ ] **Step 13: Build, then run full verification**

Run each, and pin the exit code rather than reading a piped tail:

```bash
cd /Users/theo/projects/subshell
bunx turbo build --force; echo "build rc=$?"
bun run verify-types; echo "types rc=$?"
bun run lint; bun run lint:check; echo "lint rc=$?"
bun run test; echo "test rc=$?"
```

Expected: every `rc=0`.

- [ ] **Step 14: Assert the retired ids are gone from live code**

```bash
cd /Users/theo/projects/subshell
grep -rn "server-v\|node-v" --include="*.ts" --include="*.tsx" --include="*.sh" . 2>/dev/null \
  | grep -v node_modules | grep -v "/dist/" | grep -v "\.turbo" \
  | grep -E "'server-v|\"server-v|'node-v|\"node-v|server-v[0-9X{\$]|node-v[0-9X{\$]" \
  | grep -v "desktop-server-v\|desktop-client-v\|cli-server-v\|cli-node-v"
```

Expected: only `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts` (the frozen `server-v0.9.0` fact). Anything else is a missed site — fix it and re-run steps 13 and 14.

- [ ] **Step 15: Commit**

```bash
cd /Users/theo/projects/subshell
git add packages/subshell-protocol apps/server/api apps/server/web apps/node/agent scripts install-server.sh package.json
git commit -m "$(cat <<'MSG'
refactor(releases): rename the CLI components to cli-server and cli-node

The release-component id is the git tag prefix, and the two CLI components
carried no form marker while the two desktop ones did. All four now read
<form>-<role>: cli-server-v, cli-node-v, desktop-server-v, desktop-client-v.

`cli-node` rather than `cli-client`: `client` as a component id is retired
because it once published the node agent, which is the overload the app
vocabulary removes.

No compatibility fallback — a build reads its own prefix only, so this is a
hard cutover and an installed pre-rename binary must be reinstalled rather
than self-updated.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: Update the Rust foreign-tag fixtures and comments

The Rust side takes the prefix as a parameter and hardcodes only the two desktop prefixes, so no behaviour changes. What changes is the fixtures that assert "another component's tag is never picked" — after Task 1 the realistic sibling tags are `cli-server-v*` and `cli-node-v*`, and the suffix relationship the comments explain no longer exists.

**Files:**
- Modify: `crates/desktop-core/src/release_feed.rs:98-100`, `:288`, `:304-306`
- Modify: `apps/server/desktop/src-tauri/src/app_update.rs:486`
- Modify: `apps/client/desktop/src-tauri/src/app_update.rs:387`

**Interfaces:**
- Consumes: nothing at compile time — Rust does not import the TypeScript union. The tag strings must match Task 1's `RELEASE_TAG_PREFIX` values by convention.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Update the shared crate's fixtures**

In `crates/desktop-core/src/release_feed.rs`, change the doc comment at lines 98-100 so it no longer claims the suffix relationship:

```rust
/// Tags belonging to another component are ignored even when they would parse
/// as a newer version. Since the 2026-09-18 rename every prefix reads
/// `<form>-<role>-v`, so no prefix is another's prefix or suffix and a plain
/// `starts_with` is exact.
```

At line 288, change the foreign-tag case:

```rust
        assert_eq!(parse_release_tag("desktop-server-v", "cli-server-v1.2.3"), None);
```

At lines 298-306, drop the stale suffix rationale and rename the rows:

```rust
    // Every component's tags land on one Releases page, so a picker that
    // matched loosely would hand a desktop app a CLI release.
    #[test]
    fn another_components_tag_is_never_picked() {
        let rows = [
            row("cli-server-v9.0.0", false),
            row("cli-node-v9.0.0", false),
            row("desktop-client-v9.0.0", false),
            row("desktop-server-v1.2.3", false),
        ];
```

- [ ] **Step 2: Update both desktop apps' fixtures**

In `apps/server/desktop/src-tauri/src/app_update.rs` line 486:

```rust
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "cli-server-v1.2.3").is_none());
```

In `apps/client/desktop/src-tauri/src/app_update.rs` line 387:

```rust
        assert!(release_feed::parse_release_tag(TAG_PREFIX, "cli-node-v1.2.3").is_none());
```

Leave `crates/desktop-core/src/cli_update.rs:305,308`, `apps/server/desktop/src-tauri/src/control.rs:3646` and `apps/client/desktop/src-tauri/src/control.rs:2583` alone — each cites a real published release (`server-v0.6.0`, `node-v0.8.0`) that a rename would make false.

- [ ] **Step 3: Run the Rust checks**

```bash
cd /Users/theo/projects/subshell
bun run rust:check; echo "rust rc=$?"
```

Expected: `rc=0` — `cargo fmt --check`, `clippy -D warnings` and `cargo test` across all three crates.

- [ ] **Step 4: Commit**

```bash
cd /Users/theo/projects/subshell
git add crates/desktop-core apps/server/desktop/src-tauri apps/client/desktop/src-tauri
git commit -m "$(cat <<'MSG'
test(desktop): name the renamed CLI tags in the foreign-tag fixtures

The desktop prefixes are unchanged, but the sibling tags these fixtures
reject are now cli-server-v and cli-node-v — and `desktop-server-v` no
longer ends with the server prefix, so the comment explaining that is gone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Update the release pipeline

Nothing here is covered by a local test suite, so the gate is a read-through plus the id-prefix guard the workflow applies to itself on the next dispatch.

**Files:**
- Modify: `.github/workflows/release.yml:62-68`, `:95`, `:327-333`, `:343`, `:356-362`, `:415-417`, `:527`, `:775`, `:783`, `:948`
- Modify: `scripts/cli-e2e/published-release.sh:4`, `:22`, `:113`, `:128-131`, `:146`, `:148`
- Modify: `scripts/cli-e2e/node-update.sh:214`, `:355`

**Interfaces:**
- Consumes: the ids `cli-server` and `cli-node` from Task 1, and the root scripts `release:cli-server` / `release:cli-node`.
- Produces: `workflow_dispatch` options `cli-server | cli-node | desktop-server | desktop-client | all`; tags `cli-server-vX.Y.Z` and `cli-node-vX.Y.Z`.

- [ ] **Step 1: Update the header comment**

Replace lines 62-68 with:

```yaml
#   app (the id)  `cli-server` | `cli-node` | `desktop-server` | `desktop-client`.
#                 The git tag prefix, the upload-artifact name, the publish
#                 download pattern and file glob, the dispatch option, and
#                 every `matrix.app == …` condition. These are what a user
#                 sees on the releases page — `cli-server-vX.Y.Z`,
#                 `cli-node-vX.Y.Z`, `desktop-server-vX.Y.Z`,
#                 `desktop-client-vX.Y.Z`. Every id reads `<form>-<role>`:
#                 which shape a user installs, then which of the product's
#                 three words it is. `client` as an id is RETIRED: it
#                 published the node agent.
```

- [ ] **Step 2: Update the dispatch options**

Line 95:

```yaml
        options: [cli-server, cli-node, desktop-server, desktop-client, all]
```

- [ ] **Step 3: Update the plan job's case, guard list and directory table**

Lines 327-333:

```bash
          case "$APP_INPUT" in
            cli-server) apps="cli-server" ;;
            cli-node)   apps="cli-node" ;;
            desktop-server) apps="desktop-server" ;;
            desktop-client) apps="desktop-client" ;;
            all)     apps="cli-server cli-node desktop-server desktop-client" ;;
            *) echo "unknown app input: '$APP_INPUT'" >&2; exit 1 ;;
          esac
```

Line 343:

```bash
          ALL_APPS="cli-server cli-node desktop-server desktop-client"
```

Lines 357-361 (inside `app_dir`):

```bash
            case "$1" in
              cli-server)     echo "server/api" ;;
              cli-node)       echo "node/agent" ;;
              desktop-server) echo "server/desktop" ;;
              desktop-client) echo "client/desktop" ;;
```

Line 384 (`tag="$app-v$version"`) needs no edit — it composes the new ids automatically.

- [ ] **Step 4: Update the triples table and the CLI-only conditions**

Lines 416-417:

```bash
              cli-server) triples="linux-x64 linux-arm64 darwin-arm64" ;;
              cli-node) triples="linux-x64 linux-arm64 darwin-arm64" ;;
```

Line 527:

```yaml
        if: contains(fromJSON('["cli-server","cli-node"]'), matrix.app)
```

Lines 775 and 783, inside `exec_smoke`:

```bash
            if [ "$APP" = "cli-server" ]; then
```

Line 948:

```bash
            cli-server|desktop-server) cp repo/apps/server/LICENSE legal/LICENSE-AGPL-3.0 ;;
```

The `startsWith(matrix.app, 'desktop-')` conditions at lines 476, 618, 624, 643 and 969, the cargo cache key at 639-640, the artifact name at 848, the download pattern at 886 and the asset glob at 1002 all read `matrix.app` generically and need no edit.

- [ ] **Step 5: Update the cli-e2e scripts**

In `scripts/cli-e2e/published-release.sh`, lines 4, 22 and 113's comments (`server-v*` → `cli-server-v*`, `node-v*` → `cli-node-v*`), then the functional lines 128-131 and 146-148:

```sh
NODE_TAG=$(grep '^cli-node-v' "$W/tags.txt" | sort -V | tail -1)
[ -n "$NODE_TAG" ] || fail "no cli-node-v* tag found on the public repo"
SERVER_TAG=$(grep '^cli-server-v' "$W/tags.txt" | sort -V | tail -1)
[ -n "$SERVER_TAG" ] || fail "no cli-server-v* tag found on the public repo"
```

```sh
bun "$W/verify-manifest.ts" cli-node "${NODE_TAG#cli-node-v}" "$NODE_TAG" || fail "the published node release does not verify against this build's RELEASE_PUBKEY"
```

```sh
bun "$W/verify-manifest.ts" cli-server "${SERVER_TAG#cli-server-v}" "$SERVER_TAG" || fail "the published server release does not verify against this build's RELEASE_PUBKEY"
```

Note that `verify-manifest.ts` takes the component id as `argv[2]`, so `node`/`server` become `cli-node`/`cli-server` there too.

In `scripts/cli-e2e/node-update.sh`, lines 214 and 355:

```sh
          tag_name: \`cli-node-v\${process.argv[4]}\`,
```

```sh
          tag_name: \`cli-node-v\${version}\`,
```

- [ ] **Step 6: Verify the workflow parses and the id guard still holds**

```bash
cd /Users/theo/projects/subshell
bunx js-yaml .github/workflows/release.yml > /dev/null; echo "yaml rc=$?"
for a in cli-server cli-node desktop-server desktop-client; do
  for b in cli-server cli-node desktop-server desktop-client; do
    [ "$a" = "$b" ] && continue
    case "$b" in "$a"-*) echo "COLLISION: $a is a prefix of $b"; exit 1 ;; esac
  done
done; echo "id-prefix guard rc=$?"
bun run lint:check; echo "lint rc=$?"
```

Expected: `yaml rc=0`, no `COLLISION` line, `id-prefix guard rc=0`, `lint rc=0`.

- [ ] **Step 7: Run the install-script test once more**

The script test drives the real `install-server.sh` against a fake release host, so it is the closest thing to a pipeline test that runs locally.

```bash
cd /Users/theo/projects/subshell
bun test scripts/__tests__/install-server-script.test.ts; echo "rc=$?"
```

Expected: `rc=0`.

- [ ] **Step 8: Commit**

```bash
cd /Users/theo/projects/subshell
git add .github/workflows/release.yml scripts/cli-e2e
git commit -m "$(cat <<'MSG'
ci(release): cut the CLI components under cli-server-v and cli-node-v

Dispatch options, the id->directory table, the triples table, the CLI-only
build condition and the AGPL license case all move to the new ids; the tag
is still composed as "$app-v$version", so it follows for free.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Update the living documentation and add the changeset

**Files:**
- Modify: `AGENTS.md` (13 occurrences)
- Modify: `apps/server/api/AGENTS.md` (3), `apps/node/agent/AGENTS.md` (1), `apps/server/desktop/AGENTS.md` (5), `apps/client/desktop/AGENTS.md` (2)
- Modify: `apps/docs/content/docs/help/release-notes.mdx:14-15`
- Modify: `apps/docs/content/docs/get-started/install-server.mdx:16`, `:60`
- Modify: `apps/docs/content/docs/server/headless-install.mdx:16`
- Modify: `apps/docs/content/docs/reference/version-compatibility.mdx:33`
- Modify: `apps/docs/content/docs/reference/environment-variables.mdx:18`
- Modify: `apps/docs/content/docs/help/troubleshooting.mdx:69`
- Create: `.changeset/cli-prefixed-release-tags.md`

**Interfaces:**
- Consumes: the final ids, tag prefixes and root script names from Tasks 1 and 3.
- Produces: nothing code-level.

- [ ] **Step 1: Update the root AGENTS.md**

Rewrite the id/directory table under "GitHub Releases" so the id column reads `cli-server`, `cli-node`, `desktop-server`, `desktop-client`, and update every `server-vX.Y.Z` / `node-vX.Y.Z` mention, the `gh workflow run release.yml -f app=all` option list, and every `bun run release:node` / `bun run release:server` to `release:cli-node` / `release:cli-server`. Under "Directory names and component IDS are two different things", change the tag-prefix list to `cli-server-vX.Y.Z`, `cli-node-vX.Y.Z`, `desktop-server-vX.Y.Z`, `desktop-client-vX.Y.Z` and add one sentence recording the rename:

```markdown
Every id reads `<form>-<role>`: which shape a user installs, then which of the
product's three words it is. The CLI pair carried no form marker until
2026-09-18 (`server`, `node`); renaming them to `cli-server` and `cli-node`
also removed a real wart — `desktop-server-v` used to have `server-v` as a
suffix, which both the TypeScript and the Rust tag parsers carried comments
about. `client` as a component id stays RETIRED.
```

Find every site with:

```bash
cd /Users/theo/projects/subshell
grep -n "server-v\|node-v\|release:node\|release:server" AGENTS.md
```

- [ ] **Step 2: Update the four app AGENTS.md files**

```bash
cd /Users/theo/projects/subshell
for f in apps/server/api/AGENTS.md apps/node/agent/AGENTS.md apps/server/desktop/AGENTS.md apps/client/desktop/AGENTS.md; do
  echo "===== $f"; grep -n "server-v\|node-v\|release:node\|release:server" "$f"
done
```

Rename each live reference. Leave any sentence that dates a past release (for example a note that a behaviour "shipped in server-v0.9.0") as written — those name releases that exist under the old tags.

- [ ] **Step 3: Update the docs site**

`apps/docs/content/docs/help/release-notes.mdx` lines 14-15:

```markdown
| Control plane | `cli-server-vX.Y.Z` | `subshell-server-cli-<triple>` — one binary each for `linux-x64`, `linux-arm64`, `darwin-arm64`, each with the web UI embedded |
| Node agent | `cli-node-vX.Y.Z` | `subshell-node-cli-<triple>` — the same three platforms |
```

`apps/docs/content/docs/get-started/install-server.mdx` line 16 and `apps/docs/content/docs/server/headless-install.mdx` line 16: `` `server-vX.Y.Z` `` → `` `cli-server-vX.Y.Z` ``.

`apps/docs/content/docs/get-started/install-server.mdx` line 60:

```bash
gh release download cli-server-vX.Y.Z -p 'subshell-server-cli-darwin-arm64*'
```

`apps/docs/content/docs/reference/version-compatibility.mdx` line 33: `` `node-v*` release`` → `` `cli-node-v*` release``.

`apps/docs/content/docs/reference/environment-variables.mdx` line 18: `` `release:node` `` → `` `release:cli-node` ``.

`apps/docs/content/docs/help/troubleshooting.mdx` line 69: `` `node-v*` GitHub Release`` → `` `cli-node-v*` GitHub Release``.

- [ ] **Step 4: Write the changeset**

Both CLI apps change user-visibly (the install one-liner's tag, the self-update target, the error strings). `@internal/server-web` and the desktop apps are NOT named: the SPA is an ignored workspace whose change rides `@internal/server`, and the desktop apps' own tags did not move.

Create `.changeset/cli-prefixed-release-tags.md`:

```markdown
---
"@internal/server": minor
"@internal/node": minor
---

Release tags now read `<form>-<role>-v`: the control plane publishes under
`cli-server-vX.Y.Z` and the node agent under `cli-node-vX.Y.Z`, matching the
`desktop-server-v` / `desktop-client-v` pair. Artifact file names are
unchanged.

This is a hard cutover with no compatibility fallback: a binary reads only its
own compiled-in prefix, so an installation from before this release will report
itself up to date forever. Reinstall from `install-server.sh` (or re-run the
node enroll one-liner) rather than waiting for self-update.
```

- [ ] **Step 5: Verify the docs build and the whole tree**

The docs package's `build` runs inside `bun run build`, which `lint.yml` runs on every push, so a broken MDX fails CI rather than only the deploy.

```bash
cd /Users/theo/projects/subshell
bunx turbo build --force; echo "build rc=$?"
bun run verify-types; echo "types rc=$?"
bun run lint:check; echo "lint rc=$?"
bun run test; echo "test rc=$?"
bun run rust:check; echo "rust rc=$?"
```

Expected: every `rc=0`.

- [ ] **Step 6: Final sweep for stragglers**

```bash
cd /Users/theo/projects/subshell
grep -rn "server-v\|node-v\|release:node\|release:server" \
  --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.sh" \
  --include="*.yml" --include="*.json" --include="*.md" --include="*.mdx" . 2>/dev/null \
  | grep -v node_modules | grep -v "/dist/" | grep -v "\.turbo" \
  | grep -v "^./docs/superpowers/specs/" | grep -v "^./docs/superpowers/plans/" \
  | grep -v "desktop-server-v\|desktop-client-v\|cli-server-v\|cli-node-v\|release:cli-"
```

Expected: only the deliberate historical citations — `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts` (`server-v0.9.0`), `crates/desktop-core/src/cli_update.rs` (`server-v0.6.0`, `node-v0.8.0`), `apps/server/desktop/src-tauri/src/control.rs` (`server-v0.6.0`), `apps/client/desktop/src-tauri/src/control.rs` (`node-v0.8.0`), and any dated AGENTS.md sentence naming a shipped release. Anything else is a missed site.

- [ ] **Step 7: Commit**

```bash
cd /Users/theo/projects/subshell
git add AGENTS.md apps/server/api/AGENTS.md apps/node/agent/AGENTS.md \
  apps/server/desktop/AGENTS.md apps/client/desktop/AGENTS.md \
  apps/docs/content .changeset/cli-prefixed-release-tags.md
git commit -m "$(cat <<'MSG'
docs: name the cli-server and cli-node release tags

The four AGENTS.md files, the docs site's install and release-notes pages,
and a changeset for the two CLI apps. Dated references to releases that
really shipped under server-v / node-v are left as written.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## After the plan

1. Push and let CI go green.
2. Merge the "chore: release package(s)" version PR.
3. Dispatch one cut: `gh workflow run release.yml -f app=all`. It will create `cli-server-vX.Y.Z` and `cli-node-vX.Y.Z` for the first time, alongside fresh desktop tags.
4. Reinstall this host's `subshell-server` from the new `install-server.sh` — its current binary looks for `server-v*` and will never self-update across the rename.
5. Only after a published cut exists, run the post-cut check by hand: `bash scripts/cli-e2e/published-release.sh`. It greps the public repo for `cli-server-v*` and `cli-node-v*` and will correctly fail until step 3 has published them.

---

### Task 5: Make the update rows read `Subshell <Product> <Form>`

The three update surfaces label their rows by three different rules today. After this task all of them mirror the release components, and `App` is capitalised like every other word in the label.

| surface | before | after |
|---|---|---|
| Subshell Server assistant | `Subshell Server app` / `subshell-server CLI` | `Subshell Server App` / `Subshell Server CLI` |
| Subshell Client assistant | `Subshell Client app` / `subshell CLI` | `Subshell Client App` / `Subshell Node CLI` |
| SPA `/settings/updates` | `Subshell Server app` / `subshell-server CLI` / `Subshell Client app` | the same three, capitalised |

`Subshell Client App` beside `Subshell Node CLI` is deliberate and not a mismatch: that app is where a machine becomes a node, which is why there is no `apps/node/desktop`.

**Files:**
- Modify: `apps/server/desktop/ui/src/lib/update-act.ts:263` (`APP_LABEL`), `:273` (`CLI_LABEL`)
- Modify: `apps/client/desktop/ui/src/lib/update-act.ts:235` (`APP_LABEL`), `:245` (`AGENT_LABEL`)
- Modify: `apps/server/web/src/components/updates/folded-server-row.tsx:81-87` (comment + label), `:107-109` (comment + label)
- Modify: `apps/server/web/src/components/updates/desktop-rows.tsx:54-55`
- Test: `apps/server/desktop/ui/src/__tests__/update-act.test.ts`, `apps/client/desktop/ui/src/__tests__/update-act.test.ts`, `apps/client/desktop/ui/src/__tests__/update-screen.test.tsx`, `apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx`, `apps/server/web/src/components/__tests__/updates-server-row.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the four label constants above. Task 6 and Task 7 assume these strings.

- [ ] **Step 1: Find every assertion that pins a current label**

```bash
cd /Users/theo/projects/subshell
grep -rn "Subshell Server app\|Subshell Client app\|subshell-server CLI\|subshell CLI" \
  --include="*.ts" --include="*.tsx" apps | grep -v "/dist/"
```

Expected: the four definition sites plus their test assertions, including the aria names `"Update subshell CLI"` and `"Update Subshell Client app"`.

- [ ] **Step 2: Change the two desktop assistants' constants**

`apps/server/desktop/ui/src/lib/update-act.ts`:

```typescript
const APP_LABEL = "Subshell Server App";
```

```typescript
const CLI_LABEL = "Subshell Server CLI";
```

`apps/client/desktop/ui/src/lib/update-act.ts`:

```typescript
const APP_LABEL = "Subshell Client App";
```

Rename `AGENT_LABEL` to `NODE_CLI_LABEL` at its definition and its one use (line 435), since Task 7 retires the sense-B `agent` identifiers anyway:

```typescript
const NODE_CLI_LABEL = "Subshell Node CLI";
```

- [ ] **Step 3: Change the SPA rows**

`apps/server/web/src/components/updates/folded-server-row.tsx` — replace the comment at lines 81-87 and its label with:

```tsx
          {/* `Subshell <Product> <Form>`, the one rule all three update
              surfaces follow since 2026-09-18, mirroring the cli-server /
              cli-node / desktop-server / desktop-client release components.
              It read "Subshell Server", which named the product rather than
              the thing this row's versions are about (operator's report,
              2026-09-18). */}
          <p className="truncate font-strong text-label">Subshell Server App</p>
```

and the CLI row's comment at lines 107-108 and its label with:

```tsx
          {/* "CLI", so the version beside it is unambiguously the binary's and
              not this app's — the row above carries the other one. */}
          <p className="truncate font-strong text-label">Subshell Server CLI</p>
```

`apps/server/web/src/components/updates/desktop-rows.tsx` lines 54-55:

```tsx
    { app: "server", name: "Subshell Server App", release: desktop.server },
    { app: "client", name: "Subshell Client App", release: desktop.client },
```

- [ ] **Step 4: Update every assertion found in Step 1**

Change each pinned string to its new spelling, including the aria names — `"Update subshell CLI"` becomes `"Update Subshell Node CLI"` and `"Update Subshell Client app"` becomes `"Update Subshell Client App"`. Re-run Step 1's grep afterwards; it must return only the new spellings.

- [ ] **Step 5: Verify**

```bash
cd /Users/theo/projects/subshell
bun run verify-types; echo "types rc=$?"
bun run lint; bun run lint:check; echo "lint rc=$?"
bun run test; echo "test rc=$?"
```

Expected: every `rc=0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/theo/projects/subshell
git add apps/server/desktop/ui apps/client/desktop/ui apps/server/web/src/components/updates
git commit -m "$(cat <<'MSG'
fix(updates): label every row Subshell <Product> <Form>

Three surfaces labelled their rows three ways: the product name, the binary
name, and a mix of cases. They now mirror the release components, so the
Client app's CLI row says "Subshell Node CLI" instead of "subshell CLI",
which read as the product's CLI in general.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: Say "node", not "agent", in user-visible copy

`agent` names two things in the UI: the harness a subshell runs, and the node daemon. `AGENTS.md` already reserves it for the first — "node" means "a machine that runs agents — the `subshell` daemon" — so this task brings the copy to the vocabulary the docs already state. A person reading "Update the agent" has no way to know it does not mean their Claude Code.

**Three senses. Only the second changes:**

- **Harness** — "Choose an agent", "Install an agent CLI", "Which agent CLI subshells started with this preset will run", "Tells you when an agent is waiting for you", "Start an agent harness subshell". **Keep.** This is the word's correct use.
- **Node daemon** — "Update the agent", "Open the agent log", "Agent binary", "This node's agent did not report how it runs". **Change to node.**
- **`launchd agent`** — Apple's term for a per-user launchd job, in `supervision-dialog.tsx:30`, `supervision-card.tsx:203`, `startup-screen.tsx:41`, `wizard.ts:1159`, `wizard.ts:2007`. **Never change.** It names something Apple named.

**Files:** roughly 35 strings. The Client assistant holds the most (`status-screen.tsx`, `use-node-commands.ts`, `client-flow.ts`, `probe-facts.ts`, `steps.ts`, `choice-screen.tsx`, `subtitles.ts`, `update-screen.tsx`, `app.tsx`); the SPA next (`nodes/node-runtime-card.tsx`, `nodes/node-service-card.tsx`, `nodes/node-log-card.tsx`, `nodes/node-maintenance-card.tsx`, `nodes/node-server-url-card.tsx`, `nodes/node-key-setup.tsx`, `routes/nodes_.$id.logs.tsx`, `routes/nodes_.$id.service.tsx`, `components/settings/reset-card.tsx`); the Server assistant two (`assistant/reset-view.ts:96`, `lib/reset.ts:48`). Plus `apps/docs/content`.

**Interfaces:**
- Consumes: Task 5's labels.
- Produces: no code interface; a copy convention Task 7's identifiers then match.

- [ ] **Step 1: List every candidate**

```bash
cd /Users/theo/projects/subshell
grep -rniE '\bagents?\b' --include="*.ts" --include="*.tsx" \
  apps/server/web/src apps/client/desktop/ui/src apps/server/desktop/ui/src \
  | grep -v "__tests__" | grep -viE "userAgent|LaunchAgent|user_agent|ondragenter"
```

Classify each hit into one of the three senses above before editing. A hit inside a JSDoc or `//` comment counts: a comment saying "the agent" about the daemon is the same confusion for the next reader.

- [ ] **Step 2: Rewrite the node-daemon copy**

Apply these substitutions, keeping each sentence's grammar:

| before | after |
|---|---|
| `Update the agent` | `Update the node` |
| `Install the agent` | `Install the node` |
| `Restart the agent` | `Restart the node` |
| `Open the agent log` | `Open the node log` |
| `Agent binary` | `Node binary` |
| `Could not restart the agent` | `Could not restart the node` |
| `No agent` (Client `steps.ts:45`) | `No node` |
| `the node agent that ships inside this app` | `the node CLI that ships inside this app` |
| `This node's agent did not report how it runs.` | `This node did not report how it runs.` |
| `the agent's own connection` | `the node's own connection` |
| `Nothing on that machine is supervising this agent` | `Nothing on that machine is supervising this node` |
| `This build ships no agent` | `This build ships no node CLI` |
| `Node artifacts (the agent binaries this plane serves)` | `Node artifacts (the node binaries this plane serves)` |

For the one definition sentence in `status-screen.tsx:338`, say what it is without the overloaded word:

```tsx
            The node is the small program that holds this machine's connection to the control plane and starts the
```

- [ ] **Step 3: Leave the harness copy alone, and prove it**

```bash
cd /Users/theo/projects/subshell
grep -rn "agent harness\|Choose an agent\|an agent CLI\|Loading agents\|No agent installed\|agent is waiting" \
  --include="*.tsx" --include="*.ts" apps/server/web/src | grep -v "__tests__"
```

Expected: unchanged from before this task. These are sense A.

- [ ] **Step 4: Update the docs site**

```bash
cd /Users/theo/projects/subshell
grep -rniE '\bagents?\b' apps/docs/content | grep -viE "userAgent|LaunchAgent"
```

Apply the same three-sense classification. `apps/docs/content/docs/nodes/` is where most of the sense-B prose lives.

- [ ] **Step 5: Update the tests that assert the changed copy**

```bash
cd /Users/theo/projects/subshell
bun run test 2>&1 | grep "^(fail)"
```

Every failure here is a test pinning a sentence this task rewrote. Update the assertion to the new wording — do not weaken it to a substring that would pass either way.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/theo/projects/subshell
bunx turbo build --force; echo "build rc=$?"
bun run verify-types; echo "types rc=$?"
bun run lint; bun run lint:check; echo "lint rc=$?"
bun run test; echo "test rc=$?"
```

```bash
git add apps/server/web apps/client/desktop/ui apps/server/desktop/ui apps/docs/content
git commit -m "$(cat <<'MSG'
fix(copy): call the node daemon a node, not an agent

"Agent" named two things a user sees: the harness in a pane, and the
program that makes a machine a node. AGENTS.md already reserves the word
for the first; the UI copy had drifted. Harness-sense "agent" is unchanged,
and "launchd agent" stays as Apple's own term.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Rename the sense-B identifiers

Same three senses, applied to code. **A blanket find-and-replace breaks this repo** — `userAgent` is the HTTP header and `LaunchAgents` is a real directory under `~/Library`.

**Never touch:** `userAgent`, `previousUserAgent`, `deviceNameFromUserAgent`, `user_agent`, `user_agent_for` (the `User-Agent` header); `LaunchAgent`, `LaunchAgents` (Apple's launchd, and filesystem paths); `ondragenter` (a false positive — it merely contains the letters).

**Keep as `agent` (sense A, the harness):** `defaultAgentId`, `buildAgentOptions`, `readAgentInventory`, `installBuiltInAgent`, `installedAgent`, `pickAgent`, `openAgentPicker`, `installAgent`, `NoAgent`, `AGENT_OVERRIDES`, `setAgentInstallDepsForTests`.

**Rename (sense B, the node daemon):**

| before | after |
|---|---|
| `minAgentVersion` / `MIN_AGENT_VERSION` / `minAgent` | `minNodeVersion` / `MIN_NODE_VERSION` / `minNode` |
| `NodeAgentFacts` | `NodeFacts` |
| `node_install_agent` | `node_install_cli` |
| `resolveAgentBinary` | `resolveNodeBinary` |
| `readAgentLogSlice` | `readNodeLogSlice` |
| `comparable_agent_version` / `parse_agent_version` | `comparable_node_version` / `parse_node_version` |
| `isOfflineAgent` / `markStaleAgentsOffline` | `isOfflineNode` / `markStaleNodesOffline` |
| `pressInstallsAgent` | `pressInstallsNodeCli` |
| `installedAgentHere` / `installingAgent` / `isNewAgentProcess` | `installedNodeHere` / `installingNode` / `isNewNodeProcess` |
| `decide_agent` / `install_agent` | `decide_node` / `install_node` |
| `RunningAgent` | `RunningNode` |
| `mkAgent` / `mkAgentNode` / `seedAgentRow` / `attachFakeAgent` (test helpers) | `mkNode` / `mkNodeRow` / `seedNodeRow` / `attachFakeNode` |

**Two are wire-visible, and both are safe only because of this plan's cutover:**

- **`minAgentVersion` is a field in the signed `release-manifest.json`** (`packages/subshell-protocol/src/releases.ts:185`), so renaming it changes bytes a publisher signs and every component verifies. It is safe here *only* because Task 1 already forces every component to be re-cut together and every pre-rename release to be unreadable. Renaming it in a release where the tags did not move would strand every installed binary. Say so in the JSDoc at the field.
- **`node_install_agent` is a Tauri command name**, listed in `apps/client/desktop/src-tauri/capabilities/*.json` and pinned by `ui/src/__tests__/ipc-acl.test.ts`. The Rust `#[tauri::command]` function, the capability entry and the TypeScript `desktopInvoke` call must move in one commit, or the ACL test fails — which is the test doing its job.

**Files:** `packages/subshell-protocol/src/releases.ts`, `versions.ts` and their tests; `apps/server/api/src/services/releases.ts` and the nodes routes; `apps/server/web/src/types/updates.ts` and the updates components; both desktop apps' `ui/src/lib/` and `src-tauri/src/`; `crates/desktop-core`; `e2e/`.

**Interfaces:**
- Consumes: Tasks 5 and 6.
- Produces: the renamed symbols above. Nothing later depends on them.

- [ ] **Step 1: Confirm the inventory against the tree**

```bash
cd /Users/theo/projects/subshell
grep -rhoE '\b[A-Za-z_$][A-Za-z0-9_$]*[Aa]gent[A-Za-z0-9_$]*\b' \
  --include="*.ts" --include="*.tsx" --include="*.rs" apps packages scripts crates e2e \
  | sort | uniq -c | sort -rn
```

Classify every name with a count into one of the four buckets above before renaming anything. A name not in any list is a name to decide on, not to sweep.

- [ ] **Step 2: Rename the protocol package first, and say why the manifest field may move**

In `packages/subshell-protocol/src/releases.ts`, rename the interface field and update its JSDoc:

```typescript
  /**
   * `MIN_NODE_VERSION` as of this build.
   *
   * This field is inside the SIGNED manifest, so its name is wire format: a
   * verifier reading an older release finds no such key. It was renamed from
   * `minAgentVersion` on 2026-09-18, in the same change that moved the release
   * tags to `cli-server-v`/`cli-node-v` — that cutover already makes every
   * pre-rename release unreadable to a current build, so this costs nothing
   * extra. Renaming it on its own would strand every installed binary.
   */
  minNodeVersion: string;
```

Rename `MIN_AGENT_VERSION` to `MIN_NODE_VERSION` in `packages/subshell-protocol/src/versions.ts`, then update `parseReleaseManifest`'s destructure and validation, both release-manifest writers (`apps/server/api/src/scripts/release.ts`, `apps/node/agent/src/scripts/release.ts`), `scripts/merge-release-manifest.ts`, and `packages/subshell-protocol/src/release-signature.ts`.

```bash
bunx turbo build --force --filter=@internal/subshell-protocol
ls -la packages/subshell-protocol/dist/index.d.ts
bun test packages/subshell-protocol; echo "rc=$?"
```

- [ ] **Step 3: Rename the Tauri command in one commit's worth of edits**

Move all four together — the Rust function, the ACL capability entries, the TypeScript caller, and the test:

```bash
cd /Users/theo/projects/subshell
grep -rn "node_install_agent" apps/client/desktop
```

Rename each occurrence to `node_install_cli`, then:

```bash
bun test apps/client/desktop/ui/src/__tests__/ipc-acl.test.ts; echo "rc=$?"
```

Expected: `rc=0`. A failure here means one of the four sites was missed — that is exactly what the test is for.

- [ ] **Step 4: Rename the remaining sense-B identifiers**

Work one name at a time from Step 1's classified list, renaming across `.ts`, `.tsx` and `.rs` together, and running `bun run verify-types` after each. Renaming several at once makes a compile error ambiguous about which rename caused it.

- [ ] **Step 5: Prove the keep-lists survived**

```bash
cd /Users/theo/projects/subshell
grep -rc "userAgent\|LaunchAgent" --include="*.ts" --include="*.tsx" --include="*.rs" apps crates \
  | grep -v ":0" | head
grep -rn "defaultAgentId\|buildAgentOptions\|readAgentInventory\|openAgentPicker" \
  --include="*.ts" --include="*.tsx" apps | wc -l
```

Expected: both still present in the same places. A zero here means the sweep ate a sense it was told to keep.

- [ ] **Step 6: Verify everything, Rust included**

```bash
cd /Users/theo/projects/subshell
bunx turbo build --force; echo "build rc=$?"
bun run verify-types; echo "types rc=$?"
bun run lint; bun run lint:check; echo "lint rc=$?"
bun run test; echo "test rc=$?"
bun run rust:check; echo "rust rc=$?"
```

Expected: every `rc=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/theo/projects/subshell
git add -A
git commit -m "$(cat <<'MSG'
refactor: name the node daemon "node" in code as well as copy

Sense-B identifiers (the daemon) become node-named; sense-A ones (the
harness a subshell runs) keep "agent", which is the word's correct use.
userAgent and LaunchAgents are untouched — the HTTP header and Apple's
launchd, neither of them ours to rename.

minAgentVersion -> minNodeVersion changes a field inside the SIGNED release
manifest. It rides the tag cutover in this same series, which already makes
every pre-rename release unreadable to a current build; alone it would have
stranded every installed binary.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```
