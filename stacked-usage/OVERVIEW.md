Stacked usage adds a usage widget to the bottom of the sidebar: one line per account,
stacked, each showing its session and weekly windows as meters coloured by how much is
used (green below 70%, amber from 70%, red above 90%). Paseo's own sidebar summary draws
its meters in grey; this one keeps the colour.

It also reports the Claude and Codex accounts that ZeroSub manages to Paseo's usage
system, so they appear in Paseo's own usage screens as well as in the widget. Readings come
from ZeroSub's saved usage file, so the plugin makes no extra calls to Anthropic or OpenAI;
a ZeroSub account's numbers are as fresh as ZeroSub's last reading. The account ZeroSub
calls the CLI's own login is left to Paseo's built-in source, so it is not listed twice.

Tap the widget, or open Settings, Plugins, Stacked usage, Sidebar meters, to see every
account and window with its reset time and to choose which meters show in the sidebar.
Session and weekly windows show unless hidden; per-model windows show once switched on.

Requires Paseo 0.12 or later. ZeroSub is optional: without it the widget shows the
accounts Paseo already reports.
