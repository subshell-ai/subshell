import { describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { emptyNewSubshellForm } from "@/components/subshell-picker/launch-form-rules";
import {
  ACTIVE_GROUP,
  copySettingsOptions,
  isUntouchedForm,
  launchTemplateFromList,
  RECENTLY_TERMINATED_GROUP,
} from "@/lib/launch-defaults";
import type { LaunchAgent } from "@/lib/subshell-compat";
import type { SubshellView } from "@/types/subshell";

/**
 * The pure half of "open the launch form with my last settings" (operator
 * rule 2026-09-25): which row is "most recent" (one selector with the agent
 * default), what disqualifies the auto arm, and what the copy picker lists.
 */

function node(overrides: Partial<Node> & { id: string }): Node {
  return {
    name: overrides.id,
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
    access: "owner",
    canManage: true,
    canLaunch: true,
    allowedDirs: [],
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    held: null,
    ...overrides,
  } as Node;
}

function row(overrides: Partial<SubshellView> & { id: string }): SubshellView {
  return {
    harnessId: "claude-code",
    presetId: null,
    nodeId: "local",
    name: overrides.id,
    workingDir: "/srv/app",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as SubshellView;
}

const PLUGIN = (id: string, name: string): LaunchAgent => ({
  id,
  name,
  installed: true,
  enabled: true,
  broken: undefined,
  type: "agent-harness",
});

describe("launchTemplateFromList", () => {
  it("takes the newest row by creation, with the id tie-break", () => {
    const t = launchTemplateFromList([
      row({ id: "a", createdAt: "2026-09-01T00:00:00.000Z", harnessId: "old" }),
      row({ id: "b", createdAt: "2026-09-12T00:00:00.000Z", harnessId: "pi", nodeId: "a1", workingDir: "/x" }),
    ]);
    expect(t).toEqual({ subshellId: "b", harnessId: "pi", presetId: null, nodeId: "a1", workingDir: "/x" });
    // Same millisecond: `sortByCreation`'s total tie-break (id), never input order.
    const tie = launchTemplateFromList([
      row({ id: "z", createdAt: "2026-09-02T00:00:00.000Z" }),
      row({ id: "y", createdAt: "2026-09-02T00:00:00.000Z" }),
    ]);
    expect(tie?.subshellId).toBe("y");
  });

  it("terminated and shared rows are eligible — a finished launch is the usual source", () => {
    const t = launchTemplateFromList([
      row({ id: "own", createdAt: "2026-09-01T00:00:00.000Z", harnessId: "old" }),
      row({
        id: "done",
        createdAt: "2026-09-10T00:00:00.000Z",
        harnessId: "pi",
        status: "terminated",
        alive: false,
        access: "view",
      }),
    ]);
    expect(t?.harnessId).toBe("pi");
  });

  it("coerces the older-payload optional fields to the wire's defaults", () => {
    const t = launchTemplateFromList([
      { id: "r", harnessId: "claude-code", createdAt: "2026-09-01T00:00:00.000Z" } as SubshellView,
    ]);
    expect(t).toEqual({ subshellId: "r", harnessId: "claude-code", presetId: null, nodeId: "local", workingDir: "" });
  });

  it("empty and unanswered lists yield no template", () => {
    expect(launchTemplateFromList([])).toBeNull();
    expect(launchTemplateFromList(undefined)).toBeNull();
    expect(launchTemplateFromList(null)).toBeNull();
  });
});

describe("isUntouchedForm", () => {
  it("is true only for the empty baseline", () => {
    const empty = emptyNewSubshellForm();
    expect(isUntouchedForm({ ...empty }, empty)).toBe(true);
    expect(isUntouchedForm({ ...empty, harnessId: "pi" }, empty)).toBe(false);
    expect(isUntouchedForm({ ...empty, presetId: "p1" }, empty)).toBe(false);
    // The Split case: a caller-supplied pair (harness + dir) is never untouched.
    expect(isUntouchedForm({ ...empty, workingDir: "/x" }, empty)).toBe(false);
    // The re-home case: a node move alone disqualifies the auto arm too.
    expect(isUntouchedForm({ ...empty, nodeId: "a1" }, empty)).toBe(false);
    // The prompt clause (spec 2026-09-28): an opened section, or a block
    // already stacked, is an edit the prior-launch tier must not override.
    expect(isUntouchedForm({ ...empty, promptEnabled: true }, empty)).toBe(false);
    expect(
      isUntouchedForm(
        { ...empty, promptBlocks: [{ localId: "x", kind: "custom", description: "d", body: "b" }] },
        empty,
      ),
    ).toBe(false);
  });
});

describe("copySettingsOptions", () => {
  const nodes = [node({ id: "a1", name: "mac mini" }), node({ id: "local", name: "Server", kind: "local" })];
  const plugins = [PLUGIN("pi", "Pi")];

  it("lists newest-first with the agent · node · dir detail line", () => {
    const opts = copySettingsOptions(
      [
        row({ id: "old", createdAt: "2026-09-01T00:00:00.000Z", name: "Sep one" }),
        row({ id: "new", createdAt: "2026-09-12T00:00:00.000Z", name: "Sep twelve", harnessId: "pi", nodeId: "a1" }),
      ],
      nodes,
      plugins,
    );
    expect(opts.map((o) => o.value)).toEqual(["new", "old"]);
    expect(opts[0].label).toBe("Sep twelve");
    expect(opts[0].reason).toBe("Pi · mac mini · /srv/app");
    // Non-terminated rows are the Active category (the combobox caps the view).
    expect(opts.every((o) => o.group === ACTIVE_GROUP)).toBe(true);
    // Never disabled: the form's arms degrade an unsafe copy, the row stays pickable.
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it("returns EVERY row so a search reaches the deep list (the cap is display-only)", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      row({ id: `s${i}`, status: "running", createdAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const opts = copySettingsOptions(many, nodes, plugins);
    // No slice here: 15 in, 15 out, newest-created first, all Active. The
    // combobox shows COPY_CATEGORY_PREVIEW of them until the user searches.
    expect(opts).toHaveLength(15);
    expect(opts.map((o) => o.value)).toEqual([
      "s14",
      "s13",
      "s12",
      "s11",
      "s10",
      "s9",
      "s8",
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
      "s2",
      "s1",
      "s0",
    ]);
    expect(opts.every((o) => o.group === ACTIVE_GROUP)).toBe(true);
  });

  it("falls back to the short node id and the raw agent slug when either is unresolved", () => {
    const opts = copySettingsOptions([row({ id: "r", nodeId: "gone-node", harnessId: "ghost-plugin" })], nodes, []);
    expect(opts[0].reason).toBe("ghost-plugin · gone-nod · /srv/app");
  });

  it("drops the directory segment instead of dangling its separator", () => {
    const opts = copySettingsOptions([row({ id: "r", workingDir: "", nodeId: "a1" })], nodes, plugins);
    expect(opts[0].reason).toBe("claude-code · mac mini");
  });

  it("labels a nameless older-payload row by its id and survives an unanswered list", () => {
    const opts = copySettingsOptions(
      [{ id: "r9", harnessId: "pi", createdAt: "2026-09-01T00:00:00.000Z" } as SubshellView],
      nodes,
      [],
    );
    expect(opts[0].label).toBe("r9");
    expect(copySettingsOptions(undefined, nodes, [])).toEqual([]);
  });

  // The two categories (operator rule 2026-09-29): Recently terminated leads,
  // newest-ended first (endedAt, not createdAt), over Active (newest created
  // first). Every row is returned; the "3 each" view is the combobox's cap.
  const ended = (id: string, createdAt: string, endedAt: string) =>
    row({ id, status: "terminated", createdAt, endedAt });

  it("leads with Recently terminated (by endedAt), then Active, over a younger running row", () => {
    const opts = copySettingsOptions(
      [
        ended("term-old", "2026-09-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z"),
        ended("term-new", "2026-09-02T00:00:00.000Z", "2026-09-20T00:00:00.000Z"),
        row({ id: "run", status: "running", createdAt: "2026-09-15T00:00:00.000Z" }),
      ],
      nodes,
      plugins,
    );
    // term-new is the OLDEST by creation yet leads the list: endedAt drives
    // its category, not createdAt; the running row lands in Active below.
    expect(opts.map((o) => [o.value, o.group])).toEqual([
      ["term-new", RECENTLY_TERMINATED_GROUP],
      ["term-old", RECENTLY_TERMINATED_GROUP],
      ["run", ACTIVE_GROUP],
    ]);
  });

  it("groups every row into one of the two, terminated ordered by endedAt, active by creation, no duplicates", () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) =>
        ended(
          `t${i}`,
          `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          `2026-09-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      row({ id: "run-a", status: "running", createdAt: "2026-09-01T00:00:00.000Z" }),
      row({ id: "run-b", status: "running", createdAt: "2026-09-25T00:00:00.000Z" }),
    ];
    const opts = copySettingsOptions(many, nodes, plugins);
    expect(opts.filter((o) => o.group === RECENTLY_TERMINATED_GROUP).map((o) => o.value)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    // Active follows, newest created first, and nothing is in both.
    expect(opts.filter((o) => o.group === ACTIVE_GROUP).map((o) => o.value)).toEqual(["run-b", "run-a"]);
    expect(new Set(opts.map((o) => o.value)).size).toBe(7);
  });

  it("lists one id once even when the payload carries it twice, first occurrence winning", () => {
    // The operator rule: never list a subshell twice. A mid-merge cache can
    // hold the same id as both running and terminated; the FIRST row in list
    // order decides the category, so the two spellings are asserted directly.
    const dup = [
      row({ id: "d", status: "running", createdAt: "2026-09-10T00:00:00.000Z" }),
      ended("d", "2026-09-10T00:00:00.000Z", "2026-09-28T00:00:00.000Z"),
    ];
    const opts = copySettingsOptions(dup, nodes, plugins);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ value: "d", group: ACTIVE_GROUP });
    // Reversed order: the terminated spelling wins instead.
    const flipped = copySettingsOptions([...dup].reverse(), nodes, plugins);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]).toMatchObject({ value: "d", group: RECENTLY_TERMINATED_GROUP });
  });
});
