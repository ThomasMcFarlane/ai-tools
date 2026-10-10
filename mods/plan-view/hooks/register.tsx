import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { clip, isPlanPath, planTitle } from './plan'

const PANE = 'plan-view'
// '/plan' is Claude Code's own command (enter plan mode), so this one is '/plan-view'.
const COMMAND = 'plan-view'

const plan = atom({ plugin: 'plan-view', key: 'plan' } as const, { path: '', at: 0 })

// The drawn text. A module variable on purpose: a render may not write $.state, and session.start re-reads it after a reload.
let shown = ''

const report = ($: EngineInterface, where: string, err: unknown) => {
  try {
    $.ui.status(`plan-view: ${where}: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`)
  } catch {
    /* nothing left to do */
  }
}

const configDir = async ($: EngineInterface) => (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`

const load = async ($: EngineInterface, path: string) => {
  shown = String(await $.fs.read(path))
  await update($, plan, () => ({ path, at: Date.now() }))
}

const open = async ($: EngineInterface) => {
  const { path } = await read($, plan)
  await $.ui.open({ id: PANE, title: planTitle(shown, path) })
}

// Reads the plan again and opens or retitles the pane.
const show = async ($: EngineInterface, path: string) => {
  await load($, path)
  await open($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: "Toggle the pane showing Claude's latest plan" })
      const { path } = await read($, plan)
      if (path) await load($, path).catch(() => undefined) // a deleted plan just leaves the pane empty
    } catch (err) {
      report($, 'session.start', err)
    }
    return next(e)
  })

  // Learns where the session keeps its plan file.
  on('prompt.attachment', async ($, e, next) => {
    try {
      const d = (e as { detail?: { planFilePath?: string } }).detail
      if (['plan_mode', 'plan_mode_exit', 'plan_mode_reentry'].includes(String(e.type)) && d?.planFilePath) {
        const path = d.planFilePath
        await update($, plan, p => (p.path === path ? p : { path, at: 0 }))
      }
    } catch (err) {
      report($, 'prompt.attachment', err)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { file_path?: unknown }
    const tool = String(e.tool)
    const file = typeof input.file_path === 'string' ? input.file_path : ''
    try {
      const known = (await read($, plan)).path
      const isWrite = ['Write', 'Edit', 'MultiEdit'].includes(tool) && isPlanPath(file, await configDir($), known)
      if (!isWrite && tool !== 'ExitPlanMode') return next(e)
      const ran = await next(e)
      // A pane failure must never fail a tool call that already ran.
      try {
        if (ran.deny !== undefined || ran.isError === true) return ran
        const path = isWrite ? file : known
        if (path) await show($, path)
      } catch (err) {
        report($, 'refresh', err)
      }
      return ran
    } catch (err) {
      report($, 'tool.call', err)
      return next(e)
    }
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      if ((await $.ui.panes()).some(p => p.id === PANE)) {
        await $.ui.close({ id: PANE })
        return { text: 'Plan pane closed.' }
      }
      const { path } = await read($, plan)
      if (!path) return { text: 'No plan yet.' }
      await show($, path)
      return { text: 'Plan pane opened.' }
    } catch (err) {
      report($, 'command.run', err)
      return { text: `Plan pane failed: ${String(err instanceof Error ? err.message : err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const p = await read($, plan)
    if (!shown) return <Text dimColor>No plan yet.</Text>
    const { text, isCut } = clip(shown)
    const time = p.at ? new Date(p.at).toLocaleTimeString('en-GB') : ''
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{`${p.path}${time ? ` · updated ${time}` : ''}`}</Text>
        <Markdown key="plan" text={text} />
        {isCut && <Text dimColor wrap="wrap">{`Plan cut at ${text.length} characters; the rest is in ${p.path}`}</Text>}
      </Box>
    )
  })
}
