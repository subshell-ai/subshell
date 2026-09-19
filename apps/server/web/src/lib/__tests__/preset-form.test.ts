import { describe, expect, it } from "bun:test";
import type { PresetRow } from "@/types/preset";
import { filterSuggestions } from "../autocomplete";
import {
  emptyPresetForm,
  flagTokensToRows,
  formToEnv,
  formToFlagTokens,
  parseCommandPaste,
  parseEnvPaste,
  parseFlagsPaste,
  presetFormFromRow,
  presetFormToCommand,
  toPresetPayload,
  toPresetUpdatePayload,
} from "../preset-form";

const baseRow: PresetRow = {
  id: "p1",
  harnessId: "claude-code",
  name: "Default",
  description: null,
  envJson: null,
  flagsJson: null,
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 0,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

describe("emptyPresetForm", () => {
  it("returns one blank row per section, with auto-restart already on", () => {
    expect(emptyPresetForm()).toEqual({
      harnessId: "",
      name: "",
      envRows: [{ key: "", value: "" }],
      flagRows: [{ flag: "", value: "" }],
      // Operator's call, 2026-09-18: a preset is a way of running something
      // repeatedly, so recovering from an exit is the expected answer.
      restartOnExit: true,
    });
  });

  it("does not change what an EXISTING preset stored", () => {
    // The default is for a form being filled in. A saved preset with the
    // switch off keeps it off, whatever a new form would start as.
    expect(presetFormFromRow({ ...baseRow, restartOnExit: 0 }).restartOnExit).toBe(false);
    expect(presetFormFromRow({ ...baseRow, restartOnExit: 1 }).restartOnExit).toBe(true);
  });
});

describe("presetFormFromRow", () => {
  it("maps env entries to rows and pairs flag tokens into rows", () => {
    const form = presetFormFromRow({
      ...baseRow,
      name: "Ops",
      envJson: '{"A":"1","B":"two words"}',
      flagsJson: '["--model","sonnet","--verbose"]',
      restartOnExit: 1,
    });
    expect(form).toEqual({
      harnessId: baseRow.harnessId,
      name: "Ops",
      envRows: [
        { key: "A", value: "1" },
        { key: "B", value: "two words" },
      ],
      flagRows: [
        { flag: "--model", value: "sonnet" },
        { flag: "--verbose", value: "" },
      ],
      restartOnExit: true,
    });
  });

  it("treats null blobs as one blank row each and toggles off", () => {
    const form = presetFormFromRow(baseRow);
    expect(form.envRows).toEqual([{ key: "", value: "" }]);
    expect(form.flagRows).toEqual([{ flag: "", value: "" }]);
    expect(form.restartOnExit).toBe(false);
  });

  it("falls back to blank rows when stored JSON is unparseable", () => {
    const form = presetFormFromRow({ ...baseRow, envJson: '{"broken', flagsJson: "[broken" });
    expect(form.envRows).toEqual([{ key: "", value: "" }]);
    expect(form.flagRows).toEqual([{ flag: "", value: "" }]);
  });
});

describe("flagTokensToRows", () => {
  it("drops tokens that appear before the first flag", () => {
    expect(flagTokensToRows(["claude", "--model", "x"])).toEqual([{ flag: "--model", value: "x" }]);
  });
  it("joins several value tokens with spaces", () => {
    expect(flagTokensToRows(["--append-system-prompt", "be", "nice"])).toEqual([
      { flag: "--append-system-prompt", value: "be nice" },
    ]);
  });
});

describe("formToEnv / formToFlagTokens", () => {
  it("skips empty rows", () => {
    expect(
      formToEnv([
        { key: "", value: "x" },
        { key: " A ", value: "1" },
      ]),
    ).toEqual({ A: "1" });
    expect(
      formToFlagTokens([
        { flag: "", value: "x" },
        { flag: "--a", value: "" },
      ]),
    ).toEqual(["--a"]);
  });
  it("keeps a multi-word flag value as one token", () => {
    expect(formToFlagTokens([{ flag: "--prompt", value: "be nice" }])).toEqual(["--prompt", "be nice"]);
  });
  it("round-trips through flagTokensToRows", () => {
    const rows = [
      { flag: "--model", value: "sonnet" },
      { flag: "--auto", value: "" },
    ];
    expect(flagTokensToRows(formToFlagTokens(rows))).toEqual(rows);
  });
});

describe("parseEnvPaste", () => {
  it("parses a JSON object", () => {
    expect(parseEnvPaste('{"ANTHROPIC_MODEL":"sonnet"}')).toEqual([{ key: "ANTHROPIC_MODEL", value: "sonnet" }]);
  });
  it("parses KEY=value and export lines, ignoring blanks and comments", () => {
    expect(parseEnvPaste("# note\nexport A=1\n\nB=2")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });
  it("splits only on the first = and strips one layer of quotes", () => {
    expect(parseEnvPaste('URL="https://x/?a=b"\nTOKEN=abc=def')).toEqual([
      { key: "URL", value: "https://x/?a=b" },
      { key: "TOKEN", value: "abc=def" },
    ]);
  });
  it("throws on a line without = and on invalid names", () => {
    expect(() => parseEnvPaste("JUST_A_WORD")).toThrow();
    expect(() => parseEnvPaste("9BAD=x")).toThrow();
  });
  it("returns [] for empty input and throws on broken JSON", () => {
    expect(parseEnvPaste("  ")).toEqual([]);
    expect(() => parseEnvPaste("{not json")).toThrow();
  });
  it("strips trailing shell-continuation backslashes from KEY=value lines", () => {
    expect(parseEnvPaste('A=1 \\\nB="two" \\\nC=3')).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two" },
      { key: "C", value: "3" },
    ]);
  });
  it("strips the continuation even on the last line and with export", () => {
    expect(parseEnvPaste("export A=1 \\")).toEqual([{ key: "A", value: "1" }]);
  });
});

