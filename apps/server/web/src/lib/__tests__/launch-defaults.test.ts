import { describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { emptyNewSubshellForm } from "@/components/subshell-picker/new-subshell-form";
import {
  COPY_SETTINGS_LIMIT,
  copySettingsOptions,
  isUntouchedForm,
  launchTemplateFromList,
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
    // Never disabled: the form's arms degrade an unsafe copy, the row stays pickable.
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it("caps at the limit", () => {
    const many = Array.from({ length: COPY_SETTINGS_LIMIT + 5 }, (_, i) =>
      row({ id: `s${i}`, createdAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    expect(copySettingsOptions(many, nodes, plugins)).toHaveLength(COPY_SETTINGS_LIMIT);
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
});
