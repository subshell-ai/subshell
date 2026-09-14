import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface PluginIconProps {
  /** Plugin id — this is what names the image route */
  pluginId: string;
  /** The plugin's display name; its first character is the fallback monogram */
  name?: string;
  className?: string;
}

/**
 * Ids whose icon this page session already failed to fetch.
 *
 * Whether a plugin HAS an icon is a fact the route knows and no catalog row
 * carries — `InstancePluginRow`, `HarnessInfo` and `NodeHarness` are three
 * different shapes and giving each a presence flag would be three wire
 * changes for a decoration. So this component simply asks, and remembers a
 * miss so a second row (or a remount) does not ask again.
 */
const missing = new Set<string>();

/**
 * A plugin's mark, or a monogram when it has none.
 *
 * The image is fetched from `/api/plugins/<id>/icon` rather than carried in a
 * catalog row: these are real files inside the plugin packages (a vendor's own
 * SVG, or a PNG), and a row that inlined them would put tens of kilobytes of
 * base64 into every list read.
 *
 * `<img>` and never inline SVG. The bytes are a third party's — a plugin is
 * installed by an admin, but "trusted to run in the control-plane process" is
 * not the same as "trusted to inject markup into a page holding the session
 * cookie". An `<img>` is a non-scripting context, which is what makes an
 * unreviewed SVG safe to render at all.
 */
export function PluginIcon({ pluginId, name, className }: PluginIconProps) {
  const [failed, setFailed] = useState(() => missing.has(pluginId));
  // A different plugin in the same slot must not inherit the previous one's
  // verdict — the picker reuses these rows as the selection changes.
  useEffect(() => setFailed(missing.has(pluginId)), [pluginId]);

  const box = cn("size-5 shrink-0 rounded-sm", className);
  if (failed) {
    return (
      <span
        aria-hidden
        className={cn(box, "grid place-items-center bg-muted font-strong text-caption text-muted-foreground")}
      >
        {(name ?? pluginId).charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      // Decorative: every site that renders this also renders the plugin's
      // name as text, so an alt would be the same word twice to a screen
      // reader.
      alt=""
      aria-hidden
      className={cn(box, "object-contain")}
      src={`/api/plugins/${encodeURIComponent(pluginId)}/icon`}
      onError={() => {
        missing.add(pluginId);
        setFailed(true);
      }}
    />
  );
}