describe("parseFlagsPaste", () => {
  it("parses one flag per line", () => {
    expect(parseFlagsPaste("--permission-mode plan\n--verbose")).toEqual([
      { flag: "--permission-mode", value: "plan" },
      { flag: "--verbose", value: "" },
    ]);
  });
  it("pairs a full command line and drops a pasted binary prefix", () => {
    expect(parseFlagsPaste("opencode -m anthropic/claude-sonnet-4-5 --auto")).toEqual([
      { flag: "-m", value: "anthropic/claude-sonnet-4-5" },
      { flag: "--auto", value: "" },
    ]);
  });
  it("keeps a quoted multi-word value in one value", () => {
    expect(parseFlagsPaste('--append-system-prompt "be nice"')).toEqual([
      { flag: "--append-system-prompt", value: "be nice" },
    ]);
  });
  it("drops a leading -- separator", () => {
    expect(parseFlagsPaste("-- --model sonnet")).toEqual([{ flag: "--model", value: "sonnet" }]);
  });
  it("throws on an unterminated quote and returns [] for empty input", () => {
    expect(() => parseFlagsPaste('--prompt "oops')).toThrow();
    expect(parseFlagsPaste("")).toEqual([]);
  });
  it("joins a command line wrapped with backslash continuations", () => {
    expect(parseFlagsPaste("opencode -m anthropic/claude-sonnet-4-5 \\\n--auto \\\n")).toEqual([
      { flag: "-m", value: "anthropic/claude-sonnet-4-5" },
      { flag: "--auto", value: "" },
    ]);
  });
  it("glues a token split across a continuation but keeps quoted newlines literal", () => {
    expect(parseFlagsPaste("--mo\\\ndel sonnet")).toEqual([{ flag: "--model", value: "sonnet" }]);
    expect(parseFlagsPaste('--prompt "be \\\nnice"')).toEqual([{ flag: "--prompt", value: "be \\\nnice" }]);
  });
});

describe("filterSuggestions", () => {
  const items = [
    { value: "--model", detail: "d" },
    { value: "--mcp-config", detail: "d" },
    { value: "--permission-mode", detail: "d" },
    { value: "--allowedTools", detail: "d" },
  ];
  it("returns everything for an empty query", () => {
    expect(filterSuggestions("", items)).toEqual(items);
    expect(filterSuggestions("   ", items)).toEqual(items);
  });
  it("ranks prefix matches before substring matches, case-insensitively", () => {
    const hits = filterSuggestions("MODE", items).map((s) => s.value);
    expect(hits).toEqual(["--model", "--permission-mode"]);
  });
  it("returns [] when nothing matches", () => {
    expect(filterSuggestions("--zzz", items)).toEqual([]);
  });
});

