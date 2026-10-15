import type { Beat, Call, Example, Judge, Judgement, Scope, Truth, Verdict, Who } from '../types'

/** The session record starts empty. */
export const EMPTY: Beat[] = []

/** How many lines of the session the judge is shown. */
export const BEATS = 12

const YOU_CHARS = 400
const CLAUDE_CHARS = 240
const REASON_CHARS = 90
const COMPARISON_CHARS = 280

/**
 * Prompts that carry no subject of their own. An answer, a nudge or a retry
 * continues whatever ran before it, so there is nothing to judge and no
 * request to spend.
 */
const CARRY_ON =
  /^(?:y|n|k|ok|okay|yes|ya|yeah|yep|yup|no|nope|nah|sure|go|go on|go ahead|continue|carry on|keep going|next|more|again|retry|redo|undo|revert|stop|wait|hold on|please|thanks|thank you|ty|do it|do that|fix it|fix them|try again|done|good|great|nice|perfect|right|correct|wrong|huh|really|hm+|why|how|what|where|when|who|yes please|no thanks)[\s.!?]*$/i

/**
 * Lines the composer takes as an instruction to itself rather than as something to say:
 * a slash command, a `#` memory line, a `!` shell line. A command and a memory line both
 * reach this hook as typed, so judging one risks spending the command the person meant to
 * run; a shell line does not reach it from the terminal, and is named here for a surface
 * where it might.
 */
