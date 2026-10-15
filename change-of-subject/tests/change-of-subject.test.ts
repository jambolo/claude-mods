import type { HttpInit, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  CARRY_ON_HERE,
  COMPACT_FIRST,
  EMPTY,
  NEW_SESSION,
  NOT_ASIDE,
  NOT_PHASE,
  USE_BTW,
  bearsOut,
  beatOf,
  briefing,
  isWorthJudging,
  jevRefused,
  keep,
  outcomeOf,
  readJev,
  readVerdict,
  readWas,
  remember,
  report,
} from '../hooks/model'
import {
  EXPLAIN_SYSTEM,
  barsFor,
  calibrated,
  gate,
  haikuRequest,
  isDue,
  jevRequest,
  lessonsBrief,
  pastCalls,
  readExplanation,
  readLessons,
} from '../hooks/teach'
import type { Example, Truth, Verdict } from '../types'

const SESSION = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
// Where the store keeps this project's labels, and everyone's.
const HERE = 'local:C:/repo:examples'
const EVERYWHERE = 'user:examples'
const USAGE = { input_tokens: 500, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// Long enough to pass the delay the mod waits before it runs a command in a prompt's place.
const SETTLED_MS = 400
// Long enough for the mod to stop waiting on a Jev that never answers.
const JEV_GIVEN_UP_MS = 5_000

/** A Jev reply picking `choice`, `sure` of it. */
const jevSays = (choice: string, sure: number): string =>
  JSON.stringify({
    model: 'jev-1.13.0',
    answers: { belongs: { type: 'choice', choice, probabilities: { [choice]: sure }, confidence: sure } },
    usage: { input_tokens: 400, output_tokens: 10 },
  })

type World = {
  /** What the judge answers, one per prompt it is asked about. */
  verdicts: string[]
  /** What the person picks in the dialog, one per dialog. */
  answers: string[]
  briefings: string[]
  questions: string[]
  commands: { command: string; args: string }[]
  /** Commands the engine will not run, by name. */
  failing: string[]
  /** Held by a command still running, as `/clear` is while it tears a session down. */
  pending: Promise<void> | null
  /** The prompts that reached the session. */
  through: string[]
  /** Prompts the engine will not take back, by text: a session torn down takes its queue with it. */
  unsendable: string[]
  /** The prompts put in the person's box instead. */
  filled: string[]
  /** The environment, as the mod reads it. */
  env: Record<string, string>
  /** What Jev answers, one reply per prompt it is asked about. */
  jev: string[]
  /** The requests sent to Jev. */
  fetched: { url: string; init?: HttpInit }[]
  /** The toasts the mod raised. */
  toasts: string[]
  /** The plugin's store, by key. */
  store: Record<string, unknown>
  /** A store that refuses every write, as a full disk would. */
  isStoreBroken: boolean
  /** The system prompts Claude Haiku was judged with, one per prompt it was asked about. */
  systems: string[]
  /** What Claude Sonnet answers when asked to draw the rules, one reply per drawing. */
  lessons: string[]
  /** What Claude Sonnet was given to draw the rules from. */
  drawn: string[]
  /** What Claude Haiku answers when asked to explain a verdict, one reply per label. */
  explanations: string[]
  /** What Claude Haiku was given to explain. */
  explained: string[]
}

/** The labels the store keeps under `key`. */
const labelsIn = (w: World, key: string): Example[] => (w.store[key] ?? []) as Example[]

/** A label's prompt, the verdict the mod acted on, the person's word on it, and how that was learned. */
const gist = (x: Example) => [x.prompt, x.said, x.truth, x.source]

/** A label as the store keeps one: the person bore the judge out, unless told otherwise, and it is explained. */
const labeled = (prompt: string, said: Verdict, more: Partial<Example> = {}): Example => ({
  at: 1,
  prompt,
  said,
  truth: { is: said },
  source: 'dialog',
  judge: 'haiku',
  comparison: `how "${prompt}" stood to its session`,
  ...more,
})

// Where the store keeps Claude Haiku's rules for this project, and for every project.
const HERE_LESSONS = 'local:C:/repo:lessons:haiku'
const EVERYWHERE_LESSONS = 'user:lessons:haiku'
// What Claude Haiku says, unless the test queued another explanation.
const EXPLAINED = 'off the subject of the parser\nThe session is writing a config parser; the prompt asks about something else.'

/** The engine around the mod: a judge and a dialog that answer what the test queued up. */
function worldOf(on: On): World {
  const w: World = {
    verdicts: [],
    answers: [],
    briefings: [],
    questions: [],
    commands: [],
    through: [],
    unsendable: [],
    filled: [],
    failing: [],
    pending: null,
    env: {},
    jev: [],
    fetched: [],
    toasts: [],
    store: {},
    isStoreBroken: false,
    systems: [],
    lessons: [],
    drawn: [],
    explanations: [],
    explained: [],
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/repo' }))

  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => {
    if (w.isStoreBroken) throw new Error('disk full')
    w.store[e.key] = JSON.parse(JSON.stringify(e.value)) as unknown

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete w.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  on('session.end', () => ({ sessionId: 'the-session-left-behind' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  on('model.complete', ($, e) => {
    if (e.model === 'sonnet') {
      w.drawn.push(String(e.prompt))

      return { value: { isAnswered: true as const, text: w.lessons.shift() ?? '', usage: USAGE } }
    }
    if (e.system === EXPLAIN_SYSTEM) {
      w.explained.push(String(e.prompt))

      return { value: { isAnswered: true as const, text: w.explanations.shift() ?? EXPLAINED, usage: USAGE } }
    }
    w.briefings.push(String(e.prompt))
    w.systems.push(String(e.system))
    const said = w.verdicts.shift() ?? 'same'
    // A queued 'throw' stands for a judge that is not there, 'overloaded' for one the API turned away.
    if (said === 'throw') throw new Error('no model today')
    if (said === 'overloaded') {
      return {
        value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE },
      }
    }

    return { value: { isAnswered: true as const, text: said, usage: USAGE } }
  })

  on('env.get', ($, e) => ({ value: w.env[e.name] }))

  on('http.fetch', ($, e) => {
    w.fetched.push(e)
    const said = w.jev.shift() ?? jevSays('same', 0.9)
    // A queued 'throw' stands for a request that failed, 'hang' for a Jev that never answers,
    // 'refused' for a key Jev does not take.
    if (said === 'throw') throw new Error('no network today')
    if (said === 'hang') return new Promise<never>(() => {})
    if (said === 'refused') {
      const text = '{"detail":{"error_type":"authentication_error","message":"Invalid API key."}}'

      return { value: { status: 403, ok: false, headers: {}, text } }
    }

    return { value: { status: 200, ok: true, headers: {}, text: said } }
  })

  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })

  on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))

  // $.ui.ask is raised as a call to the AskUserQuestion tool.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const asked = (e as unknown as { questions: { question: string }[] }).questions
    const question = asked[0]?.question ?? ''
    w.questions.push(question)
    const answer = w.answers.shift() ?? ''
    // A queued 'throw' stands for a dialog the person dismissed.
    if (answer === 'throw') throw new Error('nobody answered')

    return { result: { answers: { [question]: answer } } }
  })

  on('command.run', async ($, e) => {
    w.commands.push({ command: e.command, args: e.args })
    if (w.failing.includes(e.command)) throw new Error(`no command named /${e.command}`)
    if (w.pending !== null) await w.pending

    return { text: '' }
  })

  on('prompt.submit', ($, e) => {
    if (w.unsendable.includes(e.text)) throw new Error('this session has gone')
    w.through.push(e.text)

    return { text: e.text }
  })

  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)

    return { isFilled: true }
  })

  return w
}