describe("toPresetPayload / toPresetUpdatePayload", () => {
  const form = {
    ...emptyPresetForm(),
    harnessId: "pi",
    name: "  Work  ",
    envRows: [
      { key: "A", value: "1" },
      { key: "  ", value: "ignored" },
    ],
    flagRows: [{ flag: "--model", value: "sonnet" }],
    restartOnExit: true,
  };

  it("builds the POST body: trimmed name, parsed rows, reserved constants", () => {
    expect(toPresetPayload(form)).toEqual({
      harnessId: "pi",
      name: "Work",
      env: { A: "1" },
      flags: ["--model", "sonnet"],
      settings: {},
      configIsolation: false,
      restartOnExit: true,
    });
  });

  it("blank name falls back to Untitled in both builders", () => {
    expect(toPresetPayload({ ...form, name: "   " }).name).toBe("Untitled");
    expect(toPresetUpdatePayload({ ...form, name: "" }).name).toBe("Untitled");
  });

  it("the PUT body is the POST body minus harnessId and settings", () => {
    const update = toPresetUpdatePayload(form);
    expect(update).toEqual({
      name: "Work",
      env: { A: "1" },
      flags: ["--model", "sonnet"],
      configIsolation: false,
      restartOnExit: true,
    });
    expect(Object.keys(update).sort()).toEqual(
      Object.keys(toPresetPayload(form))
        .filter((k) => k !== "harnessId" && k !== "settings")
        .sort(),
    );
  });
});

