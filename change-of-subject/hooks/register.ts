// Everything that takes `$` lives in this file, for compatibility with 2.1.295: it follows `$` only into functions
// declared in the same file. Do not move the labels or judges back into modules that are imported.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import type { Beat, Calibration, Call, Example, Interrupting, Judge, Judgment, Learning, Lessons, Scope, Teaching, Truth, Verdict } from '../types'
import {
  ASIDE_HEADER,
  ASIDE_QUESTION,
  BEATS,
  CARRY_ON_HERE,
  COMPACT_FIRST,
  EMPTY,
  LIMITS,
  NEW_SESSION,
  NOT_ASIDE,
  NOT_PHASE,
  PHASE_HEADER,
  PHASE_QUESTION,
  USE_BTW,
  bearsOut,
  beatOf,
  callOf,
  clip,
  explanationOf,
  failed,
  hasSubject,
  isWorthJudging,
  jevRefused,
  keep,
  messageOf,
  outcomeOf,
  promptOf,
  readJev,
  readVerdict,
  readWas,
  remember,
  report,
  scopeOf,
  sessionOf,
  sizeOf,
  squash,
} from './model'
import {
  EXPLAIN_SYSTEM,
  LESSONS_SYSTEM,
  UNTAUGHT,
  answeredIn,
  barsFor,
  explainBrief,
  gate,
  haikuRequest,
  isDue,
  jevRequest,
  lessonsBrief,
  pastCalls,
  readExplanation,
  readLessons,
  recountedIn,
  reopenedIn,
  scopeReport,
} from './teach'
import type { Bars } from './teach'

type Judging = Exclude<Judge, 'off'>

const log = atom({ plugin: 'change-of-subject', key: 'log' } as const, EMPTY)
const anchor = atom({ plugin: 'change-of-subject', key: 'anchor' } as const, null)
const judge = atom({ plugin: 'change-of-subject', key: 'judge' } as const, 'haiku')
const last = atom({ plugin: 'change-of-subject', key: 'last' } as const, null)
const judged = atom({ plugin: 'change-of-subject', key: 'judged' } as const, 0)
const ruling = atom({ plugin: 'change-of-subject', key: 'ruling' } as const, null)

const JUDGES: readonly Judging[] = ['haiku', 'jev']

const USAGE = [
  'Usage: `/change-of-subject [on | off | haiku | jev]`, or:',
  '- `was <same | aside | phase> [user | local]` corrects the last prompt judged',
  '- `learn [user | local | off]` says or sets where new labels are kept',
  '- `lessons [user | local]` shows the labels, the bars they set and the rules drawn from them',
  "- `promote` copies this project's labels to every project's",
  "- `forget <user | local>` forgets a scope's labels and rules",
].join('\n')
const NO_KEY = 'Jev needs `TYPESAFE_API_KEY` set to a key where Claude Code started. The judge is unchanged.'
const NOTHING_RULED = 'Nothing judged yet in this session, so nothing to correct.'
/** What `/change-of-subject` answers on switching to each judge. */
const SAID: Record<Judge, string> = {
  off: 'Not watching prompts any more. `/change-of-subject on` starts again.',
  haiku: 'Watching every prompt, judged by Claude Haiku.',
  jev: `Watching every prompt, judged by Jev. Warning: each prompt judged, with the last ${BEATS} lines of the session, a few past calls and the rules drawn from your labels, goes to TypeSafe AI (api.typesafe.ai). Past calls and rules kept for every project carry prompts from other projects.`,
}
/** What the toast for a failing judge suggests doing about it. */
const WHILE_FAILING: Record<Judging, string> = {
  haiku: '`/change-of-subject off` stops the judging.',
  jev: '`/change-of-subject haiku` switches to Claude Haiku.',
}
/** How the commands name each scope, within a sentence and at its head. */
const SCOPE_NAMES: Record<Scope, string> = { local: 'this project', user: 'every project' }
const SCOPE_TITLES: Record<Scope, string> = { local: 'This project', user: 'Every project' }
/** What `/change-of-subject learn` says of where labels go. */
const LEARNING: Record<Learning, string> = {
  local: 'New labels are kept for this project.',
  user: 'New labels are kept for every project.',
  off: 'New labels are not kept. `/change-of-subject was` still keeps the corrections you make.',
}
const QUOTED_CHARS = 60
// Long enough for the engine to finish dropping the prompt before a command runs in its place.
const ACT_MS = 250

/** A prompt held back while a command runs in its place, submitted again once that command is done. */
let held: string | null = null
/** The last prompt this mod submitted itself, so its own submission is never judged a second time. */
let sent: string | null = null
/** The files Claude changed in the turn under way. */
const touched = new Set<string>()
/** The scopes and judges whose rules are being drawn, so none is drawn twice at once. */
const drawing = new Set<string>()
/** The labels being explained, so none is explained twice at once. */
const explaining = new Set<string>()

function takeHeld(): string | null {
  const text = held
  held = null

  return text
}

