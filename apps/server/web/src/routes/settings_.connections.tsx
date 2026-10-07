import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "./connect";

/** Personal connections: cookie ownership is enforced by every SSH endpoint. */
export const Route = createFileRoute("/settings_/connections")({ component: ConnectionsPage });
