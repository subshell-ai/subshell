import { Switch } from "@internal/node-admin";

/**
 * The Enabled cell shared by the agent and SSH preset tables. Whoever holds
 * the owner/edit grant gets the working Switch, which PATCHes through the
 * caller's toggle; a view-only viewer reads the same fact as plain text.
 * The `<td>` stays with each table, because the two columns hide at different
 * container widths.
 */
export function PresetEnabledCell({
  name,
  enabled,
  editable,
  onToggle,
}: {
  /** The preset's name, which labels the switch for screen readers. */
  name: string;
  /** Whether the preset is enabled right now. */
  enabled: boolean;
  /** Owner/edit holders get the Switch; everyone else gets the Yes/No text. */
  editable: boolean;
  /** Receives the new enabled state when the switch is flipped. */
  onToggle: (enabled: boolean) => void;
}) {
  if (!editable) return <span className="text-muted-foreground">{enabled ? "Yes" : "No"}</span>;
  return <Switch checked={enabled} aria-label={`${name} enabled`} onCheckedChange={onToggle} />;
}
