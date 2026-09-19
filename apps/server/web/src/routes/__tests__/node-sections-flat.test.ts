import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The node section pages are FLAT SIBLINGS of the Overview, not children of
 * it — and `routeTree.gen.ts` is the artifact that decides that, so that is
 * what this pins.
 *
 * The bug this guards: `nodes_.$id.config.tsx` (no escape on `$id`) wired
 * Service, Configuration and Logs as CHILD routes of `nodes_.$id`, whose
 * component renders no `<Outlet/>` — so the tabs changed the URL and the
 * highlight while the Overview content stayed on screen, and all three
 * sections did nothing. Every page-level test missed it because each mounts
 * one page's Route under its own minimal router, which reproduces whatever
 * wiring the test itself declares rather than reading the generated tree.
 *
 * The flat shape is also what each section file's `NodePageShell` mount
 * requires: a child would render a full second header, nav and back-link
 * inside the parent's page. If a future layout-route refactor DOES add an
 * Outlet to the Overview, this test is the one that must change — together
 * with dropping each section's own shell.
 */
const generatedTree = readFileSync(new URL("../../routeTree.gen.ts", import.meta.url), "utf8");

const SECTION_ROUTES = {
  config: "NodesIdConfigRoute",
  logs: "NodesIdLogsRoute",
  service: "NodesIdServiceRoute",
} as const;

describe("node section routes in the generated tree", () => {
  for (const [section, routeName] of Object.entries(SECTION_ROUTES)) {
    it(`wires /nodes/$id/${section} under the root, not under /nodes/$id`, () => {
      // The `as any)` terminator bounds the match to this route's own
      // `.update({...})` call rather than the next one's.
      const block = generatedTree.match(new RegExp(`const ${routeName} = [\\s\\S]*?\\} as any\\)`));
      if (!block) throw new Error(`${routeName} is not wired in the generated tree at all`);
      expect(block[0]).toContain("getParentRoute: () => rootRouteImport");
    });
  }

  it("keeps the section URLs unchanged", () => {
    for (const section of Object.keys(SECTION_ROUTES)) {
      expect(generatedTree).toContain(`path: '/nodes/$id/${section}'`);
    }
  });
});
