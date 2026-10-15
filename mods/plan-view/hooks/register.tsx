import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { clip, isPlanPath, mdMentions, planTitle } from './plan'

const PANE = 'plan-view'
// '/plan' is Claude Code's own command (enter plan mode), so this one is '/plan-view'.
const COMMAND = 'plan-view'
const LIST_PANE = 'plan-view-list'
const LIST_COMMAND = 'plan-view-list'

const plan = atom({ plugin: 'plan-view', key: 'plan' } as const, { path: '', at: 0 })

// Markdown files mentioned in replies: `pending` waits for an answer (newest last), `seen` was ever offered.
const offer = atom({ plugin: 'plan-view', key: 'offer' } as const, { pending: [] as string[], seen: [] as string[], at: 0 })

// The drawn text. A module variable on purpose: a render may not write $.state, and session.start re-reads it after a reload.
let shown = ''

// Mention -> existing path, hits only (a file may appear later). Module-level because a render may not write $.state.
const resolved = new Map<string, string>()

const resolveMd = async ($: EngineInterface, m: string): Promise<string | undefined> => {
  const home = (await $.env.get('HOME')) ?? ''
  const bases = [await $.session.cwd(), await $.session.root()]
  const key = `${m}\0${bases.join('\0')}`
  const hit = resolved.get(key)
  if (hit) return hit
  const options = m.startsWith('/') ? [m] : m.startsWith('~/') ? [`${home}${m.slice(1)}`] : bases.map(b => `${b.replace(/\/+$/, '')}/${m}`)
  for (const path of options) {
    if (await $.fs.exists(path)) {
      resolved.set(key, path)
      return path
    }
  }
}

const report = ($: EngineInterface, where: string, err: unknown) => {
  try {
    $.ui.status(`plan-view: ${where}: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`)
  } catch {
    /* nothing left to do */
  }
}

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

// Drops the path from the band (keeping the index in range), then shows it.
const openOffered = async ($: EngineInterface, path: string) => {
  await update($, offer, o => {
    const pending = o.pending.filter(p => p !== path)
    return { ...o, pending, at: Math.min(o.at, Math.max(pending.length - 1, 0)) }
  })
  await show($, path)
}

