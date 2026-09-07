import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { useWaitingCount } from "@/hooks/use-summary";
import { colors } from "@/lib/tokens";

/**
 * Explicit icons: SDK 57 no longer bundles @expo/vector-icons through the expo
 * package, so bottom-tabs' default glyph font resolves to nothing and every
 * tab renders a tofu box (emulator smoke, 2026-08-31).
 */
const icon = (name: ComponentProps<typeof Ionicons>["name"]) =>
  function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} size={size} color={color} />;
  };

/** Compact shell (spec §Adaptive): Subshells (waiting badge) · New · Settings. */
export default function TabsLayout() {
  const waiting = useWaitingCount();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedFg,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.bg },
        tabBarIcon: icon("list"),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Subshells",
          tabBarBadge: waiting > 0 ? waiting : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.warning },
        }}
      />
      <Tabs.Screen name="new" options={{ tabBarIcon: icon("add-circle-outline") }} />
      <Tabs.Screen name="settings" options={{ tabBarIcon: icon("settings-outline") }} />
    </Tabs>
  );
}
