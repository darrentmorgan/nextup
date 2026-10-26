import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Thread } from '../types'
import { delegateThreads, LIVE_STAGES, stageOf } from './stage'
import type { StagePR } from './stage'

const NOW = new Date(2026, 9, 25, 12).getTime()
const thread = (id = 't1', more: Partial<Thread> = {}): Thread => ({
  id, title: `Task ${id}`, project: 'demo', finish: 'Tests pass for the new report', minutes: 60,
  progress: 30, link: '', link_label: '', resume: 'cd "/r/github.com/example/demo/.claude/worktrees/task" && claude',
  source: 'Claude Code', status: 'open', value: 3, last: new Date(NOW).toISOString(), check: 'verified', branch: 'feat/report', ...more,
})
const pr = (more: Partial<StagePR> = {}): StagePR => ({ title: 'Report', url: 'https://github.com/example/demo/pull/44', number: 44, repo: 'example/demo', branch: 'feat/report', draft: false, updated: '', checks: 'SUCCESS', ...more })

test('stage rules: branch and repository evidence, red precedence, passing non-draft only', async () => {
  const t = thread()
  expect(stageOf(t, [pr({ checks: 'FAILURE' })], NOW)).toEqual({ stage: 'red-ci', skill: 'mattpocock-skills:diagnosing-bugs', reason: 'PR #44 checks failing', live: true })
  expect(stageOf(t, [pr({ checks: 'ERROR' })], NOW)?.stage).toBe('red-ci')
  expect(stageOf(t, [pr(), pr({ checks: 'FAILURE' })], NOW)?.stage).toBe('red-ci')
  expect(stageOf({ ...t, resume: 'cd \"/r/demo\" && claude' }, [pr()], NOW)?.stage).toBe('build')
  expect(stageOf(t, [pr()], NOW)).toEqual({ stage: 'ready-to-merge', skill: 'code-review', reason: 'PR #44 checks passing; not a draft', live: true })
  for (const p of [pr({ draft: true }), pr({ checks: 'NONE' }), pr({ checks: 'PENDING' }), pr({ branch: 'other' }), pr({ repo: 'example/other' }), pr({ repo: 'another/demo' }), pr({ branch: undefined })]) expect(stageOf(t, [p], NOW)?.stage).toBe('build')
})

test('stage rules: build, blocked and two-day stuck, idea and null; only proven stages are live', async () => {
  expect([...LIVE_STAGES]).toEqual(['red-ci', 'ready-to-merge'])
  expect(stageOf(thread(), [], NOW)).toEqual({ stage: 'build', skill: 'darren-core:worker-dispatch', reason: 'Finish line: Tests pass for the new report', live: false })
  expect(stageOf(thread('b', { blocked: true }), [], NOW)?.stage).toBe('stuck')
  const old = thread('s', { last: new Date(NOW - 2 * 86400_000).toISOString() })
  expect(stageOf(old, [], NOW)?.reason).toBe(`No progress since ${old.last}`)
  expect(stageOf({ ...old, last: new Date(NOW - 2 * 86400_000 + 1).toISOString() }, [], NOW)?.stage).toBe('build')
  expect(stageOf(thread('i', { branch: null, finish: '', progress: 0 }), [], NOW)?.stage).toBe('idea')
  for (const t of [thread('done', { progress: 100 }), thread('n', { finish: '', progress: 20 }), thread('n', { branch: null, resume: '', progress: 20 })]) expect(stageOf(t, [], NOW)).toBeNull()
})

test('Delegate ranks by board value, takes three and excludes non-build work', async () => {
  const list = [thread('low', { value: 1, minutes: 1 }), thread('high', { value: 8, minutes: 900 }), thread('mid', { value: 4 }), thread('fourth', { value: 2 }), thread('blocked', { blocked: true, value: 100 }), thread('no-repo', { resume: '', value: 100 }), thread('no-finish', { finish: '', value: 100 })]
  expect(delegateThreads(list, [], NOW).map(t => t.id)).toEqual(['high', 'mid', 'fourth'])
  expect(delegateThreads([thread()], [pr()], NOW)).toEqual([])
})

