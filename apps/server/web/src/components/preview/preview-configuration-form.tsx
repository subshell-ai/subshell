import { Button, errMessage, Input } from "@internal/node-admin";
import {
  DEFAULT_PREVIEW_CONFIGURATION,
  normalizeServiceHost,
  type PreviewConfiguration,
} from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type SavedService, useSubshellServices } from "@/hooks/use-subshell-services";
import { fieldError, makeForm, useSubmitDisabled, useSubmitDisabledReason } from "@/lib/form";
import type { WorkspacePreviewTarget } from "@/lib/workspace-preview";

export const UNSANDBOXED_WARNING =
  "This site can access your Subshell browser session and data, interact with the dashboard, and act with your account's permissions. Only enable this for a site and everyone who can change it that you fully trust.";
const options = [
  ["rewriteUrls", "Rewrite app URLs", "Keep app resources and live reload connections inside this preview."],
  [
    "passHost",
    "Pass the preview host",
    "Send the browser's host to the app. Leave this off if the app only accepts its own hostname.",
  ],
  ["rewriteRedirects", "Rewrite redirects", "Keep redirects to this app inside the preview."],
] as const;

export function PreviewConfigurationForm({
  subshellId,
  port,
  service: initialService,
  configuration,
  mode = "open",
  onBack,
  onOpen,
  onSaved,
  onBusyChange,
}: {
  subshellId: string;
  port?: number;
  service?: SavedService;
  configuration?: PreviewConfiguration;
  mode?: "open" | "create" | "edit";
  onBack: () => void;
  onOpen: (view: WorkspacePreviewTarget) => void | Promise<void>;
  onSaved?: (service: SavedService) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  // Keep the revision the user started editing, even when the service list polls.
  const [service] = useState(initialService);
  const services = useSubshellServices(subshellId);
  const [error, setError] = useState<string | null>(null);
  const defaults = {
    ...DEFAULT_PREVIEW_CONFIGURATION,
    ...service?.configuration,
    ...configuration,
    ...(service
      ? {
          host: service.host,
          protocol: service.protocol,
          ignoreCertificateErrors: service.ignoreCertificateErrors ?? false,
        }
      : {}),
  };
  const form = makeForm({
    defaultValues: {
      ...defaults,
      port: String(service?.port ?? port ?? ""),
      name: service?.name ?? "",
      save: mode !== "open",
    },
    validator: (value) => {
      const errors: Record<string, string> = {};
      const number = Number(value.port);
      if (!Number.isInteger(number) || number < 1 || number > 65535) errors.port = "Enter a port between 1 and 65535.";
      if (!normalizeServiceHost(value.host)) errors.host = "Enter a hostname or IP address.";
      if (value.name.length > 80) errors.name = "Use a name of 80 characters or fewer.";
      return errors;
    },
    onSubmit: async (value) => {
      setError(null);
      onBusyChange?.(true);
      const { name, port: rawPort, save, ...settings } = value;
      const targetPort = Number(rawPort);
      const config: PreviewConfiguration = {
        ...settings,
        host: normalizeServiceHost(settings.host) ?? "localhost",
        ignoreCertificateErrors: settings.protocol === "https" && settings.ignoreCertificateErrors,
      };
      try {
        if (mode === "edit" && service) {
          const updated = await services.update(service.id, {
            expectedRevision: service.revision ?? 0,
            name,
            port: targetPort,
            host: config.host,
            protocol: config.protocol,
            ignoreCertificateErrors: config.ignoreCertificateErrors,
            configuration: config,
          });
          await onSaved?.(updated);
        } else if (save || mode === "create") {
          const saved = await services.save({
            name,
            port: targetPort,
            host: config.host,
            protocol: config.protocol,
            ignoreCertificateErrors: config.ignoreCertificateErrors,
            configuration: config,
          });
          if (mode === "create") await onSaved?.(saved);
          else
            await onOpen({
              kind: "service",
              serviceId: saved.id,
              port: saved.port,
              revision: saved.revision,
              configuration: config,
            });
        } else {
          await onOpen(
            service &&
              targetPort === service.port &&
              config.host === service.host &&
              config.protocol === service.protocol &&
              config.ignoreCertificateErrors === (service.ignoreCertificateErrors ?? false)
              ? {
                  kind: "service",
                  serviceId: service.id,
                  port: targetPort,
                  revision: service.revision,
                  configuration: config,
                }
              : { kind: "app", port: targetPort, configuration: config },
          );
        }
      } catch (err) {
        setError(errMessage(err, "Couldn't apply this preview configuration."));
      } finally {
        onBusyChange?.(false);
      }
    },
  });
  const value = useStore(form.store, (state) => state.values);
  const busy = useStore(form.store, (state) => state.isSubmitting);
  const disabled = useSubmitDisabled(form);
  const reason = useSubmitDisabledReason(form);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void form.handleSubmit();
      }}
    >
      {error && (
        <p role="alert" className="text-destructive text-detail">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="contents">
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor={`${id}-port`}>Port</FieldLabel>
            <form.Field name="port">
              {(field) => (
                <>
                  <Input
                    id={`${id}-port`}
                    type="number"
                    min={1}
                    max={65535}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                  {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                    <p className="text-destructive text-detail">{fieldError(field.state.meta.errors)}</p>
                  )}
                </>
              )}
            </form.Field>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-protocol`}>Protocol</FieldLabel>
            <Select
              value={value.protocol}
              items={[
                { value: "http", label: "HTTP" },
                { value: "https", label: "HTTPS" },
              ]}
              onValueChange={(protocol) => {
                if (protocol === "http" || protocol === "https") {
                  form.setFieldValue("protocol", protocol);
                  form.setFieldValue("ignoreCertificateErrors", false);
                }
              }}
            >
              <SelectTrigger id={`${id}-protocol`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-host`}>Host</FieldLabel>
            <form.Field name="host">
              {(field) => (
                <>
                  <Input
                    id={`${id}-host`}
                    value={field.state.value}
                    maxLength={253}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                  {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                    <p className="text-destructive text-detail">{fieldError(field.state.meta.errors)}</p>
                  )}
                </>
              )}
            </form.Field>
            <p className="text-detail text-muted-foreground">localhost means this subshell's node.</p>
          </Field>
          {value.protocol === "https" && (
            <Field>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-certificate`}
                  checked={value.ignoreCertificateErrors}
                  onCheckedChange={(checked) => form.setFieldValue("ignoreCertificateErrors", checked)}
                />
                <FieldLabel htmlFor={`${id}-certificate`}>Ignore certificate validation</FieldLabel>
              </div>
              <p className="text-detail text-warning">
                The connection stays encrypted, but Subshell won't verify the server's identity. Use this only for a
                service you trust.
              </p>
            </Field>
          )}
          {options.map(([key, label, description]) => (
            <Field key={key}>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${key}`}
                  checked={value[key]}
                  onCheckedChange={(checked) => form.setFieldValue(key, checked)}
                />
                <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
              </div>
              <p className="text-detail text-muted-foreground">{description}</p>
            </Field>
          ))}
          <Field>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-sandbox`}
                checked={!value.sandbox}
                aria-describedby={`${id}-sandbox-help${!value.sandbox ? ` ${id}-sandbox-warning` : ""}`}
                onCheckedChange={(checked) => form.setFieldValue("sandbox", !checked)}
              />
              <FieldLabel htmlFor={`${id}-sandbox`}>Run outside the sandbox</FieldLabel>
            </div>
            <p id={`${id}-sandbox-help`} className="text-detail text-muted-foreground">
              Use this when a trusted app needs browser storage, sign-in, or other browser features blocked by the
              sandbox.
            </p>
            {!value.sandbox && (
              <p id={`${id}-sandbox-warning`} className="text-detail text-warning">
                {UNSANDBOXED_WARNING}
              </p>
            )}
          </Field>
          {mode === "open" && !service && (
            <Field>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-save`}
                  checked={value.save}
                  onCheckedChange={(checked) => form.setFieldValue("save", checked)}
                />
                <FieldLabel htmlFor={`${id}-save`}>Save this configuration</FieldLabel>
              </div>
            </Field>
          )}
          {(value.save || mode !== "open") && (
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name (optional)</FieldLabel>
              <form.Field name="name">
                {(field) => (
                  <>
                    <Input
                      id={`${id}-name`}
                      value={field.state.value}
                      maxLength={80}
                      placeholder="My website"
                      onChange={(event) => field.handleChange(event.target.value)}
                      onBlur={field.handleBlur}
                    />
                    {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                      <p className="text-destructive text-detail">{fieldError(field.state.meta.errors)}</p>
                    )}
                  </>
                )}
              </form.Field>
            </Field>
          )}
        </FieldGroup>
      </fieldset>
      {mode === "edit" && (
        <p className="text-detail text-muted-foreground">
          Saving disconnects open previews of this service. Open it again to use the updated settings.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          disabledReason={busy ? "Saving this configuration…" : undefined}
          onClick={onBack}
        >
          {mode === "open" ? "Back" : "Cancel"}
        </Button>
        <Button type="submit" disabled={disabled} disabledReason={reason}>
          {mode === "edit"
            ? "Save changes"
            : mode === "create"
              ? "Save service"
              : value.save
                ? "Save and open"
                : "Open preview"}
        </Button>
      </div>
    </form>
  );
}
