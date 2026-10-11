import { expect, test } from "bun:test";
import type { Node } from "@internal/node-admin";
import { render, screen } from "@testing-library/react";
import { NodeStatusDot } from "../node-status-dot";

const base = { name: "n", hostname: "h", access: "owner" } as Node;

test("online: green, announced 'online'", () => {
  render(<NodeStatusDot node={{ ...base, status: "online", lastSeenAt: "2026-10-10T00:00:00Z" }} />);
  const dot = screen.getByRole("img", { name: "online" });
  expect(dot.className).toContain("bg-success");
  expect(dot.className).not.toContain("bg-destructive");
});
test("offline with a last-seen: red, label carries the seen time", () => {
  render(
    <NodeStatusDot
      node={{ ...base, status: "offline", lastSeenAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }}
    />,
  );
  const dot = screen.getByRole("img", { name: /^offline · seen / });
  expect(dot.className).toContain("bg-destructive");
});
test("never-seen offline announces 'offline · never seen'", () => {
  render(<NodeStatusDot node={{ ...base, status: "offline", lastSeenAt: null }} />);
  screen.getByRole("img", { name: "offline · never seen" });
});
