import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listUsage } from "./server/list";
import { AccountRegistry } from "./server/accounts/registry";
import { Switcher } from "./server/accounts/swap";
import { discoverAccounts, fetchAccountUsage, lbInputSchema } from "./server/accounts/usage-source";
import { HeaderProxy } from "./server/proxy";
import { HeaderReadings } from "./server/readings";
import { routeSession } from "./server/route";
import { betaSettings, displaySettings, routingSettings } from "./shared/settings";
import { listUsageRpc } from "./shared/usage";
import {
  cancelLoginRpc,
  clearLimitRpc,
  importAccountRpc,
  listAccountsRpc,
  refreshAccountRpc,
  removeAccountRpc,
  renameAccountRpc,
  setAccountEnabledRpc,
  setAgentAccountRpc,
  setDefaultAccountRpc,
  startLoginRpc,
  submitLoginCodeRpc,
} from "./shared/accounts";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(displaySettings);
  const beta = server.registerSettings(betaSettings);
  const routing = server.registerSettings(routingSettings);
  // Header readings are matched to accounts by organization.
  let registry: AccountRegistry;
  const readings = new HeaderReadings(async () => registry.identities());
  registry = new AccountRegistry(readings);
  const switcher = new Switcher(registry, async () => {
    const state = await routing.read();
    return state.status === "ready" ? state.values : null;
  });
  const proxy = new HeaderProxy((headers) => readings.record(headers));

  async function proxyEnabled(): Promise<boolean> {
    const state = await beta.read();
    return state.status === "ready" && state.values.headerProxy;
  }

  // Turning the beta off only stops new sessions using the proxy. Sessions already pointed at it
  // are not reopened by a settings change, so it keeps listening until the plugin stops.
  void (async () => {
    await readings.load();
    await registry.start();
    if (await proxyEnabled()) await proxy.start();
  })().catch((error: unknown) => console.error("[Load Balancer] startup failed", describe(error)));

  // Never let routing break or stall an agent: on any error, or if it takes too long (Paseo fails
  // a hook after 30s), the session opens as it would have (on the account chosen so far, without
  // the proxy), and polling covers its usage.
  server.before("agent.session_open", async ({ request }, context) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let routed: typeof request | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 15_000);
    });
    const route = async () => {
      try {
        routed = await switcher.route(request, context.paseo);
      } catch (error) {
        console.error(`[Load Balancer] could not choose an account for ${request.agentId}`, describe(error));
      }
      try {
        if (await proxyEnabled()) routed = (await routeSession(routed ?? request, context.paseo, proxy)) ?? routed;
      } catch (error) {
        console.error(`[Load Balancer] could not route ${request.agentId} through the proxy`, describe(error));
      }
      return routed;
    };
    try {
      return (await Promise.race([route(), deadline])) ?? routed;
    } finally {
      clearTimeout(timer);
    }
  });
  server.on("agent.turn_ended", (event, context) => {
    void switcher.onTurnEnded(event, context.paseo).catch((error: unknown) => console.error("[Load Balancer] turn handling failed", describe(error)));
  });
  server.on("agent.archived", (event) => {
    void switcher.onArchived(event.agent.id)?.catch(() => undefined);
  });

  server.handle(listUsageRpc, async (input, context) =>
    listUsage(input, context, (await proxyEnabled()) ? readings : null),
  );
  const ok = { ok: true as const };
  server.handle(listAccountsRpc, async (_input, context) => {
    const [view, prefs] = await Promise.all([switcher.view(context.paseo), routing.read()]);
    const values = prefs.status === "ready" ? prefs.values : null;
    return {
      ...(await registry.list(view.counts)),
      routing: { enabled: values?.enabled ?? false, showComposerPill: values?.showComposerPill ?? true, canReopen: view.canReopen },
      agents: view.agents,
    };
  });
  server.handle(startLoginRpc, async ({ accountId }) => ({ id: await registry.startLogin(accountId) }));
  server.handle(submitLoginCodeRpc, ({ loginId, code }) => {
    registry.submitCode(loginId, code);
    return ok;
  });
  server.handle(cancelLoginRpc, ({ loginId }) => {
    registry.cancelLogin(loginId);
    return ok;
  });
  server.handle(importAccountRpc, async ({ path }) => ({ accountId: await registry.importFrom(path) }));
  server.handle(renameAccountRpc, async ({ accountId, label }) => {
    await registry.rename(accountId, label);
    return ok;
  });
  server.handle(removeAccountRpc, async ({ accountId }, context) => {
    await switcher.remove(context.paseo, accountId);
    return ok;
  });
  server.handle(setDefaultAccountRpc, ({ accountId }, context) => switcher.setDefault(context.paseo, accountId));
  server.handle(setAccountEnabledRpc, ({ accountId, enabled }, context) => switcher.setEnabled(context.paseo, accountId, enabled));
  server.handle(setAgentAccountRpc, ({ agentId, accountId }, context) => switcher.setAgentAccount(context.paseo, agentId, accountId));
  server.handle(clearLimitRpc, async ({ accountId }) => {
    await switcher.clearLimit(accountId);
    return ok;
  });
  server.handle(refreshAccountRpc, ({ accountId }) => {
    registry.refresh(accountId);
    return ok;
  });
  server.registerUsageSource({
    id: "load-balancer-claude",
    label: "Claude",
    icon: "assets/claude.svg",
    input: lbInputSchema,
    discover: (scope) => discoverAccounts(registry, scope),
    fetch: (input) => fetchAccountUsage(registry, input),
  });
  return () => {
    readings.flush();
    registry.stop();
    proxy.stop();
  };
}