const COMPOSER_LINE = /^[/#!]/

/** What each verdict means, taught to either judge in the same words and in this order. */
export const MEANINGS: Record<Verdict, string> = {
  same: 'it carries on the work the session is already doing: a follow-up, a correction, a retry, an answer to a question, or the next step of the same task.',
  aside: 'it is about something else: another subject, another project, or a stray question that does not touch the work.',
  phase: 'it belongs to the same work but starts a new direction or phase in it: another task on the same code, or a move from one stage to the next.',
}

export const VERDICTS = Object.keys(MEANINGS) as Verdict[]

/** What an answer nobody can read comes to: it is no reason to interrupt. */
export const NO_VERDICT: Judgement = { verdict: 'same', reason: '' }

/** A judge that gave no answer, and why: the prompt goes through unjudged. */
export const failed = (failure: string): Judgement => ({ ...NO_VERDICT, failure })

/** The judge's own call, with only the parts it gave: what is kept holds no `undefined`. */
export const callOf = (j: Call): Call => ({
  ...(j.pick === undefined ? {} : { pick: j.pick }),
  ...(j.sure === undefined ? {} : { sure: j.sure }),
})

type Explanation = { reason?: string; comparison?: string }

/** A reason and a comparison, with only the parts given: what is kept holds no `undefined` or empty text. */
export const explanationOf = (j: Explanation): Explanation => ({
  ...(j.reason === undefined || j.reason === '' ? {} : { reason: j.reason }),
  ...(j.comparison === undefined || j.comparison === '' ? {} : { comparison: j.comparison }),
})

/** How many files a line of Claude's names as changed, and the room they get. */
const FILES_NAMED = 5
const FILES_CHARS = 120

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A prompt as the judge is shown it. */
export const promptOf = (text: string): string => clip(squash(text), YOU_CHARS)

/** A reason as it is kept: a few words, with no label before them and no full stop after. */
export const reasonOf = (text: string): string =>
  clip(squash(text).replace(/^reason\s*:\s*/i, '').replace(/^[\s:.;,–—-]+/, '').replace(/[.]+$/, ''), REASON_CHARS)

/** A comparison as it is kept: one sentence, with no label before it. */
export const comparisonOf = (text: string): string =>
  clip(squash(text).replace(/^comparison\s*:\s*/i, ''), COMPARISON_CHARS)

/** A file by its folder and name: enough to say what part of the work it is. */
const shortPath = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

/**
 * The files Claude changed in a turn, as a line of its names them. They say what the
 * work is about more plainly than the opening of an answer does.
 */
function changed(files: readonly string[]): string {
  const names = [...new Set(files.map(shortPath))]
  if (names.length === 0) return ''

  const more = names.length > FILES_NAMED ? ` and ${names.length - FILES_NAMED} more` : ''

  return ` [changed: ${clip(names.slice(0, FILES_NAMED).join(', '), FILES_CHARS)}${more}]`
}

/** One line of the session, trimmed to what the judge needs of it, with the files Claude changed. */
export const beatOf = (who: Who, text: string, files: readonly string[] = []): Beat => ({
  who,
  text: who === 'you' ? clip(squash(text), YOU_CHARS) : `${clip(squash(text), CLAUDE_CHARS)}${changed(files)}`.trim(),
})

/** Adds a line to the record, keeping the last `BEATS`. An empty line is nothing to remember. */
export const remember = (log: Beat[], line: Beat): Beat[] => (line.text === '' ? log : [...log, line].slice(-BEATS))

export const lastAsked = (log: Beat[]): string | undefined => log.filter(b => b.who === 'you').pop()?.text

/** A record's lines as the judge reads them. */
export const linesOf = (log: Beat[]): string[] => log.map(b => `[${b.who === 'you' ? 'person' : 'claude'}] ${b.text}`)

/** Whether a prompt carries a subject of its own: a line meant for the composer and a bare answer or nudge do not. */
export function hasSubject(text: string): boolean {
  const asked = squash(text)

  return asked.length >= 3 && !COMPOSER_LINE.test(asked) && !CARRY_ON.test(asked)
}

/**
 * Whether a prompt is worth a judgement. The first prompt of a session has
 * nothing to be unrelated to, a line meant for the composer is no prompt at all,
 * a bare answer or nudge carries no subject, and a prompt typed again is a retry
 * of the one before it.
 */
export function isWorthJudging(text: string, log: Beat[]): boolean {
  const before = lastAsked(log)

  return hasSubject(text) && before !== undefined && before !== squash(text)
}

/**
 * The session and the new prompt, as material for the judge, opening with the session's
 * first prompt once its record has let go of it. All of it is data, never instructions.
 */
export function briefing(log: Beat[], text: string, anchor: Beat | null = null): string {
  const isKept = anchor === null || log.some(b => b.who === anchor.who && b.text === anchor.text)

  return [
    ...(isKept ? [] : ['The session began with:', '<start>', ...linesOf([anchor]), '</start>']),
    'The session so far, oldest line first:',
    '<session>',
    ...linesOf(log),
    '</session>',
    'The prompt the person has just typed:',
    '<prompt>',
    promptOf(text),
    '</prompt>',
  ].join('\n')
}

/** The session as the judge saw it: its last lines, opening with its first prompt once they have let go of it. */
export function sessionOf(log: Beat[], anchor: Beat | null): Beat[] {
  const isKept = anchor === null || log.some(b => b.who === anchor.who && b.text === anchor.text)

  return isKept ? log : [anchor, ...log]
}

/**
 * The judge's one word, how sure of it it was, and its few words of reason, on its first
 * line; on a second, for `aside` or `phase`, a sentence comparing the prompt with the
 * session. Anything unreadable is taken as `same`; a judgement without a number in it is
 * not gated.
 */
export function readVerdict(answer: string): Judgement {
  const [first = '', ...rest] = answer.trim().split(/\r?\n/)
  const said = squash(first)
  const verdict = VERDICTS.find(v => said.toLowerCase().startsWith(v))

  if (verdict === undefined) return NO_VERDICT

  const after = said.slice(verdict.length)
  const number = /^\s*(\d{1,3})\s*%?/.exec(after)
  const sure = number === null ? NaN : Number(number[1]) / 100
  const comparison = verdict === 'same' ? '' : comparisonOf(rest.join(' '))

  return {
    verdict,
    reason: reasonOf(after.slice(number?.[0].length ?? 0)),
    pick: verdict,
    ...(sure <= 1 ? { sure } : {}),
    ...(comparison === '' ? {} : { comparison }),
  }
}

type JevAnswer = { choice?: unknown; probabilities?: Record<string, unknown> }

/**
 * Jev's pick and how sure it was. Jev answers in a fixed shape, so a body without a
 * verdict in it is a failure.
 */
export function readJev(body: string): Judgement {
  let answer: JevAnswer | undefined
  try {
    answer = (JSON.parse(body) as { answers?: { belongs?: JevAnswer } }).answers?.belongs
  } catch {
    answer = undefined
  }

  const choice = typeof answer?.choice === 'string' ? answer.choice : ''
  const verdict = VERDICTS.find(v => v === choice)
  if (verdict === undefined) return failed("Jev's answer could not be read")

  const p = answer?.probabilities?.[choice]

  return { verdict, reason: '', pick: verdict, sure: typeof p === 'number' ? p : 0 }
}

/** Why Jev refused a request: its status, and the kind of error its body names, when it names one. */
export function jevRefused(status: number, body: string): string {
  let kind: unknown
  try {
    kind = (JSON.parse(body) as { detail?: { error_type?: unknown } }).detail?.error_type
  } catch {
    kind = undefined
  }

  return `Jev refused the request: HTTP ${status}${typeof kind === 'string' ? ` (${kind})` : ''}`
}

/** The headers the dialogs carry. The engine takes at most 12 characters. */
export const ASIDE_HEADER = 'Side trip'
export const PHASE_HEADER = 'New phase'

/** The answers the dialogs offer. The engine takes at most four of them. */
export const USE_BTW = 'Ask with /btw'
export const NEW_SESSION = 'New session'
export const COMPACT_FIRST = 'Compact first'
export const CARRY_ON_HERE = 'Continue here'
/** "Continue here", and the judge was wrong: the answers that turn the verdict down. */
export const NOT_ASIDE = 'Not a side trip'
export const NOT_PHASE = 'Not a new phase'

/**
 * What a pop-up's answer says of the judge's verdict: that it was right, or that it was
 * not. `Continue here` says neither: the person may agree with the judge and still want
 * the prompt here. Nor does a dismissed pop-up.
 */
export function outcomeOf(choice: string): 'confirmed' | 'denied' | undefined {
  if (choice === USE_BTW || choice === NEW_SESSION || choice === COMPACT_FIRST) return 'confirmed'
  if (choice === NOT_ASIDE || choice === NOT_PHASE) return 'denied'

  return undefined
}

/**
 * Whether the person's word bears a verdict out: undefined when it cannot say, as when they
 * turned one verdict down and the question is another.
 */
export function bearsOut(truth: Truth, verdict: Verdict): boolean | undefined {
  if ('is' in truth) return truth.is === verdict

  return truth.not === verdict ? false : undefined
}

/** Whether the verdict the mod acted on was wrong: the judge's own mistake, which teaches it most. */
export const isMistake = (x: Example): boolean => bearsOut(x.truth, x.said) === false

/** The verdict a label speaks of: the one the person gave, or the one they turned down. */
export const spokenOf = (truth: Truth): Verdict => ('is' in truth ? truth.is : truth.not)

/** The most labels each scope keeps. */
export const LIMITS: Record<Scope, number> = { user: 500, local: 100 }

const SCOPES = Object.keys(LIMITS) as Scope[]

/**
 * Trims a scope's labels, oldest first, to `cap`. One that bears the judge out goes before
 * any mistake: a mistake is what the judge has most to learn from.
 */
export function keep(examples: Example[], cap: number): Example[] {
  const over = examples.length - cap
  if (over <= 0) return examples

  const agreeing = examples.filter(x => !isMistake(x)).slice(0, over)
  const left = examples.filter(x => !agreeing.includes(x))

  return left.slice(left.length - cap)
}

/** A scope by its word, or undefined for any other word. */
export const scopeOf = (word: string | undefined): Scope | undefined => SCOPES.find(s => s === word)

/**
 * `was <same|aside|phase> [user|local]`: the verdict a prompt should have had, and where
 * to keep it, when the person named a scope.
 */
export function readWas(args: string): { label: Verdict; scope?: Scope } | undefined {
  const [word, label, scope, ...rest] = squash(args).toLowerCase().split(' ')
  const verdict = VERDICTS.find(v => v === label)
  const where = scopeOf(scope)

  if (word !== 'was' || verdict === undefined || (scope !== undefined && where === undefined) || rest.length > 0) return undefined

  return where === undefined ? { label: verdict } : { label: verdict, scope: where }
}

/**
 * What the dialogs ask. Neither says what the judge made of the prompt: the person can see
 * their own prompt and the session it landed in, and the few words of reason belong in
 * `/change-of-subject`, where they are there to be asked for rather than in the way.
 */
export const ASIDE_QUESTION = 'This prompt looks unrelated to what this session is about. Ask it as a side question instead?'
export const PHASE_QUESTION = 'This prompt starts a new direction in this session. Where should it run?'

const because = (reason: string): string => (reason === '' ? '' : `: ${reason}`)

export const percent = (sure: number): string => `${Math.round(sure * 100)}%`

/** How sure the judge was, and of what when that is not the verdict the mod acted on. */
function howSure(j: Judgement): string {
  if (j.sure === undefined) return ''

  return j.pick !== undefined && j.pick !== j.verdict ? ` (${percent(j.sure)} sure of ${j.pick})` : ` (${percent(j.sure)} sure)`
}

/** What `/change-of-subject` prints. */
export function report(judge: Judge, judged: number, last: Judgement | null, log: Beat[]): string {
  const watch =
    judge === 'off'
      ? 'Not watching. `/change-of-subject on` starts it again.'
      : `Watching every prompt, judged by ${judge === 'jev' ? 'Jev' : 'Claude Haiku'}. \`/change-of-subject off\` stops it.`
  const counted = `${judged} prompt${judged === 1 ? '' : 's'} judged this session, against ${log.length} remembered line${log.length === 1 ? '' : 's'}.`
  const verdict =
    last === null
      ? 'Nothing judged yet.'
      : last.failure !== undefined
        ? `The last prompt went through unjudged: ${last.failure}.`
        : `Last verdict: **${last.verdict}**${howSure(last)}${because(last.reason)}.`

  return [watch, counted, verdict].join('\n\n')
}