/**
 * Remembers one line of the session, and the session's first prompt with a subject. A
 * record nobody can write is not worth failing a turn over.
 */
async function note($: EngineInterface, who: Beat['who'], text: unknown, files: readonly string[] = []): Promise<void> {
  try {
    if (typeof text !== 'string') return
    await update($, log, l => remember(l, beatOf(who, text, files)))
    if (who === 'you' && hasSubject(text) && (await read($, anchor)) === null) await update($, anchor, () => beatOf(who, text))
  } catch {
    // The judge reads a shorter session; nothing else changes.
  }
}

/** Hands a held prompt back: submitted again, or put in the box for the person when the engine will not take it. */
async function send($: EngineInterface, text: string): Promise<void> {
  sent = text
  try {
    // `asUser`: the prompt is the person's own, and without it the engine frames it as a
    // message from a plugin and explains itself to Claude above the prompt.
    await $.prompt.submit({ text, asUser: true })

    return
  } catch {
    // A session torn down by /clear takes its queue with it; the box is the fallback.
  }
  try {
    await $.prompt.fill({ text })
  } catch {
    // Nothing left to try: the dialog already said what was happening.
  }
}

/**
 * How a displaced prompt comes back: `after` the command has run (the command made room
 * for it), or only `if-it-fails` (the command was handed the prompt itself, so it comes
 * back only when it never ran).
 */
type HandBack = { text: string; when: 'after' | 'if-it-fails' }

/**
 * Runs the command the person chose in the prompt's place, then hands the prompt back.
 * The engine refuses `$.command.run` inside a `prompt.submit` hook — it would wait on the
 * turn the hook is holding — so this runs off a timer, once the hook has answered.
 */
function act($: EngineInterface, command: string, args: string, back: HandBack): void {
  // Held before the command runs, so a `/clear` that tears this session down still has it.
  held = back.when === 'after' ? back.text : null
  $.clock.after(ACT_MS, () => {
    void (async () => {
      try {
        await $.command.run({ command, args })
      } catch {
        // The command never ran, so a prompt it was given is the person's again.
        if (back.when === 'if-it-fails') held = back.text
      }
      // `/clear` ends this session, and its `session.start` claims the prompt first.
      const text = takeHeld()
      if (text !== null) await send($, text)
    })()
  })
}

async function askAbout($: EngineInterface, j: Judgment): Promise<string> {
  const isAside = j.verdict === 'aside'
  try {
    return await $.ui.ask(isAside ? ASIDE_QUESTION : PHASE_QUESTION, {
      header: isAside ? ASIDE_HEADER : PHASE_HEADER,
      options: isAside
        ? [USE_BTW, CARRY_ON_HERE, NOT_ASIDE]
        : [NEW_SESSION, COMPACT_FIRST, CARRY_ON_HERE, NOT_PHASE],
    })
  } catch {
    // A dismissed dialog is a person saying: leave my prompt where it is.
    return ''
  }
}

const labelKey = (scope: Scope, x: Pick<Example, 'at' | 'prompt'>): string => `${scope}:${x.at}:${x.prompt}`

/**
 * Has Claude Haiku write the comparison a label lacks, and the reason when Jev judged, from
 * the session kept with it, then lets that session go. A label it cannot explain keeps its
 * session and is tried again before its judge's rules are next drawn.
 */
async function explain($: EngineInterface, scope: Scope, one: Example): Promise<void> {
  const key = labelKey(scope, one)
  if (one.session === undefined || explaining.has(key)) return

  explaining.add(key)
  try {
    const said = await explainVerdict($, one.session, one.prompt, one.said)
    if (said === undefined) return

    const examples = await relearn($, scope, one, ({ session: _, ...x }) => ({
      ...x,
      ...explanationOf({ reason: x.reason ?? said.reason, comparison: said.comparison }),
    }))
    await drawIfDue($, scope, one.judge, examples)
  } catch {
    // The label waits with its session.
  } finally {
    explaining.delete(key)
  }
}

/** Explains every label of a scope still waiting on a comparison, one after another. */
async function explainWaiting($: EngineInterface, scope: Scope): Promise<void> {
  for (const x of (await readScope($, scope)).examples) if (x.comparison === undefined) await explain($, scope, x)
}

/**
 * Draws one judge's rules for a scope again, once its labels have their comparisons. A
 * model that gives none leaves the rules as they were.
 */
async function draw($: EngineInterface, scope: Scope, by: Judging): Promise<void> {
  try {
    await explainWaiting($, scope)
    const { examples, lessons } = await readScope($, scope)
    const drawn = lessons[by]
    const text = await drawLessons($, examples, drawn, by)
    // Drawn or not, the mistakes so far have had their turn: the next draw waits for new ones.
    await keepLessons($, scope, by, { text: text === '' ? (drawn?.text ?? '') : text, upTo: Math.max(...examples.map(x => x.at)) })
  } catch {
    // The judge keeps the rules it had, and its next mistake tries again.
  } finally {
    drawing.delete(`${scope}:${by}`)
  }
}

