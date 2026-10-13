# out-to-lunch

Shows what Claude is doing right now and why it is taking long.

## Install

In a Claude Code terminal session:

```text
/plugin install out-to-lunch --marketplace jambolo/claude-mods
```

## What it shows

While Claude works, a band above the prompt shows:

- what Claude is doing and for how long: waiting for the API, thinking, writing, preparing a tool call, running a tool, a permission check or prompt, subagents, compacting;
- the likely reasons it is slow: no first token yet (API busy, rate-limited or retrying), a large context or a prompt-cache miss, high effort, a build or test command, a network or MCP call, many round trips;
- the turn's elapsed time, step, tool calls, and where the time went so far.

After a turn of 30 seconds or more, the band shows one line on where its time went, until you dismiss it with `x`.

## Commands

| Command | Result |
| --- | --- |
| `/out-to-lunch` | Prints the current diagnosis, even while a turn is running; when idle, a summary of the last turn. |
| `/out-to-lunch pane` | Opens a pane with the full breakdown, token and cache figures, and the slowest steps. The band's Details button does the same. |
| `/out-to-lunch off` | Hides the band for this session. `/out-to-lunch` and the pane keep working. |
| `/out-to-lunch on` | Shows the band again, from the start of each turn. Every new session starts with it on. |
| `/out-to-lunch on <seconds>` | Shows the band only once a turn has run that long (`/out-to-lunch on 20`), and the last-turn summary only for turns at least that long. For this session. |

## Limits

- Reasons are inferred from events and timing, not measured inside the API or a running command.
- No event marks when you answer a permission prompt, so a tool's run after you approve it counts as permission-prompt time.
- Context and cache reasons use the previous request's token usage.
