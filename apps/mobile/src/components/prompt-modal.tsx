import { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { colors, radius, touchTarget } from "@/lib/tokens";

/**
 * Minimal text-entry modal for rename/notes (Alert.prompt is iOS-only; this
 * is the Android parity path). `onDone(null)` = cancelled — empty strings are
 * meaningful (they clear notes), so they must not be conflated with cancel.
 */
export function PromptModal({
  title,
  initial,
  multiline,
  onDone,
}: {
  /** Modal heading */
  title: string;
  /** Prefilled text */
  initial: string;
  /** Multi-line entry (notes) */
  multiline?: boolean;
  /** Called with the saved text, or null when cancelled */
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal visible onRequestClose={() => onDone(null)} transparent animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: "#000000aa",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 420,
            backgroundColor: colors.card,
            borderRadius: radius * 2,
            padding: 16,
            gap: 12,
          }}
        >
          <Text style={{ color: colors.fg, fontSize: 17, fontWeight: "600" }}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            multiline={multiline}
            autoFocus
            style={{
              minHeight: multiline ? 96 : touchTarget,
              textAlignVertical: multiline ? "top" : "center",
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius,
              padding: 10,
              color: colors.fg,
              backgroundColor: colors.bg,
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
            <Pressable onPress={() => onDone(null)} hitSlop={8} style={{ padding: 10 }}>
              <Text style={{ color: colors.mutedFg }}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => onDone(value)} hitSlop={8} style={{ padding: 10 }}>
              <Text style={{ color: colors.primary, fontWeight: "700" }}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
