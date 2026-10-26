import { expect, mock, test } from 'claude-code/testing'
import { desk, tone } from './theme'

test('desktop wide Session column and cards can shrink within the pane', { options: { dataDir: '/board' } }, async ($) => {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 140 }, surface: 'desktop' })
  const wide = await ui.find({ key: 'wide' })
  expect(wide).toBeDefined()
  const columns = wide!.children as { props: Record<string, unknown> }[]
  expect(columns[1]?.props).toMatchObject({ width: '100%', flexShrink: 1, minWidth: 0 })
  const cards = (await ui.findAll({ type: 'Box' })).filter(x => x.key?.startsWith('pc-'))
  expect(cards.length).toBe(4)
  for (const card of cards) expect(card.props).toMatchObject({ width: '100%', flexShrink: 1, minWidth: 0 })
  await ui.unmount()
})

test('desktop tabs are two framed Buttons, the view shown primary, with no hit overlay', { options: { dataDir: '/board' } }, async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A desktop takes a click anywhere on a framed Button, as Done and Go to session; a plain one only on its text,
  // and the hit regions laid over plain tabs (0.4.21 to 0.4.23) missed clicks in the app.
  expect(await ui.find({ key: 'hit-tabs' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-track' })).toBeUndefined()
  const row = await ui.find({ key: 'tab-row' })
  expect((row!.children as { props: { key?: string } }[]).map(x => x.props.key)).toEqual(['tabbox-focus', 'tabbox-session'])
  const variants = async () => {
    const out: Record<string, unknown> = {}
    for (const id of ['focus', 'session']) {
      const box = await ui.find({ key: `tabbox-${id}` })
      // Equal halves, each Button stretched across its half.
      expect(box?.props).toMatchObject({ flexGrow: 1, width: 0, flexDirection: 'column', alignItems: 'stretch' })
      expect(box!.children.length).toBe(1)
      const button = box!.children[0] as { type: string; props: Record<string, unknown> }
      expect(button.type).toBe('Button')
      expect(button.props.plain).toBeUndefined()
      out[id] = button.props.variant
    }
    return out
  }
  expect(await variants()).toEqual({ focus: 'primary', session: undefined })
  await ui.press({ key: 'tab-session' } as never)
  expect(await variants()).toEqual({ focus: undefined, session: 'primary' })
  // The lists sit under Next, so Next stays the primary tab on them.
  await ui.press({ key: 'tab-focus' } as never)
  await ui.press({ key: 'tab-work' } as never)
  expect(await variants()).toEqual({ focus: 'primary', session: undefined })
  await ui.unmount()
})

for (const columns of [44, 100]) {
  test(`desktop tab row at ${columns} columns: the tabs keep their size on both views, and a quiet Hand off sits in the header`, { options: { dataDir: '/board' } }, async ($, on) => {
    on('command.list', () => ({ value: [HANDOFF] as never }))
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'desktop' })
    const before = await ui.find({ key: 'tab-row' })
    await ui.press({ key: 'tab-session' } as never)
    const row = await ui.find({ key: 'tab-row' })
    expect(row?.props.flexWrap).toBeUndefined()
    // The two tabs alone fill the row on both views, so switching to Session never shrinks or moves them.
    expect(row!.children.length).toBe(2)
    expect(before!.children.length).toBe(2)
    expect(JSON.stringify(row)).not.toContain('"key":"handoff"')
    expect(JSON.stringify(await ui.find({ key: 'head-row' }))).toContain('"key":"handoff"')
    const box = await ui.find({ key: 'handoff-box' })
    // Secondary: no box of its own, never shrunk into two lines, its label centred down the row.
    expect(box?.props.borderStyle).toBeUndefined()
    expect(box?.props.backgroundColor).toBeUndefined()
    expect(box?.props).toMatchObject({ flexShrink: 0, justifyContent: 'center' })
    const button = await ui.find({ key: 'handoff' } as never)
    expect(button?.props.dimColor).toBe(true)
    // A narrow pane gets the short label, so the two tabs keep their room.
    expect(button?.props.label).toBe(columns < 70 ? 'Hand off' : 'Hand off and clear')
    await ui.unmount()
  })
}