const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const runCommand = ($: Engine, args: string) =>
  $.command.run({
    command: 'change-of-subject',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

test('the record keeps the last lines of the session, trimmed and squashed', () => {
  let log = EMPTY
  for (let i = 0; i < 15; i += 1) log = remember(log, beatOf('you', `prompt ${i}`))

  expect(log.length).toBe(12)
  expect(log[0]?.text).toBe('prompt 3')
  expect(remember(log, beatOf('claude', '   ')).length, 'nothing said is nothing to remember').toBe(12)
  expect(beatOf('claude', 'two\n  files\twritten').text).toBe('two files written')
})

test('a first prompt, a bare answer and a prompt typed again are not judged', () => {
  const started = remember(EMPTY, beatOf('you', 'write a parser for the config file'))

  expect(isWorthJudging('write a parser for the config file', EMPTY), 'nothing to be unrelated to yet').toBe(false)
  expect(isWorthJudging('ok', started)).toBe(false)
  expect(isWorthJudging('Thanks!', started)).toBe(false)
  expect(isWorthJudging('try again', started)).toBe(false)
  expect(isWorthJudging('write a parser for the config file', started), 'a retry').toBe(false)
  expect(isWorthJudging('now add a test for it', started)).toBe(true)
})

test('a line meant for the composer is no prompt to judge', () => {
  const started = remember(EMPTY, beatOf('you', 'write a parser for the config file'))

  expect(isWorthJudging('/release-notes', started), 'a command the person meant to run').toBe(false)
  expect(isWorthJudging('/clear', started)).toBe(false)
  expect(isWorthJudging('#the parser lives in src/config.ts', started), 'a memory line').toBe(false)
  expect(isWorthJudging('!git status', started), 'a shell line').toBe(false)
})

test('the judge is read for its one word, and an answer nobody can read carries on', () => {
  expect(readVerdict('aside: a question about tea.')).toEqual({ verdict: 'aside', reason: 'a question about tea', pick: 'aside' })
  expect(readVerdict('PHASE — the release, not the parser')).toEqual({
    verdict: 'phase',
    reason: 'the release, not the parser',
    pick: 'phase',
  })
  expect(readVerdict('same')).toEqual({ verdict: 'same', reason: '', pick: 'same' })
  expect(readVerdict('I think this one is unrelated')).toEqual({ verdict: 'same', reason: '' })
})

test('the judge is read for how sure it was, when it says', () => {
  expect(readVerdict('aside 80: a question about tea')).toEqual({ verdict: 'aside', reason: 'a question about tea', pick: 'aside', sure: 0.8 })
  expect(readVerdict('phase 75%: the release')).toEqual({ verdict: 'phase', reason: 'the release', pick: 'phase', sure: 0.75 })
  expect(readVerdict('aside 250: no such number'), 'a number past 100 is no measure').toEqual({
    verdict: 'aside',
    reason: 'no such number',
    pick: 'aside',
  })
})

test('Jev is read for its pick and how sure it was, and only a sure aside or phase interrupts', () => {
  const bars = barsFor([], 'jev')

  expect(readJev(jevSays('aside', 0.91))).toEqual({ verdict: 'aside', reason: '', pick: 'aside', sure: 0.91 })
  expect(gate(readJev(jevSays('aside', 0.91)), bars).verdict).toBe('aside')
  expect(gate(readJev(jevSays('phase', 0.55)), bars), 'a close call carries on').toEqual({
    verdict: 'same',
    reason: '',
    pick: 'phase',
    sure: 0.55,
  })
  expect(readJev(jevSays('same', 0.8))).toEqual({ verdict: 'same', reason: '', pick: 'same', sure: 0.8 })
  const unread = { verdict: 'same', reason: '', failure: "Jev's answer could not be read" }
  expect(readJev(jevSays('billing', 0.99)), 'an option it was never offered').toEqual(unread)
  expect(readJev('<html>502 Bad Gateway</html>')).toEqual(unread)
  expect(jevRefused(403, '{"detail":{"error_type":"authentication_error"}}')).toBe(
    'Jev refused the request: HTTP 403 (authentication_error)',
  )
  expect(jevRefused(502, '<html>502 Bad Gateway</html>')).toBe('Jev refused the request: HTTP 502')
})

test('Jev is asked one Choice question, with the briefing as its state', () => {
  const log = remember(EMPTY, beatOf('you', 'write a parser'))
  const sent = JSON.parse(jevRequest(log, 'now publish it'))

  expect(sent.model).toBe('jev-1.13.0')
  expect(sent.state).toBe(briefing(log, 'now publish it'))
  expect(sent.questions.belongs.type).toBe('choice')
  expect(Object.keys(sent.questions.belongs.criteria)).toEqual(['same', 'aside', 'phase'])
})

test('the briefing carries the session and the new prompt, both marked as material', () => {
  const log = remember(remember(EMPTY, beatOf('you', 'write a parser')), beatOf('claude', 'Done:\n  two files.'))
  const text = briefing(log, 'now  publish it')

  expect(text).toContain('[person] write a parser')
  expect(text).toContain('[claude] Done: two files.')
  expect(text).toContain('<prompt>\nnow publish it\n</prompt>')
})

test('the report says whether prompts are being watched and what the last verdict was', () => {
  const log = remember(EMPTY, beatOf('you', 'write a parser'))

  expect(report('haiku', 0, null, EMPTY)).toContain('Watching every prompt')
  expect(report('off', 0, null, EMPTY)).toContain('Not watching')
  expect(report('haiku', 1, { verdict: 'phase', reason: 'the release' }, log)).toContain('1 prompt judged')
  expect(report('haiku', 1, { verdict: 'phase', reason: 'the release' }, log)).toContain('**phase**: the release')
  expect(report('haiku', 0, null, EMPTY)).toContain('judged by Claude Haiku')
  expect(report('jev', 0, null, EMPTY)).toContain('judged by Jev')
  expect(report('jev', 0, { verdict: 'same', reason: '', failure: 'Jev did not answer within 5s' }, log)).toContain(
    'The last prompt went through unjudged: Jev did not answer within 5s.',
  )
})

test('the first prompt of a session goes straight through, unjudged', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')

  expect(w.briefings).toEqual([])
  expect(w.through).toEqual(['write a parser for the config file'])
})

test('a prompt about another subject is handed to /btw and never enters the session', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside: a question about Peru, not the parser']
  w.answers = [USE_BTW]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  const answer = await say($, 'what is the capital of Peru?')

  expect(w.questions[0], 'the dialog asks without explaining itself').toBe(
    'This prompt looks unrelated to what this session is about. Ask it as a side question instead?',
  )
  expect(JSON.stringify(answer)).toContain('side question')

  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'btw', args: 'what is the capital of Peru?' }])
  expect(w.through, 'the aside stayed out of the session').toEqual(['write a parser for the config file'])
})

