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
 * A verdict and the few words the judge gave for it. A judge that gave no answer at all
 * says why in `failure`, and its verdict is `same`: the prompt goes through unjudged.
 */
export type Judgement = { verdict: Verdict; reason: string; failure?: string }

declare module 'claude-code' {
  interface PluginState {
    'change-of-subject': {
      log: Beat[]
      judge: Judge
      last: Judgement | null
      judged: number
    }
  }
}
