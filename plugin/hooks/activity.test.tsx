import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { COMMAND_CHARS, FILES_CAP, LOG_CAP, SHELL_CAP, gateStats, helperAxis, helperRuns, latestBatch, span, summarise, sessionLanes, helperLabel } from './activity'
import { lanes as tenLanes, now as fixtureNow, twoHours } from './fixtures/activity-ten-lanes'
import { desk } from './theme'
import type { FileTouch, ShellRun, Spawn, ToolEvent } from '../types'

test('desktop zero Permissions draws three equal dim tiles without a bar', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 140 }, surface: 'desktop' })
  expect(await ui.find({ key: 'gate-track' })).toBeUndefined()
  for (const kind of ['waiting', 'asked', 'denied']) {
    const tile = await ui.find({ key: `gate-tile-${kind}` })
    expect(tile?.props).toMatchObject({ flexGrow: 1, width: 0, backgroundColor: desk.track, borderStyle: 'round', borderColor: desk.track })
    expect((await ui.find({ key: `gate-${kind}` }))?.props.dimColor).toBe(true)
  }
  expect(await ui.find({ key: 'segment-0' })).toBeUndefined()
  expect(await ui.find({ key: 'segment-1' })).toBeUndefined()
  expect(await ui.find({ key: 'segment-2' })).toBeUndefined()
  await ui.unmount()
})

test('desktop Session uses neutral fills, slim timelines and safe file hints', async ($, on) => {
  engine(on, undefined, '/Users/x/proj')
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'helper' }))
  await $.agent.spawn({ prompt: 'Review', description: 'Review' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/Users/x/proj/plugin/hooks/register.tsx', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/outside/other.ts', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/Users/x/proj/README.md', content: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const boxes = await ui.findAll({ type: 'Box' })
  for (const box of boxes) {
    expect(['inactive', 'subtle'].includes(String(box.props.backgroundColor))).toBe(false)
    expect(/px$/.test(String(box.props.height))).toBe(false)
    expect(box.props.borderColor).not.toBe('transparent')
    // Only a helper's lane is a quarter cell tall (a thin line); nothing else is drawn that slim.
    if (!/^hs-/.test(box.key ?? '')) expect(box.props.height).not.toBe(0.25)
    expect(box.key?.startsWith('line-') ?? false).toBe(false)
    if (/^(af-|al-)/.test(box.key ?? '')) expect(box.props.paddingY).toBe('xs')
    // Helper rows and their timeline lines are compact: no padding above or below each row.
    if (/^(hn-|hl-)/.test(box.key ?? '')) expect(box.props.paddingY).toBeUndefined()
  }
  for (const key of ['pc-help', 'pc-files', 'pc-log']) {
    expect((await ui.find({ key }))?.props.gap).toBe('xs')
  }
  expect(await ui.find({ key: 'gate-track' })).toBeUndefined()
  // The old lane marks are gone; each helper has a full-width line on a shared axis instead.
  expect(await ui.find({ key: 'timeline-helper' })).toBeUndefined()
  expect((await ui.find({ key: 'tl-helper' }))?.props).toMatchObject({ flexGrow: 1, minWidth: 0 })
  expect(await text(ui, '▸ register.tsx')).toBeDefined()
  expect(await text(ui, 'hooks/ · ×1 · now')).toBeDefined()
  expect(await text(ui, '~/…/outside/ · ×1 · now')).toBeDefined()
  expect(await text(ui, './ · ×1 · now')).toBeDefined()
  // Inspect rendered children, not the key (which itself contains the file name).
  const row = await ui.find({ key: 'af-plugin/hooks/register.tsx' })
  // One native Button holds the name, then its dim hint.
  const button = row!.children[0] as { children: { children: string[] }[] }
  expect(button.children[0]!.children.join('')).toBe('▸ register.tsx')
  expect(button.children.at(-1)!.children.join('')).toBe('hooks/ · ×1 · now')
  const fileCard = await ui.find({ key: 'pc-files' })
  expect(JSON.stringify(fileCard!.children).includes('/Users/')).toBe(false)
  expect(await text(ui, /^\//)).toBeUndefined()
  await ui.unmount()
})

test('terminal Session keeps glyph bars, original file hints and unpadded rows', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'helper' }))
  await $.agent.spawn({ prompt: 'Review', description: 'Review' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/plugin/hooks/register.tsx`, content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/outside/other.ts', content: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'gate-track' })).toBeUndefined()
  expect(await ui.find({ key: 'timeline-helper' })).toBeUndefined()
  expect(await text(ui, /█/)).toBeUndefined()
  // A glyph line: the helper's span drawn with ─, on the shared axis that ends at now.
  expect(await text(ui, /─/)).toBeDefined()
  expect(await text(ui, 'now')).toBeDefined()
  expect(await text(ui, 'plugin/hooks/ · ×1 · now')).toBeDefined()
  expect(await text(ui, '/outside/ · ×1 · now')).toBeDefined()
  for (const box of await ui.findAll({ type: 'Box' })) {
    expect(String(box.props.backgroundColor).includes('rgba(')).toBe(false)
    expect(box.key?.startsWith('line-') ?? false).toBe(false)
    if (/^(af-|al-|hn-|hl-)/.test(box.key ?? '')) expect(box.props.paddingY).toBeUndefined()
  }
  expect((await ui.find({ key: 'pc-files' }))?.props).toMatchObject({ borderColor: 'inactive' })
  await ui.unmount()
})

test('desktop Session headers and long file/log rows constrain and truncate text', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/${'long-directory/'.repeat(20)}long-file.ts`, content: '' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 140 }, surface: 'desktop' })
  const boxes = await ui.findAll({ type: 'Box' })
  for (const row of boxes.filter(x => x.key?.startsWith('al-') || x.key?.startsWith('af-'))) {
    expect(row.props).toMatchObject({ width: '100%', flexShrink: 1, minWidth: 0 })
  }
  for (const card of boxes.filter(x => x.key?.startsWith('pc-'))) {
    const header = card.children[0] as { props: Record<string, unknown>; children: { props: Record<string, unknown>; children: { props: Record<string, unknown> }[] }[] }
    expect(header.props.minWidth).toBe(0)
    const side = header.children[1]!
    expect(side.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
    expect(side.children[0]?.props.wrap).toBe('truncate-end')
  }
  await ui.unmount()
})

