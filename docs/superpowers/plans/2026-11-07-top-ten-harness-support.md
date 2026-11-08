# Top-ten harness support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six new built-in agent-harness plugin packages (gemini, qwen-code, cline, open-interpreter, openhands, openclaw) so Subshell ships every harness in the popularity top ten.

**Architecture:** Each harness is a published package under `packages/plugins/<id>` exporting a `HarnessPluginFactory` and its manifest, compiled into both binaries by static import in `packages/pane-runtime/src/registry.ts`. The mold is `packages/plugins/grok-build` (manual MCP registration) and `packages/plugins/opencode` (package layout). No server, SPA, or plugin-api changes.

**Tech Stack:** TypeScript, Bun, tsdown, Elysia-free (plugins are plain modules), bun:test, biome, changesets.

**Spec:** `docs/superpowers/specs/2026-11-07-top-ten-harness-support-design.md`

## Global Constraints

- No dynamic imports anywhere; built-ins are static imports only (`.claude/rules/code-style.md`).
- All dependency versions pinned exactly, then `bunx syncpack fix` (`.claude/rules/dependencies.md`).
- Every new package is Apache-2.0: `"license": "Apache-2.0"` plus an Apache `LICENSE` file copied from `packages/plugins/grok-build/LICENSE` (`bun run lint:licenses` enforces).
- Capabilities declared only where the live binary verified them. First batch: `mcp` + `settings` where applicable; `openclaw` ships `[]` (ruling below); `openhands` ships `["mcp"]` (no verified CLI settings flags).
- The `subshell` manifest block, NOT code, carries id/name/description/icon/detect/hostEnv/install; `manifest.ts` must throw on a malformed block.
- JSDoc and shipped strings follow the repo voice; no em dashes (U+2014) in comments, UI copy, or docs (`lint:prose`).
- Automation shells run test scripts with `env -u SHELLOPTS -u BASHOPTS` (`.claude/rules/testing.md`).
- Per-slice verification at handoff: package `test` script, `bun run test:changed -- --plan`, `bun run verify:changed`, `bun run lint:check`, `bun run lint:lockfile`.
- Changesets name the new plugin package plus `@internal/server` and `@internal/node` (both bundle the registry).
- Live installs used during planning already exist under `/tmp/hv/` (gemini 0.67.0, qwen 0.27.0, cline 3.0.74, interpreter 0.0.59, openhands SDK 1.21.0 via uv tool, openclaw 2026.11.1). All six ALIVE in a detached tmux pane, rendering their TUI (measured 2026-11-07, 120x30). A task re-verifies its own binary; if `/tmp/hv/<name>` is gone, re-run the task's Step 1 install.

### Verified facts (2026-11-07, live binaries)

| harness | bin | version | interactive launch | settings flags (verified in `--help`) | MCP add syntax (verified) | config home / env |
|---|---|---|---|---|---|---|
| Gemini CLI | `gemini` | 0.67.0 | bare `gemini` → TUI | `-m/--model`, `--approval-mode <default\|auto_edit\|yolo\|plan>` | `gemini mcp add -s user <name> <command> [args...]` (default scope is `project`, pass `-s user`) | `GEMINI_CLI_HOME` names a HOME-style dir whose inner `.gemini` holds the config (default: the OS home, so `~/.gemini`); corrected by Task 1's live review (`GEMINI_DIR` is not the override) |
| Qwen Code | `qwen` | 0.27.0 | bare `qwen` → TUI | `-m/--model`, `--workflow-mode <on\|off>`; chat recording is ON by default (bundle: `chatRecording ?? settings.general?.chatRecording ?? true`), so `--resume` works unless recording was explicitly disabled | `qwen mcp add [-s user] <name> <command> [args...]` (default scope `user`) | `~/.qwen` |
| Cline | `cline` | 3.0.74 | `cline -i` → TUI | `-m <model-id>`, `-P <provider>`, `--thinking <none\|low\|medium\|high\|xhigh>` | `cline mcp add <name> [args...]` opens a prefilled wizard; check `cline mcp add --help` for a non-interactive form | `~/.cline` |
| Open Interpreter | `interpreter` | 0.0.59 | bare `interpreter` → TUI | `-m/--model` | `interpreter mcp add` (check `interpreter mcp add --help` for argv form) | `INTERPRETER_HOME` (default `~/.openinterpreter`); alias `i` |
| OpenHands | `openhands` | SDK 1.21.0 | bare `openhands` → TUI wizard | none verified in `--help` (no `settings` capability) | `openhands mcp ...` (check `openhands mcp --help`) | `OPENHANDS_SUPPRESS_BANNER=1` hides the startup banner (suggest it) |
| OpenClaw | `openclaw` | 2026.11.1 | `openclaw chat` = `tui --local`, embedded, no Gateway needed | model lives in OpenClaw config, not a launch flag | gateway-scoped `openclaw mcp add`; **deliberately not used** (ruling) | `OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_TOKEN` |

