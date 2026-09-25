import { describe, expect, it } from "bun:test";
import { parseCommandPaste, parseEnvPaste, parseFlagsPaste, presetFormToCommand } from "../preset-command";
import { emptyPresetForm } from "../preset-form";

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
    // A `--` AFTER the first flag is not a separator, it opens a row — the
    // only pin for the walk's `first` latch, which two otherwise-surviving
    // mutations would erase (round-4 mutation audit, 2026-09-25).
    expect(parseFlagsPaste("--f v -- --g w")).toEqual([
      { flag: "--f", value: "v" },
      { flag: "--", value: "" },
      { flag: "--g", value: "w" },
    ]);
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

  it("restores a leading dash that smart typography converted", () => {
    // A command copied out of rich text arrives typeset: `--auto` as `—auto`
    // (U+2014). The old walk saw no ASCII hyphen and glued the token onto the
    // previous flag's value.
    expect(parseFlagsPaste("opencode --effort xhigh —auto")).toEqual([
      { flag: "--effort", value: "xhigh" },
      { flag: "--auto", value: "" },
    ]);
    // Every multi-hyphen map entry is pinned by name, so flipping a
    // DASH_REPLACEMENTS value fails (round-2 review, 2026-09-25).
    expect(parseFlagsPaste("opencode –auto")).toEqual([{ flag: "--auto", value: "" }]);
    expect(parseFlagsPaste("opencode ―auto")).toEqual([{ flag: "--auto", value: "" }]);
  });

  it("maps the single-hyphen dash lookalikes to one hyphen", () => {
    expect(parseFlagsPaste("opencode −m anthropic/claude ‑v")).toEqual([
      { flag: "-m", value: "anthropic/claude" },
      { flag: "-v", value: "" },
    ]);
    // U+2010 hyphen and U+2012 figure dash, the map's remaining entries.
    expect(parseFlagsPaste("opencode ‐m ‒x")).toEqual([
      { flag: "-m", value: "" },
      { flag: "-x", value: "" },
    ]);
    // A multi-character run maps each dash and restores as one flag (round-5
    // mutation audit: restoring only the first character of a run survived
    // every single-character input, so the loop itself needed this pin).
    expect(parseFlagsPaste("opencode ‒‒x")).toEqual([{ flag: "--x", value: "" }]);
  });

  it("leaves a typographic dash inside a value as data", () => {
    expect(parseFlagsPaste('--prompt "make it — nice"')).toEqual([{ flag: "--prompt", value: "make it — nice" }]);
  });

  it("does not restore a dash run the source left spaced or standing alone", () => {
    // The regression this pins (review 2026-09-25): the tokenizer consumes
    // quotes BEFORE classification, so `--title "— Q3"` arrives as the token
    // `— Q3`. Restoring its leading dash would open a flag row and destroy a
    // value the pre-fix code kept — and `presetFormToCommand` emits exactly
    // that shape for any flag value starting with a spaced em dash.
    expect(parseFlagsPaste('claude --title "— Q3"')).toEqual([{ flag: "--title", value: "— Q3" }]);
    expect(parseFlagsPaste("--prompt hello — world")).toEqual([{ flag: "--prompt", value: "hello — world" }]);
    // The accepted trade in the other direction, pinned so a future
    // "consistency fix" cannot silently undo it: the bug's shape IS a
    // leading-dash token with no space, and quotes are consumed before
    // classification, so a quoted `—Q3` restores too — exactly the rule
    // `--f "-x"` already follows for ASCII.
    expect(parseFlagsPaste('--f v "—Q3"')).toEqual([
      { flag: "--f", value: "v" },
      { flag: "--Q3", value: "" },
    ]);
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

  it("restores typographic dashes instead of gluing them onto the previous flag", () => {
    // The bug this pins, as reported: a paste whose `--chrome` had been
    // typeset to `—chrome` by a chat UI, and `--effort` ended up holding
    // "xhigh —chrome".
    expect(parseCommandPaste("claude --effort xhigh —chrome")).toEqual({
      env: [],
      flags: [
        { flag: "--effort", value: "xhigh" },
        { flag: "--chrome", value: "" },
      ],
      command: "claude",
    });
  });

  it("does not mistake a dash-restored flag for the command name", () => {
    const parsed = parseCommandPaste("—chrome --effort xhigh");
    expect(parsed.command).toBeUndefined();
    expect(parsed.flags).toEqual([
      { flag: "--chrome", value: "" },
      { flag: "--effort", value: "xhigh" },
    ]);
  });

  it("keeps em dashes inside env and flag values as data", () => {
    expect(parseCommandPaste('K="a — b" claude --t "x — y"')).toEqual({
      env: [{ key: "K", value: "a — b" }],
      flags: [{ flag: "--t", value: "x — y" }],
      command: "claude",
    });
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
      // A leading em dash is data too: quoted on render, and the restored
      // leading run must not mistake it for a typeset flag (review 2026-09-25).
      "— Q3",
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
