import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { RenderElement } from 'claude-code'
import { tone } from './theme'
import { stampOf } from './applog'
import sentinelSample from './fixtures/sentinel.sample'

// Each action writes mod-marks.json and changes the view; the status line counts the board.
// The board here is made up: two checked steps, one unchecked, one blocked, two finished, two notes.

const DIR = '/data/board'
// The data folder the plugin is configured with; every test passes it.
const OPTS = { options: { dataDir: DIR } }
const HELPER = '/H/skills/reload_plugins.py'
const RELOAD_OPTS = { options: { dataDir: DIR, reloadHelper: '~/skills/reload_plugins.py' } }
const HELPER_FILE = { [HELPER]: '' }
const MARKS = `${DIR}/mod-marks.json`

const thread = (id: string, title: string, more: Record<string, unknown>) => ({
  id, title, project: 'demo', finish: `Finish ${title}`, minutes: 10, progress: 50, link: '', link_label: '',
  resume: 'cd "/x" && claude', source: 'claude', status: 'open', value: 3, last: '2026-10-20', rated: true, check: 'verified', ...more,
})

const BOARD = {
  generated: '2026-10-22T09:00:00',
  threads: [
    thread('t1', 'Alpha step', { value: 5 }),
    thread('t2', 'Beta step', {
      source: 'Claude Code', goal: 'Ship the beta', last_ask: 'Run the tests again',
      left_off: 'Tests pass; PR open', branch: 'feat/beta', dirty: 2,
      resume: 'cd "/r/beta/.claude/worktrees/feat-x" && claude --resume t2',
    }),
    thread('t3', 'Gamma maybe', { check: 'ask' }),
    thread('t4', 'Delta blocked', { blocked: true }),
    thread('w1', 'Epsilon win', { progress: 100 }),
    thread('w2', 'Zeta win', { progress: 100 }),
  ],
}
const NOTES = {
  items: [
    { id: 'n1', text: 'Buy milk', title: 'Buy milk', project: 'House', ticked: false, minutes: 5 },
    { id: 'n2', text: 'Call bank', title: 'Call bank', project: 'House', ticked: false, minutes: 10 },
  ],
}

