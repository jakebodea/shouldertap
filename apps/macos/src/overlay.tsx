import { MAX_REPLY_LENGTH, swatches } from "@shouldertap/domain";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Icon, type IconName } from "./icons";
import { onNativeEvent } from "./native";
import { type OverlayTap, store } from "./store";
import { fonts, paper } from "./theme";

interface OverlayProps {
  readonly isFocused: boolean;
  /** Reduce Motion, read natively when the overlay is shown. */
  readonly reduceMotion?: boolean;
  readonly screenIndex: number;
  readonly tap: OverlayTap;
}

const answers: ReadonlyArray<{
  key: "1" | "2" | "3";
  label: string;
  icon: IconName;
  kind: "on_it" | "in_10" | "reply";
}> = [
  { key: "1", label: "On it", icon: "onIt", kind: "on_it" },
  { key: "2", label: "In 10 min", icon: "in10", kind: "in_10" },
  { key: "3", label: "Reply", icon: "reply", kind: "reply" },
];

const easeOutExpo = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * "Frame": the sender's color covers the display and holds a calm paper page
 * with the message. Rendered by native code once per display; every copy
 * answers the same tap.
 */
export function Overlay({ tap, screenIndex, reduceMotion }: OverlayProps) {
  const swatch = swatches[tap.senderColor] ?? swatches.cobalt;
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [size, setSize] = useState({ width: 1440, height: 900 });
  const [, setTick] = useState(0);

  // A new tap (the next one in the queue) starts fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per tap
  useEffect(() => {
    setReplying(false);
    setReply("");
  }, [tap.id]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const answer = (kind: "on_it" | "in_10" | "reply") => {
    if (kind === "reply") {
      setReplying(true);
    } else {
      store.respond(tap.id, { kind });
    }
  };

  const sendReply = () => {
    const text = reply.trim();
    if (text) {
      store.respond(tap.id, { kind: "text", text });
    }
  };

  // Keys arrive from native for the display that has the keyboard.
  const handlers = useRef({ answer, replying });
  handlers.current = { answer, replying };
  useEffect(() => {
    const subscription = onNativeEvent("overlayKey", (body) => {
      const { key, screenIndex: target } = body as {
        key: string;
        screenIndex: number;
      };
      if (target !== screenIndex) {
        return;
      }
      if (key === "Escape") {
        setReplying(false);
        return;
      }
      const match = answers.find((a) => a.key === key);
      if (match && !handlers.current.replying) {
        handlers.current.answer(match.kind);
      }
    });
    return () => subscription.remove();
  }, [screenIndex]);

  // Arrive with a fade; each new message rises in (opacity only with Reduce
  // Motion). JS-driven: native-driver opacity left the overlay transparent on
  // react-native-macos (Fabric), and these run once per tap.
  const arrive = useRef(new Animated.Value(0)).current;
  const swap = useRef(new Animated.Value(1)).current;
  const firstTap = useRef(tap.id);
  useEffect(() => {
    Animated.timing(arrive, {
      toValue: 1,
      duration: 520,
      easing: easeOutExpo,
      useNativeDriver: false,
    }).start();
  }, [arrive]);
  useEffect(() => {
    if (tap.id === firstTap.current) {
      return;
    }
    swap.setValue(0);
    Animated.timing(swap, {
      toValue: 1,
      duration: 600,
      easing: easeOutExpo,
      useNativeDriver: false,
    }).start();
  }, [tap.id, swap]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  const messageSize = fitMessage(tap.body, size);

  return (
    <Animated.View
      onLayout={onLayout}
      style={[styles.frame, { backgroundColor: swatch.base, opacity: arrive }]}
    >
      <View style={styles.band}>
        <Text numberOfLines={1} style={[styles.sender, { color: swatch.ink }]}>
          {tap.senderName}
        </Text>
        <Text style={[styles.bandMeta, { color: swatch.ink }]}>
          {since(tap.createdAt)}
        </Text>
        {tap.queued > 0 ? (
          <Text style={[styles.bandMeta, styles.more, { color: swatch.ink }]}>
            {tap.queued} more waiting
          </Text>
        ) : null}
      </View>

      <View style={styles.page}>
        <Animated.View
          style={[
            styles.messageArea,
            {
              opacity: swap,
              transform: reduceMotion
                ? []
                : [
                    {
                      translateY: swap.interpolate({
                        inputRange: [0, 1],
                        outputRange: [18, 0],
                      }),
                    },
                  ],
            },
          ]}
        >
          <Text
            selectable
            style={[
              styles.message,
              {
                fontSize: messageSize,
                lineHeight: Math.round(messageSize * 0.98),
                letterSpacing: -0.04 * messageSize,
                maxWidth: messageSize * 12,
              },
            ]}
          >
            {tap.body}
          </Text>
        </Animated.View>

        {replying ? (
          <View style={styles.actions}>
            <View style={styles.field}>
              <TextInput
                autoFocus
                enableFocusRing={false}
                maxLength={MAX_REPLY_LENGTH}
                onChangeText={setReply}
                onSubmitEditing={sendReply}
                placeholder={`Reply to ${tap.senderName}`}
                placeholderTextColor={paper.tone}
                style={styles.input}
                value={reply}
              />
            </View>
            <Pill
              disabled={!reply.trim()}
              fill={swatch}
              icon="send"
              label="Send"
              onPress={sendReply}
            />
            <Pill
              accessibilityLabel="Back"
              icon="back"
              onPress={() => setReplying(false)}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            {answers.map((a, index) => (
              <Pill
                fill={index === 0 ? swatch : undefined}
                hint={a.key}
                icon={a.icon}
                key={a.kind}
                label={a.label}
                onPress={() => answer(a.kind)}
              />
            ))}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

function Pill({
  label,
  icon,
  hint,
  fill,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  label?: string;
  icon: IconName;
  hint?: string;
  fill?: { base: string; ink: string };
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const color = fill ? fill.ink : paper.ink;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        label ? null : styles.iconPill,
        fill
          ? { backgroundColor: fill.base, borderColor: fill.base }
          : hovered && !disabled && styles.pillHover,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Icon color={color} name={icon} size={26} />
      {label ? (
        <Text style={[styles.pillLabel, { color }]}>{label}</Text>
      ) : null}
      {hint ? <Text style={[styles.hint, { color }]}>{hint}</Text> : null}
    </Pressable>
  );
}

/**
 * Message size: 156pt for a few words down to 80pt for a paragraph (on a
 * 1440×900 display), then smaller still if the text wouldn't fit the page.
 */
const fitMessage = (body: string, size: { width: number; height: number }) => {
  const scale = Math.min(
    1.4,
    Math.max(0.7, Math.min(size.width / 1440, size.height / 900))
  );
  const t = Math.min(1, Math.max(0, (body.length - 14) / 70));
  const preferred = (156 - 76 * Math.sqrt(t)) * scale;
  // Room for text: the page minus its padding and the reply row.
  const width = size.width - 2 * 40 - 2 * 72;
  const height = size.height - 96 - 40 - 2 * 64 - 68 - 40;
  // Roughly 0.55em per character and 1em per line, with slack for wrapping.
  const fits = Math.sqrt((width * height) / (Math.max(1, body.length) * 0.75));
  return Math.round(Math.max(36, Math.min(preferred, fits)));
};

const since = (timestamp: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

const styles = StyleSheet.create({
  frame: { flex: 1 },
  band: {
    height: 96,
    flexDirection: "row",
    alignItems: "baseline",
    gap: 18,
    paddingTop: 30,
    paddingHorizontal: 72,
  },
  sender: {
    flexShrink: 1,
    fontFamily: fonts.bold,
    fontSize: 36,
    letterSpacing: -0.72,
  },
  bandMeta: {
    fontFamily: fonts.medium,
    fontSize: 20,
    opacity: 0.72,
    fontVariant: ["tabular-nums"],
  },
  more: { opacity: 0.85 },
  page: {
    flex: 1,
    marginHorizontal: 40,
    marginBottom: 40,
    borderRadius: 28,
    backgroundColor: paper.paper,
    paddingVertical: 64,
    paddingHorizontal: 72,
    gap: 40,
  },
  messageArea: { flex: 1, justifyContent: "center" },
  message: {
    fontFamily: fonts.extraBold,
    color: paper.ink,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: 14 },
  pill: {
    height: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 28,
    borderRadius: 34,
    borderWidth: 2,
    borderColor: paper.line,
  },
  iconPill: { width: 68, paddingHorizontal: 0, justifyContent: "center" },
  pillHover: { borderColor: paper.ink },
  pillLabel: { fontFamily: fonts.bold, fontSize: 24 },
  hint: {
    fontFamily: fonts.medium,
    fontSize: 15,
    opacity: 0.5,
    marginLeft: 4,
    fontVariant: ["tabular-nums"],
  },
  field: {
    flex: 1,
    height: 68,
    justifyContent: "center",
    paddingHorizontal: 30,
    borderRadius: 34,
    borderWidth: 2,
    borderColor: paper.ink,
    backgroundColor: paper.faint,
  },
  input: {
    fontFamily: fonts.medium,
    fontSize: 24,
    color: paper.ink,
  },
  disabled: { opacity: 0.4 },
  pressed: { transform: [{ scale: 0.98 }] },
});