test('Now project appears once on each surface and desktop tags are track-coloured pills', { options: { dataDir: '/board' } }, async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.status', () => ({ value: undefined as never }))
  on('session.cwd', () => ({ value: '/' }))
  on('process.run', () => ({ value: { code: 0, stdout: '', stderr: '' } } as never))
  on('env.get', () => ({ value: undefined }))
  const thread = { id: 'task', title: 'Task', finish: 'Finish task', project: 'sample-project', minutes: 10, progress: 50, check: 'verified', resume: '', last: '' }
  on('fs.exists', (_, e) => ({ value: e.path === '/board/threads.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [thread] }) }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text', text: 'sample-project' })).length).toBe(1)
    const tags = (await ui.findAll({ type: 'Box' })).filter(x => x.key?.startsWith('tag-'))
    expect(tags.length).toBe(surface === 'desktop' ? 2 : 0)
    for (const tag of tags) {
      expect(tag.props).toMatchObject({ backgroundColor: desk.track, paddingX: 'xs', borderStyle: 'round', borderColor: desk.track })
      expect(tag.props.paddingY).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('the rail runs the full width of the pane', { options: { dataDir: '/board' } }, async ($) => {
  const term = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 90 }, surface: 'terminal' })
  const rule = (await term.find({ key: 'rail' } as never)) as { props: Record<string, unknown> } | undefined
  const text = rule ? undefined : await term.find({ type: 'Text', text: /^─+$/ })
  const width = rule ? (rule.props.props as { width: number }).width : String((text?.children as string[] | undefined)?.join('') ?? text?.props.text ?? '').length
  expect(width).toBeGreaterThan(80)
  await term.unmount()
})

test('terminal tab track keeps its fill and gets no border', { options: { dataDir: '/board' } }, async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const track = await ui.find({ key: 'tab-track' })
  expect(track?.props.backgroundColor).toBe(tone.hover)
  expect(track?.props.borderStyle).toBeUndefined()
  await ui.unmount()
})

test('Helpers contains the Fast switch on both surfaces, with no separate card', { options: { dataDir: '/board', dispatchDir: '/dispatch' } }, async ($, on) => {
  let fast = false
  const clock = mock.clock(on)
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === '/dispatch' || (e.path === '/dispatch/fast' && fast) }))
  on('fs.write', () => { fast = true; return { value: undefined as never } })
  on('process.run', (_, e) => { if (e.argv[0] !== '/bin/sh') fast = false; return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    await clock.advance(1000)
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'desktop') await ui.press({ key: 'tab-session' } as never)
    expect(await ui.find({ key: 'pc-help' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No helpers yet.' })).toBeDefined()
    expect(await ui.find({ key: 'worker-fast-row' })).toBeUndefined()
    expect((await ui.find({ key: 'helper-fast' }))?.props.label).toBe(surface === 'terminal' ? '⚡ Fast ○' : 'Fast')
    if (surface === 'desktop') {
      // A switch, not a boxed pill: a lightning bolt, a track with its knob left when off, and a note that it is for workers.
      expect(await ui.find({ key: 'helper-fast-pill' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '⚡' } as never)).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Codex and pi only' } as never)).toBeDefined()
      // A drawn pill, as a phone's switch: grey with the knob left when off.
      const off = (await ui.find({ type: 'Svg' } as never))?.props as { source: string; alt: string }
      expect(off.alt).toBe('Fast mode off')
      expect(off.source).toContain('OFF')
      expect(off.source).toContain('cx="12"')
      // No layer over the switch: the desktop gives the click to the topmost element, so the Button takes it.
      expect(await ui.find({ key: 'hit-helper-fast' } as never)).toBeUndefined()
    }
    await ui.press({ key: 'helper-fast' } as never)
    expect(fast).toBe(true)
    if (surface === 'desktop') {
      const on = (await ui.find({ type: 'Svg' } as never))?.props as { source: string; alt: string }
      expect(on.alt).toBe('Fast mode on')
      expect(on.source).toContain('fill="#22c55e"')
      expect(on.source).toContain('ON')
      expect(on.source).toContain('cx="38"')
      await ui.press({ key: 'helper-fast' } as never)
      expect(fast).toBe(false)
    } else {
      expect((await ui.find({ key: 'helper-fast' }))?.props.label).toBe('⚡ Fast ●')
      await ui.press({ key: 'helper-fast' } as never)
      expect(fast).toBe(false)
    }
    await ui.unmount()
  }
})

test('without dispatch there is no Fast switch', async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'helper-fast' })).toBeUndefined()
  await ui.unmount()
})

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

