import { Button, FormSectionTitle, Input, Label } from "@internal/node-admin";
import { API_KEY_PERMISSION_GROUPS, API_KEY_PERMISSIONS, type ApiKeyPermission } from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formDialogOpenChange,
} from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { RequiredMark } from "@/components/ui/required-mark";
import { type CreatedSystemKey, keyErrorMessage, useCreateSystemKey } from "@/hooks/use-system-keys";

import { makeForm, useSubmitDisabled } from "@/lib/form";

/**
 * The create flow for one system API key, opened from the page header's
 * `Create key` (it moved OUT of `SystemApiKeysCard` on 2026-09-25 so the page
 * carries its one create act in the top right, the shape Add node, Add user
 * and Add provider already set). The plaintext is shown exactly once, in the
 * reveal half of this dialog; the list only ever carries previews.
 */
export function SystemKeyCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateSystemKey();
  const pending = useRef(false);
  const form = makeForm({
    defaultValues: { name: "", permissions: [] as ApiKeyPermission[] },
    validator: ({ name, permissions }) => {
      const problems: Record<string, string> = {};
      if (!name.trim()) problems.name = "Enter a name for the API key first.";
      if (!permissions.length) problems.permissions = "Select at least one permission.";
      return problems;
    },
    onSubmit: () => submitCreate(),
  });
  const { name, permissions } = useStore(form.store, (state) => state.values);
  const submitDisabled = useSubmitDisabled(form, create.isPending);
  const allSelected = permissions.length === API_KEY_PERMISSIONS.length;
  function selectPermissions(grants: readonly ApiKeyPermission[], checked: boolean) {
    if (pending.current) return;
    form.setFieldValue("permissions", (previous) =>
      checked ? [...new Set([...previous, ...grants])] : previous.filter((grant) => !grants.includes(grant)),
    );
  }
  const [formError, setFormError] = useState<string | null>(null);
  // The one-time reveal: set after a successful create, cleared on close.
  const [created, setCreated] = useState<CreatedSystemKey | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    if (pending.current) return;
    onOpenChange(false);
    form.reset();
    setCreated(null);
    setCopied(false);
    setFormError(null);
  }

  async function submitCreate() {
    setFormError(null);
    if (!name.trim() || permissions.length === 0 || pending.current) return;
    pending.current = true;
    try {
      setCreated(await create.mutateAsync({ name: name.trim(), permissions }));
      form.setFieldValue("name", "");
    } catch (err) {
      setFormError(keyErrorMessage(err));
    } finally {
      pending.current = false;
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      setFormError(null);
    } catch {
      setCopied(false);
      setFormError("Couldn't copy the key. Select and copy the text above before closing this dialog.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={formDialogOpenChange((next) => (next ? onOpenChange(true) : close()))}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>Copy it now. This is the only time the full key is shown.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              {/* `min-w-0` is the fix, not decoration: a flex item's default
                  min-width is its content width, so the one-word key pushed
                  the dialog past itself and a scrollbar appeared at the
                  dialog's foot. `break-all` then wraps the secret where it
                  lives — a key shown once should be readable whole, not
                  scrolled. */}
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted p-3 font-mono text-sm">{created.key}</code>
              {/* The copy ICON, not the word (Patterns, `docs/design-system.md`) — and
                  the sentence above still says "Copy it now", so the verb is on the
                  screen even though the button no longer repeats it. */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={copied ? "API key copied" : "Copy API key"}
                onClick={() => void copyKey()}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {/* The HOW, spelled with the real key (operator, 2026-09-25): a
                first-time maker learns what to DO with this string at the one
                moment they can still see it. */}
            <p className="text-detail text-muted-foreground">
              Use it as the request's Authorization header:{" "}
              <span className="break-all font-mono text-foreground">Authorization: Bearer {created.key}</span>
            </p>
            <p className="text-detail text-warning">
              Store it somewhere safe. If you lose it, you'll need to create a new key.
            </p>
            {formError && (
              <p role="alert" className="text-destructive text-detail">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>New system key</DialogTitle>
              <DialogDescription>Give the key a name so you can recognize it later.</DialogDescription>
            </DialogHeader>
            <FieldGroup className="py-4">
              <Field>
                <Label htmlFor="key-name">
                  Name
                  <RequiredMark />
                </Label>
                <Input
                  id="key-name"
                  required
                  maxLength={64}
                  placeholder="e.g. lan-backup"
                  value={name}
                  disabled={create.isPending}
                  onChange={(e) => form.setFieldValue("name", e.target.value)}
                />
              </Field>
              <Field>
                <div className="flex items-center gap-2">
                  <Checkbox
                    disabled={create.isPending}
                    id="key-permissions-all"
                    checked={allSelected}
                    indeterminate={permissions.length > 0 && !allSelected}
                    onCheckedChange={(checked) => selectPermissions(API_KEY_PERMISSIONS, checked)}
                  />
                  <Label htmlFor="key-permissions-all">Select all permissions</Label>
                </div>
                <p className="text-detail text-muted-foreground">
                  Select at least one permission. Keys use the shared system account and can reach its nodes and data.
                  Browser-only administration stays unavailable, even with every permission selected.
                </p>
              </Field>
              {API_KEY_PERMISSION_GROUPS.map((group) => {
                const grants = group.permissions.map((permission) => permission.id);
                const selectedCount = grants.filter((grant) => permissions.includes(grant)).length;
                return (
                  <fieldset key={group.id} className="flex min-w-0 flex-col gap-3">
                    <FormSectionTitle as="legend" className="mb-3">
                      {group.label}
                    </FormSectionTitle>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        disabled={create.isPending}
                        id={`key-group-${group.id}`}
                        checked={selectedCount === grants.length}
                        indeterminate={selectedCount > 0 && selectedCount < grants.length}
                        onCheckedChange={(checked) => selectPermissions(grants, checked)}
                      />
                      <Label htmlFor={`key-group-${group.id}`}>Select all in {group.label.toLowerCase()}</Label>
                    </div>
                    {group.permissions.map((permission) => (
                      <Field key={permission.id} className="gap-1">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            disabled={create.isPending}
                            id={`key-permission-${permission.id}`}
                            checked={permissions.includes(permission.id)}
                            aria-describedby={`key-help-${permission.id}`}
                            onCheckedChange={(checked) => selectPermissions([permission.id], checked)}
                          />
                          <Label htmlFor={`key-permission-${permission.id}`}>{permission.label}</Label>
                        </div>
                        <p id={`key-help-${permission.id}`} className="pl-6 text-detail text-muted-foreground">
                          {permission.description}
                        </p>
                      </Field>
                    ))}
                  </fieldset>
                );
              })}
              {allSelected && (
                <p role="alert" className="text-detail text-warning">
                  This key can run commands, read accessible output, transfer files, change node access, and stop work
                  across the system account's resources. Anyone holding it can use all these permissions. Select only
                  what your integration needs.
                </p>
              )}
              {formError && <p className="text-destructive text-detail">{formError}</p>}
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={close}
                disabled={create.isPending}
                disabledReason="Wait for the API key to be created."
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitDisabled}
                disabledReason={
                  create.isPending
                    ? "Wait for the API key to be created."
                    : !name.trim()
                      ? "Enter a name for the API key first."
                      : "Select at least one permission."
                }
              >
                {create.isPending ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
