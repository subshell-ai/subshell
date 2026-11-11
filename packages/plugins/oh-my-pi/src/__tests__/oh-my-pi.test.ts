import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset: PresetDefinition = { name: "Default", env: {}, flags: [], settings: null, configIsolation: false };
const input = { binary: "/home/user/.bun/bin/omp", cwd: "/tmp/project", subshellName: "Fix auth", preset };

describe("Oh My Pi", () => {
  it("detects omp independently of pi", () => {
    expect(manifest.id).toBe("oh-my-pi");
    expect(manifest.name).toBe("Oh My Pi");
    expect(manifest.detect).toEqual({
      binaryName: "omp",
      envOverride: "OMP_PATH",
      knownPaths: [".bun/bin/omp", ".local/bin/omp"],
    });
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.capabilities()).toContain("subagents");
    expect(plugin.subagents).toEqual({ discovery: "extension", navigation: "native" });
    expect(plugin.capabilities()).toContain("previews");
    expect(plugin.previews).toEqual({ reporting: "extension" });
    expect(plugin.resume).toBeUndefined();
    expect(plugin.supportsAttentionHooks).not.toBe(true);
  });

  it("opens the interactive CLI without unsupported name or resume flags", () => {
    expect(plugin.buildCommand(input)).toEqual([input.binary]);
  });

  it("maps settings and preserves each argv token", () => {
    expect(
      plugin.buildCommand({
        ...input,
        preset: {
          ...preset,
          settings: { model: "sonnet", provider: "anthropic", thinking: "high" },
          flags: ["--append-system-prompt", "Keep it simple; $(false)"],
        },
        extraFlags: ["--no-session"],
      }),
    ).toEqual([
      input.binary,
      "--model",
      "sonnet",
      "--provider",
      "anthropic",
      "--thinking",
      "high",
      "--append-system-prompt",
      "Keep it simple; $(false)",
      "--no-session",
    ]);
  });

  it("ignores empty and non-string settings", () => {
    expect(
      plugin.buildCommand({ ...input, preset: { ...preset, settings: { model: "", provider: false, thinking: 3 } } }),
    ).toEqual([input.binary]);
  });

  it("ships a native MCP extension using the target host's executable and inherited credentials", () => {
    const launch = { command: "/opt/Subshell Client/subshell", args: ["mcp", "argument with spaces"] };
    const registration = plugin.mcpRegistration?.(launch, "/tmp/subshell config.json");
    if (!registration) throw new Error("Missing MCP registration");
    const files = registration?.files ?? {};
    expect(JSON.parse(files["mcp.json"] ?? "{}")).toEqual({ mcpServers: { subshell: { type: "stdio", ...launch } } });
    expect(files["mcp.json"]).toBe(registration.fileContent);
    expect(JSON.parse(files["package.json"] ?? "{}").omp.extensions).toEqual([
      "bridge.mjs",
      "subagents.mjs",
      "previews.mjs",
      "provider.mjs",
    ]);
    expect(files["bridge.mjs"] ?? "").toContain("export default function");
    expect(files["subagents.mjs"] ?? "").toContain("export default function");
    expect(files["previews.mjs"] ?? "").toContain("export default function");
    // Fixed source, never templated from preset env: the config it reads
    // names MODEL_CLI_OMP_API_KEY instead of carrying the credential, so no
    // secret reaches a node's disk through this file.
    expect(files["provider.mjs"]).toBe(
      `export default function(pi) {
  const raw = process.env.MODEL_CLI_OMP_CONFIG;
  if (!raw) return;
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    pi.logger?.debug?.("model-cli provider config ignored: MODEL_CLI_OMP_CONFIG is not JSON");
    return;
  }

  const CONNECTION_KEYS = ["baseUrl", "api", "apiKey", "models"];
  const MODEL_KEYS = [
    "id",
    "name",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "input",
    "cost",
    "compat",
    "thinking",
  ];
  const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
  const COMPAT_KEYS = [
    "maxTokensField",
    "reasoningContentField",
    "replayReasoningContent",
    "requiresReasoningContentForAllAssistantTurns",
    "supportsDeveloperRole",
    "supportsStore",
    "supportsStrictMode",
    "thinkingFormat",
  ];
  const THINKING_KEYS = ["mode", "efforts", "effortMap"];

  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
  const text = (value) => typeof value === "string" && value !== "";
  const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const positive = (value) => amount(value) && value > 0;
  const command = (value) => {
    if (typeof value === "string") return value.startsWith("!");
    if (Array.isArray(value)) return value.some(command);
    if (isObject(value)) return Object.values(value).some(command);
    return false;
  };
  const cost = (value) => isObject(value) && only(value, COST_KEYS) && Object.values(value).every(amount);
  const compat = (value) =>
    isObject(value) &&
    only(value, COMPAT_KEYS) &&
    Object.values(value).every((item) => typeof item === "string" || typeof item === "boolean");
  const thinking = (value) =>
    isObject(value) &&
    only(value, THINKING_KEYS) &&
    (value.mode === "anthropic-adaptive" || value.mode === "effort") &&
    Array.isArray(value.efforts) &&
    value.efforts.every(text) &&
    isObject(value.effortMap) &&
    Object.values(value.effortMap).every(text);
  const model = (value) =>
    isObject(value) &&
    only(value, MODEL_KEYS) &&
    text(value.id) &&
    (value.name === undefined || text(value.name)) &&
    (value.contextWindow === undefined || positive(value.contextWindow)) &&
    (value.maxTokens === undefined || positive(value.maxTokens)) &&
    (value.reasoning === undefined || typeof value.reasoning === "boolean") &&
    (value.input === undefined ||
      (Array.isArray(value.input) && value.input.every((item) => item === "text" || item === "image"))) &&
    (value.cost === undefined || cost(value.cost)) &&
    (value.compat === undefined || compat(value.compat)) &&
    (value.thinking === undefined || thinking(value.thinking));

  const connection = config?.connection;
  const models = connection?.models;
  const usable =
    typeof config?.provider === "string" &&
    /^model-cli-omp-(?:litellm|direct)-\\S+$/.test(config.provider) &&
    isObject(connection) &&
    only(connection, CONNECTION_KEYS) &&
    typeof connection.baseUrl === "string" &&
    /^https?:\\/\\/.+/.test(connection.baseUrl) &&
    (connection.api === "anthropic-messages" || connection.api === "openai-completions") &&
    connection.apiKey === "MODEL_CLI_OMP_API_KEY" &&
    Array.isArray(models) &&
    models.length > 0 &&
    models.every(model) &&
    !command(config);
  if (!usable) {
    pi.logger?.debug?.("model-cli provider config ignored: MODEL_CLI_OMP_CONFIG is not the model-cli shape");
    return;
  }
  pi.registerProvider(config.provider, connection);
}
`,
    );
    expect(registration?.env).toBeUndefined();
    expect(plugin.buildCommand({ ...input, mcp: registration })).toEqual([
      input.binary,
      "--extension",
      "/tmp/subshell config.json.d",
    ]);
    expect(plugin.mcpSetup?.(launch).mode).toBe("auto");
    // The host enforces these companion-file bounds on local and remote nodes.
    expect(Object.keys(files).length).toBeLessThanOrEqual(8);
    for (const [name, content] of Object.entries(files)) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+\.(mjs|py|json)$/);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("loads the model-cli provider only from a complete config", () => {
    const registration = plugin.mcpRegistration?.(
      { command: "/opt/subshell", args: ["mcp"] },
      "/tmp/subshell config.json",
    );
    const source = registration?.files?.["provider.mjs"];
    if (!source) throw new Error("Missing provider module");
    const factory = (env: Record<string, string | undefined>) => {
      // The shipped module is ESM; strip the export to run the same bytes as
      // a function, the way the subagent bridge test does.
      type Make = (process: {
        env: Record<string, string | undefined>;
      }) => (pi: {
        registerProvider: (...args: unknown[]) => void;
        logger: { debug: (message: string) => void };
      }) => void;
      const make = new Function("process", source.replace("export default", "return")) as Make;
      return make({ env });
    };
    const run = (raw?: string) => {
      const calls: unknown[][] = [];
      const logs: string[] = [];
      factory(raw === undefined ? {} : { MODEL_CLI_OMP_CONFIG: raw })({
        registerProvider: (...args) => calls.push(args),
        logger: { debug: (message) => logs.push(message) },
      });
      return { calls, logs };
    };
    // Unset and empty are normal silence. Anything else that isn't the exact
    // model-cli shape registers nothing and leaves one debug line:
    // registration is applied outside the factory's error guard.
    for (const raw of [undefined, ""]) {
      expect(run(raw)).toEqual({ calls: [], logs: [] });
    }
    const provider = "model-cli-omp-litellm-dsv41-flash-exl3";
    const valid = {
      baseUrl: "http://localhost:4000",
      api: "openai-completions",
      apiKey: "MODEL_CLI_OMP_API_KEY",
      models: [{ id: "m" }],
    };
    const rejects = [
      "{",
      "null",
      "[]",
      "{}",
      JSON.stringify({ provider }),
      // A built-in provider name would apply the override to the user's own
      // provider and models.
      JSON.stringify({ provider: "anthropic", connection: valid }),
      JSON.stringify({ provider, connection: { ...valid, headers: { "x-api-key": "!sh -c id" } } }),
      JSON.stringify({ provider, connection: { ...valid, apiKey: "SUBSHELL_API_KEY" } }),
      JSON.stringify({ provider, connection: { ...valid, apiKey: "!sh -c id" } }),
      JSON.stringify({ provider, connection: { ...valid, models: [] } }),
      JSON.stringify({ provider, connection: { ...valid, models: [{ id: "m", name: "!sh -c id" }] } }),
      JSON.stringify({ provider, connection: { ...valid, models: [{ id: "m", headers: { x: "y" } }] } }),
      JSON.stringify({ provider, connection: { ...valid, transport: "fetch" } }),
      JSON.stringify({ provider, connection: { ...valid, baseUrl: "file:///etc/passwd" } }),
      JSON.stringify({ provider, connection: { ...valid, api: "custom" } }),
      JSON.stringify({ provider, connection: { ...valid, apiKey: undefined } }),
      JSON.stringify({ provider, connection: { ...valid, api: undefined } }),
      JSON.stringify({ provider, connection: { ...valid, baseUrl: undefined } }),
      JSON.stringify({ provider, connection: { ...valid, models: [{}] } }),
    ];
    for (const raw of rejects) {
      const { calls, logs } = run(raw);
      expect(calls).toEqual([]);
      expect(logs).toHaveLength(1);
    }
    // The complete model-cli shape registers verbatim, models and all.
    const connection = {
      ...valid,
      models: [
        {
          id: "dsv41-flash-exl3",
          name: "DeepSeek V4.1 Flash",
          contextWindow: 524288,
          maxTokens: 131072,
          reasoning: true,
          input: ["text"],
          cost: { input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0.3 },
          compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
          thinking: { mode: "effort", efforts: ["low", "high"], effortMap: { low: "low", high: "high" } },
        },
      ],
    };
    expect(run(JSON.stringify({ provider, connection }))).toEqual({ calls: [[provider, connection]], logs: [] });
  });

  it("drops a legacy model-cli extension flag when the launch writes its provider", () => {
    const registration = plugin.mcpRegistration?.(
      { command: "/opt/subshell", args: ["mcp"] },
      "/tmp/subshell config.json",
    );
    if (!registration) throw new Error("Missing MCP registration");
    const legacy = [
      "--extension",
      "~/.cache/model-cli/omp-provider.mjs",
      "--extension=/opt/model-cli/omp-provider.mjs",
      "-e",
      "/home/me/projects/.cache/model-cli/./omp-provider.mjs",
      "--hook",
      "/opt/model-cli//omp-provider.mjs",
      "--hook=/opt/model-cli/omp-provider.mjs ",
      "-e=/opt/model-cli/omp-provider.mjs",
      "--trusted-extension",
      "/opt/model-cli/omp-provider.mjs",
      "--trusted-extension=/opt/model-cli/omp-provider.mjs",
    ];
    const custom = ["--extension", "/opt/custom/provider.mjs"];
    const flags = [...legacy, "--model", "m", ...custom];
    const saved = { ...preset, flags, env: { MODEL_CLI_OMP_CONFIG: "{}" } };
    expect(plugin.buildCommand({ ...input, preset: saved, mcp: registration })).toEqual([
      input.binary,
      "--extension",
      "/tmp/subshell config.json.d",
      "--model",
      "m",
      ...custom,
    ]);
    // The legacy module reads the same variable, so a preset without it would
    // load nothing; drop the flag whenever the module is written.
    expect(plugin.buildCommand({ ...input, preset: { ...preset, flags }, mcp: registration })).toEqual([
      input.binary,
      "--extension",
      "/tmp/subshell config.json.d",
      "--model",
      "m",
      ...custom,
    ]);
    // No provider module was written, so the flag remains the only provider path.
    expect(plugin.buildCommand({ ...input, preset: saved })).toEqual([
      input.binary,
      ...legacy,
      "--model",
      "m",
      ...custom,
    ]);
  });

  it("validates preset inputs", () => {
    expect(plugin.validatePreset(preset).valid).toBe(true);
    expect(plugin.validatePreset({ ...preset, env: { INVALID: 3 as unknown as string } }).valid).toBe(false);
  });
});