test('an aside the person keeps here goes through untouched', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside: a question about Peru, not the parser']
  w.answers = [CARRY_ON_HERE]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([])
  expect(w.through).toEqual(['write a parser for the config file', 'what is the capital of Peru?'])
})

test('a new direction can start a new session, with the prompt sent again in it', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['phase: the release, not the parser']
  w.answers = [NEW_SESSION]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  const answer = await say($, 'now cut a release and publish it')

  expect(w.questions[0]).toContain('new direction')
  expect(JSON.stringify(answer)).toContain('new session')

  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'clear', args: '' }])
  expect(w.through.at(-1), 'the prompt follows the clear').toBe('now cut a release and publish it')
})

test('a prompt held for a new session is sent again in the session /clear leaves behind', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['phase: the release, not the parser']
  w.answers = [NEW_SESSION]
  // `/clear` does not return until it has torn this session down and started the next, so
  // the only hand-back left is the one the new session makes.
  let clearDone = () => {}
  w.pending = new Promise<void>(resolve => {
    clearDone = resolve
  })

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now cut a release and publish it')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'clear', args: '' }])
  expect(w.through, 'nothing is sent while /clear is still running').toEqual(['write a parser for the config file'])

  await $.session.end({ reason: 'clear', sessionId: 'the-session-cleared', resume: { id: 'the-session-cleared' } })
  await $.session.start(SESSION)
  await clock.advance(SETTLED_MS)

  expect(w.through.at(-1), 'the new session sent it').toBe('now cut a release and publish it')
  expect(JSON.stringify(await runCommand($, '')), 'the record went with the old session').toContain(
    '0 prompts judged this session, against 0 remembered lines',
  )

  clearDone()
  await clock.advance(SETTLED_MS)

  const sent = w.through.filter(t => t === 'now cut a release and publish it')
  expect(sent, 'and the command that finished after it does not send it twice').toEqual([
    'now cut a release and publish it',
  ])
})

test('a prompt the new session will not take is put in the box instead', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['phase: the release, not the parser']
  w.answers = [NEW_SESSION]
  w.unsendable = ['now cut a release and publish it']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now cut a release and publish it')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'clear', args: '' }])
  expect(w.through, 'it never reached a session').toEqual(['write a parser for the config file'])
  expect(w.filled, 'it is in the box for the person').toEqual(['now cut a release and publish it'])
})

test('a new direction can compact first, with the prompt sent again after it', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['phase: the release, not the parser']
  w.answers = [COMPACT_FIRST]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now cut a release and publish it')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'compact', args: '' }])
  expect(w.through.at(-1)).toBe('now cut a release and publish it')
})

test('a new direction the person keeps here runs no command', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['phase: the release, not the parser']
  w.answers = [CARRY_ON_HERE]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now cut a release and publish it')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([])
  expect(w.through).toEqual(['write a parser for the config file', 'now cut a release and publish it'])
})

test('a dialog answered the person\'s own way, or dismissed, leaves the prompt alone', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside: a question about Peru, not the parser', 'phase: the release, not the parser']
  w.answers = ['leave my prompt where it is', 'throw']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await say($, 'now cut a release and publish it')
  await clock.advance(SETTLED_MS)

  expect(w.questions.length, 'both dialogs were raised').toBe(2)
  expect(w.commands, 'neither prompt was displaced').toEqual([])
  expect(w.through).toEqual([
    'write a parser for the config file',
    'what is the capital of Peru?',
    'now cut a release and publish it',
  ])
})

test('a prompt the judge calls part of the same work opens no dialog', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.verdicts = ['same: the next step of the parser']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now add a test for it')

  expect(w.briefings.length).toBe(1)
  expect(w.questions).toEqual([])
  expect(w.through).toEqual(['write a parser for the config file', 'now add a test for it'])
})

test('a slash command and a memory line reach the session unjudged', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  // Queued in case a line slips past the guard: the dialog would then be the loud failure.
  w.verdicts = ['aside: nothing to do with the parser']
  w.answers = [USE_BTW]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, '/release-notes')
  await say($, '#the parser lives in src/config.ts')

  expect(w.briefings, 'neither line reached the judge').toEqual([])
  expect(w.questions).toEqual([])
  expect(w.commands, 'nothing was run in their place').toEqual([])
  expect(w.through).toEqual([
    'write a parser for the config file',
    '/release-notes',
    '#the parser lives in src/config.ts',
  ])
})

test('a /btw that will not run gives the prompt back', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside: a question about Peru, not the parser']
  w.answers = [USE_BTW]
  w.failing = ['btw']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'btw', args: 'what is the capital of Peru?' }])
  expect(w.through.at(-1), 'the aside the command could not take').toBe('what is the capital of Peru?')
})

test('a bare nudge is never sent to the judge', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'ok')
  await say($, 'go on')

  expect(w.briefings).toEqual([])
})

test('/change-of-subject off stops the judging, on starts it again', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside: a question about Peru, not the parser', 'aside: still about Peru']
  w.answers = [USE_BTW]

  await $.session.start(SESSION)
  expect(JSON.stringify(await runCommand($, 'off'))).toContain('Not watching')

  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')

  expect(w.briefings, 'no judge, no request').toEqual([])
  expect(w.questions).toEqual([])

  expect(JSON.stringify(await runCommand($, 'on'))).toContain('Watching')
  await say($, 'and the capital of Chile?')

  expect(w.briefings.length).toBe(1)
  expect(JSON.stringify(await runCommand($, 'sideways'))).toContain('Usage')
  expect(JSON.stringify(await runCommand($, ''))).toContain('judged this session')
})