test('Delegate model strips markdown links before clipping at complete words', () => {
  const input = thread('links', {
    title: '[Read the report](https://example.com/report)',
    finish: `Ship [the report](https://example.com/report) ${'completeword '.repeat(30)}`,
    left_off: '[Reviewed](https://example.com/review) the results',
  })
  const row = delegateThreads([input], [], NOW)[0]!
  expect(row.title).toBe('Read the report')
  expect(row.finish).toBe(`Ship the report ${'completeword '.repeat(11).trimEnd()}…`)
  expect(row.left_off).toBe('Reviewed the results')
  expect(input.title).toContain('](https://')
})

test('Delegate model exposes only real estimates and board progress, including zero', () => {
  for (const minutes of [null, -1, NaN, Infinity]) {
    const row = delegateThreads([thread('unknown', { minutes })], [], NOW)[0]!
    expect(row.estimate).toBeUndefined()
    expect(row.estimateText).toBe('estimate unknown')
  }
  for (const minutes of [0, 25, 90]) {
    const row = delegateThreads([thread('known', { minutes, progress: 42 })], [], NOW)[0]!
    expect(row.estimate).toBe(minutes)
    expect(row.estimateText).toBe(`${minutes} min estimated`)
    expect(row.progressValue).toBe(42)
  }
  for (const progress of [undefined, NaN, -1]) {
    const row = delegateThreads([thread('unknown', { progress } as Partial<Thread>)], [], NOW)[0]!
    expect(row.progressValue).toBeUndefined()
  }
  expect(delegateThreads([thread('zero', { progress: 0 })], [], NOW)[0]!.progressValue).toBe(0)
})