test('permission tiles toggle filtered calls and ignore zero counts', async ($, on) => {
  engine(on, null)
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'pwd' } } as never)
    return e.tool === 'Read' ? { deny: 'no' } : { result: {}, text: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/no` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'gate-track' })).toBeUndefined()
  expect(await ui.find({ key: 'gate-tile-waiting' })).toBeDefined()
  // A desktop's native button draws only its label, so the label carries the count: without it the tiles
  // showed no number until pressed (0.4.14 to 0.4.17).
  expect((await ui.find({ key: 'gate-waiting' }))?.props.label).toBe('0 waiting')
  // Allowed calls remain available as history, separate from the actionable tiles.
  expect((await ui.find({ key: 'gate-allowed' }))?.props.label).toBe('0 allowed')
  expect((await ui.find({ key: 'gate-asked' }))?.props.label).toBe('1 asked you')
  expect((await ui.find({ key: 'gate-denied' }))?.props.label).toBe('1 denied')
  const askedTile = JSON.stringify(await ui.find({ key: 'gate-tile-asked' }))
  // One short line per tile: the dot, the count and the label sit in the same row.
  expect(JSON.stringify(await ui.find({ key: 'gate-asked' }))).toContain('"1"')
  expect(askedTile).not.toContain('"title"')
  expect(JSON.stringify(await ui.find({ key: 'gate-tile-denied' }))).toContain('"warning"')
  expect(await text(ui, /^(file|shell|other) \d/)).toBeUndefined()
  await ui.press({ key: 'gate-waiting' } as never)
  expect(await ui.find({ key: 'gate-calls-waiting' })).toBeUndefined()
  await ui.press({ key: 'gate-allowed' } as never)
  expect(await ui.find({ key: 'gate-calls-allowed' })).toBeUndefined()
  await ui.press({ key: 'gate-asked' } as never)
  const asked = await ui.find({ key: 'gate-calls-asked' })
  expect(JSON.stringify(asked?.children).includes('Bash · pwd')).toBe(true)
  expect(JSON.stringify(asked?.children).includes('Read · no')).toBe(false)
  await ui.press({ key: 'gate-asked' } as never)
  expect(await ui.find({ key: 'gate-calls-asked' })).toBeUndefined()
  await ui.press({ key: 'gate-asked' } as never)
  await ui.press({ key: 'gate-denied' } as never)
  expect(await ui.find({ key: 'gate-calls-asked' })).toBeUndefined()
  expect(JSON.stringify((await ui.find({ key: 'gate-calls-denied' }))?.children).includes('Read · no')).toBe(true)
  await ui.unmount()
})

test('file edits expand newest first and retain only the newest twenty', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'helper' }))
  const clock = mock.clock(on)
  await $.agent.spawn({ prompt: 'Review', description: 'Reviewer' } as never)
  for (let i = 0; i < 21; i++) {
    await clock.advance(1000)
    await $.tool.call({ tool: 'Write', file_path: `${CWD}/a.ts`, content: '' })
  }
  await clock.advance(1000)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b', agentId: 'helper' } as never)
  const edits = (await read($, files))[0]?.edits ?? []
  expect(edits.length).toBe(20)
  expect(edits[0]?.at).toBe(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'file-edits-a.ts' })).toBeUndefined()
  expect((await ui.find({ key: 'file-a.ts' }))?.props.label).toBe('▸ a.ts')
  await ui.press({ key: 'file-a.ts' } as never)
  expect((await ui.find({ key: 'file-a.ts' }))?.props.label).toBe('▾ a.ts')
  const rows = (await ui.find({ key: 'file-edits-a.ts' }))?.children
  const drawing = JSON.stringify(rows)
  expect(drawing.includes('Reviewer')).toBe(true)
  expect(drawing.includes('main')).toBe(true)
  expect(drawing.indexOf('Edit') < drawing.indexOf('Write')).toBe(true)
  await ui.unmount()
})

test('allowed calls exclude asked, denied, running and prompts; eight then Show more', async ($, on) => {
  engine(on, null)
  on('classic.PermissionRequest', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') {
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'pwd' } } as never)
      return { result: {}, text: 'failed', isError: true }
    }
    return e.tool === 'WebFetch' ? { deny: 'no' } : { result: {}, text: 'ok' }
  })
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Read', file_path: `${CWD}/r${i}` })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://denied.test', prompt: 'x' } as never)
  await $.prompt.submit({ text: 'A prompt', wait: false, origin: 'user' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'gate-allowed' } as never)
  const calls = () => ui.find({ key: 'gate-calls-allowed' })
  expect(JSON.stringify((await calls())?.children).includes('Read · r9')).toBe(true)
  expect(JSON.stringify((await calls())?.children).includes('Read · r0')).toBe(false)
  expect(JSON.stringify((await calls())?.children).includes('Bash')).toBe(false)
  expect(JSON.stringify((await calls())?.children).includes('WebFetch')).toBe(false)
  expect(JSON.stringify((await calls())?.children).includes('A prompt')).toBe(false)
  expect((await ui.find({ key: 'amore-gate-allowed' }))?.props.label).toBe('Show 2 more')
  await ui.press({ key: 'amore-gate-allowed' } as never)
  expect(JSON.stringify((await calls())?.children).includes('Read · r0')).toBe(true)
  expect((await ui.find({ key: 'amore-gate-allowed' }))?.props.label).toBe('Show less')
  await ui.press({ key: 'amore-gate-allowed' } as never)
  expect(JSON.stringify((await calls())?.children).includes('Read · r0')).toBe(false)
  await ui.unmount()
})

test('ten lanes: collapse only finishes older than two hours, never old live lanes', () => {
  const { visible, finished } = sessionLanes(tenLanes, fixtureNow)
  expect(finished).toBe(4)
  expect(visible.map(x => x.id)).toEqual(['lane-4', 'lane-5', 'lane-6', 'lane-7', 'lane-8', 'lane-9'])
  expect(sessionLanes(tenLanes, fixtureNow + 1).finished).toBe(5)
  expect(sessionLanes([], fixtureNow)).toEqual({ visible: [], finished: 0 })
  expect(sessionLanes([{ id: 'zero', name: 'Zero', at: -1, end: 0 }], twoHours + 1).finished).toBe(1)
})

test('helper labels never echo commands, paths, URLs or search patterns', () => {
  for (const [tool, label] of [['Bash', 'Running command'], ['Read', 'Reading files'], ['Edit', 'Editing files'], ['Grep', 'Searching files'], ['WebFetch', 'Fetching page']]) {
    expect(helperLabel(ev('x', tool!, 'running', 0, undefined, '/private/path && raw command'))).toBe(label)
  }
})

for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
  test(`${surface}: ten-lane fixture hides stale finishes and raw helper details, with actionable permissions`, async ($, on) => {
    engine(on, undefined, CWD, { spawns: tenLanes, log: [
      { ...ev('raw', 'Bash', 'running', fixtureNow, undefined, 'echo PRIVATE /long/path'), agent: 'lane-9' },
      { ...ev('waiting', 'Read', 'running', fixtureNow, undefined, '/private/path'), asked: true, agent: 'lane-8' },
      { ...ev('asked-done', 'Read', 'ok'), asked: true },
      ev('denied', 'Bash', 'denied'),
    ] })
    const clock = mock.clock(on)
    await clock.advance(fixtureNow)
    await $.session.start({ cwd: CWD, surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    const helpers = JSON.stringify(await ui.find({ key: 'pc-help' }))
    expect(helpers.includes('PRIVATE')).toBe(false)
    expect(helpers.includes('/private/path')).toBe(false)
    expect(helpers.includes('Running command')).toBe(true)
    expect(await text(ui, '4 finished')).toBeDefined()
    for (let i = 0; i < 4; i++) {
      expect(await ui.find({ key: `hn-lane-${i}` })).toBeUndefined()
      expect(await ui.find({ key: `hl-lane-${i}` })).toBeUndefined()
    }
    expect(await ui.find({ key: 'hn-lane-6' })).toBeDefined()
    expect((await ui.find({ key: 'gate-waiting' }))?.props.label).toBe('1 waiting')
    expect(await text(ui, '1 waiting · 1 denied')).toBeDefined()
    await ui.press({ key: 'gate-waiting' } as never)
    const waiting = JSON.stringify(await ui.find({ key: 'gate-calls-waiting' }))
    expect(waiting.includes('Read · /private/path')).toBe(true)
    expect(waiting.includes('asked-done')).toBe(false)
    expect(waiting.includes('echo PRIVATE')).toBe(false)
    await ui.unmount()
  })
}

const CWD = '/work/app'

// Each hook here stands for the engine beneath the mod.
// The test's \$ holds no state of its own, so the last value written to each
// key is read off the writes on their way down.
type Seen = { log: ToolEvent[]; files: FileTouch[]; shell: ShellRun[] }
let seen: Seen = { log: [], files: [], shell: [] }
const read = async <K extends keyof Seen>(_: unknown, k: K): Promise<Seen[K]> => seen[k]
const log = 'log' as const, files = 'files' as const, shell = 'shell' as const

const engine = (on: Parameters<TestBody>[1], answer: ((e: { tool: string; command?: string }) => object) | null = () => ({ result: {}, text: 'ok' }), cwd = CWD, seed?: { spawns: Spawn[]; log: ToolEvent[] }) => {
  seen = { log: [], files: [], shell: [] }
  if (seed) on('state.get', (_, e, next) => {
    if (seed && e.plugin === 'nextup' && (e.key === 'spawns' || e.key === 'log')) {
      return { value: { value: seed[e.key], version: 1 } }
    }
    return next(e)
  })
  on('state.set', (_, e, next) => {
    if (seed && e.plugin === 'nextup' && (e.key === 'spawns' || e.key === 'log')) {
      seed = { ...seed, [e.key]: e.value }
    }
    const w = e as unknown as { plugin: string; key: string; value: never }
    if (w.plugin === 'nextup' && w.key in seen) seen[w.key as keyof Seen] = w.value
    return next(e)
  })
  on('command.register', () => ({ value: { command: 'nextup' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  if (answer) on('tool.call', (_, e) => answer(e as never) as never)
}

test('an Edit, a Write and a NotebookEdit each record the file, relative to the folder', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/elsewhere/b.md', content: 'x' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${CWD}/n.ipynb`, new_source: 'x' } as never)
  const f = await read($, files)
  expect(f.map(x => x.path)).toEqual(['src/a.ts', '/elsewhere/b.md', 'n.ipynb'])
  expect(f.map(x => x.tool)).toEqual(['Edit', 'Write', 'NotebookEdit'])
  const l = await read($, log)
  expect(l.map(x => `${x.tool} ${x.summary} ${x.status}`)).toEqual(['Edit src/a.ts ok', 'Write /elsewhere/b.md ok', 'NotebookEdit n.ipynb ok'])
})

