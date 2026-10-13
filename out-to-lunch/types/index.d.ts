/** What one piece of in-flight work is doing. */
export type JobKind =
  | 'request'
  | 'thinking'
  | 'writing'
  | 'tool-input'
  | 'tool'
  | 'review'
  | 'approval'
  | 'compact'

/** What the main loop is doing; `engine` when no job is in flight. */
export type Phase = JobKind | 'engine'

/**
 * Where a turn's wall-clock time went. `you` runs from a permission prompt to
 * the tool's end: no event says when the person answered.
 */
export type Bucket = 'latency' | 'thinking' | 'output' | 'tools' | 'you' | 'compact' | 'engine'

export type Job = {
  id: string
  kind: JobKind
  label: string
  tool?: string
  agentId?: string
  startedAt: number
  phaseAt: number
  chars: number
  messages?: number
  effort?: string
  timeoutMs?: number
}

export type Usage = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export type Turn = {
  id: string
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  phase: Phase
  phaseAt: number
  spent: Record<Bucket, number>
  slowest?: { label: string; ms: number }
  usage?: Usage
}

export type Done = {
  label: string
  kind: JobKind
  ms: number
  at: number
  agentId?: string
}

export type Agent = { id: string; label: string; startedAt: number }

export type Live = {
  now: number
  mode?: string
  jobs: Job[]
  agents: Agent[]
  turn: Turn | null
  log: Done[]
}

/** The model's guess at why the delay named by `key` (see `delayKey`) is taking long. */
export type Insight = { key: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'out-to-lunch': {
      live: Live
      dismissed: string | null
      isHidden: boolean
      delaySeconds: number
      isGuessing: boolean
      insight: Insight | null
    }
  }
}
