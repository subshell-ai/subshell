# Top-ten harness support: six new built-in harness plugins

Date: 2026-11-07
Status: approved (design agreed with the operator on 2026-11-07)

## Goal

Subshell should launch every harness a developer is likely to already have on their machine. The final built-in set is the union of what already ships and the top ten most popular harnesses that can be supported. Five of today's top ten already ship (Hermes, opencode, Claude Code, Codex, pi). This spec adds the other five, plus Qwen Code:

**OpenClaw, Gemini CLI, OpenHands, Cline, Open Interpreter, Qwen Code.**

Qwen Code sits below the natural popularity line and was added by operator request (2026-11-07). The shipped `grok-build` and `oh-my-pi` are outside the ten and stay shipped; nothing is pruned.

## How the list was made

Measured 2026-11-07 against `api.github.com` (live star counts), cross-checked against two curated directories and npm registry probes. The primary metric is the star count of the harness's own repository, qualified by maintenance activity. The JetBrains 2026 survey is carried as an annotation, not the metric: it measures products (Cursor's IDE, Copilot's service) far more than the standalone CLIs a pane actually runs, and conflating the two produced a wrong first draft of this very table.

| # | harness | stars (2026-11-07) | shipped? | action |
|---|---|---|---|---|
| 1 | OpenClaw | 394.2k | no | new plugin |
| 2 | Hermes Agent | 261.6k | yes (`hermes`) | - |
| 3 | opencode | 225.3k | yes (`opencode`) | - |
| 4 | Claude Code | 154.9k | yes (`claude-code`) | - |
| 5 | Codex | 133.6k | yes (`codex`) | - |
| 6 | pi | 120.7k | yes (`pi`) | - |
| 7 | Gemini CLI | 108.8k | no | new plugin |
| 8 | OpenHands | 92.9k | no | new plugin (gated, see below) |
| 9 | Cline | 71.5k | no | new plugin |
| 10 | Open Interpreter | 68.8k | no | new plugin |
| + | Qwen Code | 29.1k | no | new plugin (operator request) |

**Excluded, with the reason recorded so nobody rediscovers them:**

- `claw-code` (194.9k). Its own README: "An agent-managed museum exhibit... developed and maintained with no human intervention", and it redirects people wanting to run work to other binaries. Real stars, no production posture.
- `stablyai/orca` (118.7k), `herdr` (49.2k), `cmux`, `warp`: orchestrators and terminals. They are Subshell's peers or its host, not pane contents.
- Cursor's `agent` binary and GitHub Copilot CLI: proprietary CLIs whose popularity signal rides IDE/service adoption the survey can't separate. Both head the fallback ladder instead; if the operator later weights survey adoption over repository stars, they displace the tail.

## The qualification gate

A harness qualifies only if it runs properly **under tmux**: the real interactive program in a real pane, not a print mode or a headless fallback (operator ruling, 2026-11-07). Verification per harness, at implementation, against the live binary on this machine:

1. Install through the official path (npm/pip/installer).
2. Read `--help`; source suggested flags and settings from output, not docs scrapes.
3. Launch it the way `pane-runtime` does, in a real tmux pane with the scrubbed pane env; confirm it renders, accepts typed input, redraws, and behaves across a pane restart.

Capabilities (`mcp`, `resume`, `attention`, `subagents`) are declared only where the live binary verified them. Partial declaration is the house norm: of the shipped seven, only `claude-code` holds all five, most hold `subagents, mcp, settings`.

If a harness fails the gate, it drops and the next in rank takes its slot. Fallback ladder, in order: goose (56.3k, moved to the `aaif-goose` org), aider (50.0k, no push since 2026-05), nanobot (49.9k), CowAgent (47.8k), Codewhale (41.2k), QwenPaw (37.5k), DeepSeek-Reasonix (36.1k), openclaude (34.1k), Crush (29.0k), Copilot CLI, Cursor's `agent`.

## The six plugins

Every one is a package at `packages/plugins/<id>` following the current mold (see `packages/plugins/opencode` for the shape): a `subshell` manifest block in `package.json` (apiVersion 2, detect with `binaryName`/`envOverride`/`knownPaths`, `hostEnv`, `install` command and docs URL), `src/manifest.ts` that throws on a malformed manifest, `src/index.ts` exporting the factory (`buildCommand`, `validatePreset` via the shared `validateGenericPreset`, `presetSettings`, `suggestedEnv`/`suggestedFlags`, and the `mcpRegistration`/`mcpSetup` answer for its harness), `icon.svg`, and `__tests__` with argv golden shapes. Published as `@subshell-ai/plugin-<id>`, Apache-2.0 like every plugin package.