test('a file touched twice is one row with a count, moved to newest', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/b.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/a.ts`, content: 'c' })
  const f = await read($, files)
  expect(f.map(x => `${x.path}:${x.count}:${x.tool}`)).toEqual(['b.ts:1:Edit', 'a.ts:2:Write'])
})

test('a Read or a failed Edit touches no file', async ($, on) => {
  engine(on, e => (e.tool === 'Edit' ? { result: {}, text: 'no match', isError: true } : { result: {}, text: 'ok' }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(await read($, files)).toEqual([])
  expect((await read($, log)).map(x => x.status)).toEqual(['ok', 'failed'])
})

test('a Bash command is recorded with its outcome: ok, failed or denied', async ($, on) => {
  engine(on, e =>
    e.command === 'false' ? { result: {}, text: 'exit 1', isError: true } : e.command === 'rm -rf x' ? { deny: 'no' } : { result: {}, text: 'ok' },
  )
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: '  ls -la\necho two  ' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  const s = await read($, shell)
  expect(s.map(x => `${x.command}|${x.status}`)).toEqual(['ls -la\necho two|ok', 'false|failed', 'rm -rf x|denied'])
  expect(s.every(x => typeof x.ms === 'number')).toBe(true)
  const l = await read($, log)
  expect(l.map(x => x.summary)).toEqual(['ls -la', 'false', 'rm -rf x'])
  expect(await read($, files)).toEqual([])
})

test('the call result goes back untouched', async ($, on) => {
  engine(on, () => ({ result: { stdout: 'hi' }, text: 'hi' }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const out = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(out.text).toBe('hi')
})

// Three tests, not one: 500-odd calls in a single test come close to the 5 s test limit.
test('the log is capped, oldest dropped', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  for (let i = 0; i < LOG_CAP + 5; i++) await $.tool.call({ tool: 'Read', file_path: `${CWD}/r${i}` })
  const l = await read($, log)
  expect(l.length).toBe(LOG_CAP)
  expect(l[0]?.summary).toBe('r5')
  expect(l[LOG_CAP - 1]?.summary).toBe(`r${LOG_CAP + 4}`)
})

test('shell commands are capped, oldest dropped, and long commands cut', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  for (let i = 0; i < SHELL_CAP + 5; i++) await $.tool.call({ tool: 'Bash', command: `echo ${i}` })
  const s = await read($, shell)
  expect(s.length).toBe(SHELL_CAP)
  expect(s[0]?.command).toBe('echo 5')
  await $.tool.call({ tool: 'Bash', command: 'y'.repeat(COMMAND_CHARS + 50) })
  expect((await read($, shell)).at(-1)?.command.length).toBe(COMMAND_CHARS)
})

test('files touched are capped, oldest dropped', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  for (let i = 0; i < FILES_CAP + 5; i++) await $.tool.call({ tool: 'Write', file_path: `${CWD}/f${i}`, content: '' })
  const f = await read($, files)
  expect(f.length).toBe(FILES_CAP)
  expect(f[0]?.path).toBe('f5')
  expect(f[FILES_CAP - 1]?.path).toBe(`f${FILES_CAP + 4}`)
})

test('summaries name the target of each kind of tool', () => {
  expect(summarise('Grep', { pattern: 'needle', path: `${CWD}/src` }, CWD)).toBe('needle  in src')
  expect(summarise('Glob', { pattern: '**/*.ts' }, CWD)).toBe('**/*.ts')
  expect(summarise('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
  expect(summarise('WebSearch', { query: 'mods' })).toBe('mods')
  expect(summarise('Agent', { description: 'Find files' })).toBe('Find files')
  expect(summarise('mcp__github__create_issue', {})).toBe('github · create_issue')
  expect(summarise('Bash', { command: 'x'.repeat(200) }).length).toBe(120)
})

// ---------- The Session tab ----------

const PANE = {
  plugin: 'nextup',
  component: 'Pane',
  requestId: 'nextup',
  props: {
    title: 'Next up',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const text = async (ui: { find: (q: never) => Promise<unknown> }, t: string | RegExp) => ui.find({ type: 'Text', text: t } as never)

test('with no board the pane opens on the Session tab, empty states on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, 'No tool calls yet. Each one shows here as it runs.')).toBeDefined()
    expect(await text(ui, 'No files edited or written yet.')).toBeDefined()
    expect(await text(ui, 'Shell commands')).toBeUndefined()
    expect(await text(ui, 'No data folder set.')).toBeDefined()
    await ui.unmount()
  }
})

test('before the first prompt This turn has no status glyph', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await text(ui, 'No turn yet')).toBeDefined()
  expect(await text(ui, /^[✓◐]$/)).toBeUndefined()
  await ui.unmount()
})

test('Permissions headline stays actionable instead of counting completed checks', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await text(ui, '0 waiting · 0 denied')).toBeDefined()
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/b.ts` })
  expect(await text(ui, '0 waiting · 0 denied')).toBeDefined()
  expect((await ui.find({ key: 'gate-allowed' }))?.props.label).toBe('2 allowed')
  await ui.unmount()
})

