import { describe, expect, it } from "bun:test";
import {
  dirAllowed,
  dirNavigable,
  MAX_ALLOWED_DIRS,
  normalizeAllowedDir,
  normalizeAllowedDirs,
} from "../dir-allowlist.js";

describe("normalizeAllowedDir", () => {
  it("accepts an absolute path and strips the trailing slash", () => {
    expect(normalizeAllowedDir("/home/theo/projects")).toBe("/home/theo/projects");
    expect(normalizeAllowedDir("/home/theo/projects/")).toBe("/home/theo/projects");
    expect(normalizeAllowedDir("  /home/theo/projects  ")).toBe("/home/theo/projects");
  });

  it("collapses duplicate separators", () => {
    expect(normalizeAllowedDir("/home//theo///projects")).toBe("/home/theo/projects");
  });

  it("keeps the root as a single slash rather than the empty string", () => {
    expect(normalizeAllowedDir("/")).toBe("/");
    expect(normalizeAllowedDir("//")).toBe("/");
  });

  it("refuses a relative path — an allowlist entry has no cwd to resolve against", () => {
    expect(normalizeAllowedDir("projects")).toBeNull();
    expect(normalizeAllowedDir("./projects")).toBeNull();
    expect(normalizeAllowedDir("~/projects")).toBeNull();
  });

  it("refuses `..` outright rather than collapsing it", () => {
    // Collapsing is symlink-blind: `/root/link/../evil` collapses to
    // `/root/evil` (inside) while the kernel opens `/outside/evil`. The node's
    // fs-aware check is the authority, but a rule that LOOKS like it confines
    // and does not must never be storable in the first place.
    expect(normalizeAllowedDir("/home/../etc")).toBeNull();
    expect(normalizeAllowedDir("/home/theo/..")).toBeNull();
    expect(normalizeAllowedDir("../etc")).toBeNull();
  });

  it("refuses empty and whitespace-only input", () => {
    expect(normalizeAllowedDir("")).toBeNull();
    expect(normalizeAllowedDir("   ")).toBeNull();
  });

  it("keeps a literal dot segment out, but allows dotfiles as names", () => {
    expect(normalizeAllowedDir("/home/theo/./projects")).toBeNull();
    expect(normalizeAllowedDir("/home/theo/.config")).toBe("/home/theo/.config");
  });
});

describe("normalizeAllowedDirs", () => {
  it("drops invalid entries rather than failing the whole set", () => {
    expect(normalizeAllowedDirs(["/a", "relative", "/b/"])).toEqual(["/a", "/b"]);
  });

  it("dedupes", () => {
    expect(normalizeAllowedDirs(["/a", "/a/", "/a"])).toEqual(["/a"]);
  });

  it("drops entries already covered by a broader entry", () => {
    // Keeping both would be harmless but dishonest: the UI would show a rule
    // that constrains nothing.
    expect(normalizeAllowedDirs(["/home/theo", "/home/theo/projects"])).toEqual(["/home/theo"]);
    expect(normalizeAllowedDirs(["/home/theo/projects", "/home/theo"])).toEqual(["/home/theo"]);
  });

  it("keeps siblings and near-miss prefixes", () => {
    // `/home/theo2` is NOT under `/home/theo` — a plain string prefix test
    // would wrongly swallow it.
    expect(normalizeAllowedDirs(["/home/theo", "/home/theo2"])).toEqual(["/home/theo", "/home/theo2"]);
  });

  it("collapses everything under an explicit root entry", () => {
    expect(normalizeAllowedDirs(["/", "/home/theo", "/var"])).toEqual(["/"]);
  });

  it("sorts for a stable wire payload and stable UI order", () => {
    expect(normalizeAllowedDirs(["/var", "/home", "/etc"])).toEqual(["/etc", "/home", "/var"]);
  });

  it("caps the set", () => {
    const many = Array.from({ length: MAX_ALLOWED_DIRS + 20 }, (_, i) => `/d${String(i).padStart(3, "0")}`);
    expect(normalizeAllowedDirs(many)).toHaveLength(MAX_ALLOWED_DIRS);
  });
});

