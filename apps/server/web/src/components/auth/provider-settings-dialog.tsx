import { Button, Label, Switch } from "@internal/node-admin";
import { useId } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type PatchAuthProviderBody, type ProviderAdminView, registrationDisplay } from "@/types/auth-provider";

export const LAST_OPEN_PROVIDER_COPY = "You cannot disable the last provider.";

/** Settings save one field at a time, through the same guarded provider PATCH as the table used. */
export function ProviderSettingsDialog({
  provider,
  computedOpen,
  soleOpen,
  busy,
  error,
  onChange,
  onClose,
}: {
  provider: ProviderAdminView;
  computedOpen: boolean;
  soleOpen: boolean;
  busy: boolean;
  error: string | null;
  onChange: (body: PatchAuthProviderBody) => void;
  onClose: () => void;
}) {
  const id = useId();
  const settings = [
    {
      key: "enabled",
      label: "Enabled",
      accessible: `Enabled for ${provider.name}`,
      checked: provider.enabled,
      description:
        "Allow this provider to operate. Turning it off blocks both sign-in and registration through it, regardless of the settings below.",
      guarded: true,
    },
    {
      key: "signInEnabled",
      label: "Sign-in",
      accessible: `Sign-in for ${provider.name}`,
      checked: provider.signInEnabled,
      description: "Allow existing accounts to sign in through this provider. The provider must also be enabled.",
      guarded: true,
    },
    {
      key: "registrationEnabled",
      label: "Registration",
      accessible: `Registration for ${provider.name}`,
      checked: registrationDisplay(provider, computedOpen).checked,
      description:
        "Allow this provider to create new accounts. Turning this off keeps existing accounts. The provider must also be enabled.",
      guarded: false,
    },
    {
      key: "requireApproval",
      label: "Require approval",
      accessible: `Approval required for ${provider.name}`,
      checked: provider.requireApproval,
      description:
        "Require an administrator to approve new accounts created through this provider before they can access the instance. Existing accounts are unaffected.",
      guarded: false,
    },
  ] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure provider</DialogTitle>
          <DialogDescription className="break-words">
            Settings for {provider.name}. Changes save immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {settings.map((setting) => {
            const reason = busy
              ? "Wait for the provider change to finish."
              : !provider.enabled && setting.key !== "enabled"
                ? "Enable this provider to change this setting."
                : soleOpen && setting.guarded
                  ? LAST_OPEN_PROVIDER_COPY
                  : undefined;
            const descriptionId = `${id}-${setting.key}-description`;
            const reasonId = `${descriptionId}-reason`;
            const control = (
              <Switch
                id={`${id}-${setting.key}`}
                checked={setting.checked}
                disabled={!!reason}
                aria-label={setting.accessible}
                aria-describedby={descriptionId}
                onCheckedChange={(value) => onChange({ [setting.key]: value })}
              />
            );
            return (
              <div key={setting.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Label htmlFor={`${id}-${setting.key}`}>{setting.label}</Label>
                  <p id={descriptionId} className="mt-1 text-detail text-muted-foreground">
                    {setting.description}
                  </p>
                  {reason && (
                    <p id={`${descriptionId}-reason`} className="mt-1 text-detail text-warning">
                      {reason}
                    </p>
                  )}
                </div>
                <span className="mt-1 inline-flex shrink-0">
                  {reason ? (
                    <TooltipProvider delay={300}>
                      <Tooltip>
                        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled switch needs a focusable explanation. */}
                        <TooltipTrigger render={<span tabIndex={0} aria-describedby={reasonId} />}>
                          {control}
                        </TooltipTrigger>
                        <TooltipContent>{reason}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    control
                  )}
                </span>
              </div>
            );
          })}
          {error && (
            <p role="alert" className="text-destructive text-detail">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose} disabled={busy} disabledReason="Wait for the provider change to finish.">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