**Ruling (openclaw `mcp` off):** an OpenClaw MCP registration is machine-wide (Gateway scope), and a stdio child's `SUBSHELL_*` credential is baked at spawn. A gateway-scoped registration would bind one pane's credential to every OpenClaw session on the host, which is the cross-pane leak the grok-build leader comment warns about. Launch, detect, and install ship; MCP does not, and the docs page says so. Cost if wrong: cross-subshell comms unavailable for OpenClaw until a per-session route is found.

---

## Shared file shape (every new package)

```
packages/plugins/<id>/
├── package.json        # the subshell block is the identity source of truth
├── LICENSE             # copy packages/plugins/grok-build/LICENSE verbatim
├── icon.svg            # concrete SVG given per task below
├── tsconfig.json       # {"extends": "@internal/tsconfig/tsconfig.json", "include": ["./src/**/*"]}
├── tsdown.config.ts    # copy packages/plugins/pi/tsdown.config.ts verbatim
└── src/
    ├── manifest.ts     # copy packages/plugins/pi/src/manifest.ts, change the package name in the error string
    ├── index.ts        # the factory (given per task)
    └── __tests__/<id>.test.ts
```

`devDependencies` are identical for all six (copy the block from `packages/plugins/opencode/package.json`, verbatim: `@internal/tsconfig`, `@subshell-ai/plugin-api` as `workspace:*`, `@types/bun` 1.3.14, `hash-runner` 5.0.0, `tsdown` 0.22.14, `typescript` 7.0.2), as are `scripts`, `files: ["dist", "icon.svg"]`, `publishConfig: { "access": "public" }`, `"type": "module"`, `"main"/"exports"/"types"` pointing at `dist`, and `repository.directory: "packages/plugins/<id>"`. Version starts at `1.0.0` (like `terminal` did).

Registry wiring per task: add `import <camel>Factory, { manifest as <camel>Manifest } from "@subshell-ai/plugin-<id>";` (alphabetical position) plus `{ manifest: <camel>Manifest, factory: <camel>Factory },` to `BUILT_INS` in `packages/pane-runtime/src/registry.ts`, and the `workspace:*` dependency to `packages/pane-runtime/package.json`. Then run `env -u SHELLOPTS -u BASHOPTS bunx turbo run test --filter=@internal/pane-runtime` and add your id to every expected-id array the failures point at (`registry.test.ts`, `embedded-plugins.test.ts`, `plugins-seed.test.ts`, `installed-overlay.test.ts`) in alphabetical position. Never delete an existing id.

Docs updates per task: create `apps/docs/content/docs/agents/<id>.mdx` from the structure of `agents/grok-build.mdx` (Before you start / Launch / MCP and session behavior), insert the page into `apps/docs/content/docs/agents/meta.json`, add a table row to `apps/docs/content/docs/agents/index.mdx` (Harness | CLI binary | MCP setup), and update the harness lists in `apps/docs/content/docs/about/index.mdx` and `apps/docs/content/docs/mcp/configure.mdx` where they enumerate plugins. Keep prose in the docs voice, no em dashes.

## Task 1: Gemini CLI plugin

**Files:**
- Create: `packages/plugins/gemini/` (shared shape above)
- Modify: `packages/pane-runtime/src/registry.ts`, `packages/pane-runtime/package.json`, the four pane-runtime test id arrays, docs files above
- Create: `.changeset/gemini-harness-plugin.md`

**Interfaces:**
- Consumes: nothing prior.
- Produces: id `gemini`, binary `gemini`, `envOverride` `GEMINI_PATH`; the id arrays in the four pane-runtime tests each gain `"gemini"`.

- [ ] **Step 1: Re-verify the binary surface**

```bash
/tmp/hv/gemini/bin/gemini --version                     # expect 0.67.0 or newer
/tmp/hv/gemini/bin/gemini --help | grep -E "approval-mode|resume|session-id|skip-trust"
```
If missing, re-install scoped: `npm i -g --prefix /tmp/hv/gemini @google/gemini-cli`. Record anything that changed into the report.