test('a judge that fails costs nobody their prompt', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.verdicts = ['throw']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')

  expect(w.briefings.length).toBe(1)
  expect(w.questions).toEqual([])
  expect(w.through).toEqual(['write a parser for the config file', 'what is the capital of Peru?'])
  // The engine's own words for why the call failed follow the colon.
  expect(w.toasts.length, 'the person is told').toBe(1)
  expect(w.toasts[0]).toMatch(/^Claude Haiku could not be asked: .+ Prompts go through unjudged while it fails; `\/change-of-subject off` stops the judging\.$/)
  expect(JSON.stringify(await runCommand($, ''))).toContain('0 prompts judged')
})

test('a failing judge is told once per failure, not once per prompt', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.verdicts = ['overloaded', 'overloaded', 'same: the next step of the parser', 'overloaded']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now add a test for it')
  await say($, 'and one for blank lines')
  await say($, 'and one for comments')
  await say($, 'and one for quoted values')

  expect(w.briefings.length).toBe(4)
  expect(w.toasts.length, 'once, and again after it came back and failed anew').toBe(2)
  expect(w.toasts[0]).toContain("Claude Haiku's request failed: HTTP 529 (overloaded)")
  expect(JSON.stringify(await runCommand($, ''))).toContain('1 prompt judged')
})

test('/change-of-subject jev needs a key, and Claude Haiku judges until there is one', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })

  await $.session.start(SESSION)
  expect(JSON.stringify(await runCommand($, 'jev'))).toContain('TYPESAFE_API_KEY')

  await say($, 'write a parser for the config file')
  await say($, 'now add a test for it')

  expect(w.briefings.length).toBe(1)
  expect(w.fetched).toEqual([])
})

test('/change-of-subject jev has Jev judge each prompt in place of Claude Haiku, until haiku', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.env = { TYPESAFE_API_KEY: 'sk-test' }
  w.jev = [jevSays('aside', 0.93)]
  w.answers = [USE_BTW]

  await $.session.start(SESSION)
  expect(JSON.stringify(await runCommand($, 'jev')), 'it says where prompts go').toContain('api.typesafe.ai')
  expect(JSON.stringify(await runCommand($, ''))).toContain('judged by Jev')

  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await clock.advance(SETTLED_MS)

  expect(w.briefings, 'Claude Haiku was not asked').toEqual([])
  expect(w.fetched.map(f => f.url)).toEqual(['https://api.typesafe.ai/v1/systemone'])
  expect(w.fetched[0]?.init?.headers?.Authorization).toBe('Bearer sk-test')
  expect(w.commands).toEqual([{ command: 'btw', args: 'what is the capital of Peru?' }])
  expect(JSON.stringify(await runCommand($, ''))).toContain('**aside** (93% sure)')

  expect(JSON.stringify(await runCommand($, 'haiku'))).toContain('Claude Haiku')
  await say($, 'and the capital of Chile?')

  expect(w.briefings.length).toBe(1)
  expect(w.fetched.length).toBe(1)

  await runCommand($, 'jev')
  await runCommand($, 'off')
  expect(JSON.stringify(await runCommand($, 'on')), 'on starts again with the default judge').toContain('Claude Haiku')
})

test('a Jev that fails or never answers costs nobody their prompt', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.env = { TYPESAFE_API_KEY: 'sk-test' }
  w.jev = ['throw', 'hang']

  await $.session.start(SESSION)
  await runCommand($, 'jev')
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  const waiting = say($, 'and the capital of Chile?')
  await clock.advance(JEV_GIVEN_UP_MS)
  await waiting

  expect(w.fetched.length).toBe(2)
  expect(w.toasts.length).toBe(2)
  expect(w.toasts[0]).toMatch(/^Jev could not be reached: /)
  expect(w.toasts[1]).toMatch(/^Jev did not answer within 5s\. /)
  expect(w.toasts[0], 'it says how to get out of it').toContain('`/change-of-subject haiku`')
  const said = JSON.stringify(await runCommand($, ''))
  expect(said, 'neither counts as judged').toContain('0 prompts judged')
  expect(said).toContain('went through unjudged: Jev did not answer within 5s')
  expect(w.questions).toEqual([])
  expect(w.through).toEqual([
    'write a parser for the config file',
    'what is the capital of Peru?',
    'and the capital of Chile?',
  ])
})

test('a key Jev refuses is told once, with the kind of error Jev named', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.env = { TYPESAFE_API_KEY: 'sk-revoked' }
  w.jev = ['refused', 'refused']

  await $.session.start(SESSION)
  await runCommand($, 'jev')
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await say($, 'and the capital of Chile?')

  expect(w.fetched.length).toBe(2)
  expect(w.toasts).toEqual([
    'Jev refused the request: HTTP 403 (authentication_error). Prompts go through unjudged while it fails; `/change-of-subject haiku` switches to Claude Haiku.',
  ])
  expect(w.questions).toEqual([])
  expect(w.through.length).toBe(3)
})

test("a pop-up's answer bears the verdict out or turns it down, and Continue here says neither", () => {
  expect(outcomeOf(USE_BTW)).toBe('confirmed')
  expect(outcomeOf(NEW_SESSION)).toBe('confirmed')
  expect(outcomeOf(COMPACT_FIRST)).toBe('confirmed')
  expect(outcomeOf(NOT_ASIDE)).toBe('denied')
  expect(outcomeOf(NOT_PHASE)).toBe('denied')
  expect(outcomeOf(CARRY_ON_HERE)).toBe(undefined)
  expect(outcomeOf(''), 'a dismissed pop-up').toBe(undefined)
})

test('a verdict turned down says only what the prompt was not', () => {
  expect(bearsOut({ is: 'aside' }, 'aside')).toBe(true)
  expect(bearsOut({ is: 'aside' }, 'same')).toBe(false)
  expect(bearsOut({ not: 'aside' }, 'aside')).toBe(false)
  expect(bearsOut({ not: 'aside' }, 'phase'), 'same or phase: nobody said which').toBe(undefined)
})

test('was names a verdict, and a scope when the person names one', () => {
  expect(readWas('was aside')).toEqual({ label: 'aside' })
  expect(readWas('was  PHASE   user')).toEqual({ label: 'phase', scope: 'user' })
  expect(readWas('was same local')).toEqual({ label: 'same', scope: 'local' })
  expect(readWas('was')).toBe(undefined)
  expect(readWas('was billing')).toBe(undefined)
  expect(readWas('was aside everywhere')).toBe(undefined)
  expect(readWas('was aside user please')).toBe(undefined)
})

