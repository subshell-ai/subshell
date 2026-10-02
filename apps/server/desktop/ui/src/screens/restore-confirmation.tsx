import { TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

export function RestoreFacts({ rows }: { rows: [string, string][] }) {
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
  locked: boolean;
  replace: boolean;
  start: boolean;
  setReplace: (checked: boolean) => void;
  setStart: (checked: boolean) => void;
}) {
  return (
    <>
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Existing state will be replaced</AlertTitle>
        <AlertDescription>
          This signs everyone out. Compatible running sessions are preserved. Keep a backup of the destination if you
          need its current state.
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
          <p className="m-0 text-detail text-muted-foreground">
            Compatible sessions are kept running. If any session cannot survive this restore, you will be asked before
            continuing.
          </p>
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
