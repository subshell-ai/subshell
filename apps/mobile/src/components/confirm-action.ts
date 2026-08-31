import { Alert } from "react-native";

/**
 * The confirm-sheet skeleton used before every operator action (five copies
 * before review #6 — copy and button order had started to drift).
 */
export function confirmAction(
  title: string,
  message: string,
  actionLabel: string,
  onPress: () => void,
  opts: { destructive?: boolean } = {},
): void {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: actionLabel, ...(opts.destructive ? { style: "destructive" as const } : {}), onPress },
  ]);
}
