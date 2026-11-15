import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installMod, forgetAgent, withMod } from "./server/claude-mod";
import { Changes } from "./server/changes";
import { listUsage } from "./server/list";
import { ModHandoff } from "./server/mod-handoff";
import { AccountRegistry } from "./server/accounts/registry";
import { Switcher } from "./server/accounts/swap";
import { discoverAccounts, fetchAccountUsage, lbInputSchema } from "./server/accounts/usage-source";
import { HeaderProxy } from "./server/proxy";
import { HeaderReadings } from "./server/readings";
import { routeSession } from "./server/route";
import { betaSettings, displaySettings, routingSettings } from "./shared/settings";
import { listUsageRpc, waitForReadingRpc } from "./shared/usage";
import {
  cancelLoginRpc,
  clearLimitRpc,
  listAccountsRpc,
  refreshAccountRpc,
  removeAccountRpc,
  renameAccountRpc,
  setAccountEnabledRpc,
  setAgentAccountRpc,
  getWaitingRpc,
  setWaitingContinueRpc,
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
  const changes = new Changes();
  readings.onChange = () => changes.bump();
  registry.onChange = () => changes.bump();
  const handoff = new ModHandoff(readings, (agentId) => registry.runningOn(agentId)?.email ?? null);

  async function proxyEnabled(): Promise<boolean> {
    const state = await beta.read();
    return state.status === "ready" && state.values.headerProxy;
  }

  // Turning the beta off only stops new sessions using the proxy. Sessions already pointed at it
  // are not reopened by a settings change, so it keeps listening until the plugin stops.
  void (async () => {
    await readings.load();
    await installMod().catch((error: unknown) => console.error("[Load Balancer] could not write the Claude Code mod", describe(error)));
    handoff.start();
    await registry.start();
    switcher.start();
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
      try {
        // Every interactive Claude session loads the mod, which hands over each response's usage.
        const base = routed ?? request;
        if (base.purpose === "interactive" && (await switcher.isClaude(context.paseo, base.provider))) {
          routed = { ...base, env: withMod(base.env, base.agentId) };
        }
      } catch (error) {
        console.error(`[Load Balancer] could not load the Claude Code mod into ${request.agentId}`, describe(error));
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
    // The mod wrote the turn's last reading before the turn ended; take it before judging the turn.
    void handoff
      .ingest(event.agent.id)
      .catch(() => undefined)
      .then(() => switcher.onTurnEnded(event, context.paseo))
      .catch((error: unknown) => console.error("[Load Balancer] turn handling failed", describe(error)));
  });
  server.on("agent.archived", (event) => {
    void switcher.onArchived(event.agent.id)?.catch(() => undefined);
    handoff.forget(event.agent.id);
    void forgetAgent(event.agent.id).catch(() => undefined);
  });

  server.handle(listUsageRpc, async (input, context) => {
    // The sidebar asks for this regularly, which keeps a Paseo handle at hand for waiting agents.
    switcher.remember(context.paseo);
    // Readings come from the mod's hand-offs and, when it is on, the proxy.
    return listUsage(input, context, readings, (await registry.list()).accounts);
  });
  server.handle(waitForReadingRpc, async ({ since }) => ({ version: await changes.wait(since, 20_000) }));
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
  server.handle(getWaitingRpc, ({ agentId }) => switcher.waitingState(agentId));
  server.handle(setWaitingContinueRpc, ({ agentId, continue: value }) => switcher.setWaitingContinue(agentId, value));
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
    discover: (scope) => discoverAccounts(registry, scope, (baseUrl) => proxy.owns(baseUrl)),
    fetch: (input) => fetchAccountUsage(registry, input),
  });
  return () => {
    readings.flush();
    handoff.stop();
    changes.stop();
    switcher.stop();
    registry.stop();
    proxy.stop();
  };
}
