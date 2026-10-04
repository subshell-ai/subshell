# Agents open plain terminal sessions on other nodes

Date: 2026-10-01. Status: approved by the operator in dialogue (the rulings
below are quoted at their decision points). Builds on
`2026-09-29-preset-launch-fields-design.md`, whose "create_subshell requires a
preset" ruling this deliberately narrows for `terminal`-type harnesses only.

## Summary

An agent pane can today launch, steer, and tail panes on other nodes, and the
built-in `terminal` harness (`packages/plugins/terminal`, the shell resolved
by `detect` with the `SHELL` override) launches through the same pipeline as
any agent harness. But an agent cannot open a plain shell: `create_subshell`
requires a preset id, so a human must first save a terminal preset for the
pane's owner. And the read side is lossy for a command loop:
`read_subshell_log` answers a 200-line / 256 KiB ANSI-stripped tail with no
cursor, so "send a command, read what is new" silently overlaps or drops
output under bursts.

This spec makes two changes, adds zero node-protocol surface, and changes zero
authorization: (1) `create_subshell` may launch a `terminal`-type harness with
no preset, defaulting the launch directory to the node's home when the caller
names none; (2) `GET /api/subshells/:id/log` grows a byte cursor
(`from_byte` / `max_bytes`, answered with `nextByte`), exposed through
`read_subshell_log`. The loop becomes: `create_subshell { harness:
"terminal", node }`, then `send_to_subshell`, then `read_subshell_log` with the
cursor from the previous read, until the caller closes the pane with
`terminate_subshell`.

## Operator rulings (2026-10-01)

1. Session shape, asked as shell pane vs one-shot exec vs raw terminal
   stream: "It would use the built-in terminal harness." A session is a
   normal subshell row running the `terminal` plugin; no ephemeral exec verb is
   invented.
2. Lifecycle: persist until closed. The pane keeps running (builds, servers
   included) until someone terminates it or the node dies; no auto-kill with
   the caller, no idle timer. Visibility follows the existing cross-comm
   precedent: filed under "Cross-agent comms", born with the notification bell
   off, audited as `subshell.create`.
3. Gating: "Open presetless for terminal." The preset requirement relaxes for
   harnesses of plugin type `terminal` only; agent-harness launches keep the
   2026-09-29 preset ruling verbatim. No instance-level switch.

## 1. Presetless terminal launch (MCP, client-side gate)

`packages/mcp-core/src/subshell-tools.ts` `createSubshell` keeps the preset
path untouched and adds a presetless path:

- The tool schema makes `preset` optional and refines: when `preset` is absent,
  `harness` is required. `harness` keeps its existing meaning as an ASSERT
  beside a preset; presetless it becomes the selection.
- Presetless is allowed only for a harness whose plugin row has
  `type === "terminal"`. The check reuses the catalog the tool world already
  has: `list_presets` composes `GET /api/plugins` rows (id, name, `type`,
  `installed`, `enabled`); the presetless path fetches the same list, finds the
  harness, and refuses anything that is not an installed, enabled,
  `terminal`-type plugin. The refusal names the remedy: agent harnesses launch
  from a preset; ask a human to save one.
- The create body carries `harnessId` and omits `presetId`. No other field
  changes; `node` resolution keeps its exact-id-first / name-grammar client
  code, and `prompt` stays a single final string.

