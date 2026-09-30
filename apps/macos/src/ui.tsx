import type { Swatch } from "@shouldertap/domain";
import { type ReactNode, useState } from "react";
import {
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";

import { Icon, type IconName } from "./icons";
import { fonts, live } from "./theme";

/** The popover is a native surface: system colors, system font. */
export const colors = {
  label: PlatformColor("labelColor"),
  secondary: PlatformColor("secondaryLabelColor"),
  tertiary: PlatformColor("tertiaryLabelColor"),
  separator: PlatformColor("separatorColor"),
  field: PlatformColor("textBackgroundColor"),
  card: PlatformColor("controlBackgroundColor"),
  hover: PlatformColor("quaternaryLabelColor"),
  danger: PlatformColor("systemRedColor"),
  live,
  waiting: PlatformColor("systemOrangeColor"),
  offline: PlatformColor("tertiaryLabelColor"),
};

/**
 * Icons and the ink button need plain color strings (SVG strokes don't take
 * PlatformColor), so they follow the popover's appearance by hand.
 */
export function usePalette() {
  const dark = useColorScheme() === "dark";
  return dark
    ? { ink: "#f5f5f7", onInk: "#1d1d1f", icon: "#a1a1a6" }
    : { ink: "#1d1d1f", onInk: "#ffffff", icon: "#6e6e73" };
}

export function Button({
  title,
  onPress,
  kind = "secondary",
  icon,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "plain";
  icon?: IconName;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const palette = usePalette();
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && { backgroundColor: palette.ink, borderColor: palette.ink },
        kind === "plain" && styles.plain,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {icon ? (
        <Icon
          color={primary ? palette.onInk : palette.icon}
          name={icon}
          size={16}
        />
      ) : null}
      <Text
        style={[
          styles.buttonText,
          primary && [styles.primaryText, { color: palette.onInk }],
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
    <View>
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

/** A person: a circle in their color with their initial in its ink. */
export function Avatar({ name, swatch }: { name: string; swatch: Swatch }) {
  return (
    <View style={[styles.avatar, { backgroundColor: swatch.base }]}>
      <Text style={[styles.initial, { color: swatch.ink }]}>
        {name.trim().charAt(0).toUpperCase() || "?"}
      </Text>
    </View>
  );
}

/** A list row that highlights under the pointer; `trailing` gets the hover state. */
export function Row({
  children,
  trailing,
  align = "center",
  onPress,
}: {
  children: ReactNode;
  trailing?: (hovered: boolean) => ReactNode;
  align?: "center" | "flex-start";
  onPress?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      disabled={!onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={[styles.row, { alignItems: align }, hovered && styles.rowHover]}
    >
      {children}
      {trailing ? trailing(hovered) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    backgroundColor: colors.card,
  },
  plain: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    paddingHorizontal: 4,
    minHeight: 24,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  buttonText: { fontSize: 13, fontWeight: "500", color: colors.label },
  primaryText: { fontWeight: "600" },
  dangerText: { color: colors.danger },
  plainText: { color: colors.secondary },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.secondary,
    marginBottom: 6,
  },
  muted: { fontSize: 12, color: colors.secondary, lineHeight: 16 },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: { fontFamily: fonts.bold, fontSize: 12 },
  row: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 6,
    marginHorizontal: -6,
    borderRadius: 7,
  },
  rowHover: { backgroundColor: colors.hover },
});
