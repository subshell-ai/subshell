import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";

export const Route = createFileRoute("/new")({
  component: NewSubshellPage,
});

/**
 * Launch a subshell straight from a page (the other path is the workspace
 * dialog). The fields are the dialog's `NewSubshellForm` — this page owns the
 * state, the gating and what a create means here (navigate to the subshell),
 * while the POST itself lives once in `useCreateSubshell`.
 */
function NewSubshellPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const create = useCreateSubshell();

  async function submit() {
    try {
      const created = await create.mutateAsync(form);
      void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch {
      // The mutation keeps the error; it renders below the form.
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>New subshell</CardTitle>
          <CardDescription>Launch an agent harness in a working directory.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The page's own field ids, not the dialog's picker-* ones:
              e2e/tests/06 fills `#working-dir`/`#name` on this page. */}
          <NewSubshellForm
            value={form}
            onChange={setForm}
            ids={{ profile: "profile", workingDir: "working-dir", name: "name", node: "node" }}
          />

          {/* Node-aware copy: a remote pick that raced the picker answers 409
              NODE_OFFLINE and gets the actionable line (lib/create-subshell-error). */}
          {create.error && (
            <p className="text-destructive text-sm">
              {createSubshellErrorMessage(create.error, "Failed to create subshell")}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={create.isPending} onClick={() => void navigate({ to: "/" })}>
              Cancel
            </Button>
            <Button disabled={create.isPending || !canSubmit(form)} onClick={() => void submit()}>
              {create.isPending ? "Starting…" : "Start subshell"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
