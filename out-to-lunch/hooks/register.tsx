import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

import type { JobKind, Live } from '../types'
import {
  BUCKET_LABEL,
  EMPTY,
  addAgent,
  addJob,
  breakdown,
  describeTool,
  diagnose,
  doing,
  dropAgent,
  endJob,
  endTurn,
  fmt,
  isBusy,
  patchJob,
  primary,
  report,
  settle,
  shares,
  startTurn,
  toUsage,
} from './model'

const PANE = 'out-to-lunch'
const TITLE = 'Why so slow?'
const live = atom({ plugin: 'out-to-lunch', key: 'live' } as const, EMPTY)
const dismissed = atom({ plugin: 'out-to-lunch', key: 'dismissed' } as const, null)
const isHidden = atom({ plugin: 'out-to-lunch', key: 'isHidden' } as const, true)
const delaySeconds = atom({ plugin: 'out-to-lunch', key: 'delaySeconds' } as const, 0)
const USAGE = 'Usage: `/out-to-lunch [pane | off | on [seconds]]`'
// The summary of a finished turn shows only for turns at least this long.
const SUMMARY_MS = 30_000

// Per-chunk counts stay out of $.state; the 1s tick copies them in.
const streamed = new Map<string, number>()
const knownAgents = new Set<string>()

async function change($: EngineInterface, fn: (l: Live, now: number) => Live): Promise<void> {
  try {
    const now = await $.clock.now()
    await update($, live, l => settle(fn(settle(l, now), now), now))
  } catch {
    // Tracking must never break the turn it watches.
  }
}

async function tick($: EngineInterface): Promise<void> {
  try {
    if (!isBusy(await read($, live))) return
    const now = await $.clock.now()
    await update($, live, l =>
      settle({ ...l, jobs: l.jobs.map(j => ({ ...j, chars: streamed.get(j.id) ?? j.chars })) }, now),
    )
  } catch {
    // Next tick retries.
  }
}

async function noteAgent($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId === undefined || knownAgents.has(agentId)) return
  knownAgents.add(agentId)
  let label = `agent ${agentId.slice(0, 8)}`
  try {
    const info = (await $.agent.list()).find(a => a.id === agentId)
    if (info) label = `${info.type}: ${info.description}`
  } catch {
    // Keep the id-based label.
  }
  await change($, (l, now) => addAgent(l, { id: agentId, label, startedAt: now }))
}