const PANE = {
  plugin: 'nextup',
  component: 'Pane',
  requestId: 'nextup',
  props: { title: 'Next up', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type Marks = Record<string, { done?: boolean; dropped?: boolean; parkUntil?: number; keep?: boolean; at: number }>

// The band chains to the hook beneath it: another mod's band, drawn as `text`, or an empty Box.
// Once per test; a test that draws another band calls it before setup.
const hasBeneath = new WeakSet<object>()
const beneath = (on: Parameters<TestBody>[1], text = '') => {
  if (hasBeneath.has(on)) return
  hasBeneath.add(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return text ? <Text>{text}</Text> : <Box />
  })
}

async function setup($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], extra: Record<string, string> = {}, gh: string | string[] = '', start = true, now = Date.now(), process?: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }> | { exitCode: number; stdout: string; stderr: string }) {
  const files: Record<string, string> = {
    [`${DIR}/threads.json`]: JSON.stringify(BOARD),
    [`${DIR}/notes.json`]: JSON.stringify(NOTES),
    ...extra,
  }
  const status: string[] = []
  beneath(on)
  // An extra key "$NAME" sets that environment variable; HOME is /H.
  on('env.get', (_, e) => ({ value: extra[`$${e.name}`] ?? (e.name === 'HOME' ? '/H' : undefined) }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  const reads: string[] = []
  on('fs.read', (_, e) => (reads.push(e.path), { value: files[e.path] ?? '' }))
  let mtime = 1
  const writes: string[] = []
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: mtime, isLink: false } }))
  on('fs.write', (_, e) => {
    if (`!write ${e.path}` in extra) throw new Error('read-only')
    files[e.path] = e.text
    writes.push(e.path)
    mtime++
    return { value: undefined as never }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const clock = mock.clock(on, { now })
  on('ui.status', (_, e) => {
    status.push(e.text ?? '')
    return { value: undefined as never }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined as never }))
  const copies: string[] = []
  on('ui.copy', (_, e) => {
    if ('!copy' in extra) throw new Error('clipboard unavailable')
    copies.push(e.text)
    return { value: undefined as never }
  })
  // An extra key "!store" makes the store remember, so a throttle can be seen; otherwise it is empty.
  const kept: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: ('!store' in extra ? kept[e.key] : undefined) as never }))
  on('store.set', (_, e) => { if ('!store' in extra) kept[e.key] = e.value; return { value: undefined as never } })
  const procs: string[][] = []
  let ghCalls = 0
  // An extra key "!hold build" keeps build.py running until the test calls release().
  let release = () => {}
  on('process.run', async (_, e) => {
    // The mod's event log: one appended line per press (events.ts). Kept in the files, out of procs.
    if (e.argv[0] === '/bin/sh' && e.init?.env?.F?.endsWith('mod-events.jsonl')) {
      files[e.init.env.F] = `${files[e.init.env.F] ?? ''}${e.init.env.L}\n`
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    }
    procs.push([...e.argv])
    if (process && (e.argv[0] === 'claude' || e.argv[0] === 'open' || e.argv.join(' ').includes('.claude/projects') || e.argv.join(' ').includes('main.log') || e.argv[1]?.endsWith('/reload_plugins.py'))) return { value: await process(e.argv) as never }
    if (e.argv[0] === 'python3' && e.argv[1] === 'build.py' && '!hold build' in extra) await new Promise<void>(r => { release = r })
    // gh's answer to the open-PR search, or a failed gh when the test gives none.
    // A list answers each gh call in turn, the last one repeating.
    if (e.argv.join(' ').includes('graphql')) {
      const out = Array.isArray(gh) ? (gh[ghCalls++] ?? gh[gh.length - 1] ?? '') : gh
      return { value: { exitCode: out ? 0 : 1, stdout: out, stderr: '' } as never }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('session.cwd', () => ({ value: '/' }))
  on('session.id', () => ({ value: 'me' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  if (start) await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The PR read is not awaited by session.start; let it land.
  await clock.advance(0)
  const marks = () => JSON.parse(files[MARKS] ?? '{}') as Marks
  const events = () => (files[`${DIR}/mod-events.jsonl`] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: number; action: string; outcome: string; msg: string; feedbackMs: number; proof?: string })
  return { marks, status, files, clock, procs, copies, reads, toasts, writes, events, release: () => release() }
}

// A plugin installed or updated mid-session goes live with no session.start, so the pane must load
// the board itself instead of showing "Reading your board…" for the rest of the session.
for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the pane loads the board when no session.start ran`, OPTS, async ($, on) => {
    const { clock } = await setup($, on, {}, '', false)
    const ui = await $.ui.mount({ ...PANE, surface })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: 'Reading your board…' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Alpha step/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a pane open while session.start loads the board reads it once`, OPTS, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    const { clock, reads } = await setup($, on, {}, '', false)
    const ui = await $.ui.mount({ ...PANE, surface })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await clock.advance(0)
    // fileProblem and readJson each read notes.json once per load.
    expect(reads.filter(p => p === `${DIR}/notes.json`).length).toBe(2)
    expect(await ui.find({ type: 'Text', text: /Alpha step/ })).toBeDefined()
    await ui.unmount()
  })
}

const fastState = async (ui: { find(q: never): Promise<{ props: Record<string, unknown> } | undefined> }, surface: string, on: boolean) => {
  const button = await ui.find({ key: 'helper-fast' } as never)
  expect(button?.props.label).toBe(surface === 'terminal' ? `⚡ Fast ${on ? '●' : '○'}` : 'Fast')
  if (surface !== 'terminal') expect((await ui.find({ type: 'Svg' } as never))?.props.alt).toBe(`Fast mode ${on ? 'on' : 'off'}`)
}

// Worker fast mode is the dispatch skill's saved default: a file named fast in its folder.
const DISPATCH = '/w/dispatch'
const FAST = { options: { ...OPTS.options, dispatchDir: DISPATCH } }
for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the Session tab has no worker fast toggle without a dispatch folder`, FAST, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-session' })
    expect(await ui.find({ key: 'helper-fast' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: with no dispatchDir option or DISPATCH_ROOT there is no worker fast toggle`, OPTS, async ($, on) => {
    await setup($, on, { '/H/developer/_scratch/dispatch': '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-session' })
    expect(await ui.find({ key: 'helper-fast' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: the worker fast toggle turns Codex fast mode on and off`, FAST, async ($, on) => {
    const { files, procs } = await setup($, on, { [DISPATCH]: '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-session' })
    await fastState(ui, surface, false)
    await ui.press({ key: 'helper-fast' })
    expect(`${DISPATCH}/fast` in files).toBe(true)
    await fastState(ui, surface, true)
    await ui.press({ key: 'helper-fast' })
    expect(procs).toContainEqual(['/bin/rm', '-f', `${DISPATCH}/fast`])
    await fastState(ui, surface, false)
    await ui.unmount()
  })

  test(`${surface}: the worker fast toggle acts on the file, not a stale view`, FAST, async ($, on) => {
    const { files, procs } = await setup($, on, { [DISPATCH]: '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-session' })
    // Another session turned it on after this pane read it.
    files[`${DISPATCH}/fast`] = ''
    await ui.press({ key: 'helper-fast' })
    expect(procs).toContainEqual(['/bin/rm', '-f', `${DISPATCH}/fast`])
    await fastState(ui, surface, false)
    await ui.unmount()
  })

  test(`${surface}: a failed write leaves worker fast mode off and says so`, FAST, async ($, on) => {
    const { toasts } = await setup($, on, { [DISPATCH]: '', [`!write ${DISPATCH}/fast`]: '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-session' })
    await ui.press({ key: 'helper-fast' })
    await fastState(ui, surface, false)
    expect(toasts).toContain('Could not turn worker fast mode on')
    await ui.unmount()
  })

  test(`${surface}: the worker fast toggle reads DISPATCH_ROOT and a saved on`, OPTS, async ($, on) => {
    await setup($, on, { $DISPATCH_ROOT: '/d/', '/d': '', '/d/fast': '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-session' })
    await fastState(ui, surface, true)
    await ui.unmount()
  })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: settling preserves all Notes layout slots at 80 columns`, OPTS, async ($, on) => {
    const { files, copies, procs } = await setup($, on, {
      [`${DIR}/notes.json`]: JSON.stringify({ items: [...NOTES.items, { ...NOTES.items[1], id: 'n3', title: 'Third note', text: 'Third note' }] }),
    })
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 80 } })
    await ui.press({ key: 'tab-notes' })
    // The kit exposes trees, not surface paint. Equal layout trees preserve the
    // downstream title positions even when the terminal stacks these slots.
    const layout = (node: unknown): unknown => {
      if (node === '✓') return '○' // Both occupy one terminal cell.
      if (!node || typeof node !== 'object') return node
      const el = node as RenderElement
      const props = { ...('props' in el ? el.props : {}) } as Record<string, unknown>
      for (const k of ['key', 'strikethrough', 'dimColor', 'color']) delete props[k]
      if (props.label === 'Undo') props.label = 'Done'
      return { type: el.type, props, children: ('children' in el ? el.children : undefined)?.map(layout) }
    }
    const rows = async () => Promise.all(['n1', 'n2', 'n3'].map(async id => layout((await ui.find({ key: `ni-${id}` })))))
    const before = await rows()
    await ui.press({ key: 'nt-n1' })
    expect(await rows()).toEqual(before)
    const processCount = procs.length
    await ui.press({ key: 'np-n1' })
    await ui.press({ key: 'nside-n1' })
    expect(files[`${DIR}/today.json`]).toBeUndefined()
    expect(copies).toEqual([])
    expect(procs.length).toBe(processCount)
    expect(await ui.find({ key: 'undo-n1' })).toBeDefined()
    await ui.unmount()
  })

  for (const scenario of ['stays', 'settles', 'undo', 'independent'] as const) {
    test(`${surface}: settling notes: ${scenario}`, OPTS, async ($, on) => {
      const { marks, clock } = await setup($, on, {
        [`${DIR}/notes.json`]: JSON.stringify({ items: [...NOTES.items, { ...NOTES.items[1], id: 'n3', title: 'Third note', text: 'Third note' }] }),
      })
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab-notes' })
      await ui.press({ key: 'nt-n1' })
      expect(marks().n1?.done).toBe(true)
      if (scenario === 'stays') {
        const tree = JSON.stringify(await ui.drawn())
        expect(tree.indexOf('Buy milk') < tree.indexOf('Call bank')).toBe(true)
        expect(tree.indexOf('Call bank') < tree.indexOf('Third note')).toBe(true)
        const title = await ui.find({ type: 'Text', text: 'Buy milk' })
        expect(title?.props.strikethrough).toBe(true)
        expect(title?.props.dimColor).toBe(true)
        expect(await ui.find({ key: 'undo-n1' })).toBeDefined()
      } else if (scenario === 'settles') {
        await clock.advance(4000)
        expect(await ui.find({ key: 'ni-n1' })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: 'Done today' })).toBeDefined()
        expect(await ui.find({ key: 'done-n1' })).toBeDefined()
      } else if (scenario === 'undo') {
        await ui.press({ key: 'undo-n1' })
        expect(marks().n1?.done).toBeUndefined()
        expect((await ui.find({ type: 'Text', text: 'Buy milk' }))?.props.strikethrough).not.toBe(true)
        expect(await ui.find({ key: 'nt-n1' })).toBeDefined()
        await clock.advance(4000)
        expect(await ui.find({ key: 'nt-n1' })).toBeDefined()
      } else {
        await clock.advance(1000)
        await ui.press({ key: 'nt-n2' })
        await clock.advance(3000)
        expect(await ui.find({ key: 'ni-n1' })).toBeUndefined()
        expect(await ui.find({ key: 'ni-n2' })).toBeDefined()
        await clock.advance(999)
        expect(await ui.find({ key: 'ni-n2' })).toBeDefined()
        await clock.advance(1)
        expect(await ui.find({ key: 'ni-n2' })).toBeUndefined()
      }
      await ui.unmount()
    })
  }

  test(`${surface}: Done marks the step done and the next step takes the hero`, OPTS, async ($, on) => {
    const { marks, clock } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Alpha step' })).toBeDefined()
    await ui.press({ key: 'tick-t1' })
    expect(marks().t1?.done).toBe(true)
    expect(await ui.find({ key: 'undo-t1' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'Alpha step' }))?.props.strikethrough).toBe(true)
    await clock.advance(4000)
    expect((await ui.find({ type: 'Text', text: 'Alpha step' }))?.props.size).not.toBe('heading')
    expect(await ui.find({ key: 'done-t1' })).toBeUndefined()
    await ui.press({ key: 'summary-toggle-done' })
    expect(await ui.find({ key: 'done-t1' })).toBeDefined()
    expect(await ui.find({ key: 'tick-t2' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: Not today parks the step until tomorrow and Bring back restores it`, OPTS, async ($, on) => {
    const { marks } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'park-t1' })
    expect(marks().t1?.parkUntil).toBeGreaterThan(Date.now())
    expect(await ui.find({ key: 'tick-t1' })).toBeUndefined()
    await ui.press({ key: 'tab-parked' })
    expect(await ui.find({ key: 'pb-t1' })).toBeDefined()
    await ui.press({ key: 'pb-t1' })
    const m = marks().t1
    expect(m?.parkUntil).toBeUndefined()
    expect(m?.done).toBeUndefined()
    // The Parked tab hides once empty and the view falls back to Focus with the step back on top.
    expect(await ui.find({ key: 'tab-parked' })).toBeUndefined()
    expect(await ui.find({ key: 'tick-t1' })).toBeDefined()
    await ui.unmount()
  })

  if (surface === 'desktop') test('desktop: each Lists tab is a stretched native Button in its own box that lights on hover', OPTS, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const id of ['work', 'notes', 'wins']) {
      const box = await ui.find({ key: `lbtab-${id}` })
      expect(box?.props).toMatchObject({ flexDirection: 'column', alignItems: 'stretch' })
      expect(box!.children.length).toBe(1)
      expect((box!.children[0] as { type: string; props: { key?: string } }).props.key).toBe(`tab-${id}`)
    }
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.slice(drawn.indexOf('"key":"lbtab-work"')).match(/"hover":\{[^}]*\}/)?.[0]).toContain('backgroundColor')
    await ui.unmount()
  })

  test(`${surface}: Drop marks a row dropped and removes it from Work`, OPTS, async ($, on) => {
    const { marks } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    // t1 is not a Claude Code session: the hero keeps Resume, with no Go.
    expect(await ui.find({ key: 'res-t1' })).toBeDefined()
    expect(await ui.find({ key: 'go-t1' })).toBeUndefined()
    await ui.press({ key: 'tab-work' })
    await ui.press({ key: 'row-t2' })
    await ui.press({ key: 'drop-t2' })
    expect(marks().t2?.dropped).toBe(true)
    expect(await ui.find({ key: 'row-t2' })).toBeUndefined()
    expect(await ui.find({ key: 'drop-t2' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: leaving Wins cancels an armed Tick all`, OPTS, async ($, on) => {
    const { marks } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-wins' })
    await ui.press({ key: 'tick-all' })
    await ui.press({ key: 'tab-work' })
    await ui.press({ key: 'tab-wins' })
    expect(await ui.find({ key: 'tick-all' })).toBeDefined()
    expect(await ui.find({ key: 'tick-all-yes' })).toBeUndefined()
    expect(marks().w1?.done).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: Tick all marks every finished thread done and empties To tick`, OPTS, async ($, on) => {
    const { marks } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-wins' })
    expect(await ui.find({ key: 'wt-w1' })).toBeDefined()
    await ui.press({ key: 'tick-all' })
    // One press only asks; nothing is marked until it is confirmed.
    expect(marks().w1?.done).toBeUndefined()
    await ui.press({ key: 'tick-all-no' })
    expect(await ui.find({ key: 'tick-all' })).toBeDefined()
    await ui.press({ key: 'tick-all' })
    await ui.press({ key: 'tick-all-yes' })
    expect(marks().w1?.done).toBe(true)
    expect(marks().w2?.done).toBe(true)
    expect(await ui.find({ key: 'wt-w1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Nothing to tick.' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: ticking a note marks it done and removes it from Notes`, OPTS, async ($, on) => {
    const { marks, clock } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-notes' })
    await ui.press({ key: 'nt-n1' })
    expect(marks().n1?.done).toBe(true)
    expect(await ui.find({ key: 'undo-n1' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'Buy milk' }))?.props.strikethrough).toBe(true)
    await clock.advance(4000)
    expect(await ui.find({ key: 'ni-n1' })).toBeUndefined()
    expect(await ui.find({ key: 'nt-n1' })).toBeUndefined()
    expect(await ui.find({ key: 'nt-n2' })).toBeDefined()
    await ui.unmount()
  })
}

test('Undo clears settling even without a data folder', { options: { dataDir: '' } }, async ($, on) => {
  beneath(on)
  let settling: unknown = { t1: 0 }
  on('state.get', (_, e, next) => {
    if (e.key === 'board') return { value: { value: { ...BOARD, notes: NOTES.items }, version: 1 } }
    if (e.key === 'settling') return { value: { value: settling, version: 1 } }
    return next(e)
  })
  on('state.set', (_, e, next) => {
    if (e.key === 'settling') {
      settling = e.value
      return { value: { isSet: true, version: 1 } }
    }
    if (e.key === 'board') return { value: { isSet: true, version: 1 } }
    return next(e)
  })
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false, isWorking: false, maxRows: 10, scroll: PANE.props.scroll, view: {} } })
  await ui.press({ key: 'band-undo' })
  expect(settling).toEqual({})
  await ui.unmount()
})

test('the status line counts match the board and follow each action', OPTS, async ($, on) => {
  const { status } = await setup($, on)
  // Checked and open: t1, t2 (t3 is unchecked, t4 blocked); notes n1, n2; finished w1, w2.
  expect(status.at(-1)).toBe('2 to do')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick-t1' })
  expect(status.at(-1)).toBe('1 to do')
  await ui.press({ key: 'tab-wins' })
  await ui.press({ key: 'tick-all' })
  await ui.press({ key: 'tick-all-yes' })
  expect(status.at(-1)).toBe('1 to do')
  await ui.unmount()
})

test('a .dev-act file runs each action once at session start and is emptied', OPTS, async ($, on) => {
  const act = `${DIR}/.dev-act`
  const { marks, files } = await setup($, on, { $NEXTUP_DEV: '1', [act]: 'done t1\npark n1\nbogus\ndrop\ntickall w\n' })
  expect(marks().t1?.done).toBe(true)
  expect(marks().n1?.parkUntil).toBeGreaterThan(Date.now())
  expect(marks().w1?.done).toBe(true)
  expect(marks().w2?.done).toBe(true)
  expect(marks().t2).toBeUndefined()
  expect(files[act]).toBe('')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'tick-t2' })).toBeDefined()
  await ui.unmount()
})

