Load Balancer runs several Claude subscriptions side by side: it keeps their sign-ins, opens each
Claude session on one of them, and moves agents to another account when one runs out.

Settings live on one page, opened from the sidebar's Accounts row, the sidebar meters, or
Settings, Plugins, Load Balancer, Accounts and usage: accounts (with each meter's sidebar switch),
routing and the beta switch.

Accounts: the page lists every account with its usage. Add one by signing in. Each account gets
its own home under `$PASEO_HOME/load-balancer/homes`, holding only its sign-in; everything else (projects, transcripts, settings) is shared with `~/.claude`, so an agent
keeps its history whichever account it opens on. Claude Code's own sign-in is listed too, unless a
home already holds that subscription; then that account carries a "Claude Code" badge. With no
default chosen, the first of the plugin's own sign-ins is the default. Removing an account deletes its home but does not sign it
out on Anthropic's side.

Routing, off until switched on in the Routing section of the settings page. Each Claude session
then opens on the agent's own account if it has one, else the default (or, with "Spread new
agents", the account with the most room). When a turn ends on a usage limit or a lost sign-in,
the agent moves to the account with the most room, reopens there and, unless turned off, is told
to carry on; idle agents on the same account move too. A busy agent moves after its turn. When
every account is at its limit, the agent waits: as soon as one has room it moves there if needed
and, unless turned off, is told to carry on. The wait survives a restart; after one, checking resumes once the
app is opened or any agent starts a session. An
account whose session or weekly window reads 100% is skipped by new sessions before any turn runs
into it. An agent changes accounts at most four times in ten minutes. Each move leaves a note in
the agent's timeline. The composer's account button and `/account <name|default>` switch one
agent; the account cards make an account the default, disable it for a while, or mark a limit as
lifted. Reopening uses Paseo's `paseo` command; without it, agents move when their session next
starts.

Sign-ins and usage reads run the same Claude Code as Paseo's agents: the `claude` provider's
command from Paseo's config (`agents.providers.claude.command`, as an argv array or
`{ "mode": "replace", "argv": [...] }`), else `claude` from the daemon's PATH.

Usage: one shared poll reads at most one account every two minutes, and only accounts nothing
else has read lately. Each account card shows its session and weekly windows and per-model
weekly windows such as Fable ("fb" in the sidebar). The sidebar widget shows one line per
account, its meters coloured by how much is used (green below 70%, amber from 70%, red above
90%); the switch at the end of each window's line on a card chooses whether it shows there.

Claude Code mod: every Claude session Paseo opens loads a small Claude Code mod that Load Balancer
writes to its data folder (`claude-mod`) and names in `CLAUDE_CODE_PLUGIN_DIRS`. After each model
response's headers arrive, the mod writes the session and weekly usage headers to a file per agent
(`handoff/<agent>.usage.json`), waiting at most 250 ms for the write, and Load Balancer reads it as
it changes and again when the turn ends. Usage is then current at every model call, with no proxy.
Needs Claude Code 2.1.321 or later, and an organization's mod guard (managed settings, or a Team or
Enterprise sign-in) blocks it; polling covers those sessions.

Beta, off by default: for sessions that can't load the mod, or other providers, the settings page
has a switch to read usage through a local proxy instead. New Claude sessions then run through a local proxy inside the plugin, which copies the session and weekly usage
headers and forwards everything else unchanged. If a session already has an
`ANTHROPIC_BASE_URL`, the proxy forwards to it. Paseo's own usage display skips sessions with a non-Anthropic base URL,
so Load Balancer reports usage for proxied sessions itself. The switch applies from each session's next open.
Turned off, the proxy keeps serving sessions already using it until the plugin next stops.
Reloading the plugin drops requests in flight. A base URL set in Claude's `settings.json`, plugin
sub-agents and terminal CLIs bypass the proxy, and per-model windows are not in the headers;
polling covers all of those.

Requires Paseo 0.12 or later.

Parts of this plugin derive from [ZeroSub](https://github.com/kapybara-org/zerosub) by Kapybara,
under the MIT License; see the repository's `LICENSE`.
