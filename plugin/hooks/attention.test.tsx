import { expect, mock, test } from 'claude-code/testing'
import { parseAttention, projectFlag, mergeRatings, attentionSparkline } from './attention'

const day = (day = '2026-10-24', a = 3, c = 0) => ({ day, a, b: 0, c, d: 0, total: a + c, blocked_wait_min: 12 })
const fixture = () => ({
  totals: [day('2026-10-24', 4, 1), day('2026-10-23')],
  projects: [{ project: 'ordinary', trial: false, days: [day()] }, { project: 'trial', trial: true, days: [day('2026-10-24', 1, 1)] }],
  recent: Array.from({ length: 24 }, (_, i) => ({ id: `i${i}`, project: i === 23 ? 'ordinary' : 'trial', day: '2026-10-24', ts: `2026-10-24T10:${String(i).padStart(2, '0')}:00Z`, cls: 'a', summary: `Question ${i}`, wait_min: i })),
})
const PANE = { plugin: 'nextup', component: 'Pane', requestId: 'nextup', surface: 'desktop', props: { title: 'Next up', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

test('parsing selects newest totals day, sorts trial projects first and rejects malformed input', () => {
  const data = parseAttention(fixture())!
  expect(data.today).toBe('2026-10-24')
  expect(data.projects.map(p => p.project)).toEqual(['trial', 'ordinary'])
  expect(data.recent[0]!.id).toBe('i23')
  expect(parseAttention(null)).toBeNull()
  expect(parseAttention({ totals: 'bad' })).toBeNull()
  expect(parseAttention({ totals: [{ day: 'bad' }] })).toBeNull()
})

test('flags apply strictly above three or below 90 percent a+b, with zero unflagged', () => {
  expect(projectFlag(day('2026-10-24', 4))).toBe(true)
  expect(projectFlag(day('2026-10-24', 2, 1))).toBe(true)
  expect(projectFlag(day())).toBe(false)
  expect(projectFlag({ ...day(), a: 0.9, total: 1 })).toBe(false)
  expect(projectFlag(day('2026-10-24', 0))).toBe(false)
})

test('rating merge uses newest timestamps and keeps other ids', () => {
  const old = { rating: 'worth', at: '2026-10-24T10:00:00Z' } as const
  const fresh = { rating: 'not', at: '2026-10-24T11:00:00Z' } as const
  expect(mergeRatings({ x: fresh, other: old }, { x: old, next: fresh })).toEqual({ x: fresh, other: old, next: fresh })
})

test('template mode hides Attention and does not read its files', async ($, on) => {
  const reads: string[] = []
  on('fs.read', (_, e) => { reads.push(e.path); return { value: '{}' } })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'panel-attention' })).toBeUndefined()
  expect(reads.filter(p => p.includes('interruption'))).toEqual([])
  await ui.unmount()
})

test('missing interruptions file hides Attention', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on)
  on('fs.exists', () => ({ value: false }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'panel-attention' })).toBeUndefined()
  await ui.unmount()
})

test('Attention draws on both surfaces, filters, caps, rates and changes ratings', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
  let ratings = JSON.stringify({ other: { rating: 'worth', at: '2026-10-24T09:00:00Z' } })
  on('fs.exists', (_, e) => ({ value: e.path.includes('interruption') }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('interruption-ratings.json') ? ratings : JSON.stringify(fixture()) }))
  on('fs.stat', () => ({ value: { mtimeMs: 0, size: ratings.length, kind: 'file', isLink: false } }))
  on('fs.write', (_, e) => { ratings = e.text; return { value: undefined } })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'panel-attention' })).toBeUndefined()
    await ui.press({ key: 'summary-toggle-attention' } as never)
    expect(await ui.find({ type: 'Text', text: 'Interruptions today: 5 (target 3 per project)' })).toBeDefined()
    expect((await ui.findAll({ type: 'Box' })).filter(x => x.key?.startsWith('attention-recent-')).length).toBe(20)
    expect(await ui.find({ key: 'attention-recent-i23' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /14 days through 2026-10-24/ })).toBeDefined()
    await ui.press({ key: 'attention-all' } as never)
    expect(await ui.find({ key: 'attention-recent-i23' })).toBeDefined()
    await ui.press({ key: 'attention-worth-i23' } as never)
    expect(JSON.parse(ratings).i23.rating).toBe('worth')
    expect(JSON.parse(ratings).other.rating).toBe('worth')
    await ui.press({ key: 'attention-not-i23' } as never)
    expect(JSON.parse(ratings).i23.rating).toBe('not')
    expect(await ui.find({ type: 'Text', text: 'Rated: Not' })).toBeDefined()
    await ui.press({ key: 'attention-all' } as never)
    await ui.press({ key: 'summary-toggle-attention' } as never)
    await ui.unmount()
  }
})

test('the All projects toggle redraws from state, with no invalidate', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
  let invalidated = 0
  // Swallow every invalidate: only a state write can redraw the card.
  on('ui.invalidate', () => (invalidated += 1, { value: undefined } as never))
  on('fs.exists', (_, e) => ({ value: e.path.includes('interruption') }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('interruption-ratings.json') ? '{}' : JSON.stringify(fixture()) }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'summary-toggle-attention' } as never)
  expect(await ui.find({ key: 'attention-recent-i23' })).toBeUndefined()
  await ui.press({ key: 'attention-all' } as never)
  expect(await ui.find({ key: 'attention-recent-i23' })).toBeDefined()
  expect((await ui.find({ key: 'attention-all' }))?.props.label).toBe('All projects ✓')
  await ui.press({ key: 'attention-all' } as never)
  expect(await ui.find({ key: 'attention-recent-i23' })).toBeUndefined()
  expect(invalidated).toBe(0)
  await ui.unmount()
})