test('/nextup opens the Next up pane', OPTS, async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  const { clock } = await setup($, on)
  await $.command.run({ command: 'nextup' } as never)
  await clock.advance(1)
  expect(opened).toContain('nextup')
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: an opened row shows the session's context and Go opens that session`, OPTS, async ($, on) => {
    const { procs } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    // t1 is not a Claude Code session: the hero keeps Resume, with no Go.
    expect(await ui.find({ key: 'res-t1' })).toBeDefined()
    expect(await ui.find({ key: 'go-t1' })).toBeUndefined()
    await ui.press({ key: 'tab-work' })
    await ui.press({ key: 'row-t2' })
    expect(await ui.find({ type: 'Text', text: 'Ship the beta' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Run the tests again' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tests pass; PR open' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'feat/beta · 2 uncommitted' })).toBeDefined()
    await ui.press({ key: 'go-t2' })
    expect(procs).toContainEqual(['open', 'claude://resume?session=t2'])
    await ui.unmount()
  })
}

// Plan my day: "+ Today" on a note or a thread puts it in a Today list at the top of Focus.
const dayKey = () => {
  const d = new Date(Date.now() - 4 * 3600 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: + Today plans a note and a thread, totals the minutes and saves the plan`, OPTS, async ($, on) => {
    const { files } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'today' })).toBeUndefined()
    await ui.press({ key: 'tab-notes' })
    await ui.press({ key: 'np-n2' })
    await ui.press({ key: 'tab-work' })
    await ui.press({ key: 'row-t2' })
    await ui.press({ key: 'plan-t2' })
    await ui.press({ key: 'tab-focus' })
  await ui.press({ key: 'summary-toggle-today' })
    expect(await ui.find({ key: 'today' })).toBeDefined()
    expect(await ui.find({ key: 'td-n2' })).toBeDefined()
    expect(await ui.find({ key: 'td-t2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '20 min planned' })).toBeDefined()
    expect(JSON.parse(files[`${DIR}/today.json`] ?? '{}')).toEqual({ date: dayKey(), ids: ['n2', 't2'] })
    // Up moves t2 first; × takes n2 out.
    await ui.press({ key: 'tu-t2' })
    expect(JSON.parse(files[`${DIR}/today.json`] ?? '{}').ids).toEqual(['t2', 'n2'])
    await ui.press({ key: 'tx-n2' })
    expect(await ui.find({ key: 'td-n2' })).toBeUndefined()
    await ui.unmount()
  })
}

test('a plan from an earlier day is ignored', OPTS, async ($, on) => {
  await setup($, on, { [`${DIR}/today.json`]: JSON.stringify({ date: '2020-01-01', ids: ['t1'] }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'today' })).toBeUndefined()
  // The same file dated today does show: loading works, the date is what hid it.
  await ui.press({ key: 'tab-work' })
  await ui.press({ key: 'row-t1' })
  await ui.press({ key: 'plan-t1' })
  await ui.press({ key: 'tab-focus' })
  await ui.press({ key: 'summary-toggle-today' })
  expect(await ui.find({ key: 'td-t1' })).toBeDefined()
  await ui.unmount()
})

test('a plan for today is loaded and shown in Today', OPTS, async ($, on) => {
  await setup($, on, { [`${DIR}/today.json`]: JSON.stringify({ date: dayKey(), ids: ['t1', 'n1'] }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-today' })
  expect(await ui.find({ key: 'td-t1' })).toBeDefined()
  expect(await ui.find({ key: 'td-n1' })).toBeDefined()
  await ui.unmount()
})

test('the plan skips done and unknown ids: ↑ moves past them, and only open items show', OPTS, async ($, on) => {
  const { files } = await setup($, on, {
    [`${DIR}/today.json`]: JSON.stringify({ date: dayKey(), ids: ['n1', 'gone', 't1', 'n2'] }),
    [MARKS]: JSON.stringify({ t1: { done: true, at: 1 } }),
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-today' })
  expect(await ui.find({ key: 'td-n1' })).toBeDefined()
  expect(await ui.find({ key: 'td-t1' })).toBeUndefined()
  await ui.press({ key: 'tu-n2' })
  expect(JSON.parse(files[`${DIR}/today.json`] ?? '{}').ids).toEqual(['n2', 'n1'])
  await ui.unmount()
})

test('a plan edited in another session is kept when this one adds to it', OPTS, async ($, on) => {
  const { files } = await setup($, on, { [`${DIR}/today.json`]: JSON.stringify({ date: dayKey(), ids: ['n1'] }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  files[`${DIR}/today.json`] = JSON.stringify({ date: dayKey(), ids: ['n1', 't1'] })
  await ui.press({ key: 'tab-notes' })
  await ui.press({ key: 'np-n2' })
  expect(JSON.parse(files[`${DIR}/today.json`] ?? '{}').ids).toEqual(['n1', 't1', 'n2'])
  await ui.unmount()
})

// Open PRs as gh's GraphQL search returns them: six green, one red (oldest), one pending, one with no checks.
const pr = (n: number, title: string, state: string | null, updatedAt: string, repo = 'me/app') => ({
  title, url: `https://github.com/${repo}/pull/${n}`, number: n, isDraft: false, updatedAt,
  repository: { nameWithOwner: repo },
  commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
})
const GH = JSON.stringify({
  data: {
    search: {
      nodes: [
        ...[1, 2, 3, 4, 5, 6].map(n => pr(n, `Green ${n}`, 'SUCCESS', `2026-10-2${n % 2}T0${n}:00:00Z`)),
        pr(7, 'Broken build', 'FAILURE', '2026-10-01T00:00:00Z', 'me/api'),
        pr(8, 'Still checking', 'PENDING', '2026-10-02T00:00:00Z'),
        pr(9, 'No checks', null, '2026-10-03T00:00:00Z'),
        null,
        {},
      ],
    },
  },
})
const gql = (procs: string[][]) => procs.filter(a => a.join(' ').includes('graphql')).length

test('Next lists open PRs, failing first, five then Show more', OPTS, async ($, on) => {
  await setup($, on, {}, GH)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-prs' })
  expect(await ui.find({ type: 'Text', text: 'api #7  ·  checks failing' })).toBeDefined()
  expect(await ui.find({ key: 'pr-me/app#8' })).toBeDefined()
  expect(await ui.find({ key: 'pr-me/api#7' })).toBeDefined()
  // Newest greens fill the last three places; the oldest green waits behind Show more.
  expect(await ui.find({ key: 'pr-me/app#5' })).toBeDefined()
  expect(await ui.find({ key: 'pr-me/app#6' })).toBeUndefined()
  expect(await ui.find({ key: 'pr-me/app#9' })).toBeUndefined()
  expect(await ui.find({ key: 'more-prs' })).toBeDefined()
  await ui.press({ key: 'more-prs' })
  expect(await ui.find({ key: 'pr-me/app#6' })).toBeDefined()
  await ui.unmount()
})

