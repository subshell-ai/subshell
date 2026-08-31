import { describe, expect, it } from "bun:test";
import type { ProfileRow } from "@/types/profile";
import { filterSuggestions } from "../autocomplete";
import {
  emptyProfileForm,
  flagTokensToRows,
  formToEnv,
  formToFlagTokens,
  parseEnvPaste,
  parseFlagsPaste,
  profileFormFromRow,
  toProfilePayload,
  toProfileUpdatePayload,
} from "../profile-form";

const baseRow: ProfileRow = {
  id: "p1",
  harnessId: "claude-code",
  name: "Default",
  description: null,
  envJson: null,
  flagsJson: null,
  settingsJson: null,
  isDefault: 1,
  configIsolation: 0,
  restartOnExit: 0,
};

describe("emptyProfileForm", () => {
  it("returns one blank row per section", () => {
    expect(emptyProfileForm()).toEqual({
      harnessId: "",
      name: "",
      envRows: [{ key: "", value: "" }],
      flagRows: [{ flag: "", value: "" }],
      restartOnExit: false,
    });
  });
});

describe("profileFormFromRow", () => {
  it("maps env entries to rows and pairs flag tokens into rows", () => {
    const form = profileFormFromRow({
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
    const form = profileFormFromRow(baseRow);
    expect(form.envRows).toEqual([{ key: "", value: "" }]);
    expect(form.flagRows).toEqual([{ flag: "", value: "" }]);
    expect(form.restartOnExit).toBe(false);
  });

  it("falls back to blank rows when stored JSON is unparseable", () => {
    const form = profileFormFromRow({ ...baseRow, envJson: '{"broken', flagsJson: "[broken" });
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

describe("toProfilePayload / toProfileUpdatePayload", () => {
  const form = {
    ...emptyProfileForm(),
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
    expect(toProfilePayload(form)).toEqual({
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
    expect(toProfilePayload({ ...form, name: "   " }).name).toBe("Untitled");
    expect(toProfileUpdatePayload({ ...form, name: "" }).name).toBe("Untitled");
  });

  it("the PUT body is the POST body minus harnessId and settings", () => {
    const update = toProfileUpdatePayload(form);
    expect(update).toEqual({
      name: "Work",
      env: { A: "1" },
      flags: ["--model", "sonnet"],
      configIsolation: false,
      restartOnExit: true,
    });
    expect(Object.keys(update).sort()).toEqual(
      Object.keys(toProfilePayload(form))
        .filter((k) => k !== "harnessId" && k !== "settings")
        .sort(),
    );
  });
});
