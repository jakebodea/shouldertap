import { MAX_REPLY_LENGTH, responsePresets } from "@shouldertap/domain";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { type OverlayTap, store } from "./store";

interface OverlayProps {
  readonly isFocused: boolean;
  readonly screenIndex: number;
  readonly tap: OverlayTap;
}

/** Rendered by native code once per display; every copy answers the same tap. */
export function Overlay({ tap, isFocused }: OverlayProps) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    setReplying(false);
    setReply("");
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sendReply = () => {
    const text = reply.trim();
    if (text) {
      store.respond(tap.id, { kind: "text", text });
    }
  };

  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>
          {tap.senderName} tapped you on the shoulder · {since(tap.createdAt)}
        </Text>
        <Text selectable style={styles.body}>
          {tap.body}
        </Text>

        {replying ? (
          <View style={styles.replyRow}>
            <TextInput
              autoFocus={isFocused}
              maxLength={MAX_REPLY_LENGTH}
              onChangeText={setReply}
              onSubmitEditing={sendReply}
              placeholder={`Reply to ${tap.senderName}…`}
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.replyInput}
              value={reply}
            />
            <Choice
              disabled={!reply.trim()}
              label="Send"
              onPress={sendReply}
              primary
            />
            <Choice label="Back" onPress={() => setReplying(false)} />
          </View>
        ) : (
          <View style={styles.choices}>
            {responsePresets.map((preset) => (
              <Choice
                key={preset.kind}
                label={preset.label}
                onPress={() => store.respond(tap.id, { kind: preset.kind })}
                primary={preset.kind === "on_it"}
              />
            ))}
            <Choice label="💬 Reply…" onPress={() => setReplying(true)} />
          </View>
        )}

        {tap.queued > 0 ? (
          <Text style={styles.queued}>
            {tap.queued} more {tap.queued === 1 ? "tap" : "taps"} waiting
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Choice({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        primary && styles.choicePrimary,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.choiceText}>{label}</Text>
    </Pressable>
  );
}

const since = (timestamp: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(12, 10, 9, 0.55)",
    padding: 48,
  },
  card: {
    width: "100%",
    maxWidth: 760,
    gap: 28,
    padding: 44,
    borderRadius: 28,
    backgroundColor: "rgba(28, 24, 22, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: 20 },
  },
  eyebrow: {
    fontSize: 15,
    fontWeight: "600",
    color: "#f39a78",
  },
  body: {
    fontSize: 44,
    lineHeight: 52,
    fontWeight: "700",
    color: "#fff",
  },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  choice: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  choicePrimary: { backgroundColor: "#e8613c" },
  choiceText: { fontSize: 18, fontWeight: "600", color: "#fff" },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  replyRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  replyInput: {
    flex: 1,
    fontSize: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    color: "#fff",
  },
  queued: { fontSize: 13, color: "rgba(255, 255, 255, 0.55)" },
});
