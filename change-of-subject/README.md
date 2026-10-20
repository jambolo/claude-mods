# change-of-subject

Watches every prompt you type and asks one question before it lands: does this belong here?

A long session drifts. A stray question ("what is the capital of Peru?") gets answered in the middle of a refactor and
stays in the context for the rest of the day; a real change of direction ("now cut a release") starts on top of fifty
turns about something else. This mod catches both at the door.

Each prompt is judged against the session it was typed into, and only two verdicts stop anything:

- **Another subject.** A pop-up offers first to ask it with `/btw` instead, which answers a side question without
  touching the main conversation, then a fresh session or a compaction. *Not a side trip* lands it as typed and tells
  the mod the judge got it wrong.
- **A new direction or phase in the same work.** The same pop-up, with a fresh session and a compaction first, then
  `/btw`. *Not a new phase* lands it as typed and tells the mod the judge got it wrong.

`/btw` takes the prompt as its question. A fresh session or a compaction runs first, then the mod sends your prompt
again, in the session the command left behind. To keep the prompt here without saying the judge was wrong, type your
own answer in the pop-up, or dismiss it.

Neither pop-up argues its case: you can see your own prompt and the session it landed in. The verdict and the judge's
few words of reason are in `/change-of-subject` when you want them.

Anything the judge calls part of the work in hand goes straight through with no pop-up at all.

## Install

```text
/plugin install change-of-subject --marketplace jambolo/claude-mods
```

## What it costs

