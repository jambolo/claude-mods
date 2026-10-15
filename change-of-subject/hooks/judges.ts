import type { EngineInterface, ModelCompleteResult } from 'claude-code'

import type { Beat, Example, Judge, Judgement, Lessons, Teaching, Verdict } from '../types'
import { failed, jevRefused, messageOf, readJev, readVerdict } from './model'
import { EXPLAIN_SYSTEM, LESSONS_SYSTEM, explainBrief, haikuRequest, jevRequest, lessonsBrief, readExplanation, readLessons } from './teach'

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

async function judgeWithHaiku($: EngineInterface, beats: Beat[], text: string, t: Teaching): Promise<Judgement> {
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

async function judgeWithJev($: EngineInterface, beats: Beat[], text: string, t: Teaching): Promise<Judgement> {
  const key = await $.env.get('TYPESAFE_API_KEY')
  if (key === undefined) return failed('Jev has no key: `TYPESAFE_API_KEY` is not set where Claude Code started')

  const call = $.http
    .fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: jevRequest(beats, text, t),
    })
    .catch((e: unknown) => failed(`Jev could not be reached: ${messageOf(e)}`))
  // $.http.fetch takes no timeout or signal, so the judge stops waiting instead.
  const late = new Promise<Judgement>(resolve =>
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
export function judgeWith(
  $: EngineInterface,
  by: Exclude<Judge, 'off'>,
  beats: Beat[],
  text: string,
  t: Teaching,
): Promise<Judgement> {
  return by === 'jev' ? judgeWithJev($, beats, text, t) : judgeWithHaiku($, beats, text, t)
}

/**
 * Has Claude Haiku say why a verdict was given and how the prompt compared with its
 * session, whichever judge gave the verdict: the teaching is in its words either way.
 * `medium`: a few requests a session, and every later judgement reads what they write.
 * Resolves undefined when it gave no comparison or could not be asked.
 */
export async function explainVerdict(
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
 * call, and one whose rules every later judgement reads, so it runs at Sonnet's own
 * `high`. Resolves with the rules, or empty when the model gave none or could not be asked.
 */
export async function drawLessons(
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
