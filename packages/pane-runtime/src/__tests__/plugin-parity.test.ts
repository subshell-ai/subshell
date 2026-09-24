import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BuildCommandInput,
  McpLaunchSpec,
  McpRegistration,
  McpSetupInfo,
  PluginCapability,
  PresetDefinition,
  SettingsField,
  SubshellPlugin,
} from "@subshell-ai/plugin-api";
import { createInProcessRuntime } from "../plugin-runtime.js";
import { ClaudeCodePlugin } from "./fixtures/claude-code-legacy.js";
import { CodexPlugin } from "./fixtures/codex-legacy.js";
import { HermesPlugin } from "./fixtures/hermes-legacy.js";
import { OpencodePlugin } from "./fixtures/opencode-legacy.js";
import { PiPlugin } from "./fixtures/pi-legacy.js";

/**
 * The extraction must not change what gets executed.
 *
 * This compares the loaded plugin against the class it replaces on every
 * branch of `buildCommand` that varies, and is DELETED along with the class
 * once it has served its purpose. A difference here is a real behaviour
 * change: understand it, never absorb it by editing the expectation.
 */

/** A preset with nothing set, so a case's own field is the only variable. */
const BLANK: PresetDefinition = {
  name: "Default",
  description: null,
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

/**
 * The reporter every claude-code case carries. The legacy class predates the
 * field and ignores it; the extracted plugin needs one to emit hooks at all,
 * so without it the two would differ by the whole `--settings` argument
 * instead of by the one thing that deliberately changed.
 */
const REPORTER = { command: "/bin/subshell-server", args: ["report"] };

/** The fields every case shares; a case overrides only what it is testing. */
function input(over: Partial<BuildCommandInput>): BuildCommandInput {
  return {
    binary: "/bin/claude",
    cwd: "/tmp/work",
    preset: BLANK,
    subshellName: "",
    reporter: REPORTER,
    ...over,
  };
}

/**
 * The argv with each hook COMMAND replaced by a marker, and the Notification
 * entries' `matcher` dropped — the two deliberate post-extraction divergences,
 * normalized so the rest of the comparison keeps working.
 *
 * The legacy class runs `bun -e '<inlined JS>'`, which assumed a bun on the
 * pane's PATH; the extracted plugin re-enters the subshell binary instead,
 * because most machines have no bun and every session opened on
 * `bun: command not found`. And since spec 2026-09-23 the plugin's
 * `Notification` hook carries a matcher so only the notification types that
 * genuinely need a human ring; the legacy class predates it. Everything else
 * about the hooks — which events carry one, their shape, that preset settings
 * merge underneath — still compares exactly, and so does every other argv
 * element.
 */
function normalizeHookCommands(argv: string[]): string[] {
  const idx = argv.indexOf("--settings");
  if (idx === -1) return argv;
  const settings = JSON.parse(argv[idx + 1]) as {
    hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries) {
      if (event === "Notification") delete entry.matcher;
      for (const hook of entry.hooks) hook.command = "<reporter invocation>";
    }
  }
  return argv.map((a, i) => (i === idx + 1 ? JSON.stringify(settings) : a));
}

const SESSION = "11111111-2222-3333-4444-555555555555";

const CASES: { name: string; input: BuildCommandInput }[] = [
  { name: "bare", input: input({}) },
  { name: "named subshell", input: input({ subshellName: "review" }) },
  {
    name: "mcp args splice in after the binary",
    input: input({ mcp: { fileContent: "{}", args: ["--mcp-config", "/tmp/x.json"] } }),
  },
  { name: "a new conversation pins its id", input: input({ harnessSession: { id: SESSION, mode: "start" } }) },
  { name: "an existing conversation resumes", input: input({ harnessSession: { id: SESSION, mode: "resume" } }) },
  {
    name: "preset settings merge under the attention hooks",
    input: input({ preset: { ...BLANK, settings: { permissionMode: "plan", model: "sonnet" } } }),
  },
  {
    name: "a preset that sets its own hooks still gets ours",
    input: input({ preset: { ...BLANK, settings: { hooks: { Stop: [] } } } }),
  },
  {
    name: "preset flags are passed as whole argv tokens",
    input: input({ preset: { ...BLANK, flags: ["--append-system-prompt", "be brief"] } }),
  },
  { name: "extra flags come last", input: input({ extraFlags: ["--verbose"] }) },
  {
    name: "everything at once, in order",
    input: input({
      subshellName: "all",
      mcp: { fileContent: "{}", args: ["--mcp-config", "/tmp/x.json"] },
      harnessSession: { id: SESSION, mode: "resume" },
      preset: { ...BLANK, flags: ["--model", "opus"], settings: { permissionMode: "acceptEdits" } },
      extraFlags: ["--verbose"],
    }),
  },
];

