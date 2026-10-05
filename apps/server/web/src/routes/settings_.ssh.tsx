import { createFileRoute } from "@tanstack/react-router";
import { SshConnectionsPage } from "@/components/ssh/ssh-connections-page";

/**
 * The SSH connections settings page (SSH-SUPPORT.md §3, workstream F). The
 * route is a bare registration: the page component owns the reads, the cards,
 * and the editor, per the thin-route rule.
 *
 * The data is caller-scoped on the SERVER (`GET /api/ssh/connections`
 * answers the owner's rows), so the page needs no admin gate of its own; the
 * rail entry currently lives in the admin-gated Server Settings group, which
 * the task-F report notes as the one placement tension.
 */
export const Route = createFileRoute("/settings_/ssh")({ component: SshConnectionsPage });