/**
 * Draws a judge's rules for a scope again once it has made mistakes enough since they were
 * last drawn: off a timer, so no prompt and no command waits on the model that draws them.
 */
async function drawIfDue($: EngineInterface, scope: Scope, by: Judging, examples: Example[]): Promise<void> {
  const key = `${scope}:${by}`
  if (drawing.has(key) || !isDue(examples, await lessonsAt($, await keyOf($, scope, `lessons:${by}`)), by)) return

  drawing.add(key)
  $.clock.after(ACT_MS, () => {
    void draw($, scope, by)
  })
}

/**
 * Keeps a label. One with no comparison yet is explained off a timer, so no prompt and no
 * command waits on Claude Haiku; one with a comparison may make its judge's rules due.
 */
async function teach($: EngineInterface, scope: Scope, example: Example): Promise<void> {
  const examples = await learn($, scope, example)
  if (example.comparison !== undefined) {
    await drawIfDue($, scope, example.judge, examples)

    return
  }
  $.clock.after(ACT_MS, () => {
    void explain($, scope, example)
  })
}

/**
 * What the judge is taught, and the bars its calls must clear: this project's labels and
 * rules first, then every project's, whichever judge is asked.
 */
async function teachingFor($: EngineInterface, by: Judging): Promise<{ teaching: Teaching; bars: Bars }> {
  try {
    const [here, everywhere, hereCalls, everywhereCalls, first] = await Promise.all([
      readScope($, 'local'),
      readScope($, 'user'),
      calibrationAt($, 'local', by),
      calibrationAt($, 'user', by),
      read($, anchor),
    ])

    return {
      teaching: {
        anchor: first,
        examples: pastCalls([here.examples, everywhere.examples], by),
        lessons: [everywhere.lessons[by]?.text ?? '', here.lessons[by]?.text ?? ''],
      },
      bars: barsFor([hereCalls, everywhereCalls], by),
    }
  } catch {
    // A store nobody can read teaches nothing; the judge still judges.
    return { teaching: UNTAUGHT, bars: barsFor([], by) }
  }
}

/**
 * What the mod did with the judge's verdict on a prompt, null when it never judged it, the
 * call itself with its reason and comparison, and what the person chose.
 */
type Heard = Call & { said: Verdict | null; choice: string; reason?: string; comparison?: string }

const UNHEARD: Heard = { said: null, choice: '' }

/** Asks the judge about a prompt worth judging, then the person about a verdict that would move it. */
async function hear($: EngineInterface, by: Judging, beats: Beat[], text: string): Promise<Heard> {
  if (!isWorthJudging(text, beats)) return UNHEARD

  const { teaching, bars } = await teachingFor($, by)
  const judgment = gate(await judgeWith($, by, beats, text, teaching), bars)
  const before = await read($, last)
  await update($, last, () => judgment)

  if (judgment.failure !== undefined) {
    // Once per failure, not once per prompt: a key that is refused is refused every time.
    if (judgment.failure !== before?.failure) {
      $.ui.toast(`${judgment.failure}. Prompts go through unjudged while it fails; ${WHILE_FAILING[by]}`)
    }

    return UNHEARD
  }

  await update($, judged, n => n + 1)
  const choice = judgment.verdict === 'same' ? '' : await askAbout($, judgment)

  return { ...callOf(judgment), ...explanationOf(judgment), said: judgment.verdict, choice }
}

/**
 * Keeps a judged prompt as the ruling `was` corrects and, when the person's answer to the
 * pop-up bore the verdict out or turned it down, as a label: with Claude Haiku's comparison
 * when it judged, else with the session, for Claude Haiku to explain. The answer is also
 * counted in its judge's tally.
 */
async function learnFromPrompt($: EngineInterface, by: Judging, text: string, beats: Beat[], heard: Heard): Promise<void> {
  const { said, choice, ...call } = heard
  if (said === null) return

  try {
    const into = await learning($)
    const outcome = outcomeOf(choice)
    const at = await $.clock.now()
    const prompt = promptOf(text)
    const session = sessionOf(beats, await read($, anchor))
    const scope = outcome === undefined || into === 'off' ? null : into
    await update($, ruling, () => ({ ...call, at, prompt, said, judge: by, session, scope }))
    if (outcome === undefined || said === 'same') return

    if (scope !== null) {
      const truth: Truth = outcome === 'confirmed' ? { is: said } : { not: said }
      await teach($, scope, {
        ...call,
        at,
        prompt,
        judge: by,
        said,
        truth,
        source: 'dialog',
        ...(call.comparison === undefined ? { session } : {}),
      })
    }
    if (call.sure !== undefined) await countAnswer($, scope, by, said, call.sure, outcome === 'confirmed')
  } catch {
    // A label nobody can keep costs a lesson, never the prompt.
  }
}