test('/nextup opens the Next up pane', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(`${e.id}:${e.title}`)
    return { value: { isPlaced: true } as never }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'nextup' } as never)
  expect(opened).toContain('nextup:Next up')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Next up' })).toBeDefined()
  await ui.unmount()
})

test('the pane draws on every surface', async ($, on) => {
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Next up' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No data folder set.' })).toBeDefined()
    await ui.unmount()
  }
})

test('with no data folder nothing is read or written', async ($, on) => {
  const touched: string[] = []
  on('fs.exists', (_, e) => (touched.push(`exists ${e.path}`), { value: false }))
  on('fs.read', (_, e) => (touched.push(`read ${e.path}`), { value: '' }))
  on('fs.write', (_, e) => (touched.push(`write ${e.path}`), { value: undefined as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'No data folder set.' })).toBeDefined()
  await ui.unmount()
  expect(touched.filter(t => t.startsWith('write'))).toEqual([])
  expect(touched).toEqual([])
})

test('a ~ in the data folder is read from HOME', { options: { dataDir: '~/board/' } }, async ($, on) => {
  const read: string[] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/H' : undefined }))
  on('fs.exists', (_, e) => (read.push(e.path), { value: false }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(read).toContain('/H/board/threads.json')
})

test('with no data folder no process runs, gh included', async ($, on) => {
  const ran: string[] = []
  on('process.run', (_, e) => (ran.push(e.argv.join(' ')), { value: { code: 0, stdout: '', stderr: '' } } as never))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await ui.unmount()
  expect(ran).toEqual([])
})

test('with no data folder the header has no board progress, rescan or lone tab', async ($, on) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Next up' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /done today/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /not scanned yet|scanned \d/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'refresh' } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'tab-session' } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Session log' })).toBeDefined()
  await ui.unmount()
})

test('a session with a person at the prompt opens the pane on start', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(opened).toEqual(['nextup'])
})

// The desktop app runs sessions on the SDK: session.start says no person and no surface yet. The open is
// asked for anyway; the engine holds it undrawn until a surface attaches (a -p run never attaches one).
test('a desktop (SDK) session with no surface yet still asks to open the pane on start', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: false } as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(opened).toEqual(['nextup'])
})

test('with Open on start off the pane waits for /nextup', { options: { openOnStart: false } }, async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(opened).toEqual([])
})

const HANDOFF = { name: 'handoff-and-clear', description: 'Hand off and clear', source: 'plugin', plugin: 'darren-core' } as const