| id | binary | install hint | what verification must settle |
|---|---|---|---|
| `gemini` | `gemini` | `npm i -g @google/gemini-cli` | MCP config route (`settings.json` layer the per-pane file can shadow), resume/session flags, subagent story |
| `qwen-code` | `qwen` | `npm i -g @qwen-code/qwen-code` | it is a Gemini CLI fork; verify its own flags and config paths, do not copy Gemini's |
| `cline` | verify from the real install: docs say `npm i -g cline`, the registry probe showed `@cline/cli` exposing `clite` | `npm i -g cline` (docs) | the true global package and bin name; MCP settings location; config dir |
| `open-interpreter` | `interpreter` | pip/pipx, confirm the current official path | likely no MCP support: omit `mcp` rather than invent a route |
| `openhands` | `openhands` | packaging of `OpenHands/OpenHands-CLI` | GATE: its runtime may want Docker on the node; the pane must still drive the CLI, and a Docker prerequisite must be named in the manifest |
| `openclaw` | `openclaw` | `npm i -g openclaw` | GATE: the pane process is a TUI *client* of a per-machine Gateway daemon. Verify the exact pane command; the one-time onboarding prerequisite belongs in the manifest description; sessions live in the Gateway, so `resume` means attach, not relaunch |

Identity, detection and install guidance stay in the manifest block (the host reads them without loading plugin code, per the plugin architecture). The `subagents` capability ships only where the harness has a real child view worth surfacing, per the bridge pattern the shipped plugins use.

## Reaching existing installs

No migration and no store surgery: `<dataDir>/plugins/.seeded` records which ids were seeded (`packages/pane-runtime/src/plugins-seed.ts`), so a new built-in lands in an already-booted instance on its next boot, one id at a time, never resurrecting an uninstall. Nodes receive execution data only, as always.

## Non-goals

- Pruning shipped plugins. `grok-build` and `oh-my-pi` keep shipping.
- Re-auditing the shipped six against today's binaries. Several were verified in the August/September world and the audit is a sensible follow-up, but it is separate work.
- Any `@subshell-ai/plugin-api` contract change. If verification finds a real gap in the contract, amend this spec rather than squeezing a harness into a shape it doesn't fit.
- Server, SPA, or API surface changes: catalog rows, detect specs, and icons flow from manifest data dynamically.
- Shipping any ladder name beyond the six, or Cursor/Copilot CLIs.

## Testing

Per package: manifest round-trip (a malformed `subshell` block must throw at module scope), `buildCommand` golden argv per settings combination, preset validation, and capability/manifest agreement through the existing plugin-api validators. Package tests run via the package's own `test` script.

Per slice: `bun run test:changed -- --plan`, then `bun run verify:changed` once at handoff (it builds `pane-runtime` and both apps that bundle the registry, which is what catches a new static import failing to bundle), `bun run lint:check`, `bun run lint:lockfile`.

Whole batch: boot a dev instance through the `e2e/stack.ts` pattern (never `:3080`), confirm all six appear in the instance's plugin catalog with correct detect and install data, and launch at least one new harness end-to-end in a real pane. `test:cli` is not implicated (no CLI verb or rendered-install change).

## Rollout

Six slices in confidence order, each independently shippable behind its own changeset (naming the new plugin package plus `@internal/server` and `@internal/node`):

1. `gemini`
2. `qwen-code`
3. `cline`
4. `open-interpreter`
5. `openhands`
6. `openclaw`

A gate failure on the tail reranks through the ladder without holding the batch.

## Sources

Live star pulls from `api.github.com`, 2026-11-07. JetBrains Research, "Which AI Coding Tools Do Developers Actually Use at Work?" (April 2026). `bradAGI/awesome-cli-coding-agents` and `RyanAlberts/best-of-Agent-Harnesses` as directory cross-checks. npm registry probes (`@google/gemini-cli`, `@qwen-code/qwen-code`, `@cline/cli`, `openclaw`). READMEs of `openclaw/openclaw`, `github/copilot-cli`, `ultraworkers/claw-code`. `cline.bot/cli` and the Cline CLI 2.0 announcement. Pinggy (Oct 2026) for the Cursor `agent` rename note; arcbjorn's State of CLI Coding Agents (mid-2026), codepick.dev, standardcompute.com, and openalternative.co roundups as secondary signal.
