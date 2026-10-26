import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Ask } from './model'

const PANE = { plugin: 'nextup', component: 'Pane', requestId: 'nextup', surface: 'desktop', props: { title: 'Next up', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const NOW = new Date(2026, 9, 25, 12).getTime()
const ask = (id = 'a', ago = 60_000, schema = { properties: { choice: { type: 'string', enum: ['red', 'green', 'blue'], default: 'green' } } }): Ask => ({ id, source: 'test', thread: `Worker ${id}`, message: 'Which colour?', schema, default: { choice: 'green' }, askedAt: NOW - ago, timeoutSec: 1200, status: 'waiting', at: NOW - ago })
async function setup($: Engine, on: Parameters<typeof mock.clock>[0], asks: Ask[], extra: Record<string, unknown> = {}, lose?: { done: boolean }) {
  const files: Record<string, string> = Object.fromEntries(Object.entries({ 'asks.json': asks, ...extra }).map(([k, v]) => [`/board/${k}`, JSON.stringify(v)]))
  mock.clock(on, { now: NOW })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    const payload = e as unknown as { content?: unknown; data?: unknown; text?: unknown }
    // `lose` simulates another writer overwriting the first answers.json write.
    if (lose && !lose.done && e.path.endsWith('answers.json')) { lose.done = true; return { value: undefined as never } }
    files[e.path] = String(payload.content ?? payload.data ?? payload.text ?? '')
    return { value: undefined as never }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } } as never))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return files
}

test('ledger: no asks means no question card', { options: { dataDir: '/board' } }, async ($, on) => {
  await setup($, on, [])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'ask-card' })).toBeUndefined()
  await ui.unmount()
})
test('ledger: recommended option first, oldest ask first, queue count and quiet chip', { options: { dataDir: '/board' } }, async ($, on) => {
  await setup($, on, [ask('new'), ask('old', 240_000), ask('middle', 120_000)])
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ key: 'ask-card' })).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: 'Worker old is blocked, 4 min' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 more waiting' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Quiet for 4 min' })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  const select = await ui.find({ key: 'ask-field-choice' })
  if (select?.type === 'Select') expect((select.props.options as { value: string; label: string }[])[0]).toMatchObject({ value: 'green', label: 'green (Recommended)' })
  else expect((await ui.find({ key: 'ask-option-choice-green' }))?.props.label).toContain('Recommended')
  await ui.unmount()
})
for (const skip of [false, true]) test(`ledger: ${skip ? 'Skip cancels' : 'Send remembers'} with timestamp`, { options: { dataDir: '/board' } }, async ($, on) => {
  const files = await setup($, on, [ask()])
  const ui = await $.ui.mount(PANE)
  if (!skip) await ui.press({ key: 'ask-remember' } as never)
  await ui.press({ key: skip ? 'ask-skip' : 'ask-send' } as never)
  expect(JSON.parse(files['/board/answers.json']!)[0]).toMatchObject({ id: 'a', at: NOW, answeredBy: 'darren', ...(skip ? { cancel: true } : { content: { choice: 'green' }, remember: true }) })
  if (!skip) expect(JSON.parse(files['/board/elicit-rules.json']!)[0]).toMatchObject({ server: 'test', at: NOW, value: { choice: 'green' } })
  else expect(files['/board/elicit-rules.json']).toBeUndefined()
  expect(await ui.find({ key: 'ask-card' })).toBeUndefined()
  await ui.unmount()
})
test('ledger: text alone has Input and cannot be remembered', { options: { dataDir: '/board' } }, async ($, on) => {
  const text = ask(); text.schema = { properties: { note: { type: 'string' } } }; delete text.default
  await setup($, on, [text])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'ask-remember' })).toBeUndefined()
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  await ui.unmount()
})
test('ledger: boolean choices and ineligible asks cannot save rules', { options: { dataDir: '/board' } }, async ($, on) => {
  const boolean = ask(); boolean.schema = { properties: { approve: { type: 'boolean', default: false } } }; boolean.default = { approve: false }; boolean.neverAuto = true
  const files = await setup($, on, [boolean])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'ask-remember' })).toBeUndefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.press({ key: 'ask-send' } as never)
  expect(JSON.parse(files['/board/answers.json']!)[0].content).toEqual({ approve: false })
  expect(files['/board/elicit-rules.json']).toBeUndefined()
  await ui.unmount()
})
for (const browser of [false, true]) test(`ledger: ${browser ? 'browser' : 'complex schema'} asks have no answer controls`, { options: { dataDir: '/board' } }, async ($, on) => {
  const row = browser ? { ...ask(), kind: 'browser', url: 'https://example.com/approve' } : { ...ask(), schema: { properties: { rows: { type: 'array' } } } }
  await setup($, on, [row])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'ask-card' })).toBeDefined()
  expect(await ui.find({ key: 'ask-open' })).toBeDefined()
  expect(await ui.find({ key: 'ask-send' })).toBeUndefined()
  expect(await ui.find({ key: 'ask-remember' })).toBeUndefined()
  if (browser) expect(await ui.find({ type: 'Text', text: 'Needs you in the browser' })).toBeDefined()
  await ui.unmount()
})
test('ledger: automatic wins and Undo revoke the saved rule', { options: { dataDir: '/board' } }, async ($, on) => {
  const files = await setup($, on, [], {
    'threads.json': { threads: [] },
    'elicit-log.json': ['x', 'y'].map(id => ({ id, source: 'test', message: 'Colour', status: 'auto', answeredBy: 'rule', content: { choice: 'green' }, waitedSec: 10, ruleId: 'r', at: NOW - 1000 })),
    'elicit-rules.json': [{ id: 'r', server: 'test', shape: 'enum:green', value: { choice: 'green' }, createdAt: NOW - 2000, at: NOW - 2000 }],
  })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Answered 2 for you while you slept/ })).toBeDefined()
  await ui.press({ key: 'ask-undo-x' } as never)
  expect(JSON.parse(files['/board/elicit-rules.json']!).at(-1)).toMatchObject({ id: 'r', revoked: true, at: NOW })
  await ui.unmount()
})
test('ledger: fallback commands list options and write the same answer', { options: { dataDir: '/board' } }, async ($, on) => {
  const files = await setup($, on, [ask()])
  const listed = await $.command.run({ command: 'nextup-ask' } as never)
  expect(JSON.stringify(listed)).toContain('green')
  await $.command.run({ command: 'nextup-answer', args: 'a blue' } as never)
  expect(JSON.parse(files['/board/answers.json']!)[0]).toMatchObject({ id: 'a', content: { choice: 'blue' }, at: NOW })
})

test('ledger: an answer overwritten by another writer is written again', { options: { dataDir: '/board' } }, async ($, on) => {
  const lose = { done: false }
  const files = await setup($, on, [ask()], {}, lose)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'ask-send' } as never)
  expect(lose.done).toBe(true)
  expect(JSON.parse(files['/board/answers.json']!)[0]).toMatchObject({ id: 'a', at: NOW })
  await ui.unmount()
})