test('a full scope lets go of the calls it bore out before its mistakes, oldest first', () => {
  const one = (at: number, said: Verdict, truth: Truth): Example => labeled(`prompt ${at}`, said, { at, truth })
  const mixed = [
    one(1, 'aside', { not: 'aside' }),
    one(2, 'aside', { is: 'aside' }),
    one(3, 'phase', { is: 'phase' }),
    one(4, 'same', { is: 'aside' }),
    one(5, 'aside', { is: 'aside' }),
  ]
  const mistakes = [one(1, 'aside', { not: 'aside' }), one(2, 'phase', { not: 'phase' }), one(3, 'same', { is: 'aside' })]

  expect(keep(mixed, 3).map(x => x.at)).toEqual([1, 4, 5])
  expect(keep(mistakes, 2).map(x => x.at), 'with nothing else left, the oldest mistake goes').toEqual([2, 3])
  expect(keep(mistakes, 5)).toBe(mistakes)
})

test("the judge's second line compares the prompt with the session, for aside or phase only", () => {
  expect(readVerdict('aside 80: a question about tea\nThe session is writing a parser; the prompt asks about tea.')).toEqual({
    verdict: 'aside',
    reason: 'a question about tea',
    pick: 'aside',
    sure: 0.8,
    comparison: 'The session is writing a parser; the prompt asks about tea.',
  })
  expect(readVerdict('same 90: the next step\nThe session is writing a parser.'), 'same needs no comparison').toEqual({
    verdict: 'same',
    reason: 'the next step',
    pick: 'same',
    sure: 0.9,
  })
  expect(readExplanation('Reason: off the subject\nComparison: The session is writing a parser; the prompt asks about tea.')).toEqual({
    reason: 'off the subject',
    comparison: 'The session is writing a parser; the prompt asks about tea.',
  })
  expect(readExplanation('off the subject'), 'no comparison, no explanation').toBe(undefined)
})

test("a pop-up answered while Claude Haiku judges keeps the judge's own reason and comparison", async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = [
    'aside 90: a question about Peru\nThe session is writing a config parser; the prompt asks about geography.',
    'aside 80: a question about Chile\nThe session is writing a config parser; the prompt asks about Chile.',
    'phase 70: the release, not the parser\nThe session wrote the parser; the prompt moves on to releasing it.',
    'aside 60: a question about tea\nThe session is writing a parser; the prompt asks about tea.',
    'phase 75: the docs\nThe session wrote the parser; the prompt asks for its docs.',
  ]
  w.answers = [USE_BTW, NOT_ASIDE, NOT_PHASE, CARRY_ON_HERE, COMPACT_FIRST]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await clock.advance(SETTLED_MS)
  await say($, 'and the capital of Chile?')
  await say($, 'now cut a release')
  await say($, 'tell me about tea')
  await say($, 'now write the docs')
  await clock.advance(SETTLED_MS)

  expect(labelsIn(w, HERE).map(gist)).toEqual([
    ['what is the capital of Peru?', 'aside', { is: 'aside' }, 'dialog'],
    ['and the capital of Chile?', 'aside', { not: 'aside' }, 'dialog'],
    ['now cut a release', 'phase', { not: 'phase' }, 'dialog'],
    ['now write the docs', 'phase', { is: 'phase' }, 'dialog'],
  ])
  const [peru] = labelsIn(w, HERE)
  expect([peru?.reason, peru?.comparison, peru?.pick, peru?.sure, peru?.session]).toEqual([
    'a question about Peru',
    'The session is writing a config parser; the prompt asks about geography.',
    'aside',
    0.9,
    undefined,
  ])
  expect(w.explained, 'the judge explained itself').toEqual([])
  expect(w.store[EVERYWHERE], 'nothing for every project unless asked').toBe(undefined)
  expect(w.commands.map(c => c.command)).toEqual(['btw', 'compact'])
  expect(w.through, 'a verdict turned down lets the prompt through as typed').toContain('and the capital of Chile?')
  expect(w.through).toContain('now cut a release')
})

test('a pop-up answered while Jev judges is explained by Claude Haiku off a timer, and its session let go', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.env = { TYPESAFE_API_KEY: 'sk-test' }
  w.jev = [jevSays('aside', 0.93)]
  w.answers = [NOT_ASIDE]

  await $.session.start(SESSION)
  await runCommand($, 'jev')
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')

  expect(w.explained, 'never while the prompt waits').toEqual([])
  expect(labelsIn(w, HERE)[0]?.session).toEqual([{ who: 'you', text: 'write a parser for the config file' }])

  await clock.advance(SETTLED_MS)

  expect(w.explained.length).toBe(1)
  expect(w.explained[0]).toContain('<prompt>\nwhat is the capital of Peru?\n</prompt>')
  expect(w.explained[0]).toContain('<verdict>aside</verdict>')
  const [peru] = labelsIn(w, HERE)
  expect([peru?.truth, peru?.reason, peru?.comparison, peru?.session]).toEqual([
    { not: 'aside' },
    'off the subject of the parser',
    'The session is writing a config parser; the prompt asks about something else.',
    undefined,
  ])
  expect(w.briefings, 'Claude Haiku explained; it never judged').toEqual([])
})

test('was corrects the last prompt judged, has it explained once, and keeps the label where it is told', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['same 80: the next step of the parser']

  await $.session.start(SESSION)
  expect(JSON.stringify(await runCommand($, 'was aside'))).toContain('Nothing judged yet')

  await say($, 'write a parser for the config file')
  await say($, 'now add a test for it')

  expect(w.store[HERE], 'a verdict the person never answered is no label').toBe(undefined)

  const said = JSON.stringify(await runCommand($, 'was aside'))
  expect(said).toContain('Noted for this project')
  expect(said).toContain('was **aside**')
  expect(labelsIn(w, HERE).map(gist)).toEqual([['now add a test for it', 'same', { is: 'aside' }, 'was']])

  await clock.advance(SETTLED_MS)

  const [added] = labelsIn(w, HERE)
  expect([added?.reason, added?.comparison], "the judge's own reason stays").toEqual([
    'the next step of the parser',
    'The session is writing a config parser; the prompt asks about something else.',
  ])

  expect(JSON.stringify(await runCommand($, 'was phase user'))).toContain('for every project')
  expect(labelsIn(w, HERE), 'moved, not copied').toEqual([])
  expect(labelsIn(w, EVERYWHERE).map(gist)).toEqual([['now add a test for it', 'same', { is: 'phase' }, 'was']])
  expect(labelsIn(w, EVERYWHERE)[0]?.comparison, 'the comparison moves with it').toBe(
    'The session is writing a config parser; the prompt asks about something else.',
  )

  await clock.advance(SETTLED_MS)

  expect(w.explained.length, 'so Claude Haiku is asked once').toBe(1)
  expect(JSON.stringify(await runCommand($, 'was sideways'))).toContain('Usage')
})

test('was replaces the label a pop-up answer left', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside 90: a question about Chile\nThe session is writing a parser; the prompt asks about Chile.']
  w.answers = [NOT_ASIDE]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'and the capital of Chile?')
  await runCommand($, 'was phase')

  expect(labelsIn(w, HERE).map(gist)).toEqual([['and the capital of Chile?', 'aside', { is: 'phase' }, 'was']])
})

