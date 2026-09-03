import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy URL (spec 2026-09-02 rename): the subshell list has always lived at
 * "/", so an old bookmark of the old collection path just goes home.
 */
export const Route = createFileRoute("/sessions")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