/** What the person chose, or `''` for a prompt that goes through untouched. */
async function decide($: EngineInterface, text: string, originKind: string | undefined): Promise<string> {
  if (sent !== null && squash(sent) === squash(text)) {
    sent = null

    return ''
  }

  // Only a prompt a person typed is judged: the engine calls a typed or queued one
  // `unclassified`, and a client's own box `composer`; everything else is machinery.
  if (originKind !== undefined && originKind !== 'unclassified' && originKind !== 'composer') return ''

  try {
    await use($).catch(() => undefined)
    const by = await read($, judge)
    if (by === 'off') return ''

    const beats = await read($, log)
    const heard = await hear($, by, beats, text)
    await learnFromPrompt($, by, text, beats, heard)

    return heard.choice
  } catch {
    // Watching a prompt must never cost the person the prompt.
    return ''
  }
}

/**
 * `/change-of-subject was`: relabels the last prompt a judge ruled on, in the scope named
 * or else where new labels go. A correction is kept even while labels are not. The label
 * it replaces gives up its comparison, so Claude Haiku is asked only when there is none.
 * A pop-up answer it turns around moves in the tally; a right call the bar held back
 * reopens the bar down to it. `was` is never counted otherwise: the person picks which
 * prompts to correct, so its labels are no fair sample of the judge.
 */
async function appeal($: EngineInterface, args: string): Promise<string> {
  const was = readWas(args)
  if (was === undefined) return USAGE

  const one = await read($, ruling)
  if (one === null) return NOTHING_RULED

  const { scope, session, ...seen } = one
  try {
    const into = was.scope ?? (await learning($))
    const kept = into === 'off' ? 'local' : into
    const before =
      scope === null ? undefined : (await readScope($, scope)).examples.find(x => x.at === one.at && x.prompt === one.prompt)
    if (scope !== null) await unlearn($, scope, seen)

    const explained = explanationOf({ reason: seen.reason ?? before?.reason, comparison: seen.comparison ?? before?.comparison })
    await teach($, kept, {
      ...seen,
      ...explained,
      truth: { is: was.label },
      source: 'was',
      ...(explained.comparison === undefined ? { session } : {}),
    })
    if (seen.pick !== undefined && seen.pick !== 'same' && seen.sure !== undefined) {
      const isRight = was.label === seen.pick
      const wasRight = before?.source === 'dialog' ? bearsOut(before.truth, seen.pick) : undefined
      if (scope !== null && wasRight !== undefined && wasRight !== isRight) {
        await recount($, scope, seen.judge, seen.pick, seen.sure, isRight)
      } else if (seen.said === 'same' && isRight) {
        await reopen($, kept, seen.judge, seen.pick, seen.sure)
      }
    }
    await update($, ruling, () => ({ ...one, scope: kept }))

    return `Noted for ${SCOPE_NAMES[kept]}: “${clip(one.prompt, QUOTED_CHARS)}” was **${was.label}**.`
  } catch (e) {
    return `The label could not be kept: ${messageOf(e)}`
  }
}

/** `/change-of-subject learn [user | local | off]`: where new labels go. */
async function steer($: EngineInterface, words: string[]): Promise<string> {
  const [where, ...rest] = words
  if (rest.length > 0 || (where !== undefined && where !== 'off' && scopeOf(where) === undefined)) return USAGE

  try {
    if (where === 'off' || where === 'user' || where === 'local') await learnInto($, where)

    return LEARNING[await learning($)]
  } catch (e) {
    return `Where labels go could not be changed: ${messageOf(e)}`
  }
}

/** `/change-of-subject lessons [user | local]`: what each scope has taught the judge in charge. */
async function lessons($: EngineInterface, words: string[]): Promise<string> {
  const [named, ...rest] = words
  const scope = scopeOf(named)
  if (rest.length > 0 || (named !== undefined && scope === undefined)) return USAGE

  try {
    const watching = await read($, judge)
    const by = watching === 'off' ? 'haiku' : watching
    const reports: string[] = []
    for (const s of scope === undefined ? (['local', 'user'] as const) : [scope]) {
      const kept = await readScope($, s)
      reports.push(scopeReport(SCOPE_TITLES[s], kept.examples, kept.lessons[by], await calibrationAt($, s, by), by))
    }

    return reports.join('\n\n')
  } catch (e) {
    return `The labels could not be read: ${messageOf(e)}`
  }
}

/** `/change-of-subject promote`: this project's labels, copied to every project's. */
async function promoted($: EngineInterface): Promise<string> {
  try {
    const { copied, examples } = await promote($)
    for (const by of JUDGES) await drawIfDue($, 'user', by, examples)

    return `Copied ${copied} label${copied === 1 ? '' : 's'} from this project to every project's.`
  } catch (e) {
    return `The labels could not be copied: ${messageOf(e)}`
  }
}

/** `/change-of-subject forget <user | local>`: a scope's labels and rules, gone. */
async function forgotten($: EngineInterface, words: string[]): Promise<string> {
  const scope = scopeOf(words[0])
  if (scope === undefined || words.length > 1) return USAGE

  try {
    await forget($, scope)
    await update($, ruling, r => (r === null || r.scope !== scope ? r : { ...r, scope: null }))

    return `Forgot every label and rule kept for ${SCOPE_NAMES[scope]}.`
  } catch (e) {
    return `The labels could not be forgotten: ${messageOf(e)}`
  }
}