test('a New session the person picked is labeled once, by the answer', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['phase 80: the release, not the parser\nThe session wrote a parser; the prompt moves on to releasing it.']
  w.answers = [NEW_SESSION]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now cut a release and publish it')
  await $.session.end({ reason: 'clear', sessionId: 'the-session-cleared', resume: { id: 'the-session-cleared' } })
  await $.session.start(SESSION)
  await clock.advance(SETTLED_MS)

  expect(w.through.at(-1)).toBe('now cut a release and publish it')
  expect(labelsIn(w, HERE).map(gist)).toEqual([['now cut a release and publish it', 'phase', { is: 'phase' }, 'dialog']])
})

test('a store that keeps nothing costs nobody their prompt or their choice', async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.verdicts = ['aside: a question about Peru, not the parser']
  w.answers = [USE_BTW]
  w.isStoreBroken = true

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await clock.advance(SETTLED_MS)

  expect(w.commands).toEqual([{ command: 'btw', args: 'what is the capital of Peru?' }])
  expect(JSON.stringify(await runCommand($, 'was same'))).toContain('The label could not be kept: ')
})

test('the bar for a verdict is the lowest sureness at which the judge is right often enough', () => {
  const call = (sure: number, isRight: boolean): Example =>
    labeled('a prompt', 'aside', { pick: 'aside', sure, truth: isRight ? { is: 'aside' } : { not: 'aside' } })
  const doubtful = Array.from({ length: 10 }, (_, i) => call(0.5, i < 2))
  const sure = Array.from({ length: 10 }, (_, i) => call(0.9, i < 9))

  expect(calibrated([...doubtful, ...sure], 'haiku', 'aside')).toBe(0.9)
  expect(calibrated([...doubtful, ...sure.slice(1)], 'haiku', 'aside'), 'too few calls to say').toBe(undefined)
  expect(calibrated([...doubtful, ...doubtful], 'haiku', 'aside'), 'never right enough').toBe(0.95)
  expect(calibrated([...doubtful, ...sure], 'jev', 'aside'), "another judge's calls say nothing").toBe(undefined)

  const bars = barsFor([doubtful, [...doubtful, ...sure]], 'haiku')
  expect(bars, 'from the first scope with calls enough').toEqual({ aside: 0.9, phase: 0 })
  expect(gate({ verdict: 'aside', reason: '', pick: 'aside', sure: 0.85 }, bars).verdict).toBe('same')
  expect(gate({ verdict: 'aside', reason: '', pick: 'aside', sure: 0.9 }, bars).verdict).toBe('aside')
  expect(gate({ verdict: 'phase', reason: '' }, { aside: 1, phase: 1 }).verdict, 'a judge that gave no number is not gated').toBe(
    'phase',
  )
})

test("the judge is shown its own mistakes first, then one call of each verdict, then the newest, whatever the prompt's words", () => {
  const here = [
    labeled('write the docs', 'same', { at: 1 }),
    labeled('write more docs', 'same', { at: 2 }),
    labeled('cut a release', 'phase', { at: 3 }),
    labeled('what is the capital of Peru', 'aside', { at: 4, judge: 'jev', truth: { not: 'aside' } }),
    labeled('order lunch', 'aside', { at: 5, truth: { not: 'aside' } }),
    labeled('rename the module', 'same', { at: 6, comparison: undefined, session: [] }),
  ]
  const everywhere = [labeled('write the docs', 'same', { at: 1 }), labeled('tidy the imports', 'same', { at: 7 })]

  expect(pastCalls([here, everywhere], 'haiku').map(x => x.prompt), "never Jev's mistakes, nor a call still waiting").toEqual([
    'order lunch',
    'cut a release',
    'write more docs',
    'write the docs',
  ])
  expect(pastCalls([here], 'jev').map(x => x.prompt), "never Claude Haiku's mistakes").toEqual([
    'what is the capital of Peru',
    'cut a release',
    'write more docs',
    'write the docs',
  ])
})

test('the judge is taught in its request: past calls with their comparisons, rules after its own', () => {
  const log = remember(EMPTY, beatOf('you', 'write a parser'))
  const readme = labeled('now update the README', 'phase', {
    truth: { not: 'phase' },
    reason: 'documentation is a stage after the code',
    comparison: 'The session rewrote the options; the prompt documents them.',
  })
  const cat = labeled('a name for a cat', 'aside', { comparison: 'The session fixes an export bug; the prompt is personal.' })
  const t = { anchor: null, examples: [readme, cat], lessons: ['- Docs for the work in hand are same.', '', '- Releases are phase.'] }
  const taught = haikuRequest(log, 'now the docs', t)
  const untaught = haikuRequest(log, 'now the docs')

  expect(untaught.prompt).toBe(briefing(log, 'now the docs'))
  expect(untaught.system).not.toContain("The person's own rules")
  expect(untaught.system).toContain('When the word is aside or phase, add a second line')
  expect(taught.system).toContain(
    "The person's own rules, the later ones winning where two disagree:\n- Docs for the work in hand are same.\n- Releases are phase.",
  )
  expect(taught.prompt).toContain(
    '<prompt>now update the README</prompt>\n<comparison>The session rewrote the options; the prompt documents them.</comparison>\n<rejected>phase</rejected>',
  )
  expect(taught.prompt).toContain('<verdict>aside</verdict>')
  expect(taught.prompt, 'no reasons with a past call').not.toContain('documentation is a stage')
  expect(taught.prompt.endsWith(briefing(log, 'now the docs'))).toBe(true)

  const criteria = JSON.parse(jevRequest(log, 'now the docs', t)).questions.belongs.criteria
  expect(criteria.phase.not).toEqual(['now update the README — The session rewrote the options; the prompt documents them.'])
  expect(criteria.phase.examples).toBe(undefined)
  expect(criteria.aside.examples).toEqual(['a name for a cat — The session fixes an export bug; the prompt is personal.'])
  expect(typeof criteria.same, 'a verdict with no calls keeps its plain meaning').toBe('string')
  expect(JSON.parse(jevRequest(log, 'now the docs', t)).questions.belongs.instructions.rules).toContain('- Releases are phase.')
})

test("the briefing opens with the session's first prompt once the record has let go of it", () => {
  const first = beatOf('you', 'write a parser for the config file')

  expect(briefing(remember(EMPTY, first), 'now the docs', first)).not.toContain('<start>')
  expect(briefing(remember(EMPTY, beatOf('you', 'and a test for it')), 'now the docs', first)).toContain(
    'The session began with:\n<start>\n[person] write a parser for the config file\n</start>',
  )
})

