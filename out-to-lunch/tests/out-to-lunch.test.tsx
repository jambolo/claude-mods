import type { On, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { EMPTY, addJob, breakdown, briefing, diagnose, endJob, endTurn, patchJob, report, settle, startTurn } from '../hooks/model'
import type { Live } from '../types'

const band = (isWorking: boolean) => ({
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
})

const runCommand = ($: Engine, args: string) =>
  $.command.run({
    command: 'out-to-lunch',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

// Stands for the engine's own band, which the mod's hook falls through to when it draws nothing.
const drawEngineBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

// With a turn running and no job in flight, the mod's band leads with "Between steps".
async function isBandShown($: Engine): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: 'out-to-lunch', surface: 'terminal', ...band(true) })
  const found = await ui.find({ type: 'Text', text: /Between steps/ })
  await ui.unmount()
  return found !== undefined
}

// What the plugin's change() does: charge elapsed time, apply, re-read the phase.
const step = (l: Live, now: number, fn: (l: Live) => Live) => settle(fn(settle(l, now)), now)

test('time is charged to the phase it was spent in', () => {
  let l = startTurn(EMPTY, 't', 0)
  l = step(l, 0, x => addJob(x, { id: 's', kind: 'request', label: 'Model step 1' }, 0))
  l = step(l, 4_000, x => endJob(x, 's', 4_000))
  l = step(l, 4_000, x => addJob(x, { id: 'tool:1', kind: 'tool', tool: 'Bash', label: 'Bash: ls' }, 4_000))
  expect(breakdown(l.turn!, 10_000)).toEqual([
    ['tools', 6_000],
    ['latency', 4_000],
  ])
})

test('a slow build command is named, with why', () => {
  let l = startTurn(EMPTY, 't', 0)
  l = step(l, 1_000, x => addJob(x, { id: 'tool:1', kind: 'tool', tool: 'Bash', label: 'Bash: npm test' }, 1_000))
  const d = diagnose(l, 95_000)
  expect(d.headline).toBe('Bash: npm test')
  expect(d.tone).toBe('warn')
  expect(d.reasons[0]).toContain('Build, test and install')
})

test('an open permission prompt outranks everything else', () => {
  let l = startTurn(EMPTY, 't', 0)
  l = step(l, 0, x => addJob(x, { id: 'tool:1', kind: 'tool', tool: 'Bash', label: 'Bash: rm -rf build' }, 0))
  l = step(l, 0, x => addJob(x, { id: 'step:a', kind: 'thinking', label: 'Model step 1', agentId: 'a' }, 0))
  l = step(l, 2_000, x => patchJob(x, 'tool:1', { kind: 'approval' }, 2_000))
  const d = diagnose(l, 30_000)
  expect(d.tone).toBe('you')
  expect(d.headline).toBe('Waiting for your approval: Bash: rm -rf build')
  expect(breakdown(l.turn!, 30_000)).toEqual([
    ['you', 28_000],
    ['tools', 2_000],
  ])
})

test('a long wait for the first token points at the API and the context', () => {
  let l = startTurn(EMPTY, 't', 0)
  l = {
    ...l,
    turn: l.turn && { ...l.turn, usage: { input: 2_000, cacheRead: 0, cacheWrite: 150_000, output: 300 } },
  }
  l = step(l, 0, x => addJob(x, { id: 's', kind: 'request', label: 'Model step 2', effort: 'max' }, 0))
  const d = diagnose(l, 25_000)
  expect(d.tone).toBe('warn')
  expect(d.reasons.join(' ')).toContain('rate-limited')
  expect(d.reasons.join(' ')).toContain('~152k tokens')
  expect(d.reasons.join(' ')).toContain('missed the prompt cache')
  expect(d.reasons.join(' ')).toContain('"max"')
})

test('/out-to-lunch reports the live activity mid-turn and a summary after', () => {
  let l = startTurn(EMPTY, 't', 0)
  l = step(l, 0, x => addJob(x, { id: 'tool:1', kind: 'tool', tool: 'WebFetch', label: 'Fetching example.com' }, 0))
  const during = report(l, 42_000)
  expect(during).toContain('**Fetching example.com** · 42s')
  expect(during).toContain('- Waiting on the network.')

  l = step(l, 50_000, x => endJob(x, 'tool:1', 50_000))
  l = endTurn(l, 50_000, false)
  expect(report(l, 60_000)).toContain('Idle. Last turn took 50s: tools 100%')
  expect(report(l, 60_000)).toContain('Slowest: Fetching example.com (50s)')
})

