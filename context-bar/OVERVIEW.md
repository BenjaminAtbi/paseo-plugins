Context bar adds a pill above each agent's message box showing how close the conversation
is to Claude Code's next automatic compaction, as a text bar such as
`▰▰▰▰▰▱▱▱▱▱ 312k/600k`. A dot beside it turns from green to amber at 70% of the way
and red above 90%. It updates during a turn, at every model call, not only when the turn
ends. Tap it for the exact token counts and where the compaction point came from.

Paseo's own context ring measures against the model's whole window. This bar measures
against the point where Claude Code actually compacts: `modelSettings.<model>.autoCompactWindow`
or `autoCompactWindow` from Claude Code's user `settings.json`, and otherwise Claude
Code's default (about 967K tokens on 1M-window models, the full window on others). A
per-launch override, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `--autocompact`, is not visible
to the plugin. For non-Claude agents the bar uses the model's whole window.

The bar is text because a plugin pill's label can only be a plain string in one colour;
the coloured dot is the part a plugin can draw. Requires Paseo 0.12 or later.
