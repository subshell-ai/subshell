# MCP DX audit implementation plan (2026-09-25)

Source: the `subshell mcp` DX audit reviewed with the operator on 2026-09-25
(cross-node `create_subshell` was the triggering pain). Branch: `feat/mcp-dx-audit`.

## Goal

Close the machine-facing gap between what `POST /api/subshells` supports and what
`subshell mcp` exposes: agents can name machines, read sibling output, steer
panes, discover harnesses on a presetless instance, and get errors that name the
action to take next.

## Global constraints

- Bun only (`bun test`, `bunx`); biome formatting; no dynamic imports outside
  `packages/pane-runtime/src/plugin-runtime.ts`.
- Every Elysia `t` schema property carries a `description`; route handlers stay
  thin, services own the logic; JSDoc says what is not obvious.
- **Prose voice: no em dashes (U+2014) anywhere**, including tool descriptions
  and test names (`lint:prose` gates it).
- **App type depth**: do NOT add a new top-level route module to `routes.ts`.
  New subshell endpoints fold into the existing `api/subshells/` aggregation.
  After any route-shape change run `bunx turbo build --filter=@internal/backend-client`
  and `bun run verify-types` (TS2589 on `App` is the known trap).
- Bearer subshell keys stay `machineActor`: strict owner-only on node paths,
  no admin boost, no shares. Sharing never widens what a pane token sees.
- Node disclosure to bearer is a security ruling: the machine may enumerate
  nodes it can launch on (owner-only set), names/hostnames included, mirroring
  the 2026-09-23 subshell-list enumeration ruling. `GET /api/nodes/:id`
  (detail) stays cookie-only.
- A subshell write that a person should see publishes `subshell.changed`; the
  input route writes nothing to the row, so it publishes nothing.
- `@internal/mcp-core` is changesets-ignored: its work rides the
  `@internal/server` changeset.
- Focused verification while iterating; full `verify-types` + `lint:check` +
  `bun run test` (server package + mcp-core) at each task boundary the
  implementer commits on.

## Task 1: server, machine-readable nodes and honest create errors

1. Open `GET /api/nodes` to bearer actors: cookie behavior unchanged; a bearer
   actor gets the strict owner-only set (`listByOwner`, the same candidate set
   `resolveLaunchNode` step 3 uses), rendered through the existing `toNodeViews`
   mapping with `isAdmin=false` and the unboosted granted access. Detail route
   (`GET /api/nodes/:id`) and every write stay cookie-only/admin as today.
   Update the route's comment: the machine consumer exists now.
2. New test (mirror the shape of
   `api/subshells/__tests__/subshells-list-visibility.test.ts`): a real pane
   token enumerates its owner's nodes (enumerate-ok) and is still refused node
   writes and the detail route (act-denied); a foreign node is absent, never a
   403; the response carries `canLaunch` and per-harness `installed` rows.
3. `Unknown harness: X` 400 gains the valid ids: "Unknown harness: X. Available
   harnesses: a, b, c" (from the harness registry, sorted; the message stays a
   single line).
4. Bearer log-tail proof: a real pane token reads `GET /api/subshells/:id/log`
   for a sibling owned by the same user (already gated at `view`; pin it so the
   MCP tool added in Task 3 rests on a tested door), and gets 404 for a foreign
   row.

## Task 2: server, pane input route and restart prompt

1. `POST /api/subshells/:id/input`: body `{ text: string(1..20000), submit?:
   boolean = true }`, `requirePerm(subshells, write)` + the service `#gate` at
   `edit` (the same level the WS terminal input acts at), row must be `running`
   (409 otherwise), resolve the launcher from `launcher-registry`, reuse the
   exact typing seam the WS attach path uses (`sendInput` local and remote),
   `submit` appends the Enter the same way `deliverPrompt` does. Offline node
   maps through `rethrowLaunchRefusal` (409 NODE_OFFLINE). Response
   `{ ok: true }`. No row write, no `publishLive`.
2. `restart` gains optional `prompt` in its existing optional body: after a
   successful revive, deliver it through the launcher `deliverPrompt` seam
   (same settle constants as create; remote is the one-round-trip
   `prompt_deliver`); `promptDelivered` rides the existing response schema.
   A refusal path types nothing.
