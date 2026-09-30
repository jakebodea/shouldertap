import { ApiError } from "@shouldertap/client";
import {
  type Credential,
  describeResponse,
  MAX_NAME_LENGTH,
  swatches,
  type Tap,
} from "@shouldertap/domain";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { Icon, Mark, responseIcon } from "./icons";
import { native } from "./native";
import { type State, store } from "./store";
import { fonts, swatchFor } from "./theme";
import { Avatar, Button, colors, Muted, Row, Section, usePalette } from "./ui";

const useStore = () => useSyncExternalStore(store.subscribe, store.getState);

const errorMessage = (error: unknown) => {
  if (error instanceof ApiError && error.code === "network") {
    return "Couldn't reach Shouldertap. Check your connection.";
  }
  return error instanceof Error ? error.message : "Something went wrong";
};

export function MenuBar() {
  const state = useStore();
  const screens = {
    loading: (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    ),
    setup: <Setup />,
    ready: <Ready state={state} />,
  };
  return <View style={styles.root}>{screens[state.phase]}</View>;
}

function Brand({
  subtitle,
  children,
}: {
  subtitle: string;
  children?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.header}>
      <Mark color={palette.ink} size={26} />
      <View style={styles.grow}>
        <Text style={styles.brand}>Shouldertap</Text>
        <Text numberOfLines={1} style={styles.subtitle}>
          {subtitle}
        </Text>
      </View>
      {children}
    </View>
  );
}

function Setup() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Brand subtitle="Welcome" />
      <Muted>
        People you trust can tap you on the shoulder. Their message covers your
        screens until you answer, and they see your reply right away.
      </Muted>

      <Section title="Set up this Mac">
        <View style={styles.stack}>
          <TextInput
            maxLength={MAX_NAME_LENGTH}
            onChangeText={setName}
            onSubmitEditing={() =>
              name.trim() && run(() => store.createInbox(name.trim()))
            }
            placeholder="Your first name, as senders will see it"
            style={styles.input}
            value={name}
          />
          <Button
            disabled={busy || !name.trim()}
            kind="primary"
            onPress={() => run(() => store.createInbox(name.trim()))}
            title="Get started"
          />
        </View>
      </Section>

      <Section title="Already set up on another Mac?">
        <View style={styles.stack}>
          <TextInput
            onChangeText={setCode}
            placeholder="Paste the pairing code from your other Mac"
            style={styles.input}
            value={code}
          />
          <Button
            disabled={busy || !code.trim()}
            icon="addMac"
            onPress={() => run(() => store.joinWithCode(code))}
            title="Pair this Mac"
          />
        </View>
      </Section>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {busy ? <ActivityIndicator /> : null}
      <Footer />
    </ScrollView>
  );
}

function Ready({ state }: { state: State }) {
  const senders = state.credentials.filter((c) => c.kind === "sender");
  const macs = state.credentials.filter((c) => c.kind === "device");
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Brand
        subtitle={state.recipientName ? `Taps for ${state.recipientName}` : " "}
      >
        <Status status={state.status} />
      </Brand>

      <InviteSender />

      <Section title="Can tap you">
        {senders.length === 0 ? (
          <Muted>No one yet. Invite someone above.</Muted>
        ) : (
          senders.map((credential) => (
            <PairingRow
              credential={credential}
              key={credential.id}
              self={false}
            />
          ))
        )}
      </Section>

      <Section title="Your Macs">
        {macs.map((credential) => (
          <PairingRow
            credential={credential}
            key={credential.id}
            self={credential.id === state.credentialId}
          />
        ))}
        <AddMac />
      </Section>

      <Section title="Recent">
        {state.taps.length === 0 ? (
          <Muted>Taps you receive show up here.</Muted>
        ) : (
          state.taps.slice(0, 6).map((tap) => <TapRow key={tap.id} tap={tap} />)
        )}
      </Section>

      <Footer />
    </ScrollView>
  );
}

