import { expect, spyOn, test } from "bun:test";
import { REPORTED_PREVIEW_TTL_MS, REPORTED_PREVIEWS_MAX, ReportedPreviews } from "../reported-previews.js";

test("merges successive reports and sorts by port", () => {
  const registry = new ReportedPreviews();
  registry.report("pane", "run-1", [{ port: 5173, title: "Vite" }]);
  registry.report("pane", "run-1", [{ port: 3000 }]);
  expect(registry.read("pane", "run-1")).toEqual([
    { port: 3000, reportedAt: expect.any(Number) },
    { port: 5173, title: "Vite", reportedAt: expect.any(Number) },
  ]);
});

test("a new run replaces the previous harness's ports", () => {
  const registry = new ReportedPreviews();
  registry.report("pane", "run-1", [{ port: 5173 }]);
  expect(registry.read("pane", "run-1").map((row) => row.port)).toEqual([5173]);
  registry.report("pane", "run-2", [{ port: 8080 }]);
  expect(registry.read("pane", "run-2").map((row) => row.port)).toEqual([8080]);
  expect(registry.read("pane", "run-1")).toEqual([]);
});

test("a silent reporter's rows expire", () => {
  const now = spyOn(Date, "now").mockReturnValue(1_000);
  const registry = new ReportedPreviews();
  registry.report("pane", "run-1", [{ port: 5173 }]);
  now.mockReturnValue(1_000 + REPORTED_PREVIEW_TTL_MS + 1);
  expect(registry.read("pane", "run-1")).toEqual([]);
  now.mockRestore();
});

test("a report longer than the bound keeps the first ports", () => {
  const registry = new ReportedPreviews();
  const ports = Array.from({ length: REPORTED_PREVIEWS_MAX + 8 }, (_, index) => ({ port: 3000 + index }));
  registry.report("pane", "run-1", ports);
  expect(registry.read("pane", "run-1")).toHaveLength(REPORTED_PREVIEWS_MAX);
});

test("an empty title is not stored", () => {
  const registry = new ReportedPreviews();
  registry.report("pane", "run-1", [{ port: 5173, title: "" }]);
  expect(registry.read("pane", "run-1")).toEqual([{ port: 5173, reportedAt: expect.any(Number) }]);
});