- [ ] **Step 2: Write the failing test**

`packages/plugins/gemini/src/__tests__/gemini.test.ts`, following `packages/plugins/grok-build/src/__tests__/grok-build.test.ts` exactly in structure:

```typescript
import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "Gemini",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/gemini/bin/gemini", cwd: "/work/project", subshellName: "Example" };

describe("Gemini CLI", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("gemini");
    expect(manifest.detect.binaryName).toBe("gemini");
    expect(manifest.detect.envOverride).toBe("GEMINI_PATH");
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.capabilities()).toEqual(["mcp", "settings"]);
  });

  it("starts the interactive TUI bare by default", () => {
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary]);
  });

  it("maps settings to verified flags and preserves whole argv tokens", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { model: "gemini pro", approvalMode: "auto_edit" }, flags: ["--skip-trust"] }),
        extraFlags: ["-i"],
      }),
    ).toEqual([launch.binary, "--model", "gemini pro", "--approval-mode", "auto_edit", "--skip-trust", "-i"]);
  });

  it("renders a manual one-time MCP registration for the pane's own argv", () => {
    const setup = plugin.mcpSetup!({ command: "/usr/bin/subshell", args: ["mcp"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode === "manual") {
      expect(setup.steps[0]!.command).toContain("gemini mcp add");
      expect(setup.steps[0]!.command).toContain("--scope user");
    }
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false); // `.valid`, not `.ok` (corrected by Task 1's live review)
  });
});
```

- [ ] **Step 3: Run it, watch it fail** (module not found). `cd packages/plugins/gemini && env -u SHELLOPTS -u BASHOPTS bun test src/__tests__/gemini.test.ts`

- [ ] **Step 4: Write `package.json`** (shared devDeps/scripts block verbatim from `opencode/package.json`; `subshell` block):

```json
{
  "name": "@subshell-ai/plugin-gemini",
  "description": "Gemini CLI harness plugin for Subshell",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "subshell": {
    "apiVersion": 2,
    "id": "gemini",
    "type": "agent-harness",
    "name": "Gemini CLI",
    "description": "Google's open-source agentic coding CLI (interactive TUI)",
    "icon": "icon.svg",
    "entry": "dist/index.js",
    "detect": {
      "binaryName": "gemini",
      "envOverride": "GEMINI_PATH",
      "knownPaths": [".npm-global/bin/gemini", ".local/bin/gemini"]
    },
    "install": {
      "command": "npm i -g @google/gemini-cli",
      "docsUrl": "https://github.com/google-gemini/gemini-cli"
    }
  }
}
```
(plus `main`/`exports`/`types`/`repository`/`bugs`/`homepage` copied from the mold, with `directory` set to `packages/plugins/gemini`)

`icon.svg`: a circle with the letter G: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#4285F4"/><text x="16" y="22" font-family="system-ui" font-size="16" font-weight="600" fill="#fff" text-anchor="middle">G</text></svg>`

- [ ] **Step 5: Write `src/index.ts`** (mold: grok-build).