test('A failed gh leaves no PR section and no error', OPTS, async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  expect(await ui.find({ key: 'prs' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Alpha step' })).toBeDefined()
  await ui.unmount()
})

test('PRs are read at start and again after ten minutes, not on every draw', OPTS, async ($, on) => {
  const { procs, clock } = await setup($, on, {}, GH)
  expect(gql(procs)).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  expect(gql(procs)).toBe(1)
  await clock.advance(10 * 60 * 1000 + 1)
  expect(gql(procs)).toBe(2)
  await ui.unmount()
})

test('A failed refresh keeps the PRs already shown', OPTS, async ($, on) => {
  const { procs, clock } = await setup($, on, {}, [GH, '', 'not json'])
  await clock.advance(10 * 60 * 1000 + 1)
  await clock.advance(10 * 60 * 1000 + 1)
  expect(gql(procs)).toBe(3)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-prs' })
  expect(await ui.find({ key: 'pr-me/api#7' })).toBeDefined()
  await ui.unmount()
})

// Calendar and drafts as the 8am refresh writes them. One event already over, one still to come, one all day.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const CAL = (date = localDay()) =>
  JSON.stringify({
    date,
    events: [
      { start: 'all day', end: '', title: 'Public holiday', where: '', link: '' },
      { start: '00:00', end: '00:00', title: 'Over already', where: '', link: '' },
      { start: '23:59', end: '23:59', title: 'Late call with Sam', where: 'Zoom', link: 'https://calendar.google.com/event?eid=x' },
    ],
  })
const DRAFTS = JSON.stringify({
  at: '2026-10-22T08:00:00+10:30',
  drafts: [
    { id: 'd1', to: 'Sam', subject: 'September invoice', link: 'https://mail.google.com/mail/#drafts?compose=d1' },
    { id: 'd2', to: 'Alex', subject: 'Month end files', link: 'https://mail.google.com/mail/#drafts?compose=d2' },
  ],
})

test('Focus shows the next event today and the drafts waiting to send', OPTS, async ($, on) => {
  await setup($, on, { [`${DIR}/calendar.json`]: CAL(), [`${DIR}/drafts.json`]: DRAFTS })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-calendar' })
  await ui.press({ key: 'summary-toggle-drafts' })
  expect(await ui.find({ key: 'cal' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '23:59' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Over already' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Zoom  ·  1 more today' })).toBeDefined()
  expect(await ui.find({ key: 'drafts' })).toBeDefined()
  expect(await ui.find({ key: 'dr-d1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'to Alex' })).toBeDefined()
  await ui.unmount()
})

test("Yesterday's calendar is not shown", OPTS, async ($, on) => {
  await setup($, on, { [`${DIR}/calendar.json`]: CAL('2020-01-01') })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'cal' })).toBeUndefined()
  expect(await ui.find({ key: 'drafts' })).toBeUndefined()
  await ui.unmount()
})

test('Odd calendar and drafts files never break the board', OPTS, async ($, on) => {
  const cal = JSON.stringify({
    date: localDay(),
    events: [null, { title: 'No start' }, { start: '0:00', end: '23:59', title: 'Overnight', where: 3, link: 'javascript:x' }, 'junk'],
  })
  const drafts = JSON.stringify({ at: '', drafts: [null, { id: 'd9', subject: 'No address', link: 'http://plain' }, 7, { id: 'd9', subject: 'Same id' }] })
  await setup($, on, { [`${DIR}/calendar.json`]: cal, [`${DIR}/drafts.json`]: drafts })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-calendar' })
  await ui.press({ key: 'summary-toggle-drafts' })
  expect(await ui.find({ type: 'Text', text: 'Overnight' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No address' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'to undefined' })).toBeUndefined()
  expect(await ui.find({ key: 'dr-draft-1' })).toBeDefined()
  await ui.unmount()
})

test('An event running past midnight still counts as to come', OPTS, async ($, on) => {
  const cal = JSON.stringify({ date: localDay(), events: [{ start: '00:00', end: '00:00', title: 'Over' }, { start: '00:01', end: '00:00', title: 'Night shift', where: '', link: '' }] })
  await setup($, on, { [`${DIR}/calendar.json`]: cal })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-calendar' })
  expect(await ui.find({ type: 'Text', text: 'Night shift' })).toBeDefined()
  await ui.unmount()
})

test('Not valid JSON at all shows no calendar and no drafts', OPTS, async ($, on) => {
  await setup($, on, { [`${DIR}/calendar.json`]: '{nope', [`${DIR}/drafts.json`]: '"a string"' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'cal' })).toBeUndefined()
  expect(await ui.find({ key: 'drafts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Alpha step' })).toBeDefined()
  await ui.unmount()
})

// Done marks over the last week: two today (one no longer on the board), one yesterday, one three days ago,
// one dropped today and one from ten days ago; the last two never count.
const daysAgo = (n: number) => new Date(new Date().setHours(12, 0, 0, 0) - n * 86_400_000).getTime()
const HISTORY = JSON.stringify({
  t1: { done: true, at: Math.min(Date.now(), daysAgo(0)) },
  zz: { done: true, at: Math.min(Date.now(), daysAgo(0)) },
  n1: { done: true, at: daysAgo(1) },
  w1: { done: true, at: daysAgo(3) },
  t4: { done: true, dropped: true, at: Date.now() },
  t3: { done: true, at: daysAgo(10) },
})

test('Wins shows the week as a strip and lists what was done', OPTS, async ($, on) => {
  await setup($, on, { [MARKS]: HISTORY })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-wins' })
  expect(await ui.find({ key: 'week' })).toBeDefined()
  expect(await ui.find({ key: 'wk-6' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '4 done in 7 days' })).toBeDefined()
  expect(await ui.find({ key: 'hs-t1' })).toBeDefined()
  expect(await ui.find({ key: 'hs-n1' })).toBeDefined()
  expect(await ui.find({ key: 'hs-w1' })).toBeDefined()
  expect(await ui.find({ key: 'hs-t4' })).toBeUndefined()
  expect(await ui.find({ key: 'hs-t3' })).toBeUndefined()
  expect(await ui.find({ key: 'hs-zz' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Yesterday' })).toBeDefined()
  await ui.unmount()
})

test('Undo in the history brings a step back to the board', OPTS, async ($, on) => {
  const { marks } = await setup($, on, { [MARKS]: HISTORY })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-wins' })
  await ui.press({ key: 'hu-t1' })
  expect(marks().t1?.done).toBeUndefined()
  expect(await ui.find({ key: 'hs-t1' })).toBeUndefined()
  await ui.unmount()
})

// Bad data from the refresh or a hand edit never takes the session or the pane down.
for (const [name, extra] of [
  ['null threads.json and today.json', { [`${DIR}/threads.json`]: 'null', [`${DIR}/today.json`]: 'null' }],
  ['a plan with no id list', { [`${DIR}/today.json`]: JSON.stringify({ date: dayKey(), ids: null }) }],
  ['a null tick in the marks file', { [MARKS]: JSON.stringify({ t1: null, t2: { done: true, at: Date.now() } }) }],
] as const)
  test(`${name}: the board still draws`, OPTS, async ($, on) => {
    await setup($, on, extra)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'tab-work' })).toBeDefined()
    await ui.unmount()
  })

test('dev files left in the data folder do nothing unless NEXTUP_DEV is set', OPTS, async ($, on) => {
  const act = `${DIR}/.dev-act`
  const { marks, files } = await setup($, on, { [act]: 'done t1\n', [`${DIR}/.dev-focus`]: 'wins' })
  expect(marks().t1).toBeUndefined()
  expect(files[act]).toBe('done t1\n')
})

// Side tasks: a suggested /goal prompt per item. The app turns a leading "/" in a deep link's q into "/ ",
// so Start copies the goal and opens an empty new session in the repo root; the user pastes it.
const opened = (procs: string[][]) => procs.filter(p => p[0] === 'open' && p[1]?.startsWith('claude://code/new')).map(p => new URL(p[1]!))

test('an opened row suggests a goal; Start copies it and opens an empty session in the repo root', OPTS, async ($, on) => {
  const { procs, copies } = await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  await ui.press({ key: 'row-t2' })
  expect(await ui.find({ type: 'Text', text: 'Suggested prompt' })).toBeDefined()
  await ui.press({ key: 'side-t2' })
  const [u] = opened(procs)
  expect(u?.searchParams.get('folder')).toBe('/r/beta')
  expect(u?.searchParams.has('q')).toBe(false)
  const q = copies[0] ?? ''
  expect(q.startsWith('/goal Beta step: Finish Beta step')).toBe(true)
  expect(q).toContain('session t2')
  expect(q).toContain('Tests pass; PR open')
  expect(q).toContain('fresh subagent')
  expect(q).toContain('Milestones: x/N')
  expect(q.includes('\n')).toBe(false)
  expect(q).toContain('screenshot')
  expect(q).toContain('tests pass')
  expect(q.includes('..')).toBe(false)
  expect(q.length < 1200).toBe(true)
  await ui.press({ key: 'copy-t2' })
  expect(copies).toEqual([q, q])
  await ui.unmount()
})

test("the refresh's own prompt wins over the built one", OPTS, async ($, on) => {
  const board = { ...BOARD, threads: BOARD.threads.map(t => (t.id === 't1' ? { ...t, prompt: '/goal Ship alpha. Done when X.' } : t)) }
  const { procs, copies } = await setup($, on, { [`${DIR}/threads.json`]: JSON.stringify(board) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  await ui.press({ key: 'row-t1' })
  await ui.press({ key: 'side-t1' })
  expect(copies).toEqual(['/goal Ship alpha. Done when X.'])
  expect(opened(procs)[0]?.searchParams.get('folder')).toBe('/x')
  await ui.unmount()
})

test('a note starts a side task with no folder', OPTS, async ($, on) => {
  const { procs, copies } = await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-notes' })
  await ui.press({ key: 'nside-n1' })
  const [u] = opened(procs)
  expect(u?.searchParams.has('folder')).toBe(false)
  expect(copies[0]?.startsWith('/goal Buy milk')).toBe(true)
  await ui.unmount()
})

test("a refresh prompt with line breaks goes out as one capped line", OPTS, async ($, on) => {
  const long = `/goal Ship alpha.\nDone when X.\n${'y'.repeat(9000)}`
  const board = { ...BOARD, threads: BOARD.threads.map(t => (t.id === 't1' ? { ...t, prompt: long, finish: 'Ship it.' } : t)) }
  const { copies } = await setup($, on, { [`${DIR}/threads.json`]: JSON.stringify(board) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  await ui.press({ key: 'row-t1' })
  await ui.press({ key: 'side-t1' })
  const q = copies[0] ?? ''
  expect(q.startsWith('/goal Ship alpha. Done when X.')).toBe(true)
  expect(q.includes('\n')).toBe(false)
  expect(q.length <= 8000).toBe(true)
  await ui.unmount()
})

test('a board file that is not valid JSON shows an error with Retry, never Clear board', OPTS, async ($, on) => {
  await setup($, on, { [`${DIR}/threads.json`]: '{ not json' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '✕ The board could not be read' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'threads.json is unreadable (not valid JSON). Fix or restore it, then Retry.' })).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ Clear board' })).toBeUndefined()
  await ui.unmount()
})

test('Unreadable Marks show the board error with Retry; Done leaves the file unchanged', OPTS, async ($, on) => {
  const text = '{ not json'
  const { files, toasts, clock } = await setup($, on, { [MARKS]: text })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '✕ The board could not be read' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'mod-marks.json is unreadable (not valid JSON). Fix or restore it, then Retry.' })).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  await ui.press({ key: 'tick-t1' })
  expect(files[MARKS]).toBe(text)
  expect(toasts).toEqual([])
  expect(await ui.find({ key: 'undo-t1' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'Alpha step' }))?.props.strikethrough).toBe(false)
  await clock.advance(4000)
  expect(files[MARKS]).toBe(text)
  await ui.unmount()
})

test('a healthy board shows no error', OPTS, async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '✕ The board could not be read' })).toBeUndefined()
  expect(await ui.find({ key: 'retry' })).toBeUndefined()
  await ui.unmount()
})

test('Done on a Today row, a note and a win is its own button; the title alone does nothing', OPTS, async ($, on) => {
  const { marks } = await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-notes' })
  expect(await ui.find({ key: 'nt-n1' })).toBeDefined()
  expect(marks().n1?.done).toBeUndefined()
  await ui.unmount()
})

// The band above the prompt: Done, a way back into the item, Not today.
const BAND = { plugin: 'nextup', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as const

test('band: a Claude Code item gets Go to session between Done and Not today, and it opens that session', OPTS, async ($, on) => {
  const { procs } = await setup($, on, { [`${DIR}/mod-marks.json`]: JSON.stringify({ t1: { done: true, at: 1 } }) })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'NEXT UP · demo' })).toBeDefined()
  expect(await ui.find({ key: 'band-go' })).toBeDefined()
  await ui.press({ key: 'band-go' })
  expect(procs).toContainEqual(['open', 'claude://resume?session=t2'])
  await ui.unmount()
})

test('band: a non-Claude item gets its own label (Resume) copy button', OPTS, async ($, on) => {
  const { copies } = await setup($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'band-go' })
  expect(copies).toContain('cd "/x" && claude')
  await ui.unmount()
})

test('band: no Go button when the item has nothing to go to', OPTS, async ($, on) => {
  const board = { ...BOARD, threads: [thread('t9', 'Orphan', { resume: '', link: '' })] }
  await setup($, on, { [`${DIR}/threads.json`]: JSON.stringify(board) })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'band-done' })).toBeDefined()
  expect(await ui.find({ key: 'band-go' })).toBeUndefined()
  await ui.unmount()
})

