import { expect, test } from "bun:test";
import type { Node } from "@internal/node-admin";
import { filterNodes, NODE_FILTERS_OFF, type NodeFilters } from "../node-filter";

function node(over: Partial<Node>): Node {
  return { name: "box", hostname: "box.local", status: "online", access: "owner", ...over } as Node;
}
const NODES: Node[] = [
  node({ name: "AI PC", hostname: "theo-linux-ai", status: "offline" }),
  node({ name: "Server", hostname: "mac-builder", access: "edit" }),
  node({ name: "Laptop", hostname: null, id: "deadbeef-1", status: "offline", access: "view" }),
];
const AT: Partial<NodeFilters> = {}; // spread-merge over the OFF baseline

test("no filters is the identity", () => {
  expect(filterNodes(NODES, NODE_FILTERS_OFF)).toEqual(NODES);
});
test("query matches name case-insensitively", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, ...AT, query: "ai p" }).map((n) => n.name)).toEqual(["AI PC"]);
});
test("query matches hostname, and falls back to id when hostname is null", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, query: "MAC-BUILDER" }).map((n) => n.name)).toEqual(["Server"]);
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, query: "deadbeef" }).map((n) => n.name)).toEqual(["Laptop"]);
});
test("status filter", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, status: "offline" }).map((n) => n.name)).toEqual([
    "AI PC",
    "Laptop",
  ]);
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, status: "online" }).map((n) => n.name)).toEqual(["Server"]);
});
test("access filter: yours is owner-only, shared is everything else", () => {
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, access: "yours" }).map((n) => n.name)).toEqual(["AI PC"]);
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, access: "shared" }).map((n) => n.name)).toEqual([
    "Server",
    "Laptop",
  ]);
});
test("axes AND-combine", () => {
  expect(filterNodes(NODES, { status: "offline", access: "shared", query: "" }).map((n) => n.name)).toEqual(["Laptop"]);
});
test("whitespace-only query is no query; input array is not mutated", () => {
  const snapshot = [...NODES];
  expect(filterNodes(NODES, { ...NODE_FILTERS_OFF, query: "   " })).toEqual(NODES);
  filterNodes(NODES, { ...NODE_FILTERS_OFF, status: "online" });
  expect(NODES).toEqual(snapshot);
});