```typescript
import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID, e.g. a gemini-* name", type: "string" },
  {
    key: "approvalMode",
    label: "Approval mode",
    description: "How much it may do without asking",
    type: "select",
    choices: ["default", "auto_edit", "yolo", "plan"], // string[] (corrected by Task 1's live review)
  },
];

/**
 * Launch Gemini's interactive TUI. Flags mapped here were verified against
 * @google/gemini-cli 0.67.0 --help: -m/--model, --approval-mode, --skip-trust,
 * --resume/--session-id. `gemini mcp add` defaults to project scope, so the
 * registration step passes --scope user explicitly.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags }) {
    const args = [binary];
    const settings = preset.settings ?? {};
    if (typeof settings.model === "string" && settings.model) args.push("--model", settings.model);
    if (typeof settings.approvalMode === "string" && settings.approvalMode)
      args.push("--approval-mode", settings.approvalMode);
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  mcpSetup(launch) {
    return {
      mode: "manual",
      steps: [
        {
          label: "Register Subshell once for the account and GEMINI_CLI_HOME you launch Gemini with:",
          command: `gemini mcp add --scope user ${MCP_SERVER_NAME} ${[launch.command, ...launch.args].map(host.shellQuote).join(" ")}`, // no `--` separator; gemini's parser rejects it (corrected by Task 1's live review)
        },
        { label: "Remove later with:", command: `gemini mcp remove --scope user ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "GEMINI_API_KEY", description: "AI Studio key instead of browser sign-in" },
    { key: "GOOGLE_API_KEY", description: "Google API key when using the Google provider path" },
    { key: "GEMINI_CLI_HOME", description: "Home directory that holds the .gemini config (default: the OS home, so ~/.gemini); keep sign-in and MCP registration on the same one" },
  ],
  suggestedFlags: () => [
    { flag: "--skip-trust", description: "Trust this workspace for the session" },
    { flag: "--resume latest", description: "Continue the most recent conversation" },
    { flag: "--session-id <uuid>", description: "Start under a chosen session id" },
    { flag: "-o json", description: "Machine-readable output (headless runs)" },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
```

Check the `SettingsField` union in `packages/plugin-api/src/types.ts` for the exact select shape and match it. Corrected by Task 1's live review: `choices` is `string[]`, so the select option items are plain strings with no item keys to match, `validatePreset` answers with `.valid` rather than `.ok`, and the `--` separator shown in the `mcp add` command is rejected by gemini's parser, so the server name and quoted argv follow the options directly.

- [ ] **Step 6: Run tests, expect green.** Then `cd packages/plugins/gemini && bun run build && bun run verify-types`.

- [ ] **Step 7: Wire the registry + pane-runtime deps + test arrays** (shared "Registry wiring" section). Pane-runtime suite green.

- [ ] **Step 8: Docs pages** (shared "Docs updates" section; MCP row for Gemini: "One-time registration on the execution host."; mirror grok-build's page wording for the `gemini mcp add --scope user` commands).

- [ ] **Step 9: Changeset** `.changeset/gemini-harness-plugin.md`:

```markdown
---
"@subshell-ai/plugin-gemini": minor
"@internal/server": minor
"@internal/node": minor
---

Add the Gemini CLI harness plugin: launch, detect, and install guidance ship now, with Subshell MCP as a one-time host registration.
```

- [ ] **Step 10: `bun install`, `bunx syncpack fix`, `bun install`, `bun run lint:lockfile:fix`, `bun run lint`, `bun run lint:check`, `bun run verify:changed`.** Then pane gate re-check: `/tmp/hv/gemini/bin/gemini --approval-mode auto_edit` relaunched in a detached tmux session renders (kill after capture).

- [ ] **Step 11: Commit** `feat(gemini): add the Gemini CLI harness plugin` (single commit; message body notes the 0.67.0 verification).

## Task 2: Qwen Code plugin

**Files/shape:** identical to Task 1 with `id` `qwen-code`, package `@subshell-ai/plugin-qwen-code`, dir `packages/plugins/qwen-code`.

**Interfaces:** Produces id `qwen-code`, binary `qwen`, `envOverride` `QWEN_PATH`. The four test arrays already contain `gemini` (leave it).

- [ ] **Step 1: Verify** `/tmp/hv/qwen/bin/qwen --version` (0.27.0+) and `qwen --help | grep -E "workflow-mode|chat-recording|resume"`. It is a Gemini CLI fork, but map ONLY its own verified flags: `-m/--model`, `--workflow-mode <on|off>`; `suggestedFlags` describes `--resume` honestly: recording is ON by default; resume only fails when recording was explicitly turned off (corrected by Task 2's live review; do not repeat the "requires --chat-recording" framing).

- [ ] **Step 2-6:** Write the test (same structure; expected capabilities `["mcp", "settings"]`; settings argv test uses `{ model: "qwen max", workflowMode: "on" }` → `["--model", "qwen max", "--workflow-mode", "on"]`; MCP step expects `qwen mcp add` and NOT a `--scope` flag, since user scope is qwen's default). Then package.json (name `@subshell-ai/plugin-qwen-code`, description "Qwen Code harness plugin for Subshell", manifest `name`: "Qwen Code", `detect`: binaryName `qwen`, envOverride `QWEN_PATH`, knownPaths `[".npm-global/bin/qwen", ".local/bin/qwen"]`, install `npm i -g @qwen-code/qwen-code`, docsUrl `https://github.com/QwenLM/qwen-code`). Icon: orange circle, letter Q (`#E8590C`). Factory `mcpSetup` step: `qwen mcp add ${MCP_SERVER_NAME} -- <argv…>`, removal `qwen mcp remove ${MCP_SERVER_NAME}`; `suggestedEnv`: `DASHSCOPE_API_KEY`, `OPENAI_API_KEY`, plus a note row `QWEN_HOME` ONLY if `qwen --help` or docs show it, else omit.

- [ ] **Step 7-11:** Registry wiring, docs (page `agents/qwen-code.mdx`, table row), changeset `qwen-harness-plugin.md`, full check commands, commit `feat(qwen-code): add the Qwen Code harness plugin`.

## Task 3: Cline plugin

**Id** `cline`, binary `cline`, envOverride `CLINE_PATH`. Launch: `cline -i` (the TUI; verified ALIVE in tmux 2026-11-07). Settings (all verified 3.0.74): `-m <model-id>`, `-P <provider>`, `--thinking <none|low|medium|high|xhigh>`. No auto-approve settings field: default act mode auto-approves, so add to `suggestedFlags` `--auto-approve false` and `--id <session-id>` and `--retries <n>`. `suggestedEnv`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (provider keys), `CLINE_DIR` only if verified, else omit.

**MCP:** `cline mcp add <name> [args...]` opens a prefilled wizard (verified). Step 1 of this task: run `cline mcp add --help` and check for a non-interactive flag; if one exists use it in the manual step, else word the manual step truthfully: "Open the prefilled registration wizard and save:". The wizard prefill IS the documented command, so `mcp` stays declared either way (the wizard takes the argv as `targetArgs`).

**package.json:** name `@subshell-ai/plugin-cline`, manifest name "Cline", detect binaryName `cline`, knownPaths `[".npm-global/bin/cline", ".local/bin/cline"]`, install `npm i -g cline`, docsUrl `https://docs.cline.bot/cli/cli-reference`. Icon: dark circle with teal claw glyph letter C (`#1A1A1A`/`#22D3EE`). buildCommand test goldens: default `["cline", "-i"]`; settings `["cline", "-i", "--model", "claude-sonnet-4-5", "--thinking", "high"]`. Steps 2-11 as Task 1; commit `feat(cline): add the Cline harness plugin`.

## Task 4: Open Interpreter plugin

**Id** `open-interpreter`, binary `interpreter`, envOverride `INTERPRETER_PATH`. Launch: bare `interpreter` (TUI, ALIVE in tmux). Settings: `-m/--model` only (0.0.59 verified). Capabilities `["mcp", "settings"]`.

**MCP:** `interpreter mcp add` exists (verified subcommand list). Step 1: `interpreter mcp add --help` to learn whether argv or a `--config` JSON form is accepted; word the manual step with the verified syntax (add with the stdio argv, remove with `interpreter mcp remove subshell`). If add is interactive-only, mirror Task 3's wizard wording.

**package.json:** name `@subshell-ai/plugin-open-interpreter`, manifest name "Open Interpreter", detect binaryName `interpreter`, knownPaths `[".local/bin/interpreter", ".openinterpreter/packages/standalone/current/bin/interpreter"]`, install `curl -fsSL https://www.openinterpreter.com/install | sh`, docsUrl `https://openinterpreter.com`. Icon: forest-green circle letter OI (`#2F6F49`). `suggestedEnv`: `OPENAI_API_KEY`, `INTERPRETER_HOME` (default `~/.openinterpreter`, verified from the installer). `suggestedFlags`: corrected by Task 4's live review on 0.0.59: `--resume` does NOT exist (resume is a subcommand, and the pane's flag editor cannot carry subcommand tokens); ship the verified family instead: `--ask-for-approval never`, `--approve-for-me`, `-c model="<id>"`, with no copy claiming a default. Changeset `open-interpreter-harness-plugin.md`; commit `feat(open-interpreter): add the Open Interpreter harness plugin`.