test('terminal: log rows at 70 columns keep time, separators and who on one line', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'helper' }))
  await clock.advance(7 * 3600_000 + 53 * 60_000)
  await $.prompt.submit({ text: 'A long prompt '.repeat(20), wait: false, origin: 'user' } as never)
  await $.agent.spawn({ prompt: 'Review', description: 'A very long helper name' } as never)
  await $.tool.call({ tool: 'Bash', command: 'A long command '.repeat(20), agentId: 'helper' } as never)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/${'long-path/'.repeat(20)}a.ts` })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 70 }, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Box' })).filter(row => row.key?.startsWith('al-'))
  expect(rows.length).toBe(3)
  for (const row of rows) {
    expect(row.props.flexWrap).toBe('nowrap')
    const columns = row.children as { props: Record<string, unknown>; children: { props: Record<string, unknown> }[] }[]
    // Four fixed columns (5 + 1 + 12 + 1) plus four gaps leave room for what,
    // even after the pane and card padding/borders. No fixed text may wrap.
    expect(columns.slice(0, 4).map(c => c.props.width)).toEqual([5, 1, 12, 1])
    for (const c of columns.slice(0, 4)) {
      expect(c.props.flexShrink).toBe(0)
      expect(c.children[0]?.props.wrap).toBe('truncate-end')
    }
    expect(columns[4]?.props.minWidth).toBe(0)
    expect(columns[4]?.children[0]?.props.wrap).toBe('truncate-end')
  }
  await ui.unmount()
})

test('after tool calls the log, files and commands show, newest first', async ($, on) => {
  engine(on, e => (e.command === 'false' ? { result: {}, text: 'exit 1', isError: true } : { result: {}, text: 'ok' }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, 'No tool calls yet. Each one shows here as it runs.')).toBeDefined()
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'Bash', command: 'true' })
  expect((await ui.findAll({ type: 'Text', text: /^Bash · / })).map(t => t.text)).toEqual(['Bash · true', 'Bash · false'])
  expect(await text(ui, 'No tool calls yet. Each one shows here as it runs.')).toBeUndefined()
  expect(await text(ui, '▸ a.ts')).toBeDefined()
  expect(await text(ui, 'src/ · ×2 · now')).toBeDefined()
  expect(await text(ui, 'Bash · false')).toBeDefined()
  expect(await text(ui, 'No shell commands yet.')).toBeUndefined()
  await ui.unmount()
})

test('concept C: uniform unfolded cards, file metadata, log identities and no Shell card', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the pane\nMore context', wait: false, origin: 'user' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/src/a.ts`, content: '' })
  await $.tool.call({ tool: 'Bash', command: 'git status --short' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, 'This turn')).toBeDefined()
    expect(await text(ui, / · 1 edits · 0 errors/)).toBeDefined()
    expect(await text(ui, 'you')).toBeDefined()
    expect(await text(ui, 'main')).toBeDefined()
    expect(await text(ui, 'Fix the pane')).toBeDefined()
    expect(await text(ui, 'Bash · git status --short')).toBeDefined()
    expect(await text(ui, 'newest first')).toBeDefined()
    expect(await text(ui, 'src/ · ×1 · now')).toBeDefined()
    expect(await ui.find({ key: 'fold-log' })).toBeUndefined()
    expect(await text(ui, 'Shell commands')).toBeUndefined()
    const drawing = JSON.stringify(await ui.drawn())
    expect(drawing.indexOf('Files touched') < drawing.indexOf('Session log')).toBe(true)
    expect(await ui.find({ key: 'gate-track' })).toBeUndefined()
    expect(await text(ui, /█|file 1  ·  shell 1/)).toBeUndefined()
    for (const kind of ['file', 'shell', 'other']) expect(await ui.find({ key: `pill-${kind}` })).toBeUndefined()
    // Every surface's label carries the count: a desktop's native button draws only its label.
    const lead = (n: number) => `${n} `
    expect((await ui.find({ key: 'gate-allowed' }))?.props.label).toBe(`${lead(2)}allowed`)
    expect((await ui.find({ key: 'gate-asked' }))?.props.label).toBe(`${lead(0)}asked you`)
    expect((await ui.find({ key: 'gate-denied' }))?.props.label).toBe(`${lead(0)}denied`)
    await ui.unmount()
  }
})