test('band: another mod\'s band still draws below ours', OPTS, async ($, on) => {
  beneath(on, 'Other band')
  await setup($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'band-done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Other band' })).toBeDefined()
  // Ours on top, theirs below.
  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('NEXT UP')).toBeLessThan(tree.indexOf('Other band'))
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: Band has at most three controls, primary Go and quiet Done`, OPTS, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 48 } })
    const buttons = await ui.findAll({ type: 'Button' })
    const menus = await ui.findAll({ type: 'Select' } as never)
    expect(buttons.length + menus.length).toBe(3)
    expect((await ui.find({ key: 'band-go' }))?.props.variant).toBe('primary')
    expect((await ui.find({ key: 'band-done' }))?.props.plain).toBe(true)
    expect((await ui.find({ key: 'band-done' }))?.props.variant).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Why this:/ })).toBeDefined()
    expect((await ui.find({ key: 'band-more' }))?.props.label).toBeUndefined()
    expect((await ui.find({ key: 'band-more' }))?.props.options).toEqual([
      { label: 'More', value: '' }, { label: 'Reload plugins', value: 'reload' }, { label: 'Not today', value: 'later' }, { label: 'Board', value: 'board' }, { label: 'Hide', value: 'hide' },
    ])
    await ui.unmount()
  })
}

// Drawing evidence: every nextup component mounted on desktop and terminal with the made-up board,
// checked by text, counts and buttons. Each drawing is printed as an `EVIDENCE <name>` line so
// scripts/drawing-evidence.sh can save the element trees. This is the tree each surface is handed,
// not the surface's paint.
const evidence = async (name: string, ui: { drawn: () => Promise<unknown> }) => {
  const tree = await ui.drawn()
  ;(globalThis as { console?: { log: (s: string) => void } }).console?.log(`EVIDENCE ${name} ${JSON.stringify(tree)}`)
  if (name.startsWith('desktop')) expect(clickBlockers(tree)).toEqual([])
}

// Desktop click rule: the app sends a click to the topmost element, so an absolute layer beside a Button
// takes the clicks meant for it. The test engine's press() calls the Button directly and never sees this
// (Delegate, Thread details and the hero buttons were dead in the app in 0.4.30 and 0.4.31).
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
function clickBlockers(tree: unknown): string[] {
  const found: string[] = []
  const has = (n: unknown, hit: (x: Node) => boolean): boolean => {
    const x = n as Node
    return !!x && typeof x === 'object' && (hit(x) || (x.children ?? []).some(c => has(c, hit)))
  }
  const hasButton = (n: unknown) => has(n, x => x.type === 'Button')
  const layer = (n: unknown) => has(n, x => x.props?.position === 'absolute' || x.type === 'Client')
  const walk = (n: unknown) => {
    const x = n as Node
    if (!x || typeof x !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    const kids = x.children ?? []
    kids.forEach((k, i) => {
      const c = k as Node
      if (c && layer(c) && kids.some((o, j) => j !== i && hasButton(o))) found.push(String(x.props?.key ?? x.type))
    })
    kids.forEach(walk)
  }
  walk(tree)
  return found
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: every pane tab and the band draw the board, and their main buttons work`, OPTS, async ($, on) => {
    on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
    const { status, marks, clock } = await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'Next up' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Alpha step' })).toBeDefined()
    expect(await ui.find({ key: 'tick-t1' })).toBeDefined()
    expect(await ui.find({ key: 'tab-work' })).toBeDefined()
    expect(await ui.find({ key: 'tab-session' })).toBeDefined()
    expect(status.at(-1)).toBe('2 to do')
    await evidence(`${surface}-pane-focus`, ui)

    await ui.press({ key: 'tab-work' })
    await evidence(`${surface}-pane-work`, ui)
    for (const t of ['Alpha step', 'Beta step', 'Did you already do these?', 'Delta blocked']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    await ui.press({ key: 'row-t2' })
    expect(await ui.find({ type: 'Text', text: 'Ship the beta' })).toBeDefined()
    expect(await ui.find({ key: 'go-t2' })).toBeDefined()
    await evidence(`${surface}-pane-work-opened`, ui)

    await ui.press({ key: 'tab-notes' })
    for (const t of ['Buy milk', 'Call bank']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    await evidence(`${surface}-pane-notes`, ui)

    await ui.press({ key: 'tab-wins' })
    for (const t of ['Epsilon win', 'Zeta win']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    await evidence(`${surface}-pane-wins`, ui)

    await ui.press({ key: 'tab-session' })
    expect(await ui.find({ type: 'Text', text: 'No tool calls yet. Each one shows here as it runs.' })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'echo hi' })
    await $.tool.call({ tool: 'Write', file_path: '/note.txt', content: 'x' })
    expect(await ui.find({ type: 'Text', text: 'Bash · echo hi' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No shell commands yet.' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'No files edited or written yet.' })).toBeUndefined()
    await evidence(`${surface}-pane-session`, ui)

    await ui.press({ key: 'tab-focus' })
    await ui.press({ key: 'tick-t1' })
    expect(marks().t1?.done).toBe(true)
    expect(status.at(-1)).toBe('1 to do')
    expect((await ui.find({ type: 'Text', text: 'Alpha step' }))?.props.strikethrough).toBe(true)
    await clock.advance(4000)
    expect(await ui.find({ key: 'tick-t2' })).toBeDefined()
    await ui.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: 'NEXT UP · demo' })).toBeDefined()
    expect(await band.find({ key: 'band-go' })).toBeDefined()
    expect(await band.find({ key: 'band-done' })).toBeDefined()
    await evidence(`${surface}-band`, band)
    await band.press({ key: 'band-done' })
    expect(marks().t2?.done).toBe(true)
    await band.unmount()
  })
}

test('a keep mark (Left Off "Later" or "still open") makes an unchecked step to do', OPTS, async ($, on) => {
  const { status } = await setup($, on, { [MARKS]: JSON.stringify({ t3: { keep: true, at: 1 } }) })
  expect(status.at(-1)).toBe('3 to do')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'summary-toggle-then' })
  expect(await ui.find({ type: 'Text', text: 'Gamma maybe' })).toBeDefined()
  await ui.unmount()
})

test('a kept step parked until later stays hidden until then', OPTS, async ($, on) => {
  const { status } = await setup($, on, { [MARKS]: JSON.stringify({ t3: { keep: true, parkUntil: Date.now() + 3_600_000, at: 1 } }) })
  expect(status.at(-1)).toBe('2 to do')
})

test('Clear board points to open notes when there are some', OPTS, async ($, on) => {
  await setup($, on, { [MARKS]: JSON.stringify({ t1: { done: true, at: 1 }, t2: { done: true, at: 1 } }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '✓ Clear board' })).toBeDefined()
  expect(await ui.find({ key: 'clear-notes' })).toBeDefined()
  await ui.press({ key: 'clear-notes' })
  expect(await ui.find({ key: 'nt-n1' })).toBeDefined()
  await ui.unmount()
})

test('desktop: the gauge uses glyphs the app font draws, and the idle rail is not drawn', OPTS, async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /[▮▯]/ })).toBeUndefined()
  expect(await ui.find({ key: 'rail' } as never)).toBeUndefined()
  await ui.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The terminal keeps the rail: the rail client where the surface runs clients, else a text rule.
  expect((await term.find({ key: 'rail' } as never)) ?? (await term.find({ type: 'Text', text: /─{12}/ }))).toBeDefined()
  expect(await term.find({ type: 'Text', text: /▯/ })).toBeDefined()
  await term.unmount()
})

test('desktop: while the board rescans, the orange rail runs under the title, and it goes when the rescan ends', OPTS, async ($, on) => {
  const { release } = await setup($, on, { [`${DIR}/build.py`]: '', '!hold build': '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'rail' } as never)).toBeUndefined()
  const pressed = ui.press({ key: 'refresh' })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const rail = (await ui.find({ key: 'rail' } as never)) as { props: Record<string, unknown> } | undefined
  expect(rail?.props).toMatchObject({ props: { active: true, color: tone.brand } })
  expect((await ui.find({ key: 'refresh' }))?.props.label).toBe('rescanning…')
  release()
  await pressed
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(await ui.find({ key: 'rail' } as never)).toBeUndefined()
  await ui.unmount()
})

test('concept C: compact header and full-width segmented tabs', OPTS, async ($, on) => {
  await setup($, on, { [MARKS]: HISTORY })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '2 wins today' })).toBeDefined()
  expect(await ui.find({ key: 'refresh', label: '↻ rescan' } as never)).toBeDefined()
  expect(JSON.stringify(await ui.find({ key: 'head-row' }))).not.toContain('refresh')
  expect(await ui.find({ key: 'tab-row' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^● (Next|Session)/ })).toBeUndefined()
  await ui.press({ key: 'tab-work' })
  expect((await ui.find({ type: 'Text', text: 'Next' }))?.props.weight).toBe('bold')
  await ui.unmount()
})

test('Not today on a kept step keeps it kept, so it comes back as to do', OPTS, async ($, on) => {
  const { marks } = await setup($, on, { [MARKS]: JSON.stringify({ t1: { done: true, at: 1 }, t2: { done: true, at: 1 }, t3: { keep: true, at: 1 } }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'park-t3' })
  expect(marks().t3?.parkUntil).toBeGreaterThan(Date.now())
  expect(marks().t3?.keep).toBe(true)
  await ui.unmount()
})

test('Done and Not today use the engine clock, and Tick all writes Marks once', OPTS, async ($, on) => {
  const { writes, clock, marks } = await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick-t1' })
  expect(marks().t1?.at).toBe(clock.now())
  await clock.advance(4000)
  await ui.press({ key: 'park-t2' })
  const until = new Date(clock.now())
  until.setDate(until.getDate() + 1)
  until.setHours(8, 0, 0, 0)
  expect(marks().t2?.parkUntil).toBe(until.getTime())
  expect(marks().t2?.at).toBe(clock.now())
  const before = writes.filter(path => path === MARKS).length
  await ui.press({ key: 'tab-wins' })
  await ui.press({ key: 'tick-all' })
  await ui.press({ key: 'tick-all-yes' })
  expect(writes.filter(path => path === MARKS).length - before).toBe(1)
  expect(marks().w1).toEqual({ done: true, at: clock.now() })
  expect(marks().w2).toEqual({ done: true, at: clock.now() })
  await ui.unmount()
})


test('An empty Marks ledger still dates the week from the engine clock', OPTS, async ($, on) => {
  const now = Date.UTC(2030, 0, 15, 12)
  await setup($, on, {}, '', true, now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-wins' })
  expect(JSON.stringify(await ui.find({ key: 'wk-6' }))).toContain(new Date(now).toLocaleDateString(undefined, { weekday: 'short' }))
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: Hero and Needs you precede collapsed Momentum with one compact Later today block`, OPTS, async ($, on) => {
    on('mcp.call', (_, e) => ({ value: { content: [{ type: 'text', text: e.tool === 'list_sessions'
      ? JSON.stringify([{ sessionId: 'waiting', title: 'Waiting session', isRunning: false, lastActivityAt: new Date().toISOString(), link: 'claude://resume?session=waiting' }])
      : 'Session "waiting" (idle)\n[assistant] Approve $400?' }], isError: false } as never }))
    await setup($, on, { [`${DIR}/calendar.json`]: CAL(), [`${DIR}/drafts.json`]: DRAFTS, [`${DIR}/today.json`]: JSON.stringify({ date: dayKey(), ids: ['t2'] }) }, GH)
    const ui = await $.ui.mount({ ...PANE, surface })
    const content = await ui.find({ key: 'next-content' })
    const keys = (content?.children as { props: { key?: string } }[]).map(x => x.props.key)
    expect(keys.filter(key => key !== 'panel-rescue')).toEqual(['hero', 'panel-needs', 'summary-momentum', 'later-today'])
    for (const key of ['calendar', 'drafts', 'today', 'then', 'prs']) {
      expect(await ui.find({ key: `summary-toggle-${key}` })).toBeDefined()
    }
    expect(await ui.find({ key: 'cal' })).toBeUndefined()
    expect(await ui.find({ key: 'prs' })).toBeUndefined()
    expect(await ui.find({ key: 'drafts' })).toBeUndefined()
    const summary = JSON.stringify(await ui.find({ key: 'later-today' }))
    expect(summary).toContain('Broken build')
    expect(summary).toContain('September invoice')
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: '1 needs you' })).toBeDefined()
    await band.unmount()
    await ui.unmount()
  })

  test(`${surface}: hero explains ranking, shows scan age and hides absent context; Thread details opens details`, OPTS, async ($, on) => {
    const now = Date.parse('2026-10-22T09:05:00')
    const { clock, marks } = await setup($, on, {}, '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Why this: Money: value 5 for 10 min · best return on effort' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'updated 5 min ago' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Where you were:/ })).toBeUndefined()
    expect(await ui.find({ key: 'hit-hero-t1' } as never)).toBeUndefined()
    await ui.press({ key: 'hero-details' } as never)
    expect(await ui.find({ type: 'Text', text: 'No earlier session context recorded.' })).toBeDefined()
    expect(marks().t1).toBeUndefined()
    await ui.press({ key: 'tick-t1' })
    await clock.advance(4000)
    expect(await ui.find({ type: 'Text', text: 'Where you were: Tests pass; PR open' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: wins header encourages a first win without a quota or permanent scan control`, OPTS, async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    const head = JSON.stringify(await ui.find({ key: 'head-row' }))
    expect(head).toContain('Your first win today awaits')
    expect(head).not.toContain('0/')
    expect(head).not.toContain('refresh')
    expect(head).not.toContain('09:00')
    await ui.press({ key: 'tick-t1' })
    expect(JSON.stringify(await ui.find({ key: 'head-row' }))).toContain('1 win today')
    await ui.unmount()
  })

  for (const action of ['later', 'board', 'hide'] as const) {
    test(`${surface}: Band More ${action} works without extra buttons`, OPTS, async ($, on) => {
      const opened: string[] = []
      on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } as never }))
      const { marks } = await setup($, on)
      opened.length = 0
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.findAll({ type: 'Button' })).length).toBe(2)
      await ui.select({ key: 'band-more', value: action })
      if (action === 'later') expect(marks().t1?.parkUntil).toBeGreaterThan(Date.now())
      else if (action === 'board') expect(opened).toContain('nextup')
      else expect(await ui.find({ key: 'band-done' })).toBeUndefined()
      await ui.unmount()
    })
  }
}


