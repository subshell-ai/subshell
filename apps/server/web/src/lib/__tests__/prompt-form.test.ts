import { describe, expect, it } from "bun:test";
import { promptDraftFromRow, promptDraftSchema, suggestCloneDescription } from "../prompt-form";
import type { OwnPromptRow } from "../prompts";

const row = (over: Partial<OwnPromptRow> = {}): OwnPromptRow => ({
  id: "p1",
  description: "Kickoff",
  body: "Start the task",
  shared: false,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  ...over,
});

describe("promptDraftFromRow", () => {
  it("mirrors the three editable fields and nothing else", () => {
    expect(promptDraftFromRow(row({ shared: true }))).toEqual({
      description: "Kickoff",
      body: "Start the task",
      shared: true,
    });
  });
});

describe("suggestCloneDescription", () => {
  const rows = [row({ id: "a", description: "Kickoff" }), row({ id: "b", description: "Copy of Kickoff" })];
  it("names the copy after the source", () => {
    expect(
      suggestCloneDescription([row({ id: "a", description: "Solo" })], row({ id: "a", description: "Solo" })),
    ).toBe("Copy of Solo");
  });
  it("walks the suffix when the plain copy name is taken", () => {
    expect(suggestCloneDescription(rows, rows[0])).toBe("Copy of Kickoff (2)");
  });
  it("clamps a long source so the seed still passes the 120-char validation", () => {
    const long = "x".repeat(120);
    const seed = suggestCloneDescription([], { description: long });
    expect(seed.length).toBeLessThanOrEqual(120);
    expect(seed.startsWith("Copy of xxx")).toBe(true);
    // The (2) suffix reserves its own room too.
    const taken = [{ description: `Copy of ${long.slice(0, 112)}` }];
    const second = suggestCloneDescription(taken, { description: long.slice(0, 112) });
    expect(second.length).toBeLessThanOrEqual(120);
    expect(second.endsWith("(2)")).toBe(true);
  });
});

describe("promptDraftSchema", () => {
  const messages = (draft: { description: string; body: string; shared: boolean }) =>
    promptDraftSchema.safeParse(draft).error?.issues.map((issue) => issue.message) ?? [];

  it("requires a non-blank description and body", () => {
    expect(messages({ description: "  ", body: "b", shared: false })).toContain("A short description is required");
    expect(messages({ description: "d", body: "", shared: false })).toContain("The prompt text is required");
    expect(promptDraftSchema.safeParse({ description: "d", body: "b", shared: false }).success).toBe(true);
  });
  it("caps the description at 120 chars (the server refuses past it)", () => {
    expect(messages({ description: "x".repeat(121), body: "b", shared: false })).toContain(
      "The description must be 120 characters or fewer",
    );
  });
});