// Labels: kept here, not in their own module, for compatibility with 2.1.295.
// Claude Code 2.1.295 follows `$` only into functions declared in this file, never across an import,
// and these take `$`.

/** What a scope keeps: its labels, and each judge's rules drawn from them and tally of its answered calls. */
type Kind = 'examples' | `lessons:${Judging}` | `calls:${Judging}`

/** A scope's labels and each judge's rules, as the store holds them. */
type Kept = { examples: Example[]; lessons: Partial<Record<Judging, Lessons>> }

type Bytes = Partial<Record<Kind, number>>

/** `at` is when a project was last used: eviction lets go of the oldest first. */
type Sizes = { user: Bytes; projects: Record<string, { at: number; bytes: Bytes }> }

/** Where new labels go, by the person's say: this project's, unless they said otherwise. */
const LEARNING_KEY = 'learn'
/** Every write records its key's size here, so a start reads this one key, not every label. */
const SIZES_KEY = 'sizes'
// Half the store's 4 MiB, so the scopes in use can still grow before the next start trims them.
const BUDGET_BYTES = 2 * 1024 * 1024

const SCOPES: readonly Scope[] = ['local', 'user']
const KINDS: readonly Kind[] = ['examples', ...JUDGES.flatMap((by): Kind[] => [`lessons:${by}`, `calls:${by}`])]
// A long session judges without writing; it is still a project in use, never the one evicted.
const USE_MS = 60 * 60 * 1000

const localKey = (root: string, kind: Kind): string => `local:${root}:${kind}`

const bytesIn = (bytes: Bytes): number => Object.values(bytes).reduce<number>((t, n) => t + (n ?? 0), 0)

/** `bytes` with `kind` at `n`, or without `kind` once it holds nothing. */
function sized(bytes: Bytes, kind: Kind, n: number): Bytes {
  const next = { ...bytes }
  if (n === 0) delete next[kind]
  else next[kind] = n

  return next
}

/** The store write under way. A write that reads first waits for it: two at once would each write back what the other never saw. */
let writing: Promise<unknown> = Promise.resolve()

/** Runs `work` once every write before it is done. Only the outermost write takes a turn: one inside another would wait on itself. */
function serially<T>(work: () => Promise<T>): Promise<T> {
  const turn = writing.then(work, work)
  writing = turn.catch(() => undefined)

  return turn
}

/**
 * Where a scope's labels and rules live in the plugin's own store, under the user's Claude
 * Code directory. A project's are keyed by its root, as Claude Code keeps a local-scope MCP
 * server: per person and per project, and never in the working tree, where they could be
 * committed.
 */
async function keyOf($: EngineInterface, scope: Scope, kind: Kind): Promise<string> {
  return scope === 'user' ? `user:${kind}` : localKey(await $.session.root(), kind)
}

async function examplesAt($: EngineInterface, key: string): Promise<Example[]> {
  const kept = await $.store.get(key)

  return Array.isArray(kept) ? (kept as Example[]) : []
}

async function lessonsAt($: EngineInterface, key: string): Promise<Lessons | undefined> {
  const kept = (await $.store.get(key)) as Partial<Lessons> | undefined

  return typeof kept?.text === 'string' && typeof kept.upTo === 'number' ? { text: kept.text, upTo: kept.upTo } : undefined
}

async function calibrationAt($: EngineInterface, scope: Scope, by: Judging): Promise<Calibration> {
  const kept = await $.store.get(await keyOf($, scope, `calls:${by}`))

  return typeof kept === 'object' && kept !== null && !Array.isArray(kept) ? (kept as Calibration) : {}
}

async function readScope($: EngineInterface, scope: Scope): Promise<Kept> {
  const [examples, drawn] = await Promise.all([
    keyOf($, scope, 'examples').then(key => examplesAt($, key)),
    Promise.all(JUDGES.map(by => keyOf($, scope, `lessons:${by}`).then(key => lessonsAt($, key)))),
  ])
  const lessons: Partial<Record<Judging, Lessons>> = {}
  JUDGES.forEach((by, i) => {
    const one = drawn[i]
    if (one !== undefined) lessons[by] = one
  })

  return { examples, lessons }
}

async function readSizes($: EngineInterface): Promise<Sizes> {
  const kept = (await $.store.get(SIZES_KEY)) as Partial<Sizes> | undefined

  return { user: kept?.user ?? {}, projects: kept?.projects ?? {} }
}

/**
 * Records how large one of a scope's keys is now, and that a project written to is in use.
 * A size that cannot be recorded leaves the record behind, never the label.
 */
