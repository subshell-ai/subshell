import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  canSubmit,
  emptyNewSessionForm,
  NewSessionForm,
  type NewSessionFormValue,
} from "@/components/session-picker/new-session-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCreateSession } from "@/hooks/use-create-session";
import { errMessage } from "@/lib/api";

export const Route = createFileRoute("/new")({
  component: NewSessionPage,
});

/**
 * Launch a session straight from a page (the other path is the workspace
 * dialog). The fields are the dialog's `NewSessionForm` — this page owns the
 * state, the gating and what a create means here (navigate to the session),
 * while the POST itself lives once in `useCreateSession`.
 */
function NewSessionPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<NewSessionFormValue>(emptyNewSessionForm);
  const create = useCreateSession();

  async function submit() {
    try {
      const created = await create.mutateAsync(form);
      void navigate({ to: "/sessions/$id", params: { id: created.id } });
    } catch {
      // The mutation keeps the error; it renders below the form.
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>New session</CardTitle>
          <CardDescription>Launch an agent harness in a working directory.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The page's own field ids, not the dialog's picker-* ones:
              e2e/tests/06 fills `#working-dir`/`#name` on this page. */}
          <NewSessionForm
            value={form}
            onChange={setForm}
            ids={{ profile: "profile", workingDir: "working-dir", name: "name", node: "node" }}
          />

          {create.error && (
            <p className="text-destructive text-sm">{errMessage(create.error, "Failed to create session")}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={create.isPending} onClick={() => void navigate({ to: "/" })}>
              Cancel
            </Button>
            <Button disabled={create.isPending || !canSubmit(form)} onClick={() => void submit()}>
              {create.isPending ? "Starting…" : "Start session"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
