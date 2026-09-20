import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** The shared frame for both not-found states: the same centered card the
 * workspace/preset detail routes use (routes/workspaces_.$id.tsx). */
function NotFoundCard({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        <CardContent>{action}</CardContent>
      </Card>
    </main>
  );
}

/**
 * The router's `defaultNotFoundComponent` (wired in main.tsx): any unmatched
 * URL renders this inside the app shell — sidebar and banners intact, one
 * obvious way back. TanStack passes `{ error, router }` props; neither is
 * useful to the user, so both are ignored.
 */
export function NotFoundPage() {
  return (
    <NotFoundCard
      title="Page not found"
      body="This page doesn't exist. The link may be old or mistyped."
      action={<Button render={<Link to="/">Go to subshells</Link>} />}
    />
  );
}

/**
 * The `/subshells/$id` card for a record the server will never return: the
 * backend answers 404 (never 403) for deleted AND not-shared-with-me (spec
 * 2026-08-31 sharing), so the copy covers both without leaking which one.
 */
export function SubshellNotFoundCard() {
  return (
    <NotFoundCard
      title="Subshell not found"
      body="It may have been deleted, or its owner hasn't shared it with you."
      action={<Button variant="outline" render={<Link to="/">Back to subshells</Link>} />}
    />
  );
}