async function measure($: EngineInterface, scope: Scope, kind: Kind, bytes: number): Promise<void> {
  try {
    const sizes = await readSizes($)
    if (scope === 'user') {
      sizes.user = sized(sizes.user, kind, bytes)
    } else {
      const root = await $.session.root()
      sizes.projects[root] = { at: await $.clock.now(), bytes: sized(sizes.projects[root]?.bytes ?? {}, kind, bytes) }
    }
    await $.store.set(SIZES_KEY, sizes)
  } catch {
    // The record catches up at the scope's next write.
  }
}

/** Every label write goes through `put` or `drop`, so a start reads `sizes` alone, never every label. */
async function put($: EngineInterface, scope: Scope, kind: Kind, value: unknown): Promise<void> {
  await $.store.set(await keyOf($, scope, kind), value)
  await measure($, scope, kind, sizeOf(value))
}

async function drop($: EngineInterface, scope: Scope, kind: Kind): Promise<void> {
  await $.store.delete(await keyOf($, scope, kind))
  await measure($, scope, kind, 0)
}

/** Keeps a label in `scope`, trimming the scope to its limit; resolves with what the scope keeps now. */
function learn($: EngineInterface, scope: Scope, example: Example): Promise<Example[]> {
  return serially(async () => {
    const examples = keep([...(await examplesAt($, await keyOf($, scope, 'examples'))), example], LIMITS[scope])
    await put($, scope, 'examples', examples)

    return examples
  })
}

const isOne = (x: Example, one: Pick<Example, 'at' | 'prompt'>): boolean => x.at === one.at && x.prompt === one.prompt

/** Drops the label `scope` keeps for one prompt, named by when it was typed and what it said. */
function unlearn($: EngineInterface, scope: Scope, one: Pick<Example, 'at' | 'prompt'>): Promise<void> {
  return serially(async () => {
    await put($, scope, 'examples', (await examplesAt($, await keyOf($, scope, 'examples'))).filter(x => !isOne(x, one)))
  })
}

/** Rewrites the label `scope` keeps for one prompt; resolves with what the scope keeps now. */
function relearn(
  $: EngineInterface,
  scope: Scope,
  one: Pick<Example, 'at' | 'prompt'>,
  change: (x: Example) => Example,
): Promise<Example[]> {
  return serially(async () => {
    const examples = (await examplesAt($, await keyOf($, scope, 'examples'))).map(x => (isOne(x, one) ? change(x) : x))
    await put($, scope, 'examples', examples)

    return examples
  })
}

function keepLessons($: EngineInterface, scope: Scope, by: Judging, lessons: Lessons): Promise<void> {
  return serially(() => put($, scope, `lessons:${by}`, lessons))
}

/** Forgets a scope's labels, and every judge's rules and tally. */
function forget($: EngineInterface, scope: Scope): Promise<void> {
  return serially(async () => {
    await drop($, scope, 'examples')
    for (const by of JUDGES) {
      await drop($, scope, `lessons:${by}`)
      await drop($, scope, `calls:${by}`)
    }
  })
}

/** Copies this project's labels to every project's, leaving out any already there; resolves with how many. Tallies stay where they are. */
function promote($: EngineInterface): Promise<{ copied: number; examples: Example[] }> {
  return serially(async () => {
    const everyone = await examplesAt($, await keyOf($, 'user', 'examples'))
    const fresh = (await readScope($, 'local')).examples.filter(x => !everyone.some(o => isOne(o, x)))
    const examples = keep([...everyone, ...fresh].sort((a, b) => a.at - b.at), LIMITS.user)
    await put($, 'user', 'examples', examples)

    return { copied: fresh.length, examples }
  })
}

/** Counts a pop-up answer in the tally of the scope its label is kept in, and against any range `was` reopened, in either scope. */
function countAnswer($: EngineInterface, kept: Scope | null, by: Judging, verdict: Interrupting, sure: number, isRight: boolean): Promise<void> {
  return serially(async () => {
    for (const scope of SCOPES) {
      const before = await calibrationAt($, scope, by)
      const after = answeredIn(before, verdict, sure, isRight, scope === kept)
      if (after !== before) await put($, scope, `calls:${by}`, after)
    }
  })
}

/** Moves a pop-up answer `was` turned around to the other count of its tally. */
function recount($: EngineInterface, scope: Scope, by: Judging, verdict: Interrupting, sure: number, isRight: boolean): Promise<void> {
  return serially(async () => {
    await put($, scope, `calls:${by}`, recountedIn(await calibrationAt($, scope, by), verdict, sure, isRight))
  })
}

/** Reopens the bar down to a right call it held back, in the scope the correction is kept in. */
function reopen($: EngineInterface, scope: Scope, by: Judging, verdict: Interrupting, sure: number): Promise<void> {
  return serially(async () => {
    const here = await calibrationAt($, 'local', by)
    const everywhere = await calibrationAt($, 'user', by)
    const before = scope === 'local' ? here : everywhere
    const after = reopenedIn(before, verdict, sure, barsFor([here, everywhere], by)[verdict])
    if (after !== before) await put($, scope, `calls:${by}`, after)
  })
}