test("a line of Claude's names the files it changed", () => {
  expect(beatOf('claude', 'Done.', ['C:\\repo\\hooks\\model.ts', 'C:/repo/README.md', 'C:/repo/hooks/model.ts']).text).toBe(
    'Done. [changed: hooks/model.ts, repo/README.md]',
  )
  expect(beatOf('claude', '', ['C:/repo/a.ts']).text).toBe('[changed: repo/a.ts]')
  expect(beatOf('claude', 'Done.').text).toBe('Done.')
})

test("a judge's rules are drawn from its own mistakes first, with its reasons, and read one line each", () => {
  const right = labeled('write the docs', 'same', { at: 5, reason: 'the next step' })
  const wrong = labeled('order lunch', 'aside', { at: 1, truth: { not: 'aside' }, reason: 'food, not code' })
  const jevs = labeled('what is the capital of Peru', 'aside', { at: 2, judge: 'jev', truth: { not: 'aside' } })
  const named = labeled('now add a test', 'same', { at: 3, truth: { is: 'phase' } })
  const brief = lessonsBrief([right, wrong, jevs, named], { text: '- Docs are same.', upTo: 0 }, 'haiku')

  expect(brief).toContain('<rules>\n- Docs are same.\n</rules>')
  expect(brief.indexOf('order lunch')).toBeLessThan(brief.indexOf('write the docs'))
  expect(brief).toContain('<judged>aside</judged>\n<reason>food, not code</reason>\n<person>turned it down</person>')
  expect(brief).toContain('<person>bore it out</person>')
  expect(brief).toContain('<person>said it was phase</person>')
  expect(brief, "another judge's mistake is not this judge's lesson").not.toContain('Peru')
  expect(readLessons('Here are the rules:\n- Docs are same.\n* Lunch is aside.\nThat is all.')).toBe('- Docs are same.\n- Lunch is aside.')
  expect(readLessons('No rules today.')).toBe('')

  const mistakes = Array.from({ length: 10 }, (_, i) => labeled(`prompt ${i}`, 'aside', { at: i + 1, truth: { not: 'aside' } }))
  expect(isDue(mistakes, undefined, 'haiku')).toBe(true)
  expect(isDue(mistakes, undefined, 'jev'), "Jev's rules wait on Jev's mistakes").toBe(false)
  expect(isDue(mistakes, { text: '', upTo: 1 }, 'haiku'), 'nine since the last drawing').toBe(false)
  expect(isDue([right, ...mistakes.slice(1)], undefined, 'haiku'), 'a call borne out is no mistake').toBe(false)
})

test("Claude Haiku is shown the person's past calls and its rules from every scope", async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.store[HERE] = [labeled('write the docs for the parser', 'same')]
  w.store[EVERYWHERE] = [labeled('docs for the parser flags', 'phase', { at: 2 })]
  w.store[HERE_LESSONS] = { text: '- Docs for the code in hand are same.', upTo: 1 }
  w.store[EVERYWHERE_LESSONS] = { text: '- Geography is aside.', upTo: 1 }
  w.store['local:C:/repo:lessons:jev'] = { text: '- Only for Jev.', upTo: 1 }

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now write the docs for the parser')

  expect(w.briefings[0]).toContain('<prompt>write the docs for the parser</prompt>')
  expect(w.briefings[0]).toContain('<prompt>docs for the parser flags</prompt>')
  expect(w.systems[0], "this project's rules last, where they win").toContain('- Geography is aside.\n- Docs for the code in hand are same.')
  expect(w.systems[0], "another judge's rules").not.toContain('Only for Jev')
})

test('Jev is shown past calls from this project only', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.env = { TYPESAFE_API_KEY: 'sk-test' }
  w.store[HERE] = [labeled('write the docs for the parser', 'same')]
  w.store[EVERYWHERE] = [labeled('docs for the parser flags', 'phase', { at: 2 })]
  w.store['user:lessons:jev'] = { text: '- Geography is aside.', upTo: 1 }

  await $.session.start(SESSION)
  await runCommand($, 'jev')
  await say($, 'write a parser for the config file')
  await say($, 'now write the docs for the parser')

  const body = String(w.fetched[0]?.init?.body)
  expect(body).toContain('write the docs for the parser')
  expect(body, "another project's prompts never go to TypeSafe").not.toContain('docs for the parser flags')
  expect(body, 'rules quote no prompt, so every scope sends them').toContain('Geography is aside.')
})

test('a call the labels say is too doubtful to trust carries on without a pop-up', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  const call = (sure: number, isRight: boolean): Example =>
    labeled('a prompt', 'aside', { pick: 'aside', sure, truth: isRight ? { is: 'aside' } : { not: 'aside' } })
  w.store[HERE] = [...Array.from({ length: 10 }, (_, i) => call(0.6, i < 2)), ...Array.from({ length: 10 }, () => call(0.9, true))]
  w.verdicts = ['aside 60: a question about Peru', 'aside 95: a question about Chile']
  w.answers = [CARRY_ON_HERE]

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')

  expect(w.questions, 'too doubtful to interrupt').toEqual([])
  expect(JSON.stringify(await runCommand($, ''))).toContain('**same** (60% sure of aside)')

  await say($, 'and the capital of Chile?')

  expect(w.questions.length).toBe(1)
})

test("a judge's rules are drawn again after every ten of its mistakes, off a timer, and it reads them", async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.store[HERE] = Array.from({ length: 9 }, (_, i) => labeled(`prompt ${i}`, 'aside', { at: i + 1, truth: { not: 'aside' } }))
  w.verdicts = ['aside 90: a question about tests\nThe session is writing a parser; the prompt asks for a test of it.']
  w.answers = [NOT_ASIDE]
  w.lessons = ['Rules:\n- Tests for the code in hand are same.']

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await say($, 'now add a test for it')

  expect(w.drawn, 'never while a prompt waits').toEqual([])

  await clock.advance(SETTLED_MS)

  expect(w.drawn.length).toBe(1)
  expect(w.store[HERE_LESSONS]).toEqual({ text: '- Tests for the code in hand are same.', upTo: 1_000 })

  await say($, 'and one for blank lines')
  await clock.advance(SETTLED_MS)

  expect(w.systems[1]).toContain('- Tests for the code in hand are same.')
  expect(w.drawn.length, 'no mistake since').toBe(1)
})

