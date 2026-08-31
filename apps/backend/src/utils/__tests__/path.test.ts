import { describe, expect, test } from "bun:test";
import { expandTilde } from "@/utils/path.js";

const HOME = "/home/tester";

describe("expandTilde", () => {
  test("bare `~` expands to home", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
  });

  test("`~/...` expands under home", () => {
    expect(expandTilde("~/code/proj", HOME)).toBe("/home/tester/code/proj");
  });

  test("`~/` alone expands to home (with trailing slash)", () => {
    expect(expandTilde("~/", HOME)).toBe(HOME);
  });

  test("absolute + relative paths are left untouched", () => {
    expect(expandTilde("/etc", HOME)).toBe("/etc");
    expect(expandTilde("relative/dir", HOME)).toBe("relative/dir");
    expect(expandTilde("", HOME)).toBe("");
  });

  test("embedded tilde is not expanded", () => {
    expect(expandTilde("a/~/b", HOME)).toBe("a/~/b");
  });
});