test('reads are throttled for 60 seconds', { options: { dataDir: '/board' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let count = 0
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => { if (e.path.endsWith('/interruptions.json')) count++; return { value: e.path.endsWith('/interruptions.json') ? JSON.stringify(fixture()) : '{}' } })
  let ui = await $.ui.mount(PANE)
  await ui.unmount()
  ui = await $.ui.mount(PANE)
  expect(count).toBe(1)
  await ui.unmount()
  await clock.advance(60_000)
  ui = await $.ui.mount(PANE)
  expect(count).toBe(2)
  await ui.unmount()
})

test('sparkline covers fourteen calendar days and fills missing days', () => {
  const data = parseAttention({ totals: [day('2026-10-24', 4), day('2026-10-22', 2)] })!
  expect(attentionSparkline(data)).toBe('▁'.repeat(11) + '▅▁█')
})

test('a missing file is cached, then discovered on a later draw', { options: { dataDir: '/board' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let present = false
  let reads = 0
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/interruptions.json')) { reads++; if (!present) throw new Error('ENOENT') }
    return { value: JSON.stringify(fixture()) }
  })
  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'panel-attention' })).toBeUndefined()
  await ui.unmount()
  present = true
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'panel-attention' })).toBeUndefined()
  expect(reads).toBe(1)
  await ui.unmount()
  await clock.advance(60_000)
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'summary-attention' })).toBeDefined()
  expect(reads).toBe(2)
  await ui.unmount()
})

test('rating writes reread disk, preserve newer ratings and refuse malformed ratings', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
  let ratings = '{}'
  let writes = 0
  on('fs.exists', (_, e) => ({ value: e.path.includes('interruption') }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/interruption-ratings.json') ? ratings : JSON.stringify(fixture()) }))
  on('fs.stat', () => ({ value: { mtimeMs: 0, size: ratings.length, kind: 'file', isLink: false } }))
  on('fs.write', (_, e) => { writes++; ratings = e.text; return { value: undefined } })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'summary-toggle-attention' } as never)
  ratings = JSON.stringify({ i22: { rating: 'not', at: '2026-10-25T00:00:00Z' }, external: { rating: 'worth', at: '2026-10-24T11:00:00Z' } })
  await ui.press({ key: 'attention-worth-i22' } as never)
  expect(JSON.parse(ratings).i22.rating).toBe('not')
  expect(JSON.parse(ratings).external.rating).toBe('worth')
  expect(writes).toBe(1)
  ratings = '{bad'
  await ui.press({ key: 'attention-worth-i21' } as never)
  expect(writes).toBe(1)
  expect(ratings).toBe('{bad')
  await ui.unmount()
})

test('rating write retries a changed file and keeps the concurrent id', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
  let ratings = '{}'
  let stamps = 0
  on('fs.exists', (_, e) => ({ value: e.path.includes('interruption') }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/interruption-ratings.json') ? ratings : JSON.stringify(fixture()) }))
  on('fs.stat', () => {
    if (++stamps === 2) ratings = JSON.stringify({ concurrent: { rating: 'worth', at: '2026-10-24T11:00:00Z' } })
    return { value: { mtimeMs: stamps >= 2 ? 1 : 0, size: ratings.length, kind: 'file', isLink: false } }
  })
  on('fs.write', (_, e) => { ratings = e.text; return { value: undefined } })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'summary-toggle-attention' } as never)
  await ui.press({ key: 'attention-worth-i22' } as never)
  expect(JSON.parse(ratings).concurrent.rating).toBe('worth')
  expect(JSON.parse(ratings).i22.rating).toBe('worth')
  expect(stamps).toBe(4)
  await ui.unmount()
})

test('overlapping desktop and terminal draws share one file read', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  let reads = 0
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => { if (e.path.endsWith('/interruptions.json')) reads++; return { value: JSON.stringify(fixture()) } })
  const views = await Promise.all([$.ui.mount(PANE), $.ui.mount({ ...PANE, surface: 'terminal' })])
  expect(reads).toBe(1)
  for (const ui of views) {
    expect(await ui.find({ key: 'summary-attention' })).toBeDefined()
    await ui.unmount()
  }
})

test('minute polling reads only while the Next pane is drawn', { options: { dataDir: '/board' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let visible = true
  let reads = 0
  on('ui.panes', () => ({ value: [{ id: 'nextup', isPlaced: visible, isShown: visible }] as never }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => { if (e.path.endsWith('/interruptions.json')) reads++; return { value: JSON.stringify(fixture()) } })
  const ui = await $.ui.mount(PANE)
  expect(reads).toBe(1)
  await clock.advance(60_000)
  expect(reads).toBe(2)
  visible = false
  await clock.advance(60_000)
  expect(reads).toBe(2)
  visible = true
  await ui.press({ key: 'tab-session' } as never)
  await clock.advance(60_000)
  expect(reads).toBe(2)
  await ui.unmount()
})
