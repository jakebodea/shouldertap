import { ApiError } from "@shouldertap/client";
import {
  type Credential,
  describeResponse,
  MAX_NAME_LENGTH,
  type Tap,
} from "@shouldertap/domain";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { native } from "./native";
import { type State, store } from "./store";
import { Button, colors, Muted, Section } from "./ui";

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
      <Text style={styles.title}>Welcome to Shouldertap</Text>
      <Muted>
        People you trust can tap you on the shoulder. Their message covers your
        screens until you answer, and they see your reply right away.
      </Muted>

      <Section title="Set up this Mac">
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
      </Section>

      <Section title="Already set up on another Mac?">
        <TextInput
          onChangeText={setCode}
          placeholder="Paste the pairing code from your other Mac"
          style={styles.input}
          value={code}
        />
        <Button
          disabled={busy || !code.trim()}
          onPress={() => run(() => store.joinWithCode(code))}
          title="Pair this Mac"
        />
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
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Shouldertap</Text>
          <Muted>
            {state.recipientName ? `Taps for ${state.recipientName}` : " "}
          </Muted>
        </View>
        <StatusBadge status={state.status} />
      </View>

      <InviteSender />

      <Section title={`Can tap you (${senders.length})`}>
        {senders.length === 0 ? (
          <Muted>No one yet. Create an invite link above.</Muted>
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

      <Section title={`Your Macs (${macs.length})`}>
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

function StatusBadge({ status }: { status: State["status"] }) {
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
    <View style={styles.badge}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.badgeText}>{label}</Text>
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

  return (
    <Section title="Invite someone">
      {invite ? (
        <View style={styles.inviteCard}>
          <Image source={{ uri: invite.qr }} style={styles.qr} />
          <Muted style={styles.centerText}>
            Scan with their iPhone camera, or send them the link. It works once
            and expires in 7 days.
          </Muted>
          <Text numberOfLines={2} selectable style={styles.link}>
            {invite.url}
          </Text>
          <View style={styles.row}>
            <Button
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
      ) : (
        <Button kind="primary" onPress={create} title="Create invite link" />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Section>
  );
}

function AddMac() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (code) {
    return (
      <View style={styles.inviteCard}>
        <Muted>
          On your other Mac, open Shouldertap and paste this code. It expires in
          15 minutes.
        </Muted>
        <Text numberOfLines={3} selectable style={styles.code}>
          {code}
        </Text>
        <View style={styles.row}>
          <Button
            kind="primary"
            onPress={() => native.copyToClipboard(code)}
            title="Copy code"
          />
          <Button kind="plain" onPress={() => setCode(null)} title="Done" />
        </View>
      </View>
    );
  }
  return (
    <>
      <Button
        kind="plain"
        onPress={async () => {
          setError(null);
          try {
            setCode((await store.createDeviceCode()).code);
          } catch (caught) {
            setError(errorMessage(caught));
          }
        }}
        style={styles.leftButton}
        title="+ Add another Mac"
      />
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
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.pairing}>
      <Text style={styles.pairingIcon}>
        {credential.kind === "sender" ? "📱" : "💻"}
      </Text>
      <View style={styles.grow}>
        <Text style={styles.pairingName}>
          {credential.name}
          {self ? " (this Mac)" : ""}
        </Text>
        <Muted>
          {credential.lastSeenAt
            ? `Active ${ago(credential.lastSeenAt)}`
            : "Paired"}
        </Muted>
      </View>
      {confirming ? (
        <View style={styles.row}>
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
        <Button
          kind="plain"
          onPress={() => setConfirming(true)}
          title="Remove…"
        />
      )}
    </View>
  );
}

function TapRow({ tap }: { tap: Tap }) {
  return (
    <View style={styles.tapRow}>
      <View style={styles.tapHeader}>
        <Text style={styles.pairingName}>{tap.senderName}</Text>
        <Muted>{ago(tap.createdAt)}</Muted>
      </View>
      <Text style={styles.tapBody}>{tap.body}</Text>
      <Muted>
        {tap.response ? describeResponse(tap.response) : "Waiting for you"}
      </Muted>
    </View>
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
      <View style={styles.row}>
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
  content: { padding: 18, gap: 20 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.label },
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
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: colors.card,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: { fontSize: 11, color: colors.secondary },
  inviteCard: {
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.card,
    alignItems: "center",
  },
  qr: { width: 176, height: 176, borderRadius: 6 },
  centerText: { textAlign: "center" },
  link: { fontSize: 11, color: colors.secondary, fontFamily: "Menlo" },
  code: {
    fontSize: 11,
    color: colors.label,
    fontFamily: "Menlo",
    textAlign: "center",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  leftButton: { alignSelf: "flex-start" },
  pairing: { flexDirection: "row", alignItems: "center", gap: 10 },
  pairingIcon: { fontSize: 18 },
  pairingName: { fontSize: 13, fontWeight: "600", color: colors.label },
  grow: { flex: 1 },
  tapRow: {
    gap: 3,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  tapHeader: { flexDirection: "row", justifyContent: "space-between" },
  tapBody: { fontSize: 13, color: colors.label },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
