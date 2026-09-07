import { ActivityIndicator, Pressable, Text } from "react-native";
import { colors, radius, touchTarget } from "@/lib/tokens";

/**
 * The shared primary CTA (review #9: four copy-pasted Pressable blocks with
 * the disabled condition computed twice — once for `disabled`, once for the
 * opacity). 44-tall blue pill, spinner while busy, dimmed while disabled.
 */
export function PrimaryButton({
  onPress,
  label,
  disabled = false,
  busy = false,
  bold = false,
}: {
  onPress: () => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  bold?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={{
        minHeight: touchTarget,
        borderRadius: radius,
        backgroundColor: colors.primary,
        alignItems: "center",
        justifyContent: "center",
        opacity: off ? 0.5 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color={colors.bg} />
      ) : (
        <Text style={{ color: colors.bg, fontWeight: bold ? "700" : "600" }}>{label}</Text>
      )}
    </Pressable>
  );
}
