---
paths:
  - "change-of-subject/**"
---

# change-of-subject

- The judge and the dialogs run inside the `prompt.submit` hook, which holds the prompt while they do. `$.model.complete` and `$.ui.ask` are allowed there; `$.command.run`, `$.prompt.submit` and `$.session.compact` are not — the engine refuses each of them from a hook holding a turn. So a chosen command runs from a `$.clock.after` timer, after the hook has answered `{ drop }`, and the prompt it displaced is sent again from there.
- `$.ui.ask` is the pop-up: it is raised as a call to the AskUserQuestion tool, so a test stands in for it with `on('tool.call', { tool: 'AskUserQuestion' }, ...)` answering `{ result: { answers: { [question]: choice } } }`. At most four options, a header of at most 12 characters, and a person can always type their own answer — anything that is not one of the offered options is taken as "leave my prompt alone".
- A typed slash command and a `#` memory line both reach `prompt.submit` with `origin.kind === 'composer'` — measured against 2.1.299 in the terminal, where dropping the line stopped the command from running — so the origin cannot tell them from a prompt and `COMPOSER_LINE` in `model.ts` is what keeps them away from the judge. A `!` shell line does not reach the hook from the terminal; it is named in that guard for a surface where it might.
- A command's own turn does reach `turn.complete`, so the answer to `/release-notes` is remembered as a `claude` line even though the command line itself was never judged. A subagent's answer still is not.
- `act` holds the displaced prompt before the command runs, so a `/clear` that tears the session down still has it. `/clear` and `/compact` make room, so the prompt follows them (`after`); `/btw` is handed the prompt as its own question, so it comes back only `if-it-fails`.
- The test world queues what the engine would do: a `verdicts` entry of `'throw'` is a judge that is not there and an `answers` entry of `'throw'` a dialog the person dismissed, `failing` names a command the engine will not run, `unsendable` a prompt it will not take back (the box catches it), and `pending` holds a command open — `/clear` holds until the session it tore down has been replaced, which is what leaves the hand-back to `session.start`.
- Only a prompt a person typed is judged: the engine calls a typed or queued one `unclassified`, and a client's own box `composer`. A prompt this mod sends again carries a `plugin` origin, so it cannot be judged twice; `sent` guards the same loop a second way.
- `send` passes `asUser: true`. Without it the engine frames a plugin's prompt as `The <plugin> plugin sent a message:` and explains to Claude that it starts the turn in the person's place — measured against 2.1.299; with it the prompt reads as the person's own. The dialogs name no reason for the same reason: the pop-up is a question, not a case, and the judge's words live in `/change-of-subject`. Both dialogs offer `Continue here` for leaving the prompt where it is.
- `decide()` swallows everything and answers `''` for "let it through". Watching a prompt must never cost the person the prompt, so every failure — no judge, a slow judge, an unreadable verdict, a dismissed dialog — ends with `next(e)`.
- The session record (`log`) holds only prompts that reached the session and the main loop's answers, never a subagent's. A prompt handed to `/btw` never enters it, because it never entered the session.
- `off` and `on` are session-only by design: every new session starts watching.