One request to Claude Haiku (about 1k tokens) for each prompt worth judging. Not every prompt is: the first prompt of a
session has nothing to be unrelated to, a bare answer or nudge (`ok`, `go on`, `try again`) carries no subject of its
own, a slash command or a `#` memory line is not a prompt at all, and a prompt typed again is a retry. `/change-of-subject off` stops the judging for the session.
Once you have labels (see [What it learns](#what-it-learns)), each request also carries up to four of your past calls
and your rules, a few hundred tokens more. A label made while Jev judges, or by `/change-of-subject was`, costs one more
Claude Haiku request to explain it, and every ten of a judge's mistakes one request to Claude Sonnet draws its rules
again.

With `/change-of-subject jev`, the same prompts are judged instead by [Jev](https://docs.typesafe.ai/introduction),
TypeSafe AI's decision model: one request to `api.typesafe.ai` each, billed by TypeSafe to the key in
`TYPESAFE_API_KEY` (get one from the [TypeSafe console](https://console.typesafe.ai/keys) and set it before starting
Claude Code). The prompt, the session lines the judge sees, up to four past calls and your rules then go to TypeSafe,
and the past calls and rules can come from other projects (see [What it learns](#what-it-learns)). A prompt you answer
a pop-up about, and its session, also go to Claude Haiku to be explained. Jev picks `same`, `aside` or `phase`, and `aside` or `phase` interrupts only when Jev is at
least 70% sure of it, until your labels set another bar.

## Commands

| Command | What it does |
| --- | --- |
| `/change-of-subject` | Whether prompts are being judged and by which judge, how many have been, and the last verdict. |
| `/change-of-subject off` | Stop judging prompts in this session. |
| `/change-of-subject on` | Start again, judged by Claude Haiku. |
| `/change-of-subject haiku` | Judge with Claude Haiku, the default. The same as `on`. |
| `/change-of-subject jev` | Judge with Jev instead. Refused while `TYPESAFE_API_KEY` is unset or empty. |
| `/change-of-subject was <same\|aside\|phase> [user\|local]` | Correct the last prompt the judge ruled on, for this project (`local`) or for every project (`user`); unnamed, where new labels go. |
| `/change-of-subject learn [user\|local\|off]` | Say where new labels are kept, or set it: this project (the default), every project, or nowhere. |
| `/change-of-subject lessons [user\|local]` | Each scope's labels, how sure the judge must be to interrupt, and the rules drawn from them. |
| `/change-of-subject promote` | Copy this project's labels to every project's. |
| `/change-of-subject forget <user\|local>` | Forget a scope's labels, rules and tallies. |

`off`, `on`, `haiku` and `jev` last until Claude Code exits, and a `/clear` keeps them: every time Claude Code starts,
it starts watching, judged by Claude Haiku. The rest change what is learned, and last.

## The four choices

Claude Code's `/clear` *is* "start a new session with empty context; previous session stays on disk (resumable with
`/resume`)", so **New session** and clearing the session are one button, not two. The four are:

| Choice | What runs | What you keep |
| --- | --- | --- |
| **Ask with /btw** | `/btw` with the prompt | Everything, as it was; the prompt and its answer never enter the session. |
| **New session** | `/clear` | Nothing in context. The session you left stays on disk, resumable with `/resume`. |
| **Compact first** | `/compact` | A summary of the work so far, with the room back. |
| **Not a side trip** / **Not a new phase** | nothing | Everything, as it was, and the judge's mistake is noted. |

A pop-up takes at most four choices, so there is no button for keeping the prompt here with no word on the verdict:
type your own answer, or dismiss the pop-up.

## What it learns

Your answers are kept as labels, and the judge is taught from them. What a choice says depends on the pop-up it was
made in:

| Choice | On a side trip | On a new phase |
| --- | --- | --- |
| **Ask with /btw** | It was a side trip. | It was a side trip: a side question is unrelated to the work, so it is not a new phase of it. The judge's mistake. |
| **New session** | It was a side trip. You may want more than one answer, so it gets a session of its own rather than `/btw`. | It was a new phase. |
| **Compact first** | It was a new phase. A side trip assumes the work so far is irrelevant to it, and a compaction keeps that work. The judge's mistake. | It was a new phase. |
| **Not a side trip** / **Not a new phase** | It was not a side trip. The judge's mistake. | It was not a new phase. The judge's mistake. |
| An answer you type, or a dismissed pop-up | Nothing. | Nothing. |

- The **Not** choices say only what the prompt was not: a prompt that is not a side trip may still start a new phase,
  and one that is not a new phase may still be a side trip.
- An answer you type and a dismissed pop-up say nothing, because you may agree with the judge and still want the
  prompt here.
- `/change-of-subject was` names what the last prompt the judge ruled on was, including one it let through without a
  pop-up.

Whether a prompt is a side trip or a new phase depends on the session it was typed into, so a label keeps how the two
compared: one sentence from Claude Haiku saying what the session was doing and how the prompt related to it. When Claude
Haiku judges, it writes that sentence with its own verdict; when Jev judges, or for `was`, Claude Haiku is asked
separately, after the prompt has gone through, and the label holds the session's lines only until then.

A label also keeps the judge's verdict and its reason, on this machine, in the mod's own store under your Claude Code
directory: the last 100 for each project and 500 for every project, with the ones that bore the judge out let go before
its mistakes. Once everything the mod keeps, for each project and for every project, passes 2 MiB, it lets go of what it
keeps for the projects used longest ago: never the project you are in, and never what it keeps for every project. Nothing is learned while `/change-of-subject off` is in force, and
`/change-of-subject learn off` keeps only the corrections you make with `was`.

Labels kept for every project (by `/change-of-subject learn user`, `was … user` or `promote`) hold prompts typed in the
projects they came from, and every project's judge is taught from them. So a prompt you typed in one project, using this
mod, may be sent to Anthropic (Claude Haiku and Claude Sonnet) while you work in another, and to TypeSafe when Jev judges
there. Labels kept for this project only never leave it.

A call you bore out is the right answer whichever judge made it, so it teaches both; a mistake shows how one judge
decides, so it teaches that judge alone. The judge is taught three ways, this project's labels first and every project's
after:

- **Past calls.** Each request shows the judge up to four of your calls, whatever the new prompt's words: its own
  mistakes first, then one call of each verdict, then the newest. Each shows the prompt, how it compared with its
  session, and the verdict you gave or turned down.
- **How sure is sure enough.** Claude Haiku says how sure it is of each call. Your pop-up answers are tallied by how
  sure the judge was, apart from the labels, so letting old labels go never skews it. Once a scope's tally holds 20 of a
  judge's calls of one verdict, the mod finds the lowest sureness at which four in five of those calls were right, and a
  call below it goes through without a pop-up. Until then Claude Haiku interrupts whenever it calls a side trip or a new
  phase, and Jev only from 70% sure. When `/change-of-subject was` says a call that went through below the bar was the
  side trip or new phase the judge called, the bar comes down to that call until you have answered five more pop-ups
  from that range; then the tally decides again.
- **Rules.** Every ten of a judge's mistakes, Claude Sonnet reads the calls that teach it, with their comparisons, the
  judge's reasons and your word on them, and writes at most ten short rules about how a prompt relates to its session's
  work. The judge reads them with every prompt. They never quote your prompts.

`/change-of-subject lessons` shows what each scope has learned.

## What it does not do

- It does not judge a prompt that no person typed. A queued or typed prompt is judged; one that came from a plugin, an
  agent, a schedule, a bridge or the SDK is left alone.
- It does not judge a line the composer takes as an instruction to itself. A slash command and a `#` memory line both
  arrive here as typed, so they are matched by their first character and left exactly as they are: a command you meant
  to run is never spent on a side question. A `!` shell line never reaches the mod at all.
- It never costs you a prompt. A judge that fails, times out or answers something unreadable, and a pop-up you dismiss,
  all leave the prompt exactly as you typed it. Jev gets 5 seconds, Claude Haiku 15. A judge that fails or times out
  says why in a toast, once for each new failure rather than once per prompt, and `/change-of-subject` shows why the
  last prompt went through unjudged.
- It does not read your transcript. The judge sees the last twelve lines of the session as this mod recorded them — your
  prompts, the first part of Claude's answers and the files Claude changed — and the session's first prompt once those
  lines have let go of it, all marked to it as material, not as instructions.
- **New session** sends your prompt again in the session `/clear` left behind. When the engine will not take it there,
  the prompt is put back in the box for you to send; it is never silently dropped.
- The judge is a small model making a judgment call, and it will be wrong sometimes. It is told to prefer "same"
  whenever the call is close, so it errs towards leaving you alone.