describe("Oh My Pi pane titles", () => {
  const parse = plugin.parsePaneTitle;
  if (!parse) throw new Error("Oh My Pi must parse its own pane titles");

  /**
   * omp's brand and run-state separator describe the terminal, not the
   * session. Its pane title is `π <state> <label>`, and the rail mirrored the
   * whole string — `π ⠋ 🚌 Fix the thing` — which reads as a stuck spinner in
   * front of every name (operator screenshot, 2026-11-09). The label keeps
   * its emoji: the generator starts the session name with one.
   */
  it("strips the brand and state separator, keeping the session label", () => {
    expect(parse("π > hmn-vm")).toBe("hmn-vm");
    expect(parse("π ⠋ 🚌 SLASH: Fix the stuck overlay")).toBe("🚌 SLASH: Fix the stuck overlay");
    expect(parse("π ! Waiting for you")).toBe("Waiting for you");
    // The working separator pinned to the static colon (WSL, or a spinner
    // pinned off), the disabled-title form, and the pulse, line and dots
    // spinner styles.
    expect(parse("π : Building")).toBe("Building");
    expect(parse("π: Fix the login bug")).toBe("Fix the login bug");
    expect(parse("π ◑ Building")).toBe("Building");
    expect(parse("π | Building")).toBe("Building");
    expect(parse("π ⠂ Building")).toBe("Building");
  });

  it("answers empty for a title that names no session", () => {
    // The bare brand appears for a moment before the session name lands.
    expect(parse("π")).toBe("");
    expect(parse("π:")).toBe("");
    expect(parse("π ⠋")).toBe("");
  });

  it("keeps a label that merely starts with the brand", () => {
    // No state separator after the brand, so this is not omp's shape.
    expect(parse("π calculus")).toBe("π calculus");
    expect(parse("π-calculus")).toBe("π-calculus");
    expect(parse("π/2 radians")).toBe("π/2 radians");
    // The disabled form always writes a space after its colon.
    expect(parse("π:notes")).toBe("π:notes");
    expect(parse("π:3.14159")).toBe("π:3.14159");
    expect(parse("πrojects dip")).toBe("πrojects dip");
    expect(parse("Fix the login bug")).toBe("Fix the login bug");
  });
});
