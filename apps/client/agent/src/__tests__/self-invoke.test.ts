import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { selfInvocation } from "../self-invoke.js";

/**
 * Two callers re-enter this agent — the service unit's `ExecStart` (`run`) and
 * every pane's MCP registration (`mcp`) — and they used to decide separately
 * how to name it. `execLine` branched correctly; `commands/launch.ts` passed
 * `process.execPath` bare, so a source-run agent registered `bun mcp`, which
 * is not a command. These cases pin the shared decision.
 */
describe("selfInvocation", () => {
  test("a compiled agent runs itself, ignoring argv1 even when it looks like a script", () => {
    expect(selfInvocation("run", { execPath: "/opt/bin/subshell", argv1: "/ignored/main.ts" })).toEqual({
      command: "/opt/bin/subshell",
      args: ["run"],
    });
  });

  test("an interpreter launch carries the entry script, resolved absolute", () => {
    // Absolute because a pane config spawns in the SUBSHELL's cwd, where a
    // relative argv[1] does not exist.
    expect(selfInvocation("mcp", { execPath: "/usr/local/bin/bun", argv1: "src/main.ts" })).toEqual({
      command: "/usr/local/bin/bun",
      args: [resolve("src/main.ts"), "mcp"],
    });
  });

  // The bug this module exists for: `bun mcp` is not a command, so a pane
  // launched by a source-run agent got an MCP entry that could never start.
  test("a source run never yields a bare `bun <subcommand>`", () => {
    const { command, args } = selfInvocation("mcp", { execPath: "/usr/local/bin/bun", argv1: "src/main.ts" });
    expect(command.endsWith("bun")).toBe(true);
    expect(args).not.toEqual(["mcp"]);
    expect(args[0]).toMatch(/main\.ts$/);
  });

  // The published artifact is `subshell-cli-<triple>` and nothing stops a user
  // renaming it. Its argv[1] is the virtual bunfs path, which is NOT an entry
  // script — treating it as one would bake an unspawnable command.
  test("a renamed compiled binary is still compiled, not an interpreter launch", () => {
    expect(selfInvocation("run", { execPath: "/opt/bin/agent", argv1: "/$bunfs/root/main" })).toEqual({
      command: "/opt/bin/agent",
      args: ["run"],
    });
  });

  test("an absent argv1 falls back to compiled rather than resolving cwd", () => {
    expect(selfInvocation("mcp", { execPath: "/opt/bin/agent", argv1: "" })).toEqual({
      command: "/opt/bin/agent",
      args: ["mcp"],
    });
  });

  test("the subcommand is always last", () => {
    for (const deps of [
      { execPath: "/opt/bin/subshell", argv1: "/$bunfs/root/main" },
      { execPath: "/usr/local/bin/bun", argv1: "src/main.ts" },
      { execPath: "/opt/bin/agent", argv1: "" },
    ]) {
      for (const sub of ["run", "mcp"]) {
        expect(selfInvocation(sub, deps).args.at(-1)).toBe(sub);
      }
    }
  });
});