const openList = async ($: EngineInterface) => {
  await $.ui.open({ id: LIST_PANE, title: 'Markdown files' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: "Toggle the Markdown preview pane (the plan, or the last file opened)" })
      await $.command.register({ name: LIST_COMMAND, description: 'Toggle the pane listing the Markdown files suggested this session' })
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
      const isWrite = ['Write', 'Edit', 'MultiEdit'].includes(tool) && isPlanPath(file, known)
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

  // Offers a preview of each existing .md file the reply names.
  on('turn.complete', async ($, e, next) => {
    try {
      const { seen } = await read($, offer)
      const shownPath = (await read($, plan)).path
      const fresh: string[] = []
      for (const m of mdMentions(e.answer)) {
        const path = await resolveMd($, m)
        if (!path || seen.includes(path) || fresh.includes(path) || (path === shownPath && (await $.ui.panes()).some(p => p.id === PANE))) continue
        fresh.push(path)
      }
      if (fresh.length) await update($, offer, o => ({ pending: [...o.pending, ...fresh], seen: [...o.seen, ...fresh], at: o.pending.length + fresh.length - 1 }))
    } catch (err) {
      report($, 'turn.complete', err)
    }
    return next(e)
  })

  // Stays under the message for good, whatever the band or `seen` say.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    try {
      const paths = new Set<string>()
      for (const m of mdMentions(e.props.text)) {
        const path = await resolveMd($, m)
        if (path) paths.add(path)
      }
      if (!paths.size) return next(e)
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {await next(e)}
          <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Text bold color="suggestion">Markdown preview</Text>
            {[...paths].map(path => (
              <Box key={path}>
                <Text bold>{path.split('/').pop()}</Text>
                <Text dimColor wrap="truncate-middle">{`  ${path}  `}</Text>
                <Button
                  key={`open:${path}`}
                  label="Open"
                  onPress={async () => {
                    try {
                      await openOffered($, path)
                    } catch (err) {
                      report($, 'open', err)
                    }
                  }}
                />
              </Box>
            ))}
          </Box>
        </Box>
      )
    } catch (err) {
      report($, 'AssistantMessage', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { pending, at: raw } = await read($, offer)
    if (!pending.length || e.props.hasSurvey) return next(e)
    const at = Math.min(Math.max(raw, 0), pending.length - 1)
    const path = pending[at]
    const many = pending.length > 1
    const { Box, Button, Text } = $.ui.resolve(e)
    // Drops only the shown path; the index then points at its neighbour.
    const drop = async () => update($, offer, o => ({ ...o, pending: o.pending.filter(p => p !== path), at }))
    const dismissAll = () => update($, offer, o => ({ ...o, pending: [], at: 0 }))
    const go = (step: number) => () => update($, offer, o => ({ ...o, at: (at + step + o.pending.length) % o.pending.length }))
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Box>
          <Text bold color="suggestion">Markdown preview</Text>
          <Text dimColor>{`  ${at + 1} of ${pending.length}`}</Text>
        </Box>
        <Box>
          <Text bold>{path.split('/').pop()}</Text>
          <Text dimColor wrap="truncate-middle">{`  ${path}`}</Text>
        </Box>
        <Box>
          {/* Button has no disabled prop, so with one file the labels are dim text instead. */}
          {many ? <Button key="prev" label="Prev" onPress={go(-1)} /> : <Text dimColor>[Prev]</Text>}
          {many ? <Button key="next" label="Next" onPress={go(1)} /> : <Text dimColor>[Next]</Text>}
          <Button
            key="open"
            label="Open"
            onPress={async () => {
              try {
                await openOffered($, path)
              } catch (err) {
                report($, 'open', err)
              }
            }}
          />
          <Button key="dismiss" label="Dismiss" onPress={drop} />
          <Button key="dismiss-all" label="Dismiss all" onPress={dismissAll} />
          <Button key="list" label="List" onPress={() => openList($).catch(err => report($, 'list', err))} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      if ((await $.ui.panes()).some(p => p.id === PANE)) {
        await $.ui.close({ id: PANE })
        return { text: 'Preview pane closed.' }
      }
      const { path } = await read($, plan)
      if (!path) return { text: 'Nothing to preview yet.' }
      await show($, path)
      return { text: 'Preview pane opened.' }
    } catch (err) {
      report($, 'command.run', err)
      return { text: `Preview pane failed: ${String(err instanceof Error ? err.message : err)}` }
    }
  })

  on('command.run', { command: LIST_COMMAND }, async $ => {
    try {
      if ((await $.ui.panes()).some(p => p.id === LIST_PANE)) {
        await $.ui.close({ id: LIST_PANE })
        return { text: 'Markdown list closed.' }
      }
      await openList($)
      return { text: 'Markdown list opened.' }
    } catch (err) {
      report($, 'command.run', err)
      return { text: `Markdown list failed: ${String(err instanceof Error ? err.message : err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: LIST_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { seen } = await read($, offer)
    if (!seen.length) return <Text dimColor>No Markdown files suggested yet.</Text>
    return (
      <Box flexDirection="column">
        {seen.map(path => (
          <Box key={path}>
            <Text bold>{path.split('/').pop()}</Text>
            <Text dimColor wrap="truncate-middle">{`  ${path}  `}</Text>
            <Button key={`open:${path}`} label="Open" onPress={() => openOffered($, path).catch(err => report($, 'open', err))} />
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const p = await read($, plan)
    if (!shown) return <Text dimColor>Nothing to preview yet.</Text>
    const { text, isCut } = clip(shown)
    const time = p.at ? new Date(p.at).toLocaleTimeString('en-GB') : ''
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{`${p.path}${time ? ` · updated ${time}` : ''}`}</Text>
        <Markdown key="plan" text={text} />
        {isCut && <Text dimColor wrap="wrap">{`Cut at ${text.length} characters; the rest is in ${p.path}`}</Text>}
      </Box>
    )
  })
}
