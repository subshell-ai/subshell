import { describeDevices, roleLabel, type ViewersState } from "@internal/subshell-protocol";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, font, radius, touchTarget } from "@/lib/tokens";

/**
 * Who else is watching this subshell, and which device is the reason the
 * terminal is the size it is.
 *
 * A phone is usually the SMALLEST viewer, so on this screen the question is
 * normally the other way round from the web's: not "why is my terminal small"
 * but "am I the one shrinking everyone else's". The list answers both, and
 * naming this device as the constraint is the honest way to offer the pin.
 *
 * Collapsed to a one-line strip by default, and absent entirely below two
 * devices: a phone terminal cannot spare the rows, and with one device there
 * is nothing to explain and nothing to choose between.
 */
export function DevicesStrip({
  state,
  onSizing,
}: {
  /** The latest `viewers` frame, or null while the socket is down. */
  state: ViewersState | null;
  /** Applies a sizing choice; the server refuses it for a `view` grantee. */
  onSizing: (mode: "auto" | "pinned", viewerId?: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!state || state.viewers.length < 2) return null;

  const { rows, grid, settled } = describeDevices(state);
  const pinnedId = state.sizing.mode === "pinned" ? state.sizing.pinnedViewerId : null;
  // Whether THIS viewer may change the sizing is the server's own answer,
  // carried on its entry — never a guess made here.
  const mayResize = state.viewers.find((v) => v.id === state.you)?.canInput === true;

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${state.viewers.length} devices watching this subshell`}
        style={{ minHeight: touchTarget, paddingHorizontal: 12, justifyContent: "center" }}
      >
        <Text style={{ ...font("caption"), color: colors.mutedFg }}>
          {state.viewers.length} devices
          {grid && settled ? ` · pane ${grid.cols}×${grid.rows}` : " · measuring…"}
          {pinnedId ? " · pinned" : ""}
          {open ? "  ▾" : "  ▸"}
        </Text>
      </Pressable>

      {open && (
        <View style={{ paddingBottom: 8 }}>
          {rows.map(({ viewer, you, role }) => {
            const label = roleLabel(role);
            const isPinned = viewer.id === pinnedId;
            return (
              <Pressable
                key={viewer.id}
                disabled={!mayResize}
                // Tapping a device pins the pane to it; tapping the pinned one
                // again releases it. Without a way back, pinning would be a
                // one-way door out of the default.
                onPress={() => onSizing(isPinned ? "auto" : "pinned", viewer.id)}
                accessibilityRole="button"
                style={{
                  minHeight: touchTarget,
                  paddingHorizontal: 12,
                  justifyContent: "center",
                  borderRadius: radius,
                  opacity: mayResize ? 1 : 0.6,
                }}
              >
                <Text style={{ ...font("detail"), color: colors.fg }}>
                  {isPinned ? "📌 " : ""}
                  {viewer.label}
                  {you ? "  (this device)" : ""}
                </Text>
                <Text style={{ ...font("caption"), color: colors.mutedFg }}>
                  {viewer.capacity ? `${viewer.capacity.cols}×${viewer.capacity.rows}` : "measuring…"}
                  {label ? ` · ${label}` : ""}
                  {viewer.canInput ? "" : " · read-only"}
                </Text>
              </Pressable>
            );
          })}
          {mayResize && pinnedId && (
            <Pressable
              onPress={() => onSizing("auto", null)}
              accessibilityRole="button"
              style={{ minHeight: touchTarget, paddingHorizontal: 12, justifyContent: "center" }}
            >
              <Text style={{ ...font("detail"), color: colors.primary }}>Back to automatic</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
