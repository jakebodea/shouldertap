import type { ReactNode } from "react";
import {
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";

export const colors = {
  label: PlatformColor("labelColor"),
  secondary: PlatformColor("secondaryLabelColor"),
  tertiary: PlatformColor("tertiaryLabelColor"),
  separator: PlatformColor("separatorColor"),
  field: PlatformColor("textBackgroundColor"),
  card: PlatformColor("controlBackgroundColor"),
  tap: "#e8613c",
  danger: PlatformColor("systemRedColor"),
  live: "#34c759",
  waiting: "#ffb020",
  offline: "#9a9a9f",
};

export function Button({
  title,
  onPress,
  kind = "secondary",
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "plain";
  disabled?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === "primary" && styles.primary,
        kind === "plain" && styles.plain,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          kind === "primary" && styles.primaryText,
          kind === "danger" && styles.dangerText,
          kind === "plain" && styles.plainText,
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Muted({
  children,
  style,
}: {
  children: ReactNode;
  style?: TextStyle;
}) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    backgroundColor: colors.card,
  },
  primary: {
    backgroundColor: colors.tap,
    borderColor: colors.tap,
  },
  plain: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    paddingHorizontal: 4,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  buttonText: { fontSize: 13, fontWeight: "500", color: colors.label },
  primaryText: { color: "#fff", fontWeight: "600" },
  dangerText: { color: colors.danger },
  plainText: { color: colors.secondary },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: colors.secondary,
  },
  muted: { fontSize: 12, color: colors.secondary, lineHeight: 17 },
});
