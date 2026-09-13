import { describe, expect, test } from "bun:test";
import { brokenBuiltIns, builtInHarnesses, getHarness, type PresetDefinition } from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER } from "@internal/subshell-protocol";
import { planRemoteSubshellMcp } from "@/services/mcp-launch.js";

/**
 * THE GATE of the plugins-on-the-control-plane inversion (spec 2026-09-10 §5).
 *
 * The claim this pins: `RemoteLauncher.launch` builds the launch argv with
 * {@link HARNESS_BINARY_PLACEHOLDER} in the binary slot, and the node
 * reproduces EXACTLY the argv it builds today by substituting its freshly
 * resolved binary path into that slot. Both production callers feed
 * `buildCommand` the same input set — `{ binary, cwd, preset, subshellName,
 * mcp, harnessSession }` (here: `remote-launcher.ts`; on the node:
 * `pane-runtime`'s `buildHarnessCommand`, reached by the agent's `launch`
 * command) — so "what the node builds today" is precisely the same
 * `buildCommand` called with the real path instead of the placeholder.
 *
 * Two assertions per case:
 * 1. **Equality**: substituting the placeholder token-for-token (element
 *    equality, never substring replacement) reproduces the node-built argv.
 * 2. **Exactly once**: the placeholder appears exactly once in the
 *    server-built argv. A plugin that interpolated the binary into a longer
 *    string (say `/bin/sh -c "claude …"`) would defeat substitution
 *    SILENTLY — the placeholder would be present but no element would equal
 *    it — and this count is the check that catches it.
 *
 * The input matrix is per-plugin × (settings: unset/null/empty/set) ×
 * (preset flags: absent/present) × (harnessSession: absent / "start" =
 * session-id pin / "resume") × (mcp: absent/present), plus one adversarial
 * row. Dimensions a plugin ignores still run through the matrix: parity must
 * hold for inputs the plugin ignores, because the SERVER sends them whether
 * or not the plugin reads them. The settings fixture is each plugin's own
 * settings keys (what its `presetSettings()` editor stores), so the
 * "settings set" row exercises the real interpolation paths, not opaque keys.
 *
 * The mcp registration is the REAL one for the remote path:
 * `planRemoteSubshellMcp` (the same function `subshell-manager.#planMcp`
 * calls), driven with static node facts. For hermes and pi it is `undefined`
 * by production shape — neither has a per-subshell MCP format (manual setup
 * only), so "present" and "absent" are the same input the launch really
 * carries for them.
 *
 * `extraFlags` is deliberately NOT in the matrix: neither production caller
 * passes it (it is not on `LaunchPlan` and not on the `launch` frame), so a
 * parity claim about it would describe no real launch.
 */

/** The binary path the node would freshly resolve at spawn time. */
const REAL_BINARY = "/home/node-user/.local/bin/subshell-harness";

/** Static stand-in for the node's live `ready` facts (spec §6.4 shapes). */
const NODE_FACTS = {
  dataDir: "/home/node-user/.local/share/subshell",
  // The compiled-agent shape of the ready-reported self-invocation; the
  // parity claim is about the ARGV, and any faithful command serves it.
  selfInvoke: { command: "/home/node-user/.local/bin/subshell", args: [] },
};

/** The subshell id the MCP config path is composed from (both sides, same input). */
const SUBSHELL_ID = "sshp_parity0001";

/** Each built-in's own settings keys — what its preset editor can store. */
const SETTINGS_FIXTURES: Record<string, Record<string, unknown>> = {
  "claude-code": { permissionMode: "acceptEdits", model: "sonnet", maxTokens: 8192 },
  codex: { model: "gpt-5-codex", sandbox: "workspace-write", askForApproval: "on-request" },
  opencode: { model: "anthropic/claude-sonnet-4-5", agent: "plan", auto: true },
  hermes: { model: "anthropic/claude-sonnet-4.6", provider: "openrouter", toolsets: "web,files" },
  pi: { model: "sonnet:high", provider: "anthropic", thinking: "high" },
  // Terminal has no settings keys its preset editor can store, so its
  // "settings set" row is the empty object on purpose — the parity claim is
  // that the matrix holds for inputs the plugin ignores, and a shell ignores
  // all of them.
  terminal: {},
};

/**
 * Derived, never hand-listed: a hand-synced list is itself a bypass, because
 * a sixth built-in added to pane-runtime would simply not appear and the
 * gate would silently shrink. What the registry ANSWERS is what the matrix
 * runs; the completeness test below fails loudly if a built-in failed to
 * CONSTRUCT (that case removes it from this list), and the per-id fixture
 * guard fails loudly if one resolves without a settings fixture.
 */
const BUILTIN_IDS: string[] = builtInHarnesses().map((h) => h.id);

test("the built-in set is complete: nothing failed to construct", () => {
  // `builtInHarnesses()` omits built-ins whose factory threw; the matrix
  // iterating such a shrunken list would read as parity passing while one
  // built-in silently stopped being tested. Its absence must be loud.
  expect(brokenBuiltIns()).toEqual([]);
  expect(BUILTIN_IDS.length).toBeGreaterThanOrEqual(5);
});

/** One stored preset flag pair: multi-word tokens included, as the row editor stores them. */
const PRESET_FLAGS = ["--dangerously-skip-permissions", "--model sonnet"];

/** One matrix row: everything except `binary`, which the two calls differ on. */
interface MatrixRow {
  /** Test-name suffix describing the input combination. */
  label: string;
  settings: Record<string, unknown> | null;
  flags: string[];
  harnessSession?: { id: string; mode: "start" | "resume" };
  /** true = pass the production-computed remote registration (undefined for manual-setup harnesses). */
  mcp: boolean;
  subshellName: string;
}