async function learning($: EngineInterface): Promise<Learning> {
  const said = await $.store.get(LEARNING_KEY)

  return said === 'user' || said === 'off' ? said : 'local'
}

async function learnInto($: EngineInterface, where: Learning): Promise<void> {
  await $.store.set(LEARNING_KEY, where)
}

let usedAt = -Infinity

async function use($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - usedAt < USE_MS) return

  usedAt = now
  await serially(async () => {
    const sizes = await readSizes($)
    const here = await $.session.root()
    sizes.projects[here] = { at: now, bytes: sizes.projects[here]?.bytes ?? {} }
    await $.store.set(SIZES_KEY, sizes)
  })
}

/**
 * Marks this project in use and, while every scope's labels, rules and tallies together pass
 * `BUDGET_BYTES`, lets go of those of the projects used longest ago, never this one's: the
 * store is one file of at most 4 MiB for them all. A project with nothing kept leaves the
 * record. Every kind is deleted, recorded or not, so no key outlives its record.
 */
function visit($: EngineInterface): Promise<void> {
  return serially(async () => {
    const now = await $.clock.now()
    usedAt = now
    const here = await $.session.root()
    const sizes = await readSizes($)
    sizes.projects[here] = { at: now, bytes: sizes.projects[here]?.bytes ?? {} }

    let stored = Object.values(sizes.projects).reduce((t, p) => t + bytesIn(p.bytes), bytesIn(sizes.user))
    const others = Object.entries(sizes.projects)
      .filter(([root]) => root !== here)
      .sort(([, a], [, b]) => a.at - b.at)
    for (const [root, { bytes }] of others) {
      const size = bytesIn(bytes)
      if (size > 0 && stored <= BUDGET_BYTES) continue

      for (const kind of KINDS) await $.store.delete(localKey(root, kind))
      delete sizes.projects[root]
      stored -= size
    }

    await $.store.set(SIZES_KEY, sizes)
  })
}

// Judges: kept here, not in their own module, for compatibility with 2.1.295 (see Labels above).

// One cheap request per prompt worth judging; a judge that does not answer in time lets the prompt through.
const JUDGE_TIMEOUT_MS = 15_000
// A word, a number and a dozen words of reason, then a sentence of comparison for `aside` or `phase`.
const JUDGE_TOKENS = 120
// Explaining a verdict runs off a timer, never while a prompt waits, and only for a label.
const EXPLAIN_TIMEOUT_MS = 30_000
const EXPLAIN_TOKENS = 160
// Jev answers in well under a second. Its wait is a race on a timer, so it stays inside the
// hook's 10s budget however the engine counts that wait.
const JEV_TIMEOUT_MS = 5_000
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
// Drawing the rules runs off a timer, never while a prompt waits, and only every few corrections.
const LESSONS_TIMEOUT_MS = 60_000
const LESSONS_TOKENS = 800

async function judgeWithHaiku($: EngineInterface, beats: Beat[], text: string, t: Teaching): Promise<Judgment> {
  const { system, prompt } = haikuRequest(beats, text, t)
  let r: ModelCompleteResult
  try {
    r = await $.model.complete({
      model: 'haiku',
      system,
      prompt,
      maxTokens: JUDGE_TOKENS,
      effort: 'low',
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
  } catch (e) {
    return failed(`Claude Haiku could not be asked: ${messageOf(e)}`)
  }

  if (r.isAnswered) return readVerdict(r.text)
  if (r.reason === 'api-error') {
    return failed(`Claude Haiku's request failed: ${r.status === null ? 'no response' : `HTTP ${r.status}`} (${r.error})`)
  }

  return failed(
    r.reason === 'empty-reply'
      ? 'Claude Haiku answered with nothing'
      : `Claude Haiku did not answer within ${JUDGE_TIMEOUT_MS / 1000}s`,
  )
}

// An empty `TYPESAFE_API_KEY` would be sent as `Bearer ` and refused like a bad key; it is no key at all.
const isKey = (key: string | undefined): key is string => key !== undefined && key.trim() !== ''

async function judgeWithJev($: EngineInterface, beats: Beat[], text: string, t: Teaching): Promise<Judgment> {
  const key = await $.env.get('TYPESAFE_API_KEY')
  if (!isKey(key)) return failed('Jev has no key: `TYPESAFE_API_KEY` is unset or empty where Claude Code started')

  const call = $.http
    .fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: jevRequest(beats, text, t),
    })
    .catch((e: unknown) => failed(`Jev could not be reached: ${messageOf(e)}`))
  // $.http.fetch takes no timeout or signal, so the judge stops waiting instead.
  const late = new Promise<Judgment>(resolve =>
    $.clock.after(JEV_TIMEOUT_MS, () => resolve(failed(`Jev did not answer within ${JEV_TIMEOUT_MS / 1000}s`))),
  )
  const r = await Promise.race([call, late])
  if ('verdict' in r) return r

  return r.ok ? readJev(r.text) : failed(jevRefused(r.status, r.text))
}