describe("parseCommandPaste", () => {
  it("splits a full terminal command into env vars, the command, and flags", () => {
    const pasted = [
      "ANTHROPIC_BASE_URL=https://llm.ein.disaresta.com \\",
      'ANTHROPIC_API_KEY="sk-ant-api03-0e6bb5" \\',
      'ANTHROPIC_DEFAULT_OPUS_MODEL="Qwen 3.8 Flash Next" \\',
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 \\",
      "claude --dangerously-skip-permissions --effort xhigh",
    ].join("\n");
    expect(parseCommandPaste(pasted)).toEqual({
      env: [
        { key: "ANTHROPIC_BASE_URL", value: "https://llm.ein.disaresta.com" },
        { key: "ANTHROPIC_API_KEY", value: "sk-ant-api03-0e6bb5" },
        // A quoted value holding spaces stays ONE value — the tokenizer keeps
        // it together and the model name is not three flags.
        { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "Qwen 3.8 Flash Next" },
        { key: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", value: "64000" },
      ],
      flags: [
        { flag: "--dangerously-skip-permissions", value: "" },
        { flag: "--effort", value: "xhigh" },
      ],
      command: "claude",
    });
  });

  it("reports an absolute command path verbatim and keeps its flags", () => {
    expect(parseCommandPaste("/usr/local/bin/claude --dangerously-skip-permissions --effort xhigh")).toEqual({
      env: [],
      flags: [
        { flag: "--dangerously-skip-permissions", value: "" },
        { flag: "--effort", value: "xhigh" },
      ],
      command: "/usr/local/bin/claude",
    });
  });

  it("accepts flags with no command at all", () => {
    const parsed = parseCommandPaste("--effort xhigh");
    expect(parsed.command).toBeUndefined();
    expect(parsed.flags).toEqual([{ flag: "--effort", value: "xhigh" }]);
  });

  it("accepts env assignments with no command at all", () => {
    expect(parseCommandPaste("FOO=bar")).toEqual({ env: [{ key: "FOO", value: "bar" }], flags: [] });
  });

  it("skips a leading `env` prefix", () => {
    expect(parseCommandPaste("env FOO=bar claude --x")).toEqual({
      env: [{ key: "FOO", value: "bar" }],
      flags: [{ flag: "--x", value: "" }],
      command: "claude",
    });
  });

  it("treats an assignment AFTER the command as an argument, not an env var", () => {
    const parsed = parseCommandPaste("claude --set FOO=bar");
    expect(parsed.env).toEqual([]);
    expect(parsed.flags).toEqual([{ flag: "--set", value: "FOO=bar" }]);
  });

  it("returns empty halves for empty text", () => {
    expect(parseCommandPaste("   ")).toEqual({ env: [], flags: [] });
  });

  it("throws on an unterminated quote rather than guessing", () => {
    expect(() => parseCommandPaste('claude --p "oops')).toThrow(/quote/i);
  });

  /**
   * Quotes inside quotes are DATA (fixed 2026-09-19). The tokenizer already
   * consumes the shell quoting, so `K="a b"` reaches the assignment branch as
   * the single token `K=a b`; calling `unquote` on that again stripped a
   * second, literal pair. Found by round-tripping hostile values, where
   * `K="''"` came back as the empty string.
   *
   * `parseEnvPaste` keeps its own `unquote` and must — it splits lines and
   * never tokenizes, so the quotes reach it intact. The two are not the same
   * situation, which is why the fix is not symmetric.
   */
  it("keeps quotes that are part of the value, having already been unquoted once", () => {
    expect(parseCommandPaste(`K="'x'"`).env).toEqual([{ key: "K", value: "'x'" }]);
    expect(parseCommandPaste(`K="''"`).env).toEqual([{ key: "K", value: "''" }]);
    expect(parseCommandPaste(`K='"y"'`).env).toEqual([{ key: "K", value: '"y"' }]);
    // The ordinary case is untouched: one layer of shell quoting is removed
    // by the tokenizer and nothing else is.
    expect(parseCommandPaste(`K="a b"`).env).toEqual([{ key: "K", value: "a b" }]);
    expect(parseCommandPaste("K=plain").env).toEqual([{ key: "K", value: "plain" }]);
  });

  it("round-trips every value shape presetFormToCommand can emit", () => {
    // The property the pair exists for, over the values that actually broke
    // it or nearly did. Flag values are compared trimmed because
    // `presetFormToCommand` trims them, exactly as `formToFlagTokens` does.
    const values = [
      "$HOME",
      "`date`",
      "a\nb",
      "c:\\",
      'a"b',
      "it's mine",
      "a b",
      "",
      "#hash",
      "a=b",
      "''",
      '"',
      "\\",
      "ünïcødé",
      "$(whoami)",
      "a  b",
    ];
    for (const value of values) {
      const form = {
        ...emptyPresetForm(),
        envRows: [{ key: "K", value }],
        flagRows: [{ flag: "--f", value }],
      };
      const parsed = parseCommandPaste(presetFormToCommand(form, "claude"));
      expect(parsed.env).toEqual([{ key: "K", value }]);
      expect(parsed.flags).toEqual([{ flag: "--f", value: value.trim() }]);
      expect(parsed.command).toBe("claude");
    }
  });
});

describe("presetFormToCommand", () => {
  it("renders form state as a continued command line", () => {
    const form = {
      ...emptyPresetForm(),
      envRows: [
        { key: "ANTHROPIC_MODEL", value: "sonnet" },
        { key: "BLANK", value: "" },
        { key: "", value: "dropped" },
      ],
      flagRows: [
        { flag: "--dangerously-skip-permissions", value: "" },
        { flag: "--effort", value: "xhigh" },
        { flag: "", value: "dropped" },
      ],
    };
    expect(presetFormToCommand(form, "claude")).toBe(
      ["ANTHROPIC_MODEL=sonnet \\", 'BLANK="" \\', "claude --dangerously-skip-permissions --effort xhigh"].join("\n"),
    );
  });

  it("quotes only what a shell would re-split, and round-trips through the parser", () => {
    const form = {
      ...emptyPresetForm(),
      envRows: [{ key: "MODEL", value: "Qwen 3.8 Flash Next" }],
      flagRows: [{ flag: "--append-system-prompt", value: "be nice" }],
    };
    const line = presetFormToCommand(form, "claude");
    expect(line).toContain('MODEL="Qwen 3.8 Flash Next"');
    const parsed = parseCommandPaste(line);
    expect(parsed.env).toEqual(form.envRows);
    expect(parsed.flags).toEqual(form.flagRows);
    expect(parsed.command).toBe("claude");
  });

  it("round-trips a value holding a single quote", () => {
    const form = { ...emptyPresetForm(), envRows: [{ key: "WHO", value: "it's mine" }] };
    expect(parseCommandPaste(presetFormToCommand(form, "claude")).env).toEqual([{ key: "WHO", value: "it's mine" }]);
  });

  it("prints the assignments alone when no command name is known", () => {
    const form = { ...emptyPresetForm(), envRows: [{ key: "A", value: "1" }] };
    expect(presetFormToCommand(form, "")).toBe("A=1");
  });

  it("is empty for an empty form even with a command name, so the placeholder shows", () => {
    // A bare `claude` in a fresh form's paste box hides the worked example.
    expect(presetFormToCommand(emptyPresetForm(), "claude")).toBe("");
    expect(presetFormToCommand(emptyPresetForm(), "")).toBe("");
  });

  it("prints the command line for env vars alone — that is the whole command", () => {
    const form = { ...emptyPresetForm(), envRows: [{ key: "A", value: "1" }] };
    expect(presetFormToCommand(form, "claude")).toBe("A=1 \\\nclaude");
  });
});
