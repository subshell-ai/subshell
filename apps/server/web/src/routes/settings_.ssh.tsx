import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old bookmarks lead to the SSH preset library. */
export const Route = createFileRoute("/settings_/ssh")({
  beforeLoad: () => {
    throw redirect({ to: "/presets", search: { type: "ssh" }, replace: true });
  },
});
