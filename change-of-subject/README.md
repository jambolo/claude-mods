# change-of-subject

Watches every prompt you type and asks one question before it lands: does this belong here?

A long session drifts. A stray question ("what is the capital of Peru?") gets answered in the middle of a refactor and
stays in the context for the rest of the day; a real change of direction ("now cut a release") starts on top of fifty
turns about something else. This mod catches both at the door.

Each prompt is judged against the session it was typed into, and only two verdicts stop anything:

- **Another subject.** A pop-up offers to ask it with `/btw` instead, which answers a side question without touching the
  main conversation. Say yes and the prompt goes there; say *Continue here* and it lands as typed.
- **A new direction or phase in the same work.** A pop-up offers a fresh session, a compaction, or carrying on here.
  Pick one and the mod runs it, then sends your prompt again, in the session the command left behind.

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

## Commands

| | |
|---|---|
| `/change-of-subject` | Whether prompts are being judged, how many have been, and the last verdict. |
| `/change-of-subject off` | Stop judging prompts in this session. |
| `/change-of-subject on` | Start again. |

`off` and `on` are session-only by design: every new session starts watching.

## The three choices for a new phase

Claude Code's `/clear` *is* "start a new session with empty context; previous session stays on disk (resumable with
`/resume`)", so **New session** and clearing the session are one button, not two. The three are:

| Choice | What runs | What you keep |
|---|---|---|
| **New session** | `/clear` | Nothing in context. The session you left stays on disk, resumable with `/resume`. |
| **Compact first** | `/compact` | A summary of the work so far, with the room back. |
| **Continue here** | nothing | Everything, as it was. |

## What it does not do

- It does not judge a prompt that no person typed. A queued or typed prompt is judged; one that came from a plugin, an
  agent, a schedule, a bridge or the SDK is left alone.
- It does not judge a line the composer takes as an instruction to itself. A slash command and a `#` memory line both
  arrive here as typed, so they are matched by their first character and left exactly as they are: a command you meant
  to run is never spent on a side question. A `!` shell line never reaches the mod at all.
- It never costs you a prompt. A judge that fails, times out or answers something unreadable, and a pop-up you dismiss,
  all leave the prompt exactly as you typed it.
- It does not read your transcript. The judge sees the last twelve lines of the session as this mod recorded them — your
  prompts and the first part of Claude's answers — and both are marked to it as material, not as instructions.
- **New session** sends your prompt again in the session `/clear` left behind. When the engine will not take it there,
  the prompt is put back in the box for you to send; it is never silently dropped.
- The judge is a small model making a judgement call, and it will be wrong sometimes. It is told to prefer "same"
  whenever the call is close, so it errs towards leaving you alone.
