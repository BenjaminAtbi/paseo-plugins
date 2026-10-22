# paseo-plugins

Local Paseo plugins, one per folder.

- `stacked-usage/` - colour-coded, stacked sidebar usage meters for every account,
  including the ones ZeroSub manages. See its `OVERVIEW.md`.
- `context-bar/` - a text bar above each agent's message box showing how close it is to
  Claude Code's next automatic compaction. See its `OVERVIEW.md`.

Install a plugin from its folder with `paseo plugin add ./<folder>`; after editing, run
`paseo plugin reload <id>`. Type-check with `npm install && npm run typecheck` inside the
folder.
