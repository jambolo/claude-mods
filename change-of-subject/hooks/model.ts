import type { Beat, Judge, Judgement, Verdict, Who } from '../types'

/** The session record starts empty. */
export const EMPTY: Beat[] = []

/** How many lines of the session the judge is shown. */
export const BEATS = 12

const YOU_CHARS = 400
const CLAUDE_CHARS = 240
const REASON_CHARS = 90

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

const VERDICTS = Object.keys(MEANINGS) as Verdict[]

/** What an answer nobody can read comes to: it is no reason to interrupt. */
export const NO_VERDICT: Judgement = { verdict: 'same', reason: '' }

/** A judge that gave no answer, and why: the prompt goes through unjudged. */
export const failed = (failure: string): Judgement => ({ ...NO_VERDICT, failure })

/** Pinned: Jev's minor versions have changed its question types before. */
export const JEV_MODEL = 'jev-1.13.0'

/** How sure Jev must be of `aside` or `phase` to interrupt anyone: the close calls carry on. */
const JEV_SURE = 0.7

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** One line of the session, trimmed to what the judge needs of it. */
export const beatOf = (who: Who, text: string): Beat => ({
  who,
  text: clip(squash(text), who === 'you' ? YOU_CHARS : CLAUDE_CHARS),
})

/** Adds a line to the record, keeping the last `BEATS`. An empty line is nothing to remember. */
export const remember = (log: Beat[], line: Beat): Beat[] => (line.text === '' ? log : [...log, line].slice(-BEATS))

const lastAsked = (log: Beat[]): string | undefined => log.filter(b => b.who === 'you').pop()?.text

/**
 * Whether a prompt is worth a judgement. The first prompt of a session has
 * nothing to be unrelated to, a line meant for the composer is no prompt at all,
 * a bare answer or nudge carries no subject, and a prompt typed again is a retry
 * of the one before it.
 */
export function isWorthJudging(text: string, log: Beat[]): boolean {
  const asked = squash(text)
  const before = lastAsked(log)

  if (asked.length < 3 || COMPOSER_LINE.test(asked) || CARRY_ON.test(asked)) return false

  return before !== undefined && before !== asked
}

/** The session and the new prompt, as material for the judge. Both are data, never instructions. */
export function briefing(log: Beat[], text: string): string {
  return [
    'The session so far, oldest line first:',
    '<session>',
    log.map(b => `[${b.who === 'you' ? 'person' : 'claude'}] ${b.text}`).join('\n'),
    '</session>',
    'The prompt the person has just typed:',
    '<prompt>',
    clip(squash(text), YOU_CHARS),
    '</prompt>',
  ].join('\n')
}

/** The judge's one word and its few words of reason. Anything unreadable is taken as `same`. */
export function readVerdict(answer: string): Judgement {
  const said = squash(answer)
  const verdict = VERDICTS.find(v => said.toLowerCase().startsWith(v))

  if (verdict === undefined) return NO_VERDICT

  const reason = said.slice(verdict.length).replace(/^[\s:.;,–—-]+/, '').replace(/[.]+$/, '')

  return { verdict, reason: clip(reason, REASON_CHARS) }
}

/** The body of one request to Jev: a single Choice question, the briefing as its state. */
export function jevRequest(log: Beat[], text: string): string {
  return JSON.stringify({
    model: JEV_MODEL,
    state: briefing(log, text),
    questions: {
      belongs: {
        type: 'choice',
        instructions:
          'Does the prompt the person has just typed belong to the Claude Code session it was typed into? Judge by subject, not by tone or length.',
        criteria: MEANINGS,
      },
    },
  })
}

type JevAnswer = { choice?: unknown; probabilities?: Record<string, unknown> }

/**
 * Jev's pick and how sure it was. `aside` and `phase` count only when Jev is sure of
 * them. Jev answers in a fixed shape, so a body without a verdict in it is a failure.
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
  const sure = typeof p === 'number' ? p : 0
  const said = `Jev, ${Math.round(sure * 100)}% sure`
  if (verdict !== 'same' && sure < JEV_SURE) return { verdict: 'same', reason: `${said} of ${verdict}` }

  return { verdict, reason: said }
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

/**
 * What the dialogs ask. Neither says what the judge made of the prompt: the person can see
 * their own prompt and the session it landed in, and the few words of reason belong in
 * `/change-of-subject`, where they are there to be asked for rather than in the way.
 */
export const ASIDE_QUESTION = 'This prompt looks unrelated to what this session is about. Ask it as a side question instead?'
export const PHASE_QUESTION = 'This prompt starts a new direction in this session. Where should it run?'

const because = (reason: string): string => (reason === '' ? '' : `: ${reason}`)

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
        : `Last verdict: **${last.verdict}**${because(last.reason)}.`

  return [watch, counted, verdict].join('\n\n')
}
