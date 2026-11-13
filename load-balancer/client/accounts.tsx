// Account management, after ZeroSub's accounts page (https://github.com/kapybara-org/zerosub, MIT).
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  cancelLoginRpc,
  clearLimitRpc,
  importAccountRpc,
  listAccountsRpc,
  refreshAccountRpc,
  removeAccountRpc,
  renameAccountRpc,
  setAccountEnabledRpc,
  setDefaultAccountRpc,
  startLoginRpc,
  submitLoginCodeRpc,
  type AccountView,
  type LoginView,
  type ReadingSource,
  type ReopenSummary,
} from "../shared/accounts";
import { routingSettings, type RoutingPreferences } from "../shared/settings";
import { toneFor } from "../shared/usage";
import { formatPct, formatReset } from "./data";
import { MeterBar } from "./meter";

const QUERY_KEY = ["load-balancer", "accounts"];

/** The orange of Claude's logo, marking Claude Code's own sign-in. */
const CLAUDE_ORANGE = "#D97757";
const CLAUDE_CODE_HINT =
  "Claude Code is signed in to this subscription too (~/.claude). It's one account: both share the same usage limits, and sessions are routed to it through this account's own sign-in.";

const SOURCE_LABEL: Record<ReadingSource, string> = {
  headers: "from model responses",
  poll: "polled",
  cli: "from Claude Code's cache",
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAgo(at: string | null, now = Date.now()): string {
  if (!at) return "never";
  const minutes = Math.round((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

/** What a move did to open agents, for a toast; null when it moved none. */
function describeMoves(summary: ReopenSummary): string | null {
  const parts: string[] = [];
  if (summary.reopened) parts.push(`${summary.reopened} agent${summary.reopened === 1 ? "" : "s"} moved`);
  if (summary.deferred) parts.push(`${summary.deferred} after ${summary.deferred === 1 ? "its" : "their"} turn`);
  if (summary.failed) parts.push(`${summary.failed} couldn't reopen and move at their next start`);
  return parts.length > 0 ? `${parts.join(", ")}.` : null;
}

function useAccounts(fast: boolean) {
  const list = useRpc(listAccountsRpc);
  return useQuery({ queryKey: QUERY_KEY, queryFn: () => list({}), refetchInterval: fast ? 1_000 : 15_000 });
}

function useInvalidate() {
  const client = useQueryClient();
  return useCallback(() => void client.invalidateQueries({ queryKey: QUERY_KEY }), [client]);
}

function Button({
  theme,
  label,
  onPress,
  primary,
  danger,
  disabled,
  busy,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  const color = primary ? theme.colors.accentForeground : danger ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : pressed ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/**
 * A small outlined label. With `onHint`, hovering it (or tapping, on touch screens) asks the card
 * to show its explanation. The card shows it in its own flow: a floating tip would slip under the
 * next row of cards.
 */
function Badge({
  theme,
  label,
  color,
  onHint,
}: {
  theme: PluginTheme;
  label: string;
  color?: string;
  onHint?(shown: boolean | "toggle"): void;
}) {
  const badge = (
    <Text
      style={{
        color: color ?? theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: color ?? theme.colors.border,
      }}
    >
      {label}
    </Text>
  );
  if (!onHint) return badge;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onHoverIn={() => onHint(true)}
      onHoverOut={() => onHint(false)}
      onPress={() => onHint("toggle")}
    >
      {badge}
    </Pressable>
  );
}

function Row({ children, end }: { children: ReactNode; end?: boolean }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: end ? "flex-end" : "flex-start" }}>
      {children}
    </View>
  );
}

function Field({
  theme,
  value,
  onChange,
  placeholder,
  onSubmit,
  label,
}: {
  theme: PluginTheme;
  value: string;
  onChange(text: string): void;
  placeholder: string;
  onSubmit(): void;
  label: string;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      onSubmitEditing={onSubmit}
      accessibilityLabel={label}
      style={{
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
      }}
    />
  );
}

// --------------------------------------------------------------------------- account card

function AccountCard({
  theme,
  account,
  half,
  routing,
  onSignIn,
  onRename,
  onRemove,
}: {
  theme: PluginTheme;
  account: AccountView;
  /** One of two cards to a row, sized by flex so the row never needs measuring. */
  half?: boolean;
  /** Routing is on, so the default and agent counts apply. */
  routing: boolean;
  onSignIn(): void;
  onRename(): void;
  onRemove(): void;
}) {
  const refresh = useRpc(refreshAccountRpc);
  const makeDefault = useRpc(setDefaultAccountRpc);
  const setEnabled = useRpc(setAccountEnabledRpc);
  const clearLimit = useRpc(clearLimitRpc);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const plan = account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : null;
  const subtitle = [account.email !== account.label ? account.email : null, plan].filter(Boolean).join(" · ");
  const main = account.kind === "main";
  const also = main ? "Claude Code's own sign-in (~/.claude). Sign it in or out with the claude command." : null;
  const act = (name: string, action: () => Promise<ReopenSummary | { ok: true }>, done?: string) => {
    setBusy(name);
    void action()
      .then((result) => {
        const moves = "reopened" in result ? describeMoves(result) : null;
        const message = [done, moves].filter(Boolean).join(" ");
        if (message) toast.show(message, { variant: "success" });
      })
      .catch((error: unknown) => toast.error(describe(error)))
      .finally(() => {
        setBusy(null);
        invalidate();
      });
  };
  const status =
    account.status === "limited"
      ? `At its limit${account.limitedUntil ? `, ${formatReset(account.limitedUntil) ?? ""}` : ""}. New sessions skip it.`
      : account.status === "disabled"
        ? "Disabled: nothing is routed to it until you enable it."
        : null;

  return (
    <View
      style={{
        // Two 40% bases plus the gap always fit and three never do; growing fills the row, and a card
        // alone on its row stops at half.
        ...(half ? { flexBasis: "40%", flexGrow: 1, maxWidth: "50%" } : null),
        gap: 10,
        padding: 16,
        borderRadius: 12,
        borderWidth: main ? 2 : 1,
        borderColor: main ? CLAUDE_ORANGE : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{account.label}</Text>
          {routing && account.isDefault ? <Badge theme={theme} label="Default" color={theme.colors.accent} /> : null}
          {!main && account.isCliLogin ? (
            <Badge
              theme={theme}
              label="Claude Code"
              color={CLAUDE_ORANGE}
              onHint={(shown) => setHint((current) => (shown === "toggle" ? !current : shown))}
            />
          ) : null}
          {routing ? <Badge theme={theme} label={`${account.agentCount} agent${account.agentCount === 1 ? "" : "s"}`} /> : null}
        </View>
        {subtitle ? <Text style={muted}>{subtitle}</Text> : null}
        {hint ? <Text style={{ ...muted, color: theme.colors.foreground, marginTop: 4 }}>{CLAUDE_CODE_HINT}</Text> : null}
      </View>
      {!account.signedIn ? (
        <Text style={{ color: theme.colors.statusWarning }}>Signed out. Sign in again to keep tracking it.</Text>
      ) : null}
      {status ? <Text style={{ color: theme.colors.statusWarning }}>{status}</Text> : null}
      {account.windows.map((window) => {
        const reset = formatReset(window.resetsAt);
        return (
          <View key={window.id} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ width: 110, color: theme.colors.foreground, fontSize: 13 }}>{window.label}</Text>
            <MeterBar usedPct={window.usedPct} tone={toneFor(window.usedPct)} theme={theme} height={6} />
            <Text style={{ width: 40, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
              {formatPct(window.usedPct)}
            </Text>
            <Text style={{ ...muted, width: 130 }}>{reset ?? ""}</Text>
          </View>
        );
      })}
      <Text style={muted}>
        {account.readAt
          ? `Read ${formatAgo(account.readAt)}${account.source ? `, ${SOURCE_LABEL[account.source]}` : ""}`
          : "No reading yet"}
      </Text>
      {account.error ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{account.error}</Text> : null}
      {also ? <Text style={muted}>{also}</Text> : null}
      <Row>
        <Button
          theme={theme}
          label="Refresh usage"
          onPress={() =>
            void refresh({ accountId: account.id })
              .then(() => toast.show("Queued for the next usage read", { variant: "info" }))
              .then(invalidate)
              .catch((error: unknown) => toast.error(describe(error)))
          }
        />
        {routing && !account.isDefault && account.status !== "disabled" && account.signedIn ? (
          <Button
            theme={theme}
            label="Make default"
            busy={busy === "default"}
            onPress={() => act("default", () => makeDefault({ accountId: account.id }), `${account.label} is the default.`)}
          />
        ) : null}
        {account.status === "limited" ? (
          <Button
            theme={theme}
            label="Mark available"
            busy={busy === "clear"}
            onPress={() => act("clear", () => clearLimit({ accountId: account.id }))}
          />
        ) : null}
        <Button
          theme={theme}
          label={account.disabled ? "Enable" : "Disable"}
          busy={busy === "enabled"}
          onPress={() => act("enabled", () => setEnabled({ accountId: account.id, enabled: account.disabled }))}
        />
        <Button theme={theme} label="Rename" onPress={onRename} />
        {main ? null : <Button theme={theme} label="Sign in again" onPress={onSignIn} />}
        {main ? null : <Button theme={theme} label="Remove" danger onPress={onRemove} />}
      </Row>
    </View>
  );
}

// --------------------------------------------------------------------------- sign-in

function SignInModal({
  theme,
  accountId,
  logins,
  onClose,
}: {
  theme: PluginTheme;
  accountId?: string;
  logins: LoginView[];
  onClose(): void;
}) {
  const start = useRpc(startLoginRpc);
  const submit = useRpc(submitLoginCodeRpc);
  const cancel = useRpc(cancelLoginRpc);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [loginId, setLoginId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef(0);
  const closed = useRef(false);

  const begin = useCallback(async () => {
    const mine = ++attempt.current;
    setStartError(null);
    setLoginId(null);
    setCode("");
    try {
      const { id } = await start({ accountId });
      if (closed.current || mine !== attempt.current) {
        void cancel({ loginId: id }).catch(() => undefined);
        return;
      }
      setLoginId(id);
      invalidate();
    } catch (error) {
      if (!closed.current && mine === attempt.current) setStartError(describe(error));
    }
  }, [start, cancel, accountId, invalidate]);

  useEffect(() => {
    if (attempt.current === 0) void begin();
  }, [begin]);

  const login = logins.find((entry) => entry.id === loginId) ?? null;
  const ended = login ? ["done", "failed", "canceled"].includes(login.step) : false;
  const close = useCallback(() => {
    closed.current = true;
    if (loginId && !ended) void cancel({ loginId }).catch(() => undefined);
    onClose();
  }, [loginId, ended, cancel, onClose]);

  const send = useCallback(async () => {
    if (!loginId || !code.trim()) return;
    setSubmitting(true);
    try {
      await submit({ loginId, code });
      invalidate();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSubmitting(false);
    }
  }, [loginId, code, submit, invalidate, toast]);

  const text = { color: theme.colors.foreground, fontSize: 14 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  let body: ReactNode;
  if (startError) {
    body = (
      <>
        <Text style={{ color: theme.colors.statusDanger }}>{startError}</Text>
        <Row end>
          <Button theme={theme} label="Close" onPress={close} />
          <Button theme={theme} label="Try again" primary onPress={() => void begin()} />
        </Row>
      </>
    );
  } else if (!login || login.step === "starting" || login.step === "verifying") {
    body = (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        <Text style={muted}>{login?.step === "verifying" ? "Checking the account…" : "Preparing sign-in…"}</Text>
      </View>
    );
  } else if (login.step === "waiting") {
    const link = login.codeUrl;
    body = (
      <View style={{ gap: 14 }}>
        <Text style={text}>
          1. A Claude sign-in page has opened in a browser on the host computer. Sign in there with the account to add and it
          finishes by itself.
        </Text>
        <Text style={text}>2. Or open the link below on any device, sign in, and paste the code it shows.</Text>
        <Row>
          <Button
            theme={theme}
            label="Open sign-in page"
            primary
            disabled={!link}
            onPress={() => link && void openExternalUrl(link).catch((error: unknown) => toast.error(describe(error)))}
          />
          <Button
            theme={theme}
            label="Copy link"
            disabled={!link}
            onPress={() =>
              link &&
              void copyText(link)
                .then(() => toast.show("Link copied", { variant: "success" }))
                .catch(() => toast.error("Couldn't copy the link."))
            }
          />
        </Row>
        <Field theme={theme} value={code} onChange={setCode} placeholder="Paste code" onSubmit={() => void send()} label="Sign-in code" />
        {login.message ? <Text style={muted}>{login.message}</Text> : null}
        <Row end>
          <Button theme={theme} label="Cancel" onPress={close} />
          <Button theme={theme} label="Continue" primary busy={submitting} disabled={!code.trim()} onPress={() => void send()} />
        </Row>
      </View>
    );
  } else if (login.step === "done") {
    body = (
      <>
        <Text style={text}>Signed in. Its usage shows up after the next read.</Text>
        <Row end>
          <Button theme={theme} label="Done" primary onPress={onClose} />
        </Row>
      </>
    );
  } else {
    body = (
      <>
        <Text style={{ color: login.step === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
          {login.message ?? (login.step === "canceled" ? "Sign-in was canceled." : "Sign-in failed.")}
        </Text>
        <Row end>
          <Button theme={theme} label="Close" onPress={close} />
          <Button theme={theme} label="Try again" primary onPress={() => void begin()} />
        </Row>
      </>
    );
  }

  return (
    <Modal title={accountId ? "Sign in again" : "Add Claude account"} open onOpenChange={(open) => (open ? undefined : close())}>
      <Modal.Content>{body}</Modal.Content>
    </Modal>
  );
}

// --------------------------------------------------------------------------- small dialogs

function ImportModal({ theme, onClose }: { theme: PluginTheme; onClose(): void }) {
  const importAccount = useRpc(importAccountRpc);
  const invalidate = useInvalidate();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await importAccount({ path });
      invalidate();
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Import a sign-in" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground }}>
          A Claude config folder on the host that is already signed in (it holds .credentials.json). Its sign-in is copied
          into a new home here; the folder is left as it is, so stop using it afterwards.
        </Text>
        <Field theme={theme} value={path} onChange={setPath} placeholder="C:\path\to\claude-config" onSubmit={() => void run()} label="Folder" />
        {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        <Row end>
          <Button theme={theme} label="Cancel" onPress={onClose} />
          <Button theme={theme} label="Import" primary busy={busy} disabled={!path.trim()} onPress={() => void run()} />
        </Row>
      </Modal.Content>
    </Modal>
  );
}

function RenameModal({ theme, account, onClose }: { theme: PluginTheme; account: AccountView; onClose(): void }) {
  const rename = useRpc(renameAccountRpc);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [label, setLabel] = useState(account.label);
  const save = () =>
    void rename({ accountId: account.id, label })
      .then(() => {
        invalidate();
        onClose();
      })
      .catch((error: unknown) => toast.error(describe(error)));
  return (
    <Modal title="Rename account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Field theme={theme} value={label} onChange={setLabel} placeholder={account.email ?? "Name"} onSubmit={save} label="Name" />
        <Row end>
          <Button theme={theme} label="Cancel" onPress={onClose} />
          <Button theme={theme} label="Save" primary onPress={save} />
        </Row>
      </Modal.Content>
    </Modal>
  );
}

function RemoveModal({ theme, account, onClose }: { theme: PluginTheme; account: AccountView; onClose(): void }) {
  const remove = useRpc(removeAccountRpc);
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      await remove({ accountId: account.id });
      invalidate();
      onClose();
    } catch (failure) {
      setError(describe(failure));
      setBusy(false);
    }
  };
  return (
    <Modal title="Remove account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground }}>
          Remove {account.label}? Its sign-in is deleted from this computer. It is not signed out on Anthropic's side, so
          its other logins (other devices) keep working. Agents on it move to another account.
        </Text>
        {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        <Row end>
          <Button theme={theme} label="Cancel" onPress={onClose} />
          <Button theme={theme} label="Remove" danger busy={busy} onPress={() => void run()} />
        </Row>
      </Modal.Content>
    </Modal>
  );
}

// --------------------------------------------------------------------------- routing

function RoutingSection({ theme, canReopen }: { theme: PluginTheme; canReopen: boolean }) {
  const settings = useSettings(routingSettings);
  const values = settings.status === "ready" ? settings.values : null;
  const save = (patch: Partial<RoutingPreferences>) => {
    if (settings.status !== "ready") return;
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  };
  type Flag = { [Key in keyof RoutingPreferences]: RoutingPreferences[Key] extends boolean ? Key : never }[keyof RoutingPreferences];
  const toggle = (key: Flag, label: string, hint: string, needsRouting = true) => (
    <SettingsSwitch
      label={label}
      hint={hint}
      value={values ? values[key] : false}
      disabled={!values || settings.saving || (needsRouting && !values.enabled)}
      onValueChange={(value) => save({ [key]: value })}
    />
  );
  return (
    <SettingsSection title="Routing">
      {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
      {toggle(
        "enabled",
        "Choose the account for each Claude session",
        "Opens each Claude session on the agent's account. Sessions change account when they next open.",
        false,
      )}
      {toggle("autoSwitch", "Switch accounts at a usage limit", "Moves an agent to the account with the most room when its account runs out or signs out.")}
      {toggle("autoContinue", "Carry on after a switch", "Sends the prompt below so the interrupted turn keeps going.")}
      {values ? (
        <SettingsInput
          label="Prompt sent after a switch"
          initialValue={values.continuePrompt}
          disabled={!values.enabled || !values.autoContinue}
          onChangeText={(text) => {
            if (text.trim()) save({ continuePrompt: text.trim() });
          }}
        />
      ) : null}
      {toggle("balanceNewAgents", "Spread new agents", "New agents open on the account with the most room instead of the default.")}
      {toggle(
        "moveAgentsOnDefaultChange",
        "Move open agents with the default",
        "Off, open agents stay on the account they run on and the new default is for what comes next.",
      )}
      {toggle("showComposerPill", "Account button in the composer", "Shows and switches each Claude agent's account.")}
      {values?.enabled && !canReopen ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          Paseo's command-line tool wasn't found, so agents change account the next time their session starts rather than at once.
        </Text>
      ) : null}
    </SettingsSection>
  );
}

// --------------------------------------------------------------------------- page

type Dialog =
  | { kind: "sign-in"; accountId?: string }
  | { kind: "import" }
  | { kind: "rename"; account: AccountView }
  | { kind: "remove"; account: AccountView }
  | null;

/** Below this page width (phones, narrow panes) the page drops its side padding and shows one card per row. */
const NARROW_WIDTH = 900;
const SIDE_PADDING = 0.1;
const GAP = 16;

export function AccountsScreen({ theme, layout }: PluginSurfaceProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const narrow = layout.compact || (pageWidth !== null && pageWidth < NARROW_WIDTH);
  const accounts = useAccounts(dialog?.kind === "sign-in");
  const data = accounts.data;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      onLayout={(event) => setPageWidth(event.nativeEvent.layout.width)}
      contentContainerStyle={{
        paddingVertical: narrow ? 16 : 24,
        paddingHorizontal: narrow ? 16 : `${SIDE_PADDING * 100}%`,
        gap: GAP,
      }}
    >
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>Claude accounts</Text>
        <Text style={muted}>
          Accounts Load Balancer tracks. Usage comes from model responses when the beta proxy sees them, else from one
          shared poll that reads at most one account every two minutes.
        </Text>
      </View>
      <Row>
        <Button theme={theme} label="Add account" primary onPress={() => setDialog({ kind: "sign-in" })} />
        <Button theme={theme} label="Import a sign-in" onPress={() => setDialog({ kind: "import" })} />
      </Row>
      {accounts.isLoading ? <Text style={muted}>Loading accounts…</Text> : null}
      {accounts.error ? <Text style={{ color: theme.colors.statusDanger }}>{describe(accounts.error)}</Text> : null}
      {data && data.accounts.length === 0 ? <Text style={muted}>No accounts yet.</Text> : null}
      <View style={{ flexDirection: narrow ? "column" : "row", flexWrap: "wrap", gap: GAP }}>
        {data?.accounts.map((account) => (
          <AccountCard
            key={account.id}
            theme={theme}
            account={account}
            half={!narrow}
            routing={data.routing.enabled}
            onSignIn={() => setDialog({ kind: "sign-in", accountId: account.id })}
            onRename={() => setDialog({ kind: "rename", account })}
            onRemove={() => setDialog({ kind: "remove", account })}
          />
        ))}
      </View>
      {data?.nextReadAt ? <Text style={muted}>Next usage read {formatReset(data.nextReadAt)?.replace("resets in", "in") ?? "soon"}.</Text> : null}
      <RoutingSection theme={theme} canReopen={data?.routing.canReopen ?? true} />

      {dialog?.kind === "sign-in" ? (
        <SignInModal theme={theme} accountId={dialog.accountId} logins={data?.logins ?? []} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "import" ? <ImportModal theme={theme} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "rename" ? <RenameModal theme={theme} account={dialog.account} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "remove" ? <RemoveModal theme={theme} account={dialog.account} onClose={() => setDialog(null)} /> : null}
    </ScrollView>
  );
}
