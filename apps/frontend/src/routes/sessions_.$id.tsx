import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy deep link (spec 2026-09-02 rename): the UUID survived the rename
 * unchanged, so the same id resolves to the same subshell under its new
 * route. A gone id lands on that route's not-found card — no loop.
 */
export const Route = createFileRoute("/sessions_/$id")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/subshells/$id", params: { id: params.id } });
  },
});