/** The extracted package, loaded exactly the way the agent will load it. */
async function loadExtracted(): Promise<SubshellPlugin> {
  const dir = join(import.meta.dir, "..", "..", "..", "plugins", "claude-code");
  const result = await createInProcessRuntime().load(dir);
  if ("error" in result) throw new Error(`the extracted plugin failed to load: ${result.error}`);
  // Every plugin in this file is a harness by manifest; the loader has already
  // proved the object matches its type, so this narrows rather than assumes.
  return result.plugin as SubshellPlugin;
}

describe("claude-code parity", () => {
  for (const c of CASES) {
    it(`builds the same argv: ${c.name}`, async () => {
      const legacy = new ClaudeCodePlugin().buildCommand(c.input);
      const loaded = await loadExtracted();
      expect(normalizeHookCommands(loaded.buildCommand(c.input))).toEqual(normalizeHookCommands(legacy));
    });
  }

  it("renders the same MCP registration", async () => {
    const launch = { command: "/bin/subshell-server", args: ["mcp"] };
    const legacy = new ClaudeCodePlugin().mcpRegistration(launch, "/tmp/mcp.json");
    const loaded = await loadExtracted();
    expect(loaded.mcpRegistration?.(launch, "/tmp/mcp.json")).toEqual(legacy);
  });

  it("describes MCP setup the same way", async () => {
    const launch = { command: "/bin/subshell-server", args: ["mcp"] };
    const loaded = await loadExtracted();
    expect(loaded.mcpSetup?.(launch)).toEqual(new ClaudeCodePlugin().mcpSetup(launch));
  });

  it("maps the same exit codes", async () => {
    const legacy = new ClaudeCodePlugin();
    const loaded = await loadExtracted();
    for (const code of [0, 1, 5, 10, 11, 137]) {
      expect(loaded.exitStatus?.(code) ?? null).toEqual(legacy.exitStatus(code));
    }
  });

  it("offers the same preset-editor reference data", async () => {
    const legacy = new ClaudeCodePlugin();
    const loaded = await loadExtracted();
    expect(loaded.presetSettings?.()).toEqual(legacy.settingsFields());
    expect(loaded.suggestedEnv?.()).toEqual(legacy.suggestedEnv());
    expect(loaded.suggestedFlags?.()).toEqual(legacy.suggestedFlags());
  });

  it("computes the transcript path the legacy probe checks (the resume contract's inversion)", async () => {
    // Spec 2026-09-10 §5 moved the resume from node-local I/O to a PURE path
    // computation the host stats. Parity now means: the path the extracted
    // `resumePath` computes IS the path the legacy `canResume` existsSync'd,
    // for the same environment. Planting a real transcript at the
    // legacy-computed location and requiring the extracted path to land on
    // the same file is what catches either side's slug/config-dir drifting —
    // a bare both-false comparison would pass on any two mismatched paths.
    const loaded = await loadExtracted();
    const resume = loaded.resume;
    if (!resume) throw new Error("the extracted claude-code lost its resume member");
    const id = resume.allocateHarnessSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const cfg = mkdtempSync(join(tmpdir(), "subshell-parity-cfg-"));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg; // what the LEGACY class reads from the environment
    try {
      const computed = resume.resumePath(id, "/tmp/work", { homeDir: homedir(), env: { CLAUDE_CONFIG_DIR: cfg } });
      // Fresh id: the file is not there, and the legacy probe says the same.
      expect(existsSync(computed)).toBe(false);
      expect(new ClaudeCodePlugin().resume.canResume(id, "/tmp/work")).toBe(false);

      // Plant the transcript where the OLD implementation looked, and the new
      // pure computation must name exactly that file.
      mkdirSync(join(cfg, "projects", "-tmp-work"), { recursive: true });
      writeFileSync(join(cfg, "projects", "-tmp-work", `${id}.jsonl`), "{}");
      expect(computed).toBe(join(cfg, "projects", "-tmp-work", `${id}.jsonl`));
      expect(existsSync(computed)).toBe(true);
      expect(new ClaudeCodePlugin().resume.canResume(id, "/tmp/work")).toBe(true);
      // The same id in another project dir: neither side finds it there.
      expect(
        existsSync(resume.resumePath(id, "/tmp/other", { homeDir: homedir(), env: { CLAUDE_CONFIG_DIR: cfg } })),
      ).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it("declares the capabilities it actually implements", async () => {
    const loaded = await loadExtracted();
    // claude-code is the only built-in with resume, and the only one with
    // native attention hooks. Both must survive the move.
    expect(loaded.capabilities().sort()).toEqual(["attention", "mcp", "resume", "settings"]);
    expect(loaded.supportsAttentionHooks).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The other four. Same proof, less logic to compare.                  */
/* ------------------------------------------------------------------ */

/** Cases every one of the four is checked against. */
const SHARED_CASES: { name: string; input: BuildCommandInput }[] = [
  { name: "bare", input: input({ binary: "/bin/tool" }) },
  { name: "named subshell", input: input({ binary: "/bin/tool", subshellName: "review" }) },
  {
    name: "mcp args",
    input: input({ binary: "/bin/tool", mcp: { fileContent: "{}", args: ["-c", "x=1"] } }),
  },
  {
    name: "settings drive flags",
    input: input({
      binary: "/bin/tool",
      preset: {
        ...BLANK,
        settings: {
          model: "m",
          agent: "a",
          auto: true,
          provider: "p",
          toolsets: "t",
          sandbox: "s",
          askForApproval: "never",
          thinking: "high",
        },
      },
    }),
  },
  {
    name: "preset flags are whole tokens",
    input: input({ binary: "/bin/tool", preset: { ...BLANK, flags: ["--append", "two words"] } }),
  },
  { name: "extra flags come last", input: input({ binary: "/bin/tool", extraFlags: ["--verbose"] }) },
];

/**
 * Exactly what a parity comparison reads off the pre-extraction class, and no
 * more.
 *
 * Not `HarnessPlugin`: these are frozen snapshots, so holding them to an
 * interface that keeps evolving would mean editing the reference every time
 * the live one changes, which defeats the point of freezing it. Optional here
 * for the two members hermes and pi never had.
 */
interface LegacyReference {
  buildCommand(input: BuildCommandInput): string[];
  mcpSetup(launch: McpLaunchSpec): McpSetupInfo;
  mcpRegistration?(launch: McpLaunchSpec, path: string): McpRegistration;
  settingsFields(): SettingsField[];
  suggestedEnv(): { key: string; description: string }[];
  suggestedFlags(): { flag: string; description: string }[];
}

const OTHERS: { id: string; legacy: () => LegacyReference; caps: PluginCapability[] }[] = [
  { id: "opencode", legacy: () => new OpencodePlugin(), caps: ["mcp", "settings"] },
  { id: "hermes", legacy: () => new HermesPlugin(), caps: ["mcp", "settings"] },
  { id: "pi", legacy: () => new PiPlugin(), caps: ["mcp", "settings"] },
  { id: "codex", legacy: () => new CodexPlugin(), caps: ["mcp", "settings"] },
];

for (const { id, legacy, caps } of OTHERS) {
  describe(`${id} parity`, () => {
    const load = async (): Promise<SubshellPlugin> => {
      const result = await createInProcessRuntime().load(join(import.meta.dir, "..", "..", "..", "plugins", id));
      if ("error" in result) throw new Error(`${id} failed to load: ${result.error}`);
      return result.plugin as SubshellPlugin;
    };

    for (const c of SHARED_CASES) {
      it(`builds the same argv: ${c.name}`, async () => {
        expect((await load()).buildCommand(c.input)).toEqual(legacy().buildCommand(c.input));
      });
    }

    it("renders the same MCP registration and setup", async () => {
      const launch = { command: "/bin/subshell-server", args: ["mcp"] };
      const loaded = await load();
      const old = legacy();
      expect(loaded.mcpRegistration?.(launch, "/tmp/mcp.json")).toEqual(old.mcpRegistration?.(launch, "/tmp/mcp.json"));
      expect(loaded.mcpSetup?.(launch)).toEqual(old.mcpSetup(launch));
    });

    it("offers the same preset-editor reference data", async () => {
      const loaded = await load();
      const old = legacy();
      expect(loaded.presetSettings?.()).toEqual(old.settingsFields());
      expect(loaded.suggestedEnv?.()).toEqual(old.suggestedEnv());
      expect(loaded.suggestedFlags?.()).toEqual(old.suggestedFlags());
    });

    it("declares the capabilities it implements", async () => {
      expect((await load()).capabilities().sort()).toEqual([...caps].sort());
    });
  });
}