test('a long log shows the newest rows and Show more opens the rest', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 20; i++) await $.tool.call({ tool: 'Read', file_path: `${CWD}/r${i}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, 'Read · r19')).toBeDefined()
  // Seven rows before Show more: r19 down to r13.
  expect(await text(ui, 'Read · r13')).toBeDefined()
  expect(await text(ui, 'Read · r12')).toBeUndefined()
  expect((await ui.find({ key: 'amore-log' }))?.props.label).toBe('Show 13 more')
  await ui.press({ key: 'amore-log' } as never)
  expect(await text(ui, 'Read · r0')).toBeDefined()
  await ui.unmount()
})

const ev = (id: string, tool: string, status: ToolEvent['status'], at = 0, ms?: number, summary = ''): ToolEvent => ({ id, at, tool, summary, status, ...(ms === undefined ? {} : { ms }) })

test('the gate counts finished calls as allowed, denied calls as denied, and keeps running ones apart', () => {
  const g = gateStats([ev('1', 'Read', 'ok'), ev('2', 'Bash', 'failed'), ev('3', 'Bash', 'denied'), ev('4', 'Agent', 'running'), ev('5', 'WebFetch', 'ok')])
  expect(g).toEqual({ total: 4, allowed: 3, denied: 1, running: 1 })
  expect(gateStats([])).toEqual({ total: 0, allowed: 0, denied: 0, running: 0 })
})

test('helpers use spawn lifetimes on a shared axis, with their own calls as ticks', () => {
  const calls = [
    { ...ev('x', 'Read', 'ok', 2000, 5, 'a.ts'), agent: 'b' },
    { ...ev('y', 'Bash', 'failed', 3000, 5, 'false'), agent: 'b' },
    { ...ev('z', 'Bash', 'denied', 7000, 5, 'rm'), agent: 'c' },
    ev('m', 'Read', 'ok', 500, 5, 'main.ts'),
  ]
  const runs = helperRuns(calls, 11_000, [{ id: 'b', name: 'Verify', at: 1000, end: 5000 }, { id: 'c', name: 'Review', at: 6000 }])
  expect(runs.map(r => [r.name, r.status])).toEqual([['Verify', 'ok'], ['Review', 'running']])
  // The axis runs from the earliest helper start to now.
  expect(runs[0]).toMatchObject({ at: 1000, start: 0, len: 0.4, ms: 4000, calls: 2 })
  expect(runs[1]).toMatchObject({ at: 6000, start: 0.5, len: 0.5, calls: 1 })
  // The newest call is what the helper is doing now; main-loop calls belong to no helper.
  expect(runs[0]!.last?.id).toBe('y')
  expect(runs[0]!.ticks).toEqual([{ id: 'x', at: 0.1, bad: false }, { id: 'y', at: 0.2, bad: true }])
  expect(runs[1]!.ticks).toEqual([{ id: 'z', at: 0.6, bad: true }])
  expect(helperRuns([], 1000)).toEqual([])
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: Helpers lists what each helper is doing now, newest first, over a ticked timeline`, async ($, on) => {
    engine(on, e => e.command === 'false' ? { result: {}, text: 'failed', isError: true } : { result: {}, text: 'ok' })
    const clock = mock.clock(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'haiku', agentId: `h${++n}` }))
    on('turn.complete', () => ({ text: '' }))
    await clock.advance(3600_000)
    await $.agent.spawn({ prompt: 'Review', description: 'Reviewer' } as never)
    await clock.advance(10_000)
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, agentId: 'h1' } as never)
    await clock.advance(10_000)
    await $.tool.call({ tool: 'Bash', command: 'false', agentId: 'h1' } as never)
    await clock.advance(10_000)
    await $.turn.complete({ agentId: 'h1', answer: '', reason: 'completed' } as never)
    await $.agent.spawn({ prompt: 'Verify', description: 'Verifier' } as never)
    await clock.advance(5_000)
    await $.tool.call({ tool: 'Grep', pattern: 'todo', agentId: 'h2' } as never)
    await clock.advance(20_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    const card = await ui.find({ key: 'pc-help' })
    const json = JSON.stringify(card)
    // Newest first: the running Verifier above the finished Reviewer.
    expect(json.indexOf('hn-h2')).toBeLessThan(json.indexOf('hn-h1'))
    const h1 = JSON.stringify(await ui.find({ key: 'hn-h1' }))
    const h2 = JSON.stringify(await ui.find({ key: 'hn-h2' }))
    expect(h1.includes('Reviewer')).toBe(true)
    expect(h1.includes('Running command')).toBe(true)
    expect(h1.includes('Bash · false')).toBe(false)
    expect(h1.includes('0:30')).toBe(true)
    expect(h1.includes('2 calls')).toBe(true)
    expect(h1.includes('✓')).toBe(true)
    expect(h2.includes('Verifier')).toBe(true)
    expect(h2.includes('Searching files')).toBe(true)
    // Running: elapsed since its start, live.
    expect(h2.includes('0:25')).toBe(true)
    expect(h2.includes('1 call')).toBe(true)
    expect(h2.includes('◌')).toBe(true)
    // The shared axis: the earliest start on the left, now on the right.
    const axis = JSON.stringify(await ui.find({ key: 'help-axis' }))
    expect(axis.includes('now')).toBe(true)
    expect(/\d\d:\d\d/.test(axis)).toBe(true)
    // One tick per call, the failed one red.
    const line = JSON.stringify(await ui.find({ key: 'hl-h1' }))
    if (surface === 'desktop') {
      expect((await ui.find({ key: 'tick-h1-0' }))?.props.backgroundColor).toBe('claude')
      expect((await ui.find({ key: 'tick-h1-1' }))?.props.backgroundColor).toBe('error')
      expect(await ui.find({ key: 'tick-h1-2' })).toBeUndefined()
    } else {
      // Count drawn runs only; the find result also carries a flattened text copy.
      expect((line.match(/"children":\["│"\]/g) ?? []).length).toBe(2)
      expect(line.includes('"error"')).toBe(true)
    }
    await ui.unmount()
  })
}