for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: Momentum goal, estimates and day parts use recorded wins`, OPTS, async ($, on) => {
    const now = new Date(2026, 9, 22, 14).getTime()
    const { clock } = await setup($, on, { [MARKS]: JSON.stringify({
      w1: { done: true, at: new Date(2026, 9, 22, 9).getTime() },
      w2: { done: true, at: new Date(2026, 9, 22, 13).getTime() },
      future: { done: true, at: now + 1000 },
      dropped: { done: true, dropped: true, at: now },
    }) }, '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'tick-t1' }))?.props.label).toBe('Done')
    expect((await ui.find({ key: 'tick-t1' }))?.props.hotkey).toBe('d')
    expect(await ui.find({ key: 'panel-momentum' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '2 of 5 wins today' })).toBeUndefined()
    await ui.press({ key: 'summary-toggle-momentum' })
    expect(await ui.find({ type: 'Text', text: '2 of 5 wins today' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Points: 6 completed this week' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Hours: 0.3 h estimated completed this week' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Morning · 1 win' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Midday · 1 win' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Night · 0 wins' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Revenue and hours budget unavailable' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /no longer on the board/ })).toBeUndefined()
    if (surface === 'desktop') expect((await ui.find({ type: 'Svg' } as never))?.props.alt).toBe('2 of 5 wins today')
    else expect(JSON.stringify(await ui.drawn())).toContain('▮')
    await ui.press({ key: 'tick-t1' })
    expect(await ui.find({ type: 'Text', text: '3 of 5 wins today' })).toBeDefined()
    await ui.press({ key: 'undo-t1' })
    expect(await ui.find({ type: 'Text', text: '2 of 5 wins today' })).toBeDefined()
    await clock.advance(0)
    await evidence(`${surface}-momentum`, ui)
    await ui.unmount()
  })

  test(`${surface}: Rescue appears only after a stalled day and opens a small task`, OPTS, async ($, on) => {
    const now = new Date(2026, 9, 22, 9).getTime()
    const { clock, marks } = await setup($, on, {}, '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'panel-rescue' })).toBeUndefined()
    await clock.advance(30 * 60_000)
    expect(await ui.find({ key: 'panel-rescue' })).toBeDefined()
    await evidence(`${surface}-rescue`, ui)
    await ui.press({ key: 'rescue-t2' })
    expect(await ui.find({ key: 'ctx-t2' })).toBeDefined()
    expect(marks().t2).toBeUndefined()
    await ui.press({ key: 'tick-t1' })
    expect(await ui.find({ key: 'panel-rescue' })).toBeUndefined()
    await ui.unmount()
  })

  // Rescue one, 22 Oct 09:30: the smallest step is t2 (Claude Code). Every button says what happened.
  const rescueSetup = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], ids: boolean, resume?: string) => {
    const board = resume ? { ...BOARD, threads: BOARD.threads.map(x => x.id === 't2' ? { ...x, resume } : x) } : BOARD
    const now = new Date(2026, 9, 22, 9).getTime()
    const ctx = await setup($, on, { [`${DIR}/threads.json`]: JSON.stringify(board) }, '', true, now, argv => ({ exitCode: ids ? 0 : 1, stdout: '', stderr: '' }))
    await ctx.clock.advance(30 * 60_000)
    return ctx
  }
  test(`${surface}: Rescue says what it opened`, OPTS, async ($, on) => {
    await rescueSetup($, on, true)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'rescue-t2' })
    expect(await ui.find({ type: 'Text', text: 'Rescue: Beta step. First step below.' })).toBeDefined()
    await ui.unmount()
  })
  test(`${surface}: Go to session on the Rescue card says Opened when the session is here`, OPTS, async ($, on) => {
    const { procs } = await rescueSetup($, on, true)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'rescue-t2' })
    await ui.press({ key: 'go-t2' })
    expect(procs).toContainEqual(['open', 'claude://resume?session=t2'])
    expect(await ui.find({ type: 'Text', text: 'Opened Beta step' })).toBeDefined()
    await ui.unmount()
  })
  test(`${surface}: Go to session says so when the transcript is not on this Mac, and opens nothing`, OPTS, async ($, on) => {
    const { procs } = await rescueSetup($, on, false)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'rescue-t2' })
    await ui.press({ key: 'go-t2' })
    expect(procs.filter(a => a[0] === 'open')).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Session not found on this Mac: Beta step' })).toBeDefined()
    await ui.unmount()
  })
  test(`${surface}: Go to session on a session that lives on another Mac copies its ssh resume command`, OPTS, async ($, on) => {
    const cmd = 'ssh -t macmini "cd /x && claude --resume t2"'
    const { procs, copies } = await rescueSetup($, on, false, cmd)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'rescue-t2' })
    expect(await ui.find({ key: 'go-t2' })).toBeUndefined()
    await ui.press({ key: 'ssh-t2' })
    expect(procs.filter(a => a[0] === 'open')).toEqual([])
    expect(copies).toContain(cmd)
    expect(await ui.find({ type: 'Text', text: 'Beta step is on the Mac Mini. Resume command copied: paste it in a terminal.' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: plugin reload runs scoped commands and lists blocked Desktop sessions`, RELOAD_OPTS, async ($, on) => {
    const calls: string[][] = []
    const { clock } = await setup($, on, HELPER_FILE, '', true, Date.now(), argv => {
      calls.push([...argv])
      return { exitCode: 0, stdout: JSON.stringify({ plugins: [{ update_error: '' }], reloaded: ['terminal-1'], current: [], needs_restart: ['desktop-1', 'desktop-2'] }), stderr: '' }
    })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(calls.slice(0, 2)).toEqual([
      ['claude', 'plugin', 'marketplace', 'update', 'nextup'], ['claude', 'plugin', 'update', 'nextup@nextup'],
    ])
    expect(calls[2]?.slice(-3)).toEqual(['--plugin', 'nextup@nextup', '--json'])
    expect(calls[2]).toEqual(['python3', HELPER, '--plugin', 'nextup@nextup', '--json'])
    expect(calls[2]?.join(' ')).not.toContain('--send-keys')
    // Old script output (no reloaded_by_app, no version): one terminal session reloaded, two still need a type.
    expect(await ui.find({ type: 'Text', text: 'Updated. Sent, not confirmed: no session has said it reloaded. 2 sessions still need /reload-plugins typed.' })).toBeDefined()
    const band = await $.ui.mount({ ...BAND, surface })
    await band.select({ key: 'band-more', value: 'reload' })
    await clock.advance(0)
    expect(calls.length).toBe(8)
    await band.unmount(); await ui.unmount()
  })

  test(`${surface}: plugin reload counts sessions the app reloaded and lists only those still needing a type`, RELOAD_OPTS, async ($, on) => {
    const now = Date.now()
    const { clock } = await setup($, on, HELPER_FILE, '', true, now, argv => ({
      exitCode: 0, stderr: '',
      stdout: argv[0] === 'python3'
        ? JSON.stringify({ plugins: [{ update_error: '', before: '0.4.38', after: '0.4.39' }], reloaded: ['t1'], current: [], reloaded_by_app: ['d1', 'd2'], needs_restart: ['d3'] })
        : argv.join(' ').includes('main.log') ? ['x1', 'd1', 'd2'].map(id => appliedLine(id, now + 2000)).join('') : '',
    }))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: 'Updated to 0.4.39. Reloaded 3 sessions. 1 session still needs /reload-plugins typed.' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: plugin reload says nothing about typing when the app reloaded every session`, RELOAD_OPTS, async ($, on) => {
    const now = Date.now()
    const { clock } = await setup($, on, HELPER_FILE, '', true, now, argv => ({
      exitCode: 0, stderr: '',
      stdout: argv[0] === 'python3'
        ? JSON.stringify({ plugins: [{ update_error: '', after: '0.4.39' }], reloaded: [], current: [], reloaded_by_app: ['d1'], needs_restart: [] })
        : argv.join(' ').includes('main.log') ? appliedLine('d1', now + 2000) : '',
    }))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: 'Updated to 0.4.39. Reloaded 1 session.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reload-plugins/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: plugin reload without a helper updates and tells sessions to reload`, OPTS, async ($, on) => {
    const calls: string[][] = []
    const { clock } = await setup($, on, {}, '', true, Date.now(), argv => { calls.push([...argv]); return { exitCode: 0, stdout: '', stderr: '' } })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(calls).toEqual([['claude', 'plugin', 'marketplace', 'update', 'nextup'], ['claude', 'plugin', 'update', 'nextup@nextup']])
    expect(await ui.find({ type: 'Text', text: 'Plugin updated. Type /reload-plugins in your open sessions.' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: plugin reload skips a helper that is not on disk`, RELOAD_OPTS, async ($, on) => {
    const calls: string[][] = []
    const { clock } = await setup($, on, {}, '', true, Date.now(), argv => { calls.push([...argv]); return { exitCode: 0, stdout: '', stderr: '' } })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(calls.length).toBe(2)
    expect(await ui.find({ type: 'Text', text: 'Plugin updated. Type /reload-plugins in your open sessions.' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: plugin reload shows running, prevents overlap and stops on failure`, OPTS, async ($, on) => {
    let release = () => {}
    let calls = 0
    const { clock } = await setup($, on, {}, '', true, Date.now(), async () => {
      calls++
      await new Promise<void>(r => { release = r })
      return { exitCode: 1, stdout: '', stderr: 'offline' }
    })
    const ui = await $.ui.mount({ ...PANE, surface })
    // Menu handlers start a background promise so running state can draw.
    const first = ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(await ui.find({ type: 'Text', text: 'Reloading plugins...' })).toBeDefined()
    // The log append of the refused press waits behind the held run, so it is awaited after the release.
    const second = ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(calls).toBe(1)
    release()
    await first
    await second
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // Drawing awaits the state writes queued by the command result.
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /Reload failed:.*offline/ })).toBeDefined()
    expect(calls).toBe(1)
    await ui.unmount()
  })
}

for (const failure of ['update', 'helper', 'malformed', 'denied'] as const) {
  test(`reload: ${failure} reports failure and permits a successful retry`, RELOAD_OPTS, async ($, on) => {
    let retry = false
    const calls: string[][] = []
    const { clock } = await setup($, on, HELPER_FILE, '', true, Date.now(), argv => {
      calls.push([...argv])
      const helper = argv[0] === 'python3'
      if (!retry) {
        if (failure === 'denied') throw new Error('Command denied')
        if (failure === 'update' && argv[2] === 'update') return { exitCode: 1, stdout: '', stderr: 'update failed' }
        if (helper) return { exitCode: 0, stdout: failure === 'malformed' ? '{}' : JSON.stringify({ plugins: [{ update_error: 'helper update failed' }], needs_restart: [] }), stderr: '' }
      }
      return { exitCode: 0, stdout: JSON.stringify({ plugins: [{ update_error: '' }], needs_restart: [] }), stderr: '' }
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: /^Reload failed:/ })).toBeDefined()
    if (failure === 'update') expect(calls.length).toBe(2)
    if (failure === 'denied') expect(calls.length).toBe(1)
    retry = true
    await ui.select({ key: 'pane-more', value: 'reload' })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: 'Updated. Sent, not confirmed: no session has said it reloaded.' })).toBeDefined()
    await ui.unmount()
  })
}