Server-side the shape already exists: `POST /api/subshells` has declared
`presetId` optional since the 2026-09-29 work ("omitted = launch the harness
with no saved settings"), and `EMPTY_PRESET` in `services/preset-definition.ts`
is exactly the presetless launch record. The launch pipeline never branches on
plugin type; a terminal pane is an ordinary launch. The type gate therefore
lives in the MCP layer, where the 2026-09-29 ruling also lives, and the server
answer for a human-driven presetless agent-harness launch is unchanged.

A `prompt` on a bash pane is a first command, not a coincidence: the settle
loop polls `capture-pane` until the prompt is non-blank, then types the text
plus Enter, and `promptDelivered` reports the truth. Terminal harnesses declare
empty capabilities, so no MCP config is written and no pane token is injected
into the shell; the row's token exists but nothing in the pane carries it.

## 2. The home-dir default (server)

Today neither body `workingDir` nor a preset directory produces the existing
400 ("provide workingDir or a preset that carries one"). For presetless,
`terminal`-type launches with no directory, the server defaults the working
directory to the launch node's home:

- The default is computed AFTER `resolveLaunchNode` has picked the node,
  because the answer depends on which machine won: `local` uses the server
  host's `os.homedir()`; an agent node uses the `homeDir` its `ready` facts
  already carry (`node-registry.ts` `NodeFacts.homeDir`). The missing-directory
  400 moves behind the node gate: a presetless terminal create whose node
  cannot be used answers the honest `NODE_REQUIRED` / `NODE_OFFLINE` /
  maintenance refusals, never a fabricated home.
- The default passes every directory check a typed directory passes: the
  plane-side allowlist check and the node's own gate run exactly as today. An
  allowlist that excludes the home refuses the launch like it would any dir.
- Scope is exact: presetless + plugin type `terminal` + no `workingDir` in the
  request. A named directory always wins. Any future presetless launch shape
  gets its own ruling; this one belongs to shells.

The tool description says the default plainly ("omitting working_dir starts
the shell in the node's home directory"), so the agent learns where it landed
without a new response field.

## 3. Cursor reads (server)

`GET /api/subshells/:id/log` grows optional `from_byte` (an inclusive raw file
offset; absent keeps today's EOF-anchored tail) and optional `max_bytes`
capped by one shared window constant. The response keeps `{ lines, truncated }`
and always carries `nextByte`, so a tail read can seed a cursor loop.

The honesty rules, each pinned by test:

- **`nextByte` is a raw file offset**, the number of raw bytes consumed.
  Stripped text is strictly shorter (CSI/OSC/CR removal), so a stripped offset
  could not be fed back to `log_read` and a loop would silently skip data. The
  window slice is split on raw `\n` first, then each line is ANSI-stripped.
- **Line-aligned resume.** A new pure helper owns this. The existing
  `tailLinesFromWindowText` drops the first line when the window does not start
  at 0 (correct for an EOF-anchored tail, wrong for a resume) and has no byte
  accounting; it stays verbatim and byte-identical across local and remote,
  which its parity tests pin.
- **Long-line liveness.** A single raw line longer than the window would yield
  zero complete lines and a stuck cursor forever. When the window holds no
  newline, the helper returns the partial line and advances `nextByte` to the
  window end. The partial line is a truncation of raw data; `truncated` says
  so.

Plumbing follows the existing seams, all of which already speak windows:

- `api/models.ts`: `SubshellLogTailSchema` gains `nextByte: t.Number`. The
  addition is invisible to the SPA, which reads `lines` / `truncated`.
- `services/nodes/log-tail.ts`: new `readLogWindowFrom(path, fromByte,
  maxBytes)` + `cursorLinesFromWindow(...)`, beside the untouched tail helpers.
- `NodeLauncher` gains `readLogWindow(id, fromByte, maxBytes)`. The local
  launcher wraps its existing windowed read primitive; the remote launcher
  extracts the `readLogWindow` from the size-probe + windowed `log_read` pair
  it ALREADY builds internally for the tail (the node-side `log_read` command
  takes `fromByte` / `maxBytes` today and does not change).
- `getSubshellLogTail` (service) and `readSubshellLogTail` (manager) thread the
  optional window through; `requirePerm("subshells", "read")` and the row gate
  are unchanged (a pane token already reads its owner's panes at `view`).

`read_subshell_log` exposes `from_byte` and `limit` and returns `nextByte`
through, with a description that teaches the loop and repeats the
untrusted-data line.

## 4. What does not change

- The node protocol stays 14. No agent change, no release-coordination cost.
- Authorization is untouched: strict-owner-only node resolution for bearers,
  the per-subshell gate with shares off, the existing permission map
  (`subshells` read/write), audit exactly at today's events. This spec widens
  WHAT a pane can open, never WHO can open it or WHERE: an agent can already
  launch the owner's panes on the owner's nodes; a terminal pane is one more,
  and §4's accepted "beyond its row" posture already describes what that
  means. The directory allowlist still gates the landing spot.
- The tool-name set on the MCP wire stays 20. `server.test.ts` pins
  `create_subshell`'s `required` list and description text; both change
  deliberately in this work, as do the `tools.test.ts` create cases.
- `SUBSHELL_MCP_INSTRUCTIONS` keeps its pinned brevity; the loop belongs in the
  two tool descriptions, not the briefing.

## 5. Non-goals

- A `run_command` convenience tool (marker-based completion, exit codes).
  Brittle against interactive programs and odd prompts; buildable on the
  cursor later. Deferred by ruling ("T1 over T3").
- Screen-state reads (`capture-pane` as a new surface). The log is the
  contract; capture stays attach-only.
- Auto-terminate, TTL, or idle sweep (ruling 2).
- Terminal uploads/clipboard work, the `write_file` path, file transfer. That
  is `2026-10-01-node-archive-transfer-design.md`.

## 6. Tests

- `services/nodes/__tests__/log-tail.test.ts` (new): window helper purity; raw
  offsets; line-aligned resume; the no-newline long-line case; empty window at
  EOF returns zero lines and `nextByte` at the window end, never a stuck
  cursor.
- `api/subshells/__tests__/subshells-log-route.test.ts`: cursor loop against a
  real temp log (no dup, no skip across two reads that split mid-line),
  `from_byte` past EOF answers empty + `nextByte = size`, permission and
  offline-parity cases unchanged.
- `services/nodes/__tests__/remote-launcher.test.ts` + a `scripted-node`
  `log_read` handler case: `readLogWindow` sends the size probe + window pair
  and answers the cursor honestly.
- Create-path tests: presetless terminal default to node home (remote facts
  and local), the 400 now ordering behind the node gate, and the MCP refusal
  text for presetless agent harnesses.
- `packages/mcp-core/src/__tests__/tools.test.ts`: presetless terminal happy
  path (body carries `harnessId`, no `presetId`; plugins consulted),
  presetless `agent-harness` refusal, cursor query pass-through.
- `server.test.ts`: the pinned `required` list and description strings are
  updated deliberately; the 20-name set assertion is unchanged.