/** The 3×2×3×2 cross product, plus the adversarial row. */
function matrixRows(settingsFixture: Record<string, unknown>): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const settingsVariants: { label: string; value: Record<string, unknown> | null }[] = [
    { label: "settings unset(null)", value: null },
    { label: "settings empty", value: {} },
    { label: "settings set", value: settingsFixture },
  ];
  const flagVariants = [
    { label: "no flags", value: [] as string[] },
    { label: "flags present", value: PRESET_FLAGS },
  ];
  const sessionVariants: { label: string; value: MatrixRow["harnessSession"] }[] = [
    { label: "no harnessSession", value: undefined },
    {
      label: "harnessSession start (session-id pin)",
      value: { id: "5f0c1a2b-0000-4000-8000-00000000000a", mode: "start" },
    },
    { label: "harnessSession resume", value: { id: "5f0c1a2b-0000-4000-8000-00000000000a", mode: "resume" } },
  ];
  const mcpVariants = [
    { label: "mcp absent", value: false },
    { label: "mcp present", value: true },
  ];

  for (const settings of settingsVariants) {
    for (const flags of flagVariants) {
      for (const session of sessionVariants) {
        for (const mcp of mcpVariants) {
          rows.push({
            label: `${settings.label}; ${flags.label}; ${session.label}; ${mcp.label}`,
            settings: settings.value,
            flags: flags.value,
            harnessSession: session.value,
            mcp: mcp.value,
            subshellName: "parity subshell",
          });
        }
      }
    }
  }

  // Adversarial: the placeholder as a SUBSTRING of a user-stored flag token,
  // with an empty subshell name. Substitution is element-equality, not a
  // substring replace, so this flag must survive verbatim on both sides and
  // the placeholder count must stay exactly 1.
  rows.push({
    label: `adversarial: placeholder substring in a flag + empty name; settings set; flags present; harnessSession resume; mcp present`,
    settings: settingsFixture,
    flags: [`--append-system-prompt the binary is ${HARNESS_BINARY_PLACEHOLDER} inside a longer token`],
    harnessSession: { id: "5f0c1a2b-0000-4000-8000-00000000000a", mode: "resume" },
    mcp: true,
    subshellName: "",
  });

  return rows;
}

/** Build the preset the row names — identical object content on both sides. */
function presetFor(row: MatrixRow): PresetDefinition {
  return {
    name: "parity-preset",
    env: {},
    flags: row.flags,
    settings: row.settings,
    configIsolation: false,
  };
}

for (const id of BUILTIN_IDS) {
  const harness = getHarness(id);
  if (!harness) {
    // Unreachable with a derived id list (`BUILTIN_IDS` comes from the very
    // registry read here), kept as the narrowing that turns it into a loud
    // failure instead of an unchecked dereference.
    test(`${id}: built-in harness must be in the registry`, () => {
      throw new Error(`built-in plugin "${id}" is not in the pane-runtime registry`);
    });
    continue;
  }

  if (!(id in SETTINGS_FIXTURES)) {
    // Same loudness as the missing-harness guard: a built-in the matrix
    // never heard of must FAIL the gate. `?? {}` used to run every new
    // plugin against an empty fixture, which reads identical to parity
    // passing on a plugin that genuinely takes no settings.
    test(`${id}: settings fixture must exist`, () => {
      throw new Error(
        `argv-parity: built-in "${id}" has no SETTINGS_FIXTURES entry — EXTEND the matrix, do not slip past it`,
      );
    });
    continue;
  }

  describe(`argv parity: ${id}`, () => {
    const settingsFixture = SETTINGS_FIXTURES[id];
    const realMcp = planRemoteSubshellMcp(harness, SUBSHELL_ID, NODE_FACTS)?.reg;

    for (const row of matrixRows(settingsFixture)) {
      test(`${id}: ${row.label}`, () => {
        const preset = presetFor(row);
        const mcp = row.mcp ? realMcp : undefined;
        const inputs = {
          cwd: "/home/node-user/projects/my app",
          preset,
          subshellName: row.subshellName,
          mcp,
          harnessSession: row.harnessSession,
        };

        // The server side: RemoteLauncher.launch's exact call shape.
        const serverArgv = harness.buildCommand({ ...inputs, binary: HARNESS_BINARY_PLACEHOLDER });
        // The node side today: buildHarnessCommand's exact call shape, with
        // the binary freshly resolved at spawn time.
        const nodeArgv = harness.buildCommand({ ...inputs, binary: REAL_BINARY });

        // (1) Exactly once: one element EQUALS the placeholder. Zero means the
        // plugin interpolated it into a longer string (silent substitution
        // defeat); more than one means the launch is ambiguous.
        const occurrences = serverArgv.filter((a) => a === HARNESS_BINARY_PLACEHOLDER).length;
        expect(occurrences).toBe(1);

        // (2) The substitution contract as an equality: element-equality
        // replace reproduces the node-built argv exactly.
        const substituted = serverArgv.map((a) => (a === HARNESS_BINARY_PLACEHOLDER ? REAL_BINARY : a));
        expect(substituted).toEqual(nodeArgv);
      });
    }
  });
}

/**
 * Sanity: every built-in under test really is one of the six, and the
 * registry is what production reads (`getHarness`, the same accessor
 * `subshell-manager` resolves launches through) — no copies.
 */
test("argv parity: the matrix covers all six built-ins through the production registry", () => {
  const registryIds = BUILTIN_IDS.map((id) => getHarness(id)?.id);
  expect(new Set(registryIds)).toEqual(new Set(["claude-code", "codex", "opencode", "hermes", "pi", "terminal"]));
});