test('Session tab: a Hand off and clear button in the header runs darren-core\'s hand-off', { options: { dataDir: '/board' } }, async ($, on) => {
  on('command.list', () => ({ value: [HANDOFF] as never }))
  const ran: string[] = []
  on('command.run', { command: 'handoff-and-clear' }, (_, e) => { ran.push(e.command); return { text: '' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Not on the Next tab: it belongs to the Session tab's header row.
  expect(await ui.find({ type: 'Button', key: 'handoff' } as never)).toBeUndefined()
  await ui.press({ key: 'tab-session' } as never)
  const head = await ui.find({ key: 'head-row' })
  expect(JSON.stringify(head)).toContain('"key":"handoff"')
  expect(JSON.stringify(head)).toContain('Hand off')
  expect(JSON.stringify(await ui.find({ key: 'tab-row' }))).not.toContain('"key":"handoff"')
  await ui.press({ key: 'handoff' } as never)
  expect(ran).toEqual(['handoff-and-clear'])
  await ui.unmount()
})

test('Hand off and clear: when the run is refused, the command is filled into the prompt instead', { options: { dataDir: '/board' } }, async ($, on) => {
  on('command.list', () => ({ value: [HANDOFF] as never }))
  on('command.run', { command: 'handoff-and-clear' }, () => { throw new Error('refused: non-interactive') })
  const filled: string[] = []
  on('prompt.fill', (_, e) => { filled.push((e as { text: string }).text); return { isFilled: true } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-session' } as never)
  await ui.press({ key: 'handoff' } as never)
  expect(filled).toEqual(['/handoff-and-clear'])
  await ui.unmount()
})

test('without darren-core\'s handoff command there is no Hand off and clear button', { options: { dataDir: '/board' } }, async ($, on) => {
  // A handoff command from another plugin does not count.
  on('command.list', () => ({ value: [{ ...HANDOFF, plugin: 'other' }] as never }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-session' } as never)
  expect(await ui.find({ type: 'Button', key: 'handoff' } as never)).toBeUndefined()
  await ui.unmount()
})

test('with no data folder the hand-off button sits in the header row', async ($, on) => {
  on('command.list', () => ({ value: [HANDOFF] as never }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'handoff' } as never)).toBeDefined()
  await ui.unmount()
})

test('the hand-off button appears once darren-core registers its command after the pane first drew', async ($, on) => {
  let commands: unknown[] = []
  const clock = mock.clock(on)
  on('env.get', () => ({ value: undefined }))
  on('command.list', () => ({ value: commands as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'handoff' } as never)).toBeUndefined()
  // darren-core's session.start registers the command after nextup first drew; nextup looks again shortly after.
  commands = [HANDOFF]
  await clock.advance(3000)
  expect(await ui.find({ type: 'Button', key: 'handoff' } as never)).toBeDefined()
  await ui.unmount()
})

test('terminal tabs: the label fills its segment, so a click anywhere on the segment lands on the Button', { options: { dataDir: '/board' } }, async ($) => {
  // The terminal takes a press only on the cells a Button draws: a bare "Next" missed clicks beside it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const id of ['focus', 'session']) {
    const label = String((await ui.find({ key: `tab-${id}` } as never))?.props.label ?? '')
    expect(label.length).toBe(Math.floor((PANE.props.bodyColumns - 4) / 2))
    expect(label.trim()).toBe(id === 'focus' ? 'Next' : 'Session')
    // Centred: the spaces either side differ by at most one.
    expect(Math.abs(label.indexOf(label.trim()) - (label.length - label.trimEnd().length))).toBeLessThanOrEqual(1)
  }
  await ui.unmount()
})

test('terminal tabs fill the row with the hand-off button in the header, and keep the Session count', { options: { dataDir: '/board' } }, async ($, on) => {
  on('command.list', () => ({ value: [HANDOFF] as never }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-session' } as never)
  expect(await ui.find({ type: 'Button', key: 'handoff' } as never)).toBeDefined()
  const width = Math.floor((PANE.props.bodyColumns - 4) / 2)
  for (const id of ['focus', 'session']) {
    const label = String((await ui.find({ key: `tab-${id}` } as never))?.props.label ?? '')
    expect(label.length).toBe(width)
  }
  await ui.unmount()
})

test('Session tab: Worker lanes group by run, expand to the brief and report paths, and survive a bad state.json', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const NOW = Date.parse('2026-10-24T10:00:00Z')
  const iso = (m: number) => new Date(NOW - m * 60_000).toISOString()
  const lane = (o: object) => JSON.stringify({ created: iso(60), ...o })
  const files: Record<string, string> = {
    '/dispatch/live/state.json': lane({ task: 'live', group: 'Build', phase: 'running', phase_at: iso(2), runs: [{ n: 1, harness: 'pi', status: 'running', started: iso(4) }] }),
    '/dispatch/old/state.json': lane({ task: 'old', runs: [{ n: 1, harness: 'codex', status: 'done', exit: 0, started: iso(50), ended: iso(40), wall_s: 600 }] }),
    '/dispatch/bad/state.json': '{ nope',
  }
  const clock = mock.clock(on, { now: NOW })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', (_, e) => ({ value: e.path === '/dispatch' ? [...new Set(Object.keys(files).map(f => f.split('/')[2]!))].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false })) : [] }))
  on('fs.read', (_, e) => { if (!(e.path in files)) throw new Error('ENOENT'); return { value: files[e.path]! } })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    await clock.advance(1000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'pc-dispatch' })).toBeDefined()
    for (const group of ['Build', 'Ungrouped']) expect(await ui.find({ key: `dp-group-${group}` })).toBeDefined()
    for (const dir of ['live', 'old', 'bad']) expect(await ui.find({ key: `dp-lane-/dispatch/${dir}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'unreadable · state.json could not be read' } as never)).toBeDefined()
    expect(await ui.find({ key: 'dp-brief-/dispatch/live' })).toBeUndefined()
    await ui.press({ key: 'dp-open-/dispatch/live' } as never)
    expect(await ui.find({ key: 'dp-brief-/dispatch/live' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/dispatch/live/runs/1-pi/' } as never)).toBeDefined()
    await ui.press({ key: 'dp-open-/dispatch/live' } as never)
    expect(await ui.find({ key: 'dp-brief-/dispatch/live' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Session tab: with no dispatch folder there is no Worker lanes card', async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'pc-dispatch' })).toBeUndefined()
  await ui.unmount()
})

test('Session tab: Worker lanes show eight, then Show more reveals the rest', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const NOW = Date.parse('2026-10-24T10:00:00Z')
  const names = Array.from({ length: 10 }, (_, i) => `t${i}`)
  const clock = mock.clock(on, { now: NOW })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', (_, e) => ({ value: e.path === '/dispatch' ? names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false })) : [] }))
  on('fs.read', (_, e) => ({ value: JSON.stringify({ task: e.path.split('/')[2], created: new Date(NOW - 60_000).toISOString(), runs: [{ n: 1, harness: 'pi', status: 'done', exit: 0, wall_s: 5 }] }) }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = async () => (await ui.findAll({ type: 'Box' })).filter(x => x.key?.startsWith('dp-lane-')).length
  expect(await rows()).toBe(8)
  expect((await ui.find({ key: 'dp-more-button' }))?.props.label).toBe('Show 2 more')
  await ui.press({ key: 'dp-more-button' } as never)
  expect(await rows()).toBe(10)
  await ui.unmount()
})

// A dispatch folder in memory, for the Worker lanes card at the render seam.
const NOW_L = Date.parse('2026-10-24T10:00:00Z')
const isoL = (m: number) => new Date(NOW_L - m * 60_000).toISOString()
function lanesWorld(on: Parameters<typeof mock.clock>[0], files: Record<string, string>, extra: { alive?: (pid: number) => boolean; lists?: string[] } = {}) {
  const clock = mock.clock(on, { now: NOW_L })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', (_, e) => {
    extra.lists?.push(e.path)
    return { value: e.path === '/dispatch' ? [...new Set(Object.keys(files).map(f => f.split('/')[2]!))].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: NOW_L, isLink: false })) : [] }
  })
  on('fs.read', (_, e) => { if (!(e.path in files)) throw new Error('ENOENT'); return { value: files[e.path]! } })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: NOW_L, isLink: false } }))
  on('process.run', (_, e) => ({ value: { exitCode: e.argv[0] === 'kill' && extra.alive && !extra.alive(Number(e.argv[2])) ? 1 : 0, stdout: '', stderr: '' } } as never))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return clock
}
const texts = async (ui: { findAll: (q: object) => Promise<{ children: unknown; props: Record<string, unknown> }[]> }) => (await ui.findAll({ type: 'Text' })).map(x => String((x.children as string[]).join('') || x.props.text || ''))

for (const columns of [42, 100]) {
  test(`Worker lanes at ${columns} columns: a long name keeps the row on one line and the elapsed time whole`, { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
    const name = 'a-very-long-task-name-for-the-lanes-card-wrapping-check'
    const clock = lanesWorld(on, { [`/dispatch/${name}/state.json`]: JSON.stringify({ task: name, created: isoL(60), runs: [{ n: 1, harness: 'pi', status: 'running', started: isoL(7) }] }) })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(1000)
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' })
    const label = String((await ui.find({ key: `dp-open-/dispatch/${name}` } as never))?.props.label)
    expect(label).not.toContain('\n')
    // The glyph (1), gaps (2), elapsed (5) and the frame leave the name this much.
    expect(label.length).toBeLessThanOrEqual(columns - 8 - 1 - 2 - 5)
    if (columns === 42) { expect(label.endsWith('…')).toBe(true); expect(label.length).toBeLessThan(name.length) } else expect(label).toBe(`▸ ${name}`)
    expect(await texts(ui)).toContain('7:01')
    await ui.unmount()
  })
}

test('Worker lanes: stale, cancelled and unreadable lanes get neutral glyphs, only done with exit 0 gets the tick, and the header counts unreadable', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const lane = (o: object) => JSON.stringify({ created: isoL(60), ...o })
  const run = (o: object) => ({ n: 1, harness: 'pi', status: 'done', exit: 0, started: isoL(50), ended: isoL(40), wall_s: 600, ...o })
  const clock = lanesWorld(on, {
    '/dispatch/ok/state.json': lane({ task: 'ok', runs: [run({})] }),
    '/dispatch/nope/state.json': lane({ task: 'nope', runs: [run({ status: 'cancelled', exit: undefined })] }),
    '/dispatch/ghost/state.json': lane({ task: 'ghost', runs: [run({ status: 'running', pid: 777, ended: undefined })] }),
    '/dispatch/bad/state.json': '{ nope',
  }, { alive: pid => pid !== 777 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const head = async (dir: string) => JSON.stringify(await ui.find({ key: `dp-lane-/dispatch/${dir}` }))
  expect(await head('ok')).toContain('✓')
  for (const dir of ['nope', 'ghost']) { const j = await head(dir); expect(j).not.toContain('✓'); expect(j).not.toContain('◐'); expect(j).toContain('·') }
  expect(await head('bad')).toContain('!')
  expect(await texts(ui)).toContain('0 running · 4 lanes · 1 unreadable')
  await ui.unmount()
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 42 }, surface: 'terminal' })
  expect(await texts(narrow)).toContain('0 live · 4 lanes · 1 unreadable')
  await narrow.unmount()
})

test('Worker lanes: the 5 s reread writes the lanes only when the card changed, and stops when the session ends', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const lists: string[] = []
  const files: Record<string, string> = { '/dispatch/done/state.json': JSON.stringify({ task: 'done', created: isoL(60), runs: [{ n: 1, harness: 'pi', status: 'done', exit: 0, wall_s: 5 }] }) }
  const clock = lanesWorld(on, files, { lists })
  // A write of the lanes state is what redraws the card.
  let written = 0
  on('state.set', (_, e, next) => ((e as { key?: string }).key === 'lanes' && (written += 1), next(e)))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.end', () => ({ sessionId: 's1' } as never))
  on('ui.panes', () => ({ value: [{ id: 'nextup', title: 'Next up', isShown: true, isFocused: false, isPlaced: true }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(15_000)
  expect(lists.length).toBeGreaterThan(1)
  expect(written).toBe(1)
  // Nothing changed in the folder, so nothing is written.
  await clock.advance(20_000)
  expect(written).toBe(1)
  // A change in the folder writes once.
  files['/dispatch/done/state.json'] = JSON.stringify({ task: 'done', created: isoL(60), phase: 'review', phase_at: isoL(0), runs: [{ n: 1, harness: 'pi', status: 'done', exit: 0, wall_s: 5 }] })
  await clock.advance(5000)
  expect(written).toBe(2)
  // The session ending stops the reread.
  await $.session.end({ reason: 'other' } as never)
  lists.length = 0
  await clock.advance(30_000)
  expect(lists).toEqual([])
})

test('Worker lanes: a pane that is open but not drawn starts no reread', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const lists: string[] = []
  const clock = lanesWorld(on, {}, { lists })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } as never }))
  on('ui.panes', () => ({ value: [{ id: 'nextup', title: 'Next up', isShown: false, isFocused: false, isPlaced: false }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  lists.length = 0
  await clock.advance(30_000)
  expect(lists).toEqual([])
})

test('Worker lanes on desktop: start before any surface, then attach, and the 5 s reread draws a new lane', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const lane = (task: string) => JSON.stringify({ task, created: isoL(60), runs: [{ n: 1, harness: 'pi', status: 'done', exit: 0, wall_s: 5 }] })
  const files: Record<string, string> = { '/dispatch/a/state.json': lane('a') }
  const clock = lanesWorld(on, files)
  // The desktop app starts the session before its view connects: the open is held undrawn, and no ui.open fires later.
  let placed = false
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } as never }))
  on('ui.panes', () => ({ value: [{ id: 'nextup', title: 'Next up', isShown: placed, isFocused: false, isPlaced: placed }] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  // The start-up redraws pass before the view connects.
  await clock.advance(11_000)
  placed = true
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'dp-lane-/dispatch/a' })).toBeDefined()
  files['/dispatch/b/state.json'] = lane('b')
  await clock.advance(5000)
  expect(await ui.find({ key: 'dp-lane-/dispatch/b' })).toBeDefined()
  await ui.unmount()
})

test('a pane drawn after session.end does not restart the live loop', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const files: Record<string, string> = { '/dispatch/a/state.json': JSON.stringify({ task: 'a', created: isoL(60), runs: [{ n: 1, harness: 'pi', status: 'done', exit: 0, wall_s: 5 }] }) }
  const clock = lanesWorld(on, files)
  let polls = 0
  on('ui.panes', () => { polls++; return { value: [{ id: 'nextup', title: 'Next up', isShown: true, isFocused: false, isPlaced: true }] } })
  on('session.end', () => ({ sessionId: 's1' } as never))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await $.session.end({ reason: 'other' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = polls
  await clock.advance(20_000)
  expect(polls).toBe(before)
  await ui.unmount()
})

test('Worker lanes revealed after a hidden spell draw the folder as it is now, not the old snapshot', { options: { dispatchDir: '/dispatch' } }, async ($, on) => {
  const lane = (task: string) => JSON.stringify({ task, created: isoL(60), runs: [{ n: 1, harness: 'pi', status: 'done', exit: 0, wall_s: 5 }] })
  const files: Record<string, string> = { '/dispatch/a/state.json': lane('a') }
  const clock = lanesWorld(on, files)
  let shown = true
  on('ui.panes', () => ({ value: [{ id: 'nextup', title: 'Next up', isShown: shown, isFocused: false, isPlaced: true }] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await clock.advance(5000)
  shown = false
  files['/dispatch/b/state.json'] = lane('b')
  await clock.advance(60_000)
  shown = true
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'dp-lane-/dispatch/b' })).toBeDefined()
  await ui.unmount()
})

// M2 fixture: no live board, sessions, commands, or filesystem writes.
for (const surface of ['desktop', 'terminal'] as const) {
  for (const hour of [14, 20]) {
    test(`${surface}: M2 order, collapsed wins, empty day parts and night rescue at ${hour}:00`, { options: { dataDir: '/board' } }, async ($, on) => {
      const now = new Date(2026, 9, 26, hour).getTime()
      const clock = mock.clock(on, { now })
      const task = (id: string, value: number, extra: object = {}) => ({
        id, title: id, finish: `Finish ${id}`, project: 'sample', minutes: 10, progress: 40,
        value, check: 'verified', last: new Date(now).toISOString(), resume: 'cd "/sample" && claude',
        source: 'claude', link: '', rated: true, ...extra,
      })
      const files: Record<string, string> = {
        ...(hour === 20 ? { '/board/mod-marks.json': JSON.stringify({ done: { done: true, at: new Date(2026, 9, 26, 9).getTime() } }) } : {}),
        '/board/threads.json': JSON.stringify({ generated: new Date(now).toISOString(), threads: [
          task('hero', 5, { progress: null }), task('small', 2),
          task('delegate', 1, { minutes: null}),
          task('custom', 0.5, { minutes: 7 }),
        ] }),
      }
      on('env.get', () => ({ value: undefined }))
      on('ui.status', () => ({ value: undefined as never }))
      on('fs.exists', (_, e) => ({ value: e.path in files }))
      on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
      on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: now, isLink: false } }))
      on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } } as never))
      on('command.register', (_, e) => ({ value: { command: e.name } }))
      on('session.start', (_, e) => ({ cwd: e.cwd }))
      on('mcp.call', (_, e) => ({ value: { content: [{ type: 'text', text: e.tool === 'list_sessions'
        ? JSON.stringify([{ sessionId: 'local_waiting', title: 'Waiting', isArchived: false, isRunning: false, lastActivityAt: new Date(now - 60_000).toISOString() }])
        : 'Session "waiting" (idle) — showing 1 of 1 messages\n\n[assistant] Can you review?\n[result] done (success), 1 turns' }], isError: false } as never }))
      await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
      await clock.advance(10)
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'hero' })).toBeDefined()
      expect(await ui.find({ key: 'progress-hero' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'estimate unknown' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '7 min estimated' })).toBeDefined()
      expect(await ui.find({ key: 'wins-ring' })).toBeUndefined()
      expect(await ui.find({ key: 'points-hours' })).toBeUndefined()
      expect(await ui.find({ key: 'summary-toggle-momentum' })).toBeDefined()
      // The only navigation row above content contains Next and Session. Lists
      // remain reachable below content, including on the narrower terminal.
      const tabRow = await ui.find({ key: 'tab-row' })
      expect((await ui.findAll({ key: 'tab-row' })).length).toBe(1)
      expect(tabRow?.props.flexWrap).toBeUndefined()
      expect(tabRow?.props.flexDirection ?? 'row').toBe('row')
      const strip = JSON.stringify(tabRow)
      expect(strip).toContain('"key":"tab-focus"')
      expect(strip).toContain('"key":"tab-session"')
      expect(strip).not.toContain('"key":"tab-work"')
      const pane = JSON.stringify(await ui.drawn())
      expect(pane.indexOf('"key":"tab-row"')).toBeLessThan(pane.indexOf('"key":"next-content"'))
      expect(await ui.find({ key: 'tab-work' })).toBeDefined()
      expect(pane.indexOf('"key":"next-content"')).toBeLessThan(pane.indexOf('"key":"tab-work"'))
      const content = JSON.stringify(await ui.find({ key: 'next-content' }))
      expect(await ui.find({ key: 'panel-needs' })).toBeDefined()
      expect(content.indexOf('"key":"hero"')).toBeLessThan(content.indexOf('"key":"panel-needs"'))
      expect(content.indexOf('"key":"panel-needs"')).toBeLessThan(content.indexOf('"key":"summary-momentum"'))
      if (hour < 18) {
        expect(await ui.find({ key: 'panel-rescue' })).toBeDefined()
        expect(content.indexOf('"key":"panel-needs"')).toBeLessThan(content.indexOf('"key":"panel-rescue"'))
      } else expect(await ui.find({ key: 'panel-rescue' })).toBeUndefined()
      await ui.press({ key: 'summary-toggle-momentum' } as never)
      expect(await ui.find({ key: 'points-hours' })).toBeDefined()
      if (hour === 20) expect(await ui.find({ key: 'day-part-0' })).toBeDefined()
      for (const part of hour === 20 ? [1, 2] : [0, 1, 2]) expect(await ui.find({ key: `day-part-${part}` })).toBeUndefined()
      await ui.press({ key: 'summary-toggle-momentum' } as never)
      expect(await ui.find({ key: 'points-hours' })).toBeUndefined()
      await ui.unmount()
    })
  }
}
