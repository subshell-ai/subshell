import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { ProfileFields } from "@/components/profile-fields";
import { ProfileListRow } from "@/components/profile-list-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHarnesses } from "@/hooks/use-harnesses";
import { useInvalidateProfiles, useProfiles } from "@/hooks/use-profiles";
import { apiFetch, errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import { emptyProfileForm, type ProfileFormValue, toProfilePayload } from "@/lib/profile-form";

export const Route = createFileRoute("/profiles")({
  component: ProfilesPage,
});

function ProfilesPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidateProfiles();
  const { data: profiles, isLoading, isError, refetch } = useProfiles();
  const { data: harnesses } = useHarnesses();

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<ProfileFormValue>(emptyProfileForm());
  // Two error slots, because they have two homes: a create failure belongs in
  // the dialog the person is still looking at, a delete failure belongs on the
  // page (with the dialog closed, the old single slot rendered a failed delete
  // nowhere at all).
  const [createError, setCreateError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createProfile() {
    setBusy(true);
    setCreateError(null);
    try {
      if (!form.harnessId) throw new Error("Choose a harness first");
      await apiFetch("/api/profiles", { method: "POST", body: JSON.stringify(toProfilePayload(form)) });
      setShowCreate(false);
      setForm(emptyProfileForm());
      await invalidate();
    } catch (err) {
      setCreateError(errMessage(err, "Failed"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile(id: string) {
    const ok = await confirmAction({
      title: "Delete this profile?",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      setListError(null);
      await apiFetch(`/api/profiles/${id}`, { method: "DELETE" });
      await invalidate();
    } catch (err) {
      setListError(errMessage(err, "Failed to delete profile"));
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Profiles"
        subtitle="Per-harness launch configurations"
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus /> New profile
          </Button>
        }
      />

      {listError && <p className="text-destructive text-sm">{listError}</p>}

      {/* A dialog rather than a card that pushes the list down the page
          (user report 2026-09-11): creating a profile is a decision with an
          end, and the list behind it is the thing being added to. Same shape
          as every other "new X" in the app — the launch dialog, the workspace
          dialog, Add a node. */}
      <Dialog
        open={showCreate}
        onOpenChange={(next) => {
          setShowCreate(next);
          if (!next) {
            setForm(emptyProfileForm());
            setCreateError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create profile</DialogTitle>
            <DialogDescription>A profile bundles env, flags and restart policy for one harness.</DialogDescription>
          </DialogHeader>
          <ProfileFields value={form} onChange={setForm} />
          {createError && <p className="text-destructive text-sm">{createError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createProfile()} disabled={busy || !form.harnessId}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}

      {/* A failed list load is not an empty account: say so, and offer the
          retry the old silent blank denied. (A create failure lines up inside
          the dialog and a delete failure above this banner — different
          failures, different homes.) */}
      {isError && (
        <ErrorBanner
          message="Couldn't load profiles."
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-inherit text-xs underline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          }
        />
      )}

      {!isLoading && !isError && profiles?.length === 0 && !showCreate && (
        <EmptyState
          icon={SlidersHorizontal}
          title="No profiles yet"
          description="A profile is a saved launch configuration (env vars, flags, whether subshells restart themselves) that every subshell starts from."
          actionLabel="Create your first profile"
          onAction={() => setShowCreate(true)}
        />
      )}

      {/* One row per profile: identity plus the launch command it contributes.
          The binary name comes from the harness registry (already fetched for
          the form); an unknown harness falls back to its id so the row still
          renders something honest. */}
      {(profiles?.length ?? 0) > 0 && (
        <div className="space-y-2">
          {profiles?.map((p) => (
            <ProfileListRow
              key={p.id}
              profile={p}
              binary={harnesses?.find((h) => h.id === p.harnessId)?.binary ?? p.harnessId}
              items={[
                {
                  label: "Edit",
                  icon: Pencil,
                  onSelect: () => void navigate({ to: "/profiles/$id", params: { id: p.id } }),
                },
                // Defaults are unremovable (the API refuses them) — offer the
                // action only where it would work; the row's badge explains
                // the rest.
                ...(p.isDefault === 1
                  ? []
                  : [
                      {
                        label: "Delete profile",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => void deleteProfile(p.id),
                      },
                    ]),
              ]}
            />
          ))}
        </div>
      )}
    </main>
  );
}