function measure(chunk: TurnStepChunk): { kind: JobKind; chars: number; tool?: string } | undefined {
  switch (chunk.kind) {
    case 'thinking':
      return { kind: 'thinking', chars: chunk.text.length }
    case 'text':
      return { kind: 'writing', chars: chunk.text.length }
    case 'tool':
      return { kind: 'tool-input', chars: 0, tool: chunk.name }
    case 'input':
      return { kind: 'tool-input', chars: chunk.json.length }
    default:
      return undefined
  }
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  // The band reads the engine's pane list, which no $.state write announces.
  $.ui.invalidate('ui.render')
  return opened
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'out-to-lunch',
      description: 'What Claude is doing right now and why it is taking long (works mid-turn)',
      argumentHint: '[pane|off|on [seconds]]',
      immediate: true,
    })
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'out-to-lunch' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await update($, isHidden, () => true)

      return { text: 'Band hidden. `/out-to-lunch on` shows it again.' }
    }

    const turnOn = /^on(?:\s+(\d+(?:\.\d+)?)s?)?$/i.exec(arg)
    if (turnOn) {
      const delay = Number(turnOn[1] ?? 0)
      await update($, isHidden, () => false)
      await update($, delaySeconds, () => delay)
      const text = delay > 0 ? `Band shown once a turn has run ${fmt(delay * 1000)}.` : 'Band shown.'

      return { text: (await isPaneShown($)) ? `${text} It stays hidden while the pane is open.` : text }
    }

    if (arg !== '' && arg !== 'pane') return { text: USAGE }

    const text = report(await read($, live), await $.clock.now())
    if (arg === '') return { text }

    const opened = await openPane($)

    return { text: opened.isPlaced ? text : `${text}\n\n(Pane not shown: ${opened.reason})` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    $.ui.invalidate('ui.render')
    return closed
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      knownAgents.clear()
      await change($, () => EMPTY)
    }

    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const mode = e.permission_mode
    if (mode !== undefined) await change($, l => ({ ...l, mode }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await change($, (l, now) => startTurn(l, e.turnId, now))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      knownAgents.delete(agentId)
      await change($, l => dropAgent(l, agentId))
    } else {
      await change($, (l, now) => endTurn(l, now, e.isAborted))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = `step:${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    await noteAgent($, e.agentId)
    await change($, (l, now) => {
      const added = addJob(
        l,
        {
          id,
          kind: 'request',
          label: `Model step ${e.index + 1}`,
          agentId: e.agentId,
          messages: e.messageCount,
          effort: e.effort === undefined ? undefined : String(e.effort),
        },
        now,
      )
      const t = added.turn
      return e.agentId === undefined && t ? { ...added, turn: { ...t, steps: Math.max(t.steps, e.index + 1) } } : added
    })

    let kind: JobKind = 'request'
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const piece = measure(chunk)
        if (piece !== undefined) {
          if (piece.kind !== kind || piece.tool !== undefined) {
            kind = piece.kind
            streamed.set(id, piece.chars)
            const patch = piece.tool === undefined ? { kind, chars: piece.chars } : { kind, chars: 0, tool: piece.tool }
            await change($, (l, now) => patchJob(l, id, patch, now))
          } else {
            streamed.set(id, (streamed.get(id) ?? 0) + piece.chars)
          }
        }
        yield chunk
      }
      const result = await stream.result
      if (e.agentId === undefined && result.usage) {
        const usage = toUsage(result.usage)
        await change($, l => (l.turn ? { ...l, turn: { ...l.turn, usage } } : l))
      }
    } finally {
      streamed.delete(id)
      await change($, (l, now) => endJob(l, id, now))
    }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const id = `tool:${e.tool_use_id}`
    const timeout = input['timeout']
    await noteAgent($, e.agentId)
    await change($, (l, now) =>
      addJob(
        l,
        {
          id,
          kind: 'tool',
          tool: String(e.tool),
          label: describeTool(String(e.tool), input),
          agentId: e.agentId,
          timeoutMs: typeof timeout === 'number' ? timeout : undefined,
        },
        now,
      ),
    )
    try {
      return await next(e)
    } finally {
      await change($, (l, now) => endJob(l, id, now))
    }
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      const id = `tool:${e.tool_use_id}`
      await change($, (l, now) => patchJob(l, id, { kind: 'review' }, now))
    }

    return verdict
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer?.decision === undefined) {
      const mode = e.permission_mode
      await change($, (l, now) => {
        const job = l.jobs
          .filter(j => j.tool === e.tool_name && j.agentId === e.agent_id && (j.kind === 'review' || j.kind === 'tool'))
          .pop()
        const marked = job ? patchJob(l, job.id, { kind: 'approval' }, now) : l
        return mode === undefined ? marked : { ...marked, mode }
      })
    }

    return answer
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const id = `compact:${e.agentId ?? 'main'}`
    await change($, (l, now) => addJob(l, { id, kind: 'compact', label: 'Compacting', agentId: e.agentId }, now))
    try {
      return await next(e)
    } finally {
      await change($, (l, now) => endJob(l, id, now))
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden)) || (await isPaneShown($))) return next(e)

    const l = await read($, live)
    const t = l.turn
    if (t === null) return next(e)

    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const details = <Button key="details" label="Details" onPress={() => openPane($)} />

    const delayMs = (await read($, delaySeconds)) * 1000

    if (e.props.isWorking && t.endedAt === undefined) {
      if (now - t.startedAt < delayMs) return next(e)

      const d = diagnose(l, now)
      const color = d.tone === 'you' ? 'permission' : d.tone === 'warn' ? 'warning' : 'claude'

      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color} bold wrap="truncate-end">
              {d.headline}
            </Text>
            <Text dimColor> · {fmt(now - d.since)}</Text>
          </Box>
          {d.reasons.slice(0, 2).map(reason => (
            <Text dimColor wrap="truncate-end">
              ↳ {reason}
            </Text>
          ))}
          <Box>
            <Text dimColor wrap="truncate-end">
              turn {fmt(now - t.startedAt)} · step {t.steps} · {t.tools} tools · {shares(t, now, 3)}{' '}
            </Text>
            {details}
          </Box>
        </Box>
      )
    }

    const took = (t.endedAt ?? now) - t.startedAt
    const isShort = took < Math.max(SUMMARY_MS, delayMs)
    if (e.props.isWorking || isShort || (await read($, dismissed)) === t.id) return next(e)

    const slowest = t.slowest && t.slowest.ms >= 5000 ? ` · slowest: ${t.slowest.label} ${fmt(t.slowest.ms)}` : ''

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          Last turn {fmt(took)}: {shares(t, now, 3)}
          {slowest}{' '}
        </Text>
        {details}
        <Button key="dismiss" label="x" onPress={() => update($, dismissed, () => t.id)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, live)
    const now = await $.clock.now()
    const t = l.turn

    if (t === null) {
      return <Text dimColor>Nothing has run yet. This pane fills in once Claude starts a turn.</Text>
    }

    const isRunning = t.endedAt === undefined
    const end = t.endedAt ?? now
    const total = Math.max(1, end - t.startedAt)
    const d = isRunning ? diagnose(l, now) : undefined
    const slowest = l.log
      .filter(x => x.at >= t.startedAt && x.agentId === undefined)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 6)
    const barWidth = Math.max(5, Math.min(30, e.props.bodyColumns - 32))

    return (
      <Box flexDirection="column">
        <Text bold>Now</Text>
        {d ? (
          <Box flexDirection="column">
            <Text color={d.tone === 'you' ? 'permission' : d.tone === 'warn' ? 'warning' : 'claude'}>
              {d.headline} · {fmt(now - d.since)}
            </Text>
            {d.reasons.map(reason => (
              <Text dimColor>↳ {reason}</Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>Idle.</Text>
        )}
        {l.agents.map(a => (
          <Text dimColor wrap="truncate-end">
            {a.label}: {doing(primary(l.jobs, a.id))} ({fmt(now - a.startedAt)})
          </Text>
        ))}
        <Text> </Text>
        <Text bold>
          {isRunning ? 'This turn' : 'Last turn'}: {fmt(total)} · {t.steps} model steps · {t.tools} tool calls
        </Text>
        {breakdown(t, end).map(([bucket, ms]) => (
          <Text>
            {BUCKET_LABEL[bucket].padEnd(18)} {'█'.repeat(Math.max(1, Math.round((ms / total) * barWidth))).padEnd(barWidth)}{' '}
            {fmt(ms)}
          </Text>
        ))}
        {t.usage && (
          <Text dimColor>
            Last request: {Math.round((t.usage.input + t.usage.cacheRead + t.usage.cacheWrite) / 1000)}k tokens in (
            {Math.round(t.usage.cacheRead / 1000)}k from cache), {t.usage.output} out
          </Text>
        )}
        <Text> </Text>
        <Text bold>Slowest this turn</Text>
        {slowest.length === 0 && <Text dimColor>Nothing finished yet.</Text>}
        {slowest.map(x => (
          <Text wrap="truncate-end">
            {fmt(x.ms).padStart(6)} {x.label}
          </Text>
        ))}
      </Box>
    )
  })
}
