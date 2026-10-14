# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run from the repo root.

| Task | Command |
| --- | --- |
| Validate the marketplace and every listed mod, run every mod's tests, flag unlisted mod folders | `bash scripts/check.sh` |
| Type-check one mod | `npx -y -p typescript@5.6.3 tsc -p <mod>` |

- `<mod>/tsconfig.json` extends `<mod>/.claude-plugin/types/tsconfig.json`, which Claude Code generates when it loads the mod and git ignores. In a fresh clone, type-checking works only after the mod has been loaded once (`claude --plugin-dir <mod>`).
- TypeScript is not installed globally here; use the `npx` form.

## Mod architecture

- The module runs with no Node and no DOM; everything external goes through `$` (`$.clock`, `$.state`, `$.ui`, `$.command`, ...). JSX compiles against the global `h`; elements come from `$.ui.resolve(e)`, never globals.
- The plugin API is early access. The declarations in `<mod>/.claude-plugin/types/claude-code/index.d.ts` are the authority for event inputs, results and element props; grep them rather than guessing.
- Values a drawing reads live in `$.state` (session-scoped, survives hot reloads). Every key must be declared in `<mod>/types/index.d.ts` under `interface PluginState` with the mod's name, or `validate` fails. Module-level variables reset on reload.
- Hooks at gating events (`tool.call`, `tool.check`, `classic.*` decisions, `session.compact`) carry `.catch(($, e, next) => next(e))` so a failing hook never blocks Claude.
- Tests use the kit from `claude-code/testing`: `mock.clock(on)` for time, `$.ui.mount({ plugin, surface, component, props })` to draw the band, `$.command.run` with `origin` and `presentation` supplied.

## Releasing

Bump `version` in `<mod>/.claude-plugin/plugin.json` for each release: GitHub installs only pick up changes through a new version and `claude plugin update`. A local install from this folder (`claude plugin marketplace add <repo>`, then `claude plugin install <mod>@claude-mods`) reads the working copy directly after `/reload-plugins`; don't also install the GitHub copy on the same machine.