test('the band starts off, /out-to-lunch on shows it and off hides it again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  drawEngineBand(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5_000)
  expect(await isBandShown($)).toBe(false)

  await runCommand($, 'on')
  expect(await isBandShown($)).toBe(true)

  await runCommand($, 'off')
  const ui = await $.ui.mount({ plugin: 'out-to-lunch', surface: 'terminal', ...band(true) })
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
  expect(await isBandShown($)).toBe(false)

  await runCommand($, 'on')
  expect(await isBandShown($)).toBe(true)
})

test('/out-to-lunch on <seconds> holds the band back until the turn has run that long', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  drawEngineBand(on)

  expect(JSON.stringify(await runCommand($, 'on 20'))).toContain('once a turn has run 20s')
  await $.turn.start({ text: 'go', turnId: 't1' })

  await clock.advance(10_000)
  expect(await isBandShown($)).toBe(false)
  await clock.advance(15_000)
  expect(await isBandShown($)).toBe(true)

  await runCommand($, 'on')
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(await isBandShown($)).toBe(true)

  expect(JSON.stringify(await runCommand($, 'on soon'))).toContain('Usage')
})

test('the band stays hidden while the pane is open, past the delay too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  drawEngineBand(on)
  // Stands for the engine's pane record.
  let panes: UiPane[] = []
  on('ui.open', ($, e) => {
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: panes }))

  await runCommand($, 'pane')
  expect(JSON.stringify(await runCommand($, 'on 20'))).toContain('stays hidden while the pane is open')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(25_000)
  expect(await isBandShown($)).toBe(false)

  panes = []
  expect(await isBandShown($)).toBe(true)

  await runCommand($, 'on')
  await runCommand($, 'pane')
  expect(await isBandShown($)).toBe(false)
})

test('the band shows the running tool and its elapsed time', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => {
    await clock.sleep(90_000)
    return { result: {} }
  })

  await runCommand($, 'on')
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(75_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'out-to-lunch', surface, ...band(true) })
    expect(await ui.find({ type: 'Text', text: 'Bash: npm test' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1m15s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waits for the command to exit/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(15_000)
  await running
})

test('the briefing carries the measurements and the output tail', () => {
  let l = startTurn(EMPTY, 't', 0)
  l = step(l, 1_000, x => addJob(x, { id: 'tool:1', kind: 'tool', tool: 'Grep', label: 'Grep: TODO in C:/' }, 1_000))
  const text = briefing(l, 40_000, diagnose(l, 40_000), '[thinking]\nSearching the whole drive for TODO.')
  expect(text).toContain('Current delay: Grep: TODO in C:/, for 39s.')
  expect(text).toContain('Grep: TODO in C:/: tool, 39s')
  expect(text).toContain('<output>\n[thinking]\nSearching the whole drive for TODO.\n</output>')
})

// A running turn with one slow Bash call after the given commands, the model mocked; returns the prompts the mod sent.
async function slowTurn($: Engine, on: On, commands: string[]) {
  const clock = mock.clock(on, { now: 1_000 })
  const prompts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('model.complete', ($, e) => {
    prompts.push(String(e.prompt))
    const usage = { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: 'The npm test suite\n is slow.', usage } }
  })
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: {} }
  })

  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  for (const args of commands) await runCommand($, args)
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(30_000)
  return { prompts, finish: async () => (await clock.advance(30_000), await running) }
}

test('/out-to-lunch best-guess on warns that it uses tokens', async $ => {
  expect(JSON.stringify(await runCommand($, 'best-guess on'))).toContain('Warning: this uses tokens')
  expect(JSON.stringify(await runCommand($, 'best-guess'))).toContain('Best guess is on')
  expect(JSON.stringify(await runCommand($, 'best-guess off'))).toContain('Best guess off')
})

test('with best guess on, a delay past 20s gets one AI guess, shown in the band and the report', async ($, on) => {
  const turn = await slowTurn($, on, ['on', 'best-guess on'])
  expect(turn.prompts.length).toBe(1)
  expect(turn.prompts[0]).toContain('Bash: npm test')

  const ui = await $.ui.mount({ plugin: 'out-to-lunch', surface: 'terminal', ...band(true) })
  expect(await ui.find({ type: 'Text', text: /Likely: The npm test suite is slow\./ })).toBeDefined()
  await ui.unmount()
  expect(JSON.stringify(await runCommand($, ''))).toContain('Likely (AI): The npm test suite is slow.')
  await turn.finish()
})

test('best guess is off by default', async ($, on) => {
  const turn = await slowTurn($, on, ['on'])
  expect(turn.prompts.length).toBe(0)
  await turn.finish()
})

test('no AI guess is asked for while nothing can show it', async ($, on) => {
  const turn = await slowTurn($, on, ['best-guess on'])
  expect(turn.prompts.length).toBe(0)
  await turn.finish()
})