// ---------------------------------------------------------------------------------------------
// The Sentinel (design 2026-10-26, lane A): the strip, the cards, and a visible result for every press.
// Each test replays a failure from the census: the ones Darren found before the system did.
// ---------------------------------------------------------------------------------------------

const MIN = 60_000
const CARD1 = 'sentinel-3f9a1c20'
const CARD2 = 'sentinel-81be07d4'
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
/** The three files sentinel.py leaves in the data folder. */
const SN = (now: number, o: { report?: unknown; ageMin?: number; status?: string; script?: boolean; state?: boolean } = {}): Record<string, string> => ({
  ...(o.script === false ? {} : { [`${DIR}/sentinel.py`]: '' }),
  [`${DIR}/sentinel.json`]: JSON.stringify(o.report ?? sentinelSample),
  ...(o.state === false ? {} : { [`${DIR}/sentinel-state.json`]: JSON.stringify({ t: now - (o.ageMin ?? 2) * MIN, status: o.status ?? 'attention', version: 1 }) }),
})
const text = async (ui: { find(q: never): Promise<{ props: Record<string, unknown> } | undefined> }, t: string | RegExp) => ui.find({ type: 'Text', text: t } as never)
const feedbackText = async (ui: { find(q: never): Promise<{ props: Record<string, unknown> } | undefined> }) => JSON.stringify(await ui.find({ key: 'feedback-line' } as never))