const OPTS = { options: { dataDir: '/board' } }
const PANE = { plugin: 'nextup', component: 'Pane', requestId: 'nextup', props: { title: 'Next up', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const BAND = { plugin: 'nextup', component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false, isWorking: false, maxRows: 5, scroll: { offset: 0, bodyRows: 5 }, view: {} } } as const
const DARREN_CORE = [{ name: 'handoff-and-clear', description: 'Hand off', source: 'plugin', plugin: 'darren-core' }]
async function world($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], threads = [thread()], prs: StagePR[] = [], ledger?: unknown, commands: unknown[] = DARREN_CORE) {
  const files: Record<string, string> = { '/board/threads.json': JSON.stringify({ threads, generated: new Date(NOW).toISOString() }), '/board/notes.json': '{"items":[]}' }
  if (ledger !== undefined) files['/board/mod-launches.json'] = typeof ledger === 'string' ? ledger : JSON.stringify(ledger)
  const clock = mock.clock(on, { now: NOW })
  const opened: string[][] = [], copies: string[] = []
  let lockBusy = false
  const writes: string[] = []
  const store: Record<string, unknown> = {}
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined as never } })
  on('store.get', (_, e) => ({ value: store[e.key] as never }))
  on('ui.status', () => ({ value: undefined as never }))
  on('ui.toast', () => ({ value: undefined as never }))
  on('env.get', () => ({ value: undefined }))
  on('command.list', () => ({ value: commands as never }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => { writes.push(e.path); files[e.path] = e.text; return { value: undefined as never } })
  on('ui.copy', (_, e) => { copies.push(e.text); return { value: undefined as never } })
  // All processes are stubbed, including open: no installed app is launched by these tests.
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/mkdir' && lockBusy) return { value: { exitCode: 1, stdout: '', stderr: '' } as never }
    if (e.argv[0] === 'open') opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ data: { search: { nodes: prs.map(p => ({ title: p.title, url: p.url, number: p.number, headRefName: p.branch, isDraft: p.draft, repository: { nameWithOwner: p.repo }, commits: { nodes: [{ commit: { statusCheckRollup: { state: p.checks } } }] } })) } } }), stderr: '' } as never }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/r/github.com/example/demo' }))
  on('session.id', () => ({ value: 'me' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  await $.session.start({ cwd: '/r/github.com/example/demo', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
  return { files, store, clock, opened, copies, writes, setLockBusy: (busy: boolean) => { lockBusy = busy } }
}
for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: live Hero and Band buttons show evidence; Undo cancels everywhere without spending`, OPTS, async ($, on) => {
    const w = await world($, on, [thread()], [pr({ checks: 'FAILURE' })])
    const ui = await $.ui.mount({ ...PANE, surface })
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'hero-launch-t1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'PR #44 checks failing' })).toBeDefined()
    expect(await band.find({ key: 'band-launch-t1' })).toBeDefined()
    await ui.press({ key: 'hero-launch-t1' } as never)
    await w.clock.advance(9999)
    expect(w.opened).toEqual([])
    expect(await band.find({ key: 'band-launch-undo-t1' })).toBeDefined()
    await band.press({ key: 'band-launch-undo-t1' } as never)
    await w.clock.advance(1)
    expect(w.opened).toEqual([])
    expect(w.files['/board/mod-launches.json']).toBeUndefined()
    await band.unmount(); await ui.unmount()
  })
  test(`${surface}: hints have no stage button; Delegate rows rank, open details and launch after ten seconds`, OPTS, async ($, on) => {
    const w = await world($, on, [thread('a', { value: 1 }), thread('b', { value: 7 }), thread('c', { value: 4 }), thread('d', { value: 2 })])
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Next stage: build. Worker dispatch fits.' })).toBeDefined()
    expect(await ui.find({ key: 'hero-launch-b' })).toBeUndefined()
    const card = JSON.stringify(await ui.find({ key: 'panel-delegate' }))
    expect(card).not.toContain('delegate-b')
    expect(card.indexOf('delegate-c')).toBeLessThan(card.indexOf('delegate-d'))
    expect(card).toContain('delegate-a')
    expect(await ui.find({ key: 'hit-delegate-c' } as never)).toBeUndefined()
    await ui.press({ key: 'delegate-details-c' } as never)
    expect(await ui.find({ key: 'ctx-c' })).toBeDefined()
    await ui.press({ key: 'delegate-launch-c' } as never)
    await w.clock.advance(9999)
    expect(w.opened).toEqual([])
    await w.clock.advance(1)
    expect(w.opened).toEqual([['open', 'claude://code/new?folder=%2Fr%2Fgithub.com%2Fexample%2Fdemo']])
    expect(w.copies[0]).toContain('Start with the darren-core:worker-dispatch skill.')
    expect(w.copies[0]).toContain('[nu-c]')
    expect(JSON.parse(w.files['/board/mod-launches.json']!).count).toBe(1)
    expect(JSON.parse(w.files['/board/mod-launch-history.json']!)).toEqual([{ id: 'c', skill: 'darren-core:worker-dispatch', stage: 'build', at: NOW + 10_000, progress: 30 }])
    await ui.unmount()
  })
}

test('Delegate launch without darren-core copies a plain prompt and names no darren-core skill', OPTS, async ($, on) => {
  const w = await world($, on, [thread('a', { value: 1 }), thread('b', { value: 7 }), thread('c', { value: 4 }), thread('d', { value: 2 })], [], undefined, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'delegate-details-c' } as never)
  await ui.press({ key: 'delegate-launch-c' } as never)
  await w.clock.advance(10_000)
  expect(w.opened.length).toBe(1)
  expect(w.copies[0]).not.toContain('darren-core')
  expect(w.copies[0]).toContain('Unblock or finish this thread')
  expect(JSON.parse(w.files['/board/mod-launches.json']!).log[0].skill).toBe('darren-core:worker-dispatch')
  await ui.unmount()
})

// A day on the mocked clock runs the 5 s live loop 17,280 times: more waits than one advance resolves, and longer
// than the default 5 s. The day goes by an hour at a time.
test('five-per-day cap rereads disk, counts only execution and rolls over at local midnight', { ...OPTS, timeoutMs: 30_000 }, async ($, on) => {
  const date = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
  const w = await world($, on, [thread()], [pr()], { date: date(NOW), count: 4, log: Array.from({ length: 4 }, (_, i) => ({ id: `old-${i}`, skill: 'code-review', at: NOW })) })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hero-launch-t1' } as never)
  await w.clock.advance(10_000)
  expect(JSON.parse(w.files['/board/mod-launches.json']!).count).toBe(5)
  expect(await ui.find({ key: 'hero-launch-t1' })).toBeUndefined()
  await ui.press({ key: 'tab-work' } as never)
  expect(await ui.find({ key: 'working-delegated-t1' })).toBeDefined()
  await ui.press({ key: 'tab-focus' } as never)
  for (let hour = 0; hour < 24; hour++) await w.clock.advance(3600_000)
  await ui.unmount()
  w.files['/board/threads.json'] = JSON.stringify({ threads: [thread('t2')] })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' } as never)
  await ui.press({ key: 'hero-launch-t2' } as never)
  await w.clock.advance(10_000)
  const saved = JSON.parse(w.files['/board/mod-launches.json']!)
  expect(saved.count).toBe(1)
  expect(saved.date).toBe(date(NOW + 86400_000))
  expect(saved.log.length).toBe(1)
  expect(w.opened.length).toBe(2)
  await ui.unmount()
})

test('corrupt ledger fails closed during the Undo window', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hero-launch-t1' } as never)
  w.files['/board/mod-launches.json'] = '{ bad'
  await w.clock.advance(10_000)
  expect(w.opened).toEqual([])
  expect(await ui.find({ key: 'hero-launch-t1' })).toBeUndefined()
  await ui.unmount()
})

test('Delegate card hides when no eligible build threads exist', OPTS, async ($, on) => {
  await world($, on, [thread('blocked', { blocked: true }), thread('missing', { finish: '' }), thread('pr')], [pr()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'panel-delegate' })).toBeUndefined()
  await ui.unmount()
})

test('template mode never draws launch or Delegate controls', async ($, on) => {
  const opened: string[] = []
  on('process.run', (_, e) => { opened.push(e.argv.join(' ')); return { value: { exitCode: 0, stdout: '', stderr: '' } as never } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'panel-delegate' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.includes('launch'))).toEqual([])
  expect(opened).toEqual([])
  await ui.unmount()
})

test('another session can reach five while Undo is pending; execution rechecks the shared cap', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hero-launch-t1' } as never)
  const d = new Date(NOW)
  w.files['/board/mod-launches.json'] = JSON.stringify({ date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, count: 5, log: Array.from({ length: 5 }, () => ({ id: 'other', skill: 'code-review', at: NOW })) })
  await w.clock.advance(10_000)
  expect(w.opened).toEqual([])
  expect(JSON.parse(w.files['/board/mod-launches.json']!).count).toBe(5)
  await ui.unmount()
})

test('cross-session reservation contention defers automatically and keeps Undo available', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  w.setLockBusy(true)
  await ui.press({ key: 'hero-launch-t1' } as never)
  await w.clock.advance(11_000)
  expect(w.opened).toEqual([])
  expect(w.files['/board/mod-launches.json']).toBeUndefined()
  expect(await ui.find({ key: 'hero-launch-undo-t1' })).toBeDefined()
  w.setLockBusy(false)
  await w.clock.advance(1000)
  expect(w.opened.length).toBe(1)
  expect(JSON.parse(w.files['/board/mod-launches.json']!).count).toBe(1)
  await ui.unmount()
})

test('Undo cancels an automatic lock retry and Done cancels a scheduled launch', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  w.setLockBusy(true)
  await ui.press({ key: 'hero-launch-t1' } as never)
  await w.clock.advance(10_000)
  await ui.press({ key: 'hero-launch-undo-t1' } as never)
  w.setLockBusy(false)
  await w.clock.advance(1000)
  expect(w.opened).toEqual([])
  await ui.press({ key: 'hero-launch-t1' } as never)
  await ui.press({ key: 'tick-t1' } as never)
  await w.clock.advance(10_000)
  expect(w.opened).toEqual([])
  expect(w.files['/board/mod-launches.json']).toBeUndefined()
  await ui.unmount()
})

test('a refreshed thread that changes stage cancels its pending launch', OPTS, async ($, on) => {
  const w = await world($, on, [thread('hero', { value: 10 }), thread()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'delegate-launch-t1' } as never)
  w.files['/board/threads.json'] = JSON.stringify({ threads: [thread('t1', { blocked: true })] })
  await ui.press({ key: 'refresh' } as never)
  await w.clock.advance(10_000)
  expect(w.opened).toEqual([])
  expect(w.files['/board/mod-launches.json']).toBeUndefined()
  await ui.unmount()
})


test('idea accepts scanner resumes and default branches, but requires no finish or feature branch', async () => {
  for (const branch of [undefined, null, '', 'HEAD', 'main', 'master']) {
    const t = thread('idea', { branch, finish: '  ', progress: 0 })
    expect(stageOf(t, [], NOW)?.stage).toBe('idea')
    expect(stageOf(t, [], NOW)?.live).toBe(false)
    expect(stageOf({ ...t, finish: 'Ship it' }, [], NOW)?.stage).toBe('build')
    expect(stageOf({ ...t, progress: 1 }, [], NOW)).toBeNull()
    expect(stageOf({ ...t, branch: 'feat/new' }, [], NOW)).toBeNull()
    expect(stageOf({ ...t, blocked: true }, [], NOW)?.stage).toBe('stuck')
  }
})

const HISTORY = '/board/mod-launch-history.json'
const record = (id = 't1', more: Record<string, unknown> = {}) => ({
  id, skill: 'code-review', stage: 'ready-to-merge', at: NOW - 48 * 3600_000, progress: 30, ...more,
})

test('launch appends current progress under the reservation lock and keeps only the last 500 history entries', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  const history = Array.from({ length: 500 }, (_, i) => record(`old-${i}`, { outcome: 'none', checkedAt: NOW }))
  w.files[HISTORY] = JSON.stringify(history)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hero-launch-t1' } as never)
  // Refresh during Undo: launch history must use execution-time progress.
  w.files['/board/threads.json'] = JSON.stringify({ threads: [thread('t1', { progress: 45 })] })
  await ui.press({ key: 'refresh' } as never)
  await w.clock.advance(10_000)
  expect(w.opened.length).toBe(1)
  const saved = JSON.parse(w.files[HISTORY]!)
  expect(saved.length).toBe(500)
  expect(saved[0]).toEqual(history[1])
  expect(saved[499]).toEqual(record('t1', { at: NOW + 10_000, progress: 45 }))
  expect(JSON.parse(w.files['/board/mod-launches.json']!).count).toBe(1)
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: Next records moved, done, none and gone at 48 hours, preserving checked and younger entries`, OPTS, async ($, on) => {
    const w = await world($, on, [thread('moved', { progress: 40 }), thread('done', { progress: 100 }), thread('same'), thread('lower', { progress: 20 }), thread('young')])
    const checked = record('checked', { outcome: 'none', checkedAt: NOW - 10 })
    const young = record('young', { at: NOW - 48 * 3600_000 + 1 })
    w.files[HISTORY] = JSON.stringify([record('moved'), record('done', { progress: 100 }), record('same'), record('lower'), record('gone'), checked, young])
    const ui = await $.ui.mount({ ...PANE, surface })
    await w.clock.advance(0)
    const saved = JSON.parse(w.files[HISTORY]!)
    expect(saved.map((x: { outcome?: string }) => x.outcome)).toEqual(['moved', 'moved', 'none', 'none', 'gone', 'none', undefined])
    expect(saved.slice(0, 5).map((x: { checkedAt: number }) => x.checkedAt)).toEqual([NOW, NOW, NOW, NOW, NOW])
    expect(saved[5]).toEqual(checked)
    expect(saved[6]).toEqual(young)
    expect(w.writes.filter(x => x === HISTORY).length).toBe(1)
    await ui.unmount()
    const again = await $.ui.mount({ ...PANE, surface })
    await w.clock.advance(0)
    expect(w.writes.filter(x => x === HISTORY).length).toBe(1)
    await again.unmount()
  })
}

for (const history of [undefined, '{broken', '{}', '[null]', '[{"id":"bad"}]', JSON.stringify([record('young', { at: NOW }), record('checked', { outcome: 'none', checkedAt: NOW })])]) {
  test(`history safely skips missing, broken or unchanged files: ${history}`, OPTS, async ($, on) => {
    const w = await world($, on)
    if (history !== undefined) w.files[HISTORY] = history
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await w.clock.advance(0)
    expect(w.files[HISTORY]).toBe(history)
    expect(w.writes.filter(x => x === HISTORY)).toEqual([])
    expect(await ui.find({ key: 'hero' })).toBeDefined()
    await ui.unmount()
  })
}

test('history lock contention retries on the next Next render without losing a concurrent entry', OPTS, async ($, on) => {
  const w = await world($, on)
  w.files[HISTORY] = JSON.stringify([record()])
  w.setLockBusy(true)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await w.clock.advance(0)
  expect(w.writes.filter(x => x === HISTORY)).toEqual([])
  await ui.unmount()
  const concurrent = record('other', { at: NOW })
  w.files[HISTORY] = JSON.stringify([record(), concurrent])
  w.setLockBusy(false)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await w.clock.advance(0)
  const saved = JSON.parse(w.files[HISTORY]!)
  expect(saved[0].outcome).toBe('none')
  expect(saved[1]).toEqual(concurrent)
  await ui.unmount()
})


for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: delegated row keeps its marker and blocks every launch surface`, OPTS, async ($, on) => {
    const w = await world($, on, [thread('hero', { value: 10 }), thread()])
    const ui = await $.ui.mount({ ...PANE, surface })
    const band = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'delegate-launch-t1' } as never)
    await w.clock.advance(10_000)
    expect(await ui.find({ key: 'delegate-launch-t1' })).toBeUndefined()
    // Once delegated it is being worked on: it leaves the Delegate card.
    expect(await ui.find({ key: 'delegate-delegated-t1' })).toBeUndefined()
    // Promote the same thread to hero; all controls share the durable marker.
    w.files['/board/threads.json'] = JSON.stringify({ threads: [thread()] })
    await ui.press({ key: 'refresh' } as never)
    // A delegated thread is being worked on: it leaves the hero and the band, and its marker moves to the Work tab.
    expect(await ui.find({ key: 'hero-delegated-t1' })).toBeUndefined()
    expect(await band.find({ key: 'band-delegated-t1' })).toBeUndefined()
    expect(await ui.find({ key: 'hero-launch-t1' })).toBeUndefined()
    expect(await band.find({ key: 'band-launch-t1' })).toBeUndefined()
    await ui.press({ key: 'tab-work' } as never)
    expect(await ui.find({ key: 'working-delegated-t1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Delegated <1m' })).toBeDefined()
    expect(w.opened.length).toBe(1)
    await band.unmount(); await ui.unmount()
  })
}

for (const match of ['title', 'token', 'token-other', 'firstPrompt', 'real-shape', 'stale-activity', 'missing', 'old', 'unavailable', 'prefix-collision', 'ambiguous', 'future']) {
  test(`delegated session lookup: ${match}`, OPTS, async ($, on) => {
    on('mcp.call', (_, e) => {
      if (match === 'unavailable') throw new Error('offline')
      return { value: { content: [{ type: 'text', text: JSON.stringify(e.tool === 'list_sessions' ? [
        { sessionId: 'wrong', title: match === 'ambiguous' ? 'Task t1' : 'Unrelated task', createdAt: new Date(NOW).toISOString() },
        { sessionId: 'child', title: match === 'token' ? 'Confirm dashboard phase 1 [nu-t1]' : match === 'token-other' ? 'Confirm dashboard [nu-t10]' : match === 'firstPrompt' ? 'New session' : match === 'prefix-collision' ? 'Task t10' : 'Task t1',
          firstPrompt: match === 'firstPrompt' ? 'Finish Task t1: Tests pass for the new report' : '', isRunning: true,
          ...(match === 'real-shape' || match === 'stale-activity' ? { lastActivityAt: new Date(match === 'stale-activity' ? NOW - 120_000 : NOW).toISOString(), link: 'claude://claude.ai/epitaxy/child' }
            : { createdAt: new Date(match === 'old' ? NOW - 120_000 : match === 'future' ? NOW + 1 : NOW).toISOString() }) },
      ].filter(s => match !== 'missing' || s.sessionId !== 'child') : []) }] } as never }
    })
    const w = await world($, on)
    w.files[HISTORY] = JSON.stringify([record('t1', { at: NOW - 60_000 })])
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'hero-launch-t1' })).toBeUndefined()
    await ui.press({ key: 'tab-work' } as never)
    expect(await ui.find({ type: 'Text', text: 'Delegated 1m' })).toBeDefined()
    const link = await ui.find({ key: 'working-delegated-open-t1' })
    if (match === 'real-shape') {
      // The live list_sessions rows carry lastActivityAt and link, never createdAt or firstPrompt.
      expect(link?.props.label).toBe('Open session')
      await ui.press({ key: 'working-delegated-open-t1' } as never)
      expect(w.opened).toContainEqual(['open', 'claude://claude.ai/epitaxy/child'])
    } else if (match === 'title' || match === 'token' || match === 'firstPrompt') {
      expect(link?.props.label).toBe('Open session')
      await ui.press({ key: 'working-delegated-open-t1' } as never)
      expect(w.opened).toContainEqual(['open', 'claude://resume?session=child'])
    } else expect(link).toBeUndefined()
    await ui.unmount()
  })
}

test('a concurrent delegation during Undo prevents a second launch under the shared lock', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hero-launch-t1' } as never)
  w.files[HISTORY] = JSON.stringify([record('t1', { at: NOW })])
  await w.clock.advance(10_000)
  expect(w.opened).toEqual([])
  expect(w.files['/board/mod-launches.json']).toBeUndefined()
  await ui.unmount()
})

test('Undo leaves no delegated marker and the exact 48-hour boundary restores launching', OPTS, async ($, on) => {
  const w = await world($, on, [thread()], [pr()])
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hero-launch-t1' } as never)
  await ui.press({ key: 'hero-launch-undo-t1' } as never)
  await w.clock.advance(10_000)
  expect(w.files[HISTORY]).toBeUndefined()
  expect(await ui.find({ key: 'hero-delegated-t1' })).toBeUndefined()
  await ui.unmount()
  w.files[HISTORY] = JSON.stringify([record('t1', { at: NOW + 10_000 - 48 * 3600_000 })])
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'hero-delegated-t1' })).toBeUndefined()
  expect(await ui.find({ key: 'hero-launch-t1' })).toBeDefined()
  await ui.unmount()
})

// Replay of 26 Oct 2026: a quote-writing session's band showed "Release the sample plugin",
// launched 21 h earlier, while its own session was running. A thread with a live session is not a to-do.
const HOST = 'a686e2e2-0ce3-45b2-bdf4-1c418994b0ab'
const host = () => thread(HOST, { title: 'Release the sample plugin', progress: 90, last: new Date(NOW - 12 * 3600_000).toISOString() })
const feed = new WeakMap<object, { rows: unknown[] }>()
const sessions = (on: Parameters<TestBody>[1], rows: unknown[]) => {
  const f = feed.get(on)
  if (f) { f.rows = rows; return }
  const nf = { rows }
  feed.set(on, nf)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify(nf.rows) }] } as never }))
}
const hostRow = (more: Record<string, unknown>) => ({ sessionId: `local_${HOST}`, title: 'Sample HQ: close the tracker', isRunning: true, isArchived: false, lastActivityAt: new Date(NOW - 60_000).toISOString(), ...more })
const child = (more: Record<string, unknown>) => ({ sessionId: 'child', title: 'Release the sample plugin [nu-a686e2e2]', ...more })

test('replay: a delegated thread whose session is running is not in the band or the hero', OPTS, async ($, on) => {
  sessions(on, [hostRow({})])
  const w = await world($, on, [host(), thread('other', { title: 'Other task' })])
  w.files[HISTORY] = JSON.stringify([record(HOST, { at: NOW - 21 * 3600_000 })])
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'Release the sample plugin' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'Other task' })).toBeDefined()
  expect(await ui.find({ key: `hero-delegated-${HOST}` })).toBeUndefined()
  await ui.press({ key: 'tab-work' } as never)
  expect(await ui.find({ key: `working-delegated-${HOST}` })).toBeDefined()
  await band.unmount(); await ui.unmount()
})

for (const [name, rows, launchAgo, shown] of [
  ['launched 1 h ago, no session visible: working', [], 3600_000, undefined],
  ['launched 6 h less 1 ms ago, no session visible: working', [], 6 * 3600_000 - 1, undefined],
  ['launched exactly 6 h ago, no session visible: stalled', [], 6 * 3600_000, 'Stalled: Release the sample plugin'],
  ['launched 21 h ago, no session visible: stalled', [], 21 * 3600_000, 'Stalled: Release the sample plugin'],
  ['launched 21 h ago, own session quiet 7 h: stalled', [hostRow({ lastActivityAt: new Date(NOW - 7 * 3600_000).toISOString() })], 21 * 3600_000, 'Stalled: Release the sample plugin'],
  ['delegate session ended: review', [child({ isRunning: false, createdAt: new Date(NOW - 3600_000).toISOString(), lastActivityAt: new Date(NOW - 1800_000).toISOString() })], 3 * 3600_000, 'Delegate finished: review Release the sample plugin'],
  ['delegate session running: working', [child({ isRunning: true, createdAt: new Date(NOW - 3600_000).toISOString(), lastActivityAt: new Date(NOW - 60_000).toISOString() })], 3 * 3600_000, undefined],
  ['delegate session running but silent 7 h: stalled', [child({ isRunning: true, createdAt: new Date(NOW - 9 * 3600_000).toISOString(), lastActivityAt: new Date(NOW - 7 * 3600_000).toISOString() })], 9 * 3600_000, 'Stalled: Release the sample plugin'],
] as const) {
  test(`delegated selection: ${name}`, OPTS, async ($, on) => {
    sessions(on, [...rows])
    const w = await world($, on, [host()])
    w.files[HISTORY] = JSON.stringify([record(HOST, { at: NOW - launchAgo })])
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(!!(await band.find({ type: 'Text', text: shown ?? 'Release the sample plugin' }))).toBe(!!shown)
    await band.unmount()
  })
}

test('replay: a session that worked on the thread since the board last checked hides it, with no launch', OPTS, async ($, on) => {
  sessions(on, [hostRow({})])
  await world($, on, [host()])
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'Release the sample plugin' })).toBeUndefined()
  await band.unmount()
})

const STALLED = 'Stalled: Release the sample plugin'
const stalledWorld = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], rows: unknown[] = []) => {
  sessions(on, rows)
  const w = await world($, on, [host()])
  w.files[HISTORY] = JSON.stringify([record(HOST, { at: NOW - 21 * 3600_000 })])
  return w
}

test('a stalled row has Rescue, opens the card with feedback, and then stays hidden', OPTS, async ($, on) => {
  const w = await stalledWorld($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: STALLED })).toBeDefined()
  await band.press({ key: `band-rescue-${HOST}` } as never)
  expect(await band.find({ type: 'Text', text: 'Rescue: Release the sample plugin. First step below.' })).toBeDefined()
  expect(w.store.stalledSeen).toEqual({ [HOST]: NOW - 21 * 3600_000 })
  await band.unmount()
})

test('a stall seen once returns only after the thread has new activity and stalls again', OPTS, async ($, on) => {
  const w = await stalledWorld($, on)
  w.store.stalledSeen = { [HOST]: NOW - 21 * 3600_000 }
  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: STALLED })).toBeUndefined()
  await band.unmount()
  sessions(on, [hostRow({ lastActivityAt: new Date(NOW - 7 * 3600_000).toISOString() })])
  await w.clock.advance(61_000)
  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: STALLED })).toBeDefined()
  await band.unmount()
})

test('Not today on a stalled row keeps it hidden after the park ends', OPTS, async ($, on) => {
  const w = await stalledWorld($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: STALLED })).toBeDefined()
  await band.select({ key: 'band-more', value: 'later' })
  expect(w.store.stalledSeen).toEqual({ [HOST]: NOW - 21 * 3600_000 })
  await band.unmount()
})
