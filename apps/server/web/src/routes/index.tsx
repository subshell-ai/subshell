import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceLanding } from "@/components/workspace-landing";

export const Route = createFileRoute("/")({ component: WorkspaceLanding });
