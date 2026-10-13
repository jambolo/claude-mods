import type { Agent, Bucket, Done, Job, JobKind, Live, Phase, Turn, Usage } from '../types'

export const EMPTY: Live = { now: 0, jobs: [], agents: [], turn: null, log: [] }

// Earlier wins: what blocks the loop outranks what merely streams.
const PRIORITY: readonly JobKind[] = [
  'approval',
  'review',
  'tool',
  'compact',
  'tool-input',
  'writing',
  'thinking',
  'request',
]

const BUCKET: Record<Phase, Bucket> = {
  request: 'latency',
  thinking: 'thinking',
  writing: 'output',
  'tool-input': 'output',
  tool: 'tools',
  // No event marks a verdict's end, so a reviewed call's run counts as tool time.
  review: 'tools',
  approval: 'you',
  compact: 'compact',
  engine: 'engine',
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  latency: 'API wait',
  thinking: 'thinking',
  output: 'writing',
  tools: 'tools',
  you: 'permission prompt',
  compact: 'compacting',
  engine: 'overhead',
}

const ZERO: Record<Bucket, number> = {
  latency: 0,
  thinking: 0,
  output: 0,
  tools: 0,
  you: 0,
  compact: 0,
  engine: 0,
}

const LOG_SIZE = 50
const SLOW_COMMAND =
  /\b(test|build|install|compile|cargo|npm|pnpm|yarn|bun|pip|uv|poetry|make|cmake|msbuild|dotnet|gradle|mvn|docker|pytest|jest|vitest|tsc|webpack|vite|go)\b/i

