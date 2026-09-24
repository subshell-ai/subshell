import { describe, expect, it } from "bun:test";
import type { PresetRow } from "@/types/preset";
import { filterSuggestions } from "../autocomplete";
import {
  emptyPresetForm,
  flagTokensToRows,
  formToEnv,
  formToFlagTokens,
  presetFormFromRow,
  suggestCloneName,
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

describe("suggestCloneName", () => {
  const row = (over: Partial<PresetRow>): PresetRow => ({ ...baseRow, ...over });

  it("suggests (2) when nothing collides", () => {
    const src = row({ id: "a", name: "Work" });
    expect(suggestCloneName([src], src)).toBe("Work (2)");
  });

  it("skips taken suffixes and fills a gap", () => {
    const src = row({ id: "a", name: "Work" });
    const rows = [src, row({ id: "b", name: "Work (2)" }), row({ id: "c", name: "Work (4)" })];
    expect(suggestCloneName(rows, src)).toBe("Work (3)");
  });

  it("matches case-insensitively like the NOCASE index", () => {
    const src = row({ id: "a", name: "Work" });
    expect(suggestCloneName([src, row({ id: "b", name: "wOrK (2)" })], src)).toBe("Work (3)");
  });

  it("ignores a same-named row under a different harness", () => {
    const src = row({ id: "a", name: "Work" });
    const rows = [src, row({ id: "b", name: "Work (2)", harnessId: "pi" })];
    expect(suggestCloneName(rows, src)).toBe("Work (2)");
  });

  it("a source already named X (2) nests the suffix, deterministically", () => {
    const src = row({ id: "a", name: "Work (2)" });
    expect(suggestCloneName([src], src)).toBe("Work (2) (2)");
  });

  it("keeps the suggestion within the API's 120-char name limit", () => {
    // The rule: the FULL candidate base + " (2)" fits 120, so the base is
    // trimmed to 120 minus the suffix length — 116 for n=2. A prefill the
    // server can only 400 is worse than a shorter suggestion.
    const src = row({ id: "a", name: "n".repeat(120) });
    const suggested = suggestCloneName([src], src);
    expect(suggested.length).toBeLessThanOrEqual(120);
    expect(suggested.startsWith("n".repeat(115))).toBe(true);
    expect(suggested).toBe(`${"n".repeat(116)} (2)`);
  });
});
