# claude-mods

Mods for [Claude Code](https://claude.com/claude-code), published as a plugin marketplace.

| Mod | What it does |
| --- | --- |
| [out-to-lunch](out-to-lunch) | Shows what Claude is doing right now and why it is taking long. |

## Install

In a Claude Code terminal session, type the line for the mod you want:

```text
/plugin install <mod> --marketplace jambolo/claude-mods
```

Answer `y` to add the marketplace (asked once), then pick a scope (user scope loads it in every new session). The mod is active in that session at once, with no restart.

The command is not available in the desktop app's Code tab. Install from a terminal: a mod installed at user scope also loads in the desktop app's local sessions.

The mods need a Claude Code build with function hooks (built against 2.1.295). The plugin API is early access and may change between releases.

## Layout

```text
.claude-plugin/marketplace.json   the marketplace: one entry per mod
<mod>/                            one folder per mod
  .claude-plugin/plugin.json      name, version, description, author
  hooks/hooks.json                names the hooks module
  hooks/register.ts(x)            the hooks module
  types/index.d.ts                the mod's $.state contract, if it keeps state
  tests/*.test.ts                 run by claude plugin test
  README.md                       what the mod does and how to use it
scripts/check.sh                  validates and tests every mod
```

`<mod>/.claude-plugin/types/` is written by Claude Code when it loads a mod and is ignored by git.

## Adding a mod

1. Create `<mod>/` with the files above. The folder name, the `name` in `plugin.json` and the marketplace entry's `name` are the same.
2. Add `{ "name": "<mod>", "source": "./<mod>" }` to `plugins` in `.claude-plugin/marketplace.json`.
3. Add a row to the table above and a `README.md` in the mod's folder.
4. Run `bash scripts/check.sh`.

## Development

Install from a local clone so Claude Code reads your working copy:

```bash
claude plugin marketplace add <path to clone>
```

```bash
claude plugin install <mod>@claude-mods
```

After an edit, run `/reload-plugins`. Do not also install the GitHub copies on the same machine.

To try a mod for one session only (with its installed copy disabled):

```bash
claude --plugin-dir <path to clone>/<mod>
```

Validate the marketplace and every mod, and run their tests:

```bash
bash scripts/check.sh
```

Bump `version` in a mod's `.claude-plugin/plugin.json` for each release, so `claude plugin update` picks it up.
