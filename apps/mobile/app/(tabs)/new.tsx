import { Text, View } from "react-native";

/** Placeholder for the New-session tab (lands with task 10 of the app-shell plan). */
export default function NewTabPlaceholder() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#8b9095" }}>New session — coming in the next build</Text>
    </View>
  );
}
