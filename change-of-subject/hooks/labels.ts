import type { EngineInterface } from 'claude-code'

import type { Example, Judge, Learning, Lessons, Scope } from '../types'
import { LIMITS, keep } from './model'

type Judging = Exclude<Judge, 'off'>

/** What a scope keeps: its labels, and each judge's rules drawn from them. */
type Kind = 'examples' | `lessons:${Judging}`

/** A scope's labels and each judge's rules, as the store holds them. */
export type Kept = { examples: Example[]; lessons: Partial<Record<Judging, Lessons>> }

const JUDGES: readonly Judging[] = ['haiku', 'jev']

/** Where new labels go, by the person's say: this project's, unless they said otherwise. */
const LEARNING_KEY = 'learn'
/** When each project with labels was last opened, so labels of a project long left can go. */
const PROJECTS_KEY = 'projects'
const STALE_MS = 90 * 24 * 60 * 60 * 1000

const localKey = (root: string, kind: Kind): string => `local:${root}:${kind}`

/**
 * Where a scope's labels and rules live in the plugin's own store, under the user's Claude
 * Code directory. A project's are keyed by its root, as Claude Code keeps a local-scope MCP
 * server: per person and per project, and never in the working tree, where they could be
 * committed.
 */
async function keyOf($: EngineInterface, scope: Scope, kind: Kind): Promise<string> {
  return scope === 'user' ? `user:${kind}` : localKey(await $.session.root(), kind)
}

async function examplesAt($: EngineInterface, key: string): Promise<Example[]> {
  const kept = await $.store.get(key)

  return Array.isArray(kept) ? (kept as Example[]) : []
}

async function lessonsAt($: EngineInterface, key: string): Promise<Lessons | undefined> {
  const kept = (await $.store.get(key)) as Partial<Lessons> | undefined

  return typeof kept?.text === 'string' && typeof kept.upTo === 'number' ? { text: kept.text, upTo: kept.upTo } : undefined
}

/** A scope's labels and each judge's rules. */
export async function readScope($: EngineInterface, scope: Scope): Promise<Kept> {
  const lessons: Partial<Record<Judging, Lessons>> = {}
  for (const by of JUDGES) {
    const drawn = await lessonsAt($, await keyOf($, scope, `lessons:${by}`))
    if (drawn !== undefined) lessons[by] = drawn
  }

  return { examples: await examplesAt($, await keyOf($, scope, 'examples')), lessons }
}

/** Keeps a label in `scope`, trimming the scope to its limit; resolves with what the scope keeps now. */
export async function learn($: EngineInterface, scope: Scope, example: Example): Promise<Example[]> {
  const key = await keyOf($, scope, 'examples')
  const examples = keep([...(await examplesAt($, key)), example], LIMITS[scope])
  await $.store.set(key, examples)

  return examples
}

const isOne = (x: Example, one: Pick<Example, 'at' | 'prompt'>): boolean => x.at === one.at && x.prompt === one.prompt

/** Drops the label `scope` keeps for one prompt, named by when it was typed and what it said. */
export async function unlearn($: EngineInterface, scope: Scope, one: Pick<Example, 'at' | 'prompt'>): Promise<void> {
  const key = await keyOf($, scope, 'examples')

  await $.store.set(key, (await examplesAt($, key)).filter(x => !isOne(x, one)))
}

/** Rewrites the label `scope` keeps for one prompt; resolves with what the scope keeps now. */
export async function relearn(
  $: EngineInterface,
  scope: Scope,
  one: Pick<Example, 'at' | 'prompt'>,
  change: (x: Example) => Example,
): Promise<Example[]> {
  const key = await keyOf($, scope, 'examples')
  const examples = (await examplesAt($, key)).map(x => (isOne(x, one) ? change(x) : x))
  await $.store.set(key, examples)

  return examples
}

export async function keepLessons($: EngineInterface, scope: Scope, by: Judging, lessons: Lessons): Promise<void> {
  await $.store.set(await keyOf($, scope, `lessons:${by}`), lessons)
}

/** Forgets a scope's labels and every judge's rules. */
export async function forget($: EngineInterface, scope: Scope): Promise<void> {
  await $.store.delete(await keyOf($, scope, 'examples'))
  for (const by of JUDGES) await $.store.delete(await keyOf($, scope, `lessons:${by}`))
}

/** Copies this project's labels to every project's, leaving out any already there; resolves with how many. */
export async function promote($: EngineInterface): Promise<{ copied: number; examples: Example[] }> {
  const key = await keyOf($, 'user', 'examples')
  const everyone = await examplesAt($, key)
  const fresh = (await readScope($, 'local')).examples.filter(x => !everyone.some(o => isOne(o, x)))
  const examples = keep([...everyone, ...fresh].sort((a, b) => a.at - b.at), LIMITS.user)
  await $.store.set(key, examples)

  return { copied: fresh.length, examples }
}

export async function learning($: EngineInterface): Promise<Learning> {
  const said = await $.store.get(LEARNING_KEY)

  return said === 'user' || said === 'off' ? said : 'local'
}

export async function learnInto($: EngineInterface, where: Learning): Promise<void> {
  await $.store.set(LEARNING_KEY, where)
}

/** The project a store key belongs to, or undefined for a key of every project's. */
const rootOf = (key: string): string | undefined => /^local:(.+):(?:examples|lessons:\w+)$/.exec(key)?.[1]

/**
 * Marks this project as opened now, and lets go of the labels and rules of every project
 * nobody has opened for `STALE_MS`: the store is one file of at most 4 MiB for them all.
 * A project with labels from before this was kept is taken as opened now.
 */
export async function visit($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const kept = (await $.store.get(PROJECTS_KEY)) as Record<string, number> | undefined
  const opened: Record<string, number> = { ...kept }
  const keys = await $.store.keys()

  for (const key of keys) {
    const root = rootOf(key)
    if (root !== undefined && opened[root] === undefined) opened[root] = now
  }
  for (const [root, at] of Object.entries(opened)) {
    if (now - at <= STALE_MS) continue
    for (const key of keys) if (rootOf(key) === root) await $.store.delete(key)
    delete opened[root]
  }
  opened[await $.session.root()] = now

  await $.store.set(PROJECTS_KEY, opened)
}