function Status({ status }: { status: State["status"] }) {
  const label = {
    live: "Connected",
    connecting: "Connecting…",
    offline: "Offline",
  }[status];
  const color = {
    live: colors.live,
    connecting: colors.waiting,
    offline: colors.offline,
  }[status];
  return (
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function InviteSender() {
  const [invite, setInvite] = useState<{ url: string; qr: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      setInvite(await store.createSenderInvite());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  if (!invite) {
    return (
      <View style={styles.stack}>
        <Button
          icon="invite"
          kind="primary"
          onPress={create}
          title="Invite someone"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Image source={{ uri: invite.qr }} style={styles.qr} />
      <Muted style={styles.centerText}>
        Scan with their iPhone camera, or send them the link. It works once and
        expires in 7 days.
      </Muted>
      <Text numberOfLines={2} selectable style={styles.mono}>
        {invite.url}
      </Text>
      <View style={styles.inline}>
        <Button
          icon="copy"
          kind="primary"
          onPress={() => {
            native.copyToClipboard(invite.url);
            setCopied(true);
          }}
          title={copied ? "Copied" : "Copy link"}
        />
        <Button
          kind="plain"
          onPress={() => {
            setInvite(null);
            setCopied(false);
          }}
          title="Done"
        />
      </View>
    </View>
  );
}

function AddMac() {
  const palette = usePalette();
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (code) {
    return (
      <View style={[styles.card, styles.cardSpaced]}>
        <Muted style={styles.centerText}>
          On your other Mac, open Shouldertap and paste this code. It expires in
          15 minutes.
        </Muted>
        <Text numberOfLines={3} selectable style={styles.mono}>
          {code}
        </Text>
        <View style={styles.inline}>
          <Button
            icon="copy"
            kind="primary"
            onPress={() => {
              native.copyToClipboard(code);
              setCopied(true);
            }}
            title={copied ? "Copied" : "Copy code"}
          />
          <Button
            kind="plain"
            onPress={() => {
              setCode(null);
              setCopied(false);
            }}
            title="Done"
          />
        </View>
      </View>
    );
  }
  return (
    <>
      <Row
        onPress={async () => {
          setError(null);
          try {
            setCode((await store.createDeviceCode()).code);
          } catch (caught) {
            setError(errorMessage(caught));
          }
        }}
      >
        <View style={styles.glyph}>
          <Icon color={palette.icon} name="addMac" size={18} />
        </View>
        <Text style={styles.addText}>Add another Mac</Text>
      </Row>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );
}

function PairingRow({
  credential,
  self,
}: {
  credential: Credential;
  self: boolean;
}) {
  const palette = usePalette();
  const [confirming, setConfirming] = useState(false);
  const sender = credential.kind === "sender";
  return (
    <Row
      trailing={(hovered) =>
        confirming ? (
          <View style={styles.inline}>
            <Button
              kind="danger"
              onPress={() => store.revoke(credential.id)}
              title={self ? "Unpair" : "Remove"}
            />
            <Button
              kind="plain"
              onPress={() => setConfirming(false)}
              title="Cancel"
            />
          </View>
        ) : (
          <Pressable
            accessibilityLabel={`Remove ${credential.name}`}
            accessibilityRole="button"
            onPress={() => setConfirming(true)}
            style={[styles.remove, !hovered && styles.hidden]}
          >
            <Icon color={palette.icon} name="remove" size={16} />
          </Pressable>
        )
      }
    >
      {sender ? (
        <Avatar
          name={credential.name}
          swatch={swatchFor(credential.color, credential.id)}
        />
      ) : (
        <View style={styles.glyph}>
          <Icon color={palette.icon} name="mac" size={18} />
        </View>
      )}
      <View style={styles.grow}>
        <Text numberOfLines={1} style={styles.name}>
          {credential.name}
        </Text>
        <Text style={styles.meta}>{pairingStatus(credential, self)}</Text>
      </View>
    </Row>
  );
}

function TapRow({ tap }: { tap: Tap }) {
  const palette = usePalette();
  const swatch = swatches[tap.senderColor] ?? swatchFor(null, tap.senderId);
  return (
    <Row align="flex-start">
      <Avatar name={tap.senderName} swatch={swatch} />
      <View style={[styles.grow, styles.tapText]}>
        <Text numberOfLines={2} style={styles.name}>
          {tap.body}
        </Text>
        <View style={styles.answer}>
          {tap.response ? (
            <Icon
              color={palette.icon}
              name={responseIcon(tap.response)}
              size={13}
            />
          ) : null}
          <Text numberOfLines={1} style={[styles.meta, styles.grow]}>
            {tap.response ? describeResponse(tap.response) : "Waiting for you"}
            {` · ${ago(tap.createdAt)}`}
          </Text>
        </View>
      </View>
    </Row>
  );
}

function Footer() {
  const [launch, setLaunch] = useState<boolean | null>(null);
  useEffect(() => {
    native
      .launchAtLogin()
      .then(setLaunch)
      .catch(() => setLaunch(false));
  }, []);
  return (
    <View style={styles.footer}>
      <View style={styles.inline}>
        <Switch
          disabled={launch === null}
          onValueChange={(value) => {
            native
              .setLaunchAtLogin(value)
              .then(setLaunch)
              .catch(() => undefined);
          }}
          value={launch ?? false}
        />
        <Muted>Open at login</Muted>
      </View>
      <Button kind="plain" onPress={() => native.quit()} title="Quit" />
    </View>
  );
}

const pairingStatus = (credential: Credential, self: boolean) => {
  if (self) {
    return "This Mac";
  }
  return credential.lastSeenAt
    ? `Active ${ago(credential.lastSeenAt)}`
    : "Paired";
};

const ago = (timestamp: number) => {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 14, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  brand: {
    fontFamily: fonts.bold,
    fontSize: 16,
    letterSpacing: -0.32,
    color: colors.label,
  },
  subtitle: { fontSize: 12, color: colors.secondary },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, color: colors.secondary },
  stack: { gap: 8 },
  input: {
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    backgroundColor: colors.field,
    color: colors.label,
  },
  error: { fontSize: 12, color: colors.danger },
  card: {
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.card,
    alignItems: "center",
  },
  cardSpaced: { marginTop: 4 },
  qr: { width: 176, height: 176, borderRadius: 6 },
  centerText: { textAlign: "center" },
  mono: {
    fontSize: 11,
    color: colors.secondary,
    fontFamily: "Menlo",
    textAlign: "center",
  },
  inline: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  glyph: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 13, fontWeight: "600", color: colors.label },
  meta: { fontSize: 12, color: colors.secondary },
  addText: {
    alignSelf: "center",
    fontSize: 13,
    fontWeight: "500",
    color: colors.secondary,
  },
  remove: {
    alignSelf: "center",
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  hidden: { opacity: 0 },
  tapText: { gap: 2 },
  answer: { flexDirection: "row", alignItems: "center", gap: 5 },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
});
