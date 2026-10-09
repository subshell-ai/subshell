import { createFileRoute, redirect } from "@tanstack/react-router";
import { sshConnectSearch } from "@/lib/ssh-connect-search";

/** Compatibility for saved links; SSH opens through the shared subshell launcher. */
export const Route = createFileRoute("/connect")({
  validateSearch: sshConnectSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/new", search: { ...search, kind: "ssh" }, replace: true });
  },
});
