# SSH Anywhere - Plan 2: The Launcher Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Milestone 1's machine half: an operator whose node has `ssh_enabled` on can launch an interactive SSH-terminal pane at any sshd host from the API - alias discovery, `ssh -G` resolve, a rendered `-F` config, a scoped agent socket, and owner-only input - with a CI e2e proving it against a real sshd.

**Architecture:** The plane composes ssh invocations from approved snapshots (the grammar ported in tier 1), ships them over the existing signed `sendCommand` transport and the existing `launch` frame, and the node owns only its own facts: which binary answers `ssh`, where its files live. Discovery/resolve are two new node commands; the pane itself is a new built-in `ssh` harness of type `terminal`, so streaming, logging, capture, and sharing are the ordinary pane path untouched. The reference lineage on `feat/ssh-support` (read with `git show feat/ssh-support:<path>`, available in this linked worktree) carries the Gate A renderer and agent handlers this plan adapts to interactive use.

**Tech Stack:** Bun + TypeScript, Elysia + Kysely (SQLite), tmux, OpenSSH, `@internal/pane-runtime`, `@internal/subshell-protocol`, Playwright-free e2e (REST + direct tmux probes per existing e2e specs).

## Global Constraints

- Work ONLY in `/home/theo/projects/wt-ssh-anywhere-2` (branch `feat/ssh-anywhere-2`). Never touch `/home/theo/projects/subshell` or `/home/theo/projects/wt-ssh-anywhere`.
- Tests run with `env -u SHELLOPTS -u BASHOPTS bun test <files>`; check the reported file count (bun silently skips missing paths).
- No `NODE_PROTOCOL_VERSION` value changes except the one bump Task 4 specifies.
- No `await import()` anywhere; static imports only.
- No U+2014 or U+2013 in any prose or shipped string (`lint:prose` at the boundary).
- Key material, challenges, signatures, and config file CONTENT never enter logs, argv, audit rows, or notifications (spec §13). Audit metadata names ids and hosts only.
- `shellQuote` (from `@internal/subshell-ai/plugin-api`, re-exported by `@internal/pane-runtime` as `shellQuote` - import from whichever site the surrounding file already uses) on every token of the pane command string; the pane launch IS a shell string.
- Every wire-carrying snapshot is re-validated with `parseSshConnectionSnapshot` at each trust boundary (frame parse, agent receive, renderer entry) - the tier-1 grammar doc calls this the load-bearing defense, not the plane's approval.
- Package versions pinned; after any `bun add` run `bun run syncpack-fix` then `bun install`; a workspace version change to `bun.lock` needs `bun run lint:lockfile:fix`.
- Migration additions must move `LATEST_BACKUP_MIGRATION` and the older-snapshot fixture strip-set in the same commit (tier 1's boundary lesson, commit 0ebd6cee).
- Focused verification while iterating (`bunx turbo verify-types --filter=<pkg>`, `bunx biome check <paths>`, the touched test files); the full `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` only at Task 10.
- Commit as theo@suteki.nu; do not push except where a task says so.

## File Structure (map)

```
packages/subshell-protocol/src/
  node-frames.ts                      # MODIFY: ssh command arms, launch.ssh field, version bump note
  node-results.ts                     # MODIFY: parseNodeSshAliasList, parseNodeSshResolveOutcome
  __tests__/node-frames.test.ts       # MODIFY: ssh arms + launch.ssh cases
packages/pane-runtime/src/
  ssh/ssh-render.ts                   # CREATE: interactive config + option-token builders (adapted port)
  ssh/__tests__/ssh-render.test.ts    # CREATE: golden renders, refusal cases
  registry.ts                         # MODIFY: register the ssh harness
  index.ts                            # MODIFY: named exports of the render builders
packages/plugins/ssh/                 # CREATE: built-in ssh harness (type terminal)
apps/node/agent/src/
  commands/ssh-shared.ts              # CREATE: sshBin ladder + connecting home
  commands/ssh-aliases.ts             # CREATE: the two discovery/resolve handlers (gated)
  commands/index.ts                   # MODIFY: two dispatch arms
  commands/launch.ts                  # MODIFY: ssh config write block
  commands/report.ts                  # MODIFY: ssh config cleanup at exit-watch observation
  __tests__/commands-ssh.test.ts      # CREATE: handler matrix incl. gate refusal
  __tests__/launch-ssh.test.ts        # CREATE: config write modes + skip-when-absent
apps/server/api/src/
  db/migrations/0048-ssh-launch-and-saved-hosts.ts   # CREATE
  db/migrations/__tests__/0048-...test.ts            # CREATE
  db/types/ssh-saved-hosts.db-types.ts               # CREATE
  db/types/subshells.db-types.ts                     # MODIFY: ssh column
  db/repositories/ssh-saved-hosts.repository.ts      # CREATE
  services/nodes/ssh-rpc.ts                          # CREATE: sendCommand wrappers + validators
  services/ssh-launch.service.ts                     # CREATE: gate, resolve, compose, audit
  services/subshell-manager.service.ts               # MODIFY: createSubshell sshSnapshot param
  services/nodes/local-launcher.ts                   # MODIFY: write ssh config pre-spawn (local)
  services/nodes/remote-launcher.ts                  # MODIFY: ship ssh block on the frame
  services/nodes/node-launcher.ts                    # MODIFY: LaunchPlan.ssh
  api/ssh/                                           # CREATE: index + aliases/resolve/launch/saved-hosts routes
  lib/ssh-pane-access.ts                             # CREATE: the one ssh-input predicate
  services/subshells.service.ts                      # MODIFY: sendSubshellInput + execInTerminal owner-only rule
  ws/attach-resolve.ts                               # MODIFY: resolveAttach canInput ssh carve-out
  commands/__tests__/backup-cli-subprocess.test.ts   # MODIFY: fixture strip-set (0047+0048)
  services/backups/database.ts                       # MODIFY: LATEST_BACKUP_MIGRATION
docs/security.md                                     # MODIFY §10: ssh.launch
.claude/rules/security-context.md                    # MODIFY: mirror the §10 line
e2e/tests/22-ssh-terminal.spec.ts                    # CREATE: the M1 proof
.changeset/ssh-launcher-tier.md                      # CREATE at Task 10
```

## Decisions this plan has already made (do not relitigate in implementation)

1. **No new launch pipeline.** The ssh pane is a terminal-type harness whose `preset.flags` are the ssh option tokens. `buildCommand` = `[binary, ...flags]`, exactly the terminal plugin's shape. Working dir = the existing presetless-terminal "launch node's home" default (spec 2026-10-01 machinery already in `subshells.service.ts:494`).
2. **The plane renders, the node executes.** `renderSshConfigContents` + option-token builder live in `@internal/pane-runtime` and run on the plane (which already imports pane-runtime for `LocalLauncher`); the node contributes only binary resolution (the `resolve` rule travels, the path is the node's own ladder) and file placement under its own `dataDir`.
3. **`SSH_AUTH_SOCK` rides `subshellEnv`.** The pane's command IS the ssh process, so the pane env is the ssh env; adding the snapshot's agent socket to `subshellEnv` for ssh launches only is the scoped exception spec §5.4 names. Non-ssh panes never carry it (`curatedEnv` untouched). Password/keyboard-interactive auth is NOT disabled: an interactive pane may answer a password prompt like any terminal (the tier-1 BatchMode/key-only posture belonged to supervised runs).
4. **Config file lifecycle:** written by whoever spawns (agent `execLaunch` block mirroring the MCP-file block; `LocalLauncher.launch` for local), at `<dataDir>/ssh/<subshellId>/config` (0600 in a 0700 dir). Cleaned at pane death by the exit path: the agent's exit watcher unlinks the derived path when the pane's meta names harness `ssh`; delete-time cleanup rides the existing `remove_paths`/`subshellArtifacts` seam (paths under `dataDir` are policy-legal there - verified `basics.ts:260` permits any `pathAllowed` name, not only `.log`).
5. **Input authority:** `subshells.ssh` (nullable JSON snapshot column) is the kind fact. Input (REST input, exec, MCP-via-REST, WS live frames) refuses when `row.ssh !== null` unless the acting principal is the row's OWNER account. Note the two resolutions: a bearer subshell key on a REST route resolves as its owner (boost/shares off), so an ssh pane's own key would otherwise slip through the owner comparison - the rule therefore also refuses `actor === "subshell-key"` explicitly: an ssh pane must not type into itself.
6. **Protocol bump 16 -> 17** (Task 4): a tier-1 agent (protocol 16, no ssh arms) that ignores the launch frame's `ssh` member would spawn a bare `ssh` pane with no `-F` config - the ambiguity §4.3's gate doctrine refuses to live with. Lagging agents are HELD (only `update`) until crossed; server-first sequencing ships in the changeset, same sentence class as tier 1's.
7. **Restarts:** an ssh pane refuses `POST /:id/restart` with a named 409 (reconnect from the launcher instead). Auto-restart rows (`restartOnExit`) are forced off at create for ssh panes.
8. **Audit:** one new event `ssh.launch`, metadata `{ nodeId, destination, subshellId }`. Saved-host CRUD is unaudited (the prompts precedent).
9. **Discovery/resolve/gate on the node:** every ssh node command first consults the tier-1 fail-closed mirror (`readSshEnabled`/`sshAllowed` in `apps/node/agent/src/ssh-enabled.ts`); a machine answers `ssh disabled on this node` regardless of what the plane believes.
10. **MCP:** ssh panes get their subshell token (row infra + exit hook) but NO MCP registration file and no MCP dialect - the remote shell hosts no local process that could use it.

---

### Task 1: Protocol - ssh command arms, result validators, launch `ssh` field

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (union near `:650`, parser near the `case "remove_paths"` arm at `:1538`)
- Modify: `packages/subshell-protocol/src/node-results.ts` (append the two validators; the file already imports `parseSshConnectionSnapshot`, `isSshErrorCode`, `SSH_MAX_DISCOVERED_ALIASES`, and the ssh result types)
- Modify: `packages/subshell-protocol/src/__tests__/node-frames.test.ts` (or the file's existing per-command-case test home - locate by grepping `case "remove_paths"` in `__tests__/`)
- Test: `packages/subshell-protocol/src/__tests__/node-results-ssh.test.ts` (CREATE)

**Interfaces:**
- Consumes: `SshNodeCommandBody` + `parseSshNodeCommandBody` + `SSH_COMMAND_TYPES` from `./ssh-frames.js` (already on this branch, previously unwired - this task IS the wiring), `SshConnectionSnapshotWire` + `parseSshConnectionSnapshot` from `./ssh-config.js`, `NodeSshAliasListResult` + `NodeSshResolveOutcomeWire` from `./ssh-results.js`, fixture helpers `makeAliasList` / `makeResolveOk` / `makeResolveRefused` from `./__tests__/fixtures/ssh-fixtures.ts` (already present).
- Produces: `parseNodeCommandBody` answers `ssh_discover_aliases` / `ssh_resolve_config`; the `launch` arm accepts optional `ssh?: { configPath: string; fileContent: string }` (fileContent ≤ `SSH_CONFIG_FILE_MAX_BYTES`, a new const in `ssh-limits.ts` = 65536); `parseNodeSshAliasList` / `parseNodeSshResolveOutcome` exported from `node-results.js` and through the package barrel `src/index.ts`.

- [ ] **Step 1: Read the reference verbatim**

```bash
git show feat/ssh-support:packages/subshell-protocol/src/node-results.ts | sed -n '548,589p'
git show feat/ssh-support:packages/subshell-protocol/src/node-frames.ts | sed -n '1681,1685p'
```

The first block is the two parsers to port (drop nothing; their JSDoc is load-bearing). The second is the delegation arm shape.

- [ ] **Step 2: Write the failing tests**

Create `packages/subshell-protocol/src/__tests__/node-results-ssh.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseNodeSshAliasList, parseNodeSshResolveOutcome } from "../node-results.js";
import { makeAliasList, makeResolveOk, makeResolveRefused } from "./fixtures/ssh-fixtures.js";

describe("parseNodeSshAliasList", () => {
  test("narrows a well-formed answer", () => {
    expect(parseNodeSshAliasList(makeAliasList({ aliases: ["box-a", "box-b"] }))).toEqual({
      aliases: ["box-a", "box-b"],
      includeCycle: false,
      truncated: false,
    });
  });
  test("refuses a past-cap list whole (the truncated flag depends on the cap)", () => {
    expect(parseNodeSshAliasList(makeAliasList({ aliases: Array.from({ length: 501 }, (_, i) => `h${i}`) }))).toBeNull();
  });
  test("refuses non-boolean flags and non-string members", () => {
    expect(parseNodeSshAliasList({ aliases: ["x"], includeCycle: "no", truncated: false })).toBeNull();
    expect(parseNodeSshAliasList({ aliases: [1], includeCycle: false, truncated: false })).toBeNull();
  });
});

describe("parseNodeSshResolveOutcome", () => {
  test("accepted arm runs the FULL snapshot validator (no unvalidated snapshot enters the plane)", () => {
    const ok = makeResolveOk();
    expect(parseNodeSshResolveOutcome(ok)).not.toBeNull();
    const tampered = structuredClone(ok);
    (tampered as { snapshot: { host: string } }).snapshot.host = "-oProxyCommand=evil";
    expect(parseNodeSshResolveOutcome(tampered)).toBeNull();
  });
  test("connectingAccount is optional text, never another type", () => {
    expect(parseNodeSshResolveOutcome(makeResolveOk())?.accepted === true).toBe(true);
    const withAccount = structuredClone(makeResolveOk()) as { connectingAccount?: unknown };
    withAccount.connectingAccount = 7;
    expect(parseNodeSshResolveOutcome(withAccount)).toBeNull();
  });
  test("refused arm names a known code and string settings", () => {
    expect(parseNodeSshResolveOutcome(makeResolveRefused())).toEqual({
      accepted: false,
      code: "unsupported_setting",
      settings: ["ProxyCommand"],
    });
    expect(parseNodeSshResolveOutcome({ accepted: false, code: "not_a_code", settings: [] })).toBeNull();
  });
});
```

Extend the existing `parseNodeCommandBody` test home with cases (match that file's local style - it tests one JSON object per case):

```ts
test("ssh discovery/resolve arms delegate to the ssh grammar", () => {
  expect(parseNodeCommandBody({ type: "ssh_discover_aliases" })).toEqual({ type: "ssh_discover_aliases" });
  expect(parseNodeCommandBody({ type: "ssh_resolve_config", alias: "box-a" })).toEqual({
    type: "ssh_resolve_config",
    alias: "box-a",
  });
  // alias hygiene lives in ssh-frames' parser (port-verified): option-like and whitespace are refused there
  expect(parseNodeCommandBody({ type: "ssh_resolve_config", alias: "-x" })).toBeNull();
  expect(parseNodeCommandBody({ type: "ssh_resolve_config", alias: "a b" })).toBeNull();
});

test("launch accepts an ssh block and refuses malformed ones", () => {
  // Reuse this file's existing well-formed launch fixture; add the ssh member to a clone:
  //  { ...launchFixture, ssh: { configPath: "/d/ssh/s1/config", fileContent: "Host *\n" } } -> parses,
  //  configPath "relative" -> null; fileContent past SSH_CONFIG_FILE_MAX_BYTES -> null; ssh: "x" -> null.
});
```

(For the launch cases, copy this test file's existing minimal-valid `launch` object verbatim as the base clone; do not hand-roll a new one.)

- [ ] **Step 3: Run to verify failure**

`env -u SHELLOPTS -u BASHOPTS bun test packages/subshell-protocol/src/__tests__/node-results-ssh.test.ts` - FAIL (exports missing). Confirm the file COUNTS as 1 file.

- [ ] **Step 4: Implement**

In `ssh-limits.ts`, append:

```ts
/** Largest ssh_config the wire carries in one `launch.ssh.fileContent` member (a rendered snapshot config is hundreds of bytes; this bounds a hostile plane). */
export const SSH_CONFIG_FILE_MAX_BYTES = 65_536;
```

In `node-frames.ts`: add to the `NodeCommandBody` union beside the other arms:

```ts
  | { type: "ssh_discover_aliases" }
  | { type: "ssh_resolve_config"; alias: string }
```

In `parseNodeCommandBody`, beside `case "remove_paths":`:

```ts
    case "ssh_discover_aliases":
    case "ssh_resolve_config":
      // Delegation, not a second parser: the SSH grammar (both arms, one
      // file) lives in ssh-frames.ts beside the commands it narrows.
      return parseSshNodeCommandBody(value);
```

Import `parseSshNodeCommandBody` from `./ssh-frames.js`. In the `launch` arm's validator add (beside the `mcp` member's handling):

```ts
      if ("ssh" in value) {
        const ssh = value.ssh as unknown;
        if (
          typeof ssh !== "object" ||
          ssh === null ||
          typeof (ssh as { configPath?: unknown }).configPath !== "string" ||
          !(ssh as { configPath: string }).configPath.startsWith("/") ||
          (ssh as { configPath: string }).configPath.length > SSH_PATH_MAX_CHARS ||
          typeof (ssh as { fileContent?: unknown }).fileContent !== "string" ||
          (ssh as { fileContent: string }).fileContent.length > SSH_CONFIG_FILE_MAX_BYTES
        ) {
          return null;
        }
      }
```

and carry `...( "ssh" in value ? { ssh: value.ssh as { configPath: string; fileContent: string } } : {} )` into the returned narrowed object. Add `ssh?: { configPath: string; fileContent: string }` to the TS type of the launch arm with a doc comment naming the 0600 + node-side-path-policy contract.

In `node-results.ts`, port the two validators from the reference verbatim (Step 1), fixing only the import sites (this branch's `ssh-errors.ts` exports `isSshErrorCode` already) and the section banner: `/* ssh discovery/resolution (the tier-1 wire types, dispatched from here on) */`. Export both from `src/index.ts`.

- [ ] **Step 5: Run to verify pass**

`env -u SHELLOPTS -u BASHOPTS bun test packages/subshell-protocol/src/__tests__/` - all green, count the files. Then `bunx turbo verify-types --filter=@internal/subshell-protocol`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(protocol): ssh command arms delegate to the tier-1 grammar, ssh launch block, result validators join node-results"
```

---

### Task 2: pane-runtime - the interactive renderer

**Files:**
- Create: `packages/pane-runtime/src/ssh/ssh-render.ts`
- Create: `packages/pane-runtime/src/ssh/__tests__/ssh-render.test.ts`
- Modify: `packages/pane-runtime/src/index.ts` (named exports - the ssh barrel pattern from tier 1's Task 2; this module imports NO `node:` builtins except NONE after dropping `sshChildEnv` - keep it pure so it stays Metro-safe)

**Interfaces:**
- Consumes: `parseSshConnectionSnapshot`, `SshConnectionSnapshotWire`, `SshHopWire`, `SSH_PATH_MAX_CHARS` from `@internal/subshell-protocol`; `shellQuote` from `../plugin-api` re-export (`../shell.ts` or wherever the ssh dir's siblings import it from - `ssh-discover.ts` shows the local spelling).
- Produces (consumed by Tasks 5-7): `renderSshConfigContents(snapshot): string`, `sshOptionTokens(snapshot): string[]` (the PLACEHOLDER-free option argv: everything after the binary), `sshDestinationToken(snapshot): string` (the `-- host` tail as one argv entry `host`), and `buildSshConfigPath(dataDir: string, subshellId: string): string` = `${dataDir}/ssh/${subshellId}/config` (rejects a non-absolute dataDir / an id failing `/^[a-zA-Z0-9_-]{1,64}$/` by THROWING - it is an impossible-state guard at composition sites, matching the codebase's path-composition doctrine).

- [ ] **Step 1: Read the reference in full**

```bash
git show feat/ssh-support:packages/pane-runtime/src/ssh/ssh-render.ts
git show feat/ssh-support:packages/pane-runtime/src/ssh/__tests__/ssh-render.test.ts
```

- [ ] **Step 2: Write the failing tests** (`ssh-render.test.ts`)

Adapt the reference tests to the interactive policy. Required cases (write full assertions in the reference's style; the three policy changes below are the ONLY deviations):

```ts
test("Host * carries the interactive-terminal policy, not BatchMode", () => {
  const out = renderSshConfigContents(baseSnapshot());
  expect(out).toContain("    StrictHostKeyChecking accept-new");
  expect(out).not.toContain("BatchMode");
  expect(out).not.toContain("PasswordAuthentication no");
  expect(out).not.toContain("UserKnownHostsFile /dev/null"); // default known_hosts is the M1 authority (spec §9)
  expect(out).toContain("    ForwardAgent no");
  expect(out).toContain("    ControlPath none");
  expect(out).toContain("    EscapeChar none");
  expect(out).toContain("    RemoteCommand none");
  expect(out).toContain("    CanonicalizeHostname no");
});
test("known-hosts refs render when the snapshot names them", () => {
  const out = renderSshConfigContents(baseSnapshot({ knownHostsFiles: ["/home/theo/.ssh/known_hosts"] }));
  expect(out).toContain("    UserKnownHostsFile /home/theo/.ssh/known_hosts");
});
test("identity/cert refs render quoted only when they need quoting", () => {
  /* port the reference's configPathValue quoting cases verbatim */
});
test("sshOptionTokens is destination-scoped only", () => {
  const tokens = sshOptionTokens(baseSnapshot({ port: 2222, user: "root", proxyJumps: [{ host: "j1", user: null, port: 22 }] }));
  expect(tokens).toEqual(["-F", "/data/ssh/s1/config", "-p", "2222", "-l", "root", "-o", "ProxyJump=j1"]);
});
test("refuses an unrenderable snapshot at the last station before argv", () => {
  expect(() => sshOptionTokens({ ...baseSnapshot(), host: "-oProxyCommand=x" } as never)).toThrow(/not renderable/);
});
```

- [ ] **Step 3: Run to verify failure** - FAIL (module absent).

- [ ] **Step 4: Implement `ssh-render.ts`**

Port the reference file with these exact deltas (everything else - the header, `assertRenderable`, `configPathValue`, the doc discipline - carries verbatim):

1. `MANDATORY_POLICY`: remove `["BatchMode","yes"]`, `["PasswordAuthentication","no"]`, `["KbdInteractiveAuthentication","no"]`, `["HostbasedAuthentication","no"]`; change `StrictHostKeyChecking` to `"accept-new"`; drop the reference's GSSAPI comment but KEEP `["GSSAPIAuthentication","no"]`. Header comment for the array: "the M1 interactive-terminal policy (spec 2026-10-07 §5.2/§9): every hop stays confined (forwarding, control sockets, local commands, the escape menu all die here because ssh spawns ProxyJump children that re-read THIS file), while the session itself stays a terminal: auth methods are the server's to offer and a changed host key is OpenSSH's own hard block."
2. `knownHostsLines`: `if (files.length === 0) return [];` with the comment "absent renders nothing: ssh's own default `~/.ssh/known_hosts` is the M1 trust store (§9) - the tier's product wrote /dev/null because its BatchMode posture made silence fail closed; here silence IS the policy."
3. Split the reference's `buildSshInvocation`: `sshOptionTokens(snapshot)` returns everything after the binary EXCEPT the trailing `["--", host]` (`-p` always, `-l` only when set, HostKeyAlias/ProxyJump only when set) and `sshDestinationToken(snapshot)` returns `snapshot.host`. Both call `assertRenderable`. `renderSshConfigContents` carries verbatim (minus delta 1/2).
4. Do NOT port `sshChildEnv`, `remoteCommandLine`, `-tt`/`forceTty` handling, or the `SshInvocationInput` type (this tier's pane has no remote command and allocates its PTY through tmux, so `ssh` auto-requests a tty; `-F`/option tokens ride the argv, the config path is composed by the caller into `-F`).
5. `buildSshConfigPath` as specified in Produces, with the doc: "the derived per-pane config path is composed here so plane and node agree byte-for-byte from the two facts each already holds (dataDir, subshellId) - no path ever travels the wire."

Add to `packages/pane-runtime/src/index.ts` the three/four named exports beside the tier-1 ssh exports.

- [ ] **Step 5: Run to verify pass** - `env -u SHELLOPTS -u BASHOPTS bun test packages/pane-runtime/src/ssh/` green; `bunx turbo verify-types --filter=@internal/pane-runtime`; then `bunx turbo build --filter=@internal/pane-runtime` (the Metro trap rule: this module adds no `node:` import - a grep proves it).

- [ ] **Step 6: Commit** - `git commit -am "feat(pane-runtime): interactive ssh renderer - every-hop confinement, terminal auth left to the server"`

---

### Task 3: The built-in `ssh` harness plugin

**Files:**
- Create: `packages/plugins/ssh/package.json`, `packages/plugins/ssh/src/index.ts`, `packages/plugins/ssh/src/__tests__/ssh.test.ts`, `packages/plugins/ssh/icon.svg`, `packages/plugins/ssh/tsconfig.json`, `packages/plugins/ssh/turbo.json` (all copied structure from `packages/plugins/terminal`, renamed)
- Modify: `packages/pane-runtime/src/registry.ts` (import + built-in list, beside the terminal entry at `:61`)
- Modify: `packages/pane-runtime/src/generated/embedded-plugins.ts` (the embedded-bytes list the registry falls back to - copy how `terminal` is carried; if the file is generated by a script, run the script)
- Modify: root `bun.lock` + any workspace glob is already covered by `packages/plugins/*` (verify, else add)
- Test: registry lists `ssh` among built-ins (extend the registry's existing built-in census test - grep `terminal` in `packages/pane-runtime/src/__tests__/` to find it)

**Interfaces:**
- Consumes: `@subshell-ai/plugin-api` types exactly as the terminal plugin does.
- Produces: harness `id: "ssh"`, `type: "terminal"`, `detect: { binaryName: "ssh", envOverride: "SUBSHELL_SSH_PATH", knownPaths: ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"] }`, `capabilities: []`, `buildCommand({binary, preset, extraFlags}) => [binary, ...preset.flags, ...(extraFlags ?? [])]`.

- [ ] **Step 1: `cat packages/plugins/terminal/package.json packages/plugins/terminal/src/index.ts packages/plugins/terminal/turbo.json packages/plugins/terminal/tsconfig.json`; create the ssh package as a faithful rename** (id/name `"ssh"`/`"SSH"`; description "An interactive SSH session to any sshd host."; the detect block exactly as in Interfaces above - `envOverride` `SUBSHELL_SSH_PATH` matches `apps/node/agent`'s operator seam, ported in Task 4's `ssh-shared.ts`; keep the "why this plugin declares a detect block at all" doc-comment adapted: ssh IS a binary the same way).
- [ ] **Step 2: The failing census test** - extend the built-ins test to assert `"ssh"` is among `allHarnesses()` ids and `getHarness("ssh").type === "terminal"`; run, watch it fail.
- [ ] **Step 3: Wire registry.ts + embedded-plugins**, re-run green.
- [ ] **Step 4: `bun install` (workspace), `bunx turbo build`, verify-types for pane-runtime; run the plugins-ssh test file.** Confirm `bun run lint:lockfile` clean (workspace version field exception - run `bun run lint:lockfile:fix` if bun recorded the new workspace).
- [ ] **Step 5: Commit** - `"feat(plugins): built-in ssh harness - the terminal launch, pointed at ssh"`

---

### Task 4: Agent - discovery/resolve handlers behind the SSH gate + protocol bump

**Files:**
- Create: `apps/node/agent/src/commands/ssh-shared.ts`, `apps/node/agent/src/commands/ssh-aliases.ts`
- Modify: `apps/node/agent/src/commands/index.ts` (dispatch arms), `apps/node/agent/src/commands/context.ts` (the `Cmd` map gains the two types - find its definition by grep `export type Cmd`)
- Modify: `packages/subshell-protocol/src/node-frames.ts` (`NODE_PROTOCOL_VERSION` 16 to 17 + the changelog comment at `:100-150` per its own history rule)
- Test: Create `apps/node/agent/src/__tests__/commands-ssh.test.ts`

**Interfaces:**
- Consumes: tier-1 gate (`readSshEnabled`, `sshAllowed` from `../ssh-enabled.js`), pane-runtime `discoverSshAliases` / `resolveSshAliasConfig` / `defaultSshConfigPath`, protocol `parseNodeSshAliasList` / `parseNodeSshResolveOutcome` (Task 1), `findBinary` from pane-runtime.
- Produces: `execSshDiscoverAliases(ctx): Promise<CommandResult>`, `execSshResolveConfig(ctx, cmd): Promise<CommandResult>`; both refuse `{ok:false, error:"ssh disabled on this node"}` unless the local mirror says ON (`sshAllowed(readSshEnabled(ctx.config.dataDir))`).

- [ ] **Step 1: Read the reference handlers**: `git show feat/ssh-support:apps/node/agent/src/commands/ssh-shared.ts` and `...ssh-aliases.ts` in full (both are short; `ssh-shared.ts` was read during planning - `resolveSshBin` via `findBinary("ssh", "SUBSHELL_SSH_PATH", ["/usr/bin/ssh","/bin/ssh","/usr/local/bin/ssh","/opt/homebrew/bin/ssh"])`, `connectingHomeDir` = `process.env.HOME || homedir()`).
- [ ] **Step 2: Write the failing test file** covering, in the dispatch-test harness style of the existing `__tests__/commands-*.test.ts` (copy one's context-construction helper usage): gate file absent -> both handlers refuse by name; gate ON + fixture HOME containing a `.ssh/config` with two Host blocks -> discovery answers the sorted names through the validator; resolve with an injected fake `sshBin`... the resolve path spawns `ssh -G` - for the unit test drive ONLY discovery, and for resolve assert the refusal ordering (gate check precedes any spawn) plus the malformed-alias wire refusal at parse (Task 1 covered the parser; here: dispatch reaches the handler). The REAL `ssh -G` behavior against a fixture config is covered by the tier-1 resolver tests - do not re-test it here; the e2e (Task 9) exercises the composed path.
- [ ] **Step 3: Fail, then implement** both files, adapted: the reference's per-handler shape carries, plus the gate check FIRST (new, tier-2's §4.3 requirement) and the disclosure note: reference says disclosure belongs to the human-facing surface - re-point that comment at the tier-2 launch route (Task 7) which is where the disclosure rides this tier.
- [ ] **Step 4: Dispatch arms** in `commands/index.ts` + `Cmd` map entries; bump `NODE_PROTOCOL_VERSION = 17` with the history entry: `**16 -> 17 (this tier):** the ssh launch block and the two discovery/resolve commands. A lagging agent is HELD (update-only) until crossed, per the capability-gate doctrine in docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md §4.3; the desktop update path is the crossing.` Check every test that pins the version number (grep the worktree for `NODE_PROTOCOL_VERSION` asserts, e.g. the e2e `ready` frame builders and node-frames tests) and update each with a comment naming the bump - a test that hardcodes 16 now fails loudly, which is the point.
- [ ] **Step 5: Green run**: `env -u SHELLOPTS -u BASHOPTS bun test apps/node/agent/src/__tests__/commands-ssh.test.ts` + every test file touched in step 4.
- [ ] **Step 6: Commit** - `"feat(agent): gated ssh discovery/resolve; protocol 17 for the ssh launch grammar"`

---

### Task 5: Launch path - config write, cleanup, both launchers, `LaunchPlan.ssh`

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-launcher.ts` (`LaunchPlan.ssh?: { configPath: string; fileContent: string }` with doc)
- Modify: `apps/server/api/src/services/nodes/local-launcher.ts` (`launch(plan)`: when `plan.ssh`, before spawn: ensure `<dataDir>/ssh/<id>` 0700 + write config 0600 with `enforceMode` (import from pane-runtime - `fs-mode.ts`), then compose the command string from `buildCommand` output + `shellQuote` per token (the terminal path's existing composition - follow exactly how `LocalLauncher.launch` builds its pane command and reuse it), env gets `SSH_AUTH_SOCK` when the launch service placed it in `subshellEnv` (no new field); local cleanup at subshell delete rides the existing artifact-removal call in the manager's delete path (read `subshell-manager.service.ts` delete/removeArtifacts region - add the config path to the artifact list it already composes: find `subshellArtifacts`).)
- Modify: `apps/server/api/src/services/nodes/remote-launcher.ts` (`launch` composes the frame's `ssh: {configPath: plan.ssh.configPath, fileContent: plan.ssh.fileContent}` member)
- Modify: `apps/node/agent/src/commands/launch.ts` (after the maintenance gate and allowlist check (the check runs on `cmd.cwd` - unchanged: the ssh launch's cwd is the node home via the presetless-terminal default, subject to the operator's allowlist like any terminal pane, decision 1), and AFTER the placeholder substitution + BEFORE meta record (step order note in the file header is contractual - amend the header list too): a config-write block mirroring the MCP block's posture but with the DERIVED path: `const sshPath = buildSshConfigPath(ctx.config.dataDir, cmd.subshellId)`; refuse unless `cmd.ssh.configPath === sshPath` (byte-equality: the plane may name nothing else); `pathAllowed` against `[ctx.config.dataDir]`; mkdir 0700 + write 0600 + `enforceMode` both.)
- Modify: `apps/node/agent/src/commands/report.ts` (`startExitWatcher`'s observation site: when the pane's meta `harnessId === "ssh"`, after the death is recorded, best-effort `rm -rf <dataDir>/ssh/<id>` - log-only failure, NEVER refuse; find the observation code by reading report.ts around `runExitWatchTick`)
- Test: `apps/node/agent/src/__tests__/launch-ssh.test.ts`; `apps/server/api/src/services/nodes/__tests__/local-launcher-ssh.test.ts` (or the launcher's existing test home).

**Interfaces:**
- Consumes: Task 1's launch frame `ssh` member; Task 2's `buildSshConfigPath`, `shellQuote`; existing `assembleHarnessCommand`/command-string composition in both launchers.
- Produces: `LaunchPlan.ssh`; agent-written 0600 config at the byte-derived path; death cleanup both sides.

- [ ] **Step 1: Read the four sites in full** before editing: `local-launcher.ts` (whole file), `remote-launcher.ts` `launch`, `commands/launch.ts` (in context), `report.ts` exit-watcher region. Record their real line numbers in your report - this plan's line cites came from planning-time reads and the files move under you.
- [ ] **Step 2: Failing tests.** Agent side: `execLaunch` with a well-formed ssh block -> file exists with mode 0600 and parent 0700, content byte-equal; `configPath` mismatch -> refusal + no file; block absent -> no dir created. Local side: `launch(plan with ssh)` writes under a temp dataDir the same derived path (LocalLauncher's own fs helpers), and the delete-path artifact list includes it (assert the list function's output). Exit cleanup: agent watcher unit - fake pane meta harnessId "ssh" + a real temp file -> gone after the tick; harnessId "claude-code" -> file untouched.
- [ ] **Step 3: Implement per Files above.** Amend `commands/launch.ts`'s step-order docblock (it enumerates the contract - the new step enters at the position it lands).
- [ ] **Step 4: Green focused run** + `verify-types` for `@internal/server` and `@internal/node`; commit `"feat(launch): ssh config written by the spawning machine at the byte-derived path, removed with the pane"`.

---

### Task 6: DB - migration 0048 (`ssh_saved_hosts` + `subshells.ssh`), backup ceiling

**Files:**
- Create: `apps/server/api/src/db/migrations/0048-ssh-launch-and-saved-hosts.ts`, `apps/server/api/src/db/types/ssh-saved-hosts.db-types.ts`, `apps/server/api/src/db/migrations/__tests__/0048-ssh-launch-and-saved-hosts.test.ts`
- Modify: `apps/server/api/src/db/types/subshells.db-types.ts`, `apps/server/api/src/db/index.ts` (Kysely Db type), the migration list import file (find how 0047 registers), `apps/server/api/src/services/backups/database.ts` (`LATEST_BACKUP_MIGRATION = "0048-ssh-launch-and-saved-hosts"`), `apps/server/api/src/commands/__tests__/backup-cli-subprocess.test.ts` (fixture strip-set now drops 0047 + 0048 rows/DDL from the ledger prefix - copy the pattern commit 0ebd6cee established; the older-snapshot fixture must remain a VALID contiguous prefix).
- Test-first per the tier-1 Task 4 pattern (the hand-built 0031-style test: fresh Kysely, run migrations, assert table + column exist, down() reverses).

**Schema (final):**

```ts
/** One saved or recently-used SSH destination for one owner (spec 2026-10-07 §7). Keyed
 *  by the RESOLVED canonical destination so an edited alias can never silently re-point
 *  a saved row. `saved_at` is what the human gave it; recency is `last_connect_at`, which
 *  every launch refreshes whether or not the row was ever saved. */
export interface SshSavedHostTable {
  id: string;                       // uuid
  ownerUserId: string;              // FK users, cascade
  /** canonical `user@host:port` (user part = the resolved snapshot's effective user, or "" default spelled as the connecting account? NO: `host:port` with an empty user prefix when the snapshot's user is null) */
  destination: string;
  /** display-only alias (the config token typed or discovered); never used as a key */
  alias: string | null;
  /** the connecting machine used for the most recent launch to this destination */
  nodeId: string;
  savedAt: string | null;
  lastConnectAt: string;
}
// unique index (ownerUserId, destination); index (ownerUserId, lastConnectAt desc)
```

`subshells.ssh`: `string | null` - JSON-encoded `SshConnectionSnapshotWire` (the row's own approval, kept so the pane's kind and its re-render inputs outlive the request; never serialized to clients except the launch's own answer). Column comment: "an SSH-terminal pane carries its approved snapshot here; the value's presence is the owner-only-input rule's trigger (spec §5.4)."

- [ ] Step 1 write the migration test (failing), Step 2 implement migration + types + registration, Step 3 advance the ceiling + rewrite the fixture strip-set (assert in the test's comment WHY: the ledger the fixture builds must stay contiguous through 0047), Step 4 green focused run (`env -u SHELLOPTS -u BASHOPTS bun test apps/server/api/src/db/migrations/__tests__/0048-ssh-launch-and-saved-hosts.test.ts apps/server/api/src/commands/__tests__/backup-cli-subprocess.test.ts`), Step 5 commit `"feat(db): ssh_saved_hosts + the subshells.ssh snapshot column (migration 0048)"`.

---

### Task 7: Plane - the ssh service surface and `/api/ssh` routes

**Files:**
- Create: `apps/server/api/src/services/nodes/ssh-rpc.ts`, `apps/server/api/src/services/ssh-launch.service.ts`, `apps/server/api/src/db/repositories/ssh-saved-hosts.repository.ts`, `apps/server/api/src/api/ssh/index.ts`, `api/ssh/aliases.route.ts`, `api/ssh/resolve.route.ts`, `api/ssh/launch.route.ts`, `api/ssh/saved-hosts.route.ts`
- Modify: `apps/server/api/src/api/index.ts` (mount `.use(sshRoutes)` on the EXISTING mounted app chain - do not create a new top-level Elysia instance: TS2589 on `App`, memory `elysia-app-type-depth-ceiling`), `apps/server/api/src/services/index.ts` (service registry, mirror ssh-enabled's absence there by following `nodes.service` wiring), `apps/server/api/src/api/models.ts` if response models are centralized (match the prompts routes' local-schema posture - co-located `t` schemas with descriptions are the rule).
- Test: `apps/server/api/src/api/ssh/__tests__/ssh-routes.test.ts` (cookie-auth harness like the nodes routes' tests; `sendCommand` injected/faked through the existing seam used by `set-node-ssh-enabled` tests).
- Docs: `docs/security.md` §10 + `.claude/rules/security-context.md`: add `ssh.launch` to the nodes-family line.

**Route grammar (final; all cookie-actor, all after the existing auth guard):**

```
GET    /api/ssh/aliases?node=<id>          -> 200 {aliases, includeCycle, truncated} | 403 {code: "ssh_gate_off", message names the machine's owner remedy} | 404 invisible | 502-ish mapped agent refusal
POST   /api/ssh/resolve   {node, alias}    -> 200 NodeSshResolveOutcomeWire (refusal rides IN THE DATA per tier-1 grammar)
POST   /api/ssh/launch    {node, destination: string, name?: string}
       -> 201 {subshell: SubshellView} ; refuses: 403 ssh_gate_off / 409 node_protocol_held / 422 {outcome: refusal} / 400 alias-unsafe
GET    /api/ssh/saved-hosts                -> {saved: [...], recent: [...], defaultNodeId: string|null}
PUT    /api/ssh/saved-hosts   {node, destination, alias?} -> upsert-mark-saved, returns the row
DELETE /api/ssh/saved-hosts/:id            -> 204 (owner rows only; foreign 404)
PATCH  /api/ssh/preferences   {defaultNodeId: string|null}
```

**Service (`ssh-launch.service.ts`) responsibilities, in order, each pinned by test:**
1. Gate: `nodeCanSsh({kind, access, isAdmin, serverAccountEnabled, sshEnabled})` for the ACTING cookie user (its owner/admin-on-local answer straight from `loadNodeAccess` + the row); off -> the named refusal constant + copy (the predicate answers yes/no; this route names the cause, §14).
2. Held check: a held agent node -> 409 naming the update remedy.
3. `destination` is validated at the wire like an alias (1..253, no whitespace/control, no leading `-`); discovery answers and manual tokens take the SAME path: `sendCommand(node, {type:"ssh_resolve_config", alias: destination})`.
4. On `accepted:true`: the outcome's snapshot re-validated (the RPC wrapper already ran `parseNodeSshResolveOutcome`), then compose: `configPath = buildSshConfigPath(targetDataDir, newId)`; `fileContent = renderSshConfigContents(snapshot)`; `flags = sshOptionTokens(snapshot)` plus `-F configPath` FIRST; launch via `createSubshell({ userId, harnessId: "ssh", presetId: null, workingDir: <node home - pass undefined and rely on the presetless-terminal default; if the manager's public shape REQUIRES a string, read how spec-2026-10-01's terminal default is reached from the route and pass the same way>`, name, nodeId })` with the two new plumbing params `ssh: { configPath, fileContent, snapshot }` and `presetFlags: flags`, both added to `createSubshell` in this task (see "manager plumbing" below). subshellEnv gains `SSH_AUTH_SOCK: snapshot.authAgentSocket` when non-null; `restartOnExit` forced off; row `ssh` = `JSON.stringify(snapshot)`.
5. Upsert the saved-host row (recency) and audit `ssh.launch` `{nodeId, destination, subshellId}` - AFTER a successful launch, never before (a refusal writes nothing to that trail beyond the pane-create trail the manager already handles... actually: audIT the launch even when it later fails to spawn? No: audit on success only, matching `subshell.create`'s own posture - name this in the code comment).

**Manager plumbing (`subshell-manager.service.ts createSubshell`)**: extend the input object with `ssh?: { configPath: string; fileContent: string; snapshot: SshConnectionSnapshotWire }` and `presetFlags?: string[]`. Behavior: when `presetFlags` present, the launch preset is `{...EMPTY_PRESET, flags: presetFlags}` (fresh object - EMPTY_PRESET is a shared constant, never mutate); when `ssh` present, pass `ssh` into the `LaunchPlan` (both launcher impls), pass `SSH_AUTH_SOCK` merge into `subshellEnv` AT THE CALL SITE (the ssh service computes the merged env and passes it through createSubshell's existing env surface - if createSubshell does not accept env additions, this is the one place it gains a `extraPaneEnv?: Record<string,string>` param; READ the function first and take the minimal honest plumbing), and write `ssh: JSON.stringify(...)` into the row insert. Prompt-typing: ssh launches never carry a prompt (the body schema carries no prompt field, Elysia strips unknowns; an ssh launch types nothing).

- [ ] Step 1: the route/service tests (matrix above, faked `sendCommand` + faked node facts; assert gate order: gate-before-RPC (a node with the row off never receives a command); held-before-resolve; refusal-in-the-data 200 shape for resolve vs 422 for launch; saved-hosts list never carries another owner's rows; delete foreign -> 404; default node id set/clear.)
- [ ] Step 2: fail; implement repository (`touch(destination, nodeId, alias?)` upsert-refresh, `markSaved`, `listSaved/listRecent(limit 20)`, `remove`), rpc wrappers (`sshDiscover(sshNodeId)` / `sshResolve(...)` -> validated plain objects, throwing a named `SshRpcError` on a frame error), service, routes, mount; docs/security lines.
- [ ] Step 3: green focused + `bunx turbo build` (routes visible to treaty consumers) + `verify-types --filter=@internal/server`.
- [ ] Step 4: commit `"feat(api): the ssh launcher surface - gated discovery, resolve, launch, saved hosts"`

---

### Task 8: Owner-only input for ssh panes (REST + MCP + WS)

**Files:**
- Modify: `apps/server/api/src/services/subshells.service.ts` `sendSubshellInput` (the REST input door, and the MCP door through it: add the owner-only rule after the share check as a named 403 code `SSH_OWNER_INPUT_ONLY`; the input route's response map lists response types - add the new code there; watch the treaty consumers, rebuild) and `execInTerminal` (the SAME rule; exec TYPES, so the carve-out precedes the running checks) - put the predicate in ONE place: create `apps/server/api/src/lib/ssh-pane-access.ts` `export function paneInputAllowed(row: {ssh: string | null; userId: string}, actorUserId: string, bearerActor: boolean): boolean` with the rule + spec §5.4 doc, and call it from all three sites (input, exec, WS data) - "one question, one place." (As shipped, the predicate serves the two service verbs plus `resolveAttach`'s single `canInput`; the input route gained NO response-map key because 403 was already declared.)
- Modify: `apps/server/api/src/ws/attach-resolve.ts` `resolveAttach`: the `canInput` flag every input frame honors is computed from the same predicate (the WS resolves a cookie identity; live is human-only already, `bearerActor` false).
- Test: extend `apps/server/api/src/api/subshells/__tests__/subshell-input-route.test.ts` and the exec test home with: ssh row + edit grantee -> 403 (code named), ssh row + owner -> 200, ordinary row + edit grantee -> unchanged 200, ssh row + the pane's OWN key -> 403 (decision 5).

- [ ] Steps 1-4: failing tests -> implement -> green -> commit `"feat(api): ssh panes take input from their owner alone (spec §5.4)"`

---

### Task 9: e2e - the Milestone 1 proof

**File:** Create `e2e/tests/22-ssh-terminal.spec.ts`. Read first: `e2e/tests/12-nodes.spec.ts` (backend boot + admin), `e2e/fixtures/sshd.ts` (exports - it already spawns a loopback sshd + keys + a config alias; reuse, do not rebuild), one existing spec's cleanup posture.

**Scenario (all local node, no agent link):** boot the e2e backend with `HOME=<fixture home>` and `SSH_AUTH_SOCK=<agent sock>` in its env ONLY within this spec (start `ssh-agent` + `ssh-add` via Bun.spawn at spec start; write `<fixture home>/.ssh/config` naming the fixture sshd under alias `e2e-dest`; the sshd fixture's own key trust lands in `<fixture home>/.ssh/known_hosts` - check the fixture's exports for what it already provisions, and extend the FIXTURE (not the spec) if it does not, so the next spec inherits a truthful helper). Steps: register admin; `PUT /api/nodes/local/ssh-enabled {on:true}`; `GET /api/ssh/aliases?node=local` contains `e2e-dest`; `POST /api/ssh/launch {node:"local", destination:"e2e-dest"}` -> 201; poll the pane's log through the existing capture/read route for the sshd fixture's shell banner/marker (run a command by TYPING owner input: `echo SSH-PANE-OK`); assert the log contains it. Then: second user with `edit` grant -> input 403 code SSH_OWNER_INPUT_ONLY; owner terminate; assert the config dir is gone (`<server dataDir>/ssh/<id>` absent) via fs.

- [ ] Step 1: write the spec; Step 2: run `env -u SHELLOPTS -u BASHOPTS bun run test:e2e 22-ssh-terminal` (e2e scripts live in package.json - find the invocation, run ONLY this spec file); iterate until green WITH the sshd binaries present (this host has them; if `sshd` cannot start unprivileged the fixture already handles skip-loud - do not paper a skip over a failure you could fix); Step 3: commit `"test(e2e): ssh pane end to end - gated launch, owner input typed over the wire, sharee refused, files cleaned"`.

---

### Task 10: Boundary - full verification, changeset, PR

- [ ] Full trio + prose + tests (verification.md): `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` - fix everything; expect the tier-1-known pre-existing `e2e-cross-subshell` environmental failure ONLY (re-verify it still fails at base `c5a04be6` before blaming it, per the ledger's provenance rule).
- [ ] `.changeset/ssh-launcher-tier.md`: `@internal/server`, `@internal/node`, `@internal/subshell-protocol`, `@internal/pane-runtime` minor. Deployment sentence: server before nodes; a pre-17 agent is held (offline for everything but update) until it crosses on the update command; the SSH gate itself still defaults off everywhere - nothing changes for anyone until a node is enabled.
- [ ] `bun run lint:lockfile` clean; `git push -u origin feat/ssh-anywhere-2`; `gh pr create --base feat/ssh-anywhere-1` naming the pre-existing failure with its provenance. Do NOT merge, do NOT auto-merge (memory: gh auto-merge merges immediately).
- [ ] Whole-branch review loop (requesting-code-review; package via `git diff feat/ssh-anywhere-1...HEAD` redirected to a file; quote-verify every finding before acting; rounds until zero MAJOR+MINOR).
