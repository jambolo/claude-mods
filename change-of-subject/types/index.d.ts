/** Who said a remembered line. */
export type Who = 'you' | 'claude'

/** One line of the session, kept so a later prompt can be judged against it. */
export type Beat = { who: Who; text: string }

/**
 * What the judge made of a prompt: `same` carries on the work the session is
 * already doing, `aside` belongs to another subject, `phase` belongs to the
 * same work but starts a new direction or phase in it.
 */
export type Verdict = 'same' | 'aside' | 'phase'

/** Which judge watches the prompts, or `off` for none. */
export type Judge = 'off' | 'haiku' | 'jev'

/**
 * The judge's own call, before the mod's threshold turns one it was not sure enough of
 * into `same`: what it picked, and how sure of it it was, from 0 to 1. Absent when the
 * judge did not say.
 */
export type Call = { pick?: Verdict; sure?: number }

/**
 * A verdict and the few words the judge gave for it, with one sentence comparing the
 * prompt with the session when Claude Haiku called it `aside` or `phase`. A judge that gave
 * no answer at all says why in `failure`, and its verdict is `same`: the prompt goes
 * through unjudged.
 */
export type Judgment = Call & { verdict: Verdict; reason: string; comparison?: string; failure?: string }

/** Where a label is kept: for every project (`user`), or for this one only (`local`). */
export type Scope = 'user' | 'local'

/** Where new labels go, or `off` for nowhere. */
export type Learning = Scope | 'off'

/** How a label was learned: the person's answer to a pop-up, or `/change-of-subject was`. */
export type Source = 'dialog' | 'was'

/**
 * What the person said of a prompt: that it was `is`, or, by turning a pop-up down, only
 * that it was not `not`.
 */
export type Truth = { is: Verdict } | { not: Verdict }

/** A prompt the person gave their word on, and the judge's call on it: what the judge is taught from. */
export type Example = Call & {
  at: number
  prompt: string
  judge: Exclude<Judge, 'off'>
  /** The verdict the mod acted on: the one the person bore out or turned down. */
  said: Verdict
  truth: Truth
  source: Source
  /** Why the judge's verdict was given: the judge's own words when Claude Haiku judged, else Claude Haiku's. */
  reason?: string
  /** One sentence on how the prompt compared with its session; absent until Claude Haiku has written it. */
  comparison?: string
  /** The session the prompt was typed into, kept only until the comparison is written. */
  session?: Beat[]
}

/** The rules a scope's labels came to for one judge, and the newest label they were drawn from. */
export type Lessons = { text: string; upTo: number }

export type Interrupting = Exclude<Verdict, 'same'>

/**
 * A judge's pop-up answers on one verdict, right and wrong, by how sure it was in 5% steps.
 * Kept apart from the labels: trimming those keeps mistakes longest, which would skew it.
 */
export type Tally = {
  right: number[]
  wrong: number[]
  /** Where `was` showed the bar hid right calls: those interrupt again until `left` more are answered. */
  reopened?: { from: number; below: number; left: number }
}

export type Calibration = Partial<Record<Interrupting, Tally>>

/** What the judge is taught for one prompt: the session's first prompt, past calls, and the person's rules. */
export type Teaching = { anchor: Beat | null; examples: Example[]; lessons: string[] }

/**
 * The last prompt a judge gave a verdict on, the session it saw (its first prompt
 * included), and the scope its label is kept in, or null while it has none: what
 * `/change-of-subject was` corrects.
 */
export type Ruling = Call & {
  at: number
  prompt: string
  said: Verdict
  judge: Exclude<Judge, 'off'>
  reason?: string
  comparison?: string
  session: Beat[]
  scope: Scope | null
}

declare module 'claude-code' {
  interface PluginState {
    'change-of-subject': {
      log: Beat[]
      /** The session's first prompt with a subject, which the record of its last lines lets go of. */
      anchor: Beat | null
      judge: Judge
      last: Judgment | null
      judged: number
      ruling: Ruling | null
    }
  }
}
