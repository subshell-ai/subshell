import { BACKUP_RESTORE_MODES } from "@internal/subshell-protocol";
import { TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import type { RestoreInspection } from "../lib/ipc";

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[132px_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 break-words [overflow-wrap:anywhere] pb-2 sm:pb-0">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function RestoreChoice(props: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" data-disabled={props.disabled}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
        <p id={`${props.id}-description`} className="m-0 text-detail text-muted-foreground">
          {props.description}
        </p>
      </div>
      <Switch
        id={props.id}
        aria-describedby={`${props.id}-description`}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </Field>
  );
}

export function RestoreConfirmation(props: {
  inspection: RestoreInspection;
  locked: boolean;
  replace: boolean;
  force: boolean;
  start: boolean;
  setReplace: (checked: boolean) => void;
  setForce: (checked: boolean) => void;
  setStart: (checked: boolean) => void;
}) {
  const { inspection } = props;
  const recovery = inspection.admins.find((admin) => admin.id === inspection.recoveryUserId);
  const addresses = inspection.choices?.configOverrides;
  const addressLabels: Record<string, string> = {
    baseUrl: "Public base URL",
    host: "Listen address",
    port: "Port",
    trustedOrigins: "Trusted origins",
  };
  return (
    <>
      <Card aria-labelledby="restore-backup-title">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle id="restore-backup-title">Backup to restore</CardTitle>
            <Badge variant="secondary">
              {BACKUP_RESTORE_MODES.find((mode) => mode.value === inspection.choices?.mode)?.label ??
                "Prepared restore"}
            </Badge>
          </div>
          <CardDescription>
            {inspection.legacyDatabaseOnly ? "Database-only snapshot" : "Full instance archive"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Facts
            rows={[
              ["Captured", new Date(inspection.manifest.completedAt).toLocaleString()],
              ["Server version", inspection.manifest.serverVersion],
              ["Admin recovery", inspection.recoveryUserId ? (recovery?.email ?? inspection.recoveryUserId) : "Off"],
            ]}
          />
          {inspection.recoveryUserId && (
            <p className="m-0 text-detail text-muted-foreground">
              The temporary password is ready. This administrator must change it after signing in.
            </p>
          )}
          {inspection.legacyDatabaseOnly && (
            <p className="m-0 text-detail text-muted-foreground">
              Configuration, identities, plugins and files stay in place.
            </p>
          )}
        </CardContent>
      </Card>
      <Card aria-labelledby="restore-destination-title">
        <CardHeader>
          <CardTitle id="restore-destination-title">Destination</CardTitle>
          <CardDescription>
            {inspection.legacyDatabaseOnly
              ? "The database will be replaced by the snapshot."
              : "These locations will be replaced by the backup."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {inspection.destination && (
            <Facts
              rows={[
                ["Database", inspection.destination.databasePath],
                ...(!inspection.legacyDatabaseOnly
                  ? ([
                      ["Data directory", inspection.destination.dataDir],
                      ["Configuration", inspection.destination.configPath],
                    ] as [string, string][])
                  : []),
              ]}
            />
          )}
          {addresses && Object.keys(addresses).length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-label font-strong">Addresses</h3>
              <Facts
                rows={Object.entries(addresses)
                  .filter(([key]) => key in addressLabels)
                  .map(([key, value]) => [addressLabels[key] as string, String(value)])}
              />
            </div>
          )}
        </CardContent>
      </Card>
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Existing state will be replaced</AlertTitle>
        <AlertDescription>
          This signs everyone out and retires old pane records. Keep a backup of the destination if you need its current
          state.
        </AlertDescription>
      </Alert>
      <Card aria-labelledby="restore-options-title">
        <CardHeader>
          <CardTitle id="restore-options-title">Restore options</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <RestoreChoice
            id="restore-replace"
            label="Replace the displayed destination"
            description="Confirm replacement of the locations shown above."
            checked={props.replace}
            disabled={props.locked}
            onChange={props.setReplace}
          />
          <RestoreChoice
            id="restore-panes"
            label="Allow interruption of active panes"
            description="Local panes may be terminated. Remote panes disconnect and remain on their nodes."
            checked={props.force}
            disabled={props.locked}
            onChange={props.setForce}
          />
          <RestoreChoice
            id="restore-start"
            label="Start the server after restoring"
            description="An installed service keeps its supervision and login setting. Otherwise, this app runs the restored server with a compatible binary."
            checked={props.start}
            disabled={props.locked}
            onChange={props.setStart}
          />
        </CardContent>
      </Card>
    </>
  );
}
