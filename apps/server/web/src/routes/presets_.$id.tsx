import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { PresetFields } from "@/components/presets/preset-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useInvalidatePresets, usePresets } from "@/hooks/use-presets";
import { apiFetch, errMessage } from "@/lib/api";
import { type PresetFormValue, presetFormFromRow, toPresetUpdatePayload } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

export const Route = createFileRoute("/presets_/$id")({
  component: EditPresetPage,
});

function EditPresetPage() {
  const { id } = useParams({ from: "/presets_/$id" });
  const { data: presets, isLoading, isError, refetch } = usePresets();

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }

  // The list rides in from a shared query, so "no row for this id" is only
  // evidence of deletion once the query actually succeeded. A failed fetch
  // says so instead of accusing the row of being gone.
  if (isError) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Couldn't load this preset</CardTitle>
            <CardDescription>The request failed. Check your connection, then try again.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => void refetch()}>Retry</Button>
            <Button variant="outline" render={<Link to="/presets">Back to presets</Link>} />
          </CardContent>
        </Card>
      </main>
    );
  }

  const preset = presets?.find((p) => p.id === id);

  if (!preset) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Preset not found</CardTitle>
            <CardDescription>The preset may have been deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" render={<Link to="/presets">Back to presets</Link>} />
          </CardContent>
        </Card>
      </main>
    );
  }

  // Keyed by id so each preset gets a fresh form instance: navigating from
  // /presets/:a to /presets/:b remounts this form (TanStack reuses the route
  // component across param changes, so without the key the old snapshot would
  // shadow the new preset on the first render).
  return <PresetEditor key={preset.id} preset={preset} />;
}

function PresetEditor({ preset }: { preset: PresetRow }) {
  const { id } = useParams({ from: "/presets_/$id" });
  const navigate = useNavigate();
  const invalidate = useInvalidatePresets();
  const [form, setForm] = useState<PresetFormValue>(() => presetFormFromRow(preset));
  const [error, setError] = useState<string | null>(null);
  // The header names the agent the way every other surface does — the
  // plugin's display name, falling back to the id when the catalog cannot.
  const { data: pluginData } = useInstancePlugins();
  const agentName = (pluginData?.plugins ?? []).find((p) => p.id === preset.harnessId)?.name ?? preset.harnessId;

  const mutation = useMutation({
    mutationFn: (v: PresetFormValue) =>
      apiFetch(`/api/presets/${id}`, { method: "PUT", body: JSON.stringify(toPresetUpdatePayload(v)) }),
    onSuccess: () => {
      void invalidate();
      navigate({ to: "/presets" });
    },
    onError: (err) => setError(errMessage(err, "Failed to save")),
  });

  function save() {
    setError(null);
    mutation.mutate(form);
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit preset</CardTitle>
          <CardDescription>
            Update {preset.name} for {agentName}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PresetFields value={form} onChange={setForm} lockedHarness={preset.harnessId} />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => navigate({ to: "/presets" })} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button onClick={() => save()} disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