for (const surface of ['desktop', 'terminal'] as const) {
  // 1. Two cards: the strip says so, tapping it opens both cards.
  test(`${surface}: sentinel: two cards show "2 things need a look" and open to two cards`, OPTS, async ($, on) => {
    const now = Date.now()
    await setup($, on, SN(now), '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'sentinel-strip' }))?.props.label).toBe('2 things need a look')
    expect(await ui.find({ key: `sentinel-card-${CARD1}` })).toBeUndefined()
    await ui.press({ key: 'sentinel-strip' })
    expect(await ui.find({ key: `sentinel-card-${CARD1}` })).toBeDefined()
    expect(await ui.find({ key: `sentinel-card-${CARD2}` })).toBeDefined()
    expect(await text(ui, /Phone ticks missing from the board/)).toBeDefined()
    await ui.press({ key: 'sentinel-strip' })
    expect(await ui.find({ key: `sentinel-card-${CARD1}` })).toBeUndefined()
    await ui.unmount()
  })

  // 1b. Zero cards: one quiet line, with the age of the check.
  test(`${surface}: sentinel: zero cards is one quiet line that says when it last checked`, OPTS, async ($, on) => {
    const now = Date.now()
    await setup($, on, SN(now, { report: { ...sentinelSample, status: 'ok', cards: [] }, ageMin: 3, status: 'ok' }), '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, 'All clear, checked 3 min ago')).toBeDefined()
    expect(await ui.find({ key: 'sentinel-strip' })).toBeDefined()
    expect(await text(ui, /need a look/)).toBeUndefined()
    await ui.unmount()
  })

  // 2. Unknown is never green: census 11 and 12 were failures nothing was watching.
  test(`${surface}: sentinel: no sentinel.py, or no state file, says "Sentinel not installed" and never all clear`, OPTS, async ($, on) => {
    const now = Date.now()
    await setup($, on, SN(now, { script: false }), '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, 'Sentinel not installed')).toBeDefined()
    expect(await text(ui, /All clear/)).toBeUndefined()
    expect(await ui.find({ key: `sentinel-card-${CARD1}` })).toBeUndefined()
    await ui.unmount()
  })
  test(`${surface}: sentinel: a script with no state file has not run, so it is not installed either`, OPTS, async ($, on) => {
    const now = Date.now()
    await setup($, on, SN(now, { state: false }), '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, 'Sentinel not installed')).toBeDefined()
    expect(await text(ui, /All clear/)).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: sentinel: a check older than 15 minutes is amber and says since when`, OPTS, async ($, on) => {
    const now = Date.now()
    await setup($, on, SN(now, { ageMin: 40 }), '', true, now)
    const ui = await $.ui.mount({ ...PANE, surface })
    const line = await text(ui, `Sentinel has not checked since ${hhmm(now - 40 * MIN)}`)
    expect(line).toBeDefined()
    expect(line?.props.color).toBe(tone.warn)
    expect(await text(ui, /All clear/)).toBeUndefined()
    await ui.unmount()
  })
}

test('sentinel: a card Darren already has on the board as a note is not shown twice', OPTS, async ($, on) => {
  const now = Date.now()
  const notes = { items: [...NOTES.items, { id: CARD1, text: 'Phone ticks missing', title: 'Phone ticks missing', project: 'Next up Sentinel', ticked: false, minutes: null }] }
  await setup($, on, { ...SN(now), [`${DIR}/notes.json`]: JSON.stringify(notes) }, '', true, now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-notes' })
  expect(await ui.find({ key: `nt-${CARD1}` })).toBeUndefined()
  expect(await ui.find({ key: 'nt-n1' })).toBeDefined()
  await ui.unmount()
})

// 3. The card hands over its prompt as written, by the paths a row already has.
test('sentinel: Copy prompt puts the exact prompt on the clipboard', OPTS, async ($, on) => {
  const now = Date.now()
  const { copies } = await setup($, on, SN(now), '', true, now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sentinel-strip' })
  await ui.press({ key: `sentinel-copy-${CARD1}` })
  expect(copies).toEqual([sentinelSample.cards[0]!.prompt])
  await ui.unmount()
})

test('sentinel: Start side task opens a new session with the card prompt on the clipboard', OPTS, async ($, on) => {
  const now = Date.now()
  const { copies, procs } = await setup($, on, SN(now), '', true, now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sentinel-strip' })
  await ui.press({ key: `sentinel-side-${CARD2}` })
  expect(copies).toEqual([sentinelSample.cards[1]!.prompt])
  expect(procs).toContainEqual(['open', 'claude://code/new'])
  await ui.unmount()
})

// S23: a clipboard that fails was never checked.
test('sentinel: a clipboard that fails shows a message and is logged as a failure', OPTS, async ($, on) => {
  const now = Date.now()
  const { events } = await setup($, on, { ...SN(now), '!copy': '' }, '', true, now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sentinel-strip' })
  await ui.press({ key: `sentinel-copy-${CARD1}` })
  expect(await feedbackText(ui)).toContain("Couldn't copy the prompt")
  expect(events().at(-1)).toMatchObject({ action: 'copy-prompt', outcome: 'fail' })
  await ui.unmount()
})

// S24: process.run's exit code was ignored in startSide, so Darren could land in nothing.
test('sentinel: Start side task says so when the app would not open', OPTS, async ($, on) => {
  const now = Date.now()
  await setup($, on, SN(now), '', true, now, argv => argv[0] === 'open' ? { exitCode: 1, stdout: '', stderr: 'no application' } : { exitCode: 0, stdout: '', stderr: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sentinel-strip' })
  await ui.press({ key: `sentinel-side-${CARD1}` })
  expect(await feedbackText(ui)).toContain("Couldn't start a side task")
  await ui.unmount()
})

// 4. act(): every press ends in a visible result and one logged line.
test('act: a press shows Working at once, then its result, then lets go', OPTS, async ($, on) => {
  const { release, clock, events } = await setup($, on, { [`${DIR}/build.py`]: '', '!hold build': '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pressed = ui.press({ key: 'refresh' })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(await feedbackText(ui)).toContain('Working…')
  expect(events()).toEqual([])
  release()
  await pressed
  await clock.advance(0)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(await feedbackText(ui)).not.toContain('Working…')
  expect(await feedbackText(ui)).toContain('Board rescanned')
  expect(events()).toHaveLength(1)
  expect(events()[0]).toMatchObject({ action: 'rescan', outcome: 'ok' })
  await clock.advance(7_000)
  expect(await ui.find({ key: 'feedback-line' } as never)).toBeUndefined()
  await ui.unmount()
})

test('act: a handler that throws shows a short failure and logs it', OPTS, async ($, on) => {
  const { events } = await setup($, on, { [`!write ${MARKS}`]: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick-t1' })
  expect(await feedbackText(ui)).toMatch(/Couldn't mark it done/)
  expect(events().at(-1)).toMatchObject({ action: 'done', outcome: 'fail' })
  expect(events().at(-1)?.msg).not.toContain('\n')
  await ui.unmount()
})

// S21: Done with a marks file that cannot be read returned false and said nothing.
test('act: Done on an unreadable marks file says why, as nothing changed', OPTS, async ($, on) => {
  const { events, marks } = await setup($, on, { [MARKS]: '{not json' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick-t1' })
  expect(await feedbackText(ui)).toContain('mod-marks.json is unreadable')
  expect(events().at(-1)).toMatchObject({ action: 'done', outcome: 'noop' })
  expect(events().at(-1)?.msg).toContain('mod-marks.json is unreadable')
  // The row is back, not stuck half done.
  expect(await ui.find({ key: 'tick-t1' })).toBeDefined()
  void marks
  await ui.unmount()
})

// S26: a manual Rescan inside the throttle returned false and drew nothing.
test('act: a Rescan pressed again too soon says when the next one can run', OPTS, async ($, on) => {
  const { clock, events, procs } = await setup($, on, { [`${DIR}/build.py`]: '', '!store': '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await clock.advance(0)
  await clock.advance(20_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(0)
  expect(await feedbackText(ui)).toMatch(/next in 1 min/)
  expect(procs.filter(a => a[1] === 'build.py')).toHaveLength(1)
  expect(events().map(e => e.outcome)).toEqual(['ok', 'noop'])
  await clock.advance(61_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(0)
  expect(procs.filter(a => a[1] === 'build.py')).toHaveLength(2)
  await ui.unmount()
})

test('act: every press appends exactly one line to mod-events.jsonl, with how fast it answered', OPTS, async ($, on) => {
  const { events } = await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick-t1' })
  expect(events()).toHaveLength(1)
  expect(events()[0]).toMatchObject({ action: 'done', outcome: 'ok' })
  expect(events()[0]!.feedbackMs).toBeLessThan(1000)
  await ui.unmount()
})

test('act: a view change (a tab) is quiet when it works', OPTS, async ($, on) => {
  const { events } = await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  expect(events()).toEqual([])
  expect(await ui.find({ key: 'feedback-line' } as never)).toBeUndefined()
  await ui.unmount()
})

test('act: a result can be dismissed', OPTS, async ($, on) => {
  const { clock } = await setup($, on, { [`!write ${MARKS}`]: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick-t1' })
  await clock.advance(0)
  expect(await ui.find({ key: 'feedback-line' } as never)).toBeDefined()
  await ui.press({ key: 'feedback-dismiss' })
  expect(await ui.find({ key: 'feedback-line' } as never)).toBeUndefined()
  await ui.unmount()
})

// 5. SN-08: a session on the Mac Mini is not a dead link (census 2).
test('SN-08: a thread hosted on the Mac Mini says so and offers no resume link', OPTS, async ($, on) => {
  const cmd = 'ssh -t macmini "cd /x && claude --resume t2"'
  const board = { ...BOARD, threads: BOARD.threads.map(x => x.id === 't2' ? { ...x, resume: cmd } : x) }
  const { copies } = await setup($, on, { [`${DIR}/threads.json`]: JSON.stringify(board) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-work' })
  await ui.press({ key: 'row-t2' })
  expect(await text(ui, 'On Mac Mini, open it there')).toBeDefined()
  expect(await ui.find({ key: 'go-t2' })).toBeUndefined()
  expect(await ui.find({ key: 'res-t2' })).toBeUndefined()
  await ui.press({ key: 'ssh-t2' })
  expect(copies).toContain(cmd)
  await ui.unmount()
})

// SN-08 after the press: the app logs transcript_missing when it opens nothing.
const GO_NOW = new Date(2026, 9, 22, 9, 30).getTime()
const missingLog = (id: string, at: number) => `${stampOf(at)} [error] Failed to import CLI session { error: 'Error', sessionId: '${id}', category: 'transcript_missing' }\n`
const goSetup = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], log: string) => {
  const ctx = await setup($, on, {}, '', true, GO_NOW, argv => ({ exitCode: 0, stdout: argv.join(' ').includes('main.log') ? log : '', stderr: '' }))
  await ctx.clock.advance(30 * 60_000 - 1)
  return ctx
}
test('SN-08: transcript_missing in main.log after Go to session flips the card note to failed', OPTS, async ($, on) => {
  const log = missingLog('t2', GO_NOW + 30 * 60_000 + 1000)
  const { clock, events } = await goSetup($, on, log)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'rescue-t2' })
  await ui.press({ key: 'go-t2' })
  expect(await text(ui, 'Opened Beta step')).toBeDefined()
  await clock.advance(3_000)
  expect(await text(ui, 'Opened Beta step')).toBeUndefined()
  expect(await text(ui, /Beta step did not open/)).toBeDefined()
  expect(events().map(e => `${e.action}:${e.outcome}`)).toContain('go-to-session:fail')
  await ui.unmount()
})
test('SN-08: a quiet main.log leaves the card note at Opened', OPTS, async ($, on) => {
  const { clock } = await goSetup($, on, missingLog('someone-else', GO_NOW + 30 * 60_000 + 1000))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'rescue-t2' })
  await ui.press({ key: 'go-t2' })
  await clock.advance(3_000)
  expect(await text(ui, 'Opened Beta step')).toBeDefined()
  await ui.unmount()
})

// SN-09: a reload is only claimed with the app's own "applied" lines (census 3 and 16).
const appliedLine = (id: string, at: number) => `${stampOf(at)} [info] [CCD] reload_plugins applied for local_${id}: 10 plugin(s), 135 command(s), 0 plugin error(s)\n`
const reloadRun = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], log: (now: number) => string, report: Record<string, unknown>) => {
  const now = Date.now()
  const { clock, events } = await setup($, on, HELPER_FILE, '', true, now, argv => ({
    exitCode: 0, stderr: '',
    stdout: argv.join(' ').includes('main.log') ? log(now) : argv[0] === 'python3' ? JSON.stringify({ plugins: [{ update_error: '', after: '0.5.4' }], needs_restart: [], ...report }) : '',
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'pane-more', value: 'reload' })
  await clock.advance(0)
  return { ui, events }
}
test('SN-09: a reload with no applied line since the press reads "Sent, not confirmed"', RELOAD_OPTS, async ($, on) => {
  const { ui, events } = await reloadRun($, on, now => appliedLine('old', now - 10 * MIN), { reloaded: ['t1', 't2'] })
  expect(await text(ui, /^Updated to 0\.5\.4\. Sent, not confirmed/)).toBeDefined()
  expect(await text(ui, /Reloaded \d/)).toBeUndefined()
  expect(events().at(-1)).toMatchObject({ action: 'reload-plugins', outcome: 'noop' })
  await ui.unmount()
})
test('SN-09: a reload with applied lines since the press reads "Reloaded N"', RELOAD_OPTS, async ($, on) => {
  const { ui, events } = await reloadRun($, on, now => appliedLine('a', now + 2000) + appliedLine('b', now + 3000) + appliedLine('b', now + 4000), { reloaded: [] })
  expect(await text(ui, 'Updated to 0.5.4. Reloaded 2 sessions.')).toBeDefined()
  expect(events().at(-1)).toMatchObject({ action: 'reload-plugins', outcome: 'ok' })
  await ui.unmount()
})

// 7. Every store says how old it is (SN-06): amber at one interval, red at three, and the words change.
for (const [min, words, color] of [[20, 'updated 20 min ago', undefined], [50, 'updated 50 min ago, older than usual', tone.warn], [140, 'updated 2 h ago, out of date', tone.fail]] as const) {
  test(`age chips: a board scan ${min} minutes old reads "${words}"`, OPTS, async ($, on) => {
    const { clock } = await setup($, on, {}, '', true, Date.parse('2026-10-22T09:00:00') + min * MIN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await clock.advance(0)
    const chip = await text(ui, words)
    expect(chip).toBeDefined()
    expect(chip?.props.color).toBe(color)
    await ui.unmount()
  })
}

// M8 and M6: the band says what needs you now, and a waiting permission shows on the Needs you card.
const WAIT_DIR = `${DIR}/permission-wait`
const waitFile = (session: string, tool?: string) => JSON.stringify({ session_id: session, status: 'waiting-on-permission', at: Date.now() - 3 * 60_000, ...(tool ? { tool } : {}) })

test('the status text drops the title prefix, counts what needs you, and fits 48 columns with the host prefix', OPTS, async ($, on) => {
  const files: Record<string, string> = { [`${WAIT_DIR}/a.json`]: waitFile('sess-a', 'Bash'), [`${WAIT_DIR}/.tmp.tmp`]: 'x' }
  on('fs.list', (_, e) => ({ value: e.path === WAIT_DIR ? Object.keys(files).filter(f => f.startsWith(`${WAIT_DIR}/`)).map(f => ({ name: f.slice(WAIT_DIR.length + 1), kind: 'file' as const, size: 0, mtimeMs: 1, isLink: false })) : [] }))
  const { status } = await setup($, on, { ...files, [WAIT_DIR]: '' })
  const last = status.at(-1)!
  expect(last).toBe('1 needs you · 2 to do')
  expect(last).not.toMatch(/Next up/)
  expect(`nextup: ${last}`.length).toBeLessThanOrEqual(48)
  expect(last).not.toMatch(/tick/)
})

test('a waiting permission shows its session and tool on the Needs you card', OPTS, async ($, on) => {
  const files: Record<string, string> = { [`${WAIT_DIR}/a.json`]: waitFile('sess-a', 'Bash') }
  on('fs.list', (_, e) => ({ value: e.path === WAIT_DIR ? Object.keys(files).map(f => ({ name: f.slice(WAIT_DIR.length + 1), kind: 'file' as const, size: 0, mtimeMs: 1, isLink: false })) : [] }))
  await setup($, on, { ...files, [WAIT_DIR]: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'panel-needs' } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'sess-a' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Waiting for permission to use Bash' })).toBeDefined()
  await ui.unmount()
})
