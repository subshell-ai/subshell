import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { NodeDetail } from "@internal/node-admin";
import { managesNodeSections } from "@/components/nodes/node-section-nav";

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
      // Pinned PER BLOCK: a whole-file `toContain(path)` would still pass if
      // two sections swapped paths or one lost the prefix, because the other
      // occurrence would satisfy the scan. Each route's OWN object must name
      // each of its three own facts — id (what createFileRoute looks the
      // route up by), path (the URL), parent (the flat wiring).
      expect(block[0]).toContain(`id: '/nodes_/$id_/${section}'`);
      expect(block[0]).toContain(`path: '/nodes/$id/${section}'`);
      // And exactly one ROUTE CLAIMS that URL — over creation objects, not
      // raw strings: the generated file also states every path twice in
      // type-declaration blocks (and again as `fullPath:`), which a
      // substring count would misread as a rival claimant. A swapped or
      // duplicated wiring shows up here as the wrong name or a second hit.
      const claims = [...generatedTree.matchAll(/const (\w+Route) = \w+\.update\(\{[\s\S]*?\} as any\)/g)]
        .filter((m) => (m[0] ?? "").includes(`path: '/nodes/$id/${section}'`))
        .map((m) => m[1]);
      expect(claims).toEqual([routeName]);
    });
  }
});

/**
 * The shared visibility rule behind both halves of the fix: the nav hides
 * the three section tabs by it, and the section routes redirect by it (a
 * hidden tab is not a gated URL — before 2026-09-20 a deep link to
 * `/nodes/local/service` rendered a card claiming the LIVE control plane
 * was "offline, nothing to report"). This is the whole rule table:
 * management of the sections needs an AGENT machine AND a configuring
 * viewer — `local` is never managed here (its half is Server Settings),
 * and `view` never is (the routes 403 it).
 */
describe("managesNodeSections", () => {
  const base = { kind: "agent", access: "owner" } as NodeDetail;
  const cases: [string, NodeDetail, boolean][] = [
    ["agent + owner", base, true],
    ["agent + edit", { ...base, access: "edit" }, true],
    ["agent + view", { ...base, access: "view" }, false],
    ["local + owner (admins included)", { ...base, kind: "local" }, false],
    ["local + admin-ish edit", { ...base, kind: "local", access: "edit" }, false],
  ];
  for (const [name, node, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(managesNodeSections(node)).toBe(expected);
    });
  }
});
