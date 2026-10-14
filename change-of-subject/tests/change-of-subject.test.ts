import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  CARRY_ON_HERE,
  COMPACT_FIRST,
  EMPTY,
  NEW_SESSION,
  USE_BTW,
  beatOf,
  briefing,
  isWorthJudging,
  readVerdict,
  remember,
  report,
} from '../hooks/model'

const SESSION = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }
const USAGE = { input_tokens: 500, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// Long enough to pass the delay the mod waits before it runs a command in a prompt's place.
const SETTLED_MS = 400

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
}

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
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'the-session-left-behind' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  on('model.complete', ($, e) => {
    w.briefings.push(String(e.prompt))
    const said = w.verdicts.shift() ?? 'same'
    // A queued 'throw' stands for a judge that is not there.
    if (said === 'throw') throw new Error('no model today')

    return { value: { isAnswered: true as const, text: said, usage: USAGE } }
  })

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
  expect(readVerdict('aside: a question about tea.')).toEqual({ verdict: 'aside', reason: 'a question about tea' })
  expect(readVerdict('PHASE — the release, not the parser')).toEqual({
    verdict: 'phase',
    reason: 'the release, not the parser',
  })
  expect(readVerdict('same')).toEqual({ verdict: 'same', reason: '' })
  expect(readVerdict('I think this one is unrelated')).toEqual({ verdict: 'same', reason: '' })
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

  expect(report(true, 0, null, EMPTY)).toContain('Watching every prompt')
  expect(report(false, 0, null, EMPTY)).toContain('Not watching')
  expect(report(true, 1, { verdict: 'phase', reason: 'the release' }, log)).toContain('1 prompt judged')
  expect(report(true, 1, { verdict: 'phase', reason: 'the release' }, log)).toContain('**phase**: the release')
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

  await $.session.end({ reason: 'clear' })
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
})
