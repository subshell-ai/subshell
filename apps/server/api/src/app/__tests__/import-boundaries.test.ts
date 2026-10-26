import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("capabilities and shared primitives do not depend on transport adapters", () => {
  const violations: string[] = [];
  for (const owner of ["modules", "shared"]) {
    for (const path of sourceFiles(resolve(sourceRoot, owner))) {
      const source = readFileSync(path, "utf8");
      // Include type-only imports and re-exports: API schemas must not define a workflow's input type.
      const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g);
      for (const [, specifier] of imports) {
        if (!specifier?.startsWith("@/") && !specifier?.startsWith(".")) continue;
        const target = specifier.startsWith("@/")
          ? resolve(sourceRoot, specifier.slice(2))
          : resolve(dirname(path), specifier);
        const group = relative(sourceRoot, target).split("/")[0];
        const forbidden = owner === "shared" ? ["api", "cli", "modules", "app", "db"] : ["api", "cli"];
        if (group && forbidden.includes(group)) violations.push(`${relative(sourceRoot, path)} -> ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