## Task 5: OpenHands plugin

**Id** `openhands`, binary `openhands`, envOverride `OPENHANDS_PATH`. Launch: bare `openhands` (TUI, ALIVE in tmux). **Capabilities `["mcp"]` only**: no settings flags verified in `--help` (model config is the wizard/`cli_config.json`), so no `settings` capability and no `presetSettings`. `validatePreset: validateGenericPreset` stays.

**MCP:** `openhands mcp` exists (verified subcommand; SDK 1.21.0 banner prints to stderr, suppress nothing). Step 1: `openhands mcp --help` (set `OPENHANDS_SUPPRESS_BANNER=1` for the probe only), then write the manual add/remove steps from its real syntax. If it is config-file based (`cli_config.json`), word the step as editing that file and include the JSON snippet built from `launch`.

**package.json:** name `@subshell-ai/plugin-openhands`, detect binaryName `openhands`, knownPaths `[".local/bin/openhands"]`, install `uv tool install openhands --python 3.12`, docsUrl `https://docs.openhands.dev/openhands/usage/cli/installation`. Icon: indigo circle letter O (`#4F46E5`). `suggestedEnv`: `OPENHANDS_SUPPRESS_BANNER` (set to 1 to hide the SDK banner in panes), `LLM_MODEL` / `LLM_API_KEY` ONLY if shown by `openhands --help` or the docs page fetched in Step 1, else omit. `suggestedFlags`: `--last`, `--always-approve`, `--headless`, `--json`. Changeset `openhands-harness-plugin.md`; commit `feat(openhands): add the OpenHands harness plugin`.