test('regression: a 73ms Agent launch with completion three minutes later shows 3:00', async ($, on) => {
  engine(on, null)
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'review-1' }))
  on('tool.call', async () => {
    await $.agent.spawn({ prompt: 'Review', description: 'Review migration' } as never)
    await clock.advance(73)
    return { result: {}, text: 'launched' }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'Review migration' } as never)
  expect((await read($, log))[0]?.ms).toBe(73)
  await clock.advance(180_000 - 73)
  await $.turn.complete({ agentId: 'review-1', answer: '', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, '3:00')).toBeDefined()
  expect(await text(ui, /73ms/)).toBeUndefined()
  expect(await text(ui, '0 running · 1 total')).toBeDefined()
  await ui.unmount()
})

test('permission prompts are observed, not inferred from successful calls', async ($, on) => {
  engine(on, null)
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'pwd' } } as never)
    return { result: {}, text: 'ok' }
  })
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  expect(gateStats(await read($, log))).toMatchObject({ total: 2, allowed: 1, asked: 1, denied: 0 })
})

test('only a main-loop completion ends This turn; the next prompt resets edit and error counts', async ($, on) => {
  engine(on, () => ({ result: {}, text: 'failed', isError: true }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  await $.prompt.submit({ text: 'First turn', wait: false, origin: 'user' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.turn.complete({ agentId: 'helper', answer: '', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, '◐')).toBeDefined()
  expect(await text(ui, /0 edits · 1 errors/)).toBeDefined()
  await $.turn.complete({ answer: '', reason: 'completed' } as never)
  expect(await text(ui, '✓')).toBeDefined()
  await clock.advance(1000)
  await $.prompt.submit({ text: 'Second turn', wait: false, origin: 'user' } as never)
  expect(await text(ui, /0 edits · 0 errors/)).toBeDefined()
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: This turn opens to list this turn's calls, errors included`, async ($, on) => {
    engine(on, e => e.tool === 'Bash' ? { result: {}, text: 'failed', isError: true } : { result: {}, text: 'ok' })
    on('prompt.submit', (_, e) => ({ text: e.text }))
    const clock = mock.clock(on)
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/before` })
    await clock.advance(1000)
    await $.prompt.submit({ text: 'Fix it', wait: false, origin: 'user' } as never)
    await $.tool.call({ tool: 'Bash', command: 'false' })
    await $.tool.call({ tool: 'Write', file_path: `${CWD}/a.ts`, content: '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'turn-calls-list' })).toBeUndefined()
    expect((await ui.find({ key: 'turn-calls' }))?.props.label).toBe('2 calls ▸')
    await ui.press({ key: 'turn-calls' } as never)
    const list = JSON.stringify((await ui.find({ key: 'turn-calls-list' }))?.children)
    expect(list.includes('Bash · false')).toBe(true)
    expect(list.includes('Write · a.ts')).toBe(true)
    // Only this turn: the call before the prompt is not listed.
    expect(list.includes('before')).toBe(false)
    expect((await ui.find({ key: 'turn-calls' }))?.props.label).toBe('2 calls ▾')
    await ui.press({ key: 'turn-calls' } as never)
    expect(await ui.find({ key: 'turn-calls-list' })).toBeUndefined()
    await ui.unmount()
  })
}

// ---------- 0.4.14: Darren's live feedback on the Helpers card and Session log ----------

test('desktop helper lanes are a thin line, half the old height, running or finished', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `h${++n}` }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ prompt: 'A', description: 'Done one' } as never)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, agentId: 'h1' } as never)
  await $.turn.complete({ agentId: 'h1', answer: '', reason: 'completed' } as never)
  await $.agent.spawn({ prompt: 'B', description: 'Still going' } as never)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const lanes = (await ui.findAll({ type: 'Box' })).filter(b => /^hs-h[12]-/.test(b.key ?? '') && b.props.backgroundColor)
  expect(lanes.some(b => b.key!.startsWith('hs-h1-'))).toBe(true)
  expect(lanes.some(b => b.key!.startsWith('hs-h2-'))).toBe(true)
  for (const lane of lanes) expect(lane.props.height).toBe(0.25)
  // Ticks stay a full cell tall so each call still reads.
  expect((await ui.find({ key: 'tick-h1-0' }))?.props.height).toBe(1)
  await ui.unmount()
})

test('once every helper has finished the axis ends at the last finish, so lanes stop shrinking', () => {
  const records = [{ id: 'b', name: 'Verify', at: 1000, end: 5000 }, { id: 'c', name: 'Review', at: 3000, end: 9000 }]
  const calls = [{ ...ev('x', 'Read', 'ok', 2000, 5, 'a.ts'), agent: 'b' }]
  const soon = helperRuns(calls, 10_000, records)
  const later = helperRuns(calls, 3_600_000, records)
  expect(later).toEqual(soon)
  expect(soon[1]).toMatchObject({ start: 0.25, len: 0.75 })
  expect(helperAxis(records, 3_600_000)).toEqual({ first: 1000, last: 9000, live: false })
  // While one runs the axis still ends at now.
  expect(helperAxis([...records, { id: 'd', name: 'Live', at: 9500 }], 20_000)).toEqual({ first: 1000, last: 20_000, live: true })
})

test('spans read as seconds, minutes and hours', () => {
  expect(span(0)).toBe('0s')
  expect(span(45_000)).toBe('45s')
  expect(span(80_000)).toBe('1m 20s')
  expect(span(120_000)).toBe('2m')
  expect(span(3_900_000)).toBe('1h 5m')
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the helper axis has a time scale and ends at the last finish once all are done`, async ($, on) => {
    engine(on)
    const clock = mock.clock(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'h1' }))
    on('turn.complete', () => ({ text: '' }))
    await clock.advance(3600_000)
    await $.agent.spawn({ prompt: 'A', description: 'Reviewer' } as never)
    await clock.advance(80_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    // The drawn words only: the props hold "nowrap".
    let axis = (await ui.find({ key: 'help-axis' }) as { text?: string } | undefined)?.text ?? ''
    // Running: start time, a midpoint, and the whole span ending now.
    expect(axis.includes('+40s')).toBe(true)
    expect(axis.includes('1m 20s · now')).toBe(true)
    await ui.unmount()
    await $.turn.complete({ agentId: 'h1', answer: '', reason: 'completed' } as never)
    await clock.advance(600_000)
    const after = await $.ui.mount({ ...PANE, surface })
    axis = (await after.find({ key: 'help-axis' }) as { text?: string } | undefined)?.text ?? ''
    // Finished: the span stays 1m 20s ten minutes later and the end is a time, not now.
    expect(axis.includes('now')).toBe(false)
    expect(axis.includes('1m 20s · ')).toBe(true)
    expect(axis.includes('+40s')).toBe(true)
    await after.unmount()
  })
}

test('an internal hand-back call never shows as what a helper is doing', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'h1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ prompt: 'A', description: 'Checker' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'todo', agentId: 'h1' } as never)
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'h1' } as never)
  await $.turn.complete({ agentId: 'h1', answer: '', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = JSON.stringify(await ui.find({ key: 'hn-h1' }))
  expect(row.includes('SubagentHandback')).toBe(false)
  // Only the hand-back itself is hidden: a tool that merely has the word in its name still shows.
  expect(helperRuns([{ ...ev('m', 'mcp__crm__log_handback', 'ok', 5), agent: 'x' }], 10, [{ id: 'x', name: 'X', at: 0 }])[0]!.last?.id).toBe('m')
  expect(row.includes('Searching files')).toBe(true)
  expect(row.includes('Grep · todo')).toBe(false)
  await ui.unmount()
})

test('a helper that only handed back reads done, not an empty tool line', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'h1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ prompt: 'A', description: 'Checker' } as never)
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'h1' } as never)
  await $.turn.complete({ agentId: 'h1', answer: '', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = JSON.stringify(await ui.find({ key: 'hn-h1' }))
  expect(row.includes(' · ')).toBe(true) // the time · calls column only
  expect(row.includes('Handback')).toBe(false)
  expect(row.includes('"done"')).toBe(true)
  await ui.unmount()
})

test('a helper message in the Session log names the helper, not you', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1b2c3' }))
  await $.agent.spawn({ prompt: 'A', description: 'Audit helpers' } as never)
  await $.prompt.submit({ text: 'Fix it', wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: '<task-notification><task-id>a1b2c3</task-id><summary>Agent "Audit helpers" completed</summary></task-notification>', wait: false, origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: 'From HQ: keep Array<string> as is', wait: false, origin: { kind: 'peer-send-message' } } as never)
  // A background shell's notification names no helper: it is the main loop's.
  await $.prompt.submit({ text: '<task-notification><task-id>b9</task-id><summary>Background command finished</summary></task-notification>', wait: false, origin: { kind: 'task-notification' } } as never)
  const events = await read($, log)
  expect(events.map(x => x.from)).toEqual([undefined, 'Audit helpers', 'session', 'main'])
  // A notification reads as its summary; any other message keeps its words, angle brackets and all.
  expect(events[1]!.summary).toBe('Agent "Audit helpers" completed')
  expect(events[2]!.summary).toBe('From HQ: keep Array<string> as is')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const logCard = JSON.stringify(await ui.find({ key: 'pc-log' }))
  expect(logCard.includes('Audit helpers')).toBe(true)
  // The notification's tags are not the summary; its own words are.
  expect(logCard.includes('<task-notification>')).toBe(false)
  expect(logCard.includes('Agent \\"Audit helpers\\" completed')).toBe(true)
  expect((logCard.match(/"you"/g) ?? []).length).toBe(1)
  await ui.unmount()
})

