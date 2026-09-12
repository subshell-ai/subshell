import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuickAdd } from "@/components/quick-add";

export const Route = createFileRoute("/new")({
  component: NewSubshellRoute,
});

/**
 * `/new` opens the launch DIALOG over the subshells list, rather than being a
 * page of its own.
 *
 * It used to render a second copy of the same form as a full-page card: same
 * title, same description, same two buttons, mounted from
 * `NewSubshellForm` exactly as the dialog does. Two implementations of one
 * decision is one too many — and a whole page for "pick three things and
 * press Start" reads heavier than the act is (user report 2026-09-11).
 *
 * The URL survives because it is a real entry point: the empty state links
 * here, and every end-to-end spec that launches a subshell navigates here
 * first. What it does now is raise the dialog the rail already owns
 * (`QuickAddProvider` mounts it above the routes, so it outlives this
 * navigation) and hand the page under it to the list.
 */
function NewSubshellRoute() {
  const { openLaunch } = useQuickAdd();
  const navigate = useNavigate();
  useEffect(() => {
    openLaunch();
    // `replace`, so Back from the list does not bounce through here and
    // re-open the dialog the person just dismissed.
    void navigate({ to: "/", replace: true });
  }, [openLaunch, navigate]);
  return null;
}
