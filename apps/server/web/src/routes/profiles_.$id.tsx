import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ProfileFields } from "@/components/profile-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useInvalidateProfiles, useProfiles } from "@/hooks/use-profiles";
import { apiFetch, errMessage } from "@/lib/api";
import { type ProfileFormValue, profileFormFromRow, toProfileUpdatePayload } from "@/lib/profile-form";
import type { ProfileRow } from "@/types/profile";

export const Route = createFileRoute("/profiles_/$id")({
  component: EditProfilePage,
});

function EditProfilePage() {
  const { id } = useParams({ from: "/profiles_/$id" });
  const { data: profiles, isLoading, isError, refetch } = useProfiles();

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
            <CardTitle>Couldn't load this profile</CardTitle>
            <CardDescription>The request failed. Check your connection, then try again.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => void refetch()}>Retry</Button>
            <Button variant="outline" render={<Link to="/profiles">Back to profiles</Link>} />
          </CardContent>
        </Card>
      </main>
    );
  }

  const profile = profiles?.find((p) => p.id === id);

  if (!profile) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile not found</CardTitle>
            <CardDescription>The profile may have been deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" render={<Link to="/profiles">Back to profiles</Link>} />
          </CardContent>
        </Card>
      </main>
    );
  }

  // Keyed by id so each profile gets a fresh form instance: navigating from
  // /profiles/:a to /profiles/:b remounts this form (TanStack reuses the route
  // component across param changes, so without the key the old snapshot would
  // shadow the new profile on the first render).
  return <ProfileEditor key={profile.id} profile={profile} />;
}

function ProfileEditor({ profile }: { profile: ProfileRow }) {
  const { id } = useParams({ from: "/profiles_/$id" });
  const navigate = useNavigate();
  const invalidate = useInvalidateProfiles();
  const [form, setForm] = useState<ProfileFormValue>(() => profileFormFromRow(profile));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (v: ProfileFormValue) =>
      apiFetch(`/api/profiles/${id}`, { method: "PUT", body: JSON.stringify(toProfileUpdatePayload(v)) }),
    onSuccess: () => {
      void invalidate();
      navigate({ to: "/profiles" });
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
          <CardTitle>Edit profile</CardTitle>
          <CardDescription>
            Update {profile.name} for the {profile.harnessId} harness.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProfileFields value={form} onChange={setForm} lockHarness />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => navigate({ to: "/profiles" })} disabled={mutation.isPending}>
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
