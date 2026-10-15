import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Beat, Call, Example, Judge, Judgement, Learning, Scope, Teaching, Truth, Verdict } from '../types'
import { drawLessons, explainVerdict, judgeWith } from './judges'
import { forget, keepLessons, learn, learnInto, learning, promote, readScope, relearn, unlearn, visit } from './labels'
import {
  ASIDE_HEADER,
  ASIDE_QUESTION,
  BEATS,
  CARRY_ON_HERE,
  COMPACT_FIRST,
  EMPTY,
  NEW_SESSION,
  NOT_ASIDE,
  NOT_PHASE,
  PHASE_HEADER,
  PHASE_QUESTION,
  USE_BTW,
  beatOf,
  callOf,
  clip,
  explanationOf,
  hasSubject,
  isWorthJudging,
  messageOf,
  outcomeOf,
  promptOf,
  readWas,
  remember,
  report,
  scopeOf,
  sessionOf,
  squash,
} from './model'
import { UNTAUGHT, barsFor, gate, isDue, pastCalls, scopeReport } from './teach'
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
const NO_KEY = 'Jev needs `TYPESAFE_API_KEY` set where Claude Code started. The judge is unchanged.'
const NOTHING_RULED = 'Nothing judged yet in this session, so nothing to correct.'
/** What `/change-of-subject` answers on switching to each judge. */
const SAID: Record<Judge, string> = {
  off: 'Not watching prompts any more. `/change-of-subject on` starts again.',
  haiku: 'Watching every prompt, judged by Claude Haiku.',
  jev: `Watching every prompt, judged by Jev. Warning: each prompt judged, with the last ${BEATS} lines of the session, a few past calls from this project and the rules drawn from your labels, goes to TypeSafe AI (api.typesafe.ai).`,
}
/** What the toast for a failing judge suggests doing about it. */
const WHILE_FAILING: Record<Judging, string> = {
  haiku: '`/change-of-subject off` stops the judging.',
  jev: '`/change-of-subject haiku` switches to Claude Haiku.',
}
/** How the commands name each scope. */
const SCOPE_NAMES: Record<Scope, string> = { local: 'this project', user: 'every project' }
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

async function askAbout($: EngineInterface, j: Judgement): Promise<string> {
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
  if (drawing.has(key) || !isDue(examples, (await readScope($, scope)).lessons[by], by)) return

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
 * rules first, then every project's. Jev is shown past calls from this project only:
 * everything it is shown goes to TypeSafe, and another project's prompts have no business
 * there.
 */
async function teachingFor($: EngineInterface, by: Judging): Promise<{ teaching: Teaching; bars: Bars }> {
  try {
    const here = await readScope($, 'local')
    const everywhere = await readScope($, 'user')

    return {
      teaching: {
        anchor: await read($, anchor),
        examples: pastCalls(by === 'jev' ? [here.examples] : [here.examples, everywhere.examples], by),
        lessons: [everywhere.lessons[by]?.text ?? '', here.lessons[by]?.text ?? ''],
      },
      bars: barsFor([here.examples, everywhere.examples], by),
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
  const judgement = gate(await judgeWith($, by, beats, text, teaching), bars)
  const before = await read($, last)
  await update($, last, () => judgement)

  if (judgement.failure !== undefined) {
    // Once per failure, not once per prompt: a key that is refused is refused every time.
    if (judgement.failure !== before?.failure) {
      $.ui.toast(`${judgement.failure}. Prompts go through unjudged while it fails; ${WHILE_FAILING[by]}`)
    }

    return UNHEARD
  }

  await update($, judged, n => n + 1)
  const choice = judgement.verdict === 'same' ? '' : await askAbout($, judgement)

  return { ...callOf(judgement), ...explanationOf(judgement), said: judgement.verdict, choice }
}

/**
 * Keeps a judged prompt as the ruling `was` corrects and, when the person's answer to the
 * pop-up bore the verdict out or turned it down, as a label: with Claude Haiku's comparison
 * when it judged, else with the session, for Claude Haiku to explain.
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
    if (outcome === undefined || scope === null) return

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
      const name = SCOPE_NAMES[s]
      reports.push(scopeReport(`${name[0]?.toUpperCase()}${name.slice(1)}`, kept.examples, kept.lessons[by], by))
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
      // Labels of a project long left stay a while longer.
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
      if (want === 'jev' && (await $.env.get('TYPESAFE_API_KEY')) === undefined) return { text: NO_KEY }
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