3. Tests: gate levels (view denied, edit allowed, bearer own-sibling allowed,
   bearer foreign 404), submit vs no-submit byte difference (spy the launcher),
   offline 409, not-running 409; restart-with-prompt delivers and
   plain-restart stays byte-identical to today's body-less call.
4. Fold into the existing `api/subshells/` aggregation; run the backend-client
   build + verify-types for the App-depth trap.

## Task 3: mcp-core, the agent-facing surface

1. `ApiError` carries the structured `code`; `describeToolError` maps the codes
   that need a next action (NODE_REQUIRED -> "call list_nodes and pass node",
   NODE_OFFLINE, harness_disabled -> "check list_nodes / list_presets",
   node_launch_disabled, preset_harness_mismatch, 404 -> "find the id with
   list_subshells"). Unknown codes keep today's wording.
2. New `list_nodes` tool: `GET /api/nodes`, projected to
   `{ id, name, kind, status, access, canLaunch, maintenance?, harnesses:
   [{ harnessId, installed, reason? }], inventoryStale }` (match what
   NodeViewSchema actually returns; drop owner/runtime/shares fields).
3. `create_subshell`: optional `node` (id OR display name; resolve through a
   `list_nodes` read the same way preset names resolve: exact id, then exact
   name, then case-insensitive, ties refused listing the spellings, zero
   refused listing available names); forwards `nodeId`. Description says
   `working_dir` is absolute ON THE CHOSEN NODE, and adds: if the call times
   out the pane may already exist, check `list_subshells` before retrying.
4. New `read_subshell_log` tool: `GET /api/subshells/:id/log` ->
   `{ lines, truncated }`.
5. New `send_to_subshell` tool: `POST /api/subshells/:id/input`, args
   `{ id, text, submit? }`.
6. `get_subshell`: `{ id? , name? }`, exactly one required (a name resolves
   through `list_subshells` with the same exact-then-insensitive-then-refuse
   rule).
7. Projection: `list_subshells`/`get_subshell` return the coordination set
   `{ id, name, harnessId, nodeId, nodeOffline, status, activity, alive,
   workingDir, preview, waitingSince, exitCode, access, lastOutputAt }`; the
   TS interfaces stop lying about what is returned (fix them to the projection).
   `create_subshell` drops `tmuxSocket`.
8. `restart_subshell` gains optional `prompt`; report `promptDelivered`.
9. `list_presets` also answers on a presetless instance: merge the harness
   catalog from `GET /api/plugins` (agent-harness entries) as
   `{ id, name, harnessId, presetless: true }`-style rows so a valid harness id
   is discoverable without any preset existing.
10. Remove `channel_members` from the MCP surface (REST keeps it; the UI
    reads it). `terminate_subshell` and `delete_subshell` descriptions state
    the real distinction: terminate kills the process and revokes the token but
    the row and history stay; delete removes the row and is owner-only.
11. `SUBSHELL_MCP_INSTRUCTIONS`: add one node line (machines exist,
    `list_nodes` shows them, `create_subshell.node` picks one, `working_dir`
    means that machine). Keep the briefing short.
12. Update `tools.test.ts` / `server.test.ts` for every change (including the
    removal).

## Task 4: docs, accounting, changeset

1. `docs/security.md`: bearer node enumeration ruling (§3 area, beside the
   subshell-list precedent), the input route (§ pane input: same keystroke
   surface, new door, edit-gated), log-tail bearer note, restart prompt note.
   Keep the accounting style of existing entries (dated spec markers).
2. `apps/server/api/AGENTS.md`: nodes-plane bearer-read sentence, the two new
   subshell endpoints in the route inventory, restart prompt.
3. `apps/docs/`: grep for MCP tool lists; where docs enumerate tools
   (`develop/architecture.mdx` or similar), update to the new surface.
4. Changeset: `@internal/server` minor describing the MCP DX wave. No changeset
   names ignored packages.
5. Voice rule: no em dashes in any of it.

## Verification boundaries

Each implementer commits with focused tests green. The controller runs the full
trio plus `bunx turbo build` at the end of each task's review loop, and the
whole-branch review runs last.
