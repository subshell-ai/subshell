import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { BuildCommandInput, ProfileDefinition, SubshellPlugin } from "@subshell-ai/plugin-api";
import { createInProcessRuntime } from "../plugin-runtime.js";
import { ClaudeCodePlugin } from "./fixtures/claude-code-legacy.js";

/**
 * The extraction must not change what gets executed.
 *
 * This compares the loaded plugin against the class it replaces on every
 * branch of `buildCommand` that varies, and is DELETED along with the class
 * once it has served its purpose. A difference here is a real behaviour
 * change: understand it, never absorb it by editing the expectation.
 */

/** A profile with nothing set, so a case's own field is the only variable. */
const BLANK: ProfileDefinition = {
  name: "Default",
  description: null,
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

/** The fields every case shares; a case overrides only what it is testing. */
function input(over: Partial<BuildCommandInput>): BuildCommandInput {
  return { binary: "/bin/claude", cwd: "/tmp/work", profile: BLANK, subshellName: "", ...over };
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
    name: "profile settings merge under the attention hooks",
    input: input({ profile: { ...BLANK, settings: { permissionMode: "plan", model: "sonnet" } } }),
  },
  {
    name: "a profile that sets its own hooks still gets ours",
    input: input({ profile: { ...BLANK, settings: { hooks: { Stop: [] } } } }),
  },
  {
    name: "profile flags are passed as whole argv tokens",
    input: input({ profile: { ...BLANK, flags: ["--append-system-prompt", "be brief"] } }),
  },
  { name: "extra flags come last", input: input({ extraFlags: ["--verbose"] }) },
  {
    name: "everything at once, in order",
    input: input({
      subshellName: "all",
      mcp: { fileContent: "{}", args: ["--mcp-config", "/tmp/x.json"] },
      harnessSession: { id: SESSION, mode: "resume" },
      profile: { ...BLANK, flags: ["--model", "opus"], settings: { permissionMode: "acceptEdits" } },
      extraFlags: ["--verbose"],
    }),
  },
];

/** The extracted package, loaded exactly the way the agent will load it. */
async function loadExtracted(): Promise<SubshellPlugin> {
  const dir = join(import.meta.dir, "..", "..", "..", "plugins", "claude-code");
  const result = await createInProcessRuntime().load(dir);
  if ("error" in result) throw new Error(`the extracted plugin failed to load: ${result.error}`);
  return result.plugin;
}

describe("claude-code parity", () => {
  for (const c of CASES) {
    it(`builds the same argv: ${c.name}`, async () => {
      const legacy = new ClaudeCodePlugin().buildCommand(c.input);
      const loaded = await loadExtracted();
      expect(loaded.buildCommand(c.input)).toEqual(legacy);
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

  it("offers the same profile-editor reference data", async () => {
    const legacy = new ClaudeCodePlugin();
    const loaded = await loadExtracted();
    expect(loaded.profileSettings?.()).toEqual(legacy.settingsFields());
    expect(loaded.suggestedEnv?.()).toEqual(legacy.suggestedEnv());
    expect(loaded.suggestedFlags?.()).toEqual(legacy.suggestedFlags());
  });

  it("allocates a resumable conversation id and answers canResume the same way", async () => {
    const loaded = await loadExtracted();
    const id = loaded.resume?.allocateHarnessSessionId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // No transcript exists for a fresh uuid, so both must refuse it.
    expect(loaded.resume?.canResume(id as string, "/tmp/work")).toBe(false);
    expect(new ClaudeCodePlugin().resume.canResume(id as string, "/tmp/work")).toBe(false);
  });

  it("declares the capabilities it actually implements", async () => {
    const loaded = await loadExtracted();
    // claude-code is the only built-in with resume, and the only one with
    // native attention hooks. Both must survive the move.
    expect(loaded.capabilities().sort()).toEqual(["attention", "mcp", "resume", "settings"]);
    expect(loaded.supportsAttentionHooks).toBe(true);
  });
});