/**
 * Asks the judge `/change-of-subject` named, taught what the person's labels say. A call,
 * not a table of judges: the engine holds `$` to being spelled at each call site, never
 * read out of a value.
 */
function judgeWith(
  $: EngineInterface,
  by: Exclude<Judge, 'off'>,
  beats: Beat[],
  text: string,
  t: Teaching,
): Promise<Judgment> {
  return by === 'jev' ? judgeWithJev($, beats, text, t) : judgeWithHaiku($, beats, text, t)
}

/**
 * Has Claude Haiku say why a verdict was given and how the prompt compared with its
 * session, whichever judge gave the verdict: the teaching is in its words either way.
 * `medium`: a few requests a session, and every later judgment reads what they write.
 * Resolves undefined when it gave no comparison or could not be asked.
 */
async function explainVerdict(
  $: EngineInterface,
  session: Beat[],
  prompt: string,
  verdict: Verdict,
): Promise<{ reason: string; comparison: string } | undefined> {
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: EXPLAIN_SYSTEM,
      prompt: explainBrief(session, prompt, verdict),
      maxTokens: EXPLAIN_TOKENS,
      effort: 'medium',
      timeoutMs: EXPLAIN_TIMEOUT_MS,
    })

    return r.isAnswered ? readExplanation(r.text) : undefined
  } catch {
    return undefined
  }
}

/**
 * Draws one judge's rules for a scope again from its labels, with Claude Sonnet: a rare
 * call, and one whose rules every later judgment reads, so it runs at Sonnet's own
 * `high`. Resolves with the rules, or empty when the model gave none or could not be asked.
 */
async function drawLessons(
  $: EngineInterface,
  examples: Example[],
  lessons: Lessons | undefined,
  by: Exclude<Judge, 'off'>,
): Promise<string> {
  try {
    const r = await $.model.complete({
      model: 'sonnet',
      system: LESSONS_SYSTEM,
      prompt: lessonsBrief(examples, lessons, by),
      maxTokens: LESSONS_TOKENS,
      effort: 'high',
      timeoutMs: LESSONS_TIMEOUT_MS,
    })

    return r.isAnswered ? readLessons(r.text) : ''
  } catch {
    return ''
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'change-of-subject',
      description: 'Whether prompts are being judged against the session, and what the last verdict was',
      argumentHint: '[on|off|haiku|jev|was|learn|lessons|promote|forget]',
      immediate: true,
    })

    // A prompt held back for a new session arrives here, in the session it asked for.
    const text = takeHeld()
    if (text !== null) {
      $.clock.after(ACT_MS, () => {
        void send($, text)
      })
    }

    try {
      await visit($)
    } catch {
      // The store is trimmed at the next start instead.
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      sent = null
      touched.clear()
      await update($, log, () => EMPTY)
      await update($, anchor, () => null)
      await update($, last, () => null)
      await update($, judged, () => 0)
      await update($, ruling, () => null)
    }

    return next(e)
  })

  on('command.run', { command: 'change-of-subject' }, async ($, e) => {
    const arg = squash(e.args).toLowerCase()
    const [word = '', ...words] = arg.split(' ')

    if (word === 'was') return { text: await appeal($, arg) }
    if (word === 'learn') return { text: await steer($, words) }
    if (word === 'lessons') return { text: await lessons($, words) }
    if (word === 'promote') return { text: words.length === 0 ? await promoted($) : USAGE }
    if (word === 'forget') return { text: await forgotten($, words) }

    const want = arg === 'on' ? 'haiku' : arg

    if (want === 'off' || want === 'haiku' || want === 'jev') {
      if (want === 'jev' && !isKey(await $.env.get('TYPESAFE_API_KEY'))) return { text: NO_KEY }
      await update($, judge, () => want)

      return { text: SAID[want] }
    }

    if (arg !== '') return { text: USAGE }

    return {
      text: report(await read($, judge), await read($, judged), await read($, last), await read($, log)),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const choice = await decide($, e.text, e.origin?.kind)

    if (choice === USE_BTW) {
      act($, 'btw', e.text, { text: e.text, when: 'if-it-fails' })

      return { drop: 'asked as a side question instead (/btw)' }
    }

    if (choice === NEW_SESSION) {
      act($, 'clear', '', { text: e.text, when: 'after' })

      return { drop: 'held back for a new session (/clear), then sent again' }
    }

    if (choice === COMPACT_FIRST) {
      act($, 'compact', '', { text: e.text, when: 'after' })

      return { drop: 'held back while the session compacts (/compact), then sent again' }
    }

    await note($, 'you', e.text)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The files Claude changes say what the work is about more plainly than its answers do.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    touched.add(e.file_path)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    touched.add(e.file_path)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Only the main loop: a subagent's answer is not what the session is about.
    if (e.agentId === undefined) {
      const files = [...touched]
      touched.clear()
      await note($, 'claude', e.answer, files)
    }

    return next(e)
  })
}
