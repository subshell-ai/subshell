import {
  apiFetch,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  Label,
  Switch,
} from "@internal/node-admin";
import { useEffect, useState } from "react";

/**
 * Account → Preferences: the per-user subshell MCP switch. One value stored in
 * `user_meta`, so it follows the account across devices. Off means new panes
 * and restarts launch with no MCP registration and a report-only token: the
 * agent keeps its self-reporting (the attention bell, exit codes, subagent
 * roster) but loses the sibling-coordination tools. The two hooks are
 * injectable so the read/write cycle is testable without stubbing fetch (the
 * notifications master switch is the precedent).
 */

/** Module-level so the default prop is a STABLE reference: an inline arrow
 * would re-fire the load effect on every render (refetch loop). */
const getMcpEnabled = () => apiFetch<{ mcpEnabled: boolean }>("/api/settings/mcp").then((r) => r.mcpEnabled);
const setMcpEnabled = (on: boolean) =>
  apiFetch<{ mcpEnabled: boolean }>("/api/settings/mcp", {
    method: "PATCH",
    body: JSON.stringify({ mcpEnabled: on }),
  }).then((r) => r.mcpEnabled);

/** Props exist so tests can drive the switch without a live server. */
export type McpCardProps = {
  /** Defaults to the real `GET /api/settings/mcp`. */
  getEnabled?: () => Promise<boolean>;
  /** Defaults to the real `PATCH /api/settings/mcp`. */
  setEnabled?: (on: boolean) => Promise<boolean>;
};

/** Settings card for "wire the subshell MCP into my panes at all". */
export function McpCard({ getEnabled = getMcpEnabled, setEnabled = setMcpEnabled }: McpCardProps) {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getEnabled()
      .then((on) => live && setEnabledState(on))
      // A probe that fails must not leave a broken switch: fall back to on
      // (the documented default) rather than a false "off", which would
      // silently strip tools from panes the user never opted out of.
      .catch(() => live && setEnabledState(true));
    return () => {
      live = false;
    };
  }, [getEnabled]);

  async function toggle() {
    if (enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setError(null);
    // Optimistic: move the switch now, roll back only if the write fails. The
    // server echoes the persisted value, so on success we adopt that.
    setEnabledState(next);
    try {
      setEnabledState(await setEnabled(next));
    } catch (err) {
      setEnabledState(enabled);
      setError(errMessage(err, "The MCP setting could not be changed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subshell MCP</CardTitle>
        <CardDescription>
          Wire the subshell MCP into your panes so their agents can coordinate with your other subshells. Turning this
          off removes those tools from panes you launch or restart, which narrows what a misled agent can reach and
          frees the context its tool list costs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          {/* Unknown ≠ On: the switch only claims a state the server reported,
              and is inert until it has. */}
          <Switch
            checked={enabled ?? false}
            onCheckedChange={() => void toggle()}
            disabled={busy || enabled === null}
            aria-label="Wire the subshell MCP into my panes"
          />
          <Label>{enabled === null ? "Unknown" : enabled ? "On" : "Off"}</Label>
        </div>
        <p className="text-detail text-muted-foreground">
          Panes already running keep their MCP until they restart. A node whose owner has turned the MCP off refuses it
          for every account, including yours.
        </p>
        {error && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
