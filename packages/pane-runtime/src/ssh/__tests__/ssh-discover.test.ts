import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSshConfigPath, discoverSshAliases, walkSshConfig } from "../ssh-discover.js";
import { cleanup, tempRoot } from "./helpers.js";

/**
 * Discovery is a NAME-HUNT with budgets (ssh-discover.ts module doc): what it
 * must get right is which names appear, which are excluded, and what the
 * two "the list may be incomplete" facts report. Config CONTENT never
 * escapes the walk — the answers carry no directive values at all.
 */

let root: string;

beforeAll(() => {
  root = tempRoot("subshell-ssh-discover-");
});

afterAll(() => {
  cleanup(root);
});

function fixtureConfig(tag: string, body: string): string {
  const dir = join(root, tag);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config");
  writeFileSync(path, body);
  return path;
}

describe("discoverSshAliases", () => {
  it("reports plain Host names, sorted and deduplicated", () => {
    const config = fixtureConfig(
      "plain",
      [
        "# a comment",
        "Host beta",
        "  HostName beta.example.com",
        "Host alpha gamma",
        "  User deploy",
        "Host beta", // duplicate name across blocks
        "",
      ].join("\n"),
    );
    const found = discoverSshAliases({ homeDir: root, configPath: config });
    expect(found.aliases).toEqual(["alpha", "beta", "gamma"]);
    expect(found.includeCycle).toBe(false);
    expect(found.truncated).toBe(false);
  });

  it("omits wildcard-only patterns and negations, keeps plain siblings", () => {
    const config = fixtureConfig(
      "wildcards",
      [
        "Host *.example.com !secret.example.com", // nothing plain on this line
        "  User x",
        "Host prod-*", // pattern prefix, not an alias
        "Host qa-server",
        "  User y",
        "Host q?", // single-char pattern
      ].join("\n"),
    );
    const found = discoverSshAliases({ homeDir: root, configPath: config });
    expect(found.aliases).toEqual(["qa-server"]);
  });

  it("follows includes and detects an include cycle", () => {
    const dir = join(root, "cycle");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.conf"), ["Include b.conf", "Host alias-a", "  User x"].join("\n"));
    writeFileSync(
      join(dir, "b.conf"),
      ["Include a.conf", "Host alias-b"].join("\n"), // back into a's ancestry
    );
    const walk = walkSshConfig(join(dir, "a.conf"), root);
    expect(walk.includeCycle).toBe(true);
    expect(walk.files.length).toBe(2); // a then b; the re-include stopped at the cycle, did not spin
  });

  it("dedupes a diamond include WITHOUT reporting a cycle", () => {
    const dir = join(root, "diamond");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "common.conf"), "Host shared");
    writeFileSync(join(dir, "top.conf"), ["Include common.conf", "Include common.conf", "Host other"].join("\n"));
    const found = discoverSshAliases({ homeDir: root, configPath: join(dir, "top.conf") });
    expect(found.aliases).toEqual(["other", "shared"]);
    expect(found.includeCycle).toBe(false);
  });

  it("expands glob includes with ~", () => {
    const dir = join(root, "glob");
    const inc = join(dir, "conf.d");
    mkdirSync(inc, { recursive: true });
    writeFileSync(join(inc, "one.conf"), "Host g-one");
    writeFileSync(join(inc, "two.conf"), "Host g-two");
    writeFileSync(join(inc, "skip.txt"), "Host g-not-included");
    // ~ expansion: homeDir is the fixture root.
    const found = discoverSshAliases({
      homeDir: root,
      configPath: fixtureConfig("glob-root", "Include ~/glob/conf.d/*.conf"),
    });
    expect(found.aliases).toEqual(["g-one", "g-two"]);
  });

  it("flags truncated when the file budget is exhausted", () => {
    const dir = join(root, "budget");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.conf"), "Host from-b");
    writeFileSync(join(dir, "c.conf"), "Host from-c");
    const configPath = join(dir, "config");
    writeFileSync(configPath, ["Include b.conf", "Include c.conf", "Host from-root"].join("\n"));
    const found = discoverSshAliases({ homeDir: dir, configPath, budget: { maxFiles: 2 } }); // root + b; c is never read
    expect(found.truncated).toBe(true);
    expect(found.aliases).toContain("from-b");
    expect(found.aliases).not.toContain("from-c");
  });

  it("flags truncated when the alias cap is reached", () => {
    const lines: string[] = [];
    for (let i = 0; i < 501; i++) lines.push(`Host alias-${String(i).padStart(4, "0")}`);
    const config = fixtureConfig("cap", lines.join("\n"));
    const found = discoverSshAliases({ homeDir: root, configPath: config });
    expect(found.aliases.length).toBe(500);
    expect(found.truncated).toBe(true);
  });

  it("sees Match exec in the walk (the local-execution signal §2 refuses on)", () => {
    const config = fixtureConfig("matchexec", ["Match exec echo hi", "  User x", "Host m-alias"].join("\n"));
    const walk = walkSshConfig(config, root);
    expect(walk.matchExecSeen).toBe(true);
    const found = discoverSshAliases({ homeDir: root, configPath: config });
    expect(found.aliases).toEqual(["m-alias"]); // Match blocks carry no names
  });

  it("missing config file yields an empty honest list, never a throw", () => {
    const found = discoverSshAliases({ homeDir: root, configPath: join(root, "nope", "config") });
    expect(found).toEqual({ aliases: [], includeCycle: false, truncated: false });
  });

  it("the default path is the home config", () => {
    expect(defaultSshConfigPath("/home/zed")).toBe("/home/zed/.ssh/config");
  });

  it("answers names only: no directive value text appears anywhere in the result", () => {
    const config = fixtureConfig(
      "namesonly",
      ["Host top-secret-host", "  IdentityFile /home/deploy/.ssh/private_key_material", "  User supersecret"].join(
        "\n",
      ),
    );
    const found = discoverSshAliases({ homeDir: root, configPath: config });
    const blob = JSON.stringify(found);
    expect(blob).toContain("top-secret-host"); // the NAME is the answer
    expect(blob).not.toContain("private_key_material");
    expect(blob).not.toContain("supersecret");
  });
});
