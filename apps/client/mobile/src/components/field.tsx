import { Text, TextInput, type TextInputProps, View } from "react-native";
import { colors, font, radius, touchTarget } from "@/lib/tokens";

/** Labelled single-line input with a caption line for probe/error copy. */
export function Field({
  label,
  caption,
  captionColor = colors.mutedFg,
  style,
  ...input
}: TextInputProps & { label: string; caption?: string; captionColor?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ ...font("label"), color: colors.mutedFg }}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.mutedFg}
        {...input}
        style={{
          minHeight: touchTarget,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius,
          paddingHorizontal: 12,
          color: colors.fg,
          backgroundColor: colors.card,
          ...font("body"),
          ...style,
        }}
      />
      {caption ? <Text style={{ ...font("caption"), color: captionColor }}>{caption}</Text> : null}
    </View>
  );
}