describe("dirAllowed", () => {
  it("treats an empty root set as unrestricted", () => {
    // The backwards-compatible default: every node starts with no rules and
    // behaves exactly as it did before the feature existed.
    expect(dirAllowed("/anywhere/at/all", [])).toBe(true);
  });

  it("allows a root itself and anything beneath it", () => {
    const roots = ["/home/theo/projects"];
    expect(dirAllowed("/home/theo/projects", roots)).toBe(true);
    expect(dirAllowed("/home/theo/projects/subshell", roots)).toBe(true);
    expect(dirAllowed("/home/theo/projects/a/b/c", roots)).toBe(true);
  });

  it("refuses a sibling whose name merely shares the prefix", () => {
    expect(dirAllowed("/home/theo/projects-old", ["/home/theo/projects"])).toBe(false);
    expect(dirAllowed("/home/theodore", ["/home/theo"])).toBe(false);
  });

  it("refuses an ancestor of a root", () => {
    expect(dirAllowed("/home/theo", ["/home/theo/projects"])).toBe(false);
  });

  it("matches any one of several roots", () => {
    const roots = ["/home/theo/projects", "/srv/work"];
    expect(dirAllowed("/srv/work/x", roots)).toBe(true);
    expect(dirAllowed("/srv/other", roots)).toBe(false);
  });

  it("refuses a candidate carrying `..`, never collapsing it first", () => {
    expect(dirAllowed("/home/theo/projects/../../../etc", ["/home/theo/projects"])).toBe(false);
  });

  it("refuses a relative candidate", () => {
    expect(dirAllowed("projects", ["/home/theo/projects"])).toBe(false);
  });

  it("normalizes a trailing slash on the candidate", () => {
    expect(dirAllowed("/home/theo/projects/", ["/home/theo/projects"])).toBe(true);
  });

  it("lets a root entry of `/` allow everything absolute", () => {
    expect(dirAllowed("/etc", ["/"])).toBe(true);
    expect(dirAllowed("/", ["/"])).toBe(true);
  });
});

describe("dirNavigable", () => {
  it("is unrestricted with no roots", () => {
    expect(dirNavigable("/anywhere", [])).toBe(true);
  });

  it("keeps ANCESTORS of a root visible — the stepping stones to it", () => {
    // The bug this exists for: filtering a picker by `dirAllowed` alone hides
    // /home when the rule is /home/theo/projects, leaving an empty panel with
    // no way down to the one directory that IS permitted.
    const roots = ["/home/theo/projects"];
    expect(dirNavigable("/", roots)).toBe(true);
    expect(dirNavigable("/home", roots)).toBe(true);
    expect(dirNavigable("/home/theo", roots)).toBe(true);
  });

  it("keeps the root and its descendants visible", () => {
    const roots = ["/home/theo/projects"];
    expect(dirNavigable("/home/theo/projects", roots)).toBe(true);
    expect(dirNavigable("/home/theo/projects/deep/er", roots)).toBe(true);
  });

  it("hides siblings and unrelated trees", () => {
    const roots = ["/home/theo/projects"];
    expect(dirNavigable("/home/theo/secrets", roots)).toBe(false);
    expect(dirNavigable("/etc", roots)).toBe(false);
    // The prefix near-miss, in the ancestor direction too.
    expect(dirNavigable("/home/theodore", roots)).toBe(false);
  });

  it("is not fooled by a trailing slash or doubled separators on either side", () => {
    // Entries are normalized at rest, but a node supplies `entries[].path`
    // and this predicate must not depend on that being clean.
    expect(dirNavigable("/home/theo/", ["/home/theo/projects"])).toBe(true);
    expect(dirNavigable("/home//theo", ["/home/theo/projects"])).toBe(true);
    expect(dirNavigable("/home/theo", ["/home/theo/projects/"])).toBe(true);
  });

  it("refuses a candidate carrying `..`, like every other check here", () => {
    expect(dirNavigable("/home/theo/../etc", ["/home/theo/projects"])).toBe(false);
  });

  it("is strictly wider than dirAllowed — navigation is not authorization", () => {
    const roots = ["/srv/work"];
    expect(dirNavigable("/srv", roots)).toBe(true);
    expect(dirAllowed("/srv", roots)).toBe(false);
  });
});