test("a label still waiting on a comparison is explained before its judge's rules are drawn", async ($, on) => {
  const w = worldOf(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.env = { TYPESAFE_API_KEY: 'sk-test' }
  const waiting = labeled('order lunch', 'aside', {
    at: 1,
    judge: 'jev',
    truth: { not: 'aside' },
    comparison: undefined,
    session: [{ who: 'you', text: 'fix the export bug' }],
  })
  const explained = Array.from({ length: 8 }, (_, i) =>
    labeled(`prompt ${i}`, 'aside', { at: i + 2, judge: 'jev', truth: { not: 'aside' } }),
  )
  w.store[HERE] = [waiting, ...explained]
  w.jev = [jevSays('aside', 0.9)]
  w.answers = [NOT_ASIDE]
  w.lessons = ['- Food is aside.']

  await $.session.start(SESSION)
  await runCommand($, 'jev')
  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')
  await clock.advance(SETTLED_MS)
  await clock.advance(SETTLED_MS)

  expect(w.explained.length, 'the new label, then the one left waiting').toBe(2)
  expect(labelsIn(w, HERE).every(x => x.comparison !== undefined && x.session === undefined)).toBe(true)
  expect(w.store['local:C:/repo:lessons:jev']).toEqual({ text: '- Food is aside.', upTo: 1_000 })
  expect(w.store[HERE_LESSONS], "Claude Haiku's rules wait on its own mistakes").toBe(undefined)
})

test('learn says where new labels go, and sends them there', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.verdicts = [
    'aside 90: Peru\nThe session is writing a parser; the prompt asks about Peru.',
    'aside 90: Chile\nThe session is writing a parser; the prompt asks about Chile.',
  ]
  w.answers = [NOT_ASIDE, NOT_ASIDE]

  await $.session.start(SESSION)
  expect(JSON.stringify(await runCommand($, 'learn'))).toContain('kept for this project')
  expect(JSON.stringify(await runCommand($, 'learn user'))).toContain('kept for every project')

  await say($, 'write a parser for the config file')
  await say($, 'what is the capital of Peru?')

  expect(labelsIn(w, EVERYWHERE).map(x => x.prompt)).toEqual(['what is the capital of Peru?'])

  expect(JSON.stringify(await runCommand($, 'learn off'))).toContain('not kept')
  await say($, 'and the capital of Chile?')

  expect(labelsIn(w, EVERYWHERE).length).toBe(1)
  expect(w.store[HERE]).toBe(undefined)
  expect(JSON.stringify(await runCommand($, 'was aside')), 'a correction is kept all the same').toContain('Noted for this project')
  expect(labelsIn(w, HERE).map(gist)).toEqual([['and the capital of Chile?', 'aside', { is: 'aside' }, 'was']])
  expect(JSON.stringify(await runCommand($, 'learn sideways'))).toContain('Usage')
})

test('lessons shows what each scope has taught the judge in charge', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  w.store[HERE] = [
    labeled('write the docs', 'same'),
    labeled('order lunch', 'aside', { truth: { not: 'aside' } }),
    labeled('rename it', 'same', { comparison: undefined, session: [] }),
  ]
  w.store[HERE_LESSONS] = { text: '- Lunch is aside.', upTo: 1 }

  await $.session.start(SESSION)
  const both = JSON.stringify(await runCommand($, 'lessons'))

  expect(both).toContain("**This project**: 3 labels, 1 of them Claude Haiku's mistakes, 1 awaiting a comparison.")
  expect(both).toContain('Claude Haiku must be this sure to interrupt: 0% (too few calls to say; the default)')
  expect(both).toContain("Claude Haiku's rules:")
  expect(both).toContain('- Lunch is aside.')
  expect(both).toContain('**Every project**: 0 labels')
  expect(JSON.stringify(await runCommand($, 'lessons user'))).not.toContain('This project')
})

test("promote copies this project's labels to every project's, and forget lets a scope go", async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })
  const docs = labeled('write the docs', 'same', { at: 1 })
  w.store[HERE] = [docs, labeled('order lunch', 'aside', { at: 2 })]
  w.store[EVERYWHERE] = [docs]
  w.store[HERE_LESSONS] = { text: '- Lunch is aside.', upTo: 2 }
  w.store['local:C:/repo:lessons:jev'] = { text: '- Lunch is aside.', upTo: 2 }

  await $.session.start(SESSION)
  expect(JSON.stringify(await runCommand($, 'promote'))).toContain('Copied 1 label from this project')
  expect(labelsIn(w, EVERYWHERE).map(x => x.prompt)).toEqual(['write the docs', 'order lunch'])

  expect(JSON.stringify(await runCommand($, 'forget')), 'which scope is never guessed').toContain('Usage')
  expect(JSON.stringify(await runCommand($, 'forget local'))).toContain('Forgot every label and rule kept for this project')
  expect(w.store[HERE]).toBe(undefined)
  expect(w.store[HERE_LESSONS]).toBe(undefined)
  expect(w.store['local:C:/repo:lessons:jev']).toBe(undefined)
  expect(labelsIn(w, EVERYWHERE).length).toBe(2)
})

test('the labels of a project nobody has opened for 90 days are let go', async ($, on) => {
  const w = worldOf(on)
  const DAY = 24 * 60 * 60 * 1000
  mock.clock(on, { now: 100 * DAY })
  w.store.projects = { 'C:/old': 5 * DAY, 'C:/recent': 50 * DAY }
  w.store['local:C:/old:examples'] = [labeled('order lunch', 'aside')]
  w.store['local:C:/old:lessons:haiku'] = { text: '- Lunch is aside.', upTo: 1 }
  w.store['local:C:/recent:examples'] = [labeled('order lunch', 'aside')]
  w.store['local:C:/untracked:examples'] = [labeled('order lunch', 'aside')]

  await $.session.start(SESSION)

  expect(w.store['local:C:/old:examples']).toBe(undefined)
  expect(w.store['local:C:/old:lessons:haiku']).toBe(undefined)
  expect(w.store['local:C:/recent:examples']).toBeDefined()
  expect(w.store['local:C:/untracked:examples'], 'labels kept before projects were tracked count as opened now').toBeDefined()
  expect(w.store.projects).toEqual({ 'C:/recent': 50 * DAY, 'C:/untracked': 100 * DAY, 'C:/repo': 100 * DAY })
})

test("the judge is reminded of the session's first prompt once the record lets go of it", async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  for (let i = 1; i <= 13; i += 1) await say($, `and handle case number ${i}`)

  expect(w.briefings[0]).not.toContain('<start>')
  expect(w.briefings.at(-1)).toContain('<start>\n[person] write a parser for the config file\n</start>')
})

test('the files Claude changed are remembered with its answer', async ($, on) => {
  const w = worldOf(on)
  mock.clock(on, { now: 1_000 })

  await $.session.start(SESSION)
  await say($, 'write a parser for the config file')
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/src/parser.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/repo/src/parser.test.ts', content: 'x' })
  await $.turn.complete({
    answer: 'Done: the parser reads every line.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await say($, 'now add a test for it')

  expect(w.briefings[0]).toContain('[claude] Done: the parser reads every line. [changed: src/parser.ts, src/parser.test.ts]')
})