test('desktop permission tiles and file rows are one native Button each, stretched across, with no hit overlay', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/a.ts`, content: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const kind of ['waiting', 'asked', 'denied']) {
    expect(await ui.find({ key: `hit-gate-${kind}` } as never)).toBeUndefined()
    const tile = await ui.find({ key: `gate-tile-${kind}` })
    expect(tile?.props).toMatchObject({ flexDirection: 'column', alignItems: 'stretch' })
    // The Button is the tile's only child, so its whole box is the press target, and it holds the dot and the count.
    expect(tile!.children.length).toBe(1)
    const button = tile!.children[0] as { type: string; props: { key?: string } }
    expect(button.type).toBe('Button')
    expect(button.props.key).toBe(`gate-${kind}`)
  }
  expect((await ui.find({ key: 'gate-allowed' }))?.props.label).toBe('1 allowed')
  expect(await ui.find({ key: 'hit-file-a.ts' } as never)).toBeUndefined()
  const row = await ui.find({ key: 'af-a.ts' })
  expect(row?.props).toMatchObject({ flexDirection: 'column', alignItems: 'stretch' })
  expect(row!.children.length).toBe(1)
  const file = JSON.stringify(row!.children[0])
  expect(file.includes('▸ a.ts')).toBe(true)
  expect(file.includes('./ · ×1 · now')).toBe(true)
  await ui.press({ key: 'file-a.ts' } as never)
  expect(await ui.find({ key: 'file-edits-a.ts' })).toBeDefined()
  await ui.unmount()
})

// ---------- 0.4.15: the latest batch of helpers, clean separators, hand-backs uncounted ----------

test('helper batches: a helper starting more than two minutes after the batch so far ends begins a new batch', () => {
  const MIN = 60_000
  const a = [{ id: 'a1', name: 'A1', at: 0, end: 20_000 }, { id: 'a2', name: 'A2', at: 5_000, end: 25_000 }]
  const b = [{ id: 'b1', name: 'B1', at: 29 * MIN, end: 29 * MIN + 15_000 }, { id: 'b2', name: 'B2', at: 29 * MIN + 90_000, end: 29 * MIN + 110_000 }]
  // b2 starts 75s after b1 ended: within two minutes, the same batch.
  expect(latestBatch([...a, ...b], 40 * MIN).map(x => x.id)).toEqual(['b1', 'b2'])
  expect(latestBatch(a, 40 * MIN).map(x => x.id)).toEqual(['a1', 'a2'])
  // A running helper stretches its batch to now, so one started a minute ago joins it.
  expect(latestBatch([{ id: 'r', name: 'R', at: 0 }, { id: 's', name: 'S', at: 10 * MIN }], 11 * MIN).map(x => x.id)).toEqual(['r', 's'])
  expect(latestBatch([], 1000)).toEqual([])
  // Order does not matter: shuffled starts sort into one batch, and the lanes keep its newest six.
  const eight = [5, 2, 7, 0, 3, 6, 1, 4].map(i => ({ id: `e${i}`, name: `E${i}`, at: i * 1000, end: i * 1000 + 30_000 }))
  expect(latestBatch(eight, 60_000).slice(-6).map(x => x.id)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
})

test('desktop Helpers draws lanes and the axis for the latest batch only, and lists every helper as doing now', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `h${++n}` }))
  on('turn.complete', () => ({ text: '' }))
  await clock.advance(3600_000)
  await $.agent.spawn({ prompt: 'A', description: 'Early' } as never)
  await clock.advance(20_000)
  await $.turn.complete({ agentId: 'h1', answer: '', reason: 'completed' } as never)
  await clock.advance(29 * 60_000)
  await $.agent.spawn({ prompt: 'B', description: 'Late' } as never)
  await clock.advance(20_000)
  await $.turn.complete({ agentId: 'h2', answer: '', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'hn-h1' })).toBeDefined()
  expect(await ui.find({ key: 'hn-h2' })).toBeDefined()
  expect(await ui.find({ key: 'hl-h1' })).toBeUndefined()
  expect(await ui.find({ key: 'hl-h2' })).toBeDefined()
  const axis = (await ui.find({ key: 'help-axis' }) as { text?: string } | undefined)?.text ?? ''
  expect(axis.includes('20s · ')).toBe(true)
  expect(axis.includes('+10s')).toBe(true)
  await ui.unmount()
})

test('a log row with no detail drops the trailing separator', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'ArtifactComments' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const card = JSON.stringify(await ui.find({ key: 'pc-log' }))
  expect(card.includes('"ArtifactComments"')).toBe(true)
  expect(card.includes('ArtifactComments ·')).toBe(false)
  await ui.unmount()
})

test('hand-back calls are neither counted nor ticked', () => {
  const calls = [
    { ...ev('g', 'Grep', 'ok', 10, 5, 'x'), agent: 'h' },
    { ...ev('s', 'SubagentHandback', 'ok', 20, 5), agent: 'h' },
    { ...ev('o', 'StructuredOutput', 'ok', 30, 5), agent: 'h' },
  ]
  const [run] = helperRuns(calls, 100, [{ id: 'h', name: 'H', at: 0, end: 40 }])
  expect(run!.calls).toBe(1)
  expect(run!.ticks.map(t => t.id)).toEqual(['g'])
})

// ---------- 0.4.16: wrapped messages read as short labels; an idle helper does not hold its batch open ----------

test('wrapped messages in the log read as short labels with the right sender', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ad42c300fae53c9d5' }))
  await $.agent.spawn({ prompt: 'A', description: 'Map remaining work' } as never)
  const send = (text: string, kind: string) => $.prompt.submit({ text, wait: false, origin: { kind } } as never)
  await send('<agent-message from="ad42c300fae53c9d5">\n[Subagent hand-back] The report follows: all done\n</agent-message>', 'peer-send-message')
  await send('<agent-message data-from="ad42c300fae53c9d5" from="zzz999">\nreport\n</agent-message>', 'unclassified')
  await send('<cross-session-message from="local_ee22" name="nextup HQ: Session tab polish">\nHQ here. Go.\n</cross-session-message>', 'peer')
  await send('<cross-session-message from="local_ee22">\nHi\n</cross-session-message>', 'peer')
  await send('<task-notification>\n<task-id>ad42c300fae53c9d5</task-id>\n<status>completed</status>\n</task-notification>', 'task-notification')
  await send('<side-sessions-event>\nchild done\n</side-sessions-event>', 'auto-continuation')
  // Typed by the person: kept as typed, even when it starts with a tag.
  await send('<b>bold</b> please', 'composer')
  const rows = (await read($, log)).map(x => [x.from, x.summary])
  expect(rows).toEqual([
    ['Map remaining work', 'reported back'],
    ['helper', 'reported back'],
    ['session', 'message from nextup HQ: Session tab polish'],
    ['session', 'message from another session'],
    ['Map remaining work', 'task completed'],
    ['main', 'side sessions event'],
    [undefined, '<b>bold</b> please'],
  ])
})

test('a running helper with no calls for over two minutes no longer holds its batch open', () => {
  const MIN = 60_000
  const idle = { id: 'idle', name: 'Idle', at: 0 }
  const fresh = { id: 'new', name: 'New', at: 90 * MIN }
  // Its last call was at 5 min: a helper starting at 90 min begins a new batch, so the axis is not hours long.
  const calls = [{ ...ev('c', 'Read', 'ok', 5 * MIN, 5), agent: 'idle' }]
  expect(latestBatch([idle, fresh], 91 * MIN, calls).map(x => x.id)).toEqual(['new'])
  // A call a minute ago keeps it in the batch.
  const busy = [...calls, { ...ev('d', 'Read', 'ok', 89 * MIN, 5), agent: 'idle' }]
  expect(latestBatch([idle, fresh], 91 * MIN, busy).map(x => x.id)).toEqual(['idle', 'new'])
  // A helper still in its first ten minutes counts as busy even with no calls yet (it may be thinking).
  expect(latestBatch([{ id: 't', name: 'T', at: 0 }, { id: 'n', name: 'N', at: 4 * MIN }], 4 * MIN, []).map(x => x.id)).toEqual(['t', 'n'])
})

test('the Session log hides hand-back and structured-output calls, since "reported back" covers them', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'h1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ prompt: 'A', description: 'Checker' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'todo', agentId: 'h1' } as never)
  await $.tool.call({ tool: 'StructuredOutput', agentId: 'h1' } as never)
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'h1' } as never)
  await $.tool.call({ tool: 'mcp__crm__log_handback' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const logCard = JSON.stringify(await ui.find({ key: 'pc-log' }))
  expect(logCard.includes('SubagentHandback')).toBe(false)
  expect(logCard.includes('StructuredOutput')).toBe(false)
  expect(logCard.includes('todo')).toBe(true)
  // Only those two exact tools are hidden.
  expect(logCard.includes('log_handback')).toBe(true)
  await ui.unmount()
})