export function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function size(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function describeTool(tool: string, input: Record<string, unknown>): string {
  const command = str(input, 'command')
  const path = str(input, 'file_path') ?? str(input, 'notebook_path') ?? str(input, 'path')
  const pattern = str(input, 'pattern')
  if (tool === 'Agent' || tool === 'Task') {
    const kind = str(input, 'subagent_type')
    return `Subagent: ${clip(str(input, 'description') ?? 'task', 50)}${kind ? ` (${kind})` : ''}`
  }
  if (command) return `${tool}: ${clip(command, 70)}`
  if (tool === 'WebFetch') return `Fetching ${clip(str(input, 'url') ?? '', 60)}`
  if (tool === 'WebSearch') return `Web search: ${clip(str(input, 'query') ?? '', 60)}`
  if (pattern) return `${tool} "${clip(pattern, 50)}"`
  if (path) return `${tool} ${baseName(path)}`
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[1]} › ${mcp[2]}`
  return tool
}

export function toUsage(u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): Usage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
}

export function primary(jobs: readonly Job[], agentId?: string): Job | undefined {
  return jobs
    .filter(j => j.agentId === agentId)
    .sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.startedAt - b.startedAt)[0]
}

export function isBusy(l: Live): boolean {
  return (l.turn !== null && l.turn.endedAt === undefined) || l.jobs.length > 0
}

/** Charges the time since the last change to the main loop's phase, then re-reads the phase. */
export function settle(l: Live, now: number): Live {
  const t = l.turn
  if (t === null || t.endedAt !== undefined) return { ...l, now }
  const bucket = BUCKET[t.phase]
  const spent = { ...t.spent, [bucket]: t.spent[bucket] + Math.max(0, now - t.phaseAt) }
  const phase = primary(l.jobs)?.kind ?? 'engine'
  return { ...l, now, turn: { ...t, spent, phase, phaseAt: Math.max(now, t.phaseAt) } }
}

export function startTurn(l: Live, id: string, now: number): Live {
  const turn: Turn = { id, startedAt: now, steps: 0, tools: 0, phase: 'engine', phaseAt: now, spent: { ...ZERO } }
  return { ...l, now, jobs: l.jobs.filter(j => j.agentId !== undefined), turn }
}

export function endTurn(l: Live, now: number, isAborted: boolean): Live {
  const settled = settle(l, now)
  const turn = settled.turn && { ...settled.turn, endedAt: now }
  return isAborted
    ? { ...settled, turn, jobs: [], agents: [] }
    : { ...settled, turn, jobs: settled.jobs.filter(j => j.agentId !== undefined) }
}

export function addJob(l: Live, job: Omit<Job, 'startedAt' | 'phaseAt' | 'chars'>, now: number): Live {
  const full: Job = { ...job, startedAt: now, phaseAt: now, chars: 0 }
  let turn = l.turn
  if (turn && turn.endedAt === undefined && job.agentId === undefined && job.kind === 'tool') {
    turn = { ...turn, tools: turn.tools + 1 }
  }
  return { ...l, turn, jobs: [...l.jobs.filter(j => j.id !== job.id), full] }
}

export function patchJob(l: Live, id: string, patch: Partial<Job>, now: number): Live {
  return {
    ...l,
    jobs: l.jobs.map(j => (j.id !== id ? j : { ...j, ...patch, phaseAt: patch.kind && patch.kind !== j.kind ? now : j.phaseAt })),
  }
}

export function endJob(l: Live, id: string, now: number, label?: string): Live {
  const job = l.jobs.find(j => j.id === id)
  if (!job) return l
  const done: Done = {
    label: label ?? job.label,
    kind: job.tool && job.kind !== 'tool-input' ? 'tool' : job.kind,
    ms: now - job.startedAt,
    at: now,
    agentId: job.agentId,
  }
  let turn = l.turn
  if (turn && turn.endedAt === undefined && job.agentId === undefined && (!turn.slowest || done.ms > turn.slowest.ms)) {
    turn = { ...turn, slowest: { label: done.label, ms: done.ms } }
  }
  return { ...l, turn, jobs: l.jobs.filter(j => j.id !== id), log: [...l.log, done].slice(-LOG_SIZE) }
}

export function addAgent(l: Live, agent: Agent): Live {
  return l.agents.some(a => a.id === agent.id) ? l : { ...l, agents: [...l.agents, agent] }
}

export function dropAgent(l: Live, id: string): Live {
  return { ...l, agents: l.agents.filter(a => a.id !== id), jobs: l.jobs.filter(j => j.agentId !== id) }
}

/** Time per bucket for a turn, the phase in progress counted up to `now`. */
export function breakdown(t: Turn, now: number): [Bucket, number][] {
  const spent = { ...t.spent }
  if (t.endedAt === undefined) spent[BUCKET[t.phase]] += Math.max(0, now - t.phaseAt)
  return (Object.entries(spent) as [Bucket, number][]).filter(([, ms]) => ms >= 500).sort((a, b) => b[1] - a[1])
}

export function shares(t: Turn, now: number, count = 4): string {
  const parts = breakdown(t, now)
  const total = parts.reduce((sum, [, ms]) => sum + ms, 0) || 1
  return parts
    .slice(0, count)
    .map(([b, ms]) => `${BUCKET_LABEL[b]} ${Math.round((ms / total) * 100)}%`)
    .join(' · ')
}

export function doing(job: Job | undefined): string {
  if (!job) return 'starting'
  switch (job.kind) {
    case 'request':
      return 'waiting for the model'
    case 'thinking':
      return 'thinking'
    case 'writing':
      return 'writing'
    case 'tool-input':
      return `preparing ${job.tool ?? 'a tool call'}`
    case 'review':
      return `permission check for ${job.label}`
    case 'approval':
      return `needs your approval for ${job.label}`
    case 'compact':
      return 'compacting'
    case 'tool':
      return job.label
  }
}

export type Tone = 'normal' | 'warn' | 'you'

export type Diagnosis = {
  headline: string
  since: number
  tone: Tone
  reasons: string[]
}

function contextReasons(l: Live, reasons: string[]): void {
  const u = l.turn?.usage
  if (!u) return
  const context = u.input + u.cacheRead + u.cacheWrite
  if (context >= 100_000) reasons.push(`Large context: ~${Math.round(context / 1000)}k tokens are re-read on every request.`)
  if (context >= 20_000 && u.cacheRead < context / 2) {
    reasons.push('The last request missed the prompt cache, so the whole context was reprocessed.')
  }
}

function effortReason(job: Job, reasons: string[]): void {
  if (job.effort && /^(high|xhigh|max)$/.test(job.effort)) {
    reasons.push(`Effort is "${job.effort}": the model thinks longer before answering.`)
  }
}

function toolReasons(l: Live, job: Job, age: number, now: number, reasons: string[]): void {
  const tool = job.tool ?? ''
  if (tool === 'Agent' || tool === 'Task') {
    const agents = l.agents.filter(a => a.startedAt >= job.startedAt - 1000)
    reasons.push(
      agents.length > 1
        ? `${agents.length} subagents are working; each Agent call returns when its subagent finishes.`
        : 'A subagent is doing the work; the call returns when it finishes.',
    )
    for (const a of agents.slice(0, 4)) {
      reasons.push(`${a.label}: ${doing(primary(l.jobs, a.id))} (${fmt(now - a.startedAt)})`)
    }
    return
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    reasons.push(
      SLOW_COMMAND.test(job.label)
        ? 'Build, test and install commands are often slow; Claude waits for the command to exit.'
        : 'Claude waits for the command to exit.',
    )
    if (job.timeoutMs) reasons.push(`Its timeout is ${fmt(job.timeoutMs)}.`)
    else if (age > 100_000) reasons.push('The default command timeout is 2 minutes.')
    return
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') reasons.push('Waiting on the network.')
  else if (tool.startsWith('mcp__')) reasons.push(`Waiting on the ${tool.split('__')[1]} MCP server.`)
  else if (tool === 'Grep' || tool === 'Glob') reasons.push('Searching many files.')
  else reasons.push(`${tool || 'The tool'} is still running.`)
}

/** What the main loop is doing now, and the likeliest reasons it is slow. */
export function diagnose(l: Live, now: number): Diagnosis {
  const reasons: string[] = []
  const t = l.turn
  const waiting = l.jobs.find(j => j.kind === 'approval')
  const job = waiting ?? primary(l.jobs)

  let headline: string
  let tone: Tone = 'normal'
  const since = job?.phaseAt ?? t?.phaseAt ?? now
  const age = now - since

  if (!job) {
    headline = 'Between steps'
    reasons.push(
      age > 10_000 ? 'Hooks or the engine are slow between model steps.' : 'Handling results before the next request.',
    )
  } else {
    switch (job.kind) {
      case 'request':
        headline = `Waiting for the model (step ${t?.steps ?? 1})`
        if (age >= 20_000) {
          tone = 'warn'
          reasons.push('No reply yet: the API may be busy, rate-limited or retrying.')
        }
        contextReasons(l, reasons)
        effortReason(job, reasons)
        if (reasons.length === 0) reasons.push('Request sent; waiting for the first token.')
        break
      case 'thinking':
        headline = `Thinking (${size(job.chars)})`
        effortReason(job, reasons)
        reasons.push('Extended thinking: nothing visible until it finishes.')
        break
      case 'writing':
        headline = `Writing the reply (${size(job.chars)})`
        reasons.push(age >= 30_000 ? 'Long reply: output streams at a fixed token rate.' : 'Streaming the answer.')
        break
      case 'tool-input':
        headline = `Preparing ${job.tool ?? 'a tool call'} (${size(job.chars)})`
        reasons.push(
          job.chars >= 4000
            ? 'Large tool input (e.g. a whole file) streams token by token.'
            : 'Writing the arguments of a tool call.',
        )
        break
      case 'tool':
        headline = job.label
        if (age >= 60_000) tone = 'warn'
        toolReasons(l, job, age, now, reasons)
        break
      case 'review':
        headline = job.label
        reasons.push(
          l.mode === 'auto'
            ? 'Auto mode sent this call to the safety classifier; once cleared, it runs.'
            : 'This call needed a permission check; once cleared, it runs.',
        )
        toolReasons(l, job, age, now, reasons)
        break
      case 'approval':
        tone = 'you'
        headline = `Waiting for your approval: ${job.label}`
        reasons.push(
          'A permission prompt is open: Claude is blocked until you answer. If you already approved, the tool itself is running.',
        )
        break
      case 'compact':
        headline = 'Compacting the conversation'
        reasons.push('The context window filled up; the history is being summarized (often 30s to 2 min).')
        break
    }
    const parallel = l.jobs.filter(j => j.agentId === undefined && j.kind === 'tool').length
    if (job.kind === 'tool' && parallel > 1) reasons.push(`${parallel} tools are running in parallel; the oldest is shown.`)
  }

  if (t && t.steps >= 8) reasons.push(`Many round trips: step ${t.steps}, ${t.tools} tool calls so far.`)
  return { headline, since, tone, reasons }
}

/** The `/out-to-lunch` answer, as markdown. */
export function report(l: Live, now: number): string {
  const t = l.turn
  if (t === null) return 'Nothing has run yet.'
  if (t.endedAt !== undefined) {
    const slowest = t.slowest ? `\n\nSlowest: ${t.slowest.label} (${fmt(t.slowest.ms)})` : ''
    return `Idle. Last turn took ${fmt(t.endedAt - t.startedAt)}: ${shares(t, t.endedAt, 4)}${slowest}`
  }
  const d = diagnose(l, now)
  return [
    `**${d.headline}** · ${fmt(now - d.since)}`,
    '',
    ...d.reasons.map(r => `- ${r}`),
    '',
    `Turn ${fmt(now - t.startedAt)} · step ${t.steps} · ${t.tools} tool calls · ${shares(t, now, 4)}`,
  ].join('\n')
}
