import { expect, test } from 'claude-code/testing'

const REMINDER = 'CAVEMAN MODE ACTIVE (caveman). Respond terse like smart caveman. All technical substance stay. Only fluff die. Answer only what was asked.'
const CAVEMAN = 'CAVEMAN MODE ACTIVE — mode: caveman\n\n# caveman\n\nRespond terse like smart caveman.\n\n' + 'Rule. '.repeat(500)
const PONYTAIL = 'PONYTAIL MODE ACTIVE — level: full\n\n# Ponytail\n\nYou are a lazy senior developer.\n\n' + 'Rule. '.repeat(500)
const SUPERPOWERS = "<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'superpowers:using-superpowers' skill**\n\n" + 'Rule. '.repeat(500)
const OTHER = '[agent-memory] something else'

function beneath(on: any, prompt: string[], start: string[] = []) {
  on('classic.UserPromptSubmit', () => ({ additionalContext: prompt }))
  on('classic.SessionStart', () => ({ additionalContext: start }))
}

const submit = async ($: any) => ((await $.classic.UserPromptSubmit({ prompt: 'do the thing' })) as { additionalContext?: string[] }).additionalContext ?? []

test('the caveman reminder goes out on the first prompt and every 10th after, other context always', async ($, on) => {
  beneath(on, [OTHER, REMINDER])
  await $.classic.SessionStart({ source: 'startup' })
  const seen: boolean[] = []
  for (let i = 1; i <= 21; i++) {
    const ctx = await submit($)
    expect(ctx).toContain(OTHER)
    seen.push(ctx.includes(REMINDER))
  }
  expect(seen.map((s, i) => (s ? i + 1 : 0)).filter(Boolean)).toEqual([1, 11, 21])
})

test('a reminder joined to other caveman text loses only the reminder paragraph', async ($, on) => {
  const notice = 'Tell the user their /caveman argument was not recognized and the mode is unchanged.'
  beneath(on, [`${notice}\n\n${REMINDER}`])
  await submit($)
  expect(await submit($)).toEqual([notice])
})

test('a mode switch carrying the ruleset is kept whole', async ($, on) => {
  const ruleset = `CAVEMAN MODE ACTIVE — mode: ultracave\n\n# ultracave\n\nRules.\n\n${REMINDER}`
  beneath(on, [ruleset])
  await submit($)
  expect(await submit($)).toEqual([ruleset])
})

test('the first prompt after a compaction keeps the reminder', async ($, on) => {
  beneath(on, [REMINDER])
  await submit($)
  expect(await submit($)).toEqual([])
  await $.classic.SessionStart({ source: 'compact' })
  expect(await submit($)).toEqual([REMINDER])
  expect(await submit($)).toEqual([])
})

test('/clear starts the count again', async ($, on) => {
  beneath(on, [REMINDER])
  await submit($)
  await submit($)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await submit($)).toEqual([REMINDER])
})

test('reminderEvery 1 keeps every reminder', { options: { reminderEvery: 1 } }, async ($, on) => {
  beneath(on, [REMINDER])
  for (let i = 0; i < 3; i++) expect(await submit($)).toEqual([REMINDER])
})

test('after a compaction the SessionStart texts shrink to a line or two; at startup they stay whole', async ($, on) => {
  beneath(on, [], [SUPERPOWERS, OTHER])
  const startup = (await $.classic.SessionStart({ source: 'startup' })) as { additionalContext: string[] }
  expect(startup.additionalContext).toEqual([SUPERPOWERS, OTHER])
  const compact = (await $.classic.SessionStart({ source: 'compact' })) as { additionalContext: string[] }
  expect(compact.additionalContext[1]).toBe(OTHER)
  expect(compact.additionalContext[0]).toMatch(/^You have superpowers: /)
  expect(compact.additionalContext[0]!.length).toBeLessThan(250)
})

test('plain post-compaction hook output (caveman, ponytail) is shortened; startup output and other hooks are not', async ($, on) => {
  on('prompt.attachment', (_$: any, e: any) => ({ text: e.text }))
  const attach = async (text: string, origin: object = { kind: 'hook', event: 'SessionStart' }) =>
    ((await $.prompt.attachment({ type: 'hook_success', text, origin } as never)) as { text: string | null }).text
  const cave = await attach(`SessionStart:compact hook success: ${CAVEMAN}`)
  expect(cave).toMatch(/^SessionStart:compact hook success: CAVEMAN MODE ACTIVE — mode: caveman\. /)
  expect(cave!.length).toBeLessThan(400)
  const pony = await attach(`SessionStart:compact hook success: ${PONYTAIL}`)
  expect(pony).toMatch(/^SessionStart:compact hook success: PONYTAIL MODE ACTIVE — level: full\. /)
  expect(await attach(`SessionStart:startup hook success: ${CAVEMAN}`)).toBe(`SessionStart:startup hook success: ${CAVEMAN}`)
  expect(await attach('SessionStart:compact hook success: OK')).toBe('SessionStart:compact hook success: OK')
})

test('shortenAfterCompact false leaves SessionStart texts whole', { options: { shortenAfterCompact: false } }, async ($, on) => {
  beneath(on, [], [SUPERPOWERS])
  const compact = (await $.classic.SessionStart({ source: 'compact' })) as { additionalContext: string[] }
  expect(compact.additionalContext).toEqual([SUPERPOWERS])
})
