import type { EngineInterface, Register } from 'claude-code'

import { DEFAULTS, dropReminder, keepReminder, resolveConfig, shortCompactOutput, shortStart, shortWorker } from './trim'
import type { Config } from './trim'

const PROMPTS = { plugin: 'context-diet', key: 'prompts' } as const
const COMPACTED = { plugin: 'context-diet', key: 'compacted' } as const

let config: Config = DEFAULTS

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function reset($: EngineInterface) {
  await $.state.set(PROMPTS, 0)
  await $.state.set(COMPACTED, false)
}

export const register: Register = (on, options) => {
  config = resolveConfig(options)

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.source === 'startup' || e.source === 'clear') await reset($)
      if (e.source !== 'compact') return result
      await $.state.set(COMPACTED, true)
      if (!config.shortenAfterCompact || !result.additionalContext) return result
      return { ...result, additionalContext: result.additionalContext.map((c) => shortStart(c) ?? c) }
    } catch (err) {
      $.ui.log(`context-diet: SessionStart left as it is (${message(err)})`)
      return result
    }
  })

  // SessionStart context reaches only the main thread; caveman hands each worker its full ruleset here instead.
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!config.shortenWorkers || !result.additionalContext) return result
      return { ...result, additionalContext: result.additionalContext.map((c) => shortWorker(c) ?? c) }
    } catch (err) {
      $.ui.log(`context-diet: SubagentStart left as it is (${message(err)})`)
      return result
    }
  })

  // The mod's own history rewrites raise no SessionStart, so a completed compaction is noted here too.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in result && result.skip)) {
      await $.state.set(COMPACTED, true).catch(() => undefined)
    }
    return result
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    try {
      const prompt = ((await $.state.get(PROMPTS)).value ?? 0) + 1
      const compacted = (await $.state.get(COMPACTED)).value ?? false
      await $.state.set(PROMPTS, prompt)
      if (compacted) await $.state.set(COMPACTED, false)
      if (!result.additionalContext || keepReminder(prompt, config.reminderEvery, compacted)) return result
      const kept = result.additionalContext.map(dropReminder).filter((c): c is string => c !== null)
      return { ...result, additionalContext: kept }
    } catch (err) {
      $.ui.log(`context-diet: prompt context left as it is (${message(err)})`)
      return result
    }
  })

  // Plain-text SessionStart output (caveman, ponytail) reaches the model as an attachment, not through the classic result.
  on('prompt.attachment', { type: 'hook_success' }, async ($, e, next) => {
    if (!config.shortenAfterCompact || e.origin.kind !== 'hook' || e.origin.event !== 'SessionStart') return next(e)
    const text = shortCompactOutput(e.text)
    return text === null ? next(e) : next({ ...e, text })
  })
}