## Task 6: OpenClaw plugin

**Id** `openclaw`, binary `openclaw`, envOverride `OPENCLAW_PATH`. Launch: `openclaw chat` (the embedded local TUI; verified ALIVE in tmux 2026-11-07 with no Gateway running, so no gateway prerequisite). **Capabilities `[]`** (ruling above: no settings flags for launch, MCP is gateway-scoped and would bind one pane's credential host-wide). The factory is the minimal shape (see `packages/plugins/ssh/src/index.ts` for a zero-capability mold): `buildCommand` returns `[binary, "chat", ...flags, ...extra]`; no `presetSettings`, no `mcpSetup`; `validatePreset: validateGenericPreset` still guards preset hygiene.

**package.json:** name `@subshell-ai/plugin-openclaw`, manifest name "OpenClaw", description "Open-source personal agent with an embedded terminal UI", detect binaryName `openclaw`, knownPaths `[".npm-global/bin/openclaw", ".local/bin/openclaw"]`, install `npm i -g openclaw`, docsUrl `https://docs.openclaw.ai`. Icon: coral circle letter O with claw (`#FF5A36`). `suggestedEnv`: `OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_TOKEN`. `suggestedFlags`: corrected by Task 6's live review on 2026.11.1: `tui` and `resume` are top-level SUBCOMMANDS, not attachable after `chat` by the pane's flag editor, so ship only the live-verified chat-level `--session <key>`. The docs page MUST state plainly: cross-subshell comms are not wired for OpenClaw yet and why (gateway-scoped MCP, per the ruling). Changeset `openclaw-harness-plugin.md`; commit `feat(openclaw): add the OpenClaw harness plugin`.

## Task 7: Whole-batch verification sweep

**Files:** none expected; report-only, plus fixes if a check fails.

- [ ] **Step 1:** `env -u SHELLOPTS -u BASHOPTS bun run test:changed -- --plan` from the repo root; run the planned set once.
- [ ] **Step 2:** `bun run verify:changed` full pass (builds pane-runtime, server, node; catches bundling).
- [ ] **Step 3:** Boot an isolated dev instance (never `:3080`; `e2e/stack.ts` pattern or `DEV_API_ORIGIN` per `apps/server/web/AGENTS.md`), and with an admin session confirm the Plugins catalog lists all fifteen built-in harnesses (19 packages after this batch: 15 harness + 4 network) with correct detect + install rows, and launch ALL SIX new harnesses in panes through the API (binaries under /tmp/hv; detection via each plugin's envOverride) and see each TUI render in the pane log. Mobile gates Theo added 2026-11-07: run e2e/tests/09-mobile-terminal.spec.ts and 09-mobile-scroll.spec.ts on the fresh stack (prepend 01-setup-wizard; globalSetup wipes .auth per invocation), exercise the key bar's bytes against at least one new-harness pane (TUIs own the alternate screen: the witness is the TUI reacting to the bytes, plus the bar's own horizontal drag under touch), and leave the dev server up at the hot-reload URL with the test login for Theo's device poke. Cleanup rule (a prior session was killed by violating this): kill only PIDs the test spawned and recorded; no pattern kills, nothing near service definitions or :3080.
- [ ] **Step 4:** `bun run lint:check`, `bun run lint:licenses`, `bun run lint:lockfile`, `bun run lint:design` (untouched but cheap), and the docs prose/content validation for the six new pages.
- [ ] **Step 5:** Report which tiers ran and any blocked tier, verbatim outputs for failures. Commit anything the sweep had to fix (`test(plugins): align built-in sets after the six-harness batch`).

## After all tasks

Run the whole-branch review per subagent-driven-development (`scripts/review-package` from `git merge-base origin/main HEAD`), most capable model, pointing it at the ledger's deferred/parked lines. Do not merge; finishing-a-development-branch presents that to Theo.
